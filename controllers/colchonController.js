import Colchon from "../models/Colchon.js";
import Entidad from "../models/Entidad.js";
import SubCesion from "../models/SubCesion.js";
import Empleado from "../models/Empleado.js";
import Cartera from "../models/Cartera.js";
import ExcelJS from "exceljs";
import { formatearFecha } from "../utils/formatearFecha.js";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose"; // Asegurate de tener esto al inicio

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const esSuper = (req) => (req.user.role || req.user.rol) === "super-admin";
const esAdmin = (req) => (req.user.role || req.user.rol) === "admin";
const esOperadorVip = (req) =>
  (req.user.role || req.user.rol) === "operador-vip";
const esOperador = (req) => (req.user.role || req.user.rol) === "operador";
const esOperativo = (req) => esOperador(req) || esOperadorVip(req); // propios

// 🔁 Calcula saldo pendiente priorizando deudaPorMes
export const calcularSaldoPendiente = (cuota) => {
  if (Array.isArray(cuota.deudaPorMes) && cuota.deudaPorMes.length) {
    return Math.max(
      cuota.deudaPorMes.reduce(
        (acc, d) => acc + Number(d.montoAdeudado || 0),
        0
      ),
      0
    );
  }
  const totalPagado = (cuota.pagos || []).reduce(
    (acc, p) => acc + Number(p.monto || 0),
    0
  );
  return Math.max(Number(cuota.importeCuota || 0) - totalPagado, 0);
};

// 🔁 Calcula estado de la cuota (solo fallback)
export const actualizarEstadoCuota = (cuota) => {
  const saldoPendiente = calcularSaldoPendiente(cuota);

  // Si no hay deuda → A cuota
  if (saldoPendiente === 0) return "A cuota";

  // Por defecto, mantener el estado actual
  return cuota.estado || "A cuota";
};

// Crear manual
export const crearCuota = async (req, res) => {
  try {
    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

    const {
      dni,
      nombre,
      cuotaNumero,
      importeCuota,
      vencimiento,
      observaciones,
      observacionesOperador,
      fiduciario,
      entidadId,
      subCesionId,
      turno,
      vencimientoDesde,
      vencimientoHasta,
      estado,
      telefono,
      empleadoId,
      pagos,
    } = req.body;

    const dniN = parseInt(dni, 10);
    const cuotaNumeroN =
      cuotaNumero != null ? parseInt(cuotaNumero, 10) : undefined;
    const importeCuotaN =
      importeCuota != null ? Number(importeCuota) : undefined;
    const vencimientoN = parseInt(vencimiento, 10);

    if (
      !entidadId ||
      !subCesionId ||
      isNaN(dniN) ||
      !nombre ||
      isNaN(importeCuotaN) ||
      isNaN(vencimientoN)
    ) {
      return res.status(400).json({
        error: "Faltan campos obligatorios (incluye ENTIDAD y SUBCESIÓN).",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(entidadId)) {
      return res.status(400).json({ error: "Entidad inválida" });
    }
    if (!mongoose.Types.ObjectId.isValid(subCesionId)) {
      return res.status(400).json({ error: "Subcesión inválida" });
    }

    const idCuotaLogico = `${dniN}-${entidadId}-${subCesionId}`;
    const yaExiste = await Colchon.findOne({ idCuotaLogico });
    if (yaExiste) {
      return res.status(400).json({
        error:
          "⚠️ Ya existe una cuota para este DNI con esta ENTIDAD y SUBCESIÓN.",
      });
    }

    const nueva = new Colchon({
      dni: dniN,
      nombre,
      cuotaNumero: cuotaNumeroN,
      importeCuota: importeCuotaN,
      vencimiento: vencimientoN,
      observaciones,
      observacionesOperador: observacionesOperador || "",
      fiduciario,
      entidadId: new mongoose.Types.ObjectId(entidadId),
      subCesionId: new mongoose.Types.ObjectId(subCesionId),
      turno,
      telefono,
      pagos: pagos || [],
      vencimientoCuotas: { desde: vencimientoDesde, hasta: vencimientoHasta },
      empleadoId: empleadoId || req.user.id,
      idCuotaLogico,
      creado: new Date(),
      ultimaModificacion: new Date(),
    });

    if (estado && typeof estado === "string" && estado.trim()) {
      nueva.estado = estado.trim();
      nueva.estadoOriginal = estado.trim();
    } else {
      nueva.estado = "A cuota";
      nueva.estadoOriginal = "A cuota";
    }

    // Recalcular deuda / saldo / alerta
    nueva.estado = nueva.estadoOriginal;
    actualizarDeudaPorMes(nueva);
    nueva.saldoPendiente = (nueva.deudaPorMes || []).reduce(
      (acc, d) => acc + (d.montoAdeudado || 0),
      0
    );

    const imp = Number(nueva.importeCuota) || 0;
    const cuotasAdeudadas =
      Array.isArray(nueva.deudaPorMes) && nueva.deudaPorMes.length
        ? nueva.deudaPorMes.filter((m) => Number(m.montoAdeudado || 0) > 0)
            .length
        : imp > 0
        ? Math.floor(Number(nueva.saldoPendiente || 0) / imp)
        : 0;
    nueva.alertaDeuda = cuotasAdeudadas > 1;

    await nueva.save();
    res.json(nueva);
  } catch (error) {
    console.error("❌ Error al crear cuota:", error);
    res.status(500).json({ error: "Error al crear cuota" });
  }
};

// Editar cuota
export const editarCuota = async (req, res) => {
  try {
    const cuota = await Colchon.findById(req.params.id);
    if (!cuota) return res.status(404).json({ error: "Cuota no encontrada" });

    // 👷 Operador / operador-vip: sólo observación + teléfono
    if (esOperativo(req)) {
      const { observacionesOperador, telefono } = req.body;
      if (observacionesOperador !== undefined)
        cuota.observacionesOperador = observacionesOperador;
      if (telefono !== undefined) cuota.telefono = telefono;

      // recalcular vistas (no cambia base)
      const estadoBase = cuota.estadoOriginal || cuota.estado || "A cuota";
      cuota.estado = estadoBase;
      actualizarDeudaPorMes(cuota);

      cuota.saldoPendiente = (cuota.deudaPorMes || []).reduce(
        (acc, d) => acc + (Number(d.montoAdeudado) || 0),
        0
      );

      if (Array.isArray(cuota.pagos) && cuota.pagos.length > 0) {
        cuota.estado = "A cuota";
      }

      // 🟨 sólo si >1 cuota adeudada
      const cuotasAdeudadas =
        Array.isArray(cuota.deudaPorMes) && cuota.deudaPorMes.length
          ? cuota.deudaPorMes.filter((m) => Number(m.montoAdeudado || 0) > 0)
              .length
          : (() => {
              const imp = Number(cuota.importeCuota) || 0;
              return imp > 0
                ? Math.floor(Number(cuota.saldoPendiente || 0) / imp)
                : 0;
            })();
      cuota.alertaDeuda = cuotasAdeudadas > 1;

      cuota.ultimaModificacion = new Date();
      await cuota.save();
      return res.json(cuota);
    }

    // 🛡️ Super-admin: actualización parcial
    const {
      cartera,
      dni,
      nombre,
      cuotaNumero,
      importeCuota,
      vencimiento,
      fechaPago,
      observaciones,
      observacionesOperador,
      fiduciario,
      entidadId,
      subCesionId,
      turno,
      vencimientoDesde,
      vencimientoHasta,
      pagos,
      empleadoId,
      estado,
      telefono,
    } = req.body;

    if (entidadId !== undefined) cuota.entidadId = entidadId;
    if (subCesionId !== undefined) cuota.subCesionId = subCesionId;

    if (cartera !== undefined) cuota.cartera = cartera;
    if (dni !== undefined) cuota.dni = dni;
    if (nombre !== undefined) cuota.nombre = nombre;
    if (cuotaNumero !== undefined) cuota.cuotaNumero = cuotaNumero;
    if (importeCuota !== undefined) cuota.importeCuota = importeCuota;
    if (vencimiento !== undefined) cuota.vencimiento = vencimiento;
    if (fechaPago !== undefined) cuota.fechaPago = fechaPago;
    if (observaciones !== undefined) cuota.observaciones = observaciones;
    if (observacionesOperador !== undefined)
      cuota.observacionesOperador = observacionesOperador;
    if (fiduciario !== undefined) cuota.fiduciario = fiduciario;
    if (turno !== undefined) cuota.turno = turno;
    if (telefono !== undefined) cuota.telefono = telefono;
    if (Array.isArray(pagos)) cuota.pagos = pagos;
    if (empleadoId !== undefined) cuota.empleadoId = empleadoId;

    if (vencimientoDesde !== undefined || vencimientoHasta !== undefined) {
      cuota.vencimientoCuotas = {
        desde: vencimientoDesde ?? cuota.vencimientoCuotas?.desde,
        hasta: vencimientoHasta ?? cuota.vencimientoCuotas?.hasta,
      };
    }

    // Estado base (permite fijar Cuota 30/60/90 manualmente)
    if (typeof estado === "string" && estado.trim()) {
      cuota.estado = estado.trim();
      cuota.estadoOriginal = estado.trim();
    } else {
      cuota.estado = cuota.estadoOriginal || cuota.estado || "A cuota";
    }

    // Recalcular clave lógica si cambian DNI/entidad/subcesión
    if (
      dni !== undefined ||
      entidadId !== undefined ||
      subCesionId !== undefined
    ) {
      if (cuota.dni && cuota.entidadId && cuota.subCesionId) {
        cuota.idCuotaLogico = `${cuota.dni}-${String(cuota.entidadId)}-${String(
          cuota.subCesionId
        )}`;
      }
    }

    // 🔄 Recalcular deuda/saldo/alerta
    const estadoBase = cuota.estadoOriginal || cuota.estado || "A cuota";
    cuota.estado = estadoBase;
    actualizarDeudaPorMes(cuota);

    cuota.saldoPendiente = (cuota.deudaPorMes || []).reduce(
      (acc, d) => acc + (Number(d.montoAdeudado) || 0),
      0
    );

    if (Array.isArray(cuota.pagos) && cuota.pagos.length > 0) {
      cuota.estado = "A cuota";
    }

    const cuotasAdeudadas =
      Array.isArray(cuota.deudaPorMes) && cuota.deudaPorMes.length
        ? cuota.deudaPorMes.filter((m) => Number(m.montoAdeudado || 0) > 0)
            .length
        : (() => {
            const imp = Number(cuota.importeCuota) || 0;
            return imp > 0
              ? Math.floor(Number(cuota.saldoPendiente || 0) / imp)
              : 0;
          })();
    cuota.alertaDeuda = cuotasAdeudadas > 1;

    cuota.ultimaModificacion = new Date();
    await cuota.save();
    res.json(cuota);
  } catch (error) {
    console.error("❌ Error al editar cuota:", error);
    res.status(500).json({ error: "Error al editar cuota" });
  }
};

// Eliminar cuota
export const eliminarCuota = async (req, res) => {
  try {
    const cuota = await Colchon.findById(req.params.id);
    if (!cuota) return res.status(404).json({ error: "Cuota no encontrada" });

    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

    await cuota.deleteOne();
    res.json({ message: "Cuota eliminada correctamente" });
  } catch (error) {
    console.error("❌ Error al eliminar cuota:", error);
    res.status(500).json({ error: "Error al eliminar cuota" });
  }
};

export const eliminarCuotasSeleccionadas = async (req, res) => {
  try {
    if (!esSuper(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const ids = Array.from(
      new Set(
        (Array.isArray(req.body?.ids) ? req.body.ids : [])
          .map((id) => String(id || "").trim())
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      )
    );

    if (ids.length === 0) {
      return res.status(400).json({ error: "Seleccioná al menos una cuota válida." });
    }

    if (ids.length > 500) {
      return res.status(400).json({
        error: "Por seguridad, solo se pueden eliminar hasta 500 cuotas por vez.",
      });
    }

    const resultado = await Colchon.deleteMany({ _id: { $in: ids } });
    return res.json({
      message: "Cuotas seleccionadas eliminadas correctamente",
      eliminadas: Number(resultado.deletedCount || 0),
    });
  } catch (error) {
    console.error("❌ Error al eliminar cuotas seleccionadas:", error);
    return res.status(500).json({ error: "Error al eliminar cuotas seleccionadas" });
  }
};

// Helper para castear a ObjectId cuando corresponde (aggregate NO castea automáticamente)
const toObjId = (v) =>
  mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : v;

export const filtrarCuotas = async (req, res) => {
  try {
    const {
      dni,
      nombre,
      entidad,
      subCesion,
      estado,
      usuarioId,
      diaDesde,
      diaHasta,
      page = 1,
      limit = 50,
      sortBy = "vencimiento",
      sortDirection = "asc",
      sinGestion,
      conPagosNoVistos,
    } = req.query;

    const rol = req.user.role || req.user.rol;

    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso al módulo Colchón" });
    }

    const filtrosBase = [];

    if (esOperativo(req)) {
      filtrosBase.push({ empleadoId: toObjId(req.user.id) });
    } else if (usuarioId) {
      filtrosBase.push({ empleadoId: toObjId(usuarioId) });
    }

    if (dni) {
      const dniParsed = parseInt(dni, 10);
      if (!Number.isNaN(dniParsed)) filtrosBase.push({ dni: dniParsed });
    }

    if (nombre) {
      const nombreSeguro = String(nombre)
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (nombreSeguro) filtrosBase.push({ nombre: new RegExp(nombreSeguro, "i") });
    }

    if (entidad && mongoose.Types.ObjectId.isValid(entidad)) {
      filtrosBase.push({ entidadId: new mongoose.Types.ObjectId(entidad) });
    }
    if (subCesion && mongoose.Types.ObjectId.isValid(subCesion)) {
      filtrosBase.push({ subCesionId: new mongoose.Types.ObjectId(subCesion) });
    }

    if (diaDesde !== undefined || diaHasta !== undefined) {
      const desde = Math.max(1, Math.min(parseInt(diaDesde || 1, 10), 31));
      const hasta = Math.max(1, Math.min(parseInt(diaHasta || 31, 10), 31));
      if (desde <= hasta) filtrosBase.push({ vencimiento: { $gte: desde, $lte: hasta } });
    }

    if (sinGestion === "true") {
      filtrosBase.push({
        $or: [
          { vecesTocada: { $exists: false } },
          { vecesTocada: null },
          { vecesTocada: { $lte: 0 } },
        ],
      });
    }

    if (conPagosNoVistos === "true") {
      filtrosBase.push({ "pagosInformados.visto": false });
    }

    const baseMatch = filtrosBase.length ? { $and: filtrosBase } : {};
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 200);
    const skip = (pageNumber - 1) * pageLimit;
    const sortDir = sortDirection === "desc" ? -1 : 1;

    const derivedStages = [
      {
        $addFields: {
          estadoFinal: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$pagos", []] } }, 0] },
              "A cuota",
              { $ifNull: ["$estadoOriginal", "$estado"] },
            ],
          },
          pagadoTotal: {
            $sum: {
              $map: {
                input: { $ifNull: ["$pagos", []] },
                as: "pago",
                in: { $ifNull: ["$$pago.monto", 0] },
              },
            },
          },
        },
      },
    ];

    if (estado) derivedStages.push({ $match: { estadoFinal: estado } });

    const lookupStages = [
      {
        $lookup: {
          from: "empleados",
          localField: "empleadoId",
          foreignField: "_id",
          as: "empleado",
          pipeline: [{ $project: { _id: 1, username: 1 } }],
        },
      },
      { $unwind: { path: "$empleado", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "entidads",
          localField: "entidadId",
          foreignField: "_id",
          as: "entidad",
          pipeline: [{ $project: { _id: 1, nombre: 1, numero: 1 } }],
        },
      },
      { $unwind: { path: "$entidad", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "subcesions",
          localField: "subCesionId",
          foreignField: "_id",
          as: "subcesion",
          pipeline: [{ $project: { _id: 1, nombre: 1 } }],
        },
      },
      { $unwind: { path: "$subcesion", preserveNullAndEmptyArrays: true } },
    ];

    const sortFieldMap = {
      vencimiento: "vencimiento",
      dni: "dni",
      nombre: "nombre",
      cuotaNumero: "cuotaNumero",
      importeCuota: "importeCuota",
      saldoPendiente: "saldoPendiente",
      estado: "estadoFinal",
      pagado: "pagadoTotal",
      ultimaGestion: "ultimaGestion",
      empleadoId: "empleado.username",
      entidadId: "entidad.nombre",
      cartera: "subcesion.nombre",
      subCesionId: "subcesion.nombre",
    };

    const sortField = sortFieldMap[String(sortBy || "").trim()] || "vencimiento";
    const necesitaLookupAntesDeOrdenar = [
      "empleado.username",
      "entidad.nombre",
      "subcesion.nombre",
    ].includes(sortField);
    const sortStage = { $sort: { [sortField]: sortDir, _id: 1 } };

    const pipelineConteo = [
      { $match: baseMatch },
      ...derivedStages,
      { $count: "count" },
    ];

    const pipelineDatos = [
      { $match: baseMatch },
      ...derivedStages,
      ...(necesitaLookupAntesDeOrdenar ? lookupStages : []),
      sortStage,
      { $skip: skip },
      { $limit: pageLimit },
      ...(!necesitaLookupAntesDeOrdenar ? lookupStages : []),
      {
        $project: {
          _id: 1,
          dni: 1,
          nombre: 1,
          vencimiento: 1,
          cuotaNumero: 1,
          importeCuota: 1,
          saldoPendiente: 1,
          deudaPorMes: 1,
          telefono: 1,
          turno: 1,
          vecesTocada: 1,
          fechaUltimaTocada: 1,
          ultimaGestion: 1,
          usuarioUltimoTocado: 1,
          pagos: 1,
          pagosInformados: 1,
          estadoOriginal: 1,
          estado: "$estadoFinal",
          pagadoTotal: 1,
          observaciones: 1,
          observacionesOperador: 1,
          empleadoId: { _id: "$empleado._id", username: "$empleado.username" },
          entidadId: {
            _id: "$entidad._id",
            nombre: "$entidad.nombre",
            numero: "$entidad.numero",
          },
          subCesionId: { _id: "$subcesion._id", nombre: "$subcesion.nombre" },
        },
      },
    ];

    const filtroGeneral =
      rol === "operador" || rol === "operador-vip"
        ? { empleadoId: toObjId(req.user.id) }
        : usuarioId
        ? { empleadoId: toObjId(usuarioId) }
        : {};

    const [conteoRes, resultadosAgg, totalGeneral] = await Promise.all([
      Colchon.aggregate(pipelineConteo).allowDiskUse(true),
      Colchon.aggregate(pipelineDatos).allowDiskUse(true),
      Colchon.countDocuments(filtroGeneral),
    ]);

    const totalFiltrado = conteoRes?.[0]?.count || 0;
    const resultados = resultadosAgg.map((cuota) => {
      const cuotasAdeudadas =
        Array.isArray(cuota.deudaPorMes) && cuota.deudaPorMes.length
          ? cuota.deudaPorMes.filter((m) => Number(m.montoAdeudado || 0) > 0).length
          : (() => {
              const imp = Number(cuota.importeCuota) || 0;
              const saldo = Number(cuota.saldoPendiente) || 0;
              return imp > 0 ? Math.floor(saldo / imp) : 0;
            })();

      return {
        ...cuota,
        alertaDeuda: cuota.estado === "A cuota" && cuotasAdeudadas > 1,
      };
    });

    return res.json({
      resultados,
      totalFiltrado,
      totalGeneral,
      page: pageNumber,
      limit: pageLimit,
      pages: Math.max(1, Math.ceil(totalFiltrado / pageLimit)),
    });
  } catch (error) {
    console.error("❌ Error al filtrar cuotas:", error);
    return res.status(500).json({ error: "Error al filtrar cuotas" });
  }
};


// Importar desde Excel
export const importarExcel = async (req, res) => {
  if (!esSuper(req)) return res.status(403).json({ error: "No autorizado" });
  try {
    if (!req.file)
      return res.status(400).json({ error: "No se recibió archivo" });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];

    const sinTildes = (s) =>
      String(s)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    const encabezadosEsperados = [
      "ESTADO",
      "ENTIDAD",
      "DNI",
      "NOMBRE Y APELLIDO",
      "OPERADOR",
      "TURNO",
      "SUBCESION",
      "VTO CUO",
      "C/CUOTAS",
      "$CUOTA",
      "TELEFONO", // ← sin acentos
    ];

    const encabezadosArchivo = worksheet
      .getRow(1)
      .values.slice(1)
      .map((v) => sinTildes(v).trim().toUpperCase());

    const validacionEncabezados = encabezadosEsperados.every(
      (e, i) => e === encabezadosArchivo[i]
    );

    if (!validacionEncabezados) {
      return res.status(400).json({
        error:
          "Encabezados inválidos o desordenados. Usá el archivo modelo para asegurarte.",
      });
    }

    const errores = [];
    const filasValidas = [];
    const filasConErrores = [];

    const entidadesCache = {};
    const empleadosCache = {};
    const subCesionesCache = {};

    const entidades = await Entidad.find();
    entidades.forEach((e) => (entidadesCache[e.numero] = e));

    const empleados = await Empleado.find();
    empleados.forEach((e) => (empleadosCache[e.username.toLowerCase()] = e));

    const subcesiones = await SubCesion.find();
    subcesiones.forEach((s) => (subCesionesCache[s.nombre.toUpperCase()] = s));

    const calcularDeudaPorMes = (cuota) => {
      const meses = {
        "Cuota 30": 2,
        "Cuota 60": 3,
        "Cuota 90": 4,
        Caída: 5,
      };
      const hoy = new Date();
      const deudaMeses = meses[cuota.estadoOriginal] || 1;
      cuota.deudaPorMes = [];

      for (let i = deudaMeses - 1; i >= 0; i--) {
        const fecha = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
        cuota.deudaPorMes.push({
          mes: fecha.toLocaleString("es-AR", { month: "long" }),
          anio: fecha.getFullYear(),
          montoAdeudado: cuota.importeCuota,
        });
      }
    };

    for (let i = 2; i <= worksheet.rowCount; i++) {
      const row = worksheet.getRow(i);
      const filaOriginal = row.values
        .slice(1)
        .map((v) => (v !== null ? v : ""));

      let motivos = [];

      const estadoRaw = (row.getCell(1).value || "").toString().trim();
      const estado = /a\s*cuota/i.test(estadoRaw) ? "A cuota" : estadoRaw;

      const entidadNumero = parseInt(row.getCell(2).value);
      const dni = parseInt(row.getCell(3).value);
      const nombre = (row.getCell(4).value || "").toString().trim();
      const operadorUsername = (row.getCell(5).value || "").toString().trim();
      const turno = (row.getCell(6).value || "").toString().trim();
      const cartera = (row.getCell(7).value || "").toString().trim();
      const vtoCuota = parseInt(row.getCell(8).value);
      const cuotas = parseInt(row.getCell(9).value);
      const importeCuota = parseFloat(row.getCell(10).value || 0);
      const telefono = (row.getCell(11).value || "").toString().trim();

      if (!estado) motivos.push("Falta ESTADO");
      if (!entidadNumero) motivos.push("Falta ENTIDAD");
      if (!dni) motivos.push("Falta DNI");
      if (!nombre) motivos.push("Falta NOMBRE");
      if (!operadorUsername) motivos.push("Falta OPERADOR");
      if (!turno) motivos.push("Falta TURNO");
      if (!cartera) motivos.push("Falta SUBCESIÓN");
      if (!vtoCuota) motivos.push("Falta VTO CUO");
      if (!cuotas) motivos.push("Falta C/CUOTAS");
      if (!importeCuota) motivos.push("Falta $CUOTA");
      if (!telefono) motivos.push("Falta TELÉFONO");

      const entidad = entidadesCache[entidadNumero];
      if (!entidad) motivos.push("Entidad no encontrada");

      const empleado = empleadosCache[operadorUsername.toLowerCase()];
      if (!empleado) motivos.push("Operador no encontrado");

      if (motivos.length > 0) {
        filasConErrores.push([...filaOriginal, motivos.join(" | ")]);
        continue;
      }

      // 🔎 Resolver/crear SubCesión a partir de "cartera"
      let subCesion = subCesionesCache[cartera.toUpperCase()];
      if (!subCesion) {
        subCesion = await SubCesion.create({ nombre: cartera.toUpperCase() });
        subCesionesCache[cartera.toUpperCase()] = subCesion;
      }

      filasValidas.push({
        filaExcel: i,
        entidad,
        subCesion,
        empleadoId: empleado._id,
        empleadoUsername: empleado.username,
        dni,
        nombre,
        turno,
        carteraNombre: cartera,
        vtoCuota,
        cuotas,
        importeCuota,
        telefono,
        estadoExcel: estado,
      });
    }

    let insertadas = 0;
    let actualizadas = 0;

    const mostrarDuplicadosComoError = true;

    for (const fila of filasValidas) {
      try {
        // 🔑 NUEVA CLAVE: DNI + ENTIDAD + SUBCESIÓN
        const idCuotaLogico = `${fila.dni}-${fila.entidad._id}-${fila.subCesion._id}`;
        const existente = await Colchon.findOne({ idCuotaLogico });

        if (existente) {
          Object.assign(existente, {
            entidadId: fila.entidad._id,
            dni: fila.dni,
            nombre: fila.nombre,
            empleadoId: fila.empleadoId,
            turno: fila.turno,
            cartera: fila.carteraNombre,
            vencimiento: fila.vtoCuota,
            cuotaNumero: fila.cuotas,
            importeCuota: fila.importeCuota,
            subCesionId: fila.subCesion._id,
            estado: fila.estadoExcel,
            estadoOriginal: fila.estadoExcel,
            telefono: fila.telefono,
            ultimaModificacion: new Date(),
          });

          calcularDeudaPorMes(existente);
          existente.saldoPendiente = existente.deudaPorMes.reduce(
            (acc, d) => acc + d.montoAdeudado,
            0
          );
          existente.alertaDeuda =
            existente.estado === "A cuota" &&
            existente.saldoPendiente > existente.importeCuota;

          await existente.save();
          actualizadas++;

          // ✅ Mostrar duplicados como errores (mensaje actualizado)
          filasConErrores.push([
            fila.estadoExcel || "", // A
            fila.entidad?.numero || "", // B
            fila.dni || "", // C
            fila.nombre || "", // D
            fila.empleadoUsername || "", // E
            fila.turno || "", // F
            fila.carteraNombre || "", // G
            fila.vtoCuota || "", // H
            fila.cuotas || "", // I
            fila.importeCuota || "", // J
            fila.telefono || "", // K
            "Fila duplicada: ya existía una cuota con ese DNI + ENTIDAD + SUBCESIÓN", // L
          ]);
        } else {
          const nueva = new Colchon({
            entidadId: fila.entidad._id,
            dni: fila.dni,
            nombre: fila.nombre,
            empleadoId: fila.empleadoId,
            turno: fila.turno,
            cartera: fila.carteraNombre,
            vencimiento: fila.vtoCuota,
            cuotaNumero: fila.cuotas,
            importeCuota: fila.importeCuota,
            idCuotaLogico, // ← con subCesión
            subCesionId: fila.subCesion._id,
            ultimaModificacion: new Date(),
            creado: new Date(),
            pagos: [],
            pagosInformados: [],
            estado: fila.estadoExcel,
            estadoOriginal: fila.estadoExcel,
            telefono: fila.telefono,
          });

          calcularDeudaPorMes(nueva);
          nueva.saldoPendiente = nueva.deudaPorMes.reduce(
            (acc, d) => acc + d.montoAdeudado,
            0
          );
          const imp = Number(nueva.importeCuota) || 0;
          const cuotasAdeudadas =
            Array.isArray(nueva.deudaPorMes) && nueva.deudaPorMes.length
              ? nueva.deudaPorMes.filter(
                  (m) => Number(m.montoAdeudado || 0) > 0
                ).length
              : imp > 0
              ? Math.floor(Number(nueva.saldoPendiente || 0) / imp)
              : 0;
          nueva.alertaDeuda = cuotasAdeudadas > 1;

          await nueva.save();
          insertadas++;
        }
      } catch (err) {
        filasConErrores.push([
          fila.estadoExcel || "",
          fila.entidad?.numero || "",
          fila.dni || "",
          fila.nombre || "",
          fila.empleadoUsername || "",
          fila.turno || "",
          fila.carteraNombre || "", // ← acá va la SubCesión (texto)
          fila.vtoCuota || "",
          fila.cuotas || "",
          fila.importeCuota || "",
          fila.telefono || "",
          err?.message || "Error desconocido",
        ]);
      }
    }

    if (filasConErrores.length > 0) {
      const erroresWorkbook = new ExcelJS.Workbook();
      const erroresSheet = erroresWorkbook.addWorksheet("Errores");

      erroresSheet.addRow([...encabezadosEsperados, "MOTIVO DEL ERROR"]);
      filasConErrores.forEach((fila) => erroresSheet.addRow(fila));

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=colchon-con-errores.xlsx"
      );

      await erroresWorkbook.xlsx.write(res);
      return; // ✅ Finaliza sin enviar JSON
    }

    res.json({
      procesadas: worksheet.rowCount - 1,
      insertadas,
      actualizadas,
    });
  } catch (error) {
    console.error("❌ Error al importar Excel:", error);
    res.status(500).json({ error: "Error al procesar el archivo Excel" });
  }
};

// Exportar a Excel
export const exportarExcel = async (req, res) => {
  try {
    const {
      dni,
      nombre,
      entidad,
      subCesion,
      estado,
      usuarioId,
      diaDesde,
      diaHasta,
      conPagosNoVistos,
    } = req.query;

    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso a exportación" });
    }

    const filtros = [];
    if (esOperativo(req)) {
      filtros.push({ empleadoId: req.user.id });
    } else if (usuarioId) {
      filtros.push({ empleadoId: usuarioId });
    }

    if (dni) {
      const dniParsed = parseInt(dni, 10);
      if (!Number.isNaN(dniParsed)) filtros.push({ dni: dniParsed });
    }

    if (nombre) {
      const nombreSeguro = String(nombre)
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (nombreSeguro) filtros.push({ nombre: new RegExp(nombreSeguro, "i") });
    }

    if (entidad && mongoose.Types.ObjectId.isValid(entidad)) {
      filtros.push({ entidadId: entidad });
    }
    if (subCesion && mongoose.Types.ObjectId.isValid(subCesion)) {
      filtros.push({ subCesionId: subCesion });
    }

    if (diaDesde !== undefined || diaHasta !== undefined) {
      const desde = Math.max(1, Math.min(parseInt(diaDesde || 1, 10), 31));
      const hasta = Math.max(1, Math.min(parseInt(diaHasta || 31, 10), 31));
      if (desde <= hasta) filtros.push({ vencimiento: { $gte: desde, $lte: hasta } });
    }

    if (conPagosNoVistos === "true") {
      filtros.push({ "pagosInformados.visto": false });
    }

    const query = filtros.length ? { $and: filtros } : {};

    let cuotas = await Colchon.find(query)
      .populate("empleadoId", "username")
      .populate("entidadId", "numero nombre")
      .populate("subCesionId", "nombre")
      .lean();

    const sumar = (lista) =>
      (Array.isArray(lista) ? lista : []).reduce(
        (total, item) => total + Number(item?.monto || 0),
        0
      );
    const informadosValidos = (cuota) =>
      (Array.isArray(cuota.pagosInformados) ? cuota.pagosInformados : []).filter(
        (pago) => !pago?.erroneo
      );
    const abreviarTurno = (value) => {
      const texto = String(value || "").trim().toLowerCase();
      if (!texto) return "";
      if (texto === "m" || texto === "tm" || texto.includes("mañana") || texto.includes("manana")) return "TM";
      if (texto === "t" || texto === "tt" || texto.includes("tarde")) return "TT";
      if (texto === "r" || texto === "tr" || texto.includes("residual")) return "TR";
      return String(value).trim();
    };

    cuotas = cuotas
      .map((cuota) => {
        const estadoBase = cuota.estadoOriginal || cuota.estado || "A cuota";
        const estadoFinal = cuota.pagos?.length > 0 ? "A cuota" : estadoBase;
        const pagadoReal = sumar(cuota.pagos);
        const informado = sumar(informadosValidos(cuota));
        return {
          ...cuota,
          estado: estadoFinal,
          pagadoReal,
          informado,
          cobradoTotal: pagadoReal + informado,
        };
      })
      .filter((cuota) => !estado || cuota.estado === estado);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "COBRINA";
    workbook.created = new Date();

    const info = workbook.addWorksheet("Información");
    const partesFecha = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const valoresFecha = Object.fromEntries(partesFecha.map((parte) => [parte.type, parte.value]));
    const mesesArchivo = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    const mesArchivo = mesesArchivo[Number(valoresFecha.month) - 1];
    const fechaArchivo = `${valoresFecha.day}-${mesArchivo}-${valoresFecha.year}`;
    const fechaVisible = `${valoresFecha.day}/${mesArchivo}/${valoresFecha.year}`;

    const filtrosAplicados = [
      nombre ? `Nombre: ${nombre}` : "",
      dni ? `DNI: ${dni}` : "",
      estado ? `Estado: ${estado}` : "",
      diaDesde || diaHasta ? `Vencimiento: día ${diaDesde || 1} al ${diaHasta || 31}` : "",
      entidad ? "Entidad seleccionada" : "",
      subCesion ? "Subcesión seleccionada" : "",
      usuarioId ? "Operador seleccionado" : "",
      conPagosNoVistos === "true" ? "Pagos informados no vistos" : "",
    ].filter(Boolean);

    info.addRow(["Exportación del Colchón de Cuotas"]);
    info.addRow(["Fecha", fechaVisible]);
    info.addRow(["Registros exportados", cuotas.length]);
    info.addRow(["Filtros", filtrosAplicados.length ? filtrosAplicados.join(" · ") : "Sin filtros"]);
    info.getColumn(1).width = 24;
    info.getColumn(2).width = 90;
    info.getRow(1).font = { bold: true, color: { argb: "FF29154F" }, size: 14 };

    const worksheet = workbook.addWorksheet("Colchón");
    worksheet.columns = [
      { header: "Estado", key: "estado", width: 15 },
      { header: "Entidad", key: "entidad", width: 28 },
      { header: "Subcesión", key: "subCesion", width: 24 },
      { header: "DNI", key: "dni", width: 14 },
      { header: "Nombre y apellido", key: "nombre", width: 30 },
      { header: "Operador", key: "operador", width: 20 },
      { header: "Turno", key: "turno", width: 9 },
      { header: "Vencimiento", key: "vencimiento", width: 12 },
      { header: "C/Cuotas", key: "cuotaNumero", width: 11 },
      { header: "$ C/Cuota", key: "importeCuota", width: 15 },
      { header: "$ Pagado real", key: "pagadoReal", width: 16 },
      { header: "$ Informado", key: "informado", width: 16 },
      { header: "$ Cobrado total", key: "cobradoTotal", width: 17 },
      { header: "$ Debe", key: "saldoPendiente", width: 16 },
      { header: "Teléfono", key: "telefono", width: 20 },
      { header: "Observaciones", key: "observaciones", width: 35 },
      { header: "Observaciones operador", key: "observacionesOperador", width: 35 },
    ];

    cuotas.forEach((cuota) => {
      worksheet.addRow({
        estado: cuota.estado,
        entidad: cuota.entidadId
          ? `${cuota.entidadId.numero ?? ""} - ${cuota.entidadId.nombre ?? ""}`.replace(/^ - | - $/g, "")
          : "—",
        subCesion: cuota.subCesionId?.nombre || "—",
        dni: cuota.dni,
        nombre: cuota.nombre,
        operador: cuota.empleadoId?.username || "—",
        turno: abreviarTurno(cuota.turno),
        vencimiento: cuota.vencimiento || "",
        cuotaNumero: cuota.cuotaNumero || 0,
        importeCuota: Number(cuota.importeCuota || 0),
        pagadoReal: Number(cuota.pagadoReal || 0),
        informado: Number(cuota.informado || 0),
        cobradoTotal: Number(cuota.cobradoTotal || 0),
        saldoPendiente: Number(cuota.saldoPendiente || 0),
        telefono: cuota.telefono || "",
        observaciones: cuota.observaciones || "",
        observacionesOperador: cuota.observacionesOperador || "",
      });
    });

    const header = worksheet.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF29154F" } };
    header.alignment = { vertical: "middle", horizontal: "center" };
    header.height = 24;
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    worksheet.autoFilter = { from: "A1", to: "Q1" };
    ["J", "K", "L", "M", "N"].forEach((columna) => {
      worksheet.getColumn(columna).numFmt = '$#,##0.00;[Red]-$#,##0.00';
    });
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        row.alignment = { vertical: "top", wrapText: true };
        if (rowNumber % 2 === 0) {
          row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9F5FC" } };
        }
      }
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="colchon-${fechaArchivo}.xlsx"`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("❌ Error al exportar Excel:", error);
    res.status(500).json({ error: "Error al exportar Excel" });
  }
};

// Obtener carteras únicas
export const obtenerCarterasUnicas = async (req, res) => {
  try {
    const carteras = await Cartera.find()
      .select("_id nombre")
      .sort({ nombre: 1 });
    res.json(carteras);
  } catch (error) {
    console.error("❌ Error al obtener carteras:", error);
    res.status(500).json({ error: "Error al obtener carteras" });
  }
};

export const agregarPago = async (req, res) => {
  try {
    const { id } = req.params;
    const { monto, fecha } = req.body;

    const montoNum = Number(monto);
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      return res.status(400).json({ error: "Monto inválido (debe ser > 0)." });
    }

    const fechaObj = new Date(fecha);
    if (isNaN(fechaObj.getTime())) {
      return res.status(400).json({ error: "Fecha inválida." });
    }

    const cuota = await Colchon.findById(id);
    if (!cuota) return res.status(404).json({ error: "Cuota no encontrada" });

    // 💸 Pago real
    cuota.pagos.push({
      monto: montoNum,
      fecha: fechaObj,
      origen: "manual",
      registradoPor: req.user.id,
    });

    // 🔄 Recalcular respetando el estado base
    const estadoBase = cuota.estadoOriginal || cuota.estado || "A cuota";
    cuota.estado = estadoBase;
    actualizarDeudaPorMes(cuota);

    // saldo
    cuota.saldoPendiente = (cuota.deudaPorMes || []).reduce(
      (acc, d) => acc + (Number(d.montoAdeudado) || 0),
      0
    );

    // visible: si hay pagos reales, queda "A cuota"
    cuota.estado = "A cuota";

    // 🟨 Amarillo sólo si > 1 cuota adeudada (inline, sin helpers)
    const cuotasAdeudadas =
      Array.isArray(cuota.deudaPorMes) && cuota.deudaPorMes.length
        ? cuota.deudaPorMes.filter((m) => Number(m.montoAdeudado || 0) > 0)
            .length
        : (() => {
            const imp = Number(cuota.importeCuota) || 0;
            return imp > 0
              ? Math.floor(Number(cuota.saldoPendiente || 0) / imp)
              : 0;
          })();
    cuota.alertaDeuda = cuotasAdeudadas > 1;

    cuota.ultimaModificacion = new Date();
    await cuota.save();

    await cuota.populate([
      { path: "empleadoId", select: "username _id" },
      { path: "entidadId", select: "nombre _id" },
      { path: "subCesionId", select: "nombre _id" },
      { path: "pagosInformados.operadorId", select: "username _id" },
    ]);

    res.json({ mensaje: "Pago agregado correctamente", cuota });
  } catch (error) {
    console.error("❌ Error al agregar pago:", error);
    res.status(500).json({ error: "Error al agregar pago" });
  }
};

export const informarPago = async (req, res) => {
  try {
    const { id } = req.params;
    let { monto, fecha } = req.body;

    const montoNum = Number(monto);
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      return res.status(400).json({ error: "Monto inválido (debe ser > 0)." });
    }

    const fechaObj = new Date(fecha);
    if (isNaN(fechaObj.getTime())) {
      return res.status(400).json({ error: "Fecha inválida." });
    }

    const rol = req.user.role || req.user.rol;
    const userId = req.user.id;

    const cuota = await Colchon.findById(id);
    if (!cuota) return res.status(404).json({ error: "Cuota no encontrada" });

    if (rol === "super-admin") {
      // 💸 Impacto real
      cuota.pagos.push({
        monto: montoNum,
        fecha: fechaObj,
        origen: "manual",
        registradoPor: req.user.id,
      });

      const estadoBase = cuota.estadoOriginal || cuota.estado || "A cuota";
      cuota.estado = estadoBase;
      actualizarDeudaPorMes(cuota);

      cuota.saldoPendiente = (cuota.deudaPorMes || []).reduce(
        (acc, d) => acc + (Number(d.montoAdeudado) || 0),
        0
      );

      // visible: con pagos → "A cuota"
      cuota.estado = "A cuota";

      // 🟨 sólo si >1 cuota adeudada
      const cuotasAdeudadas =
        Array.isArray(cuota.deudaPorMes) && cuota.deudaPorMes.length
          ? cuota.deudaPorMes.filter((m) => Number(m.montoAdeudado || 0) > 0)
              .length
          : (() => {
              const imp = Number(cuota.importeCuota) || 0;
              return imp > 0
                ? Math.floor(Number(cuota.saldoPendiente || 0) / imp)
                : 0;
            })();
      cuota.alertaDeuda = cuotasAdeudadas > 1;
    } else if (rol === "operador" || rol === "operador-vip") {
      // 📝 Sólo informativo
      cuota.pagosInformados.push({
        monto: montoNum,
        fecha: fechaObj,
        visto: false,
        erroneo: false,
        operadorId: userId,
      });
    } else {
      return res.status(403).json({ error: "No autorizado" });
    }

    cuota.ultimaModificacion = new Date();
    await cuota.save();

    await cuota.populate("pagosInformados.operadorId", "username _id");

    res.json({ mensaje: "Pago informado correctamente", cuota });
  } catch (error) {
    console.error("❌ Error al informar pago:", error);
    res.status(500).json({ error: "Error al informar pago" });
  }
};

export const marcarPagoInformadoComoVisto = async (req, res) => {
  try {
    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { id, pagoId } = req.params;
    const cuota = await Colchon.findById(id);
    if (!cuota) return res.status(404).json({ error: "Cuota no encontrada" });

    const pagoInformado = cuota.pagosInformados.id(pagoId);
    if (!pagoInformado) {
      return res.status(404).json({ error: "Pago informado no encontrado" });
    }

    pagoInformado.visto = true;
    cuota.ultimaModificacion = new Date();

    const estadoBase = cuota.estadoOriginal || cuota.estado || "A cuota";
    cuota.estado = estadoBase;
    actualizarDeudaPorMes(cuota);

    cuota.saldoPendiente = (cuota.deudaPorMes || []).reduce(
      (acc, d) => acc + (d.montoAdeudado || 0),
      0
    );

    if (cuota.pagos?.length > 0) {
      cuota.estado = "A cuota";
    } else {
      cuota.estado = estadoBase;
    }

    const cuotasAdeudadas =
      Array.isArray(cuota.deudaPorMes) && cuota.deudaPorMes.length
        ? cuota.deudaPorMes.filter((m) => Number(m.montoAdeudado || 0) > 0)
            .length
        : (() => {
            const imp = Number(cuota.importeCuota) || 0;
            return imp > 0
              ? Math.floor(Number(cuota.saldoPendiente || 0) / imp)
              : 0;
          })();
    cuota.alertaDeuda = cuotasAdeudadas > 1;

    await cuota.save();

    res.json({ message: "Pago marcado como visto correctamente." });
  } catch (error) {
    console.error("❌ Error al marcar pago informado como visto:", error);
    res.status(500).json({ error: "Error al confirmar pago informado" });
  }
};

// ➕ Incluye subCesionId (y nombre) para dar contexto al admin
export const obtenerPagosInformadosPendientes = async (req, res) => {
  try {
    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

    // Cuotas que tengan al menos un pago informado NO visto
    const cuotasConPagosPendientes = await Colchon.find({
      "pagosInformados.visto": false,
    })
      .populate("pagosInformados.operadorId", "username _id") // Operador que informó
      .populate("entidadId", "numero nombre") // ➕ Trae número y nombre de la entidad
      .populate("subCesionId", "nombre") // ➕ Trae nombre de la subcesión/cartera
      .select("dni nombre entidadId subCesionId pagosInformados")
      .lean();

    // Mapear solo los pagos no vistos y agregar contexto de entidad + subcesión
    const resultados = cuotasConPagosPendientes.map((cuota) => {
      const pagosPendientes = (cuota.pagosInformados || []).filter(
        (p) => !p.visto
      );

      return {
        cuotaId: cuota._id,
        dni: cuota.dni,
        nombre: cuota.nombre,
        entidad: cuota.entidadId
          ? {
              id: cuota.entidadId._id,
              numero: cuota.entidadId.numero,
              nombre: cuota.entidadId.nombre,
            }
          : null,
        subCesion: cuota.subCesionId
          ? {
              id: cuota.subCesionId._id,
              nombre: cuota.subCesionId.nombre,
            }
          : null,
        pagosPendientes: pagosPendientes.map((p) => ({
          pagoId: p._id,
          fecha: p.fecha,
          monto: p.monto,
          erroneo: p.erroneo,
          operador: p.operadorId
            ? { id: p.operadorId._id, username: p.operadorId.username }
            : null,
        })),
      };
    });

    res.json(resultados);
  } catch (error) {
    console.error("❌ Error al obtener pagos informados pendientes:", error);
    res
      .status(500)
      .json({ error: "Error al obtener pagos informados pendientes" });
  }
};

// 🔁 Actualiza deudaPorMes y saldoPendiente respetando estadoOriginal
export const actualizarDeudaPorMes = (cuota) => {
  const hoy = new Date();
  const importe = Number(cuota.importeCuota || 0);

  const mesesSegunEstado = {
    "Cuota 30": 2,
    "Cuota 60": 3,
    "Cuota 90": 4,
    Caída: 5,
  };

  const estadoBase = cuota.estadoOriginal || cuota.estado;
  const cantidadMeses = mesesSegunEstado[estadoBase] || 1;

  // construir la cola de deuda (de la más vieja a la más nueva)
  const deudaPorMes = [];
  for (let i = cantidadMeses - 1; i >= 0; i--) {
    const f = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    deudaPorMes.push({
      mes: String(f.getMonth() + 1),
      anio: f.getFullYear(),
      montoAdeudado: importe,
    });
  }

  // descontar pagos desde la más vieja
  let totalPagado = (cuota.pagos || []).reduce(
    (acc, p) => acc + Number(p.monto || 0),
    0
  );

  for (let i = 0; i < deudaPorMes.length && totalPagado > 0; i++) {
    const aPagar = Math.min(deudaPorMes[i].montoAdeudado, totalPagado);
    deudaPorMes[i].montoAdeudado = Number(
      (deudaPorMes[i].montoAdeudado - aPagar).toFixed(2)
    );
    totalPagado -= aPagar;
  }

  cuota.deudaPorMes = deudaPorMes;
  cuota.saldoPendiente = Number(
    deudaPorMes
      .reduce((acc, d) => acc + Number(d.montoAdeudado || 0), 0)
      .toFixed(2)
  );

  return cuota;
};

// ✅ Marcar/desmarcar pago informado como erróneo
export const marcarPagoComoErroneo = async (req, res) => {
  const { id, pagoId } = req.params;

  try {
    const colchon = await Colchon.findById(id);
    if (!colchon) return res.status(404).json({ error: "Cuota no encontrada" });

    const pago = colchon.pagosInformados.id(pagoId);
    if (!pago)
      return res.status(404).json({ error: "Pago informado no encontrado" });

    // Solo el operador que lo informó puede marcarlo como erróneo
    if (esOperativo(req) && pago.operadorId.toString() !== req.user.id) {
      return res.status(403).json({ error: "No autorizado" });
    }

    pago.erroneo = !pago.erroneo;
    colchon.ultimaModificacion = new Date();
    await colchon.save();

    res.json({ ok: true, erroneo: pago.erroneo });
  } catch (error) {
    console.error("❌ Error al marcar pago como erróneo:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
};

// ✅ Marcar pago informado como visto
export const marcarPagoComoVisto = async (req, res) => {
  const { id, pagoId } = req.params;

  try {
    const colchon = await Colchon.findById(id);
    if (!colchon) return res.status(404).json({ error: "Cuota no encontrada" });

    const pago = colchon.pagosInformados.id(pagoId);
    if (!pago)
      return res.status(404).json({ error: "Pago informado no encontrado" });

    // Solo  super-admin puede marcar como visto
    if (!["super-admin"].includes(req.user.role || req.user.rol)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    // ✅ Marcar como visto
    pago.visto = true;
    colchon.ultimaModificacion = new Date();

    // ✅ Recalcular estado visual completo
    const estadoBase = colchon.estadoOriginal || colchon.estado;
    colchon.estado = estadoBase;

    actualizarDeudaPorMes(colchon);

    colchon.saldoPendiente = colchon.deudaPorMes.reduce(
      (acc, d) => acc + (d.montoAdeudado || 0),
      0
    );

    if (colchon.pagos?.length > 0) {
      colchon.estado = "A cuota";
    } else {
      colchon.estado = estadoBase;
    }

    colchon.alertaDeuda =
      colchon.estado === "A cuota" && colchon.saldoPendiente > 0;

    await colchon.save();

    res.json({ ok: true });
  } catch (error) {
    console.error("❌ Error al marcar pago como visto:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
};

export const eliminarPagoInformado = async (req, res) => {
  const { id, pagoId } = req.params;

  try {
    const colchon = await Colchon.findById(id);
    if (!colchon) return res.status(404).json({ error: "Cuota no encontrada" });

    const pago = colchon.pagosInformados.id(pagoId);
    if (!pago)
      return res.status(404).json({ error: "Pago informado no encontrado" });

    // Solo el operador que lo informó y que NO fue visto
    if (
      !esSuper(req) &&
      (!esOperativo(req) ||
        pago.operadorId.toString() !== req.user.id ||
        pago.visto)
    ) {
      return res.status(403).json({ error: "No autorizado para eliminar" });
    }

    // ✅ CORRECTO: usar pull() para eliminar el subdocumento
    colchon.pagosInformados.pull({ _id: pagoId });

    colchon.ultimaModificacion = new Date();
    await colchon.save();

    res.json({ ok: true });
  } catch (error) {
    console.error("❌ Error al eliminar pago informado:", error);
    res.status(500).json({ error: "Error interno al eliminar pago" });
  }
};

export const eliminarPagoReal = async (req, res) => {
  const { cuotaId, pagoId } = req.params;

  try {
    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

    const cuota = await Colchon.findById(cuotaId);
    if (!cuota) return res.status(404).json({ error: "Cuota no encontrada" });

    const index = cuota.pagos.findIndex((p) => p._id.toString() === pagoId);
    if (index === -1) {
      return res.status(404).json({ error: "Pago no encontrado" });
    }

    cuota.pagos.splice(index, 1);
    cuota.ultimaModificacion = new Date();

    const estadoBase = cuota.estadoOriginal || cuota.estado || "A cuota";
    cuota.estado = estadoBase;
    actualizarDeudaPorMes(cuota);

    cuota.saldoPendiente = (cuota.deudaPorMes || []).reduce(
      (acc, d) => acc + (d.montoAdeudado || 0),
      0
    );

    if (cuota.pagos.length > 0) {
      cuota.estado = "A cuota";
    } else {
      cuota.estado = estadoBase;
    }

    const imp = Number(cuota.importeCuota) || 0;
    const cuotasAdeudadas =
      Array.isArray(cuota.deudaPorMes) && cuota.deudaPorMes.length
        ? cuota.deudaPorMes.filter((m) => Number(m.montoAdeudado || 0) > 0)
            .length
        : imp > 0
        ? Math.floor(Number(cuota.saldoPendiente || 0) / imp)
        : 0;
    cuota.alertaDeuda = cuotasAdeudadas > 1;

    await cuota.save();

    res.json({ message: "Pago eliminado correctamente", cuota });
  } catch (error) {
    console.error("❌ Error al eliminar pago real:", error);
    res.status(500).json({ error: "Error al eliminar pago real" });
  }
};

export const descargarModeloColchon = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Modelo Colchón");

    // ✅ Encabezados esperados
    worksheet.columns = [
      { header: "ESTADO", key: "estado", width: 15 },
      { header: "ENTIDAD", key: "entidad", width: 10 },
      { header: "DNI", key: "dni", width: 15 },
      { header: "NOMBRE Y APELLIDO", key: "nombre", width: 25 },
      { header: "OPERADOR", key: "operador", width: 20 },
      { header: "TURNO", key: "turno", width: 10 },
      { header: "SUBCESIÓN", key: "cartera", width: 20 },
      { header: "VTO CUO", key: "vencimiento", width: 12 },
      { header: "C/CUOTAS", key: "cuotas", width: 12 },
      { header: "$CUOTA", key: "cuota", width: 12 },
      { header: "TELÉFONO", key: "telefono", width: 20 }, // ✅ Nuevo campo
    ];

    // ✅ Fila ejemplo opcional (podés comentarla si no querés que venga llena)
    worksheet.addRow({
      estado: "A cuota ó Cuota 30",
      entidad: "1",
      dni: "30123456",
      nombre: "JUAN PÉREZ",
      operador: "jsuarez",
      turno: "M-T-R",
      cartera: "FRAVEGA",
      vencimiento: 10,
      cuotas: 1,
      cuota: 15000,
      telefono: "1123456789",
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=modelo-colchon.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("❌ Error al generar modelo de colchón:", err);
    res.status(500).send("Error al descargar el modelo.");
  }
};

export const limpiarCuota = async (req, res) => {
  try {
    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin") {
      return res
        .status(403)
        .json({ error: "No autorizado para limpiar cuotas" });
    }

    const { id } = req.params;
    const tipo = String(
      req.query.tipo || req.body?.tipo || "todo"
    ).toLowerCase();

    const cuota = await Colchon.findById(id);
    if (!cuota) return res.status(404).json({ error: "Cuota no encontrada" });

    const estadoBase = cuota.estadoOriginal || cuota.estado;

    if (tipo === "pagos" || tipo === "todo") {
      cuota.pagos = [];
      cuota.pagosInformados = [];

      cuota.estado = estadoBase;
      actualizarDeudaPorMes(cuota);

      cuota.saldoPendiente = (cuota.deudaPorMes || []).reduce(
        (acc, d) => acc + (d.montoAdeudado || 0),
        0
      );

      // visible: sin pagos → vuelve a base
      cuota.estado = estadoBase;

      const imp = Number(cuota.importeCuota) || 0;
      const cuotasAdeudadas =
        Array.isArray(cuota.deudaPorMes) && cuota.deudaPorMes.length
          ? cuota.deudaPorMes.filter((m) => Number(m.montoAdeudado || 0) > 0)
              .length
          : imp > 0
          ? Math.floor(Number(cuota.saldoPendiente || 0) / imp)
          : 0;
      cuota.alertaDeuda = cuotasAdeudadas > 1;
    }

    if (tipo === "observaciones" || tipo === "todo") {
      cuota.observaciones = "";
      cuota.observacionesOperador = "";
    }

    cuota.ultimaModificacion = new Date();
    await cuota.save();

    res.json({
      ok: true,
      message:
        tipo === "pagos"
          ? "Pagos limpiados"
          : tipo === "observaciones"
          ? "Observaciones limpiadas"
          : "Pagos y observaciones limpiados",
    });
  } catch (error) {
    console.error("❌ Error al limpiar cuota:", error);
    res.status(500).json({ error: "Error al limpiar cuota" });
  }
};

export const importarPagosDesdeExcel = async (req, res) => {
  try {
    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No se recibió archivo" });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];

    // ⬅️ Encabezados esperados
    const encabezadosEsperados = [
      "dni",
      "entidad",
      "subcesion",
      "monto",
      "fecha",
    ];
    const encabezadosArchivo = worksheet
      .getRow(1)
      .values.slice(1)
      .map((v) => String(v).trim().toLowerCase());

    const encabezadosOk = encabezadosEsperados.every(
      (e, i) => e === encabezadosArchivo[i]
    );
    if (!encabezadosOk) {
      return res.status(400).json({
        error:
          "Encabezados incorrectos. Se esperan: dni, entidad, subcesion, monto, fecha",
      });
    }

    // ——— Helpers para fechas ———
    // Convierte un Date (posiblemente en UTC) a medianoche local del mismo día calendario
    const aMedianocheLocal = (d) =>
      new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);

    // Parse flexible: Date | "dd/mm/yyyy" | "yyyy-mm-dd" | ISO → Date (00:00 local)
    const parseFechaLocalFlexible = (valor) => {
      if (valor instanceof Date) {
        return aMedianocheLocal(valor);
      }
      if (typeof valor === "string") {
        const s = valor.trim();
        let dd, mm, yyyy, m;

        if ((m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/))) {
          [, dd, mm, yyyy] = m;
          return new Date(+yyyy, +mm - 1, +dd, 0, 0, 0);
        }
        if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
          [, yyyy, mm, dd] = m;
          return new Date(+yyyy, +mm - 1, +dd, 0, 0, 0);
        }

        // Último intento: que el motor la entienda; luego la pasamos a 00:00 local
        const d = new Date(s);
        if (!isNaN(d.getTime())) {
          return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
        }
      }
      return null;
    };

    // Compara solo la parte de fecha (UTC yyyy-mm-dd)
    const ymdUTC = (d) =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(
        2,
        "0"
      )}-${String(d.getUTCDate()).padStart(2, "0")}`;

    const resultados = {
      procesados: 0,
      agregados: 0,
      duplicados: 0,
      errores: [],
    };

    const erroresExcel = [];
    const subCesionesCache = {};

    // Cache de subcesiones para acelerar búsquedas/creación
    const subcesiones = await SubCesion.find();
    subcesiones.forEach((s) => (subCesionesCache[s.nombre.toUpperCase()] = s));

    for (let i = 2; i <= worksheet.rowCount; i++) {
      const row = worksheet.getRow(i);

      try {
        const dni = parseInt(row.getCell(1).value);
        const entidadNumero = parseInt(row.getCell(2).value);
        const subCesionNombre = (row.getCell(3).value || "").toString().trim();
        const monto = parseFloat(row.getCell(4).value);
        const fechaPago = parseFechaLocalFlexible(row.getCell(5).value);

        // ⛔ Validaciones obligatorias
        if (
          !dni ||
          !entidadNumero ||
          !subCesionNombre ||
          !fechaPago ||
          !monto ||
          isNaN(fechaPago.getTime())
        ) {
          erroresExcel.push({
            dni,
            entidad: entidadNumero,
            subcesion: subCesionNombre,
            monto,
            fecha: row.getCell(5).value,
            motivo: "Datos incompletos o inválidos (incluye SUBCESIÓN/fecha)",
          });
          resultados.errores.push({ fila: i, motivo: "Datos incompletos" });
          continue;
        }

        // 🔍 Buscar la entidad
        const entidad = await Entidad.findOne({ numero: entidadNumero });
        if (!entidad) {
          erroresExcel.push({
            dni,
            entidad: entidadNumero,
            subcesion: subCesionNombre,
            monto,
            fecha: row.getCell(5).value,
            motivo: `Entidad ${entidadNumero} no existe`,
          });
          resultados.errores.push({ fila: i, motivo: "Entidad inexistente" });
          continue;
        }

        // 🔍 Resolver/crear SubCesión
        let subCesion = subCesionesCache[subCesionNombre.toUpperCase()];
        if (!subCesion) {
          subCesion = await SubCesion.create({
            nombre: subCesionNombre.toUpperCase(),
          });
          subCesionesCache[subCesionNombre.toUpperCase()] = subCesion;
        }

        // 🔑 Clave lógica: DNI + ENTIDAD + SUBCESIÓN
        const idCuotaLogico = `${dni}-${entidad._id}-${subCesion._id}`;
        const cuota = await Colchon.findOne({ idCuotaLogico });

        if (!cuota) {
          erroresExcel.push({
            dni,
            entidad: entidadNumero,
            subcesion: subCesionNombre,
            monto,
            fecha: row.getCell(5).value,
            motivo: "Cuota no encontrada para ese DNI + ENTIDAD + SUBCESIÓN",
          });
          resultados.errores.push({ fila: i, motivo: "Cuota no encontrada" });
          continue;
        }

        // 🛑 Duplicado si existe MISMO día (UTC y-m-d) + MISMO monto
        const fechaKey = ymdUTC(fechaPago);
        const yaExiste = (cuota.pagos || []).some((p) => {
          const pf = new Date(p.fecha);
          return ymdUTC(pf) === fechaKey && Number(p.monto) === Number(monto);
        });

        if (yaExiste) {
          erroresExcel.push({
            dni,
            entidad: entidadNumero,
            subcesion: subCesionNombre,
            monto,
            fecha: row.getCell(5).value,
            motivo: "Pago duplicado",
          });
          resultados.duplicados++;
        } else {
          // 💰 Agregar pago nuevo (fecha en 00:00 local)
          cuota.pagos.push({
            fecha: fechaPago,
            monto,
            origen: "importado",
            registradoPor: req.user.id,
          });

          // ✅ Actualizar deuda y estado
          const estadoBase = cuota.estadoOriginal || cuota.estado;
          cuota.estado = estadoBase;

          actualizarDeudaPorMes(cuota);
          cuota.saldoPendiente = cuota.deudaPorMes.reduce(
            (acc, d) => acc + (d.montoAdeudado || 0),
            0
          );

          cuota.estado = "A cuota";
          cuota.alertaDeuda =
            cuota.estado === "A cuota" && cuota.saldoPendiente > 0;

          cuota.ultimaModificacion = new Date();
          await cuota.save();

          resultados.agregados++;
        }

        resultados.procesados++;
      } catch (filaError) {
        erroresExcel.push({
          dni: "",
          entidad: "",
          subcesion: "",
          monto: "",
          fecha: "",
          motivo: filaError.message || "Error inesperado",
        });
        resultados.errores.push({ fila: i, motivo: filaError.message });
      }
    }

    // 📦 Si hubo errores/duplicados → devolver Excel
    if (erroresExcel.length > 0) {
      const erroresWb = new ExcelJS.Workbook();
      const erroresWs = erroresWb.addWorksheet("Pagos con errores");

      erroresWs.columns = [
        { header: "dni", key: "dni", width: 15 },
        { header: "entidad", key: "entidad", width: 10 },
        { header: "subcesion", key: "subcesion", width: 20 },
        { header: "monto", key: "monto", width: 12 },
        { header: "fecha", key: "fecha", width: 15 },
        { header: "motivo", key: "motivo", width: 40 },
      ];

      erroresExcel.forEach((err) => erroresWs.addRow(err));

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=pagos-con-errores.xlsx"
      );

      await erroresWb.xlsx.write(res);
      res.end();
    } else {
      res.json(resultados);
    }
  } catch (error) {
    console.error("❌ Error al importar pagos:", error);
    res.status(500).json({ error: "Error al procesar archivo Excel" });
  }
};

// Descargar modelo de pagos para importar (incluye subcesión)
export const descargarModeloPagos = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("ModeloPagos");

    // ⬅️ Ahora se requiere SUBCESIÓN entre entidad y monto
    worksheet.columns = [
      { header: "dni", key: "dni", width: 20 },
      { header: "entidad", key: "entidad", width: 15 }, // número de entidad (ej: 1)
      { header: "subcesion", key: "subcesion", width: 25 }, // nombre de la subcesión/cartera (ej: FRAVEGA)
      { header: "monto", key: "monto", width: 15 },
      { header: "fecha", key: "fecha", width: 15 }, // dd/mm/yyyy
    ];

    // Fila de ejemplo
    worksheet.addRow({
      dni: "30123456",
      entidad: "1",
      subcesion: "FRAVEGA", // ↩️ obligatorio y case-insensitive en la importación
      monto: 1000,
      fecha: "01/07/2025",
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=modelo-pagos.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("❌ Error al generar modelo de pagos:", error);
    res.status(500).json({ error: "Error al generar modelo de pagos" });
  }
};

// 📤 Exportar todos los pagos a Excel (incluye subcesión)
export const exportarPagos = async (req, res) => {
  try {
    const rol = req.user.role || req.user.rol;
    const usuarioId = req.user.id;

    // Si es operador, solo ve sus cuotas
    const filtro = { "pagos.0": { $exists: true } }; // hay al menos 1 pago

    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso a exportación" });
    }
    if (esOperativo(req)) {
      filtro["empleadoId"] = usuarioId;
    }

    // 📌 Ahora populamos también subCesionId para mostrarla
    const cuotas = await Colchon.find(filtro)
      .populate("entidadId", "nombre numero") // ✅ trae número y nombre de entidad
      .populate("subCesionId", "nombre") // ✅ trae nombre de la subcesión/cartera
      .lean();

    const pagosExportar = [];

    cuotas.forEach((cuota) => {
      const dni = cuota.dni || "";
      const entidad = cuota.entidadId?.numero || "—";
      const subcesion = cuota.subCesionId?.nombre || "—"; // ⬅️ subcesión

      cuota.pagos.forEach((pago) => {
        pagosExportar.push({
          dni,
          entidad,
          subcesion,
          monto: pago.monto,
          fecha: pago.fecha ? formatearFecha(pago.fecha) : "",
        });
      });
    });

    // Importamos ExcelJS correctamente
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Pagos");

    // ⬅️ Nueva columna SUBCESIÓN
    worksheet.columns = [
      { header: "dni", key: "dni", width: 15 },
      { header: "entidad", key: "entidad", width: 15 },
      { header: "subcesion", key: "subcesion", width: 20 },
      { header: "monto", key: "monto", width: 12 },
      { header: "fecha", key: "fecha", width: 15 },
    ];

    pagosExportar.forEach((fila) => worksheet.addRow(fila));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=pagos-exportados.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("❌ Error al exportar pagos:", error);
    res.status(500).json({ error: "Error al exportar pagos" });
  }
};

// Eliminar todas las cuotas del colchón
export const eliminarTodasLasCuotas = async (req, res) => {
  try {
    if (!esSuper(req)) return res.status(403).json({ error: "No autorizado" });
    await Colchon.deleteMany({});
    res.json({ mensaje: "Todas las cuotas fueron eliminadas correctamente" });
  } catch (error) {
    console.error("Error al eliminar todas las cuotas:", error);
    res.status(500).json({ error: "Error al eliminar las cuotas" });
  }
};

export const vaciarColchon = async (req, res) => {
  try {
    await Colchon.deleteMany({});
    res.json({ mensaje: "Colchón vaciado correctamente" });
  } catch (error) {
    console.error("❌ Error al vaciar el colchón:", error);
    res.status(500).json({ error: "Error al vaciar el colchón" });
  }
};

export const obtenerEstadisticasColchon = async (req, res) => {
  try {
    const {
      dni,
      nombre,
      entidad,
      subCesion,
      estado,
      usuarioId,
      diaDesde,
      diaHasta,
      conPagosNoVistos,
    } = req.query;

    const filtrosBase = [];

    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso a estadísticas" });
    }
    if (!esSuper(req)) {
      filtrosBase.push({ empleadoId: req.user.id });
    } else if (usuarioId) {
      filtrosBase.push({ empleadoId: usuarioId });
    }

    if (dni) {
      const dniParsed = parseInt(dni, 10);
      if (!Number.isNaN(dniParsed)) filtrosBase.push({ dni: dniParsed });
    }

    if (nombre) {
      const nombreSeguro = String(nombre)
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (nombreSeguro) filtrosBase.push({ nombre: new RegExp(nombreSeguro, "i") });
    }

    if (entidad && mongoose.Types.ObjectId.isValid(entidad)) {
      filtrosBase.push({ entidadId: entidad });
    }
    if (subCesion && mongoose.Types.ObjectId.isValid(subCesion)) {
      filtrosBase.push({ subCesionId: subCesion });
    }

    if (diaDesde !== undefined || diaHasta !== undefined) {
      const desde = Math.max(1, Math.min(parseInt(diaDesde || 1, 10), 31));
      const hasta = Math.max(1, Math.min(parseInt(diaHasta || 31, 10), 31));
      if (desde <= hasta) filtrosBase.push({ vencimiento: { $gte: desde, $lte: hasta } });
    }

    if (conPagosNoVistos === "true") {
      filtrosBase.push({ "pagosInformados.visto": false });
    }

    const baseQuery = filtrosBase.length ? { $and: filtrosBase } : {};

    const cuotasBrutas = await Colchon.find(baseQuery)
      .populate("empleadoId", "username")
      .populate("entidadId", "nombre numero")
      .populate("subCesionId", "nombre")
      .populate("pagosInformados.operadorId", "username")
      .lean();

    const partesHoyArgentina = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const hoyArgentina = Object.fromEntries(
      partesHoyArgentina.map((parte) => [parte.type, parte.value])
    );
    const mesActual = Number(hoyArgentina.month) - 1;
    const anioActual = Number(hoyArgentina.year);
    const diaActual = Number(hoyArgentina.day);

    const sumar = (lista) =>
      (Array.isArray(lista) ? lista : []).reduce(
        (total, item) => total + Number(item?.monto || 0),
        0
      );

    // En la cuotera hay dos conceptos distintos:
    // - pagos[]: dinero que la cuotera/super-admin confirmó y cargó en la cuota.
    // - pagosInformados[]: aviso del operador, todavía pendiente de control.
    // Para las estadísticas sólo se considera dinero confirmado. Dentro de pagos[]
    // distinguimos lo importado por Excel de lo cargado manualmente por la cuotera.
    const clasificarPagosConfirmados = (cuota) => {
      const confirmados = Array.isArray(cuota.pagos) ? cuota.pagos : [];
      const importados = confirmados.filter((pago) => pago?.origen === "importado");
      // Compatibilidad: los pagos históricos no tenían origen; se consideran manuales,
      // que coincide con el uso habitual de RDC (carga de la cuotera desde Colchón).
      const informadosCuotera = confirmados.filter(
        (pago) => pago?.origen !== "importado"
      );
      return { confirmados, importados, informadosCuotera };
    };

    const avisosOperadorValidos = (cuota) =>
      (Array.isArray(cuota.pagosInformados) ? cuota.pagosInformados : []).filter(
        (pago) => !pago?.erroneo
      );

    const esMesActual = (fecha) => {
      const valor = new Date(fecha);
      if (Number.isNaN(valor.getTime())) return false;
      return (
        valor.getUTCMonth() === mesActual &&
        valor.getUTCFullYear() === anioActual
      );
    };

    let totalCuotas = 0;
    let totalImporte = 0;
    let totalSaldo = 0;
    let cuotasConCobros = 0;
    let totalPagadoReal = 0;
    let totalInformado = 0;
    let totalAvisadoOperadores = 0;
    let cantidadAvisosOperadores = 0;
    let saldoNoVencido = 0;
    let saldoVencido = 0;
    let saldoNoVencidoCuotera = 0;
    let saldoVencidoCuotera = 0;
    let cuotasNoVencidas = 0;
    let cuotasVencidas = 0;

    const estadoStats = {};
    const pagosPorDia = {};
    const rankingEntidad = {};
    const rankingCartera = {};
    const rankingOperadoresMes = {};
    const rankingOperadoresAcumulado = {};

    const cuotasFiltradas = cuotasBrutas.map((cuota) => {
      const estadoBase = cuota.estadoOriginal || cuota.estado || "A cuota";
      const estadoFinal = cuota.pagos?.length > 0 ? "A cuota" : estadoBase;
      return { ...cuota, estado: estadoFinal };
    });

    const cuotas = estado
      ? cuotasFiltradas.filter((cuota) => cuota.estado === estado)
      : cuotasFiltradas;

    for (const cuota of cuotas) {
      const importe = Number(cuota.importeCuota || 0);
      const saldo = Number(cuota.saldoPendiente || 0);
      const { confirmados, importados, informadosCuotera } =
        clasificarPagosConfirmados(cuota);
      const avisosOperador = avisosOperadorValidos(cuota);

      const pagadoReal = sumar(importados);
      const informado = sumar(informadosCuotera);
      const cobradoConsiderado = pagadoReal + informado;
      const pagadoRealMes = sumar(importados.filter((pago) => esMesActual(pago.fecha)));
      const informadoMes = sumar(
        informadosCuotera.filter((pago) => esMesActual(pago.fecha))
      );

      totalCuotas += 1;
      totalImporte += importe;
      totalSaldo += saldo;
      totalPagadoReal += pagadoReal;
      totalInformado += informado;
      totalAvisadoOperadores += sumar(avisosOperador);
      cantidadAvisosOperadores += avisosOperador.length;
      if (cobradoConsiderado > 0) cuotasConCobros += 1;

      const vencimiento = Number(cuota.vencimiento || 0);
      if (vencimiento >= diaActual) {
        cuotasNoVencidas += 1;
        saldoNoVencidoCuotera += saldo;
        saldoNoVencido += saldo;
      } else {
        cuotasVencidas += 1;
        saldoVencidoCuotera += saldo;
        saldoVencido += saldo;
      }

      const estadoVisual = cuota.estado || "Desconocido";
      estadoStats[estadoVisual] = (estadoStats[estadoVisual] || 0) + 1;

      for (const pago of confirmados) {
        if (!esMesActual(pago.fecha)) continue;
        const dia = new Date(pago.fecha).getUTCDate();
        if (!pagosPorDia[dia]) {
          pagosPorDia[dia] = {
            cantidadPagos: 0,
            totalPagado: 0,
            real: 0,
            informado: 0,
          };
        }
        const monto = Number(pago.monto || 0);
        pagosPorDia[dia].cantidadPagos += 1;
        pagosPorDia[dia].totalPagado += monto;
        if (pago?.origen === "importado") pagosPorDia[dia].real += monto;
        else pagosPorDia[dia].informado += monto;
      }

      const entidadNom = cuota.entidadId?.nombre || "Sin entidad";
      if (!rankingEntidad[entidadNom]) {
        rankingEntidad[entidadNom] = {
          asignado: 0,
          cobradoReal: 0,
          informado: 0,
          cobrado: 0,
          pagos: 0,
        };
      }
      rankingEntidad[entidadNom].asignado += importe;
      rankingEntidad[entidadNom].cobradoReal += pagadoReal;
      rankingEntidad[entidadNom].informado += informado;
      rankingEntidad[entidadNom].cobrado += cobradoConsiderado;
      rankingEntidad[entidadNom].pagos += confirmados.length;

      const carteraNom = cuota.subCesionId?.nombre || cuota.cartera || "Sin subcesión";
      if (!rankingCartera[carteraNom]) {
        rankingCartera[carteraNom] = {
          asignado: 0,
          cobradoReal: 0,
          informado: 0,
          cobrado: 0,
          pagos: 0,
        };
      }
      rankingCartera[carteraNom].asignado += importe;
      rankingCartera[carteraNom].cobradoReal += pagadoReal;
      rankingCartera[carteraNom].informado += informado;
      rankingCartera[carteraNom].cobrado += cobradoConsiderado;
      rankingCartera[carteraNom].pagos += confirmados.length;

      const sumarAlRankingOperador = (
        ranking,
        nombreOperador,
        pagoImportado,
        pagoInformado
      ) => {
        const nombreOperadorSeguro = nombreOperador || "Sin asignar";
        if (!ranking[nombreOperadorSeguro]) {
          ranking[nombreOperadorSeguro] = {
            total: {
              cantidad: 0,
              asignado: 0,
              pagadoReal: 0,
              informado: 0,
              pagado: 0,
            },
            porEstado: {},
          };
        }
        if (!ranking[nombreOperadorSeguro].porEstado[estadoVisual]) {
          ranking[nombreOperadorSeguro].porEstado[estadoVisual] = {
            cantidad: 0,
            asignado: 0,
            pagadoReal: 0,
            informado: 0,
            pagado: 0,
          };
        }

        const nodoOperador = ranking[nombreOperadorSeguro];
        nodoOperador.total.cantidad += 1;
        nodoOperador.total.asignado += importe;
        nodoOperador.total.pagadoReal += pagoImportado;
        nodoOperador.total.informado += pagoInformado;
        nodoOperador.total.pagado += pagoImportado + pagoInformado;

        const nodoEstado = nodoOperador.porEstado[estadoVisual];
        nodoEstado.cantidad += 1;
        nodoEstado.asignado += importe;
        nodoEstado.pagadoReal += pagoImportado;
        nodoEstado.informado += pagoInformado;
        nodoEstado.pagado += pagoImportado + pagoInformado;
      };

      // La cuotera carga el pago para el caso asignado; por eso el monto se
      // acredita al operador dueño de la cuota, no al usuario administrador.
      // Se devuelven dos vistas: mes actual y acumulado del conjunto filtrado.
      const operadorAsignado = cuota.empleadoId?.username || "Sin asignar";
      sumarAlRankingOperador(
        rankingOperadoresMes,
        operadorAsignado,
        pagadoRealMes,
        informadoMes
      );
      sumarAlRankingOperador(
        rankingOperadoresAcumulado,
        operadorAsignado,
        pagadoReal,
        informado
      );
    }

    const prepararRanking = (objeto, campo) =>
      Object.entries(objeto).map(([nombreItem, valores]) => ({
        [campo]: nombreItem,
        asignado: valores.asignado,
        cobradoReal: valores.cobradoReal,
        informado: valores.informado,
        cobrado: valores.cobrado,
        porcentaje: valores.asignado
          ? Math.round((valores.cobrado / valores.asignado) * 100)
          : 0,
        pagos: valores.pagos,
      }));

    const rankingEntidadArray = prepararRanking(rankingEntidad, "entidad");
    const rankingCarteraArray = prepararRanking(rankingCartera, "cartera");

    const ESTADOS_ORDEN = ["A cuota", "Cuota 30", "Cuota 60", "Cuota 90", "Caída"];
    const prepararRankingOperadores = (ranking) =>
      Object.entries(ranking).map(([operador, valores]) => {
        const totalAsignado = valores.total.asignado || 0;
        const totalPagado = valores.total.pagado || 0;
        const estados = {};

        ESTADOS_ORDEN.forEach((nombreEstado) => {
          const nodo = valores.porEstado[nombreEstado] || {
            cantidad: 0,
            asignado: 0,
            pagadoReal: 0,
            informado: 0,
            pagado: 0,
          };
          estados[nombreEstado] = {
            cantidad: nodo.cantidad || 0,
            asignado: nodo.asignado || 0,
            pagadoReal: nodo.pagadoReal || 0,
            informado: nodo.informado || 0,
            pagado: nodo.pagado || 0,
            porcentaje: nodo.asignado
              ? Math.round((nodo.pagado / nodo.asignado) * 100)
              : 0,
          };
        });

        return {
          operador,
          cantidad: valores.total.cantidad || 0,
          asignado: totalAsignado,
          pagadoReal: valores.total.pagadoReal || 0,
          informado: valores.total.informado || 0,
          pagado: totalPagado,
          porcentaje: totalAsignado
            ? Math.round((totalPagado / totalAsignado) * 100)
            : 0,
          estados,
        };
      });

    const rankingOperadoresMesArray = prepararRankingOperadores(
      rankingOperadoresMes
    );
    const rankingOperadoresAcumuladoArray = prepararRankingOperadores(
      rankingOperadoresAcumulado
    );

    rankingEntidadArray.sort(
      (a, b) => b.porcentaje - a.porcentaje || b.cobrado - a.cobrado
    );
    rankingCarteraArray.sort(
      (a, b) => b.porcentaje - a.porcentaje || b.cobrado - a.cobrado
    );
    rankingOperadoresMesArray.sort(
      (a, b) => b.pagado - a.pagado || b.porcentaje - a.porcentaje
    );
    rankingOperadoresAcumuladoArray.sort(
      (a, b) => b.pagado - a.pagado || b.porcentaje - a.porcentaje
    );

    const totalCobrado = totalPagadoReal + totalInformado;

    return res.json({
      totalCuotas,
      totalImporte,
      totalSaldo,
      porcentajeCobrado: totalImporte
        ? Math.round((totalCobrado / totalImporte) * 100)
        : 0,
      cuotasPagadas: {
        cantidad: cuotasConCobros,
        totalPagado: totalCobrado,
        pagadoReal: totalPagadoReal,
        informado: totalInformado,
      },
      avisosOperadores: {
        cantidad: cantidadAvisosOperadores,
        monto: totalAvisadoOperadores,
      },
      porVencimiento: {
        diaActual,
        cuotasNoVencidas,
        saldoNoVencido,
        saldoNoVencidoCuotera,
        cuotasVencidas,
        saldoVencido,
        saldoVencidoCuotera,
      },
      estadoStats,
      pagosPorDia,
      rankingEntidad: rankingEntidadArray,
      rankingCartera: rankingCarteraArray,
      // Compatibilidad: rankingOperadores queda como vista acumulada.
      rankingOperadores: rankingOperadoresAcumuladoArray,
      rankingOperadoresMes: rankingOperadoresMesArray,
      rankingOperadoresAcumulado: rankingOperadoresAcumuladoArray,
      periodoRanking: { mes: mesActual + 1, anio: anioActual },
    });
  } catch (error) {
    console.error("❌ Error en obtenerEstadisticasColchon:", error);
    return res
      .status(500)
      .json({ error: "Error al obtener estadísticas del colchón" });
  }
};

export const getCuotaPorId = async (req, res) => {
  try {
    const { id } = req.params;

    console.log("🔍 Buscando cuota por ID:", id);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID de cuota inválido" });
    }

    // Probá sin populate por ahora
    const cuota = await Colchon.findById(id)
      .populate("entidadId")
      .populate("empleadoId")
      .populate("subCesionId")
      .populate("pagosInformados.operadorId", "username _id");
    if (!cuota) {
      return res.status(404).json({ error: "Cuota no encontrada" });
    }

    // Autorización de lectura
    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso al módulo Colchón" });
    }
    if (
      esOperativo(req) &&
      String(cuota.empleadoId?._id || cuota.empleadoId) !== String(req.user.id)
    ) {
      return res.status(403).json({ error: "No autorizado" });
    }

    res.json(cuota);
  } catch (error) {
    console.error("❌ Error interno:", error);
    res.status(500).json({ error: "Error al obtener cuota" });
  }
};

export const registrarGestionCuota = async (req, res) => {
  try {
    if (!esSuper(req)) return res.status(403).json({ error: "No autorizado" });
    const cuotaId = req.params.id;
    const usuario = req.user;

    const cuota = await Colchon.findById(cuotaId);
    if (!cuota) {
      return res.status(404).json({ error: "Cuota no encontrada" });
    }

    // ✅ Si no tiene vecesTocada aún, inicializalo en 0
    if (typeof cuota.vecesTocada !== "number") {
      cuota.vecesTocada = 0;
    }

    cuota.vecesTocada += 1;
    cuota.ultimaGestion = new Date();

    // ✅ Asignar solo si es operador y no tiene aún
    if (!cuota.empleadoId && (usuario.role || usuario.rol) === "operador") {
      cuota.empleadoId = usuario.id;
    }

    await cuota.save();

    res.json({ mensaje: "✔️ Gestión registrada correctamente", cuota });
  } catch (error) {
    console.error("❌ Error al registrar gestión:", error);
    res.status(500).json({ error: "Error al registrar gestión" });
  }
};
