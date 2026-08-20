import Proyeccion from "../models/Proyeccion.js";
import ExcelJS from "exceljs";
import { formatearFecha, formatearFechaArgentina } from "../utils/formatearFecha.js";
import Entidad from "../models/Entidad.js";
import SubCesion from "../models/SubCesion.js";
import Empleado from "../models/Empleado.js";
import mongoose from "mongoose";
import { getProyeccionesScope, ROLES } from "../config/roles.js";
import {
  normalizarDni,
  resolverEntidadCanonica,
  variantesTextoEntidad,
} from "../utils/normalizacionNegocio.js";
import { buscarPagosReales } from "../services/vinculacionPagosService.js";
import { PAGOS_FUENTE_UNICA_ACTIVA } from "../config/features.js";
import ReporteGestion from "../models/ReporteGestion.js";
import Pago from "../models/Pago.js";
import PagoInformadoMango from "../models/PagoInformadoMango.js";
import { transformarGestionEnAcuerdo, resolverEpisodiosAcuerdos, vincularPagosPosteriores } from "../services/acuerdosGestionesService.js";
import {
  claveFechaCalendario,
  fechaClaveArgentina,
  finDiaArgentinaUTC,
  finDiaCalendarioUTC,
  inicioDiaArgentinaUTC,
  inicioDiaCalendarioUTC,
  siguienteDiaCalendarioUTC,
  toDateOnly,
} from "../utils/fecha.util.js";

const rolDe = (req) => req.user.role || req.user.rol;
const esGestorGlobal = (req) => [ROLES.SUPERVISOR, ROLES.SUPER_ADMIN].includes(rolDe(req));
const esAmbitoGlobal = (req) => getProyeccionesScope(rolDe(req)) === "all";
const esAmbitoPropio = (req) => getProyeccionesScope(rolDe(req)) === "own";
const tieneAccesoProyecciones = (req) => getProyeccionesScope(rolDe(req)) !== "none";
const esDueno = (req, proyeccion) => String(proyeccion?.empleadoId?._id || proyeccion?.empleadoId) === String(req.user.id);

const validarIdentidadProyeccion = ({ dni, nombreTitular }) => {
  const dniNormalizado = normalizarDni(dni);
  const nombre = String(nombreTitular || "").trim();
  if (!/^\d{6,9}$/.test(dniNormalizado)) {
    return "El DNI debe contener entre 6 y 9 números. Verificá que no hayas ingresado el nombre en el campo DNI.";
  }
  if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(nombre) || /^\s*[\d.\-]+\s*$/.test(nombre)) {
    return "El nombre del titular debe contener letras. Verificá que el DNI no esté cargado en el campo de nombre.";
  }
  return "";
};

const calcularTotalInformado = (proy) =>
  (proy.pagosInformados || [])
    .filter((p) => !p.erroneo)
    .reduce((acc, p) => acc + Number(p.monto || 0), 0);

const parseSelectLabel = (v) => {
  if (v == null) return "";
  const s = String(v).trim();
  const m = s.match(/^\s*(?:[0-9a-f]{24}|\d+)\s*-\s*(.+)$/i);
  return (m ? m[1] : s).trim();
};

const toISODate = (v) => {
  const d = parseExcelDate(v);
  return d ? d.toISOString().slice(0, 10) : v == null ? "" : String(v);
};

const buildLabelMaps = async () => {
  const [ents, subs] = await Promise.all([
    Entidad.find({}, "nombre numero").sort({ numero: 1, nombre: 1 }).lean(),
    SubCesion.find({}, "nombre").sort({ nombre: 1 }).lean(),
  ]);
  const entLabelById = new Map();
  const subLabelById = new Map();
  ents.forEach((e) =>
    entLabelById.set(
      String(e._id),
      Number.isFinite(Number(e.numero)) ? `${e.numero} - ${e.nombre}` : e.nombre
    )
  );
  subs.forEach((s) => subLabelById.set(String(s._id), s.nombre));
  const entLabel = (id, fallbackName) =>
    id
      ? entLabelById.get(String(id)) ||
        (fallbackName ? `- ${fallbackName}` : "")
      : fallbackName || "";
  const subLabel = (id, fallbackName) =>
    id
      ? subLabelById.get(String(id)) ||
        (fallbackName ? `- ${fallbackName}` : "")
      : fallbackName || "";
  return { entLabel, subLabel, entLabelById, subLabelById };
};

const determinarEstadoCierre = (proy) => {
  const importe = Number(proy.importe || 0);
  // importePagado queda reservado al dinero conciliado con el módulo Pagos.
  const pagadoReal = Number(proy.importePagado || 0);

  if (pagadoReal >= importe && importe > 0) return "Cerrada cumplida";
  if (pagadoReal > 0 && pagadoReal < importe) return "Cerrada pago parcial";
  return "Cerrada incumplida";
};

// Campos de fecha calendario (promesa/llamado/ReporteGestion) se consultan
// por su día UTC canónico. Los timestamps reales (creado/modificado) usan
// límites del día de Buenos Aires convertidos a UTC.
const crearFechaLocal = (fechaStr, finDelDia = false) =>
  finDelDia ? finDiaCalendarioUTC(fechaStr) : inicioDiaCalendarioUTC(fechaStr);

const rangoFechaProyeccion = (desde, hasta, tipoFecha = "fechaPromesa") => {
  const campo = ({
    fechaPromesa: "fechaPromesa",
    creado: "creado",
    modificado: "ultimaModificacion",
  }[tipoFecha]) || "fechaPromesa";
  const esTimestamp = campo === "creado" || campo === "ultimaModificacion";
  return {
    campo,
    inicio: esTimestamp ? inicioDiaArgentinaUTC(desde) : inicioDiaCalendarioUTC(desde),
    fin: esTimestamp ? finDiaArgentinaUTC(hasta) : finDiaCalendarioUTC(hasta),
  };
};


const escapeRegexSafe = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const esErrorMongoTransitorio = (error) => {
  const codigo = String(error?.code || error?.cause?.code || "").toUpperCase();
  const nombre = String(error?.name || error?.cause?.name || "").toLowerCase();
  const mensaje = String(error?.message || error?.cause?.message || "").toLowerCase();
  return ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "ECONNREFUSED"].includes(codigo) ||
    nombre.includes("mongonetwork") ||
    nombre.includes("mongoserverselection") ||
    mensaje.includes("read econnreset") ||
    mensaje.includes("connection closed") ||
    mensaje.includes("socket hang up");
};

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lecturaMongoConReintento = async (operacion, etiqueta = "lectura") => {
  let ultimoError;
  for (let intento = 1; intento <= 2; intento += 1) {
    try {
      return await operacion();
    } catch (error) {
      ultimoError = error;
      if (intento >= 2 || !esErrorMongoTransitorio(error)) throw error;
      console.warn(`⚠️ ${etiqueta}: conexión Mongo interrumpida; reintento único en curso.`);
      await esperar(280);
    }
  }
  throw ultimoError;
};

const claveDniEntidad = (dni, entidadNumero) => {
  const dniNormalizado = normalizarDni(dni);
  const numero = Number(entidadNumero || 0);
  return dniNormalizado && Number.isInteger(numero) && numero > 0 ? `${dniNormalizado}|${numero}` : "";
};

const variantesOperador = (empleado = {}, fallbackUsername = "") => {
  const username = String(empleado?.username || fallbackUsername || "").trim().toLowerCase();
  const nombre = String(empleado?.nombre || "").trim().toLowerCase();
  const usernameComoNombre = username.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  const partes = usernameComoNombre.split(" ").filter(Boolean);
  return [...new Set([username, nombre, usernameComoNombre, partes.length > 1 ? [...partes].reverse().join(" ") : "", nombre.split(/\s+/).filter(Boolean).reverse().join(" ")].filter(Boolean))];
};

const queryOperadorMango = async (req, usuarioId = "") => {
  const idObjetivo = usuarioId || (!esAmbitoGlobal(req) ? req.user.id : "");
  if (!idObjetivo || !mongoose.isValidObjectId(idObjetivo)) return null;
  const empleado = await Empleado.findById(idObjetivo).select("username nombre").lean();
  const variantes = variantesOperador(empleado, String(req.user?.username || ""));
  return variantes.length
    ? { usuario: { $in: variantes.map((valor) => new RegExp(`^${escapeRegexSafe(valor)}$`, "i")) } }
    : { usuario: "__sin_coincidencias__" };
};

const variantesOperadorObjetivo = async (req, usuarioId = "") => {
  const idObjetivo = usuarioId || (!esAmbitoGlobal(req) ? req.user.id : "");
  if (!idObjetivo) return null;
  if (!mongoose.isValidObjectId(idObjetivo)) return [];
  const empleado = await Empleado.findById(idObjetivo).select("username nombre").lean();
  return variantesOperador(empleado, String(req.user?.username || ""));
};

const acuerdoPerteneceAOperador = (acuerdo = {}, variantes = null) => {
  if (variantes === null) return true;
  if (!variantes.length) return false;
  const propietario = String(
    acuerdo.operador || acuerdo.usuario || acuerdo.operadorGestion || acuerdo.operadorPago || ""
  ).trim().toLowerCase();
  const propietarioComoNombre = propietario.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  return variantes.includes(propietario) || variantes.includes(propietarioComoNombre);
};

const fechaHoraGestionISO = (fecha, hora = "00:00:00") => {
  if (!fecha) return null;
  const d = new Date(fecha);
  if (Number.isNaN(d.getTime())) return null;
  const isoFecha = d.toISOString().slice(0, 10);
  const horaSegura = /^\d{2}:\d{2}:\d{2}$/.test(String(hora || ""))
    ? String(hora)
    : "00:00:00";
  return `${isoFecha}T${horaSegura}.000Z`;
};

let mapasEntidadesCache = null;
let mapasEntidadesCacheAt = 0;
const MAPAS_ENTIDADES_TTL_MS = 5 * 60 * 1000;

const construirMapasEntidades = async ({ force = false } = {}) => {
  const ahora = Date.now();
  if (!force && mapasEntidadesCache && ahora - mapasEntidadesCacheAt < MAPAS_ENTIDADES_TTL_MS) {
    return mapasEntidadesCache;
  }

  const entidades = await Entidad.find({}, "numero nombre").lean();
  const numeroPorNombre = new Map();
  const nombrePorNumero = new Map();
  for (const entidad of entidades) {
    const numero = Number(entidad?.numero || 0);
    const nombre = String(entidad?.nombre || "").trim();
    if (!numero || !nombre) continue;
    numeroPorNombre.set(nombre.toUpperCase(), numero);
    nombrePorNumero.set(numero, nombre);
  }
  mapasEntidadesCache = { entidades, numeroPorNombre, nombrePorNumero };
  mapasEntidadesCacheAt = ahora;
  return mapasEntidadesCache;
};

const resolverNumeroEntidadGestion = (gestion = {}, numeroPorNombre = new Map()) =>
  Number(
    gestion?.entidadNumero ||
      numeroPorNombre.get(String(gestion?.entidad || "").trim().toUpperCase()) ||
      0
  );

const mapearGestionAacuerdoMango = (gestion = {}, numeroPorNombre = new Map()) => {
  const transformado = transformarGestionEnAcuerdo(gestion);
  if (!transformado) return null;
  const entidadNumero = resolverNumeroEntidadGestion(gestion, numeroPorNombre);
  return {
    _id: gestion?._id || transformado.id,
    id: String(gestion?._id || transformado.id || ""),
    dni: transformado.dni,
    entidad: transformado.entidad,
    entidadNumero,
    nombreDeudor: transformado.nombreDeudor,
    operador: transformado.usuario,
    usuario: transformado.usuario,
    fecha: transformado.fecha,
    fechaHora: fechaHoraGestionISO(gestion?.fecha, gestion?.hora),
    hora: transformado.hora,
    tipoAcuerdo: transformado.tipoAcuerdo,
    resultado: transformado.resultadoGestion,
    estadoCuenta: transformado.estadoCuenta,
    anticipoMonto: transformado.montoAnticipo,
    anticipoVto: transformado.fechaAnticipo || null,
    montoCuota: transformado.montoCuota,
    primerVto: transformado.primerVencimiento || null,
    cuotasCantidad: transformado.cuotas,
    primerPago: transformado.primerPago,
    montoTotalAcuerdo: transformado.montoTotalAcuerdo,
    deudaMin: transformado.deudaMaxima,
    observacionResumen: transformado.observacionGestion,
    telefonoGestion: transformado.telefonoGestion,
    tipoContacto: transformado.tipoContacto,
    observacionGestion: transformado.observacionGestion,
  };
};

const claveVencimientoAcuerdoMango = (acuerdo = {}) => {
  const raw = acuerdo.anticipoVto || acuerdo.primerVto || null;
  const texto = String(raw || "").trim();
  if (!texto) return "";
  const ymd = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  const dmy = texto.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (dmy) return `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  return claveFechaCalendario(raw);
};

const condicionesMangoPorProyecciones = (proyecciones = []) => {
  const condiciones = [];
  const vistas = new Set();
  for (const p of proyecciones) {
    const dni = normalizarDni(p?.dni);
    const numero = Number(p?.entidadNumero || p?.entidadId?.numero || 0);
    const nombre = String(p?.entidadId?.nombre || p?.entidadNombre || "").trim();
    const clave = `${dni}|${numero}|${nombre.toUpperCase()}`;
    if (!dni || (!numero && !nombre) || vistas.has(clave)) continue;
    vistas.add(clave);
    const opcionesEntidad = [];
    if (numero) opcionesEntidad.push({ entidadNumero: numero });
    if (nombre) opcionesEntidad.push({ entidad: new RegExp(`^${escapeRegexSafe(nombre)}$`, "i") });
    const dniNumero = Number(dni);
    const dniVariantes = Number.isSafeInteger(dniNumero) ? [dni, dniNumero] : [dni];
    condiciones.push({ dni: { $in: dniVariantes }, $or: opcionesEntidad });
  }
  return condiciones;
};

/**
 * Los acuerdos confirmados de Mango se obtienen del mismo Reporte de Gestiones
 * que alimenta "Gestiones con acuerdo". No usa la colección histórica de
 * acuerdos importados, porque esa no siempre está cargada.
 */
const buscarAcuerdosMangoDeProyecciones = async (proyecciones = []) => {
  const condiciones = condicionesMangoPorProyecciones(proyecciones);
  if (!condiciones.length) return new Map();

  const { numeroPorNombre } = await construirMapasEntidades();
  const gestiones = await ReporteGestion.find({
    borrado: { $ne: true },
    resultadoGestion: /acuerdo/i,
    $or: condiciones,
  })
    .sort({ fecha: -1, hora: -1, _id: -1 })
    .select(
      "dni nombreDeudor fecha hora usuario tipoContacto resultadoGestion estadoCuenta telMailMarcado observacionGestion entidad entidadNumero"
    )
    .maxTimeMS(30000)
    .lean();

  const mapa = new Map();
  for (const gestion of gestiones) {
    const acuerdo = mapearGestionAacuerdoMango(gestion, numeroPorNombre);
    if (!acuerdo) continue;
    const clave = claveDniEntidad(acuerdo.dni, acuerdo.entidadNumero);
    if (!clave) continue;
    const lista = mapa.get(clave) || [];
    lista.push(acuerdo);
    mapa.set(clave, lista);
  }
  return mapa;
};

const enriquecerProyeccionesConFuentes = async (docs = []) => {
  if (!docs.length) return docs;

  const condicionesGestiones = condicionesMangoPorProyecciones(docs);
  const condicionesPagos = [];
  const clavesPagos = new Set();
  for (const p of docs) {
    const dni = normalizarDni(p?.dni);
    const numero = Number(p?.entidadNumero || p?.entidadId?.numero || 0);
    const subId = String(p?.subCesionId?._id || p?.subCesionId || "");
    if (!dni || !numero || !mongoose.isValidObjectId(subId)) continue;
    const clave = `${dni}|${numero}|${subId}`;
    if (clavesPagos.has(clave)) continue;
    clavesPagos.add(clave);
    condicionesPagos.push({
      dni,
      entidadId: numero,
      subCesionId: new mongoose.Types.ObjectId(subId),
    });
  }

  const [gestiones, pagos, mapasEntidad] = await Promise.all([
    condicionesGestiones.length
      ? ReporteGestion.find({ borrado: { $ne: true }, $or: condicionesGestiones })
          .sort({ fecha: -1, hora: -1, _id: -1 })
          .select(
            "dni fecha hora usuario resultadoGestion estadoCuenta tipoContacto observacionGestion entidad entidadNumero"
          )
          .maxTimeMS(30000)
          .lean()
      : [],
    condicionesPagos.length
      ? Pago.find({ $or: condicionesPagos })
          .sort({ fechaPago: 1, idPago: 1, _id: 1 })
          .select(
            "idPago dni entidadId subCesionId fechaPago monto conceptoCodigo estado operadorUsername"
          )
          .maxTimeMS(30000)
          .lean()
      : [],
    construirMapasEntidades(),
  ]);

  const ultimaGestionPorCaso = new Map();
  for (const gestion of gestiones) {
    const numero = resolverNumeroEntidadGestion(gestion, mapasEntidad.numeroPorNombre);
    const clave = claveDniEntidad(gestion?.dni, numero);
    if (!clave || ultimaGestionPorCaso.has(clave)) continue;
    ultimaGestionPorCaso.set(clave, {
      fecha: gestion.fecha,
      hora: gestion.hora || "",
      usuario: gestion.usuario || "",
      resultado: gestion.resultadoGestion || "",
      estadoCuenta: gestion.estadoCuenta || "",
      tipoContacto: gestion.tipoContacto || "",
      observacion: gestion.observacionGestion || "",
    });
  }

  const pagosPorClave = new Map();
  for (const pago of pagos) {
    const clave = `${normalizarDni(pago?.dni)}|${Number(pago?.entidadId || 0)}|${String(
      pago?.subCesionId || ""
    )}`;
    const lista = pagosPorClave.get(clave) || [];
    lista.push(pago);
    pagosPorClave.set(clave, lista);
  }

  return docs.map((p) => {
    const entidadNumero = Number(p?.entidadNumero || p?.entidadId?.numero || 0);
    const claveCaso = claveDniEntidad(p?.dni, entidadNumero);
    const subId = String(p?.subCesionId?._id || p?.subCesionId || "");
    const clavePago = `${normalizarDni(p?.dni)}|${entidadNumero}|${subId}`;
    const pagosCaso = pagosPorClave.get(clavePago) || [];
    const fechaSoloISO = (raw) => claveFechaCalendario(raw);
    const corteISO = fechaSoloISO(
      p?.creado || p?.createdAt || p?.fechaPromesaInicial || p?.fechaPromesa
    );

    let totalAplicable = 0;
    let totalMismoDia = 0;
    let totalAnterior = 0;
    let cantidadAplicables = 0;
    let ultimoPagoAplicable = null;
    const pagosValidos = [];
    for (const pago of pagosCaso) {
      const fechaPagoISO = fechaSoloISO(pago?.fechaPago);
      if (!fechaPagoISO) continue;
      const monto = Number(pago?.monto || 0);
      if (!corteISO || fechaPagoISO > corteISO) {
        totalAplicable += monto;
        cantidadAplicables += 1;
        ultimoPagoAplicable = pago;
        pagosValidos.push(pago);
      } else if (fechaPagoISO === corteISO) {
        totalMismoDia += monto;
        pagosValidos.push(pago);
      } else {
        totalAnterior += monto;
      }
    }

    return {
      ...p,
      ultimaGestionMango: ultimaGestionPorCaso.get(claveCaso) || null,
      pagosRealesResumen: {
        estadoVinculacion: pagosCaso.length ? "coincidencia-exacta" : "sin-pagos",
        cantidadEncontrados: pagosCaso.length,
        cantidadAplicables,
        totalAplicable,
        totalMismoDia,
        totalValido: totalAplicable + totalMismoDia,
        totalAnterior,
        operadorPago: ultimoPagoAplicable?.operadorUsername || pagosValidos.at(-1)?.operadorUsername || "",
        pagosValidos: pagosValidos.map((pago) => ({
          idPago: pago.idPago,
          fechaPago: pago.fechaPago,
          monto: pago.monto,
          operadorUsername: pago.operadorUsername,
        })),
        ultimoPagoAplicable: ultimoPagoAplicable
          ? {
              idPago: ultimoPagoAplicable.idPago,
              fechaPago: ultimoPagoAplicable.fechaPago,
              monto: ultimoPagoAplicable.monto,
              operadorUsername: ultimoPagoAplicable.operadorUsername,
            }
          : null,
      },
    };
  });
};

const construirQueryProyeccionesAdmin = (source = {}, { ids = [] } = {}) => {
  const filtros = [];
  const {
    estado,
    concepto,
    entidadId,
    subCesionId,
    tipoFecha = "fechaPromesa",
    fechaDesde,
    fechaHasta,
    desde,
    hasta,
    buscar,
    usuarioId,
    mes,
    anio,
    promesaHoy,
    llamadoHoy,
    sinGestion,
  } = source || {};

  const normalizedIds = (Array.isArray(ids) ? ids : String(ids || "").split(","))
    .map((value) => String(value || "").trim())
    .filter((value) => mongoose.isValidObjectId(value));
  if (normalizedIds.length) filtros.push({ _id: { $in: normalizedIds } });
  if (usuarioId && mongoose.isValidObjectId(usuarioId)) filtros.push({ empleadoId: usuarioId });
  if (estado) filtros.push({ estado });
  if (concepto) filtros.push({ concepto });
  if (entidadId && mongoose.isValidObjectId(entidadId)) filtros.push({ entidadId });
  if (subCesionId && mongoose.isValidObjectId(subCesionId)) filtros.push({ subCesionId });
  if (mes) filtros.push({ mes: Number(mes) });
  if (anio) filtros.push({ anio: Number(anio) });

  if (sinGestion === true || sinGestion === "true") {
    filtros.push({ $or: [{ vecesTocada: { $exists: false } }, { vecesTocada: null }, { vecesTocada: { $lte: 0 } }] });
  }
  const hoyClave = fechaClaveArgentina();
  const hoy = inicioDiaCalendarioUTC(hoyClave);
  const manana = siguienteDiaCalendarioUTC(hoyClave);
  if (promesaHoy === true || promesaHoy === "true") filtros.push({ fechaPromesa: { $gte: hoy, $lt: manana } });
  if (llamadoHoy === true || llamadoHoy === "true") filtros.push({ fechaProximoLlamado: { $gte: hoy, $lt: manana } });

  const start = fechaDesde || desde;
  const end = fechaHasta || hasta;
  if (start && end && !Number.isNaN(Date.parse(start)) && !Number.isNaN(Date.parse(end))) {
    const { campo, inicio, fin } = rangoFechaProyeccion(start, end, tipoFecha);
    filtros.push({ [campo]: { $gte: inicio, $lte: fin } });
  }
  if (buscar) {
    const value = String(buscar).trim();
    const regex = new RegExp(escapeRegexSafe(value), "i");
    const possibleDni = Number.parseInt(value, 10);
    const conditions = [{ nombreTitular: regex }, { concepto: regex }, { estado: regex }];
    if (!Number.isNaN(possibleDni)) conditions.push({ dni: possibleDni });
    filtros.push({ $or: conditions });
  }
  return filtros.length ? { $and: filtros } : {};
};

function parseExcelDate(v) {
  if (v === undefined || v === null || v === "") return null;

  if (v instanceof Date && !Number.isNaN(v.getTime())) return toDateOnly(v);

  if (typeof v === "number" && Number.isFinite(v)) {
    // Mantiene la convención histórica de Excel (epoch 1899-12-30),
    // pero anclada al mediodía UTC para que el día no dependa del servidor.
    const epoch = Date.UTC(1899, 11, 30);
    const d = new Date(epoch + Math.round(v * 86400000));
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0));
  }

  if (typeof v === "string") {
    const s = v.trim();
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
      const dd = Number(m[1]);
      const mm = Number(m[2]);
      let yy = Number(m[3]);
      if (yy < 100) yy += 2000;
      return toDateOnly(`${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`);
    }
    const normalizada = toDateOnly(s);
    if (normalizada) return normalizada;
  }
  return null;
}

function clasificarEstado(fechaPromesa) {
  const clave = claveFechaCalendario(fechaPromesa);
  if (!clave) return "Pendiente";
  return clave >= fechaClaveArgentina() ? "Promesa activa" : "Promesa caída";
}

const estaCerrada = (p) =>
  p?.isActiva === false || /^Cerrada/.test(p?.estado || "");

/* === fin helpers globales === */

export const evaluarEstadoPago = (proy) => {
  const importe = parseFloat(proy.importe || 0);
  const pagado = parseFloat(proy.importePagado || 0);

  if (pagado >= importe) return "Pagado";
  if (pagado > 0 && pagado < importe) return "Pagado parcial";
  return proy.estado; // No cambiar si no aplica
};

export const actualizarEstadoAutomaticamente = async (proy) => {
  // 🚫 No recalcular si ya está cerrada o marcada inactiva
  if (proy.isActiva === false || /^Cerrada/.test(proy.estado)) {
    return proy; // nada que hacer
  }

  const hoyClave = fechaClaveArgentina();

  const importe = parseFloat(proy.importe || 0);
  const pagado = parseFloat(proy.importePagado || 0);
  const fechaPromesaClave = claveFechaCalendario(proy.fechaPromesa);

  let nuevoEstado = proy.estado;

  if (pagado >= importe) {
    nuevoEstado = "Pagado";
  } else if (pagado > 0 && pagado < importe) {
    nuevoEstado = "Pagado parcial";
  } else if (pagado === 0 && fechaPromesaClave) {
    if (fechaPromesaClave < hoyClave) nuevoEstado = "Promesa caída";
    else if (fechaPromesaClave === hoyClave) nuevoEstado = "Pendiente";
    else nuevoEstado = "Promesa activa";
  }

  if (proy.estado !== nuevoEstado) {
    proy.estado = nuevoEstado;
    proy.ultimaModificacion = new Date();
    await proy.save();
  }

  return proy;
};

export const crearProyeccion = async (req, res) => {
  try {
    if (!tieneAccesoProyecciones(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const {
      dni,
      nombreTitular,
      importe,
      estado,
      fechaPromesa,
      fechaProximoLlamado,
      concepto,
      entidadId,
      subCesionId,
      importePagado: _importePagadoIgnorado,
      pagosInformados: _pagosInformadosIgnorados,
      entidadNumero: _entidadNumeroIgnorado,
      origen: _origenIgnorado,
      acuerdoMangoReferenciadoId: _acuerdoIgnorado,
      ...otrosCampos
    } = req.body;

    // ✅ Validación con mensajes claros
    const oblig = {
      dni,
      nombreTitular,
      importe,
      estado,
      concepto,
      fechaPromesa,
      fechaProximoLlamado,
      entidadId,
      subCesionId,
    };
    const faltan = Object.entries(oblig)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (faltan.length) {
      return res
        .status(400)
        .json({ error: `Faltan completar: ${faltan.join(", ")}` });
    }

    const errorIdentidad = validarIdentidadProyeccion({ dni, nombreTitular });
    if (errorIdentidad) return res.status(400).json({ error: errorIdentidad });

    // ✅ Fechas calendario: se normalizan una sola vez y se guardan al mediodía UTC.
    const fechaPromesaDate = parseExcelDate(fechaPromesa);
    const fechaProximoLlamadoDate = parseExcelDate(fechaProximoLlamado);
    if (!fechaPromesaDate) {
      return res.status(400).json({ error: "Fecha de promesa inválida" });
    }
    if (!fechaProximoLlamadoDate) {
      return res.status(400).json({ error: "Fecha próximo llamado inválida" });
    }

    // ✅ Importe
    const importeNumerico = Number(importe);
    if (!Number.isFinite(importeNumerico) || importeNumerico <= 0) {
      return res.status(400).json({ error: "Importe inválido" });
    }

    // ✅ ENTIDAD & SUBCESIÓN deben existir
    if (!mongoose.Types.ObjectId.isValid(entidadId)) {
      return res.status(400).json({ error: "entidadId inválido" });
    }
    if (!mongoose.Types.ObjectId.isValid(subCesionId)) {
      return res.status(400).json({ error: "subCesionId inválido" });
    }

    const entidadCanonica = await resolverEntidadCanonica({ entidadId });
    const entidad = entidadCanonica?.entidad;
    if (!entidad)
      return res.status(400).json({ error: "Entidad no encontrada" });

    const subCesion = await SubCesion.findById(subCesionId);
    if (!subCesion)
      return res.status(400).json({ error: "SubCesión no encontrada" });

    // ── Regla 1-activa: cerrar activa previa para (dni, entidadId, subCesionId)
    let infoCierreAnterior = null;
    const activaPrevia = await Proyeccion.findOne({
      dni,
      entidadId,
      entidadNumero: entidadCanonica.entidadNumero,
      subCesionId,
      $or: [{ isActiva: true }, { isActiva: { $exists: false } }],
    });

    if (activaPrevia) {
      const nuevoEstado = determinarEstadoCierre(activaPrevia);
      activaPrevia.isActiva = false;
      activaPrevia.estado = nuevoEstado;
      activaPrevia.ultimaModificacion = new Date();
      await activaPrevia.save();

      infoCierreAnterior = {
        proyeccionId: String(activaPrevia._id),
        estadoCierre: nuevoEstado,
        mensaje: `La promesa anterior se cerró automáticamente como: ${nuevoEstado}.`,
      };
    }

    // Datos derivados de la fecha calendario canónica.
    const anio = fechaPromesaDate.getUTCFullYear();
    const mes = fechaPromesaDate.getUTCMonth() + 1;

    // 🔑 ID lógico normalizado
    const idProyeccionLogico = `${dni}-${entidadId}-${subCesionId}`;

    // ✅ Crear proyección nueva (activa)
    let nueva = new Proyeccion({
      dni,
      nombreTitular,
      importe: importeNumerico,
      estado,
      concepto,

      // 🔵 Campos normalizados
      entidadId,
      entidadNumero: entidadCanonica.entidadNumero,
      subCesionId,
      idProyeccionLogico,

      fechaPromesa: fechaPromesaDate,
      fechaProximoLlamado: fechaProximoLlamadoDate,
      fechaPromesaInicial: fechaPromesaDate,
      anio,
      mes,
      ...otrosCampos,
      importePagado: 0,
      pagosInformados: [],

      empleadoId: req.user.id,
      creado: new Date(),
      ultimaModificacion: new Date(),
      isActiva: true,
      origen: "control-personal",
    });

    // Ajuste de estado “en caliente”
    nueva = await actualizarEstadoAutomaticamente(nueva);
    await nueva.save();

    res.json({
      ...nueva.toObject(),
      infoCierreAnterior, // null si no había activa previa
    });
  } catch (error) {
    // Índice único esperado: (dni, entidadId, subCesionId, isActiva:true)
    if (error?.code === 11000) {
      return res.status(409).json({
        error:
          "Ya existe una promesa activa para este DNI + ENTIDAD + SUBCESIÓN.",
      });
    }
    console.error("❌ Error al crear proyección:", error);
    res.status(500).json({ error: "Error al crear proyección" });
  }
};

// 2. Obtener proyecciones propias
// 2. Obtener proyecciones propias
export const obtenerProyeccionesPropias = async (req, res) => {
  try {
    if (!tieneAccesoProyecciones(req)) return res.status(403).json({ error: "Sin acceso" });

    const campos =
      "empleadoId dni nombreTitular importe importePagado estado concepto " +
      "entidadId entidadNumero subCesionId fechaPromesa fechaProximoLlamado creado ultimaModificacion " +
      "vecesTocada ultimaGestion observaciones origen acuerdoMangoReferenciadoId advertenciaMangoConfirmada isActiva pagosInformados";

    const docs = await Proyeccion.find({ empleadoId: req.user.id })
      .select(campos)
      .populate("empleadoId", "username")
      .populate("entidadId", "nombre numero")
      .populate("subCesionId", "nombre")
      .sort({ creado: -1 })
      .lean();

    const resultados = docs.map((p) => {
      // Si está Pagado / Pagado parcial / Cerrada*, mostramos ese estado tal cual.
      // Si no, calculamos una vista por fecha (opcional) sin tocar `estado`.
      const esEstadoFijo =
        /^Pagado(?: parcial)?$/i.test(p.estado || "") || /^Cerrada/i.test(p.estado || "");
      const estadoVista = esEstadoFijo
        ? p.estado
        : (typeof clasificarEstado === "function" && p.fechaPromesa
            ? clasificarEstado(new Date(p.fechaPromesa))
            : p.estado);

      return {
        ...p, // ← incluye `estado` tal como está guardado en BD
        empleadoUsername: p?.empleadoId?.username || "-",
        entidadNombre: p?.entidadId?.nombre || "-",
        subCesionNombre: p?.subCesionId?.nombre || "-",
        estadoVista, // ← opcional para UI
      };
    });

    return res.json(resultados);
  } catch (error) {
    console.error("❌ Error al obtener proyecciones propias:", error);
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

    // 🔒 no permitir editar cuentas cerradas
    const cerrada =
      proyeccion.isActiva === false ||
      /^Cerrada/.test(String(proyeccion.estado || ""));
    if (cerrada) {
      return res
        .status(409)
        .json({ error: "La proyección está cerrada y no puede editarse." });
    }

    if (!tieneAccesoProyecciones(req)) {
      return res.status(403).json({ error: "Sin acceso" });
    }
    if (esAmbitoPropio(req) && !esDueno(req, proyeccion)) {
      return res.status(403).json({ error: "No autorizado para editar" });
    }

    const {
      dni,
      nombreTitular,
      importe,
      concepto,
      entidadId,
      subCesionId,
      fechaPromesa,
      fechaProximoLlamado,
      empleadoId: _empleadoIdIgnorado,
      importePagado: _importePagadoIgnorado,
      pagosInformados: _pagosInformadosIgnorados,
      entidadNumero: _entidadNumeroIgnorado,
      origen: _origenIgnorado,
      acuerdoMangoReferenciadoId: _acuerdoIgnorado,
      advertenciaMangoConfirmada: _advertenciaIgnorada,
      ...resto
    } = req.body;

    // ✅ obligatorios ya migrados
    const camposObligatorios = {
      dni,
      nombreTitular,
      importe,
      concepto,
      entidadId,
      subCesionId,
    };
    const faltan = Object.entries(camposObligatorios)
      .filter(([, v]) => !v && v !== 0)
      .map(([k]) => k);
    if (faltan.length) {
      return res
        .status(400)
        .json({ error: `Faltan completar: ${faltan.join(", ")}` });
    }

    const errorIdentidadEdicion = validarIdentidadProyeccion({ dni, nombreTitular });
    if (errorIdentidadEdicion) return res.status(400).json({ error: errorIdentidadEdicion });

    // ✅ fechas calendario (si vienen)
    const fechaPromesaDate = fechaPromesa ? parseExcelDate(fechaPromesa) : null;
    const fechaProximoLlamadoDate = fechaProximoLlamado ? parseExcelDate(fechaProximoLlamado) : null;
    if (fechaPromesa && !fechaPromesaDate) {
      return res.status(400).json({ error: "Fecha de promesa inválida" });
    }
    if (fechaProximoLlamado && !fechaProximoLlamadoDate) {
      return res.status(400).json({ error: "Fecha próximo llamado inválida" });
    }

    // ✅ importe
    const importeNumerico = Number(importe);
    if (!Number.isFinite(importeNumerico)) {
      return res.status(400).json({ error: "Importe inválido" });
    }

    // ✅ ids válidos + existencia
    if (!mongoose.Types.ObjectId.isValid(entidadId)) {
      return res.status(400).json({ error: "entidadId inválido" });
    }
    if (!mongoose.Types.ObjectId.isValid(subCesionId)) {
      return res.status(400).json({ error: "subCesionId inválido" });
    }
    const [entidadCanonica, subCesion] = await Promise.all([
      resolverEntidadCanonica({ entidadId }),
      SubCesion.findById(subCesionId),
    ]);
    const entidad = entidadCanonica?.entidad;
    if (!entidad)
      return res.status(400).json({ error: "Entidad no encontrada" });
    if (!subCesion)
      return res.status(400).json({ error: "SubCesión no encontrada" });

    // 🔎 si cambia la clave lógica (dni/entidad/subCesión), evitar duplicar activas
    const cambiaClave =
      String(proyeccion.dni) !== String(dni) ||
      String(proyeccion.entidadId) !== String(entidadId) ||
      String(proyeccion.subCesionId) !== String(subCesionId);

    if (cambiaClave) {
      const yaActiva = await Proyeccion.findOne({
        _id: { $ne: proyeccion._id },
        dni,
        entidadId,
        subCesionId,
        $or: [{ isActiva: true }, { isActiva: { $exists: false } }],
      }).lean();

      if (yaActiva) {
        return res.status(409).json({
          error:
            "Ya existe una promesa activa para este DNI + ENTIDAD + SUBCESIÓN. Cierra la otra o elige otra combinación.",
        });
      }
    }

    const updateData = {
      dni,
      nombreTitular,
      importe: importeNumerico,
      concepto,
      entidadId,
      entidadNumero: entidadCanonica.entidadNumero,
      subCesionId,
      fechaPromesa: fechaPromesaDate || proyeccion.fechaPromesa,
      fechaProximoLlamado: fechaProximoLlamadoDate || proyeccion.fechaProximoLlamado,
      ultimaModificacion: new Date(),
      ...resto,
    };

    // 🔑 id lógico coherente si cambió algo de la clave
    updateData.idProyeccionLogico = `${dni}-${entidadId}-${subCesionId}`;

    if (fechaPromesaDate) {
      updateData.mes = fechaPromesaDate.getUTCMonth() + 1;
      updateData.anio = fechaPromesaDate.getUTCFullYear();
    }

    let actualizada = await Proyeccion.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    actualizada = await actualizarEstadoAutomaticamente(actualizada);

    res.json(actualizada);
  } catch (error) {
    // choque con índice único parcial (dni, entidadId, subCesionId, isActiva:true)
    if (error?.code === 11000) {
      return res.status(409).json({
        error:
          "Conflicto: existe una promesa activa con el mismo DNI + ENTIDAD + SUBCESIÓN.",
      });
    }
    console.error("❌ Error al actualizar proyección:", error);
    res.status(500).json({ error: "Error al actualizar proyección" });
  }
};

// 4. Eliminar
export const eliminarProyeccion = async (req, res) => {
  try {
    // ✅ micro: validar id antes de ir a DB
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const proyeccion = await Proyeccion.findById(req.params.id);
    if (!proyeccion) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    if (!tieneAccesoProyecciones(req)) return res.status(403).json({ error: "Sin acceso" });
    if (!esDueno(req, proyeccion) && !esAmbitoGlobal(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    // 🔒 las cuentas cerradas NO se pueden eliminar
    const cerrada =
      proyeccion.isActiva === false ||
      /^Cerrada/.test(String(proyeccion.estado || ""));
    if (cerrada) {
      return res
        .status(409)
        .json({ error: "La proyección está cerrada y no puede eliminarse." });
    }

    // guardo id lógico para reportarlo en la respuesta
    const idProyeccionLogico = proyeccion.idProyeccionLogico;

    await proyeccion.deleteOne();

    // ✅ micro: devuelvo también el id lógico (nuevo esquema)
    res.json({ mensaje: "Proyección eliminada", idProyeccionLogico });
  } catch (error) {
    console.error("Error al eliminar proyección:", error);
    res.status(500).json({ error: "Error al eliminar proyección" });
  }
};

// 4.bis) Registrar gestión (solo dueño puede sumar)
export const registrarGestion = async (req, res) => {
  try {
    const { id } = req.params; // proyeccionId
    const proy = await Proyeccion.findById(id);

    if (!proy) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    // 🔒 Bloqueo: no permitir registrar gestión en cuentas cerradas
    const cerrada =
      proy.isActiva === false || /^Cerrada/.test(String(proy.estado || ""));
    if (cerrada) {
      return res.status(409).json({
        error: "La proyección está cerrada: no se pueden registrar gestiones.",
      });
    }

    if (esAmbitoPropio(req) && !esDueno(req, proy)) {
      return res
        .status(403)
        .json({ error: "Solo el dueño puede registrar esta gestión" });
    }

    // Los perfiles globales supervisan, pero no registran gestión como operador.
    if (esAmbitoGlobal(req)) {
      return res.status(403).json({
        error: "Los administradores no pueden registrar gestiones aquí",
      });
    }

    // Incremento seguro
    proy.vecesTocada = Number(proy.vecesTocada || 0) + 1;
    proy.ultimaGestion = new Date();
    proy.ultimaModificacion = new Date();

    await proy.save();

    return res.json({
      ok: true,
      vecesTocada: proy.vecesTocada,
      ultimaGestion: proy.ultimaGestion,
    });
  } catch (error) {
    console.error("❌ Error al registrar gestión:", error);
    return res.status(500).json({ error: "Error al registrar gestión" });
  }
};

// 5. Obtener por operador
export const obtenerProyeccionesPorOperadorId = async (req, res) => {
  try {
    if (!esAmbitoGlobal(req)) return res.status(403).json({ error: "No autorizado" });
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
      limit = 20,
      estado,
      concepto,
      entidadId,
      subCesionId,
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
      sinGestion, // opcional
    } = req.query;

    const filtros = [];
    if (!tieneAccesoProyecciones(req)) {
      return res.status(403).json({ error: "Sin acceso" });
    }
    if (esAmbitoGlobal(req)) {
      if (usuarioId) filtros.push({ empleadoId: usuarioId });
    } else {
      filtros.push({ empleadoId: req.user.id });
    }

    // Filtros simples
    if (estado) filtros.push({ estado });
    if (concepto) filtros.push({ concepto });
    if (entidadId) filtros.push({ entidadId });
    if (subCesionId) filtros.push({ subCesionId });
    if (mes) filtros.push({ mes: parseInt(mes) });
    if (anio) filtros.push({ anio: parseInt(anio) });

    // Sin gestión
    if (sinGestion === "true") {
      filtros.push({
        $or: [
          { vecesTocada: { $exists: false } },
          { vecesTocada: null },
          { vecesTocada: { $lte: 0 } },
        ],
      });
    }

    // Hoy (promesas y llamados)
    const hoyClave = fechaClaveArgentina();
    const hoy = inicioDiaCalendarioUTC(hoyClave);
    const mañana = siguienteDiaCalendarioUTC(hoyClave);
    if (promesaHoy === "true") filtros.push({ fechaPromesa: { $gte: hoy, $lt: mañana } });
    if (llamadoHoy === "true") filtros.push({ fechaProximoLlamado: { $gte: hoy, $lt: mañana } });

    // Rango por tipoFecha
    if (fechaDesde && fechaHasta && !isNaN(Date.parse(fechaDesde)) && !isNaN(Date.parse(fechaHasta))) {
      const { campo: campoFecha, inicio, fin } = rangoFechaProyeccion(fechaDesde, fechaHasta, tipoFecha);
      filtros.push({ [campoFecha]: { $gte: inicio, $lte: fin } });
    }

    // Búsqueda libre
    if (buscar) {
      const regex = new RegExp(escapeRegexSafe(buscar), "i");
      const posibleDni = parseInt(buscar, 10);
      const condiciones = [{ nombreTitular: regex }, { concepto: regex }, { estado: regex }];
      if (!isNaN(posibleDni)) condiciones.push({ dni: posibleDni });
      filtros.push({ $or: condiciones });
    }

    // Query final
    const query = filtros.length ? { $and: filtros } : {};

    // Paginación y orden
    const pageNum = parseInt(page);
    const pageSize = parseInt(limit);
    const skip = (pageNum - 1) * pageSize;
    const sortObj = {};
    if (ordenPor) sortObj[ordenPor] = orden === "asc" ? 1 : -1;

    const campos =
      "empleadoId dni nombreTitular importe importePagado estado concepto " +
      "entidadId entidadNumero subCesionId fechaPromesa fechaProximoLlamado creado ultimaModificacion " +
      "vecesTocada ultimaGestion observaciones origen acuerdoMangoReferenciadoId advertenciaMangoConfirmada isActiva pagosInformados";

    const { docs, acuerdosPorCaso, total } = await lecturaMongoConReintento(
      async () => {
        const [docsBase, totalDocumentos] = await Promise.all([
          Proyeccion.find(query)
            .select(campos)
            .populate("empleadoId", "username nombre")
            .populate("entidadId", "nombre numero")
            .populate("subCesionId", "nombre")
            .sort(sortObj)
            .skip(skip)
            .limit(pageSize)
            .maxTimeMS(30000)
            .lean(),
          Proyeccion.countDocuments(query).maxTimeMS(30000),
        ]);
        const docsEnriquecidos = await enriquecerProyeccionesConFuentes(docsBase);
        const acuerdos = await buscarAcuerdosMangoDeProyecciones(docsEnriquecidos);
        return {
          docs: docsEnriquecidos,
          acuerdosPorCaso: acuerdos,
          total: totalDocumentos,
        };
      },
      "/proyecciones/filtrar"
    );
    const resultados = docs.map((p) => {
      const pagosInformadosActivos = (Array.isArray(p?.pagosInformados) ? p.pagosInformados : [])
        .filter((pago) => !pago?.erroneo);
      const totalPagosInformados = pagosInformadosActivos.reduce(
        (acumulado, pago) => acumulado + Number(pago?.monto || 0),
        0
      );
      const ultimoPagoInformado = pagosInformadosActivos
        .slice()
        .sort((a, b) => new Date(b?.fecha || 0) - new Date(a?.fecha || 0))[0] || null;

      const esEstadoFijo =
        /^Pagado(?: parcial)?$/i.test(p.estado || "") || /^Cerrada/i.test(p.estado || "");
      const estadoVista = esEstadoFijo
        ? p.estado
        : (typeof clasificarEstado === "function" && p.fechaPromesa
            ? clasificarEstado(new Date(p.fechaPromesa))
            : p.estado);
      const entidadNumero = Number(p?.entidadNumero || p?.entidadId?.numero || 0);
      const acuerdosMango = acuerdosPorCaso.get(claveDniEntidad(p.dni, entidadNumero)) || [];
      const acuerdoMango = acuerdosMango[0] || null;

      return {
        ...p,
        // La tabla solo necesita un resumen visual; el detalle completo se consulta en su endpoint.
        pagosInformados: undefined,
        pagosInformadosResumen: {
          cantidad: pagosInformadosActivos.length,
          total: totalPagosInformados,
          ultimoPago: ultimoPagoInformado
            ? {
                fecha: ultimoPagoInformado.fecha || null,
                monto: Number(ultimoPagoInformado.monto || 0),
              }
            : null,
        },
        empleadoUsernameOriginal: p?.empleadoId?.username || "-",
        empleadoUsername: p?.empleadoId?.username || "-",
        operadorPagoUsername: p?.pagosRealesResumen?.operadorPago || "",
        propietarioSegunPago: false,
        entidadNombre: p?.entidadId?.nombre || "-",
        entidadNumero,
        subCesionNombre: p?.subCesionId?.nombre || "-",
        estadoVista,
        tieneAcuerdoMango: acuerdosMango.length > 0,
        cantidadAcuerdosMango: acuerdosMango.length,
        acuerdoMangoResumen: acuerdoMango ? {
          _id: acuerdoMango._id,
          fecha: acuerdoMango.fecha || acuerdoMango.fechaHora,
          tipo: acuerdoMango.tipoAcuerdo || acuerdoMango.resultado || "Acuerdo",
          operador: acuerdoMango.operador || "",
          estado: acuerdoMango.estadoCuenta || "Confirmado",
        } : null,
      };
    });

    return res.json({ total, resultados });
  } catch (error) {
    console.error("❌ Error en /proyecciones/filtrar:", error);
    res.status(500).json({
      error: esErrorMongoTransitorio(error)
        ? "La conexión con la base de datos se interrumpió. Reintentá en unos segundos."
        : "Error al filtrar proyecciones",
      codigo: esErrorMongoTransitorio(error) ? "DB_CONNECTION_RESET" : "PROYECCIONES_FILTER_ERROR",
    });
  }
};


// 7. Estadísticas propias

/**
 * Cierra un control personal cuando el mismo DNI + entidad ya está confirmado
 * en el módulo de Acuerdos Mango. No elimina el registro: conserva el historial
 * y evita que vuelva a computarse como un acuerdo personal activo.
 */
export const cerrarProyeccionPorAcuerdoMango = async (req, res) => {
  try {
    if (!tieneAccesoProyecciones(req)) {
      return res.status(403).json({ error: "Sin acceso a Proyecciones" });
    }

    const proyeccion = await Proyeccion.findById(req.params.id)
      .populate("entidadId", "nombre numero")
      .populate("empleadoId", "username nombre");

    if (!proyeccion) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }
    if (esAmbitoPropio(req) && !esDueno(req, proyeccion)) {
      return res.status(403).json({ error: "No tenés permiso sobre esta proyección" });
    }

    const acuerdosPorCaso = await buscarAcuerdosMangoDeProyecciones([proyeccion.toObject()]);
    const entidadNumero = Number(
      proyeccion.entidadNumero || proyeccion.entidadId?.numero || 0
    );
    const acuerdos =
      acuerdosPorCaso.get(claveDniEntidad(proyeccion.dni, entidadNumero)) || [];
    const acuerdo = acuerdos[0];

    if (!acuerdo) {
      return res.status(409).json({
        error:
          "No se encontró un acuerdo de Mango para el mismo DNI y entidad. Actualizá la tabla y volvé a intentar.",
      });
    }

    proyeccion.isActiva = false;
    proyeccion.estado = "Cerrada por acuerdo Mango";
    proyeccion.origen = "control-personal";
    proyeccion.advertenciaMangoConfirmada = true;
    proyeccion.acuerdoMangoReferenciadoId = acuerdo._id;
    proyeccion.ultimaModificacion = new Date();
    await proyeccion.save();

    const resultado = await Proyeccion.findById(proyeccion._id)
      .populate("empleadoId", "username nombre")
      .populate("entidadId", "nombre numero")
      .populate("subCesionId", "nombre")
      .lean();

    return res.json({
      ok: true,
      mensaje: "El acuerdo manual quedó cerrado porque ya está confirmado en Mango.",
      proyeccion: {
        ...resultado,
        entidadNumero: Number(
          resultado?.entidadNumero || resultado?.entidadId?.numero || 0
        ),
        tieneAcuerdoMango: true,
        cantidadAcuerdosMango: acuerdos.length,
        acuerdoMangoResumen: {
          _id: acuerdo._id,
          fecha: acuerdo.fechaHora || acuerdo.fecha,
          tipo: acuerdo.tipoAcuerdo || acuerdo.resultado || "Acuerdo",
          operador: acuerdo.operador || "",
          estado: acuerdo.estadoCuenta || "Confirmado",
        },
      },
    });
  } catch (error) {
    console.error("❌ Error cerrando proyección por acuerdo Mango:", error);
    return res.status(500).json({
      error: "No se pudo cerrar el acuerdo manual por acuerdo Mango",
    });
  }
};

export const obtenerEstadisticasPropias = async (req, res) => {
  try {
    if (!tieneAccesoProyecciones(req)) return res.status(403).json({ error: "Sin acceso" });
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

export const obtenerEstadisticasAdmin = async (req, res) => {
  try {
    if (!esAmbitoGlobal(req)) return res.status(403).json({ error: "No autorizado" });
    const proyecciones = await Proyeccion.find();
    const actualizadas = await Promise.all(
      proyecciones.map(actualizarEstadoAutomaticamente)
    );

    const porEmpleado = {},
      porEntidad = {},
      porSubCesion = {},
      porMes = {};

    for (const p of actualizadas) {
      const id = p.empleadoId.toString();
      porEmpleado[id] = porEmpleado[id] || { total: 0, cumplidas: 0 };
      porEmpleado[id].total++;
      if (p.estado === "Pagado") porEmpleado[id].cumplidas++;

      const entKey = String(p.entidadId || "sin_entidad");
      const subKey = String(p.subCesionId || "sin_subcesion");

      porEntidad[entKey] = (porEntidad[entKey] || 0) + 1;
      porSubCesion[subKey] = (porSubCesion[subKey] || 0) + 1;

      const clave = `${p.anio}-${String(p.mes).padStart(2, "0")}`;
      porMes[clave] = (porMes[clave] || 0) + 1;
    }

    res.json({ porEmpleado, porEntidad, porSubCesion, porMes });
  } catch (error) {
    res.status(500).json({ error: "Error al calcular estadísticas globales" });
  }
};

export const obtenerResumenGlobal = async (req, res) => {
  try {
    if (!esAmbitoGlobal(req)) return res.status(403).json({ error: "No autorizado" });
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
      entidadId,
      subCesionId,
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
      sinGestion,
    } = req.query;

    if (!tieneAccesoProyecciones(req)) {
      return res.status(403).json({ error: "Sin acceso" });
    }

    const filtros = [];
    if (esAmbitoGlobal(req) && usuarioId) {
      filtros.push({ empleadoId: usuarioId });
    } else if (!esAmbitoGlobal(req)) {
      filtros.push({ empleadoId: req.user.id });
    }

    if (estado) filtros.push({ estado });
    if (concepto) filtros.push({ concepto });
    if (entidadId) filtros.push({ entidadId });
    if (subCesionId) filtros.push({ subCesionId });
    if (mes) filtros.push({ mes: Number.parseInt(mes, 10) });
    if (anio) filtros.push({ anio: Number.parseInt(anio, 10) });
    if (sinGestion === "true") {
      filtros.push({
        $or: [
          { vecesTocada: { $exists: false } },
          { vecesTocada: null },
          { vecesTocada: { $lte: 0 } },
        ],
      });
    }

    let rangoDesde = null;
    let rangoHasta = null;
    if (
      fechaDesde &&
      fechaHasta &&
      !Number.isNaN(Date.parse(fechaDesde)) &&
      !Number.isNaN(Date.parse(fechaHasta))
    ) {
      const rango = rangoFechaProyeccion(fechaDesde, fechaHasta, tipoFecha);
      rangoDesde = rango.inicio;
      rangoHasta = rango.fin;
      filtros.push({ [rango.campo]: { $gte: rangoDesde, $lte: rangoHasta } });
    }

    const hoyClave = fechaClaveArgentina();
    const hoy = inicioDiaCalendarioUTC(hoyClave);
    const manana = siguienteDiaCalendarioUTC(hoyClave);
    if (promesaHoy === "true") {
      filtros.push({ fechaPromesa: { $gte: hoy, $lt: manana } });
    }
    if (llamadoHoy === "true") {
      filtros.push({ fechaProximoLlamado: { $gte: hoy, $lt: manana } });
    }

    const query = filtros.length ? { $and: filtros } : {};
    let proyecciones = await lecturaMongoConReintento(
      () =>
        Proyeccion.find(query)
          .populate("empleadoId", "username nombre")
          .populate("entidadId", "nombre numero")
          .populate("subCesionId", "nombre")
          .sort(ordenPor ? { [ordenPor]: orden === "asc" ? 1 : -1 } : {})
          .maxTimeMS(30000),
      "/proyecciones/resumen/data"
    );

    if (buscar) {
      const regex = new RegExp(escapeRegexSafe(buscar), "i");
      const posibleDni = Number.parseInt(buscar, 10);
      proyecciones = proyecciones.filter((p) => {
        const matchTexto =
          regex.test(p.nombreTitular || "") ||
          regex.test(p.concepto || "") ||
          regex.test(p.estado || "") ||
          regex.test(p.entidadId?.nombre || "") ||
          regex.test(p.subCesionId?.nombre || "");
        const matchDni =
          !Number.isNaN(posibleDni) && Number(p.dni) === posibleDni;
        return matchTexto || matchDni;
      });
    }

    /*
     * Los acuerdos de Mango forman parte de las estadísticas, pero nunca se
     * suman dos veces. Si existe Mango para DNI + entidad, el control personal
     * equivalente queda fuera del resumen (sigue visible en su tabla).
     * Mango no posee subcesión, próximo llamado ni cantidad de gestiones; por
     * eso se excluye solamente cuando alguno de esos filtros está activo.
     */
    const motivosExclusionMango = [];
    if (subCesionId) motivosExclusionMango.push("subcesión");
    if (llamadoHoy === "true") motivosExclusionMango.push("llamados de hoy");
    if (sinGestion === "true") motivosExclusionMango.push("sin gestión");
    if (estado) motivosExclusionMango.push("estado personal");
    if (tipoFecha && tipoFecha !== "fechaPromesa") {
      motivosExclusionMango.push("tipo de fecha");
    }

    let acuerdosMango = [];
    let entidadesCatalogo = [];
    if (!motivosExclusionMango.length) {
      const condicionesMango = [
        { borrado: { $ne: true } },
        { resultadoGestion: /acuerdo/i },
      ];

      if (rangoDesde && rangoHasta) {
        condicionesMango.push({ fecha: { $gte: rangoDesde, $lte: rangoHasta } });
      } else if (promesaHoy === "true") {
        condicionesMango.push({ fecha: { $gte: hoy, $lt: manana } });
      } else if (mes && anio) {
        const inicioMes = new Date(Number(anio), Number(mes) - 1, 1, 0, 0, 0, 0);
        const finMes = new Date(Number(anio), Number(mes), 0, 23, 59, 59, 999);
        condicionesMango.push({ fecha: { $gte: inicioMes, $lte: finMes } });
      }

      if (entidadId) {
        const canonica = await resolverEntidadCanonica({ entidadId });
        if (canonica) {
          const variantes = variantesTextoEntidad(canonica.entidad).map(
            (valor) => new RegExp(`^${escapeRegexSafe(valor)}$`, "i")
          );
          condicionesMango.push({
            $or: [
              { entidadNumero: canonica.entidadNumero },
              { entidad: { $in: variantes } },
            ],
          });
        }
      }

      if (concepto) {
        const regexConcepto = new RegExp(escapeRegexSafe(concepto), "i");
        condicionesMango.push({
          $or: [
            { resultadoGestion: regexConcepto },
            { observacionGestion: regexConcepto },
          ],
        });
      }

      if (buscar) {
        const regexBuscar = new RegExp(escapeRegexSafe(buscar), "i");
        condicionesMango.push({
          $or: [
            { dni: regexBuscar },
            { nombreDeudor: regexBuscar },
            { entidad: regexBuscar },
            { usuario: regexBuscar },
            { resultadoGestion: regexBuscar },
            { observacionGestion: regexBuscar },
          ],
        });
      }

      const queryMango = condicionesMango.length === 1
        ? condicionesMango[0]
        : { $and: condicionesMango };

      const [gestionesMango, catalogo] = await lecturaMongoConReintento(
        () =>
          Promise.all([
            ReporteGestion.find(queryMango)
              .sort({ fecha: -1, hora: -1, _id: -1 })
              .select(
                "dni entidad entidadNumero nombreDeudor usuario fecha hora tipoContacto resultadoGestion estadoCuenta telMailMarcado observacionGestion"
              )
              .maxTimeMS(30000)
              .lean(),
            Entidad.find({}, "numero nombre").maxTimeMS(30000).lean(),
          ]),
        "/proyecciones/resumen/data · acuerdos Mango"
      );
      entidadesCatalogo = catalogo;
      const numeroPorNombreTemporal = new Map(
        catalogo.map((entidad) => [
          String(entidad.nombre || "").trim().toUpperCase(),
          Number(entidad.numero || 0),
        ])
      );
      acuerdosMango = gestionesMango
        .map((gestion) => mapearGestionAacuerdoMango(gestion, numeroPorNombreTemporal))
        .filter(Boolean);
    }

    const numeroPorNombre = new Map(
      entidadesCatalogo.map((entidad) => [
        String(entidad.nombre || "").trim().toUpperCase(),
        Number(entidad.numero || 0),
      ])
    );
    const nombrePorNumero = new Map(
      entidadesCatalogo.map((entidad) => [
        Number(entidad.numero || 0),
        String(entidad.nombre || "").trim(),
      ])
    );

    const variantesObjetivo = await variantesOperadorObjetivo(req, usuarioId);
    const acuerdosMangoVinculadosTodos = await vincularAcuerdosMangoConPagos(acuerdosMango);
    const acuerdosMangoEpisodios = resolverEpisodiosAcuerdos(acuerdosMangoVinculadosTodos).rows;
    const acuerdosMangoVinculados = acuerdosMangoEpisodios
      .filter((acuerdo) => acuerdoPerteneceAOperador(acuerdo, variantesObjetivo));

    const clavesMango = new Set();
    const acuerdosMangoConPagos = [];
    for (const acuerdo of acuerdosMangoVinculados) {
      const entidadNumero = Number(
        acuerdo.entidadNumero ||
          numeroPorNombre.get(String(acuerdo.entidad || "").trim().toUpperCase()) ||
          0
      );
      const clave = claveDniEntidad(acuerdo.dni, entidadNumero);
      if (!clave) continue;
      clavesMango.add(clave);
      acuerdosMangoConPagos.push({ ...acuerdo, entidadNumero });
    }

    let personalesOmitidosPorMango = 0;
    const personalesIncluidosBase = proyecciones.filter((proyeccion) => {
      const entidadNumero = Number(
        proyeccion.entidadNumero || proyeccion.entidadId?.numero || 0
      );
      const duplicada = clavesMango.has(
        claveDniEntidad(proyeccion.dni, entidadNumero)
      );
      if (duplicada) personalesOmitidosPorMango += 1;
      return !duplicada;
    });

    const personalesIncluidos = await enriquecerProyeccionesConFuentes(
      personalesIncluidosBase.map((proyeccion) => proyeccion.toObject())
    );

    const registrosResumen = [
      ...personalesIncluidos.map((proyeccion) => {
        const importe = Number(proyeccion.importe || 0);
        const pagadoReal = Number(proyeccion?.pagosRealesResumen?.totalValido || 0);
        const estadoReal = pagadoReal > 0
          ? (importe > 0 && pagadoReal >= importe ? "Pagado" : "Pagado parcial")
          : proyeccion.estado;
        return {
          ...proyeccion,
          importePagado: pagadoReal,
          estado: estadoReal,
          empleadoId: {
            ...(proyeccion.empleadoId || {}),
            // La proyección pertenece a quien la generó. El operador que luego
            // imputó un pago no cambia la autoría/productividad de la promesa.
            username:
              proyeccion?.empleadoId?.username ||
              proyeccion?.pagosRealesResumen?.operadorPago ||
              "Sin usuario",
          },
          pagosEstadistica: proyeccion?.pagosRealesResumen?.pagosValidos || [],
          _fuenteResumen: "manual",
        };
      }),
      ...acuerdosMangoConPagos.map((acuerdo) => {
        const importe = Number(
          acuerdo.primerPago ||
            acuerdo.anticipoMonto ||
            acuerdo.montoCuota ||
            acuerdo.montoTotalAcuerdo ||
            acuerdo.deudaMin ||
            0
        );
        const importePagado = Number(
          acuerdo.montoPagosValidos || acuerdo.montoPagosPosteriores || 0
        );
        const fechaAcuerdo = acuerdo.fecha || acuerdo.fechaHora || null;
        const fechaVencimiento = claveVencimientoAcuerdoMango(acuerdo) || fechaAcuerdo;
        const estado = importePagado > 0
          ? (importe > 0 && importePagado >= importe ? "Pagado" : "Pagado parcial")
          : acuerdo.requiereRevisionPagos
          ? "Requiere revisión"
          : "Acuerdo Mango";
        return {
          _id: acuerdo._id,
          dni: acuerdo.dni,
          nombreTitular: acuerdo.nombreDeudor || "",
          importe,
          importePagado,
          estado,
          concepto: acuerdo.tipoAcuerdo || acuerdo.resultado || "Acuerdo",
          fechaPromesa: fechaVencimiento,
          creado: fechaAcuerdo,
          empleadoId: { username: acuerdo.operador || acuerdo.usuario || acuerdo.operadorGestion || acuerdo.operadorPago || "Sin usuario" },
          entidadId: {
            nombre:
              nombrePorNumero.get(Number(acuerdo.entidadNumero || 0)) ||
              acuerdo.entidad ||
              "Sin entidad",
            numero: acuerdo.entidadNumero,
          },
          subCesionId: { nombre: "Sin subcesión informada" },
          pagosEstadistica: acuerdo.pagosValidos || [],
          _fuenteResumen: "mango",
        };
      }),
    ];

    const resumen = {
      totalImporte: 0,
      totalPagado: 0,
      vencidasSinPago: 0,
      pagadas: 0,
      total: 0,
      porEstado: {},
      porEntidad: {},
      porDia: {},
      porDiaCreacion: {},
      porUsuario: {},
      subCesiones: {},
      pagosPorDia: {},
      montosPagosPorDia: {},
      totalPagos: 0,
      montoPagos: 0,
      _detUsuarios: {},
    };

    const hoyClaveResumen = fechaClaveArgentina();
    const rangoDesdeClave = rangoDesde ? claveFechaCalendario(rangoDesde) : "";
    const rangoHastaClave = rangoHasta ? claveFechaCalendario(rangoHasta) : "";
    const normalizarFechaResumen = (raw) => claveFechaCalendario(raw);
    const estaEnRangoPagos = (clave) =>
      !rangoDesdeClave || !rangoHastaClave || (clave >= rangoDesdeClave && clave <= rangoHastaClave);

    for (const registro of registrosResumen) {
      const importe = Number(registro.importe || 0) || 0;
      const pagado = Number(registro.importePagado || 0) || 0;
      const estadoRegistro = String(registro.estado || "Sin estado").trim();
      const entidadNombre =
        String(registro.entidadId?.nombre || "").trim() || "Sin entidad";
      const subCesionNombre =
        String(registro.subCesionId?.nombre || "").trim() || "Sin subcesión";
      const usuario = registro.empleadoId?.username || "Sin usuario";

      resumen.total += 1;
      resumen.totalImporte += importe;
      resumen.totalPagado += pagado;

      const cumplida =
        estadoRegistro === "Pagado" || estadoRegistro === "Pagado parcial";
      if (cumplida) resumen.pagadas += 1;

      const fechaPromesa = normalizarFechaResumen(registro.fechaPromesa);
      // Una promesa está vencida por su vencimiento real y por no tener pago
      // válido, no por la etiqueta persistida del estado. Esto también cubre
      // acuerdos de Mango cuyo estado visible sigue siendo "Acuerdo Mango".
      if (pagado <= 0 && fechaPromesa && fechaPromesa < hoyClaveResumen) {
        resumen.vencidasSinPago += 1;
      }

      resumen.porEstado[estadoRegistro] =
        (resumen.porEstado[estadoRegistro] || 0) + 1;
      resumen.porEntidad[entidadNombre] =
        (resumen.porEntidad[entidadNombre] || 0) + 1;
      resumen.subCesiones[subCesionNombre] =
        (resumen.subCesiones[subCesionNombre] || 0) + 1;

      if (fechaPromesa) {
        resumen.porDia[fechaPromesa] = (resumen.porDia[fechaPromesa] || 0) + 1;
      }
      const fechaCreacion = registro.creado ? fechaClaveArgentina(registro.creado) : "";
      if (fechaCreacion) {
        resumen.porDiaCreacion[fechaCreacion] =
          (resumen.porDiaCreacion[fechaCreacion] || 0) + 1;
      }

      resumen.porUsuario[usuario] = resumen.porUsuario[usuario] || {
        total: 0,
        pagadas: 0,
      };
      resumen.porUsuario[usuario].total += 1;
      if (cumplida) resumen.porUsuario[usuario].pagadas += 1;

      const detalle = (resumen._detUsuarios[usuario] =
        resumen._detUsuarios[usuario] || {
          total: 0,
          importeTotal: 0,
          pagadas: 0,
          cantPagos: 0,
          pagadoTotal: 0,
        });
      detalle.total += 1;
      detalle.importeTotal += importe;
      if (cumplida) detalle.pagadas += 1;

      for (const pago of registro.pagosEstadistica || []) {
        const fechaPago = normalizarFechaResumen(
          pago.fecha || pago.fechaPago || pago.creado || pago.createdAt
        );
        if (!fechaPago || !estaEnRangoPagos(fechaPago)) continue;
        const montoPago = Number(pago.monto ?? pago.importe ?? 0) || 0;
        resumen.pagosPorDia[fechaPago] = (resumen.pagosPorDia[fechaPago] || 0) + 1;
        resumen.montosPagosPorDia[fechaPago] =
          (resumen.montosPagosPorDia[fechaPago] || 0) + montoPago;
        resumen.totalPagos += 1;
        resumen.montoPagos += montoPago;
        detalle.cantPagos += 1;
        detalle.pagadoTotal += montoPago;
      }
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
      .sort((a, b) => Number(b.porcentaje) - Number(a.porcentaje));
    const rankingDetallado = Object.entries(resumen._detUsuarios)
      .map(([usuario, data]) => ({
        usuario,
        total: data.total,
        importeTotal: data.importeTotal,
        pagadas: data.pagadas,
        cantPagos: data.cantPagos,
        pagadoTotal: data.pagadoTotal,
        porcentaje:
          data.total > 0
            ? ((data.pagadas / data.total) * 100).toFixed(1)
            : "0.0",
      }))
      .sort((a, b) => Number(b.porcentaje) - Number(a.porcentaje));

    return res.json({
      totalImporte: resumen.totalImporte,
      totalPagado: resumen.totalPagado,
      porcentajeVencidas,
      porcentajeCumplimiento,
      porEstado: resumen.porEstado,
      porEntidad: resumen.porEntidad,
      porDia: resumen.porDia,
      porDiaCreacion: resumen.porDiaCreacion,
      topUsuarios,
      rankingCumplimiento,
      rankingDetallado,
      subCesiones: resumen.subCesiones,
      pagadas: resumen.pagadas,
      total: resumen.total,
      vencidasSinPago: resumen.vencidasSinPago,
      pagosPorDia: resumen.pagosPorDia,
      montosPagosPorDia: resumen.montosPagosPorDia,
      totalPagos: resumen.totalPagos,
      montoPagos: resumen.montoPagos,
      fuentes: {
        acuerdosMango: acuerdosMangoConPagos.length,
        acuerdosManualesIncluidos: personalesIncluidos.length,
        acuerdosPersonalesIncluidos: personalesIncluidos.length,
        personalesOmitidosPorMango,
        criterioDeduplicacion: "DNI + entidad",
        mangoIncluido: motivosExclusionMango.length === 0,
        motivosExclusionMango,
      },
    });
  } catch (error) {
    console.error("❌ Error en obtenerProyeccionesParaResumen:", error);
    return res.status(500).json({
      error: esErrorMongoTransitorio(error)
        ? "La conexión con la base de datos se interrumpió al calcular las estadísticas. Reintentá en unos segundos."
        : "Error al obtener resumen",
      codigo: esErrorMongoTransitorio(error)
        ? "DB_CONNECTION_RESET"
        : "PROYECCIONES_SUMMARY_ERROR",
    });
  }
};
export const informarPago = async (req, res) => {
  try {
    const { id } = req.params; // proyeccionId
    const { fecha, monto } = req.body;

    // Validaciones de entrada
    const fechaJS = parseExcelDate(fecha);
    if (!fechaJS || isNaN(fechaJS)) {
      return res.status(400).json({ error: "Fecha inválida" });
    }
    const montoNum = Number(monto);
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      return res.status(400).json({ error: "Monto inválido" });
    }

    // Buscar proyección
    const proy = await Proyeccion.findById(id);
    if (!proy) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    // 🔒 no permitir informar pagos en cuentas cerradas
    const cerrada =
      proy.isActiva === false || /^Cerrada/.test(String(proy.estado || ""));
    if (cerrada) {
      return res.status(409).json({
        error: "La proyección está cerrada: no se pueden informar pagos.",
      });
    }

    if (!tieneAccesoProyecciones(req)) return res.status(403).json({ error: "Sin acceso" });
    if (esAmbitoPropio(req) && !esDueno(req, proy)) {
      return res
        .status(403)
        .json({ error: "No autorizado para informar pago" });
    }

    // Evitar duplicados (mismo día y mismo monto ya cargado y no erróneo)
    const fechaClave = claveFechaCalendario(fechaJS);
    const duplicado = (proy.pagosInformados || []).some((p) => {
      if (p.erroneo) return false;
      return (
        claveFechaCalendario(p.fecha) === fechaClave &&
        Number(p.monto || 0) === Number(montoNum)
      );
    });
    if (duplicado) {
      return res
        .status(409)
        .json({ error: "Pago duplicado (misma fecha y monto ya cargado)." });
    }

    // Agregar pago
    proy.pagosInformados.push({
      fecha: fechaJS,
      monto: montoNum,
      operadorId: req.user.id,
    });

    if (!PAGOS_FUENTE_UNICA_ACTIVA) {
      // Compatibilidad temporal con el funcionamiento anterior.
      proy.importePagado = calcularTotalInformado(proy);
    }
    proy.ultimaModificacion = new Date();
    await proy.save();
    if (!PAGOS_FUENTE_UNICA_ACTIVA) {
      await actualizarEstadoAutomaticamente(proy);
    }

    // Devolver proyección actualizada (con operador y creador para el front)
    const actualizado = await Proyeccion.findById(id)
      .populate("empleadoId", "username")
      .populate("pagosInformados.operadorId", "username");

    return res.json(actualizado);
  } catch (e) {
    console.error("❌ informarPago:", e);
    return res.status(500).json({ error: "Error al informar pago" });
  }
};

export const listarPagosInformados = async (req, res) => {
  try {
    const { id } = req.params;

    if (!tieneAccesoProyecciones(req)) return res.status(403).json({ error: "Sin acceso" });

    const proy = await Proyeccion.findById(id)
      .select("empleadoId pagosInformados")
      .populate("pagosInformados.operadorId", "username nombre email") // ← clave
      .populate("pagosInformados.marcadoPor", "username") // opcional
      .lean();

    if (!proy)
      return res.status(404).json({ error: "Proyección no encontrada" });

    if (esAmbitoPropio(req) && !esDueno(req, proy)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const pagos = (proy.pagosInformados || [])
      .slice()
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    return res.json({ ok: true, pagos });
  } catch (e) {
    console.error("❌ listarPagosInformados:", e);
    return res.status(500).json({ error: "Error al listar pagos" });
  }
};

export const marcarPagoErroneo = async (req, res) => {
  try {
    const { id, pagoId } = req.params; // proyeccionId, pagoId
    const { erroneo = true, motivo = "" } = req.body;

    // Buscar proyección
    const proy = await Proyeccion.findById(id);
    if (!proy) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    // 🔒 No permitir ediciones en cuentas cerradas
    const cerrada =
      proy.isActiva === false || /^Cerrada/.test(String(proy.estado || ""));
    if (cerrada) {
      return res.status(409).json({
        error: "La proyección está cerrada: no se pueden editar pagos.",
      });
    }

    if (!tieneAccesoProyecciones(req)) return res.status(403).json({ error: "Sin acceso" });
    if (esAmbitoPropio(req) && !esDueno(req, proy)) {
      return res
        .status(403)
        .json({ error: "No autorizado para marcar este pago" });
    }

    // Ubicar el pago
    const pago = (proy.pagosInformados || []).id(pagoId);
    if (!pago) {
      return res.status(404).json({ error: "Pago no encontrado" });
    }

    // Marcar / desmarcar
    pago.erroneo = !!erroneo;
    pago.motivoError = pago.erroneo ? motivo || "" : "";
    pago.marcadoPor = req.user.id;
    pago.marcadoEn = new Date();

    if (!PAGOS_FUENTE_UNICA_ACTIVA) {
      proy.importePagado = calcularTotalInformado(proy);
    }
    proy.ultimaModificacion = new Date();
    await proy.save();
    if (!PAGOS_FUENTE_UNICA_ACTIVA) {
      await actualizarEstadoAutomaticamente(proy);
    }

    // Responder con datos enriquecidos para el front
    const actualizado = await Proyeccion.findById(id)
      .populate("empleadoId", "username")
      .populate("pagosInformados.operadorId", "username")
      .populate("pagosInformados.marcadoPor", "username");

    const pagosOrdenados = (actualizado.pagosInformados || []).sort(
      (a, b) => new Date(b.fecha) - new Date(a.fecha)
    );

    return res.json({
      ok: true,
      proyeccion: actualizado,
      pagos: pagosOrdenados,
    });
  } catch (e) {
    console.error("❌ marcarPagoErroneo:", e);
    return res.status(500).json({ error: "No se pudo marcar el pago" });
  }
};

export const limpiarPagosProyeccion = async (req, res) => {
  try {
    const proyeccion = await Proyeccion.findById(req.params.id);
    if (!proyeccion) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    // 🔒 Bloqueo: no permitir limpiar pagos en cuentas cerradas
    const cerrada =
      proyeccion.isActiva === false ||
      /^Cerrada/.test(String(proyeccion.estado || ""));
    if (cerrada) {
      return res.status(409).json({
        error: "La proyección está cerrada: no se pueden limpiar pagos.",
      });
    }

    const rol = rolDe(req);

    if (!tieneAccesoProyecciones(req)) {
      return res.status(403).json({ error: "Sin acceso" });
    }
    if (esAmbitoPropio(req) && !esDueno(req, proyeccion)) {
      return res.status(403).json({ error: "No autorizado para limpiar pagos" });
    }

    // Asegurar array
    proyeccion.pagosInformados = proyeccion.pagosInformados || [];

    if (esAmbitoPropio(req)) {
      // Operador: limpia SOLO sus propios pagos
      proyeccion.pagosInformados = proyeccion.pagosInformados.filter(
        (p) => String(p.operadorId) !== String(req.user.id)
      );
    } else if (esAmbitoGlobal(req)) {
      // Admin / Super-admin: limpia TODOS los pagos
      proyeccion.pagosInformados = [];
    } else {
      // Otros roles no permitidos
      return res
        .status(403)
        .json({ error: "No autorizado para limpiar pagos" });
    }

    if (!PAGOS_FUENTE_UNICA_ACTIVA) {
      proyeccion.importePagado = calcularTotalInformado(proyeccion);
    }
    proyeccion.ultimaModificacion = new Date();
    await proyeccion.save();
    if (!PAGOS_FUENTE_UNICA_ACTIVA) {
      await actualizarEstadoAutomaticamente(proyeccion);
    }

    // Devolver proyección actualizada con datos útiles
    const actualizado = await Proyeccion.findById(proyeccion._id)
      .populate("empleadoId", "username")
      .populate("pagosInformados.operadorId", "username");

    return res.json({
      ok: true,
      mensaje:
        esAmbitoPropio(req)
          ? "Pagos del usuario actual limpiados correctamente"
          : "Se limpiaron todos los pagos informados",
      proyeccion: actualizado?.toObject?.() || actualizado,
    });
  } catch (err) {
    console.error("Error al limpiar pagos:", err);
    return res.status(500).json({ error: "Error interno al limpiar pagos" });
  }
};

export const limpiarObservacionesProyeccion = async (req, res) => {
  try {
    const proyeccion = await Proyeccion.findById(req.params.id);
    if (!proyeccion) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    // 🔒 Bloqueo: no permitir modificar cuentas cerradas
    const cerrada =
      proyeccion.isActiva === false ||
      /^Cerrada/.test(String(proyeccion.estado || ""));
    if (cerrada) {
      return res.status(409).json({
        error:
          "La proyección está cerrada: no se pueden limpiar observaciones.",
      });
    }

    // 👤 Permisos
    if (!tieneAccesoProyecciones(req)) {
      return res.status(403).json({ error: "Sin acceso" });
    }
    if (esAmbitoPropio(req) && !esDueno(req, proyeccion)) {
      return res
        .status(403)
        .json({ error: "No autorizado para limpiar observaciones" });
    }
    if (!tieneAccesoProyecciones(req)) {
      return res.status(403).json({ error: "Rol no autorizado" });
    }

    // 🧹 Limpieza
    proyeccion.observaciones = "";
    proyeccion.ultimaModificacion = new Date();
    await proyeccion.save();

    // devolver proyección actualizada (con datos útiles)
    const actualizado = await Proyeccion.findById(proyeccion._id).populate(
      "empleadoId",
      "username"
    );

    return res.json({
      ok: true,
      mensaje: "Observaciones limpiadas",
      proyeccion: actualizado?.toObject?.() || actualizado,
    });
  } catch (err) {
    console.error("Error al limpiar observaciones:", err);
    return res
      .status(500)
      .json({ error: "Error interno al limpiar observaciones" });
  }
};

export const importarPagosMasivo = async (req, res) => {
  try {
    // 1) Seguridad por rol (la ruta igual debería tener el middleware)
    if (!esGestorGlobal(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    // 2) Archivo adjunto
    if (!req.file || !req.file.buffer) {
      return res
        .status(400)
        .json({ error: "Subí un archivo XLSX (campo: file)" });
    }

    // 3) Cargar XLSX
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws)
      return res.status(400).json({ error: "El archivo no tiene hojas" });

    // ==== Helpers locales ====
    const norm = (s) =>
      String(s || "")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .trim()
        .toLowerCase();

    const NORM_TXT = (s) =>
      String(s || "")
        .trim()
        .toUpperCase();

    // quita prefijos "123 - " o "66f0... - " → queda NOMBRE
    const parseSelectLabel = (v) => {
      if (v == null) return "";
      const s = String(v).trim();
      const m = s.match(/^\s*(?:[0-9a-f]{24}|\d+)\s*-\s*(.+)$/i);
      return (m ? m[1] : s).trim();
    };

    const toISODate = (v) => {
      const d = (() => {
        if (v == null) return null;
        if (v instanceof Date) return v;
        if (typeof v === "number") {
          const ms = (v - 25569) * 86400 * 1000; // Excel serial
          const d = new Date(ms);
          return isNaN(d) ? null : d;
        }
        const s = String(v).trim();
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
          const [dd, mm, aa] = s.split("/").map(Number);
          return new Date(aa, mm - 1, dd, 12, 0, 0, 0);
        }
        const d2 = new Date(s);
        return isNaN(d2) ? null : d2;
      })();
      return d ? d.toISOString().slice(0, 10) : v == null ? "" : String(v);
    };

    // etiquetas: Entidad "n - NOMBRE" / SubCesión "NOMBRE"
    const buildLabelMaps = async () => {
      const [ents, subs] = await Promise.all([
        Entidad.find({}, "nombre numero").sort({ numero: 1, nombre: 1 }).lean(),
        SubCesion.find({}, "nombre").sort({ nombre: 1 }).lean(),
      ]);
      const entLabelById = new Map(); // id -> "n - NOMBRE"
      const subNameById = new Map(); // id -> "NOMBRE"
      ents.forEach((e) =>
        entLabelById.set(
          String(e._id),
          Number.isFinite(Number(e.numero)) ? `${e.numero} - ${e.nombre}` : e.nombre
        )
      );
      subs.forEach((s) => subNameById.set(String(s._id), s.nombre));
      const entLabel = (id, fallbackName) =>
        id
          ? entLabelById.get(String(id)) ||
            (fallbackName ? `- ${fallbackName}` : "")
          : fallbackName || "";
      const subLabel = (id, fallbackName) =>
        id
          ? subNameById.get(String(id)) || fallbackName || ""
          : fallbackName || "";
      return { entLabel, subLabel };
    };
    const { entLabel, subLabel } = await buildLabelMaps();

    // mapear encabezados de la fila 1
    const headers = {};
    ws.getRow(1).eachCell((cell, col) => {
      const key = norm(cell.value);
      if (key) headers[key] = col;
    });

    // Alias aceptados (admite ID o NOMBRE)
    const aliases = {
      dni: ["dni", "documento", "doc"],
      entidadId: ["entidadid", "entidad id", "id entidad", "id_entidad"],
      subCesionId: [
        "subcesionid",
        "subcesion id",
        "id subcesion",
        "id_subcesion",
      ],
      entidad: ["entidad", "empresa"],
      subCesion: [
        "subcesion",
        "sub-cesion",
        "sub cesion",
        "subcesión",
        "sub cesión",
      ],
      fecha: ["fecha pago", "fecha", "fecha de pago"],
      monto: ["monto", "importe", "monto pago", "importe pago"],
      observacion: ["observacion", "observación", "obs"],
    };

    const getCol = (logical) => {
      if (headers[logical]) return headers[logical];
      for (const alias of aliases[logical] || []) {
        const k = norm(alias);
        if (headers[k]) return headers[k];
      }
      return null;
    };

    // Debe venir: DNI, FECHA, MONTO y (ENTIDAD_ID o ENTIDAD) y (SUBCESION_ID o SUBCESION)
    const faltan = [];
    if (!getCol("dni")) faltan.push("DNI");
    if (!getCol("fecha")) faltan.push("FECHA");
    if (!getCol("monto")) faltan.push("MONTO");
    if (!getCol("entidadId") && !getCol("entidad"))
      faltan.push("ENTIDAD_ID o ENTIDAD");
    if (!getCol("subCesionId") && !getCol("subCesion"))
      faltan.push("SUBCESION_ID o SUBCESION");

    if (faltan.length) {
      return res.status(400).json({
        error: `Faltan columnas: ${faltan.join(
          ", "
        )}. Requerido: DNI, (EntidadId o Entidad), (SubCesionId o SubCesion), Fecha, Monto`,
      });
    }

    // Fecha de pago: misma normalización calendario que el resto del módulo.
    const parseFecha = (v) => parseExcelDate(v);

    const parseMonto = (v) => {
      if (v == null) return NaN;
      if (typeof v === "number") return v;
      const n = Number(
        String(v)
          .replace(/[^\d.,-]/g, "")
          .replace(",", ".")
      );
      return Number.isFinite(n) ? n : NaN;
    };

    const parseObjectId = (v) => {
      if (v == null) return null;
      const s = String(v).trim();
      return mongoose.Types.ObjectId.isValid(s)
        ? new mongoose.Types.ObjectId(s)
        : null;
    };

    // Cache para no consultar la DB por la misma (dni, entidadId, subCesionId) en cada fila
    const cacheActivas = new Map();
    const getActiva = async (dni, entidadId, subCesionId) => {
      const key = `${dni}::${entidadId}::${subCesionId}`;
      if (cacheActivas.has(key)) return cacheActivas.get(key);
      const proy = await Proyeccion.findOne({
        dni,
        entidadId,
        subCesionId,
        $or: [{ isActiva: true }, { isActiva: { $exists: false } }],
      });
      cacheActivas.set(key, proy || null);
      return proy;
    };

    // Caches Entidad/SubCesión por nombre
    const cacheEntPorNombre = new Map(); // NOMBRE→doc/null
    const cacheSubPorNombre = new Map(); // NOMBRE→doc/null (GLOBAL)

    const buscarEntidadPorNombre = async (nombre) => {
      if (!nombre) return null;
      const key = NORM_TXT(nombre);
      if (cacheEntPorNombre.has(key)) return cacheEntPorNombre.get(key);
      const ent = await Entidad.findOne({ nombre: key });
      cacheEntPorNombre.set(key, ent || null);
      return ent;
    };

    // GLOBAL: SubCesión por NOMBRE (no depende de entidad)
    const buscarOCrearSubPorNombre = async (nombre) => {
      if (!nombre) return null;
      const key = NORM_TXT(nombre);
      if (cacheSubPorNombre.has(key)) return cacheSubPorNombre.get(key);
      let sub = await SubCesion.findOne({ nombre: key });
      if (!sub) sub = await SubCesion.create({ nombre: key }); // modelo: { nombre: unique }
      cacheSubPorNombre.set(key, sub);
      return sub;
    };

    // Duplicado: mismo día y mismo monto (no erróneo)
    const esDuplicado = (proy, fechaJS, montoNum) => {
      const fechaClave = claveFechaCalendario(fechaJS);
      return (proy.pagosInformados || []).some((p) => {
        if (p.erroneo) return false;
        return (
          claveFechaCalendario(p.fecha) === fechaClave &&
          Number(p.monto || 0) === Number(montoNum)
        );
      });
    };

    const errores = [];
    let ok = 0;

    // ---- Recorrer filas (desde 2) ----
    for (let i = 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);

      const getCell = (logical) => {
        const col = getCol(logical);
        return col ? row.getCell(col).value : undefined;
      };

      const rawDni = getCell("dni");
      const rawEntId = getCell("entidadId");
      const rawSubId = getCell("subCesionId");
      const rawEntNm = parseSelectLabel(getCell("entidad"));
      const rawSubNm = parseSelectLabel(getCell("subCesion"));
      const rawFec = getCell("fecha");
      const rawMon = getCell("monto");
      const rawObs = getCell("observacion");

      const dni = Number(String(rawDni || "").replace(/\D/g, ""));
      let entidadId = parseObjectId(rawEntId);
      let subCesionId = parseObjectId(rawSubId);
      const fechaJS = parseFecha(rawFec);
      const montoNum = parseMonto(rawMon);

      // Resolver ENTIDAD por NOMBRE cuando no hay ID
      if (!entidadId && rawEntNm) {
        const ent = await buscarEntidadPorNombre(rawEntNm);
        if (!ent) {
          errores.push({
            fila: i,
            dni: Number.isFinite(dni) ? dni : String(rawDni ?? ""),
            entidad: rawEntNm || "",
            subCesion: rawSubNm || "",
            fecha: toISODate(rawFec),
            monto: String(rawMon ?? ""),
            error: `Entidad "${rawEntNm}" inexistente (no se crea automáticamente)`,
          });
          continue;
        }
        entidadId = ent._id;
      }

      // Resolver SUBCESIÓN por NOMBRE (GLOBAL) cuando no hay ID
      if (!subCesionId && rawSubNm) {
        const sub = await buscarOCrearSubPorNombre(rawSubNm); // crea si falta
        subCesionId = sub ? sub._id : null;
      }

      // Validaciones por fila
      const rowErr = [];
      if (!Number.isFinite(dni) || dni <= 0) rowErr.push("DNI inválido");
      if (!entidadId) rowErr.push("Entidad inválida/ausente (por ID o NOMBRE)");
      if (!subCesionId)
        rowErr.push("SubCesión inválida/ausente (por ID o NOMBRE)");
      if (!fechaJS || isNaN(fechaJS)) rowErr.push("Fecha inválida");
      if (!Number.isFinite(montoNum) || montoNum <= 0)
        rowErr.push("Monto inválido");

      if (rowErr.length) {
        errores.push({
          fila: i,
          dni: Number.isFinite(dni) ? dni : String(rawDni ?? ""),
          entidad: entidadId
            ? entLabel(entidadId)
            : rawEntNm || String(rawEntId || ""),
          subCesion: subCesionId
            ? subLabel(subCesionId)
            : rawSubNm || String(rawSubId || ""),
          fecha: toISODate(rawFec),
          monto: String(rawMon ?? ""),
          error: rowErr.join(" | "),
        });
        continue;
      }

      // Buscar proyección activa por (dni, entidadId, subCesionId)
      const proy = await getActiva(dni, entidadId, subCesionId);
      if (!proy) {
        errores.push({
          fila: i,
          dni,
          entidad: entLabel(entidadId),
          subCesion: subLabel(subCesionId),
          fecha: fechaJS.toISOString().slice(0, 10),
          monto: montoNum,
          error: "No existe promesa activa para DNI + Entidad + SubCesión",
        });
        continue;
      }

      // Duplicado
      if (esDuplicado(proy, fechaJS, montoNum)) {
        errores.push({
          fila: i,
          dni,
          entidad: entLabel(entidadId),
          subCesion: subLabel(subCesionId),
          fecha: fechaJS.toISOString().slice(0, 10),
          monto: montoNum,
          error: "Pago duplicado (mismo día y monto ya cargado)",
        });
        continue;
      }

      // Insertar pago informado (NO descuenta deuda real)
      proy.pagosInformados = proy.pagosInformados || [];
      proy.pagosInformados.push({
        fecha: fechaJS,
        monto: montoNum,
        operadorId: req.user.id, // quién importó
        visto: false,
        erroneo: false,
        observacion: rawObs ? String(rawObs) : undefined,
      });

      if (!PAGOS_FUENTE_UNICA_ACTIVA) {
        proy.importePagado = calcularTotalInformado(proy);
      }
      proy.ultimaModificacion = new Date();
      await proy.save();
      if (!PAGOS_FUENTE_UNICA_ACTIVA) {
        await actualizarEstadoAutomaticamente(proy);
      }

      ok++;
    }

    // ---- Respuesta según errores ----
    if (errores.length > 0) {
      const wbErr = new ExcelJS.Workbook();
      const wsErr = wbErr.addWorksheet("Errores");
      wsErr.columns = [
        { header: "Fila", key: "fila", width: 8 },
        { header: "DNI", key: "dni", width: 14 },
        { header: "Entidad", key: "entidad", width: 26 },
        { header: "SubCesión", key: "subCesion", width: 26 },
        { header: "Fecha", key: "fecha", width: 12 },
        { header: "Monto", key: "monto", width: 14 },
        { header: "Error", key: "error", width: 70 },
      ];
      errores.forEach((e) => wsErr.addRow(e));

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="errores_importacion_pagos.xlsx"'
      );
      // 200 con attachment (el front detecta por content-type)
      await wbErr.xlsx.write(res);
      return res.end();
    }

    // ✅ OK total
    return res.status(200).json({
      ok: true,
      procesados: ok,
      mensaje: `Pagos importados correctamente: ${ok}`,
    });
  } catch (e) {
    console.error("❌ importarPagosMasivo:", e);
    return res.status(500).json({ error: "Error al importar pagos" });
  }
};


export const eliminarProyeccionesMasivo = async (req, res) => {
  try {
    if (!esGestorGlobal(req)) return res.status(403).json({ error: "Solo Supervisión o super-admin pueden eliminar proyecciones masivamente" });
    const confirmacion = String(req.body?.confirmacion || "").trim();
    if (confirmacion !== "ELIMINAR PROYECCIONES") {
      return res.status(400).json({ error: "Confirmación inválida" });
    }
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const filtros = req.body?.filtros || {};
    if (!ids.length && !Object.values(filtros).some((value) => value !== "" && value != null && value !== false)) {
      return res.status(400).json({ error: "Debés seleccionar filas o aplicar al menos un filtro" });
    }
    if (ids.length > 1000) return res.status(400).json({ error: "Máximo 1000 proyecciones seleccionadas por operación" });
    const query = construirQueryProyeccionesAdmin(filtros, { ids });
    const result = await Proyeccion.deleteMany(query);
    return res.json({ ok: true, eliminadas: Number(result.deletedCount || 0) });
  } catch (error) {
    console.error("eliminarProyeccionesMasivo:", error);
    return res.status(500).json({ error: "No se pudieron eliminar las proyecciones" });
  }
};

export const exportarProyeccionesExcel = async (req, res) => {
  try {
    const {
      estado,
      concepto,
      entidadId,
      subCesionId,
      buscar,
      orden = "desc",
      usuarioId,
      // fechas (nuevo + compat)
      tipoFecha,
      fechaDesde,
      fechaHasta,
      desde,
      hasta,
      ids,
    } = req.query;

    if (!tieneAccesoProyecciones(req)) {
      return res.status(403).json({ error: "Sin acceso a exportación" });
    }

    // etiquetas: Entidad "n - NOMBRE" / SubCesión "NOMBRE"
    const buildLabelMaps = async () => {
      const [ents, subs] = await Promise.all([
        Entidad.find({}, "nombre numero").sort({ numero: 1, nombre: 1 }).lean(),
        SubCesion.find({}, "nombre").sort({ nombre: 1 }).lean(),
      ]);
      const entLabelById = new Map(); // id -> "n - NOMBRE"
      const subNameById = new Map(); // id -> "NOMBRE"
      ents.forEach((e) =>
        entLabelById.set(
          String(e._id),
          Number.isFinite(Number(e.numero)) ? `${e.numero} - ${e.nombre}` : e.nombre
        )
      );
      subs.forEach((s) => subNameById.set(String(s._id), s.nombre));
      const entLabel = (id, fallbackName) =>
        id
          ? entLabelById.get(String(id)) ||
            (fallbackName ? `- ${fallbackName}` : "")
          : fallbackName || "";
      const subLabel = (id, fallbackName) =>
        id
          ? subNameById.get(String(id)) || fallbackName || ""
          : fallbackName || "";
      return { entLabel, subLabel };
    };
    const { entLabel, subLabel } = await buildLabelMaps();

    // Filtros base (según rol)
    const filtros = [];
    const idsSeleccionados = String(ids || "").split(",").map((value) => value.trim()).filter((value) => mongoose.isValidObjectId(value));
    if (idsSeleccionados.length) filtros.push({ _id: { $in: idsSeleccionados } });
    if (esAmbitoGlobal(req)) {
      if (usuarioId) filtros.push({ empleadoId: usuarioId });
    } else {
      filtros.push({ empleadoId: req.user.id });
    }

    if (estado) filtros.push({ estado });
    if (concepto) filtros.push({ concepto });
    if (entidadId) filtros.push({ entidadId });
    if (subCesionId) filtros.push({ subCesionId });

    // Rango de fechas (fechaPromesa/creado/modificado)
    const _fechaDesde = fechaDesde || desde;
    const _fechaHasta = fechaHasta || hasta;
    if (
      tipoFecha &&
      _fechaDesde &&
      _fechaHasta &&
      !isNaN(Date.parse(_fechaDesde)) &&
      !isNaN(Date.parse(_fechaHasta))
    ) {
      const rango = rangoFechaProyeccion(_fechaDesde, _fechaHasta, tipoFecha);
      if (rango.campo) {
        filtros.push({
          [rango.campo]: { $gte: rango.inicio, $lte: rango.fin },
        });
      }
    }

    // Buscar (texto / DNI / ObjectId de entidad o subcesión)
    if (buscar) {
      const buscarStr = String(buscar).trim();
      const regex = new RegExp(buscarStr, "i");
      const posibleDni = parseInt(buscarStr, 10);
      const condiciones = [
        { nombreTitular: regex },
        { concepto: regex },
        { estado: regex },
      ];
      if (!isNaN(posibleDni)) condiciones.push({ dni: posibleDni });
      if (mongoose.isValidObjectId(buscarStr)) {
        condiciones.push({ entidadId: buscarStr });
        condiciones.push({ subCesionId: buscarStr });
      }
      filtros.push({ $or: condiciones });
    }

    const queryFinal = filtros.length ? { $and: filtros } : {};

    const proyecciones = await Proyeccion.find(queryFinal)
      .populate("empleadoId", "username")
      .populate("entidadId", "nombre")
      .populate("subCesionId", "nombre")
      .sort({ fechaPromesa: orden === "asc" ? 1 : -1 });

    // ---------- Excel ----------
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
      { header: "Entidad", key: "entidad", width: 24 },
      { header: "SubCesión", key: "subCesion", width: 24 },
      { header: "Fecha Promesa", key: "fechaPromesa", width: 15 },
      {
        header: "Fecha Próximo Llamado",
        key: "fechaProximoLlamado",
        width: 20,
      },
      { header: "Creado", key: "creado", width: 15 },
      { header: "Última Modificación", key: "ultimaModificacion", width: 20 },
      { header: "Gestiones", key: "vecesTocada", width: 12 },
      { header: "Última Gestión", key: "ultimaGestion", width: 18 },
      { header: "Observaciones", key: "observaciones", width: 30 },
    ];

    // Formato numérico de dinero
    const moneyFmt = "#,##0.00";
    ["importe", "importePagado"].forEach((k) => {
      const col = worksheet.getColumn(k);
      col.numFmt = moneyFmt;
      col.alignment = { horizontal: "right" };
    });

    // Normaliza a número (acepta "7,2" -> 7.2, etc.)
    const toNumber = (v) => {
      if (v === null || v === undefined) return 0;
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const s = v.replace(/\s/g, "").replace(",", ".");
        const n = Number(s);
        return isNaN(n) ? 0 : n;
      }
      const n = Number(v);
      return isNaN(n) ? 0 : n;
    };

    proyecciones.forEach((p) => {
      worksheet.addRow({
        creadoPor: p.empleadoId?.username || "-",
        dni: p.dni,
        nombreTitular: p.nombreTitular,
        importe: toNumber(p.importe),
        importePagado: toNumber(p.importePagado),
        estado: p.estado,
        concepto: p.concepto,
        entidad: entLabel(p.entidadId?._id || p.entidadId, p.entidadId?.nombre),
        subCesion: subLabel(
          p.subCesionId?._id || p.subCesionId,
          p.subCesionId?.nombre
        ),
        fechaPromesa: formatearFecha(p.fechaPromesa),
        fechaProximoLlamado: formatearFecha(p.fechaProximoLlamado),
        creado: formatearFechaArgentina(p.creado),
        ultimaModificacion: formatearFechaArgentina(p.ultimaModificacion),
        vecesTocada: p.vecesTocada ?? 0,
        ultimaGestion: formatearFechaArgentina(p.ultimaGestion),
        observaciones: p.observaciones,
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=proyecciones.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("❌ Error al exportar Excel:", error);
    res.status(500).json({ error: "Error al exportar a Excel" });
  }
};

export const exportarPagosExcel = async (req, res) => {
  try {
    const {
      estado,
      concepto,
      entidadId,
      subCesionId,
      tipoFecha = "fechaPromesa",
      fechaDesde,
      fechaHasta,
      buscar,
      usuarioId, // opcional: para que super-admin filtre por usuario
      orden = "desc",
      soloNoErroneos = "false",
    } = req.query;

    // --- filtros sobre PROYECCIONES ---
    const filtros = [];

    // operador: solo sus proyecciones
    if (!tieneAccesoProyecciones(req)) {
      return res.status(403).json({ error: "Sin acceso a exportación" });
    }
    if (esAmbitoPropio(req)) {
      filtros.push({ empleadoId: req.user.id });
    } else if (usuarioId) {
      // super-admin: puede pasar usuarioId para filtrar
      filtros.push({ empleadoId: usuarioId });
    }

    if (estado) filtros.push({ estado });
    if (concepto) filtros.push({ concepto });
    if (entidadId) filtros.push({ entidadId });
    if (subCesionId) filtros.push({ subCesionId });

    // rango por el campo seleccionado (promesa/creado/modificado)
    let rangoDesde = null,
      rangoHasta = null;
    if (
      fechaDesde &&
      fechaHasta &&
      !isNaN(Date.parse(fechaDesde)) &&
      !isNaN(Date.parse(fechaHasta))
    ) {
      const rango = rangoFechaProyeccion(fechaDesde, fechaHasta, tipoFecha);
      rangoDesde = rango.inicio;
      rangoHasta = rango.fin;
      filtros.push({ [rango.campo]: { $gte: rangoDesde, $lte: rangoHasta } });
    }

    // búsqueda libre
    if (buscar) {
      const regex = new RegExp(buscar, "i");
      const posibleDni = parseInt(buscar);
      const condiciones = [
        { nombreTitular: regex },
        { concepto: regex },
        { estado: regex },
      ];
      if (!isNaN(posibleDni)) condiciones.push({ dni: posibleDni });
      filtros.push({ $or: condiciones });
    }

    const queryProy = filtros.length ? { $and: filtros } : {};

    const proyecciones = await Proyeccion.find(queryProy)
      .populate("empleadoId", "username")
      .populate("pagosInformados.operadorId", "username nombre email")
      .sort({ fechaPromesa: orden === "asc" ? 1 : -1 })
      .lean();

    // rango por FECHA DE PAGO (usa el mismo rango si vino)
    const pagosDesde = rangoDesde;
    const pagosHasta = rangoHasta;
    const excluirErroneos = String(soloNoErroneos).toLowerCase() === "true";

    // etiquetas: Entidad "n - NOMBRE" / SubCesión "NOMBRE"
    const buildLabelMaps = async () => {
      const [ents, subs] = await Promise.all([
        Entidad.find({}, "nombre numero").sort({ numero: 1, nombre: 1 }).lean(),
        SubCesion.find({}, "nombre").sort({ nombre: 1 }).lean(),
      ]);
      const entLabelById = new Map(); // id -> "n - NOMBRE"
      const subNameById = new Map(); // id -> "NOMBRE"
      ents.forEach((e) =>
        entLabelById.set(
          String(e._id),
          Number.isFinite(Number(e.numero)) ? `${e.numero} - ${e.nombre}` : e.nombre
        )
      );
      subs.forEach((s) => subNameById.set(String(s._id), s.nombre));
      const entLabel = (id, fallbackName) =>
        id
          ? entLabelById.get(String(id)) ||
            (fallbackName ? `- ${fallbackName}` : "")
          : fallbackName || "";
      const subLabel = (id, fallbackName) =>
        id
          ? subNameById.get(String(id)) || fallbackName || ""
          : fallbackName || "";
      return { entLabel, subLabel };
    };
    const { entLabel, subLabel } = await buildLabelMaps();

    // --- armar Excel ---
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Pagos informados");

    ws.columns = [
      { header: "Creado por", key: "creadoPor", width: 20 },
      { header: "Estado promesa", key: "estado", width: 18 },
      { header: "Entidad", key: "entidad", width: 26 }, // "n - NOMBRE"
      { header: "SubCesión", key: "subCesion", width: 26 }, // "NOMBRE"
      { header: "DNI", key: "dni", width: 14 },
      { header: "Titular", key: "titular", width: 24 },
      { header: "Importe promesa", key: "importe", width: 16 },
      { header: "Fecha promesa", key: "fechaPromesa", width: 14 },
      { header: "Fecha pago", key: "fechaPago", width: 14 },
      { header: "Monto pago", key: "montoPago", width: 14 },
      { header: "Erróneo", key: "erroneo", width: 10 },
      { header: "Operador", key: "operador", width: 20 },
    ];

    for (const p of proyecciones) {
      const base = {
        creadoPor: p.empleadoId?.username || "-",
        estado: p.estado,
        entidad: entLabel(p.entidadId),
        subCesion: subLabel(p.subCesionId),
        dni: p.dni,
        titular: p.nombreTitular,
        importe: p.importe,
        fechaPromesa: formatearFecha(p.fechaPromesa),
      };

      const pagos = (p.pagosInformados || [])
        .filter((pg) => !excluirErroneos || !pg.erroneo)
        .filter((pg) => {
          if (!pagosDesde || !pagosHasta) return true;
          const f = new Date(pg.fecha);
          return f >= pagosDesde && f <= pagosHasta;
        })
        .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

      for (const pago of pagos) {
        const op = pago?.operadorId || {};
        const nombreOp = op.username || op.nombre || op.email || "-";
        ws.addRow({
          ...base,
          fechaPago: formatearFecha(pago.fecha),
          montoPago: pago.monto,
          erroneo: pago.erroneo ? "Sí" : "No",
          operador: nombreOp,
        });
      }
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=pagos_informados.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("❌ Error al exportar pagos:", error);
    res.status(500).json({ error: "Error al exportar pagos a Excel" });
  }
};

export const importarProyeccionesMasivo = async (req, res) => {
  try {
    if (!esGestorGlobal(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    if (!req.file || !req.file.buffer) {
      return res
        .status(400)
        .json({ error: "Subí un archivo .xlsx en el campo 'file'." });
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws)
      return res.status(400).json({ error: "El archivo no tiene hojas." });

    // Mapa de encabezados en MAYÚSCULAS (se conservan tildes y guiones)
    const headerMap = new Map();
    ws.getRow(1).eachCell((cell, colNumber) => {
      headerMap.set(
        colNumber,
        String(cell.value || "")
          .trim()
          .toUpperCase()
      );
    });

    // Requeridos base (Entidad / SubCesión)
    const headersPresent = new Set(Array.from(headerMap.values()));
    const ENTIDAD_KEYS = ["ENTIDAD", "EMPRESA"];
    const SUBCESION_KEYS = [
      "SUBCESION",
      "SUBCESIÓN",
      "SUB CESION",
      "SUB CESIÓN",
      "SUB-CESION",
      "SUB-CESIÓN",
    ];

    const hasEntidad = ENTIDAD_KEYS.some((k) => headersPresent.has(k));
    const hasSub = SUBCESION_KEYS.some((k) => headersPresent.has(k));

    const faltan = [
      hasEntidad ? null : "ENTIDAD",
      hasSub ? null : "SUBCESION",
      headersPresent.has("CONCEPTO") ? null : "CONCEPTO",
      headersPresent.has("DNI") ? null : "DNI",
      headersPresent.has("NOMBRE") ? null : "NOMBRE",
      headersPresent.has("FECHA DE PROMESA") ? null : "FECHA DE PROMESA",
      headersPresent.has("IMPORTE") ? null : "IMPORTE",
    ].filter(Boolean);

    if (faltan.length) {
      return res
        .status(400)
        .json({ error: `Faltan columnas obligatorias: ${faltan.join(", ")}` });
    }

    // Opcional: columna de asignación de empleado
    const CANDIDATOS_EMPLEADO = new Set([
      "EMPLEADO",
      "USUARIO",
      "OPERADOR",
      "ASIGNADO A",
      "ASIGNADO_A",
      "ASIGNADO",
      "CREADO POR",
      "CREADO_POR",
    ]);

    const getField = (obj, variants) => {
      for (const k of variants) if (k in obj) return obj[k];
      return undefined;
    };

    // helper: quitar prefijo "n - " de selects
    const parseSelectLabel = (v) => {
      if (v == null) return "";
      const s = String(v).trim();
      const m = s.match(/^\s*(?:[0-9a-f]{24}|\d+)\s*-\s*(.+)$/i);
      return (m ? m[1] : s).trim();
    };

    // Parsear filas
    const rows = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj = {};
      row.eachCell((cell, colNumber) => {
        obj[headerMap.get(colNumber)] = cell.value;
      });
      const hasData = Object.values(obj).some(
        (v) => v != null && String(v).trim() !== ""
      );
      if (hasData) rows.push({ rowNumber, ...obj });
    });

    const errores = [];
    const advertencias = [];
    const resultados = [];

    // ====== Caches DB ======
    // Empleados
    const empleados = await Empleado.find({}, "username email").lean();
    const byUsername = new Map(
      empleados.map((e) => [
        String(e.username || "")
          .trim()
          .toLowerCase(),
        e._id,
      ])
    );
    const byEmail = new Map(
      empleados.map((e) => [
        String(e.email || "")
          .trim()
          .toLowerCase(),
        e._id,
      ])
    );
    const resolverEmpleado = (valorCrudo) => {
      if (valorCrudo == null) return null;
      const s = String(valorCrudo).trim().toLowerCase();
      if (!s) return null;
      if (byUsername.has(s)) return byUsername.get(s);
      if (byEmail.has(s)) return byEmail.get(s);
      if (mongoose.isValidObjectId(s)) return s;
      return null;
    };

    // Entidad / SubCesión
    const normTxt = (s) =>
      String(s || "")
        .trim()
        .toUpperCase();

    const cacheEntidades = new Map(); // nombre → doc
    const cacheSubs = new Map(); // nombre → doc  (GLOBAL por nombre)

    // Entidad: NO crear si no existe
    const getEntidad = async (nombre) => {
      const key = normTxt(nombre);
      if (cacheEntidades.has(key)) return cacheEntidades.get(key);
      const ent = await Entidad.findOne({ nombre: key });
      cacheEntidades.set(key, ent || null);
      return ent;
    };

    // SubCesión GLOBAL por nombre — crea si no existe
    const getSubCesion = async (nombre) => {
      const key = normTxt(nombre);
      if (cacheSubs.has(key)) return cacheSubs.get(key);
      let sub = await SubCesion.findOne({ nombre: key });
      if (!sub) sub = await SubCesion.create({ nombre: key }); // unique:true en nombre
      cacheSubs.set(key, sub);
      return sub;
    };

    // Proyección activa por (dni, entidadId, subCesionId)
    const activaCache = new Map(); // `${dni}::${entId}::${subId}` → doc/null
    const keyPair = (dni, entidadId, subId) => `${dni}::${entidadId}::${subId}`;
    const getActivaDeDB = async (dni, entidadId, subCesionId) => {
      const k = keyPair(dni, entidadId, subCesionId);
      if (activaCache.has(k)) return activaCache.get(k);
      const proy = await Proyeccion.findOne({
        dni,
        entidadId,
        subCesionId,
        $or: [{ isActiva: true }, { isActiva: { $exists: false } }],
      }).sort({ creado: -1 });
      activaCache.set(k, proy || null);
      return proy;
    };

    // Evitar duplicados dentro del archivo
    const creadasEnCorrida = new Map(); // key → { doc, filaCreacion }

    for (const r of rows) {
      const fila = r.rowNumber;
      try {
        const entidadNombre = parseSelectLabel(getField(r, ENTIDAD_KEYS));
        const subNombre = parseSelectLabel(getField(r, SUBCESION_KEYS));
        const concepto = String(r["CONCEPTO"] || "").trim();
        const dniRaw = String(r["DNI"] || "").trim();
        const nombre = String(r["NOMBRE"] || "").trim();
        const tel = String(r["TELEFONO"] || r["TELÉFONO"] || "").trim();
        const fechaProm = parseExcelDate(r["FECHA DE PROMESA"]);
        const fechaProx = parseExcelDate(r["PROX LLAMADO"]);
        const importe = Number(r["IMPORTE"] || 0);

        // Asignación
        let asignTexto = "";
        for (const key of CANDIDATOS_EMPLEADO) {
          if (r[key] != null && String(r[key]).trim() !== "") {
            asignTexto = String(r[key]).trim();
            break;
          }
        }
        let ownerId = req.user.id; // por defecto: el importador
        if (asignTexto) {
          const resuelto = resolverEmpleado(asignTexto);
          if (resuelto) ownerId = resuelto;
          else {
            advertencias.push({
              fila,
              dni: dniRaw,
              entidad: entidadNombre,
              subCesion: subNombre,
              motivo: `Empleado "${asignTexto}" no encontrado. Se asignó al importador.`,
            });
          }
        }

        // Validaciones
        if (!entidadNombre) throw new Error("ENTIDAD es obligatoria");
        if (!subNombre) throw new Error("SUBCESION es obligatoria");
        if (!concepto) throw new Error("CONCEPTO es obligatorio");
        if (!dniRaw) throw new Error("DNI es obligatorio");
        if (!nombre) throw new Error("NOMBRE es obligatorio");
        if (!fechaProm)
          throw new Error("FECHA DE PROMESA inválida/obligatoria");
        if (!Number.isFinite(importe) || importe <= 0)
          throw new Error("IMPORTE inválido (>0)");

        const dni = Number(String(dniRaw).replace(/\D/g, ""));
        if (!Number.isFinite(dni) || dni <= 0) throw new Error("DNI inválido");

        // Resolver Entidad (NO crear). Si no existe → error
        const entidad = await getEntidad(entidadNombre);
        if (!entidad) {
          throw new Error(
            `Entidad "${entidadNombre}" inexistente (debe crearse previamente)`
          );
        }

        // SubCesión GLOBAL (por nombre)
        const sub = await getSubCesion(subNombre);

        const anio = fechaProm.getUTCFullYear();
        const mes = fechaProm.getUTCMonth() + 1;

        const k = keyPair(dni, entidad._id, sub._id);

        // 1) Duplicado en el mismo archivo
        if (creadasEnCorrida.has(k)) {
          const { doc, filaCreacion } = creadasEnCorrida.get(k);
          doc.nombreTitular = nombre || doc.nombreTitular;
          doc.concepto = concepto || doc.concepto;
          if (tel) doc.telefono = tel;
          doc.fechaPromesa = fechaProm;
          doc.fechaProximoLlamado = fechaProx || undefined;
          doc.fechaPromesaInicial = doc.fechaPromesaInicial || fechaProm;
          doc.importe = importe;
          doc.estado = clasificarEstado(fechaProm);
          doc.anio = anio;
          doc.mes = mes;
          doc.empleadoId = ownerId;
          doc.entidadNumero = Number(entidad.numero);
          doc.origen = "control-personal";
          doc.ultimaModificacion = new Date();
          await doc.save();

          advertencias.push({
            fila,
            dni,
            entidad: entidad.nombre,
            subCesion: sub.nombre,
            motivo: `Duplicado en el archivo. Se ACTUALIZÓ la proyección creada en la fila ${filaCreacion}.`,
          });
          resultados.push({
            fila,
            dni,
            entidadId: String(entidad._id),
            subCesionId: String(sub._id),
            _id: String(doc._id),
            ok: true,
            actualizado: true,
          });
          continue;
        }

        // 2) Cerrar activa previa en DB (misma combinación)
        let activaPrevia = await getActivaDeDB(dni, entidad._id, sub._id);
        if (activaPrevia) {
          const estadoCierre = determinarEstadoCierre(activaPrevia);
          activaPrevia.isActiva = false;
          activaPrevia.estado = estadoCierre;
          activaPrevia.ultimaModificacion = new Date();
          await activaPrevia.save();
          activaCache.set(k, null);
          advertencias.push({
            fila,
            dni,
            entidad: entidad.nombre,
            subCesion: sub.nombre,
            motivo: `Se cerró la proyección activa previa (${activaPrevia._id}) como: ${estadoCierre}.`,
          });
        }

        // 3) Crear nueva activa
        const nueva = new Proyeccion({
          dni,
          nombreTitular: nombre,
          concepto,
          telefono: tel || undefined,
          fechaPromesa: fechaProm,
          fechaPromesaInicial: fechaProm,
          fechaProximoLlamado: fechaProx || undefined,
          importe,
          estado: clasificarEstado(fechaProm),
          anio,
          mes,
          isActiva: true,
          empleadoId: ownerId,
          creado: new Date(),
          ultimaModificacion: new Date(),
          entidadId: entidad._id,
          entidadNumero: Number(entidad.numero),
          subCesionId: sub._id,
          idProyeccionLogico: `${dni}-${entidad._id}-${sub._id}`,
          origen: "control-personal",
        });

        try {
          await nueva.save();
        } catch (e) {
          if (e?.code === 11000) {
            // Conflicto por única activa -> actualizar la activa
            const actual = await getActivaDeDB(dni, entidad._id, sub._id);
            if (actual) {
              actual.nombreTitular = nombre || actual.nombreTitular;
              actual.concepto = concepto || actual.concepto;
              if (tel) actual.telefono = tel;
              actual.fechaPromesa = fechaProm;
              actual.fechaProximoLlamado = fechaProx || undefined;
              actual.fechaPromesaInicial =
                actual.fechaPromesaInicial || fechaProm;
              actual.importe = importe;
              actual.estado = clasificarEstado(fechaProm);
              actual.anio = anio;
              actual.mes = mes;
              actual.empleadoId = ownerId;
              actual.entidadId = entidad._id;
              actual.entidadNumero = Number(entidad.numero);
              actual.subCesionId = sub._id;
              actual.origen = "control-personal";
              actual.idProyeccionLogico = `${dni}-${entidad._id}-${sub._id}`;
              actual.ultimaModificacion = new Date();
              await actual.save();

              creadasEnCorrida.set(k, { doc: actual, filaCreacion: fila });
              resultados.push({
                fila,
                dni,
                entidadId: String(entidad._id),
                subCesionId: String(sub._id),
                _id: String(actual._id),
                ok: true,
                actualizado: true,
              });
              continue;
            }
            throw e;
          } else {
            throw e;
          }
        }

        creadasEnCorrida.set(k, { doc: nueva, filaCreacion: fila });
        resultados.push({
          fila,
          dni,
          entidadId: String(entidad._id),
          subCesionId: String(sub._id),
          _id: String(nueva._id),
          ok: true,
        });
      } catch (e) {
        errores.push({
          fila,
          dni: r["DNI"],
          entidad: getField(r, ENTIDAD_KEYS),
          subCesion: getField(r, SUBCESION_KEYS),
          error: e.message || "Error inesperado",
        });
      }
    }

    // === Salida ===
    if (errores.length > 0 || advertencias.length > 0) {
      const wbOut = new ExcelJS.Workbook();
      const wsOut = wbOut.addWorksheet("Detalle importación");
      wsOut.columns = [
        { header: "Fila", key: "fila", width: 8 },
        { header: "DNI", key: "dni", width: 14 },
        { header: "Entidad", key: "entidad", width: 20 },
        { header: "SubCesión", key: "subCesion", width: 20 },
        { header: "Resultado", key: "resultado", width: 16 },
        { header: "Mensaje", key: "mensaje", width: 70 },
      ];
      for (const a of advertencias) {
        wsOut.addRow({
          fila: a.fila,
          dni: a.dni,
          entidad: a.entidad,
          subCesion: a.subCesion,
          resultado: "ADVERTENCIA",
          mensaje: a.motivo,
        });
      }
      for (const er of errores) {
        wsOut.addRow({
          fila: er.fila,
          dni: er.dni,
          entidad: er.entidad,
          subCesion: er.subCesion,
          resultado: "ERROR",
          mensaje: er.error,
        });
      }
      const buf = await wbOut.xlsx.writeBuffer();
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="resultado_importacion_proyecciones.xlsx"'
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.status(errores.length > 0 ? 207 : 200);
      return res.send(Buffer.from(buf));
    }

    return res.json({
      mensaje: "Proyecciones importadas correctamente",
      importados: resultados.length,
      advertencias: [],
    });
  } catch (err) {
    console.error("Error en importarProyeccionesMasivo:", err);
    res.status(500).json({ error: "Error interno al importar proyecciones" });
  }
};

/**
 * Referencia informativa: muestra acuerdos confirmados importados desde Mango
 * antes de guardar un control personal. No crea ni modifica proyecciones.
 */
export const buscarCoincidenciasAcuerdosMango = async (req, res) => {
  try {
    if (!tieneAccesoProyecciones(req)) {
      return res.status(403).json({ error: "Sin acceso" });
    }

    const dni = normalizarDni(req.query?.dni);
    const entidadCanonica = await resolverEntidadCanonica({
      entidadId: req.query?.entidadId,
      entidadNumero: req.query?.entidadNumero,
    });

    if (!dni || !entidadCanonica) {
      return res.status(400).json({
        error: "Para revisar acuerdos se necesita DNI y una entidad válida.",
      });
    }

    const variantes = variantesTextoEntidad(entidadCanonica.entidad);
    const filtrosEntidad = variantes.map(
      (valor) => new RegExp(`^${escapeRegexSafe(valor)}$`, "i")
    );

    const filtroControles = {
      dni: Number(dni),
      $or: [
        { entidadNumero: entidadCanonica.entidadNumero },
        { entidadId: entidadCanonica.entidadId },
      ],
    };
    if (esAmbitoPropio(req)) filtroControles.empleadoId = req.user.id;

    const [gestionesAcuerdo, controlesPersonales, mapasEntidad] = await Promise.all([
      ReporteGestion.find({
        dni,
        borrado: { $ne: true },
        resultadoGestion: /acuerdo/i,
        $or: [
          { entidadNumero: entidadCanonica.entidadNumero },
          { entidad: { $in: filtrosEntidad } },
        ],
      })
        .sort({ fecha: -1, hora: -1, _id: -1 })
        .limit(25)
        .select(
          "dni entidad entidadNumero nombreDeudor usuario fecha hora tipoContacto resultadoGestion estadoCuenta telMailMarcado observacionGestion"
        )
        .lean(),
      Proyeccion.find(filtroControles)
        .sort({ isActiva: -1, fechaPromesa: -1, createdAt: -1 })
        .limit(5)
        .populate("empleadoId", "username nombre")
        .populate("subCesionId", "nombre")
        .select(
          "dni nombreTitular importe concepto fechaPromesa fechaProximoLlamado estado isActiva observaciones origen empleadoId subCesionId"
        )
        .lean(),
      construirMapasEntidades(),
    ]);

    const acuerdos = gestionesAcuerdo
      .map((gestion) => mapearGestionAacuerdoMango(gestion, mapasEntidad.numeroPorNombre))
      .filter(Boolean)
      .slice(0, 5);

    return res.json({
      ok: true,
      coincidencias: acuerdos.length + controlesPersonales.length,
      coincidenciasMango: acuerdos.length,
      coincidenciasControles: controlesPersonales.length,
      entidad: {
        _id: entidadCanonica.entidadId,
        numero: entidadCanonica.entidadNumero,
        nombre: entidadCanonica.entidadNombre,
      },
      acuerdos,
      controlesPersonales,
      mensaje:
        acuerdos.length || controlesPersonales.length
          ? "Ya existe información para este DNI y entidad. Los acuerdos de Mango y los acuerdos manuales se mantienen separados."
          : "No se encontraron acuerdos de Mango ni acuerdos manuales para este DNI y entidad.",
    });
  } catch (error) {
    console.error("❌ Error buscando acuerdos Mango para proyección:", error);
    return res.status(500).json({ error: "No se pudo revisar los acuerdos confirmados" });
  }
};

/**
 * Conciliación de solo lectura. No cambia importePagado ni estado.
 * Permite validar la futura fuente única antes de activarla.
 */
export const obtenerConciliacionPagosProyeccion = async (req, res) => {
  try {
    const proyeccion = await Proyeccion.findById(req.params.id)
      .populate("entidadId", "numero nombre")
      .lean();
    if (!proyeccion) return res.status(404).json({ error: "Proyección no encontrada" });

    if (esAmbitoPropio(req) && !esDueno(req, proyeccion)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const entidadNumero =
      Number(proyeccion.entidadNumero) || Number(proyeccion.entidadId?.numero);
    const conciliacion = await buscarPagosReales({
      dni: proyeccion.dni,
      entidadNumero,
      subCesionId: proyeccion.subCesionId,
      fechaCorte:
        proyeccion.creado ||
        proyeccion.createdAt ||
        proyeccion.fechaPromesaInicial ||
        proyeccion.fechaPromesa,
    });

    return res.json({
      ok: true,
      modo: "solo-lectura",
      modificaSaldos: false,
      proyeccionId: proyeccion._id,
      importeComprometido: proyeccion.importe,
      importeInformadoHistorico: calcularTotalInformado(proyeccion),
      ...conciliacion,
    });
  } catch (error) {
    console.error("❌ Error conciliando pagos de proyección:", error);
    return res.status(500).json({ error: "No se pudo conciliar la proyección con Pagos" });
  }
};

let moduloPagosDisponibleCache = { value: null, at: 0 };
const MODULO_PAGOS_TTL_MS = 60_000;

const vincularAcuerdosMangoConPagos = async (acuerdos = []) => {
  if (!acuerdos.length) return acuerdos;
  const dnis = [...new Set(acuerdos.map((item) => normalizarDni(item.dni)).filter(Boolean))];
  const fechas = acuerdos.map((item) => new Date(item.fecha)).filter((date) => !Number.isNaN(date.getTime()));
  const fechaMinima = fechas.length ? new Date(Math.min(...fechas.map((date) => date.getTime()))) : null;
  const paymentQuery = { dni: { $in: dnis } };
  if (fechaMinima) paymentQuery.fechaPago = { $gte: new Date(fechaMinima.getTime() - 90 * 86400000) };

  const ahora = Date.now();
  const necesitaConsultarDisponibilidad =
    moduloPagosDisponibleCache.value == null ||
    ahora - moduloPagosDisponibleCache.at >= MODULO_PAGOS_TTL_MS;

  const [pagos, mapas, existeModuloPagos] = await Promise.all([
    dnis.length
      ? Pago.find(paymentQuery)
          .select("idPago dni entidadId subCesionId fechaPago monto conceptoCodigo estado operadorUsername operadorId")
          .sort({ fechaPago: 1, _id: 1 })
          .lean()
          .maxTimeMS(20000)
      : [],
    construirMapasEntidades(),
    necesitaConsultarDisponibilidad
      ? Pago.exists({}).then((value) => {
          moduloPagosDisponibleCache = { value: Boolean(value), at: Date.now() };
          return Boolean(value);
        })
      : moduloPagosDisponibleCache.value,
  ]);

  return vincularPagosPosteriores(acuerdos, pagos, mapas.entidades, {
    disponible: Boolean(existeModuloPagos),
    motivo: existeModuloPagos ? "" : "SIN_PAGOS_CARGADOS",
  });
};

const enriquecerAcuerdosMangoConPagosInformados = async (acuerdos = []) => {
  const ids = acuerdos
    .map((item) => String(item?._id || item?.id || ""))
    .filter((id) => mongoose.isValidObjectId(id));
  if (!ids.length) return acuerdos;

  const avisos = await PagoInformadoMango.find({
    acuerdoGestionId: { $in: ids },
    erroneo: { $ne: true },
  })
    .select("acuerdoGestionId fecha monto operadorId createdAt")
    .sort({ fecha: -1, createdAt: -1 })
    .lean()
    .maxTimeMS(15000);

  const resumenPorAcuerdo = new Map();
  for (const aviso of avisos) {
    const key = String(aviso.acuerdoGestionId || "");
    const actual = resumenPorAcuerdo.get(key) || {
      cantidad: 0,
      total: 0,
      ultimaFecha: null,
    };
    actual.cantidad += 1;
    actual.total += Number(aviso.monto || 0);
    if (!actual.ultimaFecha || new Date(aviso.fecha) > new Date(actual.ultimaFecha)) {
      actual.ultimaFecha = aviso.fecha;
    }
    resumenPorAcuerdo.set(key, actual);
  }

  return acuerdos.map((acuerdo) => ({
    ...acuerdo,
    pagosInformadosResumen:
      resumenPorAcuerdo.get(String(acuerdo?._id || acuerdo?.id || "")) || {
        cantidad: 0,
        total: 0,
        ultimaFecha: null,
      },
  }));
};

const normalizarEstadoMango = (valor = "") =>
  String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

/**
 * Traduce un acuerdo confirmado de Mango a los mismos estados operativos que
 * usa la tabla de acuerdos manuales. Los pagos informados no intervienen: solo
 * cuentan los pagos válidos conciliados con COBRINA.
 */
const calcularEstadoSeguimientoMango = (acuerdo = {}) => {
  const esperado = Number(
    acuerdo.primerPago || acuerdo.anticipoMonto || acuerdo.montoCuota || 0
  );
  const totalAcuerdo = Number(acuerdo.montoTotalAcuerdo || 0);
  const objetivo = esperado > 0 ? esperado : totalAcuerdo;
  const pagado = Number(
    acuerdo.montoPagosValidos ?? acuerdo.montoPagosPosteriores ?? 0
  );

  if (objetivo > 0 && pagado >= objetivo) return "Pagado";
  if (pagado > 0) return "Pagado parcial";

  const vencimientoRaw = acuerdo.anticipoVto || acuerdo.primerVto || null;
  const textoVencimiento = String(vencimientoRaw || "").trim();
  let vencimientoISO = "";

  const ymd = textoVencimiento.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const dmy = textoVencimiento.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (ymd) {
    vencimientoISO = `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  } else if (dmy) {
    vencimientoISO = `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  } else if (vencimientoRaw) {
    const fecha = new Date(vencimientoRaw);
    if (!Number.isNaN(fecha.getTime())) vencimientoISO = fecha.toISOString().slice(0, 10);
  }

  if (vencimientoISO) {
    const hoyISO = fechaClaveArgentina();
    if (vencimientoISO < hoyISO) return "Promesa caída";
  }

  return "Promesa activa";
};

const coincideEstadoMango = (acuerdo = {}, estadoSolicitado = "") => {
  const solicitado = normalizarEstadoMango(estadoSolicitado);
  if (!solicitado) return true;

  // Compatibilidad con nombres que pudieron quedar guardados en filtros viejos.
  const alias = {
    vencido: "promesa caida",
    caido: "promesa caida",
    "promesa vencida": "promesa caida",
    activo: "promesa activa",
    parcial: "pagado parcial",
  };
  const esperado = alias[solicitado] || solicitado;
  return normalizarEstadoMango(calcularEstadoSeguimientoMango(acuerdo)) === esperado;
};

/**
 * Construye la misma consulta para la vista y para el Excel de acuerdos Mango.
 * Los filtros se reciben desde el bloque general de Proyecciones; no existe un
 * segundo formulario independiente.
 */
const obtenerAcuerdosMangoFiltrados = async (req, { page = 1, limit = 20, paginar = false } = {}) => {
  const condiciones = [
    { borrado: { $ne: true } },
    { resultadoGestion: /acuerdo/i },
  ];

  const usuarioId = String(req.query?.usuarioId || "").trim();

  const desde = String(req.query?.fechaDesde || req.query?.desde || "").trim();
  const hasta = String(req.query?.fechaHasta || req.query?.hasta || "").trim();
  if (desde || hasta) {
    const rango = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(desde)) rango.$gte = crearFechaLocal(desde);
    if (/^\d{4}-\d{2}-\d{2}$/.test(hasta)) rango.$lte = crearFechaLocal(hasta, true);
    if (Object.keys(rango).length) condiciones.push({ fecha: rango });
  }

  const entidadId = String(req.query?.entidadId || "").trim();
  const entidadNumero = Number(req.query?.entidadNumero || 0);
  if (entidadId || entidadNumero > 0) {
    const canonica = await resolverEntidadCanonica({ entidadId, entidadNumero });
    if (canonica) {
      const variantes = variantesTextoEntidad(canonica.entidad).map(
        (valor) => new RegExp(`^${escapeRegexSafe(valor)}$`, "i")
      );
      condiciones.push({
        $or: [
          { entidadNumero: canonica.entidadNumero },
          { entidad: { $in: variantes } },
        ],
      });
    }
  }

  const concepto = String(req.query?.concepto || "").trim();
  if (concepto) {
    const regex = new RegExp(escapeRegexSafe(concepto), "i");
    condiciones.push({ $or: [{ resultadoGestion: regex }, { observacionGestion: regex }] });
  }

  // El estado de Mango no está guardado textualmente en ReporteGestion. Se
  // calcula después de cruzar fecha de vencimiento y pagos válidos, igual que
  // en acuerdos manuales. Por eso no se aplica como regex sobre MongoDB.
  const estadoFiltro = String(req.query?.estado || "").trim();

  const buscar = String(req.query?.buscar || "").trim();
  if (buscar) {
    const regex = new RegExp(escapeRegexSafe(buscar), "i");
    const busqueda = [
      { nombreDeudor: regex },
      { entidad: regex },
      { usuario: regex },
      { resultadoGestion: regex },
      { estadoCuenta: regex },
      { observacionGestion: regex },
    ];
    const dniLimpio = buscar.replace(/\D/g, "");
    if (dniLimpio) busqueda.push({ dni: dniLimpio }, { dni: Number(dniLimpio) });
    condiciones.push({ $or: busqueda });
  }

  // Estos accesos rápidos pertenecen a los controles manuales. En Mango no hay
  // próximo llamado ni un acuerdo "sin gestión" porque el acuerdo nace de una gestión.
  if (req.query?.llamadoHoy === "true" || req.query?.sinGestion === "true") {
    return {
      acuerdos: [],
      total: 0,
      paginadoEnMongo: false,
      filtrosNoCompatibles: [
        req.query?.llamadoHoy === "true" ? "Llamados de hoy" : "",
        req.query?.sinGestion === "true" ? "Sin gestión" : "",
      ].filter(Boolean),
    };
  }

  const query = condiciones.length === 1 ? condiciones[0] : { $and: condiciones };
  const subCesionId = String(req.query?.subCesionId || "").trim();

  // IMPORTANTE: la paginación se aplica DESPUÉS de resolver episodios efectivos.
  // Paginar las gestiones crudas en Mongo podía separar dos acuerdos del mismo
  // DNI/entidad en páginas distintas y hacer que una renegociación sin pago se
  // contara como acuerdo adicional. La cantidad de gestiones con acuerdo es muy
  // inferior al total de gestiones, por lo que resolver el conjunto filtrado y
  // recién luego paginar mantiene exactitud sin cargar el universo completo.
  const consultaGestiones = ReporteGestion.find(query)
    .sort({ fecha: -1, hora: -1, _id: -1 })
    .select(
      "dni entidad entidadNumero nombreDeudor usuario fecha hora tipoContacto resultadoGestion estadoCuenta telMailMarcado observacionGestion"
    )
    .lean()
    .maxTimeMS(30000);

  const [mapas, gestiones] = await Promise.all([
    construirMapasEntidades(),
    consultaGestiones,
  ]);

  let acuerdos = gestiones
    .map((gestion) => mapearGestionAacuerdoMango(gestion, mapas.numeroPorNombre))
    .filter(Boolean);

  if (!acuerdos.length) {
    return {
      acuerdos: [],
      total: 0,
      paginadoEnMongo: false,
      filtrosNoCompatibles: [],
    };
  }

  acuerdos = resolverEpisodiosAcuerdos(await vincularAcuerdosMangoConPagos(acuerdos)).rows;

  const variantesObjetivo = await variantesOperadorObjetivo(req, usuarioId);
  acuerdos = acuerdos.filter((acuerdo) => acuerdoPerteneceAOperador(acuerdo, variantesObjetivo));

  if (subCesionId) {
    acuerdos = acuerdos.filter((acuerdo) =>
      (acuerdo.pagosValidos || []).some((pago) => String(pago.subCesionId || "") === subCesionId)
    );
  }

  acuerdos = acuerdos
    .map((acuerdo) => ({
      ...acuerdo,
      estadoSeguimiento: calcularEstadoSeguimientoMango(acuerdo),
    }))
    .filter((acuerdo) => coincideEstadoMango(acuerdo, estadoFiltro));

  acuerdos = await enriquecerAcuerdosMangoConPagosInformados(acuerdos);

  return {
    acuerdos,
    total: acuerdos.length,
    paginadoEnMongo: false,
    filtrosNoCompatibles: [],
  };
};

const acuerdosMangoListadoCache = new Map();
const ACUERDOS_MANGO_LISTADO_TTL_MS = 30_000;
const ACUERDOS_MANGO_LISTADO_CACHE_MAX = 40;

const claveCacheAcuerdosMango = (req, page, limit) => {
  const queryOrdenada = Object.keys(req.query || {})
    .sort()
    .reduce((acc, key) => {
      const value = req.query[key];
      if (value !== "" && value != null && value !== false) acc[key] = value;
      return acc;
    }, {});
  return JSON.stringify({
    user: req.user?.id || "",
    role: req.user?.role || "",
    page,
    limit,
    query: queryOrdenada,
  });
};

const guardarCacheAcuerdosMango = (key, payload) => {
  if (acuerdosMangoListadoCache.size >= ACUERDOS_MANGO_LISTADO_CACHE_MAX) {
    const firstKey = acuerdosMangoListadoCache.keys().next().value;
    if (firstKey) acuerdosMangoListadoCache.delete(firstKey);
  }
  acuerdosMangoListadoCache.set(key, { at: Date.now(), payload });
};

/**
 * Listado de solo lectura de los acuerdos confirmados importados desde Mango.
 * Se muestra dentro de Proyecciones, pero nunca crea ni modifica controles
 * manuales. Los perfiles de alcance propio ven solamente sus acuerdos.
 */
export const listarAcuerdosMangoParaProyecciones = async (req, res) => {
  try {
    if (!tieneAccesoProyecciones(req)) {
      return res.status(403).json({ error: "Sin acceso a Proyecciones" });
    }

    const page = Math.max(1, Number.parseInt(req.query?.page, 10) || 1);
    const limit = Math.min(100, Math.max(5, Number.parseInt(req.query?.limit, 10) || 20));
    const cacheKey = claveCacheAcuerdosMango(req, page, limit);
    const cached = acuerdosMangoListadoCache.get(cacheKey);
    if (cached && Date.now() - cached.at < ACUERDOS_MANGO_LISTADO_TTL_MS) {
      return res.json({ ...cached.payload, cache: "hit" });
    }

    const {
      acuerdos,
      filtrosNoCompatibles,
      total: totalCalculado,
      paginadoEnMongo,
    } = await obtenerAcuerdosMangoFiltrados(req, { page, limit, paginar: true });
    const total = Number(totalCalculado ?? acuerdos.length);
    const items = paginadoEnMongo
      ? acuerdos
      : acuerdos.slice((page - 1) * limit, page * limit);

    const payload = {
      ok: true,
      modo: "solo-lectura",
      fuente: "reporte-de-gestiones",
      separadosDeControlesManuales: true,
      alcance: esAmbitoGlobal(req) ? "todos" : "propios",
      filtrosGeneralesAplicados: true,
      filtrosNoCompatibles,
      items,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      limit,
      paginadoOptimizado: Boolean(paginadoEnMongo),
    };
    guardarCacheAcuerdosMango(cacheKey, payload);
    return res.json(payload);
  } catch (error) {
    console.error("❌ Error listando acuerdos Mango en Proyecciones:", error);
    return res.status(500).json({ error: "No se pudieron cargar los acuerdos confirmados de Mango" });
  }
};

const obtenerAcuerdoMangoAutorizado = async (req, acuerdoId) => {
  if (!mongoose.isValidObjectId(acuerdoId)) return { error: "Acuerdo Mango inválido", status: 400 };
  const gestion = await ReporteGestion.findOne({
    _id: acuerdoId,
    borrado: { $ne: true },
    resultadoGestion: /acuerdo/i,
  })
    .select(
      "dni entidad entidadNumero nombreDeudor usuario fecha hora tipoContacto resultadoGestion estadoCuenta telMailMarcado observacionGestion"
    )
    .lean();
  if (!gestion) return { error: "Acuerdo Mango no encontrado", status: 404 };

  const { numeroPorNombre } = await construirMapasEntidades();
  let acuerdo = mapearGestionAacuerdoMango(gestion, numeroPorNombre);
  if (!acuerdo) return { error: "No se pudo interpretar el acuerdo Mango", status: 422 };
  [acuerdo] = await vincularAcuerdosMangoConPagos([acuerdo]);

  if (esAmbitoPropio(req)) {
    const variantes = await variantesOperadorObjetivo(req);
    if (!acuerdoPerteneceAOperador(acuerdo, variantes)) {
      return { error: "No tenés permiso sobre este acuerdo Mango", status: 403 };
    }
  }

  return { acuerdo, gestion };
};

export const informarPagoAcuerdoMango = async (req, res) => {
  try {
    if (!tieneAccesoProyecciones(req)) return res.status(403).json({ error: "Sin acceso" });
    const acceso = await obtenerAcuerdoMangoAutorizado(req, req.params.id);
    if (acceso.error) return res.status(acceso.status).json({ error: acceso.error });

    const fecha = parseExcelDate(req.body?.fecha);
    const monto = Number(req.body?.monto);
    if (!fecha || Number.isNaN(fecha.getTime())) return res.status(400).json({ error: "Fecha inválida" });
    if (!Number.isFinite(monto) || monto <= 0) return res.status(400).json({ error: "Monto inválido" });

    const inicio = inicioDiaCalendarioUTC(fecha);
    const fin = finDiaCalendarioUTC(fecha);
    const duplicado = await PagoInformadoMango.exists({
      acuerdoGestionId: req.params.id,
      fecha: { $gte: inicio, $lte: fin },
      monto,
      erroneo: { $ne: true },
    });
    if (duplicado) {
      return res.status(409).json({ error: "Pago duplicado (misma fecha y monto ya informados)." });
    }

    const creado = await PagoInformadoMango.create({
      acuerdoGestionId: req.params.id,
      fecha,
      monto,
      operadorId: req.user.id,
    });
    acuerdosMangoListadoCache.clear();

    const pago = await PagoInformadoMango.findById(creado._id)
      .populate("operadorId", "username nombre email")
      .lean();
    return res.status(201).json({
      ok: true,
      mensaje: "Pago informado como dato orientativo. No modifica el pago válido.",
      pago,
    });
  } catch (error) {
    console.error("❌ Error informando pago de acuerdo Mango:", error);
    return res.status(500).json({ error: "No se pudo informar el pago del acuerdo Mango" });
  }
};

export const listarPagosInformadosAcuerdoMango = async (req, res) => {
  try {
    if (!tieneAccesoProyecciones(req)) return res.status(403).json({ error: "Sin acceso" });
    const acceso = await obtenerAcuerdoMangoAutorizado(req, req.params.id);
    if (acceso.error) return res.status(acceso.status).json({ error: acceso.error });

    const pagos = await PagoInformadoMango.find({ acuerdoGestionId: req.params.id })
      .sort({ fecha: -1, createdAt: -1 })
      .populate("operadorId", "username nombre email")
      .populate("marcadoPor", "username nombre")
      .lean();
    return res.json({ ok: true, acuerdo: acceso.acuerdo, pagos });
  } catch (error) {
    console.error("❌ Error listando pagos informados Mango:", error);
    return res.status(500).json({ error: "No se pudieron cargar los pagos informados" });
  }
};

export const marcarPagoInformadoMangoErroneo = async (req, res) => {
  try {
    if (!tieneAccesoProyecciones(req)) return res.status(403).json({ error: "Sin acceso" });
    const acceso = await obtenerAcuerdoMangoAutorizado(req, req.params.id);
    if (acceso.error) return res.status(acceso.status).json({ error: acceso.error });

    const pago = await PagoInformadoMango.findOne({
      _id: req.params.pagoId,
      acuerdoGestionId: req.params.id,
    });
    if (!pago) return res.status(404).json({ error: "Pago informado no encontrado" });
    if (!esAmbitoGlobal(req) && String(pago.operadorId) !== String(req.user.id)) {
      return res.status(403).json({ error: "Solo podés modificar los pagos que informaste" });
    }

    const erroneo = req.body?.erroneo !== false;
    pago.erroneo = erroneo;
    pago.motivoError = erroneo ? String(req.body?.motivo || "Marcado como erróneo").trim() : "";
    pago.marcadoPor = erroneo ? req.user.id : null;
    pago.marcadoEn = erroneo ? new Date() : null;
    await pago.save();
    acuerdosMangoListadoCache.clear();
    return res.json({ ok: true, pago });
  } catch (error) {
    console.error("❌ Error actualizando pago informado Mango:", error);
    return res.status(500).json({ error: "No se pudo actualizar el pago informado" });
  }
};

export const exportarAcuerdosMangoProyeccionesExcel = async (req, res) => {
  try {
    if (!tieneAccesoProyecciones(req)) {
      return res.status(403).json({ error: "Sin acceso a Proyecciones" });
    }
    const { acuerdos } = await obtenerAcuerdosMangoFiltrados(req);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Acuerdos Mango");
    worksheet.columns = [
      { header: "Fecha acuerdo", key: "fecha", width: 15 },
      { header: "Hora", key: "hora", width: 10 },
      { header: "DNI", key: "dni", width: 15 },
      { header: "Titular", key: "titular", width: 30 },
      { header: "Entidad ID", key: "entidadNumero", width: 12 },
      { header: "Entidad", key: "entidad", width: 25 },
      { header: "Tipo de acuerdo", key: "tipo", width: 30 },
      { header: "Anticipo", key: "anticipo", width: 14 },
      { header: "Cuota", key: "cuota", width: 14 },
      { header: "Total acuerdo", key: "total", width: 16 },
      { header: "Operador", key: "operador", width: 22 },
      { header: "Estado cuenta", key: "estadoCuenta", width: 22 },
      { header: "Estado pago", key: "estadoPago", width: 24 },
      { header: "Pagado válido", key: "pagadoValido", width: 16 },
      { header: "Pago mismo día", key: "pagoMismoDia", width: 16 },
      { header: "Pagos posteriores", key: "pagosPosteriores", width: 17 },
      { header: "Último pago válido", key: "ultimoPago", width: 18 },
      { header: "Coincidencia", key: "coincidencia", width: 18 },
      { header: "Revisión", key: "revision", width: 38 },
      { header: "Observación Mango", key: "observacion", width: 45 },
    ];

    acuerdos.forEach((item) => worksheet.addRow({
      fecha: item.fecha ? new Date(item.fecha) : "",
      hora: item.hora || "",
      dni: item.dni || "",
      titular: item.nombreDeudor || "",
      entidadNumero: item.entidadNumero || "",
      entidad: item.entidad || "",
      tipo: item.tipoAcuerdo || item.resultado || "Acuerdo",
      anticipo: Number(item.anticipoMonto || 0),
      cuota: Number(item.montoCuota || 0),
      total: Number(item.montoTotalAcuerdo || 0),
      operador: item.operador || "",
      estadoCuenta: item.estadoCuenta || "",
      estadoPago: item.estadoPagoAcuerdo || "",
      pagadoValido: Number(item.montoPagosValidos || item.montoPagosPosteriores || 0),
      pagoMismoDia: Number(item.montoPagosMismoDia || 0),
      pagosPosteriores: Number(item.montoPagosEstrictamentePosteriores || 0),
      ultimoPago: item.ultimoPagoValido ? new Date(`${item.ultimoPagoValido}T12:00:00`) : "",
      coincidencia: item.coincidenciaPagoPor || "",
      revision: item.motivoRevisionPagos || "",
      observacion: item.observacionGestion || item.observacionResumen || "",
    }));

    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF29154F" } };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    ["anticipo", "cuota", "total", "pagadoValido", "pagoMismoDia", "pagosPosteriores"].forEach((key) => {
      worksheet.getColumn(key).numFmt = '$ #,##0.00';
    });
    worksheet.getColumn("fecha").numFmt = "dd/mm/yyyy";
    worksheet.getColumn("ultimoPago").numFmt = "dd/mm/yyyy";
    worksheet.autoFilter = { from: "A1", to: "T1" };

    const buffer = await workbook.xlsx.writeBuffer();
    const suffix = fechaClaveArgentina();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=acuerdos_mango_${suffix}.xlsx`);
    return res.send(Buffer.from(buffer));
  } catch (error) {
    console.error("❌ Error exportando acuerdos Mango:", error);
    return res.status(500).json({ error: "No se pudo generar el Excel de acuerdos Mango" });
  }
};
