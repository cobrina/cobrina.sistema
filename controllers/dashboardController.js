import ReporteGestion from "../models/ReporteGestion.js";
import Pago from "../models/Pago.js";
import Colchon from "../models/Colchon.js";
import NovedadRRHH from "../models/NovedadRRHH.js";
import AdelantoRRHH from "../models/AdelantoRRHH.js";
import ObjetivoMensual from "../models/ObjetivoMensual.js";
import AgendaItem from "../models/AgendaItem.js";
import StickyNote from "../models/StickyNote.js";
import Empleado from "../models/Empleado.js";
import mongoose from "mongoose";
import { ROLES, normalizeStoredRole } from "../config/roles.js";
import { transformarGestionEnAcuerdo } from "../services/acuerdosGestionesService.js";

function fechaArgentinaPartes() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

function rangoActual() {
  const { year, month, day } = fechaArgentinaPartes();
  const mes = `${year}-${String(month).padStart(2, "0")}`;
  const hoy = `${mes}-${String(day).padStart(2, "0")}`;
  const siguienteYear = month === 12 ? year + 1 : year;
  const siguienteMonth = month === 12 ? 1 : month + 1;
  return {
    mes,
    hoy,
    day,
    desdeMes: new Date(`${mes}-01T00:00:00.000Z`),
    hastaMes: new Date(`${siguienteYear}-${String(siguienteMonth).padStart(2, "0")}-01T00:00:00.000Z`),
    inicioHoy: new Date(`${hoy}T00:00:00.000Z`),
    finHoy: new Date(`${hoy}T23:59:59.999Z`),
  };
}

function card(id, label, value, caption, to = "", format = "number") {
  return { id, label, value: Number(value || 0), caption, to, format };
}

function fechaHoraAcuerdo(acuerdo) {
  const fecha = String(acuerdo?.fecha || "").slice(0, 10);
  if (!fecha) return null;
  const hora = /^\d{2}:\d{2}:\d{2}$/.test(String(acuerdo?.hora || ""))
    ? String(acuerdo.hora)
    : "00:00:00";
  const value = new Date(`${fecha}T${hora}.000Z`);
  return Number.isNaN(value.getTime()) ? null : value;
}

async function contarAcuerdosVencidosSinPago({ acuerdos, ownOnly, userObjectId, username, now }) {
  const candidatos = acuerdos.filter((acuerdo) => acuerdo.estadoVencimiento === "VENCIDO");
  if (!candidatos.length) return 0;

  const dnis = [...new Set(candidatos.map((item) => String(item.dni || "")).filter(Boolean))];
  const fechas = candidatos.map(fechaHoraAcuerdo).filter(Boolean);
  const fechaMinima = fechas.length
    ? new Date(Math.min(...fechas.map((fecha) => fecha.getTime())))
    : new Date(0);

  const pagoQuery = {
    dni: { $in: dnis },
    fechaPago: { $gte: fechaMinima, $lte: now },
  };
  if (ownOnly) {
    pagoQuery.$or = [{ operadorId: userObjectId }, { operadorUsername: username }];
  }

  const pagos = await Pago.find(pagoQuery).select("dni entidadId fechaPago").lean();
  return candidatos.filter((acuerdo) => {
    const fechaAcuerdo = fechaHoraAcuerdo(acuerdo) || new Date(0);
    const dni = String(acuerdo.dni || "");
    const entidadNumero = Number(acuerdo.entidadNumero || 0);
    const tienePago = pagos.some((pago) => {
      if (String(pago.dni || "") !== dni) return false;
      if (new Date(pago.fechaPago).getTime() < fechaAcuerdo.getTime()) return false;
      const entidadPago = Number(pago.entidadId || 0);
      return !entidadNumero || !entidadPago || entidadPago === entidadNumero;
    });
    return !tienePago;
  }).length;
}

async function filtroUsuariosActivos(ownOnly, username) {
  if (ownOnly) return username;
  const rows = await Empleado.find({ isActive: { $ne: false } }).select("username").lean();
  const usernames = rows
    .map((row) => String(row.username || "").trim().toLowerCase())
    .filter(Boolean);
  return { $in: usernames.length ? usernames : ["__cobrina_sin_usuario_activo__"] };
}

export async function resumenDashboard(req, res) {
  try {
    const role = normalizeStoredRole(req.user.role);
    const username = String(req.user.username || "").trim().toLowerCase();
    const userId = req.user.id;
    const userObjectId = mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : userId;
    const ownOnly = [ROLES.OPERADOR, ROLES.OPERADOR_VIP].includes(role);
    const { mes, hoy, day, desdeMes, hastaMes, inicioHoy, finHoy } = rangoActual();
    const now = new Date();
    const usuarioFiltro = await filtroUsuariosActivos(ownOnly, username);

    const gestionQuery = {
      fecha: { $gte: desdeMes, $lt: hastaMes },
      borrado: { $ne: true },
      usuario: usuarioFiltro,
    };
    // Misma fuente que Reportes > Acuerdos: gestiones cuyo resultado contiene
    // "acuerdo", validadas con el mismo parser. Pagos no interviene en el total.
    const acuerdoQuery = {
      ...gestionQuery,
      resultadoGestion: /acuerdo/i,
    };
    const pagoQuery = {
      fechaPago: { $gte: desdeMes, $lt: hastaMes },
      ...(ownOnly ? { $or: [{ operadorId: userObjectId }, { operadorUsername: username }] } : {}),
    };
    const novedadQuery = {
      estado: { $ne: "anulado" },
      fechaDesde: { $lt: hastaMes },
      $or: [{ fechaHasta: null }, { fechaHasta: { $gte: desdeMes } }],
      ...(ownOnly ? { empleadoId: userId } : {}),
    };

    const [gestiones, gestionesAcuerdo, pagosAgg, novedades, agendaPendientes, trelloHoy, objetivosActivos] = await Promise.all([
      ReporteGestion.countDocuments(gestionQuery),
      ReporteGestion.find(acuerdoQuery)
        .select("dni nombreDeudor fecha hora usuario tipoContacto resultadoGestion estadoCuenta telMailMarcado observacionGestion entidad entidadNumero")
        .sort({ fecha: -1, hora: -1, _id: -1 })
        .lean(),
      Pago.aggregate([
        { $match: pagoQuery },
        { $group: { _id: null, cantidad: { $sum: 1 }, monto: { $sum: "$monto" } } },
      ]),
      NovedadRRHH.find(novedadQuery).select("tipo empleadoId").lean(),
      AgendaItem.find({ propietario: userId, fechaClave: hoy, completada: false })
        .select("hora titulo tipo asignadaPorOtro creadoPorUsername")
        .sort({ hora: 1 })
        .limit(8)
        .lean(),
      StickyNote.find({
        userId,
        status: { $ne: "finalizada" },
        dueDate: { $gte: inicioHoy, $lte: finHoy },
      })
        .select("title text status priority dueDate")
        .sort({ priority: -1, dueDate: 1 })
        .limit(8)
        .lean(),
      ObjetivoMensual.countDocuments({ mes, activo: true }),
    ]);

    const acuerdos = gestionesAcuerdo.map(transformarGestionEnAcuerdo).filter(Boolean);
    const pagosCantidad = Number(pagosAgg[0]?.cantidad || 0);
    const pagosMonto = Number(pagosAgg[0]?.monto || 0);
    const vencidosSinPago = await contarAcuerdosVencidosSinPago({
      acuerdos,
      ownOnly,
      userObjectId,
      username,
      now,
    });
    const faltas = novedades.filter((item) => ["falta", "falta-justificada"].includes(item.tipo)).length;
    const tardes = novedades.filter((item) => item.tipo === "llegada-tarde").length;
    const apercibimientos = novedades.filter((item) => ["apercibimiento", "error-grave-gestion"].includes(item.tipo)).length;

    let cards = [];
    let focus = [
      card(
        "agenda-hoy",
        "Agenda de hoy",
        agendaPendientes.length,
        agendaPendientes.length === 1 ? "1 pendiente" : `${agendaPendientes.length} pendientes`,
        "/dashboard/agenda"
      ),
      card(
        "trello-hoy",
        "Tareas para hoy",
        trelloHoy.length,
        trelloHoy.length === 1 ? "1 tarjeta pendiente" : `${trelloHoy.length} tarjetas pendientes`,
        "/controles/notas"
      ),
    ];

    if ([ROLES.OPERADOR, ROLES.OPERADOR_VIP].includes(role)) {
      cards = [
        card("gestiones", "Gestiones del mes", gestiones, "Tus gestiones cargadas", "/dashboard/proyecciones"),
        card("acuerdos", "Acuerdos del mes", acuerdos.length, "Detectados en Reporte de gestiones", "/dashboard/proyecciones"),
        card("vencidos", "Vencidos sin pago", vencidosSinPago, "Para priorizar hoy", "/dashboard/colchon"),
        card("pagos", "Pagos acreditados", pagosCantidad, `${pagosMonto.toLocaleString("es-AR")} pesos en el mes`, "/dashboard/colchon"),
        card("agenda", "Pendientes de agenda", agendaPendientes.length, "Tareas personales de hoy", "/dashboard/agenda"),
        card("trello", "Tareas tipo Trello", trelloHoy.length, "Con vencimiento para hoy", "/controles/notas"),
      ];
      focus.push(card("asistencia", "Asistencia del mes", faltas + tardes, `${faltas} faltas · ${tardes} tardanzas`));
    } else if (role === ROLES.CUOTERO) {
      const [colchonResumen, pagosInformados] = await Promise.all([
        Colchon.aggregate([
          { $group: { _id: null, cuotas: { $sum: 1 }, saldo: { $sum: "$saldoPendiente" } } },
        ]),
        Colchon.aggregate([
          { $unwind: "$pagosInformados" },
          { $match: { "pagosInformados.estadoAplicacion": "pendiente" } },
          { $count: "cantidad" },
        ]),
      ]);
      const vencidasColchon = await Colchon.countDocuments({
        vencimiento: { $lt: day },
        saldoPendiente: { $gt: 0 },
        estado: { $ne: "Caída" },
      });
      cards = [
        card("pagos", "Pagos del mes", pagosCantidad, "Pagos acreditados", "/dashboard/pagos"),
        card("monto-pagos", "Monto acreditado", pagosMonto, `${pagosCantidad} pagos en el período`, "/dashboard/pagos", "currency"),
        card("colchon", "Cuotas en Colchón", colchonResumen[0]?.cuotas || 0, "Cuotas activas para seguimiento", "/dashboard/colchon"),
        card("saldo-colchon", "Saldo pendiente", colchonResumen[0]?.saldo || 0, "Total pendiente en Colchón", "/dashboard/colchon", "currency"),
        card("avisos", "Pagos a revisar", pagosInformados[0]?.cantidad || 0, "Avisos pendientes de control", "/dashboard/colchon"),
        card("cuotas-vencidas", "Cuotas vencidas", vencidasColchon, "Con saldo pendiente", "/dashboard/colchon"),
      ];
      focus.push(card("pagos-revisar", "Control de pagos", pagosInformados[0]?.cantidad || 0, "Avisos pendientes", "/dashboard/colchon"));
    } else if (role === ROLES.CAPACITADORA) {
      cards = [
        card("gestiones", "Gestiones del equipo", gestiones, "Actividad total del mes", "/dashboard/reportes/gestiones"),
        card("acuerdos", "Acuerdos del equipo", acuerdos.length, "Desde Reporte de gestiones", "/dashboard/reportes/acuerdos"),
        card("vencidos", "Vencidos sin pago", vencidosSinPago, "Casos para reforzar", "/dashboard/reportes/acuerdos"),
        card("asistencia", "Faltas y tardanzas", faltas + tardes, `${faltas} faltas · ${tardes} tardanzas`, "/dashboard/rrhh"),
        card("objetivos", "Objetivos activos", objetivosActivos, "Objetivos definidos para el período", "/dashboard/rrhh"),
        card("pendientes", "Pendientes de hoy", agendaPendientes.length + trelloHoy.length, "Agenda y tareas tipo Trello", "/dashboard/agenda"),
      ];
      focus.push(card("vencidos-foco", "Acuerdos vencidos", vencidosSinPago, "Sin pago posterior", "/dashboard/reportes/acuerdos"));
    } else if (role === ROLES.ADMINISTRACION) {
      const adelantos = await AdelantoRRHH.countDocuments({ fechaSolicitud: { $gte: desdeMes, $lt: hastaMes }, estado: { $nin: ["rechazado", "cancelado"] } });
      cards = [
        card("gestiones", "Gestiones del equipo", gestiones, "Actividad total del mes", "/dashboard/reportes/gestiones"),
        card("acuerdos", "Acuerdos del mes", acuerdos.length, `${vencidosSinPago} vencidos sin pago`, "/dashboard/reportes/acuerdos"),
        card("pagos", "Monto acreditado", pagosMonto, `${pagosCantidad} pagos en el mes`, "/dashboard/pagos", "currency"),
        card("rrhh", "Novedades de RRHH", novedades.length, `${faltas} faltas · ${tardes} tardanzas`, "/dashboard/rrhh"),
        card("adelantos", "Adelantos del mes", adelantos, "Solicitados, aprobados o entregados", "/dashboard/rrhh"),
        card("objetivos", "Objetivos activos", objetivosActivos, "Definidos para el período", "/dashboard/rrhh"),
      ];
      focus.push(card("vencidos-foco", "Acuerdos vencidos", vencidosSinPago, "Sin pago posterior", "/dashboard/reportes/acuerdos"));
    } else {
      cards = [
        card("gestiones", "Gestiones del equipo", gestiones, "Actividad total del mes", "/dashboard/reportes/gestiones"),
        card("acuerdos", "Acuerdos del equipo", acuerdos.length, "Desde Reporte de gestiones", "/dashboard/reportes/acuerdos"),
        card("vencidos", "Vencidos sin pago", vencidosSinPago, "Para seguimiento del equipo", "/dashboard/reportes/acuerdos"),
        card("pagos", "Monto acreditado", pagosMonto, `${pagosCantidad} pagos en el mes`, "/dashboard/pagos", "currency"),
        card("asistencia", "Alertas de asistencia", faltas + tardes + apercibimientos, `${faltas} faltas · ${tardes} tardanzas · ${apercibimientos} apercibimientos`, "/dashboard/rrhh"),
        card("objetivos", "Objetivos activos", objetivosActivos, "Definidos para el período", "/dashboard/rrhh"),
      ];
      focus.push(
        card("vencidos-foco", "Acuerdos vencidos", vencidosSinPago, "Sin pago posterior", "/dashboard/reportes/acuerdos"),
        card("asistencia-foco", "Alertas de asistencia", faltas + tardes + apercibimientos, "Faltas, tardanzas y apercibimientos", "/dashboard/rrhh")
      );
    }

    return res.json({
      ok: true,
      role,
      mes,
      cards,
      focus,
      agendaPendientes,
      trelloHoy,
      resumen: { gestiones, acuerdos: acuerdos.length, pagosCantidad, pagosMonto, vencidosSinPago, faltas, tardes },
      fuenteAcuerdos: "reporte-gestiones",
    });
  } catch (error) {
    console.error("Dashboard resumen:", error);
    return res.status(500).json({ error: "No se pudo preparar el resumen del dashboard" });
  }
}
