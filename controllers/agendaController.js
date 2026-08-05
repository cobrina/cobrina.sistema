import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import AgendaItem from "../models/AgendaItem.js";
import Empleado from "../models/Empleado.js";
import { canAssignAgenda } from "../config/roles.js";

const fechaValida = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
const horaValida = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "").trim());
const TIPOS = new Set(["tarea", "reunion", "recordatorio"]);
const RECURRENCIAS = new Set(["semanal", "mensual"]);
const MAX_OCURRENCIAS = 120;

function limpiarTexto(value, max) {
  return String(value || "").trim().slice(0, max);
}

function puedeAsignar(req) {
  return canAssignAgenda(req.user?.role);
}

function fechaUTCDesdeClave(clave) {
  const [anio, mes, dia] = String(clave || "").split("-").map(Number);
  return new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0, 0));
}

function claveDesdeFechaUTC(fecha) {
  return fecha.toISOString().slice(0, 10);
}

function sumarMesConAncla(fecha, meses, diaAncla) {
  const objetivo = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth() + meses, 1, 12));
  const ultimoDia = new Date(Date.UTC(objetivo.getUTCFullYear(), objetivo.getUTCMonth() + 1, 0, 12)).getUTCDate();
  objetivo.setUTCDate(Math.min(diaAncla, ultimoDia));
  return objetivo;
}

function fechasRecurrencia(fechaInicial, recurrencia, hastaClave) {
  if (!recurrencia) return [fechaInicial];
  if (!RECURRENCIAS.has(recurrencia)) throw new Error("Frecuencia de repetición inválida");
  if (!fechaValida(hastaClave) || hastaClave < fechaInicial) {
    throw new Error("Elegí hasta qué fecha se repite la actividad");
  }

  const inicio = fechaUTCDesdeClave(fechaInicial);
  const diaAncla = inicio.getUTCDate();
  const fechas = [];
  let cursor = new Date(inicio);
  let indice = 0;
  while (claveDesdeFechaUTC(cursor) <= hastaClave && fechas.length < MAX_OCURRENCIAS) {
    fechas.push(claveDesdeFechaUTC(cursor));
    indice += 1;
    cursor = recurrencia === "semanal"
      ? new Date(cursor.getTime() + 7 * 86_400_000)
      : sumarMesConAncla(inicio, indice, diaAncla);
  }
  if (!fechas.length) throw new Error("No se pudieron generar las repeticiones");
  return fechas;
}

function normalizarPayload(body = {}, { parcial = false } = {}) {
  const payload = {};

  if (!parcial || body.fechaClave !== undefined) {
    const fechaClave = String(body.fechaClave || "").trim();
    if (!fechaValida(fechaClave)) throw new Error("Fecha inválida");
    payload.fechaClave = fechaClave;
  }

  if (!parcial || body.hora !== undefined) {
    const hora = String(body.hora || "").trim();
    if (!horaValida(hora)) throw new Error("Hora inválida");
    payload.hora = hora;
  }

  if (!parcial || body.titulo !== undefined) {
    const titulo = limpiarTexto(body.titulo, 180);
    if (!titulo) throw new Error("Escribí un título para la actividad");
    payload.titulo = titulo;
  }

  if (body.detalle !== undefined) payload.detalle = limpiarTexto(body.detalle, 1200);

  if (body.tipo !== undefined || !parcial) {
    const tipo = String(body.tipo || "tarea").trim().toLowerCase();
    payload.tipo = TIPOS.has(tipo) ? tipo : "tarea";
  }

  if (body.completada !== undefined) payload.completada = Boolean(body.completada);

  return payload;
}

function normalizarItem(item, userId) {
  const propietarioId = String(item?.propietario?._id || item?.propietario || "");
  const creadorId = String(item?.creadoPor?._id || item?.creadoPor || "");
  const creadorUsername =
    item?.creadoPor?.username || item?.creadoPorUsername || "";

  return {
    ...item,
    propietario: propietarioId,
    creadoPor: creadorId,
    creadoPorUsername: creadorUsername,
    asignadaPorOtro: Boolean(creadorId && propietarioId && creadorId !== propietarioId),
    creadaPorMi: creadorId === String(userId),
  };
}

async function resolverPropietario(req) {
  const solicitado = String(req.body?.destinatarioId || "").trim();
  if (!solicitado || !puedeAsignar(req)) return String(req.user.id);
  if (!mongoose.Types.ObjectId.isValid(solicitado)) throw new Error("Destinatario inválido");

  const empleado = await Empleado.findOne({ _id: solicitado, isActive: { $ne: false } })
    .select("_id")
    .lean();
  if (!empleado) throw new Error("El destinatario no existe o está inactivo");
  return String(empleado._id);
}

function filtroAcceso(req, id) {
  const filtro = { _id: id };
  if (puedeAsignar(req)) {
    filtro.$or = [{ propietario: req.user.id }, { creadoPor: req.user.id }];
  } else {
    filtro.propietario = req.user.id;
  }
  return filtro;
}

export async function listarDestinatariosAgenda(req, res) {
  try {
    if (!puedeAsignar(req)) return res.json({ ok: true, items: [] });
    const items = await Empleado.find({ isActive: { $ne: false } })
      .select("username nombre role")
      .sort({ username: 1 })
      .lean();
    return res.json({
      ok: true,
      items: items.map((item) => ({
        id: String(item._id),
        username: item.username,
        nombre: item.nombre || "",
        role: item.role,
      })),
    });
  } catch {
    return res.status(500).json({ error: "No se pudieron cargar los destinatarios" });
  }
}

export async function listarAgenda(req, res) {
  try {
    const desde = String(req.query.desde || "").trim();
    const hasta = String(req.query.hasta || "").trim();

    if (!fechaValida(desde) || !fechaValida(hasta) || desde > hasta) {
      return res.status(400).json({ error: "Rango de fechas inválido" });
    }

    const items = await AgendaItem.find({
      propietario: req.user.id,
      fechaClave: { $gte: desde, $lte: hasta },
    })
      .populate("creadoPor", "username nombre role")
      .sort({ fechaClave: 1, hora: 1, createdAt: 1 })
      .lean();

    return res.json({
      ok: true,
      items: items.map((item) => normalizarItem(item, req.user.id)),
    });
  } catch {
    return res.status(500).json({ error: "No se pudo cargar la agenda" });
  }
}

export async function crearAgendaItem(req, res) {
  try {
    const payload = normalizarPayload(req.body);
    const propietario = await resolverPropietario(req);
    const recurrencia = String(req.body?.recurrencia || "").trim().toLowerCase();
    const recurrenciaHasta = recurrencia ? String(req.body?.recurrenciaHasta || "").trim() : "";
    const fechas = fechasRecurrencia(payload.fechaClave, recurrencia, recurrenciaHasta);
    const serieId = fechas.length > 1 ? randomUUID() : "";
    const base = {
      ...payload,
      propietario,
      creadoPor: req.user.id,
      creadoPorUsername: req.user.username || "",
      recurrencia: fechas.length > 1 ? recurrencia : "",
      recurrenciaHasta: fechas.length > 1 ? recurrenciaHasta : "",
      serieId,
    };
    const creados = await AgendaItem.insertMany(
      fechas.map((fechaClave, indiceRecurrencia) => ({
        ...base,
        fechaClave,
        indiceRecurrencia,
        completada: false,
      })),
      { ordered: true }
    );
    const items = await AgendaItem.find({ _id: { $in: creados.map((item) => item._id) } })
      .populate("creadoPor", "username nombre role")
      .sort({ fechaClave: 1, hora: 1 })
      .lean();
    return res.status(201).json({
      ok: true,
      item: normalizarItem(items[0], req.user.id),
      items: items.map((item) => normalizarItem(item, req.user.id)),
      count: items.length,
      serieId,
    });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "No se pudo crear la actividad" });
  }
}

export async function actualizarAgendaItem(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Actividad inválida" });
    }

    const cambios = normalizarPayload(req.body, { parcial: true });
    const item = await AgendaItem.findOneAndUpdate(
      filtroAcceso(req, req.params.id),
      { $set: cambios },
      { new: true, runValidators: true }
    )
      .populate("creadoPor", "username nombre role")
      .lean();

    if (!item) return res.status(404).json({ error: "Actividad no encontrada" });
    return res.json({ ok: true, item: normalizarItem(item, req.user.id) });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "No se pudo actualizar la actividad" });
  }
}

export async function alternarCompletada(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Actividad inválida" });
    }

    const itemActual = await AgendaItem.findOne(filtroAcceso(req, req.params.id));
    if (!itemActual) return res.status(404).json({ error: "Actividad no encontrada" });

    itemActual.completada =
      req.body?.completada === undefined ? !itemActual.completada : Boolean(req.body.completada);
    await itemActual.save();

    return res.json({ ok: true, item: normalizarItem(itemActual.toObject(), req.user.id) });
  } catch {
    return res.status(500).json({ error: "No se pudo actualizar el estado" });
  }
}

export async function eliminarAgendaItem(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Actividad inválida" });
    }

    const item = await AgendaItem.findOneAndDelete(filtroAcceso(req, req.params.id)).lean();
    if (!item) return res.status(404).json({ error: "Actividad no encontrada" });
    return res.json({ ok: true, mensaje: "Actividad eliminada" });
  } catch {
    return res.status(500).json({ error: "No se pudo eliminar la actividad" });
  }
}
