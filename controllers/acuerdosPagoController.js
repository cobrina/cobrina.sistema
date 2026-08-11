// BACKEND/controllers/acuerdosPagoController.js
import mongoose from "mongoose";
import * as XLSX from "xlsx";
import PDFDocument from "pdfkit";
import AcuerdoPago from "../models/AcuerdoPago.js";
import { parseRowToAcuerdoPago } from "../utils/acuerdosPagoParser.js";
import Empleado from "../models/Empleado.js";
import Entidad from "../models/Entidad.js";
import { fechaClaveArgentina } from "../utils/fecha.util.js";

/** Helpers token (igual estilo Reportes Gestiones) */
function getUsuarioId(req) {
  return req?.user?.id || req?.usuario?._id || req?.userId || null;
}
function getUsuarioRol(req) {
  return (
    req?.user?.rol ||
    req?.user?.role ||
    req?.usuario?.rol ||
    req?.usuario?.role ||
    null
  );
}
function ensureNoOperador(req, res) {
  const rol = String(getUsuarioRol(req) || "").toLowerCase();
  // ✅ más robusto (operador, operador-vip, etc.)
  if (rol.includes("operador")) {
    res
      .status(403)
      .json({ error: "Acceso denegado: operadores no tienen acceso a Reportes." });
    return false;
  }
  return true;
}

/** Scope:
 * - admin/super-admin => ver todo (salvo onlyMine=true)
 * - otros => por seguridad, propietario
 */
function ownerScope(req) {
  const usuarioId = getUsuarioId(req);
  const rol = String(getUsuarioRol(req) || "").toLowerCase();
  const onlyMine = String(
    req?.query?.onlyMine ?? req?.body?.onlyMine ?? ""
  ).toLowerCase() === "true";
  if (!usuarioId) return {};
  const isAdminLike =
    ["capacitadora", "administracion", "supervisor", "super-admin"].includes(rol);
  if (isAdminLike && !onlyMine) return {};
  return { propietario: new mongoose.Types.ObjectId(usuarioId) };
}

/** abort flag */
function attachAbortFlag(req, res) {
  req.__aborted = false;
  res.on("close", () => (req.__aborted = true));
}
function throwIfAborted(req) {
  if (req?.aborted || req?.__aborted) {
    const e = new Error("CLIENT_ABORTED");
    e.code = "CLIENT_ABORTED";
    throw e;
  }
}

const escapeRegex = (s = "") => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const splitCSV = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) raw = raw.join(",");
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};
const rxExactMulti = (raw, mapFn = (x) => x) => {
  const arr = splitCSV(raw)
    .map((x) => mapFn(String(x).trim()))
    .filter(Boolean);
  if (!arr.length) return null;
  const regs = arr.map((v) => new RegExp(`^${escapeRegex(v)}$`, "i"));
  return regs.length === 1 ? regs[0] : { $in: regs };
};
function buildDniFilter(raw) {
  if (!raw) return null;
  const arr = String(raw)
    .split(/[\s,;]+/g)
    .map((s) => s.replace(/\D/g, ""))
    .filter((s) => s.length > 0);
  if (!arr.length) return null;
  return arr.length === 1 ? arr[0] : { $in: arr };
}

function diaInicioUTC(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const yyyy = Number(m[1]);
    const mm = Number(m[2]);
    const dd = Number(m[3]);
    return new Date(Date.UTC(yyyy, mm - 1, dd));
  }
  // dd/mm/yyyy
  const m2 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m2) {
    const dd = Number(m2[1]);
    const mm = Number(m2[2]);
    const yyyy = Number(m2[3]);
    return new Date(Date.UTC(yyyy, mm - 1, dd));
  }
  return null;
}
function diaFinUTC(raw) {
  const d0 = diaInicioUTC(raw);
  if (!d0) return null;
  return new Date(d0.getTime() + 86399999);
}

function pickSheet(wb) {
  if (wb.Sheets["Datos"]) return { ws: wb.Sheets["Datos"], name: "Datos" };
  const first = wb.SheetNames[0];
  return { ws: wb.Sheets[first], name: first };
}

function parseFileToRows(req) {
  if (!req.file?.buffer) throw new Error("Falta archivo (field: file)");
  const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
  const { ws, name } = pickSheet(wb);
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  return { rows, sheetName: name };
}

/** build query from req.query */
function buildQueryFromReq(req) {
  const { desde, hasta, dni, entidad, operador, estadoCuenta, tipoAcuerdo, mes } =
    req.query || {};

  const q = { ...ownerScope(req) };

  // rango día completo UTC
  if (desde || hasta) {
    const dDesde = desde ? diaInicioUTC(desde) : null;
    const dHasta = hasta ? diaFinUTC(hasta) : null;
    if (dDesde || dHasta) {
      q.fecha = {};
      if (dDesde) q.fecha.$gte = dDesde;
      if (dHasta) q.fecha.$lte = dHasta;
    }
  }

  if (mes) q.mes = String(mes).trim(); // YYYY-MM

  const dniFilter = buildDniFilter(dni);
  if (dniFilter) q.dni = dniFilter;

  const fEntidad = rxExactMulti(entidad, (s) => s.toUpperCase());
  const fOperador = rxExactMulti(operador, (s) => s.toLowerCase());
  const fEstado = rxExactMulti(estadoCuenta);
  const fTipo = rxExactMulti(tipoAcuerdo);

  if (fEntidad) q.entidad = fEntidad;
  if (fOperador) q.operador = fOperador;
  if (fEstado) q.estadoCuenta = fEstado;
  if (fTipo) q.tipoAcuerdo = fTipo;

  return q;
}

function inferMesFromReq(req) {
  const mes = String(req.query?.mes || "").trim();
  if (mes) return mes;

  const desde = String(req.query?.desde || "").trim();
  const hasta = String(req.query?.hasta || "").trim();

  const d = diaInicioUTC(desde) || diaInicioUTC(hasta);
  if (!d) return "";
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

function fmtISO(d) {
  if (!d) return "";
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}
function fmtDMY(d) {
  if (!d) return "";
  try {
    const x = new Date(d);
    if (isNaN(x)) return "";
    const dd = String(x.getUTCDate()).padStart(2, "0");
    const mm = String(x.getUTCMonth() + 1).padStart(2, "0");
    const yy = x.getUTCFullYear();
    return `${dd}/${mm}/${yy}`;
  } catch {
    return "";
  }
}

function monthRangeUTC(mesYYYYMM) {
  const m = String(mesYYYYMM || "").trim();
  const mm = m.match(/^(\d{4})-(\d{2})$/);
  if (!mm) return null;
  const y = Number(mm[1]);
  const mon = Number(mm[2]); // 1..12
  const start = new Date(Date.UTC(y, mon - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, mon, 1, 0, 0, 0, 0) - 1);
  const daysInMonth = new Date(Date.UTC(y, mon, 0)).getUTCDate();
  return { start, end, daysInMonth, y, mon };
}

// ✅ convertir a número robusto para sum/avg aunque venga string, null, ""
const numExpr = (fieldPath) => ({
  $convert: { input: fieldPath, to: "double", onError: 0, onNull: 0 },
});

/** GET /api/acuerdos-pago/ping */
export async function ping(req, res) {
  try {
    attachAbortFlag(req, res);
    return res.json({ ok: true, ts: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

/** POST /api/acuerdos-pago/preview (form-data file) */
export async function preview(req, res) {
  try {
    attachAbortFlag(req, res);
    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { rows, sheetName } = parseFileToRows(req);

    const parsedValid = [];
    const invalidas = [];
    let acuerdosDetectados = 0; // filas que son acuerdo (incluye invalidas)
    for (let i = 0; i < rows.length; i++) {
      const a = parseRowToAcuerdoPago(rows[i]);
      if (!a.isAcuerdo) continue;

      acuerdosDetectados++;
      if (a.invalid) invalidas.push({ idx: i + 2, warnings: a.warnings || [] });
      else parsedValid.push(a);
    }

    // ✅ dedupe por key (key = mes|dni|entidad) => quedarse con el más nuevo (fechaHora)
    const map = new Map();
    for (const a of parsedValid) {
      const prev = map.get(a.key);
      if (!prev) map.set(a.key, a);
      else {
        const tPrev = prev.fechaHora?.getTime?.() ?? 0;
        const tNew = a.fechaHora?.getTime?.() ?? 0;
        if (tNew >= tPrev) map.set(a.key, a);
      }
    }
    const finalDocs = Array.from(map.values());

    const byTipo = {};
    const byOperador = {};
    const byMes = {};

    for (const a of finalDocs) {
      byTipo[a.tipoAcuerdo] = (byTipo[a.tipoAcuerdo] || 0) + 1;
      byOperador[a.operador] = (byOperador[a.operador] || 0) + 1;
      byMes[a.mes] = (byMes[a.mes] || 0) + 1;
    }

    const conWarnings = finalDocs.filter(
      (x) => Array.isArray(x.warnings) && x.warnings.length
    ).length;

    const noAcuerdos = rows.length - acuerdosDetectados;
    const duplicates = Math.max(0, parsedValid.length - finalDocs.length);

    // ✅ respuesta compatible con tu FRONT actual (ImportadorAcuerdos.jsx)
    return res.json({
      ok: true,
      hoja: sheetName,
      totalFilas: rows.length,
      acuerdos: finalDocs.length,
      noAcuerdos,
      conWarnings,
      resumenTipo: byTipo,

      // extras útiles (no rompen)
      acuerdosDetectados,
      acuerdosValidos: parsedValid.length,
      duplicates,
      mesesDetectados: byMes,
      porOperador: byOperador,
      invalidas: invalidas.slice(0, 50),
      warningsCount: conWarnings,
      muestra: finalDocs.slice(0, 60),
    });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

/** POST /api/acuerdos-pago/importar (form-data file) */
export async function importar(req, res) {
  try {
    attachAbortFlag(req, res);
    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const propietario = new mongoose.Types.ObjectId(usuarioId);

    // ✅ compat FRONT: reemplazarTodo (checkbox). Internamente lo usamos como "reemplazarMes" (solo meses del archivo)
    const reemplazarTodo =
      String(req.body?.reemplazarTodo ?? "").toLowerCase() === "true";
    const reemplazarMes =
      String(req.body?.reemplazarMes ?? "").toLowerCase() === "true" ||
      reemplazarTodo;

    const fuenteArchivo = String(
      req.body?.fuenteArchivo ?? req.file?.originalname ?? ""
    ).trim();

    const { rows, sheetName } = parseFileToRows(req);

    const parsedValid = [];
    let acuerdosDetectados = 0;
    for (let i = 0; i < rows.length; i++) {
      const a = parseRowToAcuerdoPago(rows[i]);
      if (!a.isAcuerdo) continue;

      acuerdosDetectados++;
      if (a.invalid) continue;
      if (!a.dni || !a.entidad || !a.mes || !a.key) continue;
      parsedValid.push(a);
    }

    // ✅ dedupe dentro del archivo (key=mes|dni|entidad -> más nuevo)
    const map = new Map();
    for (const a of parsedValid) {
      const prev = map.get(a.key);
      if (!prev) map.set(a.key, a);
      else {
        const tPrev = prev.fechaHora?.getTime?.() ?? 0;
        const tNew = a.fechaHora?.getTime?.() ?? 0;
        if (tNew >= tPrev) map.set(a.key, a);
      }
    }
    const finalDocs = Array.from(map.values());
    const duplicates = Math.max(0, parsedValid.length - finalDocs.length);

    const monthsInFile = Array.from(new Set(finalDocs.map((x) => x.mes)));

    throwIfAborted(req);

    // ✅ Si pedís reemplazarMes=true => borra SOLO esos meses del propietario que importa
    if (reemplazarMes && monthsInFile.length) {
      await AcuerdoPago.deleteMany({
        propietario,
        mes: { $in: monthsInFile },
      });
    }

    // ✅ protección anti “pisar con más viejo” (comparando fechaHora por key)
    const keys = finalDocs.map((d) => d.key);
    const existentes = await AcuerdoPago.find({
      propietario,
      key: { $in: keys },
    })
      .select("key fechaHora")
      .lean();

    const mapExist = new Map(
      existentes.map((x) => [
        x.key,
        x.fechaHora ? new Date(x.fechaHora).getTime() : 0,
      ])
    );

    const ops = [];
    let skippedOlder = 0;

    const entidadesCanonicas = await Entidad.find().select("numero nombre").lean();
    const normalizarEntidad = (value) =>
      String(value || "")
        .trim()
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ");
    const entidadNumeroPorTexto = new Map();
    for (const entidadCatalogo of entidadesCanonicas) {
      const numero = Number(entidadCatalogo.numero);
      const nombre = normalizarEntidad(entidadCatalogo.nombre);
      entidadNumeroPorTexto.set(String(numero), numero);
      entidadNumeroPorTexto.set(nombre, numero);
      entidadNumeroPorTexto.set(normalizarEntidad(`${numero} - ${entidadCatalogo.nombre}`), numero);
    }

    for (const a of finalDocs) {
      const tNew = a.fechaHora?.getTime?.() ?? 0;
      const tOld = mapExist.get(a.key) ?? null;

      if (tOld != null && tOld > tNew) {
        skippedOlder++;
        continue;
      }

      ops.push({
        updateOne: {
          filter: { propietario, key: a.key },
          update: {
            $set: {
              propietario,
              key: a.key,
              mes: a.mes,
              dni: a.dni,
              entidad: a.entidad,
              entidadNumero:
                entidadNumeroPorTexto.get(normalizarEntidad(a.entidad)) || null,
              nombreDeudor: a.nombreDeudor || "",
              idGestion: a.idGestion || "",
              resultado: a.resultado || "",
              operador: a.operador || "",
              estadoCuenta: a.estadoCuenta || "",
              fechaHora: a.fechaHora,
              fecha: a.fecha,
              hora: a.hora,
              tipoAcuerdo: a.tipoAcuerdo || "",

              cuotasCantidad: a.cuotasCantidad ?? null,
              montoCuota: a.montoCuota ?? null,
              primerVto: a.primerVto ?? null,
              anticipoMonto: a.anticipoMonto ?? 0,
              anticipoVto: a.anticipoVto ?? null,

              deudaMin: a.deudaMin ?? null,
              deudaMax: a.deudaMax ?? null,
              observacionCorta: a.observacionCorta || "",
              observacionResumen: a.observacionResumen || "",
              observacionFull: a.observacionFull || "",

              primerPago: a.primerPago ?? null,
              montoTotalAcuerdo: a.montoTotalAcuerdo ?? null,

              // compat / QA
              observacionRaw: a.observacionRaw || "",
              warnings: a.warnings || [],
              fuenteArchivo,
            },
          },
          upsert: true,
        },
      });
    }

    let bulkResult = null;
    if (ops.length) {
      bulkResult = await AcuerdoPago.bulkWrite(ops, { ordered: false });
    }

    const upserted = bulkResult?.upsertedCount ?? 0;
    const modified = bulkResult?.modifiedCount ?? 0;

    const noAcuerdos = rows.length - acuerdosDetectados;

    return res.json({
      ok: true,
      hoja: sheetName,
      totalFilas: rows.length,
      acuerdos: finalDocs.length,
      noAcuerdos,
      duplicates,
      inserted: upserted,
      updated: modified,

      acuerdosDetectados,
      acuerdosValidos: parsedValid.length,
      mesesDetectados: monthsInFile,
      reemplazarMes,
      reemplazarTodo,
      skippedOlder,
      bulk: {
        upserted,
        modified,
        matched: bulkResult?.matchedCount ?? 0,
      },
    });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

/** GET /api/acuerdos-pago/listar */
export async function listar(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { page = 1, limit = 200, sortKey, sortDir, fields = "min" } =
      req.query || {};

    const q = buildQueryFromReq(req);

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(1000, Math.max(1, Number(limit) || 200));
    const skip = (pageNum - 1) * limitNum;

    const ALLOWED_SORT = new Set([
      "dni",
      "entidad",
      "operador",
      "estadoCuenta",
      "tipoAcuerdo",
      "fecha",
      "hora",
      "primerPago",
      "montoTotalAcuerdo",
      "mes",
      "deudaMin",
      "deudaMax",
      "deudaMinTotal",
    ]);

    const key = ALLOWED_SORT.has(String(sortKey)) ? String(sortKey) : "fecha";
    const dir = String(sortDir).toLowerCase() === "asc" ? 1 : -1;

    let sortStage = {};
    if (key === "fecha") sortStage = { fecha: dir, hora: dir, _id: 1 };
    else if (key === "hora") sortStage = { hora: dir, fecha: dir, _id: 1 };
    else sortStage = { [key]: dir, fecha: -1, hora: -1, _id: 1 };

    const PROJ_MIN = {
      dni: 1,
      entidad: 1,
      nombreDeudor: 1,
      operador: 1,
      estadoCuenta: 1,
      resultado: 1,
      tipoAcuerdo: 1,

      fecha: 1,
      hora: 1,
      mes: 1,

      anticipoMonto: 1,
      anticipoVto: 1,

      cuotasCantidad: 1,
      montoCuota: 1,
      primerVto: 1,

      montoTotalAcuerdo: 1,

      deudaMinTotal: "$deudaMin",
      deudaMin: 1,
      deudaMax: 1,

      observacionResumen: 1,
      observacionCorta: 1,

      warnings: 1,
      idGestion: 1,
    };

    const projectStage =
      fields === "min" ? { $project: PROJ_MIN } : { $project: { __v: 0 } };

    throwIfAborted(req);

    const [total, items] = await Promise.all([
      AcuerdoPago.countDocuments(q),
      AcuerdoPago.aggregate([
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

/** DELETE /api/acuerdos-pago/limpiar (por defecto solo mi propietario) */
export async function limpiar(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const propietario = new mongoose.Types.ObjectId(usuarioId);
    const f = req.body?.filtros || {};

    // ✅ compat: el front te manda fechaDesde/fechaHasta, pero el back esperaba desde/hasta
    const desde = f.desde ?? f.fechaDesde ?? "";
    const hasta = f.hasta ?? f.fechaHasta ?? "";
    const dni = f.dni;
    const entidad = f.entidad;
    const operador = f.operador;
    const estadoCuenta = f.estadoCuenta;
    const tipoAcuerdo = f.tipoAcuerdo;
    const mes = f.mes;

    const q = { propietario };

    if (desde || hasta) {
      const dDesde = desde ? diaInicioUTC(desde) : null;
      const dHasta = hasta ? diaFinUTC(hasta) : null;
      if (dDesde || dHasta) {
        q.fecha = {};
        if (dDesde) q.fecha.$gte = dDesde;
        if (dHasta) q.fecha.$lte = dHasta;
      }
    }
    if (mes) q.mes = String(mes).trim();

    const dniFilter = buildDniFilter(dni);
    if (dniFilter) q.dni = dniFilter;

    const fEntidad = rxExactMulti(entidad, (s) => s.toUpperCase());
    const fOperador = rxExactMulti(operador, (s) => s.toLowerCase());
    const fEstado = rxExactMulti(estadoCuenta);
    const fTipo = rxExactMulti(tipoAcuerdo);

    if (fEntidad) q.entidad = fEntidad;
    if (fOperador) q.operador = fOperador;
    if (fEstado) q.estadoCuenta = fEstado;
    if (fTipo) q.tipoAcuerdo = fTipo;

    throwIfAborted(req);

    const r = await AcuerdoPago.deleteMany(q);
    return res.json({ ok: true, borrados: r.deletedCount || 0 });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

/** GET /api/acuerdos-pago/catalogos */
export async function catalogos(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { desde, hasta } = req.query || {};
    const base = { ...ownerScope(req) };

    if (desde || hasta) {
      const dDesde = desde ? diaInicioUTC(desde) : null;
      const dHasta = hasta ? diaFinUTC(hasta) : null;
      if (dDesde || dHasta) {
        base.fecha = {};
        if (dDesde) base.fecha.$gte = dDesde;
        if (dHasta) base.fecha.$lte = dHasta;
      }
    }

    throwIfAborted(req);

    const empleados = (await Empleado.find({ isActive: true })
      .select("username")
      .lean()).map((e) => String(e.username || "").trim());

    const [opsData, entsData, estados, tipos] = await Promise.all([
      AcuerdoPago.distinct("operador", base).collation({ locale: "es", strength: 1 }),
      AcuerdoPago.distinct("entidad", base).collation({ locale: "es", strength: 1 }),
      AcuerdoPago.distinct("estadoCuenta", base).collation({ locale: "es", strength: 1 }),
      AcuerdoPago.distinct("tipoAcuerdo", base).collation({ locale: "es", strength: 1 }),
    ]);

    const entidadesCatalogo = (await Entidad.find()
      .select("nombre")
      .sort({ numero: 1 })
      .lean()).map((x) => String(x.nombre || "").trim());

    const normTxt = (x) => String(x || "").trim();
    const ordenar = (arr = []) =>
      Array.from(new Set((arr || []).map(normTxt).filter((x) => x.length > 0))).sort((a, b) =>
        a.localeCompare(b, "es", { sensitivity: "base" })
      );

    const operadores = ordenar([
      ...empleados.map((x) => x.toLowerCase()),
      ...opsData.map((x) => String(x || "")),
    ]);

    return res.json({
      ok: true,
      operadores,
      entidades: ordenar([...entidadesCatalogo.map((x) => x.toUpperCase()), ...entsData]),
      estadosCuenta: ordenar(estados),
      tiposAcuerdo: ordenar(tipos),
    });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

/** GET /api/acuerdos-pago/export/xlsx (respeta filtros) */
export async function exportarXlsx(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const q = buildQueryFromReq(req);

    const items = await AcuerdoPago.find(q)
      .sort({ fecha: -1, hora: -1 })
      .limit(50000)
      .lean();

    const numOrBlank = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : "";
    };

    // ✅ ORDEN FIJO + FECHAS dd/mm/yyyy + DNI como TEXTO
    const header = [
      "DNI",
      "NOMBRE",
      "FECHA",
      "HORA",
      "OPERADOR",
      "ENTIDAD",
      "ESTADO CUENTA",
      "TIPO ACUERDO",
      "$ ANTICIPO",
      "VTO ANTICIPO",
      "CUOTAS",
      "$ CUOTA",
      "VTO CUOTA",
      "$ TOTAL ACUERDO",
      "$ DEUDA TOTAL",
      "OBSERVACION",
      "WARNINGS",
      "ID_GESTION",
    ];

    const aoa = [
      header,
      ...items.map((x) => ([
        String(x.dni || ""), // ✅ texto
        String(x.nombreDeudor || ""),
        x.fecha ? fmtDMY(x.fecha) : "",
        String(x.hora || ""),
        String(x.operador || ""),
        String(x.entidad || ""),
        String(x.estadoCuenta || ""),
        String(x.tipoAcuerdo || ""),

        numOrBlank(x.anticipoMonto),
        x.anticipoVto ? fmtDMY(x.anticipoVto) : "",

        x.cuotasCantidad ?? "",
        numOrBlank(x.montoCuota),
        x.primerVto ? fmtDMY(x.primerVto) : "",

        numOrBlank(x.montoTotalAcuerdo),
        numOrBlank(x.deudaMin ?? x.deudaMax),

        String(
          x.observacionCorta ||
            x.observacionResumen ||
            x.observacionRaw ||
            ""
        ),
        Array.isArray(x.warnings) ? x.warnings.join(" | ") : "",
        String(x.idGestion || ""), // ✅ texto
      ])),
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // ✅ forzar DNI e ID_GESTION como texto
    const ref = ws["!ref"];
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      for (let R = 1; R <= range.e.r; R++) {
        // DNI col 0
        const cDNI = XLSX.utils.encode_cell({ r: R, c: 0 });
        if (ws[cDNI]) {
          ws[cDNI].t = "s";
          ws[cDNI].v = String(ws[cDNI].v ?? "");
        }
        // FECHA col 2 (string)
        const cFecha = XLSX.utils.encode_cell({ r: R, c: 2 });
        if (ws[cFecha]) {
          ws[cFecha].t = "s";
          ws[cFecha].v = String(ws[cFecha].v ?? "");
        }
        // VTO ANTICIPO col 9 (string)
        const cVtoA = XLSX.utils.encode_cell({ r: R, c: 9 });
        if (ws[cVtoA]) {
          ws[cVtoA].t = "s";
          ws[cVtoA].v = String(ws[cVtoA].v ?? "");
        }
        // VTO CUOTA col 12 (string)
        const cVtoC = XLSX.utils.encode_cell({ r: R, c: 12 });
        if (ws[cVtoC]) {
          ws[cVtoC].t = "s";
          ws[cVtoC].v = String(ws[cVtoC].v ?? "");
        }
        // ID_GESTION col 17
        const cId = XLSX.utils.encode_cell({ r: R, c: 17 });
        if (ws[cId]) {
          ws[cId].t = "s";
          ws[cId].v = String(ws[cId].v ?? "");
        }
      }
    }

    XLSX.utils.book_append_sheet(wb, ws, "ACUERDOS");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="acuerdos_pago_${fechaClaveArgentina()}.xlsx"`
    );

    return res.status(200).send(buf);
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

/** GET /api/acuerdos-pago/analytics/resumen (KPIs filtrados) */
export async function analyticsResumen(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const q = buildQueryFromReq(req);

    throwIfAborted(req);

    const [tot, dnisAgg, porTipo, porEstado, porEntidad, topOperadores] =
      await Promise.all([
        AcuerdoPago.countDocuments(q),
        AcuerdoPago.aggregate([
          { $match: q },
          { $group: { _id: "$dni" } },
          { $count: "n" },
        ]),
        AcuerdoPago.aggregate([
          { $match: q },
          { $group: { _id: "$tipoAcuerdo", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        AcuerdoPago.aggregate([
          { $match: q },
          { $group: { _id: "$estadoCuenta", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        // ✅ torta por entidad
        AcuerdoPago.aggregate([
          { $match: q },
          { $group: { _id: "$entidad", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        AcuerdoPago.aggregate([
          { $match: q },
          {
            $group: {
              _id: "$operador",
              acuerdos: { $sum: 1 },
              sumaPrimerPago: { $sum: numExpr("$primerPago") },
              avgPrimerPago: { $avg: numExpr("$primerPago") },
              sumaMontoTotal: { $sum: numExpr("$montoTotalAcuerdo") },
              avgMontoTotal: { $avg: numExpr("$montoTotalAcuerdo") },
            },
          },
          { $sort: { acuerdos: -1 } },
          { $limit: 20 },
        ]),
      ]);

    const dnisUnicos = dnisAgg?.[0]?.n || 0;

    const moneyAgg = await AcuerdoPago.aggregate([
      { $match: q },
      {
        $group: {
          _id: null,
          sumaPrimerPago: { $sum: numExpr("$primerPago") },
          avgPrimerPago: { $avg: numExpr("$primerPago") },
          sumaMontoTotal: { $sum: numExpr("$montoTotalAcuerdo") },
          avgMontoTotal: { $avg: numExpr("$montoTotalAcuerdo") },
        },
      },
    ]);

    const m = moneyAgg?.[0] || {};

    return res.json({
      ok: true,
      applied: { ...req.query },

      acuerdosTotales: tot,
      dnisUnicos,
      acuerdosPorDni: dnisUnicos ? Number((tot / dnisUnicos).toFixed(2)) : 0,
      ticketPromedioPrimerPago: Number((m.avgPrimerPago || 0).toFixed(2)),
      sumaPrimerPago: Number((m.sumaPrimerPago || 0).toFixed(2)),
      promedioMontoTotalAcuerdo: Number((m.avgMontoTotal || 0).toFixed(2)),
      sumaMontoTotalAcuerdo: Number((m.sumaMontoTotal || 0).toFixed(2)),

      porTipo,
      porEntidad, // ✅ NUEVO
      porEstadoCuenta: porEstado,
      topOperadores,
    });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

/** GET /api/acuerdos-pago/analytics/resumen-operador */
export async function resumenOperador(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const q = buildQueryFromReq(req);

    const rows = await AcuerdoPago.aggregate([
      { $match: q },
      {
        $group: {
          _id: "$operador",
          acuerdosTotales: { $sum: 1 },
          ticketPromedioPrimerPago: { $avg: numExpr("$primerPago") },
          sumaPrimerPago: { $sum: numExpr("$primerPago") },

          cancelacion: {
            $sum: { $cond: [{ $eq: ["$tipoAcuerdo", "Cancelación"] }, 1, 0] },
          },
          cancelacionConAnticipo: {
            $sum: {
              $cond: [{ $eq: ["$tipoAcuerdo", "Cancelación con anticipo"] }, 1, 0],
            },
          },
          cuotasConAnticipo: {
            $sum: {
              $cond: [{ $eq: ["$tipoAcuerdo", "Acuerdo en cuotas con anticipo"] }, 1, 0],
            },
          },
          cuotasSinAnticipo: {
            $sum: {
              $cond: [{ $eq: ["$tipoAcuerdo", "Acuerdo en cuotas sin anticipo"] }, 1, 0],
            },
          },
          parciales: {
            $sum: { $cond: [{ $eq: ["$tipoAcuerdo", "Parcial"] }, 1, 0] },
          },
        },
      },
      { $sort: { acuerdosTotales: -1 } },
    ]);

    return res.json({ ok: true, rows });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

/** GET /api/acuerdos-pago/analytics/por-dia?mes=YYYY-MM */
export async function acuerdosPorDia(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const mes = String(req.query?.mes || "").trim();
    if (!mes) return res.status(400).json({ error: "Falta mes=YYYY-MM" });

    const range = monthRangeUTC(mes);
    if (!range) return res.status(400).json({ error: "Mes inválido. Usá mes=YYYY-MM" });

    const q = { ...buildQueryFromReq(req), mes };

    const rows = await AcuerdoPago.aggregate([
      { $match: q },
      { $addFields: { dia: { $dayOfMonth: "$fecha" } } },
      { $group: { _id: { operador: "$operador", dia: "$dia" }, acuerdos: { $sum: 1 } } },
      { $sort: { "_id.operador": 1, "_id.dia": 1 } },
    ]);

    // ✅ extras para heatmap (no rompe compat porque mantenemos rows)
    const totalsByDay = {};
    for (let d = 1; d <= range.daysInMonth; d++) totalsByDay[String(d)] = 0;

    const map = new Map(); // operador -> { operador, total, dias:{} }
    for (const r of rows) {
      const operador = String(r?._id?.operador || "").trim();
      const dia = Number(r?._id?.dia || 0);
      const acuerdos = Number(r?.acuerdos || 0);
      if (!operador || dia <= 0) continue;

      if (!map.has(operador)) map.set(operador, { operador, total: 0, dias: {} });
      const it = map.get(operador);
      it.total += acuerdos;
      it.dias[String(dia)] = (it.dias[String(dia)] || 0) + acuerdos;

      totalsByDay[String(dia)] = (totalsByDay[String(dia)] || 0) + acuerdos;
    }

    // opcional: incluir todos los operadores activos para que aparezcan con “-”
    const empleados = (await Empleado.find({ isActive: true })
      .select("username")
      .lean()).map((e) => String(e.username || "").trim().toLowerCase());

    for (const op of empleados) {
      if (!op) continue;
      if (!map.has(op)) map.set(op, { operador: op, total: 0, dias: {} });
    }

    const users = Array.from(map.values()).sort((a, b) =>
      String(a.operador || "").localeCompare(String(b.operador || ""), "es", { sensitivity: "base" })
    );

    return res.json({
      ok: true,
      mes,
      rows,         // ✅ compat
      daysInMonth: range.daysInMonth,
      totalsByDay,  // ✅ para la fila de totales (arriba del heatmap)
      users,        // ✅ para armar la grilla usuarios × días
    });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

/** ✅ GET /api/acuerdos-pago/analytics/calendario-mes?mes=YYYY-MM */
export async function analyticsCalendarioMes(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const mes = String(req.query?.mes || "").trim();
    if (!mes) return res.status(400).json({ error: "Falta mes=YYYY-MM" });

    const range = monthRangeUTC(mes);
    if (!range) return res.status(400).json({ error: "Mes inválido. Usá mes=YYYY-MM" });

    const q = { ...buildQueryFromReq(req), mes };
    q.fecha = { $gte: range.start, $lte: range.end };

    const agg = await AcuerdoPago.aggregate([
      { $match: q },
      { $addFields: { dia: { $dayOfMonth: "$fecha" } } },
      { $group: { _id: "$dia", acuerdos: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    const map = new Map(agg.map((r) => [Number(r._id), Number(r.acuerdos || 0)]));

    const dias = [];
    for (let d = 1; d <= range.daysInMonth; d++) {
      const yyyy = range.y;
      const mm = String(range.mon).padStart(2, "0");
      const dd = String(d).padStart(2, "0");
      const fechaISO = `${yyyy}-${mm}-${dd}`;
      dias.push({
        dia: d,
        fecha: fechaISO,
        fechaDMY: `${dd}/${mm}/${yyyy}`, // ✅ para mostrar directo
        acuerdos: map.get(d) || 0
      });
    }

    const total = dias.reduce((a, x) => a + (x.acuerdos || 0), 0);

    return res.json({
      ok: true,
      mes,
      total,
      dias,
      applied: { ...req.query },
    });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

/** GET /api/acuerdos-pago/analytics/ultimos-3-meses?mes=YYYY-MM */
export async function ultimosTresMeses(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const mesBase = String(req.query?.mes || "").trim();
    if (!mesBase) return res.status(400).json({ error: "Falta mes=YYYY-MM" });

    const [y, m] = mesBase.split("-").map(Number);
    const baseDate = new Date(Date.UTC(y, m - 1, 1));

    const months = [0, 1, 2].map((i) => {
      const d = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth() - i, 1));
      const yy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      return `${yy}-${mm}`;
    });

    const results = [];
    for (const mes of months) {
      const q = { ...buildQueryFromReq(req), mes };
      const [tot, dnisAgg, moneyAgg] = await Promise.all([
        AcuerdoPago.countDocuments(q),
        AcuerdoPago.aggregate([{ $match: q }, { $group: { _id: "$dni" } }, { $count: "n" }]),
        AcuerdoPago.aggregate([
          { $match: q },
          {
            $group: {
              _id: null,
              sumaPrimerPago: { $sum: numExpr("$primerPago") },
              avgPrimerPago: { $avg: numExpr("$primerPago") },
              sumaMontoTotal: { $sum: numExpr("$montoTotalAcuerdo") },
            },
          },
        ]),
      ]);

      const dnisUnicos = dnisAgg?.[0]?.n || 0;
      const mmAgg = moneyAgg?.[0] || {};

      results.push({
        mes,
        acuerdosTotales: tot,
        dnisUnicos,
        ticketPromedioPrimerPago: Number((mmAgg.avgPrimerPago || 0).toFixed(2)),
        sumaPrimerPago: Number((mmAgg.sumaPrimerPago || 0).toFixed(2)),
        sumaMontoTotalAcuerdo: Number((mmAgg.sumaMontoTotal || 0).toFixed(2)),
      });
    }

    return res.json({ ok: true, meses: months, results });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

/** GET /api/acuerdos-pago/comparativo?desde=YYYY-MM-DD&hasta=YYYY-MM-DD */
export async function comparativo(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { desde, hasta } = req.query || {};
    const d1 = diaInicioUTC(desde);
    const d2 = diaInicioUTC(hasta);
    const endOfDayUTC = (d) => new Date(d.getTime() + 86399999);

    if (!d1 || !d2 || d2 < d1)
      return res.status(400).json({ error: "Rango de fechas inválido" });

    const days = Math.floor((endOfDayUTC(d2) - d1) / 86400000) + 1;
    const prevEnd = new Date(d1.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86400000);

    const baseFilters = { ...buildQueryFromReq(req) };
    delete baseFilters.fecha;

    const qCur = { ...baseFilters, fecha: { $gte: d1, $lte: endOfDayUTC(d2) } };
    const qPrev = {
      ...baseFilters,
      fecha: { $gte: prevStart, $lte: endOfDayUTC(prevEnd) },
    };

    const calc = async (q) => {
      const [tot, dnisAgg, moneyAgg] = await Promise.all([
        AcuerdoPago.countDocuments(q),
        AcuerdoPago.aggregate([{ $match: q }, { $group: { _id: "$dni" } }, { $count: "n" }]),
        AcuerdoPago.aggregate([
          { $match: q },
          {
            $group: {
              _id: null,
              sumaPrimerPago: { $sum: numExpr("$primerPago") },
              avgPrimerPago: { $avg: numExpr("$primerPago") },
              sumaMontoTotal: { $sum: numExpr("$montoTotalAcuerdo") },
            },
          },
        ]),
      ]);
      const dnisUnicos = dnisAgg?.[0]?.n || 0;
      const m = moneyAgg?.[0] || {};
      return {
        acuerdosTotales: tot,
        dnisUnicos,
        acuerdosPorDni: dnisUnicos ? Number((tot / dnisUnicos).toFixed(2)) : 0,
        ticketPromedioPrimerPago: Number((m.avgPrimerPago || 0).toFixed(2)),
        sumaPrimerPago: Number((m.sumaPrimerPago || 0).toFixed(2)),
        sumaMontoTotalAcuerdo: Number((m.sumaMontoTotal || 0).toFixed(2)),
      };
    };

    const [actual, anterior] = await Promise.all([calc(qCur), calc(qPrev)]);

    const delta = (a, b) => ({
      abs: Number(((a || 0) - (b || 0)).toFixed(2)),
      pct: b ? Number((((a - b) / b) * 100).toFixed(2)) : null,
    });

    return res.json({
      ok: true,
      rangoActual: {
        desde: fmtDMY(d1),
        hasta: fmtDMY(d2),
        desdeISO: fmtISO(d1),
        hastaISO: fmtISO(d2),
        days,
      },
      rangoAnterior: {
        desde: fmtDMY(prevStart),
        hasta: fmtDMY(prevEnd),
        desdeISO: fmtISO(prevStart),
        hastaISO: fmtISO(prevEnd),
      },
      actual,
      anterior,
      deltas: {
        acuerdosTotales: delta(actual.acuerdosTotales, anterior.acuerdosTotales),
        dnisUnicos: delta(actual.dnisUnicos, anterior.dnisUnicos),
        ticketPromedioPrimerPago: delta(
          actual.ticketPromedioPrimerPago,
          anterior.ticketPromedioPrimerPago
        ),
        sumaPrimerPago: delta(actual.sumaPrimerPago, anterior.sumaPrimerPago),
        sumaMontoTotalAcuerdo: delta(
          actual.sumaMontoTotalAcuerdo,
          anterior.sumaMontoTotalAcuerdo
        ),
      },
    });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}
