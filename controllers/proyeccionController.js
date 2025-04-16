import Proyeccion from "../models/Proyeccion.js";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

// ✅ Función auxiliar para evaluar estado según importe pagado
export const evaluarEstadoPago = (proy) => {
  const importe = parseFloat(proy.importe || 0);
  const pagado = parseFloat(proy.importePagado || 0);

  if (pagado >= importe) return "Pagado";
  if (pagado > 0 && pagado < importe) return "Pagado parcial";
  return proy.estado; // No cambiar si no aplica
};

// 🧠 Función para actualizar estados automáticamente
export const actualizarEstadoAutomaticamente = async (proy) => {
  const hoy = new Date();
  let cambio = false;

  // ✅ Solo si hay fecha de promesa válida
  const fechaPromesaValida =
    proy.fechaPromesa && !isNaN(Date.parse(proy.fechaPromesa));
  const vencida = fechaPromesaValida && new Date(proy.fechaPromesa) < hoy;

  const importe = parseFloat(proy.importe);
  const pagado = parseFloat(proy.importePagado);
  const tieneImportesValidos = !isNaN(importe) && !isNaN(pagado);

  const estaPagado = tieneImportesValidos && pagado > 0;
  const promesaActiva = proy.estado === "Promesa activa";

  if (vencida && !estaPagado && promesaActiva) {
    proy.estado = "Promesa caída";
    cambio = true;
  }

  if (tieneImportesValidos) {
    if (pagado >= importe && proy.estado !== "Pagado") {
      proy.estado = "Pagado";
      cambio = true;
    } else if (
      pagado > 0 &&
      pagado < importe &&
      proy.estado !== "Pagado parcial"
    ) {
      proy.estado = "Pagado parcial";
      cambio = true;
    }
  }

  if (cambio) {
    proy.ultimaModificacion = new Date();
    await proy.save();
  }

  return proy;
};

// 1. Crear proyección
export const crearProyeccion = async (req, res) => {
  try {
    const {
      dni,
      nombreTitular,
      importe,
      estado,
      fechaPromesa,
      fechaProximoLlamado,
      ...otrosCampos
    } = req.body;

    if (!dni || !nombreTitular || !importe || !estado) {
      return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    if (fechaPromesa && isNaN(Date.parse(fechaPromesa))) {
      return res.status(400).json({ error: "Fecha de promesa inválida" });
    }

    if (fechaProximoLlamado && isNaN(Date.parse(fechaProximoLlamado))) {
      return res.status(400).json({ error: "Fecha próximo llamado inválida" });
    }

    const importeNumerico = parseFloat(importe);
    if (isNaN(importeNumerico)) {
      return res.status(400).json({ error: "Importe inválido" });
    }

    const fecha = new Date(fechaPromesa);
    const anio = fecha.getFullYear();
    const mes = fecha.getMonth() + 1;

    const nueva = new Proyeccion({
      dni,
      nombreTitular,
      importe: importeNumerico,
      estado,
      fechaPromesa,
      fechaProximoLlamado,
      anio,
      mes,
      ...otrosCampos,
      empleadoId: req.user.id,
      creado: new Date(),
      ultimaModificacion: new Date(),
    });

    await nueva.save();
    res.json(nueva);
  } catch (error) {
    res.status(500).json({ error: "Error al crear proyección" });
  }
};

// 2. Obtener proyecciones propias
export const obtenerProyeccionesPropias = async (req, res) => {
  try {
    const proyecciones = await Proyeccion.find({
      empleadoId: req.user.id,
    }).sort({ creado: -1 });
    const actualizadas = await Promise.all(
      proyecciones.map(actualizarEstadoAutomaticamente)
    );
    res.json(actualizadas);
  } catch (error) {
    res.status(500).json({ error: "Error al obtener proyecciones" });
  }
};

// 3. Actualizar proyección
export const actualizarProyeccion = async (req, res) => {
  try {
    const proyeccion = await Proyeccion.findById(req.params.id);
    if (!proyeccion)
      return res.status(404).json({ error: "Proyección no encontrada" });

    const rol = req.user.role || req.user.rol;
    if (rol === "operador" && String(proyeccion.empleadoId) !== req.user.id) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const fecha = new Date(req.body.fechaPromesa);
    const actualizada = await Proyeccion.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        ultimaModificacion: new Date(),
        mes: fecha.getMonth() + 1,
        anio: fecha.getFullYear(),
      },
      { new: true }
    );

    await actualizarEstadoAutomaticamente(actualizada);
    res.json(actualizada);
  } catch (error) {
    res.status(500).json({ error: "Error al actualizar proyección" });
  }
};

// 4. Eliminar
export const eliminarProyeccion = async (req, res) => {
  try {
    const proyeccion = await Proyeccion.findById(req.params.id);
    if (!proyeccion)
      return res.status(404).json({ error: "Proyección no encontrada" });

    const rol = req.user.role || req.user.rol;
    if (
      String(proyeccion.empleadoId) !== req.user.id &&
      !["admin", "super-admin"].includes(rol)
    ) {
      return res.status(403).json({ error: "No autorizado" });
    }

    await proyeccion.deleteOne();
    res.json({ mensaje: "Proyección eliminada" });
  } catch (error) {
    console.error("Error al eliminar proyección:", error);
    res.status(500).json({ error: "Error al eliminar proyección" });
  }
};

// 5. Obtener por operador
export const obtenerProyeccionesPorOperadorId = async (req, res) => {
  try {
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
      limit = 10,
      estado,
      concepto,
      cartera,
      desde,
      hasta,
      buscar,
      orden = "desc",
      usuarioId,
      mes,
      anio
    } = req.query;

    const filtros = [];

    const rol = req.user.role || req.user.rol;

    // ✅ Filtrado por usuario dependiendo del rol
    if (rol === "super-admin") {
      if (usuarioId) {
        filtros.push({ empleadoId: usuarioId });
      }
      // Si no hay usuarioId, no se filtra por empleadoId (ve todos)
    } else {
      filtros.push({ empleadoId: req.user.id });
    }

    if (estado) filtros.push({ estado });
    if (concepto) filtros.push({ concepto });
    if (cartera) filtros.push({ cartera });
    if (mes) filtros.push({ mes: parseInt(mes) });
    if (anio) filtros.push({ anio: parseInt(anio) });

    if (
      desde &&
      hasta &&
      !isNaN(Date.parse(desde)) &&
      !isNaN(Date.parse(hasta))
    ) {
      filtros.push({
        fechaPromesa: {
          $gte: new Date(desde),
          $lte: new Date(hasta),
        },
      });
    }

    if (buscar) {
      const regex = new RegExp(buscar, "i");
      const posibleDni = parseInt(buscar);
      const condicionesBusqueda = [
        { nombreTitular: regex },
        { concepto: regex },
        { estado: regex },
        { cartera: regex },
        { fiduciario: regex },
      ];
      if (!isNaN(posibleDni)) {
        condicionesBusqueda.push({ dni: posibleDni });
      }
      filtros.push({ $or: condicionesBusqueda });
    }

    const queryFinal = filtros.length ? { $and: filtros } : {};

    const total = await Proyeccion.countDocuments(queryFinal);

    const resultados = await Proyeccion.find(queryFinal)
      .populate("empleadoId", "username") // 👉 ahora el campo Por: funcionará
      .sort({ fechaPromesa: orden === "asc" ? 1 : -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const actualizadas = await Promise.all(
      resultados.map(actualizarEstadoAutomaticamente)
    );

    res.json({ total, resultados: actualizadas });
  } catch (error) {
    console.error("❌ Error en /proyecciones/filtrar:", error);
    res.status(500).json({ error: "Error al filtrar proyecciones" });
  }
};

// 7. Estadísticas propias
export const obtenerEstadisticasPropias = async (req, res) => {
  try {
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
      ["Cancelación", "Anticipo", "Parcial", "Pago a cuenta"].includes(
        p.concepto
      )
    ).length;

    const cuota = actualizadas.filter((p) => p.concepto === "Cuota").length;

    // 🧸 Colchón marcado por usuario
    const colchon = actualizadas.filter((p) => p.concepto === "Colchón").length;

    const porDia = {};
    actualizadas.forEach((p) => {
      const fecha = new Date(p.fechaPromesa).toISOString().split("T")[0];
      porDia[fecha] = (porDia[fecha] || 0) + 1;
    });

    res.json({ total, cumplidas, caidas, produccion, cuota, colchon, porDia });
  } catch (error) {
    res.status(500).json({ error: "Error al calcular estadísticas" });
  }
};

// 8. Estadísticas globales admin
export const obtenerEstadisticasAdmin = async (req, res) => {
  try {
    const proyecciones = await Proyeccion.find();
    const actualizadas = await Promise.all(
      proyecciones.map(actualizarEstadoAutomaticamente)
    );

    const porEmpleado = {},
      porCartera = {},
      porFiduciario = {},
      porMes = {};

    for (const p of actualizadas) {
      const id = p.empleadoId.toString();
      porEmpleado[id] = porEmpleado[id] || { total: 0, cumplidas: 0 };
      porEmpleado[id].total++;
      if (p.estado === "Pagado") porEmpleado[id].cumplidas++;

      porCartera[p.cartera] = (porCartera[p.cartera] || 0) + 1;
      if (p.fiduciario)
        porFiduciario[p.fiduciario] = (porFiduciario[p.fiduciario] || 0) + 1;

      const clave = `${p.anio}-${String(p.mes).padStart(2, "0")}`;
      porMes[clave] = (porMes[clave] || 0) + 1;
    }

    res.json({ porEmpleado, porCartera, porFiduciario, porMes });
  } catch (error) {
    res.status(500).json({ error: "Error al calcular estadísticas globales" });
  }
};

export const exportarProyeccionesExcel = async (req, res) => {
  try {
    const {
      estado,
      concepto,
      cartera,
      desde,
      hasta,
      buscar,
      orden = "desc",
      usuarioId,
    } = req.query;

    const rol = req.user.role || req.user.rol;
    const filtros = [];

    if (rol === "super-admin") {
      if (usuarioId) {
        filtros.push({ empleadoId: usuarioId });
      }
      // Si no hay usuarioId, no se filtra por empleadoId (o sea: ver todas)
    } else {
      filtros.push({ empleadoId: req.user.id });
    }

    if (estado) filtros.push({ estado });
    if (concepto) filtros.push({ concepto });
    if (cartera) filtros.push({ cartera });

    if (
      desde &&
      hasta &&
      !isNaN(Date.parse(desde)) &&
      !isNaN(Date.parse(hasta))
    ) {
      filtros.push({
        fechaPromesa: {
          $gte: new Date(desde),
          $lte: new Date(hasta),
        },
      });
    }

    if (buscar) {
      const regex = new RegExp(buscar, "i");
      const posibleDni = parseInt(buscar);
      const condicionesBusqueda = [
        { nombreTitular: regex },
        { concepto: regex },
        { estado: regex },
        { cartera: regex },
        { fiduciario: regex },
      ];
      if (!isNaN(posibleDni)) {
        condicionesBusqueda.push({ dni: posibleDni });
      }
      filtros.push({ $or: condicionesBusqueda });
    }

    const queryFinal = filtros.length ? { $and: filtros } : {};

    const proyecciones = await Proyeccion.find(queryFinal)
      .populate("empleadoId", "username") // ✅ Trae el nombre de quien creó
      .sort({ fechaPromesa: orden === "asc" ? 1 : -1 });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Proyecciones");

    worksheet.columns = [
      { header: "Creado por", key: "creadoPor", width: 20 }, // ✅ NUEVO
      { header: "DNI", key: "dni", width: 15 },
      { header: "Titular", key: "nombreTitular", width: 25 },
      { header: "Importe", key: "importe", width: 12 },
      { header: "Importe Pagado", key: "importePagado", width: 15 },
      { header: "Estado", key: "estado", width: 18 },
      { header: "Concepto", key: "concepto", width: 20 },
      { header: "Cartera", key: "cartera", width: 20 },
      { header: "Fiduciario", key: "fiduciario", width: 20 },
      { header: "Fecha Promesa", key: "fechaPromesa", width: 15 },
      {
        header: "Fecha Próximo Llamado",
        key: "fechaProximoLlamado",
        width: 18,
      },
      { header: "Observaciones", key: "observaciones", width: 30 },
    ];

    proyecciones.forEach((p) => {
      worksheet.addRow({
        creadoPor: p.empleadoId?.username || "-", // ✅ Usuario creador
        ...p.toObject(),
        fechaPromesa: p.fechaPromesa?.toLocaleDateString("es-AR") || "",
        fechaProximoLlamado: p.fechaProximoLlamado?.toLocaleDateString("es-AR") || "",
      });
      
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=proyecciones.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("❌ Error al exportar Excel:", error);
    res.status(500).json({ error: "Error al exportar a Excel" });
  }
};

export const obtenerResumenGlobal = async (req, res) => {
  try {
    const proyecciones = await Proyeccion.find().populate("empleadoId", "username");

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

      resumen.porUsuario[usuario] = resumen.porUsuario[usuario] || { total: 0, pagadas: 0 };
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

    resumen.porcentajeGlobal = resumen.total > 0
      ? ((resumen.pagadas / resumen.total) * 100).toFixed(1)
      : "0.0";

    res.json(resumen);
  } catch (error) {
    console.error("❌ Error en obtenerResumenGlobal:", error);
    res.status(500).json({ error: "Error al obtener resumen global" });
  }
};


// 📄 Exportar resumen de proyecciones en PDF (solo super-admin)
export const exportarResumenPDF = async (req, res) => {
  try {
    const proyecciones = await Proyeccion.find().populate("empleadoId", "username");

    let totalImporte = 0;
    let totalPagado = 0;
    let promesasCumplidas = 0;
    let vencidasSinPago = 0;
    let total = proyecciones.length;
    const hoy = new Date();
    const porUsuario = {};

    proyecciones.forEach((p) => {
      const importe = parseFloat(p.importe || 0);
      const pagado = parseFloat(p.importePagado || 0);
      const estado = p.estado;
      const username = p.empleadoId?.username || "Desconocido";

      totalImporte += importe;
      totalPagado += pagado;

      if (estado === "Pagado") promesasCumplidas++;
      if (
        p.fechaPromesa &&
        new Date(p.fechaPromesa) < hoy &&
        !pagado &&
        ["Pendiente", "Promesa activa"].includes(estado)
      ) {
        vencidasSinPago++;
      }

      porUsuario[username] = porUsuario[username] || { total: 0, pagadas: 0 };
      porUsuario[username].total++;
      if (estado === "Pagado") porUsuario[username].pagadas++;
    });

    // 🧠 Calcular cumplimiento por usuario
    const ranking = Object.entries(porUsuario)
      .map(([usuario, { total, pagadas }]) => ({
        usuario,
        total,
        pagadas,
        porcentaje: ((pagadas / total) * 100).toFixed(1),
      }))
      .sort((a, b) => b.porcentaje - a.porcentaje);

    const doc = new PDFDocument();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=resumen_proyecciones.pdf`);
    doc.pipe(res);

    doc.fontSize(18).text("Resumen Global de Proyecciones", { align: "center" }).moveDown();

    doc.fontSize(12).text(`Total proyecciones: ${total}`);
    doc.text(`Total prometido: $${totalImporte.toLocaleString()}`);
    doc.text(`Total pagado: $${totalPagado.toLocaleString()}`);
    doc.text(`Promesas cumplidas: ${promesasCumplidas}`);
    doc.text(`% vencidas sin pago: ${((vencidasSinPago / total) * 100).toFixed(1)}%`);
    doc.text(`% global de cumplimiento: ${((promesasCumplidas / total) * 100).toFixed(1)}%`);

    doc.moveDown().text("Ranking de cumplimiento por usuario:", { underline: true });

    ranking.forEach((r, i) => {
      doc.text(`${i + 1}. ${r.usuario} - ${r.porcentaje}% (${r.pagadas}/${r.total})`);
    });

    doc.end();
  } catch (error) {
    console.error("❌ Error al exportar resumen PDF:", error);
    res.status(500).json({ error: "Error al exportar resumen PDF" });
  }
};
