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

// 🔁 Calcula saldo pendiente
export const calcularSaldoPendiente = (cuota) => {
  const totalPagado = cuota.pagos?.reduce((acc, p) => acc + p.monto, 0) || 0;
  return Math.max((cuota.importeCuota || 0) - totalPagado, 0);
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
    if (rol !== "super-admin" && rol !== "admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

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
      estado,
      telefono, // ✅ nuevo campo
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
      vencimiento,
      observaciones,
      observacionesOperador: observacionesOperador || "",
      fiduciario,
      entidadId,
      subCesionId,
      turno,
      telefono, // ✅ guardar teléfono si viene
      pagos: req.body.pagos || [],
      vencimientoCuotas: {
        desde: vencimientoDesde,
        hasta: vencimientoHasta,
      },
      empleadoId: req.user.id,
      creado: new Date(),
      ultimaModificacion: new Date(),
    });

    // 👉 calcular idCuotaLogico
    nueva.idCuotaLogico = `${dni}-${entidadId || "SIN_ENTIDAD"}`;

    // ✅ Usar estado manual si viene
    if (estado && typeof estado === "string" && estado.trim()) {
      nueva.estado = estado.trim();
      nueva.estadoOriginal = estado.trim();
    } else {
      nueva.estado = "A cuota"; // default
      nueva.estadoOriginal = "A cuota";
    }

    // ✅ Usar estadoOriginal para calcular deuda
    nueva.estado = nueva.estadoOriginal;
    actualizarDeudaPorMes(nueva);

    // ✅ Calcular saldo
    nueva.saldoPendiente = nueva.deudaPorMes.reduce(
      (acc, d) => acc + (d.montoAdeudado || 0),
      0
    );

    // ✅ Agregar alerta si debe más de 1 cuota
    if (
      nueva.estado === "A cuota" &&
      nueva.saldoPendiente > (nueva.importeCuota || 0)
    ) {
      nueva.alertaDeuda = true;
    }

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

    // 🚫 Solo super-admin o dueño puede editar todo
    if (rol !== "super-admin" && String(cuota.empleadoId) !== req.user.id) {
      return res.status(403).json({ error: "No autorizado" });
    }

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

    // 👩‍💻 Si es operador → solo puede editar observación de operador
    if (rol === "operador") {
      cuota.observacionesOperador = observacionesOperador;
      cuota.ultimaModificacion = new Date();

      const estadoBase = cuota.estadoOriginal || cuota.estado;
      cuota.estado = estadoBase;

      actualizarDeudaPorMes(cuota);
      cuota.saldoPendiente = cuota.deudaPorMes.reduce(
        (acc, d) => acc + (d.montoAdeudado || 0),
        0
      );

      // 👉 Si tiene pagos → visualmente "A cuota"
      if (cuota.pagos?.length > 0) {
        cuota.estado = "A cuota";
      }

      // 👉 Mostrar alerta si debe más de una cuota
      cuota.alertaDeuda =
        cuota.estado === "A cuota" &&
        cuota.saldoPendiente > (cuota.importeCuota || 0);

      await cuota.save();
      return res.json(cuota);
    }

    // Validar campos obligatorios
    if (!cartera || !dni || !nombre || !importeCuota || !vencimiento) {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    // Actualizar datos
    cuota.cartera = cartera;
    cuota.dni = dni;
    cuota.nombre = nombre;
    cuota.cuotaNumero = cuotaNumero;
    cuota.importeCuota = importeCuota;
    cuota.vencimiento = vencimiento;
    cuota.fechaPago = fechaPago;
    cuota.observaciones = observaciones;
    cuota.observacionesOperador = observacionesOperador;
    cuota.fiduciario = fiduciario;
    cuota.entidadId = entidadId;
    cuota.subCesionId = subCesionId;
    cuota.turno = turno;
    cuota.pagos = pagos;
    cuota.empleadoId = empleadoId;
    cuota.vencimientoCuotas = {
      desde: vencimientoDesde,
      hasta: vencimientoHasta,
    };
    cuota.telefono = telefono;
    cuota.idCuotaLogico = `${dni}-${entidadId || "SIN_ENTIDAD"}`;
    cuota.ultimaModificacion = new Date();

    // ✅ Si se proporciona un estado, actualizarlo y fijarlo como original
    if (estado && typeof estado === "string" && estado.trim()) {
      cuota.estado = estado.trim();
      cuota.estadoOriginal = estado.trim();
    } else {
      cuota.estado = cuota.estadoOriginal || "A cuota";
    }

    // ✅ Calcular deuda y saldo basado en estadoOriginal
    const estadoBase = cuota.estadoOriginal || cuota.estado;
    cuota.estado = estadoBase;

    actualizarDeudaPorMes(cuota);

    cuota.saldoPendiente = cuota.deudaPorMes.reduce(
      (acc, d) => acc + (d.montoAdeudado || 0),
      0
    );

    // ✅ Si tiene pagos → mostrar "A cuota"
    if (cuota.pagos?.length > 0) {
      cuota.estado = "A cuota";
    }

    // ✅ Marcar alerta si debe más de una cuota
    cuota.alertaDeuda =
      cuota.estado === "A cuota" &&
      cuota.saldoPendiente > (cuota.importeCuota || 0);

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
      limit = 10,
      sortBy = "vencimiento",
      sortDirection = "asc",
      sinGestion,
      conPagosNoVistos,
    } = req.query;

    const rol = req.user.role || req.user.rol;
    const filtrosBase = [];

    // 🔐 Restricción por operador
    if (rol !== "super-admin") {
      filtrosBase.push({ empleadoId: req.user.id });
    } else if (usuarioId) {
      filtrosBase.push({ empleadoId: usuarioId });
    }

    if (dni) {
      const dniParsed = parseInt(dni);
      if (!isNaN(dniParsed)) filtrosBase.push({ dni: dniParsed });
    }

    if (nombre) {
      filtrosBase.push({ nombre: new RegExp(nombre, "i") });
    }

    if (entidad) filtrosBase.push({ entidadId: entidad });
    if (subCesion) filtrosBase.push({ subCesionId: subCesion });

    if (diaDesde !== undefined || diaHasta !== undefined) {
      const desde = Math.max(1, Math.min(parseInt(diaDesde) || 1, 31));
      const hasta = Math.max(1, Math.min(parseInt(diaHasta) || 31, 31));
      if (desde <= hasta) {
        filtrosBase.push({ vencimiento: { $gte: desde, $lte: hasta } });
      }
    }

    // 🎯 Filtro: cuotas sin gestión
    if (sinGestion === "true") {
      filtrosBase.push({ vecesTocada: { $lte: 0 } });
    }

    // 💬 Filtro: cuotas con pagos informados no vistos
    if (conPagosNoVistos === "true") {
      filtrosBase.push({ "pagosInformados.visto": false });
    }

    const baseQuery = filtrosBase.length ? { $and: filtrosBase } : {};

    // 📦 Obtener todas las cuotas coincidentes sin paginación
    const cuotasBrutas = await Colchon.find(baseQuery)
      .populate("empleadoId", "username _id")
      .populate("entidadId", "nombre")
      .populate("subCesionId", "nombre")
      .populate("pagosInformados.operadorId", "username _id")
      .lean();

    // 🧠 Calcular estado dinámico
    const cuotasConEstado = cuotasBrutas.map((cuota) => {
      const estadoBase = cuota.estadoOriginal || cuota.estado;
      const estadoFinal = cuota.pagos?.length > 0 ? "A cuota" : estadoBase;
      return {
        ...cuota,
        estado: estadoFinal,
        alertaDeuda:
          estadoFinal === "A cuota" &&
          cuota.saldoPendiente > (cuota.importeCuota || 0),
      };
    });

    // 🎯 Aplicar filtro por estado si corresponde
    const cuotasFiltradas = estado
      ? cuotasConEstado.filter((c) => c.estado === estado)
      : cuotasConEstado;

    const totalFiltrado = cuotasFiltradas.length;

    // ✂️ Aplicar paginación manual
    const pageNumber = parseInt(page);
    const pageLimit = parseInt(limit);
    const skip = (pageNumber - 1) * pageLimit;
    const sortField = sortBy.trim() || "vencimiento";
    const sortDir = sortDirection === "desc" ? -1 : 1;

    const resultados = cuotasFiltradas
      .sort((a, b) => {
        const aVal = a[sortField];
        const bVal = b[sortField];
        if (aVal < bVal) return -1 * sortDir;
        if (aVal > bVal) return 1 * sortDir;
        return 0;
      })
      .slice(skip, skip + pageLimit);

    // 🧮 Calcular totalGeneral sin filtros, solo por operador
    const filtroGeneral =
      rol !== "super-admin"
        ? { empleadoId: req.user.id }
        : usuarioId
        ? { empleadoId: usuarioId }
        : {};

    const totalGeneral = await Colchon.countDocuments(filtroGeneral);

    res.json({
      resultados,
      totalFiltrado,
      totalGeneral,
    });
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

    const encabezadosEsperados = [
      "ESTADO",
      "ENTIDAD",
      "DNI",
      "NOMBRE Y APELLIDO",
      "OPERADOR",
      "TURNO",
      "CARTERA",
      "VTO CUO",
      "C/CUOTAS",
      "$CUOTA",
      "TELÉFONO",
    ];

    const encabezadosArchivo = worksheet
      .getRow(1)
      .values.slice(1)
      .map((v) => String(v).trim().toUpperCase());

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

      const estado = (row.getCell(1).value || "").toString().trim();
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
      if (!cartera) motivos.push("Falta CARTERA");
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

    for (const fila of filasValidas) {
      try {
        const idCuotaLogico = `${fila.dni}-${fila.entidad._id}`;
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
            idCuotaLogico,
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
          nueva.alertaDeuda =
            nueva.estado === "A cuota" &&
            nueva.saldoPendiente > nueva.importeCuota;
          await nueva.save();
          insertadas++;
        }
      } catch (err) {
        filasConErrores.push([
          ...fila.filaExcel,
          err.message || "Error desconocido",
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
    } = req.query;

    const rol = req.user.role || req.user.rol;
    const filtros = [];

    // 🔐 Filtro por rol
    if (rol === "operador") {
      filtros.push({ empleadoId: req.user.id });
    } else if (usuarioId) {
      filtros.push({ empleadoId: usuarioId });
    }

    // 🎯 Filtros opcionales
    if (dni) {
      const dniParsed = parseInt(dni);
      if (!isNaN(dniParsed)) filtros.push({ dni: dniParsed });
    }

    if (nombre) {
      filtros.push({ nombre: new RegExp(nombre, "i") });
    }

    if (entidad) filtros.push({ entidadId: entidad });
    if (subCesion) filtros.push({ subCesionId: subCesion });

    // 📆 Filtro por día del mes
    if (diaDesde || diaHasta) {
      const desde = Math.max(1, Math.min(parseInt(diaDesde) || 1, 31));
      const hasta = Math.max(1, Math.min(parseInt(diaHasta) || 31, 31));
      if (desde <= hasta) {
        filtros.push({ vencimiento: { $gte: desde, $lte: hasta } });
      }
    }

    const query = filtros.length ? { $and: filtros } : {};

    // 🗃️ Buscar cuotas
    let cuotas = await Colchon.find(query)
      .populate("empleadoId", "username")
      .populate("entidadId", "numero nombre")
      .populate("subCesionId", "nombre")
      .lean();

    // 🧠 Calcular estado final
    cuotas = cuotas.map((cuota) => {
      const estadoBase = cuota.estadoOriginal || cuota.estado;
      const estadoFinal = cuota.pagos?.length > 0 ? "A cuota" : estadoBase;
      return {
        ...cuota,
        estado: estadoFinal,
      };
    });

    // 🎯 Filtro final por estado
    if (estado) {
      cuotas = cuotas.filter((c) => c.estado === estado);
    }

    // 🧾 Crear Excel
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Colchón");

    worksheet.columns = [
      { header: "Estado", key: "estado", width: 15 },
      { header: "Entidad", key: "entidad", width: 25 },
      { header: "SubCesión", key: "subCesion", width: 25 },
      { header: "DNI", key: "dni", width: 15 },
      { header: "Titular", key: "nombre", width: 25 },
      { header: "Operador", key: "operador", width: 20 },
      { header: "Turno", key: "turno", width: 10 },
      { header: "Cartera", key: "cartera", width: 15 },
      { header: "Vencimiento", key: "vencimiento", width: 12 },
      { header: "C/Cuotas", key: "cuotaNumero", width: 12 },
      { header: "$ Cuota", key: "importeCuota", width: 12 },
      { header: "$ DEBE", key: "saldoPendiente", width: 12 },
      { header: "Teléfono", key: "telefono", width: 20 }, // ✅ NUEVO
    ];

    cuotas.forEach((cuota) => {
      worksheet.addRow({
        estado: cuota.estado,
        entidad: cuota.entidadId
          ? `${cuota.entidadId.numero} - ${cuota.entidadId.nombre}`
          : "—",
        subCesion: cuota.subCesionId?.nombre || "—",
        dni: cuota.dni,
        nombre: cuota.nombre,
        operador:
          typeof cuota.empleadoId === "object"
            ? cuota.empleadoId.username
            : "—",
        turno: cuota.turno || "",
        cartera: cuota.cartera || "",
        vencimiento: cuota.vencimiento || "",
        cuotaNumero: cuota.cuotaNumero || "",
        importeCuota: cuota.importeCuota || 0,
        saldoPendiente: cuota.saldoPendiente || 0,
        telefono: cuota.telefono || "", // ✅ NUEVO
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=colchon-exportado.xlsx"
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

    const cuota = await Colchon.findById(id);
    if (!cuota) return res.status(404).json({ error: "Cuota no encontrada" });

    cuota.pagos.push({ monto, fecha });

    // Recalcular el saldo pendiente
    const totalPagado = cuota.pagos.reduce((sum, p) => sum + p.monto, 0);
    cuota.saldoPendiente = Math.max(cuota.importeCuota - totalPagado, 0);

    await cuota.save();
    res.json({ mensaje: "Pago agregado correctamente", cuota });
  } catch (error) {
    console.error("❌ Error al agregar pago:", error);
    res.status(500).json({ error: "Error al agregar pago" });
  }
};

export const informarPago = async (req, res) => {
  try {
    const { id } = req.params;
    const { monto, fecha } = req.body;

    const user = req.user; // ✅ obtenemos el usuario desde middleware
    const cuota = await Colchon.findById(id);
    if (!cuota) return res.status(404).json({ error: "Cuota no encontrada" });

    if (user.rol === "super-admin" || user.rol === "admin") {
      // ✅ ADMIN: pago real
      cuota.pagos.push({ monto, fecha });

      // Recalcular el saldo
      const totalPagado = cuota.pagos.reduce((sum, p) => sum + p.monto, 0);
      cuota.saldoPendiente = Math.max(cuota.importeCuota - totalPagado, 0);
    } else {
      // ✅ OPERADOR: solo informa pago, no se descuenta ni aparece como real
      cuota.pagosInformados.push({
        monto,
        fecha,
        visto: false,
        erroneo: false,
        operadorId: user.id,
      });
    }

    await cuota.save();
    res.json({ mensaje: "Pago informado correctamente", cuota });
  } catch (error) {
    console.error("❌ Error al informar pago:", error);
    res.status(500).json({ error: "Error al informar pago" });
  }
};

export const marcarPagoInformadoComoVisto = async (req, res) => {
  try {
    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin" && rol !== "admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { id, pagoId } = req.params;

    const cuota = await Colchon.findById(id);
    if (!cuota) return res.status(404).json({ error: "Cuota no encontrada" });

    const pagoInformado = cuota.pagosInformados.id(pagoId);
    if (!pagoInformado) {
      return res.status(404).json({ error: "Pago informado no encontrado" });
    }

    // ✅ Marcar como visto
    pagoInformado.visto = true;
    cuota.ultimaModificacion = new Date();

    // ✅ Recalcular deuda y estado visual
    const estadoBase = cuota.estadoOriginal || cuota.estado;
    cuota.estado = estadoBase;

    actualizarDeudaPorMes(cuota);

    cuota.saldoPendiente = cuota.deudaPorMes.reduce(
      (acc, d) => acc + (d.montoAdeudado || 0),
      0
    );

    if (cuota.pagos?.length > 0) {
      cuota.estado = "A cuota";
    } else {
      cuota.estado = estadoBase;
    }

    cuota.alertaDeuda =
      cuota.estado === "A cuota" &&
      cuota.saldoPendiente > (cuota.importeCuota || 0);

    await cuota.save();

    res.json({
      message: "Pago marcado como visto correctamente.",
    });
  } catch (error) {
    console.error("❌ Error al marcar pago informado como visto:", error);
    res.status(500).json({ error: "Error al confirmar pago informado" });
  }
};

export const obtenerPagosInformadosPendientes = async (req, res) => {
  try {
    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin" && rol !== "admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

    // Buscar todas las cuotas que tengan al menos un pagoInformado no visto
    const cuotasConPagosPendientes = await Colchon.find({
      "pagosInformados.visto": false,
    })
      .populate("pagosInformados.operadorId", "username _id") // <== CAMBIÁS ESTA
      .select("dni nombre entidadId pagosInformados");

    // Mapear resultados para mostrar solo los pagos no vistos
    const resultados = cuotasConPagosPendientes.map((cuota) => {
      return {
        cuotaId: cuota._id,
        dni: cuota.dni,
        nombre: cuota.nombre,
        entidadId: cuota.entidadId,
        pagosPendientes: cuota.pagosInformados.filter((pago) => !pago.visto),
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

// 🔁 Actualiza deudaPorMes y saldoPendiente acumulado
export const actualizarDeudaPorMes = (cuota) => {
  const hoy = new Date();
  const anioActual = hoy.getFullYear();
  const mesActual = hoy.getMonth() + 1;

  const importeCuota = cuota.importeCuota || 0;

  const mesesAdeudadosPorEstado = {
    "Cuota 30": 2,
    "Cuota 60": 3,
    "Cuota 90": 4,
    Caída: 5,
  };

  // ⚠️ Este es el fix importante
  const estadoBase = cuota.estadoOriginal || cuota.estado;
  const cantidadMeses = mesesAdeudadosPorEstado[estadoBase] || 1;

  const deudaPorMes = [];
  for (let i = cantidadMeses - 1; i >= 0; i--) {
    const fecha = new Date(anioActual, mesActual - 1 - i);
    const mes = (fecha.getMonth() + 1).toString();
    const anio = fecha.getFullYear();
    deudaPorMes.push({
      mes,
      anio,
      montoAdeudado: importeCuota,
    });
  }

  let totalPagado = cuota.pagos?.reduce((acc, p) => acc + p.monto, 0) || 0;

  for (let i = 0; i < deudaPorMes.length; i++) {
    if (totalPagado <= 0) break;
    const deudaMes = deudaPorMes[i].montoAdeudado;
    const aPagar = Math.min(deudaMes, totalPagado);
    deudaPorMes[i].montoAdeudado = parseFloat((deudaMes - aPagar).toFixed(2));
    totalPagado -= aPagar;
  }

  cuota.deudaPorMes = deudaPorMes;

  // 💰 Calcular saldo pendiente
  cuota.saldoPendiente = parseFloat(
    deudaPorMes.reduce((acc, d) => acc + d.montoAdeudado, 0).toFixed(2)
  );

  // ❗ Agregar alerta si el saldo pendiente es mayor al valor de una cuota
  cuota.alertaDeuda = cuota.saldoPendiente > importeCuota;

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
    if (
      req.user.role === "operador" &&
      pago.operadorId.toString() !== req.user.id
    ) {
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

    // Solo admin o super-admin puede marcar como visto
    if (!["admin", "super-admin"].includes(req.user.role)) {
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
      colchon.estado === "A cuota" &&
      colchon.saldoPendiente > (colchon.importeCuota || 0);

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
      req.user.role === "operador" &&
      (pago.operadorId.toString() !== req.user.id || pago.visto)
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
    if (rol !== "super-admin" && rol !== "admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

    const cuota = await Colchon.findById(cuotaId);
    if (!cuota) return res.status(404).json({ error: "Cuota no encontrada" });

    const index = cuota.pagos.findIndex((p) => p._id.toString() === pagoId);
    if (index === -1) {
      return res.status(404).json({ error: "Pago no encontrado" });
    }

    // 👉 Eliminar el pago
    cuota.pagos.splice(index, 1);
    cuota.ultimaModificacion = new Date();

    // 👉 Usar el estado original (manual/importado) si existe
    const estadoBase = cuota.estadoOriginal || cuota.estado;
    cuota.estado = estadoBase;

    // 👉 Recalcular deuda respetando ese estado
    actualizarDeudaPorMes(cuota);

    // 👉 Calcular nuevo saldo pendiente
    cuota.saldoPendiente = cuota.deudaPorMes.reduce(
      (acc, d) => acc + (d.montoAdeudado || 0),
      0
    );

    // 👉 Estado visual: "A cuota" si quedan pagos, sino volver al original
    if (cuota.pagos.length > 0) {
      cuota.estado = "A cuota";
    } else {
      cuota.estado = estadoBase;
    }

    // 👉 Control de alerta si hay deuda mayor a una cuota
    cuota.alertaDeuda =
      cuota.estado === "A cuota" &&
      cuota.saldoPendiente > (cuota.importeCuota || 0);

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
      { header: "CARTERA", key: "cartera", width: 20 },
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

// 🧹 Limpiar una cuota (pagos + observaciones)
export const limpiarCuota = async (req, res) => {
  try {
    const rol = req.user.role || req.user.rol;

    if (rol !== "super-admin" && rol !== "admin") {
      return res
        .status(403)
        .json({ error: "No autorizado para limpiar cuotas" });
    }

    const { id } = req.params;

    const cuota = await Colchon.findById(id);
    if (!cuota) return res.status(404).json({ error: "Cuota no encontrada" });

    // 🧹 Limpiar campos
    cuota.pagos = [];
    cuota.pagosInformados = [];
    cuota.observaciones = "";
    cuota.observacionesOperador = "";

    // 🛠️ Recalcular deuda según estado original
    const estadoBase = cuota.estadoOriginal || cuota.estado;
    cuota.estado = estadoBase;

    actualizarDeudaPorMes(cuota);

    // 🧮 Recalcular saldo
    cuota.saldoPendiente = cuota.deudaPorMes.reduce(
      (acc, d) => acc + (d.montoAdeudado || 0),
      0
    );

    // 👁️ Estado visual queda como "A cuota"
    cuota.estado = "A cuota";

    // ⚠️ Mostrar alerta si la deuda supera 1 cuota
    cuota.alertaDeuda =
      cuota.estado === "A cuota" &&
      cuota.saldoPendiente > (cuota.importeCuota || 0);

    cuota.ultimaModificacion = new Date();
    await cuota.save();

    res.json({ message: "Cuota limpiada correctamente" });
  } catch (error) {
    console.error("❌ Error al limpiar cuota:", error);
    res.status(500).json({ error: "Error al limpiar cuota" });
  }
};

// 📥 Importar pagos desde Excel
export const importarPagosDesdeExcel = async (req, res) => {
  try {
    const rol = req.user.role || req.user.rol;
    if (rol !== "super-admin" && rol !== "admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No se recibió archivo" });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];

    const encabezadosEsperados = ["dni", "entidad", "monto", "fecha"];
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
          "Encabezados incorrectos. Se esperan: dni, entidad, monto, fecha",
      });
    }

    const resultados = {
      procesados: 0,
      agregados: 0,
      duplicados: 0,
      errores: [],
    };

    const erroresExcel = [];

    for (let i = 2; i <= worksheet.rowCount; i++) {
      const row = worksheet.getRow(i);
      try {
        const dni = parseInt(row.getCell(1).value);
        const entidadNumero = parseInt(row.getCell(2).value);
        const monto = parseFloat(row.getCell(3).value);

        let fechaPagoRaw = row.getCell(4).value;
        let fechaPago;

        if (fechaPagoRaw instanceof Date) {
          fechaPago = fechaPagoRaw;
        } else if (typeof fechaPagoRaw === "string") {
          const partes = fechaPagoRaw.trim().split("/");
          if (partes.length === 3) {
            const [dd, mm, yyyy] = partes;
            fechaPago = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
          }
        }

        if (
          !dni ||
          !entidadNumero ||
          !fechaPago ||
          !monto ||
          isNaN(fechaPago.getTime())
        ) {
          erroresExcel.push({
            dni,
            entidad: entidadNumero,
            monto,
            fecha: fechaPagoRaw,
            motivo: "Datos incompletos o inválidos",
          });
          resultados.errores.push({ fila: i, motivo: "Datos incompletos" });
          continue;
        }

        const entidad = await Entidad.findOne({ numero: entidadNumero });
        if (!entidad) {
          erroresExcel.push({
            dni,
            entidad: entidadNumero,
            monto,
            fecha: fechaPagoRaw,
            motivo: `Entidad ${entidadNumero} no existe`,
          });
          resultados.errores.push({ fila: i, motivo: "Entidad inexistente" });
          continue;
        }

        const idCuotaLogico = `${dni}-${entidad._id}`;
        const cuota = await Colchon.findOne({ idCuotaLogico });
        if (!cuota) {
          erroresExcel.push({
            dni,
            entidad: entidadNumero,
            monto,
            fecha: fechaPagoRaw,
            motivo: "Cuota no encontrada",
          });
          resultados.errores.push({ fila: i, motivo: "Cuota no encontrada" });
          continue;
        }

        const yaExiste = cuota.pagos.some(
          (p) =>
            new Date(p.fecha).toISOString() === fechaPago.toISOString() &&
            parseFloat(p.monto) === parseFloat(monto)
        );

        if (yaExiste) {
          erroresExcel.push({
            dni,
            entidad: entidadNumero,
            monto,
            fecha: fechaPagoRaw,
            motivo: "Pago duplicado",
          });
          resultados.duplicados++;
        } else {
          cuota.pagos.push({ fecha: fechaPago, monto });

          const estadoBase = cuota.estadoOriginal || cuota.estado;
          cuota.estado = estadoBase;

          actualizarDeudaPorMes(cuota);
          cuota.saldoPendiente = cuota.deudaPorMes.reduce(
            (acc, d) => acc + (d.montoAdeudado || 0),
            0
          );

          cuota.estado = "A cuota";
          cuota.alertaDeuda =
            cuota.estado === "A cuota" &&
            cuota.saldoPendiente > (cuota.importeCuota || 0);

          cuota.ultimaModificacion = new Date();

          await cuota.save();
          resultados.agregados++;
        }

        resultados.procesados++;
      } catch (filaError) {
        erroresExcel.push({
          dni: "",
          entidad: "",
          monto: "",
          fecha: "",
          motivo: filaError.message || "Error inesperado",
        });
        resultados.errores.push({ fila: i, motivo: filaError.message });
      }
    }

    // ✅ Si hubo errores o duplicados → generar archivo para descargar
    if (erroresExcel.length > 0) {
      const erroresWb = new ExcelJS.Workbook();
      const erroresWs = erroresWb.addWorksheet("Pagos con errores");

      erroresWs.columns = [
        { header: "dni", key: "dni", width: 15 },
        { header: "entidad", key: "entidad", width: 10 },
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

// Descargar modelo de pagos para importar
export const descargarModeloPagos = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("ModeloPagos");

    worksheet.columns = [
      { header: "dni", key: "dni", width: 20 },
      { header: "entidad", key: "entidad", width: 30 },
      { header: "monto", key: "monto", width: 15 },
      { header: "fecha", key: "fecha", width: 20 },
    ];

    worksheet.addRow({
      dni: "30123456",
      entidad: "1",
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

// 📤 Exportar todos los pagos a Excel
export const exportarPagos = async (req, res) => {
  try {
    const rol = req.user.role || req.user.rol;
    const usuarioId = req.user.id;

    // Si es operador, solo ve sus cuotas
    const filtro = { pagos: { $exists: true, $not: { $size: 0 } } };
    if (rol === "operador") {
      filtro["empleadoId"] = usuarioId;
    }

    // Usamos entidadId porque así está en el schema
    const cuotas = await Colchon.find(filtro)
      .populate("entidadId", "nombre numero") // ✅ trae número y nombre
      .lean();

    const pagosExportar = [];

    cuotas.forEach((cuota) => {
      const dni = cuota.dni || "";
      const entidad = cuota.entidadId?.numero || "—";

      cuota.pagos.forEach((pago) => {
        pagosExportar.push({
          dni,
          entidad,
          monto: pago.monto,
          fecha: pago.fecha
            ? new Date(pago.fecha).toLocaleDateString("es-AR")
            : "",
        });
      });
    });

    // Importamos ExcelJS correctamente
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Pagos");

    worksheet.columns = [
      { header: "dni", key: "dni", width: 15 },
      { header: "entidad", key: "entidad", width: 15 },
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
    } = req.query;

    const rol = req.user.role || req.user.rol;
    const filtrosBase = [];

    // Filtro por usuario (seguridad)
    if (rol !== "super-admin") {
      filtrosBase.push({ empleadoId: req.user.id });
    } else if (usuarioId) {
      filtrosBase.push({ empleadoId: usuarioId });
    }

    // Filtros opcionales
    if (dni) {
      const dniParsed = parseInt(dni);
      if (!isNaN(dniParsed)) filtrosBase.push({ dni: dniParsed });
    }

    if (nombre) {
      filtrosBase.push({ nombre: new RegExp(nombre, "i") });
    }

    if (entidad) filtrosBase.push({ entidadId: entidad });
    if (subCesion) filtrosBase.push({ subCesionId: subCesion });

    if (diaDesde !== undefined || diaHasta !== undefined) {
      const desde = Math.max(1, Math.min(parseInt(diaDesde) || 1, 31));
      const hasta = Math.max(1, Math.min(parseInt(diaHasta) || 31, 31));
      if (desde <= hasta) {
        filtrosBase.push({ vencimiento: { $gte: desde, $lte: hasta } });
      }
    }

    const baseQuery = filtrosBase.length ? { $and: filtrosBase } : {};

    const cuotasBrutas = await Colchon.find(baseQuery)
      .populate("empleadoId", "username")
      .populate("entidadId", "nombre")
      .lean();

    const hoy = new Date();
    const mesActual = hoy.getMonth();
    const anioActual = hoy.getFullYear();

    let totalCuotas = 0;
    let totalImporte = 0;
    let totalSaldo = 0;
    let cuotasPagadas = 0;
    let totalPagadoCuotas = 0;

    const estadoStats = {};
    const pagosPorDia = {};
    const rankingEntidad = {};
    const rankingCartera = {};
    const rankingOperadores = {};

    const cuotasFiltradas = cuotasBrutas.map((cuota) => {
      const estadoBase = cuota.estadoOriginal || cuota.estado;
      const estadoFinal = cuota.pagos?.length > 0 ? "A cuota" : estadoBase;
      return {
        ...cuota,
        estado: estadoFinal,
        alertaDeuda:
          estadoFinal === "A cuota" &&
          cuota.saldoPendiente > (cuota.importeCuota || 0),
      };
    });

    const cuotas = estado
      ? cuotasFiltradas.filter((c) => c.estado === estado)
      : cuotasFiltradas;

    for (const cuota of cuotas) {
      totalCuotas += 1;
      totalImporte += cuota.importeCuota || 0;
      totalSaldo += cuota.saldoPendiente || 0;

      const pagos = cuota.pagos || [];
      const pagado = pagos.reduce((sum, p) => sum + p.monto, 0);
      const pagosMesActual = pagos.filter((p) => {
        const f = new Date(p.fecha);
        return f.getMonth() === mesActual && f.getFullYear() === anioActual;
      });
      const pagadoMesActual = pagosMesActual.reduce(
        (sum, p) => sum + p.monto,
        0
      );

      const estadoVisual = cuota.estado || "Desconocido";
      estadoStats[estadoVisual] = (estadoStats[estadoVisual] || 0) + 1;

      if (cuota.pagos?.length > 0) {
        cuotasPagadas += 1;
      }
      totalPagadoCuotas += pagado;

      for (const pago of pagosMesActual) {
        const dia = new Date(pago.fecha).getDate();

        if (!pagosPorDia[dia]) {
          pagosPorDia[dia] = { cantidadPagos: 0, totalPagado: 0 };
        }

        pagosPorDia[dia].cantidadPagos += 1;
        pagosPorDia[dia].totalPagado += pago.monto;
      }

      const entidad = cuota.entidadId?.nombre || "Sin entidad";
      if (!rankingEntidad[entidad]) {
        rankingEntidad[entidad] = { asignado: 0, cobrado: 0, pagos: 0 };
      }
      rankingEntidad[entidad].asignado += cuota.importeCuota || 0;
      rankingEntidad[entidad].cobrado += pagado;
      rankingEntidad[entidad].pagos += pagos.length;

      const cartera = cuota.cartera || "Sin cartera";
      if (!rankingCartera[cartera]) {
        rankingCartera[cartera] = { asignado: 0, cobrado: 0, pagos: 0 };
      }
      rankingCartera[cartera].asignado += cuota.importeCuota || 0;
      rankingCartera[cartera].cobrado += pagado;
      rankingCartera[cartera].pagos += pagos.length;

      const operador = cuota.empleadoId?.username || "Sin asignar";
      if (!rankingOperadores[operador]) {
        rankingOperadores[operador] = { asignado: 0, cobrado: 0 };
      }
      rankingOperadores[operador].asignado += cuota.importeCuota || 0;
      rankingOperadores[operador].cobrado += pagadoMesActual;
    }

    // Convertir rankings a arrays
    const rankingEntidadArray = Object.entries(rankingEntidad).map(
      ([entidad, val]) => ({
        entidad,
        asignado: val.asignado,
        cobrado: val.cobrado,
        porcentaje: val.asignado
          ? Math.round((val.cobrado / val.asignado) * 100)
          : 0,
        pagos: val.pagos,
      })
    );

    const rankingCarteraArray = Object.entries(rankingCartera).map(
      ([cartera, val]) => ({
        cartera,
        asignado: val.asignado,
        cobrado: val.cobrado,
        porcentaje: val.asignado
          ? Math.round((val.cobrado / val.asignado) * 100)
          : 0,
        pagos: val.pagos,
      })
    );

    const rankingOperadoresArray = Object.entries(rankingOperadores).map(
      ([operador, val]) => ({
        operador,
        asignado: val.asignado,
        pagado: val.cobrado,
        porcentaje: val.asignado
          ? Math.round((val.cobrado / val.asignado) * 100)
          : 0,
      })
    );

    // ✅ ¡ESTE ES EL CAMBIO CLAVE! Valores por defecto seguros para el frontend
    res.json({
      totalCuotas: totalCuotas || 0,
      totalImporte: totalImporte || 0,
      totalSaldo: totalSaldo || 0,
      cuotasPagadas: {
        cantidad: cuotasPagadas || 0,
        totalPagado: totalPagadoCuotas || 0,
      },
      estadoStats: estadoStats || {},
      pagosPorDia: pagosPorDia || {},
      rankingEntidad: rankingEntidadArray || [],
      rankingCartera: rankingCarteraArray || [],
      rankingOperadores: rankingOperadoresArray || [],
    });
  } catch (error) {
    console.error("❌ Error en obtenerEstadisticasColchon:", error);
    res
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
      .populate("subCesionId");
    if (!cuota) {
      return res.status(404).json({ error: "Cuota no encontrada" });
    }

    res.json(cuota);
  } catch (error) {
    console.error("❌ Error interno:", error);
    res.status(500).json({ error: "Error al obtener cuota" });
  }
};

export const registrarGestionCuota = async (req, res) => {
  try {
    const cuota = await Colchon.findById(req.params.id);
    if (!cuota) return res.status(404).json({ error: "Cuota no encontrada" });

    cuota.vecesTocada = (cuota.vecesTocada || 0) + 1;
    cuota.ultimaGestion = new Date();

    await cuota.save();

    const cuotaActualizada = await Colchon.findById(req.params.id).lean();

    res.json({
      mensaje: "Gestión registrada exitosamente",
      cuota: cuotaActualizada,
    });
  } catch (error) {
    console.error("Error al registrar gestión:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
};
