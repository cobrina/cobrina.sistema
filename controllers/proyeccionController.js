import Proyeccion from "../models/Proyeccion.js";
import ExcelJS from "exceljs";
import { formatearFecha } from "../utils/formatearFecha.js";

// ✅ Utilidad para crear fechas locales sin desfase horario
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

    if (fecha.getTime() < hoy.getTime()) {
      nuevoEstado = "Promesa caída";
    } else if (fecha.getTime() === hoy.getTime()) {
      nuevoEstado = "Pendiente";
    } else {
      nuevoEstado = "Promesa activa";
    }
  }

  // ⚠️ Si el estado cambió, lo persistimos en DB
  if (proy.estado !== nuevoEstado) {
    proy.estado = nuevoEstado;
    proy.ultimaModificacion = new Date();
    await proy.save(); // 👈 obligatorio para que se actualice en MongoDB
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
      concepto,
      cartera,
      ...otrosCampos
    } = req.body;

    // ✅ Validación con mensajes detallados
    const camposObligatorios = {
      dni,
      nombreTitular,
      importe,
      estado,
      concepto,
      cartera,
      fechaPromesa,
      fechaProximoLlamado,
    };

    const camposFaltantes = Object.entries(camposObligatorios)
      .filter(([_, valor]) => !valor)
      .map(([campo]) => campo);

    if (camposFaltantes.length > 0) {
      return res.status(400).json({
        error: `Faltan completar: ${camposFaltantes.join(", ")}`
      });
    }

    // ✅ Validar fechas
    if (isNaN(Date.parse(fechaPromesa))) {
      return res.status(400).json({ error: "Fecha de promesa inválida" });
    }
    if (isNaN(Date.parse(fechaProximoLlamado))) {
      return res.status(400).json({ error: "Fecha próximo llamado inválida" });
    }

    const importeNumerico = parseFloat(importe);
    if (isNaN(importeNumerico)) {
      return res.status(400).json({ error: "Importe inválido" });
    }

    const fecha = new Date(`${fechaPromesa}T12:00:00`);
    const anio = fecha.getFullYear();
    const mes = fecha.getMonth() + 1;

    // ✅ Crear proyección
    let nueva = new Proyeccion({
      dni,
      nombreTitular,
      importe: importeNumerico,
      estado,
      concepto,
      cartera,
      fechaPromesa,
      fechaProximoLlamado,
      fechaPromesaInicial: fechaPromesa,
      anio,
      mes,
      ...otrosCampos,
      empleadoId: req.user.id,
      creado: new Date(),
      ultimaModificacion: new Date(),
    });

    nueva = await actualizarEstadoAutomaticamente(nueva);

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
    if (!proyeccion) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    const rol = req.user.role || req.user.rol;
    if (rol === "operador" && String(proyeccion.empleadoId) !== req.user.id) {
      return res.status(403).json({ error: "No autorizado para editar" });
    }

    const {
      dni,
      nombreTitular,
      importe,
      concepto,
      cartera,
      fechaPromesa,
      fechaProximoLlamado,
      ...resto
    } = req.body;

    const camposObligatorios = {
      dni,
      nombreTitular,
      importe,
      concepto,
      cartera,
    };

    const faltan = Object.entries(camposObligatorios)
      .filter(([_, v]) => !v && v !== 0)
      .map(([k]) => k);

    if (faltan.length) {
      return res.status(400).json({
        error: `Faltan completar: ${faltan.join(", ")}`
      });
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

    const updateData = {
      dni,
      nombreTitular,
      importe: importeNumerico,
      concepto,
      cartera,
      fechaPromesa,
      fechaProximoLlamado,
      ultimaModificacion: new Date(),
      ...resto,
    };

    if (fechaPromesa) {
      const f = new Date(fechaPromesa);
      updateData.mes = f.getMonth() + 1;
      updateData.anio = f.getFullYear();
    }

    const actualizada = await Proyeccion.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    );

    await actualizarEstadoAutomaticamente(actualizada);

    res.json(actualizada);
  } catch (error) {
    console.error("❌ Error al actualizar proyección:", error);
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
    } = req.query;

    const filtros = [];
    const rol = req.user.role || req.user.rol;

    if (rol === "super-admin") {
      if (usuarioId) {
        filtros.push({ empleadoId: usuarioId });
      }
    } else {
      filtros.push({ empleadoId: req.user.id });
    }

    if (estado) filtros.push({ estado });
    if (concepto) filtros.push({ concepto });
    if (cartera) filtros.push({ cartera });
    if (mes) filtros.push({ mes: parseInt(mes) });
    if (anio) filtros.push({ anio: parseInt(anio) });

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const mañana = new Date(hoy);
    mañana.setDate(hoy.getDate() + 1);

    if (promesaHoy === "true") {
      filtros.push({ fechaPromesa: { $gte: hoy, $lt: mañana } });
    }

    if (llamadoHoy === "true") {
      filtros.push({ fechaProximoLlamado: { $gte: hoy, $lt: mañana } });
    }

    if (
      fechaDesde &&
      fechaHasta &&
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

      if (campoFecha) {
        filtros.push({
          [campoFecha]: { $gte: inicio, $lte: fin },
        });
      }
    }

    if (buscar) {
      const regex = new RegExp(buscar, "i");
      const posibleDni = parseInt(buscar);
      const condiciones = [
        { nombreTitular: regex },
        { concepto: regex },
        { estado: regex },
        { cartera: regex },
        { fiduciario: regex },
      ];
      if (!isNaN(posibleDni)) condiciones.push({ dni: posibleDni });
      filtros.push({ $or: condiciones });
    }

    const query = filtros.length ? { $and: filtros } : {};
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const sortObj = {};
    if (ordenPor) {
      sortObj[ordenPor] = orden === "asc" ? 1 : -1;
    }

    const resultados = await Proyeccion.find(query)
      .populate("empleadoId", "username")
      .sort(sortObj)
      .skip(skip)
      .limit(parseInt(limit));

    const actualizadas = await Promise.all(
      resultados.map(actualizarEstadoAutomaticamente)
    );

    const total = await Proyeccion.countDocuments(query);
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
      // No agregues nada si es super-admin y no hay usuarioId
    } else {
      filtros.push({ empleadoId: req.user.id });
    }

    if (estado) filtros.push({ estado });
    if (concepto) filtros.push({ concepto });
    if (cartera) filtros.push({ cartera });

    if (
      req.query.tipoFecha &&
      req.query.fechaDesde &&
      req.query.fechaHasta &&
      !isNaN(Date.parse(req.query.fechaDesde)) &&
      !isNaN(Date.parse(req.query.fechaHasta))
    ) {
      const desde = crearFechaLocal(req.query.fechaDesde);
      const hasta = crearFechaLocal(req.query.fechaHasta, true);

      const campoFecha = {
        fechaPromesa: "fechaPromesa",
        creado: "creado",
        modificado: "ultimaModificacion",
      }[req.query.tipoFecha];

      if (campoFecha) {
        filtros.push({
          [campoFecha]: { $gte: desde, $lte: hasta },
        });
      }
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
      .populate("empleadoId", "username")
      .sort({ fechaPromesa: orden === "asc" ? 1 : -1 });

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
      { header: "Cartera", key: "cartera", width: 20 },
      { header: "Fiduciario", key: "fiduciario", width: 20 },
      { header: "Fecha Promesa", key: "fechaPromesa", width: 15 },
      {
        header: "Fecha Próximo Llamado",
        key: "fechaProximoLlamado",
        width: 20,
      },
      { header: "Creado", key: "creado", width: 15 },
      { header: "Última Modificación", key: "ultimaModificacion", width: 20 },
      { header: "Observaciones", key: "observaciones", width: 30 },
    ];

    proyecciones.forEach((p) => {
      worksheet.addRow({
        creadoPor: p.empleadoId?.username || "-",
        dni: p.dni,
        nombreTitular: p.nombreTitular,
        importe: p.importe,
        importePagado: p.importePagado,
        estado: p.estado,
        concepto: p.concepto,
        cartera: p.cartera,
        fiduciario: p.fiduciario,
        fechaPromesa: formatearFecha(p.fechaPromesa),
        fechaProximoLlamado: formatearFecha(p.fechaProximoLlamado),
        creado: formatearFecha(p.creado),
        ultimaModificacion: formatearFecha(p.ultimaModificacion),
        observaciones: p.observaciones,
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
      cartera,
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
    const rol = req.user.role || req.user.rol;

    if (rol === "super-admin" && usuarioId) {
      filtros.push({ empleadoId: usuarioId });
    } else if (rol !== "super-admin") {
      filtros.push({ empleadoId: req.user.id });
    }

    if (estado) filtros.push({ estado });
    if (concepto) filtros.push({ concepto });
    if (cartera) filtros.push({ cartera });
    if (mes) filtros.push({ mes: parseInt(mes) });
    if (anio) filtros.push({ anio: parseInt(anio) });

    if (
      fechaDesde &&
      fechaHasta &&
      !isNaN(Date.parse(fechaDesde)) &&
      !isNaN(Date.parse(fechaHasta))
    ) {
      const desde = crearFechaLocal(fechaDesde);
      const hasta = crearFechaLocal(fechaHasta, true);

      const campoFecha =
        {
          fechaPromesa: "fechaPromesa",
          creado: "creado",
          modificado: "ultimaModificacion",
        }[tipoFecha] || "fechaPromesa";

      filtros.push({ [campoFecha]: { $gte: desde, $lte: hasta } });
    }

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const mañana = new Date(hoy);
    mañana.setDate(hoy.getDate() + 1);

    if (promesaHoy === "true") {
      filtros.push({ fechaPromesa: { $gte: hoy, $lt: mañana } });
    }

    if (llamadoHoy === "true") {
      filtros.push({ fechaProximoLlamado: { $gte: hoy, $lt: mañana } });
    }

    if (buscar) {
      const regex = new RegExp(buscar, "i");
      const posibleDni = parseInt(buscar);
      const condiciones = [
        { nombreTitular: regex },
        { concepto: regex },
        { estado: regex },
        { cartera: regex },
        { fiduciario: regex },
      ];
      if (!isNaN(posibleDni)) condiciones.push({ dni: posibleDni });
      filtros.push({ $or: condiciones });
    }

    const query = filtros.length ? { $and: filtros } : {};

    const proyecciones = await Proyeccion.find(query)
      .populate("empleadoId", "username")
      .sort(ordenPor ? { [ordenPor]: orden === "asc" ? 1 : -1 } : {});

    const resumen = {
      totalImporte: 0,
      totalPagado: 0,
      vencidasSinPago: 0,
      pagadas: 0,
      total: 0,
      porEstado: {},
      porCartera: {},
      porDia: {},
      porDiaCreacion: {}, // 👈 NUEVO
      porUsuario: {},
      fiduciarios: {},
    };

    const hoyDate = new Date();
    hoyDate.setHours(0, 0, 0, 0);

    for (const p of proyecciones) {
      const importe = parseFloat(p.importe || 0);
      const pagado = parseFloat(p.importePagado || 0);
      const estado = p.estado?.trim() || "Sin estado";
      const cartera = (p.cartera || "Sin cartera").trim();
      const fiduciario =
        p.fiduciario && p.fiduciario.trim() !== ""
          ? p.fiduciario.trim()
          : "No informado";
      const usuario = p.empleadoId?.username || "Sin usuario";

      resumen.total++;
      resumen.totalImporte += importe;
      resumen.totalPagado += pagado;

      if (estado === "Pagado") resumen.pagadas++;

      const promesaVencida = new Date(p.fechaPromesa);
      if (
        estado === "Promesa caída" &&
        pagado === 0 &&
        promesaVencida < hoyDate
      ) {
        resumen.vencidasSinPago++;
      }

      resumen.porEstado[estado] = (resumen.porEstado[estado] || 0) + 1;
      resumen.porCartera[cartera] = (resumen.porCartera[cartera] || 0) + 1;

      const fPromesa = new Date(p.fechaPromesa);
      const fCreacion = new Date(p.creado);

      const strPromesa = `${fPromesa.getFullYear()}-${String(
        fPromesa.getMonth() + 1
      ).padStart(2, "0")}-${String(fPromesa.getDate()).padStart(2, "0")}`;

      const strCreacion = `${fCreacion.getFullYear()}-${String(
        fCreacion.getMonth() + 1
      ).padStart(2, "0")}-${String(fCreacion.getDate()).padStart(2, "0")}`;

      resumen.porDia[strPromesa] = (resumen.porDia[strPromesa] || 0) + 1;
      resumen.porDiaCreacion[strCreacion] =
        (resumen.porDiaCreacion[strCreacion] || 0) + 1;

      resumen.porUsuario[usuario] = resumen.porUsuario[usuario] || {
        total: 0,
        pagadas: 0,
      };
      resumen.porUsuario[usuario].total++;
      if (estado === "Pagado") resumen.porUsuario[usuario].pagadas++;

      resumen.fiduciarios[fiduciario] =
        (resumen.fiduciarios[fiduciario] || 0) + 1;
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

    res.json({
      totalImporte: resumen.totalImporte,
      totalPagado: resumen.totalPagado,
      porcentajeVencidas,
      porcentajeCumplimiento,
      porEstado: resumen.porEstado,
      porCartera: resumen.porCartera,
      porDia: resumen.porDia,
      porDiaCreacion: resumen.porDiaCreacion, // 👈 NUEVO
      topUsuarios,
      rankingCumplimiento,
      fiduciarios: resumen.fiduciarios,
      pagadas: resumen.pagadas,
      total: resumen.total,
      vencidasSinPago: resumen.vencidasSinPago,
    });
  } catch (error) {
    console.error("❌ Error en obtenerProyeccionesParaResumen:", error);
    res.status(500).json({ error: "Error al obtener resumen" });
  }
};
