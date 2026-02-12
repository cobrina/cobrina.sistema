// BACKEND/controllers/auditoriasController.js
import mongoose from "mongoose";
import AuditoriaContactoDirecto from "../models/AuditoriaContactoDirecto.js";
import Empleado from "../models/Empleado.js";
import { toDateOnly, normalizarHora } from "../utils/fecha.util.js";

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
  return req?.user?.rol || req?.user?.role || req?.usuario?.rol || req?.usuario?.role || null;
}

function getUsuarioUsername(req) {
  return req?.user?.username || req?.usuario?.username || null;
}

function ensureNoOperador(req, res) {
  const rol = String(getUsuarioRol(req) || "").toLowerCase();
  if (rol === "operador" || rol === "operador-vip") {
    res.status(403).json({ error: "Acceso denegado: operadores no tienen acceso a Auditorías." });
    return false;
  }
  return true;
}

function ownerScope(req) {
  const usuarioId = getUsuarioId(req);
  const rol = String(getUsuarioRol(req) || "").toLowerCase();
  const onlyMine = String(req?.query?.onlyMine ?? req?.body?.onlyMine ?? "").toLowerCase() === "true";

  if (!usuarioId) return {};
  const isAdminLike = rol === "admin" || rol === "super-admin" || rol === "superadmin";

  if (isAdminLike && !onlyMine) return {}; // ver todo
  return { propietario: new mongoose.Types.ObjectId(usuarioId) };
}

function diaInicioUTC(raw) {
  const d = toDateOnly(raw);
  if (!d) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function diaFinUTC(raw) {
  const d0 = diaInicioUTC(raw);
  if (!d0) return null;
  return new Date(d0.getTime() + 86399999);
}

/* ============================================================
   Duración (segundos)
   ============================================================ */
function parseDuracionSegundos(it = {}) {
  // Acepta variantes para no pelearse con el front:
  // duracionSegundos | duracion | duracionSeconds | segundos
  const raw =
    it?.duracionSegundos ??
    it?.duracion ??
    it?.duracionSeconds ??
    it?.segundos ??
    it?.duracion_s ??
    it?.duracionEnSegundos;

  if (raw == null || raw === "") return 0;

  const n = Number(String(raw).replace(",", "."));
  if (!Number.isFinite(n)) return 0;

  // clamp razonable: 0..8hs
  return Math.max(0, Math.min(8 * 60 * 60, Math.round(n)));
}

function isLlamada(tipoInteraccion = "") {
  return String(tipoInteraccion || "").toUpperCase().startsWith("LLAMADA");
}

/* ============================================================
   Planilla: criterios y pesos (idéntico al Excel)
   ============================================================ */
const CRITERIOS = [
  // Presentación (3)
  { id: 1, grupo: "presentacion", label: "Se presenta cordial y correctamente" },
  { id: 2, grupo: "presentacion", label: "Solicita por titular o encargado de pago" },
  { id: 3, grupo: "presentacion", label: "Expone motivo del llamado" },

  // Negociación (7)
  { id: 4, grupo: "negociacion", label: "Solicita saldo actualizado" },
  { id: 5, grupo: "negociacion", label: "Consulta motivos de atraso" },
  { id: 6, grupo: "negociacion", label: "Negocia el saldo a abonar" },
  { id: 7, grupo: "negociacion", label: "Argumenta ante historial de gestion" },
  { id: 8, grupo: "negociacion", label: "Refuta argumentos frente a negativa de pago" },
  { id: 9, grupo: "negociacion", label: "Informa consecuencias de atraso" },
  { id: 10, grupo: "negociacion", label: "Brinda información relevante" },

  // Cierre (6)
  { id: 11, grupo: "cierre", label: "Comprometió al titular o encargado de pago" },
  { id: 12, grupo: "cierre", label: "Solicita teléfonos alternativos / implementa otro medio" },
  { id: 13, grupo: "cierre", label: "Informa saldo deudor negociado" },
  { id: 14, grupo: "cierre", label: "Fecha de pago o de nueva comunicación (Acuerdo/Contacto)" },
  { id: 15, grupo: "cierre", label: "Holdeo correcto (Promesa o fecha de nueva comunicación)" },
  { id: 16, grupo: "cierre", label: "Informa y/o confirma medios de pago" },

  // Calidad de Gestión (8)
  { id: 17, grupo: "calidad", label: "Formalidad" },
  { id: 18, grupo: "calidad", label: "Transmite urgencia con seguridad y firmeza" },
  { id: 19, grupo: "calidad", label: "Aplica gestion MORA TARDIA" },
  { id: 20, grupo: "calidad", label: "Manejo de conflicto" },
  { id: 21, grupo: "calidad", label: "Analiza el comportamiento del titular" },
  { id: 22, grupo: "calidad", label: "Resolución de conflicto" },
  { id: 23, grupo: "calidad", label: "Observaciones correctas y completas (Mango)" },
  { id: 24, grupo: "calidad", label: "Cierre de gestión (Mango)" },
];

const ALL_IDS = CRITERIOS.map((c) => c.id);
const CRITERIOS_BY_ID = new Map(CRITERIOS.map((c) => [c.id, c]));

const PESOS = {
  presentacion: 0.1,
  negociacion: 0.4,
  cierre: 0.3,
  calidad: 0.2,
};

const UMBRAL_BAJO = 6.5;
const UMBRAL_ALTO = 7.5;

function uniqNums(arr = []) {
  return [...new Set((arr || []).map((n) => Number(n)).filter((n) => Number.isFinite(n)))];
}

function normalizarFallos(item = {}) {
  let fallos = [];

  if (Array.isArray(item.fallosIds)) {
    fallos = uniqNums(item.fallosIds);
  } else if (Array.isArray(item.okIds)) {
    const ok = new Set(uniqNums(item.okIds));
    fallos = ALL_IDS.filter((id) => !ok.has(id));
  } else if (item.checks && typeof item.checks === "object") {
    const ok = new Set(
      Object.entries(item.checks)
        .filter(([, v]) => !!v)
        .map(([k]) => Number(k))
        .filter((n) => Number.isFinite(n))
    );
    fallos = ALL_IDS.filter((id) => !ok.has(id));
  } else {
    fallos = [...ALL_IDS];
  }

  fallos = fallos.filter((id) => CRITERIOS_BY_ID.has(id)).sort((a, b) => a - b);
  return fallos;
}

function calcScoresFromFallos(fallosIds = []) {
  const fallos = new Set(fallosIds);

  const totales = { presentacion: 3, negociacion: 7, cierre: 6, calidad: 8 };
  const okCount = { presentacion: 0, negociacion: 0, cierre: 0, calidad: 0 };

  for (const id of ALL_IDS) {
    const c = CRITERIOS_BY_ID.get(id);
    if (!c) continue;
    if (!fallos.has(id)) okCount[c.grupo] += 1;
  }

  const scoreBloques = {
    presentacion: totales.presentacion ? (okCount.presentacion / totales.presentacion) * 10 : 0,
    negociacion: totales.negociacion ? (okCount.negociacion / totales.negociacion) * 10 : 0,
    cierre: totales.cierre ? (okCount.cierre / totales.cierre) * 10 : 0,
    calidad: totales.calidad ? (okCount.calidad / totales.calidad) * 10 : 0,
  };

  const scoreAudio =
    (scoreBloques.presentacion / 10) * PESOS.presentacion +
    (scoreBloques.negociacion / 10) * PESOS.negociacion +
    (scoreBloques.cierre / 10) * PESOS.cierre +
    (scoreBloques.calidad / 10) * PESOS.calidad;

  return {
    scoreBloques,
    scoreAudio: Number((scoreAudio * 10).toFixed(6)),
  };
}

function semaforo(scoreFinal) {
  if (scoreFinal < UMBRAL_BAJO) return "bajo";
  if (scoreFinal >= UMBRAL_ALTO) return "alto";
  return "medio";
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

    if (!getUsuarioId(req)) return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    throwIfAborted(req);

    const operadores = (
      await Empleado.find({
        isActive: true,
        role: { $in: ["operador", "operador-vip"] },
      })
        .select("username")
        .sort({ username: 1 })
        .lean()
    ).map((x) => String(x.username || ""));

    const motivos = ["aleatorio", "prueba", "bajo-rendimiento", "caso-nuevo", "reclamo-conflicto", "pedido-cliente", "otro"];

    const tiposInteraccion = ["LLAMADA_ENTRANTE", "LLAMADA_SALIENTE", "MENSAJE_ENTRANTE", "MENSAJE_SALIENTE"];

    return res.json({
      ok: true,
      operadores,
      motivos,
      tiposInteraccion,
      criterios: {
        pesos: PESOS,
        umbrales: { bajo: UMBRAL_BAJO, alto: UMBRAL_ALTO },
        lista: CRITERIOS,
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

    const items = itemsIn.map((it, idx) => {
      const telefono = String(it.telefono || "").trim();
      if (!telefono) throw new Error(`Cada item debe incluir telefono. (item #${idx + 1})`);

      const dni = String(it.dni || "").trim();
      const cartera = String(it.cartera || "").trim().toUpperCase();

      const fechaAudio = it.fechaAudio ? toDateOnly(it.fechaAudio) : null;
      const horaAprox = it.horaAprox ? normalizarHora(it.horaAprox) : "";

      const tipoInteraccion = String(it.tipoInteraccion || "LLAMADA_SALIENTE").trim().toUpperCase();
      const referencia = String(it.referencia || "").trim();

      const duracionSegundos = parseDuracionSegundos(it);
      if (isLlamada(tipoInteraccion) && duracionSegundos <= 0) {
        throw new Error(`Falta duración (segundos) para llamada en item #${idx + 1}.`);
      }

      const fallosIds = normalizarFallos(it);
      const { scoreBloques, scoreAudio } = calcScoresFromFallos(fallosIds);

      return {
        telefono,
        dni,
        cartera,
        fechaAudio,
        horaAprox,
        tipoInteraccion,
        referencia,
        duracionSegundos,
        fallosIds,
        scoreAudio,
        scoreBloques,
      };
    });

    const scoreFinal = Number(
      (items.reduce((acc, x) => acc + (Number(x.scoreAudio) || 0), 0) / items.length).toFixed(6)
    );

    const avg = (k) => items.reduce((acc, x) => acc + (Number(x.scoreBloques?.[k]) || 0), 0) / items.length;
    const scoreBloques = {
      presentacion: Number(avg("presentacion").toFixed(6)),
      negociacion: Number(avg("negociacion").toFixed(6)),
      cierre: Number(avg("cierre").toFixed(6)),
      calidad: Number(avg("calidad").toFixed(6)),
    };

    const doc = await AuditoriaContactoDirecto.create({
      propietario: new mongoose.Types.ObjectId(usuarioId),
      operadorUsername,
      auditorUsername,
      fechaAuditoria: body.fechaAuditoria ? toDateOnly(body.fechaAuditoria) : new Date(),
      motivosSeleccion: Array.isArray(body.motivosSeleccion) ? body.motivosSeleccion : [],
      // ❌ feedbackInformado / requiereCoaching removidos
      observacionesGenerales: String(body.observacionesGenerales || "").trim(),
      puntosPositivos: String(body.puntosPositivos || "").trim(),
      puntosAMejorar: String(body.puntosAMejorar || "").trim(),
      items,
      scoreFinal,
      scoreBloques,
      semaforo: semaforo(scoreFinal),
      borrado: false,
    });

    return res.status(201).json({ ok: true, item: doc });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

export async function listar(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { desde, hasta, operador, auditor, semaforo: sem, page = 1, limit = 50 } = req.query || {};

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
      items,
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
    if (!usuarioId) return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { id } = req.params;

    const doc = await AuditoriaContactoDirecto.findOne({
      _id: id,
      ...ownerScope(req),
      borrado: { $ne: true },
    }).lean();

    if (!doc) return res.status(404).json({ error: "Auditoría no encontrada." });

    return res.json({ ok: true, item: doc });
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

    if (body.operadorUsername) existing.operadorUsername = String(body.operadorUsername).toLowerCase().trim();
    if (body.fechaAuditoria) existing.fechaAuditoria = toDateOnly(body.fechaAuditoria) || existing.fechaAuditoria;

    existing.motivosSeleccion = Array.isArray(body.motivosSeleccion) ? body.motivosSeleccion : existing.motivosSeleccion;

    // ❌ feedbackInformado / requiereCoaching removidos

    existing.observacionesGenerales = String(body.observacionesGenerales || "").trim();
    existing.puntosPositivos = String(body.puntosPositivos || "").trim();
    existing.puntosAMejorar = String(body.puntosAMejorar || "").trim();

    const itemsIn = Array.isArray(body.items) ? body.items : [];
    if (itemsIn.length < 1) return res.status(400).json({ error: "Debe incluir al menos 1 audio/item." });
    if (itemsIn.length > 5) return res.status(400).json({ error: "Máximo 5 audios/items por auditoría." });

    const items = itemsIn.map((it, idx) => {
      const telefono = String(it.telefono || "").trim();
      if (!telefono) throw new Error(`Cada item debe incluir telefono. (item #${idx + 1})`);

      const dni = String(it.dni || "").trim();
      const cartera = String(it.cartera || "").trim().toUpperCase();

      const fechaAudio = it.fechaAudio ? toDateOnly(it.fechaAudio) : null;
      const horaAprox = it.horaAprox ? normalizarHora(it.horaAprox) : "";

      const tipoInteraccion = String(it.tipoInteraccion || "LLAMADA_SALIENTE").trim().toUpperCase();
      const referencia = String(it.referencia || "").trim();

      const duracionSegundos = parseDuracionSegundos(it);
      if (isLlamada(tipoInteraccion) && duracionSegundos <= 0) {
        throw new Error(`Falta duración (segundos) para llamada en item #${idx + 1}.`);
      }

      const fallosIds = normalizarFallos(it);
      const { scoreBloques, scoreAudio } = calcScoresFromFallos(fallosIds);

      return {
        telefono,
        dni,
        cartera,
        fechaAudio,
        horaAprox,
        tipoInteraccion,
        referencia,
        duracionSegundos,
        fallosIds,
        scoreAudio,
        scoreBloques,
      };
    });

    const scoreFinal = Number(
      (items.reduce((acc, x) => acc + (Number(x.scoreAudio) || 0), 0) / items.length).toFixed(6)
    );

    const avg = (k) => items.reduce((acc, x) => acc + (Number(x.scoreBloques?.[k]) || 0), 0) / items.length;
    const scoreBloques = {
      presentacion: Number(avg("presentacion").toFixed(6)),
      negociacion: Number(avg("negociacion").toFixed(6)),
      cierre: Number(avg("cierre").toFixed(6)),
      calidad: Number(avg("calidad").toFixed(6)),
    };

    existing.items = items;
    existing.scoreFinal = scoreFinal;
    existing.scoreBloques = scoreBloques;
    existing.semaforo = semaforo(scoreFinal);

    await existing.save();

    return res.json({ ok: true, item: existing });
  } catch (e) {
    if (e?.code === "CLIENT_ABORTED") return res.status(499).end();
    return res.status(500).json({ error: e.message });
  }
}

export async function borrar(req, res) {
  try {
    attachAbortFlag(req, res);

    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { id } = req.params;

    const doc = await AuditoriaContactoDirecto.findOne({
      _id: id,
      ...ownerScope(req),
      borrado: { $ne: true },
    });

    if (!doc) return res.status(404).json({ error: "Auditoría no encontrada." });

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
    if (!usuarioId) return res.status(401).json({ error: "Token inválido o ausente." });
    if (!ensureNoOperador(req, res)) return;

    const { desde, hasta, operador } = req.query || {};

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

    throwIfAborted(req);

    const [resumen] = await AuditoriaContactoDirecto.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          auditorias: { $sum: 1 },
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
      { $group: { _id: "$semaforo", count: { $sum: 1 } } },
      { $project: { _id: 0, semaforo: "$_id", count: 1 } },
    ]);

    const porOperador = await AuditoriaContactoDirecto.aggregate([
      { $match: match },
      { $group: { _id: "$operadorUsername", auditorias: { $sum: 1 }, avgFinal: { $avg: "$scoreFinal" } } },
      { $project: { _id: 0, operadorUsername: "$_id", auditorias: 1, avgFinal: 1 } },
      { $sort: { avgFinal: 1 } },
    ]);

    const topFallosRaw = await AuditoriaContactoDirecto.aggregate([
      { $match: match },
      { $unwind: "$items" },
      { $unwind: "$items.fallosIds" },
      { $group: { _id: "$items.fallosIds", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);

    const topFallos = topFallosRaw.map((x) => ({
      id: x._id,
      label: CRITERIOS_BY_ID.get(x._id)?.label || `Criterio ${x._id}`,
      grupo: CRITERIOS_BY_ID.get(x._id)?.grupo || "",
      count: x.count,
    }));

    return res.json({
      ok: true,
      resumen: {
        auditorias: resumen?.auditorias || 0,
        audios: resumen?.audios || 0,
        scorePromedio: Number((resumen?.avgFinal || 0).toFixed(4)),
        bloquesPromedio: {
          presentacion: Number((resumen?.avgPres || 0).toFixed(4)),
          negociacion: Number((resumen?.avgNeg || 0).toFixed(4)),
          cierre: Number((resumen?.avgCie || 0).toFixed(4)),
          calidad: Number((resumen?.avgCal || 0).toFixed(4)),
        },
      },
      semaforos,
      porOperador,
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
