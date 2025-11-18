// BACKEND/utils/fecha.util.js

/* ============================================================
   Fechas y Horas – utilidades estables para COBRINA / Reportes
   ============================================================ */

const EXCEL_EPOCH = Date.UTC(1899, 11, 31);

/** Convierte un serial de Excel (día) a Date UTC "solo fecha". */
export function fromExcelSerial(n) {
  const days = Number(n);
  if (!Number.isFinite(days)) return null;
  const ms = EXCEL_EPOCH + days * 86400000;
  const d = new Date(ms);
  d.setUTCHours(12, 0, 0, 0); // anclar al mediodía UTC para evitar off-by-one
  return d;
}

function isYearInRange(y) {
  return y >= 2000 && y <= 2100; // ajustable
}

/**
 * Normaliza una fecha a Date UTC "solo fecha".
 * Soporta: serial Excel, dd-mm-yyyy, yyyy-mm-dd (ignora hora si viene pegada).
 */
export function toDateOnly(raw) {
  if (raw == null) return null;
  const sRaw = String(raw).trim();

  // 1) número → serial Excel
  if (!isNaN(Number(sRaw))) {
    const num = Number(sRaw);
    // rango razonable de seriales
    if (num >= 25569 && num <= 60000) {
      return fromExcelSerial(num);
    }
    return null;
  }

  // Cortar cualquier parte horaria si viene pegada (espacio o 'T')
  const soloFecha = sRaw.split(/[ T]/)[0];

  // normalizamos separadores a '-'
  const s = soloFecha.replace(/\//g, "-");

  // dd-mm-yyyy
  let m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (m) {
    const [, dd, mm, yyyy] = m.map(Number);
    if (!isYearInRange(yyyy)) return null;
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    d.setUTCHours(12, 0, 0, 0);
    return isNaN(d) ? null : d;
  }

  // yyyy-mm-dd
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const [, yyyy, mm, dd] = m.map(Number);
    if (!isYearInRange(yyyy)) return null;
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    d.setUTCHours(12, 0, 0, 0);
    return isNaN(d) ? null : d;
  }

  return null;
}

/* ============================================================
   Hora – normalización robusta
   Objetivo: devolver SIEMPRE "HH:mm:ss" desde cualquier variante
   Soporta:
   - "H:mm", "HH:mm", "HH:mm:ss"
   - "835", "0915", "174412" (pegado sin ':')
   - "9.35", "09.35", "91.35" (formatos con punto)
   - números sueltos (9135, 915, etc.)
   Reglas especiales:
   - Si aparecen puntos, se interpreta izquierda como hora y derecha como minutos.
     Si la hora queda > 23 en un caso de 2 dígitos (p.ej. "91.35"),
     se asume un 0 faltante delante → "09:35:00".
   - En dígitos pegados:
       len=1..2  → HH:00
       len=3     → H:MM  (e.g. "935" → 09:35)
       len=4     → HH:MM (si HH>23 y había ambigüedad, forzar 0H:MM)
       len=5..6  → HH:MM:SS
   ============================================================ */
export function normalizarHora(h) {
  const s = String(h ?? "").trim();
  if (!s) return "00:00:00";

  let hh = 0, mm = 0, ss = 0;

  // 1) Formatos con ':'
  const colon = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (colon) {
    hh = parseInt(colon[1], 10) || 0;
    mm = parseInt(colon[2], 10) || 0;
    ss = parseInt(colon[3] ?? "0", 10) || 0;
    return [
      String(Math.max(0, Math.min(23, hh))).padStart(2, "0"),
      String(Math.max(0, Math.min(59, mm))).padStart(2, "0"),
      String(Math.max(0, Math.min(59, ss))).padStart(2, "0"),
    ].join(":");
  }

  // 2) Formatos con '.'
  if (s.includes(".")) {
    const [L, R] = s.split(".");
    let hLeft = L.replace(/\D/g, "");
    let mRight = R.replace(/\D/g, "");
    if (hLeft.length === 0 && mRight.length === 0) return "00:00:00";

    // minutos: tomamos 2 dígitos (completamos con 0 si faltan)
    mm = parseInt(mRight.padEnd(2, "0").slice(0, 2), 10) || 0;

    // horas:
    let hNum = parseInt(hLeft, 10);
    if (!Number.isFinite(hNum)) hNum = 0;

    // Caso especial reportado: "91.35" debe ser 09:35 (no 91:35)
    if (hLeft.length === 2 && hNum > 23) {
      hh = parseInt(hLeft[0], 10) || 0; // tomamos el primer dígito y asumimos 0 delante
    } else {
      hh = hNum;
    }

    hh = Math.max(0, Math.min(23, hh));
    return `${String(hh).padStart(2, "0")}:${String(Math.max(0, Math.min(59, mm))).padStart(2, "0")}:00`;
  }

  // 3) Solo dígitos (u otros separadores → limpiamos)
  const digits = s.replace(/\D/g, "");
  if (!digits) return "00:00:00";

  if (digits.length <= 2) {
    // "9" → 09:00, "13" → 13:00
    hh = parseInt(digits, 10) || 0;
    mm = 0;
  } else if (digits.length === 3) {
    // "935" → 09:35
    hh = parseInt(digits[0], 10) || 0;
    mm = parseInt(digits.slice(1), 10) || 0;
  } else if (digits.length === 4) {
    // "0915" → 09:15  | "9135" → 09:35 (si 91 > 23, asumimos 0 faltante delante)
    let h2 = parseInt(digits.slice(0, 2), 10) || 0;
    const m2 = parseInt(digits.slice(2, 4), 10) || 0;
    if (h2 > 23) {
      // Heurística para casos como "9135" (queremos 09:35)
      hh = parseInt(digits[0], 10) || 0;
      mm = m2;
    } else {
      hh = h2;
      mm = m2;
    }
  } else {
    // 5..6 → HHMMSS (o más largo: tomamos primeros 6)
    const p = digits.slice(0, 6).padStart(6, "0");
    hh = parseInt(p.slice(0, 2), 10) || 0;
    mm = parseInt(p.slice(2, 4), 10) || 0;
    ss = parseInt(p.slice(4, 6), 10) || 0;
  }

  hh = Math.max(0, Math.min(23, hh));
  mm = Math.max(0, Math.min(59, mm));
  ss = Math.max(0, Math.min(59, ss));

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
