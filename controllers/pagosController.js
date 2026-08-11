// controllers/pagosController.js
import Pago, { CONCEPTOS_MAP, PAGO_ESTADOS } from "../models/Pago.js";
import Entidad from "../models/Entidad.js";
import SubCesion from "../models/SubCesion.js";
import Empleado from "../models/Empleado.js";
import JobProceso from "../models/JobProceso.js";
import ExcelJS from "exceljs";
import {
  claveFechaCalendario,
  fechaClaveArgentina,
  inicioDiaCalendarioUTC,
  siguienteDiaCalendarioUTC,
  toDateOnly,
} from "../utils/fecha.util.js";

/* ──────────────────────────────────────────────────────────────
   Helpers de fecha calendario
   - fechaPago NO es un instante: es un día calendario.
   - Se persiste/consulta por componentes UTC para que 11/08 siga siendo 11/08.
   - “Hoy” se obtiene siempre con el calendario de Buenos Aires.
   ────────────────────────────────────────────────────────────── */
const startOfDay = (value) => inicioDiaCalendarioUTC(value);

const parseFechaDDMMYYYY = (val) => {
  if (val === null || val === undefined || val === "") return null;

  if (val && typeof val === "object" && val.result != null) {
    return parseFechaDDMMYYYY(val.result);
  }

  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return inicioDiaCalendarioUTC(val);
  }

  const s = String(val).trim();

  // yyyy-mm-dd / ISO: conservar literalmente el día calendario.
  const isoKey = claveFechaCalendario(s);
  if (isoKey) return inicioDiaCalendarioUTC(isoKey);

  // dd/mm/aaaa | dd-mm-aaaa | dd/mm | dd-mm | dd/mm/yy | dd-mm-yy
  const match = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2}|\d{4}))?$/);
  if (!match) return null;

  const dd = Number(match[1]);
  const mm = Number(match[2]);
  const anioActualArgentina = Number(fechaClaveArgentina().slice(0, 4));
  let yyyy = match[3] ? Number(match[3]) : anioActualArgentina;
  if (match[3] && String(match[3]).length === 2) yyyy = 2000 + yyyy;
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return null;

  const canonical = toDateOnly(`${String(dd).padStart(2, "0")}-${String(mm).padStart(2, "0")}-${yyyy}`);
  return canonical ? inicioDiaCalendarioUTC(canonical) : null;
};

function formatDateOnlyUTC(v) {
  const key = claveFechaCalendario(v);
  if (!key) return "";
  const [yyyy, mm, dd] = key.split("-");
  return `${dd}/${mm}/${yyyy}`;
}

function formatFechaInput(val) {
  if (val === null || val === undefined || val === "") return "";
  const parsed = parseFechaDDMMYYYY(val);
  return parsed ? formatDateOnlyUTC(parsed) : String(val).trim();
}

function parseLocalYMD(ymd) {
  return inicioDiaCalendarioUTC(ymd);
}

function nextDay(date) {
  return siguienteDiaCalendarioUTC(date);
}

/* ──────────────────────────────────────────────────────────────
   NUEVO: operador filter helpers
   ────────────────────────────────────────────────────────────── */
function parseOperadorQuery(operador) {
  if (!operador) return [];
  return String(operador)
    .split(/[, ]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function applyOperadorMatch(match, operador) {
  const ops = parseOperadorQuery(operador);
  if (!ops.length) return;
  match.operadorUsername = ops.length === 1 ? ops[0] : { $in: ops };
}

function countBusinessDaysInclusiveCalendar(startInclusive, endInclusive) {
  if (!(startInclusive instanceof Date) || isNaN(startInclusive)) return 0;
  if (!(endInclusive instanceof Date) || isNaN(endInclusive)) return 0;

  const a = inicioDiaCalendarioUTC(startInclusive);
  const b = inicioDiaCalendarioUTC(endInclusive);
  if (!a || !b) return 0;

  if (a > b) return 0;

  let count = 0;
  const cur = new Date(a);
  while (cur <= b) {
    const wd = cur.getUTCDay(); // 0 domingo, 6 sábado
    if (wd !== 0 && wd !== 6) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

/* ──────────────────────────────────────────────────────────────
   Lectura de hoja desde XLSX/XLS y fallback CSV (coma/;/\t)
   ────────────────────────────────────────────────────────────── */
async function cargarWorksheetDesdeBuffer(file) {
  const wb = new ExcelJS.Workbook();

  // 1) Intento XLSX/XLS
  try {
    await wb.xlsx.load(file.buffer);
    if (!wb.worksheets?.length) throw new Error("xlsx sin hojas");
    return wb.worksheets[0];
  } catch {
    // 2) Fallback CSV: autodetectar delimitador y parsear
    const name = (file.originalname || "").toLowerCase();
    const looksCsv =
      name.endsWith(".csv") || (file.mimetype || "").includes("csv") || true; // permitimos CSV aunque el mimetype no ayude
    if (!looksCsv) throw new Error("Archivo no es XLSX y no parece CSV");

    const csvText = bufferToUtf8(file.buffer);
    const { rows } = parseCSVAuto(csvText); // array de arrays
    return createCsvWorksheet(rows);
  }
}

// Convierte Buffer a UTF-8 respetando BOM si existe
function bufferToUtf8(buf) {
  if (!buf) return "";
  let text = buf.toString("utf8");
  // remover BOM si está
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text;
}

// Autodetecta delimitador (coma/;/\t) y parsea CSV con comillas dobles
function parseCSVAuto(text) {
  // normalizar saltos \r\n -> \n para facilitar
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const firstLine = text.split("\n")[0] || "";
  const cand = [",", ";", "\t"];
  const counts = cand.map((c) => countOutsideQuotes(firstLine, c));
  // elegimos el separador con mayor cantidad
  let delimiter = ",";
  let maxIdx = 0;
  for (let i = 1; i < cand.length; i++) {
    if (counts[i] > counts[maxIdx]) maxIdx = i;
  }
  delimiter = cand[maxIdx] || ",";

  const rows = parseCSV(text, delimiter);
  return { delimiter, rows };
}

// Cuenta cuántas veces aparece 'sep' fuera de comillas en una línea
function countOutsideQuotes(line, sep) {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const peek = line[i + 1];
    if (ch === '"') {
      if (inQuotes && peek === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (!inQuotes && ch === sep) {
      count++;
    }
  }
  return count;
}

// Parser CSV que respeta comillas dobles y el separador elegido. Soporta campos vacíos.
function parseCSV(text, sep = ",") {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const peek = text[i + 1];

    if (ch === '"') {
      if (inQuotes && peek === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && ch === sep) {
      row.push(cur);
      cur = "";
    } else if (!inQuotes && ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else {
      cur += ch;
    }
  }
  // Cierra última fila si quedó algo
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }

  // filtrar filas vacías
  return rows.filter((r) => r.some((v) => String(v || "").trim() !== ""));
}

// Simulamos una Worksheet de ExcelJS para el resto del código
function createCsvWorksheet(rows) {
  // normalizamos: recortar espacios de headers (fila 1) y mantener el resto crudo
  if (rows.length) {
    rows[0] = rows[0].map((v) => String(v || "").trim());
  }

  return {
    lastRow: { number: rows.length },
    getRow: (rowNumber) => {
      const arr = rows[rowNumber - 1] || [];
      return {
        getCell: (colNumber) => {
          const idx =
            (typeof colNumber === "number" ? colNumber : Number(colNumber)) - 1;
          return { value: arr[idx] ?? "" };
        },
        eachCell: (cb) => {
          for (let c = 0; c < arr.length; c++) {
            cb({ value: arr[c] ?? "" }, c + 1);
          }
        },
      };
    },
  };
}

/**
 * Genera y envía un Excel de errores. Termina la respuesta HTTP.
 * ✅ FIX: tipos (DNI/MONTO/SALDO numéricos) + fecha dd/mm/yyyy
 */
async function enviarExcelErrores(res, nombreArchivo, columns, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Errores");
  sheet.columns = columns.map((c) => ({ width: 25, ...c }));

  const toNum = (v) => {
    if (v === null || v === undefined || v === "") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const s = String(v).trim();
    if (!s) return v;
    if (/^\d+$/.test(s)) return Number(s);
    const n = Number(s.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : v;
  };

  const normRows = rows.map((r) => {
    const out = { ...r };
    for (const k of Object.keys(out)) {
      const kk = String(k).toLowerCase();

      if (["dni", "saldo", "monto", "entidadid", "fila", "idpago"].includes(kk)) {
        out[k] = toNum(out[k]);
      }

      if (kk.includes("fecha")) {
        const parsed = parseFechaDDMMYYYY(out[k]);
        if (parsed) out[k] = parsed; // Date real
      }
    }
    return out;
  });

  normRows.forEach((r) => sheet.addRow(r));

  // formatos por columna (según key)
  columns.forEach((c) => {
    const key = String(c.key || "");
    const kk = key.toLowerCase();
    if (!key) return;

    if (["dni", "entidadId", "entidadid", "fila", "idPago", "idpago"].includes(kk)) {
      sheet.getColumn(key).numFmt = "0";
    }
    if (["monto", "saldo"].includes(kk)) {
      sheet.getColumn(key).numFmt = "#,##0.00";
    }
    if (kk.includes("fecha")) {
      sheet.getColumn(key).numFmt = "dd/mm/yyyy";
    }
  });

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "middle", horizontal: "center" };

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=${encodeURIComponent(nombreArchivo)}.xlsx`
  );
  await workbook.xlsx.write(res);
  res.end();
}

/* ──────────────────────────────────────────────────────────────
   Helper: userId seguro/optional para JobProceso
   ────────────────────────────────────────────────────────────── */
async function getUserIdSeguro(req) {
  if (req?.usuario?._id) return req.usuario._id;
  if (process.env.SYSTEM_USERNAME) {
    const u = await Empleado.findOne({ username: process.env.SYSTEM_USERNAME })
      .select("_id")
      .lean();
    if (u?._id) return u._id;
  }
  const first = await Empleado.findOne({}, { _id: 1 }).lean();
  if (first?._id) return first._id;
  return null; // no hay usuario disponible, evitamos romper JobProceso
}

/* ──────────────────────────────────────────────────────────────
   GET /api/pagos  → listado + filtros + paginación
   - La pantalla usa páginas numeradas.
   - Se conserva cursor para procesos internos/estadísticas antiguas.
   ────────────────────────────────────────────────────────────── */
export const listPagos = async (req, res) => {
  try {
    const {
      dni,
      nombre,
      entidadId,
      subCesionId,
      estado,
      concepto,
      fechaDesde,
      fechaHasta,
      nroRemesa,
      cuentaDestino,
      cursor,
      page,
      limit = 50,
      idPago,
      operador,
      sortKey,
      sortDir,
    } = req.query;

    const filtros = {};
    if (dni) filtros.dni = String(dni).trim();
    if (nombre) filtros.titularNombre = { $regex: String(nombre).trim(), $options: "i" };
    if (entidadId && Number.isFinite(Number(entidadId))) filtros.entidadId = Number(entidadId);
    if (subCesionId) filtros.subCesionId = subCesionId;
    if (estado) filtros.estado = String(estado).trim().toUpperCase();
    if (concepto) filtros.conceptoCodigo = String(concepto).trim().toUpperCase();
    applyOperadorMatch(filtros, operador);

    if (fechaDesde || fechaHasta) {
      filtros.fechaPago = {};
      if (fechaDesde) {
        const d = parseLocalYMD(fechaDesde);
        if (d) filtros.fechaPago.$gte = d;
      }
      if (fechaHasta) {
        const h0 = parseLocalYMD(fechaHasta);
        if (h0) filtros.fechaPago.$lt = nextDay(h0);
      }
      if (!Object.keys(filtros.fechaPago).length) delete filtros.fechaPago;
    }

    if (nroRemesa) filtros.nroRemesa = String(nroRemesa).trim();
    if (cuentaDestino) filtros.cuentaDestino = { $regex: String(cuentaDestino).trim(), $options: "i" };
    if (idPago && /^\d+$/.test(String(idPago).trim())) filtros.idPago = Number(idPago);

    const safeLimit = Math.min(Math.max(Number(limit) || 50, 10), 500);
    const sortFields = {
      idPago: "idPago", dni: "dni", nombre: "titularNombre", entidad: "entidadId",
      subCesion: "subCesionId", concepto: "conceptoCodigo", fecha: "fechaPago", monto: "monto",
      operador: "operadorUsername", cuentaDestino: "cuentaDestino", nroRemesa: "nroRemesa",
      estado: "estado", observaciones: "observaciones",
    };
    const sortField = sortFields[String(sortKey || "fecha")] || "fechaPago";
    const sortDirection = String(sortDir || "desc").toLowerCase() === "asc" ? 1 : -1;
    const sortSpec = { [sortField]: sortDirection, _id: sortDirection };
    const populate = (query) => query
      .populate("subCesionId", "nombre")
      .populate("operadorId", "username nombre")
      .populate("creadoPor", "username nombre")
      .populate("modificadoPor", "username nombre");

    // Paginación numerada para la tabla principal.
    if (page !== undefined && page !== null && String(page) !== "") {
      const safePage = Math.max(Number(page) || 1, 1);
      const skip = (safePage - 1) * safeLimit;
      const [total, pagos] = await Promise.all([
        Pago.countDocuments(filtros),
        populate(
          Pago.find(filtros)
            .sort(sortSpec)
            .skip(skip)
            .limit(safeLimit)
        ),
      ]);
      const pages = Math.max(1, Math.ceil(total / safeLimit));
      return res.json({
        ok: true,
        data: pagos,
        total,
        page: Math.min(safePage, pages),
        pages,
        limit: safeLimit,
        nextCursor: null,
      });
    }

    // Compatibilidad: paginación por cursor usada por cargas completas.
    const cursorFiltros = { ...filtros };
    if (cursor) {
      const separator = String(cursor).lastIndexOf("_");
      const fechaStr = separator >= 0 ? String(cursor).slice(0, separator) : "";
      const id = separator >= 0 ? String(cursor).slice(separator + 1) : "";
      const fecha = new Date(fechaStr);
      if (!Number.isNaN(fecha.getTime()) && id) {
        cursorFiltros.$or = [
          { fechaPago: { $lt: fecha } },
          { fechaPago: fecha, _id: { $lt: id } },
        ];
      }
    }

    const pagos = await populate(
      Pago.find(cursorFiltros)
        .sort(sortSpec)
        .limit(safeLimit + 1)
    );

    let nextCursor = null;
    if (pagos.length > safeLimit) {
      const last = pagos[safeLimit - 1];
      nextCursor = `${last.fechaPago.toISOString()}_${last._id}`;
    }

    return res.json({ ok: true, data: pagos.slice(0, safeLimit), nextCursor });
  } catch (error) {
    console.error("Error en listPagos:", error);
    return res.status(500).json({ ok: false, msg: "Error al listar pagos" });
  }
};

/* ──────────────────────────────────────────────────────────────
   GET /api/pagos/catalogos → catálogos operativos del módulo
   ────────────────────────────────────────────────────────────── */
export const getPagosCatalogos = async (_req, res) => {
  try {
    const [entidades, subCesiones, operadores] = await Promise.all([
      Entidad.find().select("numero nombre").sort({ numero: 1 }).lean(),
      SubCesion.find().select("nombre").sort({ nombre: 1 }).lean(),
      Empleado.find({
        isActive: { $ne: false },
        role: { $in: ["operador", "operador-vip", "capacitadora", "administracion", "admin", "supervisor", "super-admin"] },
      })
        .select("username nombre role")
        .sort({ username: 1 })
        .lean(),
    ]);

    return res.json({
      ok: true,
      entidades,
      subCesiones,
      operadores,
      conceptos: Object.entries(CONCEPTOS_MAP).map(([codigo, nombre]) => ({ codigo, nombre })),
      estados: PAGO_ESTADOS,
    });
  } catch (error) {
    console.error("Error en getPagosCatalogos:", error);
    return res.status(500).json({ ok: false, msg: "No se pudieron cargar los catálogos de Pagos" });
  }
};

/* ──────────────────────────────────────────────────────────────
   POST /api/pagos/manual → alta individual segura
   - El estado inicial siempre es INGRESADO.
   - Mantiene la misma clave única que las importaciones masivas.
   ────────────────────────────────────────────────────────────── */
export const createPagoManual = async (req, res) => {
  try {
    const {
      dni,
      titularNombre,
      entidadId,
      subCesionId,
      conceptoCodigo,
      fechaPago,
      monto,
      operadorUsername,
      cuentaDestino = "",
      nroRemesa = "",
      observaciones = "",
    } = req.body || {};

    const errores = [];
    const dniNormalizado = String(dni || "").replace(/\D/g, "");
    const nombreNormalizado = String(titularNombre || "").trim();
    const entidadNumero = Number(entidadId);
    const concepto = String(conceptoCodigo || "").trim().toUpperCase();
    const fecha = parseLocalYMD(fechaPago) || parseFechaDDMMYYYY(fechaPago);
    const montoNumero = Number(monto);
    const operadorNormalizado = String(operadorUsername || "").trim().toLowerCase();

    if (!dniNormalizado) errores.push("Ingresá el DNI.");
    if (!nombreNormalizado) errores.push("Ingresá el nombre del titular.");
    if (!Number.isFinite(entidadNumero)) errores.push("Seleccioná una entidad.");
    if (!subCesionId) errores.push("Seleccioná una subcesión.");
    if (!Object.prototype.hasOwnProperty.call(CONCEPTOS_MAP, concepto)) errores.push("Seleccioná un concepto válido.");
    if (!fecha) errores.push("Ingresá una fecha de pago válida.");
    if (!Number.isFinite(montoNumero) || montoNumero <= 0) errores.push("El monto debe ser mayor a cero.");
    if (!operadorNormalizado) errores.push("Seleccioná un operador.");
    if (errores.length) return res.status(400).json({ ok: false, errores, msg: errores[0] });

    const [entidad, subCesion, operador] = await Promise.all([
      Entidad.findOne({ numero: entidadNumero }).select("numero nombre").lean(),
      SubCesion.findById(subCesionId).select("nombre").lean(),
      Empleado.findOne({ username: operadorNormalizado, isActive: { $ne: false } })
        .select("username nombre role")
        .lean(),
    ]);

    if (!entidad) return res.status(400).json({ ok: false, msg: "La entidad seleccionada ya no existe." });
    if (!subCesion) return res.status(400).json({ ok: false, msg: "La subcesión seleccionada ya no existe." });
    if (!operador) return res.status(400).json({ ok: false, msg: "El operador seleccionado no existe o está inactivo." });

    const pago = await Pago.create({
      dni: dniNormalizado,
      titularNombre: nombreNormalizado,
      entidadId: entidadNumero,
      subCesionId,
      conceptoCodigo: concepto,
      fechaPago: startOfDay(fecha),
      monto: montoNumero,
      operadorUsername: operador.username,
      operadorId: operador._id,
      cuentaDestino: String(cuentaDestino || "").trim(),
      nroRemesa: String(nroRemesa || "").trim(),
      estado: "INGRESADO",
      observaciones: String(observaciones || "").trim(),
      creadoPor: req.user?.id || null,
      modificadoPor: req.user?.id || null,
    });

    const creado = await Pago.findById(pago._id)
      .populate("subCesionId", "nombre")
      .populate("operadorId", "username nombre")
      .populate("creadoPor", "username nombre")
      .populate("modificadoPor", "username nombre");

    return res.status(201).json({ ok: true, pago: creado, msg: "Pago cargado manualmente" });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        ok: false,
        msg: "Ese pago ya existe para el mismo DNI, entidad, subcesión, fecha y monto.",
      });
    }
    console.error("Error en createPagoManual:", error);
    return res.status(500).json({ ok: false, msg: error?.message || "No se pudo crear el pago" });
  }
};

/* ──────────────────────────────────────────────────────────────
   GET /api/pagos/export  → Excel con todas las columnas
   ────────────────────────────────────────────────────────────── */
export const exportPagos = async (req, res) => {
  try {
    const {
      idPago,
      dni,
      nombre,
      entidadId,
      subCesionId,
      estado,
      concepto,
      fechaDesde,
      fechaHasta,
      operador,
      nroRemesa,
      cuentaDestino,
      sortKey,
      sortDir,
    } = req.query;

    const filtros = {};
    if (idPago && /^\d+$/.test(String(idPago).trim())) filtros.idPago = Number(idPago);
    if (dni) filtros.dni = String(dni).trim();
    if (nombre) filtros.titularNombre = { $regex: String(nombre).trim(), $options: "i" };
    if (entidadId && Number.isFinite(Number(entidadId))) filtros.entidadId = Number(entidadId);
    if (subCesionId) filtros.subCesionId = subCesionId;
    if (estado) filtros.estado = String(estado).trim().toUpperCase();
    if (concepto) filtros.conceptoCodigo = String(concepto).trim().toUpperCase();
    if (nroRemesa) filtros.nroRemesa = String(nroRemesa).trim();
    if (cuentaDestino) filtros.cuentaDestino = { $regex: String(cuentaDestino).trim(), $options: "i" };
    applyOperadorMatch(filtros, operador);

    if (fechaDesde || fechaHasta) {
      filtros.fechaPago = {};
      if (fechaDesde) {
        const d = parseLocalYMD(fechaDesde);
        if (d) filtros.fechaPago.$gte = d;
      }
      if (fechaHasta) {
        const h0 = parseLocalYMD(fechaHasta);
        if (h0) filtros.fechaPago.$lt = nextDay(h0);
      }
    }

    const sortFields = {
      idPago: "idPago", dni: "dni", nombre: "titularNombre", entidad: "entidadId",
      subCesion: "subCesionId", concepto: "conceptoCodigo", fecha: "fechaPago", monto: "monto",
      operador: "operadorUsername", cuentaDestino: "cuentaDestino", nroRemesa: "nroRemesa",
      estado: "estado", observaciones: "observaciones",
    };
    const sortField = sortFields[String(sortKey || "fecha")] || "fechaPago";
    const sortDirection = String(sortDir || "desc").toLowerCase() === "asc" ? 1 : -1;

    const pagos = await Pago.find(filtros)
      .sort({ [sortField]: sortDirection, _id: sortDirection })
      .populate("subCesionId", "nombre")
      .populate("operadorId", "username nombre")
      .lean();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Pagos");

    sheet.columns = [
      { header: "ID PAGO", key: "idPago", width: 14 },
      { header: "DNI", key: "dni", width: 12 },
      { header: "Titular", key: "titularNombre", width: 24 },
      { header: "Entidad", key: "entidadId", width: 10 },
      { header: "SubCesión", key: "subCesion", width: 20 },
      { header: "Concepto", key: "conceptoTexto", width: 20 },
      { header: "Fecha Pago", key: "fechaPago", width: 15 },
      { header: "Monto", key: "monto", width: 12 },
      { header: "Operador", key: "operador", width: 20 },
      { header: "Cuenta Destino", key: "cuentaDestino", width: 20 },
      { header: "Nro Remesa", key: "nroRemesa", width: 18 },
      { header: "Estado", key: "estado", width: 15 },
      { header: "Observaciones", key: "observaciones", width: 30 },
      { header: "Creado en", key: "createdAt", width: 20 },
      { header: "Modificado en", key: "updatedAt", width: 20 },
    ];

    pagos.forEach((p) => {
      sheet.addRow({
        idPago: p.idPago,
        dni: p.dni,
        titularNombre: p.titularNombre,
        entidadId: p.entidadId,
        subCesion: p.subCesionId?.nombre || "",
        conceptoTexto: CONCEPTOS_MAP[p.conceptoCodigo] || p.conceptoCodigo,
        fechaPago: formatDateOnlyUTC(p.fechaPago),
        monto: p.monto,
        operador: p.operadorId?.username || p.operadorUsername,
        cuentaDestino: p.cuentaDestino,
        nroRemesa: p.nroRemesa,
        estado: p.estado,
        observaciones: p.observaciones,
        createdAt: new Date(p.createdAt).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
        updatedAt: new Date(p.updatedAt).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    const desdeNombre = String(fechaDesde || "inicio").replace(/[^0-9-]/g, "");
    const hastaNombre = String(fechaHasta || "actualidad").replace(/[^0-9-]/g, "");
    const filtrosNombre = [
      operador ? `operador-${String(operador).replace(/[^a-zA-Z0-9_-]/g, "_")}` : "",
      entidadId ? `entidad-${String(entidadId).replace(/[^a-zA-Z0-9_-]/g, "_")}` : "",
      estado ? `estado-${String(estado).replace(/[^a-zA-Z0-9_-]/g, "_")}` : "",
    ].filter(Boolean).join("_");
    const filename = `Pagos_RDC_${desdeNombre}_a_${hastaNombre}${filtrosNombre ? `_${filtrosNombre}` : ""}.xlsx`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Error en exportPagos:", error);
    res.status(500).json({ ok: false, msg: "Error al exportar pagos" });
  }
};

/* ──────────────────────────────────────────────────────────────
   POST /api/pagos/import  → Import masivo de PAGOS (mejorado)
   ────────────────────────────────────────────────────────────── */
export const importPagos = async (req, res) => {
  if (!req.file?.buffer) {
    return res.status(400).json({
      ok: false,
      msg: "Subí un archivo en el campo 'file' (XLSX/CSV).",
    });
  }

  const userId = await getUserIdSeguro(req);
  const usarJobs = !!userId;

  if (usarJobs) {
    const activo = await JobProceso.findOne({
      tipo: "IMPORT_PAGOS",
      estado: "EN_PROCESO",
    });
    if (activo) {
      return res.status(409).json({
        ok: false,
        msg: "Ya hay un proceso en curso. Esperá a que termine.",
      });
    }
  }

  let job = null;
  if (usarJobs) {
    job = await JobProceso.create({
      tipo: "IMPORT_PAGOS",
      estado: "EN_PROCESO",
      iniciadoPor: userId,
    });
  }

  const errores = [];
  let insertados = 0;
  let totalLeidas = 0;

  // helper para normalizar mensaje mongo
  const msgMongo = (we) => {
    const m = we?.errmsg || we?.err?.errmsg || we?.message || "";
    if (/E11000/i.test(m)) {
      return "Duplicado de clave de negocio (DNI + ENTIDAD_ID + SUBCESIÓN + FECHA_PAGO + MONTO)";
    }
    return m || "Error en inserción";
  };

  try {
    const ws = await cargarWorksheetDesdeBuffer(req.file);
    if (!ws) throw new Error("No pude leer la hoja del archivo.");

    // Encabezados
    const headers = {};
    ws.getRow(1).eachCell((cell, col) => {
      headers[(cell?.value || "").toString().trim().toUpperCase()] = col;
    });

    const REQ = [
      "DNI",
      "TITULAR_NOMBRE",
      "ENTIDAD_ID",
      "SUBCESION",
      "CONCEPTO",
      "FECHA_PAGO",
      "MONTO",
      "OPERADOR",
    ];
    const faltan = REQ.filter((h) => !headers[h]);
    if (faltan.length) {
      throw new Error(`Faltan columnas requeridas: ${faltan.join(", ")}`);
    }

    // Catálogos
    const entidadesSet = new Set(
      (await Entidad.find({}, { numero: 1 }).lean()).map((e) => e.numero)
    );
    const subMap = new Map(
      (await SubCesion.find({}, { _id: 1, nombre: 1 }).lean()).map((s) => [
        String(s.nombre).trim().toUpperCase(),
        s._id,
      ])
    );
    const opSet = new Set(
      (await Empleado.find({}, { username: 1 }).lean()).map((u) =>
        String(u.username).trim().toLowerCase()
      )
    );

    // Operaciones y metas (fila y valores "de entrada" para reporte)
    const ops = [];
    const metas = [];
    totalLeidas = 0; // ✅ FIX: contar solo filas con datos

    const seenInFile = new Set(); // clave negocio para duplicados dentro del archivo

    const unwrap = (x) => (x && typeof x === "object" && x.result != null ? x.result : x);

    for (let r = 2; r <= (ws.lastRow?.number || 1); r++) {
      const row = ws.getRow(r);
      const v = (H) => row.getCell(headers[H]).value;

      // ✅ FIX: saltar filas completamente vacías (típico en XLSX con filas de más)
      const filaVacia = REQ.every((H) => {
        const val = unwrap(v(H));
        if (val === null || val === undefined) return true;
        if (val instanceof Date) return false;
        const s = String(val).trim();
        return s === "";
      });
      if (filaVacia) continue;
      totalLeidas++;

      const raw = {
        DNI: v("DNI"),
        TITULAR_NOMBRE: v("TITULAR_NOMBRE"),
        ENTIDAD_ID: v("ENTIDAD_ID"),
        SUBCESION: v("SUBCESION"),
        CONCEPTO: v("CONCEPTO"),
        FECHA_PAGO: v("FECHA_PAGO"),
        MONTO: v("MONTO"),
        OPERADOR: v("OPERADOR"),
        CUENTA_DESTINO: headers["CUENTA_DESTINO"] ? v("CUENTA_DESTINO") : "",
        OBSERVACIONES: headers["OBSERVACIONES"] ? v("OBSERVACIONES") : "",
      };

      // Parseos / normalizaciones
      const dni = String(unwrap(raw.DNI) || "").trim();
      const titularNombre = String(unwrap(raw.TITULAR_NOMBRE) || "")
        .trim()
        .toUpperCase();
      const entidadId = Number(unwrap(raw.ENTIDAD_ID));
      const subNombre = String(unwrap(raw.SUBCESION) || "").trim().toUpperCase();
      const conceptoCodigo = String(unwrap(raw.CONCEPTO) || "").trim().toUpperCase();
      const fechaPago = parseFechaDDMMYYYY(unwrap(raw.FECHA_PAGO));

      const montoRaw = unwrap(raw.MONTO);
      const monto = typeof montoRaw === "number"
        ? montoRaw
        : Number(String(montoRaw ?? "").toString().replace(/\./g, "").replace(",", "."));

      const operadorUsername = String(unwrap(raw.OPERADOR) || "").trim().toLowerCase();
      const cuentaDestino = String(unwrap(raw.CUENTA_DESTINO) || "").trim();
      const observaciones = String(unwrap(raw.OBSERVACIONES) || "").trim();

      // Validaciones
      const errs = [];
      if (!dni) errs.push("DNI vacío");
      if (!titularNombre) errs.push("TITULAR_NOMBRE vacío");
      if (!Number.isFinite(entidadId)) errs.push("ENTIDAD_ID inválido");
      if (Number.isFinite(entidadId) && !entidadesSet.has(entidadId))
        errs.push("ENTIDAD_ID no existe en catálogo");
      const subId = subMap.get(subNombre);
      if (!subId) errs.push("SUBCESION (nombre) no encontrada");
      if (!CONCEPTOS_MAP[conceptoCodigo]) errs.push("CONCEPTO inválido");
      if (!fechaPago) errs.push("FECHA_PAGO inválida (usa dd/mm/aaaa o dd-mm)");
      if (!Number.isFinite(monto) || monto <= 0) errs.push("MONTO inválido");
      if (!operadorUsername) errs.push("OPERADOR vacío");
      if (operadorUsername && !opSet.has(operadorUsername))
        errs.push("OPERADOR no existe");

      if (errs.length) {
        errores.push({
          fila: r,
          dni,
          entidadId,
          subCesion: subNombre,
          concepto: conceptoCodigo,
          fechaPago: formatFechaInput(unwrap(raw.FECHA_PAGO)),
          monto: unwrap(raw.MONTO) ?? "",
          operador: operadorUsername,
          motivo: errs.join(" | "),
        });
        continue;
      }


      // ✅ FIX DUPLICADOS: clave de negocio (por día UTC) para evitar que se inserte el mismo pago
      // aunque haya diferencias de hora/minuto o el índice único no esté creado en Atlas.
      const fechaKey = formatDateOnlyUTC(fechaPago);
      const montoKey = Number(monto).toString();
      const subIdStr = String(subId);
      const bizKey = `${dni}|${entidadId}|${subIdStr}|${fechaKey}|${montoKey}`;

      if (seenInFile.has(bizKey)) {
        errores.push({
          fila: r,
          dni,
          entidadId,
          subCesion: subNombre,
          concepto: conceptoCodigo,
          fechaPago: formatFechaInput(unwrap(raw.FECHA_PAGO)),
          monto: unwrap(raw.MONTO) ?? "",
          operador: operadorUsername,
          motivo:
            "Duplicado dentro del archivo (dni + entidadId + subCesion + fechaPago + monto)",
        });
        continue;
      }
      seenInFile.add(bizKey);

      // Rango UTC del día para poder detectar duplicados aunque la fecha guardada tenga hora distinta
      const yUtc = fechaPago.getUTCFullYear();
      const mUtc = fechaPago.getUTCMonth();
      const dUtc = fechaPago.getUTCDate();
      const fechaPagoStartUTC = new Date(Date.UTC(yUtc, mUtc, dUtc, 0, 0, 0, 0));
      const fechaPagoEndUTC = new Date(Date.UTC(yUtc, mUtc, dUtc + 1, 0, 0, 0, 0));

      // Operación + metadatos de la fila (para reporte de writeErrors)
      ops.push({
        insertOne: {
          document: {
            dni,
            titularNombre,
            entidadId,
            subCesionId: subId,
            conceptoCodigo,
            fechaPago,
            monto,
            operadorUsername,
            operadorId: null,
            cuentaDestino,
            nroRemesa: "",
            estado: "INGRESADO",
            observaciones,
            creadoPor: userId || undefined,
            modificadoPor: userId || undefined,
          },
        },
      });
      metas.push({
        fila: r,
        dni,
        entidadId,
        subCesion: subNombre, // nombre legible
        subCesionId: subId,
        concepto: conceptoCodigo,
        fechaPago: formatFechaInput(unwrap(raw.FECHA_PAGO)),
        monto: unwrap(raw.MONTO) ?? "",
        montoNum: Number(monto),
        operador: operadorUsername,
        bizKey,
        fechaPagoStartUTC,
        fechaPagoEndUTC,
      });
    }

    // Inserción masiva en CHUNKS para evitar bloqueos/timeout
    const CHUNK = 1000;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const opPart = ops.slice(i, i + CHUNK);
      const metaPart = metas.slice(i, i + CHUNK);
      if (!opPart.length) continue;

      // ✅ FIX DUPLICADOS (DB): evitamos insertar si ya existe un pago con la misma
      // clave de negocio (dni + entidadId + subCesionId + fechaPago (día UTC) + monto),
      // incluso si la fecha existente tiene hora distinta o el índice único no está creado.
      let opToWrite = opPart;
      let metaToWrite = metaPart;

      if (metaPart.length) {
        const existingKeys = new Set();

        const orAll = metaPart.map((m) => ({
          dni: m.dni,
          entidadId: m.entidadId,
          subCesionId: m.subCesionId,
          monto: m.montoNum,
          fechaPago: { $gte: m.fechaPagoStartUTC, $lt: m.fechaPagoEndUTC },
        }));

        const STEP = 250;
        for (let j = 0; j < orAll.length; j += STEP) {
          const slice = orAll.slice(j, j + STEP);
          const exist = await Pago.find(
            { $or: slice },
            { dni: 1, entidadId: 1, subCesionId: 1, fechaPago: 1, monto: 1 }
          ).lean();

          for (const p of exist) {
            const k = `${p.dni}|${p.entidadId}|${String(p.subCesionId)}|${formatDateOnlyUTC(
              p.fechaPago
            )}|${Number(p.monto).toString()}`;
            existingKeys.add(k);
          }
        }

        if (existingKeys.size) {
          const newOps = [];
          const newMetas = [];
          for (let j = 0; j < metaPart.length; j++) {
            const m = metaPart[j];
            if (existingKeys.has(m.bizKey)) {
              errores.push({
                fila: m.fila,
                dni: m.dni,
                entidadId: m.entidadId,
                subCesion: m.subCesion,
                concepto: m.concepto,
                fechaPago: m.fechaPago,
                monto: m.monto,
                operador: m.operador,
                motivo:
                  "Duplicado: ya existe en el sistema (dni + entidadId + subCesion + fechaPago + monto)",
              });
            } else {
              newOps.push(opPart[j]);
              newMetas.push(m);
            }
          }
          opToWrite = newOps;
          metaToWrite = newMetas;
        }
      }

      if (!opToWrite.length) continue;

      try {
        const resp = await Pago.bulkWrite(opToWrite, { ordered: false });
        insertados += resp?.insertedCount || 0;
      } catch (e) {
        const writeErrors = e?.writeErrors || [];
        writeErrors.forEach((we) => {
          const idx = typeof we.index === "number" ? we.index : null;
          const meta = idx != null ? metaToWrite[idx] : null;
          errores.push({
            fila: meta?.fila ?? "?",
            dni: meta?.dni ?? "",
            entidadId: meta?.entidadId ?? "",
            subCesion: meta?.subCesion ?? "",
            concepto: meta?.concepto ?? "",
            fechaPago: meta?.fechaPago ?? "",
            monto: meta?.monto ?? "",
            operador: meta?.operador ?? "",
            motivo: msgMongo(we),
          });
        });
        if (e.result?.result?.nInserted)
          insertados += e.result.result.nInserted;
      }
    }

    // Cerrar job OK
    if (usarJobs && job?._id) {
      await JobProceso.findByIdAndUpdate(job._id, {
        estado: "OK",
        finalizadoEn: new Date(),
        progreso: 100,
      });
    }

    // Si hay errores → Excel con fila correcta
    if (errores.length) {
      const cols = [
        { header: "Fila (input)", key: "fila", width: 12 },
        { header: "DNI", key: "dni", width: 14 },
        { header: "EntidadId", key: "entidadId", width: 12 },
        { header: "SubCesión (nombre)", key: "subCesion", width: 24 },
        { header: "Concepto", key: "concepto", width: 12 },
        { header: "FechaPago (input)", key: "fechaPago", width: 20 },
        { header: "Monto (input)", key: "monto", width: 16 },
        { header: "Operador (username)", key: "operador", width: 20 },
        { header: "Motivo", key: "motivo", width: 60 },
      ];
      return enviarExcelErrores(res, "Errores_ImportPagos", cols, errores);
    }

    // Sin errores
    return res.json({
      ok: true,
      totalLeidas,
      insertados,
      errores: [],
      msg: "Importado correctamente",
    });
  } catch (error) {
    console.error("Error en importPagos:", error);
    try {
      if (usarJobs && job?._id) {
        await JobProceso.findByIdAndUpdate(job._id, {
          estado: "ERROR",
          finalizadoEn: new Date(),
          detalleError: error.message,
        });
      }
    } catch {}
    return res.status(500).json({
      ok: false,
      msg: "Error al importar pagos",
      error: error.message,
    });
  }
};

/* ──────────────────────────────────────────────────────────────
   POST /api/pagos/estados/import  → Cambia solo 'estado'
   Columnas: ID_PAGO, NUEVO_ESTADO
   ────────────────────────────────────────────────────────────── */
export const importCambiosEstado = async (req, res) => {
  if (!req.file?.buffer)
    return res
      .status(400)
      .json({ ok: false, msg: "Subí un archivo en 'file'." });

  const userId = await getUserIdSeguro(req);
  const usarJobs = !!userId;

  if (usarJobs) {
    const activo = await JobProceso.findOne({
      tipo: "IMPORT_ESTADOS",
      estado: "EN_PROCESO",
    });
    if (activo)
      return res
        .status(409)
        .json({ ok: false, msg: "Ya hay un proceso en curso." });
  }

  let job = null;
  if (usarJobs) {
    job = await JobProceso.create({
      tipo: "IMPORT_ESTADOS",
      estado: "EN_PROCESO",
      iniciadoPor: userId,
    });
  }

  const errores = [];
  let totalLeidas = 0;
  let actualizados = 0;

  try {
    const ws = await cargarWorksheetDesdeBuffer(req.file);
    const headers = {};
    ws.getRow(1).eachCell((cell, col) => {
      headers[(cell?.value || "").toString().trim().toUpperCase()] = col;
    });
    const REQ = ["ID_PAGO", "NUEVO_ESTADO"];
    const faltan = REQ.filter((h) => !headers[h]);
    if (faltan.length) throw new Error(`Faltan columnas: ${faltan.join(", ")}`);

    // 1) Parse preliminar
    const prelim = [];
    totalLeidas = ws.lastRow?.number ? ws.lastRow.number - 1 : 0;

    for (let r = 2; r <= (ws.lastRow?.number || 1); r++) {
      const row = ws.getRow(r);
      const idPagoStr = String(
        row.getCell(headers["ID_PAGO"]).value || ""
      ).trim();
      const idPagoNum = /^\d+$/.test(idPagoStr) ? Number(idPagoStr) : NaN;
      const nuevoEstado = String(
        row.getCell(headers["NUEVO_ESTADO"]).value || ""
      )
        .trim()
        .toUpperCase();

      const errs = [];
      if (!idPagoStr) errs.push("ID_PAGO vacío");
      if (!Number.isFinite(idPagoNum)) errs.push("ID_PAGO debe ser numérico");
      if (!PAGO_ESTADOS.includes(nuevoEstado))
        errs.push("NUEVO_ESTADO inválido");

      if (errs.length) {
        errores.push({
          fila: r,
          idPago: idPagoStr,
          nuevoEstado,
          motivo: errs.join(" | "),
        });
        continue;
      }
      prelim.push({ fila: r, idPago: idPagoNum, nuevoEstado });
    }

    // 2) Traer estado actual para saber si existe / sin cambios
    const ids = Array.from(new Set(prelim.map((x) => x.idPago)));
    const actuales = await Pago.find(
      { idPago: { $in: ids } },
      { idPago: 1, estado: 1 }
    ).lean();
    const mapActual = new Map(actuales.map((p) => [p.idPago, p.estado]));

    const ops = [];
    const metas = [];

    for (const it of prelim) {
      const estadoActual = mapActual.get(it.idPago);
      if (estadoActual === undefined) {
        errores.push({
          fila: it.fila,
          idPago: it.idPago,
          nuevoEstado: it.nuevoEstado,
          motivo: "ID_PAGO no existe",
        });
        continue;
      }
      if (estadoActual === it.nuevoEstado) {
        errores.push({
          fila: it.fila,
          idPago: it.idPago,
          nuevoEstado: it.nuevoEstado,
          motivo: `Sin cambios (ya estaba ${estadoActual})`,
        });
        continue;
      }
      ops.push({
        updateOne: {
          filter: { idPago: it.idPago },
          update: {
            $set: {
              estado: it.nuevoEstado,
              modificadoPor: userId || undefined,
            },
          },
        },
      });
      metas.push({
        fila: it.fila,
        idPago: it.idPago,
        nuevoEstado: it.nuevoEstado,
      });
    }

    if (ops.length) {
      try {
        const resp = await Pago.bulkWrite(ops, { ordered: false });
        actualizados = resp?.modifiedCount || 0;
      } catch (e) {
        // Errores de Mongo al actualizar (poco probable aquí, pero lo reportamos por fila)
        const writeErrors = e?.writeErrors || [];
        writeErrors.forEach((we) => {
          const idx = typeof we.index === "number" ? we.index : null;
          const meta = idx != null ? metas[idx] : null;
          errores.push({
            fila: meta?.fila ?? "?",
            idPago: meta?.idPago ?? "",
            nuevoEstado: meta?.nuevoEstado ?? "",
            motivo: we?.errmsg || we?.message || "Error de actualización",
          });
        });
      }
    }

    if (usarJobs && job?._id) {
      await JobProceso.findByIdAndUpdate(job._id, {
        estado: "OK",
        finalizadoEn: new Date(),
        progreso: 100,
      });
    }

    if (errores.length) {
      const cols = [
        { header: "Fila", key: "fila", width: 8 },
        { header: "ID_PAGO", key: "idPago", width: 14 },
        { header: "NUEVO_ESTADO", key: "nuevoEstado", width: 18 },
        { header: "Motivo", key: "motivo", width: 60 },
      ];
      return enviarExcelErrores(
        res,
        "Errores_ImportCambiosEstado",
        cols,
        errores
      );
    }

    return res.json({
      ok: true,
      totalLeidas,
      actualizados,
      errores: [],
      msg: "Cambios aplicados",
    });
  } catch (error) {
    console.error("Error en importCambiosEstado:", error);
    try {
      if (usarJobs && job?._id) {
        await JobProceso.findByIdAndUpdate(job._id, {
          estado: "ERROR",
          finalizadoEn: new Date(),
          detalleError: error.message,
        });
      }
    } catch {}
    return res.status(500).json({
      ok: false,
      msg: "Error en import de estados",
      error: error.message,
    });
  }
};

/* ──────────────────────────────────────────────────────────────
   POST /api/pagos/remesas/import  → Asigna nroRemesa
   Columnas: ID_PAGO, NRO_REMESA (alfanumérico)
   ────────────────────────────────────────────────────────────── */
export const importRemesas = async (req, res) => {
  if (!req.file?.buffer)
    return res
      .status(400)
      .json({ ok: false, msg: "Subí un archivo en 'file'." });

  const userId = await getUserIdSeguro(req);
  const usarJobs = !!userId;

  if (usarJobs) {
    const activo = await JobProceso.findOne({
      tipo: "IMPORT_REMESAS",
      estado: "EN_PROCESO",
    });
    if (activo)
      return res
        .status(409)
        .json({ ok: false, msg: "Ya hay un proceso en curso." });
  }

  let job = null;
  if (usarJobs) {
    job = await JobProceso.create({
      tipo: "IMPORT_REMESAS",
      estado: "EN_PROCESO",
      iniciadoPor: userId,
    });
  }

  const errores = [];
  let totalLeidas = 0;
  let actualizados = 0;

  try {
    const ws = await cargarWorksheetDesdeBuffer(req.file);
    const headers = {};
    ws.getRow(1).eachCell((cell, col) => {
      headers[(cell?.value || "").toString().trim().toUpperCase()] = col;
    });
    const REQ = ["ID_PAGO", "NRO_REMESA"];
    const faltan = REQ.filter((h) => !headers[h]);
    if (faltan.length) throw new Error(`Faltan columnas: ${faltan.join(", ")}`);

    // 1) Parse preliminar
    const prelim = [];
    totalLeidas = ws.lastRow?.number ? ws.lastRow.number - 1 : 0;

    for (let r = 2; r <= (ws.lastRow?.number || 1); r++) {
      const row = ws.getRow(r);

      const idPagoStr = String(
        row.getCell(headers["ID_PAGO"]).value || ""
      ).trim();
      const idPagoNum = /^\d+$/.test(idPagoStr) ? Number(idPagoStr) : NaN;
      const nroRemesa = String(
        row.getCell(headers["NRO_REMESA"]).value || ""
      ).trim();

      const errs = [];
      if (!idPagoStr) errs.push("ID_PAGO vacío");
      if (!Number.isFinite(idPagoNum)) errs.push("ID_PAGO debe ser numérico");
      if (!nroRemesa) errs.push("NRO_REMESA vacío");
      if (nroRemesa && !/^[A-Za-z0-9._-]+$/.test(nroRemesa))
        errs.push("NRO_REMESA inválido (solo letras/números . _ -)");

      if (errs.length) {
        errores.push({
          fila: r,
          idPago: idPagoStr,
          nroRemesa,
          motivo: errs.join(" | "),
        });
        continue;
      }

      prelim.push({ fila: r, idPago: idPagoNum, nroRemesa });
    }

    // 2) Traer nroRemesa actual para saber si existe / sin cambios
    const ids = Array.from(new Set(prelim.map((x) => x.idPago)));
    const actuales = await Pago.find(
      { idPago: { $in: ids } },
      { idPago: 1, nroRemesa: 1 }
    ).lean();
    const mapActual = new Map(
      actuales.map((p) => [p.idPago, p.nroRemesa || ""])
    );

    const ops = [];
    const metas = [];

    for (const it of prelim) {
      const remesaActual = mapActual.get(it.idPago);
      if (remesaActual === undefined) {
        errores.push({
          fila: it.fila,
          idPago: it.idPago,
          nroRemesa: it.nroRemesa,
          motivo: "ID_PAGO no existe",
        });
        continue;
      }
      if ((remesaActual || "") === it.nroRemesa) {
        errores.push({
          fila: it.fila,
          idPago: it.idPago,
          nroRemesa: it.nroRemesa,
          motivo: "Sin cambios (ya tenía ese NRO_REMESA)",
        });
        continue;
      }

      ops.push({
        updateOne: {
          filter: { idPago: it.idPago },
          update: {
            $set: {
              nroRemesa: it.nroRemesa,
              modificadoPor: userId || undefined,
            },
          },
        },
      });
      metas.push({ fila: it.fila, idPago: it.idPago, nroRemesa: it.nroRemesa });
    }

    if (ops.length) {
      try {
        const resp = await Pago.bulkWrite(ops, { ordered: false });
        actualizados = resp?.modifiedCount || 0;
      } catch (e) {
        const writeErrors = e?.writeErrors || [];
        writeErrors.forEach((we) => {
          const idx = typeof we.index === "number" ? we.index : null;
          const meta = idx != null ? metas[idx] : null;
          errores.push({
            fila: meta?.fila ?? "?",
            idPago: meta?.idPago ?? "",
            nroRemesa: meta?.nroRemesa ?? "",
            motivo: we?.errmsg || we?.message || "Error de actualización",
          });
        });
      }
    }

    if (usarJobs && job?._id) {
      await JobProceso.findByIdAndUpdate(job._id, {
        estado: "OK",
        finalizadoEn: new Date(),
        progreso: 100,
      });
    }

    if (errores.length) {
      const cols = [
        { header: "Fila", key: "fila", width: 8 },
        { header: "ID_PAGO", key: "idPago", width: 14 },
        { header: "NRO_REMESA (input)", key: "nroRemesa", width: 22 },
        { header: "Motivo", key: "motivo", width: 60 },
      ];
      return enviarExcelErrores(res, "Errores_ImportRemesas", cols, errores);
    }

    return res.json({
      ok: true,
      totalLeidas,
      actualizados,
      errores: [],
      msg: "Remesas aplicadas",
    });
  } catch (error) {
    console.error("Error en importRemesas:", error);
    try {
      if (usarJobs && job?._id) {
        await JobProceso.findByIdAndUpdate(job._id, {
          estado: "ERROR",
          finalizadoEn: new Date(),
          detalleError: error.message,
        });
      }
    } catch {}
    return res.status(500).json({
      ok: false,
      msg: "Error en import de remesas",
      error: error.message,
    });
  }
};

/* ──────────────────────────────────────────────────────────────
   PATCH /api/pagos/:id  → edición sin tocar estado/clave única
   (ahora :id es el ID_PAGO numérico)
   ────────────────────────────────────────────────────────────── */
export const updatePago = async (req, res) => {
  const userId = await getUserIdSeguro(req);
  try {
    const { id } = req.params;

    // validar que el parámetro es ID_PAGO numérico
    const idStr = String(id).trim();
    if (!/^\d+$/.test(idStr)) {
      return res
        .status(400)
        .json({ ok: false, msg: "ID_PAGO inválido (debe ser numérico)" });
    }
    const idPago = Number(idStr);

    // solo campos editables (no tocamos estado ni la clave de negocio ni el ID)
    const camposEditables = { ...req.body };
    delete camposEditables.estado;
    delete camposEditables.dni;
    delete camposEditables.entidadId;
    delete camposEditables.subCesionId;
    delete camposEditables.fechaPago;
    delete camposEditables.monto;
    delete camposEditables.idPago; // evitar cambio de ID corto
    delete camposEditables._id; // evitar cambio de ObjectId
    delete camposEditables.creadoPor;
    delete camposEditables.modificadoPor;

    const pago = await Pago.findOneAndUpdate(
      { idPago }, // ← ahora buscamos por ID corto numérico
      { $set: { ...camposEditables, modificadoPor: userId || undefined } },
      { new: true }
    );

    if (!pago)
      return res.status(404).json({ ok: false, msg: "Pago no encontrado" });

    res.json({ ok: true, pago });
  } catch (error) {
    console.error("Error en updatePago:", error);
    res.status(500).json({ ok: false, msg: "Error en updatePago" });
  }
};

/* ──────────────────────────────────────────────────────────────
   DELETE /api/pagos/:id  → eliminación definitiva
   (ahora :id es el ID_PAGO numérico)
   ────────────────────────────────────────────────────────────── */
export const deletePago = async (req, res) => {
  try {
    const { id } = req.params;

    // validar ID_PAGO numérico
    const idStr = String(id).trim();
    if (!/^\d+$/.test(idStr)) {
      return res
        .status(400)
        .json({ ok: false, msg: "ID_PAGO inválido (debe ser numérico)" });
    }
    const idPago = Number(idStr);

    // eliminar por idPago (corto)
    const pago = await Pago.findOneAndDelete({ idPago });
    if (!pago)
      return res.status(404).json({ ok: false, msg: "Pago no encontrado" });

    res.json({ ok: true, msg: "Pago eliminado" });
  } catch (error) {
    console.error("Error en deletePago:", error);
    res.status(500).json({ ok: false, msg: "Error en deletePago" });
  }
};

/* ──────────────────────────────────────────────────────────────
   GET /api/pagos/kpi/hoy-vs-mes-anterior
   (Cuenta TODOS los pagos, sin filtrar por estado)
   ✅ Ahora soporta operador + filtros básicos (sin romper el comportamiento)
   ────────────────────────────────────────────────────────────── */
export const kpiHoyVsMesAnterior = async (req, res) => {
  try {
    const {
      entidadId,
      subCesionId,
      dni,
      concepto,
      cuentaDestino,
      nroRemesa,
      operador, // ✅
    } = req.query;

    const hoyClave = fechaClaveArgentina();
    const hoy = inicioDiaCalendarioUTC(hoyClave);
    const mañana = siguienteDiaCalendarioUTC(hoyClave);

    const base = {};
    if (dni) base.dni = dni;
    if (entidadId) base.entidadId = Number(entidadId);
    if (subCesionId) base.subCesionId = subCesionId;
    if (concepto) base.conceptoCodigo = String(concepto).toUpperCase();
    if (cuentaDestino)
      base.cuentaDestino = { $regex: cuentaDestino, $options: "i" };
    if (nroRemesa) base.nroRemesa = nroRemesa;

    applyOperadorMatch(base, operador);

    const totalHoy = await Pago.aggregate([
      { $match: { ...base, fechaPago: { $gte: hoy, $lt: mañana } } },
      { $group: { _id: null, total: { $sum: "$monto" } } },
    ]);

    const [hy, hm, hd] = hoyClave.split("-").map(Number);
    const prevMonthLastDay = new Date(Date.UTC(hy, hm - 1, 0)).getUTCDate();
    const refDay = Math.min(hd, prevMonthLastDay);
    const ref = new Date(Date.UTC(hy, hm - 2, refDay));
    const refEnd = siguienteDiaCalendarioUTC(ref);

    const totalRef = await Pago.aggregate([
      { $match: { ...base, fechaPago: { $gte: ref, $lt: refEnd } } },
      { $group: { _id: null, total: { $sum: "$monto" } } },
    ]);

    res.json({
      ok: true,
      hoy: totalHoy[0]?.total || 0,
      refMesAnterior: totalRef[0]?.total || 0,
      delta: (totalHoy[0]?.total || 0) - (totalRef[0]?.total || 0),
    });
  } catch (error) {
    console.error("Error en KPI:", error);
    res.status(500).json({ ok: false, msg: "Error en KPI" });
  }
};

/* ──────────────────────────────────────────────────────────────
   GET /api/pagos/:id  → obtener un pago por ID_PAGO (numérico)
   ────────────────────────────────────────────────────────────── */
export const getPagoByIdPago = async (req, res) => {
  try {
    const { id } = req.params;

    // validar ID_PAGO numérico
    const idStr = String(id).trim();
    if (!/^\d+$/.test(idStr)) {
      return res
        .status(400)
        .json({ ok: false, msg: "ID_PAGO inválido (debe ser numérico)" });
    }
    const idPago = Number(idStr);

    const pago = await Pago.findOne({ idPago })
      .populate("subCesionId", "nombre")
      .populate("operadorId", "username nombre")
      .populate("creadoPor", "username nombre")
      .populate("modificadoPor", "username nombre");

    if (!pago) {
      return res.status(404).json({ ok: false, msg: "Pago no encontrado" });
    }

    return res.json({ ok: true, pago });
  } catch (error) {
    console.error("Error en getPagoByIdPago:", error);
    return res
      .status(500)
      .json({ ok: false, msg: "Error al obtener el pago por ID_PAGO" });
  }
};

// KPI: Month-To-Date vs Previous-Month-To-Date (respetando filtros y anclado a fechaHasta)
export const kpiMtdVsPrev = async (req, res) => {
  try {
    const {
      fechaHasta, // "YYYY-MM-DD" (opcional). Si no viene, anclo en hoy (timezone local del server)
      entidadId,
      subCesionId,
      estado,
      concepto,
      dni,
      cuentaDestino,
      nroRemesa,
      operador, // ✅
    } = req.query;

    // 1) Anchor: día calendario de Buenos Aires si no llega fechaHasta.
    const anchorKey = claveFechaCalendario(fechaHasta) || fechaClaveArgentina();
    const anchor = inicioDiaCalendarioUTC(anchorKey);

    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth();
    const d = anchor.getUTCDate();

    const py = m === 0 ? y - 1 : y;
    const pm = (m + 11) % 12;

    const prevDays = new Date(Date.UTC(py, pm + 1, 0)).getUTCDate();
    const pCut = Math.min(d, prevDays);

    const curStart = new Date(Date.UTC(y, m, 1));
    const curEndExcl = siguienteDiaCalendarioUTC(new Date(Date.UTC(y, m, d)));

    const prevStart = new Date(Date.UTC(py, pm, 1));
    const prevEndExcl = siguienteDiaCalendarioUTC(new Date(Date.UTC(py, pm, pCut)));

    // 2) Filtros base
    const base = {};
    if (dni) base.dni = dni;
    if (entidadId) base.entidadId = Number(entidadId);
    if (subCesionId) base.subCesionId = subCesionId;
    if (estado) base.estado = String(estado).toUpperCase();
    if (concepto) base.conceptoCodigo = String(concepto).toUpperCase();
    if (cuentaDestino)
      base.cuentaDestino = { $regex: cuentaDestino, $options: "i" };
    if (nroRemesa) base.nroRemesa = nroRemesa;

    applyOperadorMatch(base, operador);

    const matchNow = {
      ...base,
      fechaPago: { $gte: curStart, $lt: curEndExcl },
    };
    const matchPrev = {
      ...base,
      fechaPago: { $gte: prevStart, $lt: prevEndExcl },
    };

    const agg = async (match) => {
      const r = await Pago.aggregate([
        { $match: match },
        { $group: { _id: null, count: { $sum: 1 }, sum: { $sum: "$monto" } } },
      ]);
      return { count: r[0]?.count || 0, sum: r[0]?.sum || 0 };
    };

    const now = await agg(matchNow);
    const prev = await agg(matchPrev);

    const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : a > 0 ? 100 : 0);
    const signed = (n) =>
      n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";

    res.json({
      ok: true,
      anchor: anchor.toISOString(),
      lastKey: `${y}-${String(m + 1).padStart(2, "0")} (1–${d})`,
      prevKey: `${py}-${String(pm + 1).padStart(2, "0")} (1–${pCut})`,
      now,
      prev,
      deltas: {
        c: pct(now.count, prev.count),
        s: pct(now.sum, prev.sum),
        cAbs: signed(now.count - prev.count),
        sAbs: now.sum - prev.sum,
      },
    });
  } catch (e) {
    console.error("Error en kpiMtdVsPrev:", e);
    res.status(500).json({ ok: false, msg: "Error en KPI MTD vs anterior" });
  }
};

// KPI: Ventana (fechaDesde–fechaHasta) vs la misma ventana del mes anterior
export const kpiWindowVsPrev = async (req, res) => {
  try {
    const {
      fechaDesde, // "YYYY-MM-DD" (obligatorio para esta métrica)
      fechaHasta, // "YYYY-MM-DD" (obligatorio)
      entidadId,
      subCesionId,
      estado,
      concepto,
      dni,
      cuentaDestino,
      nroRemesa,
      operador, // ✅
    } = req.query;

    const ini = parseLocalYMD(fechaDesde);
    const fin = parseLocalYMD(fechaHasta);
    if (!ini || !fin) {
      return res.status(400).json({
        ok: false,
        msg: "fechaDesde y fechaHasta son requeridas (YYYY-MM-DD)",
      });
    }

    // Normalizamos orden y armamos "end exclusive"
    const a = ini <= fin ? ini : fin;
    const bInclusive = ini <= fin ? fin : ini;
    const b = nextDay(bInclusive); // $lt

    // Misma ventana del mes anterior (cuidando fin de mes)
    const y = a.getUTCFullYear(),
      m = a.getUTCMonth(),
      d = a.getUTCDate();
    const y2 = bInclusive.getUTCFullYear(),
      m2 = bInclusive.getUTCMonth(),
      d2 = bInclusive.getUTCDate();

    const prevY1 = m === 0 ? y - 1 : y;
    const prevM1 = (m + 11) % 12;
    const prevY2 = m2 === 0 ? y2 - 1 : y2;
    const prevM2 = (m2 + 11) % 12;

    // clamp del día si el mes anterior no tiene ese día
    const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
    const pd1 = Math.min(d, lastDay(prevY1, prevM1));
    const pd2 = Math.min(d2, lastDay(prevY2, prevM2));

    const prevStart = new Date(Date.UTC(prevY1, prevM1, pd1));
    const prevEndExcl = siguienteDiaCalendarioUTC(new Date(Date.UTC(prevY2, prevM2, pd2)));

    // Filtros comunes (igual que en kpiMtdVsPrev)
    const base = {};
    if (dni) base.dni = dni;
    if (entidadId) base.entidadId = Number(entidadId);
    if (subCesionId) base.subCesionId = subCesionId;
    if (estado) base.estado = String(estado).toUpperCase();
    if (concepto) base.conceptoCodigo = String(concepto).toUpperCase();
    if (cuentaDestino)
      base.cuentaDestino = { $regex: cuentaDestino, $options: "i" };
    if (nroRemesa) base.nroRemesa = nroRemesa;

    applyOperadorMatch(base, operador);

    const matchNow = { ...base, fechaPago: { $gte: a, $lt: b } };
    const matchPrev = { ...base, fechaPago: { $gte: prevStart, $lt: prevEndExcl } };

    const agg = async (match) => {
      const r = await Pago.aggregate([
        { $match: match },
        { $group: { _id: null, count: { $sum: 1 }, sum: { $sum: "$monto" } } },
      ]);
      return { count: r[0]?.count || 0, sum: r[0]?.sum || 0 };
    };

    const now = await agg(matchNow);
    const prev = await agg(matchPrev);

    const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : a > 0 ? 100 : 0);
    const signed = (n) =>
      n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";
    const pad2 = (n) => String(n).padStart(2, "0");

    const ymd = (dt) =>
      `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
    const lastKey = `${ymd(a)} → ${ymd(new Date(b.getTime() - 1))}`;
    const prevKey = `${ymd(prevStart)} → ${ymd(new Date(prevEndExcl.getTime() - 1))}`;

    res.json({
      ok: true,
      lastKey,
      prevKey,
      now,
      prev,
      deltas: {
        c: pct(now.count, prev.count),
        s: pct(now.sum, prev.sum),
        cAbs: signed(now.count - prev.count),
        sAbs: now.sum - prev.sum,
      },
    });
  } catch (e) {
    console.error("Error en kpiWindowVsPrev:", e);
    res.status(500).json({ ok: false, msg: "Error en KPI Ventana vs anterior" });
  }
};

/* ──────────────────────────────────────────────────────────────
   ✅ NUEVO: GET /api/pagos/analytics/resumen
   Resumen "para supervisión" (ideal para la solapa nueva/extra)
   ────────────────────────────────────────────────────────────── */
export const analyticsResumen = async (req, res) => {
  try {
    const {
      fechaDesde,
      fechaHasta,
      entidadId,
      subCesionId,
      estado,
      concepto,
      dni,
      cuentaDestino,
      nroRemesa,
      operador,
      pendientesDias = 7, // default
    } = req.query;

    const ini = parseLocalYMD(fechaDesde);
    const fin = parseLocalYMD(fechaHasta);
    if (!ini || !fin) {
      return res.status(400).json({
        ok: false,
        msg: "fechaDesde y fechaHasta son requeridas (YYYY-MM-DD)",
      });
    }
    const a = ini <= fin ? ini : fin;
    const bInclusive = ini <= fin ? fin : ini;
    const bExcl = nextDay(bInclusive);

    const match = {};
    match.fechaPago = { $gte: a, $lt: bExcl };

    if (dni) match.dni = dni;
    if (entidadId) match.entidadId = Number(entidadId);
    if (subCesionId) match.subCesionId = subCesionId;
    if (estado) match.estado = String(estado).toUpperCase();
    if (concepto) match.conceptoCodigo = String(concepto).toUpperCase();
    if (cuentaDestino)
      match.cuentaDestino = { $regex: cuentaDestino, $options: "i" };
    if (nroRemesa) match.nroRemesa = nroRemesa;

    applyOperadorMatch(match, operador);

    const diasHabiles = countBusinessDaysInclusiveCalendar(a, bInclusive);

    const cutoffDays = Number(pendientesDias);
    const safeCutoff = Number.isFinite(cutoffDays) && cutoffDays > 0 ? cutoffDays : 7;
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - safeCutoff * 24 * 60 * 60 * 1000);

    const faceted = await Pago.aggregate([
      { $match: match },
      {
        $facet: {
          totales: [
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                sum: { $sum: "$monto" },
              },
            },
          ],
          porEstado: [
            {
              $group: {
                _id: "$estado",
                count: { $sum: 1 },
                sum: { $sum: "$monto" },
              },
            },
            { $sort: { sum: -1 } },
          ],
          porConcepto: [
            {
              $group: {
                _id: "$conceptoCodigo",
                count: { $sum: 1 },
                sum: { $sum: "$monto" },
              },
            },
            { $sort: { sum: -1 } },
          ],
          topEntidadSub: [
            {
              $group: {
                _id: { entidadId: "$entidadId", subCesionId: "$subCesionId" },
                count: { $sum: 1 },
                sum: { $sum: "$monto" },
              },
            },
            { $sort: { sum: -1 } },
            { $limit: 5 },
          ],
          serieDiaria: [
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m-%d", date: "$fechaPago", timezone: "UTC" },
                },
                count: { $sum: 1 },
                sum: { $sum: "$monto" },
              },
            },
            { $sort: { _id: 1 } },
          ],
          diasActivos: [
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m-%d", date: "$fechaPago", timezone: "UTC" },
                },
              },
            },
            { $count: "dias" },
          ],
          demora: [
            {
              $project: {
                delayDays: {
                  $divide: [{ $subtract: ["$createdAt", "$fechaPago"] }, 86400000],
                },
              },
            },
            {
              $group: {
                _id: null,
                avgDelay: { $avg: "$delayDays" },
                enDia: {
                  $sum: {
                    $cond: [{ $lte: ["$delayDays", 1] }, 1, 0],
                  },
                },
                tarde: {
                  $sum: {
                    $cond: [{ $gt: ["$delayDays", 1] }, 1, 0],
                  },
                },
              },
            },
          ],
          pendientesCriticos: [
            { $match: { estado: "INGRESADO", createdAt: { $lte: cutoffDate } } },
            { $count: "count" },
          ],
          sinRemesa: [
            {
              $match: {
                $or: [
                  { nroRemesa: "" },
                  { nroRemesa: null },
                  { nroRemesa: { $exists: false } },
                ],
              },
            },
            { $count: "count" },
          ],
          sinCuenta: [
            {
              $match: {
                $or: [
                  { cuentaDestino: "" },
                  { cuentaDestino: null },
                  { cuentaDestino: { $exists: false } },
                ],
              },
            },
            { $count: "count" },
          ],
          remesaBuckets: [
            {
              $group: {
                _id: {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$nroRemesa", ""] },
                        { $ne: ["$nroRemesa", null] },
                      ],
                    },
                    "CON_REMESA",
                    "SIN_REMESA",
                  ],
                },
                count: { $sum: 1 },
                sum: { $sum: "$monto" },
              },
            },
          ],
        },
      },
    ]);

    const f = faceted?.[0] || {};
    const tot = f.totales?.[0] || { count: 0, sum: 0 };
    const demora = f.demora?.[0] || { avgDelay: 0, enDia: 0, tarde: 0 };
    const diasActivos = f.diasActivos?.[0]?.dias || 0;

    const totalPagos = tot.count || 0;
    const totalMonto = tot.sum || 0;
    const ticketProm = totalPagos > 0 ? totalMonto / totalPagos : 0;

    const pct = (part, total) => (total > 0 ? (part / total) * 100 : 0);

    // tasa verificación: VERIFICADO+ vs total
    const porEstado = (f.porEstado || []).map((x) => ({
      estado: x._id,
      count: x.count || 0,
      sum: x.sum || 0,
    }));
    const verificadosCount = porEstado
      .filter((x) => ["VERIFICADO", "REMESADO", "FACTURADO"].includes(x.estado))
      .reduce((acc, x) => acc + x.count, 0);
    const tasaVerificacion = pct(verificadosCount, totalPagos);

    const remBuckets = { conRemesa: { count: 0, sum: 0 }, sinRemesa: { count: 0, sum: 0 } };
    for (const it of f.remesaBuckets || []) {
      if (it._id === "CON_REMESA") remBuckets.conRemesa = { count: it.count || 0, sum: it.sum || 0 };
      if (it._id === "SIN_REMESA") remBuckets.sinRemesa = { count: it.count || 0, sum: it.sum || 0 };
    }

    const promMontoDiaHabil = diasHabiles > 0 ? totalMonto / diasHabiles : 0;
    const promPagosDiaHabil = diasHabiles > 0 ? totalPagos / diasHabiles : 0;

    const pctDiasActivos = diasHabiles > 0 ? (diasActivos / diasHabiles) * 100 : 0;

    const pendientesCriticos = f.pendientesCriticos?.[0]?.count || 0;
    const sinRemesa = f.sinRemesa?.[0]?.count || 0;
    const sinCuenta = f.sinCuenta?.[0]?.count || 0;

    res.json({
      ok: true,
      range: {
        desde: fechaDesde,
        hasta: fechaHasta,
      },
      filtrosAplicados: {
        dni: dni || "",
        entidadId: entidadId ? Number(entidadId) : null,
        subCesionId: subCesionId || null,
        estado: estado ? String(estado).toUpperCase() : "",
        concepto: concepto ? String(concepto).toUpperCase() : "",
        cuentaDestino: cuentaDestino || "",
        nroRemesa: nroRemesa || "",
        operador: operador || "",
      },
      kpis: {
        totalPagos,
        totalMonto,
        ticketPromedio: ticketProm,

        diasHabiles,
        diasActivos,
        pctDiasActivos,

        montoPorDiaHabil: promMontoDiaHabil,
        pagosPorDiaHabil: promPagosDiaHabil,

        demoraPromedioDias: Number(demora.avgDelay || 0),
        pctEnDia: pct(Number(demora.enDia || 0), totalPagos),
        pctTarde: pct(Number(demora.tarde || 0), totalPagos),

        tasaVerificacion,

        pendientesCriticos,
        pendientesDiasUmbral: safeCutoff,

        pagosSinRemesa: sinRemesa,
        pagosSinCuenta: sinCuenta,
      },
      charts: {
        porEstado,
        porConcepto: (f.porConcepto || []).map((x) => ({
          concepto: x._id,
          conceptoTexto: CONCEPTOS_MAP[x._id] || x._id,
          count: x.count || 0,
          sum: x.sum || 0,
        })),
        topEntidadSub: (f.topEntidadSub || []).map((x) => ({
          entidadId: x._id?.entidadId ?? null,
          subCesionId: x._id?.subCesionId ?? null,
          count: x.count || 0,
          sum: x.sum || 0,
        })),
        serieDiaria: (f.serieDiaria || []).map((x) => ({
          fecha: x._id,
          count: x.count || 0,
          sum: x.sum || 0,
        })),
        remesas: remBuckets,
      },
    });
  } catch (e) {
    console.error("Error en analyticsResumen:", e);
    res.status(500).json({ ok: false, msg: "Error en analytics resumen" });
  }
};

/* ──────────────────────────────────────────────────────────────
   GET /api/pagos/kpi/ultimos-tres-meses
   → Devuelve montos totales por día hábil de los últimos 3 meses
   ✅ ahora soporta operador (y mantiene entidad/subcesion)
   ────────────────────────────────────────────────────────────── */
export const kpiUltimosTresMeses = async (req, res) => {
  try {
    const { entidadId, subCesionId, operador } = req.query;

    // ====== Helpers UTC (evita corrimientos por timezone) ======
    const monthLabelUTC = (y, m) =>
      new Date(Date.UTC(y, m, 1))
        .toLocaleString("es-AR", { month: "long", timeZone: "UTC" })
        .toUpperCase();

    // Índice de día hábil del mes en UTC. Si es sábado/domingo devuelve 0.
    const businessDayIndexUTC = (dUtc) => {
      const y = dUtc.getUTCFullYear();
      const m = dUtc.getUTCMonth();
      const day = dUtc.getUTCDate();
      let idx = 0;
      for (let i = 1; i <= day; i++) {
        const w = new Date(Date.UTC(y, m, i)).getUTCDay(); // 0 Dom .. 6 Sáb
        if (w !== 0 && w !== 6) idx++;
      }
      const wToday = dUtc.getUTCDay();
      return wToday === 0 || wToday === 6 ? 0 : idx; // 1..N si es hábil
    };

    // ====== Ventana de 3 meses en UTC ======
    const [yNow, mesAhora] = fechaClaveArgentina().split("-").map(Number);
    const mNow = mesAhora - 1;

    // ej si hoy es 10/10 -> [ago, sep, oct]
    const start = new Date(Date.UTC(yNow, mNow - 2, 1, 0, 0, 0, 0));
    const endExcl = new Date(Date.UTC(yNow, mNow + 1, 1, 0, 0, 0, 0));

    // Filtros para Mongo (sin fechas en query)
    const match = { fechaPago: { $gte: start, $lt: endExcl } };
    if (entidadId) match.entidadId = Number(entidadId);
    if (subCesionId) match.subCesionId = subCesionId;

    applyOperadorMatch(match, operador);

    // Traigo solo lo que necesito
    const pagos = await Pago.find(match, { fechaPago: 1, monto: 1 }).lean();

    // Etiquetas de los 3 meses (en el mismo orden)
    const months = [
      monthLabelUTC(start.getUTCFullYear(), start.getUTCMonth()),
      monthLabelUTC(start.getUTCFullYear(), start.getUTCMonth() + 1),
      monthLabelUTC(start.getUTCFullYear(), start.getUTCMonth() + 2),
    ];

    // Acumulo por "MES|díaHábil"
    const acc = new Map(); // `${MES}|${bh}` -> suma

    for (const p of pagos) {
      const f = new Date(p.fechaPago); // Mongo Date (UTC)
      if (!(f >= start && f < endExcl)) continue; // resguardo

      const w = f.getUTCDay();
      if (w === 0 || w === 6) continue; // fin de semana

      const mesLbl = monthLabelUTC(f.getUTCFullYear(), f.getUTCMonth());
      const bh = businessDayIndexUTC(f); // 1..N
      if (bh === 0) continue;

      const key = `${mesLbl}|${bh}`;
      acc.set(key, (acc.get(key) || 0) + (Number(p.monto) || 0));
    }

    // Máximo día hábil que apareció en cualquiera de los 3 meses
    let maxBH = 1;
    for (const k of acc.keys()) {
      const bh = Number(k.split("|")[1]);
      if (bh > maxBH) maxBH = bh;
    }

    // Armo filas 1..maxBH con las 3 columnas (meses)
    const rows = [];
    for (let bh = 1; bh <= maxBH; bh++) {
      const values = {};
      for (const m of months) {
        values[m] = acc.get(`${m}|${bh}`) || 0;
      }
      rows.push({ businessDay: bh, values });
    }

    return res.json({ ok: true, months, rows });
  } catch (error) {
    console.error("Error en kpiUltimosTresMeses:", error);
    res
      .status(500)
      .json({ ok: false, msg: "Error en KPI últimos tres meses" });
  }
};
