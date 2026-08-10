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
  minutosEsperadosHastaHoy,
  novedadCubreFecha,
  rangoMesLocal,
  minutosActividadSegunHorario,
  intervalosAjustadosPorDescanso,
  minutosHoraHHMM,
  minutoEnDescansoProgramado,
  descansoProgramadoSolapadoMin,
} from "../utils/calculoAsistencia.js";
import { actividadDeUsuarioEnFecha, horaGestionHHMM, resumirActividadMensual } from "../utils/actividadGestiones.js";
import { filtrarEmpleadosControlados, usernamesControlados } from "../utils/controlEquipo.js";
import { normalizeUsername } from "../config/roles.js";
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
    if (huecoReal > 30) {
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
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
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
    const empleadosControlados = filtrarEmpleadosControlados(empleados);
    const idsControlados = empleadosControlados.map((empleado) => empleado._id);
    const usuariosControlados = usernamesControlados(empleados);
    const listaUsuariosControlados = [...usuariosControlados];

    const [pagosTres, objetivos, novedadesRRHH, gestionesActividadPeriodo, gestionesActividadHoy,
      proyeccionesCaidas, colchonSinGestion, pendientesColchon, pendientesProyecciones, ultimaPago,
      ultimaGestionAcuerdo, ultimaGestion, gestionesAcuerdoPeriodo, pagosHoyAgg, pagosHoyDetalle, fichadosAhora,
      jornadasSinSalida, ultimaAcuerdoManual, acuerdosManualesCantidad] = await Promise.all([
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
      Pago.find({ fechaPago: { $gte: hoyDesde, $lte: hoyHasta } })
        .select("monto operadorId operadorUsername")
        .lean(),
      Asistencia.countDocuments({ empleado: { $in: idsControlados }, fechaClave: hoyClave, estado: "presente" }),
      Asistencia.countDocuments({ empleado: { $in: idsControlados }, fechaClave: { $lt: hoyClave }, estado: "presente" }),
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
    const ahoraMinArgentina = minutoActualArgentina();

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
      const esperados = minutosEsperadosHastaHoy(empleado, mesSeleccionado, novedadesEmpleado);
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
      const intervalosHoy = intervalosAjustadosPorDescanso(actividadDelDia.intervalos || [], horarioHoy);
      const baches30Hoy = intervalosHoy.filter((intervalo) => intervalo.duracionMin > 30).length;
      const baches60Hoy = intervalosHoy.filter((intervalo) => intervalo.duracionMin > 60).length;
      const bacheMaximoHoyMin = intervalosHoy.reduce((maximo, intervalo) => Math.max(maximo, Number(intervalo.duracionMin || 0)), 0);
      const salidaHoyMin = minutosHoraHHMM(horarioHoy.salida);
      const entradaHoyMin = minutosHoraHHMM(horarioHoy.entrada);
      const jornadaFinalizadaHoy = horarioHoy.programado && Number.isFinite(salidaHoyMin) && ahoraMinArgentina >= salidaHoyMin;
      const enDescansoProgramadoHoy = minutoEnDescansoProgramado(ahoraMinArgentina, horarioHoy.bloquesHorario);
      let minutosSinGestionHoy = null;
      if (Number.isFinite(ultimaMinHoy) && ahoraMinArgentina >= ultimaMinHoy) {
        minutosSinGestionHoy = Math.max(0, Math.round(
          ahoraMinArgentina - ultimaMinHoy - descansoProgramadoSolapadoMin(horarioHoy.bloquesHorario, ultimaMinHoy, ahoraMinArgentina)
        ));
      }

      let estadoJornadaHoy = "sin-jornada";
      let estadoJornadaHoyLabel = horarioHoy.horarioLibre ? "Horario libre" : "Sin jornada hoy";
      if (novedadDia) {
        estadoJornadaHoy = novedadDia.tipo === "falta" ? "falta" : "novedad";
        estadoJornadaHoyLabel = etiquetaNovedadDia(novedadDia);
      } else if (horarioHoy.horarioLibre) {
        estadoJornadaHoy = Number(actividadDelDia.gestiones || 0) > 0 ? "en-curso" : "sin-actividad";
        estadoJornadaHoyLabel = Number(actividadDelDia.gestiones || 0) > 0 ? "Con actividad" : "Sin actividad";
      } else if (horarioHoy.programado) {
        if (Number.isFinite(entradaHoyMin) && ahoraMinArgentina < entradaHoyMin) {
          estadoJornadaHoy = "pendiente";
          estadoJornadaHoyLabel = "Todavía no inicia";
        } else if (enDescansoProgramadoHoy) {
          estadoJornadaHoy = "descanso";
          estadoJornadaHoyLabel = "Descanso programado";
        } else if (jornadaFinalizadaHoy) {
          if (faltanHoyMin > 15) {
            estadoJornadaHoy = "incompleta";
            estadoJornadaHoyLabel = `Terminó · faltan ${Math.floor(faltanHoyMin / 60)}h ${faltanHoyMin % 60}m`;
          } else if (extraHoyMin > 15) {
            estadoJornadaHoy = "extra";
            estadoJornadaHoyLabel = `Completa · +${Math.floor(extraHoyMin / 60)}h ${extraHoyMin % 60}m extra voluntaria`;
          } else {
            estadoJornadaHoy = "completa";
            estadoJornadaHoyLabel = "Jornada completa";
          }
        } else if (!Number(actividadDelDia.gestiones || 0)) {
          estadoJornadaHoy = "sin-actividad";
          estadoJornadaHoyLabel = "Sin gestiones todavía";
        } else if (Number(minutosSinGestionHoy || 0) > 60) {
          estadoJornadaHoy = "alerta";
          estadoJornadaHoyLabel = `Sin gestión hace ${Math.round(minutosSinGestionHoy)} min`;
        } else if (Number(minutosSinGestionHoy || 0) > 30) {
          estadoJornadaHoy = "atencion";
          estadoJornadaHoyLabel = `Pausa actual ${Math.round(minutosSinGestionHoy)} min`;
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
        baches30Hoy,
        baches60Hoy,
        bacheMaximoHoyMin,
        minutosSinGestionHoy,
        jornadaFinalizadaHoy,
        enDescansoProgramadoHoy,
        estadoJornadaHoy,
        estadoJornadaHoyLabel,
        novedadHoyTipo: novedadDia?.tipo || "",
        novedadHoyDescripcion: novedadDia?.descripcion || "",
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
      const usuarioControlado = usuariosControlados.has(normalizeUsername(usuario));
      if (usuarioControlado) {
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
      }

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
