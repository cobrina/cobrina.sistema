// BACKEND/controllers/reportesGestionesController.js
import mongoose from "mongoose";
import ReporteGestion from "../models/ReporteGestion.js";
import { extraerEmails } from "../utils/email.util.js";
import { toDateOnly, normalizarHora } from "../utils/fecha.util.js";
import Empleado from "../models/Empleado.js";
import Entidad from "../models/Entidad.js";

/** Helper: extrae el usuario del JWT (lo setea verifyToken/miniVerify) */
function getUsuarioId(req) {
  // Soporta ambas convenciones + compat
  return (
    req?.user?.id || // ✅ lo que setea tu verifyToken actual
    req?.usuario?._id || // legacy
    req?.userId || // compat
    null
  );
}

const escapeRegex = (s = "") =>
  String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Normaliza un string de fecha (dd/mm/yyyy, yyyy-mm-dd, serial Excel)
// a INICIO de día UTC (00:00:00.000)
function diaInicioUTC(raw) {
  const d = toDateOnly(raw); // usa el util (puede devolver null)
  if (!d) return null;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
}

// Devuelve FIN de día UTC (23:59:59.999) a partir de un string de fecha
function diaFinUTC(raw) {
  const d0 = diaInicioUTC(raw);
  if (!d0) return null;
  return new Date(d0.getTime() + 86399999); // 24h - 1ms
}

// --- helper para parsear filtro DNI (uno o varios) ---
function buildDniFilter(raw) {
  if (!raw) return null;
  // admite: "123, 456  789\n012" → [123,456,789,012]
  const arr = String(raw)
    .split(/[\s,;]+/g)
    .map((s) => s.replace(/\D/g, ""))
    .filter((s) => s.length > 0);

  if (!arr.length) return null;
  // si vino 1 solo: exacto; si son varios: $in
  return arr.length === 1 ? arr[0] : { $in: arr };
}

/** GET /api/reportes-gestiones/ping */
export async function ping(_req, res) {
  try {
    return res.json({ ok: true, ts: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export async function cargar(req, res) {
  try {
    const usuarioId = getUsuarioId(req);
    if (!usuarioId) {
      return res.status(401).json({ error: "Token invalido o ausente." });
    }

    const {
      filas = [],
      fuenteArchivo = "",
      reemplazarTodo = false,
    } = req.body || {};
    if (!Array.isArray(filas) || filas.length === 0) {
      return res.status(400).json({ error: "No hay filas para cargar." });
    }

    // Si marcás reemplazarTodo, borra TODO el universo de gestiones
    if (reemplazarTodo) {
      await ReporteGestion.deleteMany({});
    }

    // helpers de normalizacion
    const norm = (s) => String(s ?? "").trim();
    const normUser = (s) => norm(s).toLowerCase();
    const normEntidad = (s) => norm(s).toUpperCase();

    // catalogos precargados
    const [empleados, entidades] = await Promise.all([
      Empleado.find({ isActive: true }).select("username").lean(),
      Entidad.find().select("nombre").lean(),
    ]);
    const setUsers = new Set(
      empleados.map((e) => String(e.username || "").toLowerCase())
    );
    const setEnts = new Set(
      entidades.map((e) => String(e.nombre || "").toUpperCase())
    );

    const errores = [];
    const seen = new Set();
    const docs = [];
    const rawRows = [];

    filas.forEach((f, idx) => {
      const row = idx + 2; // encabezado en fila 1

      // base obligatoria
      const dni = norm(f?.DNI ?? f?.dni);
      const fechaStr = norm(f?.FECHA ?? f?.fecha);
      const horaStr = norm(f?.HORA ?? f?.hora);
      const usuarioRaw = norm(f?.USUARIO ?? f?.usuario);
      const entidadRaw = norm(f?.ENTIDAD ?? f?.entidad);

      // 👉 ahora también exigimos ENTIDAD no vacía
      if (!dni || !fechaStr || !usuarioRaw || !entidadRaw) {
        errores.push({
          fila: row,
          motivo: "Faltan campos obligatorios (DNI, FECHA, USUARIO o ENTIDAD)",
          row: { ...f },
        });
        return;
      }

      const fDate = toDateOnly(fechaStr);
      if (!fDate) {
        errores.push({
          fila: row,
          motivo: `Fecha invalida o no soportada (${fechaStr}). Use dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd o serial Excel.`,
          row: { ...f },
        });
        return;
      }

      // campos de clave
      const tipoContacto = norm(f?.["TIPO CONTACTO"] ?? f?.tipoContacto);
      const resultadoGestion = norm(
        f?.["RESULTADO GESTION"] ?? f?.resultadoGestion
      );
      const estadoCuenta = norm(f?.["ESTADO DE LA CUENTA"] ?? f?.estadoCuenta);

      // normalizaciones coherentes con el modelo
      const horaNorm = normalizarHora(horaStr) || "00:00:00"; // HH:mm:ss
      const fechaKey = fDate.toISOString().slice(0, 10); // yyyy-mm-dd

      const usuario = normUser(usuarioRaw);
      let entidad = normEntidad(entidadRaw);
      if (entidad.length > 120) entidad = entidad.slice(0, 120); // defensivo

      // 🔴 VALIDACIÓN DURA: usuario debe existir en Empleado.isActive = true
      if (!setUsers.has(usuario)) {
        errores.push({
          fila: row,
          motivo: `Usuario "${usuarioRaw}" no existe como username activo en la tabla Empleados.`,
          row: { ...f },
        });
        return; // ⛔ NO seguimos con esta fila, NO se inserta
      }

      // 🔴 VALIDACIÓN DURA: entidad debe existir en Entidad
      if (!setEnts.has(entidad)) {
        errores.push({
          fila: row,
          motivo: `Entidad "${entidadRaw}" no existe en la tabla Entidades.`,
          row: { ...f },
        });
        return; // ⛔ NO seguimos con esta fila
      }

      // duplicado dentro del archivo (misma clave que el indice unico)
      const key = [
        dni,
        fechaKey,
        horaNorm,
        usuario,
        tipoContacto,
        resultadoGestion,
        estadoCuenta,
        entidad,
      ].join("|");

      if (seen.has(key)) {
        errores.push({
          fila: row,
          motivo:
            "Duplicado dentro del archivo (dni+fecha+hora+usuario+tipoContacto+resultadoGestion+estadoCuenta+entidad)",
          row: { ...f },
        });
        return;
      }
      seen.add(key);

      // resto de campos
      const telMail = norm(f?.["TEL-MAIL MARCADO"] ?? f?.telMailMarcado);
      const nombreDeudor = norm(f?.["NOMBRE DEUDOR"] ?? f?.nombreDeudor);
      let observacion = norm(
        f?.["OBSERVACION GESTION"] ?? f?.observacionGestion ?? f?.observacion
      );
      if (observacion.length > 3000) observacion = observacion.slice(0, 3000);

      // copia cruda para reporte de errores
      rawRows.push({
        DNI: dni,
        "NOMBRE DEUDOR": nombreDeudor,
        FECHA: fechaStr,
        HORA: horaStr,
        USUARIO: usuarioRaw,
        "TIPO CONTACTO": tipoContacto,
        "RESULTADO GESTION": resultadoGestion,
        "ESTADO DE LA CUENTA": estadoCuenta,
        "TEL-MAIL MARCADO": telMail,
        "OBSERVACION GESTION": observacion,
        ENTIDAD: entidadRaw,
      });

      // ⚠️ mailsDetectados: SOLO desde TEL-MAIL MARCADO (no Observacion)
      const mailsSoloTel = extraerEmails(telMail);

      docs.push({
        propietario: new mongoose.Types.ObjectId(usuarioId),
        fuenteArchivo,
        dni,
        nombreDeudor,
        fecha: fDate,
        hora: horaNorm,
        usuario, // minusculas
        tipoContacto,
        resultadoGestion,
        estadoCuenta,
        telMailMarcado: telMail,
        observacionGestion: observacion,
        entidad, // MAYÚSCULAS
        mailsDetectados: mailsSoloTel,
      });
    });

    if (!docs.length) {
      return res.status(200).json({
        ok: true,
        insertados: 0,
        duplicadosEnBD: 0,
        totalProcesados: 0,
        errores,
      });
    }

    let insertados = 0;
    let duplicadosEnBD = 0;
    try {
      const inserted = await ReporteGestion.insertMany(docs, {
        ordered: false,
      });
      insertados = Array.isArray(inserted) ? inserted.length : 0;
    } catch (e) {
      const writeErrors =
        e?.writeErrors ||
        e?.result?.result?.writeErrors ||
        e?.result?.writeErrors ||
        e?.writeErrors?.errors ||
        [];

      const isDup = (w, top = e) => {
        const code = w?.code ?? top?.code;
        const codeName = w?.codeName ?? top?.codeName;
        const msg =
          w?.errmsg || w?.message || w?.err?.message || top?.message || "";
        return (
          Number(code) === 11000 ||
          String(codeName || "").toLowerCase() === "duplicatekey" ||
          /E11000/i.test(String(msg))
        );
      };

      const getIdx = (w) => {
        if (Number.isFinite(w?.index)) return w.index;
        if (Number.isFinite(w?.err?.index)) return w.err.index;
        if (Number.isFinite(e?.index)) return e.index;
        return null;
      };

      writeErrors.forEach((w) => {
        const idx = getIdx(w);
        const rowData = idx != null ? rawRows[idx] : null;

        if (isDup(w)) {
          duplicadosEnBD++;
          errores.push({
            fila: idx != null ? idx + 2 : "-",
            motivo:
              "Gestion duplicada en BD (dni+fecha+hora+usuario+tipoContacto+resultadoGestion+estadoCuenta+entidad)",
            row: rowData || {},
          });
        } else {
          const msg =
            w?.errmsg ||
            w?.message ||
            w?.err?.message ||
            e?.message ||
            "Error de insercion";
          errores.push({
            fila: idx != null ? idx + 2 : "-",
            motivo: msg,
            row: rowData || {},
          });
        }
      });

      if (!writeErrors.length && /E11000/i.test(String(e?.message || ""))) {
        errores.push({
          fila: "-",
          motivo:
            "Gestion duplicada en BD (detectado por mensaje E11000 sin indice de fila)",
          row: {},
        });
        duplicadosEnBD++;
      }

      if (typeof e?.result?.result?.nInserted === "number") {
        insertados = e.result.result.nInserted;
      } else if (Array.isArray(e?.insertedDocs)) {
        insertados = e.insertedDocs.length;
      }
    }

    return res.status(200).json({
      ok: true,
      insertados,
      duplicadosEnBD,
      totalProcesados: docs.length + (errores?.length || 0),
      errores,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export async function listar(req, res) {
  try {
    const usuarioId = getUsuarioId(req);
    if (!usuarioId) {
      return res.status(401).json({ error: "Token invalido o ausente." });
    }

    const {
      // Filtros
      desde,
      hasta,
      operador,
      entidad,
      tipoContacto,
      estadoCuenta,
      dni,
      // Paginación
      page = 1,
      limit = 200,
      // Ordenamiento
      sortKey,
      sortDir,
      // downsampling de campos (min|full)
      fields = "min",
    } = req.query || {};

    // ---- Construcción de query base (scope GLOBAL, ya no por propietario)
    const q = {
      borrado: { $ne: true },
    };

    // Rango de fechas (día completo UTC)
    if (desde || hasta) {
      const dDesde = desde ? diaInicioUTC(String(desde).trim()) : null;
      const dHasta = hasta ? diaFinUTC(String(hasta).trim()) : null;

      if (dDesde || dHasta) {
        q.fecha = {};
        if (dDesde) q.fecha.$gte = dDesde;
        if (dHasta) q.fecha.$lte = dHasta;
      }
    }

    // DNI (uno o varios)
    const dniFilter = buildDniFilter(dni);
    if (dniFilter) q.dni = dniFilter;

    // Filtros exactos (case-insensitive)
    const rxExact = (s) =>
      new RegExp(`^${escapeRegex(String(s).trim())}$`, "i");
    if (operador) q.usuario = rxExact(operador);
    if (entidad) q.entidad = rxExact(entidad);
    if (tipoContacto) q.tipoContacto = rxExact(tipoContacto);
    if (estadoCuenta) q.estadoCuenta = rxExact(estadoCuenta);

    // ---- Paginación
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(1000, Math.max(1, Number(limit) || 200));
    const skip = (pageNum - 1) * limitNum;

    // ---- Ordenamiento (whitelist + defaults)
    const ALLOWED_SORT = new Set([
      "dni",
      "nombreDeudor",
      "fecha",
      "hora",
      "usuario",
      "tipoContacto",
      "resultadoGestion",
      "estadoCuenta",
      "telMailMarcado",
      "observacionGestion",
      "entidad",
    ]);
    const key = ALLOWED_SORT.has(String(sortKey)) ? String(sortKey) : "fecha";
    const dir = String(sortDir).toLowerCase() === "asc" ? 1 : -1;

    let sortStage = {};
    if (key === "fecha") {
      sortStage = { fecha: dir, hora: dir, _id: 1 };
    } else if (key === "hora") {
      sortStage = { hora: dir, fecha: dir, _id: 1 };
    } else {
      sortStage = { [key]: dir, fecha: -1, hora: -1, _id: 1 };
    }

    // ---- Proyección liviana por defecto
    const PROJ_MIN = {
      dni: 1,
      nombreDeudor: 1,
      fecha: 1,
      hora: 1,
      usuario: 1,
      tipoContacto: 1,
      resultadoGestion: 1,
      estadoCuenta: 1,
      telMailMarcado: 1,
      observacionGestion: 1,
      entidad: 1,
      mailsDetectados: 1,
    };
    const projectStage =
      fields === "min" ? { $project: PROJ_MIN } : { $project: { __v: 0 } };

    // ---- Total y página con aggregate (+ allowDiskUse)
    const [total, items] = await Promise.all([
      ReporteGestion.countDocuments(q),
      ReporteGestion.aggregate([
        { $match: q },
        { $sort: sortStage },
        { $skip: skip },
        { $limit: limitNum },
        projectStage,
      ])
        .allowDiskUse(true)
        .collation({ locale: "es", strength: 2 }),
    ]);

    return res.json({
      ok: true,
      total,
      page: pageNum,
      pages: Math.max(1, Math.ceil(total / limitNum)),
      items,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export async function limpiar(req, res) {
  try {
    const usuarioId = getUsuarioId(req);
    if (!usuarioId) {
      return res.status(401).json({ error: "Token invalido o ausente." });
    }

    // filtros opcionales (mismo contract que /listar)
    const f = req.body?.filtros || {};
    const { desde, hasta, operador, entidad, tipoContacto, estadoCuenta, dni } =
      f;

    // base GLOBAL (ya no filtramos por propietario)
    const q = {};

    // construir filtros (idéntico criterio que /listar, día completo UTC)
    if (desde || hasta) {
      const dDesde = desde ? diaInicioUTC(String(desde).trim()) : null;
      const dHasta = hasta ? diaFinUTC(String(hasta).trim()) : null;

      if (dDesde || dHasta) {
        q.fecha = {};
        if (dDesde) q.fecha.$gte = dDesde;
        if (dHasta) q.fecha.$lte = dHasta;
      }
    }

    const rxExact = (s) =>
      new RegExp(`^${escapeRegex(String(s).trim())}$`, "i");
    if (operador) q.usuario = rxExact(operador);
    if (entidad) q.entidad = rxExact(entidad);
    if (tipoContacto) q.tipoContacto = rxExact(tipoContacto);
    if (estadoCuenta) q.estadoCuenta = rxExact(estadoCuenta);

    // DNI (uno o varios)
    const dniFilter = buildDniFilter(dni);
    if (dniFilter) q.dni = dniFilter;

    // Si no vino NINGÚN filtro (todo vacio), borra TODO el universo de gestiones
    // (igual requiere JWT válido)
    const r = await ReporteGestion.deleteMany(q);
    return res.json({ ok: true, borrados: r.deletedCount || 0 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

/** GET /api/reportes-gestiones/export/pdf (stub hasta implementar server-side) */
export async function exportarPDF(_req, res) {
  try {
    return res
      .status(501)
      .json({ ok: false, message: "exportarPDF aun no implementado" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

/** GET /api/reportes-gestiones/catalogos */
export async function catalogos(req, res) {
  try {
    const usuarioId = getUsuarioId(req);
    if (!usuarioId) {
      return res.status(401).json({ error: "Token invalido o ausente." });
    }

    const { desde, hasta } = req.query || {};

    // Base GLOBAL: ya no filtramos por propietario, solo por fecha si viene
    const base = {};

    if (desde || hasta) {
      const dDesde = desde ? diaInicioUTC(String(desde).trim()) : null;
      const dHasta = hasta ? diaFinUTC(String(hasta).trim()) : null;

      if (dDesde || dHasta) {
        base.fecha = {};
        if (dDesde) base.fecha.$gte = dDesde;
        if (dHasta) base.fecha.$lte = dHasta;
      }
    }

    // Operadores activos desde Empleado
    const operadores = (
      await Empleado.find({ isActive: true })
        .select("username")
        .sort({ username: 1 })
        .lean()
    ).map((e) => String(e.username || ""));

    // Entidades desde Entidad
    const entidades = (
      await Entidad.find().select("nombre").sort({ numero: 1 }).lean()
    ).map((x) => String(x.nombre || ""));

    // Tipos/estados desde las gestiones (libres, pero ahora globales)
    const [tiposRaw, estadosRaw] = await Promise.all([
      ReporteGestion.distinct("tipoContacto", base),
      ReporteGestion.distinct("estadoCuenta", base),
    ]);

    const normTxt = (x) => String(x || "").trim();
    const ordenar = (arr = []) =>
      (arr || [])
        .map(normTxt)
        .filter((x) => x.length > 0)
        .sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));

    return res.json({
      ok: true,
      operadores: ordenar(operadores),
      entidades: ordenar(entidades),
      tiposContacto: ordenar(tiposRaw),
      estadosCuenta: ordenar(estadosRaw),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// controllers/reportesGestionesController.js (handler corregido)
export async function comparativo(req, res) {
  try {
    const usuarioId = getUsuarioId(req); // usamos el helper de arriba
    if (!usuarioId) {
      return res.status(401).json({ error: "Token invalido o ausente." });
    }

    // --------- Entrada ---------
    const {
      desde, // puede venir dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd, serial Excel
      hasta,
      operador,
      entidad,
      tipoContacto,
      estadoCuenta,
    } = req.query || {};

    // --------- Fechas (día completo UTC, alineado al modelo) ---------
    const d1 = diaInicioUTC(desde);
    const d2 = diaInicioUTC(hasta);
    const endOfDayUTC = (d) => new Date(d.getTime() + 86399999);

    if (!d1 || !d2 || d2 < d1) {
      return res.status(400).json({ error: "Rango de fechas invalido" });
    }

    // Rango “previo” con la misma longitud
    const days = Math.floor((endOfDayUTC(d2) - d1) / 86400000) + 1; // inclusive
    const prevEnd = new Date(d1.getTime() - 86400000); // dia anterior al inicio actual
    const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86400000);

    // --------- Query base + filtros ---------
    const escapeRegex = (s = "") =>
      String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rxExact = (s) =>
      new RegExp(`^${escapeRegex(String(s).trim())}$`, "i");

    // 🔹 Base GLOBAL: ya no filtramos por propietario
    const base = {};

    const addFilters = (q) => {
      const out = { ...base };
      if (q?.fecha) out.fecha = q.fecha;
      if (operador) out.usuario = rxExact(operador);
      if (entidad) out.entidad = rxExact(entidad);
      if (tipoContacto) out.tipoContacto = rxExact(tipoContacto);
      if (estadoCuenta) out.estadoCuenta = rxExact(estadoCuenta);
      return out;
    };

    const qActual = addFilters({ fecha: { $gte: d1, $lte: endOfDayUTC(d2) } });
    const qPrevio = addFilters({
      fecha: { $gte: prevStart, $lte: endOfDayUTC(prevEnd) },
    });

    // --------- Utilidades de KPI ---------
    const esContactoDoc = {
      $or: [
        { resultadoGestion: { $regex: /contactad[oa]/i } },
        { estadoCuenta: { $regex: /contactad[oa]/i } },
      ],
    };
    const esMailLibreDoc = { resultadoGestion: { $regex: /mail\s*libre/i } };

    // Pipeline comun para computar KPIs
    const pipelineKPIs = (matchQ) => [
      { $match: matchQ },
      {
        $project: {
          dni: 1,
          fecha: 1,
          hora: 1,
          usuario: 1,
          tipoContacto: 1,
          resultadoGestion: 1,
          estadoCuenta: 1,
          telMailMarcado: 1,
          isContacto: esContactoDoc,
          isMailLibre: esMailLibreDoc,
          horaHH: { $substr: ["$hora", 0, 2] },
        },
      },
      {
        $facet: {
          base: [
            {
              $group: {
                _id: null,
                gestiones: { $sum: 1 },
                dnisSet: { $addToSet: "$dni" },
                contactos: { $sum: { $cond: ["$isContacto", 1, 0] } },
              },
            },
          ],
          porDniMailLibre: [
            {
              $match: {
                isMailLibre: true,
                telMailMarcado: { $type: "string", $ne: "" },
              },
            },
            { $project: { dni: 1, mails: "$telMailMarcado" } },
          ],
          porHora: [
            {
              $group: {
                _id: "$horaHH",
                gestiones: { $sum: 1 },
                contactos: { $sum: { $cond: ["$isContacto", 1, 0] } },
              },
            },
          ],
          orden: [
            {
              $project: {
                dni: 1,
                fecha: 1,
                hora: 1,
                ts: { $add: [{ $toLong: "$fecha" }, 0] },
              },
            },
            { $sort: { fecha: 1, hora: 1, _id: 1 } },
          ],
        },
      },
    ];

    const [actAgg, prevAgg] = await Promise.all([
      ReporteGestion.aggregate(pipelineKPIs(qActual)).collation({
        locale: "es",
        strength: 1,
      }),
      ReporteGestion.aggregate(pipelineKPIs(qPrevio)).collation({
        locale: "es",
        strength: 1,
      }),
    ]);

    const fold = (agg, rangoDias) => {
      const base = agg?.[0]?.base?.[0] || {};
      const gestiones = base.gestiones || 0;
      const dnisUnicos = (base.dnisSet || []).filter(Boolean).length || 0;
      const contactos = base.contactos || 0;

      const diasHabiles = rangoDias;
      const dnisPorDia = diasHabiles ? dnisUnicos / diasHabiles : 0;

      const porDniMailLibre = agg?.[0]?.porDniMailLibre || [];
      const regexEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
      const mapaDniMails = new Map();
      for (const r of porDniMailLibre) {
        const mails = String(r.mails || "").match(regexEmail) || [];
        if (!mails.length) continue;
        const key = String(r.dni || "");
        mapaDniMails.set(key, (mapaDniMails.get(key) || 0) + mails.length);
      }
      let promedioMailsPorDni = 0;
      if (mapaDniMails.size) {
        const sum = Array.from(mapaDniMails.values()).reduce(
          (a, b) => a + b,
          0
        );
        promedioMailsPorDni = sum / mapaDniMails.size;
      }

      const tasaContactabilidad = gestiones ? (contactos * 100) / gestiones : 0;

      const efectividadPorDni = { value: 0, total: dnisUnicos };

      const porHora = (agg?.[0]?.porHora || []).map((h) => {
        const tot = h.gestiones || 0;
        const cont = h.contactos || 0;
        return {
          hora: (h._id || "").padStart(2, "0") + ":00",
          gestiones: tot,
          tasaContacto: tot ? (cont * 100) / tot : 0,
        };
      });
      const bestPct = porHora.reduce(
        (a, b) => (b.tasaContacto > a.tasaContacto ? b : a),
        { tasaContacto: -1, hora: "--:--" }
      );
      const bestVol = porHora.reduce(
        (a, b) => (b.gestiones > a.gestiones ? b : a),
        { gestiones: -1, hora: "--:--" }
      );

      return {
        gestiones,
        dnisUnicos,
        gestionesPorCaso: dnisUnicos ? gestiones / dnisUnicos : 0,
        tasaContactabilidad,
        efectividadContacto: efectividadPorDni.value,
        dnisPorDiaHabil: dnisPorDia,
        ritmoEntreCasosMin: null,
        promedioMailsPorDni,
        bestHoraPorcentaje: bestPct,
        bestHoraVolumen: bestVol,
      };
    };

    const rangoDiasActual = daysHabilesEntre(d1, d2);
    const rangoDiasPrevio = daysHabilesEntre(prevStart, prevEnd);

    function daysHabilesEntre(a, b) {
      let c = 0;
      const d = new Date(a);
      while (d <= b) {
        const wd = d.getUTCDay();
        if (wd >= 1 && wd <= 5) c++;
        d.setUTCDate(d.getUTCDate() + 1);
      }
      return Math.max(c, 1);
    }

    const actual = fold(actAgg, rangoDiasActual);
    const previo = fold(prevAgg, rangoDiasPrevio);

    const delta = (act, prev) => ({
      actual: act,
      previo: prev,
      deltaAbs:
        Number.isFinite(act) && Number.isFinite(prev) ? act - prev : null,
      deltaPct:
        Number.isFinite(prev) && prev !== 0 && Number.isFinite(act)
          ? ((act - prev) * 100) / prev
          : null,
    });

    const prevGestiones = previo.gestiones;

    const out = {
      rango: {
        actual: {
          desde: d1.toISOString().slice(0, 10),
          hasta: d2.toISOString().slice(0, 10),
        },
        previo: {
          desde: prevStart.toISOString().slice(0, 10),
          hasta: prevEnd.toISOString().slice(0, 10),
        },
      },
      kpis: {
        gestionesTotales: delta(
          actual.gestiones,
          Number(prevGestiones) || (prevGestiones === 0 ? null : null)
        ),
        dnisUnicos: delta(
          actual.dnisUnicos,
          previo.dnisUnicos || (previo.dnisUnicos === 0 ? null : null)
        ),
        gestionesPorCaso: delta(
          actual.gestionesPorCaso,
          previo.gestionesPorCaso ?? null
        ),
        tasaContactabilidad: delta(
          actual.tasaContactabilidad,
          previo.tasaContactabilidad ?? null
        ),
        efectividadContacto: delta(
          actual.efectividadContacto,
          previo.efectividadContacto ?? null
        ),
        dnisPorDiaHabil: delta(
          actual.dnisPorDiaHabil,
          previo.dnisPorDiaHabil ?? null
        ),
        ritmoEntreCasosMin: delta(
          actual.ritmoEntreCasosMin,
          previo.ritmoEntreCasosMin ?? null
        ),
        mailsPorDniMailLibre: delta(
          actual.promedioMailsPorDni,
          previo.promedioMailsPorDni ?? null
        ),
      },
      previoSinDatos: !prevGestiones || prevGestiones === 0,
    };

    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// --- NUEVO: /api/reportes-gestiones/analytics/resumen-dia
export async function resumenDia(req, res) {
  try {
    const usuarioId = req?.user?.id || req?.usuario?._id || req?.userId || null;
    if (!usuarioId)
      return res.status(401).json({ error: "Token invalido o ausente." });

    const { fecha, operador, entidad, tipoContacto, estadoCuenta } =
      req.query || {};
    if (!fecha)
      return res
        .status(400)
        .json({ error: "Falta parametro fecha (YYYY-MM-DD)" });

    const d = new Date(fecha);
    if (isNaN(d)) return res.status(400).json({ error: "Fecha invalida" });
    const desde = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    );
    const hasta = new Date(desde.getTime() + 86399999);

    const escapeRegex = (s = "") =>
      String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rxExact = (s) =>
      new RegExp(`^${escapeRegex(String(s).trim())}$`, "i");

    // 🔹 Match GLOBAL: ya no filtramos por propietario, solo por fecha + filtros
    const match = {
      fecha: { $gte: desde, $lte: hasta },
    };
    if (operador) match.usuario = rxExact(operador);
    if (entidad) match.entidad = rxExact(entidad);
    if (tipoContacto) match.tipoContacto = rxExact(tipoContacto);
    if (estadoCuenta) match.estadoCuenta = rxExact(estadoCuenta);

    const horaNum = {
      $toInt: {
        $concat: [
          { $substr: ["$hora", 0, 2] },
          { $substr: ["$hora", 3, 2] },
          { $substr: ["$hora", 6, 2] },
        ],
      },
    };

    const rows = await ReporteGestion.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$usuario",
          dnisSet: { $addToSet: "$dni" },
          gestiones: { $sum: 1 },
          minHora: { $min: "$hora" }, // ← usamos la cadena "HH:mm:ss"
          maxHora: { $max: "$hora" },
        },
      },
      {
        $project: {
          _id: 0,
          usuario: "$_id",
          dnisUnicos: { $size: "$dnisSet" },
          gestiones: 1,

          // Mostrar HH:mm directo desde la cadena
          primeraHora: { $substr: ["$minHora", 0, 5] },
          ultimaHora: { $substr: ["$maxHora", 0, 5] },

          // Para diferencia, pasamos HH:mm:ss a segundos
          minSecs: {
            $add: [
              {
                $multiply: [{ $toInt: { $substr: ["$minHora", 0, 2] } }, 3600],
              },
              { $multiply: [{ $toInt: { $substr: ["$minHora", 3, 2] } }, 60] },
              { $toInt: { $substr: ["$minHora", 6, 2] } },
            ],
          },
          maxSecs: {
            $add: [
              {
                $multiply: [{ $toInt: { $substr: ["$maxHora", 0, 2] } }, 3600],
              },
              { $multiply: [{ $toInt: { $substr: ["$maxHora", 3, 2] } }, 60] },
              { $toInt: { $substr: ["$maxHora", 6, 2] } },
            ],
          },
        },
      },
      {
        $addFields: {
          minTrabajados: {
            $max: [0, { $subtract: ["$maxSecs", "$minSecs"] }],
          },
          horasTrabajadasHHMM: {
            $let: {
              vars: {
                totalMin: { $floor: { $divide: ["$minTrabajados", 60] } },
              },
              in: {
                $concat: [
                  // horas
                  {
                    $toString: {
                      $floor: { $divide: ["$minTrabajados", 3600] },
                    },
                  },
                  ":",
                  // minutos dos digitos
                  {
                    $substr: [
                      {
                        $concat: [
                          "00",
                          { $toString: { $mod: ["$$totalMin", 60] } },
                        ],
                      },
                      {
                        $subtract: [
                          {
                            $strLenCP: {
                              $concat: [
                                "00",
                                { $toString: { $mod: ["$$totalMin", 60] } },
                              ],
                            },
                          },
                          2,
                        ],
                      },
                      2,
                    ],
                  },
                ],
              },
            },
          },
        },
      },
      { $sort: { usuario: 1 } },
    ]).collation({ locale: "es", strength: 1 });

    return res.json({ ok: true, fecha, rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// --- NUEVO: /api/reportes-gestiones/analytics/calendario-mes
export async function calendarioMes(req, res) {
  try {
    const usuarioId = req?.user?.id || req?.usuario?._id || req?.userId || null;
    if (!usuarioId)
      return res.status(401).json({ error: "Token invalido o ausente." });

    const { mes, operador, entidad, tipoContacto, estadoCuenta } =
      req.query || {};
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
      return res.status(400).json({ error: "Falta parametro mes (YYYY-MM)" });
    }

    const [yy, mm] = mes.split("-").map(Number);
    const desde = new Date(Date.UTC(yy, mm - 1, 1));
    const hasta = new Date(Date.UTC(yy, mm, 0, 23, 59, 59, 999));

    const escapeRegex = (s = "") =>
      String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rxExact = (s) =>
      new RegExp(`^${escapeRegex(String(s).trim())}$`, "i");

    // 🔹 Match GLOBAL: ya no filtramos por propietario, solo por fecha + filtros
    const match = {
      fecha: { $gte: desde, $lte: hasta },
    };
    if (operador) match.usuario = rxExact(operador);
    if (entidad) match.entidad = rxExact(entidad);
    if (tipoContacto) match.tipoContacto = rxExact(tipoContacto);
    if (estadoCuenta) match.estadoCuenta = rxExact(estadoCuenta);

    const horaNum = {
      $toInt: {
        $concat: [
          { $substr: ["$hora", 0, 2] },
          { $substr: ["$hora", 3, 2] },
          { $substr: ["$hora", 6, 2] },
        ],
      },
    };

    let agg = await ReporteGestion.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            dia: { $dateToString: { date: "$fecha", format: "%Y-%m-%d" } },
          },
          dnisSet: { $addToSet: "$dni" },
          gestiones: { $sum: 1 },
          minHora: { $min: "$hora" }, // ← cadena
          maxHora: { $max: "$hora" },
        },
      },
      {
        $project: {
          _id: 0,
          fecha: "$_id.dia",
          dnisUnicos: { $size: "$dnisSet" },
          gestiones: 1,

          // Mostrar HH:mm
          inicio: { $substr: ["$minHora", 0, 5] },
          fin: { $substr: ["$maxHora", 0, 5] },

          // segundos para fichas/hora si lo necesitas despues
          minSecs: {
            $add: [
              {
                $multiply: [{ $toInt: { $substr: ["$minHora", 0, 2] } }, 3600],
              },
              { $multiply: [{ $toInt: { $substr: ["$minHora", 3, 2] } }, 60] },
              { $toInt: { $substr: ["$minHora", 6, 2] } },
            ],
          },
          maxSecs: {
            $add: [
              {
                $multiply: [{ $toInt: { $substr: ["$maxHora", 0, 2] } }, 3600],
              },
              { $multiply: [{ $toInt: { $substr: ["$maxHora", 3, 2] } }, 60] },
              { $toInt: { $substr: ["$maxHora", 6, 2] } },
            ],
          },
        },
      },
      {
        $addFields: {
          minTrabajados: { $max: [0, { $subtract: ["$maxSecs", "$minSecs"] }] },
          fichasPorHora: {
            $cond: [
              { $gt: ["$minTrabajados", 0] },
              {
                $divide: ["$dnisUnicos", { $divide: ["$minTrabajados", 3600] }],
              },
              0,
            ],
          },
        },
      },
      { $sort: { fecha: 1 } },
    ]).collation({ locale: "es", strength: 1 });

    // 🔹 Formatear correctamente las horas (placeholder por si querés tocar algo luego)
    agg = agg.map((d) => ({
      ...d,
    }));

    return res.json({ ok: true, mes, dias: agg });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// --- NUEVO: /api/reportes-gestiones/analytics/calendario-matriz
export async function calendarioMesMatriz(req, res) {
  try {
    const usuarioId = req?.user?.id || req?.usuario?._id || req?.userId || null;
    if (!usuarioId)
      return res.status(401).json({ error: "Token invalido o ausente." });

    const { mes, operador, entidad, tipoContacto, estadoCuenta } =
      req.query || {};
    if (!/^\d{4}-\d{2}$/.test(mes || "")) {
      return res
        .status(400)
        .json({ error: "Parametro 'mes' invalido (yyyy-mm)." });
    }

    const year = Number(mes.slice(0, 4));
    const month = Number(mes.slice(5, 7)) - 1;
    const d1 = new Date(Date.UTC(year, month, 1));
    const d2 = new Date(Date.UTC(year, month + 1, 0));
    const endOfDay = (d) => new Date(d.getTime() + 86399999);

    // 🔹 Base GLOBAL: ya no filtramos por propietario, solo por fecha
    const base = {
      fecha: { $gte: d1, $lte: endOfDay(d2) },
    };

    const escapeRegex = (s = "") =>
      String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rxExact = (s) =>
      new RegExp(`^${escapeRegex(String(s).trim())}$`, "i");

    if (operador) base.usuario = rxExact(operador);
    if (entidad) base.entidad = rxExact(entidad);
    if (tipoContacto) base.tipoContacto = rxExact(tipoContacto);
    if (estadoCuenta) base.estadoCuenta = rxExact(estadoCuenta);

    const agg = await ReporteGestion.aggregate([
      { $match: base },
      {
        $project: {
          usuario: 1,
          d: { $dateToString: { date: "$fecha", format: "%Y-%m-%d" } },
          dni: 1,
        },
      },
      {
        $group: {
          _id: { usuario: "$usuario", d: "$d" },
          dnis: { $addToSet: "$dni" },
        },
      },
      {
        $project: {
          _id: 0,
          usuario: "$_id.usuario",
          d: "$_id.d",
          cuentas: { $size: "$dnis" },
        },
      },
      { $sort: { usuario: 1, d: 1 } },
    ]).collation({ locale: "es", strength: 1 });

    // 🔹 Crear cabecera de dias del mes
    const diasCabecera = [];
    for (let day = 1; day <= d2.getUTCDate(); day++) {
      const iso = `${mes}-${String(day).padStart(2, "0")}`;
      diasCabecera.push(iso);
    }

    // 🔹 Pivot a { usuario, dias: { yyyy-mm-dd: cuentas } }
    const mapa = new Map();
    for (const r of agg) {
      if (!mapa.has(r.usuario))
        mapa.set(r.usuario, { usuario: r.usuario, dias: {} });
      mapa.get(r.usuario).dias[r.d] = r.cuentas;
    }
    const usuariosMatriz = Array.from(mapa.values());

    // 🔹 Totales por dia (para vista de resumen general)
    const totalesPorDia = new Map();
    for (const u of usuariosMatriz) {
      for (const d of Object.keys(u.dias)) {
        totalesPorDia.set(d, (totalesPorDia.get(d) || 0) + u.dias[d]);
      }
    }
    const dias = diasCabecera.map((d) => ({
      dia: d,
      cuentas: totalesPorDia.get(d) || 0,
    }));

    return res.json({ ok: true, dias, usuariosMatriz, diasCabecera });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// --- /api/reportes-gestiones/analytics/casos-nuevos (90 días, sin lookup) ---
export async function casosNuevos(req, res) {
  try {
    // --- Auth ---
    const usuarioId = req?.user?.id || req?.usuario?._id || req?.userId || null;
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });

    // --- Helpers de fecha (normalizamos a día UTC) ---
    const toDateOnlyUTC = (s) => {
      if (!s) return null;
      const d = new Date(s);
      if (isNaN(d)) return null;
      return new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      );
    };
    const endOfDayUTC = (d) => new Date(d.getTime() + 86399999);

    // --- Params (acepta desde/hasta o fechaDesde/fechaHasta) ---
    const {
      desde,
      hasta,
      fechaDesde,
      fechaHasta,
      operador,
      entidad,
      tipoContacto,
      estadoCuenta,
      // opcional: días de ventana (default 90)
      minDias: minDiasStr,
    } = req.query || {};

    const d1 = toDateOnlyUTC(desde || fechaDesde);
    const d2 = toDateOnlyUTC(hasta || fechaHasta);
    if (!d1 || !d2 || d2 < d1) {
      return res.status(400).json({ error: "Rango de fechas inválido." });
    }

    const MIN_DIAS = Number.isFinite(Number(minDiasStr))
      ? Math.max(0, Number(minDiasStr))
      : 90; // 🎯 por defecto 90 días

    // 🔹 Ya no usamos ownerId / propietario, el cálculo es GLOBAL

    // --- 1) DNI “recientes”: tuvieron al menos UNA gestión en [d1 - MIN_DIAS, d1)
    const corteInicio = new Date(d1.getTime() - MIN_DIAS * 86400000); // d1 - 90 días
    const recientesDNIs = await ReporteGestion.distinct("dni", {
      fecha: { $gte: corteInicio, $lt: d1 },
    }).collation({ locale: "es", strength: 1 }); // respeta normalización

    const recientesSet = new Set(recientesDNIs);

    // --- 2) DNIs gestionados en el rango actual, con filtros “visibles” (operador/entidad/etc)
    const baseMatch = {
      fecha: { $gte: d1, $lte: endOfDayUTC(d2) },
    };
    if (operador) baseMatch.usuario = operador; // igualdad pura => index-friendly
    if (entidad) baseMatch.entidad = entidad;
    if (tipoContacto) baseMatch.tipoContacto = tipoContacto;
    if (estadoCuenta) baseMatch.estadoCuenta = estadoCuenta;

    // En vez de $lookup, traemos pares (operador, dni) y agregamos en Node
    const pares = await ReporteGestion.aggregate([
      { $match: baseMatch },
      { $group: { _id: { operador: "$usuario", dni: "$dni" } } },
      { $project: { _id: 0, operador: "$_id.operador", dni: "$_id.dni" } },
    ])
      .allowDiskUse(true)
      .option({ maxTimeMS: 20000 })
      .collation({ locale: "es", strength: 1 });

    // --- 3) Agregado en memoria: por operador, contá “casosDistintos” y “casosNuevos”
    const porOperador = new Map();
    for (const row of pares) {
      const op = String(row.operador || "").trim();
      const dni = String(row.dni || "").trim();
      if (!op || !dni) continue;

      if (!porOperador.has(op)) {
        porOperador.set(op, { casosDistintos: 0, casosNuevos: 0 });
      }
      const acc = porOperador.get(op);
      acc.casosDistintos += 1;
      if (!recientesSet.has(dni)) {
        acc.casosNuevos += 1;
      }
    }

    // --- 4) Salida formateada por operador + totales
    const totalCasosOperador = Array.from(porOperador.entries())
      .map(([operador, vals]) => ({
        operador,
        casosDistintos: vals.casosDistintos,
        casosNuevos: vals.casosNuevos,
        pctNuevos: vals.casosDistintos
          ? (vals.casosNuevos * 100) / vals.casosDistintos
          : 0,
      }))
      .sort((a, b) =>
        a.operador.localeCompare(b.operador, "es", { sensitivity: "base" })
      );

    const totales = totalCasosOperador.reduce(
      (a, x) => ({
        casosNuevos: a.casosNuevos + (x.casosNuevos || 0),
        casosDistintos: a.casosDistintos + (x.casosDistintos || 0),
      }),
      { casosNuevos: 0, casosDistintos: 0 }
    );
    totales.pctNuevos = totales.casosDistintos
      ? (totales.casosNuevos * 100) / totales.casosDistintos
      : 0;

    return res.json({
      ok: true,
      totalCasosOperador,
      totales,
      params: {
        desde: d1.toISOString().slice(0, 10),
        hasta: d2.toISOString().slice(0, 10),
        operador: operador || null,
        entidad: entidad || null,
        tipoContacto: tipoContacto || null,
        estadoCuenta: estadoCuenta || null,
        minDias: MIN_DIAS,
      },
    });
  } catch (e) {
    if (
      String(e?.message || "")
        .toLowerCase()
        .includes("exceeded time limit")
    ) {
      return res
        .status(504)
        .json({ error: "Timeout en cálculo de casos nuevos (maxTimeMS)." });
    }
    return res.status(500).json({ error: e.message || "Error interno." });
  }
}
