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
    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso al módulo Colchón" });
    }
    if (esOperativo(req)) {
      filtrosBase.push({ empleadoId: req.user.id });
    } else if (usuarioId) {
      filtrosBase.push({ empleadoId: usuarioId });
    }

    // 🔍 Filtro por DNI
    if (dni) {
      const dniParsed = parseInt(dni, 10);
      if (!isNaN(dniParsed)) filtrosBase.push({ dni: dniParsed });
    }

    // 🔍 Filtro por nombre parcial
    if (nombre) {
      filtrosBase.push({ nombre: new RegExp(nombre, "i") });
    }

    // 🔍 Filtros por entidad y subCesión — usamos ObjectId para que funcione siempre
    if (entidad && mongoose.Types.ObjectId.isValid(entidad)) {
      filtrosBase.push({ entidadId: new mongoose.Types.ObjectId(entidad) });
    }
    if (subCesion && mongoose.Types.ObjectId.isValid(subCesion)) {
      filtrosBase.push({ subCesionId: new mongoose.Types.ObjectId(subCesion) });
    }

    // 📅 Filtro por rango de vencimiento (día del mes)
    if (diaDesde !== undefined || diaHasta !== undefined) {
      const desde = Math.max(1, Math.min(parseInt(diaDesde || 1, 10), 31));
      const hasta = Math.max(1, Math.min(parseInt(diaHasta || 31, 10), 31));
      if (desde <= hasta) {
        filtrosBase.push({ vencimiento: { $gte: desde, $lte: hasta } });
      }
    }

    // 🎯 Filtro: cuotas sin gestión
    if (sinGestion === "true") {
      filtrosBase.push({
        $or: [
          { vecesTocada: { $exists: false } },
          { vecesTocada: null },
          { vecesTocada: { $lte: 0 } },
        ],
      });
    }

    // 💬 Filtro: cuotas con pagos informados no vistos
    if (conPagosNoVistos === "true") {
      filtrosBase.push({ "pagosInformados.visto": false });
    }

    // 🧩 Construcción de la query final
    const baseQuery = filtrosBase.length ? { $and: filtrosBase } : {};

    // 📦 Buscar cuotas
    const cuotasBrutas = await Colchon.find(baseQuery)
      .populate("empleadoId", "username _id")
      .populate("entidadId", "nombre numero")
      .populate("subCesionId", "nombre")
      .populate("pagosInformados.operadorId", "username _id")
      .lean();

    // 🧠 Calcular estado dinámico
    const cuotasConEstado = cuotasBrutas.map((cuota) => {
      const estadoBase = cuota.estadoOriginal || cuota.estado;
      const estadoFinal =
        (cuota.pagos?.length ?? 0) > 0 ? "A cuota" : estadoBase;

      // calcular cuotas adeudadas sin helpers
      const cuotasAdeudadas =
        Array.isArray(cuota.deudaPorMes) && cuota.deudaPorMes.length
          ? cuota.deudaPorMes.filter((m) => Number(m.montoAdeudado || 0) > 0)
              .length
          : (() => {
              const imp = Number(cuota.importeCuota) || 0;
              const saldo = Number(cuota.saldoPendiente) || 0;
              return imp > 0 ? Math.floor(saldo / imp) : 0;
            })();

      return {
        ...cuota,
        estado: estadoFinal,
        alertaDeuda: estadoFinal === "A cuota" && cuotasAdeudadas > 1,
      };
    });

    // 🎯 Filtro por estado, si se especifica
    const cuotasFiltradas = estado
      ? cuotasConEstado.filter((c) => c.estado === estado)
      : cuotasConEstado;

    const totalFiltrado = cuotasFiltradas.length;

    // ✂️ Paginación + ordenación en memoria
    const pageNumber = parseInt(page, 10);
    const pageLimit = parseInt(limit, 10);
    const skip = (pageNumber - 1) * pageLimit;
    const sortField = (sortBy || "vencimiento").trim();
    const sortDir = sortDirection === "desc" ? -1 : 1;

    const getSortValue = (item, field) => {
      if (field === "entidadId") return item.entidadId?.nombre ?? "";
      if (field === "empleadoId") return item.empleadoId?.username ?? "";
      return item[field];
    };

    const resultados = cuotasFiltradas
      .sort((a, b) => {
        const aVal = getSortValue(a, sortField);
        const bVal = getSortValue(b, sortField);

        // undefined/null al final
        const aU = aVal === undefined || aVal === null;
        const bU = bVal === undefined || bVal === null;
        if (aU && bU) return 0;
        if (aU) return 1;
        if (bU) return -1;

        // strings vs números
        if (typeof aVal === "string" && typeof bVal === "string") {
          const cmp = aVal.localeCompare(bVal, "es", { sensitivity: "base" });
          return sortDir === 1 ? cmp : -cmp;
        }

        const aNum = Number(aVal);
        const bNum = Number(bVal);
        if (!isNaN(aNum) && !isNaN(bNum)) {
          return sortDir === 1 ? aNum - bNum : bNum - aNum;
        }

        // fallback genérico
        if (aVal < bVal) return -1 * sortDir;
        if (aVal > bVal) return 1 * sortDir;
        return 0;
      })
      .slice(skip, skip + pageLimit);

    // 🧮 totalGeneral (según rol)
    const filtroGeneral =
      rol === "operador"
        ? { empleadoId: req.user.id }
        : usuarioId
        ? { empleadoId: usuarioId }
        : {};

    const totalGeneral = await Colchon.countDocuments(filtroGeneral);

    // 📤 Respuesta final
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
    } = req.query;

    const rol = req.user.role || req.user.rol;
    const filtros = [];

    // 🔐 Filtro por rol
    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso a exportación" });
    }
    if (esOperativo(req)) {
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
      { header: "Vencimiento", key: "vencimiento", width: 12 },
      { header: "C/Cuotas", key: "cuotaNumero", width: 12 },
      { header: "$ Cuota", key: "importeCuota", width: 12 },
      { header: "$ DEBE", key: "saldoPendiente", width: 12 },
      { header: "Teléfono", key: "telefono", width: 20 },
      { header: "Gestiones", key: "gestiones", width: 30 }, // 🟡 Nuevo campo
    ];

    cuotas.forEach((cuota) => {
      const vecesTocada = cuota?.vecesTocada || 0;
      const ultimaFecha = cuota?.fechaUltimaTocada
        ? new Date(cuota.fechaUltimaTocada).toLocaleDateString("es-AR")
        : "—";
      const nombreUltimo = cuota?.usuarioUltimoTocado?.username || "—";

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
        telefono: cuota.telefono || "",
        gestiones: `${vecesTocada}`,
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
    cuota.pagos.push({ monto: montoNum, fecha: fechaObj });

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
      cuota.pagos.push({ monto: montoNum, fecha: fechaObj });

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
          cuota.pagos.push({ fecha: fechaPago, monto });

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
    } = req.query;

    const rol = req.user.role || req.user.rol;
    const filtrosBase = [];

    // Filtro por usuario (seguridad)
    if (esAdmin(req)) {
      return res.status(403).json({ error: "Sin acceso a estadísticas" });
    }
    if (!esSuper(req)) {
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
    const rankingOperadores = {}; // ← ahora tendrá totales + porEstado

    const cuotasFiltradas = cuotasBrutas.map((cuota) => {
      const estadoBase = cuota.estadoOriginal || cuota.estado;
      const estadoFinal = cuota.pagos?.length > 0 ? "A cuota" : estadoBase;
      return {
        ...cuota,
        estado: estadoFinal,
        alertaDeuda: estadoFinal === "A cuota" && cuota.saldoPendiente > 0,
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

      const entidadNom = cuota.entidadId?.nombre || "Sin entidad";
      if (!rankingEntidad[entidadNom]) {
        rankingEntidad[entidadNom] = { asignado: 0, cobrado: 0, pagos: 0 };
      }
      rankingEntidad[entidadNom].asignado += cuota.importeCuota || 0;
      rankingEntidad[entidadNom].cobrado += pagado;
      rankingEntidad[entidadNom].pagos += pagos.length;

      const carteraNom = cuota.cartera || "Sin subcesión";
      if (!rankingCartera[carteraNom]) {
        rankingCartera[carteraNom] = { asignado: 0, cobrado: 0, pagos: 0 };
      }
      rankingCartera[carteraNom].asignado += cuota.importeCuota || 0;
      rankingCartera[carteraNom].cobrado += pagado;
      rankingCartera[carteraNom].pagos += pagos.length;

      // ====== RANKING POR OPERADOR (con desglose por estado) ======
      const operador = cuota.empleadoId?.username || "Sin asignar";
      const estadoFinal = cuota.estado || "Desconocido";

      if (!rankingOperadores[operador]) {
        rankingOperadores[operador] = {
          total: { asignado: 0, pagado: 0, porcentaje: 0 },
          porEstado: {}, // { "A cuota": {cantidad, asignado, pagado, porcentaje}, ... }
        };
      }

      // Totales por operador (pagado = del mes actual)
      rankingOperadores[operador].total.asignado += cuota.importeCuota || 0;
      rankingOperadores[operador].total.pagado += pagadoMesActual;

      // Desglose por estado
      if (!rankingOperadores[operador].porEstado[estadoFinal]) {
        rankingOperadores[operador].porEstado[estadoFinal] = {
          cantidad: 0,
          asignado: 0,
          pagado: 0,
          porcentaje: 0,
        };
      }
      const nodoEstado = rankingOperadores[operador].porEstado[estadoFinal];
      nodoEstado.cantidad += 1;
      nodoEstado.asignado += cuota.importeCuota || 0;
      nodoEstado.pagado += pagadoMesActual;
    }

    // Convertir rankings a arrays
    const rankingEntidadArray = Object.entries(rankingEntidad).map(
      ([entidadNom, val]) => ({
        entidad: entidadNom,
        asignado: val.asignado,
        cobrado: val.cobrado,
        porcentaje: val.asignado
          ? Math.round((val.cobrado / val.asignado) * 100)
          : 0,
        pagos: val.pagos,
      })
    );

    const rankingCarteraArray = Object.entries(rankingCartera).map(
      ([carteraNom, val]) => ({
        cartera: carteraNom,
        asignado: val.asignado,
        cobrado: val.cobrado,
        porcentaje: val.asignado
          ? Math.round((val.cobrado / val.asignado) * 100)
          : 0,
        pagos: val.pagos,
      })
    );

    // Ranking de operadores con desglose por estado
    const ESTADOS_ORDEN = [
      "A cuota",
      "Cuota 30",
      "Cuota 60",
      "Cuota 90",
      "Caída",
    ];
    const rankingOperadoresArray = Object.entries(rankingOperadores).map(
      ([operador, val]) => {
        const totalAsignado = val.total.asignado || 0;
        const totalPagado = val.total.pagado || 0;
        const totalPorcentaje = totalAsignado
          ? Math.round((totalPagado / totalAsignado) * 100)
          : 0;

        const estados = {};
        ESTADOS_ORDEN.forEach((e) => {
          const nodo = val.porEstado[e] || {
            cantidad: 0,
            asignado: 0,
            pagado: 0,
            porcentaje: 0,
          };
          const asign = nodo.asignado || 0;
          const pag = nodo.pagado || 0;
          estados[e] = {
            cantidad: nodo.cantidad || 0,
            asignado: asign,
            pagado: pag,
            porcentaje: asign ? Math.round((pag / asign) * 100) : 0,
          };
        });

        return {
          operador,
          asignado: totalAsignado,
          pagado: totalPagado,
          porcentaje: totalPorcentaje,
          estados, // { "A cuota": {...}, "Cuota 30": {...}, ... }
        };
      }
    );

    // Ordenamientos
    rankingEntidadArray.sort(
      (a, b) => b.porcentaje - a.porcentaje || b.cobrado - a.cobrado
    );
    rankingCarteraArray.sort(
      (a, b) => b.porcentaje - a.porcentaje || b.cobrado - a.cobrado
    );
    rankingOperadoresArray.sort(
      (a, b) =>
        (b.porcentaje ?? 0) - (a.porcentaje ?? 0) ||
        (b.pagado ?? 0) - (a.pagado ?? 0)
    );

    // Respuesta
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
