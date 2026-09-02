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
import ContactadoVentana from "../models/ContactadoVentana.js";
import {
  horarioEfectivoParaFecha,
  minutosEsperadosEnRango,
  novedadCubreFecha,
  rangoMesLocal,
  minutosActividadSegunHorario,
  intervalosAjustadosPorDescanso,
  intervalosExcluyendoBloques,
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
import { transformarGestionEnAcuerdo, resolverEpisodiosAcuerdos, vincularPagosPosteriores } from "../services/acuerdosGestionesService.js";
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

// Mango usa un conjunto acotado de resultados para acuerdos reales. Antes
// Supervisión consultaba /acuerdo/i sobre seis meses de gestiones: esa regex no
// aprovecha bien los índices y, con mucho volumen, podía escanear una parte enorme
// de ReporteGestion. La lista exacta excluye además "Bajo acuerdo/Baja acuerdo".
const RESULTADOS_ACUERDO_MANGO = [
  "Acuerdo libre", "ACUERDO LIBRE", "acuerdo libre",
  "Acuerdo parcial", "ACUERDO PARCIAL", "acuerdo parcial",
  "Acuerdo anticipo mas cuotas", "ACUERDO ANTICIPO MAS CUOTAS", "acuerdo anticipo mas cuotas",
  "Acuerdo en cuota/s", "ACUERDO EN CUOTA/S", "acuerdo en cuota/s",
  "Acuerdo en cuota", "ACUERDO EN CUOTA", "acuerdo en cuota",
  "Acuerdo en cuotas", "ACUERDO EN CUOTAS", "acuerdo en cuotas",
];

const SUPERVISION_QUERY_MS = 7000;
const SUPERVISION_CRUCE_PAGOS_MS = 6000;

async function consultaOpcional(nombre, query, fallback, errores) {
  try {
    return await query;
  } catch (error) {
    const mensaje = String(error?.message || error || "Error desconocido");
    console.warn(`[Supervisión] ${nombre} no disponible:`, mensaje);
    errores.push({ fuente: nombre, mensaje });
    return fallback;
  }
}

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
  if (tipo === "vacaciones") return "Vacaciones";
  if (tipo === "falta-justificada") return "Falta justificada";
  if (tipo === "falta") return "Falta sin justificar";
  if (tipo === "dia-estudio") return "Día de estudio";
  if (tipo === "permiso") return "Permiso / ausencia";
  return "";
}

function bloquesCapacitacionDelDia(novedades = [], fechaClave = "") {
  return (Array.isArray(novedades) ? novedades : [])
    .filter((novedad) => novedad?.tipo === "capacitacion" && novedadCubreFecha(novedad, fechaClave))
    .map((novedad) => ({
      desdeMin: minutosHoraHHMM(novedad?.horaInicio),
      hastaMin: minutosHoraHHMM(novedad?.horaFin),
      descripcion: novedad?.descripcion || "Capacitación",
    }))
    .filter((bloque) => Number.isFinite(bloque.desdeMin) && Number.isFinite(bloque.hastaMin) && bloque.hastaMin > bloque.desdeMin)
    .sort((a, b) => a.desdeMin - b.desdeMin);
}

function minutosCapacitacionDentroHorario(bloques = [], horario = {}) {
  return intervalosLaboralesSinDescanso(bloques, horario)
    .reduce((sum, bloque) => sum + Number(bloque?.duracionMin || 0), 0);
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
  const iniciadoEnMs = Date.now();
  const erroresFuentes = [];
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
    const finMesSeleccionadoUTC = finDiaCalendarioUTC(hastaClave);
    // Para proyectar lo que efectivamente debe entrar en el mes necesitamos
    // también acuerdos generados antes cuyo primer pago vence en este mes.
    const acuerdosProyeccionDesdeUTC = new Date(selectedDesdeUTC.getTime() - 185 * 86400000);
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
    // Los perfiles no controlados siguen aportando a métricas de equipo. Sólo se
    // los excluye de evaluaciones/tablas individuales.
    const listaUsuariosActivos = empleados
      .map((empleado) => normalizeUsername(empleado?.username))
      .filter(Boolean);

    const [pagosTres, objetivos, novedadesRRHH, gestionesActividadPeriodo,
      proyeccionesCaidas, proyeccionesManuales, colchonSinGestion, pendientesColchon, pendientesProyecciones, ultimaPago,
      ultimaGestionAcuerdo, ultimaGestion, ultimaGestionDia, fichadosAhora,
      jornadasSinSalida, ultimaAcuerdoManual, acuerdosManualesCantidad, colchonResumenRows, ultimaColchon, ultimaNovedadRRHH, entidadesCatalogo, gestionesAcuerdoProyeccion] = await Promise.all([
      Pago.find({ fechaPago: { $gte: desdeTres, $lte: hasta } })
        .select("dni monto fechaPago operadorId operadorUsername entidadId subCesionId")
        .lean()
        .maxTimeMS(SUPERVISION_QUERY_MS),
      ObjetivoMensual.find({ mes: mesSeleccionado, activo: true })
        .populate("empleadoId", "username nombre")
        .populate("subCesionId", "nombre")
        .lean(),
      NovedadRRHH.find({
        empleadoId: { $in: idsControlados },
        tipo: { $in: ["cambio-horario", "licencia-medica", "vacaciones", "falta", "falta-justificada", "dia-estudio", "permiso", "capacitacion"] },
        estado: { $ne: "anulado" },
        fechaDesde: { $lte: hastaNovedades },
        $or: [{ fechaHasta: null }, { fechaHasta: { $gte: desdeNovedades } }],
      }).lean(),
      // Actividad base del período: incluye a TODOS los usuarios activos. Más abajo
      // la tabla/Jornada individual se arma sólo con empleadosControlados, pero
      // el TOTAL EQUIPO y la frescura de Gestiones no pueden perder aportes de
      // mandos medios/perfiles ocultos de control.
      ReporteGestion.find({
        fecha: { $gte: selectedDesdeUTC, $lte: selectedHastaUTC },
        borrado: { $ne: true },
        usuario: { $in: listaUsuariosActivos },
      }).select("fecha hora usuario").lean().maxTimeMS(SUPERVISION_QUERY_MS),
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
      ReporteGestion.findOne({
        borrado: { $ne: true },
        resultadoGestion: { $in: RESULTADOS_ACUERDO_MANGO },
        usuario: { $in: listaUsuariosActivos },
      })
        .sort({ createdAt: -1 })
        .select("createdAt fecha hora usuario resultadoGestion fuenteArchivo")
        .lean()
        .maxTimeMS(SUPERVISION_QUERY_MS),
      ReporteGestion.findOne({ borrado: { $ne: true } }).sort({ createdAt: -1 }).select("createdAt fecha fuenteArchivo").lean(),
      ReporteGestion.findOne({
        fecha: { $gte: hoyDesdeUTC, $lte: hoyHastaUTC },
        borrado: { $ne: true },
        usuario: { $in: listaUsuariosActivos },
      }).sort({ createdAt: -1 }).select("createdAt fecha hora fuenteArchivo usuario").lean(),
      Asistencia.countDocuments({ empleado: { $in: idsControlados }, fechaClave: hoyClave, estado: "presente" }),
      Asistencia.countDocuments({ empleado: { $in: idsControlados }, fechaClave: { $lt: hoyClave }, estado: "presente" }),
      AcuerdoPago.findOne({ mes: mesSeleccionado, fecha: { $lte: selectedHastaUTC } })
        .sort({ fechaHora: -1, createdAt: -1 })
        .select("fechaHora createdAt fuenteArchivo operador")
        .lean(),
      AcuerdoPago.countDocuments({ mes: mesSeleccionado, fecha: { $lte: selectedHastaUTC } }),
      consultaOpcional(
        "Colchón resumen",
        Colchon.aggregate([
          { $match: { creado: { $lte: selectedHastaUTC } } },
          {
            $group: {
              _id: {
                dni: "$dni",
                entidadId: "$entidadId",
                entidadNumero: "$entidadNumero",
                subCesionId: "$subCesionId",
              },
              importeCuota: { $sum: { $ifNull: ["$importeCuota", 0] } },
              cuotas: { $sum: 1 },
            },
          },
          {
            $project: {
              _id: 0,
              dni: "$_id.dni",
              entidadId: "$_id.entidadId",
              entidadNumero: "$_id.entidadNumero",
              subCesionId: "$_id.subCesionId",
              importeCuota: 1,
              cuotas: 1,
            },
          },
        ]).option({ maxTimeMS: SUPERVISION_QUERY_MS }).allowDiskUse(true),
        [],
        erroresFuentes
      ),
      Colchon.findOne({ creado: { $lte: selectedHastaUTC } }).sort({ ultimaModificacion: -1, creado: -1 }).select("ultimaModificacion creado").lean(),
      NovedadRRHH.findOne({ estado: { $ne: "anulado" } }).sort({ updatedAt: -1, createdAt: -1 }).select("updatedAt createdAt tipo fechaDesde").lean(),
      Entidad.find({}).select("_id numero nombre").lean(),
      consultaOpcional(
        "Acuerdos Mango",
        ReporteGestion.find({
          fecha: { $gte: acuerdosProyeccionDesdeUTC, $lte: finMesSeleccionadoUTC },
          borrado: { $ne: true },
          usuario: { $in: listaUsuariosActivos },
          resultadoGestion: { $in: RESULTADOS_ACUERDO_MANGO },
        })
          .select("dni nombreDeudor fecha hora usuario tipoContacto resultadoGestion estadoCuenta telMailMarcado observacionGestion entidad entidadNumero")
          .sort({ fecha: -1, hora: -1, _id: -1 })
          .lean()
          .maxTimeMS(SUPERVISION_QUERY_MS),
        [],
        erroresFuentes
      ),
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
    const pagosDiaSeleccionado = pagosTres.filter((p) => p.fechaPago >= hoyDesde && p.fechaPago <= hoyHasta);
    const pagosDiaSeleccionadoTotal = pagosDiaSeleccionado.reduce((sum, p) => sum + Number(p.monto || 0), 0);
    const totalActual = pagosActuales.reduce((sum, p) => sum + Number(p.monto || 0), 0);
    // Antes esta métrica hacía un $lookup a Pagos POR CADA fila de Colchón.
    // Conservamos exactamente la misma regla de cruce (DNI + entidad + subcesión),
    // pero usando los pagos del mes ya cargados y mapas en memoria.
    const entidadNumeroPorId = new Map(
      (entidadesCatalogo || []).map((entidad) => [String(entidad._id), Number(entidad.numero || 0)])
    );
    const pagosMesPorCaso = new Map();
    for (const pago of pagosActuales) {
      const dni = String(pago?.dni || "").replace(/\D/g, "");
      const entidadNumero = Number(pago?.entidadId || 0);
      const subCesionId = String(pago?.subCesionId || "");
      if (!dni || !entidadNumero || !subCesionId) continue;
      const key = `${dni}|${entidadNumero}|${subCesionId}`;
      pagosMesPorCaso.set(key, Number(pagosMesPorCaso.get(key) || 0) + Number(pago?.monto || 0));
    }

    let colchonTotalCuotas = 0;
    let colchonImporteTotal = 0;
    let colchonPagadoTotal = 0;
    let colchonCuotasConPago = 0;
    for (const cuota of colchonResumenRows || []) {
      const dni = String(cuota?.dni || "").replace(/\D/g, "");
      const entidadNumero = Number(cuota?.entidadNumero || entidadNumeroPorId.get(String(cuota?.entidadId || "")) || 0);
      const subCesionId = String(cuota?.subCesionId || "");
      const key = `${dni}|${entidadNumero}|${subCesionId}`;
      const pagado = Number(pagosMesPorCaso.get(key) || 0);
      const cuotas = Math.max(1, Number(cuota?.cuotas || 1));
      colchonTotalCuotas += cuotas;
      colchonImporteTotal += Number(cuota?.importeCuota || 0);
      // El pago se suma una sola vez por DNI+entidad+subcesión. La versión
      // anterior podía repetir el mismo pago si el Colchón tenía varias cuotas
      // del mismo caso.
      colchonPagadoTotal += pagado;
      if (pagado > 0) colchonCuotasConPago += cuotas;
    }

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
    const objetivosPorUsername = new Map(
      empleadosControlados.map((empleado) => [
        normalizeUsername(empleado.username),
        objetivosOperador.get(String(empleado._id)) || 0,
      ])
    );
    const actividadMensual = resumirActividadMensual(gestionesActividadPeriodo);
    const actividadHoy = actividadDeUsuarioEnFecha(gestionesActividadPeriodo, hoyClave);

    // El panel principal conserva la misma consulta de Jornada que tenía antes
    // de incorporar "Gestiones". Aquí sólo reutilizamos ese resumen en memoria.
    // Cuentas trabajadas + casos nuevos se calculan aparte para no bloquear todo
    // Supervisión con el cruce histórico de 90 días.
    const gestionesPorOperadorHoy = empleadosControlados.map((empleado) => {
      const username = normalizeUsername(empleado.username);
      const actividad = actividadHoy.get(username) || {};
      return {
        empleadoId: empleado._id,
        nombre: empleado.nombre || empleado.username,
        username: empleado.username,
        gestiones: Number(actividad.gestiones || 0),
        cuentasTrabajadas: null,
        casosNuevos: null,
        primeraGestion: actividad.primeraGestion || "",
        ultimaGestion: actividad.ultimaGestion || "",
      };
    });
    const resumenGestionesHoy = {
      // El resumen del equipo sale de actividadHoy (todos los activos); las filas
      // por operador siguen siendo únicamente las personas sujetas a control.
      totalGestiones: [...actividadHoy.values()].reduce((sum, item) => sum + Number(item?.gestiones || 0), 0),
      cuentasTrabajadas: null,
      casosNuevos: null,
      casosNuevosPendiente: true,
      operadoresConActividad: actividadHoy.size,
      ventanaCasosNuevosDias: 90,
      porOperador: gestionesPorOperadorHoy
        .filter((item) => Number(item.gestiones || 0) > 0)
        .sort((a, b) => b.gestiones - a.gestiones || String(a.username).localeCompare(String(b.username), "es")),
    };

    const novedadesPorEmpleado = new Map();
    for (const novedad of novedadesRRHH) {
      const key = String(novedad.empleadoId);
      if (!novedadesPorEmpleado.has(key)) novedadesPorEmpleado.set(key, []);
      novedadesPorEmpleado.get(key).push(novedad);
    }

    const pagosHoyPorOperador = new Map(
      mapearPagosPorOperador(pagosDiaSeleccionado, empleadosControlados)
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
      const novedadDia = ["licencia-medica", "vacaciones", "falta", "falta-justificada", "dia-estudio", "permiso"]
        .map((tipo) => novedadesDelDia.find((novedad) => novedad.tipo === tipo))
        .find(Boolean) || null;
      const ausenciaJustificadaHoy = ["licencia-medica", "vacaciones", "falta-justificada", "dia-estudio", "permiso"].includes(novedadDia?.tipo);
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
      // La hora de importación del Excel no forma parte del cálculo de jornada.
      // El estado usa la hora real de la consulta y los baches sólo horas reales de
      // gestión/franja RRHH. Durante la jornada no se inventa un corte abierto.
      const estadoAhoraMin = ahoraMinArgentina;
      const jornadaFinalizadaHoy = horarioHoy.programado && Number.isFinite(salidaHoyMin) && estadoAhoraMin >= salidaHoyMin;
      const enDescansoProgramadoHoy = minutoEnDescansoProgramado(estadoAhoraMin, horarioHoy.bloquesHorario);
      const capacitacionesHoy = bloquesCapacitacionDelDia(novedadesEmpleado, hoyClave);

      const intervalosLaboralesHoy = intervalosAjustadosPorDescanso(
        intervalosExcluyendoBloques(actividadDelDia.intervalos || [], capacitacionesHoy),
        horarioHoy
      ).map((intervalo) => ({ ...intervalo, actual: false, abiertoAlCorte: false, origen: "cerrado" }));

      // Cuando la franja ya terminó, si hubo gestiones pero la última quedó antes
      // de la salida, se evalúa ese único tramo final como máximo hasta RRHH. La
      // línea de tiempo seguirá terminando visualmente en la última gestión real.
      const tramoFinalHoy = jornadaFinalizadaHoy && Number.isFinite(ultimaMinHoy) && Number.isFinite(salidaHoyMin) && salidaHoyMin > ultimaMinHoy
        ? intervalosAjustadosPorDescanso(
            intervalosExcluyendoBloques([{ desdeMin: ultimaMinHoy, hastaMin: salidaHoyMin }], capacitacionesHoy),
            horarioHoy
          ).map((intervalo) => ({ ...intervalo, actual: false, abiertoAlCorte: false, origen: "cerrado" }))
        : [];

      const ajusteBreakHoy = aplicarBreakFlexible([...intervalosLaboralesHoy, ...tramoFinalHoy], horarioHoy);
      const intervalosConBreakHoy = ajusteBreakHoy.intervalos;
      const breakPermitidoHoyMin = ajusteBreakHoy.permitidoMin || minutosBreakFlexiblePermitido(horarioHoy);
      const breakConsideradoHoyRaw = ajusteBreakHoy.breakDetalle;
      const bachesDetalleHoy = intervalosConBreakHoy
        .filter((intervalo) => Number(intervalo.duracionOriginalMin ?? intervalo.duracionMin ?? 0) > BACHE_VISIBLE_MIN)
        .map((intervalo) => {
          const bruto = Math.round(Number(intervalo.duracionOriginalMin ?? intervalo.duracionMin ?? 0));
          return {
            desde: horaGestionHHMM(intervalo.desdeMin),
            hasta: horaGestionHHMM(intervalo.hastaMin),
            // Siempre mostramos el bache real. El break se descuenta globalmente
            // en el resumen para no hacer desaparecer un corte de 20–30 min.
            duracionMin: bruto,
            duracionOriginalMin: bruto,
            breakConsideradoMin: 0,
            breakPermitidoMin: Math.round(Number(breakPermitidoHoyMin || 0)),
            actual: false,
            abiertoAlCorte: false,
            corteDatosHora: "",
          };
        })
        .sort((a, b) => minutosHoraHHMM(a.desde) - minutosHoraHHMM(b.desde));
      const totalBachesBrutosHoyMin = Math.round(bachesDetalleHoy.reduce((sum, intervalo) => sum + Number(intervalo.duracionOriginalMin || 0), 0));
      const breakDescontadoHoyMin = Math.min(totalBachesBrutosHoyMin, Math.round(Number(breakPermitidoHoyMin || 0)));
      const cortesDescontadosHoyMin = Math.max(0, totalBachesBrutosHoyMin - breakDescontadoHoyMin);
      const breakConsideradoHoy = totalBachesBrutosHoyMin > 0 && breakDescontadoHoyMin > 0 ? {
        desde: breakConsideradoHoyRaw ? horaGestionHHMM(breakConsideradoHoyRaw.desdeMin) : "",
        hasta: breakConsideradoHoyRaw ? horaGestionHHMM(breakConsideradoHoyRaw.hastaMin) : "",
        duracionOriginalMin: totalBachesBrutosHoyMin,
        breakConsideradoMin: breakDescontadoHoyMin,
        breakPermitidoMin: Math.round(Number(breakPermitidoHoyMin || 0)),
        excedenteMin: cortesDescontadosHoyMin,
        actual: false,
        abiertoAlCorte: false,
        corteDatosHora: "",
      } : null;
      // "Trabajo efectivo" parte de la franja entre primera y última gestión y
      // descuenta la franquicia diaria de break + los cortes NETOS restantes.
      // Capacitación se reconoce aparte para cumplimiento, nunca para fabricar horas extra.
      const capacitacionHoyMin = Math.round(minutosCapacitacionDentroHorario(capacitacionesHoy, horarioHoy));
      // La franja primera→última gestión puede atravesar una capacitación. Ese
      // tiempo no es actividad Mango: se resta del trabajo efectivo y se acredita
      // después como tiempo justificado, evitando contarlo dos veces.
      const capacitacionDentroFranjaHoyMin = Number.isFinite(primeraMinHoy) && Number.isFinite(ultimaMinHoy) && ultimaMinHoy > primeraMinHoy
        ? Math.round(intervalosLaboralesSinDescanso(capacitacionesHoy, horarioHoy).reduce((total, bloque) => {
            const desde = Math.max(Number(bloque?.desdeMin || 0), primeraMinHoy);
            const hasta = Math.min(Number(bloque?.hastaMin || 0), ultimaMinHoy);
            return total + Math.max(0, hasta - desde);
          }, 0))
        : 0;
      const minutosTrabajoEfectivoHoy = Math.max(0, Math.round(minutosTrabajadosHoy - breakDescontadoHoyMin - cortesDescontadosHoyMin - capacitacionDentroFranjaHoyMin));
      const breakAplicadoCumplimientoHoyMin = minutosExigiblesHoy > 0
        ? Math.min(breakDescontadoHoyMin, Math.max(0, minutosExigiblesHoy - minutosTrabajoEfectivoHoy))
        : 0;
      const capacitacionAplicadaCumplimientoHoyMin = minutosExigiblesHoy > 0
        ? Math.min(capacitacionHoyMin, Math.max(0, minutosExigiblesHoy - minutosTrabajoEfectivoHoy - breakAplicadoCumplimientoHoyMin))
        : 0;
      const minutosTrabajoComputableHoy = Math.max(0, Math.round(minutosTrabajoEfectivoHoy + breakAplicadoCumplimientoHoyMin + capacitacionAplicadaCumplimientoHoyMin));
      const diferenciaTrabajoEfectivoHoyMin = minutosExigiblesHoy > 0 ? minutosTrabajoComputableHoy - minutosExigiblesHoy : null;
      const faltanTrabajoEfectivoHoyMin = minutosExigiblesHoy > 0 ? Math.max(0, minutosExigiblesHoy - minutosTrabajoComputableHoy) : 0;
      const extraTrabajoEfectivoHoyMin = minutosExigiblesHoy > 0 ? Math.max(0, minutosTrabajoEfectivoHoy - minutosExigiblesHoy) : 0;
      // Los cortes se auditan completos, pero sólo se transforma en tiempo a
      // recuperar la porción que todavía falta para cumplir la jornada RRHH.
      const recuperarHoyMin = minutosExigiblesHoy > 0
        ? Math.min(cortesDescontadosHoyMin, faltanTrabajoEfectivoHoyMin)
        : null;
      const baches20Hoy = bachesDetalleHoy.length;
      const baches30Hoy = bachesDetalleHoy.filter((intervalo) => Number(intervalo.duracionOriginalMin || intervalo.duracionMin || 0) > 30).length;
      const baches60Hoy = bachesDetalleHoy.filter((intervalo) => Number(intervalo.duracionOriginalMin || intervalo.duracionMin || 0) > BACHE_CRITICO_MIN).length;
      const bacheMaximoHoyMin = bachesDetalleHoy.reduce((maximo, intervalo) => Math.max(maximo, Number(intervalo.duracionOriginalMin || intervalo.duracionMin || 0)), 0);
      const minutosAbiertosAlCorteHoy = 0;
      const minutosSinGestionHoy = 0;
      const minutosSinGestionAlCorteHoy = 0;

      const tardanzaInicioHoyMin = Number.isFinite(primeraMinHoy) && Number.isFinite(entradaHoyMin)
        ? Math.max(0, Math.round(primeraMinHoy - entradaHoyMin))
        : 0;
      const inicioAnticipadoHoyMin = Number.isFinite(primeraMinHoy) && Number.isFinite(entradaHoyMin)
        ? Math.max(0, Math.round(entradaHoyMin - primeraMinHoy))
        : 0;

      let estadoJornadaHoy = "sin-jornada";
      let estadoJornadaHoyLabel = horarioHoy.horarioLibre ? "Horario libre" : "Sin jornada hoy";
      if (novedadDia) {
        estadoJornadaHoy = novedadDia.tipo === "falta" ? "falta" : "novedad";
        estadoJornadaHoyLabel = etiquetaNovedadDia(novedadDia);
      } else if (horarioHoy.horarioLibre) {
        if (minutosTrabajoEfectivoHoy >= 240) {
          estadoJornadaHoy = "completa";
          estadoJornadaHoyLabel = "Horario libre · 4 h cumplidas";
        } else {
          estadoJornadaHoy = "en-curso";
          estadoJornadaHoyLabel = `Horario libre · ${Math.floor(minutosTrabajoEfectivoHoy / 60)}h ${minutosTrabajoEfectivoHoy % 60}m efectivos de 4 h`;
        }
      } else if (horarioHoy.programado) {
        if (Number.isFinite(entradaHoyMin) && estadoAhoraMin < entradaHoyMin && !Number(actividadDelDia.gestiones || 0)) {
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
          } else if (faltanTrabajoEfectivoHoyMin > 15) {
            estadoJornadaHoy = "incompleta";
            estadoJornadaHoyLabel = `Terminó · faltan ${Math.floor(faltanTrabajoEfectivoHoyMin / 60)}h ${faltanTrabajoEfectivoHoyMin % 60}m efectivos`;
          } else if (extraTrabajoEfectivoHoyMin > 15) {
            estadoJornadaHoy = "extra";
            estadoJornadaHoyLabel = `Trabajo efectivo +${Math.floor(extraTrabajoEfectivoHoyMin / 60)}h ${extraTrabajoEfectivoHoyMin % 60}m sobre RRHH`;
          } else {
            estadoJornadaHoy = "completa";
            estadoJornadaHoyLabel = "Jornada completa";
          }
        } else if (!Number(actividadDelDia.gestiones || 0)) {
          estadoJornadaHoy = "sin-actividad";
          estadoJornadaHoyLabel = "No inició · sin gestiones";
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
        minutosTrabajoEfectivoHoy,
        minutosTrabajoComputableHoy,
        breakAplicadoCumplimientoHoyMin,
        capacitacionHoyMin,
        capacitacionDentroFranjaHoyMin,
        capacitacionAplicadaCumplimientoHoyMin,
        capacitacionesHoy: capacitacionesHoy.map((bloque) => ({ desde: horaGestionHHMM(bloque.desdeMin), hasta: horaGestionHHMM(bloque.hastaMin), descripcion: bloque.descripcion })),
        breakDescontadoHoyMin,
        cortesDescontadosHoyMin,
        minutosProgramadosHoy,
        minutosExigiblesHoy,
        diferenciaHoyMin: diferenciaTrabajoEfectivoHoyMin,
        faltanHoyMin: faltanTrabajoEfectivoHoyMin,
        recuperarHoyMin,
        extraHoyMin: extraTrabajoEfectivoHoyMin,
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
        corteDatosHora: "",
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

    const entidades = entidadesCatalogo || [];
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

    // La fuente de acuerdos es exactamente la misma que Reportes > Acuerdos.
    // Desde esta versión NO deduplicamos antes de mirar Pagos: primero se
    // construyen ventanas por DNI + entidad y luego se resuelven episodios.
    // Así un acuerdo pagado seguido de un nuevo acuerdo cuenta como 2 episodios,
    // mientras que una renegociación que reemplazó un acuerdo sin pago cuenta 1.
    const usuariosActivos = new Set(
      empleados
        .map((empleado) => String(empleado.username || "").trim().toLowerCase())
        .filter(Boolean)
    );

    // La consulta de proyección ya contiene al período seleccionado. Transformamos
    // una sola vez y derivamos el subconjunto mensual en memoria; antes se hacía
    // una segunda consulta + un segundo parseo de las mismas gestiones.
    const acuerdosProyeccionBase = (gestionesAcuerdoProyeccion || [])
      .map((gestion) => transformarGestionEnAcuerdo(gestion))
      .filter(Boolean)
      .filter((acuerdo) => usuariosActivos.has(String(acuerdo.usuario || "").trim().toLowerCase()));

    const acuerdosPeriodoBase = acuerdosProyeccionBase.filter((acuerdo) => {
      const fecha = String(acuerdo?.fecha || "").slice(0, 10);
      return fecha >= desdeClave && fecha <= hastaPeriodoClave;
    });

    let crucePagosDisponible = false;
    let crucePagosHasta = "";
    let pagosCruceCantidad = 0;
    let pagosCruce = [];

    // acuerdosPeriodoBase ya es subconjunto de acuerdosProyeccionBase. Evitamos
    // duplicar objetos antes de preparar el cruce de pagos.
    const acuerdosParaCruce = acuerdosProyeccionBase;
    if (ultimaPago && acuerdosParaCruce.length) {
      try {
        const dnisAcuerdos = [...new Set(
          acuerdosParaCruce
            .map((row) => String(row?.dni || "").replace(/\D/g, ""))
            .filter(Boolean)
        )];
        const entidadesAcuerdos = [...new Set(
          acuerdosParaCruce
            .map((row) => Number(row?.entidadNumero || 0))
            .filter((value) => Number.isFinite(value) && value > 0)
        )];
        const fechasAcuerdos = acuerdosParaCruce
          .map((row) => String(row?.fecha || "").slice(0, 10))
          .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
          .sort();
        const primeraFecha = fechasAcuerdos[0] ? inicioDiaCalendarioUTC(fechasAcuerdos[0]) : null;
        const pagoDesde = primeraFecha ? new Date(primeraFecha.getTime() - 90 * 86400000) : acuerdosProyeccionDesdeUTC;
        const pagoHasta = selectedHastaUTC < hoyReal ? selectedHastaUTC : hoyReal;
        pagosCruce = dnisAcuerdos.length
          ? await Pago.find({
              dni: { $in: dnisAcuerdos },
              ...(entidadesAcuerdos.length ? { entidadId: { $in: entidadesAcuerdos } } : {}),
              fechaPago: { $gte: pagoDesde, $lte: pagoHasta },
            })
              .select("idPago dni entidadId subCesionId fechaPago monto conceptoCodigo estado operadorUsername")
              .sort({ fechaPago: 1, _id: 1 })
              .lean()
              .maxTimeMS(SUPERVISION_CRUCE_PAGOS_MS)
          : [];
        crucePagosDisponible = true;
        crucePagosHasta = fechaClaveArgentina(pagoHasta);
        pagosCruceCantidad = pagosCruce.length;
      } catch (error) {
        console.warn("Cruce opcional acuerdos/pagos en Supervisión no disponible:", error?.message || error);
      }
    }

    const periodoVinculado = vincularPagosPosteriores(
      acuerdosPeriodoBase,
      pagosCruce,
      entidades,
      { disponible: crucePagosDisponible, motivo: crucePagosDisponible ? "" : "SIN_CRUCE_PAGOS" }
    );
    const episodiosPeriodo = resolverEpisodiosAcuerdos(periodoVinculado);
    const acuerdosValidos = episodiosPeriodo.rows;
    const acuerdosConPagos = acuerdosValidos;

    const proyeccionVinculada = vincularPagosPosteriores(
      acuerdosProyeccionBase,
      pagosCruce,
      entidades,
      { disponible: crucePagosDisponible, motivo: crucePagosDisponible ? "" : "SIN_CRUCE_PAGOS" }
    );
    const episodiosProyeccion = resolverEpisodiosAcuerdos(proyeccionVinculada);

    // PROYECCIÓN DEL MES = suma del PRIMER PAGO esperado cuyo vencimiento cae
    // en el mes seleccionado, pero solo de episodios efectivos.
    const acuerdosProyectablesMes = episodiosProyeccion.rows.filter(
      (acuerdo) => String(acuerdo.fechaPrimerPago || acuerdo.primerVencimiento || "").slice(0, 7) === mesSeleccionado
    );

    const proyeccionPorOperadorMap = new Map();
    let proyeccionPrimerPagoMes = 0;
    let primerPagoCobradoMesEquipo = 0;
    let primerosPagosCubiertosMesEquipo = 0;
    for (const acuerdo of acuerdosProyectablesMes) {
      const usuario = String(acuerdo.usuario || "Sin operador").trim() || "Sin operador";
      const usuarioNormalizado = normalizeUsername(usuario);
      const importe = Number(acuerdo.primerPago || 0);
      const cobradoPrimerPago = Number(acuerdo.montoPrimerPagoCobrado || 0);

      // Equipo = todos los usuarios activos, aunque no deban aparecer evaluados.
      proyeccionPrimerPagoMes += importe;
      primerPagoCobradoMesEquipo += cobradoPrimerPago;
      if (acuerdo.primerPagoCubierto) primerosPagosCubiertosMesEquipo += 1;

      // Tabla por operador = sólo universo controlable/visible.
      if (!usuariosControlados.has(usuarioNormalizado)) continue;
      const actual = proyeccionPorOperadorMap.get(usuarioNormalizado) || {
        cantidad: 0,
        importe: 0,
        primerPagoCobrado: 0,
        primerosPagosCubiertos: 0,
      };
      actual.cantidad += 1;
      actual.importe += importe;
      actual.primerPagoCobrado += cobradoPrimerPago;
      if (acuerdo.primerPagoCubierto) actual.primerosPagosCubiertos += 1;
      proyeccionPorOperadorMap.set(usuarioNormalizado, actual);
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
      // Para cumplimiento contra la proyección usamos solo el importe aplicado
      // al PRIMER PAGO. El total de pagos válidos puede incluir cuotas posteriores
      // y no debe inflar el porcentaje de cumplimiento del primer vencimiento.
      const montoPrimerPagoCobrado = conPago ? Number(acuerdo.montoPrimerPagoCobrado || 0) : 0;
      const tipo = acuerdo.tipoAcuerdo || "Sin clasificar";

      if (usuarioControlado) {
        const actual = acuerdosPorOperadorMap.get(usuario) || {
          usuario,
          total: 0,
          montoTotal: 0,
          primerPagoTotal: 0,
          primerPagoCobradoTotal: 0,
          primerosPagosCubiertos: 0,
          reacuerdosEfectivos: 0,
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
        actual.primerPagoCobradoTotal += Number(acuerdo.montoPrimerPagoCobrado || 0);
        if (acuerdo.primerPagoCubierto) actual.primerosPagosCubiertos += 1;
        if (acuerdo.esReacuerdoEfectivo) actual.reacuerdosEfectivos += 1;
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
            actual.montoPagadoExigibles += montoPrimerPagoCobrado;
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
          montoPagadoExigibles += montoPrimerPagoCobrado;
        }
      }
    }

    const recaudacionPorUsername = new Map(
      operadores.map((item) => [normalizeUsername(item.username), Number(item.total || 0)])
    );

    // Separación de la recaudación real del mes:
    // 1) pagos vinculados a acuerdos generados en el período seleccionado;
    // 2) resto de la recaudación (cuotas / pagos de acuerdos anteriores).
    // El dinero se atribuye al operador informado en Pagos, mientras que la
    // productividad del acuerdo permanece en quien generó el acuerdo.
    const recaudadoAcuerdosPeriodoPorOperador = new Map();
    const pagosVinculadosPeriodoIds = new Set();
    let recaudadoAcuerdosPeriodoEquipo = 0;
    for (const acuerdo of acuerdosConPagos) {
      for (const pago of acuerdo.pagosValidos || []) {
        const paymentId = String(
          pago?.clavePago ||
          pago?.idPago ||
          `${pago?.fecha || ""}|${pago?.monto || 0}|${pago?.subCesionId || ""}|${pago?.operadorUsername || ""}`
        );
        if (pagosVinculadosPeriodoIds.has(paymentId)) continue;
        const owner = normalizeUsername(pago?.operadorUsername || "");
        // Para el TOTAL EQUIPO conservamos el mismo universo que la recaudación
        // mensual global. Para el detalle por operador sí limitamos a usuarios de
        // control, porque esa tabla no muestra perfiles administrativos/ocultos.
        pagosVinculadosPeriodoIds.add(paymentId);
        const monto = Number(pago?.monto || 0);
        recaudadoAcuerdosPeriodoEquipo += monto;
        if (owner && usuariosControlados.has(owner)) {
          recaudadoAcuerdosPeriodoPorOperador.set(
            owner,
            Number(recaudadoAcuerdosPeriodoPorOperador.get(owner) || 0) + monto
          );
        }
      }
    }

    const acuerdosPorOperador = [...acuerdosPorOperadorMap.values()]
      .map(({ tiposMap, ...item }) => {
        const usernameKey = normalizeUsername(item.usuario);
        const proyeccion = proyeccionPorOperadorMap.get(usernameKey) || {
          cantidad: 0,
          importe: 0,
          primerPagoCobrado: 0,
          primerosPagosCubiertos: 0,
        };
        const objetivo = Number(objetivosPorUsername.get(usernameKey) || 0);
        const recaudadoMes = Number(recaudacionPorUsername.get(usernameKey) || 0);
        const recaudadoAcuerdosPeriodo = Number(recaudadoAcuerdosPeriodoPorOperador.get(usernameKey) || 0);
        const recaudadoCarteraAnterior = Math.max(0, recaudadoMes - recaudadoAcuerdosPeriodo);
        return {
          ...item,
          proyeccionPrimerPagoMes: Number(proyeccion.importe || 0),
          proyeccionCantidad: Number(proyeccion.cantidad || 0),
          primerPagoCobradoMes: Number(proyeccion.primerPagoCobrado || 0),
          primerosPagosCubiertosMes: Number(proyeccion.primerosPagosCubiertos || 0),
          recaudadoAcuerdosPeriodo,
          recaudadoCarteraAnterior,
          objetivo,
          recaudadoMes,
          faltanteObjetivo: objetivo > 0 ? Math.max(0, objetivo - recaudadoMes) : null,
          porcentajeObjetivo: objetivo > 0 ? Math.round((recaudadoMes / objetivo) * 1000) / 10 : null,
          porcentajeProyeccionObjetivo: objetivo > 0 ? Math.round((Number(proyeccion.importe || 0) / objetivo) * 1000) / 10 : null,
          porcentajeCumplimiento: item.exigibles > 0
            ? Math.round((item.exigiblesConPago / item.exigibles) * 1000) / 10
            : null,
          porcentajeCumplimientoMonto: item.primerPagoExigibleTotal > 0
            ? Math.round((item.montoPagadoExigibles / item.primerPagoExigibleTotal) * 1000) / 10
            : null,
          tipos: [...tiposMap.entries()]
            .map(([tipo, total]) => ({ tipo, total }))
            .sort((a, b) => b.total - a.total || String(a.tipo).localeCompare(String(b.tipo), "es")),
        };
      })
      .sort((a, b) => b.total - a.total || b.proyeccionPrimerPagoMes - a.proyeccionPrimerPagoMes);
    const acuerdosPorTipo = [...acuerdosPorTipoMap.entries()]
      .map(([tipo, total]) => ({ tipo, total }))
      .sort((a, b) => b.total - a.total);

    const recaudadoCarteraAnteriorEquipo = Math.max(0, Number(totalActual || 0) - recaudadoAcuerdosPeriodoEquipo);

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

    const duracionMs = Date.now() - iniciadoEnMs;
    // Evita ensuciar la terminal en desarrollo normal. Si alguna vez necesitás
    // medir consultas lentas de Supervisión, iniciar con SUPERVISION_DEBUG=true.
    if (process.env.SUPERVISION_DEBUG === "true" && duracionMs > 3000) {
      console.warn(`[Supervisión] resumen ${hoyClave} preparado en ${duracionMs} ms`, {
        gestionesActividad: gestionesActividadPeriodo?.length || 0,
        acuerdosMango: gestionesAcuerdoProyeccion?.length || 0,
        pagosTresMeses: pagosTres?.length || 0,
        fuentesConError: erroresFuentes.map((item) => item.fuente),
      });
    }
    res.set("Server-Timing", `supervision;dur=${duracionMs}`);

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
      gestiones: resumenGestionesHoy,
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
        pagosCantidad: pagosDiaSeleccionado.length,
        pagosTotal: pagosDiaSeleccionadoTotal,
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
        disponible: !erroresFuentes.some((item) => item.fuente === "Acuerdos Mango"),
        total: acuerdosValidos.length,
        // Valor contractual completo de los acuerdos generados en el período.
        // Se conserva como referencia, pero NO se usa como proyección mensual.
        montoTotal: montoTotalAcuerdos,
        primerPagoTotal,
        proyeccionPrimerPagoMes,
        proyeccionCantidad: acuerdosProyectablesMes.length,
        primerPagoCobradoMes: primerPagoCobradoMesEquipo,
        primerosPagosCubiertosMes: primerosPagosCubiertosMesEquipo,
        recaudadoAcuerdosPeriodo: recaudadoAcuerdosPeriodoEquipo,
        recaudadoCarteraAnterior: recaudadoCarteraAnteriorEquipo,
        reacuerdosEfectivos: acuerdosValidos.filter((acuerdo) => acuerdo.esReacuerdoEfectivo).length,
        acuerdosCrudos: episodiosPeriodo.meta.acuerdosCrudos,
        acuerdosReemplazadosSinPago: episodiosPeriodo.meta.acuerdosReemplazadosSinPago,
        casosConMasDeUnEpisodio: episodiosPeriodo.meta.casosConMasDeUnEpisodio,
        objetivoEquipo: montoObjetivoEquipo,
        porcentajeProyeccionObjetivoEquipo: montoObjetivoEquipo > 0
          ? Math.round((proyeccionPrimerPagoMes / montoObjetivoEquipo) * 1000) / 10
          : null,
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
          acuerdosCrudos: episodiosPeriodo.meta.acuerdosCrudos,
          acuerdosEfectivos: episodiosPeriodo.meta.acuerdosEfectivos,
          reemplazadosSinPago: episodiosPeriodo.meta.acuerdosReemplazadosSinPago,
          casosConMasDeUnEpisodio: episodiosPeriodo.meta.casosConMasDeUnEpisodio,
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
      meta: {
        duracionMs: Date.now() - iniciadoEnMs,
        degradado: erroresFuentes.length > 0,
        erroresFuentes,
      },
    });
  } catch (error) {
    console.error("Panel supervisión:", error);
    const payload = { error: "No se pudo preparar el panel de supervisión" };
    if (process.env.NODE_ENV !== "production") payload.detalle = String(error?.message || error || "Error desconocido");
    return res.status(500).json(payload);
  }
}


/**
 * Gestiones del día + casos nuevos contra los 90 días previos.
 *
 * Está separado del resumen principal a propósito: a medida que crece el universo
 * de operadores y gestiones, el cruce histórico puede volverse más pesado. Si
 * este análisis tarda, sólo espera el bloque "Gestiones" y el resto de
 * Supervisión permanece disponible.
 *
 * La consulta histórica NO agrupa todo el universo de 90 días. Primero toma los
 * DNIs efectivamente trabajados en el día seleccionado y luego busca historia
 * únicamente para esos DNIs. Eso reduce drásticamente el trabajo de Mongo.
 */
export async function resumenGestionesSupervision(req, res) {
  const iniciadoEnMs = Date.now();
  try {
    const hoyRealClave = fechaClaveArgentina(new Date());
    const fechaPedida = claveFechaCalendario(req.query?.fecha);
    const fechaConsulta = fechaPedida && fechaPedida <= hoyRealClave ? fechaPedida : hoyRealClave;
    const diaDesde = inicioDiaCalendarioUTC(fechaConsulta);
    const diaHasta = finDiaCalendarioUTC(fechaConsulta);
    const historialDesde = new Date(diaDesde.getTime() - 90 * 86400000);

    const empleados = await Empleado.find({ isActive: { $ne: false } })
      .select("username nombre role")
      .sort({ username: 1 })
      .lean();
    const empleadosControlados = filtrarEmpleadosControlados(empleados);
    const listaUsuariosActivos = empleados
      .map((empleado) => normalizeUsername(empleado?.username))
      .filter(Boolean);

    const filasDia = await ReporteGestion.find({
      fecha: { $gte: diaDesde, $lte: diaHasta },
      borrado: { $ne: true },
      usuario: { $in: listaUsuariosActivos },
    })
      .select("usuario dni hora")
      .lean()
      .maxTimeMS(120000);

    const actividadDia = actividadDeUsuarioEnFecha(
      filasDia.map((row) => ({ ...row, fecha: diaDesde })),
      fechaConsulta
    );

    const paresHoy = new Set();
    const dnisHoy = new Set();
    const cuentasPorUsuario = new Map();
    for (const item of filasDia || []) {
      const usuario = normalizeUsername(item?.usuario);
      const dni = String(item?.dni || "").trim();
      if (!usuario || !dni) continue;
      const par = `${usuario}|${dni}`;
      if (paresHoy.has(par)) continue;
      paresHoy.add(par);
      dnisHoy.add(dni);
      cuentasPorUsuario.set(usuario, Number(cuentasPorUsuario.get(usuario) || 0) + 1);
    }

    let historial = [];
    if (dnisHoy.size) {
      // El DNI tiene índice propio en ReporteGestion. Limitar el historial a los
      // DNIs presentes HOY evita agrupar todas las gestiones de 90 días.
      historial = await ReporteGestion.find({
        fecha: { $gte: historialDesde, $lt: diaDesde },
        borrado: { $ne: true },
        usuario: { $in: listaUsuariosActivos },
        dni: { $in: [...dnisHoy] },
      })
        .select("usuario dni")
        .lean()
        .maxTimeMS(120000);
    }

    const paresPrevios90 = new Set();
    for (const item of historial || []) {
      const usuario = normalizeUsername(item?.usuario);
      const dni = String(item?.dni || "").trim();
      if (usuario && dni) paresPrevios90.add(`${usuario}|${dni}`);
    }

    const nuevosPorUsuario = new Map();
    let casosNuevos = 0;
    for (const par of paresHoy) {
      if (paresPrevios90.has(par)) continue;
      const [usuario] = par.split("|");
      nuevosPorUsuario.set(usuario, Number(nuevosPorUsuario.get(usuario) || 0) + 1);
      casosNuevos += 1;
    }

    const porOperador = empleadosControlados.map((empleado) => {
      const usernameNormalizado = normalizeUsername(empleado.username);
      const actividad = actividadDia.get(usernameNormalizado) || {};
      return {
        empleadoId: empleado._id,
        nombre: empleado.nombre || empleado.username,
        username: empleado.username,
        gestiones: Number(actividad.gestiones || 0),
        cuentasTrabajadas: Number(cuentasPorUsuario.get(usernameNormalizado) || 0),
        casosNuevos: Number(nuevosPorUsuario.get(usernameNormalizado) || 0),
        primeraGestion: actividad.primeraGestion || "",
        ultimaGestion: actividad.ultimaGestion || "",
      };
    })
      .filter((item) => item.gestiones > 0 || item.cuentasTrabajadas > 0)
      .sort((a, b) => b.gestiones - a.gestiones || b.casosNuevos - a.casosNuevos || String(a.username).localeCompare(String(b.username), "es"));

    const duracionMs = Date.now() - iniciadoEnMs;
    if (process.env.SUPERVISION_DEBUG === "true") {
      console.warn(`[Supervisión] gestiones ${fechaConsulta} preparadas en ${duracionMs} ms`, {
        filasDia: filasDia.length,
        cuentasDia: paresHoy.size,
        dnisDia: dnisHoy.size,
        filasHistorialRevisadas: historial.length,
      });
    }

    return res.json({
      fechaConsulta,
      resumen: {
        totalGestiones: filasDia.length,
        cuentasTrabajadas: paresHoy.size,
        casosNuevos,
        casosNuevosPendiente: false,
        operadoresConActividad: new Set((filasDia || []).map((item) => normalizeUsername(item?.usuario)).filter(Boolean)).size,
        ventanaCasosNuevosDias: 90,
        porOperador,
      },
      meta: {
        duracionMs,
        filasDia: filasDia.length,
        cuentasDia: paresHoy.size,
        dnisDia: dnisHoy.size,
        filasHistorialRevisadas: historial.length,
        ventanaDias: 90,
      },
    });
  } catch (error) {
    console.error("Gestiones de Supervisión:", error);
    const payload = { error: "No se pudo preparar el análisis de gestiones" };
    if (process.env.NODE_ENV !== "production") payload.detalle = String(error?.message || error || "Error desconocido");
    return res.status(500).json(payload);
  }
}


/**
 * Resumen liviano de Contactados para el Panel de Supervisión.
 * No dispara sincronizaciones ni reconstrucciones: usa el material ya generado
 * por el módulo Contactados. Así la apertura de Supervisión no compite con el
 * endpoint completo /contactados/estadisticas.
 */
export async function resumenContactadosSupervision(req, res) {
  const iniciadoEnMs = Date.now();
  try {
    const mes = mesValido(req.query?.mes) || mesClaveArgentina();
    const empleados = await Empleado.find({ isActive: { $ne: false } })
      .select("username nombre role")
      .lean()
      .maxTimeMS(SUPERVISION_QUERY_MS);
    const usuarios = [...usernamesControlados(empleados)];
    const now = new Date();

    const rows = await ContactadoVentana.find({
      mesOrigen: mes,
      operador: { $in: usuarios },
      estado: { $in: ["abierta", "cumplida", "vencida"] },
    })
      .select("operador estado alertaAt criticoAt venceAt clickRealizadoAt esOrigenContactado calificacionResolucion")
      .lean()
      .maxTimeMS(SUPERVISION_QUERY_MS);

    const cerradas = rows.filter((row) => ["cumplida", "vencida"].includes(row.estado));
    const cumplidas = cerradas.filter((row) => row.estado === "cumplida");
    const vencidas = cerradas.filter((row) => row.estado === "vencida");
    const abiertas = rows.filter((row) => row.estado === "abierta" && new Date(row.venceAt) > now);
    const pendientes = abiertas.filter((row) => new Date(row.alertaAt) <= now);

    let vigente = 0;
    let porVencer = 0;
    let critico = 0;
    for (const row of abiertas) {
      if (now < new Date(row.alertaAt)) vigente += 1;
      else if (now < new Date(row.criticoAt)) porVencer += 1;
      else critico += 1;
    }

    const porOperador = new Map();
    for (const row of [...cerradas, ...pendientes]) {
      const operador = String(row.operador || "sin-operador");
      const item = porOperador.get(operador) || {
        operador,
        cumplidos: 0,
        vencidos: 0,
        pendientes: 0,
        totalCerrados: 0,
        cumplimientoPct: 0,
      };
      if (row.estado === "cumplida") {
        item.cumplidos += 1;
        item.totalCerrados += 1;
      } else if (row.estado === "vencida") {
        item.vencidos += 1;
        item.totalCerrados += 1;
      } else {
        item.pendientes += 1;
      }
      porOperador.set(operador, item);
    }

    const rendimiento = [...porOperador.values()]
      .map((item) => ({
        ...item,
        cumplimientoPct: item.totalCerrados
          ? Math.round((item.cumplidos * 1000) / item.totalCerrados) / 10
          : 0,
      }))
      .sort((a, b) => b.cumplimientoPct - a.cumplimientoPct || b.totalCerrados - a.totalCerrados);

    const cumplimientoPct = cerradas.length
      ? Math.round((cumplidas.length * 1000) / cerradas.length) / 10
      : 0;

    const payload = {
      ok: true,
      mes,
      canViewAll: true,
      resumen: {
        contactadosGenerados: rows.filter((row) => row.esOrigenContactado).length,
        cumplidos: cumplidas.length,
        vencidos: vencidas.length,
        pendientes: pendientes.length,
        cumplimientoPct,
        vigente,
        porVencer,
        critico,
      },
      rendimiento,
      meta: { duracionMs: Date.now() - iniciadoEnMs, fuente: "contactados-materializados" },
    };
    res.set("Server-Timing", `supervision-contactados;dur=${payload.meta.duracionMs}`);
    return res.json(payload);
  } catch (error) {
    console.error("Contactados liviano de Supervisión:", error);
    const payload = { error: "No se pudo preparar el resumen liviano de Contactados" };
    if (process.env.NODE_ENV !== "production") payload.detalle = String(error?.message || error || "Error desconocido");
    return res.status(500).json(payload);
  }
}
