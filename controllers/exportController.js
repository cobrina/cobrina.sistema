import Proyeccion from "../models/Proyeccion.js";
import { Parser } from "json2csv";
import PDFDocument from "pdfkit";

// 1. Exportar proyecciones del usuario (o usuarioId si es super-admin) a CSV
export const exportarProyeccionesCSV = async (req, res) => {
  try {
    const rol = req.user.role || req.user.rol;
    const usuarioId = req.query.usuarioId;

    const filtros = [];

    if (rol === "super-admin" && usuarioId) {
      filtros.push({ empleadoId: usuarioId });
    } else {
      filtros.push({ empleadoId: req.user.id });
    }

    const query = filtros.length ? { $and: filtros } : {};
    const proyecciones = await Proyeccion.find(query);

    const fields = [
      "dni",
      "nombreTitular",
      "importe",
      "concepto",
      "fechaPromesa",
      "importePagado",
      "estado",
      "cartera",
      "fiduciario",
      "observaciones",
      "creado",
      "ultimaModificacion",
    ];

    const parser = new Parser({ fields });
    const csv = parser.parse(proyecciones);

    res.header("Content-Type", "text/csv");
    res.attachment("proyecciones.csv");
    return res.send(csv);
  } catch (error) {
    res.status(500).json({ error: "Error al exportar proyecciones" });
  }
};

// 2. Exportar estadísticas en PDF (operador o admin o super-admin)
export const exportarEstadisticasPDF = async (req, res) => {
  try {
    const rol = req.user.role || req.user.rol;
    const usuarioId = req.query.operadorId;

    const filtro =
      rol === "super-admin" && usuarioId
        ? { empleadoId: usuarioId }
        : { empleadoId: req.user.id };

    const proyecciones = await Proyeccion.find(filtro);

    const total = proyecciones.length;
    const cumplidas = proyecciones.filter((p) => p.estado === "Pagado").length;
    const caidas = proyecciones.filter((p) => p.estado === "Promesa caída").length;
    const produccion = proyecciones.filter((p) =>
      ["Cancelación", "Anticipo", "Parcial", "Pago a cuenta"].includes(p.concepto)
    ).length;
    const cuota = proyecciones.filter((p) => p.concepto === "Cuota").length;

    const porDia = {};
    proyecciones.forEach((p) => {
      const fecha = new Date(p.fechaPromesa).toISOString().split("T")[0];
      porDia[fecha] = (porDia[fecha] || 0) + 1;
    });

    // Crear PDF
    const doc = new PDFDocument();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=estadisticas.pdf");

    doc.fontSize(16).text("📊 Informe de Estadísticas", { align: "center" });
    doc.moveDown();

    doc.fontSize(12).text(`Total de promesas: ${total}`);
    doc.text(`Cumplidas (Pagado): ${cumplidas}`);
    doc.text(`Caídas (Promesa caída): ${caidas}`);
    doc.text(`Producción: ${produccion}`);
    doc.text(`Cuotas: ${cuota}`);

    doc.moveDown().text("Promesas por día:");
    for (const [fecha, cantidad] of Object.entries(porDia)) {
      doc.text(`• ${fecha}: ${cantidad}`);
    }

    doc.end(); // Finaliza el PDF
    doc.pipe(res);
  } catch (error) {
    res.status(500).json({ error: "Error al exportar estadísticas" });
  }
};

export const exportarResumenPDF = async (req, res) => {
  try {
    const response = await fetch("http://localhost:5000/proyecciones/admin/resumen", {
      headers: {
        Authorization: req.headers.authorization,
      },
    });

    const resumen = await response.json();

    const doc = new PDFDocument();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=resumen.pdf");
    doc.pipe(res);

    doc.fontSize(20).text("Resumen Global de Proyecciones", { align: "center" });
    doc.moveDown();

    doc.fontSize(12).text(`Total de promesas: ${resumen.total}`);
    doc.text(`Total pagadas: ${resumen.pagadas}`);
    doc.text(`% de cumplimiento global: ${resumen.porcentajeGlobal}%`);
    doc.moveDown();

    doc.fontSize(14).text("Ranking de Cumplimiento por Usuario:");
    for (const [usuario, porcentaje] of Object.entries(resumen.rankingCumplimiento)) {
      doc.text(`- ${usuario}: ${porcentaje}%`);
    }

    doc.moveDown();
    doc.fontSize(14).text("Totales por Usuario:");
    for (const [usuario, datos] of Object.entries(resumen.porUsuario)) {
      doc.text(`- ${usuario}: ${datos.total} promesas, ${datos.pagadas} pagadas`);
    }

    doc.end();
  } catch (error) {
    console.error("❌ Error al generar resumen PDF:", error);
    res.status(500).json({ error: "Error al exportar resumen PDF" });
  }
};