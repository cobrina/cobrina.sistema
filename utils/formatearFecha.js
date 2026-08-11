import { claveFechaCalendario, ZONA_HORARIA_ARGENTINA } from "./fecha.util.js";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// Para campos que representan un día calendario (promesa, pago, vencimiento).
export const formatearFecha = (fecha) => {
  const key = claveFechaCalendario(fecha);
  if (!key) return "";
  const [yyyy, mm, dd] = key.split("-");
  return `${dd}/${MESES[Number(mm) - 1]}/${yyyy}`;
};

// Para timestamps reales (creado, modificado, última gestión).
export const formatearFechaArgentina = (fecha) => {
  if (!fecha) return "";
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA_HORARIA_ARGENTINA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const v = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${v.day}/${MESES[Number(v.month) - 1]}/${v.year}`;
};
