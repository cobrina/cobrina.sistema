// Feriados usados por Contactados para el reloj de 48/60/72 horas hábiles.
// Incluye reglas nacionales recurrentes + días turísticos oficiales 2026.
// Se pueden sumar excepciones locales sin tocar código con:
// FERIADOS_AR_EXTRA=YYYY-MM-DD,YYYY-MM-DD

const TURISTICOS_POR_ANIO = {
  2026: ["2026-03-23", "2026-07-10", "2026-12-07"],
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function keyUTC(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// Algoritmo gregoriano de Meeus/Jones/Butcher para Domingo de Pascua.
function domingoPascuaUTC(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function sumarDiasUTC(date, days) {
  return new Date(date.getTime() + Number(days) * 86_400_000);
}

// Ley 27.399: 17/6, 17/8, 12/10 y 20/11 se trasladan cuando caen
// martes/miércoles al lunes anterior y jueves/viernes al lunes siguiente.
function trasladable(year, month, day) {
  const fecha = new Date(Date.UTC(year, month - 1, day));
  const weekday = fecha.getUTCDay();
  if (weekday === 2) return sumarDiasUTC(fecha, -1); // martes -> lunes anterior
  if (weekday === 3) return sumarDiasUTC(fecha, -2); // miércoles -> lunes anterior
  if (weekday === 4) return sumarDiasUTC(fecha, 4);  // jueves -> lunes siguiente
  if (weekday === 5) return sumarDiasUTC(fecha, 3);  // viernes -> lunes siguiente
  return fecha;
}

export function feriadosArgentinaParaAnio(year) {
  const y = Number(year);
  const out = new Set();
  const agregar = (month, day) => out.add(`${y}-${pad(month)}-${pad(day)}`);

  // Inamovibles nacionales.
  agregar(1, 1);
  agregar(3, 24);
  agregar(4, 2);
  agregar(5, 1);
  agregar(5, 25);
  agregar(6, 20);
  agregar(7, 9);
  agregar(12, 8);
  agregar(12, 25);

  // Carnaval y Viernes Santo.
  const pascua = domingoPascuaUTC(y);
  out.add(keyUTC(sumarDiasUTC(pascua, -48))); // lunes de Carnaval
  out.add(keyUTC(sumarDiasUTC(pascua, -47))); // martes de Carnaval
  out.add(keyUTC(sumarDiasUTC(pascua, -2)));  // Viernes Santo

  // Trasladables nacionales.
  out.add(keyUTC(trasladable(y, 6, 17)));
  out.add(keyUTC(trasladable(y, 8, 17)));
  out.add(keyUTC(trasladable(y, 10, 12)));
  out.add(keyUTC(trasladable(y, 11, 20)));

  // Días no laborables con fines turísticos publicados para el año.
  (TURISTICOS_POR_ANIO[y] || []).forEach((key) => out.add(key));
  return out;
}

function extrasDesdeEnv() {
  return String(process.env.FERIADOS_AR_EXTRA || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
}

export function feriadosArgentinaSet(year = new Date().getUTCFullYear()) {
  // Agregamos año anterior/siguiente para cálculos que cruzan Año Nuevo.
  const y = Number(year);
  const base = new Set([
    ...feriadosArgentinaParaAnio(y - 1),
    ...feriadosArgentinaParaAnio(y),
    ...feriadosArgentinaParaAnio(y + 1),
  ]);
  extrasDesdeEnv().forEach((key) => base.add(key));
  return base;
}

export default feriadosArgentinaParaAnio(2026);
