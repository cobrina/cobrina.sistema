// BACKEND/controllers/auditoriasController.js
import mongoose from "mongoose";
import AuditoriaContactoDirecto from "../models/AuditoriaContactoDirecto.js";
import Empleado from "../models/Empleado.js";
import { toDateOnly, normalizarHora } from "../utils/fecha.util.js";
import {
  CRITERIOS_TITULAR,
  FORMULARIOS_AUDITORIA,
  FORMULARIOS_LEGACY,
  MOTIVOS_NO_AUDITABLE,
  PESOS_AUDITORIA,
  QUIEN_CONDUJO_OPCIONES,
  RESULTADO_COMERCIAL_OPCIONES,
  UMBRALES_AUDITORIA,
  calcularScoresAuditoriaItem,
  crearSnapshotFormulario,
  criterioPorId,
  esTipoInterlocutorVigente,
  formularioAplicadoParaTipo,
  normalizarResultadosItem,
  normalizarTipoInterlocutor,
  semaforoAuditoria,
  valorAplicadoResultado,
  valorResultadoCriterio,
  versionFormularioActual,
} from "../config/auditorias.js";

/* ============================================================
   Helpers (mismo estilo que Reportes)
   ============================================================ */
function attachAbortFlag(req, res) {
  req.__aborted = false;
  res.on("close", () => {
    req.__aborted = true;
  });
}

function throwIfAborted(req) {
  if (req?.aborted || req?.__aborted) {
    const err = new Error("CLIENT_ABORTED");
    err.code = "CLIENT_ABORTED";
    throw err;
  }
}

function getUsuarioId(req) {
  return req?.user?.id || req?.usuario?._id || req?.userId || null;
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

function getUsuarioUsername(req) {
  return req?.user?.username || req?.usuario?.username || null;
}

function ensureNoOperador(req, res) {
  const rol = String(getUsuarioRol(req) || "").toLowerCase();
  if (rol === "operador" || rol === "operador-vip") {
    res.status(403).json({
      error: "Acceso denegado: operadores no tienen acceso a Auditorías.",
    });
    return false;
  }
  return true;
}

function ownerScope(req) {
  const usuarioId = getUsuarioId(req);
  const rol = String(getUsuarioRol(req) || "").toLowerCase();
  const onlyMine =
    String(req?.query?.onlyMine ?? req?.body?.onlyMine ?? "").toLowerCase() ===
    "true";

  if (!usuarioId) return {};
  const isAdminLike =
    ["capacitadora", "administracion", "supervisor", "super-admin"].includes(rol);

  if (isAdminLike && !onlyMine) return {}; // ver todo
  return { propietario: new mongoose.Types.ObjectId(usuarioId) };
}

function diaInicioUTC(raw) {
  const d = toDateOnly(raw);
  if (!d) return null;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
}
function diaFinUTC(raw) {
  const d0 = diaInicioUTC(raw);
  if (!d0) return null;
  return new Date(d0.getTime() + 86399999);
}

/* ============================================================
   Duración (minutos) + compatibilidad con segundos viejos
   ============================================================ */
function round2(n) {
  return Number(Number(n || 0).toFixed(2));
}

function parseDuracionMinutos(it = {}) {
  // ✅ NUEVO formato preferido
  const rawMin = it?.duracionMinutos ?? it?.duracionMin ?? it?.minutos;

  if (rawMin != null && rawMin !== "") {
    const n = Number(String(rawMin).replace(",", "."));
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(480, round2(n))); // 0..8hs
  }

  // ✅ Compatibilidad con lo viejo en segundos
  const rawSeg =
    it?.duracionSegundos ??
    it?.duracionSeconds ??
    it?.segundos ??
    it?.duracion_s ??
    it?.duracionEnSegundos;

  if (rawSeg == null || rawSeg === "") return 0;

  const sec = Number(String(rawSeg).replace(",", "."));
  if (!Number.isFinite(sec)) return 0;

  return Math.max(0, Math.min(480, round2(sec / 60)));
}

function parseDuracionSegundosCompat(it = {}) {
  const mins = parseDuracionMinutos(it);
  return Math.round(mins * 60);
}

function getDuracionMinutosSalida(it = {}) {
  const mins = Number(it?.duracionMinutos);
  if (Number.isFinite(mins) && mins > 0) return round2(mins);

  const seg = Number(it?.duracionSegundos);
  if (Number.isFinite(seg) && seg > 0) return round2(seg / 60);

  return 0;
}

function isLlamada(tipoInteraccion = "") {
  return String(tipoInteraccion || "").toUpperCase().startsWith("LLAMADA");
}

/* ============================================================
   Formularios, resultados y score
   - Las auditorías nuevas usan sólo formularios vigentes.
   - Las históricas conservan su formulario/score y se reconstruyen con V1.
   - NO_APLICA se excluye del cálculo.
   ============================================================ */
const PESOS = PESOS_AUDITORIA;
const UMBRAL_BAJO = UMBRALES_AUDITORIA.bajo;
const UMBRAL_ALTO = UMBRALES_AUDITORIA.alto;

function objectFromMaybeMap(raw) {
  if (raw instanceof Map) return Object.fromEntries(raw);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  return {};
}

function inferirVersionHistorica(base = {}) {
  const explicit = Number(base?.versionFormulario ?? base?.formularioSnapshot?.version);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const key = String(base?.formularioAplicado || base?.tipoInterlocutor || "TITULAR").toUpperCase();
  if (["TITULAR", "TERCERO", "TERCERO_PAGADOR"].includes(key)) return 1;
  return versionFormularioActual(key) || 1;
}

function formularioSnapshotSalida(base = {}) {
  if (base?.formularioSnapshot?.criterios?.length) return base.formularioSnapshot;
  const key = String(base?.formularioAplicado || formularioAplicadoParaTipo(base?.tipoInterlocutor || "TITULAR")).toUpperCase();
  if (key === "NINGUNO") return null;
  return crearSnapshotFormulario(key, inferirVersionHistorica(base));
}

function esAuditoriaHistoricaProtegida(base = {}) {
  const key = String(base?.formularioAplicado || formularioAplicadoParaTipo(base?.tipoInterlocutor || "TITULAR")).toUpperCase();
  if (key === "NINGUNO") return false;
  if (!base?.formularioSnapshot?.criterios?.length) return true;
  const version = inferirVersionHistorica(base);
  const actual = versionFormularioActual(key);
  if (actual == null) return true;
  return version !== actual;
}

function parseComentariosCriterio(it = {}, criterios = []) {
  const raw = it?.comentariosCriterio ?? it?.comentariosPorCriterio ?? it?.comentarios ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const idsValidos = new Set((criterios || []).map((c) => Number(c.id)));
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const criterioId = Number(key);
    if (!Number.isInteger(criterioId) || !idsValidos.has(criterioId)) continue;
    const txt = String(value ?? "").trim();
    if (!txt) continue;
    out[String(criterioId)] = txt.slice(0, 1000);
  }
  return out;
}

function validarResultadosYComentarios(resultadosCriterios = {}, comentariosCriterio = {}, criterios = [], itemIndex = 0) {
  for (const c of criterios) {
    const estado = valorResultadoCriterio(resultadosCriterios[String(c.id)] ?? resultadosCriterios[c.id]);
    if (estado === "SIN_RESPUESTA") {
      const err = new Error(`Audio #${itemIndex + 1}: falta responder el criterio ${c.id} · ${c.label}.`);
      err.statusCode = 400;
      err.fieldError = { itemIndex, criterioId: c.id, tipo: "respuesta", mensaje: "Seleccioná Sí, Parcial, No o No aplica." };
      throw err;
    }
    if (["PARCIAL", "NO"].includes(estado)) {
      const comentario = String(comentariosCriterio[String(c.id)] ?? comentariosCriterio[c.id] ?? "").trim();
      if (!comentario) {
        const err = new Error(`Audio #${itemIndex + 1}: el criterio ${c.id} requiere comentario al marcar ${estado === "PARCIAL" ? "Parcial" : "No"}.`);
        err.statusCode = 400;
        err.fieldError = { itemIndex, criterioId: c.id, tipo: "comentario", mensaje: `El comentario es obligatorio cuando el resultado es ${estado === "PARCIAL" ? "Parcial" : "No"}.` };
        throw err;
      }
    }
  }
}

function construirEvaluacionSnapshot(resultadosCriterios = {}, comentariosCriterio = {}, criterios = []) {
  return (criterios || []).map((c) => {
    const respuesta = valorResultadoCriterio(resultadosCriterios[String(c.id)] ?? resultadosCriterios[c.id]);
    return {
      criterioId: Number(c.id),
      orden: Number(c.orden ?? c.id),
      bloque: c.grupo,
      nombre: c.label,
      respuesta,
      comentario: String(comentariosCriterio[String(c.id)] ?? comentariosCriterio[c.id] ?? "").trim().slice(0, 1000),
      valorAplicado: valorAplicadoResultado(respuesta),
    };
  });
}

function construirEvaluacionHistoricaSalida(it = {}, criterios = []) {
  if (Array.isArray(it?.evaluacionSnapshot) && it.evaluacionSnapshot.length) return it.evaluacionSnapshot;
  const resultados = normalizarResultadosItem(it, criterios).resultadosCriterios;
  const comentarios = objectFromMaybeMap(it?.comentariosCriterio);
  return (criterios || []).map((c) => ({
    criterioId: Number(c.id),
    orden: Number(c.orden ?? c.id),
    bloque: c.grupo,
    nombre: c.label,
    respuesta: valorResultadoCriterio(resultados[String(c.id)]),
    comentario: String(comentarios[String(c.id)] ?? "").trim(),
    valorAplicado: valorAplicadoResultado(resultados[String(c.id)]),
  }));
}

function calcScoresFromResultados(resultadosCriterios = {}, criterios = []) {
  return calcularScoresAuditoriaItem(resultadosCriterios, criterios, null, PESOS_AUDITORIA);
}

function semaforo(scoreFinal) {
  return semaforoAuditoria(scoreFinal);
}

function construirItemsAuditoria(itemsIn = [], { tipoInterlocutor, criterios = [] }) {
  const noAuditable = tipoInterlocutor === "NO_AUDITABLE";

  return itemsIn.map((it, idx) => {
    const telefono = String(it.telefono || "").trim();
    if (!telefono) throw new Error(`Cada item debe incluir telefono. (item #${idx + 1})`);

    const dni = String(it.dni || "").trim();
    const cartera = String(it.cartera || "").trim().toUpperCase();
    const fechaAudio = it.fechaAudio ? toDateOnly(it.fechaAudio) : null;
    const horaAprox = it.horaAprox ? normalizarHora(it.horaAprox) : "";
    const tipoInteraccion = String(it.tipoInteraccion || "LLAMADA_SALIENTE").trim().toUpperCase();
    const referencia = String(it.referencia || "").trim();
    const duracionMinutos = parseDuracionMinutos(it);
    const duracionSegundos = parseDuracionSegundosCompat(it);

    if (!noAuditable && isLlamada(tipoInteraccion) && duracionMinutos <= 0) {
      throw new Error(`Falta duración (minutos) para llamada en item #${idx + 1}.`);
    }

    if (noAuditable) {
      return {
        telefono, dni, cartera, fechaAudio, horaAprox, tipoInteraccion, referencia,
        duracionMinutos, duracionSegundos, comentariosCriterio: {},
        resultadosCriterios: {}, fallosIds: [], parcialesIds: [], criteriosNoAplica: [], evaluacionSnapshot: [],
        scoreAudio: null,
        scoreBloques: { presentacion: null, negociacion: null, cierre: null, calidad: null },
      };
    }

    const comentariosCriterio = parseComentariosCriterio(it, criterios);
    const resultados = normalizarResultadosItem(it, criterios);
    validarResultadosYComentarios(resultados.resultadosCriterios, comentariosCriterio, criterios, idx);
    const { scoreBloques, scoreAudio } = calcScoresFromResultados(resultados.resultadosCriterios, criterios);

    return {
      telefono, dni, cartera, fechaAudio, horaAprox, tipoInteraccion, referencia,
      duracionMinutos, duracionSegundos, comentariosCriterio,
      ...resultados,
      evaluacionSnapshot: construirEvaluacionSnapshot(resultados.resultadosCriterios, comentariosCriterio, criterios),
      scoreAudio,
      scoreBloques,
    };
  });
}

function validarDiagnosticosGlobales(body = {}, tipoInterlocutor = "TITULAR") {
  if (tipoInterlocutor === "NO_AUDITABLE") return { quienCondujo: "", justificacionConduccion: "", resultadoComercial: "" };

  const quienCondujo = String(body?.quienCondujo || "").trim().toUpperCase();
  if (!QUIEN_CONDUJO_OPCIONES.includes(quienCondujo)) {
    const err = new Error("Seleccioná quién condujo la llamada.");
    err.statusCode = 400;
    err.fieldError = { tipo: "global", campo: "quienCondujo", mensaje: "Este campo es obligatorio." };
    throw err;
  }

  const resultadoComercial = String(body?.resultadoComercial || "").trim().toUpperCase();
  if (resultadoComercial && !RESULTADO_COMERCIAL_OPCIONES.includes(resultadoComercial)) {
    const err = new Error("Resultado comercial inválido.");
    err.statusCode = 400;
    throw err;
  }

  return {
    quienCondujo,
    justificacionConduccion: String(body?.justificacionConduccion || "").trim().slice(0, 1500),
    resultadoComercial,
  };
}

function calcularResumenItems(items = [], tipoInterlocutor = "TITULAR") {
  if (tipoInterlocutor === "NO_AUDITABLE") {
    return {
      scoreFinal: null,
      scoreBloques: { presentacion: null, negociacion: null, cierre: null, calidad: null },
      semaforo: null,
    };
  }

  const scoresValidos = items
    .map((x) => x?.scoreAudio)
    .filter((v) => v != null && Number.isFinite(Number(v)))
    .map(Number);
  const scoreFinal = scoresValidos.length
    ? Number((scoresValidos.reduce((a, b) => a + b, 0) / scoresValidos.length).toFixed(6))
    : null;

  const scoreBloques = {};
  for (const k of ["presentacion", "negociacion", "cierre", "calidad"]) {
    const vals = items
      .map((x) => x?.scoreBloques?.[k])
      .filter((v) => v != null && Number.isFinite(Number(v)))
      .map(Number);
    scoreBloques[k] = vals.length
      ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(6))
      : null;
  }

  return { scoreFinal, scoreBloques, semaforo: semaforo(scoreFinal) };
}

function normalizarItemSalida(it = {}, criteriosSnapshot = []) {
  const base = typeof it?.toObject === "function" ? it.toObject() : { ...it };
  const comentarios = objectFromMaybeMap(base?.comentariosCriterio);
  const normalizados = normalizarResultadosItem(base, criteriosSnapshot);
  return {
    ...base,
    duracionMinutos: getDuracionMinutosSalida(base),
    comentariosCriterio: comentarios,
    resultadosCriterios: normalizados.resultadosCriterios,
    fallosIds: Array.isArray(base?.fallosIds) ? base.fallosIds : normalizados.fallosIds,
    parcialesIds: Array.isArray(base?.parcialesIds) ? base.parcialesIds : normalizados.parcialesIds,
    criteriosNoAplica: Array.isArray(base?.criteriosNoAplica) ? base.criteriosNoAplica : normalizados.criteriosNoAplica,
    evaluacionSnapshot: construirEvaluacionHistoricaSalida(base, criteriosSnapshot),
  };
}

function normalizarAuditoriaSalida(doc) {
  if (!doc) return doc;
  const base = typeof doc?.toObject === "function" ? doc.toObject() : { ...doc };
  const tipoInterlocutor = normalizarTipoInterlocutor(base.tipoInterlocutor || "TITULAR");
  const formularioAplicado = base.formularioAplicado || formularioAplicadoParaTipo(tipoInterlocutor);
  const versionFormulario = formularioAplicado === "NINGUNO"
    ? null
    : inferirVersionHistorica({ ...base, formularioAplicado, tipoInterlocutor });
  const formularioSnapshot = formularioSnapshotSalida({ ...base, formularioAplicado, tipoInterlocutor, versionFormulario });
  const criteriosSnapshot = formularioSnapshot?.criterios || [];

  return {
    ...base,
    tipoInterlocutor,
    formularioAplicado,
    tipoFormulario: base.tipoFormulario || formularioAplicado,
    versionFormulario,
    formularioSnapshot,
    historicaProtegida: esAuditoriaHistoricaProtegida({ ...base, formularioAplicado, tipoInterlocutor, versionFormulario }),
    motivoNoAuditable: base.motivoNoAuditable || "",
    detalleMotivoNoAuditable: base.detalleMotivoNoAuditable || "",
    quienCondujo: base.quienCondujo || "",
    justificacionConduccion: base.justificacionConduccion || "",
    resultadoComercial: base.resultadoComercial || "",
    items: Array.isArray(base.items) ? base.items.map((it) => normalizarItemSalida(it, criteriosSnapshot)) : [],
  };
}

/* ============================================================
   Endpoints
   ============================================================ */
export async function ping(req, res) {
  return res.json({ ok: true, module: "auditorias" });
}

export async function catalogos(req, res) {
  try {
    attachAbortFlag(req, res);

    if (!getUsuarioId(req))
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    throwIfAborted(req);

    const operadores = (
      await Empleado.find({
        isActive: true,
        role: { $in: ["operador", "operador-vip", "capacitadora", "administracion", "admin"] },
      })
        .select("username")
        .sort({ username: 1 })
        .lean()
    ).map((x) => String(x.username || ""));

    const motivos = [
      "aleatorio",
      "prueba",
      "bajo-rendimiento",
      "caso-nuevo",
      "reclamo-conflicto",
      "pedido-cliente",
      "otro",
    ];

    const tiposInteraccion = [
      "LLAMADA_ENTRANTE",
      "LLAMADA_SALIENTE",
      "MENSAJE_ENTRANTE",
      "MENSAJE_SALIENTE",
    ];

    return res.json({
      ok: true,
      operadores,
      motivos,
      tiposInteraccion,
      // Sólo formularios vigentes para auditorías nuevas. Las versiones viejas quedan internas.
      tiposInterlocutor: [
        { value: "TITULAR", label: "Titular" },
        { value: "FAMILIAR_DIRECTO", label: "Familiar directo / Pareja" },
        { value: "REFERENCIA", label: "Referencia / Tercero no directo" },
        { value: "TERCERO_PAGADOR", label: "Tercero pagador" },
        { value: "NO_AUDITABLE", label: "No auditable" },
      ],
      motivosNoAuditable: MOTIVOS_NO_AUDITABLE,
      diagnosticos: {
        quienCondujo: [
          { value: "OPERADOR", label: "Operador" },
          { value: "COMPARTIDA", label: "Compartida" },
          { value: "INTERLOCUTOR", label: "Titular / interlocutor" },
        ],
        resultadoComercial: [
          { value: "PAGO_REALIZADO", label: "Pago realizado" },
          { value: "ACUERDO_CERRADO", label: "Acuerdo cerrado" },
          { value: "PROMESA_FIRME", label: "Promesa firme" },
          { value: "CONTRAOFERTA_CONCRETA", label: "Contraoferta concreta" },
          { value: "PENDIENTE_DOCUMENTACION", label: "Pendiente de documentación" },
          { value: "PROXIMA_ACCION_CONCRETA", label: "Próxima acción concreta" },
          { value: "CONTACTO_UTIL_SIN_COMPROMISO", label: "Contacto útil sin compromiso económico" },
          { value: "SIN_DEFINICION", label: "Sin definición" },
          { value: "NO_APLICA", label: "No aplica" },
        ],
      },
      formularios: Object.fromEntries(
        Object.entries(FORMULARIOS_AUDITORIA).map(([key, value]) => [
          key,
          { key, label: value.label, version: value.version, lista: value.criterios },
        ])
      ),
      criterios: {
        pesos: PESOS,
        umbrales: { bajo: UMBRAL_BAJO, alto: UMBRAL_ALTO },
        lista: CRITERIOS_TITULAR,
      },
    });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

export async function crear(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    const auditorUsername = String(getUsuarioUsername(req) || "").toLowerCase().trim();
    if (!usuarioId) return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const body = req.body || {};
    const operadorUsername = String(body.operadorUsername || "").toLowerCase().trim();
    if (!operadorUsername) return res.status(400).json({ error: "operadorUsername es obligatorio." });
    if (!auditorUsername) return res.status(400).json({ error: "No se pudo determinar auditorUsername desde el token." });

    const op = await Empleado.findOne({ username: operadorUsername }).select("isActive role username").lean();
    if (!op) return res.status(400).json({ error: "Operador no existe." });
    if (op.isActive === false) return res.status(400).json({ error: "Operador inactivo." });

    const itemsIn = Array.isArray(body.items) ? body.items : [];
    if (itemsIn.length < 1) return res.status(400).json({ error: "Debe incluir al menos 1 audio/item." });
    if (itemsIn.length > 5) return res.status(400).json({ error: "Máximo 5 audios/items por auditoría." });

    const tipoInterlocutor = normalizarTipoInterlocutor(body.tipoInterlocutor || "TITULAR");
    if (!esTipoInterlocutorVigente(tipoInterlocutor)) {
      return res.status(400).json({ error: "Ese formulario es histórico y ya no puede usarse para una auditoría nueva." });
    }

    const formularioAplicado = formularioAplicadoParaTipo(tipoInterlocutor);
    const motivoNoAuditable = String(body.motivoNoAuditable || "").trim();
    const detalleMotivoNoAuditable = String(body.detalleMotivoNoAuditable || "").trim();
    if (tipoInterlocutor === "NO_AUDITABLE" && !motivoNoAuditable) {
      return res.status(400).json({ error: "Seleccioná un motivo para marcar la auditoría como No auditable." });
    }

    const formularioSnapshot = formularioAplicado === "NINGUNO" ? null : crearSnapshotFormulario(formularioAplicado);
    const criterios = formularioSnapshot?.criterios || [];
    const diagnosticos = validarDiagnosticosGlobales(body, tipoInterlocutor);
    const items = construirItemsAuditoria(itemsIn, { tipoInterlocutor, criterios });
    const resumenScores = calcularResumenItems(items, tipoInterlocutor);

    const doc = await AuditoriaContactoDirecto.create({
      propietario: new mongoose.Types.ObjectId(usuarioId),
      operadorUsername,
      auditorUsername,
      fechaAuditoria: body.fechaAuditoria ? toDateOnly(body.fechaAuditoria) : new Date(),
      tipoInterlocutor,
      formularioAplicado,
      tipoFormulario: formularioAplicado,
      versionFormulario: formularioSnapshot?.version || null,
      formularioSnapshot,
      motivoNoAuditable: tipoInterlocutor === "NO_AUDITABLE" ? motivoNoAuditable : "",
      detalleMotivoNoAuditable: tipoInterlocutor === "NO_AUDITABLE" ? detalleMotivoNoAuditable : "",
      motivosSeleccion: Array.isArray(body.motivosSeleccion) ? body.motivosSeleccion : [],
      observacionesGenerales: String(body.observacionesGenerales || "").trim(),
      puntosPositivos: tipoInterlocutor === "NO_AUDITABLE" ? "" : String(body.puntosPositivos || "").trim(),
      puntosAMejorar: tipoInterlocutor === "NO_AUDITABLE" ? "" : String(body.puntosAMejorar || "").trim(),
      ...diagnosticos,
      items,
      scoreFinal: resumenScores.scoreFinal,
      scoreBloques: resumenScores.scoreBloques,
      semaforo: resumenScores.semaforo,
      borrado: false,
    });

    return res.status(201).json({ ok: true, item: normalizarAuditoriaSalida(doc) });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ error: e.message, fieldError: e?.fieldError || null });
  }
}

export async function listar(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const {
      desde,
      hasta,
      operador,
      auditor,
      semaforo: sem,
      tipoInterlocutor,
      page = 1,
      limit = 50,
    } = req.query || {};

    const base = { ...ownerScope(req), borrado: { $ne: true } };

    if (desde || hasta) {
      const dDesde = desde ? diaInicioUTC(String(desde).trim()) : null;
      const dHasta = hasta ? diaFinUTC(String(hasta).trim()) : null;
      if (dDesde || dHasta) {
        base.fechaAuditoria = {};
        if (dDesde) base.fechaAuditoria.$gte = dDesde;
        if (dHasta) base.fechaAuditoria.$lte = dHasta;
      }
    }

    if (operador) base.operadorUsername = String(operador).toLowerCase().trim();
    if (auditor) base.auditorUsername = String(auditor).toLowerCase().trim();
    if (sem) base.semaforo = String(sem).toLowerCase().trim();
    if (tipoInterlocutor) {
      const tipo = normalizarTipoInterlocutor(tipoInterlocutor);
      if (tipo === "TITULAR") {
        base.$or = [
          { tipoInterlocutor: "TITULAR" },
          { tipoInterlocutor: { $exists: false } },
          { tipoInterlocutor: null },
        ];
      } else {
        base.tipoInterlocutor = tipo;
      }
    }

    // ❌ filtros feedback/coaching removidos

    const p = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (p - 1) * lim;

    throwIfAborted(req);

    const [total, items] = await Promise.all([
      AuditoriaContactoDirecto.countDocuments(base),
      AuditoriaContactoDirecto.find(base)
        .sort({ fechaAuditoria: -1, _id: -1 })
        .skip(skip)
        .limit(lim)
        .lean(),
    ]);

    return res.json({
      ok: true,
      page: p,
      limit: lim,
      total,
      items: Array.isArray(items) ? items.map(normalizarAuditoriaSalida) : [],
    });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

export async function detalle(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { id } = req.params;

    const doc = await AuditoriaContactoDirecto.findOne({
      _id: id,
      ...ownerScope(req),
      borrado: { $ne: true },
    }).lean();

    if (!doc)
      return res.status(404).json({ error: "Auditoría no encontrada." });

    return res.json({ ok: true, item: normalizarAuditoriaSalida(doc) });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

export async function editar(req, res) {
  try {
    attachAbortFlag(req, res);
    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { id } = req.params;
    const body = req.body || {};
    const existing = await AuditoriaContactoDirecto.findOne({
      _id: id,
      ...ownerScope(req),
      borrado: { $ne: true },
    });
    if (!existing) return res.status(404).json({ error: "Auditoría no encontrada." });

    // Las auditorías hechas con formularios anteriores se consultan/PDF, pero no se recalculan ni reescriben.
    if (esAuditoriaHistoricaProtegida(existing.toObject())) {
      return res.status(409).json({
        error: "Esta auditoría pertenece a una versión histórica y está protegida para no modificar ni recalcular su evaluación.",
        historicaProtegida: true,
      });
    }

    if (body.operadorUsername) {
      const operadorUsername = String(body.operadorUsername).toLowerCase().trim();
      const op = await Empleado.findOne({ username: operadorUsername }).select("isActive role username").lean();
      if (!op) return res.status(400).json({ error: "Operador no existe." });
      if (op.isActive === false) return res.status(400).json({ error: "Operador inactivo." });
      existing.operadorUsername = operadorUsername;
    }
    if (body.fechaAuditoria) existing.fechaAuditoria = toDateOnly(body.fechaAuditoria) || existing.fechaAuditoria;

    const tipoInterlocutor = normalizarTipoInterlocutor(body.tipoInterlocutor || existing.tipoInterlocutor || "TITULAR");
    if (!esTipoInterlocutorVigente(tipoInterlocutor)) {
      return res.status(400).json({ error: "No se puede cambiar una auditoría vigente a un formulario histórico." });
    }

    const formularioAplicado = formularioAplicadoParaTipo(tipoInterlocutor);
    const motivoNoAuditable = String(body.motivoNoAuditable || "").trim();
    const detalleMotivoNoAuditable = String(body.detalleMotivoNoAuditable || "").trim();
    if (tipoInterlocutor === "NO_AUDITABLE" && !motivoNoAuditable) {
      return res.status(400).json({ error: "Seleccioná un motivo para marcar la auditoría como No auditable." });
    }

    const tipoCambio = formularioAplicado !== String(existing.formularioAplicado || "");
    const formularioSnapshot = formularioAplicado === "NINGUNO"
      ? null
      : tipoCambio
        ? crearSnapshotFormulario(formularioAplicado)
        : (existing.formularioSnapshot?.criterios?.length ? existing.formularioSnapshot.toObject?.() || existing.formularioSnapshot : crearSnapshotFormulario(formularioAplicado));
    const criterios = formularioSnapshot?.criterios || [];
    const diagnosticos = validarDiagnosticosGlobales(body, tipoInterlocutor);

    existing.tipoInterlocutor = tipoInterlocutor;
    existing.formularioAplicado = formularioAplicado;
    existing.tipoFormulario = formularioAplicado;
    existing.versionFormulario = formularioSnapshot?.version || null;
    existing.formularioSnapshot = formularioSnapshot;
    existing.motivoNoAuditable = tipoInterlocutor === "NO_AUDITABLE" ? motivoNoAuditable : "";
    existing.detalleMotivoNoAuditable = tipoInterlocutor === "NO_AUDITABLE" ? detalleMotivoNoAuditable : "";
    existing.motivosSeleccion = Array.isArray(body.motivosSeleccion) ? body.motivosSeleccion : existing.motivosSeleccion;
    existing.observacionesGenerales = String(body.observacionesGenerales || "").trim();
    existing.puntosPositivos = tipoInterlocutor === "NO_AUDITABLE" ? "" : String(body.puntosPositivos || "").trim();
    existing.puntosAMejorar = tipoInterlocutor === "NO_AUDITABLE" ? "" : String(body.puntosAMejorar || "").trim();
    existing.quienCondujo = diagnosticos.quienCondujo;
    existing.justificacionConduccion = diagnosticos.justificacionConduccion;
    existing.resultadoComercial = diagnosticos.resultadoComercial;

    const itemsIn = Array.isArray(body.items) ? body.items : [];
    if (itemsIn.length < 1) return res.status(400).json({ error: "Debe incluir al menos 1 audio/item." });
    if (itemsIn.length > 5) return res.status(400).json({ error: "Máximo 5 audios/items por auditoría." });

    const items = construirItemsAuditoria(itemsIn, { tipoInterlocutor, criterios });
    const resumenScores = calcularResumenItems(items, tipoInterlocutor);
    existing.items = items;
    existing.scoreFinal = resumenScores.scoreFinal;
    existing.scoreBloques = resumenScores.scoreBloques;
    existing.semaforo = resumenScores.semaforo;

    await existing.save();
    return res.json({ ok: true, item: normalizarAuditoriaSalida(existing) });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ error: e.message, fieldError: e?.fieldError || null });
  }
}

export async function borrar(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { id } = req.params;

    const doc = await AuditoriaContactoDirecto.findOne({
      _id: id,
      ...ownerScope(req),
      borrado: { $ne: true },
    });

    if (!doc)
      return res.status(404).json({ error: "Auditoría no encontrada." });

    doc.borrado = true;
    await doc.save();

    // ✅ devolvemos id para que el front pueda sacar la fila sin refresh
    return res.json({ ok: true, id });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

export async function analyticsResumen(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { desde, hasta, operador, tipoInterlocutor } = req.query || {};
    const match = { ...ownerScope(req), borrado: { $ne: true } };

    if (desde || hasta) {
      const dDesde = desde ? diaInicioUTC(String(desde).trim()) : null;
      const dHasta = hasta ? diaFinUTC(String(hasta).trim()) : null;
      if (dDesde || dHasta) {
        match.fechaAuditoria = {};
        if (dDesde) match.fechaAuditoria.$gte = dDesde;
        if (dHasta) match.fechaAuditoria.$lte = dHasta;
      }
    }

    if (operador) match.operadorUsername = String(operador).toLowerCase().trim();
    if (tipoInterlocutor) {
      const tipo = normalizarTipoInterlocutor(tipoInterlocutor);
      if (tipo === "TITULAR") {
        match.$or = [
          { tipoInterlocutor: "TITULAR" },
          { tipoInterlocutor: { $exists: false } },
          { tipoInterlocutor: null },
        ];
      } else {
        match.tipoInterlocutor = tipo;
      }
    }

    throwIfAborted(req);

    // Los promedios/evolución se calculan sólo contra la versión vigente de
    // cada formulario. Así no comparamos un score del formulario viejo con uno
    // del nuevo, que tienen criterios distintos. El histórico sigue disponible
    // aparte para trazabilidad.
    const formulariosVigentesMatch = {
      $or: Object.entries(FORMULARIOS_AUDITORIA).map(([formulario, def]) => ({
        formularioAplicado: formulario,
        versionFormulario: Number(def.version),
      })),
    };

    // Un solo recorrido de auditorías para todos los KPIs. Además de ser más
    // completo que el tablero anterior, evita sumar varias consultas pesadas.
    const [aggRows, empleadosActivos] = await Promise.all([
      AuditoriaContactoDirecto.aggregate([
        { $match: match },
        {
          $facet: {
            resumen: [
              {
                $group: {
                  _id: null,
                  auditorias: { $sum: 1 },
                  auditables: { $sum: { $cond: [{ $ne: ["$scoreFinal", null] }, 1, 0] } },
                  noAuditables: { $sum: { $cond: [{ $eq: ["$tipoInterlocutor", "NO_AUDITABLE"] }, 1, 0] } },
                  audios: { $sum: { $size: { $ifNull: ["$items", []] } } },
                },
              },
            ],
            resumenVigente: [
              { $match: formulariosVigentesMatch },
              {
                $group: {
                  _id: null,
                  auditorias: { $sum: 1 },
                  auditables: { $sum: { $cond: [{ $ne: ["$scoreFinal", null] }, 1, 0] } },
                  avgFinal: { $avg: "$scoreFinal" },
                  avgPres: { $avg: "$scoreBloques.presentacion" },
                  avgNeg: { $avg: "$scoreBloques.negociacion" },
                  avgCie: { $avg: "$scoreBloques.cierre" },
                  avgCal: { $avg: "$scoreBloques.calidad" },
                },
              },
            ],
            semaforos: [
              { $match: formulariosVigentesMatch },
              { $match: { semaforo: { $in: ["bajo", "medio", "alto"] } } },
              { $group: { _id: "$semaforo", count: { $sum: 1 } } },
              { $project: { _id: 0, semaforo: "$_id", count: 1 } },
            ],
            porOperador: [
              { $sort: { operadorUsername: 1, fechaAuditoria: 1, _id: 1 } },
              {
                $group: {
                  _id: "$operadorUsername",
                  auditorias: { $sum: 1 },
                  auditables: { $sum: { $cond: [{ $ne: ["$scoreFinal", null] }, 1, 0] } },
                  avgFinal: { $avg: "$scoreFinal" },
                  ultimaAuditoria: { $last: "$fechaAuditoria" },
                  scores: {
                    $push: {
                      score: "$scoreFinal",
                      fecha: "$fechaAuditoria",
                      semaforo: "$semaforo",
                      formulario: { $ifNull: ["$formularioAplicado", { $ifNull: ["$tipoInterlocutor", "TITULAR"] }] },
                      version: "$versionFormulario",
                    },
                  },
                },
              },
              { $project: { _id: 0, operadorUsername: "$_id", auditorias: 1, auditables: 1, avgFinal: 1, ultimaAuditoria: 1, scores: 1 } },
            ],
            topFallosRaw: [
              { $unwind: "$items" },
              { $unwind: "$items.fallosIds" },
              {
                $group: {
                  _id: {
                    formulario: { $ifNull: ["$formularioAplicado", { $ifNull: ["$tipoInterlocutor", "TITULAR"] }] },
                    version: "$versionFormulario",
                    criterio: "$items.fallosIds",
                  },
                  count: { $sum: 1 },
                },
              },
              { $sort: { count: -1 } },
              { $limit: 40 },
            ],
            fallosPorOperadorRaw: [
              { $unwind: "$items" },
              { $unwind: "$items.fallosIds" },
              {
                $group: {
                  _id: {
                    operador: "$operadorUsername",
                    formulario: { $ifNull: ["$formularioAplicado", { $ifNull: ["$tipoInterlocutor", "TITULAR"] }] },
                    version: "$versionFormulario",
                    criterio: "$items.fallosIds",
                  },
                  count: { $sum: 1 },
                },
              },
              { $sort: { "_id.operador": 1, count: -1 } },
              { $limit: 1500 },
            ],
            porTipoInterlocutor: [
              {
                $group: {
                  _id: { $ifNull: ["$tipoInterlocutor", "TITULAR"] },
                  auditorias: { $sum: 1 },
                  avgFinal: { $avg: "$scoreFinal" },
                },
              },
              { $project: { _id: 0, tipoInterlocutor: "$_id", auditorias: 1, avgFinal: 1 } },
              { $sort: { auditorias: -1, tipoInterlocutor: 1 } },
            ],
            porFormulario: [
              {
                $group: {
                  _id: {
                    formulario: { $ifNull: ["$formularioAplicado", { $ifNull: ["$tipoInterlocutor", "TITULAR"] }] },
                    version: "$versionFormulario",
                  },
                  auditorias: { $sum: 1 },
                  auditables: { $sum: { $cond: [{ $ne: ["$scoreFinal", null] }, 1, 0] } },
                  avgFinal: { $avg: "$scoreFinal" },
                },
              },
              { $sort: { "_id.formulario": 1, "_id.version": 1 } },
            ],
            conduccion: [
              { $match: { quienCondujo: { $in: ["OPERADOR", "COMPARTIDA", "INTERLOCUTOR"] } } },
              { $group: { _id: "$quienCondujo", count: { $sum: 1 } } },
              { $project: { _id: 0, value: "$_id", count: 1 } },
              { $sort: { count: -1 } },
            ],
            resultadosComerciales: [
              { $match: { resultadoComercial: { $nin: ["", null, "NO_APLICA"] } } },
              { $group: { _id: "$resultadoComercial", count: { $sum: 1 } } },
              { $project: { _id: 0, value: "$_id", count: 1 } },
              { $sort: { count: -1 } },
              { $limit: 10 },
            ],
          },
        },
      ]).allowDiskUse(true),
      Empleado.find({ isActive: true, role: { $in: ["operador", "operador-vip"] } })
        .select("username nombre")
        .sort({ username: 1 })
        .lean(),
    ]);

    throwIfAborted(req);

    const root = aggRows?.[0] || {};
    const resumen = root.resumen?.[0] || {};
    const resumenVigente = root.resumenVigente?.[0] || {};

    const esFormularioVigente = (scoreRow = {}) => {
      const formulario = String(scoreRow?.formulario || "TITULAR").toUpperCase();
      const version = Number(scoreRow?.version) || (["TITULAR", "TERCERO", "TERCERO_PAGADOR"].includes(formulario) ? 1 : versionFormularioActual(formulario));
      return Boolean(FORMULARIOS_AUDITORIA[formulario])
        && Number(FORMULARIOS_AUDITORIA[formulario].version) === Number(version);
    };

    const criterioInfo = (raw = {}) => {
      const formulario = String(raw?.formulario || "TITULAR").toUpperCase();
      const fallbackVersion = ["TITULAR", "TERCERO", "TERCERO_PAGADOR"].includes(formulario)
        ? 1
        : versionFormularioActual(formulario);
      const version = Number(raw?.version) || fallbackVersion;
      const criterio = criterioPorId(formulario, raw?.criterio, version);
      const vigente = Boolean(FORMULARIOS_AUDITORIA[formulario])
        && Number(FORMULARIOS_AUDITORIA[formulario].version) === Number(version);
      return {
        id: raw?.criterio,
        formulario,
        version,
        vigente,
        label: criterio?.label || `Criterio ${raw?.criterio}`,
        grupo: criterio?.grupo || "",
        count: Number(raw?.count || 0),
      };
    };

    const allFallos = (root.topFallosRaw || []).map((x) => criterioInfo({
      formulario: x?._id?.formulario,
      version: x?._id?.version,
      criterio: x?._id?.criterio,
      count: x?.count,
    }));
    const topFallos = allFallos.filter((x) => x.vigente).slice(0, 10);
    const topFallosHistoricos = allFallos.filter((x) => !x.vigente).slice(0, 8);

    const fallosByOperator = new Map();
    for (const raw of root.fallosPorOperadorRaw || []) {
      const username = String(raw?._id?.operador || "").toLowerCase();
      if (!username) continue;
      const info = criterioInfo({
        formulario: raw?._id?.formulario,
        version: raw?._id?.version,
        criterio: raw?._id?.criterio,
        count: raw?.count,
      });
      if (!fallosByOperator.has(username)) fallosByOperator.set(username, []);
      fallosByOperator.get(username).push(info);
    }
    for (const [username, items] of fallosByOperator.entries()) {
      fallosByOperator.set(username, items.sort((a, b) => Number(b.vigente) - Number(a.vigente) || b.count - a.count).slice(0, 3));
    }

    const porOperador = (root.porOperador || []).map((row) => {
      const allScores = Array.isArray(row.scores) ? row.scores : [];
      const currentRows = allScores.filter(esFormularioVigente);
      const currentValidScores = currentRows
        .filter((x) => x?.score != null && Number.isFinite(Number(x.score)))
        .map((x) => ({ ...x, score: Number(x.score) }));
      const allValidScores = allScores
        .filter((x) => x?.score != null && Number.isFinite(Number(x.score)))
        .map((x) => ({ ...x, score: Number(x.score) }));

      // Evolución válida = últimas dos muestras comparables del formulario
      // vigente. Los scores históricos se conservan, pero no se mezclan.
      const ultimo = currentValidScores.at(-1) || null;
      const anterior = currentValidScores.length >= 2 ? currentValidScores.at(-2) : null;
      const delta = ultimo && anterior ? Number((ultimo.score - anterior.score).toFixed(2)) : null;
      const username = String(row.operadorUsername || "").toLowerCase();
      const avgVigente = currentValidScores.length
        ? currentValidScores.reduce((acc, x) => acc + Number(x.score || 0), 0) / currentValidScores.length
        : null;

      return {
        operadorUsername: username,
        auditorias: Number(row.auditorias || 0),
        auditables: Number(row.auditables || 0),
        auditoriasVigentes: currentRows.length,
        auditablesVigentes: currentValidScores.length,
        avgFinal: avgVigente == null ? null : Number(avgVigente.toFixed(4)),
        avgFinalHistoricoMixto: row.avgFinal == null ? null : Number(Number(row.avgFinal).toFixed(4)),
        ultimaAuditoria: row.ultimaAuditoria || null,
        ultimoScore: ultimo?.score ?? null,
        ultimoScoreFecha: ultimo?.fecha || null,
        ultimoSemaforo: ultimo?.semaforo || null,
        scoreAnterior: anterior?.score ?? null,
        deltaUltimas: delta,
        muestrasHistoricas: Math.max(0, allValidScores.length - currentValidScores.length),
        fallosRecurrentes: (fallosByOperator.get(username) || []).filter((x) => x.vigente),
      };
    });
    const porOperadorMap = new Map(porOperador.map((x) => [x.operadorUsername, x]));

    let objetivos = empleadosActivos
      .map((x) => ({ username: String(x.username || "").toLowerCase(), nombre: String(x.nombre || "") }))
      .filter((x) => x.username);
    if (operador) {
      const selected = String(operador).toLowerCase().trim();
      objetivos = objetivos.filter((x) => x.username === selected);
    }

    const planRefuerzo = objetivos.map((op) => {
      const row = porOperadorMap.get(op.username);
      const auditorias = Number(row?.auditorias || 0);
      const auditablesTotales = Number(row?.auditables || 0);
      const auditoriasVigentes = Number(row?.auditoriasVigentes || 0);
      const auditables = Number(row?.auditablesVigentes || 0);
      const ultimo = row?.ultimoScore;
      const avg = row?.avgFinal;
      const delta = row?.deltaUltimas;
      const recurrentes = row?.fallosRecurrentes || [];

      let prioridad = "NORMAL";
      let prioridadOrden = 20;
      let necesidad = "Control normal";
      let motivo = "Resultado estable dentro de parámetros.";

      if (!auditorias) {
        prioridad = "PENDIENTE";
        prioridadOrden = 100;
        necesidad = "Auditar";
        motivo = "Todavía no tiene auditoría en el período.";
      } else if (!auditables && auditablesTotales > 0) {
        prioridad = "PENDIENTE";
        prioridadOrden = 98;
        necesidad = "Auditar con formulario vigente";
        motivo = "Tiene auditorías históricas/anteriores, pero todavía no una muestra comparable con el formulario nuevo.";
      } else if (!auditables) {
        prioridad = "ALTA";
        prioridadOrden = 95;
        necesidad = "Buscar audio auditable";
        motivo = "Tiene registros, pero ninguno permite medir calidad con el formulario vigente.";
      } else if (ultimo != null && ultimo < UMBRALES_AUDITORIA.bajo) {
        prioridad = "ALTA";
        prioridadOrden = 90;
        necesidad = "Refuerzo + nueva auditoría";
        motivo = `Último score bajo (${ultimo.toFixed(2)}).`;
      } else if (delta != null && delta <= -0.75) {
        prioridad = "ALTA";
        prioridadOrden = 86;
        necesidad = "Nueva auditoría pronta";
        motivo = `Empeoró ${Math.abs(delta).toFixed(2)} puntos respecto de la auditoría anterior.`;
      } else if (avg != null && avg < UMBRALES_AUDITORIA.bajo) {
        prioridad = "ALTA";
        prioridadOrden = 82;
        necesidad = "Refuerzo";
        motivo = `Promedio del período bajo (${avg.toFixed(2)}).`;
      } else if ((ultimo != null && ultimo < UMBRALES_AUDITORIA.alto) || (delta != null && delta < -0.25)) {
        prioridad = "MEDIA";
        prioridadOrden = 65;
        necesidad = "Seguimiento / refuerzo puntual";
        motivo = delta != null && delta < -0.25
          ? `Tendencia en baja (${delta.toFixed(2)} puntos).`
          : `Último score medio (${Number(ultimo || 0).toFixed(2)}).`;
      } else if (auditables < 2) {
        prioridad = "SEGUIMIENTO";
        prioridadOrden = 48;
        necesidad = "Segunda muestra";
        motivo = "Tiene una sola auditoría con score; falta otra muestra para medir evolución.";
      }

      if (recurrentes[0]?.count >= 2 && prioridadOrden < 80) {
        prioridadOrden += 6;
        if (prioridad === "NORMAL") prioridad = "SEGUIMIENTO";
        if (necesidad === "Control normal") necesidad = "Refuerzo puntual";
        motivo = `${motivo} Repite fallas en ${recurrentes[0].label}.`;
      }

      return {
        ...op,
        prioridad,
        prioridadOrden,
        necesidad,
        motivo,
        auditorias,
        auditables,
        auditoriasVigentes,
        auditablesTotales,
        avgFinal: avg ?? null,
        ultimoScore: ultimo ?? null,
        scoreAnterior: row?.scoreAnterior ?? null,
        deltaUltimas: delta ?? null,
        ultimaAuditoria: row?.ultimoScoreFecha || row?.ultimaAuditoria || null,
        fallosRecurrentes: recurrentes,
      };
    }).sort((a, b) => b.prioridadOrden - a.prioridadOrden || a.username.localeCompare(b.username, "es"));

    const faltantes = planRefuerzo.filter((x) => x.auditorias === 0).map((x) => ({ username: x.username, nombre: x.nombre }));
    const faltanVigente = planRefuerzo.filter((x) => x.auditables === 0).map((x) => ({
      username: x.username,
      nombre: x.nombre,
      auditorias: x.auditorias,
      auditablesTotales: x.auditablesTotales,
    }));
    const faltanConScore = faltanVigente;
    const mejoraron = porOperador.filter((x) => x.deltaUltimas != null && x.deltaUltimas >= 0.5).sort((a, b) => b.deltaUltimas - a.deltaUltimas);
    const empeoraron = porOperador.filter((x) => x.deltaUltimas != null && x.deltaUltimas <= -0.5).sort((a, b) => a.deltaUltimas - b.deltaUltimas);

    const porFormulario = (root.porFormulario || []).map((x) => {
      const formulario = String(x?._id?.formulario || "TITULAR").toUpperCase();
      const version = Number(x?._id?.version) || (["TITULAR", "TERCERO", "TERCERO_PAGADOR"].includes(formulario) ? 1 : versionFormularioActual(formulario));
      return {
        formulario,
        version,
        vigente: Boolean(FORMULARIOS_AUDITORIA[formulario]) && Number(FORMULARIOS_AUDITORIA[formulario].version) === version,
        label: FORMULARIOS_AUDITORIA[formulario]?.label || (formulario === "TERCERO" ? "Tercero / Familiar / Referencia (histórico)" : formulario.replaceAll("_", " ")),
        auditorias: Number(x.auditorias || 0),
        auditables: Number(x.auditables || 0),
        avgFinal: x.avgFinal == null ? null : Number(Number(x.avgFinal).toFixed(4)),
      };
    });
    const formulariosVigentesCount = porFormulario.filter((x) => x.vigente).reduce((acc, x) => acc + x.auditorias, 0);
    const formulariosHistoricosCount = porFormulario.filter((x) => !x.vigente).reduce((acc, x) => acc + x.auditorias, 0);

    return res.json({
      ok: true,
      resumen: {
        auditorias: resumen?.auditorias || 0,
        auditables: resumen?.auditables || 0,
        auditablesVigentes: resumenVigente?.auditables || 0,
        noAuditables: resumen?.noAuditables || 0,
        audios: resumen?.audios || 0,
        scorePromedio: resumenVigente?.avgFinal == null ? null : Number(Number(resumenVigente.avgFinal).toFixed(4)),
        bloquesPromedio: {
          presentacion: resumenVigente?.avgPres == null ? null : Number(Number(resumenVigente.avgPres).toFixed(4)),
          negociacion: resumenVigente?.avgNeg == null ? null : Number(Number(resumenVigente.avgNeg).toFixed(4)),
          cierre: resumenVigente?.avgCie == null ? null : Number(Number(resumenVigente.avgCie).toFixed(4)),
          calidad: resumenVigente?.avgCal == null ? null : Number(Number(resumenVigente.avgCal).toFixed(4)),
        },
        formulariosVigentes: formulariosVigentesCount,
        formulariosHistoricos: formulariosHistoricosCount,
      },
      cobertura: {
        totalObjetivo: planRefuerzo.length,
        conAuditoria: planRefuerzo.filter((x) => x.auditorias > 0).length,
        conFormularioVigente: planRefuerzo.filter((x) => x.auditoriasVigentes > 0).length,
        conScore: planRefuerzo.filter((x) => x.auditables > 0).length,
        faltantes,
        faltanVigente,
        faltanConScore,
      },
      evolucion: {
        mejoraron,
        empeoraron,
        comparables: porOperador.filter((x) => x.deltaUltimas != null).length,
      },
      planRefuerzo,
      semaforos: root.semaforos || [],
      porOperador,
      porTipoInterlocutor: root.porTipoInterlocutor || [],
      porFormulario,
      topFallos,
      topFallosHistoricos,
      diagnosticos: {
        conduccion: root.conduccion || [],
        resultadosComerciales: root.resultadosComerciales || [],
      },
    });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

export async function exportarPDF(req, res) {
  return res.status(501).json({
    ok: false,
    message:
      "Export PDF se generará desde el Frontend (jsPDF). Por ahora usar GET /api/auditorias/:id y armar el PDF en React.",
  });
}