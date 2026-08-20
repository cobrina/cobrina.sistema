import mongoose from "mongoose";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import NovedadRRHH from "../models/NovedadRRHH.js";
import AdelantoRRHH from "../models/AdelantoRRHH.js";
import ObjetivoMensual from "../models/ObjetivoMensual.js";
import Empleado from "../models/Empleado.js";
import Pago from "../models/Pago.js";
import Entidad from "../models/Entidad.js";
import SubCesion from "../models/SubCesion.js";
import { novedadSolapaRango, rangoMesLocal } from "../utils/calculoAsistencia.js";
import { filtrarEmpleadosControlados } from "../utils/controlEquipo.js";
import { normalizarEntidadNumero } from "../utils/normalizacionNegocio.js";
import { ROLES, normalizeStoredRole, normalizeUsername } from "../config/roles.js";
import { invalidateSeguimientoCache } from "./reportesSeguimientoController.js";
import { fechaClaveArgentina, mesClaveArgentina, toDateOnly } from "../utils/fecha.util.js";

const objectId = (value) =>
  mongoose.Types.ObjectId.isValid(String(value || ""))
    ? new mongoose.Types.ObjectId(String(value))
    : null;

const actorId = (req) => new mongoose.Types.ObjectId(req.user.id);

function rangoMesUTC(mes) {
  const match = String(mes || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const anio = Number(match[1]);
  const numeroMes = Number(match[2]);
  if (numeroMes < 1 || numeroMes > 12) return null;
  return {
    desde: new Date(Date.UTC(anio, numeroMes - 1, 1, 0, 0, 0, 0)),
    hasta: new Date(Date.UTC(anio, numeroMes, 0, 23, 59, 59, 999)),
  };
}

function filtroFechaMes(campo, mes) {
  const rango = rangoMesUTC(mes) || rangoMesLocal(mes);
  return { [campo]: { $gte: rango.desde, $lte: rango.hasta } };
}

function parseDate(value, fallback = null) {
  if (!value) return fallback;
  return toDateOnly(value);
}

const normalizarEncabezado = (value = "") =>
  String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const leerFilasMasivas = (buffer) => {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  return raw.map((row, index) => ({
    filaExcel: index + 2,
    datos: Object.fromEntries(
      Object.entries(row).map(([key, value]) => [normalizarEncabezado(key), value])
    ),
  }));
};

const enviarWorkbook = async (res, workbook, filename) => {
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(Buffer.from(buffer));
};

const enviarCsv = (res, filas, filename) => {
  const sheet = XLSX.utils.aoa_to_sheet(filas);
  const csv = XLSX.utils.sheet_to_csv(sheet, { FS: ",", RS: "\n" });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // BOM para que Excel reconozca correctamente tildes y eñes.
  return res.send(`\uFEFF${csv}`);
};

const quiereCsv = (req) =>
  [req.query?.formato, req.query?.format]
    .some((value) => String(value || "").trim().toLowerCase() === "csv");

const parseDiasLaborales = (value) => {
  const mapa = new Map([
    ["DOM", 0], ["DOMINGO", 0], ["LUN", 1], ["LUNES", 1],
    ["MAR", 2], ["MARTES", 2], ["MIE", 3], ["MIERCOLES", 3],
    ["JUE", 4], ["JUEVES", 4], ["VIE", 5], ["VIERNES", 5],
    ["SAB", 6], ["SABADO", 6],
  ]);
  const partes = String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().split(/[;,|/\s]+/).filter(Boolean);
  const dias = partes.map((parte) => {
    if (/^[0-6]$/.test(parte)) return Number(parte);
    return mapa.get(parte);
  });
  if (!dias.length || dias.some((dia) => dia === undefined)) return null;
  return [...new Set(dias)].sort((a, b) => a - b);
};

const horaValida = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "").trim());

const fechaFinNoAnterior = (desde, hasta) => !hasta || hasta >= desde;

function validarDatosNovedad(tipo, body, fechaDesde, fechaHasta) {
  if (!fechaFinNoAnterior(fechaDesde, fechaHasta)) {
    return "La fecha hasta no puede ser anterior a la fecha desde";
  }
  if (tipo === "cambio-horario") {
    const entrada = String(body.horaEntradaNueva || "").trim();
    const salida = String(body.horaSalidaNueva || "").trim();
    if (!horaValida(entrada) || !horaValida(salida)) {
      return "Completá un horario de entrada y salida válido";
    }
    const aMinutos = (value) => {
      const [h, m] = String(value || "").split(":").map(Number);
      return h * 60 + m;
    };
    if (aMinutos(salida) <= aMinutos(entrada)) return "La hora de salida debe ser posterior a la entrada";

    if (Boolean(body.jornadaPartidaNueva)) {
      const entrada2 = String(body.horaEntradaSegundaNueva || "").trim();
      const salida2 = String(body.horaSalidaSegundaNueva || "").trim();
      if (!horaValida(entrada2) || !horaValida(salida2)) {
        return "Completá el segundo bloque de la jornada partida";
      }
      if (aMinutos(salida2) <= aMinutos(entrada2)) {
        return "La salida del segundo bloque debe ser posterior a su entrada";
      }
      if (aMinutos(entrada2) <= aMinutos(salida)) {
        return "El segundo bloque debe comenzar después de finalizar el primero";
      }
    }
  }
  return "";
}

export async function listarNovedades(req, res) {
  try {
    const query = {};
    if (req.query.empleadoId) {
      const id = objectId(req.query.empleadoId);
      if (!id) return res.status(400).json({ error: "Empleado inválido" });
      query.empleadoId = id;
    }
    if (req.query.tipo) query.tipo = req.query.tipo;
    if (req.query.estado) query.estado = req.query.estado;
    if (req.query.mes) {
      const rango = rangoMesUTC(req.query.mes);
      if (!rango) return res.status(400).json({ error: "Mes inválido" });
      query.fechaDesde = { $lte: rango.hasta };
      query.$or = [
        { fechaHasta: null },
        { fechaHasta: { $gte: rango.desde } },
      ];
    }

    const items = await NovedadRRHH.find(query)
      .populate("empleadoId", "username nombre role")
      .populate("creadoPor", "username nombre")
      .populate("modificadoPor", "username nombre")
      .sort({ fechaDesde: -1, createdAt: -1 })
      .limit(1000)
      .lean();
    return res.json(items);
  } catch (error) {
    console.error("RRHH listar novedades:", error);
    return res.status(500).json({ error: "No se pudieron obtener las novedades" });
  }
}

export async function crearNovedad(req, res) {
  try {
    const empleadoId = objectId(req.body.empleadoId);
    const tipo = String(req.body.tipo || "").trim();
    const fechaDesde = parseDate(req.body.fechaDesde);
    let fechaHasta = parseDate(req.body.fechaHasta);
    const descripcion = String(req.body.descripcion || "").trim();
    if (!empleadoId || !fechaDesde || !tipo || !descripcion) {
      return res.status(400).json({ error: "Completá empleado, tipo, fecha y descripción" });
    }

    // Las novedades pueden abarcar uno o varios días. En cambios de horario
    // se admite además fechaHasta=null para reglas recurrentes "desde ahora".
    if (tipo === "licencia-medica" && !fechaHasta) {
      fechaHasta = fechaDesde;
    }
    const errorDatos = validarDatosNovedad(tipo, req.body, fechaDesde, fechaHasta);
    if (errorDatos) return res.status(400).json({ error: errorDatos });

    const empleado = await Empleado.findById(empleadoId).select("_id horarioLaboral").lean();
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });

    const entradaNueva = tipo === "cambio-horario" ? String(req.body.horaEntradaNueva || "").trim() : "";
    const salidaNueva = tipo === "cambio-horario" ? String(req.body.horaSalidaNueva || "").trim() : "";
    const jornadaPartidaNueva = tipo === "cambio-horario" && Boolean(req.body.jornadaPartidaNueva);
    const entradaSegundaNueva = jornadaPartidaNueva ? String(req.body.horaEntradaSegundaNueva || "").trim() : "";
    const salidaSegundaNueva = jornadaPartidaNueva ? String(req.body.horaSalidaSegundaNueva || "").trim() : "";
    const horarioAnterior = tipo === "cambio-horario"
      ? `${empleado.horarioLaboral?.entrada || ""}-${empleado.horarioLaboral?.salida || ""}`
      : String(req.body.horarioAnterior || "");
    const horarioNuevo = tipo === "cambio-horario"
      ? `${entradaNueva}-${salidaNueva}${jornadaPartidaNueva ? ` / ${entradaSegundaNueva}-${salidaSegundaNueva}` : ""}`
      : String(req.body.horarioNuevo || "");

    const item = await NovedadRRHH.create({
      empleadoId,
      tipo,
      motivoApercibimiento:
        tipo === "apercibimiento" ? req.body.motivoApercibimiento || "otro" : "",
      fechaDesde,
      fechaHasta,
      diasSemanaAplicables: tipo === "cambio-horario"
        ? (Array.isArray(req.body.diasSemanaAplicables)
            ? [...new Set(req.body.diasSemanaAplicables.map(Number).filter((dia) => Number.isInteger(dia) && dia >= 0 && dia <= 6))]
            : [])
        : [],
      horarioAnterior,
      horarioNuevo,
      horaEntradaNueva: entradaNueva,
      horaSalidaNueva: salidaNueva,
      jornadaPartidaNueva,
      horaEntradaSegundaNueva: entradaSegundaNueva,
      horaSalidaSegundaNueva: salidaSegundaNueva,
      toleranciaMinutosNueva: tipo === "cambio-horario"
        ? Math.max(0, Math.min(180, Number(req.body.toleranciaMinutosNueva ?? empleado.horarioLaboral?.toleranciaMinutos ?? 10)))
        : 10,
      minutosTarde: Number(req.body.minutosTarde || 0),
      justificado: Boolean(req.body.justificado || ["falta-justificada", "licencia-medica", "vacaciones"].includes(tipo)),
      descripcion,
      accionTomada: String(req.body.accionTomada || "").trim(),
      estado: req.body.estado || "vigente",
      creadoPor: actorId(req),
    });

    await item.populate("empleadoId", "username nombre role");
    if (["cambio-horario", "licencia-medica"].includes(tipo)) invalidateSeguimientoCache();
    return res.status(201).json(item);
  } catch (error) {
    console.error("RRHH crear novedad:", error);
    return res.status(400).json({ error: error.message || "No se pudo crear la novedad" });
  }
}

export async function actualizarNovedad(req, res) {
  try {
    const actual = await NovedadRRHH.findById(req.params.id).lean();
    if (!actual) return res.status(404).json({ error: "Novedad no encontrada" });

    const update = { ...req.body, modificadoPor: actorId(req) };
    delete update.creadoPor;
    if (update.empleadoId !== undefined) {
      const empleadoId = objectId(update.empleadoId);
      if (!empleadoId) return res.status(400).json({ error: "Empleado inválido" });
      const existeEmpleado = await Empleado.exists({ _id: empleadoId });
      if (!existeEmpleado) return res.status(404).json({ error: "Empleado no encontrado" });
      update.empleadoId = empleadoId;
    }
    if (update.fechaDesde) {
      update.fechaDesde = parseDate(update.fechaDesde);
      if (!update.fechaDesde) return res.status(400).json({ error: "Fecha inválida" });
    }
    if (update.fechaHasta !== undefined) update.fechaHasta = parseDate(update.fechaHasta);

    const tipo = String(update.tipo || actual.tipo || "");
    const fechaDesde = update.fechaDesde || actual.fechaDesde;
    let fechaHasta = update.fechaHasta !== undefined ? update.fechaHasta : actual.fechaHasta;
    if (tipo === "licencia-medica" && !fechaHasta) fechaHasta = fechaDesde;
    update.fechaHasta = fechaHasta;
    const datosCombinados = { ...actual, ...update };
    const errorDatos = validarDatosNovedad(tipo, datosCombinados, fechaDesde, fechaHasta);
    if (errorDatos) return res.status(400).json({ error: errorDatos });

    if (["licencia-medica", "vacaciones"].includes(tipo)) update.justificado = true;
    update.motivoApercibimiento = tipo === "apercibimiento"
      ? String(datosCombinados.motivoApercibimiento || "otro")
      : "";
    if (tipo === "cambio-horario") {
      update.diasSemanaAplicables = Array.isArray(datosCombinados.diasSemanaAplicables)
        ? [...new Set(datosCombinados.diasSemanaAplicables.map(Number).filter((dia) => Number.isInteger(dia) && dia >= 0 && dia <= 6))]
        : [];
      const partida = Boolean(datosCombinados.jornadaPartidaNueva);
      update.jornadaPartidaNueva = partida;
      update.horaEntradaSegundaNueva = partida ? String(datosCombinados.horaEntradaSegundaNueva || "").trim() : "";
      update.horaSalidaSegundaNueva = partida ? String(datosCombinados.horaSalidaSegundaNueva || "").trim() : "";
      update.horarioNuevo = `${datosCombinados.horaEntradaNueva}-${datosCombinados.horaSalidaNueva}${partida ? ` / ${update.horaEntradaSegundaNueva}-${update.horaSalidaSegundaNueva}` : ""}`;
      update.toleranciaMinutosNueva = Math.max(0, Math.min(180, Number(datosCombinados.toleranciaMinutosNueva ?? 10)));
    }

    const item = await NovedadRRHH.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    }).populate("empleadoId", "username nombre role");
    if (["cambio-horario", "licencia-medica"].includes(tipo)) invalidateSeguimientoCache();
    return res.json(item);
  } catch (error) {
    return res.status(400).json({ error: error.message || "No se pudo actualizar la novedad" });
  }
}

export async function eliminarNovedad(req, res) {
  try {
    const item = await NovedadRRHH.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ error: "Novedad no encontrada" });
    if (["cambio-horario", "licencia-medica"].includes(item.tipo)) invalidateSeguimientoCache();
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: "No se pudo eliminar la novedad" });
  }
}

export async function listarAdelantos(req, res) {
  try {
    const query = {};
    if (req.query.empleadoId) {
      const id = objectId(req.query.empleadoId);
      if (!id) return res.status(400).json({ error: "Empleado inválido" });
      query.empleadoId = id;
    }
    if (req.query.estado) query.estado = req.query.estado;
    if (req.query.mes) Object.assign(query, filtroFechaMes("fechaSolicitud", req.query.mes));
    const items = await AdelantoRRHH.find(query)
      .populate("empleadoId", "username nombre role")
      .populate("creadoPor", "username nombre")
      .populate("modificadoPor", "username nombre")
      .sort({ fechaSolicitud: -1, createdAt: -1 })
      .limit(1000)
      .lean();
    return res.json(items);
  } catch (error) {
    return res.status(500).json({ error: "No se pudieron obtener los adelantos" });
  }
}

export async function crearAdelanto(req, res) {
  try {
    const empleadoId = objectId(req.body.empleadoId);
    const monto = Number(req.body.monto);
    if (!empleadoId || !Number.isFinite(monto) || monto <= 0 || !String(req.body.motivo || "").trim()) {
      return res.status(400).json({ error: "Completá empleado, monto y motivo" });
    }
    const item = await AdelantoRRHH.create({
      empleadoId,
      fechaSolicitud: parseDate(req.body.fechaSolicitud, toDateOnly(fechaClaveArgentina())),
      monto,
      motivo: String(req.body.motivo).trim(),
      estado: req.body.estado || "solicitado",
      fechaResolucion: parseDate(req.body.fechaResolucion),
      fechaEntrega: parseDate(req.body.fechaEntrega),
      periodoDescuento: req.body.periodoDescuento || "",
      observaciones: req.body.observaciones || "",
      creadoPor: actorId(req),
    });
    await item.populate("empleadoId", "username nombre role");
    return res.status(201).json(item);
  } catch (error) {
    return res.status(400).json({ error: error.message || "No se pudo registrar el adelanto" });
  }
}

export async function actualizarAdelanto(req, res) {
  try {
    const update = { ...req.body, modificadoPor: actorId(req) };
    delete update.creadoPor;
    if (update.empleadoId !== undefined) {
      const empleadoId = objectId(update.empleadoId);
      if (!empleadoId) return res.status(400).json({ error: "Empleado inválido" });
      const existeEmpleado = await Empleado.exists({ _id: empleadoId });
      if (!existeEmpleado) return res.status(404).json({ error: "Empleado no encontrado" });
      update.empleadoId = empleadoId;
    }
    if (update.fechaSolicitud) {
      update.fechaSolicitud = parseDate(update.fechaSolicitud);
      if (!update.fechaSolicitud) return res.status(400).json({ error: "Fecha inválida" });
    }
    if (update.monto !== undefined) {
      update.monto = Number(update.monto);
      if (!Number.isFinite(update.monto) || update.monto <= 0) {
        return res.status(400).json({ error: "Monto inválido" });
      }
    }
    if (["aprobado", "rechazado", "cancelado", "descontado"].includes(update.estado) && !update.fechaResolucion) {
      update.fechaResolucion = toDateOnly(fechaClaveArgentina());
    }
    if (update.estado === "entregado" && !update.fechaEntrega) update.fechaEntrega = toDateOnly(fechaClaveArgentina());
    const item = await AdelantoRRHH.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    }).populate("empleadoId", "username nombre role");
    if (!item) return res.status(404).json({ error: "Adelanto no encontrado" });
    return res.json(item);
  } catch (error) {
    return res.status(400).json({ error: error.message || "No se pudo actualizar el adelanto" });
  }
}

export async function listarObjetivos(req, res) {
  try {
    const query = {};
    if (req.query.mes) query.mes = req.query.mes;
    if (req.query.alcance) query.alcance = req.query.alcance;
    const items = await ObjetivoMensual.find(query)
      .populate("empleadoId", "username nombre role")
      .populate("subCesionId", "nombre")
      .sort({ mes: -1, alcance: 1, createdAt: -1 })
      .lean();

    const numeros = [...new Set(items.map((x) => x.entidadNumero).filter(Boolean))];
    const entidades = await Entidad.find({ numero: { $in: numeros } }).select("numero nombre").lean();
    const mapa = new Map(entidades.map((e) => [Number(e.numero), e.nombre]));
    return res.json(items.map((item) => ({ ...item, entidadNombre: mapa.get(Number(item.entidadNumero)) || "" })));
  } catch (error) {
    return res.status(500).json({ error: "No se pudieron obtener los objetivos" });
  }
}

export async function guardarObjetivo(req, res) {
  try {
    const alcance = req.body.alcance;
    const mes = String(req.body.mes || "");
    const montoObjetivo = Number(req.body.montoObjetivo);
    if (!/^\d{4}-\d{2}$/.test(mes) || !["equipo", "operador", "entidad", "entidad-subcesion"].includes(alcance)) {
      return res.status(400).json({ error: "Mes o alcance inválido" });
    }
    if (!Number.isFinite(montoObjetivo) || montoObjetivo < 0) {
      return res.status(400).json({ error: "Objetivo inválido" });
    }

    const empleadoId = alcance === "operador" ? objectId(req.body.empleadoId) : null;
    const entidadNumero = ["entidad", "entidad-subcesion"].includes(alcance)
      ? normalizarEntidadNumero(req.body.entidadNumero)
      : null;
    const subCesionId = alcance === "entidad-subcesion" ? objectId(req.body.subCesionId) : null;

    if (alcance === "operador" && !empleadoId) return res.status(400).json({ error: "Elegí un operador" });
    if (["entidad", "entidad-subcesion"].includes(alcance) && !entidadNumero) {
      return res.status(400).json({ error: "Elegí una entidad" });
    }
    if (alcance === "entidad-subcesion" && !subCesionId) {
      return res.status(400).json({ error: "Elegí una subcesión" });
    }

    if (entidadNumero) {
      const existe = await Entidad.exists({ numero: entidadNumero });
      if (!existe) return res.status(400).json({ error: "La entidad no existe" });
    }
    if (subCesionId) {
      const existe = await SubCesion.exists({ _id: subCesionId });
      if (!existe) return res.status(400).json({ error: "La subcesión no existe" });
    }

    const filtro = { mes, alcance, empleadoId, entidadNumero, subCesionId };
    const item = await ObjetivoMensual.findOneAndUpdate(
      filtro,
      {
        $set: {
          montoObjetivo,
          observaciones: req.body.observaciones || "",
          activo: req.body.activo !== false,
          modificadoPor: actorId(req),
        },
        $setOnInsert: { creadoPor: actorId(req) },
      },
      { new: true, upsert: true, runValidators: true }
    )
      .populate("empleadoId", "username nombre role")
      .populate("subCesionId", "nombre");
    return res.status(201).json(item);
  } catch (error) {
    return res.status(400).json({ error: error.message || "No se pudo guardar el objetivo" });
  }
}


export async function actualizarObjetivo(req, res) {
  try {
    const actual = await ObjetivoMensual.findById(req.params.id);
    if (!actual) return res.status(404).json({ error: "Objetivo no encontrado" });

    const alcance = String(req.body.alcance || actual.alcance || "");
    const mes = String(req.body.mes || actual.mes || "");
    const montoObjetivo = Number(
      req.body.montoObjetivo !== undefined ? req.body.montoObjetivo : actual.montoObjetivo
    );
    if (!/^\d{4}-\d{2}$/.test(mes) || !["equipo", "operador", "entidad", "entidad-subcesion"].includes(alcance)) {
      return res.status(400).json({ error: "Mes o alcance inválido" });
    }
    if (!Number.isFinite(montoObjetivo) || montoObjetivo < 0) {
      return res.status(400).json({ error: "Objetivo inválido" });
    }

    const empleadoId = alcance === "operador"
      ? objectId(req.body.empleadoId ?? actual.empleadoId)
      : null;
    const entidadNumero = ["entidad", "entidad-subcesion"].includes(alcance)
      ? normalizarEntidadNumero(req.body.entidadNumero ?? actual.entidadNumero)
      : null;
    const subCesionId = alcance === "entidad-subcesion"
      ? objectId(req.body.subCesionId ?? actual.subCesionId)
      : null;

    if (alcance === "operador" && !empleadoId) return res.status(400).json({ error: "Elegí un operador" });
    if (["entidad", "entidad-subcesion"].includes(alcance) && !entidadNumero) {
      return res.status(400).json({ error: "Elegí una entidad" });
    }
    if (alcance === "entidad-subcesion" && !subCesionId) {
      return res.status(400).json({ error: "Elegí una subcesión" });
    }

    if (empleadoId && !(await Empleado.exists({ _id: empleadoId }))) {
      return res.status(400).json({ error: "El operador no existe" });
    }
    if (entidadNumero && !(await Entidad.exists({ numero: entidadNumero }))) {
      return res.status(400).json({ error: "La entidad no existe" });
    }
    if (subCesionId && !(await SubCesion.exists({ _id: subCesionId }))) {
      return res.status(400).json({ error: "La subcesión no existe" });
    }

    const duplicado = await ObjetivoMensual.exists({
      _id: { $ne: actual._id },
      mes,
      alcance,
      empleadoId,
      entidadNumero,
      subCesionId,
    });
    if (duplicado) {
      return res.status(409).json({ error: "Ya existe un objetivo con ese mes y alcance" });
    }

    actual.mes = mes;
    actual.alcance = alcance;
    actual.empleadoId = empleadoId;
    actual.entidadNumero = entidadNumero;
    actual.subCesionId = subCesionId;
    actual.montoObjetivo = montoObjetivo;
    actual.observaciones = String(req.body.observaciones ?? actual.observaciones ?? "").trim();
    actual.activo = req.body.activo !== undefined ? Boolean(req.body.activo) : actual.activo;
    actual.modificadoPor = actorId(req);
    await actual.save();
    await actual.populate("empleadoId", "username nombre role");
    await actual.populate("subCesionId", "nombre");
    return res.json(actual);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ error: "Ya existe un objetivo con ese mes y alcance" });
    }
    return res.status(400).json({ error: error.message || "No se pudo actualizar el objetivo" });
  }
}

export async function eliminarObjetivo(req, res) {
  try {
    const item = await ObjetivoMensual.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ error: "Objetivo no encontrado" });
    return res.json({ ok: true });
  } catch {
    return res.status(400).json({ error: "No se pudo eliminar el objetivo" });
  }
}

export async function descargarPlantillaHorarios(req, res) {
  try {
    const empleados = await Empleado.find({ isActive: { $ne: false } })
      .select("username email nombre horarioLaboral")
      .sort({ username: 1 })
      .lean();

    const filasHorarios = empleados.map((empleado) => ({
      usuario: empleado.username,
      email: empleado.email,
      nombre: empleado.nombre,
      modalidad: empleado.horarioLaboral?.modalidad === "libre" ? "LIBRE" : "FIJO",
      dias: empleado.horarioLaboral?.modalidad === "libre"
        ? ""
        : (empleado.horarioLaboral?.dias || [1, 2, 3, 4, 5]).join(","),
      entrada: empleado.horarioLaboral?.modalidad === "libre" ? "" : (empleado.horarioLaboral?.entrada || "09:00"),
      salida: empleado.horarioLaboral?.modalidad === "libre" ? "" : (empleado.horarioLaboral?.salida || "18:00"),
      tolerancia: empleado.horarioLaboral?.modalidad === "libre" ? 0 : (empleado.horarioLaboral?.toleranciaMinutos ?? 10),
    }));

    if (quiereCsv(req)) {
      return enviarCsv(
        res,
        [
          ["USUARIO", "EMAIL", "NOMBRE", "MODALIDAD", "DIAS_SEMANA", "ENTRADA", "SALIDA", "TOLERANCIA_MINUTOS"],
          ...filasHorarios.map((fila) => [
            fila.usuario,
            fila.email,
            fila.nombre,
            fila.modalidad,
            fila.dias,
            fila.entrada,
            fila.salida,
            fila.tolerancia,
          ]),
        ],
        "modelo-horarios-rrhh.csv"
      );
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Horarios");
    sheet.columns = [
      { header: "USUARIO", key: "usuario", width: 22 },
      { header: "EMAIL", key: "email", width: 30 },
      { header: "NOMBRE", key: "nombre", width: 30 },
      { header: "MODALIDAD", key: "modalidad", width: 16 },
      { header: "DIAS_SEMANA", key: "dias", width: 20 },
      { header: "ENTRADA", key: "entrada", width: 12 },
      { header: "SALIDA", key: "salida", width: 12 },
      { header: "TOLERANCIA_MINUTOS", key: "tolerancia", width: 22 },
    ];
    filasHorarios.forEach((fila) => sheet.addRow(fila));
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF29104F" } };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.addRow({});
    sheet.addRow({ usuario: "AYUDA", email: "MODALIDAD: FIJO o LIBRE. En LIBRE dejá días, entrada y salida vacíos. En FIJO usá 0=domingo ... 6=sábado." });
    return enviarWorkbook(res, workbook, "modelo-horarios-rrhh.xlsx");
  } catch (error) {
    console.error("RRHH plantilla horarios:", error);
    return res.status(500).json({ error: "No se pudo generar el modelo de horarios" });
  }
}

export async function importarHorariosMasivos(req, res) {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "Seleccioná un archivo XLSX, XLS o CSV" });
    const filas = leerFilasMasivas(req.file.buffer);
    if (!filas.length) return res.status(400).json({ error: "El archivo no contiene filas" });
    const empleados = await Empleado.find({}).select("_id username email").lean();
    const porUsuario = new Map(empleados.map((e) => [String(e.username).toLowerCase(), e]));
    const porEmail = new Map(empleados.map((e) => [String(e.email).toLowerCase(), e]));
    const errores = [];
    let actualizados = 0;
    for (const { filaExcel, datos } of filas) {
      const usuario = String(datos.USUARIO || "").trim().toLowerCase();
      const email = String(datos.EMAIL || "").trim().toLowerCase();
      if (usuario === "ayuda") continue;
      const empleado = porUsuario.get(usuario) || porEmail.get(email);
      const modalidadRaw = String(datos.MODALIDAD || "FIJO").trim().toUpperCase();
      const modalidad = ["LIBRE", "FLEXIBLE", "SIN HORARIO"].includes(modalidadRaw) ? "libre" : "fijo";
      const dias = modalidad === "libre" ? [] : parseDiasLaborales(datos.DIAS_SEMANA);
      const entrada = modalidad === "libre" ? "" : String(datos.ENTRADA || "").trim();
      const salida = modalidad === "libre" ? "" : String(datos.SALIDA || "").trim();
      const tolerancia = modalidad === "libre" ? 0 : Number(datos.TOLERANCIA_MINUTOS ?? 10);
      const problemas = [];
      if (!empleado) problemas.push("usuario o email no encontrado");
      if (modalidad === "fijo" && !dias) problemas.push("días inválidos");
      if (modalidad === "fijo" && !horaValida(entrada)) problemas.push("hora de entrada inválida");
      if (modalidad === "fijo" && !horaValida(salida)) problemas.push("hora de salida inválida");
      if (modalidad === "fijo" && horaValida(entrada) && horaValida(salida)) {
        const [eh, em] = entrada.split(":").map(Number);
        const [sh, sm] = salida.split(":").map(Number);
        if (sh * 60 + sm <= eh * 60 + em) problemas.push("la salida debe ser posterior a la entrada");
      }
      if (!Number.isFinite(tolerancia) || tolerancia < 0 || tolerancia > 180) problemas.push("tolerancia inválida");
      if (problemas.length) {
        errores.push({ fila: filaExcel, usuario: usuario || email || "-", error: problemas.join(", ") });
        continue;
      }
      await Empleado.updateOne({ _id: empleado._id }, {
        $set: { horarioLaboral: { modalidad, dias, entrada, salida, toleranciaMinutos: tolerancia } },
      }, { runValidators: true });
      actualizados += 1;
    }
    return res.json({ ok: true, actualizados, errores, totalFilas: filas.length });
  } catch (error) {
    console.error("RRHH importar horarios:", error);
    return res.status(400).json({ error: error.message || "No se pudieron importar los horarios" });
  }
}

export async function descargarPlantillaObjetivos(req, res) {
  try {
    const mes = mesClaveArgentina();
    const ejemplos = [
      { mes, alcance: "equipo", empleado: "", entidad: "", subcesion: "", monto: 1000000, observaciones: "Objetivo general" },
      { mes, alcance: "operador", empleado: "usuario.operador", entidad: "", subcesion: "", monto: 250000, observaciones: "" },
      { mes, alcance: "entidad", empleado: "", entidad: 1, subcesion: "", monto: 500000, observaciones: "" },
      { mes, alcance: "entidad-subcesion", empleado: "", entidad: 1, subcesion: "NOMBRE CARTERA", monto: 300000, observaciones: "" },
    ];

    if (quiereCsv(req)) {
      return enviarCsv(
        res,
        [
          ["MES", "ALCANCE", "EMPLEADO", "ENTIDAD_NUMERO", "SUBCESION", "MONTO_OBJETIVO", "OBSERVACIONES"],
          ...ejemplos.map((fila) => [
            fila.mes,
            fila.alcance,
            fila.empleado,
            fila.entidad,
            fila.subcesion,
            fila.monto,
            fila.observaciones,
          ]),
        ],
        "modelo-objetivos-rrhh.csv"
      );
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Objetivos");
    sheet.columns = [
      { header: "MES", key: "mes", width: 12 },
      { header: "ALCANCE", key: "alcance", width: 22 },
      { header: "EMPLEADO", key: "empleado", width: 24 },
      { header: "ENTIDAD_NUMERO", key: "entidad", width: 18 },
      { header: "SUBCESION", key: "subcesion", width: 24 },
      { header: "MONTO_OBJETIVO", key: "monto", width: 20 },
      { header: "OBSERVACIONES", key: "observaciones", width: 38 },
    ];
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF29104F" } };
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const ayuda = workbook.addWorksheet("Ejemplos y ayuda");
    ayuda.columns = sheet.columns.map((columna) => ({
      header: columna.header,
      key: columna.key,
      width: columna.width,
    }));
    ayuda.addRows(ejemplos);
    ayuda.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ayuda.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF29104F" } };
    ayuda.addRow({ observaciones: "Completá únicamente la hoja Objetivos. Esta hoja es de referencia y no se importa." });
    return enviarWorkbook(res, workbook, "modelo-objetivos-rrhh.xlsx");
  } catch (error) {
    console.error("RRHH plantilla objetivos:", error);
    return res.status(500).json({ error: "No se pudo generar el modelo de objetivos" });
  }
}

export async function importarObjetivosMasivos(req, res) {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "Seleccioná un archivo XLSX, XLS o CSV" });
    const filas = leerFilasMasivas(req.file.buffer);
    if (!filas.length) return res.status(400).json({ error: "El archivo no contiene filas" });
    const [empleados, entidades, subcesiones] = await Promise.all([
      Empleado.find({}).select("_id username email nombre").lean(),
      Entidad.find({}).select("numero nombre").lean(),
      SubCesion.find({}).select("_id nombre").lean(),
    ]);
    const empleadosMap = new Map();
    empleados.forEach((e) => [e.username, e.email, e.nombre].filter(Boolean).forEach((v) => empleadosMap.set(String(v).trim().toLowerCase(), e)));
    const entidadesMap = new Map(entidades.map((e) => [Number(e.numero), e]));
    const subcesionesMap = new Map(subcesiones.map((s) => [String(s.nombre).trim().toUpperCase(), s]));
    const errores = [];
    let actualizados = 0;
    for (const { filaExcel, datos } of filas) {
      const mes = String(datos.MES || "").trim();
      const alcance = String(datos.ALCANCE || "").trim().toLowerCase();
      const montoObjetivo = Number(String(datos.MONTO_OBJETIVO || "0").replace(/[$.\s]/g, "").replace(",", "."));
      const problemas = [];
      let empleadoId = null;
      let entidadNumero = null;
      let subCesionId = null;
      if (!/^\d{4}-\d{2}$/.test(mes)) problemas.push("mes inválido");
      if (!["equipo", "operador", "entidad", "entidad-subcesion"].includes(alcance)) problemas.push("alcance inválido");
      if (!Number.isFinite(montoObjetivo) || montoObjetivo < 0) problemas.push("monto inválido");
      if (alcance === "operador") {
        const empleado = empleadosMap.get(String(datos.EMPLEADO || "").trim().toLowerCase());
        if (!empleado) problemas.push("empleado no encontrado"); else empleadoId = empleado._id;
      }
      if (["entidad", "entidad-subcesion"].includes(alcance)) {
        entidadNumero = normalizarEntidadNumero(datos.ENTIDAD_NUMERO);
        if (!entidadNumero || !entidadesMap.has(Number(entidadNumero))) problemas.push("entidad inexistente");
      }
      if (alcance === "entidad-subcesion") {
        const sub = subcesionesMap.get(String(datos.SUBCESION || "").trim().toUpperCase());
        if (!sub) problemas.push("subcesión inexistente"); else subCesionId = sub._id;
      }
      if (problemas.length) {
        errores.push({ fila: filaExcel, error: problemas.join(", ") });
        continue;
      }
      const filtro = { mes, alcance, empleadoId, entidadNumero, subCesionId };
      await ObjetivoMensual.findOneAndUpdate(filtro, {
        $set: {
          montoObjetivo,
          observaciones: String(datos.OBSERVACIONES || "").trim(),
          activo: true,
          modificadoPor: actorId(req),
        },
        $setOnInsert: { creadoPor: actorId(req) },
      }, { upsert: true, new: true, runValidators: true });
      actualizados += 1;
    }
    return res.json({ ok: true, actualizados, errores, totalFilas: filas.length });
  } catch (error) {
    console.error("RRHH importar objetivos:", error);
    return res.status(400).json({ error: error.message || "No se pudieron importar los objetivos" });
  }
}

export async function resumenEmpleados(req, res) {
  try {
    const role = normalizeStoredRole(req.user?.role || req.user?.rol);
    const puedeVerAdelantos = [ROLES.ADMINISTRACION, ROLES.SUPERVISOR, ROLES.SUPER_ADMIN].includes(role);
    const { mes, desde, hasta, desdeClave, hastaClave } = rangoMesLocal(req.query.mes);
    const desdeNovedades = new Date(`${desdeClave}T00:00:00.000Z`);
    const hastaNovedades = new Date(`${hastaClave}T23:59:59.999Z`);
    const empleadosTodos = await Empleado.find({ isActive: { $ne: false } })
      .select("username nombre role horarioLaboral")
      .sort({ username: 1 })
      .lean();
    const empleados = filtrarEmpleadosControlados(empleadosTodos);
    const ids = empleados.map((e) => e._id);
    const usernames = empleados.map((e) => normalizeUsername(e.username)).filter(Boolean);

    const [pagosPorId, pagosPorUsername, objetivos, novedades, adelantos] = await Promise.all([
      Pago.aggregate([
        { $match: { fechaPago: { $gte: desde, $lte: hasta }, operadorId: { $in: ids } } },
        { $group: { _id: "$operadorId", total: { $sum: "$monto" }, cantidad: { $sum: 1 } } },
      ]),
      Pago.aggregate([
        {
          $match: {
            fechaPago: { $gte: desde, $lte: hasta },
            operadorUsername: { $in: usernames },
            $or: [
              { operadorId: null },
              { operadorId: { $exists: false } },
              { operadorId: { $nin: ids } },
            ],
          },
        },
        { $group: { _id: "$operadorUsername", total: { $sum: "$monto" }, cantidad: { $sum: 1 } } },
      ]),
      ObjetivoMensual.find({ mes, alcance: "operador", activo: true }).lean(),
      NovedadRRHH.find({
        empleadoId: { $in: ids },
        estado: { $ne: "anulado" },
        fechaDesde: { $lte: hastaNovedades },
        $or: [{ fechaHasta: null }, { fechaHasta: { $gte: desdeNovedades } }],
      }).lean(),
      puedeVerAdelantos
        ? AdelantoRRHH.find({ empleadoId: { $in: ids }, fechaSolicitud: { $gte: desde, $lte: hasta }, estado: { $nin: ["rechazado", "cancelado"] } }).lean()
        : Promise.resolve([]),
    ]);

    const pagoIdMap = new Map(pagosPorId.map((p) => [String(p._id), p]));
    const pagoUserMap = new Map(pagosPorUsername.map((p) => [normalizeUsername(p._id), p]));
    const novedadesPeriodo = novedades.filter((novedad) => novedadSolapaRango(novedad, desdeClave, hastaClave));
    const objetivoMap = new Map(objetivos.map((o) => [String(o.empleadoId), o]));

    const resultado = empleados.map((empleado) => {
      const id = String(empleado._id);
      const porId = pagoIdMap.get(id);
      const porUser = pagoUserMap.get(normalizeUsername(empleado.username));
      const recaudacion = Number(porId?.total || 0) + Number(porUser?.total || 0);
      const cantidadPagos = Number(porId?.cantidad || 0) + Number(porUser?.cantidad || 0);
      const objetivo = objetivoMap.get(id);
      const novedadesEmp = novedadesPeriodo.filter((n) => String(n.empleadoId) === id);
      const adelantosEmp = adelantos.filter((a) => String(a.empleadoId) === id);
      const montoAdelantos = adelantosEmp.reduce((sum, a) => sum + Number(a.monto || 0), 0);
      const montoObjetivo = Number(objetivo?.montoObjetivo || 0);
      return {
        empleado,
        recaudacion,
        cantidadPagos,
        objetivo: montoObjetivo,
        porcentajeObjetivo: montoObjetivo > 0 ? Math.round((recaudacion / montoObjetivo) * 1000) / 10 : null,
        llegoObjetivo: montoObjetivo > 0 ? recaudacion >= montoObjetivo : null,
        horarioLibre: empleado.horarioLaboral?.modalidad === "libre",
        horarioBase: {
          modalidad: empleado.horarioLaboral?.modalidad === "libre" ? "libre" : "fijo",
          entrada: empleado.horarioLaboral?.entrada || "",
          salida: empleado.horarioLaboral?.salida || "",
          dias: Array.isArray(empleado.horarioLaboral?.dias) ? empleado.horarioLaboral.dias : [],
        },
        faltas: novedadesEmp.filter((n) => n.tipo === "falta").length,
        faltasJustificadas: novedadesEmp.filter((n) => n.tipo === "falta-justificada").length,
        llegadasTarde: novedadesEmp.filter((n) => n.tipo === "llegada-tarde").length,
        apercibimientos: novedadesEmp.filter((n) => ["apercibimiento", "error-grave-gestion"].includes(n.tipo)).length,
        licenciasMedicas: novedadesEmp.filter((n) => n.tipo === "licencia-medica").length,
        vacaciones: novedadesEmp.filter((n) => n.tipo === "vacaciones").length,
        cambiosHorario: novedadesEmp.filter((n) => n.tipo === "cambio-horario").length,
        adelantosCantidad: puedeVerAdelantos ? adelantosEmp.length : null,
        adelantosMonto: puedeVerAdelantos ? montoAdelantos : null,
      };
    });

    return res.json({ mes, empleados: resultado });
  } catch (error) {
    console.error("RRHH resumen empleados:", error);
    return res.status(500).json({ error: "No se pudo preparar el resumen de Recursos Humanos" });
  }
}
