import Colchon from "../models/Colchon.js";
import Entidad from "../models/Entidad.js";
import SubCesion from "../models/SubCesion.js";
import Empleado from "../models/Empleado.js";
import Cartera from "../models/Cartera.js";
import ExcelJS from "exceljs";
import { formatearFecha } from "../utils/formatearFecha.js";

// Crear manual
export const crearCuota = async (req, res) => {
  try {
    const {
      cartera,
      dni,
      nombre,
      cuotaNumero,
      importeCuota,
      saldoPendiente,
      vencimiento,
      fechaPago,
      observaciones,
      fiduciario,
      entidadId,
      subCesionId,
      turno,
      mesGenerado,
      vencimientoDesde,
      vencimientoHasta,
      idPago, // ✅ agregado
    } = req.body;

    if (!cartera || !dni || !nombre || !importeCuota || !vencimiento) {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    const nueva = new Colchon({
      cartera,
      dni,
      nombre,
      cuotaNumero,
      importeCuota,
      saldoPendiente,
      vencimiento,
      fechaPago,
      observaciones,
      fiduciario,
      entidadId,
      subCesionId,
      turno,
      mesGenerado,
      idPago, // ✅ agregado
      vencimientoCuotas: {
        desde: vencimientoDesde,
        hasta: vencimientoHasta,
      },
      empleadoId: req.user.id,
      creado: new Date(),
      ultimaModificacion: new Date(),
    });

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

    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin" && String(cuota.empleadoId) !== req.user.id) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const {
      cartera,
      dni,
      nombre,
      cuotaNumero,
      importeCuota,
      saldoPendiente,
      vencimiento,
      fechaPago,
      observaciones,
      fiduciario,
      entidadId,
      subCesionId,
      turno,
      mesGenerado,
      vencimientoDesde,
      vencimientoHasta,
      idPago, // ✅ agregado
    } = req.body;

    if (!cartera || !dni || !nombre || !importeCuota || !vencimiento) {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    const updateData = {
      cartera,
      dni,
      nombre,
      cuotaNumero,
      importeCuota,
      saldoPendiente,
      vencimiento,
      fechaPago,
      observaciones,
      fiduciario,
      entidadId,
      subCesionId,
      turno,
      mesGenerado,
      idPago, // ✅ agregado
      vencimientoCuotas: {
        desde: vencimientoDesde,
        hasta: vencimientoHasta,
      },
      ultimaModificacion: new Date(),
    };

    const actualizada = await Colchon.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    );
    res.json(actualizada);
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
    if (rol !== "super-admin" && String(cuota.empleadoId) !== req.user.id) {
      return res.status(403).json({ error: "No autorizado" });
    }

    await cuota.deleteOne();
    res.json({ message: "Cuota eliminada correctamente" });
  } catch (error) {
    console.error("❌ Error al eliminar cuota:", error);
    res.status(500).json({ error: "Error al eliminar cuota" });
  }
};

// Filtrar cuotas
export const filtrarCuotas = async (req, res) => {
  try {
    const {
      cartera,
      fiduciario,
      fechaDesde,
      fechaHasta,
      buscar,
      page = 1,
      limit = 10,
    } = req.query;

    const filtros = [];
    const rol = req.user.role || req.user.rol;

    if (rol !== "super-admin") filtros.push({ empleadoId: req.user.id });
    if (cartera) filtros.push({ cartera });
    if (fiduciario) filtros.push({ fiduciario });

    if (fechaDesde || fechaHasta) {
      const fechaFiltro = {};
      if (fechaDesde) fechaFiltro.$gte = new Date(fechaDesde);
      if (fechaHasta) fechaFiltro.$lte = new Date(fechaHasta);
      filtros.push({ vencimiento: fechaFiltro });
    }

    if (buscar) {
      const regex = new RegExp(buscar, "i");
      filtros.push({
        $or: [
          { nombre: regex },
          { observaciones: regex },
          { fiduciario: regex },
        ],
      });
    }

    const query = filtros.length ? { $and: filtros } : {};
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const cuotas = await Colchon.find(query)
      .populate("empleadoId", "username")
      .populate("entidadId", "nombre")
      .populate("subCesionId", "nombre")
      .sort({ vencimiento: 1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Colchon.countDocuments(query);
    res.json({ total, cuotas });
  } catch (error) {
    console.error("❌ Error al filtrar cuotas:", error);
    res.status(500).json({ error: "Error al filtrar cuotas" });
  }
};

// Importar desde Excel
export const importarExcel = async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "No se recibió archivo" });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];

    const registros = [];

    for (let i = 2; i <= worksheet.rowCount; i++) {
      const row = worksheet.getRow(i);

      const entidadNumero = parseInt(row.getCell("ENTIDAD").value);
      const entidad = await Entidad.findOne({ numero: entidadNumero });

      registros.push({
        estado: row.getCell("ESTADO").value || "A cuota",
        entidadId: entidad ? entidad._id : null,
        idPago: row.getCell("ID PAGO").value || null,
        dni: parseInt(row.getCell("DNI").value),
        nombre: row.getCell("NOMBRE Y APELLIDO").value || "",
        operador: row.getCell("OPERADOR").value || "",
        turno: row.getCell("TURNO").value || "",
        cartera: row.getCell("CARTERA").value || "",
        mesGenerado: row.getCell(" MES GENERADO ").value || "",
        vencimientoCuotas: {
          desde: parseInt(row.getCell("VTO").value),
          hasta: parseInt(row.getCell("CUOTAS").value),
        },
        importeCuota: parseFloat(row.getCell("PAGO?").value || 0),
        saldoPendiente: parseFloat(row.getCell("ABRIL").value || 0),
        empleadoId: req.user.id,
        creado: new Date(),
        ultimaModificacion: new Date(),
      });
    }

    await Colchon.insertMany(registros);
    res.json({
      message: `Se importaron ${registros.length} cuotas correctamente.`,
    });
  } catch (error) {
    console.error("❌ Error al importar Excel:", error);
    res.status(500).json({ error: "Error al importar Excel" });
  }
};

// Exportar a Excel
export const exportarExcel = async (req, res) => {
  try {
    const filtros = [];
    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin") filtros.push({ empleadoId: req.user.id });

    const query = filtros.length ? { $and: filtros } : {};
    const cuotas = await Colchon.find(query).populate("empleadoId", "username");

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Colchon");

    worksheet.columns = [
      { header: "DNI", key: "dni", width: 15 },
      { header: "Titular", key: "nombre", width: 25 },
      { header: "Turno", key: "turno", width: 15 },
      { header: "Cartera", key: "cartera", width: 20 },
      { header: "Importe", key: "importeCuota", width: 12 },
      { header: "Saldo", key: "saldoPendiente", width: 12 },
      { header: "Mes Generado", key: "mesGenerado", width: 15 },
      { header: "Cuota Desde", key: "cuotaDesde", width: 12 },
      { header: "Cuota Hasta", key: "cuotaHasta", width: 12 },
      { header: "Entidad", key: "entidad", width: 20 },
    ];

    cuotas.forEach((c) => {
      worksheet.addRow({
        dni: c.dni,
        nombre: c.nombre,
        turno: c.turno,
        cartera: c.cartera,
        importeCuota: c.importeCuota,
        saldoPendiente: c.saldoPendiente,
        mesGenerado: c.mesGenerado,
        cuotaDesde: c.vencimientoCuotas?.desde || "",
        cuotaHasta: c.vencimientoCuotas?.hasta || "",
        entidad: c.entidadId?.nombre || "",
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename=colchon.xlsx`);

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
