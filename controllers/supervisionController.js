import Pago from "../models/Pago.js";
import Empleado from "../models/Empleado.js";
import Entidad from "../models/Entidad.js";
import SubCesion from "../models/SubCesion.js";
import ObjetivoMensual from "../models/ObjetivoMensual.js";
import Asistencia from "../models/Asistencia.js";
import Proyeccion from "../models/Proyeccion.js";
import Colchon from "../models/Colchon.js";
import AcuerdoPago from "../models/AcuerdoPago.js";
import ReporteGestion from "../models/ReporteGestion.js";
import NovedadRRHH from "../models/NovedadRRHH.js";
import { horarioEfectivoParaFecha, minutosTrabajadosDesdeMarcas, minutosEsperadosHastaHoy, rangoMesLocal } from "../utils/calculoAsistencia.js";

function mesValido(valor) {
  const match = String(valor || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const anio = Number(match[1]);
  const mes = Number(match[2]);
  if (anio < 2000 || anio > 2100 || mes < 1 || mes > 12) return null;
  return `${anio}-${String(mes).padStart(2, "0")}`;
}

function fechaBaseMes(mes) {
  const normalizado = mesValido(mes);
  if (!normalizado) return new Date();
  const [anio, numeroMes] = normalizado.split("-").map(Number);
  return new Date(anio, numeroMes - 1, 1, 12, 0, 0, 0);
}

function mesesUltimosTres(base = new Date()) {
  const items = [];
  for (let i = 2; i >= 0; i -= 1) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    items.push({
      mes: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      desde: new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0),
      hasta: new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999),
    });
  }
  return items;
}

function mapearPagosPorOperador(pagos, empleados) {
  const porId = new Map();
  const porUsername = new Map();
  for (const pago of pagos) {
    if (pago.operadorId) {
      const key = String(pago.operadorId);
      porId.set(key, (porId.get(key) || 0) + Number(pago.monto || 0));
    } else if (pago.operadorUsername) {
      const key = String(pago.operadorUsername).toLowerCase();
      porUsername.set(key, (porUsername.get(key) || 0) + Number(pago.monto || 0));
    }
  }
  return empleados.map((empleado) => ({
    empleadoId: empleado._id,
    username: empleado.username,
    nombre: empleado.nombre,
    role: empleado.role,
    total: porId.get(String(empleado._id)) || porUsername.get(String(empleado.username).toLowerCase()) || 0,
  }));
}

export async function resumenSupervision(req, res) {
  try {
    const hoyReal = new Date();
    const mesReal = `${hoyReal.getFullYear()}-${String(hoyReal.getMonth() + 1).padStart(2, "0")}`;
    const mesSolicitado = mesValido(req.query?.mes);
    const mesSeleccionado = mesSolicitado || mesReal;
    const meses = mesesUltimosTres(fechaBaseMes(mesSeleccionado));
    const { desde, hasta, desdeClave, hastaClave } = rangoMesLocal(mesSeleccionado);
    const desdeTres = meses[0].desde;
    const ahora = hoyReal;
    const hoyDesde = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 0, 0, 0, 0);
    const hoyHasta = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 23, 59, 59, 999);
    const hoyClave = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, "0")}-${String(ahora.getDate()).padStart(2, "0")}`;
    const selectedDesdeUTC = new Date(`${desdeClave}T00:00:00.000Z`);
    const selectedHastaUTC = new Date(`${hastaClave}T23:59:59.999Z`);
    const hoyDesdeUTC = new Date(`${hoyClave}T00:00:00.000Z`);
    const hoyHastaUTC = new Date(`${hoyClave}T23:59:59.999Z`);
    const desdeNovedades = selectedDesdeUTC < hoyDesdeUTC ? selectedDesdeUTC : hoyDesdeUTC;
    const hastaNovedades = selectedHastaUTC > hoyHastaUTC ? selectedHastaUTC : hoyHastaUTC;

    const empleados = await Empleado.find({ isActive: { $ne: false } })
      .select("username nombre role horarioLaboral")
      .sort({ username: 1 })
      .lean();

    const [pagosTres, objetivos, asistencias, novedadesHorario, proyeccionesCaidas, colchonSinGestion,
      pendientesColchon, pendientesProyecciones, ultimaPago, ultimoAcuerdo, ultimaGestion,
      pagosHoyAgg, presentesAhora, jornadasSinSalida] = await Promise.all([
      Pago.find({ fechaPago: { $gte: desdeTres, $lte: hasta } })
        .select("monto fechaPago operadorId operadorUsername entidadId subCesionId")
        .lean(),
      ObjetivoMensual.find({ mes: mesSeleccionado, activo: true })
        .populate("empleadoId", "username nombre")
        .populate("subCesionId", "nombre")
        .lean(),
      Asistencia.find({ fechaClave: { $gte: desdeClave, $lte: hastaClave } }).lean(),
      NovedadRRHH.find({
        empleadoId: { $in: empleados.map((empleado) => empleado._id) },
        tipo: { $in: ["cambio-horario", "licencia-medica"] },
        estado: { $ne: "anulado" },
        fechaDesde: { $lte: hastaNovedades },
        $or: [{ fechaHasta: null }, { fechaHasta: { $gte: desdeNovedades } }],
      }).lean(),
      Proyeccion.countDocuments({
        fechaPromesa: { $gte: desde, $lte: hasta },
        $or: [
          { estado: "Promesa caída" },
          { importePagado: { $lte: 0 } },
        ],
      }),
      Colchon.countDocuments({
        $or: [{ ultimaGestion: null }, { ultimaGestion: { $lt: new Date(Date.now() - 7 * 86400000) } }],
      }),
      Colchon.countDocuments({
        pagosInformados: { $elemMatch: { erroneo: { $ne: true }, estadoAplicacion: { $in: [null, "pendiente"] } } },
      }),
      Proyeccion.countDocuments({
        pagosInformados: { $elemMatch: { erroneo: { $ne: true }, estadoAplicacion: { $in: [null, "pendiente"] } } },
      }),
      Pago.findOne().sort({ createdAt: -1 }).select("createdAt fechaPago").lean(),
      AcuerdoPago.findOne().sort({ createdAt: -1 }).select("createdAt fechaHora fuenteArchivo").lean(),
      ReporteGestion.findOne().sort({ createdAt: -1 }).select("createdAt fecha fuenteArchivo").lean(),
      Pago.aggregate([
        { $match: { fechaPago: { $gte: hoyDesde, $lte: hoyHasta } } },
        { $group: { _id: null, total: { $sum: "$monto" }, cantidad: { $sum: 1 } } },
      ]),
      Asistencia.countDocuments({ fechaClave: hoyClave, estado: "presente" }),
      Asistencia.countDocuments({ fechaClave: { $lt: hoyClave }, estado: "presente" }),
    ]);

    const recaudacionTresMeses = meses.map((m) => {
      const total = pagosTres
        .filter((p) => p.fechaPago >= m.desde && p.fechaPago <= m.hasta)
        .reduce((sum, p) => sum + Number(p.monto || 0), 0);
      return { mes: m.mes, total };
    });

    const pagosActuales = pagosTres.filter((p) => p.fechaPago >= desde && p.fechaPago <= hasta);
    const totalActual = pagosActuales.reduce((sum, p) => sum + Number(p.monto || 0), 0);
    const objetivoEquipo = objetivos.find((o) => o.alcance === "equipo");
    const montoObjetivoEquipo = Number(objetivoEquipo?.montoObjetivo || 0);

    const porOperador = mapearPagosPorOperador(pagosActuales, empleados);
    const objetivosOperador = new Map(
      objetivos.filter((o) => o.alcance === "operador").map((o) => [String(o.empleadoId?._id || o.empleadoId), Number(o.montoObjetivo || 0)])
    );

    const minutosPorEmpleado = new Map();
    for (const asistencia of asistencias) {
      const key = String(asistencia.empleado);
      minutosPorEmpleado.set(key, (minutosPorEmpleado.get(key) || 0) + minutosTrabajadosDesdeMarcas(asistencia.marcas));
    }

    const novedadesPorEmpleado = new Map();
    for (const novedad of novedadesHorario) {
      const key = String(novedad.empleadoId);
      if (!novedadesPorEmpleado.has(key)) novedadesPorEmpleado.set(key, []);
      novedadesPorEmpleado.get(key).push(novedad);
    }

    const operadores = porOperador.map((item) => {
      const empleado = empleados.find((e) => String(e._id) === String(item.empleadoId));
      const objetivo = objetivosOperador.get(String(item.empleadoId)) || 0;
      const minutos = minutosPorEmpleado.get(String(item.empleadoId)) || 0;
      const novedadesEmpleado = novedadesPorEmpleado.get(String(item.empleadoId)) || [];
      const esperados = minutosEsperadosHastaHoy(empleado, mesSeleccionado, novedadesEmpleado);
      const horarioHoy = horarioEfectivoParaFecha(empleado, hoyClave, novedadesEmpleado);
      return {
        ...item,
        objetivo,
        porcentajeObjetivo: objetivo > 0 ? Math.round((item.total / objetivo) * 1000) / 10 : null,
        minutosTrabajados: minutos,
        minutosEsperados: esperados,
        porcentajeHoras: esperados > 0 ? Math.round((minutos / esperados) * 1000) / 10 : null,
        horarioHoy: horarioHoy.etiqueta,
        horarioModificadoHoy: horarioHoy.cambioHorario,
        licenciaMedicaHoy: horarioHoy.licenciaMedica,
      };
    });

    const entidades = await Entidad.find({}).select("numero nombre").lean();
    const entidadMap = new Map(entidades.map((e) => [Number(e.numero), e.nombre]));
    const porEntidadMap = new Map();
    for (const pago of pagosActuales) {
      const numero = Number(pago.entidadId);
      porEntidadMap.set(numero, (porEntidadMap.get(numero) || 0) + Number(pago.monto || 0));
    }
    const objetivosEntidad = new Map(
      objetivos
        .filter((o) => o.alcance === "entidad")
        .map((o) => [Number(o.entidadNumero), Number(o.montoObjetivo || 0)])
    );
    const porEntidad = [...porEntidadMap.entries()]
      .map(([entidadNumero, total]) => {
        const objetivo = objetivosEntidad.get(entidadNumero) || 0;
        return {
          entidadNumero,
          entidadNombre: entidadMap.get(entidadNumero) || "Sin catálogo",
          total,
          objetivo,
          porcentajeObjetivo: objetivo > 0 ? Math.round((total / objetivo) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => b.total - a.total);

    const idsSub = [...new Set(pagosActuales.map((p) => String(p.subCesionId || "")).filter(Boolean))];
    const subcesiones = await SubCesion.find({ _id: { $in: idsSub } }).select("nombre").lean();
    const subMap = new Map(subcesiones.map((s) => [String(s._id), s.nombre]));
    const porSubMap = new Map();
    for (const pago of pagosActuales) {
      const key = `${pago.entidadId}|${pago.subCesionId}`;
      porSubMap.set(key, (porSubMap.get(key) || 0) + Number(pago.monto || 0));
    }
    const objetivosCartera = new Map(
      objetivos
        .filter((o) => o.alcance === "entidad-subcesion")
        .map((o) => [`${Number(o.entidadNumero)}|${String(o.subCesionId?._id || o.subCesionId)}`, Number(o.montoObjetivo || 0)])
    );
    const porCartera = [...porSubMap.entries()]
      .map(([key, total]) => {
        const [entidadNumero, subCesionId] = key.split("|");
        const objetivo = objetivosCartera.get(key) || 0;
        return {
          entidadNumero: Number(entidadNumero),
          entidadNombre: entidadMap.get(Number(entidadNumero)) || "Sin catálogo",
          subCesionId,
          subCesionNombre: subMap.get(subCesionId) || "Sin catálogo",
          total,
          objetivo,
          porcentajeObjetivo: objetivo > 0 ? Math.round((total / objetivo) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => b.total - a.total);

    const horasParaRevisar = operadores
      .filter((o) => o.minutosEsperados > 0 && o.porcentajeHoras < 75)
      .sort((a, b) => a.porcentajeHoras - b.porcentajeHoras)
      .slice(0, 12);

    const objetivosParaRevisar = operadores
      .filter((o) => o.objetivo > 0)
      .sort((a, b) => a.porcentajeObjetivo - b.porcentajeObjetivo)
      .slice(0, 12);

    const cambiosHorarioHoy = operadores
      .filter((operador) => operador.horarioModificadoHoy)
      .map((operador) => ({
        empleadoId: operador.empleadoId,
        username: operador.username,
        nombre: operador.nombre,
        horario: operador.horarioHoy,
      }));
    const licenciasMedicasHoy = operadores
      .filter((operador) => operador.licenciaMedicaHoy)
      .map((operador) => ({
        empleadoId: operador.empleadoId,
        username: operador.username,
        nombre: operador.nombre,
      }));

    return res.json({
      mesActual: mesSeleccionado,
      mesSeleccionado,
      esMesActual: mesSeleccionado === mesReal,
      alertasEnTiempoReal: true,
      recaudacion: {
        ultimosTresMeses: recaudacionTresMeses,
        mesActual: totalActual,
        objetivoEquipo: montoObjetivoEquipo,
        porcentajeObjetivoEquipo: montoObjetivoEquipo > 0 ? Math.round((totalActual / montoObjetivoEquipo) * 1000) / 10 : null,
        porOperador: operadores.sort((a, b) => b.total - a.total),
        porEntidad,
        porCartera,
      },
      hoy: {
        pagosCantidad: Number(pagosHoyAgg?.[0]?.cantidad || 0),
        pagosTotal: Number(pagosHoyAgg?.[0]?.total || 0),
        presentesAhora,
        jornadasSinSalida,
        cambiosHorario: cambiosHorarioHoy.length,
        licenciasMedicas: licenciasMedicasHoy.length,
      },
      alertas: {
        proyeccionesCaidas,
        colchonSinGestion,
        pagosInformadosPendientes: pendientesColchon + pendientesProyecciones,
        pagosInformadosColchon: pendientesColchon,
        pagosInformadosProyecciones: pendientesProyecciones,
        horasParaRevisar,
        objetivosParaRevisar,
        cambiosHorarioHoy,
        licenciasMedicasHoy,
      },
      actualizaciones: {
        pagos: ultimaPago,
        acuerdos: ultimoAcuerdo,
        gestiones: ultimaGestion,
      },
      objetivos,
    });
  } catch (error) {
    console.error("Panel supervisión:", error);
    return res.status(500).json({ error: "No se pudo preparar el panel de supervisión" });
  }
}
