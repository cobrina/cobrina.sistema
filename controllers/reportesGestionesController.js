// BACKEND/controllers/reportesGestionesController.js probando
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

/** Helper: rol del usuario desde el token (compat) */
function getUsuarioRol(req) {
  return (
    req?.user?.rol ||
    req?.user?.role ||
    req?.usuario?.rol ||
    req?.usuario?.role ||
    null
  );
}

/** Bloqueo: operadores no pueden acceder a Reportes */
function ensureNoOperador(req, res) {
  const rol = String(getUsuarioRol(req) || "").toLowerCase();
  if (rol === "operador") {
    res.status(403).json({
      error: "Acceso denegado: operadores no tienen acceso a Reportes.",
    });
    return false;
  }
  return true;
}

/**
 * Scope multi-tenant:
 * - admin/super-admin => ven TODO (no filtra por propietario)
 * - otros roles => por seguridad, filtra por propietario
 * - opcional onlyMine=true => incluso admin/super ve solo lo suyo
 */
function ownerScope(req) {
  const usuarioId = getUsuarioId(req);
  const rol = String(getUsuarioRol(req) || "").toLowerCase();

  const onlyMine =
    String(req?.query?.onlyMine ?? req?.body?.onlyMine ?? "").toLowerCase() ===
    "true";

  if (!usuarioId) return {};

  const isAdminLike = rol === "admin" || rol === "super-admin" || rol === "superadmin";

  if (isAdminLike && !onlyMine) {
    return {}; // ✅ ver todo
  }

  // ✅ fallback: ver solo lo propio
  return { propietario: new mongoose.Types.ObjectId(usuarioId) };
}

/**
 * Cancel “soft”:
 * - Si el cliente cambia de pantalla / cancela fetch => se dispara "close"
 * - No podemos abortar una query Mongo ya enviada, pero evitamos seguir
 *   y devolvemos 499 si se cortó la conexión.
 */
function attachAbortFlag(req, res) {
  req.__aborted = false;
  res.on("close", () => {
    req.__aborted = true;
  });
}
function throwIfAborted(req) {
  if (req?.aborted || req?.__aborted) {
    const err = new Error("CLIENT_ABORTED");
    err.code = "CLIENT_ABORTED";
    throw err;
  }
}

const escapeRegex = (s = "") =>
  String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ✅ NUEVO: soporta filtros múltiples (CSV) o array
const splitCSV = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) raw = raw.join(",");
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

// ✅ NUEVO: regex exacta (case-insensitive) para 1 o muchos valores (CSV)
// Devuelve: /^(... )$/i  ó  { $in: [/^...$/i, /^...$/i] }
const rxExactMulti = (raw, mapFn = (x) => x) => {
  const arr = splitCSV(raw)
    .map((x) => mapFn(String(x).trim()))
    .filter(Boolean);
  if (!arr.length) return null;

  const regs = arr.map((v) => new RegExp(`^${escapeRegex(v)}$`, "i"));
  return regs.length === 1 ? regs[0] : { $in: regs };
};

// ✅ NUEVO: exact match index-friendly (strings) para 1 o muchos valores (CSV)
// Útil si el campo ya está normalizado (usuario lower, entidad upper)
const inExactMultiStrings = (raw, mapFn = (x) => x) => {
  const arr = splitCSV(raw)
    .map((x) => mapFn(String(x).trim()))
    .filter(Boolean);
  if (!arr.length) return null;
  return arr.length === 1 ? arr[0] : { $in: arr };
};

// Normaliza un string de fecha (dd/mm/yyyy, yyyy-mm-dd, serial Excel)
// a INICIO de día UTC (00:00:00.000)
function diaInicioUTC(raw) {
  const d = toDateOnly(raw); // usa el util (puede devolver null)
  if (!d) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
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
export async function ping(req, res) {
  try {
    attachAbortFlag(req, res);
    return res.json({ ok: true, ts: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export async function cargar(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) {
      return res.status(401).json({ error: "Token invalido o ausente." });
    }

    // ✅ Operadores NO pueden acceder
    if (!ensureNoOperador(req, res)) return;

    const { filas = [], fuenteArchivo = "", reemplazarTodo = false } = req.body || {};
    if (!Array.isArray(filas) || filas.length === 0) {
      return res.status(400).json({ error: "No hay filas para cargar." });
    }

    // ✅ Seguridad: cargar siempre pertenece al usuario que cargó (propietario)
    // ✅ Si marcás reemplazarTodo, borra SOLO el universo de este propietario
    if (reemplazarTodo) {
      await ReporteGestion.deleteMany({
        propietario: new mongoose.Types.ObjectId(usuarioId),
      });
    }

    const norm = (s) => String(s ?? "").trim();
    const normUser = (s) => norm(s).toLowerCase();
    const normEntidad = (s) => norm(s).toUpperCase();

    const [empleados, entidades] = await Promise.all([
      Empleado.find({ isActive: true }).select("username").lean(),
      Entidad.find().select("nombre").lean(),
    ]);

    const setUsers = new Set(empleados.map((e) => String(e.username || "").toLowerCase()));
    const setEnts = new Set(entidades.map((e) => String(e.nombre || "").toUpperCase()));

    const errores = [];
    const seen = new Set();
    const docs = [];
    const rawRows = [];

    filas.forEach((f, idx) => {
      const row = idx + 2;

      const dni = norm(f?.DNI ?? f?.dni);
      const fechaStr = norm(f?.FECHA ?? f?.fecha);
      const horaStr = norm(f?.HORA ?? f?.hora);
      const usuarioRaw = norm(f?.USUARIO ?? f?.usuario);
      const entidadRaw = norm(f?.ENTIDAD ?? f?.entidad);

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

      const tipoContacto = norm(f?.["TIPO CONTACTO"] ?? f?.tipoContacto);
      const resultadoGestion = norm(f?.["RESULTADO GESTION"] ?? f?.resultadoGestion);
      const estadoCuenta = norm(f?.["ESTADO DE LA CUENTA"] ?? f?.estadoCuenta);

      const horaNorm = normalizarHora(horaStr) || "00:00:00";
      const fechaKey = fDate.toISOString().slice(0, 10);

      const usuario = normUser(usuarioRaw);
      let entidad = normEntidad(entidadRaw);
      if (entidad.length > 120) entidad = entidad.slice(0, 120);

      if (!setUsers.has(usuario)) {
        errores.push({
          fila: row,
          motivo: `Usuario "${usuarioRaw}" no existe como username activo en la tabla Empleados.`,
          row: { ...f },
        });
        return;
      }

      if (!setEnts.has(entidad)) {
        errores.push({
          fila: row,
          motivo: `Entidad "${entidadRaw}" no existe en la tabla Entidades.`,
          row: { ...f },
        });
        return;
      }

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

      const telMail = norm(f?.["TEL-MAIL MARCADO"] ?? f?.telMailMarcado);
      const nombreDeudor = norm(f?.["NOMBRE DEUDOR"] ?? f?.nombreDeudor);
      let observacion = norm(
        f?.["OBSERVACION GESTION"] ?? f?.observacionGestion ?? f?.observacion
      );
      if (observacion.length > 3000) observacion = observacion.slice(0, 3000);

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

      const mailsSoloTel = extraerEmails(telMail);

      docs.push({
        propietario: new mongoose.Types.ObjectId(usuarioId),
        fuenteArchivo,
        dni,
        nombreDeudor,
        fecha: fDate,
        hora: horaNorm,
        usuario,
        tipoContacto,
        resultadoGestion,
        estadoCuenta,
        telMailMarcado: telMail,
        observacionGestion: observacion,
        entidad,
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
      const inserted = await ReporteGestion.insertMany(docs, { ordered: false });
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
        const msg = w?.errmsg || w?.message || w?.err?.message || top?.message || "";
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
            w?.errmsg || w?.message || w?.err?.message || e?.message || "Error de insercion";
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
          motivo: "Gestion duplicada en BD (detectado por mensaje E11000 sin indice de fila)",
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
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

export async function listar(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });

    // ✅ Operadores NO pueden acceder
    if (!ensureNoOperador(req, res)) return;

    const {
      desde,
      hasta,
      operador,
      entidad,
      tipoContacto,
      estadoCuenta,
      dni,
      page = 1,
      limit = 200,
      sortKey,
      sortDir,
      fields = "min",
    } = req.query || {};

    // ✅ Scope: admin/super ve todo; otros => solo su propietario
    const q = {
      ...ownerScope(req),
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

    // filtros multi (case-insensitive)
    const fUsuario = rxExactMulti(operador, (s) => s.toLowerCase());
    const fEntidad = rxExactMulti(entidad, (s) => s.toUpperCase());
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);

    if (fUsuario) q.usuario = fUsuario;
    if (fEntidad) q.entidad = fEntidad;
    if (fTipo) q.tipoContacto = fTipo;
    if (fEstado) q.estadoCuenta = fEstado;

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(1000, Math.max(1, Number(limit) || 200));
    const skip = (pageNum - 1) * limitNum;

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
    if (key === "fecha") sortStage = { fecha: dir, hora: dir, _id: 1 };
    else if (key === "hora") sortStage = { hora: dir, fecha: dir, _id: 1 };
    else sortStage = { [key]: dir, fecha: -1, hora: -1, _id: 1 };

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

    const projectStage = fields === "min" ? { $project: PROJ_MIN } : { $project: { __v: 0 } };

    throwIfAborted(req);

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
        .option({ maxTimeMS: 20000 })
        .collation({ locale: "es", strength: 2 }),
    ]);

    throwIfAborted(req);

    return res.json({
      ok: true,
      total,
      page: pageNum,
      pages: Math.max(1, Math.ceil(total / limitNum)),
      items,
    });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

export async function limpiar(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });

    // ✅ Operadores NO pueden acceder
    if (!ensureNoOperador(req, res)) return;

    const f = req.body?.filtros || {};
    const { desde, hasta, operador, entidad, tipoContacto, estadoCuenta, dni } = f;

    // ✅ Seguridad: limpiar por defecto SOLO mi propietario
    // (aunque seas admin/super). Si querés habilitar “borrar todo”, lo hacemos
    // con un flag explícito, pero NO lo prendo solo por ser admin.
    const q = { propietario: new mongoose.Types.ObjectId(usuarioId) };

    if (desde || hasta) {
      const dDesde = desde ? diaInicioUTC(String(desde).trim()) : null;
      const dHasta = hasta ? diaFinUTC(String(hasta).trim()) : null;
      if (dDesde || dHasta) {
        q.fecha = {};
        if (dDesde) q.fecha.$gte = dDesde;
        if (dHasta) q.fecha.$lte = dHasta;
      }
    }

    const fUsuario = rxExactMulti(operador, (s) => s.toLowerCase());
    const fEntidad = rxExactMulti(entidad, (s) => s.toUpperCase());
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);

    if (fUsuario) q.usuario = fUsuario;
    if (fEntidad) q.entidad = fEntidad;
    if (fTipo) q.tipoContacto = fTipo;
    if (fEstado) q.estadoCuenta = fEstado;

    const dniFilter = buildDniFilter(dni);
    if (dniFilter) q.dni = dniFilter;

    throwIfAborted(req);

    const r = await ReporteGestion.deleteMany(q);
    return res.json({ ok: true, borrados: r.deletedCount || 0 });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

/** GET /api/reportes-gestiones/export/pdf (stub hasta implementar server-side) */
export async function exportarPDF(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });

    if (!ensureNoOperador(req, res)) return;

    return res.status(501).json({ ok: false, message: "exportarPDF aun no implementado" });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

export async function catalogos(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });

    // ✅ Operadores NO pueden acceder
    if (!ensureNoOperador(req, res)) return;

    const { desde, hasta } = req.query || {};

    // ✅ base: admin/super => todo; otros => solo lo suyo
    const base = {
      ...ownerScope(req),
      borrado: { $ne: true },
    };

    if (desde || hasta) {
      const dDesde = desde ? diaInicioUTC(String(desde).trim()) : null;
      const dHasta = hasta ? diaFinUTC(String(hasta).trim()) : null;
      if (dDesde || dHasta) {
        base.fecha = {};
        if (dDesde) base.fecha.$gte = dDesde;
        if (dHasta) base.fecha.$lte = dHasta;
      }
    }

    throwIfAborted(req);

    const operadores = (
      await Empleado.find({ isActive: true }).select("username").sort({ username: 1 }).lean()
    ).map((e) => String(e.username || ""));

    const entidades = (await Entidad.find().select("nombre").sort({ numero: 1 }).lean()).map((x) =>
      String(x.nombre || "")
    );

    const [tiposRaw, estadosRaw] = await Promise.all([
      ReporteGestion.distinct("tipoContacto", base).collation({ locale: "es", strength: 1 }),
      ReporteGestion.distinct("estadoCuenta", base).collation({ locale: "es", strength: 1 }),
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
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

// controllers/reportesGestionesController.js
export async function comparativo(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });

    // ✅ Operadores NO pueden acceder
    if (!ensureNoOperador(req, res)) return;

    const { desde, hasta, operador, entidad, tipoContacto, estadoCuenta, dni } = req.query || {};

    const d1 = diaInicioUTC(desde);
    const d2 = diaInicioUTC(hasta);
    const endOfDayUTC = (d) => new Date(d.getTime() + 86399999);

    if (!d1 || !d2 || d2 < d1) {
      return res.status(400).json({ error: "Rango de fechas invalido" });
    }

    const days = Math.floor((endOfDayUTC(d2) - d1) / 86400000) + 1;
    const prevEnd = new Date(d1.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86400000);

    // ✅ Scope: admin/super => todo; otros => solo lo suyo
    // ✅ Scope: admin/super => todo; otros => solo lo suyo
const base = {
  ...ownerScope(req),
  borrado: { $ne: true },
};

const addFilters = (q) => {
  const out = { ...base };
  if (q?.fecha) out.fecha = q.fecha;

  const dniFilter = buildDniFilter(dni);
  if (dniFilter) out.dni = dniFilter;

  const fUsuario = rxExactMulti(operador, (s) => s.toLowerCase());
  const fEntidad = rxExactMulti(entidad, (s) => s.toUpperCase());
  const fTipo = rxExactMulti(tipoContacto);
  const fEstado = rxExactMulti(estadoCuenta);

  if (fUsuario) out.usuario = fUsuario;
  if (fEntidad) out.entidad = fEntidad;
  if (fTipo) out.tipoContacto = fTipo;
  if (fEstado) out.estadoCuenta = fEstado;

  return out;
};


    const qActual = addFilters({ fecha: { $gte: d1, $lte: endOfDayUTC(d2) } });
    const qPrevio = addFilters({ fecha: { $gte: prevStart, $lte: endOfDayUTC(prevEnd) } });

    const esContactoDoc = {
      $or: [
        { resultadoGestion: { $regex: /contactad[oa]/i } },
        { estadoCuenta: { $regex: /contactad[oa]/i } },
      ],
    };
    const esMailLibreDoc = { resultadoGestion: { $regex: /mail\s*libre/i } };

    const HORA_SAFE = {
      $convert: {
        input: "$hora",
        to: "string",
        onError: "00:00:00",
        onNull: "00:00:00",
      },
    };

    const pipelineKPIs = (matchQ) => [
      { $match: matchQ },
      {
        $project: {
          dni: 1,
          fecha: 1,
          horaStr: HORA_SAFE,
          usuario: 1,
          tipoContacto: 1,
          resultadoGestion: 1,
          estadoCuenta: 1,
          telMailMarcado: 1,
          isContacto: esContactoDoc,
          isMailLibre: esMailLibreDoc,
          horaHH: { $substrBytes: [HORA_SAFE, 0, 2] },
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
        },
      },
    ];

    throwIfAborted(req);

    const [actAgg, prevAgg] = await Promise.all([
      ReporteGestion.aggregate(pipelineKPIs(qActual))
        .allowDiskUse(true)
        .option({ maxTimeMS: 20000 })
        .collation({ locale: "es", strength: 1 }),
      ReporteGestion.aggregate(pipelineKPIs(qPrevio))
        .allowDiskUse(true)
        .option({ maxTimeMS: 20000 })
        .collation({ locale: "es", strength: 1 }),
    ]);

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

    const fold = (agg, rangoDiasHabiles) => {
      const base0 = agg?.[0]?.base?.[0] || {};
      const gestiones = base0.gestiones || 0;
      const dnisUnicos = (base0.dnisSet || []).filter(Boolean).length || 0;
      const contactos = base0.contactos || 0;

      const dnisPorDia = rangoDiasHabiles ? dnisUnicos / rangoDiasHabiles : 0;

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
        const sum = Array.from(mapaDniMails.values()).reduce((a, b) => a + b, 0);
        promedioMailsPorDni = sum / mapaDniMails.size;
      }

      const tasaContactabilidad = gestiones ? (contactos * 100) / gestiones : 0;

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
        efectividadContacto: 0,
        dnisPorDiaHabil: dnisPorDia,
        ritmoEntreCasosMin: null,
        promedioMailsPorDni,
        bestHoraPorcentaje: bestPct,
        bestHoraVolumen: bestVol,
      };
    };

    const rangoDiasActual = daysHabilesEntre(d1, d2);
    const rangoDiasPrevio = daysHabilesEntre(prevStart, prevEnd);

    const actual = fold(actAgg, rangoDiasActual);
    const previo = fold(prevAgg, rangoDiasPrevio);

    const delta = (act, prev) => {
      const a = Number.isFinite(Number(act)) ? Number(act) : null;
      const p = Number.isFinite(Number(prev)) ? Number(prev) : null;
      const deltaAbs = a != null && p != null ? Number(a) - Number(p) : null;
      const deltaPct = p != null && p !== 0 && a != null ? ((a - p) * 100) / p : null;
      return { actual: a, previo: p, deltaAbs, deltaPct };
    };

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
        gestionesTotales: delta(actual.gestiones, previo.gestiones),
        dnisUnicos: delta(actual.dnisUnicos, previo.dnisUnicos),
        gestionesPorCaso: delta(actual.gestionesPorCaso, previo.gestionesPorCaso),
        tasaContactabilidad: delta(actual.tasaContactabilidad, previo.tasaContactabilidad),
        efectividadContacto: delta(actual.efectividadContacto, previo.efectividadContacto),
        dnisPorDiaHabil: delta(actual.dnisPorDiaHabil, previo.dnisPorDiaHabil),
        ritmoEntreCasosMin: delta(actual.ritmoEntreCasosMin, previo.ritmoEntreCasosMin),
        mailsPorDniMailLibre: delta(actual.promedioMailsPorDni, previo.promedioMailsPorDni),
      },
      previoSinDatos: !previo.gestiones,
    };

    return res.json({ ok: true, ...out });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

const __cacheResumen = new Map(); // key -> { exp, data }
const CACHE_TTL_MS = 45_000;

function cacheGet(key) {
  const hit = __cacheResumen.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    __cacheResumen.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key, data) {
  __cacheResumen.set(key, { exp: Date.now() + CACHE_TTL_MS, data });
}

export async function analyticsResumen(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });

    // ✅ Operadores NO pueden acceder
    if (!ensureNoOperador(req, res)) return;

    // ✅ ahora acepta rango actual y rango previo explícito
    const {
      desde,
      hasta,
      prevDesde,
      prevHasta,
      operador,
      entidad,
      tipoContacto,
      estadoCuenta,
      dni,
      topN = 10,
    } = req.query || {};

    const topNNum = Math.max(1, Math.min(50, parseInt(topN, 10) || 10));

    const d1 = diaInicioUTC(desde);
    const d2 = diaInicioUTC(hasta);
    const p1 = prevDesde ? diaInicioUTC(prevDesde) : null;
    const p2 = prevHasta ? diaInicioUTC(prevHasta) : null;

    const endOfDayUTC = (d) => new Date(d.getTime() + 86399999);

    if (!d1 || !d2 || d2 < d1) {
      return res.status(400).json({ error: "Rango de fechas invalido" });
    }

    // ✅ si no mandan previo, mantiene el comportamiento anterior
    const days = Math.floor((endOfDayUTC(d2) - d1) / 86400000) + 1;
    const prevEndFallback = new Date(d1.getTime() - 86400000);
    const prevStartFallback = new Date(prevEndFallback.getTime() - (days - 1) * 86400000);

    const prevStart = p1 && p2 ? p1 : prevStartFallback;
    const prevEnd = p1 && p2 ? p2 : prevEndFallback;

    const dniFilter = buildDniFilter(dni);

    // ✅ más index-friendly para usuario y entidad (ya están normalizados en BD)
    const fUsuario = inExactMultiStrings(operador, (s) => s.toLowerCase());
    const fEntidad = inExactMultiStrings(entidad, (s) => s.toUpperCase());

    // (estos dos suelen venir “tal cual”, no garantizamos normalización)
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);

   // ✅ Scope: admin/super => todo; otros => solo lo suyo
const baseFiltros = {
  ...ownerScope(req),
  borrado: { $ne: true },
};

if (dniFilter) baseFiltros.dni = dniFilter;
if (fUsuario) baseFiltros.usuario = fUsuario;
if (fEntidad) baseFiltros.entidad = fEntidad;
if (fTipo) baseFiltros.tipoContacto = fTipo;
if (fEstado) baseFiltros.estadoCuenta = fEstado;

const matchActual = {
  ...baseFiltros,
  fecha: { $gte: d1, $lte: endOfDayUTC(d2) },
};

const matchPrevio = {
  ...baseFiltros,
  fecha: { $gte: prevStart, $lte: endOfDayUTC(prevEnd) },
};


    // ✅ cacheKey ya NO incluye owner fijo (porque admin/super ve todo)
    // (igual conserva filtros, rangos, etc.)
    const cacheKey = JSON.stringify({
      scope: String(req?.query?.onlyMine || req?.body?.onlyMine || "false"),
      d1: d1.toISOString().slice(0, 10),
      d2: d2.toISOString().slice(0, 10),
      prevStart: prevStart.toISOString().slice(0, 10),
      prevEnd: prevEnd.toISOString().slice(0, 10),
      operador: operador || null,
      entidad: entidad || null,
      tipoContacto: tipoContacto || null,
      estadoCuenta: estadoCuenta || null,
      dni: dni || null,
      topN: topNNum,
    });

    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const RESULTADO_SAFE = {
      $convert: { input: "$resultadoGestion", to: "string", onError: "", onNull: "" },
    };
    const ESTADO_SAFE = {
      $convert: { input: "$estadoCuenta", to: "string", onError: "", onNull: "" },
    };
    const HORA_SAFE = {
      $convert: { input: "$hora", to: "string", onError: "00:00:00", onNull: "00:00:00" },
    };

    const buildPipelineResumen = (matchQ) => [
      { $match: matchQ },
      {
        $project: {
          dni: 1,
          nombreDeudor: 1,
          fecha: 1,
          horaStr: HORA_SAFE,
          usuario: 1,
          entidad: 1,
          tipoContacto: 1,
          resultadoGestion: 1,
          estadoCuenta: 1,
          telMailMarcado: 1,
          isContacto: {
            $or: [
              { $regexMatch: { input: RESULTADO_SAFE, regex: /contactad[oa]/i } },
              { $regexMatch: { input: ESTADO_SAFE, regex: /contactad[oa]/i } },
            ],
          },
          isMailLibre: { $regexMatch: { input: RESULTADO_SAFE, regex: /mail\s*libre/i } },
          horaHH: { $substrBytes: [HORA_SAFE, 0, 2] },
          diaISO: { $dateToString: { date: "$fecha", format: "%Y-%m-%d" } },
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
          porHora: [
            {
              $group: {
                _id: "$horaHH",
                gestiones: { $sum: 1 },
                contactos: { $sum: { $cond: ["$isContacto", 1, 0] } },
              },
            },
            { $sort: { _id: 1 } },
          ],
          pieTipos: [
            { $match: { tipoContacto: { $not: /proceso|batch|autom[aá]tico|ignorar/i } } },
            { $group: { _id: "$tipoContacto", value: { $sum: 1 } } },
            { $sort: { value: -1, _id: 1 } },
          ],
          topGestiones: [
            { $group: { _id: "$dni", gestiones: { $sum: 1 } } },
            { $sort: { gestiones: -1, _id: 1 } },
            { $limit: topNNum },
          ],
          topDias: [
            { $group: { _id: { dni: "$dni", dia: "$diaISO" } } },
            { $group: { _id: "$_id.dni", diasTocados: { $sum: 1 } } },
            { $sort: { diasTocados: -1, _id: 1 } },
            { $limit: 10 },
            { $project: { _id: 1, diasTocados: 1 } },
          ],
          porDniMailLibre: [
            { $match: { isMailLibre: true, telMailMarcado: { $type: "string", $ne: "" } } },
            { $project: { dni: 1, mails: "$telMailMarcado" } },
          ],
        },
      },
    ];

    throwIfAborted(req);

    const [actAgg, prevAgg] = await Promise.all([
      ReporteGestion.aggregate(buildPipelineResumen(matchActual))
        .allowDiskUse(true)
        .option({ maxTimeMS: 25000 })
        .collation({ locale: "es", strength: 1 }),
      ReporteGestion.aggregate(buildPipelineResumen(matchPrevio))
        .allowDiskUse(true)
        .option({ maxTimeMS: 25000 })
        .collation({ locale: "es", strength: 1 }),
    ]);

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

    const foldKPIs = (agg, rangoDiasHabiles) => {
      const base0 = agg?.[0]?.base?.[0] || {};
      const gestiones = base0.gestiones || 0;
      const dnisUnicos = (base0.dnisSet || []).filter(Boolean).length || 0;
      const contactos = base0.contactos || 0;

      const gestionesPorCaso = dnisUnicos ? gestiones / dnisUnicos : 0;
      const tasaContactabilidad = gestiones ? (contactos * 100) / gestiones : 0;
      const dnisPorDiaHabil = rangoDiasHabiles ? dnisUnicos / rangoDiasHabiles : 0;

      const porDniMailLibre = agg?.[0]?.porDniMailLibre || [];
      const regexEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
      const mapa = new Map();
      for (const r of porDniMailLibre) {
        const mails = String(r.mails || "").match(regexEmail) || [];
        if (!mails.length) continue;
        const key = String(r.dni || "");
        mapa.set(key, (mapa.get(key) || 0) + mails.length);
      }
      let promedioMailsPorDni = 0;
      if (mapa.size) {
        const sum = Array.from(mapa.values()).reduce((a, b) => a + b, 0);
        promedioMailsPorDni = sum / mapa.size;
      }

      return {
        gestiones,
        dnisUnicos,
        gestionesPorCaso,
        tasaContactabilidad,
        dnisPorDiaHabil,
        mailsPorDniMailLibre: promedioMailsPorDni,
      };
    };

    const rangoDiasActual = daysHabilesEntre(d1, d2);
    const rangoDiasPrevio = daysHabilesEntre(prevStart, prevEnd);

    const kpiAct = foldKPIs(actAgg, rangoDiasActual);
    const kpiPrev = foldKPIs(prevAgg, rangoDiasPrevio);

    const delta = (act, prev) => {
      const a = Number.isFinite(Number(act)) ? Number(act) : null;
      const p = Number.isFinite(Number(prev)) ? Number(prev) : null;
      const deltaAbs = a != null && p != null ? a - p : null;
      const deltaPct = p != null && p !== 0 && a != null ? ((a - p) * 100) / p : null;
      return { actual: a, previo: p, deltaAbs, deltaPct };
    };

    const seriesHoraFromAgg = (agg) => {
      const porHora = agg?.[0]?.porHora || [];
      return porHora.map((h) => {
        const hh = String(h._id || "").padStart(2, "0");
        const tot = h.gestiones || 0;
        const cont = h.contactos || 0;
        return {
          hora: `${hh}:00`,
          gestiones: tot,
          tasaContacto: tot ? (cont * 100) / tot : 0,
        };
      });
    };

    const payload = {
      ok: true,
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
      filtros: {
        operador: operador || null,
        entidad: entidad || null,
        tipoContacto: tipoContacto || null,
        estadoCuenta: estadoCuenta || null,
        dni: dni || null,
        topN: topNNum,
        prevDesde: prevDesde || null,
        prevHasta: prevHasta || null,
      },
      actual: {
        kpis: {
          gestionesTotales: delta(kpiAct.gestiones, kpiPrev.gestiones),
          dnisUnicos: delta(kpiAct.dnisUnicos, kpiPrev.dnisUnicos),
          gestionesPorCaso: delta(kpiAct.gestionesPorCaso, kpiPrev.gestionesPorCaso),
          tasaContactabilidad: delta(kpiAct.tasaContactabilidad, kpiPrev.tasaContactabilidad),
          dnisPorDiaHabil: delta(kpiAct.dnisPorDiaHabil, kpiPrev.dnisPorDiaHabil),
          mailsPorDniMailLibre: delta(kpiAct.mailsPorDniMailLibre, kpiPrev.mailsPorDniMailLibre),
        },
        seriesHora: seriesHoraFromAgg(actAgg),
        pieTipos: (actAgg?.[0]?.pieTipos || []).map((x) => ({
          name: String(x._id || "SIN_TIPO").trim() || "SIN_TIPO",
          value: x.value || 0,
        })),
        topGestiones: actAgg?.[0]?.topGestiones || [],
        topDias: actAgg?.[0]?.topDias || [],
      },
      previo: {
        kpis: {
          gestiones: kpiPrev.gestiones,
          dnisUnicos: kpiPrev.dnisUnicos,
          gestionesPorCaso: kpiPrev.gestionesPorCaso,
          tasaContactabilidad: kpiPrev.tasaContactabilidad,
          dnisPorDiaHabil: kpiPrev.dnisPorDiaHabil,
          mailsPorDniMailLibre: kpiPrev.mailsPorDniMailLibre,
        },
      },
      previoSinDatos: !kpiPrev.gestiones,
    };

    cacheSet(cacheKey, payload);
    return res.json(payload);
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    console.error("❌ analyticsResumen ERROR:", e);
    return res.status(500).json({
      error: e?.message || "Error interno",
      stack: process.env.NODE_ENV === "development" ? e?.stack : undefined,
    });
  }
}

export async function resumenDia(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });

    // ✅ Operadores NO pueden acceder
    if (!ensureNoOperador(req, res)) return;

    const {
      fecha,
      operador,
      entidad,
      tipoContacto,
      estadoCuenta,
      dni,
      minDias = 90, // ✅ ventana para “casos nuevos” en asistencia
    } = req.query || {};

    if (!fecha) {
      return res.status(400).json({ error: "Falta parametro fecha (YYYY-MM-DD)" });
    }

    const d = new Date(fecha);
    if (isNaN(d)) return res.status(400).json({ error: "Fecha invalida" });

    const desde = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const hasta = new Date(desde.getTime() + 86399999);

    const MIN_DIAS = Number.isFinite(Number(minDias)) ? Math.max(0, Number(minDias)) : 90;
    const corteInicio = new Date(desde.getTime() - MIN_DIAS * 86400000);

    // ✅ Scope: admin/super => todo; otros => solo lo suyo
    const matchBase = {
      ...ownerScope(req),
      borrado: { $ne: true },
    };

    const matchDia = {
      ...matchBase,
      fecha: { $gte: desde, $lte: hasta },
    };

    const dniFilter = buildDniFilter(dni);
    if (dniFilter) matchDia.dni = dniFilter;

    const fUsuario = rxExactMulti(operador, (s) => s.toLowerCase());
    const fEntidad = rxExactMulti(entidad, (s) => s.toUpperCase());
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);

    if (fUsuario) matchDia.usuario = fUsuario;
    if (fEntidad) matchDia.entidad = fEntidad;
    if (fTipo) matchDia.tipoContacto = fTipo;
    if (fEstado) matchDia.estadoCuenta = fEstado;

    // Para “casos nuevos” necesitamos también el mismo filtro pero en ventana previa
    const matchPrev = {
      ...matchBase,
      fecha: { $gte: corteInicio, $lt: desde },
    };
    if (dniFilter) matchPrev.dni = dniFilter;
    if (fUsuario) matchPrev.usuario = fUsuario;
    if (fEntidad) matchPrev.entidad = fEntidad;
    if (fTipo) matchPrev.tipoContacto = fTipo;
    if (fEstado) matchPrev.estadoCuenta = fEstado;

    const HORA_SAFE = {
      $convert: { input: "$hora", to: "string", onError: "00:00:00", onNull: "00:00:00" },
    };

    throwIfAborted(req);

    // 1) pares (usuario,dni) del día
    const paresDia = await ReporteGestion.aggregate([
      { $match: matchDia },
      { $project: { usuario: 1, dni: 1, horaSafe: HORA_SAFE } },
      { $group: { _id: { usuario: "$usuario", dni: "$dni" } } },
      { $project: { _id: 0, usuario: "$_id.usuario", dni: "$_id.dni" } },
    ])
      .allowDiskUse(true)
      .option({ maxTimeMS: 20000 })
      .collation({ locale: "es", strength: 1 });

    throwIfAborted(req);

    // 2) pares (usuario,dni) en ventana previa (para saber si ya existían)
    const paresPrev = await ReporteGestion.aggregate([
      { $match: matchPrev },
      { $group: { _id: { usuario: "$usuario", dni: "$dni" } } },
      { $project: { _id: 0, k: { $concat: ["$_id.usuario", "|", "$_id.dni"] } } },
    ])
      .allowDiskUse(true)
      .option({ maxTimeMS: 20000 })
      .collation({ locale: "es", strength: 1 });

    const prevSet = new Set((paresPrev || []).map((x) => String(x.k || "")));

    // 3) Ahora sí: resumen por usuario (como tenías) + casos nuevos
    const matchResumen = { ...matchDia };
    // reutilizamos matchDia que ya tiene filtros y scope

    const rowsRaw = await ReporteGestion.aggregate([
      { $match: matchResumen },
      { $project: { usuario: 1, dni: 1, horaSafe: HORA_SAFE } },
      {
        $group: {
          _id: "$usuario",
          dnisSet: { $addToSet: "$dni" },
          gestiones: { $sum: 1 },
          minHora: { $min: "$horaSafe" },
          maxHora: { $max: "$horaSafe" },
        },
      },
      {
        $project: {
          _id: 0,
          usuario: "$_id",
          dnisUnicos: { $size: "$dnisSet" },
          gestiones: 1,
          primeraHora: { $substrBytes: ["$minHora", 0, 5] },
          ultimaHora: { $substrBytes: ["$maxHora", 0, 5] },
          minSecs: {
            $add: [
              { $multiply: [{ $toInt: { $substrBytes: ["$minHora", 0, 2] } }, 3600] },
              { $multiply: [{ $toInt: { $substrBytes: ["$minHora", 3, 2] } }, 60] },
              { $toInt: { $substrBytes: ["$minHora", 6, 2] } },
            ],
          },
          maxSecs: {
            $add: [
              { $multiply: [{ $toInt: { $substrBytes: ["$maxHora", 0, 2] } }, 3600] },
              { $multiply: [{ $toInt: { $substrBytes: ["$maxHora", 3, 2] } }, 60] },
              { $toInt: { $substrBytes: ["$maxHora", 6, 2] } },
            ],
          },
        },
      },
      {
        $addFields: {
          minTrabajados: { $max: [0, { $subtract: ["$maxSecs", "$minSecs"] }] },
          horasTrabajadasHHMM: {
            $let: {
              vars: { totalMin: { $floor: { $divide: ["$minTrabajados", 60] } } },
              in: {
                $concat: [
                  { $toString: { $floor: { $divide: ["$minTrabajados", 3600] } } },
                  ":",
                  {
                    $substrBytes: [
                      { $concat: ["00", { $toString: { $mod: ["$$totalMin", 60] } }] },
                      {
                        $subtract: [
                          { $strLenCP: { $concat: ["00", { $toString: { $mod: ["$$totalMin", 60] } }] } },
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
    ])
      .allowDiskUse(true)
      .option({ maxTimeMS: 20000 })
      .collation({ locale: "es", strength: 1 });

    // casos nuevos por usuario en el día (según ventana previa)
    const casosNuevosPorUsuario = new Map();
    for (const p of paresDia) {
      const u = String(p.usuario || "");
      const dnin = String(p.dni || "");
      if (!u || !dnin) continue;
      const k = `${u}|${dnin}`;
      if (!prevSet.has(k)) {
        casosNuevosPorUsuario.set(u, (casosNuevosPorUsuario.get(u) || 0) + 1);
      }
    }

    const rows = (rowsRaw || []).map((r) => ({
      ...r,
      casosNuevos: casosNuevosPorUsuario.get(String(r.usuario || "")) || 0,
      minDias: MIN_DIAS,
    }));

    return res.json({ ok: true, fecha, rows });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

export async function calendarioMes(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });

    // ✅ Operadores NO pueden acceder
    if (!ensureNoOperador(req, res)) return;

    const { mes, operador, entidad, tipoContacto, estadoCuenta } = req.query || {};
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
      return res.status(400).json({ error: "Falta parametro mes (YYYY-MM)" });
    }

    const [yy, mm] = mes.split("-").map(Number);
    const desde = new Date(Date.UTC(yy, mm - 1, 1));
    const hasta = new Date(Date.UTC(yy, mm, 0, 23, 59, 59, 999));

    const match = {
      ...ownerScope(req),
      borrado: { $ne: true },
      fecha: { $gte: desde, $lte: hasta },
    };

    const fUsuario = rxExactMulti(operador, (s) => s.toLowerCase());
    const fEntidad = rxExactMulti(entidad, (s) => s.toUpperCase());
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);

    if (fUsuario) match.usuario = fUsuario;
    if (fEntidad) match.entidad = fEntidad;
    if (fTipo) match.tipoContacto = fTipo;
    if (fEstado) match.estadoCuenta = fEstado;

    const HORA_SAFE = {
      $convert: { input: "$hora", to: "string", onError: "00:00:00", onNull: "00:00:00" },
    };

    throwIfAborted(req);

    let agg = await ReporteGestion.aggregate([
      { $match: match },
      { $project: { fecha: 1, dni: 1, horaSafe: HORA_SAFE } },
      {
        $group: {
          _id: { dia: { $dateToString: { date: "$fecha", format: "%Y-%m-%d" } } },
          dnisSet: { $addToSet: "$dni" },
          gestiones: { $sum: 1 },
          minHora: { $min: "$horaSafe" },
          maxHora: { $max: "$horaSafe" },
        },
      },
      {
        $project: {
          _id: 0,
          fecha: "$_id.dia",
          dnisUnicos: { $size: "$dnisSet" },
          gestiones: 1,
          inicio: { $substrBytes: ["$minHora", 0, 5] },
          fin: { $substrBytes: ["$maxHora", 0, 5] },
          minSecs: {
            $add: [
              { $multiply: [{ $toInt: { $substrBytes: ["$minHora", 0, 2] } }, 3600] },
              { $multiply: [{ $toInt: { $substrBytes: ["$minHora", 3, 2] } }, 60] },
              { $toInt: { $substrBytes: ["$minHora", 6, 2] } },
            ],
          },
          maxSecs: {
            $add: [
              { $multiply: [{ $toInt: { $substrBytes: ["$maxHora", 0, 2] } }, 3600] },
              { $multiply: [{ $toInt: { $substrBytes: ["$maxHora", 3, 2] } }, 60] },
              { $toInt: { $substrBytes: ["$maxHora", 6, 2] } },
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
              { $divide: ["$dnisUnicos", { $divide: ["$minTrabajados", 3600] }] },
              0,
            ],
          },
        },
      },
      { $sort: { fecha: 1 } },
    ])
      .allowDiskUse(true)
      .option({ maxTimeMS: 20000 })
      .collation({ locale: "es", strength: 1 });

agg = agg.map((d) => ({ ...d }));

    return res.json({ ok: true, mes, dias: agg });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

export async function calendarioMesMatriz(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });

    // ✅ Operadores NO pueden acceder
    if (!ensureNoOperador(req, res)) return;

    const { mes, operador, entidad, tipoContacto, estadoCuenta } = req.query || {};
    if (!/^\d{4}-\d{2}$/.test(mes || "")) {
      return res.status(400).json({ error: "Parametro 'mes' invalido (yyyy-mm)." });
    }

    const year = Number(mes.slice(0, 4));
    const month = Number(mes.slice(5, 7)) - 1;
    const d1 = new Date(Date.UTC(year, month, 1));
    const d2 = new Date(Date.UTC(year, month + 1, 0));
    const endOfDay = (d) => new Date(d.getTime() + 86399999);

    const base = {
      ...ownerScope(req),
      borrado: { $ne: true },
      fecha: { $gte: d1, $lte: endOfDay(d2) },
    };

    const fUsuario = rxExactMulti(operador, (s) => s.toLowerCase());
    const fEntidad = rxExactMulti(entidad, (s) => s.toUpperCase());
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);

    if (fUsuario) base.usuario = fUsuario;
    if (fEntidad) base.entidad = fEntidad;
    if (fTipo) base.tipoContacto = fTipo;
    if (fEstado) base.estadoCuenta = fEstado;

    throwIfAborted(req);

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
    ])
      .allowDiskUse(true)
      .option({ maxTimeMS: 20000 })
      .collation({ locale: "es", strength: 1 });

    const diasCabecera = [];
    for (let day = 1; day <= d2.getUTCDate(); day++) {
      const iso = `${mes}-${String(day).padStart(2, "0")}`;
      diasCabecera.push(iso);
    }

    const mapa = new Map();
    for (const r of agg) {
      if (!mapa.has(r.usuario)) mapa.set(r.usuario, { usuario: r.usuario, dias: {} });
      mapa.get(r.usuario).dias[r.d] = r.cuentas;
    }
    const usuariosMatriz = Array.from(mapa.values());

    const totalesPorDia = new Map();
    for (const u of usuariosMatriz) {
      for (const d of Object.keys(u.dias)) {
        totalesPorDia.set(d, (totalesPorDia.get(d) || 0) + u.dias[d]);
      }
    }
    const dias = diasCabecera.map((d) => ({ dia: d, cuentas: totalesPorDia.get(d) || 0 }));

    return res.json({ ok: true, dias, usuariosMatriz, diasCabecera });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

export async function casosNuevos(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token inválido o ausente." });

    // ✅ Operadores NO pueden acceder
    if (!ensureNoOperador(req, res)) return;

    const toDateOnlyUTC = (s) => {
      if (!s) return null;
      const d = new Date(s);
      if (isNaN(d)) return null;
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    };
    const endOfDayUTC = (d) => new Date(d.getTime() + 86399999);

    const {
      desde,
      hasta,
      fechaDesde,
      fechaHasta,
      operador,
      entidad,
      tipoContacto,
      estadoCuenta,
      minDias: minDiasStr,
      dni,
    } = req.query || {};

    const d1 = toDateOnlyUTC(desde || fechaDesde);
    const d2 = toDateOnlyUTC(hasta || fechaHasta);
    if (!d1 || !d2 || d2 < d1) {
      return res.status(400).json({ error: "Rango de fechas inválido." });
    }

    const MIN_DIAS = Number.isFinite(Number(minDiasStr)) ? Math.max(0, Number(minDiasStr)) : 90;

    // ✅ Scope: admin/super => todo; otros => solo lo suyo
    const baseTenant = {
      ...ownerScope(req),
      borrado: { $ne: true },
    };

    // filtros index-friendly (strings normalizados)
    // 🔥 OJO: ahora operador es OPCIONAL. Si viene vacío => trae por todos.
    const usuarioFilter = inExactMultiStrings(operador, (s) => s.toLowerCase());
    const entidadFilter = inExactMultiStrings(entidad, (s) => s.toUpperCase());
    const tipoFilter = inExactMultiStrings(tipoContacto, (s) => String(s));
    const estadoFilter = inExactMultiStrings(estadoCuenta, (s) => String(s));
    const dniFilter = buildDniFilter(dni);

    // 1) DNIs con actividad reciente antes del rango (ventana)
    const corteInicio = new Date(d1.getTime() - MIN_DIAS * 86400000);

    throwIfAborted(req);

    const recientesDNIs = await ReporteGestion.distinct("dni", {
      ...baseTenant,
      fecha: { $gte: corteInicio, $lt: d1 },
      ...(dniFilter ? { dni: dniFilter } : {}),
      ...(entidadFilter ? { entidad: entidadFilter } : {}),
      ...(tipoFilter ? { tipoContacto: tipoFilter } : {}),
      ...(estadoFilter ? { estadoCuenta: estadoFilter } : {}),
      ...(usuarioFilter ? { usuario: usuarioFilter } : {}),
    }).collation({ locale: "es", strength: 1 });

    const recientesSet = new Set(recientesDNIs);

    // 2) pares (operador,dni) del rango actual (ya filtrado)
    const baseMatch = {
      ...baseTenant,
      fecha: { $gte: d1, $lte: endOfDayUTC(d2) },
    };

    if (usuarioFilter) baseMatch.usuario = usuarioFilter;
    if (entidadFilter) baseMatch.entidad = entidadFilter;
    if (tipoFilter) baseMatch.tipoContacto = tipoFilter;
    if (estadoFilter) baseMatch.estadoCuenta = estadoFilter;
    if (dniFilter) baseMatch.dni = dniFilter;

    const pares = await ReporteGestion.aggregate([
      { $match: baseMatch },
      { $group: { _id: { operador: "$usuario", dni: "$dni" } } },
      { $project: { _id: 0, operador: "$_id.operador", dni: "$_id.dni" } },
    ])
      .allowDiskUse(true)
      .option({ maxTimeMS: 20000 })
      .collation({ locale: "es", strength: 1 });

    const porOperador = new Map();
    for (const row of pares) {
      const op = String(row.operador || "").trim();
      const dnin = String(row.dni || "").trim();
      if (!op || !dnin) continue;

      if (!porOperador.has(op)) porOperador.set(op, { casosDistintos: 0, casosNuevos: 0 });
      const acc = porOperador.get(op);
      acc.casosDistintos += 1;
      if (!recientesSet.has(dnin)) acc.casosNuevos += 1;
    }

    const totalCasosOperador = Array.from(porOperador.entries())
      .map(([operadorName, vals]) => ({
        operador: operadorName,
        casosDistintos: vals.casosDistintos,
        casosNuevos: vals.casosNuevos,
        pctNuevos: vals.casosDistintos ? (vals.casosNuevos * 100) / vals.casosDistintos : 0,
      }))
      .sort((a, b) => a.operador.localeCompare(b.operador, "es", { sensitivity: "base" }));

    const totales = totalCasosOperador.reduce(
      (a, x) => ({
        casosNuevos: a.casosNuevos + (x.casosNuevos || 0),
        casosDistintos: a.casosDistintos + (x.casosDistintos || 0),
      }),
      { casosNuevos: 0, casosDistintos: 0 }
    );
    totales.pctNuevos = totales.casosDistintos ? (totales.casosNuevos * 100) / totales.casosDistintos : 0;

    return res.json({
      ok: true,
      // ✅ ahora SIEMPRE se puede usar en asistencia sin seleccionar operador
      requireOperador: false,
      totalCasosOperador,
      totales,
      params: {
        desde: d1.toISOString().slice(0, 10),
        hasta: d2.toISOString().slice(0, 10),
        operador: operador || null,
        entidad: entidad || null,
        tipoContacto: tipoContacto || null,
        estadoCuenta: estadoCuenta || null,
        dni: dni || null,
        minDias: MIN_DIAS,
      },
    });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    if (String(e?.message || "").toLowerCase().includes("exceeded time limit")) {
      return res.status(504).json({ error: "Timeout en cálculo de casos nuevos (maxTimeMS)." });
    }
    return res.status(500).json({ error: e.message || "Error interno." });
  }
}


export async function ultimaActualizacion(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });

    // ✅ Operadores NO pueden acceder
    if (!ensureNoOperador(req, res)) return;

    const { operador, entidad, tipoContacto, estadoCuenta } = req.query || {};

    const match = {
      ...ownerScope(req),
      borrado: { $ne: true },
    };

    const fUsuario = rxExactMulti(operador, (s) => s.toLowerCase());
    const fEntidad = rxExactMulti(entidad, (s) => s.toUpperCase());
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);

    if (fUsuario) match.usuario = fUsuario;
    if (fEntidad) match.entidad = fEntidad;
    if (fTipo) match.tipoContacto = fTipo;
    if (fEstado) match.estadoCuenta = fEstado;

    const HORA_SAFE = {
      $convert: { input: "$hora", to: "string", onError: "00:00:00", onNull: "00:00:00" },
    };

    throwIfAborted(req);

    const [last] = await ReporteGestion.aggregate([
      { $match: match },
      { $sort: { fecha: -1, hora: -1, _id: -1 } },
      { $limit: 1 },
      {
        $project: {
          _id: 0,
          fecha: {
            $dateToString: { date: "$fecha", format: "%Y-%m-%d", timezone: "UTC" },
          },
          hora: { $substrBytes: [HORA_SAFE, 0, 5] },
        },
      },
    ])
      .allowDiskUse(false)
      .option({ maxTimeMS: 10000 })
      .collation({ locale: "es", strength: 1 });

    if (!last) return res.json({ ok: true, fecha: null, hora: null });

    return res.json({ ok: true, fecha: last.fecha, hora: last.hora });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}
