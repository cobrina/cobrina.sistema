import ExcelJS from "exceljs";
import mongoose from "mongoose";
import ContactadoVentana from "../models/ContactadoVentana.js";
import ContactadoObservacion from "../models/ContactadoObservacion.js";
import ReporteGestion from "../models/ReporteGestion.js";
import Pago from "../models/Pago.js";
import Entidad from "../models/Entidad.js";
import {
  asegurarLimpiezaEstadosTerminalesMes,
  asegurarMesContactados,
  estadoSincronizacionContactados,
  sincronizarContactadosEnSegundoPlano,
} from "../services/contactadosService.js";
import {
  USUARIOS_OCULTOS_REPORTES_CONTROL,
  esUsuarioVisibleEnReportesControl,
} from "../utils/controlEquipo.js";
import {
  claveFechaArgentina,
  fechaHoraGestionArgentina,
  finDiaArgentina,
  finMesArgentina,
  horasHabilesEntreArgentina,
  esDiaHabilArgentina,
  inicioDiaArgentina,
  inicioMesArgentina,
} from "../utils/contactadosTiempo.js";

const ROLES_SOLO_PROPIOS = new Set(["operador", "operador-vip", "capacitador", "capacitadora", "cuotero", "cuotera"]);
const PAGO_A_IMPUTAR_RX = /pago\s+a\s+imputar/i;
const ACUERDO_PAGO_RX = /^\s*acuerdo\s+de\s+pago(?:\s*[-–—:]?\s*cumplido)?\s*$/i;
const FILTRO_SIN_ESTADOS_TERMINALES = {
  $nor: [
    { calificacionInicio: PAGO_A_IMPUTAR_RX },
    { estadoCuentaInicio: PAGO_A_IMPUTAR_RX },
    { calificacionInicio: ACUERDO_PAGO_RX },
    { estadoCuentaInicio: ACUERDO_PAGO_RX },
  ],
};

function norm(value) {
  return String(value ?? "").trim();
}
function dniExcel(value) {
  const digits = norm(value).replace(/\D/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : digits;
}
function fechaExcel(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
function normUser(value) {
  return norm(value).toLowerCase();
}
function esMandoMedio(req) {
  return !ROLES_SOLO_PROPIOS.has(normUser(req.user?.role));
}
function usernameActual(req) {
  return normUser(req.user?.username);
}
function escaparRx(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function rxExact(value) {
  const v = norm(value);
  return v ? new RegExp(`^${escaparRx(v)}$`, "i") : null;
}
function mesActualArgentina() {
  return claveFechaArgentina(new Date()).slice(0, 7);
}
function mesAnteriorClave(mes = mesActualArgentina()) {
  const [year, month] = String(mes || "").split("-").map(Number);
  const d = new Date(Date.UTC(year, (month || 1) - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function mesRecuperadosPermitido(req, solicitado) {
  if (esMandoMedio(req)) return solicitado;
  const actual = mesActualArgentina();
  const anterior = mesAnteriorClave(actual);
  return [actual, anterior].includes(solicitado) ? solicitado : actual;
}
function syncMeta() {
  return estadoSincronizacionContactados();
}
function rangoMes(mes) {
  const safe = /^\d{4}-\d{2}$/.test(norm(mes)) ? norm(mes) : mesActualArgentina();
  return { mes: safe, desde: inicioMesArgentina(safe), hasta: finMesArgentina(safe) };
}
function rangoMesCalendarioUTC(mes) {
  const safe = /^\d{4}-\d{2}$/.test(norm(mes)) ? norm(mes) : mesActualArgentina();
  const [year, month] = safe.split("-").map(Number);
  return {
    mes: safe,
    desde: new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)),
    hasta: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0) - 1),
  };
}

function filtroScope(req, query = {}) {
  const filtro = {};
  if (!esMandoMedio(req)) {
    filtro.operador = usernameActual(req);
  } else if (query.operador) {
    filtro.operador = rxExact(query.operador);
  }
  if (query.dni) filtro.dni = norm(query.dni).replace(/\D/g, "");
  if (query.entidad) filtro.entidad = rxExact(query.entidad);
  return filtro;
}
function filtroScopeTabla(req, query = {}) {
  const filtro = filtroScope(req, query);
  if (!esMandoMedio(req)) return filtro;
  if (query.operador && !esUsuarioVisibleEnReportesControl(query.operador)) {
    return { ...filtro, _id: { $exists: false } };
  }
  if (!query.operador) {
    return { ...filtro, operador: { $nin: [...USUARIOS_OCULTOS_REPORTES_CONTROL] } };
  }
  return filtro;
}

function visibleEnTabla(req, operador) {
  return !esMandoMedio(req) || esUsuarioVisibleEnReportesControl(operador);
}

function normalizarOrden(query = {}, defaultKey = "venceAt", defaultDirection = "asc") {
  const permitidas = new Set([
    "semaforo", "cliente", "telefono", "operador", "entidad",
    "iniciaAt", "venceAt", "toquesMes", "validacion", "postSeguimiento",
  ]);
  const key = permitidas.has(norm(query.sortKey)) ? norm(query.sortKey) : defaultKey;
  const requestedDirection = norm(query.sortDir).toLowerCase();
  const direction = ["asc", "desc"].includes(requestedDirection) ? requestedDirection : defaultDirection;
  return { key, direction };
}

function ordenMongoVentanas(sort, { vencidas = false } = {}) {
  const dir = sort.direction === "desc" ? -1 : 1;
  const desempate = { operador: 1, dni: 1 };
  switch (sort.key) {
    // En Estado, ascendente conserva la lectura operativa Vigente → Por vencer → Crítico.
    // Como todas las ventanas duran 72 h hábiles, esa prioridad equivale a venceAt descendente.
    case "semaforo": return { venceAt: dir === 1 ? -1 : 1, ...desempate };
    case "cliente": return { nombreDeudor: dir, dni: dir, ...desempate };
    case "telefono": return { telefonoVisible: dir, telefonoOriginal: dir, ...desempate };
    case "operador": return { operador: dir, dni: 1 };
    case "entidad": return { entidad: dir, operador: 1, dni: 1 };
    case "iniciaAt": return { iniciaAt: dir, ...desempate };
    case "venceAt": return { venceAt: dir, ...desempate };
    default: return vencidas ? { venceAt: -1, ...desempate } : { venceAt: 1, ...desempate };
  }
}

function valorOrdenEspecial(row, key, now, toquesMap) {
  if (key === "toquesMes") return Number(toquesMap?.get(`${normUser(row.operador)}|${row.dni}`) || 0);
  if (key === "validacion") {
    const rank = {
      "no-requerido": 1, pendiente: 2, "pendiente-validacion": 3,
      validado: 4, cumplida: 4, "gestion-sin-check": 5,
      "check-sin-gestion": 6, vencido: 7,
    };
    return rank[estadoValidacion(row, now)] || 99;
  }
  return 0;
}

function ordenarEspecial(rows, sort, now, toquesMap) {
  const factor = sort.direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = valorOrdenEspecial(a, sort.key, now, toquesMap);
    const bv = valorOrdenEspecial(b, sort.key, now, toquesMap);
    if (av !== bv) return (av < bv ? -1 : 1) * factor;
    const op = normUser(a.operador).localeCompare(normUser(b.operador), "es");
    if (op) return op;
    return String(a.dni || "").localeCompare(String(b.dni || ""), "es", { numeric: true });
  });
}

function semaforoVentana(row, now = new Date()) {
  if (now >= new Date(row.venceAt)) return "vencido";
  if (now >= new Date(row.criticoAt)) return "critico";
  if (now >= new Date(row.alertaAt)) return "por-vencer";
  return "vigente";
}
function estadoValidacion(row, now = new Date()) {
  if (row.estado !== "abierta") {
    if (row.estado === "cumplida") return row.clickRealizadoAt ? "validado" : "gestion-sin-check";
    if (row.estado === "vencida") return row.clickRealizadoAt ? "check-sin-gestion" : "vencido";
    return row.estado;
  }
  // El operador puede trabajar el caso antes de las 48 h. Si ya hizo el check,
  // debe verse como pendiente de validación aunque todavía no haya nacido la alerta.
  if (row.clickRealizadoAt) return "pendiente-validacion";
  if (now < new Date(row.alertaAt)) return "no-requerido";
  return "pendiente";
}

async function mapaToquesMes(rows, mes) {
  if (!rows.length) return new Map();
  const { desde, hasta } = rangoMesCalendarioUTC(mes);
  const dnis = [...new Set(rows.map((r) => String(r.dni || "")).filter(Boolean))];
  const operadores = [...new Set(rows.map((r) => normUser(r.operador)).filter(Boolean))];
  if (!dnis.length || !operadores.length) return new Map();

  const agrupado = await ReporteGestion.aggregate([
    {
      $match: {
        borrado: { $ne: true },
        dni: { $in: dnis },
        usuario: { $in: operadores },
        fecha: { $gte: desde, $lte: hasta },
      },
    },
    { $group: { _id: { dni: "$dni", operador: "$usuario", dia: "$fecha" } } },
    { $group: { _id: { dni: "$_id.dni", operador: "$_id.operador" }, dias: { $sum: 1 } } },
  ]).allowDiskUse(true);

  return new Map(agrupado.map((r) => [`${normUser(r._id.operador)}|${r._id.dni}`, Number(r.dias || 0)]));
}

async function mapaUltimasObservaciones(rows) {
  const series = [...new Set(rows.map((r) => r.serieId).filter(Boolean))];
  if (!series.length) return new Map();
  const obs = await ContactadoObservacion.find({ serieId: { $in: series } })
    .sort({ createdAt: -1 })
    .lean();
  const map = new Map();
  for (const item of obs) {
    const current = map.get(item.serieId) || { operador: null, supervision: null, cantidad: 0 };
    current.cantidad += 1;
    if (item.tipo === "operador" && !current.operador) current.operador = item;
    if (item.tipo === "supervision" && !current.supervision) current.supervision = item;
    map.set(item.serieId, current);
  }
  return map;
}

function diaCalendarioUtcDesdeArgentina(value) {
  const key = claveFechaArgentina(new Date(value));
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

/**
 * Busca, en una sola consulta, la primera gestión REAL posterior al vencimiento
 * de cada ventana. Sirve para distinguir "venció dentro de 72 h" de "después
 * fue retomado" y poder volver a repartir únicamente lo que sigue sin trabajo.
 */
async function mapaSeguimientoPosterior(rows) {
  const ventanas = (rows || []).filter((r) => r?._id && r?.dni && r?.venceAt);
  if (!ventanas.length) return new Map();

  const dnis = [...new Set(ventanas.map((r) => String(r.dni || "")).filter(Boolean))];
  if (!dnis.length) return new Map();

  const desde = new Date(Math.min(...ventanas.map((r) => diaCalendarioUtcDesdeArgentina(r.venceAt).getTime())));
  const hasta = diaCalendarioUtcDesdeArgentina(new Date());
  // No limitamos por el operador original: si el vencido fue retomado por otra
  // persona del equipo también debe contarse como seguimiento posterior.
  const gestiones = await ReporteGestion.find({
    borrado: { $ne: true },
    dni: { $in: dnis },
    fecha: { $gte: desde, $lte: hasta },
  })
    .select("dni usuario fecha hora tipoContacto resultadoGestion estadoCuenta entidad entidadNumero observacionGestion")
    .sort({ fecha: 1, hora: 1, _id: 1 })
    .lean();

  const porDni = new Map();
  for (const gestion of gestiones) {
    const key = String(gestion.dni || "");
    if (!porDni.has(key)) porDni.set(key, []);
    const at = fechaHoraGestionArgentina(gestion.fecha, gestion.hora);
    if (at) porDni.get(key).push({ ...gestion, at });
  }

  const mismaEntidad = (ventana, gestion) => {
    const vn = Number(ventana.entidadNumero || 0);
    const gn = Number(gestion.entidadNumero || 0);
    if (vn > 0 && gn > 0) return vn === gn;
    const vNombre = norm(ventana.entidad).toUpperCase();
    const gNombre = norm(gestion.entidad).toUpperCase();
    if (vNombre && gNombre) return vNombre === gNombre;
    // Si un registro histórico no conserva entidad en Reporte de Gestiones,
    // preferimos no marcar un falso seguimiento sobre otra deuda del mismo DNI.
    return !vNombre && !vn;
  };

  const out = new Map();
  for (const ventana of ventanas) {
    const venceMs = new Date(ventana.venceAt).getTime();
    const lista = porDni.get(String(ventana.dni || "")) || [];
    const encontrada = lista.find((gestion) => gestion.at.getTime() > venceMs && mismaEntidad(ventana, gestion)) || null;
    out.set(String(ventana._id), encontrada ? {
      tiene: true,
      fecha: encontrada.at,
      operador: normUser(encontrada.usuario),
      tipoContacto: encontrada.tipoContacto || "",
      resultadoGestion: encontrada.resultadoGestion || "",
      estadoCuenta: encontrada.estadoCuenta || "",
      observacionGestion: encontrada.observacionGestion || "",
    } : { tiene: false, fecha: null, operador: "" });
  }
  return out;
}

function valorOrdenFila(row, key, { now = new Date(), toquesMap = null, postMap = null } = {}) {
  if (key === "semaforo") {
    const rank = { vigente: 1, "por-vencer": 2, critico: 3, vencido: 4 };
    return rank[semaforoVentana(row, now)] || 99;
  }
  if (key === "cliente") return `${norm(row.nombreDeudor).toLowerCase()}|${String(row.dni || "")}`;
  if (key === "telefono") return norm(row.telefonoVisible || row.telefonoOriginal);
  if (key === "operador") return normUser(row.operador);
  if (key === "entidad") return norm(row.entidad).toLowerCase();
  if (key === "iniciaAt") return new Date(row.iniciaAt || 0).getTime();
  if (key === "venceAt") return new Date(row.venceAt || 0).getTime();
  if (key === "toquesMes") return Number(toquesMap?.get(`${normUser(row.operador)}|${row.dni}`) || 0);
  if (key === "validacion") return valorOrdenEspecial(row, "validacion", now, toquesMap);
  if (key === "postSeguimiento") return postMap?.get(String(row._id))?.tiene ? 1 : 0;
  return "";
}

function ordenarFilasMemoria(rows, sort, helpers = {}) {
  const factor = sort.direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = valorOrdenFila(a, sort.key, helpers);
    const bv = valorOrdenFila(b, sort.key, helpers);
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    const op = normUser(a.operador).localeCompare(normUser(b.operador), "es");
    if (op) return op;
    return String(a.dni || "").localeCompare(String(b.dni || ""), "es", { numeric: true });
  });
}

function serializarVentana(row, { toques = 0, observaciones = null, seguimientoPosterior = null, now = new Date() } = {}) {
  const restante = Math.max(0, horasHabilesEntreArgentina(now, row.venceAt));
  const transcurridas = Math.min(72, Math.max(0, 72 - restante));
  return {
    id: String(row._id),
    serieId: row.serieId,
    dni: row.dni,
    nombreDeudor: row.nombreDeudor || "",
    operador: row.operador,
    entidad: row.entidad || "",
    entidadNumero: row.entidadNumero ?? null,
    telefono: row.telefonoVisible || row.telefonoOriginal || "",
    contactoOriginal: row.telefonoOriginal || row.telefonoVisible || "",
    whatsappNumero: row.whatsappNumero || "",
    whatsappDisponible: Boolean(row.whatsappDisponible),
    iniciaAt: row.iniciaAt,
    alertaAt: row.alertaAt,
    criticoAt: row.criticoAt,
    venceAt: row.venceAt,
    estado: row.estado,
    semaforo: semaforoVentana(row, now),
    horasHabilesRestantes: Math.round(restante * 10) / 10,
    horasHabilesTranscurridas: Math.round(transcurridas * 10) / 10,
    calificacionInicio: row.calificacionInicio || "",
    tipoContactoInicio: row.tipoContactoInicio || "",
    estadoCuentaInicio: row.estadoCuentaInicio || "",
    observacionGestionInicio: row.observacionGestionInicio || "",
    clickRealizadoAt: row.clickRealizadoAt || null,
    validacion: estadoValidacion(row, now),
    toquesMes: Number(toques || 0),
    observaciones: {
      cantidad: observaciones?.cantidad || 0,
      operador: observaciones?.operador
        ? { texto: observaciones.operador.texto, autor: observaciones.operador.autorUsername, fecha: observaciones.operador.createdAt }
        : null,
      supervision: observaciones?.supervision
        ? { texto: observaciones.supervision.texto, autor: observaciones.supervision.autorUsername, fecha: observaciones.supervision.createdAt }
        : null,
    },
    seguimientoPosterior: seguimientoPosterior || null,
  };
}

async function obtenerSeguimientoData(req, { exportar = false } = {}) {
  sincronizarContactadosEnSegundoPlano();
  const now = new Date();
  const mesSolicitado = /^\d{4}-\d{2}$/.test(norm(req.query.mes)) ? norm(req.query.mes) : mesActualArgentina();
  const mes = esMandoMedio(req) ? mesSolicitado : mesActualArgentina();
  if (mes !== mesActualArgentina()) await asegurarMesContactados(mes);
  else await asegurarLimpiezaEstadosTerminalesMes(mes);
  const filtroBaseMes = {
    ...filtroScopeTabla(req, req.query),
    ...FILTRO_SIN_ESTADOS_TERMINALES,
    mesOrigen: mes,
  };
  const filtro = {
    ...filtroBaseMes,
    estado: "abierta",
    venceAt: { $gt: now },
  };
  const semaforo = norm(req.query.semaforo);
  if (semaforo === "vigente") filtro.alertaAt = { $gt: now };
  if (semaforo === "por-vencer") {
    filtro.alertaAt = { $lte: now };
    filtro.criticoAt = { $gt: now };
  }
  if (semaforo === "critico") {
    filtro.criticoAt = { $lte: now };
    filtro.venceAt = { $gt: now };
  }
  const soloPendientes = String(req.query.soloPendientes || "").toLowerCase() === "true";
  if (soloPendientes) {
    filtro.alertaAt = { $lte: now };
    filtro.clickRealizadoAt = null;
  }
  const tocado = norm(req.query.tocado).toLowerCase();
  if (tocado === "si") filtro.clickRealizadoAt = { $ne: null };
  if (tocado === "no") filtro.clickRealizadoAt = null;

  const page = exportar ? 1 : Math.max(1, Number(req.query.page || 1));
  const limit = exportar ? 10000 : Math.min(250, Math.max(10, Number(req.query.limit || 80)));
  const sort = normalizarOrden(req.query, "venceAt", "asc");
  const totalPromise = ContactadoVentana.countDocuments(filtro);
  const origenesPromise = ContactadoVentana.countDocuments({ ...filtroBaseMes, esOrigenContactado: true });
  let rows;
  if (["toquesMes", "validacion"].includes(sort.key)) {
    const allRows = await ContactadoVentana.find(filtro).lean();
    const allToques = sort.key === "toquesMes" ? await mapaToquesMes(allRows, mes) : null;
    rows = ordenarEspecial(allRows, sort, now, allToques).slice((page - 1) * limit, page * limit);
  } else {
    rows = await ContactadoVentana.find(filtro)
      .sort(ordenMongoVentanas(sort))
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
  }
  const [total, origenesMes, toquesMap, obsMap] = await Promise.all([
    totalPromise,
    origenesPromise,
    mapaToquesMes(rows, mes),
    mapaUltimasObservaciones(rows),
  ]);
  const items = rows.map((row) => serializarVentana(row, {
    toques: toquesMap.get(`${normUser(row.operador)}|${row.dni}`) || 0,
    observaciones: obsMap.get(row.serieId),
    now,
  }));
  return { items, total, origenesMes, page, limit, mes, sort, canViewAll: esMandoMedio(req), sync: syncMeta() };
}

async function obtenerVencidosData(req, { hoy = false, exportar = false } = {}) {
  // Vencidos e Histórico contienen información de control del equipo y quedan
  // reservados a supervisión / mandos medios. El operador trabaja sus Activos.
  if (!esMandoMedio(req)) {
    const error = new Error(hoy
      ? "La vista Vencidos hoy es exclusiva de supervisión y mandos medios."
      : "El histórico de Contactados es exclusivo de supervisión y mandos medios.");
    error.status = 403;
    throw error;
  }

  const now = new Date();
  if (hoy && !esDiaHabilArgentina(now)) {
    return {
      items: [], total: 0, page: 1, limit: Math.min(250, Math.max(10, Number(req.query.limit || 80))),
      mes: mesActualArgentina(), canViewAll: true, diaHabil: false,
      mensajeDiaNoHabil: "Hoy no es día hábil: las ventanas de Contactados no vencen sábados, domingos ni feriados. El cómputo continúa el próximo día hábil.",
      sync: syncMeta(),
    };
  }

  sincronizarContactadosEnSegundoPlano();
  const mes = hoy
    ? mesActualArgentina()
    : (/^\d{4}-\d{2}$/.test(norm(req.query.mes)) ? norm(req.query.mes) : mesActualArgentina());
  if (!hoy && mes !== mesActualArgentina()) await asegurarMesContactados(mes);
  else await asegurarLimpiezaEstadosTerminalesMes(mes);

  const filtro = { ...filtroScopeTabla(req, req.query), ...FILTRO_SIN_ESTADOS_TERMINALES, mesOrigen: mes, estado: "vencida" };
  if (hoy) filtro.venceAt = { $gte: inicioDiaArgentina(), $lte: finDiaArgentina() };

  const page = exportar ? 1 : Math.max(1, Number(req.query.page || 1));
  const limit = exportar ? 10000 : Math.min(250, Math.max(10, Number(req.query.limit || 80)));
  const sort = normalizarOrden(req.query, "venceAt", "desc");
  const postFiltro = ["con", "sin"].includes(norm(req.query.postSeguimiento)) ? norm(req.query.postSeguimiento) : "";
  const necesitaUniversoCompleto = Boolean(postFiltro) || ["toquesMes", "validacion", "postSeguimiento"].includes(sort.key);

  let rows = [];
  let total = 0;
  let allToques = null;
  let allPost = null;

  if (necesitaUniversoCompleto) {
    let universo = await ContactadoVentana.find(filtro).lean();
    if (sort.key === "toquesMes") allToques = await mapaToquesMes(universo, mes);
    if (postFiltro || sort.key === "postSeguimiento") allPost = await mapaSeguimientoPosterior(universo);

    if (postFiltro) {
      universo = universo.filter((row) => {
        const tiene = Boolean(allPost?.get(String(row._id))?.tiene);
        return postFiltro === "con" ? tiene : !tiene;
      });
    }

    universo = ordenarFilasMemoria(universo, sort, { now, toquesMap: allToques, postMap: allPost });
    total = universo.length;
    rows = exportar ? universo : universo.slice((page - 1) * limit, page * limit);
  } else {
    total = await ContactadoVentana.countDocuments(filtro);
    rows = await ContactadoVentana.find(filtro)
      .sort(ordenMongoVentanas(sort, { vencidas: true }))
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
  }

  const [toquesMap, obsMap, postMapPagina] = await Promise.all([
    allToques || mapaToquesMes(rows, mes),
    mapaUltimasObservaciones(rows),
    allPost || mapaSeguimientoPosterior(rows),
  ]);

  return {
    items: rows.map((row) => serializarVentana(row, {
      toques: toquesMap.get(`${normUser(row.operador)}|${row.dni}`) || 0,
      observaciones: obsMap.get(row.serieId),
      seguimientoPosterior: postMapPagina.get(String(row._id)) || { tiene: false, fecha: null },
      now,
    })),
    total,
    page,
    limit,
    mes,
    sort,
    postSeguimiento: postFiltro,
    diaHabil: hoy ? true : null,
    canViewAll: true,
    sync: syncMeta(),
  };
}

export async function resumenAlerta(req, res) {
  try {
    sincronizarContactadosEnSegundoPlano();
    await asegurarLimpiezaEstadosTerminalesMes(mesActualArgentina());
    const now = new Date();
    if (esMandoMedio(req)) {
      const vencidosHoy = await ContactadoVentana.countDocuments({
        ...FILTRO_SIN_ESTADOS_TERMINALES,
        mesOrigen: mesActualArgentina(),
        estado: "vencida",
        venceAt: { $gte: inicioDiaArgentina(now), $lte: finDiaArgentina(now) },
        operador: { $nin: [...USUARIOS_OCULTOS_REPORTES_CONTROL] },
      });
      return res.json({ ok: true, canViewAll: true, vencidosHoy, sync: syncMeta() });
    }

    const operador = usernameActual(req);
    const base = { ...FILTRO_SIN_ESTADOS_TERMINALES, mesOrigen: mesActualArgentina(), estado: "abierta", operador, alertaAt: { $lte: now }, venceAt: { $gt: now } };
    const [pendientes, criticos, realizadosPendientesValidar] = await Promise.all([
      ContactadoVentana.countDocuments({ ...base, clickRealizadoAt: null }),
      ContactadoVentana.countDocuments({ ...base, criticoAt: { $lte: now }, clickRealizadoAt: null }),
      ContactadoVentana.countDocuments({ ...base, clickRealizadoAt: { $ne: null } }),
    ]);
    return res.json({ ok: true, canViewAll: false, pendientes, criticos, realizadosPendientesValidar, sync: syncMeta() });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "No se pudo consultar la alerta de Contactados" });
  }
}

export async function listarSeguimiento(req, res) {
  try {
    return res.json({ ok: true, ...(await obtenerSeguimientoData(req)) });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || "No se pudieron cargar los Contactados" });
  }
}

export async function listarVencidosHoy(req, res) {
  try {
    return res.json({ ok: true, ...(await obtenerVencidosData(req, { hoy: true })) });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || "No se pudieron cargar los vencidos de hoy" });
  }
}

export async function listarHistoricoVencidos(req, res) {
  try {
    return res.json({ ok: true, ...(await obtenerVencidosData(req, { hoy: false })) });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || "No se pudo cargar el histórico" });
  }
}

export async function marcarRealizado(req, res) {
  try {
    if (esMandoMedio(req)) return res.status(403).json({ error: "El check Realizado corresponde al operador que tiene asignado el Contactado" });
    sincronizarContactadosEnSegundoPlano();
    await asegurarLimpiezaEstadosTerminalesMes(mesActualArgentina());
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Caso inválido" });
    const now = new Date();
    const row = await ContactadoVentana.findOne({ _id: req.params.id, ...FILTRO_SIN_ESTADOS_TERMINALES, mesOrigen: mesActualArgentina(), estado: "abierta", venceAt: { $gt: now } });
    if (!row) return res.status(404).json({ error: "El Contactado ya no está activo" });
    if (normUser(row.operador) !== usernameActual(req)) return res.status(403).json({ error: "Solo el operador asignado puede marcar este caso" });

    // El check puede hacerse antes de las 48 h: "aún no requiere seguimiento" sólo
    // significa que la alerta no venció, no que el botón Realizado deba bloquearse.
    if (!row.clickRealizadoAt) {
      row.clickRealizadoAt = now;
      row.clickRealizadoPor = usernameActual(req);
      await row.save();
    }
    const observacion = norm(req.body?.observacion).slice(0, 1800);
    if (observacion) {
      await ContactadoObservacion.create({
        serieId: row.serieId,
        ventanaId: row._id,
        dni: row.dni,
        operadorCaso: row.operador,
        autorId: req.user.id,
        autorUsername: usernameActual(req),
        autorRole: req.user.role,
        tipo: "operador",
        texto: observacion,
      });
    }
    return res.json({ ok: true, mensaje: "Marcado como realizado. Queda pendiente de validar contra Reporte de Gestiones." });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "No se pudo marcar como realizado" });
  }
}

export async function agregarObservacion(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Caso inválido" });
    const texto = norm(req.body?.texto).slice(0, 1800);
    if (!texto) return res.status(400).json({ error: "Escribí una observación" });
    const row = await ContactadoVentana.findById(req.params.id).lean();
    if (!row) return res.status(404).json({ error: "Caso no encontrado" });
    const manager = esMandoMedio(req);
    if (!manager && normUser(row.operador) !== usernameActual(req)) return res.status(403).json({ error: "No tenés acceso a este caso" });
    if (!manager && row.estado !== "abierta") return res.status(403).json({ error: "Los operadores no pueden agregar observaciones a casos vencidos" });

    const item = await ContactadoObservacion.create({
      serieId: row.serieId,
      ventanaId: row._id,
      dni: row.dni,
      operadorCaso: row.operador,
      autorId: req.user.id,
      autorUsername: usernameActual(req),
      autorRole: req.user.role,
      tipo: manager ? "supervision" : "operador",
      texto,
    });
    return res.status(201).json({ ok: true, item });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "No se pudo guardar la observación" });
  }
}

export async function listarObservaciones(req, res) {
  try {
    const serieId = norm(req.params.serieId);
    if (!serieId) return res.status(400).json({ error: "Serie inválida" });
    const ventana = await ContactadoVentana.findOne({ serieId }).sort({ iniciaAt: -1 }).lean();
    if (!ventana) return res.status(404).json({ error: "Caso no encontrado" });
    if (!esMandoMedio(req) && normUser(ventana.operador) !== usernameActual(req)) return res.status(403).json({ error: "No tenés acceso a este caso" });
    if (!esMandoMedio(req) && ventana.estado !== "abierta") {
      return res.status(403).json({ error: "El histórico de Contactados es exclusivo de supervisión y mandos medios" });
    }
    const items = await ContactadoObservacion.find({ serieId }).sort({ createdAt: 1 }).lean();
    return res.json({ ok: true, items });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "No se pudieron cargar las observaciones" });
  }
}

async function calcularEstadisticasActivos(req) {
  sincronizarContactadosEnSegundoPlano();
  const now = new Date();
  const rangoSolicitado = rangoMes(req.query.mes);
  const mes = esMandoMedio(req) ? rangoSolicitado.mes : mesActualArgentina();
  if (mes !== mesActualArgentina()) await asegurarMesContactados(mes);
  else await asegurarLimpiezaEstadosTerminalesMes(mes);
  const scope = filtroScope(req, req.query);
  const filtroStats = { ...scope, ...FILTRO_SIN_ESTADOS_TERMINALES, mesOrigen: mes };
  const tocado = norm(req.query.tocado).toLowerCase();
  if (tocado === "si") filtroStats.clickRealizadoAt = { $ne: null };
  if (tocado === "no") filtroStats.clickRealizadoAt = null;
  const rows = await ContactadoVentana.find(filtroStats).lean();
  const cerradasEvaluables = rows.filter((r) => ["cumplida", "vencida"].includes(r.estado));
  const cumplidas = cerradasEvaluables.filter((r) => r.estado === "cumplida");
  const vencidas = cerradasEvaluables.filter((r) => r.estado === "vencida");
  const pendientes = rows.filter((r) => r.estado === "abierta" && new Date(r.alertaAt) <= now && new Date(r.venceAt) > now);
  const cumplimientoPct = cerradasEvaluables.length ? (cumplidas.length * 100) / cerradasEvaluables.length : 0;

  const origenes = await ContactadoVentana.countDocuments({ ...filtroStats, esOrigenContactado: true });
  const activas = await ContactadoVentana.find({ ...filtroStats, estado: "abierta", venceAt: { $gt: now } }).select("alertaAt criticoAt venceAt operador").lean();
  const semaforos = { vigente: 0, porVencer: 0, critico: 0 };
  activas.forEach((r) => {
    const sem = semaforoVentana(r, now);
    if (sem === "vigente") semaforos.vigente += 1;
    else if (sem === "por-vencer") semaforos.porVencer += 1;
    else if (sem === "critico") semaforos.critico += 1;
  });

  const porOperador = new Map();
  for (const row of [...cerradasEvaluables, ...pendientes]) {
    const op = row.operador || "sin-operador";
    const item = porOperador.get(op) || { operador: op, cumplidos: 0, vencidos: 0, pendientes: 0, totalCerrados: 0, cumplimientoPct: 0 };
    if (row.estado === "cumplida") { item.cumplidos += 1; item.totalCerrados += 1; }
    else if (row.estado === "vencida") { item.vencidos += 1; item.totalCerrados += 1; }
    else item.pendientes += 1;
    porOperador.set(op, item);
  }
  const rendimiento = [...porOperador.values()].map((r) => ({
    ...r,
    cumplimientoPct: r.totalCerrados ? Math.round((r.cumplidos * 1000) / r.totalCerrados) / 10 : 0,
  })).sort((a, b) => b.cumplimientoPct - a.cumplimientoPct || b.totalCerrados - a.totalCerrados);

  const calidadMap = new Map();
  cumplidas.forEach((r) => {
    const label = norm(r.calificacionResolucion) || "Sin calificación";
    calidadMap.set(label, (calidadMap.get(label) || 0) + 1);
  });
  const calidadRenovacion = [...calidadMap.entries()]
    .map(([calificacion, cantidad]) => ({ calificacion, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad)
    .slice(0, 12);

  const checksValidados = cumplidas.filter((r) => r.clickRealizadoAt).length;
  const gestionesSinCheck = cumplidas.filter((r) => !r.clickRealizadoAt).length;
  const checksSinGestion = vencidas.filter((r) => r.clickRealizadoAt).length;
  const renovacionesConContacto = cumplidas.filter((r) => /contactad[oa]/i.test(`${norm(r.calificacionResolucion)} ${norm(r.estadoCuentaResolucion)}`)).length;
  const renovacionesConContactoPct = cumplidas.length ? Math.round((renovacionesConContacto * 1000) / cumplidas.length) / 10 : 0;

  return {
    mes,
    canViewAll: esMandoMedio(req),
    resumen: {
      contactadosGenerados: origenes,
      cumplidos: cumplidas.length,
      vencidos: vencidas.length,
      pendientes: pendientes.length,
      cumplimientoPct: Math.round(cumplimientoPct * 10) / 10,
      checksValidados,
      gestionesSinCheck,
      checksSinGestion,
      renovacionesConContacto,
      renovacionesConContactoPct,
      ...semaforos,
    },
    rendimiento: rendimiento.filter((r) => visibleEnTabla(req, r.operador)),
    calidadRenovacion,
  };
}


async function calcularEstadisticasVencidos(req, { hoy = false } = {}) {
  if (!esMandoMedio(req)) {
    const error = new Error("Las estadísticas de vencidos son exclusivas de supervisión y mandos medios.");
    error.status = 403;
    throw error;
  }

  const now = new Date();
  const mes = hoy
    ? mesActualArgentina()
    : (/^\d{4}-\d{2}$/.test(norm(req.query.mes)) ? norm(req.query.mes) : mesActualArgentina());

  if (hoy && !esDiaHabilArgentina(now)) {
    return {
      modo: "vencidos-hoy",
      mes,
      canViewAll: true,
      diaHabil: false,
      resumen: {
        vencidosTotal: 0,
        conGestionPosterior: 0,
        sinGestionPosterior: 0,
        conCheck: 0,
        sinCheck: 0,
        conObservacionOperador: 0,
        retomadosPct: 0,
      },
      rendimiento: [],
      calidadRenovacion: [],
    };
  }

  if (!hoy && mes !== mesActualArgentina()) await asegurarMesContactados(mes);
  else await asegurarLimpiezaEstadosTerminalesMes(mes);

  const filtro = { ...filtroScopeTabla(req, req.query), ...FILTRO_SIN_ESTADOS_TERMINALES, mesOrigen: mes, estado: "vencida" };
  if (hoy) filtro.venceAt = { $gte: inicioDiaArgentina(now), $lte: finDiaArgentina(now) };

  let rows = await ContactadoVentana.find(filtro).lean();
  const postMap = await mapaSeguimientoPosterior(rows);
  const postFiltro = !hoy && ["con", "sin"].includes(norm(req.query.postSeguimiento))
    ? norm(req.query.postSeguimiento)
    : "";
  if (postFiltro) {
    rows = rows.filter((row) => {
      const tiene = Boolean(postMap.get(String(row._id))?.tiene);
      return postFiltro === "con" ? tiene : !tiene;
    });
  }

  const obsMap = await mapaUltimasObservaciones(rows);
  const porOperador = new Map();
  const calidadMap = new Map();
  let conGestionPosterior = 0;
  let sinGestionPosterior = 0;
  let conCheck = 0;
  let sinCheck = 0;
  let conObservacionOperador = 0;

  for (const row of rows) {
    const post = postMap.get(String(row._id));
    const tienePost = Boolean(post?.tiene);
    if (tienePost) conGestionPosterior += 1;
    else sinGestionPosterior += 1;
    if (row.clickRealizadoAt) conCheck += 1;
    else sinCheck += 1;
    if (obsMap.get(row.serieId)?.operador) conObservacionOperador += 1;

    const op = row.operador || "sin-operador";
    const item = porOperador.get(op) || {
      operador: op,
      vencidos: 0,
      conGestionPosterior: 0,
      sinGestionPosterior: 0,
      conCheck: 0,
      retomadosPct: 0,
    };
    item.vencidos += 1;
    if (tienePost) item.conGestionPosterior += 1;
    else item.sinGestionPosterior += 1;
    if (row.clickRealizadoAt) item.conCheck += 1;
    porOperador.set(op, item);

    const label = norm(row.calificacionInicio) || "Sin calificación";
    calidadMap.set(label, (calidadMap.get(label) || 0) + 1);
  }

  const rendimiento = [...porOperador.values()].map((r) => ({
    ...r,
    retomadosPct: r.vencidos ? Math.round((r.conGestionPosterior * 1000) / r.vencidos) / 10 : 0,
  })).sort((a, b) => b.sinGestionPosterior - a.sinGestionPosterior || a.retomadosPct - b.retomadosPct);

  const calidadRenovacion = [...calidadMap.entries()]
    .map(([calificacion, cantidad]) => ({ calificacion, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad)
    .slice(0, 12);

  return {
    modo: hoy ? "vencidos-hoy" : "historico",
    mes,
    canViewAll: true,
    diaHabil: hoy ? true : null,
    postSeguimiento: postFiltro,
    resumen: {
      vencidosTotal: rows.length,
      conGestionPosterior,
      sinGestionPosterior,
      conCheck,
      sinCheck,
      conObservacionOperador,
      retomadosPct: rows.length ? Math.round((conGestionPosterior * 1000) / rows.length) / 10 : 0,
    },
    rendimiento: rendimiento.filter((r) => visibleEnTabla(req, r.operador)),
    calidadRenovacion,
  };
}

async function calcularEstadisticas(req) {
  const vista = norm(req.query.vistaAnalisis || req.query.subvista || "activos");
  if (vista === "vencidos-hoy") return calcularEstadisticasVencidos(req, { hoy: true });
  if (vista === "historico") return calcularEstadisticasVencidos(req, { hoy: false });
  const data = await calcularEstadisticasActivos(req);
  return { modo: "activos", ...data };
}

export async function estadisticas(req, res) {
  try {
    const data = await calcularEstadisticas(req);
    return res.json({ ok: true, ...data, sync: syncMeta() });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || "No se pudieron calcular las estadísticas" });
  }
}

async function calcularRecuperados(req) {
  sincronizarContactadosEnSegundoPlano();
  const dias = [7, 15, 30, 60].includes(Number(req.query.dias)) ? Number(req.query.dias) : 30;
  const rangoSolicitado = rangoMes(req.query.mes);
  const mes = mesRecuperadosPermitido(req, rangoSolicitado.mes);
  if (mes !== mesActualArgentina()) await asegurarMesContactados(mes);
  else await asegurarLimpiezaEstadosTerminalesMes(mes);
  const filtroSolicitado = filtroScope(req, req.query);

  // El universo se define por el MES EN QUE NACIÓ el Contactado. No se arrastran
  // casos originados el mes anterior sólo porque vencieron o cobraron después.
  // Buscamos globalmente dentro de ese mes para atribuir cada pago al último
  // vencimiento real y recién después aplicamos el scope del usuario/operador.
  const todasVencidas = await ContactadoVentana.find({
    ...FILTRO_SIN_ESTADOS_TERMINALES,
    mesOrigen: mes,
    estado: "vencida",
  }).sort({ venceAt: 1 }).lean();
  if (!todasVencidas.length) return { mes, dias, resumen: { vencidos: 0, cobradosPorOtro: 0, cobradosPorMismo: 0, sinRecupero: 0, montoPorOtros: 0, montoMismo: 0, pctCobradosPorOtro: 0 }, porOperador: [], casos: [], diagnosticoPagos: { pagosEncontrados: 0, pagosAsignados: 0, vencidosConEntidadCanonica: 0, vencidosSinEntidadCanonica: 0 } };

  // Contactados históricos anteriores a la normalización pueden no haber guardado
  // entidadNumero. La reconstruimos por el nombre canónico para que el cruce con
  // Pagos use siempre DNI + ENTIDAD y no caiga en coincidencias por DNI solo.
  const nombresEntidad = [...new Set(todasVencidas.map((r) => norm(r.entidad).toUpperCase()).filter(Boolean))];
  const entidadesCatalogo = nombresEntidad.length
    ? await Entidad.find({ $or: nombresEntidad.map((nombre) => ({ nombre: rxExact(nombre) })) }).select("nombre numero").lean()
    : [];
  const numeroPorEntidad = new Map(entidadesCatalogo.map((e) => [norm(e.nombre).toUpperCase(), Number(e.numero)]));
  todasVencidas.forEach((row) => {
    const guardado = Number(row.entidadNumero);
    row.__entidadNumero = Number.isFinite(guardado) && guardado > 0
      ? guardado
      : Number(numeroPorEntidad.get(norm(row.entidad).toUpperCase()) || 0) || null;
  });

  const dnis = [...new Set(todasVencidas.map((r) => String(r.dni || "")).filter(Boolean))];
  const vencimientosCalendarioUTC = todasVencidas.map((v) => {
    const [y, m, d] = claveFechaArgentina(new Date(v.venceAt)).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  });
  const pagoDesde = new Date(Math.min(...vencimientosCalendarioUTC.map((d) => d.getTime())));
  const ultimoVencimiento = Math.max(...vencimientosCalendarioUTC.map((d) => d.getTime()));
  const pagoHastaExclusivo = new Date(ultimoVencimiento + (dias + 1) * 86_400_000);
  const entidadesNumeros = [...new Set(todasVencidas.map((r) => Number(r.__entidadNumero || 0)).filter((n) => n > 0))];
  const pagos = await Pago.find({
    dni: { $in: dnis },
    ...(entidadesNumeros.length ? { entidadId: { $in: entidadesNumeros } } : {}),
    fechaPago: { $gte: pagoDesde, $lt: pagoHastaExclusivo },
  })
    .select("dni entidadId subCesionId fechaPago monto operadorUsername conceptoCodigo")
    .sort({ fechaPago: 1, _id: 1 })
    .lean();

  const porDni = new Map();
  todasVencidas.forEach((v) => {
    if (!porDni.has(v.dni)) porDni.set(v.dni, []);
    porDni.get(v.dni).push(v);
  });

  const asignaciones = new Map(); // ventanaId -> pagos[]
  for (const pago of pagos) {
    const candidatos = (porDni.get(String(pago.dni)) || []).filter((v) => {
      const vence = new Date(v.venceAt);
      const pagoFecha = new Date(pago.fechaPago);
      const [vy, vm, vd] = claveFechaArgentina(vence).split("-").map(Number);
      const venceDiaCalendarioUTC = new Date(Date.UTC(vy, vm - 1, vd, 0, 0, 0, 0));
      // Pago sólo guarda día calendario, no hora. Si cae el mismo día del vencimiento
      // se considera recupero posterior posible porque no existe precisión horaria para separarlo.
      const diff = pagoFecha.getTime() - venceDiaCalendarioUTC.getTime();
      if (diff < 0 || diff > dias * 86_400_000) return false;
      const entidadVentana = Number(v.__entidadNumero || 0);
      const entidadPago = Number(pago.entidadId || 0);
      if (!entidadVentana || !entidadPago) return false;
      return entidadVentana === entidadPago;
    });
    if (!candidatos.length) continue;
    candidatos.sort((a, b) => new Date(b.venceAt) - new Date(a.venceAt));
    const elegida = candidatos[0];
    const key = String(elegida._id);
    if (!asignaciones.has(key)) asignaciones.set(key, []);
    asignaciones.get(key).push(pago);
  }

  function cumpleFiltro(v) {
    if (filtroSolicitado.operador) {
      if (filtroSolicitado.operador instanceof RegExp) {
        if (!filtroSolicitado.operador.test(v.operador)) return false;
      } else if (v.operador !== filtroSolicitado.operador) return false;
    }
    if (filtroSolicitado.dni && v.dni !== filtroSolicitado.dni) return false;
    if (filtroSolicitado.entidad instanceof RegExp && !filtroSolicitado.entidad.test(v.entidad || "")) return false;
    return true;
  }

  const vencidasScope = todasVencidas.filter(cumpleFiltro);
  const casos = vencidasScope.map((v) => {
    const ps = asignaciones.get(String(v._id)) || [];
    let montoPorOtros = 0;
    let montoMismo = 0;
    const otros = new Set();
    ps.forEach((p) => {
      const mismo = normUser(p.operadorUsername) === normUser(v.operador);
      if (mismo) montoMismo += Number(p.monto || 0);
      else {
        montoPorOtros += Number(p.monto || 0);
        if (p.operadorUsername) otros.add(normUser(p.operadorUsername));
      }
    });
    const tipo = montoPorOtros > 0 ? "otro" : montoMismo > 0 ? "mismo" : "sin-recupero";
    return {
      id: String(v._id), serieId: v.serieId, dni: v.dni, nombreDeudor: v.nombreDeudor || "",
      operador: v.operador, entidad: v.entidad || "", venceAt: v.venceAt, tipo,
      montoPorOtros, montoMismo, operadoresQueCobraron: [...otros], pagos: ps.length,
    };
  });

  const porOperadorMap = new Map();
  casos.forEach((c) => {
    const r = porOperadorMap.get(c.operador) || { operador: c.operador, vencidos: 0, cobradosPorOtro: 0, cobradosPorMismo: 0, sinRecupero: 0, montoPorOtros: 0, montoMismo: 0 };
    r.vencidos += 1;
    if (c.tipo === "otro") r.cobradosPorOtro += 1;
    else if (c.tipo === "mismo") r.cobradosPorMismo += 1;
    else r.sinRecupero += 1;
    r.montoPorOtros += c.montoPorOtros;
    r.montoMismo += c.montoMismo;
    porOperadorMap.set(c.operador, r);
  });
  const porOperador = [...porOperadorMap.values()].map((r) => ({
    ...r,
    pctCobradosPorOtro: r.vencidos ? Math.round((r.cobradosPorOtro * 1000) / r.vencidos) / 10 : 0,
  })).sort((a, b) => b.montoPorOtros - a.montoPorOtros || b.cobradosPorOtro - a.cobradosPorOtro);

  const resumen = porOperador.reduce((a, r) => ({
    vencidos: a.vencidos + r.vencidos,
    cobradosPorOtro: a.cobradosPorOtro + r.cobradosPorOtro,
    cobradosPorMismo: a.cobradosPorMismo + r.cobradosPorMismo,
    sinRecupero: a.sinRecupero + r.sinRecupero,
    montoPorOtros: a.montoPorOtros + r.montoPorOtros,
    montoMismo: a.montoMismo + r.montoMismo,
  }), { vencidos: 0, cobradosPorOtro: 0, cobradosPorMismo: 0, sinRecupero: 0, montoPorOtros: 0, montoMismo: 0 });
  resumen.pctCobradosPorOtro = resumen.vencidos ? Math.round((resumen.cobradosPorOtro * 1000) / resumen.vencidos) / 10 : 0;
  return {
    mes,
    dias,
    resumen,
    diagnosticoPagos: {
      pagosEncontrados: pagos.length,
      pagosAsignados: [...asignaciones.values()].reduce((acc, lista) => acc + lista.length, 0),
      vencidosConEntidadCanonica: todasVencidas.filter((r) => Number(r.__entidadNumero || 0) > 0).length,
      vencidosSinEntidadCanonica: todasVencidas.filter((r) => !Number(r.__entidadNumero || 0)).length,
    },
    // En Vencidos / recuperados interesa el universo completo que perdió casos.
    // A diferencia de Reportes/Controles, acá sí deben aparecer residual, cuotería
    // y cualquier usuario operativo excluido de rankings de control.
    porOperador,
    // El operador puede ver el impacto agregado de sus vencidos, pero nunca
    // recibe el detalle de DNIs que ya perdió. Ese listado es sólo de mando medio.
    casos: esMandoMedio(req) ? casos : [],
  };
}

export async function recuperados(req, res) {
  try {
    return res.json({ ok: true, canViewAll: esMandoMedio(req), ...(await calcularRecuperados(req)), sync: syncMeta() });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "No se pudo analizar el recupero posterior" });
  }
}

export async function catalogos(req, res) {
  try {
    sincronizarContactadosEnSegundoPlano();
    const mesSolicitado = /^\d{4}-\d{2}$/.test(norm(req.query.mes)) ? norm(req.query.mes) : mesActualArgentina();
    const esVistaRecuperados = norm(req.query.vista).toLowerCase() === "recuperados";
    const mes = esMandoMedio(req)
      ? mesSolicitado
      : esVistaRecuperados
        ? mesRecuperadosPermitido(req, mesSolicitado)
        : mesActualArgentina();
    if (mes !== mesActualArgentina()) await asegurarMesContactados(mes);
    const scope = { ...filtroScope(req, {}), mesOrigen: mes };
    const [operadores, entidades] = await Promise.all([
      esMandoMedio(req) ? ContactadoVentana.distinct("operador", { mesOrigen: mes }) : Promise.resolve([usernameActual(req)]),
      ContactadoVentana.distinct("entidad", scope),
    ]);
    return res.json({
      ok: true,
      operadores: operadores.filter((op) => Boolean(op) && visibleEnTabla(req, op)).sort(),
      entidades: entidades.filter(Boolean).sort(),
      mes,
      canViewAll: esMandoMedio(req),
      sync: syncMeta(),
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "No se pudieron cargar los filtros" });
  }
}

function estiloHeader(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6C3FD1" } };
  row.alignment = { vertical: "middle" };
}

export async function exportarExcel(req, res) {
  try {
    const vista = norm(req.query.vista || "seguimiento");
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "COBRINA";
    workbook.created = new Date();
    const ws = workbook.addWorksheet("Contactados");

    if (vista === "estadisticas") {
      const data = await calcularEstadisticas(req);
      const r = data.resumen || {};
      ws.name = "Resumen";
      ws.columns = [
        { header: "Indicador", key: "indicador", width: 34 },
        { header: "Valor", key: "valor", width: 22 },
      ];
      [
        ["Mes", data.mes],
        ["Contactados generados", r.contactadosGenerados || 0],
        ["Cumplidos 48–72 h", r.cumplidos || 0],
        ["Vencidos sin seguimiento", r.vencidos || 0],
        ["Pendientes 48–72 h", r.pendientes || 0],
        ["Cumplimiento %", r.cumplimientoPct || 0],
        ["Checks validados", r.checksValidados || 0],
        ["Gestiones reales sin check", r.gestionesSinCheck || 0],
        ["Checks sin gestión", r.checksSinGestion || 0],
        ["Renovaciones con nuevo contacto", r.renovacionesConContacto || 0],
        ["Renovaciones con nuevo contacto %", r.renovacionesConContactoPct || 0],
        ["Activos vigentes", r.vigente || 0],
        ["Activos por vencer", r.porVencer || 0],
        ["Activos críticos", r.critico || 0],
      ].forEach(([indicador, valor]) => ws.addRow({ indicador, valor }));
      const ranking = workbook.addWorksheet("Rendimiento operador");
      ranking.columns = [
        { header: "Operador", key: "operador", width: 24 }, { header: "Cumplidos", key: "cumplidos", width: 14 },
        { header: "Vencidos", key: "vencidos", width: 14 }, { header: "Pendientes", key: "pendientes", width: 14 },
        { header: "Total evaluado", key: "total", width: 16 }, { header: "Cumplimiento %", key: "pct", width: 18 },
      ];
      data.rendimiento.forEach((x) => ranking.addRow({ operador: x.operador, cumplidos: x.cumplidos, vencidos: x.vencidos, pendientes: x.pendientes, total: x.totalCerrados, pct: x.cumplimientoPct }));
      estiloHeader(ranking.getRow(1));
      ranking.views = [{ state: "frozen", ySplit: 1 }];
      ranking.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ranking.columnCount } };
      const calidad = workbook.addWorksheet("Calidad renovaciones");
      calidad.columns = [{ header: "Calificación usada", key: "calificacion", width: 38 }, { header: "Cantidad", key: "cantidad", width: 16 }];
      data.calidadRenovacion.forEach((x) => calidad.addRow(x));
      estiloHeader(calidad.getRow(1));
      calidad.views = [{ state: "frozen", ySplit: 1 }];
      calidad.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: calidad.columnCount } };
    } else if (vista === "recuperados") {
      const data = await calcularRecuperados(req);
      if (esMandoMedio(req)) {
        ws.columns = [
          { header: "DNI", key: "dni", width: 16 }, { header: "Cliente", key: "nombre", width: 30 },
          { header: "Operador que lo perdió", key: "operador", width: 22 }, { header: "Entidad", key: "entidad", width: 20 },
          { header: "Venció", key: "vence", width: 20 }, { header: "Resultado posterior", key: "tipo", width: 22 },
          { header: "Cobrado por otros", key: "otros", width: 18 }, { header: "Cobrado por el mismo", key: "mismo", width: 20 },
          { header: "Operadores que cobraron", key: "operadores", width: 30 },
        ];
        data.casos.forEach((c) => ws.addRow({
          dni: dniExcel(c.dni), nombre: c.nombreDeudor, operador: c.operador, entidad: c.entidad,
          vence: fechaExcel(c.venceAt), tipo: c.tipo, otros: Number(c.montoPorOtros || 0),
          mismo: Number(c.montoMismo || 0), operadores: c.operadoresQueCobraron.join(", "),
        }));
        ws.getColumn("dni").numFmt = "0";
        ws.getColumn("vence").numFmt = "dd/mm/yyyy hh:mm";
        ws.getColumn("otros").numFmt = '"$" #,##0';
        ws.getColumn("mismo").numFmt = '"$" #,##0';
      } else {
        const r = data.resumen || {};
        ws.name = "Resumen recuperos";
        ws.columns = [{ header: "Indicador", key: "indicador", width: 36 }, { header: "Valor", key: "valor", width: 22 }];
        [
          ["Mes", data.mes], ["Ventana de recupero (días)", data.dias], ["Casos vencidos", r.vencidos || 0],
          ["Cobrados por otro operador", r.cobradosPorOtro || 0], ["% cobrados por otro", r.pctCobradosPorOtro || 0],
          ["Monto recuperado por otros", r.montoPorOtros || 0], ["Recuperados por el mismo operador", r.cobradosPorMismo || 0],
          ["Monto recuperado por el mismo", r.montoMismo || 0], ["Sin recupero", r.sinRecupero || 0],
        ].forEach(([indicador, valor]) => ws.addRow({ indicador, valor }));
      }
    } else {
      const data = vista === "vencidos-hoy"
        ? await obtenerVencidosData(req, { hoy: true, exportar: true })
        : vista === "historico"
          ? await obtenerVencidosData(req, { hoy: false, exportar: true })
          : await obtenerSeguimientoData(req, { exportar: true });
      ws.columns = [
        { header: "DNI", key: "dni", width: 16 }, { header: "Cliente", key: "nombre", width: 30 },
        { header: "Operador", key: "operador", width: 22 }, { header: "Entidad", key: "entidad", width: 20 },
        { header: "Teléfono", key: "telefono", width: 22 }, { header: "Inicio", key: "inicio", width: 20 },
        { header: "Alerta 48 h hábiles", key: "alerta", width: 22 }, { header: "Vence 72 h hábiles", key: "vence", width: 22 },
        { header: "Semáforo", key: "semaforo", width: 16 }, { header: "Toques del mes", key: "toques", width: 16 },
        { header: "Validación", key: "validacion", width: 24 }, { header: "Calificación", key: "calificacion", width: 28 },
        { header: "Seguimiento posterior", key: "post", width: 24 }, { header: "Fecha gestión posterior", key: "postFecha", width: 22 },
        { header: "Resultado posterior", key: "postResultado", width: 28 },
        { header: "Obs. operador", key: "obsOp", width: 36 }, { header: "Obs. supervisión", key: "obsSup", width: 36 },
      ];
      data.items.forEach((c) => ws.addRow({
        dni: dniExcel(c.dni), nombre: c.nombreDeudor, operador: c.operador, entidad: c.entidad, telefono: c.telefono,
        inicio: fechaExcel(c.iniciaAt), alerta: fechaExcel(c.alertaAt), vence: fechaExcel(c.venceAt),
        semaforo: c.semaforo, toques: Number(c.toquesMes || 0),
        validacion: c.validacion, calificacion: c.calificacionInicio,
        post: c.seguimientoPosterior?.tiene ? "Con gestión posterior" : (vista === "historico" || vista === "vencidos-hoy" ? "Sin gestión posterior" : ""),
        postFecha: fechaExcel(c.seguimientoPosterior?.fecha),
        postResultado: c.seguimientoPosterior?.resultadoGestion || c.seguimientoPosterior?.estadoCuenta || "",
        obsOp: c.observaciones?.operador?.texto || "", obsSup: c.observaciones?.supervision?.texto || "",
      }));
      ws.getColumn("dni").numFmt = "0";
      ["inicio", "alerta", "vence", "postFecha"].forEach((key) => {
        ws.getColumn(key).numFmt = "dd/mm/yyyy hh:mm";
      });
    }

    estiloHeader(ws.getRow(1));
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
    const file = `contactados_${vista}_${claveFechaArgentina().replaceAll("-", "")}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
    await workbook.xlsx.write(res);
    return res.end();
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || "No se pudo generar el Excel" });
  }
}
