import mongoose from "mongoose";
import ReporteGestion from "../models/ReporteGestion.js";
import AuditoriaContactoDirecto from "../models/AuditoriaContactoDirecto.js";
import Empleado from "../models/Empleado.js";
import NovedadRRHH from "../models/NovedadRRHH.js";
import {
  horarioEfectivoParaFecha,
  minutosEsperadosEnRango,
  minutosActividadSegunHorario,
  intervalosLaboralesSinDescanso,
  minutosHoraHHMM,
  minutoEnDescansoProgramado,
  novedadCubreFecha,
} from "../utils/calculoAsistencia.js";
import { toDateOnly } from "../utils/fecha.util.js";
import { criterioPorId } from "../config/auditorias.js";
import { filtrarEmpleadosControlados } from "../utils/controlEquipo.js";

const CACHE_TTL_MS = 120_000;
const cache = new Map();

const CONTINUIDAD_MIN = 20;
const PAUSA_NORMAL_MAX = 15;
const PAUSA_BREVE_MAX = 20;
const PAUSA_CRITICA_MIN = 60;
const MIN_BLOQUE_MIN = 5;
const TOLERANCIA_FIN_MIN = 30;

const TIME_ZONE = "America/Argentina/Buenos_Aires";

function partesArgentina(fecha = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(fecha);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function fechaClaveArgentina(fecha = new Date()) {
  const p = partesArgentina(fecha);
  return `${p.year}-${p.month}-${p.day}`;
}

function minutoActualArgentina(fecha = new Date()) {
  const p = partesArgentina(fecha);
  return Number(p.hour || 0) * 60 + Number(p.minute || 0);
}

function novedadLaboralDelDia(novedades = [], fechaClave = "") {
  return ["licencia-medica", "falta", "falta-justificada", "dia-estudio", "permiso"]
    .map((tipo) => (novedades || []).find((novedad) => novedad.tipo === tipo && novedadCubreFecha(novedad, fechaClave)))
    .find(Boolean) || null;
}

function etiquetaNovedad(novedad) {
  if (novedad?.tipo === "licencia-medica") return "Licencia médica";
  if (novedad?.tipo === "falta-justificada") return "Falta justificada";
  if (novedad?.tipo === "falta") return "Falta sin justificar";
  if (novedad?.tipo === "dia-estudio") return "Día de estudio";
  if (novedad?.tipo === "permiso") return "Permiso / ausencia";
  return "";
}

function getUsuarioId(req) {
  return (
    req?.user?.id ||
    req?.usuario?._id ||
    req?.userId ||
    null
  );
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

/**
 * Mantiene el mismo scope multi-tenant que el resto del Reporte de Gestiones.
 * Los perfiles de control ven el conjunto completo salvo que pidan onlyMine=true;
 * para el resto se filtra por propietario.
 */
function ownerScope(req) {
  const usuarioId = getUsuarioId(req);
  const rol = String(getUsuarioRol(req) || "").toLowerCase();
  const onlyMine =
    String(req?.query?.onlyMine ?? req?.body?.onlyMine ?? "").toLowerCase() ===
    "true";

  if (!usuarioId) return {};

  const isAdminLike = [
    "capacitadora",
    "administracion",
    "supervisor",
    "super-admin",
  ].includes(rol);

  if (isAdminLike && !onlyMine) return {};
  return { propietario: new mongoose.Types.ObjectId(usuarioId) };
}

function startDay(raw) {
  const value = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function endDay(raw) {
  const value = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function splitCSV(raw) {
  return String(raw || "")
    .split(/[;,\n]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function exactFilter(raw, transform = (value) => value) {
  const values = splitCSV(raw).map(transform).filter(Boolean);
  if (!values.length) return null;
  return values.length === 1 ? values[0] : { $in: values };
}

function dniFilter(raw) {
  const values = splitCSV(raw).map((value) => value.replace(/\D/g, "")).filter(Boolean);
  if (!values.length) return null;
  return values.length === 1 ? values[0] : { $in: values };
}

function minutesOfDay(raw) {
  const match = String(raw || "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 60 + minutes + seconds / 60;
}

function hhmm(value) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.max(0, Math.round(value));
  const hours = Math.floor(rounded / 60) % 24;
  const minutes = rounded % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function humanMinutes(value) {
  const minutes = Math.max(0, Math.round(Number(value || 0)));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function dayOfWeek(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function rangeDays(desde, hasta) {
  const result = [];
  for (let cursor = new Date(desde); cursor <= hasta; cursor = new Date(cursor.getTime() + 86_400_000)) {
    result.push(cursor.toISOString().slice(0, 10));
  }
  return result;
}

function isSingleDayRange(desde, hasta) {
  return Boolean(desde && hasta && desde.toISOString().slice(0, 10) === hasta.toISOString().slice(0, 10));
}

function groupActivity(rows, employeeByUsername, novedadesByEmployee = new Map()) {
  const grouped = new Map();
  for (const row of rows) {
    const username = String(row.usuario || "").trim().toLowerCase();
    const day = isoDay(row.fecha);
    const minute = minutesOfDay(row.hora);
    if (!username || !day || minute == null) continue;
    const key = `${username}|${day}`;
    if (!grouped.has(key)) grouped.set(key, { username, day, events: [] });
    grouped.get(key).events.push({ minute, dni: String(row.dni || "").trim() });
  }

  const daily = [];
  for (const item of grouped.values()) {
    item.events.sort((a, b) => a.minute - b.minute);
    const first = item.events[0]?.minute ?? 0;
    const last = item.events.at(-1)?.minute ?? first;
    const employee = employeeByUsername.get(item.username);
    const novedadesEmpleado = novedadesByEmployee.get(String(employee?._id || "")) || [];
    const horarioEfectivo = horarioEfectivoParaFecha(employee, item.day, novedadesEmpleado);
    const novedadDia = novedadLaboralDelDia(novedadesEmpleado, item.day);
    const ausenciaJustificada = ["licencia-medica", "falta-justificada", "dia-estudio", "permiso"].includes(novedadDia?.tipo);

    const rawIntervals = [];
    const blocks = [];
    let blockStart = first;
    let blockLast = first;
    const hourly = new Map();

    for (const event of item.events) {
      const hour = Math.floor(event.minute / 60);
      hourly.set(hour, (hourly.get(hour) || 0) + 1);
    }

    for (let index = 1; index < item.events.length; index += 1) {
      const previous = item.events[index - 1].minute;
      const current = item.events[index].minute;
      const rawGap = Math.max(0, current - previous);
      rawIntervals.push({ desdeMin: previous, hastaMin: current, duracionMin: rawGap });
      // Visualmente se conserva el corte real entre gestiones para que la tira
      // muestre los bloques, aunque el descanso programado no penalice como bache.
      if (rawGap > CONTINUIDAD_MIN) {
        blocks.push({ start: blockStart, end: blockLast, durationMin: Math.max(MIN_BLOQUE_MIN, blockLast - blockStart + MIN_BLOQUE_MIN) });
        blockStart = current;
      }
      blockLast = current;
    }
    blocks.push({ start: blockStart, end: blockLast, durationMin: Math.max(MIN_BLOQUE_MIN, blockLast - blockStart + MIN_BLOQUE_MIN) });

    const gapsLaborales = intervalosLaboralesSinDescanso(rawIntervals, horarioEfectivo);
    const workedMin = minutosActividadSegunHorario(first, last, horarioEfectivo);
    const scheduledStart = minutesOfDay(horarioEfectivo.entrada);
    const scheduledEnd = minutesOfDay(horarioEfectivo.salida);
    const expectedProgrammed = Number(horarioEfectivo.minutosEsperados || 0);
    const expectedMin = ausenciaJustificada ? 0 : expectedProgrammed;
    const todayKey = fechaClaveArgentina();
    const nowMin = minutoActualArgentina();
    const isToday = item.day === todayKey;
    const dayEnded = item.day < todayKey || (isToday && Number.isFinite(scheduledEnd) && nowMin >= scheduledEnd);
    const enDescansoProgramado = isToday && minutoEnDescansoProgramado(nowMin, horarioEfectivo.bloquesHorario);

    // Para la vista de hoy se agrega el corte abierto desde la última gestión hasta
    // la hora actual. intervalosLaboralesSinDescanso lo recorta por los bloques RRHH,
    // por lo que un descanso programado jamás se suma al bache.
    const openGaps = isToday && nowMin > last
      ? intervalosLaboralesSinDescanso([{ desdeMin: last, hastaMin: nowMin }], horarioEfectivo)
          .map((gap) => ({ ...gap, actual: !dayEnded }))
      : [];
    const allGaps = [
      ...gapsLaborales.map((gap) => ({ ...gap, actual: false })),
      ...openGaps,
    ];
    const brief = allGaps.filter((gap) => gap.duracionMin > PAUSA_NORMAL_MAX && gap.duracionMin <= PAUSA_BREVE_MAX);
    const long = allGaps.filter((gap) => gap.duracionMin > PAUSA_BREVE_MAX);
    const critical = long.filter((gap) => gap.duracionMin > PAUSA_CRITICA_MIN);
    const longTotal = long.reduce((sum, gap) => sum + Number(gap.duracionMin || 0), 0);
    const currentPauseMin = openGaps.reduce((sum, gap) => sum + Number(gap.duracionMin || 0), 0);
    const lateMin = !horarioEfectivo.programado || scheduledStart == null ? 0 : Math.max(0, first - scheduledStart);
    const earlyStartMin = !horarioEfectivo.programado || scheduledStart == null ? 0 : Math.max(0, scheduledStart - first);
    const earlyMin = !horarioEfectivo.programado || scheduledEnd == null ? 0 : Math.max(0, scheduledEnd - last - TOLERANCIA_FIN_MIN);
    const sortedHours = [...hourly.values()].sort((a, b) => b - a);
    const topTwo = (sortedHours[0] || 0) + (sortedHours[1] || 0);
    const concentrationPct = item.events.length ? (topTwo * 100) / item.events.length : 0;
    const uniqueCases = new Set(item.events.map((event) => event.dni).filter(Boolean)).size;
    const diff = expectedMin > 0 ? Math.round(workedMin - expectedMin) : null;
    let estadoHoras = "sin-horario";
    let estadoHorasLabel = horarioEfectivo.horarioLibre ? "Horario libre" : "Sin horario esperado";
    if (novedadDia) {
      estadoHoras = novedadDia.tipo === "falta" ? "falta" : "novedad";
      estadoHorasLabel = etiquetaNovedad(novedadDia);
    } else if (expectedMin > 0) {
      if (isToday && Number.isFinite(scheduledStart) && nowMin < scheduledStart && !item.events.length) {
        estadoHoras = "pendiente";
        estadoHorasLabel = `Todavía no inicia · ${horarioEfectivo.entrada}`;
      } else if (isToday && Number.isFinite(scheduledStart) && nowMin < scheduledStart && item.events.length) {
        estadoHoras = "en-curso";
        estadoHorasLabel = earlyStartMin > 0 ? `Actividad antes del horario · inició ${humanMinutes(earlyStartMin)} antes` : "Actividad antes del horario";
      } else if (enDescansoProgramado) {
        estadoHoras = "descanso";
        estadoHorasLabel = "Descanso programado";
      } else if (dayEnded) {
        if (diff >= 16) {
          estadoHoras = "extra";
          estadoHorasLabel = `+${humanMinutes(diff)} extra voluntaria`;
        } else if (diff >= -15) {
          estadoHoras = "completa";
          estadoHorasLabel = "Jornada completa";
        } else {
          estadoHoras = "incompleta";
          estadoHorasLabel = `Faltan ${humanMinutes(Math.abs(diff))}`;
        }
      } else if (currentPauseMin > PAUSA_CRITICA_MIN) {
        estadoHoras = "alerta";
        estadoHorasLabel = `Pausa actual ${humanMinutes(currentPauseMin)}`;
      } else if (currentPauseMin > PAUSA_BREVE_MAX) {
        estadoHoras = "atencion";
        estadoHorasLabel = `Pausa actual ${humanMinutes(currentPauseMin)}`;
      } else if (lateMin > PAUSA_BREVE_MAX) {
        estadoHoras = "atencion";
        estadoHorasLabel = `En curso · inició ${humanMinutes(lateMin)} tarde`;
      } else if (earlyStartMin > PAUSA_BREVE_MAX) {
        estadoHoras = "en-curso";
        estadoHorasLabel = `En curso · inició ${humanMinutes(earlyStartMin)} antes`;
      } else {
        estadoHoras = "en-curso";
        estadoHorasLabel = `En curso · faltan ${humanMinutes(Math.max(0, Math.abs(diff || 0)))}`;
      }
    }

    daily.push({
      username: item.username,
      fecha: item.day,
      horarioAsignado: horarioEfectivo.etiqueta,
      bloquesHorario: horarioEfectivo.bloquesHorario || [],
      jornadaPartida: horarioEfectivo.jornadaPartida,
      horarioModificado: horarioEfectivo.cambioHorario,
      licenciaMedica: horarioEfectivo.licenciaMedica,
      horarioLibre: horarioEfectivo.horarioLibre,
      novedadDia: novedadDia ? { tipo: novedadDia.tipo, descripcion: novedadDia.descripcion || "", etiqueta: etiquetaNovedad(novedadDia) } : null,
      primeraGestion: hhmm(first),
      ultimaGestion: hhmm(last),
      franjaTotalMin: Math.max(0, last - first),
      horasTrabajadasMin: Math.round(workedMin),
      gestiones: item.events.length,
      casos: uniqueCases,
      gestionesPorHora: workedMin > 0 ? item.events.length / (workedMin / 60) : 0,
      pausasBreves: brief.length,
      pausasLargas: long.length,
      pausasCriticas: critical.length,
      pausaLargaTotalMin: Math.round(longTotal),
      pausaLargaPromedioMin: long.length ? Math.round(longTotal / long.length) : 0,
      pausaMaximaMin: long.length ? Math.round(Math.max(...long.map((gap) => Number(gap.duracionMin || 0)))) : 0,
      pausasDetalle: long.map((gap) => ({
        desde: hhmm(gap.desdeMin),
        hasta: hhmm(gap.hastaMin),
        duracionMin: Math.round(Number(gap.duracionMin || 0)),
        actual: Boolean(gap.actual),
      })),
      pausaActualMin: Math.round(currentPauseMin),
      bloques: blocks.map((block) => ({
        desde: hhmm(block.start),
        hasta: hhmm(block.end),
        duracionMin: Math.round(block.durationMin),
      })),
      esperadoProgramadoMin: expectedProgrammed,
      esperadoMin: expectedMin,
      diferenciaPrevistaMin: diff,
      faltanMin: diff != null ? Math.max(0, -diff) : 0,
      extraMin: diff != null ? Math.max(0, diff) : 0,
      cumplimientoPct: expectedMin > 0 ? Math.round((workedMin / expectedMin) * 1000) / 10 : null,
      estadoHoras,
      estadoHorasLabel,
      inicioTardioMin: Math.round(lateMin),
      inicioAnticipadoMin: Math.round(earlyStartMin),
      finAnticipadoMin: Math.round(earlyMin),
      concentracionDosHorasPct: Math.round(concentrationPct * 10) / 10,
    });
  }
  daily.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.username.localeCompare(b.username));
  return daily;
}

function summarizeDaily(rows, employee, desde, hasta, novedades = []) {
  const sum = (key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
  const max = (key) => rows.reduce((value, row) => Math.max(value, Number(row[key] || 0)), 0);
  const longCount = sum("pausasLargas");
  const horarioLibre = employee?.horarioLaboral?.modalidad === "libre";
  const clavesRango = rangeDays(desde, hasta);
  const esperadoPorDia = horarioLibre
    ? []
    : clavesRango.map((day) => {
        const horario = horarioEfectivoParaFecha(employee, day, novedades);
        const novedadDia = novedadLaboralDelDia(novedades, day);
        const ausenciaJustificada = ["licencia-medica", "falta-justificada", "dia-estudio", "permiso"].includes(novedadDia?.tipo);
        return { day, minutos: ausenciaJustificada ? 0 : Number(horario.minutosEsperados || 0) };
      });
  const expectedDays = esperadoPorDia.filter((item) => item.minutos > 0).length;
  const expectedTotal = esperadoPorDia.reduce((total, item) => total + item.minutos, 0);
  const worked = sum("horasTrabajadasMin");
  const gestiones = sum("gestiones");
  const cases = sum("casos");
  const longTotal = sum("pausaLargaTotalMin");
  return {
    horarioLibre,
    diasConActividad: rows.length,
    diasLaboralesEsperados: expectedDays,
    horasPrevistasMin: expectedTotal,
    franjaRegistradaMin: sum("franjaTotalMin"),
    horasTrabajadasMin: worked,
    diferenciaPrevistaMin: expectedTotal ? worked - expectedTotal : null,
    gestiones,
    casos: cases,
    gestionesPorHora: worked ? gestiones / (worked / 60) : 0,
    pausasBreves: sum("pausasBreves"),
    pausasLargas: longCount,
    pausasCriticas: sum("pausasCriticas"),
    pausaLargaTotalMin: longTotal,
    pausaLargaPromedioMin: longCount ? longTotal / longCount : 0,
    pausaMaximaMin: max("pausaMaximaMin"),
    diasInicioTardio: rows.filter((row) => row.inicioTardioMin > 0).length,
    diasFinAnticipado: rows.filter((row) => row.finAnticipadoMin > 0).length,
    diasMenosCuatroHoras: horarioLibre ? 0 : rows.filter((row) => row.horasTrabajadasMin < 240).length,
    diasActividadConcentrada: rows.filter((row) => row.concentracionDosHorasPct >= 50).length,
  };
}

function textFragments(raw) {
  return String(raw || "")
    .split(/[\n\r;•]+/)
    .map((value) => value.replace(/^[-*\u2022\d.)\s]+/, "").trim())
    .filter((value) => value.length >= 4);
}

function recurringTexts(audits, field, limit = 8) {
  const grouped = new Map();
  for (const audit of audits) {
    for (const text of textFragments(audit?.[field])) {
      const key = text
        .toLocaleLowerCase("es-AR")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!key) continue;
      const current = grouped.get(key) || { texto: text, cantidad: 0 };
      current.cantidad += 1;
      grouped.set(key, current);
    }
  }
  return [...grouped.values()]
    .sort((a, b) => b.cantidad - a.cantidad || a.texto.localeCompare(b.texto, "es"))
    .slice(0, limit);
}

function aggregateAudit(audits) {
  const allOrderedAsc = [...audits].sort((a, b) => new Date(a.fechaAuditoria) - new Date(b.fechaAuditoria));
  const noAuditables = allOrderedAsc.filter((audit) => audit?.tipoInterlocutor === "NO_AUDITABLE");
  const orderedAsc = allOrderedAsc.filter((audit) =>
    audit?.tipoInterlocutor !== "NO_AUDITABLE" &&
    audit?.scoreFinal != null &&
    Number.isFinite(Number(audit.scoreFinal))
  );
  const orderedDesc = [...orderedAsc].reverse();
  const count = orderedAsc.length;
  const average = (path) => {
    const values = orderedAsc
      .map((audit) => path(audit))
      .filter((value) => value != null && Number.isFinite(Number(value)))
      .map(Number);
    return values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  };
  const failures = new Map();
  const partials = new Map();
  const semaforos = { bajo: 0, medio: 0, alto: 0 };

  for (const audit of orderedAsc) {
    semaforos[audit.semaforo] = (semaforos[audit.semaforo] || 0) + 1;
    const formulario = ["TITULAR", "TERCERO", "TERCERO_PAGADOR"].includes(audit?.formularioAplicado)
      ? audit.formularioAplicado
      : ["TITULAR", "TERCERO", "TERCERO_PAGADOR"].includes(audit?.tipoInterlocutor)
        ? audit.tipoInterlocutor
        : "TITULAR";
    for (const item of audit.items || []) {
      for (const rawId of item.fallosIds || []) {
        const id = Number(rawId);
        const key = `${formulario}:${id}`;
        failures.set(key, (failures.get(key) || 0) + 1);
      }
      for (const rawId of item.parcialesIds || []) {
        const id = Number(rawId);
        const key = `${formulario}:${id}`;
        partials.set(key, (partials.get(key) || 0) + 1);
      }
    }
  }

  const ids = new Set([...failures.keys(), ...partials.keys()]);
  const criteriosSeguimiento = [...ids]
    .map((key) => {
      const [formulario, rawId] = String(key).split(":");
      const id = Number(rawId);
      const criterio = criterioPorId(formulario, id) || { id, label: `Criterio ${id}`, grupo: "" };
      return {
        ...criterio,
        formulario,
        fallos: failures.get(key) || 0,
        parciales: partials.get(key) || 0,
        pesoSeguimiento: (failures.get(key) || 0) + (partials.get(key) || 0) * 0.5,
      };
    })
    .sort((a, b) => b.pesoSeguimiento - a.pesoSeguimiento || b.fallos - a.fallos)
    .slice(0, 10);

  const lastAudit = orderedDesc[0] || null;
  const firstAudit = orderedAsc[0] || null;
  const previousAudit = orderedDesc[1] || null;
  const evolution = count >= 2
    ? Number(lastAudit?.scoreFinal || 0) - Number(firstAudit?.scoreFinal || 0)
    : 0;
  const recentEvolution = previousAudit
    ? Number(lastAudit?.scoreFinal || 0) - Number(previousAudit?.scoreFinal || 0)
    : 0;

  const historial = orderedDesc.map((audit) => ({
    id: String(audit._id || ""),
    fecha: audit.fechaAuditoria,
    score: Number(audit.scoreFinal || 0),
    semaforo: audit.semaforo || "medio",
    auditorUsername: audit.auditorUsername || "",
    observacionesGenerales: audit.observacionesGenerales || "",
    puntosPositivos: audit.puntosPositivos || "",
    puntosAMejorar: audit.puntosAMejorar || "",
  }));

  const puntosAMejorarRecurrentes = recurringTexts(orderedAsc, "puntosAMejorar");
  const puntosPositivosRecurrentes = recurringTexts(orderedAsc, "puntosPositivos", 6);
  const recordatorio = [];
  for (const criterio of criteriosSeguimiento.slice(0, 3)) {
    const detalle = [
      criterio.fallos ? `${criterio.fallos} fallo(s)` : "",
      criterio.parciales ? `${criterio.parciales} parcial(es)` : "",
    ].filter(Boolean).join(" y ");
    recordatorio.push(`${criterio.label}${detalle ? ` (${detalle})` : ""}`);
  }
  if (lastAudit?.puntosAMejorar) {
    for (const item of textFragments(lastAudit.puntosAMejorar).slice(0, 3)) {
      if (!recordatorio.some((value) => value.toLocaleLowerCase("es-AR").includes(item.toLocaleLowerCase("es-AR")))) {
        recordatorio.push(item);
      }
    }
  }

  return {
    realizadas: count,
    realizadasTotales: allOrderedAsc.length,
    noAuditables: noAuditables.length,
    scorePromedio: average((audit) => audit.scoreFinal),
    bloques: {
      presentacion: average((audit) => audit.scoreBloques?.presentacion),
      negociacion: average((audit) => audit.scoreBloques?.negociacion),
      cierre: average((audit) => audit.scoreBloques?.cierre),
      calidad: average((audit) => audit.scoreBloques?.calidad),
    },
    semaforos,
    criteriosSeguimiento,
    criteriosMasFallados: criteriosSeguimiento.filter((item) => item.fallos > 0).slice(0, 6),
    criteriosParciales: criteriosSeguimiento.filter((item) => item.parciales > 0).slice(0, 6),
    puntosAMejorarRecurrentes,
    puntosPositivosRecurrentes,
    evolucionScore: evolution,
    evolucionReciente: recentEvolution,
    primeraAuditoria: firstAudit ? { fecha: firstAudit.fechaAuditoria, score: Number(firstAudit.scoreFinal || 0) } : null,
    ultimaAuditoria: lastAudit ? {
      fecha: lastAudit.fechaAuditoria,
      score: Number(lastAudit.scoreFinal || 0),
      semaforo: lastAudit.semaforo,
      observacionesGenerales: lastAudit.observacionesGenerales || "",
      puntosPositivos: lastAudit.puntosPositivos || "",
      puntosAMejorar: lastAudit.puntosAMejorar || "",
      auditorUsername: lastAudit.auditorUsername || "",
    } : null,
    historial,
    recordatorioProximaDevolucion: recordatorio.slice(0, 6),
  };
}

function buildActivityRecommendations(summary) {
  const alerts = [];
  if (!summary.horarioLibre && summary.diasMenosCuatroHoras) alerts.push(`${summary.diasMenosCuatroHoras} día(s) con menos de 4 horas trabajadas según Mango.`);
  if (summary.pausasCriticas) alerts.push(`${summary.pausasCriticas} pausa(s) crítica(s) superiores a 60 minutos.`);
  if (summary.diasInicioTardio) alerts.push(`${summary.diasInicioTardio} día(s) con inicio posterior al horario y tolerancia configurados.`);
  if (summary.diasActividadConcentrada) alerts.push(`${summary.diasActividadConcentrada} día(s) con más del 50 % de las gestiones concentradas en solo dos horas.`);
  if (!alerts.length) alerts.push(summary.horarioLibre
    ? "Horario libre: se informa actividad real sin calcular tardanzas, faltas horarias ni cumplimiento de una franja fija."
    : "No se detectaron alertas principales de actividad con los criterios actuales.");
  return alerts;
}

function buildAuditRecommendations(audit) {
  const alerts = [];
  if (!audit?.realizadas) return alerts;
  if (Number(audit.scorePromedio || 0) < 6.5) {
    alerts.push("El promedio histórico de auditoría está en nivel bajo y requiere acompañamiento.");
  }
  if (Number(audit.evolucionReciente || 0) < -0.5) {
    alerts.push(`El último score bajó ${Math.abs(Number(audit.evolucionReciente || 0)).toFixed(2)} puntos frente a la auditoría anterior.`);
  } else if (Number(audit.evolucionReciente || 0) > 0.5) {
    alerts.push(`El último score mejoró ${Number(audit.evolucionReciente || 0).toFixed(2)} puntos frente a la auditoría anterior.`);
  }
  if (audit.criteriosSeguimiento?.[0]) {
    alerts.push(`Prioridad para la próxima devolución: ${audit.criteriosSeguimiento[0].label}.`);
  }
  return alerts;
}

function buildCommonFilters(req, usernames, desde, hasta) {
  const match = {
    ...ownerScope(req),
    borrado: { $ne: true },
    fecha: { $gte: desde, $lte: hasta },
    usuario: usernames.length === 1 ? usernames[0] : { $in: usernames },
  };
  const ent = exactFilter(req.query.entidad, (value) => value.toUpperCase());
  const type = exactFilter(req.query.tipoContacto);
  const state = exactFilter(req.query.estadoCuenta);
  const dni = dniFilter(req.query.dni);
  if (ent) match.entidad = ent;
  if (type) match.tipoContacto = type;
  if (state) match.estadoCuenta = state;
  if (dni) match.dni = dni;
  return match;
}

async function resolveEmployees(req) {
  const requested = splitCSV(req.query.operador)
    .map((value) => value.toLowerCase())
    .filter((value) => !["todos", "todas", "-"].includes(value));

  const allEmployees = await Empleado.find({ isActive: { $ne: false } })
    .select("username nombre role horarioLaboral")
    .maxTimeMS(5_000)
    .lean();
  const controlled = filtrarEmpleadosControlados(allEmployees);
  const employees = requested.length
    ? controlled.filter((employee) => requested.includes(String(employee.username || "").trim().toLowerCase()))
    : controlled;
  const employeeByUsername = new Map(
    employees.map((employee) => [String(employee.username || "").toLowerCase(), employee])
  );
  const usernames = requested.length
    ? requested.filter((username) => employeeByUsername.has(username))
    : employees.map((employee) => String(employee.username || "").toLowerCase()).filter(Boolean);
  return { requested, employees, employeeByUsername, usernames };
}

export async function seguimientoOperadores(req, res) {
  const startedAt = Date.now();
  try {
    const desde = startDay(req.query.desde);
    const hasta = endDay(req.query.hasta);
    if (!desde || !hasta || hasta < desde) {
      return res.status(400).json({ error: "Rango de fechas inválido." });
    }

    const { employeeByUsername, usernames } = await resolveEmployees(req);
    if (!usernames.length) {
      return res.json({ ok: true, modo: "general", operadores: [], definiciones: {}, meta: { duracionMs: Date.now() - startedAt } });
    }

    const cacheKey = `actividad:${JSON.stringify({
      scope: ownerScope(req),
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
      usernames,
      entidad: req.query.entidad || "",
      tipoContacto: req.query.tipoContacto || "",
      estadoCuenta: req.query.estadoCuenta || "",
      dni: req.query.dni || "",
    })}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return res.json(cached.data);

    const match = buildCommonFilters(req, usernames, desde, hasta);

    // Esta consulta contiene solamente los cuatro campos necesarios. El orden se
    // realiza en memoria después de filtrar al operador/rango, evitando un sort
    // costoso sobre toda la colección cuando la consulta administrativa no usa propietario.
    const employeeIds = [...employeeByUsername.values()].map((employee) => employee._id).filter(Boolean);
    const [rows, novedadesHorario] = await Promise.all([
      ReporteGestion.find(match)
        .select("usuario fecha hora dni")
        .maxTimeMS(15_000)
        .lean(),
      employeeIds.length
        ? NovedadRRHH.find({
            empleadoId: { $in: employeeIds },
            tipo: { $in: ["cambio-horario", "licencia-medica", "falta", "falta-justificada", "dia-estudio", "permiso"] },
            estado: { $ne: "anulado" },
            fechaDesde: { $lte: hasta },
            $or: [{ fechaHasta: null }, { fechaHasta: { $gte: desde } }],
          }).lean()
        : Promise.resolve([]),
    ]);
    const novedadesByEmployee = new Map();
    for (const novedad of novedadesHorario) {
      const key = String(novedad.empleadoId);
      if (!novedadesByEmployee.has(key)) novedadesByEmployee.set(key, []);
      novedadesByEmployee.get(key).push(novedad);
    }

    const daily = groupActivity(rows, employeeByUsername, novedadesByEmployee);
    const includeDailyRows = usernames.length === 1 || isSingleDayRange(desde, hasta);
    const operadores = usernames.map((username) => {
      const employee = employeeByUsername.get(username) || { username };
      const days = daily.filter((row) => row.username === username);
      const novedadesEmpleado = novedadesByEmployee.get(String(employee?._id || "")) || [];
      const summary = summarizeDaily(days, employee, desde, hasta, novedadesEmpleado);
      const alerts = buildActivityRecommendations(summary);
      let diasSalida = days;
      if (!days.length && includeDailyRows && isSingleDayRange(desde, hasta)) {
        const fecha = desde.toISOString().slice(0, 10);
        const horario = horarioEfectivoParaFecha(employee, fecha, novedadesEmpleado);
        const novedadDia = novedadLaboralDelDia(novedadesEmpleado, fecha);
        const ausenciaJustificada = ["licencia-medica", "falta-justificada", "dia-estudio", "permiso"].includes(novedadDia?.tipo);
        const esperado = ausenciaJustificada ? 0 : Number(horario.minutosEsperados || 0);
        const todayKey = fechaClaveArgentina();
        const startMin = minutesOfDay(horario.entrada);
        const endMin = minutesOfDay(horario.salida);
        const nowMin = minutoActualArgentina();
        const dayEnded = fecha < todayKey || (fecha === todayKey && Number.isFinite(endMin) && nowMin >= endMin);
        const notStarted = fecha === todayKey && Number.isFinite(startMin) && nowMin < startMin;
        const enDescanso = fecha === todayKey && minutoEnDescansoProgramado(nowMin, horario.bloquesHorario);
        const openDesde = Number.isFinite(startMin) ? startMin : null;
        const openGaps = fecha === todayKey && Number.isFinite(openDesde) && nowMin > openDesde
          ? intervalosLaboralesSinDescanso([{ desdeMin: openDesde, hastaMin: nowMin }], horario)
          : [];
        const pausaActualMin = openGaps.reduce((sum, gap) => sum + Number(gap.duracionMin || 0), 0);
        const pausasDetalle = openGaps.filter((gap) => Number(gap.duracionMin || 0) > PAUSA_BREVE_MAX).map((gap) => ({
          desde: hhmm(gap.desdeMin), hasta: hhmm(gap.hastaMin), duracionMin: Math.round(Number(gap.duracionMin || 0)), actual: !dayEnded,
        }));
        const estadoSinActividad = novedadDia
          ? (novedadDia.tipo === "falta" ? "falta" : "novedad")
          : esperado > 0
            ? (notStarted ? "pendiente" : enDescanso ? "descanso" : dayEnded ? "incompleta" : pausaActualMin > PAUSA_CRITICA_MIN ? "alerta" : "sin-actividad")
            : "sin-horario";
        const etiquetaSinActividad = novedadDia
          ? etiquetaNovedad(novedadDia)
          : esperado > 0
            ? (notStarted ? `Todavía no inicia · ${horario.entrada}` : enDescanso ? "Descanso programado" : dayEnded ? `Faltan ${humanMinutes(esperado)}` : `Sin gestiones desde ${horario.entrada} · ${humanMinutes(pausaActualMin)}`)
            : (horario.horarioLibre ? "Horario libre" : "Sin horario esperado");
        diasSalida = [{
          username, fecha, horarioAsignado: horario.etiqueta, bloquesHorario: horario.bloquesHorario || [],
          jornadaPartida: horario.jornadaPartida, horarioModificado: horario.cambioHorario,
          licenciaMedica: horario.licenciaMedica, horarioLibre: horario.horarioLibre,
          novedadDia: novedadDia ? { tipo: novedadDia.tipo, descripcion: novedadDia.descripcion || "", etiqueta: etiquetaNovedad(novedadDia) } : null,
          primeraGestion: "—", ultimaGestion: "—", franjaTotalMin: 0, horasTrabajadasMin: 0, gestiones: 0, casos: 0,
          gestionesPorHora: 0, pausasBreves: 0, pausasLargas: pausasDetalle.length, pausasCriticas: pausasDetalle.filter((gap) => gap.duracionMin > PAUSA_CRITICA_MIN).length, pausaLargaTotalMin: pausasDetalle.reduce((sum, gap) => sum + gap.duracionMin, 0),
          pausaLargaPromedioMin: pausasDetalle.length ? Math.round(pausasDetalle.reduce((sum, gap) => sum + gap.duracionMin, 0) / pausasDetalle.length) : 0, pausaMaximaMin: pausasDetalle.length ? Math.max(...pausasDetalle.map((gap) => gap.duracionMin)) : 0, pausasDetalle, pausaActualMin: Math.round(pausaActualMin), bloques: [], esperadoProgramadoMin: Number(horario.minutosEsperados || 0),
          esperadoMin: esperado, diferenciaPrevistaMin: esperado > 0 ? -esperado : null, faltanMin: esperado, extraMin: 0,
          cumplimientoPct: esperado > 0 ? 0 : null,
          estadoHoras: estadoSinActividad,
          estadoHorasLabel: etiquetaSinActividad,
          inicioTardioMin: 0, inicioAnticipadoMin: 0, finAnticipadoMin: 0, concentracionDosHorasPct: 0,
        }];
        alerts.unshift('Sin actividad registrada en el rango seleccionado.');
      }
      return {
        username,
        nombre: employee.nombre || "",
        role: employee.role || "",
        horarioLaboral: employee.horarioLaboral || {},
        novedadesHorario: novedadesEmpleado.map((novedad) => ({
          id: String(novedad._id),
          tipo: novedad.tipo,
          fechaDesde: novedad.fechaDesde,
          fechaHasta: novedad.fechaHasta,
          horaEntradaNueva: novedad.horaEntradaNueva || "",
          horaSalidaNueva: novedad.horaSalidaNueva || "",
          jornadaPartidaNueva: Boolean(novedad.jornadaPartidaNueva),
          horaEntradaSegundaNueva: novedad.horaEntradaSegundaNueva || "",
          horaSalidaSegundaNueva: novedad.horaSalidaSegundaNueva || "",
          descripcion: novedad.descripcion || "",
        })),
        resumen: summary,
        dias: includeDailyRows ? diasSalida : [],
        alertas: alerts,
      };
    });
    operadores.sort((a, b) => b.resumen.horasTrabajadasMin - a.resumen.horasTrabajadasMin);

    const definitions = {
      horasTrabajadas: "Tiempo entre primera y última gestión de cada día. Si el horario está partido, se descuenta solamente el descanso programado entre bloques; los baches se informan aparte.",
      franjaTotal: "Tiempo transcurrido entre la primera y la última gestión del día; puede incluir pausas.",
      pausaNormal: `Hasta ${PAUSA_NORMAL_MAX} minutos entre gestiones se considera continuidad normal.`,
      pausaBreve: `Más de ${PAUSA_NORMAL_MAX} y hasta ${PAUSA_BREVE_MAX} minutos se informa como pausa breve, pero permanece dentro del bloque de actividad.`,
      pausaLarga: `Más de ${PAUSA_BREVE_MAX} minutos sin gestiones se considera pausa larga y separa bloques de trabajo.`,
      pausaCritica: `Más de ${PAUSA_CRITICA_MIN} minutos sin gestiones se marca como pausa crítica.`,
      gestionesPorHora: "Cantidad de gestiones registradas por cada hora trabajada estimada según Mango.",
      gestionesTotales: "Cantidad de registros de gestión de Mango dentro de los filtros aplicados.",
      casosDistintos: "Cantidad de DNIs únicos trabajados en el período.",
      casosNuevos: "DNIs gestionados en el período que no registraron gestiones durante los 90 días anteriores.",
      contactabilidad: "Porcentaje de gestiones cuyo resultado o estado indica que hubo contacto.",
      efectividad: "Porcentaje de DNIs distintos con al menos una gestión contactada.",
      intervaloGestiones: "Promedio de minutos entre gestiones consecutivas del mismo operador y día.",
      intervaloCasos: "Promedio de minutos entre gestiones consecutivas cuando cambia el DNI trabajado.",
      comparacion: "Los valores coloreados comparan el período seleccionado con el período anterior equivalente.",
    };

    const payload = {
      ok: true,
      modo: usernames.length === 1 ? "individual" : includeDailyRows ? "equipo-dia" : "general",
      rango: { desde: desde.toISOString().slice(0, 10), hasta: hasta.toISOString().slice(0, 10) },
      parametros: {
        continuidadMin: CONTINUIDAD_MIN,
        pausaNormalMax: PAUSA_NORMAL_MAX,
        pausaBreveMax: PAUSA_BREVE_MAX,
        pausaCriticaMin: PAUSA_CRITICA_MIN,
      },
      definiciones: definitions,
      operadores,
      meta: {
        gestionesAnalizadas: rows.length,
        generadoEn: new Date().toISOString(),
        duracionMs: Date.now() - startedAt,
      },
    };
    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, data: payload });
    return res.json(payload);
  } catch (error) {
    console.error("seguimientoOperadores:", error);
    const timeout = error?.code === 50 || error?.codeName === "MaxTimeMSExpired";
    return res.status(timeout ? 504 : 500).json({
      error: timeout
        ? "El análisis de actividad superó el tiempo esperado. Probá un rango menor o volvé a intentarlo."
        : error?.message || "No se pudo calcular el seguimiento del operador.",
    });
  }
}

export async function seguimientoAuditorias(req, res) {
  const startedAt = Date.now();
  try {
    const { usernames } = await resolveEmployees(req);
    if (usernames.length !== 1) {
      return res.status(400).json({ error: "Seleccioná un único operador para consultar auditorías." });
    }

    const username = usernames[0];
    const auditScope = ownerScope(req)?.propietario ? { propietario: ownerScope(req).propietario } : {};
    const cacheKey = `auditoria-historica:${JSON.stringify({ auditScope, username })}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return res.json(cached.data);

    // Solo se consulta la colección de auditorías. No se cuentan gestiones ni se
    // descargan audios/PDFs, por lo que este panel nunca debe trabar el reporte.
    const audits = await AuditoriaContactoDirecto.find({
      ...auditScope,
      borrado: { $ne: true },
      operadorUsername: username,
    })
      .select("auditorUsername operadorUsername fechaAuditoria tipoInterlocutor formularioAplicado scoreFinal scoreBloques semaforo items.fallosIds items.parcialesIds observacionesGenerales puntosPositivos puntosAMejorar")
      .sort({ fechaAuditoria: -1 })
      .maxTimeMS(6_000)
      .lean();

    const audit = aggregateAudit(audits);
    const payload = {
      ok: true,
      operador: username,
      alcance: "historial-completo",
      auditorias: audit,
      alertas: buildAuditRecommendations(audit),
      meta: {
        generadoEn: new Date().toISOString(),
        duracionMs: Date.now() - startedAt,
        documentosAnalizados: audits.length,
      },
    };

    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS * 3, data: payload });
    return res.json(payload);
  } catch (error) {
    console.error("seguimientoAuditorias:", error);
    const timeout = error?.code === 50 || error?.codeName === "MaxTimeMSExpired";
    return res.status(timeout ? 504 : 500).json({
      error: timeout
        ? "La consulta del historial de auditorías superó el tiempo esperado. Volvé a intentarlo."
        : error?.message || "No se pudieron cargar las auditorías del operador.",
    });
  }
}

export function invalidateSeguimientoCache() {
  cache.clear();
}
