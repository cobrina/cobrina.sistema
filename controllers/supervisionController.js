import Pago from "../models/Pago.js";
import Empleado from "../models/Empleado.js";
import Entidad from "../models/Entidad.js";
import SubCesion from "../models/SubCesion.js";
import ObjetivoMensual from "../models/ObjetivoMensual.js";
import Asistencia from "../models/Asistencia.js";
import Proyeccion from "../models/Proyeccion.js";
import Colchon from "../models/Colchon.js";
import ReporteGestion from "../models/ReporteGestion.js";
import NovedadRRHH from "../models/NovedadRRHH.js";
import AcuerdoPago from "../models/AcuerdoPago.js";
import { horarioEfectivoParaFecha, minutosTrabajadosDesdeMarcas, minutosEsperadosHastaHoy, rangoMesLocal } from "../utils/calculoAsistencia.js";
import { transformarGestionEnAcuerdo } from "../services/acuerdosGestionesService.js";

function mesValido(valor) {
  const match = String(valor || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const anio = Number(match[1]);
  const mes = Number(match[2]);
  if (anio < 2000 || anio > 2100 || mes < 1 || mes > 12) return null;
  return `${anio}-${String(mes).padStart(2, "0")}`;
}

function fechaHoraGestionLocal(fecha, hora = "") {
  const fechaMatch = String(fecha || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!fechaMatch) return null;

  const horaMatch = String(hora || "").trim().match(/^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?/);
  const horas = horaMatch ? Number(horaMatch[1]) : 0;
  const minutos = horaMatch ? Number(horaMatch[2] || 0) : 0;
  const segundos = horaMatch ? Number(horaMatch[3] || 0) : 0;
  if (horas > 23 || minutos > 59 || segundos > 59) return null;

  // Las horas de Mango se guardan en horario argentino (UTC-03:00).
  const fechaUTC = new Date(Date.UTC(
    Number(fechaMatch[1]),
    Number(fechaMatch[2]) - 1,
    Number(fechaMatch[3]),
    horas + 3,
    minutos,
    segundos
  ));
  return Number.isNaN(fechaUTC.getTime()) ? null : fechaUTC;
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
      pendientesColchon, pendientesProyecciones, ultimaPago, ultimaGestionAcuerdo, ultimaGestion,
      gestionesAcuerdoPeriodo, pagosHoyAgg, presentesAhora, jornadasSinSalida,
      ultimaAcuerdoManual, acuerdosManualesCantidad] = await Promise.all([
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
      ReporteGestion.findOne({ borrado: { $ne: true }, resultadoGestion: /acuerdo/i })
        .sort({ createdAt: -1 })
        .select("createdAt fecha hora usuario resultadoGestion fuenteArchivo")
        .lean(),
      ReporteGestion.findOne({ borrado: { $ne: true } }).sort({ createdAt: -1 }).select("createdAt fecha fuenteArchivo").lean(),
      ReporteGestion.find({
        fecha: { $gte: selectedDesdeUTC, $lte: selectedHastaUTC },
        borrado: { $ne: true },
        resultadoGestion: /acuerdo/i,
      })
        .select("dni nombreDeudor fecha hora usuario tipoContacto resultadoGestion estadoCuenta telMailMarcado observacionGestion entidad entidadNumero")
        .sort({ fecha: -1, hora: -1, _id: -1 })
        .lean(),
      Pago.aggregate([
        { $match: { fechaPago: { $gte: hoyDesde, $lte: hoyHasta } } },
        { $group: { _id: null, total: { $sum: "$monto" }, cantidad: { $sum: 1 } } },
      ]),
      Asistencia.countDocuments({ fechaClave: hoyClave, estado: "presente" }),
      Asistencia.countDocuments({ fechaClave: { $lt: hoyClave }, estado: "presente" }),
      AcuerdoPago.findOne({ mes: mesSeleccionado })
        .sort({ fechaHora: -1, createdAt: -1 })
        .select("fechaHora createdAt fuenteArchivo operador")
        .lean(),
      AcuerdoPago.countDocuments({ mes: mesSeleccionado }),
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
        horarioLibre: horarioHoy.horarioLibre,
        deficitMinutos: Math.max(0, esperados - minutos),
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

    // La fuente de acuerdos es exactamente la misma que Reportes > Acuerdos:
    // gestiones con resultado "acuerdo" que además superan la validación del parser.
    // El total de acuerdos no depende de que existan pagos importados.
    const usuariosActivos = new Set(
      empleados
        .map((empleado) => String(empleado.username || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const acuerdosValidos = gestionesAcuerdoPeriodo
      .map((gestion) => transformarGestionEnAcuerdo(gestion))
      .filter(Boolean)
      // El filtro se hace en JS para que nombres con mayúsculas/minúsculas distintas
      // no oculten acuerdos que sí aparecen en Reporte de gestiones.
      .filter((acuerdo) => usuariosActivos.has(String(acuerdo.usuario || "").trim().toLowerCase()));
    const ultimoAcuerdoMango = acuerdosValidos[0] || null;
    const ultimaFechaAcuerdoMango = ultimoAcuerdoMango?.fecha
      ? fechaHoraGestionLocal(ultimoAcuerdoMango.fecha, ultimoAcuerdoMango.hora)
      : null;
    const acuerdosPorOperadorMap = new Map();
    const acuerdosPorTipoMap = new Map();
    let montoTotalAcuerdos = 0;
    let primerPagoTotal = 0;
    let acuerdosVencidos = 0;
    let acuerdosVenceHoy = 0;
    let acuerdosProximos = 0;

    for (const acuerdo of acuerdosValidos) {
      const usuario = String(acuerdo.usuario || "Sin operador").trim() || "Sin operador";
      const actual = acuerdosPorOperadorMap.get(usuario) || {
        usuario,
        total: 0,
        montoTotal: 0,
        primerPagoTotal: 0,
        vencidos: 0,
        venceHoy: 0,
        proximos: 0,
      };
      actual.total += 1;
      actual.montoTotal += Number(acuerdo.montoTotalAcuerdo || 0);
      actual.primerPagoTotal += Number(acuerdo.primerPago || 0);
      if (acuerdo.estadoVencimiento === "VENCIDO") actual.vencidos += 1;
      if (acuerdo.estadoVencimiento === "VENCE HOY") actual.venceHoy += 1;
      if (acuerdo.estadoVencimiento === "PRÓXIMO 3 DÍAS") actual.proximos += 1;
      acuerdosPorOperadorMap.set(usuario, actual);

      const tipo = acuerdo.tipoAcuerdo || "Sin clasificar";
      acuerdosPorTipoMap.set(tipo, (acuerdosPorTipoMap.get(tipo) || 0) + 1);
      montoTotalAcuerdos += Number(acuerdo.montoTotalAcuerdo || 0);
      primerPagoTotal += Number(acuerdo.primerPago || 0);
      if (acuerdo.estadoVencimiento === "VENCIDO") acuerdosVencidos += 1;
      if (acuerdo.estadoVencimiento === "VENCE HOY") acuerdosVenceHoy += 1;
      if (acuerdo.estadoVencimiento === "PRÓXIMO 3 DÍAS") acuerdosProximos += 1;
    }

    const acuerdosPorOperador = [...acuerdosPorOperadorMap.values()]
      .sort((a, b) => b.total - a.total || b.montoTotal - a.montoTotal);
    const acuerdosPorTipo = [...acuerdosPorTipoMap.entries()]
      .map(([tipo, total]) => ({ tipo, total }))
      .sort((a, b) => b.total - a.total);

    const horasParaRevisar = operadores
      .filter((o) => !o.horarioLibre && o.minutosEsperados > 0 && o.deficitMinutos >= 60 && o.porcentajeHoras < 90)
      .sort((a, b) => b.deficitMinutos - a.deficitMinutos || a.porcentajeHoras - b.porcentajeHoras)
      .slice(0, 12)
      .map((o) => ({
        ...o,
        motivoRevision: o.minutosTrabajados <= 0
          ? "Sin horas fichadas en el período"
          : `Faltan ${Math.floor(o.deficitMinutos / 60)}h ${Math.round(o.deficitMinutos % 60)}m frente al horario base`,
      }));

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
      acuerdos: {
        total: acuerdosValidos.length,
        montoTotal: montoTotalAcuerdos,
        primerPagoTotal,
        vencidos: acuerdosVencidos,
        venceHoy: acuerdosVenceHoy,
        proximos: acuerdosProximos,
        porOperador: acuerdosPorOperador,
        porTipo: acuerdosPorTipo,
        fuente: "reporte-gestiones",
      },
      actualizaciones: {
        pagos: ultimaPago,
        acuerdos: ultimaGestionAcuerdo,
        acuerdosManuales: {
          cantidad: Number(acuerdosManualesCantidad || 0),
          fecha: ultimaAcuerdoManual?.fechaHora || ultimaAcuerdoManual?.createdAt || null,
          fuenteArchivo: ultimaAcuerdoManual?.fuenteArchivo || "",
        },
        acuerdosMango: {
          cantidad: acuerdosValidos.length,
          fecha: ultimaFechaAcuerdoMango && !Number.isNaN(ultimaFechaAcuerdoMango.getTime())
            ? ultimaFechaAcuerdoMango
            : null,
          fuente: "Reporte de gestiones",
        },
        gestiones: ultimaGestion,
      },
      objetivos,
    });
  } catch (error) {
    console.error("Panel supervisión:", error);
    return res.status(500).json({ error: "No se pudo preparar el panel de supervisión" });
  }
}
