import mongoose from "mongoose";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import Capacitacion from "../models/Capacitacion.js";
import AuditoriaContactoDirecto from "../models/AuditoriaContactoDirecto.js";
import Empleado from "../models/Empleado.js";
import AgendaItem from "../models/AgendaItem.js";

const ESTADOS_ACTIVOS = ["PENDIENTE", "EN_CAPACITACION"];
const ESTADOS_REALIZADOS = ["REALIZADA", "REQUIERE_SEGUIMIENTO", "CERRADA"];

const MOTIVOS = [
  ["AUDITORIA_CALIDAD", "Auditoría de calidad"],
  ["REPORTE_GESTIONES", "Reporte de gestiones"],
  ["SEGUIMIENTO_ANTERIOR", "Seguimiento anterior"],
  ["CONSULTA_OPERADOR", "Consulta del operador"],
  ["CAPACITACION_SISTEMA", "Capacitación de sistema"],
  ["REFUERZO_GENERAL", "Refuerzo general"],
  ["INGRESO_OPERADOR", "Ingreso de operador"],
  ["PEDIDO_SUPERVISION", "Pedido de supervisión"],
  ["OTRO", "Otro"],
].map(([value, label]) => ({ value, label }));

const TEMAS_GESTION = [
  ["PRESENTACION", "Presentación"],
  ["INDAGACION", "Indagación / motivo de atraso"],
  ["NEGOCIACION", "Negociación"],
  ["OBJECIONES", "Manejo de objeciones"],
  ["MAXIMO_POSIBLE", "Solicitud del máximo posible"],
  ["PROPUESTA", "Propuesta / alternativas"],
  ["CIERRE", "Cierre"],
  ["COMPROMISO_PAGO", "Compromiso de pago"],
  ["SEGUIMIENTO", "Seguimiento"],
  ["REGISTRO_GESTION", "Registro de gestión"],
  ["BUSQUEDA_BARRIDO", "Búsqueda / barrido"],
  ["CALIDAD_COMUNICACION", "Calidad de comunicación"],
].map(([value, label]) => ({ value, label }));

const HERRAMIENTAS = [
  ["MANGO", "Mango"],
  ["CERTERO", "Certero"],
  ["INFORMES_DIGITALES", "Informes Digitales"],
  ["COBRINA", "Cobrina"],
  ["OTRA", "Otra herramienta"],
].map(([value, label]) => ({ value, label }));

const MATERIALES = [
  "Auditoría",
  "Audio",
  "Reporte de gestiones",
  "Caso real en Mango",
  "Certero",
  "Informes Digitales",
  "Role play",
  "Ejemplo práctico",
  "Material teórico",
];

const AREAS_DUDAS = ["MANGO", "CERTERO", "INFORMES_DIGITALES", "COBRINA", "PROCEDIMIENTO", "NEGOCIACION", "OTRO"];
const DERIVACIONES = ["SUPERVISION", "ADMINISTRACION", "SISTEMAS", "AUDITORIA", "JEFATURA", "OTRO"];

function cleanText(value, max = 12000) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanArray(values, maxItems = 100, maxLen = 200) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((v) => cleanText(v, maxLen)).filter(Boolean))].slice(0, maxItems);
}

function safeDate(value, fallback = null) {
  if (!value) return fallback;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function startOfDay(value) {
  const d = safeDate(value);
  if (!d) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function endOfDay(value) {
  const d = startOfDay(value);
  return d ? new Date(d.getTime() + 86399999) : null;
}

function startOfCurrentMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function endOfCurrentMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1);
}

function formatDateAR(value) {
  const d = safeDate(value);
  if (!d) return "—";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function formatMinutes(value) {
  const mins = Math.max(0, Number(value) || 0);
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (!h) return `${m} min`;
  return `${h} h ${String(m).padStart(2, "0")} min`;
}

function labelFrom(list, key, fallback = "") {
  return list.find((x) => x.value === key)?.label || fallback || key || "";
}

function displayUsername(op) {
  return op?.nombre || op?.username || "—";
}

function calcDuration(horaInicio, horaFin, explicitValue = null) {
  const explicit = Number(explicitValue);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.min(1440, Math.round(explicit));
  const parse = (raw) => {
    const m = String(raw || "").match(/^(\d{2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const a = parse(horaInicio);
  const b = parse(horaFin);
  if (a == null || b == null || b < a) return 0;
  return b - a;
}

async function resolveOperators(raw) {
  const entries = Array.isArray(raw) ? raw : [];
  const usernames = [...new Set(entries.map((x) => cleanText(typeof x === "string" ? x : x?.username, 120).toLowerCase()).filter(Boolean))].slice(0, 40);
  if (!usernames.length) throw new Error("Elegí al menos un operador.");

  const empleados = await Empleado.find({ username: { $in: usernames }, isActive: { $ne: false } })
    .select("username nombre")
    .lean();
  const byUsername = new Map(empleados.map((x) => [String(x.username).toLowerCase(), x]));
  const missing = usernames.filter((u) => !byUsername.has(u));
  if (missing.length) throw new Error(`No se encontraron usuarios activos: ${missing.join(", ")}`);

  return usernames.map((username) => ({
    username,
    nombre: cleanText(byUsername.get(username)?.nombre, 160),
  }));
}

function agendaFechaValida(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function agendaHoraValida(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "").trim());
}

async function sincronizarAgendaCapacitacion(doc, req, rawAgenda) {
  if (rawAgenda === undefined) return;

  const fechaClave = cleanText(rawAgenda?.fechaClave, 10);
  const hora = cleanText(rawAgenda?.hora, 5);
  const avisarMinutosAntes = Math.max(0, Math.min(1440, Math.round(Number(rawAgenda?.avisarMinutosAntes ?? 15) || 15)));

  if ((!fechaClave && hora) || (fechaClave && !hora) ||
      ((fechaClave || hora) && (!agendaFechaValida(fechaClave) || !agendaHoraValida(hora)))) {
    throw new Error("Para programar la devolución indicá fecha y hora válidas.");
  }

  // Eliminamos cualquier cita anterior vinculada a este pendiente antes de recrearla.
  if (doc?._id) {
    await AgendaItem.deleteMany({ origenSistema: "capacitacion", referenciaId: doc._id });
  }

  if (!fechaClave && !hora) {
    doc.agendaProgramada = {
      fechaClave: "",
      hora: "",
      avisarMinutosAntes: 15,
      agendaItemIds: [],
      actualizadaPorUsername: cleanText(req.user?.username, 120).toLowerCase(),
    };
    return;
  }

  const usernames = [...new Set([
    ...(doc.operadores || []).map((op) => cleanText(op?.username, 120).toLowerCase()),
    cleanText(doc.capacitadoraUsername, 120).toLowerCase(),
  ].filter(Boolean))];

  const empleados = await Empleado.find({
    username: { $in: usernames },
    isActive: { $ne: false },
  }).select("_id username nombre role").lean();

  const operatorNames = (doc.operadores || []).map((op) => op?.nombre || op?.username).filter(Boolean).join(", ");
  const trainer = empleados.find((e) => String(e.username || "").toLowerCase() === String(doc.capacitadoraUsername || "").toLowerCase());
  const trainerLabel = trainer?.nombre || trainer?.username || doc.capacitadoraUsername || "Capacitadora";
  const titulo = `Capacitación programada · ${operatorNames || "operador"}`.slice(0, 180);

  const creados = empleados.length
    ? await AgendaItem.insertMany(empleados.map((empleado) => ({
        propietario: empleado._id,
        creadoPor: req.user?.id || null,
        creadoPorUsername: cleanText(req.user?.username, 80).toLowerCase(),
        fechaClave,
        hora,
        titulo,
        detalle: `Devolución / capacitación programada. Capacitadora: ${trainerLabel}. Aviso 15 minutos antes.`.slice(0, 1200),
        tipo: "reunion",
        completada: false,
        avisarMinutosAntes,
        origenSistema: "capacitacion",
        referenciaId: doc._id,
      })), { ordered: true })
    : [];

  doc.agendaProgramada = {
    fechaClave,
    hora,
    avisarMinutosAntes,
    agendaItemIds: creados.map((item) => item._id),
    actualizadaPorUsername: cleanText(req.user?.username, 120).toLowerCase(),
  };
}

function normalizeTemaItems(raw, catalog) {
  if (!Array.isArray(raw)) return [];
  const allowed = new Map(catalog.map((x) => [x.value, x.label]));
  const out = [];
  for (const item of raw) {
    const clave = cleanText(typeof item === "string" ? item : item?.clave, 80).toUpperCase();
    if (!clave || !allowed.has(clave) || out.some((x) => x.clave === clave)) continue;
    out.push({
      clave,
      label: allowed.get(clave),
      detalle: cleanText(item?.detalle, 3000),
    });
  }
  return out;
}

function normalizeDudas(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 30).map((d) => {
    const duda = cleanText(d?.duda, 4000);
    if (!duda) return null;
    const area = AREAS_DUDAS.includes(String(d?.area || "").toUpperCase()) ? String(d.area).toUpperCase() : "OTRO";
    const resolucion = ["RESUELTA", "PARCIAL", "PENDIENTE"].includes(String(d?.resolucion || "").toUpperCase())
      ? String(d.resolucion).toUpperCase()
      : "RESUELTA";
    const derivarA = DERIVACIONES.includes(String(d?.derivarA || "").toUpperCase()) ? String(d.derivarA).toUpperCase() : "";
    return { area, duda, resolucion, derivarA, respuesta: cleanText(d?.respuesta, 4000) };
  }).filter(Boolean);
}

function normalizeCompromisos(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 30).map((c) => {
    const texto = cleanText(c?.texto, 4000);
    if (!texto) return null;
    const responsableRaw = String(c?.responsable || "OPERADOR").toUpperCase();
    const responsable = ["OPERADOR", "CAPACITADORA", "SUPERVISION", "SISTEMAS", "OTRO"].includes(responsableRaw)
      ? responsableRaw
      : "OPERADOR";
    return {
      texto,
      responsable,
      fechaObjetivo: safeDate(c?.fechaObjetivo),
      requiereSeguimiento: Boolean(c?.requiereSeguimiento),
      cumplido: Boolean(c?.cumplido),
    };
  }).filter(Boolean);
}

function updateStateFromPayload(doc, payload, mode = "save") {
  if (mode === "draft") {
    doc.estado = "EN_CAPACITACION";
    doc.cerradaAt = null;
    return;
  }
  if (mode === "pending") {
    doc.estado = "PENDIENTE";
    doc.cerradaAt = null;
    return;
  }
  const requiere = Boolean(doc.requiereSeguimiento);
  doc.estado = requiere ? "REQUIERE_SEGUIMIENTO" : "CERRADA";
  doc.cerradaAt = new Date();
}

async function applyPayload(doc, body, req, { mode = "save", preserveAssignment = true } = {}) {
  if (body.operadores !== undefined || body.operadoresUsername !== undefined) {
    const rawOps = body.operadores ?? body.operadoresUsername;
    const values = Array.isArray(rawOps) ? rawOps : [rawOps];
    doc.operadores = await resolveOperators(values);
  }

  const tipo = String(body.tipoCapacitacion || doc.tipoCapacitacion || "INDIVIDUAL").toUpperCase();
  doc.tipoCapacitacion = tipo === "GRUPAL" ? "GRUPAL" : "INDIVIDUAL";
  if (doc.tipoCapacitacion === "INDIVIDUAL" && doc.operadores.length > 1) doc.operadores = [doc.operadores[0]];

  const modalidad = String(body.modalidad || doc.modalidad || "PRESENCIAL").toUpperCase();
  doc.modalidad = ["PRESENCIAL", "MEET", "TELEFONICA", "OTRA"].includes(modalidad) ? modalidad : "OTRA";

  if (body.fechaCapacitacion !== undefined) doc.fechaCapacitacion = safeDate(body.fechaCapacitacion, doc.fechaCapacitacion || new Date());
  if (body.horaInicio !== undefined) doc.horaInicio = cleanText(body.horaInicio, 5);
  if (body.horaFin !== undefined) doc.horaFin = cleanText(body.horaFin, 5);
  doc.duracionMinutos = calcDuration(doc.horaInicio, doc.horaFin, body.duracionMinutos);

  if (body.motivos !== undefined) doc.motivos = cleanArray(body.motivos, 20, 80).map((x) => x.toUpperCase());
  if (body.origen !== undefined) {
    const origen = String(body.origen || "GENERAL").toUpperCase();
    doc.origen = ["AUDITORIA", "REPORTE_GESTIONES", "SEGUIMIENTO", "CONSULTA_OPERADOR", "SUPERVISION", "GENERAL", "OTRO"].includes(origen) ? origen : "OTRO";
  }
  if (body.notaAsignacion !== undefined) doc.notaAsignacion = cleanText(body.notaAsignacion, 6000);
  if (body.focosAsignados !== undefined) doc.focosAsignados = cleanArray(body.focosAsignados, 30, 300);
  if (body.periodoGestiones !== undefined) {
    doc.periodoGestiones = {
      desde: safeDate(body.periodoGestiones?.desde),
      hasta: safeDate(body.periodoGestiones?.hasta),
    };
  }

  if (body.temasGestion !== undefined) doc.temasGestion = normalizeTemaItems(body.temasGestion, TEMAS_GESTION);
  if (body.herramientas !== undefined) doc.herramientas = normalizeTemaItems(body.herramientas, HERRAMIENTAS);
  if (body.materiales !== undefined) doc.materiales = cleanArray(body.materiales, 30, 120);

  const recepcion = String(body.recepcion ?? doc.recepcion ?? "").toUpperCase();
  if (["", "MUY_RECEPTIVO", "RECEPTIVO", "NEUTRAL", "RESISTENCIA", "NO_ACUERDO"].includes(recepcion)) doc.recepcion = recepcion;
  const participacion = String(body.participacion ?? doc.participacion ?? "").toUpperCase();
  if (["", "ALTA", "MEDIA", "BAJA"].includes(participacion)) doc.participacion = participacion;
  const comprension = String(body.comprension ?? doc.comprension ?? "").toUpperCase();
  if (["", "COMPRENDIO", "PARCIAL", "REQUIERE_REFUERZO"].includes(comprension)) doc.comprension = comprension;
  const reconoce = String(body.reconocePuntos ?? doc.reconocePuntos ?? "").toUpperCase();
  if (["", "SI", "PARCIAL", "NO"].includes(reconoce)) doc.reconocePuntos = reconoce;

  if (body.observacionCapacitadora !== undefined) doc.observacionCapacitadora = cleanText(body.observacionCapacitadora, 12000);
  if (body.hallazgos !== undefined) doc.hallazgos = cleanArray(body.hallazgos, 50, 4000);
  if (body.dudas !== undefined) doc.dudas = normalizeDudas(body.dudas);
  if (body.compromisos !== undefined) doc.compromisos = normalizeCompromisos(body.compromisos);

  if (body.requiereSeguimiento !== undefined) doc.requiereSeguimiento = Boolean(body.requiereSeguimiento);
  if (body.fechaSeguimiento !== undefined) doc.fechaSeguimiento = safeDate(body.fechaSeguimiento);
  if (!doc.requiereSeguimiento) doc.fechaSeguimiento = null;

  if (mode === "draft" || mode === "final" || !preserveAssignment || !doc.capacitadoraUsername) {
    doc.capacitadoraUsername = cleanText(body.capacitadoraUsername || req.user.username, 120).toLowerCase();
  }

  updateStateFromPayload(doc, body, mode);
}

function baseFilterFromQuery(query = {}) {
  const filter = { borrado: { $ne: true } };
  if (String(query.finalizadas || "").toLowerCase() === "true") {
    filter.estado = { $in: ESTADOS_REALIZADOS };
  }
  if (query.estado) filter.estado = String(query.estado).toUpperCase();
  if (query.operador) filter["operadores.username"] = cleanText(query.operador, 120).toLowerCase();
  if (query.capacitadora) filter.capacitadoraUsername = cleanText(query.capacitadora, 120).toLowerCase();
  if (query.origen) filter.origen = String(query.origen).toUpperCase();
  if (query.desde || query.hasta) {
    filter.fechaCapacitacion = {};
    if (query.desde) filter.fechaCapacitacion.$gte = startOfDay(query.desde);
    if (query.hasta) filter.fechaCapacitacion.$lte = endOfDay(query.hasta);
  }
  return filter;
}

function suggestedFocusFromAudit(audit) {
  const suggested = [];
  const scores = audit?.scoreBloques || {};
  const mapping = {
    presentacion: "Presentación",
    negociacion: "Negociación",
    cierre: "Cierre",
    calidad: "Calidad de comunicación",
  };
  for (const [key, label] of Object.entries(mapping)) {
    const value = Number(scores?.[key]);
    if (Number.isFinite(value) && value < 7.5) suggested.push(label);
  }
  if (cleanText(audit?.puntosAMejorar)) suggested.push("Puntos a mejorar de la auditoría");
  return [...new Set(suggested)];
}

function auditSnapshot(audit) {
  return {
    auditoriaId: audit._id,
    fechaAuditoria: audit.fechaAuditoria || null,
    scoreFinal: audit.scoreFinal ?? null,
    semaforo: audit.semaforo || "",
    tipoInterlocutor: audit.tipoInterlocutor || "TITULAR",
    puntosAMejorar: audit.puntosAMejorar || "",
    puntosPositivos: audit.puntosPositivos || "",
    observacionesGenerales: audit.observacionesGenerales || "",
    dnis: [...new Set((audit.items || []).map((x) => cleanText(x?.dni, 40)).filter(Boolean))],
    telefonos: [...new Set((audit.items || []).map((x) => cleanText(x?.telefono, 60)).filter(Boolean))],
  };
}

export async function catalogos(_req, res) {
  return res.json({
    ok: true,
    motivos: MOTIVOS,
    temasGestion: TEMAS_GESTION,
    herramientas: HERRAMIENTAS,
    materiales: MATERIALES,
    areasDudas: AREAS_DUDAS,
    derivaciones: DERIVACIONES,
    estados: ["PENDIENTE", "EN_CAPACITACION", "REALIZADA", "REQUIERE_SEGUIMIENTO", "CERRADA"],
  });
}

export async function crearPendiente(req, res) {
  try {
    const operadores = await resolveOperators(req.body?.operadores ?? req.body?.operadoresUsername ?? []);
    const doc = new Capacitacion({
      operadores,
      capacitadoraUsername: cleanText(req.body?.capacitadoraUsername || req.user.username, 120).toLowerCase(),
      creadaPorUsername: req.user.username,
      asignadaPorUsername: req.user.username,
      fechaCapacitacion: safeDate(req.body?.fechaCapacitacion, new Date()),
      tipoCapacitacion: operadores.length > 1 ? "GRUPAL" : "INDIVIDUAL",
      modalidad: "PRESENCIAL",
      origen: String(req.body?.origen || "SUPERVISION").toUpperCase(),
      motivos: cleanArray(req.body?.motivos || [], 20, 80).map((x) => x.toUpperCase()),
      notaAsignacion: cleanText(req.body?.notaAsignacion, 6000),
      focosAsignados: cleanArray(req.body?.focosAsignados, 30, 300),
      periodoGestiones: {
        desde: safeDate(req.body?.periodoGestiones?.desde),
        hasta: safeDate(req.body?.periodoGestiones?.hasta),
      },
      estado: "PENDIENTE",
    });
    await doc.save();
    if (req.body?.agendaProgramada !== undefined) {
      await sincronizarAgendaCapacitacion(doc, req, req.body.agendaProgramada);
      await doc.save();
    }
    return res.status(201).json({ ok: true, item: doc.toObject() });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "No se pudo crear el pendiente." });
  }
}

export async function editarPendiente(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID inválido." });
    const doc = await Capacitacion.findOne({ _id: req.params.id, borrado: { $ne: true } });
    if (!doc) return res.status(404).json({ error: "Pendiente no encontrado." });
    if (!ESTADOS_ACTIVOS.includes(doc.estado)) {
      return res.status(400).json({ error: "Esta capacitación ya fue cerrada. Editala desde Historial." });
    }

    if (req.body?.operadores !== undefined || req.body?.operadoresUsername !== undefined) {
      const raw = req.body?.operadores ?? req.body?.operadoresUsername;
      const values = Array.isArray(raw) ? raw : [raw];
      doc.operadores = await resolveOperators(values);
      doc.tipoCapacitacion = doc.operadores.length > 1 ? "GRUPAL" : "INDIVIDUAL";
    }

    if (req.body?.capacitadoraUsername !== undefined) {
      const capacitadoraUsername = cleanText(req.body.capacitadoraUsername, 120).toLowerCase();
      if (capacitadoraUsername) {
        const capacitadora = await Empleado.findOne({ username: capacitadoraUsername, isActive: { $ne: false } })
          .select("username role")
          .lean();
        if (!capacitadora) throw new Error("La capacitadora seleccionada no está activa.");
        doc.capacitadoraUsername = capacitadoraUsername;
      }
    }

    if (req.body?.origen !== undefined) {
      const origen = String(req.body.origen || "GENERAL").toUpperCase();
      doc.origen = ["AUDITORIA", "REPORTE_GESTIONES", "SEGUIMIENTO", "CONSULTA_OPERADOR", "SUPERVISION", "GENERAL", "OTRO"].includes(origen)
        ? origen
        : "OTRO";
    }
    if (req.body?.motivos !== undefined) doc.motivos = cleanArray(req.body.motivos, 20, 80).map((x) => x.toUpperCase());
    if (req.body?.notaAsignacion !== undefined) doc.notaAsignacion = cleanText(req.body.notaAsignacion, 6000);
    if (req.body?.focosAsignados !== undefined) doc.focosAsignados = cleanArray(req.body.focosAsignados, 30, 300);
    if (req.body?.periodoGestiones !== undefined) {
      doc.periodoGestiones = {
        desde: safeDate(req.body.periodoGestiones?.desde),
        hasta: safeDate(req.body.periodoGestiones?.hasta),
      };
    }

    // Editar la tarjeta NO inicia ni finaliza la capacitación.
    // Conservamos estado, auditorías vinculadas y todo lo trabajado hasta el momento.
    if (req.body?.agendaProgramada !== undefined) {
      await sincronizarAgendaCapacitacion(doc, req, req.body.agendaProgramada);
    }
    await doc.save();
    return res.json({ ok: true, item: doc.toObject() });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "No se pudo editar el pendiente." });
  }
}

export async function desdeAuditoria(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.auditoriaId)) {
      return res.status(400).json({ error: "Auditoría inválida." });
    }
    const audit = await AuditoriaContactoDirecto.findOne({
      _id: req.params.auditoriaId,
      borrado: { $ne: true },
    }).lean();
    if (!audit) return res.status(404).json({ error: "Auditoría no encontrada." });

    const existing = await Capacitacion.findOne({
      borrado: { $ne: true },
      "auditorias.auditoriaId": audit._id,
    }).sort({ createdAt: -1 });
    if (existing) {
      return res.json({ ok: true, existing: true, item: existing.toObject() });
    }

    const operadores = await resolveOperators([audit.operadorUsername]);
    const doc = new Capacitacion({
      operadores,
      capacitadoraUsername: req.user.username,
      creadaPorUsername: req.user.username,
      asignadaPorUsername: req.user.username,
      fechaCapacitacion: new Date(),
      tipoCapacitacion: "INDIVIDUAL",
      modalidad: "PRESENCIAL",
      estado: "PENDIENTE",
      origen: "AUDITORIA",
      motivos: ["AUDITORIA_CALIDAD"],
      focosAsignados: suggestedFocusFromAudit(audit),
      notaAsignacion: cleanText(audit.puntosAMejorar || audit.observacionesGenerales, 6000),
      materiales: ["Auditoría", "Audio"],
      auditorias: [auditSnapshot(audit)],
    });
    await doc.save();
    return res.status(201).json({ ok: true, existing: false, item: doc.toObject() });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "No se pudo enviar a capacitación." });
  }
}

export async function crear(req, res) {
  try {
    const doc = new Capacitacion({
      operadores: await resolveOperators(req.body?.operadores ?? req.body?.operadoresUsername ?? []),
      capacitadoraUsername: req.user.username,
      creadaPorUsername: req.user.username,
      asignadaPorUsername: req.user.username,
      fechaCapacitacion: new Date(),
    });
    await applyPayload(doc, req.body || {}, req, { mode: req.body?.guardarComoBorrador ? "draft" : "final", preserveAssignment: false });
    await doc.save();
    if (!req.body?.guardarComoBorrador) {
      await AgendaItem.updateMany({ origenSistema: "capacitacion", referenciaId: doc._id }, { $set: { completada: true } });
    }
    return res.status(201).json({ ok: true, item: doc.toObject() });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "No se pudo guardar la capacitación." });
  }
}

export async function editar(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID inválido." });
    const doc = await Capacitacion.findOne({ _id: req.params.id, borrado: { $ne: true } });
    if (!doc) return res.status(404).json({ error: "Capacitación no encontrada." });
    await applyPayload(doc, req.body || {}, req, { mode: req.body?.guardarComoBorrador ? "draft" : "final", preserveAssignment: true });
    await doc.save();
    if (!req.body?.guardarComoBorrador) {
      await AgendaItem.updateMany({ origenSistema: "capacitacion", referenciaId: doc._id }, { $set: { completada: true } });
    }
    return res.json({ ok: true, item: doc.toObject() });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "No se pudo actualizar la capacitación." });
  }
}

export async function listar(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const filter = baseFilterFromQuery(req.query);
    const [total, items] = await Promise.all([
      Capacitacion.countDocuments(filter),
      Capacitacion.find(filter).sort({ fechaCapacitacion: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    return res.json({ ok: true, page, limit, total, items });
  } catch (error) {
    return res.status(500).json({ error: "No se pudo cargar el historial de capacitaciones." });
  }
}

export async function pendientes(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const filter = { ...baseFilterFromQuery(req.query), estado: { $in: ESTADOS_ACTIVOS } };
    const [total, items] = await Promise.all([
      Capacitacion.countDocuments(filter),
      Capacitacion.find(filter).sort({ createdAt: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    return res.json({ ok: true, page, limit, total, items });
  } catch {
    return res.status(500).json({ error: "No se pudieron cargar los pendientes." });
  }
}

export async function seguimientosPendientes(req, res) {
  try {
    const filter = {
      ...baseFilterFromQuery(req.query),
      borrado: { $ne: true },
      requiereSeguimiento: true,
      estado: "REQUIERE_SEGUIMIENTO",
    };
    const items = await Capacitacion.find(filter).sort({ fechaSeguimiento: 1, fechaCapacitacion: 1 }).limit(200).lean();
    return res.json({ ok: true, total: items.length, items });
  } catch {
    return res.status(500).json({ error: "No se pudieron cargar los seguimientos." });
  }
}

export async function detalle(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID inválido." });
    const item = await Capacitacion.findOne({ _id: req.params.id, borrado: { $ne: true } }).lean();
    if (!item) return res.status(404).json({ error: "Capacitación no encontrada." });
    return res.json({ ok: true, item });
  } catch {
    return res.status(500).json({ error: "No se pudo cargar la capacitación." });
  }
}

export async function agregarSeguimiento(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID inválido." });
    const resultado = String(req.body?.resultado || "").toUpperCase();
    if (!["MEJORO", "MEJORA_PARCIAL", "PERSISTE", "SIN_INFO"].includes(resultado)) {
      return res.status(400).json({ error: "Elegí un resultado de seguimiento." });
    }
    const doc = await Capacitacion.findOne({ _id: req.params.id, borrado: { $ne: true } });
    if (!doc) return res.status(404).json({ error: "Capacitación no encontrada." });

    doc.seguimientos.push({
      fecha: safeDate(req.body?.fecha, new Date()),
      resultado,
      observacion: cleanText(req.body?.observacion, 6000),
      realizadoPor: req.user.username,
      auditoriasNuevas: Array.isArray(req.body?.auditoriasNuevas)
        ? req.body.auditoriasNuevas.filter((id) => mongoose.Types.ObjectId.isValid(id)).slice(0, 20)
        : [],
    });

    const mantener = Boolean(req.body?.mantenerSeguimiento) || resultado === "PERSISTE" || resultado === "MEJORA_PARCIAL";
    doc.requiereSeguimiento = mantener;
    doc.fechaSeguimiento = mantener ? safeDate(req.body?.proximaFecha, doc.fechaSeguimiento || new Date()) : null;
    doc.estado = mantener ? "REQUIERE_SEGUIMIENTO" : "CERRADA";
    if (!mantener) doc.cerradaAt = new Date();
    await doc.save();
    return res.json({ ok: true, item: doc.toObject() });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "No se pudo guardar el seguimiento." });
  }
}

export async function borrar(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID inválido." });
    const doc = await Capacitacion.findOneAndUpdate(
      { _id: req.params.id, borrado: { $ne: true } },
      { $set: { borrado: true } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: "Capacitación no encontrada." });
    await AgendaItem.deleteMany({ origenSistema: "capacitacion", referenciaId: doc._id });
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: "No se pudo eliminar la capacitación." });
  }
}

export async function resumen(req, res) {
  try {
    const desde = startOfDay(req.query.desde) || startOfCurrentMonth();
    const hasta = endOfDay(req.query.hasta) || endOfCurrentMonth();
    const base = baseFilterFromQuery(req.query);
    base.fechaCapacitacion = { $gte: desde, $lte: hasta };
    delete base.estado;

    const docs = await Capacitacion.find(base)
      .select("operadores estado duracionMinutos temasGestion herramientas dudas requiereSeguimiento fechaSeguimiento seguimientos")
      .lean();

    const operadores = new Set();
    let realizadas = 0;
    let minutos = 0;
    let seguimientosPeriodo = 0;
    let dudasPendientes = 0;
    const conteoTemas = new Map();
    const conteoDudas = new Map();
    const resultados = { MEJORO: 0, MEJORA_PARCIAL: 0, PERSISTE: 0, SIN_INFO: 0 };

    for (const doc of docs) {
      if (!ESTADOS_REALIZADOS.includes(doc.estado)) continue;

      (doc.operadores || []).forEach((op) => operadores.add(op.username));
      realizadas += 1;
      minutos += Number(doc.duracionMinutos) || 0;
      if (doc.estado === "REQUIERE_SEGUIMIENTO") seguimientosPeriodo += 1;

      for (const item of [...(doc.temasGestion || []), ...(doc.herramientas || [])]) {
        const label = item.label || item.clave;
        conteoTemas.set(label, (conteoTemas.get(label) || 0) + 1);
      }
      for (const duda of doc.dudas || []) {
        if (duda.resolucion !== "RESUELTA") dudasPendientes += 1;
        conteoDudas.set(duda.area, (conteoDudas.get(duda.area) || 0) + 1);
      }
      const last = Array.isArray(doc.seguimientos) && doc.seguimientos.length
        ? doc.seguimientos[doc.seguimientos.length - 1]
        : null;
      if (last?.resultado && Object.prototype.hasOwnProperty.call(resultados, last.resultado)) {
        resultados[last.resultado] += 1;
      }
    }

    const scopeGlobal = { borrado: { $ne: true } };
    if (req.query.operador) scopeGlobal["operadores.username"] = cleanText(req.query.operador, 120).toLowerCase();
    if (req.query.capacitadora) scopeGlobal.capacitadoraUsername = cleanText(req.query.capacitadora, 120).toLowerCase();
    if (req.query.origen) scopeGlobal.origen = String(req.query.origen).toUpperCase();

    const [pendingTotal, seguimientosGlobal] = await Promise.all([
      Capacitacion.countDocuments({ ...scopeGlobal, estado: { $in: ESTADOS_ACTIVOS } }),
      Capacitacion.countDocuments({ ...scopeGlobal, estado: "REQUIERE_SEGUIMIENTO" }),
    ]);

    const top = (map, limit = 8) => [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([label, cantidad]) => ({ label, cantidad }));

    return res.json({
      ok: true,
      periodo: { desde, hasta },
      kpis: {
        realizadas,
        operadores: operadores.size,
        minutos,
        pendientes: pendingTotal,
        seguimientos: seguimientosPeriodo,
        seguimientosPendientes: seguimientosGlobal,
        dudasPendientes,
      },
      topTemas: top(conteoTemas),
      topDudas: top(conteoDudas),
      resultados,
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "No se pudo calcular el resumen." });
  }
}

const ESTADO_PDF_LABELS = {
  PENDIENTE: "Pendiente",
  EN_CAPACITACION: "En capacitación",
  REALIZADA: "Realizada",
  REQUIERE_SEGUIMIENTO: "Requiere seguimiento",
  CERRADA: "Cerrada",
};

const MODALIDAD_PDF_LABELS = {
  PRESENCIAL: "Presencial",
  MEET: "Meet",
  TELEFONICA: "Telefónica",
  OTRA: "Otra",
};

const ORIGEN_PDF_LABELS = {
  AUDITORIA: "Auditoría",
  REPORTE_GESTIONES: "Reporte de gestiones",
  SEGUIMIENTO: "Seguimiento",
  CONSULTA_OPERADOR: "Consulta del operador",
  SUPERVISION: "Supervisión",
  GENERAL: "Refuerzo general",
  OTRO: "Otro",
};

const RECEPCION_PDF_LABELS = {
  MUY_RECEPTIVO: "Muy receptivo",
  RECEPTIVO: "Receptivo",
  NEUTRAL: "Neutral",
  RESISTENCIA: "Con resistencia",
  NO_ACUERDO: "No hubo acuerdo",
};

const PARTICIPACION_PDF_LABELS = { ALTA: "Alta", MEDIA: "Media", BAJA: "Baja" };
const COMPRENSION_PDF_LABELS = { COMPRENDIO: "Comprendió", PARCIAL: "Comprensión parcial", REQUIERE_REFUERZO: "Requiere refuerzo" };
const RECONOCE_PDF_LABELS = { SI: "Sí", PARCIAL: "Parcial", NO: "No" };
const RESPONSABLE_PDF_LABELS = { OPERADOR: "Operador", CAPACITADORA: "Capacitadora", SUPERVISION: "Supervisión", SISTEMAS: "Sistemas", OTRO: "Otro" };
const RESOLUCION_DUDA_PDF_LABELS = { RESUELTA: "Resuelta", PARCIAL: "Parcial", PENDIENTE: "Pendiente" };
const RESULTADO_SEGUIMIENTO_PDF_LABELS = { MEJORO: "Mejoró", MEJORA_PARCIAL: "Mejoró parcialmente", PERSISTE: "Persiste", SIN_INFO: "Sin info suficiente" };

function pdfLabel(map, value, fallback = "—") {
  return map[String(value || "").toUpperCase()] || fallback;
}

function docLine(pdf, label, value, opts = {}) {
  const text = cleanText(value, 15000) || "—";
  pdf.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.size || 7.2).fillColor(opts.color || "#24213a");
  if (label) {
    pdf.font("Helvetica-Bold").text(`${label}: `, { continued: true });
    pdf.font("Helvetica").text(text);
  } else {
    pdf.text(text);
  }
}

function ensurePage(pdf, needed = 90) {
  if (pdf.y + needed > pdf.page.height - 55) pdf.addPage();
}

function sectionTitle(pdf, title, tone = "#6b2be2") {
  ensurePage(pdf, 25);
  pdf.moveDown(0.12);
  const y = pdf.y;
  pdf.save();
  pdf.roundedRect(42, y - 1, pdf.page.width - 84, 15, 5).fillOpacity(1).fill("#fbf7ff");
  pdf.restore();
  pdf.rect(42, y - 1, 3, 15).fill(tone);
  pdf.fillColor("#362246").font("Helvetica-Bold").fontSize(7.4).text(title, 51, y + 3, { lineBreak: false });
  pdf.y = y + 18;
}

function drawSummaryRow(pdf, items) {
  ensurePage(pdf, 42);
  const startY = pdf.y;
  const gap = 6;
  const totalWidth = pdf.page.width - 84;
  const width = (totalWidth - gap * (items.length - 1)) / items.length;
  items.forEach((item, idx) => {
    const x = 42 + idx * (width + gap);
    pdf.save();
    pdf.roundedRect(x, startY, width, 34, 6).fillAndStroke("#ffffff", "#e8dcf8");
    pdf.rect(x, startY, width, 2.5).fill(item.accent || "#6b2be2");
    pdf.fillColor("#796f89").font("Helvetica-Bold").fontSize(5.7).text(item.label, x + 7, startY + 7, { width: width - 14, lineBreak: false });
    pdf.fillColor(item.valueColor || "#392456").font("Helvetica-Bold").fontSize(8.6).text(item.value, x + 7, startY + 17, { width: width - 14, lineBreak: false });
    if (item.note) pdf.fillColor("#8c8299").font("Helvetica").fontSize(5.4).text(item.note, x + 7, startY + 26, { width: width - 14, lineBreak: false });
    pdf.restore();
  });
  pdf.y = startY + 40;
}

function reportHeader(pdf, title, subtitle = "") {
  pdf.rect(0, 0, pdf.page.width, 58).fill("#17114f");
  pdf.rect(0, 58, pdf.page.width, 4).fill("#f4ecff");
  pdf.fillColor("#06d79a").font("Helvetica-Bold").fontSize(7.5).text("COBRINA", 42, 12, { lineBreak: false });
  pdf.fillColor("#ffffff").font("Helvetica-Bold").fontSize(13).text(title, 42, 23, { width: pdf.page.width - 84, lineBreak: false });
  if (subtitle) pdf.font("Helvetica").fontSize(6.2).text(subtitle, 42, 41, { width: pdf.page.width - 84, lineBreak: false });
  pdf.fillColor("#24213a");
  pdf.y = 74;
}

function writeCapacitacionPDF(pdf, item, index = null) {
  ensurePage(pdf, 165);

  const title = item.operadores?.map(displayUsername).join(", ") || "Sin operador";
  const subtitle = item.capacitadoraUsername ? `Capacitadora: ${item.capacitadoraUsername}` : "";
  const headingY = pdf.y;
  pdf.save();
  pdf.roundedRect(42, headingY, pdf.page.width - 84, 25, 7).fillAndStroke("#ffffff", "#e8dcf8");
  pdf.rect(42, headingY, 4, 25).fill("#aa2cf4");
  pdf.restore();
  pdf.fillColor("#3b1ea6").font("Helvetica-Bold").fontSize(9.1).text(index != null ? `${index}. ${title}` : title, 53, headingY + 5, { width: pdf.page.width - 155, lineBreak: false });
  if (subtitle) pdf.fillColor("#7c718e").font("Helvetica").fontSize(6.1).text(subtitle, 53, headingY + 15, { width: pdf.page.width - 170, lineBreak: false });
  pdf.fillColor(item.requiereSeguimiento ? "#b22d61" : "#3b1ea6").font("Helvetica-Bold").fontSize(7.4)
    .text(pdfLabel(ESTADO_PDF_LABELS, item.estado, item.estado || "—"), pdf.page.width - 165, headingY + 8, { width: 105, align: "right", lineBreak: false });
  pdf.y = headingY + 30;

  drawSummaryRow(pdf, [
    { label: "Fecha", value: formatDateAR(item.fechaCapacitacion), accent: "#29154f" },
    { label: "Modalidad", value: pdfLabel(MODALIDAD_PDF_LABELS, item.modalidad, item.modalidad || "—"), accent: "#aa2cf4" },
    { label: "Duración", value: formatMinutes(item.duracionMinutos), accent: "#00b968" },
    { label: "Origen", value: pdfLabel(ORIGEN_PDF_LABELS, item.origen, item.origen || "—"), accent: "#ff00cc" },
  ]);

  if (item.motivos?.length || item.focosAsignados?.length) {
    sectionTitle(pdf, "Motivo y enfoque de la devolución", "#00b968");
    if (item.motivos?.length) docLine(pdf, "Motivos", item.motivos.map((x) => labelFrom(MOTIVOS, x, x)).join(" · "));
    if (item.focosAsignados?.length) docLine(pdf, "Focos asignados", item.focosAsignados.join(" · "));
  }

  const temas = [...(item.temasGestion || []), ...(item.herramientas || [])];
  if (temas.length) {
    sectionTitle(pdf, "Qué se trabajó", "#aa2cf4");
    temas.forEach((t) => {
      ensurePage(pdf, 24);
      pdf.fillColor("#312145").font("Helvetica-Bold").fontSize(7.2).text(`• ${t.label || t.clave}${t.detalle ? ':' : ''}`, { continued: Boolean(t.detalle) });
      if (t.detalle) pdf.font("Helvetica").fillColor("#51495a").text(` ${t.detalle}`);
    });
  }

  if (item.materiales?.length) {
    sectionTitle(pdf, "Material utilizado", "#29154f");
    pdf.font("Helvetica").fontSize(7.0).fillColor("#51495a").text(item.materiales.join(" · "), { lineGap: 0 });
  }

  if (item.recepcion || item.comprension || item.participacion || item.reconocePuntos) {
    sectionTitle(pdf, "Resultado de la devolución", "#ff00cc");
    drawSummaryRow(pdf, [
      { label: "Recepción", value: pdfLabel(RECEPCION_PDF_LABELS, item.recepcion, item.recepcion || "—"), accent: "#ff00cc" },
      { label: "Participación", value: pdfLabel(PARTICIPACION_PDF_LABELS, item.participacion, item.participacion || "—"), accent: "#aa2cf4" },
      { label: "Comprensión", value: pdfLabel(COMPRENSION_PDF_LABELS, item.comprension, item.comprension || "—"), accent: "#00b968" },
      { label: "Reconoce puntos", value: pdfLabel(RECONOCE_PDF_LABELS, item.reconocePuntos, item.reconocePuntos || "—"), accent: "#29154f" },
    ]);
  }

  if (item.observacionCapacitadora) {
    sectionTitle(pdf, "Observación de la capacitadora", "#29154f");
    pdf.font("Helvetica").fontSize(7.1).fillColor("#4f4657").text(item.observacionCapacitadora, { lineGap: 1 });
  }

  if (item.dudas?.length) {
    sectionTitle(pdf, "Dudas del operador", "#aa2cf4");
    item.dudas.forEach((d) => {
      ensurePage(pdf, 34);
      pdf.font("Helvetica-Bold").fontSize(7.0).fillColor("#322247").text(`• ${pdfLabel({ MANGO: "Mango", CERTERO: "Certero", INFORMES_DIGITALES: "Informes Digitales", COBRINA: "Cobrina", PROCEDIMIENTO: "Procedimiento", NEGOCIACION: "Negociación", OTRO: "Otro" }, d.area, d.area)} · ${pdfLabel(RESOLUCION_DUDA_PDF_LABELS, d.resolucion, d.resolucion)}`);
      pdf.font("Helvetica").fontSize(7.0).fillColor("#51495a").text(d.duda);
      if (d.respuesta) pdf.font("Helvetica").fontSize(6.8).fillColor("#7b7187").text(`Respuesta / aclaración: ${d.respuesta}`);
    });
  }

  if (item.hallazgos?.length) {
    sectionTitle(pdf, "Situaciones relevantes detectadas", "#00b968");
    item.hallazgos.forEach((x) => pdf.font("Helvetica").fontSize(7.0).fillColor("#51495a").text(`• ${x}`));
  }

  if (item.compromisos?.length) {
    sectionTitle(pdf, "Compromisos y seguimiento", "#ff00cc");
    item.compromisos.forEach((c) => {
      ensurePage(pdf, 30);
      const extra = [pdfLabel(RESPONSABLE_PDF_LABELS, c.responsable, c.responsable), c.fechaObjetivo ? formatDateAR(c.fechaObjetivo) : ""].filter(Boolean).join(" · ");
      pdf.font("Helvetica-Bold").fontSize(7.0).fillColor("#322247").text(`• ${c.texto}`);
      if (extra) pdf.font("Helvetica").fontSize(6.7).fillColor("#7b7187").text(`  ${extra}${c.requiereSeguimiento ? " · Requiere control" : ""}`);
    });
  }

  if (item.requiereSeguimiento) {
    ensurePage(pdf, 40);
    pdf.moveDown(0.35);
    pdf.roundedRect(42, pdf.y, pdf.page.width - 84, 20, 7).fillAndStroke("#fff5fa", "#f2c4d4");
    pdf.fillColor("#b22d61").font("Helvetica-Bold").fontSize(7.0).text(`Requiere seguimiento${item.fechaSeguimiento ? ` · fecha sugerida ${formatDateAR(item.fechaSeguimiento)}` : ""}`, 51, pdf.y + 6, { lineBreak: false });
    pdf.y += 26;
  }

  if (item.seguimientos?.length) {
    sectionTitle(pdf, "Seguimientos registrados", "#29154f");
    item.seguimientos.forEach((s) => {
      ensurePage(pdf, 34);
      pdf.font("Helvetica-Bold").fontSize(7.9).fillColor("#322247").text(`${formatDateAR(s.fecha)} · ${pdfLabel(RESULTADO_SEGUIMIENTO_PDF_LABELS, s.resultado, s.resultado)}`);
      if (s.observacion) pdf.font("Helvetica").fontSize(7.8).fillColor("#51495a").text(s.observacion);
    });
  }

  pdf.moveDown(0.35);
}

function truncatePdfText(value, max = 180) {
  const text = cleanText(value, 10000);
  return text.length > max ? `${text.slice(0, max - 3).trim()}...` : text;
}

function countEntries(items, getter) {
  const map = new Map();
  for (const item of items) {
    const values = getter(item);
    const list = Array.isArray(values) ? values : [values];
    for (const raw of list) {
      const value = cleanText(raw, 200);
      if (!value) continue;
      map.set(value, (map.get(value) || 0) + 1);
    }
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
}

function drawDailyActivity(pdf, items) {
  const rows = countEntries(items, (item) => formatDateAR(item.fechaCapacitacion)).sort((a, b) => {
    const [da, ma, ya] = a.label.split("/").map(Number);
    const [db, mb, yb] = b.label.split("/").map(Number);
    return new Date(ya, ma - 1, da) - new Date(yb, mb - 1, db);
  });
  sectionTitle(pdf, "Capacitaciones realizadas por día", "#aa2cf4");
  if (!rows.length) {
    pdf.font("Helvetica").fontSize(8).fillColor("#766b86").text("Sin capacitaciones finalizadas en el período.");
    return;
  }
  ensurePage(pdf, 118);
  const x = 52;
  const y = pdf.y + 5;
  const width = pdf.page.width - 104;
  const height = 84;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const gap = rows.length > 20 ? 3 : 5;
  const barWidth = Math.max(7, Math.min(22, (width - gap * (rows.length - 1)) / rows.length));
  const usedWidth = barWidth * rows.length + gap * (rows.length - 1);
  const startX = x + Math.max(0, (width - usedWidth) / 2);

  pdf.save();
  pdf.roundedRect(42, y - 7, pdf.page.width - 84, height + 31, 9).fillAndStroke("#ffffff", "#eadcff");
  pdf.strokeColor("#eee7f6").moveTo(52, y + height).lineTo(pdf.page.width - 52, y + height).stroke();
  rows.forEach((row, idx) => {
    const h = Math.max(5, (row.value / max) * 62);
    const bx = startX + idx * (barWidth + gap);
    const by = y + height - h;
    pdf.roundedRect(bx, by, barWidth, h, 3).fill("#b078f6");
    pdf.fillColor("#5c2d94").font("Helvetica-Bold").fontSize(6.2).text(String(row.value), bx - 2, by - 10, { width: barWidth + 4, align: "center", lineBreak: false });
    const label = row.label.slice(0, 5);
    pdf.fillColor("#8b8096").font("Helvetica").fontSize(5.6).text(label, bx - 8, y + height + 5, { width: barWidth + 16, align: "center", lineBreak: false });
  });
  pdf.restore();
  pdf.y = y + height + 31;
}

function drawBarPanel(pdf, { x, y, width, title, subtitle = "", rows = [], tone = "#aa2cf4", maxRows = 6 }) {
  const selected = rows.slice(0, maxRows);
  const rowH = 24;
  const headerH = subtitle ? 42 : 32;
  const height = headerH + Math.max(1, selected.length) * rowH + 12;
  pdf.save();
  pdf.roundedRect(x, y, width, height, 9).fillAndStroke("#ffffff", "#eadcff");
  pdf.rect(x, y, width, 3).fill(tone);
  pdf.fillColor("#3d2854").font("Helvetica-Bold").fontSize(8.6).text(title, x + 10, y + 10, { width: width - 20 });
  if (subtitle) pdf.fillColor("#84798f").font("Helvetica").fontSize(6.4).text(subtitle, x + 10, y + 23, { width: width - 20 });
  const max = Math.max(1, ...selected.map((r) => r.value));
  let cy = y + headerH;
  if (!selected.length) {
    pdf.fillColor("#8b8096").font("Helvetica").fontSize(7.3).text("Sin datos para el período.", x + 10, cy + 4, { width: width - 20 });
  } else {
    selected.forEach((row, idx) => {
      const label = truncatePdfText(row.label, 34);
      pdf.fillColor("#51475a").font("Helvetica").fontSize(6.8).text(`${idx + 1}. ${label}`, x + 10, cy, { width: width - 48, lineBreak: false });
      pdf.fillColor("#5f269f").font("Helvetica-Bold").fontSize(6.8).text(String(row.value), x + width - 34, cy, { width: 24, align: "right", lineBreak: false });
      const trackY = cy + 12;
      pdf.roundedRect(x + 10, trackY, width - 20, 5, 2).fill("#f0e8fa");
      pdf.roundedRect(x + 10, trackY, Math.max(5, ((width - 20) * row.value) / max), 5, 2).fill(tone);
      cy += rowH;
    });
  }
  pdf.restore();
  return height;
}

function writeCompactReportRow(pdf, item, index) {
  ensurePage(pdf, 74);
  const y = pdf.y;
  const width = pdf.page.width - 84;
  const temas = [...(item.temasGestion || []), ...(item.herramientas || [])].map((x) => x.label || x.clave).filter(Boolean);
  const follow = item.requiereSeguimiento ? `Seguimiento${item.fechaSeguimiento ? ` ${formatDateAR(item.fechaSeguimiento)}` : ""}` : "Sin seguimiento";
  pdf.save();
  pdf.roundedRect(42, y, width, 61, 8).fillAndStroke("#ffffff", "#eae1f3");
  pdf.rect(42, y, 4, 61).fill(item.requiereSeguimiento ? "#ff00aa" : "#00b968");
  pdf.fillColor("#3b1ea6").font("Helvetica-Bold").fontSize(8.4).text(`${index}. ${item.operadores?.map(displayUsername).join(", ") || "Sin operador"}`, 54, y + 8, { width: 225, lineBreak: false });
  pdf.fillColor("#776d82").font("Helvetica").fontSize(6.7).text(`${formatDateAR(item.fechaCapacitacion)} · ${pdfLabel(MODALIDAD_PDF_LABELS, item.modalidad, item.modalidad || "—")} · ${formatMinutes(item.duracionMinutos)}`, 54, y + 21, { width: 260, lineBreak: false });
  pdf.fillColor("#5b5065").font("Helvetica").fontSize(6.8).text(truncatePdfText(temas.join(" · ") || "Sin temas registrados", 115), 54, y + 34, { width: width - 190, lineBreak: false });
  if (item.observacionCapacitadora) pdf.fillColor("#8b8096").font("Helvetica").fontSize(6.2).text(`Obs.: ${truncatePdfText(item.observacionCapacitadora, 95)}`, 54, y + 47, { width: width - 190, lineBreak: false });
  pdf.fillColor(item.requiereSeguimiento ? "#b22d61" : "#14745a").font("Helvetica-Bold").fontSize(6.8).text(follow, pdf.page.width - 180, y + 10, { width: 126, align: "right" });
  pdf.fillColor("#5c5066").font("Helvetica").fontSize(6.6).text(RECEPCION_PDF_LABELS[item.recepcion] || "Recepción sin registrar", pdf.page.width - 180, y + 27, { width: 126, align: "right" });
  pdf.restore();
  pdf.y = y + 68;
}

function addPdfFooters(pdf, label = "COBRINA · Capacitación") {
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    pdf.switchToPage(i);
    pdf.save();
    const previousBottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf.font("Helvetica").fontSize(5.8).fillColor("#8b849a").text(`${label} · ${i + 1}/${range.count}`, 42, pdf.page.height - 15, { align: "right", width: pdf.page.width - 84, lineBreak: false });
    pdf.page.margins.bottom = previousBottom;
    pdf.restore();
  }
}

export async function exportarPDF(req, res) {
  try {
    const filter = baseFilterFromQuery(req.query);
    if (!req.query.estado) filter.estado = { $in: ESTADOS_REALIZADOS };
    const items = await Capacitacion.find(filter).sort({ fechaCapacitacion: 1 }).lean();

    const desde = req.query.desde ? formatDateAR(req.query.desde) : "inicio";
    const hasta = req.query.hasta ? formatDateAR(req.query.hasta) : "hoy";
    const pdf = new PDFDocument({ size: "A4", margin: 42, bufferPages: true, info: { Title: "Reporte de capacitaciones COBRINA" } });
    const filename = `capacitaciones_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
    pdf.pipe(res);
    reportHeader(pdf, "Reporte de Capacitación y Seguimiento", `Período ${desde} a ${hasta} · generado ${formatDateAR(new Date())}`);

    const uniqueOps = new Set(items.flatMap((x) => (x.operadores || []).map((o) => o.username)));
    const minutes = items.reduce((acc, x) => acc + (Number(x.duracionMinutos) || 0), 0);
    const followPending = items.filter((x) => x.requiereSeguimiento).length;
    const openQuestions = items.reduce((acc, x) => acc + (x.dudas || []).filter((d) => d.resolucion !== "RESUELTA").length, 0);

    drawSummaryRow(pdf, [
      { label: "Capacitaciones", value: String(items.length), accent: "#29154f" },
      { label: "Operadores", value: String(uniqueOps.size), accent: "#aa2cf4" },
      { label: "Tiempo trabajado", value: formatMinutes(minutes), accent: "#00b968" },
      { label: "Seguimientos", value: String(followPending), accent: "#ff00cc", note: openQuestions ? `${openQuestions} dudas abiertas` : "sin dudas abiertas" },
    ]);

    if (!items.length) {
      sectionTitle(pdf, "Sin datos para exportar", "#aa2cf4");
      pdf.font("Helvetica").fontSize(8.5).fillColor("#51495a").text("No hay capacitaciones finalizadas para los filtros seleccionados.");
      addPdfFooters(pdf, "COBRINA · Reporte de Capacitación");
      pdf.end();
      return;
    }

    drawDailyActivity(pdf, items);

    ensurePage(pdf, 190);
    sectionTitle(pdf, "Lectura general del período", "#29154f");
    const temas = countEntries(items, (item) => [...(item.temasGestion || []), ...(item.herramientas || [])].map((x) => x.label || x.clave));
    const recepciones = countEntries(items, (item) => RECEPCION_PDF_LABELS[item.recepcion] || "Sin registrar");
    const dudas = countEntries(items, (item) => (item.dudas || []).map((d) => pdfLabel({ MANGO: "Mango", CERTERO: "Certero", INFORMES_DIGITALES: "Informes Digitales", COBRINA: "Cobrina", PROCEDIMIENTO: "Procedimiento", NEGOCIACION: "Negociación", OTRO: "Otro" }, d.area, d.area)));

    const panelY = pdf.y + 3;
    const gap = 10;
    const panelW = (pdf.page.width - 84 - gap) / 2;
    const h1 = drawBarPanel(pdf, { x: 42, y: panelY, width: panelW, title: "Temas más trabajados", subtitle: "Refuerzos que más aparecieron en las devoluciones", rows: temas, tone: "#aa2cf4", maxRows: 6 });
    const h2 = drawBarPanel(pdf, { x: 42 + panelW + gap, y: panelY, width: panelW, title: "Recepción de la devolución", subtitle: "Cómo recibió el operador la capacitación", rows: recepciones, tone: "#ff00cc", maxRows: 6 });
    pdf.y = panelY + Math.max(h1, h2) + 10;

    if (dudas.length) {
      ensurePage(pdf, 110);
      const h3 = drawBarPanel(pdf, { x: 42, y: pdf.y, width: pdf.page.width - 84, title: "Dudas por área", subtitle: "Consultas surgidas durante las capacitaciones", rows: dudas, tone: "#00b968", maxRows: 7 });
      pdf.y += h3 + 8;
    }

    sectionTitle(pdf, "Detalle de capacitaciones realizadas", "#aa2cf4");
    pdf.fillColor("#81758c").font("Helvetica").fontSize(6.8).text("Resumen por capacitación. El registro completo y editable queda disponible en Historial dentro de COBRINA.");
    pdf.moveDown(0.4);
    items.forEach((item, idx) => writeCompactReportRow(pdf, item, idx + 1));

    addPdfFooters(pdf, "COBRINA · Reporte de Capacitación");
    pdf.end();
  } catch (error) {
    if (!res.headersSent) return res.status(500).json({ error: error?.message || "No se pudo generar el PDF." });
    return res.end();
  }
}

export async function exportarIndividualPDF(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "ID inválido." });
    const item = await Capacitacion.findOne({ _id: req.params.id, borrado: { $ne: true } }).lean();
    if (!item) return res.status(404).json({ error: "Capacitación no encontrada." });
    const pdf = new PDFDocument({ size: "A4", margin: 42, bufferPages: true });
    const filename = `capacitacion_${item.operadores?.[0]?.username || "operador"}_${String(item._id).slice(-6)}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
    pdf.pipe(res);
    reportHeader(pdf, "Informe individual de capacitación", `Registro ${String(item._id)} · generado ${formatDateAR(new Date())}`);
    writeCapacitacionPDF(pdf, item);
    addPdfFooters(pdf, "COBRINA · Registro de Capacitación");
    pdf.end();
  } catch (error) {
    if (!res.headersSent) return res.status(500).json({ error: error?.message || "No se pudo generar el PDF." });
    return res.end();
  }
}

export async function exportarExcel(req, res) {
  try {
    const filter = baseFilterFromQuery(req.query);
    if (!req.query.estado) filter.estado = { $in: ESTADOS_REALIZADOS };
    const items = await Capacitacion.find(filter).sort({ fechaCapacitacion: 1 }).lean();
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Capacitaciones");
    ws.columns = [
      { header: "FECHA", key: "fecha", width: 14 },
      { header: "OPERADOR/ES", key: "operadores", width: 32 },
      { header: "CAPACITADORA", key: "capacitadora", width: 22 },
      { header: "ORIGEN", key: "origen", width: 20 },
      { header: "MOTIVOS", key: "motivos", width: 38 },
      { header: "TEMAS / HERRAMIENTAS", key: "temas", width: 48 },
      { header: "DURACIÓN", key: "duracion", width: 14 },
      { header: "RECEPCIÓN", key: "recepcion", width: 18 },
      { header: "COMPRENSIÓN", key: "comprension", width: 20 },
      { header: "OBSERVACIÓN", key: "observacion", width: 60 },
      { header: "DUDAS", key: "dudas", width: 55 },
      { header: "COMPROMISOS", key: "compromisos", width: 55 },
      { header: "SEGUIMIENTO", key: "seguimiento", width: 24 },
      { header: "ESTADO", key: "estado", width: 22 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const item of items) {
      ws.addRow({
        fecha: formatDateAR(item.fechaCapacitacion),
        operadores: (item.operadores || []).map(displayUsername).join(", "),
        capacitadora: item.capacitadoraUsername,
        origen: item.origen,
        motivos: (item.motivos || []).map((x) => labelFrom(MOTIVOS, x, x)).join(" | "),
        temas: [...(item.temasGestion || []), ...(item.herramientas || [])].map((x) => x.label || x.clave).join(" | "),
        duracion: formatMinutes(item.duracionMinutos),
        recepcion: item.recepcion,
        comprension: item.comprension,
        observacion: item.observacionCapacitadora,
        dudas: (item.dudas || []).map((x) => `${x.area}: ${x.duda} [${x.resolucion}]`).join(" | "),
        compromisos: (item.compromisos || []).map((x) => `${x.texto} (${x.responsable})`).join(" | "),
        seguimiento: item.requiereSeguimiento ? `Sí${item.fechaSeguimiento ? ` · ${formatDateAR(item.fechaSeguimiento)}` : ""}` : "No",
        estado: item.estado,
      });
    }
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.autoFilter = { from: "A1", to: "N1" };
    ws.eachRow((row, idx) => {
      row.alignment = { vertical: "top", wrapText: true };
      if (idx === 1) row.height = 24;
    });
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=\"capacitaciones_${new Date().toISOString().slice(0, 10)}.xlsx\"`);
    return res.send(Buffer.from(buffer));
  } catch (error) {
    return res.status(500).json({ error: error?.message || "No se pudo generar el Excel." });
  }
}
