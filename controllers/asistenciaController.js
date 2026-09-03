import mongoose from "mongoose";
import Asistencia from "../models/Asistencia.js";
import Empleado from "../models/Empleado.js";
import NovedadRRHH from "../models/NovedadRRHH.js";
import ReporteGestion from "../models/ReporteGestion.js";
import {
  horarioEfectivoParaFecha,
  novedadCubreFecha,
  minutosActividadSegunHorario,
  intervalosLaboralesSinDescanso,
  aplicarBreakFlexible,
  minutosBreakFlexiblePermitido,
  minutosHoraHHMM,
  minutoEnDescansoProgramado,
} from "../utils/calculoAsistencia.js";
import { actividadDeUsuarioEnFecha } from "../utils/actividadGestiones.js";
import { filtrarEmpleadosControlados } from "../utils/controlEquipo.js";
import { normalizeUsername } from "../config/roles.js";
import { invalidateSeguimientoCache } from "./reportesSeguimientoController.js";

const TIME_ZONE = "America/Argentina/Buenos_Aires";
const HORA_CIERRE_AUTOMATICO = "21:00";
const DEMORA_CIERRE_NAVEGADOR_MS = 60_000;

function partesArgentina(fecha = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(fecha);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function fechaClaveArgentina(fecha = new Date()) {
  const values = partesArgentina(fecha);
  return `${values.year}-${values.month}-${values.day}`;
}

function minutoActualArgentina(fecha = new Date()) {
  const values = partesArgentina(fecha);
  return Number(values.hour || 0) * 60 + Number(values.minute || 0);
}

function minutosArgentina(fecha = new Date()) {
  const values = partesArgentina(fecha);
  return Number(values.hour || 0) * 60 + Number(values.minute || 0);
}

function fechaHoraArgentina(fechaClave, hora = HORA_CIERRE_AUTOMATICO) {
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(fechaClave || ""))
    ? fechaClave
    : fechaClaveArgentina();
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(hora || ""))
    ? hora
    : HORA_CIERRE_AUTOMATICO;
  // Argentina permanece en UTC-03 para el período operativo de COBRINA.
  return new Date(`${fecha}T${hhmm}:00-03:00`);
}

function normalizarFechaClave(value) {
  const raw = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : fechaClaveArgentina();
}

function primeraMarca(marcas = [], tipo) {
  return marcas.find((marca) => marca.tipo === tipo)?.fecha || null;
}

function ultimaMarca(marcas = [], tipo) {
  return [...marcas].reverse().find((marca) => marca.tipo === tipo)?.fecha || null;
}

function limpiarHorario(payload = {}) {
  const modalidad = String(payload.modalidad || "fijo").trim().toLowerCase() === "libre"
    ? "libre"
    : "fijo";

  if (modalidad === "libre") {
    return {
      modalidad: "libre",
      dias: [],
      entrada: "",
      salida: "",
      toleranciaMinutos: 0,
    };
  }

  const diasRecibidos = Array.isArray(payload.dias)
    ? [...new Set(payload.dias.map(Number).filter((dia) => dia >= 0 && dia <= 6))]
    : [];
  const dias = diasRecibidos.length ? diasRecibidos : [1, 2, 3, 4, 5];

  const horaValida = (value) => {
    const hora = String(value || "").trim();
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(hora) ? hora : "";
  };

  const entrada = horaValida(payload.entrada);
  const salida = horaValida(payload.salida);
  if (!entrada || !salida) {
    const error = new Error("Completá una hora de entrada y salida válida");
    error.statusCode = 400;
    throw error;
  }
  const [eh, em] = entrada.split(":").map(Number);
  const [sh, sm] = salida.split(":").map(Number);
  if (sh * 60 + sm <= eh * 60 + em) {
    const error = new Error("La hora de salida debe ser posterior a la entrada");
    error.statusCode = 400;
    throw error;
  }

  const tolerancia = Number(payload.toleranciaMinutos);

  return {
    modalidad: "fijo",
    dias,
    entrada,
    salida,
    toleranciaMinutos:
      Number.isFinite(tolerancia) && tolerancia >= 0 && tolerancia <= 180
        ? Math.round(tolerancia)
        : 10,
  };
}

function yaTieneSalidaPosterior(asistencia, fechaSalida) {
  const salida = ultimaMarca(asistencia?.marcas || [], "salida");
  return salida && new Date(salida).getTime() >= new Date(fechaSalida).getTime();
}

async function finalizarAsistencia(asistencia, fechaSalida, motivo) {
  if (!asistencia || asistencia.estado !== "presente") return false;
  const salida = fechaSalida instanceof Date ? fechaSalida : new Date(fechaSalida || Date.now());
  if (!yaTieneSalidaPosterior(asistencia, salida)) {
    asistencia.marcas.push({ tipo: "salida", fecha: salida, motivo });
  }
  asistencia.estado = "finalizado";
  asistencia.cierrePendienteDesde = null;
  asistencia.cierrePendienteHasta = null;
  asistencia.motivoCierrePendiente = "";
  await asistencia.save();
  return true;
}

/**
 * Cierra jornadas olvidadas:
 * - a las 21:00 de Argentina;
 * - jornadas de días anteriores que hayan quedado abiertas;
 * - cierre de navegador confirmado luego de 60 segundos sin volver a abrir COBRINA.
 */
let cierresAutomaticosEnCurso = null;

function esErrorMongoTransitorio(error) {
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const name = String(error?.name || error?.cause?.name || "").toLowerCase();
  const message = String(error?.message || error?.cause?.message || "").toLowerCase();
  return (
    ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "ECONNREFUSED"].includes(code) ||
    name.includes("mongonetwork") ||
    name.includes("mongoserverselection") ||
    message.includes("read econnreset") ||
    message.includes("connection closed") ||
    message.includes("socket hang up")
  );
}

const esperarCierre = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ejecutarCierresAutomaticos() {
  const ahora = new Date();
  const hoy = fechaClaveArgentina(ahora);
  const despuesDeLas21 = minutosArgentina(ahora) >= 21 * 60;

  const condiciones = [
    { cierrePendienteHasta: { $ne: null, $lte: ahora } },
    { fechaClave: { $lt: hoy } },
  ];
  if (despuesDeLas21) condiciones.push({ fechaClave: hoy });

  const abiertas = await Asistencia.find({
    estado: "presente",
    $or: condiciones,
  }).maxTimeMS(20000);

  let cerradas = 0;
  for (const asistencia of abiertas) {
    const cierreNavegador =
      asistencia.cierrePendienteHasta &&
      new Date(asistencia.cierrePendienteHasta).getTime() <= ahora.getTime();

    if (cierreNavegador) {
      const salida = asistencia.cierrePendienteDesde || ahora;
      if (await finalizarAsistencia(asistencia, salida, "cierre-navegador")) cerradas++;
      continue;
    }

    const salida21 = fechaHoraArgentina(asistencia.fechaClave, HORA_CIERRE_AUTOMATICO);
    if (await finalizarAsistencia(asistencia, salida21, "automatico-21")) cerradas++;
  }

  return { ok: true, cerradas };
}

export async function procesarCierresAutomaticos() {
  // Varias pantallas consultan asistencia al mismo tiempo. Compartimos una
  // única ejecución para no multiplicar consultas ni cierres en paralelo.
  if (cierresAutomaticosEnCurso) return cierresAutomaticosEnCurso;

  cierresAutomaticosEnCurso = (async () => {
    if (mongoose.connection.readyState !== 1) {
      return { ok: false, cerradas: 0, omitido: "mongo-no-disponible" };
    }

    let ultimoError = null;
    for (let intento = 1; intento <= 2; intento += 1) {
      try {
        return await ejecutarCierresAutomaticos();
      } catch (error) {
        ultimoError = error;
        if (!esErrorMongoTransitorio(error) || intento >= 2) break;
        console.warn("⚠️ Cierres automáticos: conexión Mongo interrumpida; reintentando una vez.");
        await esperarCierre(500);
      }
    }

    console.error("❌ Error procesando cierres automáticos:", ultimoError?.message || ultimoError);
    return { ok: false, cerradas: 0 };
  })().finally(() => {
    cierresAutomaticosEnCurso = null;
  });

  return cierresAutomaticosEnCurso;
}

export async function miEstado(req, res) {
  try {
    await procesarCierresAutomaticos();
    const fechaClave = fechaClaveArgentina();
    try {
      await Asistencia.updateOne(
        { empleado: req.user.id, fechaClave, estado: "presente" },
        {
          $set: {
            cierrePendienteDesde: null,
            cierrePendienteHasta: null,
            motivoCierrePendiente: "",
          },
        }
      );
    } catch (error) {
      // Consultar el estado no debe romperse por una escritura auxiliar.
      console.warn("⚠️ Asistencia mi-estado: no se pudo limpiar cierre pendiente:", error?.message || error);
    }

    const [asistencia, empleado] = await Promise.all([
      Asistencia.findOne({ empleado: req.user.id, fechaClave }).lean(),
      Empleado.findById(req.user.id)
        .select("username nombre role horarioLaboral ultimaActividad")
        .lean(),
    ]);

    if (!empleado) return res.status(404).json({ error: "Usuario no encontrado" });

    return res.json({
      ok: true,
      fechaClave,
      estado: asistencia?.estado || "sin-fichar",
      marcas: asistencia?.marcas || [],
      entrada: primeraMarca(asistencia?.marcas, "entrada"),
      salida: ultimaMarca(asistencia?.marcas, "salida"),
      horarioLaboral: empleado.horarioLaboral || {},
      cierreAutomatico: HORA_CIERRE_AUTOMATICO,
    });
  } catch (error) {
    return res.status(500).json({ error: "No se pudo obtener el estado de fichaje" });
  }
}

export async function marcarEntrada(req, res) {
  try {
    await procesarCierresAutomaticos();
    const fechaClave = fechaClaveArgentina();
    const ahora = new Date();

    if (minutosArgentina(ahora) >= 21 * 60) {
      return res.status(400).json({
        error: "La jornada ya cerró automáticamente a las 21:00. No se puede iniciar un nuevo fichaje hoy.",
      });
    }

    let asistencia = await Asistencia.findOne({ empleado: req.user.id, fechaClave });

    if (!asistencia) {
      asistencia = new Asistencia({
        empleado: req.user.id,
        fechaClave,
        estado: "presente",
        marcas: [{ tipo: "entrada", fecha: ahora, motivo: "manual" }],
      });
    } else if (asistencia.estado === "presente") {
      asistencia.cierrePendienteDesde = null;
      asistencia.cierrePendienteHasta = null;
      asistencia.motivoCierrePendiente = "";
      await asistencia.save();
      return res.json({
        ok: true,
        yaEstabaPresente: true,
        estado: asistencia.estado,
        marcas: asistencia.marcas,
      });
    } else {
      asistencia.estado = "presente";
      asistencia.cierrePendienteDesde = null;
      asistencia.cierrePendienteHasta = null;
      asistencia.motivoCierrePendiente = "";
      asistencia.marcas.push({ tipo: "entrada", fecha: ahora, motivo: "manual" });
    }

    await Promise.all([
      asistencia.save(),
      Empleado.updateOne({ _id: req.user.id }, { $set: { ultimaActividad: ahora } }),
    ]);

    return res.status(201).json({
      ok: true,
      estado: asistencia.estado,
      marcas: asistencia.marcas,
      mensaje: "Entrada registrada",
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ error: "El fichaje ya fue actualizado. Reintentá." });
    }
    return res.status(500).json({ error: "No se pudo registrar la entrada" });
  }
}

export async function marcarSalida(req, res) {
  try {
    const fechaClave = fechaClaveArgentina();
    const ahora = new Date();
    const asistencia = await Asistencia.findOne({ empleado: req.user.id, fechaClave });

    if (!asistencia || asistencia.estado !== "presente") {
      return res.json({
        ok: true,
        yaEstabaFinalizada: Boolean(asistencia),
        estado: asistencia?.estado || "sin-fichar",
        marcas: asistencia?.marcas || [],
        mensaje: asistencia
          ? "La jornada ya estaba finalizada"
          : "No había una jornada abierta",
      });
    }

    await finalizarAsistencia(asistencia, ahora, "manual");
    await Empleado.updateOne({ _id: req.user.id }, { $set: { ultimaActividad: ahora } });

    return res.json({
      ok: true,
      estado: asistencia.estado,
      marcas: asistencia.marcas,
      mensaje: "Salida registrada",
    });
  } catch (error) {
    return res.status(500).json({ error: "No se pudo registrar la salida" });
  }
}

/**
 * Se invoca con fetch keepalive al cerrar la última pestaña. No finaliza de
 * inmediato: espera 60 segundos. Si fue una recarga, el heartbeat nuevo cancela
 * el cierre pendiente y la jornada continúa normalmente.
 */
export async function programarCierreNavegador(req, res) {
  try {
    const fechaClave = fechaClaveArgentina();
    const ahora = new Date();
    const hasta = new Date(ahora.getTime() + DEMORA_CIERRE_NAVEGADOR_MS);

    const asistencia = await Asistencia.findOneAndUpdate(
      { empleado: req.user.id, fechaClave, estado: "presente" },
      {
        $set: {
          cierrePendienteDesde: ahora,
          cierrePendienteHasta: hasta,
          motivoCierrePendiente: "cierre-navegador",
        },
      },
      { new: true }
    ).lean();

    return res.status(202).json({
      ok: true,
      programado: Boolean(asistencia),
      cierrePendienteHasta: asistencia?.cierrePendienteHasta || null,
    });
  } catch (error) {
    return res.status(500).json({ error: "No se pudo programar el cierre de jornada" });
  }
}

export async function panel(req, res) {
  try {
    await procesarCierresAutomaticos();
    const fechaClave = normalizarFechaClave(req.query.fecha);
    const fechaConsulta = new Date(`${fechaClave}T00:00:00.000Z`);
    const fechaConsultaHasta = new Date(`${fechaClave}T23:59:59.999Z`);

    const empleadosTodos = await Empleado.find({ isActive: { $ne: false } })
      .select("username nombre role ultimaActividad horarioLaboral isActive")
      .sort({ username: 1 })
      .lean();
    const empleados = filtrarEmpleadosControlados(empleadosTodos);
    const ids = empleados.map((empleado) => empleado._id);
    const usernames = empleados.map((empleado) => normalizeUsername(empleado.username)).filter(Boolean);

    const [asistencias, gestiones, novedades] = await Promise.all([
      Asistencia.find({ fechaClave, empleado: { $in: ids } }).lean(),
      ReporteGestion.find({
        fecha: { $gte: fechaConsulta, $lte: fechaConsultaHasta },
        borrado: { $ne: true },
        usuario: { $in: usernames },
      }).select("fecha hora usuario").lean(),
      ids.length
        ? NovedadRRHH.find({
            empleadoId: { $in: ids },
            tipo: { $in: ["cambio-horario", "licencia-medica", "vacaciones", "falta", "falta-justificada", "dia-estudio", "permiso"] },
            estado: { $ne: "anulado" },
            fechaDesde: { $lte: fechaConsultaHasta },
            $or: [{ fechaHasta: null }, { fechaHasta: { $gte: fechaConsulta } }],
          }).lean()
        : Promise.resolve([]),
    ]);

    const novedadesPorEmpleado = new Map();
    for (const novedad of novedades) {
      const key = String(novedad.empleadoId);
      if (!novedadesPorEmpleado.has(key)) novedadesPorEmpleado.set(key, []);
      novedadesPorEmpleado.get(key).push(novedad);
    }

    const porEmpleado = new Map(asistencias.map((item) => [String(item.empleado), item]));
    const actividadPorUsuario = actividadDeUsuarioEnFecha(gestiones, fechaClave);
    const prioridadNovedad = ["licencia-medica", "vacaciones", "falta", "falta-justificada", "dia-estudio", "permiso"];

    const items = empleados.map((empleado) => {
      const asistencia = porEmpleado.get(String(empleado._id));
      const marcas = asistencia?.marcas || [];
      const ultimaSalida = [...marcas].reverse().find((marca) => marca.tipo === "salida");
      const novedadesEmpleado = novedadesPorEmpleado.get(String(empleado._id)) || [];
      const horarioEfectivo = horarioEfectivoParaFecha(empleado, fechaClave, novedadesEmpleado);
      const actividad = actividadPorUsuario.get(normalizeUsername(empleado.username)) || null;
      const novedadesDelDia = novedadesEmpleado.filter((novedad) => novedadCubreFecha(novedad, fechaClave));
      const novedadDia = prioridadNovedad
        .map((tipo) => novedadesDelDia.find((novedad) => novedad.tipo === tipo))
        .find(Boolean) || null;
      const primeraMin = minutosHoraHHMM(actividad?.primeraGestion);
      const ultimaMin = minutosHoraHHMM(actividad?.ultimaGestion);
      const minutosTrabajadosHoy = minutosActividadSegunHorario(primeraMin, ultimaMin, horarioEfectivo);
      const intervalosLaborales = intervalosLaboralesSinDescanso(actividad?.intervalos || [], horarioEfectivo)
        .map((intervalo) => ({ ...intervalo, origen: "cerrado" }));
      const ausenciaJustificada = ["licencia-medica", "vacaciones", "falta-justificada", "dia-estudio", "permiso"].includes(novedadDia?.tipo);
      const minutosProgramadosHoy = Number(horarioEfectivo.minutosEsperados || 0);
      const minutosExigiblesHoy = ausenciaJustificada ? 0 : minutosProgramadosHoy;
      const diferenciaHoyMin = minutosExigiblesHoy > 0 ? minutosTrabajadosHoy - minutosExigiblesHoy : null;
      const esHoy = fechaClave === fechaClaveArgentina();
      const ahoraMin = esHoy ? minutoActualArgentina() : null;
      const entradaProgramadaMin = minutosHoraHHMM(horarioEfectivo.entrada);
      const salidaProgramadaMin = minutosHoraHHMM(horarioEfectivo.salida);
      const jornadaIniciada = horarioEfectivo.programado && Number.isFinite(entradaProgramadaMin)
        ? (esHoy ? ahoraMin >= entradaProgramadaMin : fechaClave < fechaClaveArgentina())
        : false;
      const jornadaFinalizada = horarioEfectivo.programado && Number.isFinite(salidaProgramadaMin)
        ? (esHoy ? ahoraMin >= salidaProgramadaMin : fechaClave < fechaClaveArgentina())
        : false;
      const enDescansoProgramado = esHoy && minutoEnDescansoProgramado(ahoraMin, horarioEfectivo.bloquesHorario);
      const intervalosAbiertos = esHoy && Number.isFinite(ultimaMin) && Number.isFinite(ahoraMin) && ahoraMin >= ultimaMin
        ? intervalosLaboralesSinDescanso([{ desdeMin: ultimaMin, hastaMin: ahoraMin }], horarioEfectivo)
            .map((intervalo) => ({ ...intervalo, origen: "abierto", actual: true }))
        : [];
      const ajusteBreak = aplicarBreakFlexible([...intervalosLaborales, ...intervalosAbiertos], horarioEfectivo);
      const intervalosConBreak = ajusteBreak.intervalos;
      const intervalosCerradosAjustados = intervalosConBreak.filter((intervalo) => intervalo.origen === "cerrado");
      const intervalosAbiertosAjustados = intervalosConBreak.filter((intervalo) => intervalo.origen === "abierto");
      const baches30Ajustados = intervalosCerradosAjustados.filter((intervalo) => intervalo.duracionMin > 30).length;
      const baches60Ajustados = intervalosCerradosAjustados.filter((intervalo) => intervalo.duracionMin > 60).length;
      const bacheMaximoAjustado = intervalosCerradosAjustados.reduce((maximo, intervalo) => Math.max(maximo, Number(intervalo.duracionMin || 0)), 0);
      let minutosSinGestion = null;
      if (esHoy && intervalosAbiertosAjustados.length) {
        minutosSinGestion = Math.max(0, Math.round(intervalosAbiertosAjustados.reduce((sum, intervalo) => sum + Number(intervalo.duracionMin || 0), 0)));
      }

      return {
        _id: empleado._id,
        username: empleado.username,
        nombre: empleado.nombre || "",
        role: empleado.role,
        ultimaActividad: empleado.ultimaActividad || null,
        horarioLaboral: empleado.horarioLaboral || {},
        horarioEfectivo: {
          entrada: horarioEfectivo.entrada,
          salida: horarioEfectivo.salida,
          bloquesHorario: horarioEfectivo.bloquesHorario || [],
          jornadaPartida: horarioEfectivo.jornadaPartida,
          toleranciaMinutos: horarioEfectivo.toleranciaMinutos,
          etiqueta: horarioEfectivo.etiqueta,
          cambioTemporal: horarioEfectivo.cambioHorario,
          licenciaMedica: horarioEfectivo.licenciaMedica,
          horarioLibre: horarioEfectivo.horarioLibre,
          minutosProgramadosHoy,
          minutosExigiblesHoy,
        },
        actividadGestiones: {
          primeraGestion: actividad?.primeraGestion || "",
          ultimaGestion: actividad?.ultimaGestion || "",
          minutosFranja: Number(actividad?.minutosFranja || 0),
          minutosTrabajadosHoy,
          diferenciaHoyMin,
          jornadaIniciada,
          jornadaFinalizada,
          enDescansoProgramado,
          minutosSinGestion,
          gestiones: Number(actividad?.gestiones || 0),
          baches30: baches30Ajustados,
          baches60: baches60Ajustados,
          bacheMaximoMin: bacheMaximoAjustado,
          breakPermitidoMin: ajusteBreak.permitidoMin || minutosBreakFlexiblePermitido(horarioEfectivo),
          breakConsiderado: ajusteBreak.breakDetalle ? {
            desdeMin: ajusteBreak.breakDetalle.desdeMin,
            hastaMin: ajusteBreak.breakDetalle.hastaMin,
            duracionOriginalMin: ajusteBreak.breakDetalle.duracionOriginalMin,
            breakConsideradoMin: ajusteBreak.breakDetalle.breakConsideradoMin,
            excedenteMin: ajusteBreak.breakDetalle.excedenteMin,
            actual: Boolean(ajusteBreak.breakDetalle.actual),
          } : null,
        },
        novedadDia: novedadDia
          ? {
              tipo: novedadDia.tipo,
              descripcion: novedadDia.descripcion || "",
              justificado: Boolean(novedadDia.justificado || novedadDia.tipo === "falta-justificada" || ["licencia-medica", "vacaciones"].includes(novedadDia.tipo)),
            }
          : null,
        fichaje: {
          estado: asistencia?.estado || "sin-fichar",
          entrada: primeraMarca(marcas, "entrada"),
          salida: ultimaMarca(marcas, "salida"),
          motivoSalida: ultimaSalida?.motivo || "",
          cierrePendienteHasta: asistencia?.cierrePendienteHasta || null,
          marcas,
        },
      };
    });

    items.sort((a, b) => {
      const aLicencia = Boolean(["licencia-medica", "vacaciones"].includes(a?.novedadDia?.tipo) || a?.horarioEfectivo?.licenciaMedica);
      const bLicencia = Boolean(["licencia-medica", "vacaciones"].includes(b?.novedadDia?.tipo) || b?.horarioEfectivo?.licenciaMedica);
      if (aLicencia !== bLicencia) return aLicencia ? 1 : -1;
      return String(a?.username || "").localeCompare(String(b?.username || ""), "es", { sensitivity: "base" });
    });

    return res.json({
      ok: true,
      fechaClave,
      cierreAutomatico: HORA_CIERRE_AUTOMATICO,
      fuenteActividad: "reporte-gestiones",
      items,
    });
  } catch (error) {
    console.error("Panel presentismo:", error);
    return res.status(500).json({ error: "No se pudo cargar el panel de presentismo" });
  }
}

export async function actualizarHorario(req, res) {
  try {
    const { empleadoId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(empleadoId)) {
      return res.status(400).json({ error: "Empleado inválido" });
    }

    const horarioLaboral = limpiarHorario(req.body?.horarioLaboral || req.body || {});
    const empleado = await Empleado.findByIdAndUpdate(
      empleadoId,
      { $set: { horarioLaboral } },
      { new: true, runValidators: true }
    )
      .select("username nombre role horarioLaboral ultimaActividad")
      .lean();

    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });

    invalidateSeguimientoCache();
    return res.json({ ok: true, empleado });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      error: error?.message || "No se pudo actualizar el horario laboral",
    });
  }
}
