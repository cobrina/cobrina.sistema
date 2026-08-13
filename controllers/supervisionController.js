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
import {
  horarioEfectivoParaFecha,
  minutosEsperadosEnRango,
  novedadCubreFecha,
  rangoMesLocal,
  minutosActividadSegunHorario,
  intervalosLaboralesSinDescanso,
  aplicarBreakFlexible,
  minutosBreakFlexiblePermitido,
  minutosHoraHHMM,
  minutoEnDescansoProgramado,
  descansoProgramadoSolapadoMin,
} from "../utils/calculoAsistencia.js";
import { actividadDeUsuarioEnFecha, horaGestionHHMM, resumirActividadMensual } from "../utils/actividadGestiones.js";
import { filtrarEmpleadosControlados, usernamesControlados } from "../utils/controlEquipo.js";
import { normalizeUsername } from "../config/roles.js";
import { transformarGestionEnAcuerdo, vincularPagosPosteriores } from "../services/acuerdosGestionesService.js";
import {
  claveFechaCalendario,
  fechaClaveArgentina,
  inicioDiaCalendarioUTC,
  finDiaCalendarioUTC,
  mesClaveArgentina,
} from "../utils/fecha.util.js";

const BACHE_VISIBLE_MIN = 20;
const BACHE_CRITICO_MIN = 30;
const TARDANZA_INICIO_VISIBLE_MIN = 15;
const ANTICIPO_INICIO_VISIBLE_MIN = 30;

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
  const normalizado = mesValido(mes) || mesClaveArgentina();
  const [anio, numeroMes] = normalizado.split("-").map(Number);
  return new Date(Date.UTC(anio, numeroMes - 1, 1, 12, 0, 0, 0));
}

function mesesUltimosTres(base = fechaBaseMes(mesClaveArgentina())) {
  const items = [];
  for (let i = 2; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1));
    items.push({
      mes: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      desde: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
      hasta: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1),
    });
  }
  return items;
}

function partesArgentina(fecha = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(fecha);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function minutoActualArgentina(fecha = new Date()) {
  const values = partesArgentina(fecha);
  return Number(values.hour || 0) * 60 + Number(values.minute || 0);
}

function etiquetaNovedadDia(novedad) {
  const tipo = String(novedad?.tipo || "");
  if (tipo === "licencia-medica") return "Licencia médica";
  if (tipo === "falta-justificada") return "Falta justificada";
  if (tipo === "falta") return "Falta sin justificar";
  if (tipo === "dia-estudio") return "Día de estudio";
  if (tipo === "permiso") return "Permiso / ausencia";
  return "";
}

function bloquesActividadDia(actividad = {}) {
  const primera = minutosHoraHHMM(actividad?.primeraGestion);
  const ultima = minutosHoraHHMM(actividad?.ultimaGestion);
  if (!Number.isFinite(primera) || !Number.isFinite(ultima)) return [];

  const intervalos = [...(actividad?.intervalos || [])]
    .filter((item) => Number.isFinite(Number(item?.desdeMin)) && Number.isFinite(Number(item?.hastaMin)))
    .sort((a, b) => Number(a.desdeMin) - Number(b.desdeMin));

  const bloques = [];
  let inicio = primera;
  let fin = primera;
  for (const intervalo of intervalos) {
    const desde = Number(intervalo.desdeMin);
    const hasta = Number(intervalo.hastaMin);
    const huecoReal = Math.max(0, hasta - desde);
    if (huecoReal > BACHE_VISIBLE_MIN) {
      bloques.push({
        desde: horaGestionHHMM(inicio),
        hasta: horaGestionHHMM(fin),
        duracionMin: Math.max(5, Math.round(fin - inicio + 5)),
      });
      inicio = hasta;
    }
    fin = hasta;
  }
  bloques.push({
    desde: horaGestionHHMM(inicio),
    hasta: horaGestionHHMM(fin),
    duracionMin: Math.max(5, Math.round(fin - inicio + 5)),
  });
  return bloques;
}

function etiquetaTipoNovedad(tipo) {
  if (tipo === "cambio-horario") return "Cambio de horario";
  return etiquetaNovedadDia({ tipo }) || String(tipo || "Novedad");
}

function fechaClaveNovedad(value) {
  return claveFechaCalendario(value);
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
    const hoyReal = new Date(); // instante real de consulta
    const hoyRealClave = fechaClaveArgentina(hoyReal);
    const mesReal = mesClaveArgentina(hoyReal);
    const fechaPedida = claveFechaCalendario(req.query?.fecha);
    const fechaConsulta = fechaPedida && fechaPedida <= hoyRealClave ? fechaPedida : hoyRealClave;
    const esFechaActual = fechaConsulta === hoyRealClave;
    const mesSolicitado = mesValido(req.query?.mes);
    const mesSeleccionado = fechaPedida ? fechaConsulta.slice(0, 7) : (mesSolicitado || mesReal);
    const meses = mesesUltimosTres(fechaBaseMes(mesSeleccionado));
    const rangoMes = rangoMesLocal(mesSeleccionado);
    const { desde, desdeClave, hastaClave } = rangoMes;
    const hastaPeriodoClave = fechaConsulta < hastaClave ? fechaConsulta : hastaClave;
    const hasta = finDiaCalendarioUTC(hastaPeriodoClave);
    const desdeTres = meses[0].desde;
    // Conservamos nombres históricos "hoy*" para no romper consumidores, pero
    // desde esta versión representan el día seleccionado en Supervisión.
    const hoyClave = fechaConsulta;
    const hoyDesde = inicioDiaCalendarioUTC(hoyClave);
    const hoyHasta = finDiaCalendarioUTC(hoyClave);
    const selectedDesdeUTC = inicioDiaCalendarioUTC(desdeClave);
    const selectedHastaUTC = hasta;
    const hoyDesdeUTC = hoyDesde;
    const hoyHastaUTC = hoyHasta;
    const desdeNovedades = selectedDesdeUTC;
    const hastaNovedades = selectedHastaUTC;

    const empleados = await Empleado.find({ isActive: { $ne: false } })
      .select("username nombre role horarioLaboral")
      .sort({ username: 1 })
      .lean();
    const empleadosControlados = filtrarEmpleadosControlados(empleados);
    const idsControlados = empleadosControlados.map((empleado) => empleado._id);
    const usuariosControlados = usernamesControlados(empleados);
    const listaUsuariosControlados = [...usuariosControlados];

    const [pagosTres, objetivos, novedadesRRHH, gestionesActividadPeriodo, gestionesActividadHoy,
      proyeccionesCaidas, proyeccionesManuales, colchonSinGestion, pendientesColchon, pendientesProyecciones, ultimaPago,
      ultimaGestionAcuerdo, ultimaGestion, ultimaGestionDia, gestionesAcuerdoPeriodo, pagosHoyAgg, pagosHoyDetalle, fichadosAhora,
      jornadasSinSalida, ultimaAcuerdoManual, acuerdosManualesCantidad, resumenColchonAgg, ultimaColchon, ultimaNovedadRRHH] = await Promise.all([
      Pago.find({ fechaPago: { $gte: desdeTres, $lte: hasta } })
        .select("monto fechaPago operadorId operadorUsername entidadId subCesionId")
        .lean(),
      ObjetivoMensual.find({ mes: mesSeleccionado, activo: true })
        .populate("empleadoId", "username nombre")
        .populate("subCesionId", "nombre")
        .lean(),
      NovedadRRHH.find({
        empleadoId: { $in: idsControlados },
        tipo: { $in: ["cambio-horario", "licencia-medica", "falta", "falta-justificada", "dia-estudio", "permiso"] },
        estado: { $ne: "anulado" },
        fechaDesde: { $lte: hastaNovedades },
        $or: [{ fechaHasta: null }, { fechaHasta: { $gte: desdeNovedades } }],
      }).lean(),
      ReporteGestion.find({
        fecha: { $gte: selectedDesdeUTC, $lte: selectedHastaUTC },
        borrado: { $ne: true },
        usuario: { $in: listaUsuariosControlados },
      }).select("fecha hora usuario").lean(),
      ReporteGestion.find({
        fecha: { $gte: hoyDesdeUTC, $lte: hoyHastaUTC },
        borrado: { $ne: true },
        usuario: { $in: listaUsuariosControlados },
      }).select("fecha hora usuario").lean(),
      Proyeccion.countDocuments({
        fechaPromesa: { $gte: desde, $lte: hasta },
        $or: [
          { estado: "Promesa caída" },
          { importePagado: { $lte: 0 } },
        ],
      }),
      Proyeccion.countDocuments({
        anio: Number(mesSeleccionado.slice(0, 4)),
        mes: Number(mesSeleccionado.slice(5, 7)),
        origen: { $ne: "mango-confirmado" },
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
      ReporteGestion.findOne({
        fecha: { $gte: hoyDesdeUTC, $lte: hoyHastaUTC },
        borrado: { $ne: true },
        usuario: { $in: listaUsuariosControlados },
      }).sort({ createdAt: -1 }).select("createdAt fecha hora fuenteArchivo usuario").lean(),
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
      Pago.find({ fechaPago: { $gte: hoyDesde, $lte: hoyHasta } })
        .select("monto operadorId operadorUsername")
        .lean(),
      Asistencia.countDocuments({ empleado: { $in: idsControlados }, fechaClave: hoyClave, estado: "presente" }),
      Asistencia.countDocuments({ empleado: { $in: idsControlados }, fechaClave: { $lt: hoyClave }, estado: "presente" }),
      AcuerdoPago.findOne({ mes: mesSeleccionado, fecha: { $lte: selectedHastaUTC } })
        .sort({ fechaHora: -1, createdAt: -1 })
        .select("fechaHora createdAt fuenteArchivo operador")
        .lean(),
      AcuerdoPago.countDocuments({ mes: mesSeleccionado, fecha: { $lte: selectedHastaUTC } }),
      Colchon.aggregate([
        { $match: { creado: { $lte: selectedHastaUTC } } },
        {
          $lookup: {
            from: "entidads",
            localField: "entidadId",
            foreignField: "_id",
            as: "entidadCatalogo",
            pipeline: [{ $project: { _id: 1, numero: 1 } }],
          },
        },
        { $unwind: { path: "$entidadCatalogo", preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            importeCuotaSupervision: { $ifNull: ["$importeCuota", 0] },
            dniPago: { $toString: "$dni" },
            entidadNumeroPago: {
              $convert: {
                input: { $ifNull: ["$entidadNumero", "$entidadCatalogo.numero"] },
                to: "int",
                onError: null,
                onNull: null,
              },
            },
          },
        },
        {
          $lookup: {
            from: Pago.collection.name,
            let: {
              dniCuota: "$dniPago",
              entidadNumero: "$entidadNumeroPago",
              subCesion: "$subCesionId",
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$dni", "$$dniCuota"] },
                      { $eq: ["$entidadId", "$$entidadNumero"] },
                      { $eq: ["$subCesionId", "$$subCesion"] },
                      { $gte: ["$fechaPago", desde] },
                      { $lte: ["$fechaPago", hasta] },
                    ],
                  },
                },
              },
              {
                $group: {
                  _id: null,
                  total: { $sum: { $ifNull: ["$monto", 0] } },
                  cantidad: { $sum: 1 },
                },
              },
            ],
            as: "pagosColchonMes",
          },
        },
        {
          $addFields: {
            pagadoSupervision: {
              $ifNull: [{ $arrayElemAt: ["$pagosColchonMes.total", 0] }, 0],
            },
          },
        },
        {
          $group: {
            _id: null,
            totalCuotas: { $sum: 1 },
            importeTotal: { $sum: "$importeCuotaSupervision" },
            pagadoTotal: { $sum: "$pagadoSupervision" },
            cuotasConPago: { $sum: { $cond: [{ $gt: ["$pagadoSupervision", 0] }, 1, 0] } },
          },
        },
      ]).allowDiskUse(true),
      Colchon.findOne({ creado: { $lte: selectedHastaUTC } }).sort({ ultimaModificacion: -1, creado: -1 }).select("ultimaModificacion creado").lean(),
      NovedadRRHH.findOne({ estado: { $ne: "anulado" } }).sort({ updatedAt: -1, createdAt: -1 }).select("updatedAt createdAt tipo fechaDesde").lean(),
    ]);

    const diaCorteComparacion = Number(hoyClave.slice(8, 10));

    const recaudacionTresMeses = meses.map((m) => {
      const total = pagosTres
        .filter((p) => p.fechaPago >= m.desde && p.fechaPago <= m.hasta)
        .reduce((sum, p) => sum + Number(p.monto || 0), 0);
      const diasMes = new Date(Date.UTC(Number(m.mes.slice(0, 4)), Number(m.mes.slice(5, 7)), 0)).getUTCDate();
      const corte = Math.min(diaCorteComparacion, diasMes);
      const comparable = pagosTres
        .filter((p) => p.fechaPago >= m.desde && p.fechaPago <= m.hasta && p.fechaPago.getUTCDate() <= corte)
        .reduce((sum, p) => sum + Number(p.monto || 0), 0);
      return { mes: m.mes, total, comparable, diaCorte: corte };
    }).map((item, index, rows) => {
      if (!index) return { ...item, variacionVsAnterior: null };
      const anterior = Number(rows[index - 1]?.comparable || 0);
      const actual = Number(item.comparable || 0);
      const variacion = anterior > 0 ? Math.round((((actual - anterior) / anterior) * 100) * 10) / 10 : null;
      return { ...item, variacionVsAnterior: variacion, diferenciaVsAnterior: actual - anterior };
    });

    const pagosActuales = pagosTres.filter((p) => p.fechaPago >= desde && p.fechaPago <= hasta);
    const totalActual = pagosActuales.reduce((sum, p) => sum + Number(p.monto || 0), 0);
    const colchonBase = resumenColchonAgg?.[0] || {};
    const colchonTotalCuotas = Number(colchonBase.totalCuotas || 0);
    const colchonImporteTotal = Number(colchonBase.importeTotal || 0);
    const colchonPagadoTotal = Number(colchonBase.pagadoTotal || 0);
    const colchonCuotasConPago = Number(colchonBase.cuotasConPago || 0);
    const resumenColchon = {
      totalCuotas: colchonTotalCuotas,
      importeTotal: colchonImporteTotal,
      pagadoTotal: colchonPagadoTotal,
      cuotasConPago: colchonCuotasConPago,
      porcentajeCumplimientoMonto: colchonImporteTotal > 0
        ? Math.round((colchonPagadoTotal / colchonImporteTotal) * 1000) / 10
        : null,
      porcentajeCuotasConPago: colchonTotalCuotas > 0
        ? Math.round((colchonCuotasConPago / colchonTotalCuotas) * 1000) / 10
        : null,
    };
    const objetivoEquipo = objetivos.find((o) => o.alcance === "equipo");
    const montoObjetivoEquipo = Number(objetivoEquipo?.montoObjetivo || 0);

    const porOperador = mapearPagosPorOperador(pagosActuales, empleadosControlados);
    const objetivosOperador = new Map(
      objetivos.filter((o) => o.alcance === "operador").map((o) => [String(o.empleadoId?._id || o.empleadoId), Number(o.montoObjetivo || 0)])
    );
    const actividadMensual = resumirActividadMensual(gestionesActividadPeriodo);
    const actividadHoy = actividadDeUsuarioEnFecha(gestionesActividadHoy, hoyClave);

    const novedadesPorEmpleado = new Map();
    for (const novedad of novedadesRRHH) {
      const key = String(novedad.empleadoId);
      if (!novedadesPorEmpleado.has(key)) novedadesPorEmpleado.set(key, []);
      novedadesPorEmpleado.get(key).push(novedad);
    }

    const pagosHoyPorOperador = new Map(
      mapearPagosPorOperador(pagosHoyDetalle || [], empleadosControlados)
        .map((item) => [normalizeUsername(item.username), Number(item.total || 0)])
    );
    const ahoraMinArgentina = esFechaActual ? minutoActualArgentina() : (24 * 60 - 1);
    const fuenteGestionesDia = esFechaActual ? ultimaGestion : ultimaGestionDia;
    const fuenteGestionesEn = fuenteGestionesDia?.createdAt ? new Date(fuenteGestionesDia.createdAt) : null;
    const fuenteGestionesActualizadaHoy = esFechaActual
      ? Boolean(
          fuenteGestionesEn &&
          !Number.isNaN(fuenteGestionesEn.getTime()) &&
          fechaClaveArgentina(fuenteGestionesEn) === hoyClave
        )
      : Boolean(ultimaGestionDia);
    const fuenteCorteMin = esFechaActual && fuenteGestionesActualizadaHoy ? minutoActualArgentina(fuenteGestionesEn) : null;
    const desfaseGestionesMin = esFechaActual && fuenteGestionesActualizadaHoy && Number.isFinite(fuenteCorteMin)
      ? Math.max(0, Math.round(ahoraMinArgentina - fuenteCorteMin))
      : null;
    const fuenteGestionesReciente = Boolean(esFechaActual && fuenteGestionesActualizadaHoy && Number(desfaseGestionesMin || 0) === 0);
    const corteGestionesMin = esFechaActual && fuenteGestionesActualizadaHoy && Number.isFinite(fuenteCorteMin)
      ? Math.min(ahoraMinArgentina, fuenteCorteMin)
      : null;
    const corteGestionesHora = Number.isFinite(corteGestionesMin) ? horaGestionHHMM(corteGestionesMin) : "";

    const operadores = porOperador.map((item) => {
      const empleado = empleadosControlados.find((e) => String(e._id) === String(item.empleadoId));
      const objetivo = objetivosOperador.get(String(item.empleadoId)) || 0;
      const actividad = actividadMensual.get(normalizeUsername(item.username)) || {};
      const actividadDelDia = actividadHoy.get(normalizeUsername(item.username)) || {};
      const novedadesEmpleado = novedadesPorEmpleado.get(String(item.empleadoId)) || [];
      const minutos = (actividad.dias || []).reduce((total, dia) => {
        const horarioDia = horarioEfectivoParaFecha(empleado, dia.fechaClave, novedadesEmpleado);
        return total + minutosActividadSegunHorario(
          minutosHoraHHMM(dia.primeraGestion),
          minutosHoraHHMM(dia.ultimaGestion),
          horarioDia
        );
      }, 0);
      const esperados = minutosEsperadosEnRango(empleado, desdeClave, hoyClave, novedadesEmpleado);
      const horarioHoy = horarioEfectivoParaFecha(empleado, hoyClave, novedadesEmpleado);
      const novedadesDelDia = novedadesEmpleado.filter((novedad) => novedadCubreFecha(novedad, hoyClave));
      const novedadDia = ["licencia-medica", "falta", "falta-justificada", "dia-estudio", "permiso"]
        .map((tipo) => novedadesDelDia.find((novedad) => novedad.tipo === tipo))
        .find(Boolean) || null;
      const ausenciaJustificadaHoy = ["licencia-medica", "falta-justificada", "dia-estudio", "permiso"].includes(novedadDia?.tipo);
      const primeraMinHoy = minutosHoraHHMM(actividadDelDia.primeraGestion);
      const ultimaMinHoy = minutosHoraHHMM(actividadDelDia.ultimaGestion);
      const minutosTrabajadosHoy = minutosActividadSegunHorario(primeraMinHoy, ultimaMinHoy, horarioHoy);
      const minutosProgramadosHoy = Number(horarioHoy.minutosEsperados || 0);
      const minutosExigiblesHoy = ausenciaJustificadaHoy ? 0 : minutosProgramadosHoy;
      const diferenciaHoyMin = minutosExigiblesHoy > 0 ? minutosTrabajadosHoy - minutosExigiblesHoy : null;
      const faltanHoyMin = minutosExigiblesHoy > 0 ? Math.max(0, minutosExigiblesHoy - minutosTrabajadosHoy) : 0;
      const extraHoyMin = minutosExigiblesHoy > 0 ? Math.max(0, minutosTrabajadosHoy - minutosExigiblesHoy) : 0;
      const salidaHoyMin = minutosHoraHHMM(horarioHoy.salida);
      const entradaHoyMin = minutosHoraHHMM(horarioHoy.entrada);
      const estadoAhoraMin = fuenteGestionesActualizadaHoy && Number.isFinite(corteGestionesMin)
        ? Number(corteGestionesMin)
        : ahoraMinArgentina;
      const jornadaFinalizadaHoy = horarioHoy.programado && Number.isFinite(salidaHoyMin) && estadoAhoraMin >= salidaHoyMin;
      const enDescansoProgramadoHoy = minutoEnDescansoProgramado(estadoAhoraMin, horarioHoy.bloquesHorario);

      // Misma regla que Reportes > Seguimiento: los cortes cerrados salen de las
      // gestiones cargadas y el corte abierto llega únicamente hasta la última carga
      // manual disponible. Solo se llama "actual" si esa carga coincide con el minuto
      // de la consulta. Los espacios fuera de los bloques laborales quedan excluidos.
      const intervalosLaboralesHoy = intervalosLaboralesSinDescanso(actividadDelDia.intervalos || [], horarioHoy)
        .map((intervalo) => ({ ...intervalo, actual: false, abiertoAlCorte: false, origen: "cerrado" }));
      const desdeCorteAbiertoMin = Number.isFinite(ultimaMinHoy)
        ? ultimaMinHoy
        : Number.isFinite(entradaHoyMin)
          ? entradaHoyMin
          : null;
      const intervalosAbiertosHoy = esFechaActual && fuenteGestionesActualizadaHoy && Number.isFinite(desdeCorteAbiertoMin) && Number.isFinite(corteGestionesMin) && corteGestionesMin > desdeCorteAbiertoMin
        ? intervalosLaboralesSinDescanso([{ desdeMin: desdeCorteAbiertoMin, hastaMin: corteGestionesMin }], horarioHoy)
            .map((intervalo) => ({
              ...intervalo,
              actual: Boolean(fuenteGestionesReciente && !jornadaFinalizadaHoy),
              abiertoAlCorte: Boolean(!fuenteGestionesReciente && !jornadaFinalizadaHoy),
              corteDatosHora: corteGestionesHora,
              origen: "abierto",
            }))
        : [];
      const ajusteBreakHoy = aplicarBreakFlexible([...intervalosLaboralesHoy, ...intervalosAbiertosHoy], horarioHoy);
      const intervalosConBreakHoy = ajusteBreakHoy.intervalos;
      const breakPermitidoHoyMin = ajusteBreakHoy.permitidoMin || minutosBreakFlexiblePermitido(horarioHoy);
      const breakConsideradoHoyRaw = ajusteBreakHoy.breakDetalle;
      const bachesDetalleHoy = intervalosConBreakHoy
        .filter((intervalo) => Number(intervalo.duracionMin || 0) > BACHE_VISIBLE_MIN)
        .map((intervalo) => ({
          desde: horaGestionHHMM(intervalo.desdeMin),
          hasta: horaGestionHHMM(intervalo.hastaMin),
          duracionMin: Math.round(Number(intervalo.duracionMin || 0)),
          duracionOriginalMin: Math.round(Number(intervalo.duracionOriginalMin ?? intervalo.duracionMin ?? 0)),
          breakConsideradoMin: Math.round(Number(intervalo.breakConsideradoMin || 0)),
          breakPermitidoMin: Math.round(Number(intervalo.breakPermitidoMin || breakPermitidoHoyMin || 0)),
          actual: Boolean(intervalo.actual),
          abiertoAlCorte: Boolean(intervalo.abiertoAlCorte),
          corteDatosHora: intervalo.corteDatosHora || "",
        }))
        .sort((a, b) => minutosHoraHHMM(a.desde) - minutosHoraHHMM(b.desde));
      const breakConsideradoHoy = breakConsideradoHoyRaw ? {
        desde: horaGestionHHMM(breakConsideradoHoyRaw.desdeMin),
        hasta: horaGestionHHMM(breakConsideradoHoyRaw.hastaMin),
        duracionOriginalMin: Math.round(Number(breakConsideradoHoyRaw.duracionOriginalMin || 0)),
        breakConsideradoMin: Math.round(Number(breakConsideradoHoyRaw.breakConsideradoMin || 0)),
        breakPermitidoMin: Math.round(Number(breakConsideradoHoyRaw.breakPermitidoMin || 0)),
        excedenteMin: Math.round(Number(breakConsideradoHoyRaw.excedenteMin || 0)),
        actual: Boolean(breakConsideradoHoyRaw.actual),
        abiertoAlCorte: Boolean(breakConsideradoHoyRaw.abiertoAlCorte),
        corteDatosHora: breakConsideradoHoyRaw.corteDatosHora || "",
      } : null;
      const baches20Hoy = bachesDetalleHoy.length;
      // Se conserva el campo histórico +30 para no romper consumidores anteriores.
      const baches30Hoy = bachesDetalleHoy.filter((intervalo) => intervalo.duracionMin > 30 && !intervalo.abiertoAlCorte).length;
      const baches60Hoy = bachesDetalleHoy.filter((intervalo) => intervalo.duracionMin > BACHE_CRITICO_MIN && !intervalo.abiertoAlCorte).length;
      const bacheMaximoHoyMin = bachesDetalleHoy.reduce((maximo, intervalo) => Math.max(maximo, Number(intervalo.duracionMin || 0)), 0);

      const minutosAbiertosAlCorteHoy = intervalosConBreakHoy.some((intervalo) => intervalo.origen === "abierto")
        ? Math.round(intervalosConBreakHoy
            .filter((intervalo) => intervalo.origen === "abierto")
            .reduce((sum, intervalo) => sum + Number(intervalo.duracionMin || 0), 0))
        : 0;
      const breakActualCubriendoPausaHoy = Boolean(
        breakConsideradoHoy?.actual && Number(breakConsideradoHoy?.breakConsideradoMin || 0) > 0 && minutosAbiertosAlCorteHoy <= BACHE_VISIBLE_MIN
      );
      const minutosSinGestionHoy = fuenteGestionesReciente ? minutosAbiertosAlCorteHoy : 0;
      const minutosSinGestionAlCorteHoy = fuenteGestionesActualizadaHoy && !fuenteGestionesReciente
        ? minutosAbiertosAlCorteHoy
        : 0;
      const tardanzaInicioHoyMin = Number.isFinite(primeraMinHoy) && Number.isFinite(entradaHoyMin)
        ? Math.max(0, Math.round(primeraMinHoy - entradaHoyMin))
        : 0;
      const inicioAnticipadoHoyMin = Number.isFinite(primeraMinHoy) && Number.isFinite(entradaHoyMin)
        ? Math.max(0, Math.round(entradaHoyMin - primeraMinHoy))
        : 0;

      let estadoJornadaHoy = "sin-jornada";
      let estadoJornadaHoyLabel = horarioHoy.horarioLibre ? "Horario libre" : "Sin jornada hoy";
      const fuenteSinActualizarHoy = !fuenteGestionesActualizadaHoy;
      const fuenteDesactualizada = fuenteGestionesActualizadaHoy && !fuenteGestionesReciente;
      if (novedadDia) {
        estadoJornadaHoy = novedadDia.tipo === "falta" ? "falta" : "novedad";
        estadoJornadaHoyLabel = etiquetaNovedadDia(novedadDia);
      } else if (horarioHoy.horarioLibre) {
        if (minutosTrabajadosHoy >= 240) {
          estadoJornadaHoy = "completa";
          estadoJornadaHoyLabel = "Horario libre · 4 h cumplidas";
        } else if (fuenteSinActualizarHoy) {
          estadoJornadaHoy = "pendiente";
          estadoJornadaHoyLabel = esFechaActual ? "Horario libre · Gestiones sin actualización de hoy" : "Horario libre · Sin gestiones importadas para la fecha";
        } else {
          estadoJornadaHoy = "en-curso";
          estadoJornadaHoyLabel = `Horario libre · ${Math.floor(minutosTrabajadosHoy / 60)}h ${minutosTrabajadosHoy % 60}m de 4 h`;
        }
      } else if (horarioHoy.programado) {
        if (fuenteSinActualizarHoy) {
          estadoJornadaHoy = "pendiente";
          estadoJornadaHoyLabel = esFechaActual ? "Gestiones sin actualización de hoy" : "Sin gestiones importadas para la fecha";
        } else if (Number.isFinite(entradaHoyMin) && estadoAhoraMin < entradaHoyMin && !Number(actividadDelDia.gestiones || 0)) {
          estadoJornadaHoy = "pendiente";
          estadoJornadaHoyLabel = "Todavía no inicia";
        } else if (Number.isFinite(entradaHoyMin) && estadoAhoraMin < entradaHoyMin && Number(actividadDelDia.gestiones || 0) > 0) {
          estadoJornadaHoy = "en-curso";
          estadoJornadaHoyLabel = inicioAnticipadoHoyMin >= ANTICIPO_INICIO_VISIBLE_MIN ? `Actividad antes del horario · inició ${inicioAnticipadoHoyMin} min antes` : "En curso";
        } else if (enDescansoProgramadoHoy) {
          estadoJornadaHoy = "descanso";
          estadoJornadaHoyLabel = "Entre bloques de horario";
        } else if (jornadaFinalizadaHoy) {
          if (!Number(actividadDelDia.gestiones || 0)) {
            estadoJornadaHoy = "sin-actividad";
            estadoJornadaHoyLabel = "Ausente · sin gestiones";
          } else if (faltanHoyMin > 15) {
            estadoJornadaHoy = "incompleta";
            estadoJornadaHoyLabel = `Terminó · faltan ${Math.floor(faltanHoyMin / 60)}h ${faltanHoyMin % 60}m`;
          } else if (extraHoyMin > 15) {
            estadoJornadaHoy = "extra";
            estadoJornadaHoyLabel = `Completa · +${Math.floor(extraHoyMin / 60)}h ${extraHoyMin % 60}m extra voluntaria`;
          } else {
            estadoJornadaHoy = "completa";
            estadoJornadaHoyLabel = "Jornada completa";
          }
        } else if (fuenteDesactualizada) {
          estadoJornadaHoy = "en-curso";
          estadoJornadaHoyLabel = `En curso · datos al corte ${corteGestionesHora || "disponible"}`;
        } else if (!Number(actividadDelDia.gestiones || 0)) {
          estadoJornadaHoy = "sin-actividad";
          estadoJornadaHoyLabel = "No inició · sin gestiones";
        } else if (fuenteGestionesReciente && breakActualCubriendoPausaHoy) {
          estadoJornadaHoy = "descanso";
          const totalPausa = Number(breakConsideradoHoy?.duracionOriginalMin || 0);
          const considerado = Number(breakConsideradoHoy?.breakConsideradoMin || 0);
          estadoJornadaHoyLabel = totalPausa <= considerado
            ? `Break considerado · ${Math.round(totalPausa)} de ${Math.round(breakPermitidoHoyMin)} min`
            : `Break considerado · ${Math.round(considerado)} min + ${Math.round(minutosSinGestionHoy)} min de excedente`;
        } else if (Number(minutosSinGestionHoy || 0) > BACHE_CRITICO_MIN) {
          estadoJornadaHoy = "alerta";
          estadoJornadaHoyLabel = `Bache actual ${Math.round(minutosSinGestionHoy)} min`;
        } else if (Number(minutosSinGestionHoy || 0) > BACHE_VISIBLE_MIN) {
          estadoJornadaHoy = "atencion";
          estadoJornadaHoyLabel = `Corte actual ${Math.round(minutosSinGestionHoy)} min`;
        } else if (tardanzaInicioHoyMin > TARDANZA_INICIO_VISIBLE_MIN) {
          estadoJornadaHoy = "atencion";
          estadoJornadaHoyLabel = `En curso · inició ${tardanzaInicioHoyMin} min tarde`;
        } else if (inicioAnticipadoHoyMin >= ANTICIPO_INICIO_VISIBLE_MIN) {
          estadoJornadaHoy = "en-curso";
          estadoJornadaHoyLabel = `En curso · inició ${inicioAnticipadoHoyMin} min antes`;
        } else {
          estadoJornadaHoy = "en-curso";
          estadoJornadaHoyLabel = "En curso";
        }
      }


      return {
        ...item,
        objetivo,
        porcentajeObjetivo: objetivo > 0 ? Math.round((item.total / objetivo) * 1000) / 10 : null,
        minutosTrabajados: minutos,
        minutosEsperados: esperados,
        porcentajeHoras: esperados > 0 ? Math.round((minutos / esperados) * 1000) / 10 : null,
        diasConActividad: Number(actividad.diasConActividad || 0),
        gestionesPeriodo: Number(actividad.gestiones || 0),
        baches30: Number(actividad.baches30 || 0),
        baches60: Number(actividad.baches60 || 0),
        bacheMaximoMin: Number(actividad.bacheMaximoMin || 0),
        primeraGestionHoy: actividadDelDia.primeraGestion || "",
        ultimaGestionHoy: actividadDelDia.ultimaGestion || "",
        gestionesHoy: Number(actividadDelDia.gestiones || 0),
        minutosTrabajadosHoy,
        minutosProgramadosHoy,
        minutosExigiblesHoy,
        diferenciaHoyMin,
        faltanHoyMin,
        extraHoyMin,
        baches20Hoy,
        baches30Hoy,
        baches60Hoy,
        bacheMaximoHoyMin,
        bachesDetalleHoy,
        breakPermitidoHoyMin,
        breakConsideradoHoy,
        tardanzaInicioHoyMin,
        inicioAnticipadoHoyMin,
        minutosSinGestionHoy,
        minutosSinGestionAlCorteHoy,
        corteDatosHora: corteGestionesHora,
        fuenteGestionesActualizadaHoy,
        fuenteGestionesReciente,
        jornadaFinalizadaHoy,
        enDescansoProgramadoHoy,
        estadoJornadaHoy,
        estadoJornadaHoyLabel,
        novedadHoyTipo: novedadDia?.tipo || "",
        novedadHoyDescripcion: novedadDia?.descripcion || "",
        novedadHoyJustificado: Boolean(novedadDia && (novedadDia.justificado || ["falta-justificada", "licencia-medica", "dia-estudio", "permiso"].includes(novedadDia.tipo))),
        recaudadoHoy: pagosHoyPorOperador.get(normalizeUsername(item.username)) || 0,
        horarioHoy: horarioHoy.etiqueta,
        bloquesHorarioHoy: horarioHoy.bloquesHorario || [],
        bloquesActividadHoy: bloquesActividadDia(actividadDelDia),
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

    // Para Supervisión no alcanza con saber que un acuerdo "venció" por fecha: si ya
    // tiene un pago válido cruzado por DNI + entidad, no debe aparecer como vencido
    // pendiente. Reutilizamos exactamente el criterio del Reporte de Acuerdos.
    let acuerdosConPagos = acuerdosValidos;
    let crucePagosDisponible = false;
    let crucePagosHasta = "";
    let pagosCruceCantidad = 0;
    if (ultimaPago && acuerdosValidos.length) {
      try {
        const dnisAcuerdos = [...new Set(
          acuerdosValidos
            .map((row) => String(row?.dni || "").replace(/\D/g, ""))
            .filter(Boolean)
        )];
        const fechasAcuerdos = acuerdosValidos
          .map((row) => String(row?.fecha || "").slice(0, 10))
          .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
          .sort();
        const primeraFecha = fechasAcuerdos[0] ? inicioDiaCalendarioUTC(fechasAcuerdos[0]) : null;
        const pagoDesde = primeraFecha ? new Date(primeraFecha.getTime() - 90 * 86400000) : selectedDesdeUTC;
        const pagoHasta = selectedHastaUTC < hoyReal ? selectedHastaUTC : hoyReal;
        const pagosCruce = dnisAcuerdos.length
          ? await Pago.find({
              dni: { $in: dnisAcuerdos },
              fechaPago: { $gte: pagoDesde, $lte: pagoHasta },
            })
              .select("idPago dni entidadId subCesionId fechaPago monto conceptoCodigo estado operadorUsername")
              .sort({ fechaPago: 1, _id: 1 })
              .lean()
              .maxTimeMS(15000)
          : [];
        acuerdosConPagos = vincularPagosPosteriores(acuerdosValidos, pagosCruce, entidades, { disponible: true });
        crucePagosDisponible = true;
        crucePagosHasta = fechaClaveArgentina(pagoHasta);
        pagosCruceCantidad = pagosCruce.length;
      } catch (error) {
        console.warn("Cruce opcional acuerdos/pagos en Supervisión no disponible:", error?.message || error);
      }
    }

    const estadosConPagoValido = new Set([
      "CON PAGO POSTERIOR",
      "CON PAGO VÁLIDO",
      "PAGO MISMO DÍA",
      "PAGO MISMO DÍA VÁLIDO",
    ]);
    const tienePagoValido = (acuerdo) => crucePagosDisponible && estadosConPagoValido.has(String(acuerdo?.estadoPagoAcuerdo || ""));

    const ultimoAcuerdoMango = acuerdosValidos[0] || null;
    const ultimaFechaAcuerdoMango = ultimoAcuerdoMango?.fecha
      ? fechaHoraGestionLocal(ultimoAcuerdoMango.fecha, ultimoAcuerdoMango.hora)
      : null;
    const acuerdosPorOperadorMap = new Map();
    const acuerdosPorTipoMap = new Map();
    let montoTotalAcuerdos = 0;
    let primerPagoTotal = 0;
    let acuerdosVencidos = 0;
    let acuerdosVencidosHistoricos = 0;
    let acuerdosVencidosConPago = 0;
    let acuerdosVenceHoy = 0;
    let acuerdosProximos = 0;
    let acuerdosConPago = 0;
    let montoPagadoAcuerdos = 0;
    let acuerdosExigibles = 0;
    let acuerdosExigiblesConPago = 0;
    let primerPagoExigibleTotal = 0;
    let montoPagadoExigibles = 0;

    for (const acuerdo of acuerdosConPagos) {
      // operadorGestion conserva quién cargó el acuerdo aunque el cruce encuentre
      // que el pago fue imputado por otro operador.
      const usuario = String(acuerdo.operadorGestion || acuerdo.usuario || "Sin operador").trim() || "Sin operador";
      const usuarioControlado = usuariosControlados.has(normalizeUsername(usuario));
      const conPago = tienePagoValido(acuerdo);
      const montoPagado = conPago ? Number(acuerdo.montoPagosValidos || acuerdo.montoPagosPosteriores || 0) : 0;
      const tipo = acuerdo.tipoAcuerdo || "Sin clasificar";

      if (usuarioControlado) {
        const actual = acuerdosPorOperadorMap.get(usuario) || {
          usuario,
          total: 0,
          montoTotal: 0,
          primerPagoTotal: 0,
          conPago: 0,
          montoPagado: 0,
          sinPago: 0,
          vencidos: 0,
          vencidosHistoricos: 0,
          vencidosConPago: 0,
          venceHoy: 0,
          proximos: 0,
          exigibles: 0,
          exigiblesConPago: 0,
          primerPagoExigibleTotal: 0,
          montoPagadoExigibles: 0,
          tiposMap: new Map(),
        };
        actual.total += 1;
        actual.montoTotal += Number(acuerdo.montoTotalAcuerdo || 0);
        actual.primerPagoTotal += Number(acuerdo.primerPago || 0);
        if (conPago) {
          actual.conPago += 1;
          actual.montoPagado += montoPagado;
        } else {
          actual.sinPago += 1;
        }
        actual.tiposMap.set(tipo, (actual.tiposMap.get(tipo) || 0) + 1);
        if (acuerdo.estadoVencimiento === "VENCIDO") {
          actual.vencidosHistoricos += 1;
          if (conPago) actual.vencidosConPago += 1;
          else actual.vencidos += 1;
        }
        if (!conPago && acuerdo.estadoVencimiento === "VENCE HOY") actual.venceHoy += 1;
        if (!conPago && acuerdo.estadoVencimiento === "PRÓXIMO 3 DÍAS") actual.proximos += 1;
        if (["VENCIDO", "VENCE HOY"].includes(acuerdo.estadoVencimiento)) {
          actual.exigibles += 1;
          actual.primerPagoExigibleTotal += Number(acuerdo.primerPago || 0);
          if (conPago) {
            actual.exigiblesConPago += 1;
            actual.montoPagadoExigibles += montoPagado;
          }
        }
        acuerdosPorOperadorMap.set(usuario, actual);
      }

      acuerdosPorTipoMap.set(tipo, (acuerdosPorTipoMap.get(tipo) || 0) + 1);
      montoTotalAcuerdos += Number(acuerdo.montoTotalAcuerdo || 0);
      primerPagoTotal += Number(acuerdo.primerPago || 0);
      if (conPago) {
        acuerdosConPago += 1;
        montoPagadoAcuerdos += montoPagado;
      }
      if (acuerdo.estadoVencimiento === "VENCIDO") {
        acuerdosVencidosHistoricos += 1;
        if (conPago) acuerdosVencidosConPago += 1;
        else acuerdosVencidos += 1;
      }
      if (!conPago && acuerdo.estadoVencimiento === "VENCE HOY") acuerdosVenceHoy += 1;
      if (!conPago && acuerdo.estadoVencimiento === "PRÓXIMO 3 DÍAS") acuerdosProximos += 1;
      if (["VENCIDO", "VENCE HOY"].includes(acuerdo.estadoVencimiento)) {
        acuerdosExigibles += 1;
        primerPagoExigibleTotal += Number(acuerdo.primerPago || 0);
        if (conPago) {
          acuerdosExigiblesConPago += 1;
          montoPagadoExigibles += montoPagado;
        }
      }
    }

    const acuerdosPorOperador = [...acuerdosPorOperadorMap.values()]
      .map(({ tiposMap, ...item }) => ({
        ...item,
        porcentajeCumplimiento: item.exigibles > 0
          ? Math.round((item.exigiblesConPago / item.exigibles) * 1000) / 10
          : null,
        porcentajeCumplimientoMonto: item.primerPagoExigibleTotal > 0
          ? Math.round((item.montoPagadoExigibles / item.primerPagoExigibleTotal) * 1000) / 10
          : null,
        tipos: [...tiposMap.entries()]
          .map(([tipo, total]) => ({ tipo, total }))
          .sort((a, b) => b.total - a.total || String(a.tipo).localeCompare(String(b.tipo), "es")),
      }))
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
          ? "Sin gestiones en días laborables del período"
          : `${Math.floor(o.minutosTrabajados / 60)}h ${Math.round(o.minutosTrabajados % 60)}m entre primera y última gestión por día · faltan ${Math.floor(o.deficitMinutos / 60)}h ${Math.round(o.deficitMinutos % 60)}m`,
      }));

    const objetivosParaRevisar = operadores
      .filter((o) => o.objetivo > 0)
      .sort((a, b) => a.porcentajeObjetivo - b.porcentajeObjetivo)
      .slice(0, 12);

    // Una novedad sin fechaHasta cubre solamente su fechaDesde. Esto evita que
    // una falta de un día quede apareciendo como vigente para siempre.
    const novedadActivaHoy = (novedad) => novedadCubreFecha(novedad, hoyClave);
    const empleadoDeNovedad = (novedad) => empleadosControlados.find(
      (empleado) => String(empleado._id) === String(novedad.empleadoId)
    );
    const novedadesHoy = novedadesRRHH.filter(novedadActivaHoy);
    const cambiosHorarioHoy = novedadesHoy
      .filter((novedad) => novedad.tipo === "cambio-horario")
      .map((novedad) => {
        const empleado = empleadoDeNovedad(novedad) || {};
        const primerBloque = [novedad.horaEntradaNueva, novedad.horaSalidaNueva].filter(Boolean).join(" a ");
        const segundoBloque = novedad.jornadaPartidaNueva
          ? [novedad.horaEntradaSegundaNueva, novedad.horaSalidaSegundaNueva].filter(Boolean).join(" a ")
          : "";
        const horario = [primerBloque, segundoBloque].filter(Boolean).join(" / ");
        return { empleadoId: novedad.empleadoId, username: empleado.username || "", nombre: empleado.nombre || "", horario: horario || "Horario especial" };
      });
    const licenciasMedicasHoy = novedadesHoy
      .filter((novedad) => novedad.tipo === "licencia-medica")
      .map((novedad) => {
        const empleado = empleadoDeNovedad(novedad) || {};
        return { empleadoId: novedad.empleadoId, username: empleado.username || "", nombre: empleado.nombre || "", descripcion: novedad.descripcion || "" };
      });
    const ausenciasHoy = novedadesHoy
      .filter((novedad) => ["falta", "falta-justificada", "dia-estudio", "permiso"].includes(novedad.tipo))
      .map((novedad) => {
        const empleado = empleadoDeNovedad(novedad) || {};
        return {
          empleadoId: novedad.empleadoId,
          username: empleado.username || "",
          nombre: empleado.nombre || "",
          tipo: novedad.tipo,
          justificado: Boolean(novedad.justificado || novedad.tipo === "falta-justificada"),
          descripcion: novedad.descripcion || "",
        };
      });
    const faltasHoy = ausenciasHoy.filter((item) => ["falta", "falta-justificada"].includes(item.tipo));
    const historialRRHH = [...novedadesRRHH]
      .filter((novedad) => {
        const inicio = fechaClaveNovedad(novedad.fechaDesde);
        const fin = fechaClaveNovedad(novedad.fechaHasta);
        if (!inicio) return false;
        if (!fin) return inicio >= desdeClave && inicio <= hastaClave;
        return inicio <= hastaClave && fin >= desdeClave;
      })
      .sort((a, b) => new Date(b.fechaDesde || b.createdAt || 0) - new Date(a.fechaDesde || a.createdAt || 0))
      .slice(0, 18)
      .map((novedad) => {
        const empleado = empleadoDeNovedad(novedad) || {};
        const primerBloque = [novedad.horaEntradaNueva, novedad.horaSalidaNueva].filter(Boolean).join(" a ");
        const segundoBloque = novedad.jornadaPartidaNueva
          ? [novedad.horaEntradaSegundaNueva, novedad.horaSalidaSegundaNueva].filter(Boolean).join(" a ")
          : "";
        const horario = [primerBloque, segundoBloque].filter(Boolean).join(" / ");
        return {
          id: String(novedad._id || ""),
          empleadoId: novedad.empleadoId,
          username: empleado.username || "",
          nombre: empleado.nombre || "",
          tipo: novedad.tipo,
          tipoLabel: etiquetaTipoNovedad(novedad.tipo),
          fechaDesde: fechaClaveNovedad(novedad.fechaDesde),
          fechaHasta: fechaClaveNovedad(novedad.fechaHasta),
          descripcion: novedad.descripcion || "",
          horario,
          justificado: Boolean(novedad.justificado || novedad.tipo === "falta-justificada"),
        };
      });
    const conGestionesHoy = actividadHoy.size;

    return res.json({
      mesActual: mesSeleccionado,
      mesSeleccionado,
      esMesActual: mesSeleccionado === mesReal,
      fechaConsulta: hoyClave,
      esFechaActual,
      periodoHasta: hoyClave,
      alertasEnTiempoReal: esFechaActual,
      historico: {
        solicitado: !esFechaActual,
        fecha: hoyClave,
        fuentesConCorteExacto: ["Gestiones Mango", "Pagos", "Acuerdos", "RRHH"],
        fuentesSinSnapshot: ["Colchón"],
      },
      evaluadoEn: hoyReal,
      recaudacion: {
        ultimosTresMeses: recaudacionTresMeses,
        mesActual: totalActual,
        pagosCantidadPeriodo: pagosActuales.length,
        objetivoEquipo: montoObjetivoEquipo,
        porcentajeObjetivoEquipo: montoObjetivoEquipo > 0 ? Math.round((totalActual / montoObjetivoEquipo) * 1000) / 10 : null,
        porOperador: operadores.sort((a, b) => b.total - a.total),
        porEntidad,
        porCartera,
      },
      hoy: {
        pagosCantidad: Number(pagosHoyAgg?.[0]?.cantidad || 0),
        pagosTotal: Number(pagosHoyAgg?.[0]?.total || 0),
        presentesAhora: conGestionesHoy,
        conGestionesHoy,
        fichadosAhora,
        jornadasSinSalida,
        cambiosHorario: cambiosHorarioHoy.length,
        licenciasMedicas: licenciasMedicasHoy.length,
        faltas: faltasHoy.length,
        ausencias: ausenciasHoy.length,
      },
      alertas: {
        proyeccionesCaidas,
        proyeccionesManuales,
        colchonSinGestion,
        pagosInformadosPendientes: pendientesColchon + pendientesProyecciones,
        pagosInformadosColchon: pendientesColchon,
        pagosInformadosProyecciones: pendientesProyecciones,
        horasParaRevisar,
        objetivosParaRevisar,
        cambiosHorarioHoy,
        licenciasMedicasHoy,
        faltasHoy,
        ausenciasHoy,
        historialRRHH,
      },
      acuerdos: {
        total: acuerdosValidos.length,
        montoTotal: montoTotalAcuerdos,
        primerPagoTotal,
        conPago: acuerdosConPago,
        sinPago: Math.max(0, acuerdosValidos.length - acuerdosConPago),
        montoPagado: montoPagadoAcuerdos,
        exigibles: acuerdosExigibles,
        exigiblesConPago: acuerdosExigiblesConPago,
        primerPagoExigibleTotal,
        montoPagadoExigibles,
        porcentajeCumplimiento: acuerdosExigibles > 0
          ? Math.round((acuerdosExigiblesConPago / acuerdosExigibles) * 1000) / 10
          : null,
        porcentajeCumplimientoMonto: primerPagoExigibleTotal > 0
          ? Math.round((montoPagadoExigibles / primerPagoExigibleTotal) * 1000) / 10
          : null,
        // "vencidos" significa vencidos que siguen sin pago válido. Los que ya
        // tienen pago se informan aparte para evitar falsas alertas.
        vencidos: acuerdosVencidos,
        vencidosHistoricos: acuerdosVencidosHistoricos,
        vencidosConPago: acuerdosVencidosConPago,
        venceHoy: acuerdosVenceHoy,
        proximos: acuerdosProximos,
        porOperador: acuerdosPorOperador,
        porTipo: acuerdosPorTipo,
        crucePagos: {
          disponible: crucePagosDisponible,
          pagosConsultados: pagosCruceCantidad,
          periodoHasta: crucePagosHasta,
        },
        fuente: "reporte-gestiones",
      },
      colchon: resumenColchon,
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
        gestionesConsulta: ultimaGestionDia || null,
        colchon: ultimaColchon ? {
          fecha: ultimaColchon.ultimaModificacion || ultimaColchon.creado || null,
        } : null,
        rrhh: ultimaNovedadRRHH ? {
          fecha: ultimaNovedadRRHH.updatedAt || ultimaNovedadRRHH.createdAt || ultimaNovedadRRHH.fechaDesde || null,
          tipo: ultimaNovedadRRHH.tipo || "",
        } : null,
      },
      objetivos,
    });
  } catch (error) {
    console.error("Panel supervisión:", error);
    return res.status(500).json({ error: "No se pudo preparar el panel de supervisión" });
  }
}
