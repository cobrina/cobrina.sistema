import { feriadosArgentinaSet } from "../config/feriadosArgentina.js";

const OFFSET_AR_MS = 3 * 60 * 60 * 1000; // Argentina = UTC-03, sin DST vigente.
const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

export function claveFechaArgentina(date = new Date()) {
  const localFakeUtc = new Date(date.getTime() - OFFSET_AR_MS);
  return localFakeUtc.toISOString().slice(0, 10);
}

export function fechaHoraGestionArgentina(fecha, hora = "00:00:00") {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const match = String(hora || "00:00:00").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const hh = Math.min(23, Math.max(0, Number(match?.[1] || 0)));
  const mm = Math.min(59, Math.max(0, Number(match?.[2] || 0)));
  const ss = Math.min(59, Math.max(0, Number(match?.[3] || 0)));
  // Hora local argentina -> UTC sumando 3 horas.
  return new Date(Date.UTC(y, m, day, hh + 3, mm, ss, 0));
}

function partesArgentina(date) {
  const localFakeUtc = new Date(date.getTime() - OFFSET_AR_MS);
  return {
    year: localFakeUtc.getUTCFullYear(),
    month: localFakeUtc.getUTCMonth(),
    day: localFakeUtc.getUTCDate(),
    weekday: localFakeUtc.getUTCDay(),
    hour: localFakeUtc.getUTCHours(),
    minute: localFakeUtc.getUTCMinutes(),
    second: localFakeUtc.getUTCSeconds(),
  };
}

function utcDesdePartesArgentina({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  return new Date(Date.UTC(year, month, day, hour + 3, minute, second, 0));
}

export function esDiaHabilArgentina(date, feriados = null) {
  const p = partesArgentina(date);
  const calendario = feriados || feriadosArgentinaSet(p.year);
  if (p.weekday === 0 || p.weekday === 6) return false;
  const key = `${p.year}-${String(p.month + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return !calendario.has(key);
}

function siguienteInicioDiaArgentina(date) {
  const p = partesArgentina(date);
  const fake = new Date(Date.UTC(p.year, p.month, p.day + 1, 0, 0, 0, 0));
  return utcDesdePartesArgentina({
    year: fake.getUTCFullYear(),
    month: fake.getUTCMonth(),
    day: fake.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  });
}

export function agregarHorasHabilesArgentina(desde, horas, feriados = null) {
  let cursor = new Date(desde);
  const calendario = feriados || feriadosArgentinaSet(partesArgentina(cursor).year);
  let restanteMs = Math.max(0, Number(horas || 0)) * HORA_MS;
  if (!restanteMs) return cursor;

  let guard = 0;
  while (restanteMs > 0 && guard < 2000) {
    guard += 1;
    if (!esDiaHabilArgentina(cursor, calendario)) {
      cursor = siguienteInicioDiaArgentina(cursor);
      continue;
    }

    const finDia = siguienteInicioDiaArgentina(cursor);
    const disponible = Math.max(0, finDia.getTime() - cursor.getTime());
    if (restanteMs <= disponible) {
      cursor = new Date(cursor.getTime() + restanteMs);
      restanteMs = 0;
      break;
    }
    restanteMs -= disponible;
    cursor = finDia;
  }
  return cursor;
}

export function horasHabilesEntreArgentina(desde, hasta, feriados = null) {
  let inicio = new Date(desde);
  const calendario = feriados || feriadosArgentinaSet(partesArgentina(inicio).year);
  const fin = new Date(hasta);
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime()) || fin <= inicio) return 0;

  let totalMs = 0;
  let guard = 0;
  while (inicio < fin && guard < 2000) {
    guard += 1;
    const finDia = siguienteInicioDiaArgentina(inicio);
    const tramoFin = fin < finDia ? fin : finDia;
    if (esDiaHabilArgentina(inicio, calendario)) {
      totalMs += Math.max(0, tramoFin.getTime() - inicio.getTime());
    }
    inicio = tramoFin;
  }
  return totalMs / HORA_MS;
}

export function inicioDiaArgentina(date = new Date()) {
  const p = partesArgentina(date);
  return utcDesdePartesArgentina({ year: p.year, month: p.month, day: p.day, hour: 0 });
}

export function finDiaArgentina(date = new Date()) {
  return new Date(inicioDiaArgentina(new Date(date.getTime() + DIA_MS)).getTime() - 1);
}

export function inicioMesArgentina(claveMes) {
  const m = String(claveMes || "").match(/^(\d{4})-(\d{2})$/);
  if (!m) return inicioDiaArgentina(new Date());
  return utcDesdePartesArgentina({ year: Number(m[1]), month: Number(m[2]) - 1, day: 1, hour: 0 });
}

export function finMesArgentina(claveMes) {
  const inicio = inicioMesArgentina(claveMes);
  const p = partesArgentina(inicio);
  const siguiente = utcDesdePartesArgentina({ year: p.year, month: p.month + 1, day: 1, hour: 0 });
  return new Date(siguiente.getTime() - 1);
}
