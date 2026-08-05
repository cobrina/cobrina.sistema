// BACKEND/utils/acuerdosPagoParser.js
import { toDateOnly, normalizarHora } from "./fecha.util.js";

const EXCEL_EPOCH_1899_12_30 = Date.UTC(1899, 11, 30);

function norm(str = "") {
  return String(str)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

/**
 * ✅ Parse monetario AR/mixto, SIN romper "91214.00" (punto decimal)
 * - "91.214,00" -> 91214
 * - "91214.00"  -> 91214
 * - "91.214"    -> 91214 (asume miles)
 * - "$ 50.000"  -> 50000
 */
function parseMoneyAR(value) {
  if (value == null) return null;
  let s = String(value).trim();
  if (!s) return null;

  // deja solo dígitos, coma, punto, signo
  s = s.replace(/[^\d.,-]/g, "");
  if (!s) return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    // típico AR: 1.234,56
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (hasComma && !hasDot) {
    // 1234,56
    s = s.replace(",", ".");
  } else if (hasDot && !hasComma) {
    // ✅ si el último punto tiene 1-2 decimales => punto decimal
    const lastDot = s.lastIndexOf(".");
    const dec = s.slice(lastDot + 1);
    if (/^\d{1,2}$/.test(dec)) {
      // decimal
    } else {
      // miles
      s = s.replace(/\./g, "");
    }
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseExcelSerialDateTime(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  const ms = EXCEL_EPOCH_1899_12_30 + n * 86400000;
  const d = new Date(ms);
  return isNaN(d) ? null : d;
}

function parseFechaHora(raw) {
  // Devuelve { fechaHora, fecha (día UTC), hora "HH:mm:ss", mes "YYYY-MM" }
  if (raw == null || raw === "") return null;

  // Date directo
  if (raw instanceof Date && !isNaN(raw)) {
    const yyyy = raw.getUTCFullYear();
    const mm = raw.getUTCMonth() + 1;
    const dd = raw.getUTCDate();
    const hh = raw.getUTCHours();
    const mi = raw.getUTCMinutes();
    const ss = raw.getUTCSeconds();

    const fechaHora = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss));
    const fecha = new Date(Date.UTC(yyyy, mm - 1, dd));
    const hora = `${String(hh).padStart(2, "0")}:${String(mi).padStart(
      2,
      "0"
    )}:${String(ss).padStart(2, "0")}`;
    const mes = `${yyyy}-${String(mm).padStart(2, "0")}`;
    return { fechaHora, fecha, hora, mes };
  }

  // Serial Excel (con o sin fracción horaria)
  const asNum = Number(raw);
  if (!Number.isNaN(asNum) && asNum > 25569 && asNum < 70000) {
    const d = parseExcelSerialDateTime(asNum);
    if (d) return parseFechaHora(d);
  }

  const s = String(raw).trim();

  // dd/mm/yyyy HH:mm(:ss)?
  let m = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = Number(m[3]);
    const hh = Number(m[4] ?? 0);
    const mi = Number(m[5] ?? 0);
    const ss = Number(m[6] ?? 0);
    const fechaHora = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss));
    const fecha = new Date(Date.UTC(yyyy, mm - 1, dd));
    const hora = normalizarHora(
      `${hh}:${String(mi).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    );
    const mes = `${yyyy}-${String(mm).padStart(2, "0")}`;
    return { fechaHora, fecha, hora, mes };
  }

  // yyyy-mm-dd HH:mm(:ss)?
  m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (m) {
    const yyyy = Number(m[1]);
    const mm = Number(m[2]);
    const dd = Number(m[3]);
    const hh = Number(m[4] ?? 0);
    const mi = Number(m[5] ?? 0);
    const ss = Number(m[6] ?? 0);
    const fechaHora = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss));
    const fecha = new Date(Date.UTC(yyyy, mm - 1, dd));
    const hora = normalizarHora(
      `${hh}:${String(mi).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    );
    const mes = `${yyyy}-${String(mm).padStart(2, "0")}`;
    return { fechaHora, fecha, hora, mes };
  }

  // fallback: intentar solo fecha
  const dOnly = toDateOnly(s);
  if (dOnly) {
    const yyyy = dOnly.getUTCFullYear();
    const mm = dOnly.getUTCMonth() + 1;
    const dd = dOnly.getUTCDate();
    const fechaHora = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
    const fecha = new Date(Date.UTC(yyyy, mm - 1, dd));
    const hora = "00:00:00";
    const mes = `${yyyy}-${String(mm).padStart(2, "0")}`;
    return { fechaHora, fecha, hora, mes };
  }

  return null;
}

function splitTokens(observacionRaw = "") {
  // ✅ más tolerante: permite " - ", " – ", "|" y también dobles espacios
  const parts = String(observacionRaw)
    .split(/\s*(?:-\s|–\s|\|\s*)/g)
    .map((p) => p.trim())
    .filter(Boolean);

  const map = {};
  for (const p of parts) {
    // ✅ acepta "key: val" y "key = val"
    const idx = p.indexOf(":") !== -1 ? p.indexOf(":") : p.indexOf("=");
    if (idx === -1) continue;
    const k = norm(p.slice(0, idx));
    const v = p.slice(idx + 1).trim();
    if (!k) continue;
    map[k] = v;
  }
  return map;
}

/**
 * ✅ FIX:
 * - No usamos "incluye acuerdo" porque mete "Bajo acuerdo/Baja acuerdo"
 * - Whitelist de acuerdos reales (y excluye los falsos positivos)
 */
function isAcuerdoByResultado(resultadoRaw) {
  const r = norm(resultadoRaw);
  if (!r) return false;

  if (r.includes("bajo acuerdo")) return false;
  if (r.includes("baja acuerdo")) return false;

  return (
    r === "acuerdo libre" ||
    r === "acuerdo parcial" ||
    r === "acuerdo anticipo mas cuotas" ||
    r === "acuerdo en cuota/s" ||
    r === "acuerdo en cuota" ||
    r === "acuerdo en cuotas"
  );
}

function buildTipoAcuerdo({ resultado, cuotasCantidad, anticipoMonto }) {
  const r = norm(resultado);
  const ant = Number(anticipoMonto || 0);

  if (r.includes("acuerdo parcial") || r.includes("parcial")) return "Parcial";

  if (r.includes("acuerdo libre")) {
    if (typeof cuotasCantidad !== "number" || !Number.isFinite(cuotasCantidad)) {
      return ant > 0 ? "Cancelación con anticipo" : "Cancelación";
    }
  }

  if (typeof cuotasCantidad === "number" && cuotasCantidad === 1) {
    return ant > 0 ? "Cancelación con anticipo" : "Cancelación";
  }

  if (typeof cuotasCantidad === "number" && cuotasCantidad > 1) {
    return ant > 0 ? "Acuerdo en cuotas con anticipo" : "Acuerdo en cuotas sin anticipo";
  }

  return "Revisar";
}

// ✅ picks: permite variantes de keys normalizadas
function pickTok(tokens, keys = []) {
  for (const k of keys) {
    const kk = norm(k);
    const v = tokens?.[kk];
    if (v != null && String(v).trim() !== "") return v;
  }
  return "";
}

function parseParcialPrimerPago(observacionRaw = "") {
  const s = String(observacionRaw);

  // 1) patrón original
  let m = s.match(/PPPAR[^0-9$]*.*?(\$?\s*[\d.]+(?:,\d{1,2})?)/i);
  if (m) return parseMoneyAR(m[1]);

  // 2) tolerante: PP / P.P / PRIMER PAGO
  m = s.match(/(?:\bPP\b|\bP\.P\.?\b|PRIMER\s*PAGO|1ER\s*PAGO)[^0-9$]*.*?(\$?\s*[\d.]+(?:,\d{1,2})?)/i);
  if (m) return parseMoneyAR(m[1]);

  return null;
}

function fmtDateISO(d) {
  if (!d) return "";
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

export function parseRowToAcuerdoPago(row, opts = {}) {
  const warnings = [];

  // ✅ helper para leer keys con espacios / variantes
  const pick = (...keys) => {
    for (const k of keys) {
      const v = row?.[k];
      if (v != null && String(v).trim() !== "") return v;
    }
    return "";
  };

  const idGestion = pick(
    "gestiones_idGestion",
    "idGestion",
    "ID_GESTION",
    "ID GESTION",
    "IdGestion",
    "IDGESTION"
  );

  const fechaHoraRaw = pick(
    "gestiones_dtFechHora",
    "FECHA_HORA",
    "FECHA HORA",
    "fechaHora",
    "fecha_hora",
    "FECHAHORA"
  );

  const operadorRaw = pick(
    "usuarios_21_cDescripcio",
    "OPERADOR",
    "usuario",
    "USUARIO",
    "Usuario",
    "OPERADOR_GESTOR"
  );

  // ✅ PRIORIDAD: resultados_22 = "Acuerdo libre / Acuerdo parcial / ..."
  const resultadoRaw = pick(
    "resultados_22_cDescripcio",
    "RESULTADO",
    "resultado",
    "resulta"
  );

  const estadoCuentaRaw = pick(
    "estadire_9_cDescripcio",
    "ESTADO_CUENTA",
    "ESTADO CUENTA",
    "estadoCuenta"
  );

  const observacionRaw = pick(
    "gestiones_cObservaci",
    "OBSERVACION",
    "observacion",
    "Observacion",
    "OBS"
  );

  const entidadRaw = pick(
    "entidades_35_cDescripcio",
    "ENTIDAD",
    "entidad",
    "Entidad"
  );

  const dniRaw = pick(
    "personas_nNumeDocu",
    "DNI",
    "dni",
    "NRO_DOC",
    "NUMERO_DOCUMENTO",
    "NUMERO DOC"
  );

  const nombreRaw = pick(
    "personas_cContacto",
    "NOMBRE",
    "nombre",
    "DEUDOR",
    "CONTACTO"
  );

  if (!isAcuerdoByResultado(resultadoRaw)) return { isAcuerdo: false };

  const fh = parseFechaHora(fechaHoraRaw);
  if (!fh) {
    warnings.push("No pude interpretar Fecha/Hora de la gestión");
    return { isAcuerdo: true, invalid: true, warnings };
  }

  const dni = String(dniRaw || "").replace(/\D/g, "").trim();
  const entidad = String(entidadRaw || "").trim().toUpperCase();
  const operador = String(operadorRaw || "").trim().toLowerCase();
  const estadoCuenta = String(estadoCuentaRaw || "").trim();

  if (!dni) warnings.push("Falta DNI");
  if (!entidad) warnings.push("Falta Entidad");

  const tokens = splitTokens(observacionRaw);

  // ✅ aliases: por si vienen con nombres distintos
  const cuotasCantidadNum = parseMoneyAR(
    pickTok(tokens, [
      "cantidad de cuota/s",
      "cantidad de cuotas",
      "cant cuotas",
      "cant. cuotas",
      "cuotas",
      "c/cuotas",
      "cantidad cuotas",
    ])
  );
  const cuotasCantidad = Number.isFinite(cuotasCantidadNum)
    ? Math.trunc(cuotasCantidadNum)
    : null;

  const montoCuota = parseMoneyAR(
    pickTok(tokens, [
      "monto de cuota",
      "monto cuota",
      "$ cuota",
      "importe de cuota",
      "importe cuota",
      "monto de la cuota",
    ])
  );

  const primerVto = toDateOnly(
    pickTok(tokens, [
      "primer vencimiento",
      "primer vto",
      "1er vencimiento",
      "1er vto",
      "vto cuota",
      "vto. cuota",
      "vencimiento de cuota",
      "vencimiento cuota",
    ])
  );

  const anticipoVto = toDateOnly(
    pickTok(tokens, [
      "fecha del anticipo",
      "vcto. del anticipo",
      "vto anticipo",
      "vto. anticipo",
      "vencimiento del anticipo",
      "vencimiento anticipo",
    ])
  ) || null;

  const anticipoMonto =
    parseMoneyAR(
      pickTok(tokens, [
        "monto del anticipo",
        "anticipo monto",
        "$ anticipo",
        "importe del anticipo",
        "importe anticipo",
      ])
    ) ?? 0;

  // ✅ Deuda mínima/máxima total
  const deudaMin =
    parseMoneyAR(
      pickTok(tokens, [
        "deuda minima total",
        "deuda min total",
        "deuda minima",
        "deuda min",
      ])
    ) ?? null;

  const deudaMax =
    parseMoneyAR(
      pickTok(tokens, [
        "deuda maxima total",
        "deuda max total",
        "deuda maxima",
        "deuda max",
      ])
    ) ?? null;

  const tipoAcuerdo = buildTipoAcuerdo({
    resultado: resultadoRaw,
    cuotasCantidad,
    anticipoMonto,
  });

  let primerPago =
    anticipoMonto > 0
      ? anticipoMonto
      : typeof montoCuota === "number"
      ? montoCuota
      : null;

  if (tipoAcuerdo === "Parcial") {
    const parcialMonto = parseParcialPrimerPago(observacionRaw);
    if (parcialMonto != null) primerPago = parcialMonto;
  }

  // ✅ si no pudimos calcular, dejamos null (pero ahora con aliases suele salir)
  const montoTotalAcuerdo =
    typeof cuotasCantidad === "number" && typeof montoCuota === "number"
      ? cuotasCantidad * montoCuota + (anticipoMonto || 0)
      : null;

  if (cuotasCantidad == null) warnings.push("No pude leer Cantidad de cuotas");
  if (montoCuota == null) warnings.push("No pude leer Monto de cuota");
  if (!primerVto) warnings.push("No pude leer Primer vencimiento");
  if (anticipoMonto > 0 && !anticipoVto) warnings.push("No pude leer Vencimiento del anticipo");

  const observacionCorta =
    pickTok(tokens, ["observacion corta", "observacion", "obs"]) || "";

  const observacionResumen =
    `Anticipo: ${anticipoMonto || 0}` +
    ` - Vto anticipo: ${fmtDateISO(anticipoVto) || ""}` +
    ` - C/Cuotas: ${cuotasCantidad ?? ""}` +
    ` - Monto cuota: ${montoCuota ?? ""}` +
    ` - Vto cuota: ${fmtDateISO(primerVto) || ""}` +
    (observacionCorta ? ` - Obs: ${observacionCorta}` : "");

  const mes = fh.mes;

  // ✅ CLAVE FINAL: dedupe solo dentro del mismo mes
  const key = `${mes}|${dni}|${entidad}`;

  return {
    isAcuerdo: true,
    invalid: false,
    key,
    mes,
    dni,
    entidad,

    nombreDeudor: String(nombreRaw || "").trim(),
    idGestion: String(idGestion || "").trim(),
    resultado: String(resultadoRaw || "").trim(),

    operador,
    estadoCuenta,
    fechaHora: fh.fechaHora,
    fecha: fh.fecha,
    hora: fh.hora,

    tipoAcuerdo,
    cuotasCantidad,
    montoCuota,
    primerVto: primerVto || null,
    anticipoMonto: anticipoMonto || 0,
    anticipoVto: anticipoVto || null,

    deudaMin,
    deudaMax,

    primerPago,
    montoTotalAcuerdo,

    observacionFull: String(observacionRaw || ""),
    observacionCorta: String(observacionCorta || ""),
    observacionResumen,

    // compat: si UI usa observacionRaw, dejamos algo “usable”
    observacionRaw: observacionCorta
      ? String(observacionCorta)
      : String(observacionRaw || ""),

    warnings,
  };
}
