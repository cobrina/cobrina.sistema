import Proyeccion from "../models/Proyeccion.js";
import ExcelJS from "exceljs";
import { formatearFecha } from "../utils/formatearFecha.js";
import Entidad from "../models/Entidad.js";
import SubCesion from "../models/SubCesion.js";
import Empleado from "../models/Empleado.js";
import mongoose from "mongoose";

const rolDe = (req) => req.user.role || req.user.rol;
const esSuper = (req) => rolDe(req) === "super-admin";
const esAdmin = (req) => rolDe(req) === "admin";
const esOp = (req) => rolDe(req) === "operador";
const esVip = (req) => rolDe(req) === "operador-vip";
const esOperativo = (req) => esOp(req) || esVip(req); // ambos operadores

const recalcularImportePagado = (proy) =>
  (proy.pagosInformados || [])
    .filter((p) => !p.erroneo)
    .reduce((acc, p) => acc + Number(p.monto || 0), 0);

const parseSelectLabel = (v) => {
  if (v == null) return "";
  const s = String(v).trim();
  const m = s.match(/^\s*(?:[0-9a-f]{24}|\d+)\s*-\s*(.+)$/i);
  return (m ? m[1] : s).trim();
};

const toISODate = (v) => {
  const d = parseExcelDate(v);
  return d ? d.toISOString().slice(0, 10) : (v == null ? "" : String(v));
};

const buildLabelMaps = async () => {
  const [ents, subs] = await Promise.all([
    Entidad.find({}, "nombre").sort({ nombre: 1 }).lean(),
    SubCesion.find({}, "nombre").sort({ nombre: 1 }).lean(),
  ]);
  const entLabelById = new Map();
  const subLabelById = new Map();
  ents.forEach((e, i) => entLabelById.set(String(e._id), `${i + 1} - ${e.nombre}`));
  subs.forEach((s, i) => subLabelById.set(String(s._id), `${i + 1} - ${s.nombre}`));
  const entLabel = (id, fallbackName) =>
    id ? (entLabelById.get(String(id)) || (fallbackName ? `- ${fallbackName}` : "")) : (fallbackName || "");
  const subLabel = (id, fallbackName) =>
    id ? (subLabelById.get(String(id)) || (fallbackName ? `- ${fallbackName}` : "")) : (fallbackName || "");
  return { entLabel, subLabel, entLabelById, subLabelById };
};

const determinarEstadoCierre = (proy) => {
  const importe = Number(proy.importe || 0);
  const pagadoReal = recalcularImportePagado(proy); // solo pagos NO erróneos

  if (pagadoReal >= importe && importe > 0) return "Cerrada cumplida";
  if (pagadoReal > 0 && pagadoReal < importe) return "Cerrada pago parcial";
  return "Cerrada incumplida";
};

const crearFechaLocal = (fechaStr, finDelDia = false) => {
  const [anio, mes, dia] = fechaStr.split("-").map(Number);
  return new Date(
    anio,
    mes - 1,
    dia,
    finDelDia ? 23 : 0,
    finDelDia ? 59 : 0,
    finDelDia ? 59 : 0,
    finDelDia ? 999 : 0
  );
};

function parseExcelDate(v) {
  if (v === undefined || v === null || v === "") return null;

  if (v instanceof Date && !isNaN(v)) {
    const d = new Date(v.getTime());
    d.setHours(12, 0, 0, 0); // mediodía local para evitar corrimientos
    return d;
  }
  if (typeof v === "number" && isFinite(v)) {
    const epoch = new Date(Date.UTC(1899, 11, 30)); // base Excel
    const ms = Math.round(v * 86400000);
    const d = new Date(epoch.getTime() + ms);
    d.setHours(12, 0, 0, 0);
    return isNaN(d) ? null : d;
  }
  if (typeof v === "string") {
    const s = v.trim();
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
      const dd = +m[1],
        mm = +m[2] - 1;
      let yy = +m[3];
      if (yy < 100) yy += 2000;
      const d = new Date(yy, mm, dd, 12, 0, 0, 0);
      return isNaN(d) ? null : d;
    }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
      return isNaN(d) ? null : d;
    }
    const d = new Date(s);
    if (!isNaN(d)) {
      d.setHours(12, 0, 0, 0);
      return d;
    }
  }
  return null;
}

function clasificarEstado(fechaPromesa) {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const f = fechaPromesa ? new Date(fechaPromesa) : null;
  if (f && f >= hoy) return "Promesa activa";
  if (f && f < hoy) return "Promesa caída";
  return "Pendiente";
}

const estaCerrada = (p) =>
  p?.isActiva === false || /^Cerrada/.test(p?.estado || "");

/* === fin helpers globales === */

export const evaluarEstadoPago = (proy) => {
  const importe = parseFloat(proy.importe || 0);
  const pagado = parseFloat(proy.importePagado || 0);

  if (pagado >= importe) return "Pagado";
  if (pagado > 0 && pagado < importe) return "Pagado parcial";
  return proy.estado; // No cambiar si no aplica
};

export const actualizarEstadoAutomaticamente = async (proy) => {
  // 🚫 No recalcular si ya está cerrada o marcada inactiva
  if (proy.isActiva === false || /^Cerrada/.test(proy.estado)) {
    return proy; // nada que hacer
  }

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  const importe = parseFloat(proy.importe || 0);
  const pagado = parseFloat(proy.importePagado || 0);
  const fechaPromesa = proy.fechaPromesa ? new Date(proy.fechaPromesa) : null;

  let nuevoEstado = proy.estado;

  if (pagado >= importe) {
    nuevoEstado = "Pagado";
  } else if (pagado > 0 && pagado < importe) {
    nuevoEstado = "Pagado parcial";
  } else if (pagado === 0 && fechaPromesa) {
    const fecha = new Date(fechaPromesa);
    fecha.setHours(0, 0, 0, 0);

    if (fecha.getTime() < hoy.getTime()) nuevoEstado = "Promesa caída";
    else if (fecha.getTime() === hoy.getTime()) nuevoEstado = "Pendiente";
    else nuevoEstado = "Promesa activa";
  }

  if (proy.estado !== nuevoEstado) {
    proy.estado = nuevoEstado;
    proy.ultimaModificacion = new Date();
    await proy.save();
  }

  return proy;
};

export const crearProyeccion = async (req, res) => {
  try {
    if (esAdmin(req)) return res.status(403).json({ error: "Sin acceso" });
    if (!esSuper(req) && !esOperativo(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const {
      dni,
      nombreTitular,
      importe,
      estado,
      fechaPromesa,
      fechaProximoLlamado,
      concepto,
      entidadId,
      subCesionId,
      ...otrosCampos
    } = req.body;

    // ✅ Validación con mensajes claros
    const oblig = {
      dni,
      nombreTitular,
      importe,
      estado,
      concepto,
      fechaPromesa,
      fechaProximoLlamado,
      entidadId,
      subCesionId,
    };
    const faltan = Object.entries(oblig)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (faltan.length) {
      return res
        .status(400)
        .json({ error: `Faltan completar: ${faltan.join(", ")}` });
    }

    // ✅ Fechas
    if (isNaN(Date.parse(fechaPromesa))) {
      return res.status(400).json({ error: "Fecha de promesa inválida" });
    }
    if (isNaN(Date.parse(fechaProximoLlamado))) {
      return res.status(400).json({ error: "Fecha próximo llamado inválida" });
    }

    // ✅ Importe
    const importeNumerico = Number(importe);
    if (!Number.isFinite(importeNumerico) || importeNumerico <= 0) {
      return res.status(400).json({ error: "Importe inválido" });
    }

    // ✅ ENTIDAD & SUBCESIÓN deben existir
    if (!mongoose.Types.ObjectId.isValid(entidadId)) {
      return res.status(400).json({ error: "entidadId inválido" });
    }
    if (!mongoose.Types.ObjectId.isValid(subCesionId)) {
      return res.status(400).json({ error: "subCesionId inválido" });
    }

    const entidad = await Entidad.findById(entidadId);
    if (!entidad)
      return res.status(400).json({ error: "Entidad no encontrada" });

    const subCesion = await SubCesion.findById(subCesionId);
    if (!subCesion)
      return res.status(400).json({ error: "SubCesión no encontrada" });

    // ── Regla 1-activa: cerrar activa previa para (dni, entidadId, subCesionId)
    let infoCierreAnterior = null;
    const activaPrevia = await Proyeccion.findOne({
      dni,
      entidadId,
      subCesionId,
      $or: [{ isActiva: true }, { isActiva: { $exists: false } }],
    });

    if (activaPrevia) {
      const nuevoEstado = determinarEstadoCierre(activaPrevia);
      activaPrevia.isActiva = false;
      activaPrevia.estado = nuevoEstado;
      activaPrevia.ultimaModificacion = new Date();
      await activaPrevia.save();

      infoCierreAnterior = {
        proyeccionId: String(activaPrevia._id),
        estadoCierre: nuevoEstado,
        mensaje: `La promesa anterior se cerró automáticamente como: ${nuevoEstado}.`,
      };
    }

    // Datos derivados
    const fecha = new Date(`${fechaPromesa}T12:00:00`);
    const anio = fecha.getFullYear();
    const mes = fecha.getMonth() + 1;

    // 🔑 ID lógico normalizado
    const idProyeccionLogico = `${dni}-${entidadId}-${subCesionId}`;

    // ✅ Crear proyección nueva (activa)
    let nueva = new Proyeccion({
      dni,
      nombreTitular,
      importe: importeNumerico,
      estado,
      concepto,

      // 🔵 Campos normalizados
      entidadId,
      subCesionId,
      idProyeccionLogico,

      fechaPromesa,
      fechaProximoLlamado,
      fechaPromesaInicial: fechaPromesa,
      anio,
      mes,
      ...otrosCampos,

      empleadoId: req.user.id,
      creado: new Date(),
      ultimaModificacion: new Date(),
      isActiva: true,
    });

    // Ajuste de estado “en caliente”
    nueva = await actualizarEstadoAutomaticamente(nueva);
    await nueva.save();

    res.json({
      ...nueva.toObject(),
      infoCierreAnterior, // null si no había activa previa
    });
  } catch (error) {
    // Índice único esperado: (dni, entidadId, subCesionId, isActiva:true)
    if (error?.code === 11000) {
      return res.status(409).json({
        error:
          "Ya existe una promesa activa para este DNI + ENTIDAD + SUBCESIÓN.",
      });
    }
    console.error("❌ Error al crear proyección:", error);
    res.status(500).json({ error: "Error al crear proyección" });
  }
};

// 2. Obtener proyecciones propias
export const obtenerProyeccionesPropias = async (req, res) => {
  try {
    if (esAdmin(req)) return res.status(403).json({ error: "Sin acceso" });

    const campos =
      "empleadoId dni nombreTitular importe importePagado estado concepto " +
      "entidadId subCesionId fechaPromesa fechaProximoLlamado creado ultimaModificacion " +
      "vecesTocada ultimaGestion observaciones";

    const docs = await Proyeccion.find({ empleadoId: req.user.id })
      .select(campos)
      .populate("empleadoId", "username")
      .populate("entidadId", "nombre numero")
      .populate("subCesionId", "nombre")
      .sort({ creado: -1 })
      .lean();

    const resultados = docs.map((p) => {
      const estadoVista = (typeof clasificarEstado === "function" && p.fechaPromesa)
        ? clasificarEstado(new Date(p.fechaPromesa))
        : p.estado;

      return {
        ...p,
        empleadoUsername: p?.empleadoId?.username || "-",
        entidadNombre: p?.entidadId?.nombre || "-",
        subCesionNombre: p?.subCesionId?.nombre || "-",
        estado: estadoVista,
      };
    });

    return res.json(resultados);
  } catch (error) {
    console.error("❌ Error al obtener proyecciones propias:", error);
    res.status(500).json({ error: "Error al obtener proyecciones" });
  }
};


// 3. Actualizar proyección
export const actualizarProyeccion = async (req, res) => {
  try {
    const proyeccion = await Proyeccion.findById(req.params.id);
    if (!proyeccion) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    // 🔒 no permitir editar cuentas cerradas
    const cerrada =
      proyeccion.isActiva === false ||
      /^Cerrada/.test(String(proyeccion.estado || ""));
    if (cerrada) {
      return res
        .status(409)
        .json({ error: "La proyección está cerrada y no puede editarse." });
    }

    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso" });
    }
    if (
      esOperativo(req) &&
      String(proyeccion.empleadoId) !== String(req.user.id)
    ) {
      return res.status(403).json({ error: "No autorizado para editar" });
    }

    const {
      dni,
      nombreTitular,
      importe,
      concepto,
      entidadId,
      subCesionId,
      fechaPromesa,
      fechaProximoLlamado,
      ...resto
    } = req.body;

    // ✅ obligatorios ya migrados
    const camposObligatorios = {
      dni,
      nombreTitular,
      importe,
      concepto,
      entidadId,
      subCesionId,
    };
    const faltan = Object.entries(camposObligatorios)
      .filter(([, v]) => !v && v !== 0)
      .map(([k]) => k);
    if (faltan.length) {
      return res
        .status(400)
        .json({ error: `Faltan completar: ${faltan.join(", ")}` });
    }

    // ✅ fechas (si vienen)
    if (fechaPromesa && isNaN(Date.parse(fechaPromesa))) {
      return res.status(400).json({ error: "Fecha de promesa inválida" });
    }
    if (fechaProximoLlamado && isNaN(Date.parse(fechaProximoLlamado))) {
      return res.status(400).json({ error: "Fecha próximo llamado inválida" });
    }

    // ✅ importe
    const importeNumerico = Number(importe);
    if (!Number.isFinite(importeNumerico)) {
      return res.status(400).json({ error: "Importe inválido" });
    }

    // ✅ ids válidos + existencia
    if (!mongoose.Types.ObjectId.isValid(entidadId)) {
      return res.status(400).json({ error: "entidadId inválido" });
    }
    if (!mongoose.Types.ObjectId.isValid(subCesionId)) {
      return res.status(400).json({ error: "subCesionId inválido" });
    }
    const [entidad, subCesion] = await Promise.all([
      Entidad.findById(entidadId),
      SubCesion.findById(subCesionId),
    ]);
    if (!entidad)
      return res.status(400).json({ error: "Entidad no encontrada" });
    if (!subCesion)
      return res.status(400).json({ error: "SubCesión no encontrada" });

    // 🔎 si cambia la clave lógica (dni/entidad/subCesión), evitar duplicar activas
    const cambiaClave =
      String(proyeccion.dni) !== String(dni) ||
      String(proyeccion.entidadId) !== String(entidadId) ||
      String(proyeccion.subCesionId) !== String(subCesionId);

    if (cambiaClave) {
      const yaActiva = await Proyeccion.findOne({
        _id: { $ne: proyeccion._id },
        dni,
        entidadId,
        subCesionId,
        $or: [{ isActiva: true }, { isActiva: { $exists: false } }],
      }).lean();

      if (yaActiva) {
        return res.status(409).json({
          error:
            "Ya existe una promesa activa para este DNI + ENTIDAD + SUBCESIÓN. Cierra la otra o elige otra combinación.",
        });
      }
    }

    const updateData = {
      dni,
      nombreTitular,
      importe: importeNumerico,
      concepto,
      entidadId,
      subCesionId,
      fechaPromesa,
      fechaProximoLlamado,
      ultimaModificacion: new Date(),
      ...resto,
    };

    // 🔑 id lógico coherente si cambió algo de la clave
    updateData.idProyeccionLogico = `${dni}-${entidadId}-${subCesionId}`;

    if (fechaPromesa) {
      const f = new Date(fechaPromesa);
      updateData.mes = f.getMonth() + 1;
      updateData.anio = f.getFullYear();
    }

    let actualizada = await Proyeccion.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    actualizada = await actualizarEstadoAutomaticamente(actualizada);

    res.json(actualizada);
  } catch (error) {
    // choque con índice único parcial (dni, entidadId, subCesionId, isActiva:true)
    if (error?.code === 11000) {
      return res.status(409).json({
        error:
          "Conflicto: existe una promesa activa con el mismo DNI + ENTIDAD + SUBCESIÓN.",
      });
    }
    console.error("❌ Error al actualizar proyección:", error);
    res.status(500).json({ error: "Error al actualizar proyección" });
  }
};

// 4. Eliminar
export const eliminarProyeccion = async (req, res) => {
  try {
    // ✅ micro: validar id antes de ir a DB
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const proyeccion = await Proyeccion.findById(req.params.id);
    if (!proyeccion) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    if (esAdmin(req)) return res.status(403).json({ error: "Sin acceso" });
    if (
      String(proyeccion.empleadoId) !== String(req.user.id) &&
      !esSuper(req)
    ) {
      return res.status(403).json({ error: "No autorizado" });
    }

    // 🔒 las cuentas cerradas NO se pueden eliminar
    const cerrada =
      proyeccion.isActiva === false ||
      /^Cerrada/.test(String(proyeccion.estado || ""));
    if (cerrada) {
      return res
        .status(409)
        .json({ error: "La proyección está cerrada y no puede eliminarse." });
    }

    // guardo id lógico para reportarlo en la respuesta
    const idProyeccionLogico = proyeccion.idProyeccionLogico;

    await proyeccion.deleteOne();

    // ✅ micro: devuelvo también el id lógico (nuevo esquema)
    res.json({ mensaje: "Proyección eliminada", idProyeccionLogico });
  } catch (error) {
    console.error("Error al eliminar proyección:", error);
    res.status(500).json({ error: "Error al eliminar proyección" });
  }
};

// 4.bis) Registrar gestión (solo dueño puede sumar)
export const registrarGestion = async (req, res) => {
  try {
    const { id } = req.params; // proyeccionId
    const proy = await Proyeccion.findById(id);

    if (!proy) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    // 🔒 Bloqueo: no permitir registrar gestión en cuentas cerradas
    const cerrada =
      proy.isActiva === false || /^Cerrada/.test(String(proy.estado || ""));
    if (cerrada) {
      return res.status(409).json({
        error: "La proyección está cerrada: no se pueden registrar gestiones.",
      });
    }

    const rol = rolDe(req);
    if (esOperativo(req) && String(proy.empleadoId) !== String(req.user.id)) {
      return res
        .status(403)
        .json({ error: "Solo el dueño puede registrar esta gestión" });
    }

    // Para admin / super-admin: solo visualizan (no suman)
    if (esAdmin(req) || esSuper(req)) {
      return res.status(403).json({
        error: "Los administradores no pueden registrar gestiones aquí",
      });
    }

    // Incremento seguro
    proy.vecesTocada = Number(proy.vecesTocada || 0) + 1;
    proy.ultimaGestion = new Date();
    proy.ultimaModificacion = new Date();

    await proy.save();

    return res.json({
      ok: true,
      vecesTocada: proy.vecesTocada,
      ultimaGestion: proy.ultimaGestion,
    });
  } catch (error) {
    console.error("❌ Error al registrar gestión:", error);
    return res.status(500).json({ error: "Error al registrar gestión" });
  }
};

// 5. Obtener por operador
export const obtenerProyeccionesPorOperadorId = async (req, res) => {
  try {
    if (!esSuper(req)) return res.status(403).json({ error: "No autorizado" });
    const proyecciones = await Proyeccion.find({
      empleadoId: req.params.id,
    }).sort({ creado: -1 });
    const actualizadas = await Promise.all(
      proyecciones.map(actualizarEstadoAutomaticamente)
    );
    res.json(actualizadas);
  } catch (error) {
    res
      .status(500)
      .json({ error: "Error al obtener proyecciones del operador" });
  }
};

// 6. Filtros
export const obtenerProyeccionesFiltradas = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      estado,
      concepto,
      entidadId,
      subCesionId,
      tipoFecha = "fechaPromesa",
      fechaDesde,
      fechaHasta,
      buscar,
      orden = "desc",
      ordenPor = "fechaPromesa",
      usuarioId,
      mes,
      anio,
      promesaHoy,
      llamadoHoy,
      // NUEVO
      sinGestion,
    } = req.query;

    const filtros = [];
    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso" });
    }
    if (esSuper(req)) {
      if (usuarioId) filtros.push({ empleadoId: usuarioId });
    } else {
      filtros.push({ empleadoId: req.user.id });
    }

    // Filtros simples
    if (estado) filtros.push({ estado });
    if (concepto) filtros.push({ concepto });
    if (entidadId) filtros.push({ entidadId });
    if (subCesionId) filtros.push({ subCesionId });
    if (mes) filtros.push({ mes: parseInt(mes) });
    if (anio) filtros.push({ anio: parseInt(anio) });

    // Filtro "Sin gestión"
    if (sinGestion === "true") {
      filtros.push({
        $or: [
          { vecesTocada: { $exists: false } },
          { vecesTocada: null },
          { vecesTocada: { $lte: 0 } },
        ],
      });
    }

    // Hoy (promesas y llamados)
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const mañana = new Date(hoy); mañana.setDate(hoy.getDate() + 1);

    if (promesaHoy === "true") {
      filtros.push({ fechaPromesa: { $gte: hoy, $lt: mañana } });
    }
    if (llamadoHoy === "true") {
      filtros.push({ fechaProximoLlamado: { $gte: hoy, $lt: mañana } });
    }

    // Rango por tipoFecha
    if (
      fechaDesde && fechaHasta &&
      !isNaN(Date.parse(fechaDesde)) &&
      !isNaN(Date.parse(fechaHasta))
    ) {
      const inicio = crearFechaLocal(fechaDesde);
      const fin = crearFechaLocal(fechaHasta, true);
      const campoFecha = {
        fechaPromesa: "fechaPromesa",
        creado: "creado",
        modificado: "ultimaModificacion",
      }[tipoFecha || "fechaPromesa"];
      if (campoFecha) filtros.push({ [campoFecha]: { $gte: inicio, $lte: fin } });
    }

    // Búsqueda libre
    if (buscar) {
      const regex = new RegExp(buscar, "i");
      const posibleDni = parseInt(buscar, 10);
      const condiciones = [{ nombreTitular: regex }, { concepto: regex }, { estado: regex }];
      if (!isNaN(posibleDni)) condiciones.push({ dni: posibleDni });
      filtros.push({ $or: condiciones });
    }

    // Query final
    const query = filtros.length ? { $and: filtros } : {};

    // Paginación y orden
    const pageNum = parseInt(page);
    const pageSize = parseInt(limit);
    const skip = (pageNum - 1) * pageSize;
    const sortObj = {};
    if (ordenPor) sortObj[ordenPor] = orden === "asc" ? 1 : -1;

    // Campos mínimos para la grilla
    const campos =
      "empleadoId dni nombreTitular importe importePagado estado concepto " +
      "entidadId subCesionId fechaPromesa fechaProximoLlamado creado ultimaModificacion " +
      "vecesTocada ultimaGestion observaciones";

    // Búsqueda rápida con populate + lean (SIN guardar)
    const docs = await Proyeccion.find(query)
      .select(campos)
      .populate("empleadoId", "username")
      .populate("entidadId", "nombre numero")
      .populate("subCesionId", "nombre")
      .sort(sortObj)
      .skip(skip)
      .limit(pageSize)
      .lean();

    // Estado “en caliente” (sin persistir) y nombres listos para la tabla
    const hoyRef = new Date(); hoyRef.setHours(0,0,0,0);
    const resultados = docs.map((p) => {
      // si tenés helper clasificarEstado, lo usamos; si no, se cae al estado guardado
      const estadoVista = (typeof clasificarEstado === "function" && p.fechaPromesa)
        ? clasificarEstado(new Date(p.fechaPromesa))
        : p.estado;

      return {
        ...p,
        empleadoUsername: p?.empleadoId?.username || "-",
        entidadNombre: p?.entidadId?.nombre || "-",
        subCesionNombre: p?.subCesionId?.nombre || "-",
        // opcional: si querés mostrar distinto sin tocar el guardado
        estado: estadoVista,
      };
    });

    const total = await Proyeccion.countDocuments(query);
    return res.json({ total, resultados });
  } catch (error) {
    console.error("❌ Error en /proyecciones/filtrar:", error);
    res.status(500).json({ error: "Error al filtrar proyecciones" });
  }
};


// 7. Estadísticas propias
export const obtenerEstadisticasPropias = async (req, res) => {
  try {
    if (esAdmin(req)) return res.status(403).json({ error: "Sin acceso" });
    const proyecciones = await Proyeccion.find({ empleadoId: req.user.id });
    const actualizadas = await Promise.all(
      proyecciones.map(actualizarEstadoAutomaticamente)
    );

    const total = actualizadas.length;
    const cumplidas = actualizadas.filter((p) => p.estado === "Pagado").length;
    const caidas = actualizadas.filter(
      (p) => p.estado === "Promesa caída"
    ).length;

    const produccion = actualizadas.filter((p) =>
      ["Cancelación", "Anticipo", "Parcial", "Ant-Can", "Posible"].includes(
        p.concepto
      )
    ).length;

    const porDia = {};
    actualizadas.forEach((p) => {
      const fecha = formatearFecha(p.fechaPromesa);
      porDia[fecha] = (porDia[fecha] || 0) + 1;
    });

    res.json({ total, cumplidas, caidas, produccion, porDia });
  } catch (error) {
    res.status(500).json({ error: "Error al calcular estadísticas" });
  }
};

export const obtenerEstadisticasAdmin = async (req, res) => {
  try {
    if (!esSuper(req)) return res.status(403).json({ error: "No autorizado" });
    const proyecciones = await Proyeccion.find();
    const actualizadas = await Promise.all(
      proyecciones.map(actualizarEstadoAutomaticamente)
    );

    const porEmpleado = {},
      porEntidad = {},
      porSubCesion = {},
      porMes = {};

    for (const p of actualizadas) {
      const id = p.empleadoId.toString();
      porEmpleado[id] = porEmpleado[id] || { total: 0, cumplidas: 0 };
      porEmpleado[id].total++;
      if (p.estado === "Pagado") porEmpleado[id].cumplidas++;

      const entKey = String(p.entidadId || "sin_entidad");
      const subKey = String(p.subCesionId || "sin_subcesion");

      porEntidad[entKey] = (porEntidad[entKey] || 0) + 1;
      porSubCesion[subKey] = (porSubCesion[subKey] || 0) + 1;

      const clave = `${p.anio}-${String(p.mes).padStart(2, "0")}`;
      porMes[clave] = (porMes[clave] || 0) + 1;
    }

    res.json({ porEmpleado, porEntidad, porSubCesion, porMes });
  } catch (error) {
    res.status(500).json({ error: "Error al calcular estadísticas globales" });
  }
};




export const obtenerResumenGlobal = async (req, res) => {
  try {
    if (!esSuper(req)) return res.status(403).json({ error: "No autorizado" });
    const proyecciones = await Proyeccion.find().populate(
      "empleadoId",
      "username"
    );

    const resumen = {
      totalImporte: 0,
      totalPagado: 0,
      porUsuario: {},
      rankingCumplimiento: {},
      total: proyecciones.length,
      pagadas: 0,
    };

    for (const p of proyecciones) {
      const importe = parseFloat(p.importe || 0);
      const pagado = parseFloat(p.importePagado || 0);
      const usuario = p.empleadoId?.username || "Desconocido";

      resumen.totalImporte += importe;
      resumen.totalPagado += pagado;

      resumen.porUsuario[usuario] = resumen.porUsuario[usuario] || {
        total: 0,
        pagadas: 0,
      };
      resumen.porUsuario[usuario].total++;

      if (p.estado === "Pagado") {
        resumen.pagadas++;
        resumen.porUsuario[usuario].pagadas++;
      }
    }

    for (const [usuario, data] of Object.entries(resumen.porUsuario)) {
      const porcentaje = (data.pagadas / data.total) * 100;
      resumen.rankingCumplimiento[usuario] = porcentaje.toFixed(1);
    }

    resumen.porcentajeGlobal =
      resumen.total > 0
        ? ((resumen.pagadas / resumen.total) * 100).toFixed(1)
        : "0.0";

    res.json(resumen);
  } catch (error) {
    console.error("❌ Error en obtenerResumenGlobal:", error);
    res.status(500).json({ error: "Error al obtener resumen global" });
  }
};

export const obtenerProyeccionesParaResumen = async (req, res) => {
  try {
    const {
      estado,
      concepto,
      entidadId, // ← reemplaza cartera
      subCesionId, // ← reemplaza fiduciario
      tipoFecha = "fechaPromesa",
      fechaDesde,
      fechaHasta,
      buscar,
      orden,
      ordenPor,
      usuarioId,
      mes,
      anio,
      promesaHoy,
      llamadoHoy,
    } = req.query;

    const filtros = [];
    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso" });
    }
    const rol = rolDe(req);
    if (esSuper(req) && usuarioId) {
      filtros.push({ empleadoId: usuarioId });
    } else if (!esSuper(req)) {
      filtros.push({ empleadoId: req.user.id });
    }

    if (estado) filtros.push({ estado });
    if (concepto) filtros.push({ concepto });
    if (entidadId) filtros.push({ entidadId });
    if (subCesionId) filtros.push({ subCesionId });
    if (mes) filtros.push({ mes: parseInt(mes) });
    if (anio) filtros.push({ anio: parseInt(anio) });

    // ----- rango para el campo elegido -----
    let rangoDesde = null,
      rangoHasta = null;
    if (
      fechaDesde &&
      fechaHasta &&
      !isNaN(Date.parse(fechaDesde)) &&
      !isNaN(Date.parse(fechaHasta))
    ) {
      rangoDesde = crearFechaLocal(fechaDesde);
      rangoHasta = crearFechaLocal(fechaHasta, true);

      const campoFecha =
        {
          fechaPromesa: "fechaPromesa",
          creado: "creado",
          modificado: "ultimaModificacion",
        }[tipoFecha] || "fechaPromesa";

      filtros.push({ [campoFecha]: { $gte: rangoDesde, $lte: rangoHasta } });
    }

    // rango para PAGOS (mismo del filtro si viene)
    const pagosDesde = rangoDesde;
    const pagosHasta = rangoHasta;

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const mañana = new Date(hoy);
    mañana.setDate(hoy.getDate() + 1);

    if (promesaHoy === "true")
      filtros.push({ fechaPromesa: { $gte: hoy, $lt: mañana } });
    if (llamadoHoy === "true")
      filtros.push({ fechaProximoLlamado: { $gte: hoy, $lt: mañana } });

    // IMPORTANTE: la búsqueda libre ahora se hace post-query para poder
    // incluir nombres de Entidad/SubCesión (campos poblados).
    const query = filtros.length ? { $and: filtros } : {};

    let proyecciones = await Proyeccion.find(query)
      .populate("empleadoId", "username")
      .populate("entidadId", "nombre")
      .populate("subCesionId", "nombre")
      .sort(ordenPor ? { [ordenPor]: orden === "asc" ? 1 : -1 } : {});

    if (buscar) {
      const regex = new RegExp(buscar, "i");
      const posibleDni = parseInt(buscar, 10);

      proyecciones = proyecciones.filter((p) => {
        const matchTexto =
          regex.test(p.nombreTitular || "") ||
          regex.test(p.concepto || "") ||
          regex.test(p.estado || "") ||
          regex.test(p.entidadId?.nombre || "") ||
          regex.test(p.subCesionId?.nombre || "");
        const matchDni = !isNaN(posibleDni) && Number(p.dni) === posibleDni;
        return matchTexto || matchDni;
      });
    }

    // ===== acumuladores =====
    const resumen = {
      totalImporte: 0,
      totalPagado: 0,
      vencidasSinPago: 0,
      pagadas: 0,
      total: 0,
      porEstado: {},
      porEntidad: {}, // ← reemplaza porCartera
      porDia: {},
      porDiaCreacion: {},
      porUsuario: {}, // para % simple
      subCesiones: {}, // ← reemplaza fiduciarios
      // 👇 nombres que espera el front
      pagosPorDia: {}, // cantidad de pagos por día
      montosPagosPorDia: {}, // monto de pagos por día
      totalPagos: 0,
      montoPagos: 0,
      // para ranking extendido
      _detUsuarios: {}, // { [usuario]: {total, importeTotal, pagadas, cantPagos, pagadoTotal} }
    };

    const hoyDate = new Date();
    hoyDate.setHours(0, 0, 0, 0);

    const normalizarFecha = (raw) => {
      if (!raw) return null;
      const d = new Date(raw);
      return isNaN(d) ? null : d;
    };
    const estaEnRango = (d) =>
      !pagosDesde || !pagosHasta || (d >= pagosDesde && d <= pagosHasta);

    for (const p of proyecciones) {
      const importe = Number(p.importe || 0) || 0;
      const pagado = Number(p.importePagado || 0) || 0;
      const estadoP = (p.estado || "Sin estado").trim();

      const entidadNombre =
        (p.entidadId && (p.entidadId.nombre || "").trim()) || "Sin entidad";
      const subCesionNombre =
        (p.subCesionId && (p.subCesionId.nombre || "").trim()) ||
        "Sin subcesión";

      const usuario = p.empleadoId?.username || "Sin usuario";

      resumen.total++;
      resumen.totalImporte += importe;
      resumen.totalPagado += pagado;

      const cumplida = estadoP === "Pagado" || estadoP === "Pagado parcial";
      if (cumplida) resumen.pagadas++;

      const fProm = normalizarFecha(p.fechaPromesa);
      if (
        estadoP === "Promesa caída" &&
        pagado === 0 &&
        fProm &&
        fProm < hoyDate
      ) {
        resumen.vencidasSinPago++;
      }

      resumen.porEstado[estadoP] = (resumen.porEstado[estadoP] || 0) + 1;
      resumen.porEntidad[entidadNombre] =
        (resumen.porEntidad[entidadNombre] || 0) + 1;

      if (fProm) {
        const k = `${fProm.getFullYear()}-${String(
          fProm.getMonth() + 1
        ).padStart(2, "0")}-${String(fProm.getDate()).padStart(2, "0")}`;
        resumen.porDia[k] = (resumen.porDia[k] || 0) + 1;
      }

      const fCrea = normalizarFecha(p.creado);
      if (fCrea) {
        const k = `${fCrea.getFullYear()}-${String(
          fCrea.getMonth() + 1
        ).padStart(2, "0")}-${String(fCrea.getDate()).padStart(2, "0")}`;
        resumen.porDiaCreacion[k] = (resumen.porDiaCreacion[k] || 0) + 1;
      }

      // por usuario (simple)
      resumen.porUsuario[usuario] = resumen.porUsuario[usuario] || {
        total: 0,
        pagadas: 0,
      };
      resumen.porUsuario[usuario].total++;
      if (cumplida) resumen.porUsuario[usuario].pagadas++;

      // por usuario (detallado)
      const det = (resumen._detUsuarios[usuario] = resumen._detUsuarios[
        usuario
      ] || {
        total: 0,
        importeTotal: 0,
        pagadas: 0,
        cantPagos: 0,
        pagadoTotal: 0,
      });
      det.total += 1;
      det.importeTotal += importe;
      if (cumplida) det.pagadas += 1;

      // SubCesiones
      resumen.subCesiones[subCesionNombre] =
        (resumen.subCesiones[subCesionNombre] || 0) + 1;

      // pagos informados (en rango)
      for (const pago of p.pagosInformados || []) {
        if (!pago || pago.erroneo) continue;
        const fPago = normalizarFecha(
          pago.fecha || pago.fechaPago || pago.creado || pago.createdAt
        );
        if (!fPago || !estaEnRango(fPago)) continue;

        const key = `${fPago.getFullYear()}-${String(
          fPago.getMonth() + 1
        ).padStart(2, "0")}-${String(fPago.getDate()).padStart(2, "0")}`;
        const monto = Number(pago.monto ?? pago.importe ?? 0) || 0;

        resumen.pagosPorDia[key] = (resumen.pagosPorDia[key] || 0) + 1;
        resumen.montosPagosPorDia[key] =
          (resumen.montosPagosPorDia[key] || 0) + monto;

        resumen.totalPagos++;
        resumen.montoPagos += monto;

        // por usuario (detallado)
        det.cantPagos += 1;
        det.pagadoTotal += monto;
      }
    }

    const porcentajeCumplimiento = resumen.total
      ? ((resumen.pagadas / resumen.total) * 100).toFixed(1)
      : "0.0";

    const porcentajeVencidas = resumen.total
      ? ((resumen.vencidasSinPago / resumen.total) * 100).toFixed(1)
      : "0.0";

    const topUsuarios = Object.entries(resumen.porUsuario)
      .map(([usuario, data]) => ({ usuario, total: data.total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 3);

    const rankingCumplimiento = Object.entries(resumen.porUsuario)
      .map(([usuario, data]) => ({
        usuario,
        porcentaje:
          data.total > 0
            ? ((data.pagadas / data.total) * 100).toFixed(1)
            : "0.0",
      }))
      .sort((a, b) => b.porcentaje - a.porcentaje);

    // 🏆 Ranking extendido con todo lo que pediste
    const rankingDetallado = Object.entries(resumen._detUsuarios)
      .map(([usuario, d]) => ({
        usuario,
        total: d.total, // # promesas
        importeTotal: d.importeTotal, // $ comprometido
        pagadas: d.pagadas, // # promesas cumplidas
        cantPagos: d.cantPagos, // # pagos en el rango
        pagadoTotal: d.pagadoTotal, // $ pagado (en el rango)
        porcentaje:
          d.total > 0 ? ((d.pagadas / d.total) * 100).toFixed(1) : "0.0",
      }))
      .sort((a, b) => parseFloat(b.porcentaje) - parseFloat(a.porcentaje));

    res.json({
      totalImporte: resumen.totalImporte,
      totalPagado: resumen.totalPagado,
      porcentajeVencidas,
      porcentajeCumplimiento,
      porEstado: resumen.porEstado,
      porEntidad: resumen.porEntidad, // ← nuevo nombre
      porDia: resumen.porDia,
      porDiaCreacion: resumen.porDiaCreacion,
      topUsuarios,
      rankingCumplimiento, // compatibilidad
      rankingDetallado, // 👈 usado por el front nuevo
      subCesiones: resumen.subCesiones, // ← nuevo nombre
      pagadas: resumen.pagadas,
      total: resumen.total,
      vencidasSinPago: resumen.vencidasSinPago,
      // 👇 nombres que espera el front para el gráfico
      pagosPorDia: resumen.pagosPorDia,
      montosPagosPorDia: resumen.montosPagosPorDia,
      totalPagos: resumen.totalPagos,
      montoPagos: resumen.montoPagos,
    });
  } catch (error) {
    console.error("❌ Error en obtenerProyeccionesParaResumen:", error);
    res.status(500).json({ error: "Error al obtener resumen" });
  }
};

export const informarPago = async (req, res) => {
  try {
    const { id } = req.params; // proyeccionId
    const { fecha, monto } = req.body;

    // Validaciones de entrada
    const fechaJS = parseExcelDate(fecha);
    if (!fechaJS || isNaN(fechaJS)) {
      return res.status(400).json({ error: "Fecha inválida" });
    }
    const montoNum = Number(monto);
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      return res.status(400).json({ error: "Monto inválido" });
    }

    // Buscar proyección
    const proy = await Proyeccion.findById(id);
    if (!proy) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    // 🔒 no permitir informar pagos en cuentas cerradas
    const cerrada =
      proy.isActiva === false || /^Cerrada/.test(String(proy.estado || ""));
    if (cerrada) {
      return res.status(409).json({
        error: "La proyección está cerrada: no se pueden informar pagos.",
      });
    }

    if (esAdmin(req)) return res.status(403).json({ error: "Sin acceso" });
    if (esOperativo(req) && String(proy.empleadoId) !== String(req.user.id)) {
      return res
        .status(403)
        .json({ error: "No autorizado para informar pago" });
    }

    // Evitar duplicados (mismo día y mismo monto ya cargado y no erróneo)
    const y = fechaJS.getFullYear();
    const m = fechaJS.getMonth();
    const d = fechaJS.getDate();
    const duplicado = (proy.pagosInformados || []).some((p) => {
      if (p.erroneo) return false;
      const pf = new Date(p.fecha);
      return (
        pf.getFullYear() === y &&
        pf.getMonth() === m &&
        pf.getDate() === d &&
        Number(p.monto || 0) === Number(montoNum)
      );
    });
    if (duplicado) {
      return res
        .status(409)
        .json({ error: "Pago duplicado (misma fecha y monto ya cargado)." });
    }

    // Agregar pago
    proy.pagosInformados.push({
      fecha: fechaJS,
      monto: montoNum,
      operadorId: req.user.id,
    });

    // Recalcular importePagado desde pagosInformados (solo válidos)
    proy.importePagado = recalcularImportePagado(proy);
    proy.ultimaModificacion = new Date();

    await proy.save();

    // Actualizar estado (Pagado / Pagado parcial / etc.)
    await actualizarEstadoAutomaticamente(proy);

    // Devolver proyección actualizada (con operador y creador para el front)
    const actualizado = await Proyeccion.findById(id)
      .populate("empleadoId", "username")
      .populate("pagosInformados.operadorId", "username");

    return res.json(actualizado);
  } catch (e) {
    console.error("❌ informarPago:", e);
    return res.status(500).json({ error: "Error al informar pago" });
  }
};


export const listarPagosInformados = async (req, res) => {
  try {
    const { id } = req.params;

    if (esAdmin(req)) return res.status(403).json({ error: "Sin acceso" });

    const proy = await Proyeccion.findById(id)
      .select("empleadoId pagosInformados")
      .populate("pagosInformados.operadorId", "username nombre email") // ← clave
      .populate("pagosInformados.marcadoPor", "username") // opcional
      .lean();

    if (!proy)
      return res.status(404).json({ error: "Proyección no encontrada" });

    if (esOperativo(req) && String(proy.empleadoId) !== String(req.user.id)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const pagos = (proy.pagosInformados || [])
      .slice()
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    return res.json({ ok: true, pagos });
  } catch (e) {
    console.error("❌ listarPagosInformados:", e);
    return res.status(500).json({ error: "Error al listar pagos" });
  }
};

export const marcarPagoErroneo = async (req, res) => {
  try {
    const { id, pagoId } = req.params; // proyeccionId, pagoId
    const { erroneo = true, motivo = "" } = req.body;

    // Buscar proyección
    const proy = await Proyeccion.findById(id);
    if (!proy) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    // 🔒 No permitir ediciones en cuentas cerradas
    const cerrada =
      proy.isActiva === false || /^Cerrada/.test(String(proy.estado || ""));
    if (cerrada) {
      return res.status(409).json({
        error: "La proyección está cerrada: no se pueden editar pagos.",
      });
    }

    if (esAdmin(req)) return res.status(403).json({ error: "Sin acceso" });
    if (esOperativo(req) && String(proy.empleadoId) !== String(req.user.id)) {
      return res
        .status(403)
        .json({ error: "No autorizado para marcar este pago" });
    }

    // Ubicar el pago
    const pago = (proy.pagosInformados || []).id(pagoId);
    if (!pago) {
      return res.status(404).json({ error: "Pago no encontrado" });
    }

    // Marcar / desmarcar
    pago.erroneo = !!erroneo;
    pago.motivoError = pago.erroneo ? motivo || "" : "";
    pago.marcadoPor = req.user.id;
    pago.marcadoEn = new Date();

    // Recalcular importePagado (solo los NO erróneos)
    proy.importePagado = (proy.pagosInformados || [])
      .filter((p) => !p.erroneo)
      .reduce((acc, p) => acc + Number(p.monto || 0), 0);

    proy.ultimaModificacion = new Date();
    await proy.save();

    // Reajustar estado automático (Pagado / Parcial / Promesa activa/caída)
    await actualizarEstadoAutomaticamente(proy);

    // Responder con datos enriquecidos para el front
    const actualizado = await Proyeccion.findById(id)
      .populate("empleadoId", "username")
      .populate("pagosInformados.operadorId", "username")
      .populate("pagosInformados.marcadoPor", "username");

    const pagosOrdenados = (actualizado.pagosInformados || []).sort(
      (a, b) => new Date(b.fecha) - new Date(a.fecha)
    );

    return res.json({
      ok: true,
      proyeccion: actualizado,
      pagos: pagosOrdenados,
    });
  } catch (e) {
    console.error("❌ marcarPagoErroneo:", e);
    return res.status(500).json({ error: "No se pudo marcar el pago" });
  }
};









export const limpiarPagosProyeccion = async (req, res) => {
  try {
    const proyeccion = await Proyeccion.findById(req.params.id);
    if (!proyeccion) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    // 🔒 Bloqueo: no permitir limpiar pagos en cuentas cerradas
    const cerrada =
      proyeccion.isActiva === false ||
      /^Cerrada/.test(String(proyeccion.estado || ""));
    if (cerrada) {
      return res.status(409).json({
        error: "La proyección está cerrada: no se pueden limpiar pagos.",
      });
    }

    const rol = rolDe(req);

    // Asegurar array
    proyeccion.pagosInformados = proyeccion.pagosInformados || [];

    if (esOperativo(req)) {
      // Operador: limpia SOLO sus propios pagos
      proyeccion.pagosInformados = proyeccion.pagosInformados.filter(
        (p) => String(p.operadorId) !== String(req.user.id)
      );
    } else if (esSuper(req)) {
      // Admin / Super-admin: limpia TODOS los pagos
      proyeccion.pagosInformados = [];
    } else {
      // Otros roles no permitidos
      return res
        .status(403)
        .json({ error: "No autorizado para limpiar pagos" });
    }

    // Recalcular importePagado a partir de pagos NO erróneos
    proyeccion.importePagado = recalcularImportePagado(proyeccion);
    proyeccion.ultimaModificacion = new Date();

    await proyeccion.save();
    await actualizarEstadoAutomaticamente(proyeccion);

    // Devolver proyección actualizada con datos útiles
    const actualizado = await Proyeccion.findById(proyeccion._id)
      .populate("empleadoId", "username")
      .populate("pagosInformados.operadorId", "username");

    return res.json({
      ok: true,
      mensaje:
        rol === "operador"
          ? "Pagos del operador actual limpiados correctamente"
          : "Se limpiaron todos los pagos informados",
      proyeccion: actualizado?.toObject?.() || actualizado,
    });
  } catch (err) {
    console.error("Error al limpiar pagos:", err);
    return res.status(500).json({ error: "Error interno al limpiar pagos" });
  }
};

export const limpiarObservacionesProyeccion = async (req, res) => {
  try {
    const proyeccion = await Proyeccion.findById(req.params.id);
    if (!proyeccion) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    // 🔒 Bloqueo: no permitir modificar cuentas cerradas
    const cerrada =
      proyeccion.isActiva === false ||
      /^Cerrada/.test(String(proyeccion.estado || ""));
    if (cerrada) {
      return res.status(409).json({
        error:
          "La proyección está cerrada: no se pueden limpiar observaciones.",
      });
    }

    // 👤 Permisos
    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso" });
    }
    if (
      esOperativo(req) &&
      String(proyeccion.empleadoId) !== String(req.user.id)
    ) {
      return res
        .status(403)
        .json({ error: "No autorizado para limpiar observaciones" });
    }
    if (!esOperativo(req) && !esSuper(req)) {
      return res.status(403).json({ error: "Rol no autorizado" });
    }

    // 🧹 Limpieza
    proyeccion.observaciones = "";
    proyeccion.ultimaModificacion = new Date();
    await proyeccion.save();

    // devolver proyección actualizada (con datos útiles)
    const actualizado = await Proyeccion.findById(proyeccion._id).populate(
      "empleadoId",
      "username"
    );

    return res.json({
      ok: true,
      mensaje: "Observaciones limpiadas",
      proyeccion: actualizado?.toObject?.() || actualizado,
    });
  } catch (err) {
    console.error("Error al limpiar observaciones:", err);
    return res
      .status(500)
      .json({ error: "Error interno al limpiar observaciones" });
  }
};




export const importarPagosMasivo = async (req, res) => {
  try {
    // 1) Seguridad por rol (la ruta igual debería tener el middleware)
    const rol = req.user.role || req.user.rol;
    if (!["admin", "super-admin"].includes(rol)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    // 2) Archivo adjunto
    if (!req.file || !req.file.buffer) {
      return res
        .status(400)
        .json({ error: "Subí un archivo XLSX (campo: file)" });
    }

    // 3) Cargar XLSX
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: "El archivo no tiene hojas" });

    // ==== Helpers locales ====
    const norm = (s) =>
      String(s || "")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .trim()
        .toLowerCase();

    const NORM_TXT = (s) => String(s || "").trim().toUpperCase();

    // quita prefijos "123 - " o "66f0... - " → queda NOMBRE
    const parseSelectLabel = (v) => {
      if (v == null) return "";
      const s = String(v).trim();
      const m = s.match(/^\s*(?:[0-9a-f]{24}|\d+)\s*-\s*(.+)$/i);
      return (m ? m[1] : s).trim();
    };

    const toISODate = (v) => {
      const d = (() => {
        if (v == null) return null;
        if (v instanceof Date) return v;
        if (typeof v === "number") {
          const ms = (v - 25569) * 86400 * 1000; // Excel serial
          const d = new Date(ms);
          return isNaN(d) ? null : d;
        }
        const s = String(v).trim();
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
          const [dd, mm, aa] = s.split("/").map(Number);
          return new Date(aa, mm - 1, dd, 12, 0, 0, 0);
        }
        const d2 = new Date(s);
        return isNaN(d2) ? null : d2;
      })();
      return d ? d.toISOString().slice(0, 10) : (v == null ? "" : String(v));
    };

    // etiquetas: Entidad "n - NOMBRE" / SubCesión "NOMBRE"
    const buildLabelMaps = async () => {
      const [ents, subs] = await Promise.all([
        Entidad.find({}, "nombre").sort({ nombre: 1 }).lean(),
        SubCesion.find({}, "nombre").sort({ nombre: 1 }).lean(),
      ]);
      const entLabelById = new Map(); // id -> "n - NOMBRE"
      const subNameById = new Map();  // id -> "NOMBRE"
      ents.forEach((e, i) => entLabelById.set(String(e._id), `${i + 1} - ${e.nombre}`));
      subs.forEach((s) => subNameById.set(String(s._id), s.nombre));
      const entLabel = (id, fallbackName) =>
        id ? (entLabelById.get(String(id)) || (fallbackName ? `- ${fallbackName}` : "")) : (fallbackName || "");
      const subLabel = (id, fallbackName) =>
        id ? (subNameById.get(String(id)) || (fallbackName || "")) : (fallbackName || "");
      return { entLabel, subLabel };
    };
    const { entLabel, subLabel } = await buildLabelMaps();

    // mapear encabezados de la fila 1
    const headers = {};
    ws.getRow(1).eachCell((cell, col) => {
      const key = norm(cell.value);
      if (key) headers[key] = col;
    });

    // Alias aceptados (admite ID o NOMBRE)
    const aliases = {
      dni: ["dni", "documento", "doc"],
      entidadId: ["entidadid", "entidad id", "id entidad", "id_entidad"],
      subCesionId: [
        "subcesionid",
        "subcesion id",
        "id subcesion",
        "id_subcesion",
      ],
      entidad: ["entidad", "empresa"],
      subCesion: ["subcesion", "sub-cesion", "sub cesion", "subcesión", "sub cesión"],
      fecha: ["fecha pago", "fecha", "fecha de pago"],
      monto: ["monto", "importe", "monto pago", "importe pago"],
      observacion: ["observacion", "observación", "obs"],
    };

    const getCol = (logical) => {
      if (headers[logical]) return headers[logical];
      for (const alias of (aliases[logical] || [])) {
        const k = norm(alias);
        if (headers[k]) return headers[k];
      }
      return null;
    };

    // Debe venir: DNI, FECHA, MONTO y (ENTIDAD_ID o ENTIDAD) y (SUBCESION_ID o SUBCESION)
    const faltan = [];
    if (!getCol("dni")) faltan.push("DNI");
    if (!getCol("fecha")) faltan.push("FECHA");
    if (!getCol("monto")) faltan.push("MONTO");
    if (!getCol("entidadId") && !getCol("entidad")) faltan.push("ENTIDAD_ID o ENTIDAD");
    if (!getCol("subCesionId") && !getCol("subCesion")) faltan.push("SUBCESION_ID o SUBCESION");

    if (faltan.length) {
      return res.status(400).json({
        error: `Faltan columnas: ${faltan.join(", ")}. Requerido: DNI, (EntidadId o Entidad), (SubCesionId o SubCesion), Fecha, Monto`,
      });
    }

    // Fecha: número Excel, Date o string (dd/mm/yyyy o ISO)
    const parseFecha = (v) => {
      if (v == null) return null;
      if (v instanceof Date) return v;
      if (typeof v === "number") {
        const ms = (v - 25569) * 86400 * 1000;
        const d = new Date(ms);
        return isNaN(d) ? null : d;
      }
      const s = String(v).trim();
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
        const [d, m, a] = s.split("/").map(Number);
        return new Date(a, m - 1, d, 12, 0, 0, 0);
      }
      const d2 = new Date(s);
      return isNaN(d2) ? null : d2;
    };

    const parseMonto = (v) => {
      if (v == null) return NaN;
      if (typeof v === "number") return v;
      const n = Number(
        String(v)
          .replace(/[^\d.,-]/g, "")
          .replace(",", ".")
      );
      return Number.isFinite(n) ? n : NaN;
    };

    const parseObjectId = (v) => {
      if (v == null) return null;
      const s = String(v).trim();
      return mongoose.Types.ObjectId.isValid(s)
        ? new mongoose.Types.ObjectId(s)
        : null;
    };

    // Cache para no consultar la DB por la misma (dni, entidadId, subCesionId) en cada fila
    const cacheActivas = new Map();
    const getActiva = async (dni, entidadId, subCesionId) => {
      const key = `${dni}::${entidadId}::${subCesionId}`;
      if (cacheActivas.has(key)) return cacheActivas.get(key);
      const proy = await Proyeccion.findOne({
        dni,
        entidadId,
        subCesionId,
        $or: [{ isActiva: true }, { isActiva: { $exists: false } }],
      });
      cacheActivas.set(key, proy || null);
      return proy;
    };

    // Caches Entidad/SubCesión por nombre
    const cacheEntPorNombre = new Map(); // NOMBRE→doc/null
    const cacheSubPorNombre = new Map(); // NOMBRE→doc/null (GLOBAL)

    const buscarEntidadPorNombre = async (nombre) => {
      if (!nombre) return null;
      const key = NORM_TXT(nombre);
      if (cacheEntPorNombre.has(key)) return cacheEntPorNombre.get(key);
      const ent = await Entidad.findOne({ nombre: key });
      cacheEntPorNombre.set(key, ent || null);
      return ent;
    };

    // GLOBAL: SubCesión por NOMBRE (no depende de entidad)
    const buscarOCrearSubPorNombre = async (nombre) => {
      if (!nombre) return null;
      const key = NORM_TXT(nombre);
      if (cacheSubPorNombre.has(key)) return cacheSubPorNombre.get(key);
      let sub = await SubCesion.findOne({ nombre: key });
      if (!sub) sub = await SubCesion.create({ nombre: key }); // modelo: { nombre: unique }
      cacheSubPorNombre.set(key, sub);
      return sub;
    };

    // Duplicado: mismo día y mismo monto (no erróneo)
    const esDuplicado = (proy, fechaJS, montoNum) => {
      const y = fechaJS.getFullYear();
      const m = fechaJS.getMonth();
      const d = fechaJS.getDate();
      return (proy.pagosInformados || []).some((p) => {
        if (p.erroneo) return false;
        const pf = new Date(p.fecha);
        return (
          pf.getFullYear() === y &&
          pf.getMonth() === m &&
          pf.getDate() === d &&
          Number(p.monto || 0) === Number(montoNum)
        );
      });
    };

    const errores = [];
    let ok = 0;

    // ---- Recorrer filas (desde 2) ----
    for (let i = 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);

      const getCell = (logical) => {
        const col = getCol(logical);
        return col ? row.getCell(col).value : undefined;
      };

      const rawDni   = getCell("dni");
      const rawEntId = getCell("entidadId");
      const rawSubId = getCell("subCesionId");
      const rawEntNm = parseSelectLabel(getCell("entidad"));
      const rawSubNm = parseSelectLabel(getCell("subCesion"));
      const rawFec   = getCell("fecha");
      const rawMon   = getCell("monto");
      const rawObs   = getCell("observacion");

      const dni = Number(String(rawDni || "").replace(/\D/g, ""));
      let entidadId   = parseObjectId(rawEntId);
      let subCesionId = parseObjectId(rawSubId);
      const fechaJS   = parseFecha(rawFec);
      const montoNum  = parseMonto(rawMon);

      // Resolver ENTIDAD por NOMBRE cuando no hay ID
      if (!entidadId && rawEntNm) {
        const ent = await buscarEntidadPorNombre(rawEntNm);
        if (!ent) {
          errores.push({
            fila: i,
            dni: Number.isFinite(dni) ? dni : String(rawDni ?? ""),
            entidad: rawEntNm || "",
            subCesion: rawSubNm || "",
            fecha: toISODate(rawFec),
            monto: String(rawMon ?? ""),
            error: `Entidad "${rawEntNm}" inexistente (no se crea automáticamente)`,
          });
          continue;
        }
        entidadId = ent._id;
      }

      // Resolver SUBCESIÓN por NOMBRE (GLOBAL) cuando no hay ID
      if (!subCesionId && rawSubNm) {
        const sub = await buscarOCrearSubPorNombre(rawSubNm); // crea si falta
        subCesionId = sub ? sub._id : null;
      }

      // Validaciones por fila
      const rowErr = [];
      if (!Number.isFinite(dni) || dni <= 0) rowErr.push("DNI inválido");
      if (!entidadId) rowErr.push("Entidad inválida/ausente (por ID o NOMBRE)");
      if (!subCesionId) rowErr.push("SubCesión inválida/ausente (por ID o NOMBRE)");
      if (!fechaJS || isNaN(fechaJS)) rowErr.push("Fecha inválida");
      if (!Number.isFinite(montoNum) || montoNum <= 0) rowErr.push("Monto inválido");

      if (rowErr.length) {
        errores.push({
          fila: i,
          dni: Number.isFinite(dni) ? dni : String(rawDni ?? ""),
          entidad: entidadId ? entLabel(entidadId) : (rawEntNm || String(rawEntId || "")),
          subCesion: subCesionId ? subLabel(subCesionId) : (rawSubNm || String(rawSubId || "")),
          fecha: toISODate(rawFec),
          monto: String(rawMon ?? ""),
          error: rowErr.join(" | "),
        });
        continue;
      }

      // Buscar proyección activa por (dni, entidadId, subCesionId)
      const proy = await getActiva(dni, entidadId, subCesionId);
      if (!proy) {
        errores.push({
          fila: i,
          dni,
          entidad: entLabel(entidadId),
          subCesion: subLabel(subCesionId),
          fecha: fechaJS.toISOString().slice(0, 10),
          monto: montoNum,
          error: "No existe promesa activa para DNI + Entidad + SubCesión",
        });
        continue;
      }

      // Duplicado
      if (esDuplicado(proy, fechaJS, montoNum)) {
        errores.push({
          fila: i,
          dni,
          entidad: entLabel(entidadId),
          subCesion: subLabel(subCesionId),
          fecha: fechaJS.toISOString().slice(0, 10),
          monto: montoNum,
          error: "Pago duplicado (mismo día y monto ya cargado)",
        });
        continue;
      }

      // Insertar pago informado (NO descuenta deuda real)
      proy.pagosInformados = proy.pagosInformados || [];
      proy.pagosInformados.push({
        fecha: fechaJS,
        monto: montoNum,
        operadorId: req.user.id, // quién importó
        visto: false,
        erroneo: false,
        observacion: rawObs ? String(rawObs) : undefined,
      });

      // Recalcular importePagado solo con NO erróneos
      proy.importePagado = recalcularImportePagado(proy);
      proy.ultimaModificacion = new Date();

      await proy.save();
      await actualizarEstadoAutomaticamente(proy);

      ok++;
    }

    // ---- Respuesta según errores ----
    if (errores.length > 0) {
      const wbErr = new ExcelJS.Workbook();
      const wsErr = wbErr.addWorksheet("Errores");
      wsErr.columns = [
        { header: "Fila", key: "fila", width: 8 },
        { header: "DNI", key: "dni", width: 14 },
        { header: "Entidad", key: "entidad", width: 26 },
        { header: "SubCesión", key: "subCesion", width: 26 },
        { header: "Fecha", key: "fecha", width: 12 },
        { header: "Monto", key: "monto", width: 14 },
        { header: "Error", key: "error", width: 70 },
      ];
      errores.forEach((e) => wsErr.addRow(e));

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="errores_importacion_pagos.xlsx"'
      );
      // 200 con attachment (el front detecta por content-type)
      await wbErr.xlsx.write(res);
      return res.end();
    }

    // ✅ OK total
    return res.status(200).json({
      ok: true,
      procesados: ok,
      mensaje: `Pagos importados correctamente: ${ok}`,
    });
  } catch (e) {
    console.error("❌ importarPagosMasivo:", e);
    return res.status(500).json({ error: "Error al importar pagos" });
  }
};


export const exportarProyeccionesExcel = async (req, res) => {
  try {
    const {
      estado,
      concepto,
      entidadId,
      subCesionId,
      buscar,
      orden = "desc",
      usuarioId,
      // fechas (nuevo + compat)
      tipoFecha,
      fechaDesde,
      fechaHasta,
      desde,
      hasta,
    } = req.query;

    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso a exportación" });
    }

    // etiquetas: Entidad "n - NOMBRE" / SubCesión "NOMBRE"
    const buildLabelMaps = async () => {
      const [ents, subs] = await Promise.all([
        Entidad.find({}, "nombre").sort({ nombre: 1 }).lean(),
        SubCesion.find({}, "nombre").sort({ nombre: 1 }).lean(),
      ]);
      const entLabelById = new Map(); // id -> "n - NOMBRE"
      const subNameById = new Map();  // id -> "NOMBRE"
      ents.forEach((e, i) => entLabelById.set(String(e._id), `${i + 1} - ${e.nombre}`));
      subs.forEach((s) => subNameById.set(String(s._id), s.nombre));
      const entLabel = (id, fallbackName) =>
        id ? (entLabelById.get(String(id)) || (fallbackName ? `- ${fallbackName}` : "")) : (fallbackName || "");
      const subLabel = (id, fallbackName) =>
        id ? (subNameById.get(String(id)) || (fallbackName || "")) : (fallbackName || "");
      return { entLabel, subLabel };
    };
    const { entLabel, subLabel } = await buildLabelMaps();

    // Filtros base (según rol)
    const filtros = [];
    if (esSuper(req)) {
      if (usuarioId) filtros.push({ empleadoId: usuarioId });
    } else {
      filtros.push({ empleadoId: req.user.id });
    }

    if (estado) filtros.push({ estado });
    if (concepto) filtros.push({ concepto });
    if (entidadId) filtros.push({ entidadId });
    if (subCesionId) filtros.push({ subCesionId });

    // Rango de fechas (fechaPromesa/creado/modificado)
    const _fechaDesde = fechaDesde || desde;
    const _fechaHasta = fechaHasta || hasta;
    if (
      tipoFecha &&
      _fechaDesde &&
      _fechaHasta &&
      !isNaN(Date.parse(_fechaDesde)) &&
      !isNaN(Date.parse(_fechaHasta))
    ) {
      const desdeLocal = crearFechaLocal(_fechaDesde);
      const hastaLocal = crearFechaLocal(_fechaHasta, true);

      const campoFecha = {
        fechaPromesa: "fechaPromesa",
        creado: "creado",
        modificado: "ultimaModificacion",
      }[tipoFecha];

      if (campoFecha) {
        filtros.push({
          [campoFecha]: { $gte: desdeLocal, $lte: hastaLocal },
        });
      }
    }

    // Buscar (texto / DNI / ObjectId de entidad o subcesión)
    if (buscar) {
      const buscarStr = String(buscar).trim();
      const regex = new RegExp(buscarStr, "i");
      const posibleDni = parseInt(buscarStr, 10);
      const condiciones = [
        { nombreTitular: regex },
        { concepto: regex },
        { estado: regex },
      ];
      if (!isNaN(posibleDni)) condiciones.push({ dni: posibleDni });
      if (mongoose.isValidObjectId(buscarStr)) {
        condiciones.push({ entidadId: buscarStr });
        condiciones.push({ subCesionId: buscarStr });
      }
      filtros.push({ $or: condiciones });
    }

    const queryFinal = filtros.length ? { $and: filtros } : {};

    const proyecciones = await Proyeccion.find(queryFinal)
      .populate("empleadoId", "username")
      .populate("entidadId", "nombre")
      .populate("subCesionId", "nombre")
      .sort({ fechaPromesa: orden === "asc" ? 1 : -1 });

    // ---------- Excel ----------
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Proyecciones");

    worksheet.columns = [
      { header: "Creado por", key: "creadoPor", width: 20 },
      { header: "DNI", key: "dni", width: 15 },
      { header: "Titular", key: "nombreTitular", width: 25 },
      { header: "Importe", key: "importe", width: 12 },
      { header: "Importe Pagado", key: "importePagado", width: 15 },
      { header: "Estado", key: "estado", width: 18 },
      { header: "Concepto", key: "concepto", width: 20 },
      { header: "Entidad", key: "entidad", width: 24 },
      { header: "SubCesión", key: "subCesion", width: 24 },
      { header: "Fecha Promesa", key: "fechaPromesa", width: 15 },
      {
        header: "Fecha Próximo Llamado",
        key: "fechaProximoLlamado",
        width: 20,
      },
      { header: "Creado", key: "creado", width: 15 },
      { header: "Última Modificación", key: "ultimaModificacion", width: 20 },
      { header: "Gestiones", key: "vecesTocada", width: 12 },
      { header: "Última Gestión", key: "ultimaGestion", width: 18 },
      { header: "Observaciones", key: "observaciones", width: 30 },
    ];

    // Formato numérico de dinero
    const moneyFmt = "#,##0.00";
    ["importe", "importePagado"].forEach((k) => {
      const col = worksheet.getColumn(k);
      col.numFmt = moneyFmt;
      col.alignment = { horizontal: "right" };
    });

    // Normaliza a número (acepta "7,2" -> 7.2, etc.)
    const toNumber = (v) => {
      if (v === null || v === undefined) return 0;
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const s = v.replace(/\s/g, "").replace(",", ".");
        const n = Number(s);
        return isNaN(n) ? 0 : n;
      }
      const n = Number(v);
      return isNaN(n) ? 0 : n;
    };

    proyecciones.forEach((p) => {
      worksheet.addRow({
        creadoPor: p.empleadoId?.username || "-",
        dni: p.dni,
        nombreTitular: p.nombreTitular,
        importe: toNumber(p.importe),
        importePagado: toNumber(p.importePagado),
        estado: p.estado,
        concepto: p.concepto,
        entidad: entLabel(p.entidadId?._id || p.entidadId, p.entidadId?.nombre),
        subCesion: subLabel(p.subCesionId?._id || p.subCesionId, p.subCesionId?.nombre),
        fechaPromesa: formatearFecha(p.fechaPromesa),
        fechaProximoLlamado: formatearFecha(p.fechaProximoLlamado),
        creado: formatearFecha(p.creado),
        ultimaModificacion: formatearFecha(p.ultimaModificacion),
        vecesTocada: p.vecesTocada ?? 0,
        ultimaGestion: formatearFecha(p.ultimaGestion),
        observaciones: p.observaciones,
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=proyecciones.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("❌ Error al exportar Excel:", error);
    res.status(500).json({ error: "Error al exportar a Excel" });
  }
};


export const exportarPagosExcel = async (req, res) => {
  try {
    const {
      estado,
      concepto,
      entidadId,
      subCesionId,
      tipoFecha = "fechaPromesa",
      fechaDesde,
      fechaHasta,
      buscar,
      usuarioId, // opcional: para que super-admin filtre por usuario
      orden = "desc",
      soloNoErroneos = "false",
    } = req.query;

    const rol = rolDe(req);

    // --- filtros sobre PROYECCIONES ---
    const filtros = [];

    // operador: solo sus proyecciones
    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso a exportación" });
    }
    if (esOperativo(req)) {
      filtros.push({ empleadoId: req.user.id });
    } else if (usuarioId) {
      // super-admin: puede pasar usuarioId para filtrar
      filtros.push({ empleadoId: usuarioId });
    }

    if (estado) filtros.push({ estado });
    if (concepto) filtros.push({ concepto });
    if (entidadId) filtros.push({ entidadId });
    if (subCesionId) filtros.push({ subCesionId });

    // rango por el campo seleccionado (promesa/creado/modificado)
    let rangoDesde = null,
      rangoHasta = null;
    if (
      fechaDesde &&
      fechaHasta &&
      !isNaN(Date.parse(fechaDesde)) &&
      !isNaN(Date.parse(fechaHasta))
    ) {
      rangoDesde = crearFechaLocal(fechaDesde);
      rangoHasta = crearFechaLocal(fechaHasta, true);
      const campoFecha =
        {
          fechaPromesa: "fechaPromesa",
          creado: "creado",
          modificado: "ultimaModificacion",
        }[tipoFecha] || "fechaPromesa";
      filtros.push({ [campoFecha]: { $gte: rangoDesde, $lte: rangoHasta } });
    }

    // búsqueda libre
    if (buscar) {
      const regex = new RegExp(buscar, "i");
      const posibleDni = parseInt(buscar);
      const condiciones = [
        { nombreTitular: regex },
        { concepto: regex },
        { estado: regex },
      ];
      if (!isNaN(posibleDni)) condiciones.push({ dni: posibleDni });
      filtros.push({ $or: condiciones });
    }

    const queryProy = filtros.length ? { $and: filtros } : {};

    const proyecciones = await Proyeccion.find(queryProy)
      .populate("empleadoId", "username")
      .populate("pagosInformados.operadorId", "username nombre email")
      .sort({ fechaPromesa: orden === "asc" ? 1 : -1 })
      .lean();

    // rango por FECHA DE PAGO (usa el mismo rango si vino)
    const pagosDesde = rangoDesde;
    const pagosHasta = rangoHasta;
    const excluirErroneos = String(soloNoErroneos).toLowerCase() === "true";

    // etiquetas: Entidad "n - NOMBRE" / SubCesión "NOMBRE"
    const buildLabelMaps = async () => {
      const [ents, subs] = await Promise.all([
        Entidad.find({}, "nombre").sort({ nombre: 1 }).lean(),
        SubCesion.find({}, "nombre").sort({ nombre: 1 }).lean(),
      ]);
      const entLabelById = new Map(); // id -> "n - NOMBRE"
      const subNameById = new Map();  // id -> "NOMBRE"
      ents.forEach((e, i) => entLabelById.set(String(e._id), `${i + 1} - ${e.nombre}`));
      subs.forEach((s) => subNameById.set(String(s._id), s.nombre));
      const entLabel = (id, fallbackName) =>
        id ? (entLabelById.get(String(id)) || (fallbackName ? `- ${fallbackName}` : "")) : (fallbackName || "");
      const subLabel = (id, fallbackName) =>
        id ? (subNameById.get(String(id)) || (fallbackName || "")) : (fallbackName || "");
      return { entLabel, subLabel };
    };
    const { entLabel, subLabel } = await buildLabelMaps();

    // --- armar Excel ---
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Pagos informados");

    ws.columns = [
      { header: "Creado por", key: "creadoPor", width: 20 },
      { header: "Estado promesa", key: "estado", width: 18 },
      { header: "Entidad", key: "entidad", width: 26 },     // "n - NOMBRE"
      { header: "SubCesión", key: "subCesion", width: 26 },  // "NOMBRE"
      { header: "DNI", key: "dni", width: 14 },
      { header: "Titular", key: "titular", width: 24 },
      { header: "Importe promesa", key: "importe", width: 16 },
      { header: "Fecha promesa", key: "fechaPromesa", width: 14 },
      { header: "Fecha pago", key: "fechaPago", width: 14 },
      { header: "Monto pago", key: "montoPago", width: 14 },
      { header: "Erróneo", key: "erroneo", width: 10 },
      { header: "Operador", key: "operador", width: 20 },
    ];

    for (const p of proyecciones) {
      const base = {
        creadoPor: p.empleadoId?.username || "-",
        estado: p.estado,
        entidad: entLabel(p.entidadId),
        subCesion: subLabel(p.subCesionId),
        dni: p.dni,
        titular: p.nombreTitular,
        importe: p.importe,
        fechaPromesa: formatearFecha(p.fechaPromesa),
      };

      const pagos = (p.pagosInformados || [])
        .filter((pg) => !excluirErroneos || !pg.erroneo)
        .filter((pg) => {
          if (!pagosDesde || !pagosHasta) return true;
          const f = new Date(pg.fecha);
          return f >= pagosDesde && f <= pagosHasta;
        })
        .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

      for (const pago of pagos) {
        const op = pago?.operadorId || {};
        const nombreOp = op.username || op.nombre || op.email || "-";
        ws.addRow({
          ...base,
          fechaPago: formatearFecha(pago.fecha),
          montoPago: pago.monto,
          erroneo: pago.erroneo ? "Sí" : "No",
          operador: nombreOp,
        });
      }
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=pagos_informados.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("❌ Error al exportar pagos:", error);
    res.status(500).json({ error: "Error al exportar pagos a Excel" });
  }
};


export const importarProyeccionesMasivo = async (req, res) => {
  try {
    if (!esSuper(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    if (!req.file || !req.file.buffer) {
      return res
        .status(400)
        .json({ error: "Subí un archivo .xlsx en el campo 'file'." });
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws)
      return res.status(400).json({ error: "El archivo no tiene hojas." });

    // Mapa de encabezados en MAYÚSCULAS (se conservan tildes y guiones)
    const headerMap = new Map();
    ws.getRow(1).eachCell((cell, colNumber) => {
      headerMap.set(
        colNumber,
        String(cell.value || "").trim().toUpperCase()
      );
    });

    // Requeridos base (Entidad / SubCesión)
    const headersPresent = new Set(Array.from(headerMap.values()));
    const ENTIDAD_KEYS = ["ENTIDAD", "EMPRESA"];
    const SUBCESION_KEYS = [
      "SUBCESION", "SUBCESIÓN", "SUB CESION", "SUB CESIÓN", "SUB-CESION", "SUB-CESIÓN",
    ];

    const hasEntidad = ENTIDAD_KEYS.some((k) => headersPresent.has(k));
    const hasSub = SUBCESION_KEYS.some((k) => headersPresent.has(k));

    const faltan = [
      hasEntidad ? null : "ENTIDAD",
      hasSub ? null : "SUBCESION",
      headersPresent.has("CONCEPTO") ? null : "CONCEPTO",
      headersPresent.has("DNI") ? null : "DNI",
      headersPresent.has("NOMBRE") ? null : "NOMBRE",
      headersPresent.has("FECHA DE PROMESA") ? null : "FECHA DE PROMESA",
      headersPresent.has("IMPORTE") ? null : "IMPORTE",
    ].filter(Boolean);

    if (faltan.length) {
      return res
        .status(400)
        .json({ error: `Faltan columnas obligatorias: ${faltan.join(", ")}` });
    }

    // Opcional: columna de asignación de empleado
    const CANDIDATOS_EMPLEADO = new Set([
      "EMPLEADO","USUARIO","OPERADOR","ASIGNADO A","ASIGNADO_A","ASIGNADO","CREADO POR","CREADO_POR",
    ]);

    const getField = (obj, variants) => {
      for (const k of variants) if (k in obj) return obj[k];
      return undefined;
    };

    // helper: quitar prefijo "n - " de selects
    const parseSelectLabel = (v) => {
      if (v == null) return "";
      const s = String(v).trim();
      const m = s.match(/^\s*(?:[0-9a-f]{24}|\d+)\s*-\s*(.+)$/i);
      return (m ? m[1] : s).trim();
    };

    // Parsear filas
    const rows = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj = {};
      row.eachCell((cell, colNumber) => {
        obj[headerMap.get(colNumber)] = cell.value;
      });
      const hasData = Object.values(obj).some(
        (v) => v != null && String(v).trim() !== ""
      );
      if (hasData) rows.push({ rowNumber, ...obj });
    });

    const errores = [];
    const advertencias = [];
    const resultados = [];

    // ====== Caches DB ======
    // Empleados
    const empleados = await Empleado.find({}, "username email").lean();
    const byUsername = new Map(
      empleados.map((e) => [String(e.username || "").trim().toLowerCase(), e._id])
    );
    const byEmail = new Map(
      empleados.map((e) => [String(e.email || "").trim().toLowerCase(), e._id])
    );
    const resolverEmpleado = (valorCrudo) => {
      if (valorCrudo == null) return null;
      const s = String(valorCrudo).trim().toLowerCase();
      if (!s) return null;
      if (byUsername.has(s)) return byUsername.get(s);
      if (byEmail.has(s)) return byEmail.get(s);
      if (mongoose.isValidObjectId(s)) return s;
      return null;
    };

    // Entidad / SubCesión
    const normTxt = (s) => String(s || "").trim().toUpperCase();

    const cacheEntidades = new Map(); // nombre → doc
    const cacheSubs = new Map();      // nombre → doc  (GLOBAL por nombre)

    // Entidad: NO crear si no existe
    const getEntidad = async (nombre) => {
      const key = normTxt(nombre);
      if (cacheEntidades.has(key)) return cacheEntidades.get(key);
      const ent = await Entidad.findOne({ nombre: key });
      cacheEntidades.set(key, ent || null);
      return ent;
    };

    // SubCesión GLOBAL por nombre — crea si no existe
    const getSubCesion = async (nombre) => {
      const key = normTxt(nombre);
      if (cacheSubs.has(key)) return cacheSubs.get(key);
      let sub = await SubCesion.findOne({ nombre: key });
      if (!sub) sub = await SubCesion.create({ nombre: key }); // unique:true en nombre
      cacheSubs.set(key, sub);
      return sub;
    };

    // Proyección activa por (dni, entidadId, subCesionId)
    const activaCache = new Map(); // `${dni}::${entId}::${subId}` → doc/null
    const keyPair = (dni, entidadId, subId) => `${dni}::${entidadId}::${subId}`;
    const getActivaDeDB = async (dni, entidadId, subCesionId) => {
      const k = keyPair(dni, entidadId, subCesionId);
      if (activaCache.has(k)) return activaCache.get(k);
      const proy = await Proyeccion.findOne({
        dni, entidadId, subCesionId,
        $or: [{ isActiva: true }, { isActiva: { $exists: false } }],
      }).sort({ creado: -1 });
      activaCache.set(k, proy || null);
      return proy;
    };

    // Evitar duplicados dentro del archivo
    const creadasEnCorrida = new Map(); // key → { doc, filaCreacion }

    for (const r of rows) {
      const fila = r.rowNumber;
      try {
        const entidadNombre = parseSelectLabel(getField(r, ENTIDAD_KEYS));
        const subNombre = parseSelectLabel(getField(r, SUBCESION_KEYS));
        const concepto = String(r["CONCEPTO"] || "").trim();
        const dniRaw = String(r["DNI"] || "").trim();
        const nombre = String(r["NOMBRE"] || "").trim();
        const tel = String(r["TELEFONO"] || r["TELÉFONO"] || "").trim();
        const fechaProm = parseExcelDate(r["FECHA DE PROMESA"]);
        const fechaProx = parseExcelDate(r["PROX LLAMADO"]);
        const importe = Number(r["IMPORTE"] || 0);

        // Asignación
        let asignTexto = "";
        for (const key of CANDIDATOS_EMPLEADO) {
          if (r[key] != null && String(r[key]).trim() !== "") {
            asignTexto = String(r[key]).trim();
            break;
          }
        }
        let ownerId = req.user.id; // por defecto: el importador
        if (asignTexto) {
          const resuelto = resolverEmpleado(asignTexto);
          if (resuelto) ownerId = resuelto;
          else {
            advertencias.push({
              fila, dni: dniRaw, entidad: entidadNombre, subCesion: subNombre,
              motivo: `Empleado "${asignTexto}" no encontrado. Se asignó al importador.`,
            });
          }
        }

        // Validaciones
        if (!entidadNombre) throw new Error("ENTIDAD es obligatoria");
        if (!subNombre) throw new Error("SUBCESION es obligatoria");
        if (!concepto) throw new Error("CONCEPTO es obligatorio");
        if (!dniRaw) throw new Error("DNI es obligatorio");
        if (!nombre) throw new Error("NOMBRE es obligatorio");
        if (!fechaProm) throw new Error("FECHA DE PROMESA inválida/obligatoria");
        if (!Number.isFinite(importe) || importe <= 0) throw new Error("IMPORTE inválido (>0)");

        const dni = Number(String(dniRaw).replace(/\D/g, ""));
        if (!Number.isFinite(dni) || dni <= 0) throw new Error("DNI inválido");

        // Resolver Entidad (NO crear). Si no existe → error
        const entidad = await getEntidad(entidadNombre);
        if (!entidad) {
          throw new Error(`Entidad "${entidadNombre}" inexistente (debe crearse previamente)`);
        }

        // SubCesión GLOBAL (por nombre)
        const sub = await getSubCesion(subNombre);

        const anio = fechaProm.getFullYear();
        const mes = fechaProm.getMonth() + 1;

        const k = keyPair(dni, entidad._id, sub._id);

        // 1) Duplicado en el mismo archivo
        if (creadasEnCorrida.has(k)) {
          const { doc, filaCreacion } = creadasEnCorrida.get(k);
          doc.nombreTitular = nombre || doc.nombreTitular;
          doc.concepto = concepto || doc.concepto;
          if (tel) doc.telefono = tel;
          doc.fechaPromesa = fechaProm;
          doc.fechaProximoLlamado = fechaProx || undefined;
          doc.fechaPromesaInicial = doc.fechaPromesaInicial || fechaProm;
          doc.importe = importe;
          doc.estado = clasificarEstado(fechaProm);
          doc.anio = anio;
          doc.mes = mes;
          doc.empleadoId = ownerId;
          doc.ultimaModificacion = new Date();
          await doc.save();

          advertencias.push({
            fila, dni, entidad: entidad.nombre, subCesion: sub.nombre,
            motivo: `Duplicado en el archivo. Se ACTUALIZÓ la proyección creada en la fila ${filaCreacion}.`,
          });
          resultados.push({
            fila, dni, entidadId: String(entidad._id), subCesionId: String(sub._id),
            _id: String(doc._id), ok: true, actualizado: true,
          });
          continue;
        }

        // 2) Cerrar activa previa en DB (misma combinación)
        let activaPrevia = await getActivaDeDB(dni, entidad._id, sub._id);
        if (activaPrevia) {
          const estadoCierre = determinarEstadoCierre(activaPrevia);
          activaPrevia.isActiva = false;
          activaPrevia.estado = estadoCierre;
          activaPrevia.ultimaModificacion = new Date();
          await activaPrevia.save();
          activaCache.set(k, null);
          advertencias.push({
            fila, dni, entidad: entidad.nombre, subCesion: sub.nombre,
            motivo: `Se cerró la proyección activa previa (${activaPrevia._id}) como: ${estadoCierre}.`,
          });
        }

        // 3) Crear nueva activa
        const nueva = new Proyeccion({
          dni,
          nombreTitular: nombre,
          concepto,
          telefono: tel || undefined,
          fechaPromesa: fechaProm,
          fechaPromesaInicial: fechaProm,
          fechaProximoLlamado: fechaProx || undefined,
          importe,
          estado: clasificarEstado(fechaProm),
          anio, mes,
          isActiva: true,
          empleadoId: ownerId,
          creado: new Date(),
          ultimaModificacion: new Date(),
          entidadId: entidad._id,
          subCesionId: sub._id,
          idProyeccionLogico: `${dni}-${entidad._id}-${sub._id}`,
        });

        try {
          await nueva.save();
        } catch (e) {
          if (e?.code === 11000) {
            // Conflicto por única activa -> actualizar la activa
            const actual = await getActivaDeDB(dni, entidad._id, sub._id);
            if (actual) {
              actual.nombreTitular = nombre || actual.nombreTitular;
              actual.concepto = concepto || actual.concepto;
              if (tel) actual.telefono = tel;
              actual.fechaPromesa = fechaProm;
              actual.fechaProximoLlamado = fechaProx || undefined;
              actual.fechaPromesaInicial = actual.fechaPromesaInicial || fechaProm;
              actual.importe = importe;
              actual.estado = clasificarEstado(fechaProm);
              actual.anio = anio;
              actual.mes = mes;
              actual.empleadoId = ownerId;
              actual.entidadId = entidad._id;
              actual.subCesionId = sub._id;
              actual.idProyeccionLogico = `${dni}-${entidad._id}-${sub._id}`;
              actual.ultimaModificacion = new Date();
              await actual.save();

              creadasEnCorrida.set(k, { doc: actual, filaCreacion: fila });
              resultados.push({
                fila, dni, entidadId: String(entidad._id), subCesionId: String(sub._id),
                _id: String(actual._id), ok: true, actualizado: true,
              });
              continue;
            }
            throw e;
          } else {
            throw e;
          }
        }

        creadasEnCorrida.set(k, { doc: nueva, filaCreacion: fila });
        resultados.push({
          fila, dni, entidadId: String(entidad._id), subCesionId: String(sub._id),
          _id: String(nueva._id), ok: true,
        });
      } catch (e) {
        errores.push({
          fila,
          dni: r["DNI"],
          entidad: getField(r, ENTIDAD_KEYS),
          subCesion: getField(r, SUBCESION_KEYS),
          error: e.message || "Error inesperado",
        });
      }
    }

    // === Salida ===
    if (errores.length > 0 || advertencias.length > 0) {
      const wbOut = new ExcelJS.Workbook();
      const wsOut = wbOut.addWorksheet("Detalle importación");
      wsOut.columns = [
        { header: "Fila", key: "fila", width: 8 },
        { header: "DNI", key: "dni", width: 14 },
        { header: "Entidad", key: "entidad", width: 20 },
        { header: "SubCesión", key: "subCesion", width: 20 },
        { header: "Resultado", key: "resultado", width: 16 },
        { header: "Mensaje", key: "mensaje", width: 70 },
      ];
      for (const a of advertencias) {
        wsOut.addRow({
          fila: a.fila, dni: a.dni, entidad: a.entidad, subCesion: a.subCesion,
          resultado: "ADVERTENCIA", mensaje: a.motivo,
        });
      }
      for (const er of errores) {
        wsOut.addRow({
          fila: er.fila, dni: er.dni, entidad: er.entidad, subCesion: er.subCesion,
          resultado: "ERROR", mensaje: er.error,
        });
      }
      const buf = await wbOut.xlsx.writeBuffer();
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="resultado_importacion_proyecciones.xlsx"'
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.status(errores.length > 0 ? 207 : 200);
      return res.send(Buffer.from(buf));
    }

    return res.json({
      mensaje: "Proyecciones importadas correctamente",
      importados: resultados.length,
      advertencias: [],
    });
  } catch (err) {
    console.error("Error en importarProyeccionesMasivo:", err);
    res.status(500).json({ error: "Error interno al importar proyecciones" });
  }
};
