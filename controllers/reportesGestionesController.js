// BACKEND/controllers/reportesGestionesController.js probando
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import ReporteGestion from "../models/ReporteGestion.js";
import { extraerEmails } from "../utils/email.util.js";
import { toDateOnly, normalizarHora, fechaClaveArgentina, claveFechaCalendario } from "../utils/fecha.util.js";
import Empleado from "../models/Empleado.js";
import Entidad from "../models/Entidad.js";
import Pago from "../models/Pago.js";
import { invalidateSeguimientoCache } from "./reportesSeguimientoController.js";
import { invalidateCalidadCache } from "./calidadGestionesController.js";
import { filtrarEmpleadosControlados } from "../utils/controlEquipo.js";
import {
  transformarGestionEnAcuerdo,
  resumirAcuerdos,
  crearExcelAcuerdos,
  vincularPagosPosteriores,
  TIPOS_ACUERDO,
} from "../services/acuerdosGestionesService.js";


function validarConfirmacionDestructiva(req, fraseEsperada) {
  const header = String(req.headers["x-cobrina-confirm-delete"] || "").trim();
  const body = String(req.body?.confirmacion || "").trim();
  return header === fraseEsperada && body === fraseEsperada;
}

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

  const isAdminLike = ["capacitadora", "administracion", "supervisor", "super-admin"].includes(rol);

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

// Usuarios activos para métricas. No modifica ni elimina gestiones históricas:
// solamente evita que usuarios dados de baja sigan apareciendo en tableros actuales.
let __activeUsersCache = { exp: 0, names: [] };
async function getActiveUsernames() {
  if (Date.now() < __activeUsersCache.exp && __activeUsersCache.names.length) {
    return __activeUsersCache.names;
  }
  const rows = await Empleado.find({ isActive: { $ne: false } })
    .select("username")
    .lean();
  const names = rows
    .map((row) => String(row.username || "").trim().toLowerCase())
    .filter(Boolean);
  __activeUsersCache = { exp: Date.now() + 60_000, names };
  return names;
}

async function activeUserFilter(rawOperator) {
  const active = await getActiveUsernames();
  const activeSet = new Set(active);
  const requested = splitCSV(rawOperator)
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  const selected = requested.length
    ? requested.filter((value) => activeSet.has(value))
    : active;
  if (!selected.length) return { $in: ["__cobrina_sin_usuario_activo__"] };
  return selected.length === 1 ? selected[0] : { $in: selected };
}

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
      const frase = "REEMPLAZAR GESTIONES";
      if (!eliminacionReportesHabilitada()) {
        return res.status(403).json({
          error: "El reemplazo total está deshabilitado para proteger las gestiones existentes.",
        });
      }
      if (!validarConfirmacionDestructiva(req, frase)) {
        return res.status(400).json({
          error: "Falta la confirmación reforzada para reemplazar gestiones.",
        });
      }
      await ReporteGestion.deleteMany({
        propietario: new mongoose.Types.ObjectId(usuarioId),
      });
    }

    const norm = (s) => String(s ?? "").trim();
    const normUser = (s) => norm(s).toLowerCase();
    const normEntidad = (s) => norm(s).toUpperCase();

    const [empleados, entidades] = await Promise.all([
      Empleado.find({ isActive: true }).select("username").lean(),
      Entidad.find().select("numero nombre").lean(),
    ]);

    const setUsers = new Set(empleados.map((e) => String(e.username || "").toLowerCase()));
    const entidadesPorNombre = new Map();
    const entidadesPorNumero = new Map();
    entidades.forEach((e) => {
      const nombre = String(e.nombre || "").trim().toUpperCase();
      const numero = Number(e.numero);
      if (nombre) entidadesPorNombre.set(nombre, e);
      if (Number.isFinite(numero)) entidadesPorNumero.set(numero, e);
    });

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
      const entidadNumeroIngresado = /^\d+$/.test(entidadRaw) ? Number(entidadRaw) : null;
      const entidadCatalogo = entidadNumeroIngresado != null
        ? entidadesPorNumero.get(entidadNumeroIngresado)
        : entidadesPorNombre.get(normEntidad(entidadRaw));
      let entidad = normEntidad(entidadCatalogo?.nombre || entidadRaw);
      const entidadNumero = Number(entidadCatalogo?.numero);
      if (entidad.length > 120) entidad = entidad.slice(0, 120);

      if (!setUsers.has(usuario)) {
        errores.push({
          fila: row,
          motivo: `Usuario "${usuarioRaw}" no existe como username activo en la tabla Empleados.`,
          row: { ...f },
        });
        return;
      }

      if (!entidadCatalogo || !Number.isFinite(entidadNumero)) {
        errores.push({
          fila: row,
          motivo: `Entidad "${entidadRaw}" no existe en la tabla Entidades por nombre ni por número.`,
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
        entidadNumero,
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

    if (insertados > 0 || reemplazarTodo) {
      invalidateReportesAnalyticsCache();
      invalidateSeguimientoCache();
      invalidateCalidadCache();
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
      soloActivos = "false",
      withTotal = "true",
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

    if (String(soloActivos).toLowerCase() === "true") {
      q.usuario = await activeUserFilter(operador);
    } else if (fUsuario) {
      q.usuario = fUsuario;
    }
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

    const includeTotal = String(withTotal).toLowerCase() !== "false";
    const itemsPromise = ReporteGestion.aggregate([
      { $match: q },
      { $sort: sortStage },
      { $skip: skip },
      { $limit: limitNum },
      projectStage,
    ])
      .allowDiskUse(true)
      .option({ maxTimeMS: 20000 })
      .collation({ locale: "es", strength: 2 });

    const [total, items] = await Promise.all([
      includeTotal ? ReporteGestion.countDocuments(q) : Promise.resolve(null),
      itemsPromise,
    ]);

    throwIfAborted(req);

    return res.json({
      ok: true,
      total,
      page: pageNum,
      pages: total == null ? null : Math.max(1, Math.ceil(total / limitNum)),
      items,
    });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}



function fechaExportacionDMY(value) {
  const key = claveFechaCalendario(value);
  if (!key) return "";
  const [yyyy, mm, dd] = key.split("-");
  return `${dd}/${mm}/${yyyy}`;
}

function nombreArchivoGestiones(desde, hasta) {
  const clean = (value, fallback) => String(value || fallback).replace(/[^0-9A-Za-z_-]+/g, "_");
  return `Gestiones_${clean(desde, "inicio")}_a_${clean(hasta, "actualidad")}_TODO.xlsx`;
}

// Excel/XML no admite algunos caracteres de control. Aunque el schema limita
// tamaños, limpiamos el texto antes de escribirlo para que una observación
// importada con caracteres invisibles no arruine todo el XLSX.
function textoSeguroExcel(value, maxLength = 32767) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .slice(0, maxLength);
}

async function validarZipXlsxBasico(filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile() || stat.size < 200) {
    throw new Error("El archivo Excel generado quedó vacío o incompleto.");
  }

  const fh = await fsp.open(filePath, "r");
  try {
    const start = Buffer.alloc(4);
    await fh.read(start, 0, 4, 0);
    if (start[0] !== 0x50 || start[1] !== 0x4b) {
      throw new Error("El archivo generado no comienza con una estructura XLSX/ZIP válida.");
    }

    // Un ZIP válido debe contener el End Of Central Directory (PK\x05\x06)
    // en los últimos 65.557 bytes. Esto detecta archivos truncados antes de
    // entregarlos al navegador.
    const tailLength = Math.min(stat.size, 65557);
    const tail = Buffer.alloc(tailLength);
    await fh.read(tail, 0, tailLength, stat.size - tailLength);
    let eocd = false;
    for (let i = tail.length - 4; i >= 0; i -= 1) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
        eocd = true;
        break;
      }
    }
    if (!eocd) {
      throw new Error("El archivo Excel quedó truncado antes de cerrar su estructura ZIP.");
    }
  } finally {
    await fh.close();
  }
  return stat;
}

/**
 * GET /api/reportes-gestiones/export/excel
 * Exportación server-side por streaming. Evita traer cientos de miles de filas
 * al navegador antes de construir el XLSX y soporta volúmenes grandes (300k+).
 */
export async function exportarGestionesExcel(req, res) {
  let cursor = null;
  let tempDir = null;
  let tempFile = null;
  let etapa = "inicio";

  const cleanup = async () => {
    try { await cursor?.close?.(); } catch { /* noop */ }
    cursor = null;
    if (tempDir) {
      try { await fsp.rm(tempDir, { recursive: true, force: true }); } catch { /* noop */ }
      tempDir = null;
      tempFile = null;
    }
  };

  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const {
      desde,
      hasta,
      operador,
      entidad,
      tipoContacto,
      estadoCuenta,
      dni,
      sortKey,
      sortDir,
      soloActivos = "false",
    } = req.query || {};

    const q = {
      ...ownerScope(req),
      borrado: { $ne: true },
    };

    // Conservamos los límites también como variables para poder exportar por
    // segmentos diarios y evitar un sort global de cientos de miles de filas.
    const exportDesdeUTC = desde ? diaInicioUTC(String(desde).trim()) : null;
    const exportHastaUTC = hasta ? diaInicioUTC(String(hasta).trim()) : null;
    if (desde || hasta) {
      const dDesde = exportDesdeUTC;
      const dHasta = hasta ? diaFinUTC(String(hasta).trim()) : null;
      if (dDesde || dHasta) {
        q.fecha = {};
        if (dDesde) q.fecha.$gte = dDesde;
        if (dHasta) q.fecha.$lte = dHasta;
      }
    }

    const dniFilter = buildDniFilter(dni);
    if (dniFilter) q.dni = dniFilter;

    const fUsuario = rxExactMulti(operador, (value) => value.toLowerCase());
    const fEntidad = rxExactMulti(entidad, (value) => value.toUpperCase());
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);

    if (String(soloActivos).toLowerCase() === "true") q.usuario = await activeUserFilter(operador);
    else if (fUsuario) q.usuario = fUsuario;
    if (fEntidad) q.entidad = fEntidad;
    if (fTipo) q.tipoContacto = fTipo;
    if (fEstado) q.estadoCuenta = fEstado;

    // En exportaciones grandes priorizamos estabilidad. El archivo se ordena
    // por día según la dirección elegida en la tabla; evitamos ordenar cientos
    // de miles de documentos por columnas arbitrarias dentro de MongoDB.
    const dir = String(sortDir).toLowerCase() === "asc" ? 1 : -1;

    // Excel admite 1.048.576 filas por hoja. Dejamos un margen amplio para
    // encabezados y metadatos. La meta operativa es soportar hasta 300.000 filas por archivo en este entorno.
    const MAX_EXPORT_ROWS = 300000;
    etapa = "contando registros";
    const total = await ReporteGestion.countDocuments(q);
    if (!total) return res.status(404).json({ error: "No hay registros para exportar." });
    if (total > MAX_EXPORT_ROWS) {
      return res.status(413).json({
        error: `La selección contiene ${total.toLocaleString("es-AR")} gestiones. Para que la descarga sea estable, exportá como máximo ${MAX_EXPORT_ROWS.toLocaleString("es-AR")} por archivo. Acotá el rango Desde/Hasta y volvé a intentar.`,
      });
    }

    // IMPORTANTE: no escribimos el ZIP/XLSX directamente sobre la respuesta HTTP.
    // Primero se termina y valida el archivo temporal. Recién después se lo envía
    // al navegador, evitando descargas truncadas que Excel no puede abrir.
    etapa = "preparando archivo temporal";
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cobrina-gestiones-"));
    tempFile = path.join(tempDir, `gestiones-${crypto.randomUUID()}.xlsx`);

    etapa = "inicializando Excel";
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: tempFile,
      useStyles: false,
      useSharedStrings: false,
    });

    const ws = workbook.addWorksheet("Gestiones");
    ws.columns = [
      { header: "DNI", key: "dni", width: 14 },
      { header: "NOMBRE DEUDOR", key: "nombreDeudor", width: 28 },
      { header: "FECHA", key: "fecha", width: 12 },
      { header: "HORA", key: "hora", width: 11 },
      { header: "USUARIO", key: "usuario", width: 22 },
      { header: "TIPO CONTACTO", key: "tipoContacto", width: 20 },
      { header: "RESULTADO GESTIÓN", key: "resultadoGestion", width: 24 },
      { header: "ESTADO DE LA CUENTA", key: "estadoCuenta", width: 24 },
      { header: "TEL-MAIL MARCADO", key: "telMailMarcado", width: 24 },
      { header: "OBSERVACIÓN GESTIÓN", key: "observacionGestion", width: 52 },
      { header: "ENTIDAD", key: "entidad", width: 24 },
    ];

    // Con el writer streaming priorizamos compatibilidad y estabilidad del archivo.
    // No agregamos vistas/filtros que no son necesarios para la exportación masiva.
    ws.getRow(1).commit();

    const projection = {
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
    };

    // Para exportaciones masivas NO hacemos un sort global. En perfiles que
    // pueden ver varios propietarios, ese sort obliga a MongoDB a ordenar todo
    // el universo en memoria/disco y en esta instalación falla incluso con
    // allowDiskUse. En su lugar recorremos el rango día por día. `fecha` tiene
    // índice propio y cada cursor queda acotado a una sola jornada. El Excel
    // conserva el orden por día (asc/desc según la vista); dentro del mismo día
    // el orden es técnico, algo que puede reordenarse luego en Excel si hace falta.
    let exportados = 0;

    const escribirItem = (item) => {
      if (exportados >= MAX_EXPORT_ROWS) {
        const err = new Error(`La exportación superó el máximo de ${MAX_EXPORT_ROWS.toLocaleString("es-AR")} filas durante la generación.`);
        err.code = "EXPORT_TOO_LARGE";
        throw err;
      }
      ws.addRow({
        dni: textoSeguroExcel(item?.dni, 64),
        nombreDeudor: textoSeguroExcel(item?.nombreDeudor, 240),
        fecha: fechaExportacionDMY(item?.fecha),
        hora: normalizarHora(item?.hora || ""),
        usuario: textoSeguroExcel(item?.usuario, 120),
        tipoContacto: textoSeguroExcel(item?.tipoContacto, 180),
        resultadoGestion: textoSeguroExcel(item?.resultadoGestion, 240),
        estadoCuenta: textoSeguroExcel(item?.estadoCuenta, 180),
        telMailMarcado: textoSeguroExcel(item?.telMailMarcado, 1000),
        observacionGestion: textoSeguroExcel(item?.observacionGestion, 3000),
        entidad: textoSeguroExcel(item?.entidad, 120),
      }).commit();
      exportados += 1;
    };

    const consumirCursor = async (query, etiqueta) => {
      etapa = etiqueta;
      cursor = ReporteGestion.find(query)
        .maxTimeMS(10 * 60 * 1000)
        .select(projection)
        .lean()
        .cursor({ batchSize: 2000 });
      try {
        for await (const item of cursor) {
          if (req.aborted || req.__aborted) {
            const err = new Error("CLIENT_ABORTED");
            err.code = "CLIENT_ABORTED";
            throw err;
          }
          escribirItem(item);
        }
      } finally {
        await cursor?.close?.();
        cursor = null;
      }
    };

    if (exportDesdeUTC && exportHastaUTC) {
      const sentido = dir === 1 ? 1 : -1;
      const desdeMs = exportDesdeUTC.getTime();
      const hastaMs = exportHastaUTC.getTime();
      let diaMs = sentido === 1 ? desdeMs : hastaMs;
      const limiteMs = sentido === 1 ? hastaMs : desdeMs;
      let numeroDia = 0;

      while (sentido === 1 ? diaMs <= limiteMs : diaMs >= limiteMs) {
        numeroDia += 1;
        const inicioDia = new Date(diaMs);
        const finDia = new Date(diaMs + 86399999);
        const queryDia = {
          ...q,
          fecha: { $gte: inicioDia, $lte: finDia },
        };
        const keyDia = inicioDia.toISOString().slice(0, 10);
        await consumirCursor(queryDia, `leyendo gestiones del ${keyDia} (segmento ${numeroDia})`);
        diaMs += sentido * 86400000;
      }
    } else {
      // Sin ambos límites no podemos segmentar de forma determinística por día.
      // Aun así evitamos el sort global para priorizar que el archivo salga.
      await consumirCursor(q, "leyendo gestiones sin ordenamiento global");
    }

    etapa = "cerrando consulta MongoDB";

    etapa = "cerrando archivo Excel";
    ws.commit();
    await workbook.commit();

    // No exigimos igualdad exacta con el count inicial: entre el count y el
    // cursor puede terminar una importación concurrente. Lo importante es que
    // el XLSX se haya cerrado bien y reportar la cantidad REAL exportada.
    if (!exportados) {
      throw new Error("No se pudo escribir ninguna gestión en el archivo Excel.");
    }

    etapa = "validando archivo Excel";
    const stat = await validarZipXlsxBasico(tempFile);

    const filename = nombreArchivoGestiones(desde, hasta);
    etapa = "enviando descarga";
    res.status(200);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("X-Cobrina-Export-Rows", String(exportados));

    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(tempFile);
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      input.once("error", done);
      res.once("error", done);
      res.once("finish", () => done());
      res.once("close", () => {
        if (!res.writableFinished) {
          const err = new Error("CLIENT_ABORTED");
          err.code = "CLIENT_ABORTED";
          try { input.destroy(err); } catch { /* noop */ }
          done(err);
        }
      });
      input.pipe(res);
    });

    await cleanup();
    return;
  } catch (error) {
    await cleanup();
    if (req?.aborted || error?.code === "CLIENT_ABORTED") return;

    console.error("[ReporteGestiones][export/excel]", {
      etapa,
      message: error?.message,
      code: error?.code,
      codeName: error?.codeName,
      name: error?.name,
    });

    if (res.headersSent) {
      try { res.destroy(error); } catch { /* noop */ }
      return;
    }

    const msg = String(error?.message || "");
    const sortMemory =
      error?.code === 292 ||
      /QueryExceededMemoryLimitNoDiskUseAllowed|Sort exceeded memory limit|sort.*memory/i.test(msg);
    const sinEspacio = error?.code === "ENOSPC" || /no space left/i.test(msg);
    const demasiadoGrande = error?.code === "EXPORT_TOO_LARGE";

    const publicMessage = sortMemory
      ? "MongoDB no pudo completar la consulta masiva. Probá acotar el rango de fechas; Cobrina admite hasta 300.000 gestiones por archivo, pero el rendimiento también depende del volumen de cada período."
      : sinEspacio
        ? "El servidor no tiene espacio temporal suficiente para generar este Excel."
        : demasiadoGrande
          ? msg
          : (msg || "No se pudo exportar el Excel de gestiones.");

    return res.status(demasiadoGrande ? 413 : 500).json({
      error: publicMessage,
      etapa,
      codigo: error?.code || error?.codeName || error?.name || "EXPORT_ERROR",
    });
  }
}

export async function limpiar(req, res) {
  try {
    attachAbortFlag(req, res);

    const frase = "ELIMINAR GESTIONES";
    if (!validarConfirmacionDestructiva(req, frase)) {
      return res.status(400).json({
        error: "Falta la confirmación reforzada para eliminar gestiones.",
      });
    }

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });

    // ✅ Operadores NO pueden acceder
    if (!ensureNoOperador(req, res)) return;

    const f = req.body?.filtros || {};
    const { desde, hasta, operador, entidad, tipoContacto, estadoCuenta, dni } = f;

    const hayFiltroExplicito = Boolean(
      desde ||
        hasta ||
        (Array.isArray(operador) ? operador.length : String(operador || "").trim()) ||
        (Array.isArray(entidad) ? entidad.length : String(entidad || "").trim()) ||
        (Array.isArray(tipoContacto)
          ? tipoContacto.length
          : String(tipoContacto || "").trim()) ||
        (Array.isArray(estadoCuenta)
          ? estadoCuenta.length
          : String(estadoCuenta || "").trim()) ||
        String(dni || "").trim()
    );

    if (!hayFiltroExplicito) {
      return res.status(400).json({
        error: "Aplicá al menos un filtro antes de eliminar gestiones.",
      });
    }

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
    if ((r.deletedCount || 0) > 0) {
      invalidateReportesAnalyticsCache();
      invalidateSeguimientoCache();
      invalidateCalidadCache();
    }
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

    const empleadosActivosTodos = await Empleado.find({ isActive: true })
      .select("username nombre role horarioLaboral.modalidad horarioLaboral.entrada horarioLaboral.salida")
      .sort({ username: 1 })
      .lean();
    const empleadosActivos = filtrarEmpleadosControlados(empleadosActivosTodos);
    const operadores = empleadosActivos.map((e) => String(e.username || ""));
    const operadoresDetalle = empleadosActivos
      .map((empleado) => ({
        username: String(empleado.username || "").trim(),
        nombre: String(empleado.nombre || "").trim(),
        role: String(empleado.role || "").trim(),
        modalidadHorario: empleado?.horarioLaboral?.modalidad === "libre" ? "libre" : "fijo",
        entrada: String(empleado?.horarioLaboral?.entrada || "").trim(),
        salida: String(empleado?.horarioLaboral?.salida || "").trim(),
      }))
      .filter((empleado) => empleado.username);

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
      operadoresDetalle,
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

    // ✅ Scope: admin/super => todo; otros => solo lo suyo.
    // Las métricas excluyen empleados inactivos sin tocar las gestiones históricas.
    const base = {
      ...ownerScope(req),
      borrado: { $ne: true },
    };
    const activeFilter = await activeUserFilter(operador);
    const dniFilter = buildDniFilter(dni);
    const fEntidad = rxExactMulti(entidad, (s) => s.toUpperCase());
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);

    const addFilters = (q) => {
      const out = { ...base, usuario: activeFilter };
      if (q?.fecha) out.fecha = q.fecha;
      if (dniFilter) out.dni = dniFilter;
      if (fEntidad) out.entidad = fEntidad;
      if (fTipo) out.tipoContacto = fTipo;
      if (fEstado) out.estadoCuenta = fEstado;
      return out;
    };


    const qActual = addFilters({ fecha: { $gte: d1, $lte: endOfDayUTC(d2) } });
    const qPrevio = addFilters({ fecha: { $gte: prevStart, $lte: endOfDayUTC(prevEnd) } });

    const resultadoTextoSeguro = {
      $convert: { input: "$resultadoGestion", to: "string", onError: "", onNull: "" },
    };
    const estadoTextoSeguro = {
      $convert: { input: "$estadoCuenta", to: "string", onError: "", onNull: "" },
    };
    const esContactoExpr = {
      $or: [
        { $regexMatch: { input: resultadoTextoSeguro, regex: /contactad[oa]/i } },
        { $regexMatch: { input: estadoTextoSeguro, regex: /contactad[oa]/i } },
      ],
    };
    const mailTextoSeguro = {
      $toLower: {
        $concat: [
          { $convert: { input: "$tipoContacto", to: "string", onError: "", onNull: "" } },
          " | ",
          { $convert: { input: "$resultadoGestion", to: "string", onError: "", onNull: "" } },
        ],
      },
    };
    const esMailEnviadoExpr = {
      $and: [
        { $regexMatch: { input: mailTextoSeguro, regex: /mail|correo|e-?mail/i } },
        { $not: [{ $regexMatch: { input: mailTextoSeguro, regex: /entrante|recibido|recepci[oó]n/i } }] },
      ],
    };

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
          isContacto: esContactoExpr,
          isMailEnviado: esMailEnviadoExpr,
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
            { $match: { isMailEnviado: true } },
            { $group: { _id: "$dni", cantidad: { $sum: 1 } } },
          ],
          dnisContactados: [
            { $match: { isContacto: true } },
            { $group: { _id: "$dni" } },
            { $count: "value" },
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
      const dnisContactados = agg?.[0]?.dnisContactados?.[0]?.value || 0;

      const dnisPorDia = rangoDiasHabiles ? dnisUnicos / rangoDiasHabiles : 0;

      const porDniMailLibre = agg?.[0]?.porDniMailLibre || [];
      const mapaDniMails = new Map();
      for (const r of porDniMailLibre) {
        const key = String(r?._id || r?.dni || "");
        const cantidad = Number(r?.cantidad || 0);
        if (!key || cantidad <= 0) continue;
        mapaDniMails.set(key, (mapaDniMails.get(key) || 0) + cantidad);
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
        efectividadContacto: dnisUnicos ? (dnisContactados * 100) / dnisUnicos : 0,
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
const __inflightResumen = new Map(); // key -> Promise
const CACHE_TTL_MS = 120_000;

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
function invalidateReportesAnalyticsCache() {
  __cacheResumen.clear();
  __inflightResumen.clear();
}

const CONTACTO_RX = /contactad[oa]/i;
const MAIL_ENVIADO_RX = /mail|correo|e-?mail/i;
const MAIL_ENTRANTE_RX = /entrante|recibido|recepci[oó]n/i;

function normalizarTipoContactoExpr() {
  const RAW = {
    $toLower: {
      $concat: [
        { $convert: { input: "$tipoContacto", to: "string", onError: "", onNull: "" } },
        " | ",
        { $convert: { input: "$resultadoGestion", to: "string", onError: "", onNull: "" } },
      ],
    },
  };
  const test = (regex) => ({ $regexMatch: { input: RAW, regex } });
  return {
    $switch: {
      branches: [
        { case: test(/proceso|batch|autom[aá]tico|ignorar/i), then: "Proceso" },
        { case: test(/entrante.*tel|llamada.*entra.*tel|inbound/i), then: "Llamada entrante - telef." },
        { case: test(/saliente|outbound|operador llama/i), then: "Llamada saliente" },
        { case: test(/whats.*chat|wp.*chat|wa.*chat|mensaje saliente.*(wp|whats|wa)/i), then: "Whatsapp chat" },
        { case: test(/carta.*entrante|mail entrante|correo entrante/i), then: "Llamada entrante - carta" },
        { case: test(/whats.*entrante|wp.*entra|wa.*entra|mensaje entrante.*(wp|whats|wa)/i), then: "Whatsapp entrante" },
        { case: test(/envio.*mail|email.*saliente|correo.*saliente|env[ií]a.*correo/i), then: "Envio e-mail" },
        { case: test(/sms.*entrante|mensaje.*texto.*entrante|masiva.*sms/i), then: "Llamada entrante - sms" },
        { case: test(/ivr.*entrante|sistema.*ivr|respuesta de voz|menu.*ivr/i), then: "Llamada entrante - ivr" },
        { case: test(/whats|wp|wa/i), then: "Whatsapp chat" },
        { case: test(/mail|correo|email/i), then: "Envio e-mail" },
      ],
      default: "Otros",
    },
  };
}

function buildResumenPipeline(matchQ, { completo = true, topN = 10 } = {}) {
  const RESULTADO_SAFE = {
    $convert: { input: "$resultadoGestion", to: "string", onError: "", onNull: "" },
  };
  const ESTADO_SAFE = {
    $convert: { input: "$estadoCuenta", to: "string", onError: "", onNull: "" },
  };
  const HORA_SAFE = {
    $convert: { input: "$hora", to: "string", onError: "00:00:00", onNull: "00:00:00" },
  };
  const MAIL_TEXT_SAFE = {
    $toLower: {
      $concat: [
        { $convert: { input: "$tipoContacto", to: "string", onError: "", onNull: "" } },
        " | ",
        { $convert: { input: "$resultadoGestion", to: "string", onError: "", onNull: "" } },
      ],
    },
  };

  const facets = {
    totales: [
      {
        $group: {
          _id: null,
          gestiones: { $sum: 1 },
          contactos: { $sum: { $cond: ["$isContacto", 1, 0] } },
          desde: { $min: "$fecha" },
          hasta: { $max: "$fecha" },
        },
      },
    ],
    dnis: [
      {
        $group: {
          _id: "$dni",
          contactado: { $max: { $cond: ["$isContacto", 1, 0] } },
        },
      },
      {
        $group: {
          _id: null,
          dnisUnicos: { $sum: 1 },
          dnisContactados: { $sum: "$contactado" },
        },
      },
    ],
    diasActividad: [
      { $match: { diaSemana: { $gte: 1, $lte: 5 } } },
      { $group: { _id: "$diaISO" } },
      { $count: "value" },
    ],
    mails: [
      { $match: { isMailEnviado: true } },
      { $group: { _id: "$dni", cantidad: { $sum: 1 } } },
      { $group: { _id: null, promedio: { $avg: "$cantidad" } } },
    ],
  };

  if (completo) {
    Object.assign(facets, {
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
        { $match: { tipoNormalizado: { $ne: "Proceso" } } },
        { $group: { _id: "$tipoNormalizado", value: { $sum: 1 } } },
        { $sort: { value: -1, _id: 1 } },
      ],
      topGestiones: [
        { $group: { _id: "$dni", gestiones: { $sum: 1 } } },
        { $sort: { gestiones: -1, _id: 1 } },
        { $limit: topN },
      ],
      topDias: [
        { $group: { _id: { dni: "$dni", dia: "$diaISO" } } },
        { $group: { _id: "$_id.dni", diasTocados: { $sum: 1 } } },
        { $sort: { diasTocados: -1, _id: 1 } },
        { $limit: 10 },
      ],
      promedioDias: [
        { $group: { _id: { dni: "$dni", dia: "$diaISO" } } },
        { $group: { _id: "$_id.dni", diasTocados: { $sum: 1 } } },
        { $group: { _id: null, promedio: { $avg: "$diasTocados" } } },
      ],
    });
  }

  return [
    { $match: matchQ },
    {
      $project: {
        dni: 1,
        fecha: 1,
        horaStr: HORA_SAFE,
        tipoContacto: 1,
        resultadoGestion: 1,
        estadoCuenta: 1,
        tipoNormalizado: normalizarTipoContactoExpr(),
        isContacto: {
          $or: [
            { $regexMatch: { input: RESULTADO_SAFE, regex: CONTACTO_RX } },
            { $regexMatch: { input: ESTADO_SAFE, regex: CONTACTO_RX } },
          ],
        },
        isMailEnviado: {
          $and: [
            { $regexMatch: { input: MAIL_TEXT_SAFE, regex: MAIL_ENVIADO_RX } },
            { $not: [{ $regexMatch: { input: MAIL_TEXT_SAFE, regex: MAIL_ENTRANTE_RX } }] },
          ],
        },
        horaHH: { $substrBytes: [HORA_SAFE, 0, 2] },
        diaISO: { $dateToString: { date: "$fecha", format: "%Y-%m-%d" } },
        diaSemana: { $isoDayOfWeek: "$fecha" },
      },
    },
    { $facet: facets },
  ];
}

function buildRitmoPipeline(matchQ) {
  const HORA_SAFE = {
    $convert: { input: "$hora", to: "string", onError: "00:00:00", onNull: "00:00:00" },
  };
  const hh = { $convert: { input: { $substrBytes: [HORA_SAFE, 0, 2] }, to: "int", onError: 0, onNull: 0 } };
  const mm = { $convert: { input: { $substrBytes: [HORA_SAFE, 3, 2] }, to: "int", onError: 0, onNull: 0 } };
  const ss = { $convert: { input: { $substrBytes: [HORA_SAFE, 6, 2] }, to: "int", onError: 0, onNull: 0 } };

  return [
    { $match: matchQ },
    { $match: { $expr: { $lte: [{ $isoDayOfWeek: "$fecha" }, 5] } } },
    {
      $project: {
        dni: 1,
        usuario: 1,
        fecha: 1,
        segundoDia: { $add: [{ $multiply: [hh, 3600] }, { $multiply: [mm, 60] }, ss] },
        particion: {
          $concat: [
            "$usuario",
            "|",
            { $dateToString: { date: "$fecha", format: "%Y-%m-%d" } },
          ],
        },
      },
    },
    {
      $setWindowFields: {
        partitionBy: "$particion",
        sortBy: { segundoDia: 1 },
        output: {
          prevSegundo: { $shift: { output: "$segundoDia", by: -1 } },
          prevDni: { $shift: { output: "$dni", by: -1 } },
        },
      },
    },
    {
      $project: {
        dni: 1,
        prevDni: 1,
        gapMin: {
          $cond: [
            {
              $and: [
                { $ne: ["$prevSegundo", null] },
                { $gte: ["$prevSegundo", 9 * 3600] },
                { $lte: ["$segundoDia", 13 * 3600] },
                { $gte: [{ $subtract: ["$segundoDia", "$prevSegundo"] }, 0] },
                { $lte: [{ $subtract: ["$segundoDia", "$prevSegundo"] }, 120 * 60] },
              ],
            },
            { $divide: [{ $subtract: ["$segundoDia", "$prevSegundo"] }, 60] },
            null,
          ],
        },
      },
    },
    {
      $group: {
        _id: null,
        promedioGestiones: { $avg: "$gapMin" },
        promedioCasos: {
          $avg: { $cond: [{ $and: [{ $ne: ["$gapMin", null] }, { $ne: ["$dni", "$prevDni"] }] }, "$gapMin", null] },
        },
      },
    },
  ];
}

async function calcularCasosNuevosTotales({
  baseTenant,
  d1,
  d2,
  usuarioFilter,
  entidadFilter,
  tipoFilter,
  estadoFilter,
  dniFilter,
  minDias = 90,
}) {
  const corteInicio = new Date(d1.getTime() - minDias * 86400000);
  const endOfDay = new Date(d2.getTime() + 86399999);
  const comunes = {
    ...(dniFilter ? { dni: dniFilter } : {}),
    ...(entidadFilter ? { entidad: entidadFilter } : {}),
    ...(tipoFilter ? { tipoContacto: tipoFilter } : {}),
    ...(estadoFilter ? { estadoCuenta: estadoFilter } : {}),
    ...(usuarioFilter ? { usuario: usuarioFilter } : {}),
  };

  const [recientesDNIs, pares] = await Promise.all([
    ReporteGestion.distinct("dni", {
      ...baseTenant,
      ...comunes,
      fecha: { $gte: corteInicio, $lt: d1 },
    }).collation({ locale: "es", strength: 1 }),
    ReporteGestion.aggregate([
      { $match: { ...baseTenant, ...comunes, fecha: { $gte: d1, $lte: endOfDay } } },
      { $group: { _id: { operador: "$usuario", dni: "$dni" } } },
      { $project: { _id: 0, operador: "$_id.operador", dni: "$_id.dni" } },
    ])
      .allowDiskUse(true)
      .option({ maxTimeMS: 20000 })
      .collation({ locale: "es", strength: 1 }),
  ]);

  const recientes = new Set(recientesDNIs.map((x) => String(x || "")));
  let casosDistintos = 0;
  let casosNuevos = 0;
  for (const row of pares) {
    const dni = String(row?.dni || "").trim();
    if (!dni) continue;
    casosDistintos += 1;
    if (!recientes.has(dni)) casosNuevos += 1;
  }
  return {
    casosNuevos,
    casosDistintos,
    pctNuevos: casosDistintos ? (casosNuevos * 100) / casosDistintos : 0,
  };
}

export async function analyticsResumen(req, res) {
  try {
    attachAbortFlag(req, res);
    const startedAt = Date.now();

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });
    if (!ensureNoOperador(req, res)) return;

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
      incluirCasosNuevos = "false",
      minDias = 90,
    } = req.query || {};

    const topNNum = Math.max(1, Math.min(50, parseInt(topN, 10) || 10));
    const minDiasNum = Math.max(0, Number(minDias) || 90);
    const d1 = diaInicioUTC(desde);
    const d2 = diaInicioUTC(hasta);
    const p1 = prevDesde ? diaInicioUTC(prevDesde) : null;
    const p2 = prevHasta ? diaInicioUTC(prevHasta) : null;
    const endOfDayUTC = (d) => new Date(d.getTime() + 86399999);

    if (!d1 || !d2 || d2 < d1) {
      return res.status(400).json({ error: "Rango de fechas invalido" });
    }

    const days = Math.floor((endOfDayUTC(d2) - d1) / 86400000) + 1;
    const prevEndFallback = new Date(d1.getTime() - 86400000);
    const prevStartFallback = new Date(prevEndFallback.getTime() - (days - 1) * 86400000);
    const prevStart = p1 && p2 ? p1 : prevStartFallback;
    const prevEnd = p1 && p2 ? p2 : prevEndFallback;

    const dniFilter = buildDniFilter(dni);
    const fEntidad = inExactMultiStrings(entidad, (s) => s.toUpperCase());
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);
    const usuarioFilter = await activeUserFilter(operador);
    const scope = ownerScope(req);
    const baseTenant = { ...scope, borrado: { $ne: true } };
    const baseFiltros = {
      ...baseTenant,
      usuario: usuarioFilter,
      ...(dniFilter ? { dni: dniFilter } : {}),
      ...(fEntidad ? { entidad: fEntidad } : {}),
      ...(fTipo ? { tipoContacto: fTipo } : {}),
      ...(fEstado ? { estadoCuenta: fEstado } : {}),
    };
    const matchActual = { ...baseFiltros, fecha: { $gte: d1, $lte: endOfDayUTC(d2) } };
    const matchPrevio = { ...baseFiltros, fecha: { $gte: prevStart, $lte: endOfDayUTC(prevEnd) } };

    const wantsCasosNuevos =
      String(incluirCasosNuevos).toLowerCase() === "true" && splitCSV(operador).length > 0;
    const scopeOwner = scope?.propietario ? String(scope.propietario) : "all";
    const cacheKey = JSON.stringify({
      scopeOwner,
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
      wantsCasosNuevos,
      minDias: minDiasNum,
    });

    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader("X-Cobrina-Cache", "HIT");
      res.setHeader("Server-Timing", `total;dur=${Date.now() - startedAt}`);
      return res.json(cached);
    }

    let work = __inflightResumen.get(cacheKey);
    if (!work) {
      work = (async () => {
        const queryStarted = Date.now();
        const currentPromise = ReporteGestion.aggregate(
          buildResumenPipeline(matchActual, { completo: true, topN: topNNum }),
        )
          .allowDiskUse(true)
          .option({ maxTimeMS: 30000 })
          .collation({ locale: "es", strength: 1 });
        const previousPromise = ReporteGestion.aggregate(
          buildResumenPipeline(matchPrevio, { completo: false, topN: topNNum }),
        )
          .allowDiskUse(true)
          .option({ maxTimeMS: 30000 })
          .collation({ locale: "es", strength: 1 });
        const ritmoPromise = ReporteGestion.aggregate(buildRitmoPipeline(matchActual))
          .allowDiskUse(true)
          .option({ maxTimeMS: 30000 })
          .collation({ locale: "es", strength: 1 })
          .catch(() => []);
        const casosPromise = wantsCasosNuevos
          ? calcularCasosNuevosTotales({
              baseTenant,
              d1,
              d2,
              usuarioFilter,
              entidadFilter: fEntidad,
              tipoFilter: fTipo,
              estadoFilter: fEstado,
              dniFilter,
              minDias: minDiasNum,
            }).catch(() => null)
          : Promise.resolve(null);

        const [actAgg, prevAgg, ritmoAgg, casosNuevos] = await Promise.all([
          currentPromise,
          previousPromise,
          ritmoPromise,
          casosPromise,
        ]);
        const queryMs = Date.now() - queryStarted;

        const unpack = (agg) => agg?.[0] || {};
        const fold = (agg) => {
          const root = unpack(agg);
          const total = root?.totales?.[0] || {};
          const dnis = root?.dnis?.[0] || {};
          const gestiones = Number(total.gestiones || 0);
          const contactos = Number(total.contactos || 0);
          const dnisUnicos = Number(dnis.dnisUnicos || 0);
          const dnisContactados = Number(dnis.dnisContactados || 0);
          const diasHabilesConActividad = Number(root?.diasActividad?.[0]?.value || 0);
          const promedioMails = Number(root?.mails?.[0]?.promedio || 0);
          return {
            gestiones,
            contactos,
            dnisUnicos,
            dnisContactados,
            diasHabilesConActividad,
            promedioMails,
            gestionesPorCaso: dnisUnicos ? gestiones / dnisUnicos : 0,
            tasaContactabilidad: gestiones ? (contactos * 100) / gestiones : 0,
            efectividadContacto: dnisUnicos ? (dnisContactados * 100) / dnisUnicos : 0,
            dnisPorDiaHabil: diasHabilesConActividad ? dnisUnicos / diasHabilesConActividad : 0,
            rangoDetectado: {
              desde: total.desde ? new Date(total.desde).toISOString().slice(0, 10) : "",
              hasta: total.hasta ? new Date(total.hasta).toISOString().slice(0, 10) : "",
            },
          };
        };
        const actual = fold(actAgg);
        const previo = fold(prevAgg);
        const actRoot = unpack(actAgg);
        const ritmo = ritmoAgg?.[0] || {};

        const series = Array.from({ length: 24 }, (_, h) => {
          const hh = String(h).padStart(2, "0");
          const row = (actRoot.porHora || []).find((x) => String(x?._id || "").padStart(2, "0") === hh);
          const gestiones = Number(row?.gestiones || 0);
          const contactos = Number(row?.contactos || 0);
          return {
            hora: `${hh}:00`,
            gestiones,
            contactos,
            tasaContacto: gestiones ? (contactos * 100) / gestiones : 0,
          };
        });

        const delta = (act, prev) => {
          const a = Number.isFinite(Number(act)) ? Number(act) : null;
          const p = Number.isFinite(Number(prev)) ? Number(prev) : null;
          return {
            actual: a,
            previo: p,
            deltaAbs: a != null && p != null ? a - p : null,
            deltaPct: p != null && p !== 0 && a != null ? ((a - p) * 100) / p : null,
          };
        };

        const payload = {
          ok: true,
          version: 2,
          rango: {
            actual: { desde: d1.toISOString().slice(0, 10), hasta: d2.toISOString().slice(0, 10) },
            previo: { desde: prevStart.toISOString().slice(0, 10), hasta: prevEnd.toISOString().slice(0, 10) },
          },
          actual: {
            kpis: {
              gestionesTotales: delta(actual.gestiones, previo.gestiones),
              dnisUnicos: delta(actual.dnisUnicos, previo.dnisUnicos),
              gestionesPorCaso: delta(actual.gestionesPorCaso, previo.gestionesPorCaso),
              tasaContactabilidad: delta(actual.tasaContactabilidad, previo.tasaContactabilidad),
              efectividadContacto: delta(actual.efectividadContacto, previo.efectividadContacto),
              dnisPorDiaHabil: delta(actual.dnisPorDiaHabil, previo.dnisPorDiaHabil),
              mailsPorDniMailLibre: delta(actual.promedioMails, previo.promedioMails),
            },
            resumen: {
              totalGestiones: actual.gestiones,
              dnisUnicos: actual.dnisUnicos,
              promedioGestionesPorCaso: actual.gestionesPorCaso,
              promedioDNIsPorDia: actual.dnisPorDiaHabil,
              tasaContactabilidad: actual.tasaContactabilidad,
              efectividadContacto: actual.efectividadContacto,
              promedioMailsPorDni: actual.promedioMails,
              promIntervaloGestionesMin: Number(ritmo.promedioGestiones || 0),
              promIntervaloCasosMin: Number(ritmo.promedioCasos || 0),
              series,
              pieTipos: (actRoot.pieTipos || []).map((x) => ({
                label: String(x?._id || "Otros"),
                value: Number(x?.value || 0),
              })),
              topGestiones: actRoot.topGestiones || [],
              topDias: actRoot.topDias || [],
              promedioDiasTocadosPorDni: Number(actRoot?.promedioDias?.[0]?.promedio || 0),
              diasHabilesConActividad: actual.diasHabilesConActividad,
              rangoDetectado: actual.rangoDetectado,
            },
            casosNuevos,
          },
          previo: {
            kpis: {
              gestiones: previo.gestiones,
              dnisUnicos: previo.dnisUnicos,
              gestionesPorCaso: previo.gestionesPorCaso,
              tasaContactabilidad: previo.tasaContactabilidad,
              efectividadContacto: previo.efectividadContacto,
              dnisPorDiaHabil: previo.dnisPorDiaHabil,
              mailsPorDniMailLibre: previo.promedioMails,
            },
          },
          previoSinDatos: !previo.gestiones,
          meta: { queryMs, generatedAt: new Date().toISOString() },
        };
        cacheSet(cacheKey, payload);
        return payload;
      })().finally(() => __inflightResumen.delete(cacheKey));
      __inflightResumen.set(cacheKey, work);
    }

    const payload = await work;
    throwIfAborted(req);
    res.setHeader("X-Cobrina-Cache", "MISS");
    res.setHeader(
      "Server-Timing",
      `mongo;dur=${Number(payload?.meta?.queryMs || 0)}, total;dur=${Date.now() - startedAt}`,
    );
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

    const activeFilter = await activeUserFilter(operador);
    const fEntidad = rxExactMulti(entidad, (s) => s.toUpperCase());
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);

    matchDia.usuario = activeFilter;
    if (fEntidad) matchDia.entidad = fEntidad;
    if (fTipo) matchDia.tipoContacto = fTipo;
    if (fEstado) matchDia.estadoCuenta = fEstado;

    // Para “casos nuevos” necesitamos también el mismo filtro pero en ventana previa
    const matchPrev = {
      ...matchBase,
      fecha: { $gte: corteInicio, $lt: desde },
    };
    if (dniFilter) matchPrev.dni = dniFilter;
    matchPrev.usuario = activeFilter;
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

    const activeFilter = await activeUserFilter(operador);
    const fEntidad = rxExactMulti(entidad, (s) => s.toUpperCase());
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);

    match.usuario = activeFilter;
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

    const activeFilter = await activeUserFilter(operador);
    const fEntidad = rxExactMulti(entidad, (s) => s.toUpperCase());
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);

    base.usuario = activeFilter;
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

export async function asistenciaMes(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token invalido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { mes, operador, entidad, tipoContacto, estadoCuenta } = req.query || {};
    if (!/^\d{4}-\d{2}$/.test(mes || "")) {
      return res.status(400).json({ error: "Parametro 'mes' invalido (yyyy-mm)." });
    }

    const cacheKey = `asistencia-mes:${JSON.stringify({
      scope: ownerScope(req), mes, operador, entidad, tipoContacto, estadoCuenta,
    })}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader("X-Cobrina-Cache", "HIT");
      return res.json(cached);
    }

    const year = Number(mes.slice(0, 4));
    const month = Number(mes.slice(5, 7)) - 1;
    const desde = new Date(Date.UTC(year, month, 1));
    const hasta = new Date(Date.UTC(year, month + 1, 1));

    const match = {
      ...ownerScope(req),
      borrado: { $ne: true },
      fecha: { $gte: desde, $lt: hasta },
    };

    const activeFilter = await activeUserFilter(operador);
    const fEntidad = rxExactMulti(entidad, (value) => value.toUpperCase());
    const fTipo = rxExactMulti(tipoContacto);
    const fEstado = rxExactMulti(estadoCuenta);
    match.usuario = activeFilter;
    if (fEntidad) match.entidad = fEntidad;
    if (fTipo) match.tipoContacto = fTipo;
    if (fEstado) match.estadoCuenta = fEstado;

    const HORA_SAFE = {
      $convert: { input: "$hora", to: "string", onError: "00:00:00", onNull: "00:00:00" },
    };

    throwIfAborted(req);

    const [resultado = {}] = await ReporteGestion.aggregate([
      { $match: match },
      {
        $project: {
          usuario: 1,
          dni: 1,
          dia: { $dateToString: { date: "$fecha", format: "%Y-%m-%d" } },
          horaSafe: HORA_SAFE,
        },
      },
      {
        $facet: {
          dias: [
            {
              $group: {
                _id: "$dia",
                dnisSet: { $addToSet: "$dni" },
                gestiones: { $sum: 1 },
                minHora: { $min: "$horaSafe" },
                maxHora: { $max: "$horaSafe" },
              },
            },
            {
              $project: {
                _id: 0,
                fecha: "$_id",
                dnisUnicos: { $size: "$dnisSet" },
                cuentas: { $size: "$dnisSet" },
                gestiones: 1,
                inicio: { $substrBytes: ["$minHora", 0, 5] },
                fin: { $substrBytes: ["$maxHora", 0, 5] },
              },
            },
            { $sort: { fecha: 1 } },
          ],
          matriz: [
            {
              $group: {
                _id: { usuario: "$usuario", dia: "$dia" },
                dnisSet: { $addToSet: "$dni" },
              },
            },
            {
              $project: {
                _id: 0,
                usuario: "$_id.usuario",
                dia: "$_id.dia",
                cuentas: { $size: "$dnisSet" },
              },
            },
            { $sort: { usuario: 1, dia: 1 } },
          ],
        },
      },
    ])
      .allowDiskUse(true)
      .option({ maxTimeMS: 20000 })
      .collation({ locale: "es", strength: 1 });

    throwIfAborted(req);

    const ultimoDia = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const diasCabecera = Array.from({ length: ultimoDia }, (_, index) => (
      `${mes}-${String(index + 1).padStart(2, "0")}`
    ));

    const mapaUsuarios = new Map();
    for (const row of resultado.matriz || []) {
      if (!mapaUsuarios.has(row.usuario)) {
        mapaUsuarios.set(row.usuario, { usuario: row.usuario, dias: {} });
      }
      mapaUsuarios.get(row.usuario).dias[row.dia] = row.cuentas;
    }

    const payload = {
      ok: true,
      mes,
      dias: resultado.dias || [],
      diasCabecera,
      usuariosMatriz: Array.from(mapaUsuarios.values()),
    };
    cacheSet(cacheKey, payload);
    return res.json(payload);
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
    const usuarioFilter = await activeUserFilter(operador);
    const entidadFilter = inExactMultiStrings(entidad, (s) => s.toUpperCase());
    const tipoFilter = inExactMultiStrings(tipoContacto, (s) => String(s));
    const estadoFilter = inExactMultiStrings(estadoCuenta, (s) => String(s));
    const dniFilter = buildDniFilter(dni);

    const casosCacheKey = `casos-nuevos::${JSON.stringify({
      scope: baseTenant?.propietario ? String(baseTenant.propietario) : "all",
      desde: d1.toISOString().slice(0, 10),
      hasta: d2.toISOString().slice(0, 10),
      operador: operador || null,
      entidad: entidad || null,
      tipoContacto: tipoContacto || null,
      estadoCuenta: estadoCuenta || null,
      dni: dni || null,
      minDias: MIN_DIAS,
    })}`;
    const casosCached = cacheGet(casosCacheKey);
    if (casosCached) return res.json(casosCached);

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

    const payload = {
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
    };
    cacheSet(casosCacheKey, payload);
    return res.json(payload);
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


/* ============================================================
   ACUERDOS DE PAGO · derivados del mismo Reporte de Gestiones
   ============================================================ */

const ACUERDOS_SORT_KEYS = new Set([
  "estadoVencimiento", "primerVencimiento", "dias", "tipoAcuerdo", "primerPago",
  "montoTotalAcuerdo", "fechaAnticipo", "montoAnticipo", "cuotas", "montoCuota",
  "deudaMaxima", "dni", "telefonoGestion", "nombreDeudor", "fecha", "hora", "usuario", "entidad",
  "tipoContacto", "resultadoGestion", "estadoCuenta", "telMailMarcado", "observacionGestion",
  "estadoPagoAcuerdo", "cantidadPagosPosteriores", "montoPagosPosteriores", "ultimoPagoPosterior",
  "ultimaGestionMangoFecha", "ultimaGestionMangoHora", "ultimaGestionMangoUsuario",
  "ultimaGestionMangoResultado",
]);

const ACUERDOS_NUMERIC_SORT_KEYS = new Set([
  "dias", "primerPago", "montoTotalAcuerdo", "montoAnticipo", "cuotas", "montoCuota", "deudaMaxima",
  "cantidadPagosPosteriores", "montoPagosPosteriores", "montoUltimoPagoAnterior", "diasPagoAnterior",
]);

function valorOrdenAcuerdo(row, key) {
  if (key === "dias") {
    return row.estadoVencimiento === "VENCIDO"
      ? Number(row.diasVencido || 0)
      : Number(row.diasParaVencer ?? 999999);
  }
  return row?.[key];
}

async function vincularPagosConAcuerdosSinRomper(acuerdos = [], { fechaHasta = "" } = {}) {
  const fallback = (motivo = "SIN_PAGOS_CARGADOS") => ({
    rows: vincularPagosPosteriores(acuerdos, [], [], { disponible: false, motivo }),
    meta: {
      disponible: false,
      motivo,
      pagosConsultados: 0,
      acuerdosEvaluados: acuerdos.length,
      periodoHasta: fechaHasta || "",
    },
  });

  if (!acuerdos.length) return fallback("SIN_ACUERDOS");

  try {
    const moduleHasData = await Pago.exists({});
    if (!moduleHasData) return fallback("SIN_PAGOS_CARGADOS");

    const dnis = [...new Set(
      acuerdos.map((row) => String(row?.dni || "").replace(/\D/g, "")).filter(Boolean)
    )];
    if (!dnis.length) return fallback("ACUERDOS_SIN_DNI");

    const agreementDates = acuerdos
      .map((row) => String(row?.fecha || "").slice(0, 10))
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
      .sort();
    const earliest = agreementDates[0] ? diaInicioUTC(agreementDates[0]) : null;
    const paymentStart = earliest ? new Date(earliest.getTime() - 90 * 86400000) : null;
    const requestedEnd = fechaHasta ? diaFinUTC(fechaHasta) : null;
    const now = new Date();
    const paymentEnd = requestedEnd && requestedEnd < now ? requestedEnd : now;
    const paymentMatch = { dni: { $in: dnis } };
    if (paymentStart) paymentMatch.fechaPago = { $gte: paymentStart, $lte: paymentEnd };

    const payments = await Pago.find(paymentMatch)
      .select("idPago dni entidadId subCesionId fechaPago monto conceptoCodigo estado")
      .sort({ fechaPago: 1, _id: 1 })
      .lean()
      .maxTimeMS(15000);

    const entityNumbers = [...new Set(
      payments.map((payment) => Number(payment?.entidadId || 0)).filter(Boolean)
    )];
    const entities = entityNumbers.length
      ? await Entidad.find({ numero: { $in: entityNumbers } })
          .select("numero nombre")
          .lean()
          .maxTimeMS(5000)
      : [];

    return {
      rows: vincularPagosPosteriores(acuerdos, payments, entities, { disponible: true }),
      meta: {
        disponible: true,
        motivo: "",
        pagosConsultados: payments.length,
        acuerdosEvaluados: acuerdos.length,
        periodoDesde: paymentStart?.toISOString().slice(0, 10) || "",
        periodoHasta: fechaClaveArgentina(paymentEnd),
      },
    };
  } catch (error) {
    console.warn("Cruce opcional acuerdos/pagos no disponible:", error?.message || error);
    return fallback("ERROR_CONSULTA_PAGOS");
  }
}

function desplazarISOUnMesAtras(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const target = new Date(Date.UTC(year, month - 2, 1));
  const targetYear = target.getUTCFullYear();
  const targetMonth = target.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function resumenComparacionAcuerdos(summary, desde, hasta) {
  if (!summary) return null;
  return {
    desde,
    hasta,
    totalGestiones: Number(summary.totalGestiones || 0),
    totalAcuerdos: Number(summary.totalAcuerdos || 0),
    tasaAcuerdo: Number(summary.tasaAcuerdo || 0),
    dnisConAcuerdo: Number(summary.dnisConAcuerdo || 0),
    totalPrimerPago: Number(summary.totalPrimerPago || 0),
    montoTotalAcuerdos: Number(summary.montoTotalAcuerdos || 0),
    vencidos: Number(summary.vencidos || 0),
    montoVencido: Number(summary.montoVencido || 0),
  };
}

function ordenarAcuerdos(rows, rawKey = "fecha", rawDir = "desc") {
  const key = ACUERDOS_SORT_KEYS.has(String(rawKey || "")) ? String(rawKey) : "fecha";
  const dir = String(rawDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  const factor = dir === "asc" ? 1 : -1;

  rows.sort((a, b) => {
    const av = valorOrdenAcuerdo(a, key);
    const bv = valorOrdenAcuerdo(b, key);
    let comparison = 0;

    if (ACUERDOS_NUMERIC_SORT_KEYS.has(key)) {
      comparison = Number(av || 0) - Number(bv || 0);
    } else {
      comparison = String(av ?? "").localeCompare(String(bv ?? ""), "es", {
        sensitivity: "base",
        numeric: true,
      });
    }

    if (comparison !== 0) return comparison * factor;

    const byDate = String(b.fecha || "").localeCompare(String(a.fecha || ""));
    if (byDate !== 0) return byDate;
    const byTime = String(b.hora || "").localeCompare(String(a.hora || ""));
    if (byTime !== 0) return byTime;
    return String(b.id || "").localeCompare(String(a.id || ""));
  });

  return { key, dir };
}


const claveEntidadGestion = (value = "") =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();

const clavesCasoGestion = (row = {}) => {
  const dniNormalizado = String(row?.dni || "").replace(/\D/g, "");
  if (!dniNormalizado) return [];
  const numero = Number(row?.entidadNumero || 0);
  const nombre = claveEntidadGestion(row?.entidad);
  return [
    numero > 0 ? `${dniNormalizado}|N:${numero}` : "",
    nombre ? `${dniNormalizado}|T:${nombre}` : "",
  ].filter(Boolean);
};

async function vincularUltimaGestionMango(acuerdos = [], req) {
  if (!acuerdos.length) return acuerdos;

  const dnis = [...new Set(
    acuerdos.map((row) => String(row?.dni || "").replace(/\D/g, "")).filter(Boolean)
  )];
  if (!dnis.length) return acuerdos;

  const dniVariants = [...new Set(
    dnis.flatMap((dniValue) => {
      const numeric = Number(dniValue);
      return Number.isSafeInteger(numeric) ? [dniValue, numeric] : [dniValue];
    })
  )];

  const gestiones = await ReporteGestion.find({
    ...ownerScope(req),
    borrado: { $ne: true },
    dni: { $in: dniVariants },
  })
    .select(
      "dni entidad entidadNumero fecha hora usuario resultadoGestion estadoCuenta tipoContacto observacionGestion"
    )
    .sort({ fecha: -1, hora: -1, _id: -1 })
    .lean()
    .maxTimeMS(30000);

  const latestByKey = new Map();
  for (const gestion of gestiones) {
    const snapshot = {
      ultimaGestionMangoFecha: gestion?.fecha
        ? new Date(gestion.fecha).toISOString().slice(0, 10)
        : "",
      ultimaGestionMangoHora: String(gestion?.hora || ""),
      ultimaGestionMangoUsuario: String(gestion?.usuario || ""),
      ultimaGestionMangoResultado: String(gestion?.resultadoGestion || ""),
      ultimaGestionMangoEstadoCuenta: String(gestion?.estadoCuenta || ""),
      ultimaGestionMangoTipoContacto: String(gestion?.tipoContacto || ""),
      ultimaGestionMangoObservacion: String(gestion?.observacionGestion || ""),
    };
    for (const key of clavesCasoGestion(gestion)) {
      if (!latestByKey.has(key)) latestByKey.set(key, snapshot);
    }
  }

  return acuerdos.map((acuerdo) => {
    let latest = null;
    for (const key of clavesCasoGestion(acuerdo)) {
      latest = latestByKey.get(key);
      if (latest) break;
    }
    if (!latest) {
      return {
        ...acuerdo,
        ultimaGestionMangoFecha: "",
        ultimaGestionMangoHora: "",
        ultimaGestionMangoUsuario: "",
        ultimaGestionMangoResultado: "",
        ultimaGestionMangoEstadoCuenta: "",
        ultimaGestionMangoTipoContacto: "",
        ultimaGestionMangoObservacion: "",
      };
    }
    const original = `${String(acuerdo?.fecha || "").slice(0, 10)}T${String(acuerdo?.hora || "00:00:00")}`;
    const latestStamp = `${latest.ultimaGestionMangoFecha}T${latest.ultimaGestionMangoHora || "00:00:00"}`;
    return {
      ...acuerdo,
      ...latest,
      ultimaGestionMangoEsPosterior: Boolean(latest.ultimaGestionMangoFecha) && latestStamp > original,
    };
  });
}

async function obtenerDatosAcuerdos(req, { paginate = true, soloVencidos = false } = {}) {
  const {
    desde,
    hasta,
    operador,
    entidad,
    tipoContacto,
    estadoCuenta,
    dni,
    tipoAcuerdo,
    estadoVencimiento,
    sortKey = "fecha",
    sortDir = "desc",
    page = 1,
    limit = 100,
  } = req.query || {};

  const match = {
    ...ownerScope(req),
    borrado: { $ne: true },
    usuario: await activeUserFilter(operador),
  };

  const d1 = diaInicioUTC(desde);
  const d2 = diaFinUTC(hasta);
  if ((desde && !d1) || (hasta && !d2) || (d1 && d2 && d2 < d1)) {
    const error = new Error("Rango de fechas inválido.");
    error.status = 400;
    throw error;
  }
  if (d1 || d2) {
    match.fecha = {};
    if (d1) match.fecha.$gte = d1;
    if (d2) match.fecha.$lte = d2;
  }

  const fEntidad = rxExactMulti(entidad, (value) => value.toUpperCase());
  const fTipo = rxExactMulti(tipoContacto);
  const fEstado = rxExactMulti(estadoCuenta);
  const fDni = buildDniFilter(dni);
  if (fEntidad) match.entidad = fEntidad;
  if (fTipo) match.tipoContacto = fTipo;
  if (fEstado) match.estadoCuenta = fEstado;
  if (fDni) match.dni = fDni;

  throwIfAborted(req);

  const agreementMatch = {
    ...match,
    resultadoGestion: /acuerdo/i,
  };

  const [totalGestiones, gestionesPorOperador, rawRows] = await Promise.all([
    ReporteGestion.countDocuments(match).maxTimeMS(30000),
    ReporteGestion.aggregate([
      { $match: match },
      { $group: { _id: "$usuario", gestiones: { $sum: 1 } } },
      { $project: { _id: 0, operador: "$_id", gestiones: 1 } },
      { $sort: { gestiones: -1, operador: 1 } },
    ])
      .option({ maxTimeMS: 30000 })
      .collation({ locale: "es", strength: 1 }),
    ReporteGestion.find(agreementMatch)
      .select(
        "dni nombreDeudor fecha hora usuario tipoContacto resultadoGestion estadoCuenta telMailMarcado observacionGestion entidad entidadNumero"
      )
      .sort({ fecha: -1, hora: -1, _id: -1 })
      .lean()
      .maxTimeMS(30000),
  ]);

  throwIfAborted(req);

  let acuerdos = rawRows
    .map((row) => transformarGestionEnAcuerdo(row))
    .filter(Boolean);

  const tiposSolicitados = splitCSV(tipoAcuerdo).map((value) => value.toLocaleLowerCase("es"));
  if (tiposSolicitados.length) {
    const tiposSet = new Set(tiposSolicitados);
    acuerdos = acuerdos.filter((row) => tiposSet.has(String(row.tipoAcuerdo || "").toLocaleLowerCase("es")));
  }

  const estadosSolicitados = splitCSV(estadoVencimiento).map((value) => value.toLocaleUpperCase("es"));
  if (estadosSolicitados.length) {
    const estadosSet = new Set(estadosSolicitados);
    acuerdos = acuerdos.filter((row) => estadosSet.has(String(row.estadoVencimiento || "").toLocaleUpperCase("es")));
  }
  if (soloVencidos) {
    acuerdos = acuerdos.filter((row) => row.estadoVencimiento === "VENCIDO");
  }

  acuerdos = await vincularUltimaGestionMango(acuerdos, req);

  const paymentLink = await vincularPagosConAcuerdosSinRomper(acuerdos, { fechaHasta: hasta });
  acuerdos = paymentLink.rows;

  const appliedSort = ordenarAcuerdos(acuerdos, sortKey, sortDir);
  const summary = resumirAcuerdos(acuerdos, totalGestiones, gestionesPorOperador, paymentLink.meta);

  if (paginate && desde && hasta) {
    const anteriorDesde = desplazarISOUnMesAtras(desde);
    const anteriorHasta = desplazarISOUnMesAtras(hasta);
    const anteriorD1 = diaInicioUTC(anteriorDesde);
    const anteriorD2 = diaFinUTC(anteriorHasta);

    if (anteriorD1 && anteriorD2) {
      const previousMatch = {
        ...match,
        fecha: { $gte: anteriorD1, $lte: anteriorD2 },
      };
      const previousAgreementMatch = {
        ...previousMatch,
        resultadoGestion: /acuerdo/i,
      };

      const [previousTotalGestiones, previousGestionesPorOperador, previousRawRows] = await Promise.all([
        ReporteGestion.countDocuments(previousMatch).maxTimeMS(30000),
        ReporteGestion.aggregate([
          { $match: previousMatch },
          { $group: { _id: "$usuario", gestiones: { $sum: 1 } } },
          { $project: { _id: 0, operador: "$_id", gestiones: 1 } },
          { $sort: { gestiones: -1, operador: 1 } },
        ])
          .option({ maxTimeMS: 30000 })
          .collation({ locale: "es", strength: 1 }),
        ReporteGestion.find(previousAgreementMatch)
          .select(
            "dni nombreDeudor fecha hora usuario tipoContacto resultadoGestion estadoCuenta telMailMarcado observacionGestion entidad entidadNumero"
          )
          .sort({ fecha: -1, hora: -1, _id: -1 })
          .lean()
          .maxTimeMS(30000),
      ]);

      let previousAgreements = previousRawRows
        .map((row) => transformarGestionEnAcuerdo(row))
        .filter(Boolean);

      if (tiposSolicitados.length) {
        const tiposSet = new Set(tiposSolicitados);
        previousAgreements = previousAgreements.filter((row) =>
          tiposSet.has(String(row.tipoAcuerdo || "").toLocaleLowerCase("es"))
        );
      }
      if (estadosSolicitados.length) {
        const estadosSet = new Set(estadosSolicitados);
        previousAgreements = previousAgreements.filter((row) =>
          estadosSet.has(String(row.estadoVencimiento || "").toLocaleUpperCase("es"))
        );
      }

      const previousSummary = resumirAcuerdos(
        previousAgreements,
        previousTotalGestiones,
        previousGestionesPorOperador
      );
      summary.comparacionAnterior = resumenComparacionAcuerdos(
        previousSummary,
        anteriorDesde,
        anteriorHasta
      );
    }
  }

  const dueRows = acuerdos
    .filter((row) => row.primerVencimiento)
    .slice()
    .sort((a, b) =>
      (a.primerVencimiento || "9999-12-31").localeCompare(b.primerVencimiento || "9999-12-31") ||
      String(a.usuario || "").localeCompare(String(b.usuario || ""), "es")
    );

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(10, Math.min(500, Number(limit) || 100));
  const total = acuerdos.length;
  const pages = Math.max(1, Math.ceil(total / safeLimit));
  const currentPage = Math.min(safePage, pages);
  const items = paginate
    ? acuerdos.slice((currentPage - 1) * safeLimit, currentPage * safeLimit)
    : acuerdos;

  return {
    acuerdos,
    items,
    vencimientos: paginate ? dueRows.slice(0, 250) : dueRows,
    summary,
    total,
    page: currentPage,
    pages,
    limit: safeLimit,
    catalogos: {
      tiposAcuerdo: TIPOS_ACUERDO,
      estadosVencimiento: ["VENCIDO", "VENCE HOY", "PRÓXIMO 3 DÍAS", "PENDIENTE"],
      estadosPagoAcuerdo: ["CON PAGO POSTERIOR", "PAGO MISMO DÍA", "SIN PAGO POSTERIOR"],
    },
    integracionPagos: paymentLink.meta,
    params: {
      desde: desde || null,
      hasta: hasta || null,
      operador: operador || null,
      entidad: entidad || null,
      tipoContacto: tipoContacto || null,
      estadoCuenta: estadoCuenta || null,
      dni: dni || null,
      tipoAcuerdo: tipoAcuerdo || null,
      estadoVencimiento: estadoVencimiento || null,
      sortKey: appliedSort.key,
      sortDir: appliedSort.dir,
    },
  };
}

/** GET /api/reportes-gestiones/analytics/acuerdos */
export async function analyticsAcuerdos(req, res) {
  try {
    attachAbortFlag(req, res);
    if (!getUsuarioId(req)) return res.status(401).json({ error: "Token invalido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const data = await obtenerDatosAcuerdos(req, { paginate: true });
    return res.json({
      ok: true,
      items: data.items,
      vencimientos: data.vencimientos,
      resumen: data.summary,
      total: data.total,
      page: data.page,
      pages: data.pages,
      limit: data.limit,
      catalogos: data.catalogos,
      integracionPagos: data.integracionPagos,
      params: data.params,
    });
  } catch (error) {
    if (error?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(error?.status || 500).json({ error: error?.message || "No se pudo generar el reporte de acuerdos." });
  }
}

function nombreExcelAcuerdos(prefix, params = {}) {
  const desde = String(params.desde || "inicio").replace(/[^0-9-]/g, "");
  const hasta = String(params.hasta || "actualidad").replace(/[^0-9-]/g, "");
  return `${prefix}_${desde}_a_${hasta}.xlsx`;
}

function enviarExcel(res, buffer, filename) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  return res.send(Buffer.from(buffer));
}

/** Compatibilidad: el antiguo /excel ahora descarga únicamente estadísticas. */
export async function exportarAcuerdosExcel(req, res) {
  return exportarAcuerdosEstadisticasExcel(req, res);
}

/** GET /api/reportes-gestiones/analytics/acuerdos/estadisticas-excel */
export async function exportarAcuerdosEstadisticasExcel(req, res) {
  try {
    attachAbortFlag(req, res);
    if (!getUsuarioId(req)) return res.status(401).json({ error: "Token invalido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const data = await obtenerDatosAcuerdos(req, { paginate: false });
    const buffer = await crearExcelAcuerdos({
      rows: data.acuerdos,
      summary: data.summary,
      metadata: data.params,
      kind: "estadisticas",
    });
    const filename = nombreExcelAcuerdos("ESTADISTICAS_ACUERDOS_COBRINA", data.params);
    return enviarExcel(res, buffer, filename);
  } catch (error) {
    if (error?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(error?.status || 500).json({ error: error?.message || "No se pudieron exportar las estadísticas de acuerdos." });
  }
}

/** GET /api/reportes-gestiones/analytics/acuerdos/gestiones-excel */
export async function exportarAcuerdosGestionesExcel(req, res) {
  try {
    attachAbortFlag(req, res);
    if (!getUsuarioId(req)) return res.status(401).json({ error: "Token invalido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const data = await obtenerDatosAcuerdos(req, { paginate: false });
    const buffer = await crearExcelAcuerdos({
      rows: data.acuerdos,
      summary: data.summary,
      metadata: data.params,
      kind: "gestiones",
    });
    const filename = nombreExcelAcuerdos("GESTIONES_CON_ACUERDO_COBRINA", data.params);
    return enviarExcel(res, buffer, filename);
  } catch (error) {
    if (error?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(error?.status || 500).json({ error: error?.message || "No se pudieron exportar las gestiones con acuerdo." });
  }
}

/** GET /api/reportes-gestiones/analytics/acuerdos/vencidos-excel */
export async function exportarAcuerdosVencidosExcel(req, res) {
  try {
    attachAbortFlag(req, res);
    if (!getUsuarioId(req)) return res.status(401).json({ error: "Token invalido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const data = await obtenerDatosAcuerdos(req, { paginate: false, soloVencidos: true });
    const buffer = await crearExcelAcuerdos({
      rows: data.acuerdos,
      summary: data.summary,
      metadata: data.params,
      kind: "vencidos",
    });
    const filename = nombreExcelAcuerdos("ACUERDOS_VENCIDOS_COBRINA", data.params);
    return enviarExcel(res, buffer, filename);
  } catch (error) {
    if (error?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(error?.status || 500).json({ error: error?.message || "No se pudo exportar el Excel de vencidos." });
  }
}
