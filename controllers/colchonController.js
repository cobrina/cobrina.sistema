import Colchon from "../models/Colchon.js";
import { formatearFecha } from "../utils/formatearFecha.js";
import ExcelJS from "exceljs";

// Crear manual
export const crearCuota = async (req, res) => {
  try {
    const {
      cartera,
      dni,
      nombreTitular,
      cuotaNumero,
      importeCuota,
      saldoPendiente,
      fechaVencimiento,
      fechaPago,
      observaciones,
      fiduciario,
    } = req.body;

    if (
      !cartera ||
      !dni ||
      !nombreTitular ||
      !cuotaNumero ||
      !importeCuota ||
      !saldoPendiente ||
      !fechaVencimiento
    ) {
      return res.status(400).json({
        error: "Todos los campos obligatorios deben ser completados.",
      });
    }

    const nueva = new Colchon({
      cartera,
      dni,
      nombreTitular,
      cuotaNumero,
      importeCuota,
      saldoPendiente,
      fechaVencimiento,
      fechaPago,
      observaciones,
      fiduciario,
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

// ✏️ Editar cuota
export const editarCuota = async (req, res) => {
  try {
    const cuota = await Colchon.findById(req.params.id);
    if (!cuota) {
      return res.status(404).json({ error: "Cuota no encontrada" });
    }

    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin" && String(cuota.empleadoId) !== req.user.id) {
      return res
        .status(403)
        .json({ error: "No autorizado para editar esta cuota" });
    }

    const {
      cartera,
      dni,
      nombreTitular,
      cuotaNumero,
      importeCuota,
      saldoPendiente,
      fechaVencimiento,
      fechaPago,
      observaciones,
      fiduciario,
    } = req.body;

    const updateData = {
      cartera,
      dni,
      nombreTitular,
      cuotaNumero,
      importeCuota,
      saldoPendiente,
      fechaVencimiento,
      fechaPago,
      observaciones,
      fiduciario,
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

// 🗑️ Eliminar cuota
export const eliminarCuota = async (req, res) => {
  try {
    const cuota = await Colchon.findById(req.params.id);
    if (!cuota) {
      return res.status(404).json({ error: "Cuota no encontrada" });
    }

    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin" && String(cuota.empleadoId) !== req.user.id) {
      return res
        .status(403)
        .json({ error: "No autorizado para eliminar esta cuota" });
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

    if (rol !== "super-admin") {
      filtros.push({ empleadoId: req.user.id });
    }

    if (cartera) filtros.push({ cartera });
    if (fiduciario) filtros.push({ fiduciario });

    if (fechaDesde || fechaHasta) {
      const fechaFiltro = {};
      if (fechaDesde) fechaFiltro.$gte = new Date(fechaDesde);
      if (fechaHasta) fechaFiltro.$lte = new Date(fechaHasta);
      filtros.push({ fechaVencimiento: fechaFiltro });
    }

    if (buscar) {
      const regex = new RegExp(buscar, "i");
      filtros.push({
        $or: [
          { nombreTitular: regex },
          { observaciones: regex },
          { fiduciario: regex },
        ],
      });
    }

    const query = filtros.length ? { $and: filtros } : {};
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Buscar cuotas
    const cuotas = await Colchon.find(query)
      .populate("empleadoId", "username")
      .sort({ fechaVencimiento: 1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Buscar total
    const total = await Colchon.countDocuments(query);

    // 📋 Si no hay cuotas, devolver igual una respuesta vacía (opcional)
    if (!cuotas.length) {
      return res.json({ total: 0, cuotas: [] });
    }

    // ✅ Devolver normalmente
    res.json({ total, cuotas });
  } catch (error) {
    console.error("❌ Error al filtrar cuotas:", error);
    res.status(500).json({ error: "Error al filtrar cuotas" });
  }
};

// Importar Excel
export const importarExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió archivo" });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);

    const worksheet = workbook.worksheets[0];
    const registros = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Saltar encabezado

      const [
        cartera,
        dni,
        nombreTitular,
        cuotaNumero,
        importeCuota,
        saldoPendiente,
        fechaVencimiento,
        fechaPago,
        observaciones,
        fiduciario,
      ] = row.values.slice(1);

      if (!dni || !cuotaNumero) return; // Saltar inválidos

      registros.push({
        cartera: cartera || "-",
        dni: parseInt(dni),
        nombreTitular: nombreTitular || "-",
        cuotaNumero: parseInt(cuotaNumero),
        importeCuota: parseFloat(importeCuota || 0),
        saldoPendiente: parseFloat(saldoPendiente || 0),
        fechaVencimiento: fechaVencimiento ? new Date(fechaVencimiento) : null,
        fechaPago: fechaPago ? new Date(fechaPago) : null,
        observaciones: observaciones || "",
        fiduciario: fiduciario || "",
        estado: "CUOTA",
        empleadoId: req.user.id,
        creado: new Date(),
        ultimaModificacion: new Date(),
      });
    });

    await Colchon.insertMany(registros);
    res.json({
      message: `Se importaron ${registros.length} cuotas correctamente.`,
    });
  } catch (error) {
    console.error("❌ Error al importar Excel:", error);
    res.status(500).json({ error: "Error al importar Excel" });
  }
};

// Exportar Excel
export const exportarExcel = async (req, res) => {
  try {
    const { cartera, fiduciario } = req.query;
    const filtros = [];
    const rol = req.user.role || req.user.rol;

    if (rol !== "super-admin") {
      filtros.push({ empleadoId: req.user.id });
    }

    if (cartera) filtros.push({ cartera });
    if (fiduciario) filtros.push({ fiduciario });

    const query = filtros.length ? { $and: filtros } : {};

    const cuotas = await Colchon.find(query).populate("empleadoId", "username");

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Cuotas");

    worksheet.columns = [
      { header: "Cartera", key: "cartera", width: 20 },
      { header: "DNI", key: "dni", width: 15 },
      { header: "Titular", key: "nombreTitular", width: 25 },
      { header: "Cuota N°", key: "cuotaNumero", width: 10 },
      { header: "Importe", key: "importeCuota", width: 12 },
      { header: "Saldo", key: "saldoPendiente", width: 12 },
      { header: "Fecha Vencimiento", key: "fechaVencimiento", width: 18 },
      { header: "Fecha Pago", key: "fechaPago", width: 18 },
      { header: "Observaciones", key: "observaciones", width: 25 },
      { header: "Fiduciario", key: "fiduciario", width: 20 },
    ];

    cuotas.forEach((c) => {
      worksheet.addRow({
        cartera: c.cartera,
        dni: c.dni,
        nombreTitular: c.nombreTitular,
        cuotaNumero: c.cuotaNumero,
        importeCuota: c.importeCuota,
        saldoPendiente: c.saldoPendiente,
        fechaVencimiento: formatearFecha(c.fechaVencimiento),
        fechaPago: c.fechaPago ? formatearFecha(c.fechaPago) : "",
        observaciones: c.observaciones,
        fiduciario: c.fiduciario,
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
