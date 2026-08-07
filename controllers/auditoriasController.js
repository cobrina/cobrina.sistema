// BACKEND/controllers/auditoriasController.js
import mongoose from "mongoose";
import AuditoriaContactoDirecto from "../models/AuditoriaContactoDirecto.js";
import Empleado from "../models/Empleado.js";
import { toDateOnly, normalizarHora } from "../utils/fecha.util.js";
import {
  CRITERIOS_TITULAR,
  FORMULARIOS_AUDITORIA,
  MOTIVOS_NO_AUDITABLE,
  PESOS_AUDITORIA,
  UMBRALES_AUDITORIA,
  calcularScoresAuditoriaItem,
  criterioPorId,
  formularioAplicadoParaTipo,
  normalizarResultadosItem,
  normalizarTipoInterlocutor,
  semaforoAuditoria,
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
   - TITULAR conserva exactamente los 24 criterios históricos.
   - TERCERO y TERCERO_PAGADOR usan formularios separados.
   - NO_APLICA se excluye del denominador ponderado.
   ============================================================ */
const PESOS = PESOS_AUDITORIA;
const UMBRAL_BAJO = UMBRALES_AUDITORIA.bajo;
const UMBRAL_ALTO = UMBRALES_AUDITORIA.alto;


function parseComentariosCriterio(it = {}) {
  const raw =
    it?.comentariosCriterio ??
    it?.comentariosPorCriterio ??
    it?.comentarios ??
    {};

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out = {};

  for (const [key, value] of Object.entries(raw)) {
    const criterioId = Number(key);
    if (!Number.isInteger(criterioId) || criterioId < 1 || criterioId > 24) continue;

    const txt = String(value ?? "").trim();
    if (!txt) continue;

    out[String(criterioId)] = txt.slice(0, 1000);
  }

  return out;
}

function calcScoresFromResultados(resultadosCriterios = {}, formulario = "TITULAR") {
  return calcularScoresAuditoriaItem(resultadosCriterios, formulario);
}

function semaforo(scoreFinal) {
  return semaforoAuditoria(scoreFinal);
}

function construirItemsAuditoria(itemsIn = [], { tipoInterlocutor, formularioAplicado }) {
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

    const comentariosCriterio = noAuditable ? {} : parseComentariosCriterio(it);

    if (noAuditable) {
      return {
        telefono, dni, cartera, fechaAudio, horaAprox, tipoInteraccion, referencia,
        duracionMinutos, duracionSegundos, comentariosCriterio,
        resultadosCriterios: {}, fallosIds: [], parcialesIds: [], criteriosNoAplica: [],
        scoreAudio: null,
        scoreBloques: { presentacion: null, negociacion: null, cierre: null, calidad: null },
      };
    }

    const resultados = normalizarResultadosItem(it, formularioAplicado);
    const { scoreBloques, scoreAudio } = calcScoresFromResultados(
      resultados.resultadosCriterios,
      formularioAplicado
    );

    return {
      telefono, dni, cartera, fechaAudio, horaAprox, tipoInteraccion, referencia,
      duracionMinutos, duracionSegundos, comentariosCriterio,
      ...resultados,
      scoreAudio,
      scoreBloques,
    };
  });
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

function normalizarItemSalida(it = {}) {
  const comentarios =
    it?.comentariosCriterio instanceof Map
      ? Object.fromEntries(it.comentariosCriterio)
      : it?.comentariosCriterio || {};
  const resultados =
    it?.resultadosCriterios instanceof Map
      ? Object.fromEntries(it.resultadosCriterios)
      : it?.resultadosCriterios || {};

  return {
    ...it,
    duracionMinutos: getDuracionMinutosSalida(it),
    comentariosCriterio: comentarios,
    resultadosCriterios: resultados,
    criteriosNoAplica: Array.isArray(it?.criteriosNoAplica) ? it.criteriosNoAplica : [],
  };
}

function normalizarAuditoriaSalida(doc) {
  if (!doc) return doc;

  const base =
    typeof doc?.toObject === "function" ? doc.toObject() : { ...doc };

  const tipoInterlocutor = normalizarTipoInterlocutor(base.tipoInterlocutor || "TITULAR");
  const formularioAplicado =
    base.formularioAplicado || formularioAplicadoParaTipo(tipoInterlocutor);

  return {
    ...base,
    tipoInterlocutor,
    formularioAplicado,
    motivoNoAuditable: base.motivoNoAuditable || "",
    detalleMotivoNoAuditable: base.detalleMotivoNoAuditable || "",
    items: Array.isArray(base.items)
      ? base.items.map(normalizarItemSalida)
      : [],
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
      tiposInterlocutor: [
        { value: "TITULAR", label: "Titular" },
        { value: "TERCERO", label: "Tercero / Familiar / Referencia" },
        { value: "TERCERO_PAGADOR", label: "Tercero pagador" },
        { value: "NO_AUDITABLE", label: "No auditable" },
      ],
      motivosNoAuditable: MOTIVOS_NO_AUDITABLE,
      formularios: Object.fromEntries(
        Object.entries(FORMULARIOS_AUDITORIA).map(([key, value]) => [
          key,
          { key, label: value.label, lista: value.criterios },
        ])
      ),
      // Compatibilidad con el frontend/reportes históricos: criterios = TITULAR.
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
    const auditorUsername = String(getUsuarioUsername(req) || "")
      .toLowerCase()
      .trim();

    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const body = req.body || {};
    const operadorUsername = String(body.operadorUsername || "")
      .toLowerCase()
      .trim();

    if (!operadorUsername)
      return res
        .status(400)
        .json({ error: "operadorUsername es obligatorio." });
    if (!auditorUsername)
      return res.status(400).json({
        error: "No se pudo determinar auditorUsername desde el token.",
      });

    const op = await Empleado.findOne({ username: operadorUsername })
      .select("isActive role username")
      .lean();
    if (!op) return res.status(400).json({ error: "Operador no existe." });
    if (op.isActive === false)
      return res.status(400).json({ error: "Operador inactivo." });

    const itemsIn = Array.isArray(body.items) ? body.items : [];
    if (itemsIn.length < 1)
      return res
        .status(400)
        .json({ error: "Debe incluir al menos 1 audio/item." });
    if (itemsIn.length > 5)
      return res
        .status(400)
        .json({ error: "Máximo 5 audios/items por auditoría." });

    const tipoInterlocutor = normalizarTipoInterlocutor(body.tipoInterlocutor || "TITULAR");
    const formularioAplicado = formularioAplicadoParaTipo(tipoInterlocutor);
    const motivoNoAuditable = String(body.motivoNoAuditable || "").trim();
    const detalleMotivoNoAuditable = String(body.detalleMotivoNoAuditable || "").trim();

    if (tipoInterlocutor === "NO_AUDITABLE" && !motivoNoAuditable) {
      return res.status(400).json({ error: "Seleccioná un motivo para marcar la auditoría como No auditable." });
    }

    const items = construirItemsAuditoria(itemsIn, { tipoInterlocutor, formularioAplicado });
    const resumenScores = calcularResumenItems(items, tipoInterlocutor);

    const doc = await AuditoriaContactoDirecto.create({
      propietario: new mongoose.Types.ObjectId(usuarioId),
      operadorUsername,
      auditorUsername,
      fechaAuditoria: body.fechaAuditoria
        ? toDateOnly(body.fechaAuditoria)
        : new Date(),
      tipoInterlocutor,
      formularioAplicado,
      motivoNoAuditable: tipoInterlocutor === "NO_AUDITABLE" ? motivoNoAuditable : "",
      detalleMotivoNoAuditable:
        tipoInterlocutor === "NO_AUDITABLE" ? detalleMotivoNoAuditable : "",
      motivosSeleccion: Array.isArray(body.motivosSeleccion)
        ? body.motivosSeleccion
        : [],
      // ❌ feedbackInformado / requiereCoaching removidos
      observacionesGenerales: String(body.observacionesGenerales || "").trim(),
      puntosPositivos:
        tipoInterlocutor === "NO_AUDITABLE" ? "" : String(body.puntosPositivos || "").trim(),
      puntosAMejorar:
        tipoInterlocutor === "NO_AUDITABLE" ? "" : String(body.puntosAMejorar || "").trim(),
      items,
      scoreFinal: resumenScores.scoreFinal,
      scoreBloques: resumenScores.scoreBloques,
      semaforo: resumenScores.semaforo,
      borrado: false,
    });

    return res
      .status(201)
      .json({ ok: true, item: normalizarAuditoriaSalida(doc) });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
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
    if (!usuarioId)
      return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { id } = req.params;
    const body = req.body || {};

    const existing = await AuditoriaContactoDirecto.findOne({
      _id: id,
      ...ownerScope(req),
      borrado: { $ne: true },
    });

    if (!existing)
      return res.status(404).json({ error: "Auditoría no encontrada." });

    if (body.operadorUsername) {
      const operadorUsername = String(body.operadorUsername)
        .toLowerCase()
        .trim();

      const op = await Empleado.findOne({ username: operadorUsername })
        .select("isActive role username")
        .lean();

      if (!op) return res.status(400).json({ error: "Operador no existe." });
      if (op.isActive === false)
        return res.status(400).json({ error: "Operador inactivo." });

      existing.operadorUsername = operadorUsername;
    }

    if (body.fechaAuditoria) {
      existing.fechaAuditoria =
        toDateOnly(body.fechaAuditoria) || existing.fechaAuditoria;
    }

    const tipoInterlocutor = normalizarTipoInterlocutor(
      body.tipoInterlocutor || existing.tipoInterlocutor || "TITULAR"
    );
    const formularioAplicado = formularioAplicadoParaTipo(tipoInterlocutor);
    const motivoNoAuditable = String(body.motivoNoAuditable || "").trim();
    const detalleMotivoNoAuditable = String(body.detalleMotivoNoAuditable || "").trim();

    if (tipoInterlocutor === "NO_AUDITABLE" && !motivoNoAuditable) {
      return res.status(400).json({ error: "Seleccioná un motivo para marcar la auditoría como No auditable." });
    }

    existing.tipoInterlocutor = tipoInterlocutor;
    existing.formularioAplicado = formularioAplicado;
    existing.motivoNoAuditable = tipoInterlocutor === "NO_AUDITABLE" ? motivoNoAuditable : "";
    existing.detalleMotivoNoAuditable =
      tipoInterlocutor === "NO_AUDITABLE" ? detalleMotivoNoAuditable : "";

    existing.motivosSeleccion = Array.isArray(body.motivosSeleccion)
      ? body.motivosSeleccion
      : existing.motivosSeleccion;

    // ❌ feedbackInformado / requiereCoaching removidos

    existing.observacionesGenerales = String(
      body.observacionesGenerales || ""
    ).trim();
    existing.puntosPositivos =
      tipoInterlocutor === "NO_AUDITABLE" ? "" : String(body.puntosPositivos || "").trim();
    existing.puntosAMejorar =
      tipoInterlocutor === "NO_AUDITABLE" ? "" : String(body.puntosAMejorar || "").trim();

    const itemsIn = Array.isArray(body.items) ? body.items : [];
    if (itemsIn.length < 1)
      return res
        .status(400)
        .json({ error: "Debe incluir al menos 1 audio/item." });
    if (itemsIn.length > 5)
      return res
        .status(400)
        .json({ error: "Máximo 5 audios/items por auditoría." });

    const items = construirItemsAuditoria(itemsIn, { tipoInterlocutor, formularioAplicado });
    const resumenScores = calcularResumenItems(items, tipoInterlocutor);

    existing.items = items;
    existing.scoreFinal = resumenScores.scoreFinal;
    existing.scoreBloques = resumenScores.scoreBloques;
    existing.semaforo = resumenScores.semaforo;

    await existing.save();

    return res.json({ ok: true, item: normalizarAuditoriaSalida(existing) });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
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

    if (operador) {
      match.operadorUsername = String(operador).toLowerCase().trim();
    }
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

    const [resumen] = await AuditoriaContactoDirecto.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          auditorias: { $sum: 1 },
          auditables: { $sum: { $cond: [{ $ne: ["$scoreFinal", null] }, 1, 0] } },
          noAuditables: { $sum: { $cond: [{ $eq: ["$tipoInterlocutor", "NO_AUDITABLE"] }, 1, 0] } },
          audios: { $sum: { $size: { $ifNull: ["$items", []] } } },
          avgFinal: { $avg: "$scoreFinal" },
          avgPres: { $avg: "$scoreBloques.presentacion" },
          avgNeg: { $avg: "$scoreBloques.negociacion" },
          avgCie: { $avg: "$scoreBloques.cierre" },
          avgCal: { $avg: "$scoreBloques.calidad" },
        },
      },
    ]);

    const semaforos = await AuditoriaContactoDirecto.aggregate([
      { $match: match },
      { $match: { semaforo: { $in: ["bajo", "medio", "alto"] } } },
      { $group: { _id: "$semaforo", count: { $sum: 1 } } },
      { $project: { _id: 0, semaforo: "$_id", count: 1 } },
    ]);

    const porOperador = await AuditoriaContactoDirecto.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$operadorUsername",
          auditorias: { $sum: 1 },
          avgFinal: { $avg: "$scoreFinal" },
        },
      },
      {
        $project: {
          _id: 0,
          operadorUsername: "$_id",
          auditorias: 1,
          avgFinal: 1,
        },
      },
      { $sort: { avgFinal: -1, auditorias: -1, operadorUsername: 1 } },
    ]);

    const topFallosRaw = await AuditoriaContactoDirecto.aggregate([
      { $match: match },
      { $unwind: "$items" },
      { $unwind: "$items.fallosIds" },
      {
        $group: {
          _id: {
            formulario: {
              $ifNull: [
                "$formularioAplicado",
                { $ifNull: ["$tipoInterlocutor", "TITULAR"] },
              ],
            },
            criterio: "$items.fallosIds",
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);

    const topFallos = topFallosRaw.map((x) => {
      const formulario = ["TITULAR", "TERCERO", "TERCERO_PAGADOR"].includes(x?._id?.formulario)
        ? x._id.formulario
        : "TITULAR";
      const criterio = criterioPorId(formulario, x?._id?.criterio);
      return {
        id: x?._id?.criterio,
        formulario,
        label: criterio?.label || `Criterio ${x?._id?.criterio}`,
        grupo: criterio?.grupo || "",
        count: x.count,
      };
    });

    const porTipoInterlocutor = await AuditoriaContactoDirecto.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ["$tipoInterlocutor", "TITULAR"] },
          auditorias: { $sum: 1 },
          avgFinal: { $avg: "$scoreFinal" },
        },
      },
      { $project: { _id: 0, tipoInterlocutor: "$_id", auditorias: 1, avgFinal: 1 } },
      { $sort: { auditorias: -1, tipoInterlocutor: 1 } },
    ]);

    return res.json({
      ok: true,
      resumen: {
        auditorias: resumen?.auditorias || 0,
        auditables: resumen?.auditables || 0,
        noAuditables: resumen?.noAuditables || 0,
        audios: resumen?.audios || 0,
        scorePromedio:
          resumen?.avgFinal == null ? null : Number(Number(resumen.avgFinal).toFixed(4)),
        bloquesPromedio: {
          presentacion:
            resumen?.avgPres == null ? null : Number(Number(resumen.avgPres).toFixed(4)),
          negociacion:
            resumen?.avgNeg == null ? null : Number(Number(resumen.avgNeg).toFixed(4)),
          cierre:
            resumen?.avgCie == null ? null : Number(Number(resumen.avgCie).toFixed(4)),
          calidad:
            resumen?.avgCal == null ? null : Number(Number(resumen.avgCal).toFixed(4)),
        },
      },
      semaforos,
      porOperador,
      porTipoInterlocutor,
      topFallos,
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