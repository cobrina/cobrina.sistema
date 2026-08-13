import StickyNote from "../models/StickyNote.js";
import AgendaItem from "../models/AgendaItem.js";
import { fechaClaveArgentina } from "./fecha.util.js";

const RETENCION_MESES = 3;
const INTERVALO_MINIMO_MS = 12 * 60 * 60 * 1000;
let ultimaEjecucion = 0;
let ejecucionActual = null;

function restarMesesClave(fechaClave, meses = RETENCION_MESES) {
  const match = String(fechaClave || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const totalMonths = year * 12 + (month - 1) - Math.max(0, Number(meses || 0));
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonthIndex = ((totalMonths % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0, 12)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${targetYear}-${String(targetMonthIndex + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

export async function limpiarRegistrosPersonalesAntiguos({ force = false, now = new Date() } = {}) {
  const ahoraMs = now.getTime();
  if (!force && ultimaEjecucion && ahoraMs - ultimaEjecucion < INTERVALO_MINIMO_MS) {
    return { skipped: true, tareas: 0, agenda: 0 };
  }
  if (ejecucionActual) return ejecucionActual;

  ejecucionActual = (async () => {
    const cutoffInstant = new Date(now);
    cutoffInstant.setUTCMonth(cutoffInstant.getUTCMonth() - RETENCION_MESES);
    const cutoffAgenda = restarMesesClave(fechaClaveArgentina(now), RETENCION_MESES);

    const [tareas, agenda] = await Promise.all([
      // Las tareas que llevan más de tres meses sin cambios se consideran archivo vencido.
      // Usar updatedAt evita borrar una tarea antigua que la persona sigue manteniendo activa.
      StickyNote.deleteMany({ updatedAt: { $lt: cutoffInstant } }),
      // La agenda conserva siempre actividades futuras; solo se limpian fechas pasadas
      // cuya fecha calendario quedó fuera de la ventana móvil de tres meses.
      AgendaItem.deleteMany({ fechaClave: { $lt: cutoffAgenda } }),
    ]);

    ultimaEjecucion = Date.now();
    return {
      skipped: false,
      tareas: Number(tareas?.deletedCount || 0),
      agenda: Number(agenda?.deletedCount || 0),
      cutoffTareas: cutoffInstant,
      cutoffAgenda,
    };
  })();

  try {
    return await ejecucionActual;
  } finally {
    ejecucionActual = null;
  }
}

export const RETENCION_PERSONAL_MESES = RETENCION_MESES;
