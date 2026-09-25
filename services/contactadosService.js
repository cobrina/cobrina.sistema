import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import ReporteGestion from "../models/ReporteGestion.js";
import ContactadoVentana from "../models/ContactadoVentana.js";
import ContactadoSyncState from "../models/ContactadoSyncState.js";
import ContactadoObservacion from "../models/ContactadoObservacion.js";
import Empleado from "../models/Empleado.js";
import { filtrarEmpleadosOperativosControl } from "../utils/controlEquipo.js";
import {
  agregarHorasHabilesArgentina,
  fechaHoraGestionArgentina,
  claveFechaArgentina,
  inicioMesArgentina,
  inicioDiaArgentina,
  finMesArgentina,
  finDiaArgentina,
} from "../utils/contactadosTiempo.js";

const CONTACTADO_RX = /^\s*contactad[oa]\s*$/i;
const PAGO_A_IMPUTAR_RX = /^\s*pagos?\s+a\s+imputar\s*$/i;
const INCOBRABLE_RX = /^\s*incobrable\s*$/i;
const ACUERDO_PAGO_RX = /^\s*acuerdo\s+de\s+pago\s*$/i;
const ACUERDO_CUMPLIDO_RX = /^\s*acuerdo(?:\s+de\s+pago)?\s+cumplido\s*$/i;
const FALLECIDO_RX = /^\s*fallecid[oa]\s*$/i;
const CANCELADO_RX = /^\s*cancelad[oa](?:\s+en\s+otra\s+entidad)?\s*$/i;
const NO_VOLUNTAD_ARREGLO_RX = /^\s*no\s+tiene\s+voluntad\s+de\s+arreglo\s*$/i;
const DIA_MS = 86_400_000;
const SOLAPE_SYNC_MS = 5 * 60 * 1000;
const SYNC_VERSION = "mensual-v8-fin-dia";
const ARRASTRE_SYNC_VERSION = "arrastre-v4-fin-dia";
const GESTION_SELECT = "_id dni nombreDeudor fecha hora usuario tipoContacto resultadoGestion estadoCuenta telMailMarcado observacionGestion entidad entidadNumero createdAt";
const BACKGROUND_SYNC_MIN_INTERVAL_MS = 45_000;
let syncEnCurso = null;
let ultimoDisparoBackgroundAt = 0;
const syncHistoricoEnCurso = new Map();
const mesesHistoricosConfirmados = new Set();
const limpiezaTerminalMesConfirmada = new Set();

function txt(value) {
  return String(value ?? "").trim();
}

function normalizarUsername(value) {
  return txt(value).toLowerCase();
}


async function obtenerOperadoresActivosContactados() {
  const empleados = await Empleado.find({ isActive: { $ne: false } })
    .select("username role isActive")
    .lean();
  return new Set(
    filtrarEmpleadosOperativosControl(empleados)
      .map((empleado) => normalizarUsername(empleado?.username))
      .filter(Boolean)
  );
}

/**
 * Contactados es una materialización de Reporte de Gestiones. Por eso puede
 * quedar desfasado si una gestión se elimina después de haber sido procesada.
 * Esta depuración hace cumplir dos invariantes:
 *  1) una ventana operativa abierta sólo puede pertenecer a un operador activo de RRHH;
 *  2) la gestión que originó cualquier ventana debe seguir existiendo.
 * El histórico cerrado se conserva aunque una persona luego haya sido dada de baja.
 */
export async function depurarContactadosMaterializados({ operadoresPermitidos = null } = {}) {
  const activos = operadoresPermitidos instanceof Set
    ? operadoresPermitidos
    : await obtenerOperadoresActivosContactados();

  let eliminadasOperador = 0;
  if (activos.size > 0) {
    const r = await ContactadoVentana.deleteMany({
      estado: "abierta",
      operador: { $nin: [...activos] },
    });
    eliminadasOperador = Number(r?.deletedCount || 0);
  } else {
    console.warn("⚠️ Contactados: no se encontraron operadores activos; se omite la limpieza por operador para evitar un borrado masivo accidental.");
  }

  const huerfanas = await ContactadoVentana.aggregate([
    { $match: { gestionInicioId: { $ne: null } } },
    {
      $lookup: {
        from: ReporteGestion.collection.name,
        localField: "gestionInicioId",
        foreignField: "_id",
        as: "__gestionOrigen",
      },
    },
    { $match: { "__gestionOrigen.0": { $exists: false } } },
    { $project: { _id: 1 } },
  ]).allowDiskUse(true);

  let eliminadasHuerfanas = 0;
  for (let i = 0; i < huerfanas.length; i += 2000) {
    const ids = huerfanas.slice(i, i + 2000).map((row) => row._id);
    if (!ids.length) continue;
    const r = await ContactadoVentana.deleteMany({ _id: { $in: ids } });
    eliminadasHuerfanas += Number(r?.deletedCount || 0);
  }

  if (eliminadasOperador || eliminadasHuerfanas) {
    console.log(
      `🧹 Contactados depurados: ${eliminadasOperador} abiertos por operador no activo/no válido · ` +
      `${eliminadasHuerfanas} sin gestión de origen.`
    );
  }

  return {
    operadoresActivos: activos,
    eliminadasOperador,
    eliminadasHuerfanas,
    eliminadas: eliminadasOperador + eliminadasHuerfanas,
  };
}

function mesClaveArgentina(date = new Date()) {
  return claveFechaArgentina(date).slice(0, 7);
}

function mesAnteriorClave(mesClave = mesClaveArgentina()) {
  const [year, month] = String(mesClave || "").split("-").map(Number);
  const d = new Date(Date.UTC(year, (month || 1) - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function mesClaveGestion(gestion = {}) {
  const fecha = gestion?.fecha instanceof Date ? gestion.fecha : new Date(gestion?.fecha);
  if (Number.isNaN(fecha?.getTime?.())) return "";
  return `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, "0")}`;
}

function entidadClave(obj = {}) {
  // El nombre de entidad está normalizado a mayúsculas en ReporteGestion y es
  // más estable para históricos donde entidadNumero todavía puede venir vacío.
  const nombre = txt(obj?.entidad).toUpperCase();
  if (nombre) return `e:${nombre}`;
  const numero = Number(obj?.entidadNumero);
  if (Number.isFinite(numero) && numero > 0) return `n:${numero}`;
  return "e:SIN_ENTIDAD";
}

function casoKey(obj = {}) {
  const dni = txt(obj?.dni).replace(/\D/g, "");
  return dni ? `${dni}|${entidadClave(obj)}` : "";
}

function mismoCaso(a = {}, b = {}) {
  const ka = casoKey(a);
  const kb = casoKey(b);
  return Boolean(ka && kb && ka === kb);
}

function estadoCuentaNormalizado(value) {
  return txt(value).toLowerCase();
}

function esValorContactado(value) {
  return CONTACTADO_RX.test(txt(value));
}

function aplicarEstadoActual(target, gestion, eventAt = null) {
  if (!target || !gestion) return target;
  const at = eventAt || fechaHoraGestionArgentina(gestion.fecha, gestion.hora);
  target.estadoActual = txt(gestion.estadoCuenta);
  target.ultimoOperador = normalizarUsername(gestion.usuario);
  target.ultimaGestionAt = at || null;
  target.ultimaGestionKey = gestion.__key || eventoKey(gestion);
  return target;
}

export function esGestionPagoAImputar(gestion = {}) {
  return PAGO_A_IMPUTAR_RX.test(txt(gestion.estadoCuenta));
}

export function esGestionAcuerdoPago(gestion = {}) {
  return ACUERDO_PAGO_RX.test(txt(gestion.estadoCuenta));
}

export function esGestionAcuerdoCumplido(gestion = {}) {
  return ACUERDO_CUMPLIDO_RX.test(txt(gestion.estadoCuenta));
}

export function esGestionIncobrable(gestion = {}) {
  return INCOBRABLE_RX.test(txt(gestion.estadoCuenta));
}

export function esGestionFallecido(gestion = {}) {
  return FALLECIDO_RX.test(txt(gestion.estadoCuenta));
}

export function esGestionCancelado(gestion = {}) {
  return CANCELADO_RX.test(txt(gestion.estadoCuenta));
}

export function esResultadoSinVoluntadArreglo(gestion = {}) {
  return NO_VOLUNTAD_ARREGLO_RX.test(txt(gestion.resultadoGestion));
}

export function esResultadoContactado(gestion = {}) {
  return CONTACTADO_RX.test(txt(gestion.resultadoGestion));
}

// Estados de la Cuenta que sacan al caso del universo de Contactados sin
// importar quién haya realizado la gestión. Son estados operativamente
// incompatibles con un Contactado activo.
export function esEstadoCuentaSalidaContactados(gestion = {}) {
  return esGestionPagoAImputar(gestion)
    || esGestionIncobrable(gestion)
    || esGestionAcuerdoPago(gestion)
    || esGestionAcuerdoCumplido(gestion)
    || esGestionFallecido(gestion)
    || esGestionCancelado(gestion);
}

// Para reconstrucciones/legacy también consideramos "No tiene voluntad de
// arreglo" como terminal. Durante el flujo activo esa calificación sólo libera
// la titularidad cuando la registra el operador dueño de la ventana.
export function esGestionTerminalContactados(gestion = {}) {
  return esEstadoCuentaSalidaContactados(gestion) || esResultadoSinVoluntadArreglo(gestion);
}

function datosCierreTerminal(gestion, eventAt) {
  return {
    estado: "cerrada_terminal",
    cerradaAt: eventAt,
    gestionResolucionKey: gestion.__key || eventoKey(gestion),
    gestionResolucionId: gestion._id || null,
    calificacionResolucion: calificacionGestion(gestion),
    tipoContactoResolucion: txt(gestion.tipoContacto),
    estadoCuentaResolucion: txt(gestion.estadoCuenta),
  };
}

export function esEstadoCuentaContactado(gestion = {}) {
  return CONTACTADO_RX.test(txt(gestion.estadoCuenta));
}

// IMPORTANTE: esto identifica una fila cuyo ESTADO DE LA CUENTA está en Contactado.
// Que la fila sea un ORIGEN real se decide comparándola contra el estado anterior
// del mismo caso (DNI + entidad). Así una gestión que simplemente encuentra el
// caso ya Contactado no se convierte en un Contactado nuevo para ese operador.
export function esGestionContactado(gestion = {}) {
  return esEstadoCuentaContactado(gestion) && !esGestionTerminalContactados(gestion);
}

export function calificacionGestion(gestion = {}) {
  return txt(gestion.resultadoGestion) || txt(gestion.estadoCuenta) || txt(gestion.tipoContacto) || "Sin calificación";
}

function eventoKey(gestion = {}) {
  const fecha = gestion?.fecha instanceof Date ? gestion.fecha.toISOString().slice(0, 10) : txt(gestion.fecha).slice(0, 10);
  const raw = [
    txt(gestion.dni).replace(/\D/g, ""),
    fecha,
    txt(gestion.hora),
    normalizarUsername(gestion.usuario),
    txt(gestion.tipoContacto).toLowerCase(),
    txt(gestion.resultadoGestion).toLowerCase(),
    txt(gestion.estadoCuenta).toLowerCase(),
    txt(gestion.entidad).toUpperCase(),
    txt(gestion.telMailMarcado).toLowerCase(),
  ].join("|");
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function detectarTelefono(raw = "") {
  const original = txt(raw);
  if (!original) {
    return { telefonoOriginal: "", telefonoVisible: "", whatsappNumero: "", whatsappDisponible: false };
  }

  const candidatos = original
    .split(/[|;,/\n]+/)
    .map((parte) => parte.trim())
    .filter(Boolean)
    .map((parte) => ({ texto: parte, digitos: parte.replace(/\D/g, "") }))
    .filter((item) => item.digitos.length >= 8 && item.digitos.length <= 15);

  const candidato = candidatos.find((item) => item.digitos.length >= 10) || candidatos[0];
  if (!candidato) {
    return { telefonoOriginal: original, telefonoVisible: original.slice(0, 80), whatsappNumero: "", whatsappDisponible: false };
  }

  let digitos = candidato.digitos;
  const senalMovilTexto = /(whats|wp\b|wa\b|celu|celular|m[oó]vil)/i.test(candidato.texto);
  const tenia549 = digitos.startsWith("549") || /^\+?54\s*9/.test(candidato.texto);
  const tenia15 = /(^|\D)15(\D|$)/.test(candidato.texto) || /15/.test(digitos);

  if (digitos.startsWith("0054")) digitos = digitos.slice(4);
  if (digitos.startsWith("54")) digitos = digitos.slice(2);
  if (digitos.startsWith("9") && digitos.length === 11) digitos = digitos.slice(1);
  if (digitos.startsWith("0")) digitos = digitos.slice(1);

  // Formatos argentinos históricos: 011-15-xxxx-xxxx / 0351-15-xxxxxxx.
  if (digitos.length > 10) {
    for (let areaLen = 2; areaLen <= 4; areaLen += 1) {
      if (digitos.slice(areaLen, areaLen + 2) === "15") {
        const sin15 = digitos.slice(0, areaLen) + digitos.slice(areaLen + 2);
        if (sin15.length === 10) {
          digitos = sin15;
          break;
        }
      }
    }
  }

  const localValido = /^\d{10}$/.test(digitos);
  const esMovilSeguro = localValido && (tenia549 || tenia15 || senalMovilTexto);
  return {
    telefonoOriginal: original,
    telefonoVisible: candidato.texto.slice(0, 80),
    whatsappNumero: esMovilSeguro ? `549${digitos}` : "",
    whatsappDisponible: esMovilSeguro,
  };
}

function ventanaDesdeGestion(gestion, {
  serieId,
  esOrigenContactado = false,
  telefonoFallback = null,
  mesOrigen = "",
  metadataExistente = null,
} = {}) {
  const iniciaAt = fechaHoraGestionArgentina(gestion.fecha, gestion.hora);
  const tel = detectarTelefono(gestion.telMailMarcado);
  const telefono = tel.telefonoVisible ? tel : (telefonoFallback || tel);
  const venceBase = agregarHorasHabilesArgentina(iniciaAt, 72);
  const key = gestion.__key || eventoKey(gestion);
  return {
    serieId: serieId || metadataExistente?.serieId || randomUUID(),
    mesOrigen: mesOrigen || mesClaveGestion(gestion),
    casoKey: casoKey(gestion),
    gestionInicioKey: key,
    gestionInicioId: gestion._id || null,
    dni: txt(gestion.dni).replace(/\D/g, ""),
    nombreDeudor: txt(gestion.nombreDeudor),
    operador: normalizarUsername(gestion.usuario),
    entidad: txt(gestion.entidad).toUpperCase(),
    entidadNumero: Number.isFinite(Number(gestion.entidadNumero)) ? Number(gestion.entidadNumero) : null,
    telefonoOriginal: telefono.telefonoOriginal || "",
    telefonoVisible: telefono.telefonoVisible || "",
    whatsappNumero: telefono.whatsappNumero || "",
    whatsappDisponible: Boolean(telefono.whatsappDisponible),
    iniciaAt,
    alertaAt: agregarHorasHabilesArgentina(iniciaAt, 48),
    criticoAt: agregarHorasHabilesArgentina(iniciaAt, 60),
    // La regla operativa mantiene el caso vigente TODO el día en que completa
    // las 72 horas hábiles. Recién vence al finalizar ese día en Argentina.
    venceAt: finDiaArgentina(venceBase),
    estado: "abierta",
    esOrigenContactado,
    calificacionInicio: calificacionGestion(gestion),
    tipoContactoInicio: txt(gestion.tipoContacto),
    estadoCuentaInicio: txt(gestion.estadoCuenta),
    observacionGestionInicio: txt(gestion.observacionGestion).slice(0, 3000),
    estadoActual: txt(gestion.estadoCuenta),
    ultimoOperador: normalizarUsername(gestion.usuario),
    ultimaGestionAt: iniciaAt,
    ultimaGestionKey: key,
    clickRealizadoAt: metadataExistente?.clickRealizadoAt || null,
    clickRealizadoPor: metadataExistente?.clickRealizadoPor || "",
  };
}

function telefonoFallbackVentana(ventana) {
  return {
    telefonoOriginal: ventana?.telefonoOriginal || "",
    telefonoVisible: ventana?.telefonoVisible || "",
    whatsappNumero: ventana?.whatsappNumero || "",
    whatsappDisponible: Boolean(ventana?.whatsappDisponible),
  };
}

async function reconciliarEventoHistorico(gestion, eventAt, operador, dni, activeByPair, now = new Date(), mesClave = mesClaveGestion(gestion)) {
  // Una gestión puede haberse importado después de que el reloj ya marcó el caso
  // como vencido. Se reconstruye por la hora REAL de gestión para no penalizar
  // cargas tardías del Reporte de Gestiones.
  const key = gestion.__key || eventoKey(gestion);
  const previa = await ContactadoVentana.findOne({
    operador,
    dni,
    iniciaAt: { $lt: eventAt },
    venceAt: { $gte: eventAt },
    gestionInicioKey: { $ne: key },
    $or: [
      { cerradaAt: null },
      { cerradaAt: { $gte: eventAt } },
    ],
  }).sort({ iniciaAt: -1 }).lean();

  if (!previa) return false;

  const estadoCierre = eventAt.getTime() >= new Date(previa.alertaAt).getTime()
    ? "cumplida"
    : "renovada_anticipada";

  await ContactadoVentana.updateOne(
    { _id: previa._id },
    {
      $set: {
        estado: estadoCierre,
        cerradaAt: eventAt,
        gestionResolucionKey: key,
        gestionResolucionId: gestion._id || null,
        calificacionResolucion: calificacionGestion(gestion),
        tipoContactoResolucion: txt(gestion.tipoContacto),
        estadoCuentaResolucion: txt(gestion.estadoCuenta),
      },
    }
  );

  // Un estado terminal (o No tiene voluntad del titular) resuelve la ventana
  // que veníamos siguiendo, pero NO inicia una nueva ventana de Contactados.
  if (esGestionTerminalContactados(gestion)) {
    activeByPair.delete(`${operador}|${dni}`);
    return true;
  }

  const nuevaData = ventanaDesdeGestion(gestion, {
    serieId: previa.serieId,
    esOrigenContactado: false,
    telefonoFallback: telefonoFallbackVentana(previa),
    mesOrigen: previa.mesOrigen || mesClave,
  });

  // Si ya había una ventana posterior creada antes de que llegara esta gestión
  // tardía, esa siguiente gestión funciona como resolución de la ventana que
  // acabamos de reconstruir.
  const siguiente = await ContactadoVentana.findOne({
    operador,
    dni,
    iniciaAt: { $gt: eventAt },
  }).sort({ iniciaAt: 1 }).lean();

  if (siguiente && new Date(siguiente.iniciaAt) <= new Date(nuevaData.venceAt)) {
    const siguienteAt = new Date(siguiente.iniciaAt);
    nuevaData.estado = siguienteAt >= new Date(nuevaData.alertaAt) ? "cumplida" : "renovada_anticipada";
    nuevaData.cerradaAt = siguienteAt;
    nuevaData.gestionResolucionKey = siguiente.gestionInicioKey;
    nuevaData.gestionResolucionId = siguiente.gestionInicioId || null;
    nuevaData.calificacionResolucion = siguiente.calificacionInicio || "Sin calificación";
    nuevaData.tipoContactoResolucion = siguiente.tipoContactoInicio || "";
    nuevaData.estadoCuentaResolucion = siguiente.estadoCuentaInicio || "";

    // Esa ventana ya no es un nuevo origen independiente: en la secuencia real
    // quedó alcanzada por el seguimiento reconstruido.
    if (siguiente.esOrigenContactado) {
      await ContactadoVentana.updateOne({ _id: siguiente._id }, { $set: { esOrigenContactado: false } });
    }
  } else if (new Date(nuevaData.venceAt) <= now) {
    nuevaData.estado = "vencida";
    nuevaData.cerradaAt = nuevaData.venceAt;
  }

  try {
    const creada = await ContactadoVentana.create(nuevaData);
    if (creada.estado === "abierta") {
      activeByPair.set(`${operador}|${dni}`, creada.toObject());
    }
  } catch (error) {
    if (Number(error?.code) !== 11000) throw error;
  }
  return true;
}


async function crearContactadoHistoricoAntesDeVentana(gestion, eventAt, operador, dni, activeByPair, now = new Date(), mesClave = mesClaveGestion(gestion)) {
  if (!esGestionContactado(gestion)) return false;

  const siguiente = await ContactadoVentana.findOne({
    operador,
    dni,
    iniciaAt: { $gt: eventAt },
  }).sort({ iniciaAt: 1 }).lean();

  // Si no existe nada posterior, el flujo cronológico normal se ocupa de crear
  // la ventana y dejarla abierta para que las siguientes gestiones del lote la cierren.
  if (!siguiente) return false;

  const siguienteAt = new Date(siguiente.iniciaAt);
  const nuevaData = ventanaDesdeGestion(gestion, {
    serieId: randomUUID(),
    esOrigenContactado: true,
    telefonoFallback: telefonoFallbackVentana(siguiente),
    mesOrigen: siguiente.mesOrigen || mesClave,
  });

  if (siguienteAt <= new Date(nuevaData.venceAt)) {
    // La gestión posterior cayó dentro de las 72 h hábiles: pertenece al mismo
    // ciclo real y funciona como resolución de este Contactado importado tarde.
    nuevaData.serieId = siguiente.serieId;
    nuevaData.estado = siguienteAt >= new Date(nuevaData.alertaAt) ? "cumplida" : "renovada_anticipada";
    nuevaData.cerradaAt = siguienteAt;
    nuevaData.gestionResolucionKey = siguiente.gestionInicioKey;
    nuevaData.gestionResolucionId = siguiente.gestionInicioId || null;
    nuevaData.calificacionResolucion = siguiente.calificacionInicio || "Sin calificación";
    nuevaData.tipoContactoResolucion = siguiente.tipoContactoInicio || "";
    nuevaData.estadoCuentaResolucion = siguiente.estadoCuentaInicio || "";

    if (siguiente.esOrigenContactado) {
      await ContactadoVentana.updateOne({ _id: siguiente._id }, { $set: { esOrigenContactado: false } });
    }
  } else if (new Date(nuevaData.venceAt) <= now) {
    // Había una ventana posterior, pero empezó cuando este caso ya estaba vencido.
    nuevaData.estado = "vencida";
    nuevaData.cerradaAt = nuevaData.venceAt;
  }

  try {
    const creada = await ContactadoVentana.create(nuevaData);
    if (creada.estado === "abierta") {
      activeByPair.set(`${operador}|${dni}`, creada.toObject());
    }
  } catch (error) {
    if (Number(error?.code) !== 11000) throw error;
  }
  return true;
}

function diaUtc(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function compararEventos(a, b) {
  const ta = fechaHoraGestionArgentina(a.fecha, a.hora)?.getTime() || 0;
  const tb = fechaHoraGestionArgentina(b.fecha, b.hora)?.getTime() || 0;
  if (ta !== tb) return ta - tb;
  const ca = new Date(a.createdAt || 0).getTime();
  const cb = new Date(b.createdAt || 0).getTime();
  if (ca !== cb) return ca - cb;
  return String(a._id).localeCompare(String(b._id));
}

async function clavesYaProcesadas(keys = []) {
  const out = new Set();
  // Evita construir un $in gigantesco si una jornada tiene muchísimas gestiones.
  const TAMANIO = 5000;
  for (let i = 0; i < keys.length; i += TAMANIO) {
    const bloque = keys.slice(i, i + TAMANIO);
    // gestionInicioKey es único globalmente. No se debe limitar por mesOrigen:
    // una gestión de septiembre puede ser la continuación real de un Contactado
    // iniciado en agosto y conservar el mesOrigen de esa serie.
    const rows = await ContactadoVentana.find({ gestionInicioKey: { $in: bloque } })
      .select("gestionInicioKey")
      .lean();
    rows.forEach((row) => {
      if (row.gestionInicioKey) out.add(row.gestionInicioKey);
    });
  }
  return out;
}

async function gestionAnteriorMismoCaso(gestion, eventAt) {
  const dni = txt(gestion.dni).replace(/\D/g, "");
  if (!dni || !eventAt) return null;
  const dia = diaUtc(gestion.fecha);
  if (!dia) return null;
  const filtro = {
    borrado: { $ne: true },
    dni,
  };
  const nombreEntidad = txt(gestion.entidad).toUpperCase();
  const numero = Number(gestion.entidadNumero);
  if (nombreEntidad) filtro.entidad = nombreEntidad;
  else if (Number.isFinite(numero) && numero > 0) filtro.entidadNumero = numero;

  const anteriores = [
    { fecha: { $lt: dia } },
    { fecha: dia, hora: { $lt: txt(gestion.hora) || "00:00:00" } },
  ];
  if (gestion._id) {
    anteriores.push({ fecha: dia, hora: txt(gestion.hora) || "00:00:00", _id: { $lt: gestion._id } });
  }
  filtro.$or = anteriores;

  return ReporteGestion.findOne(filtro)
    .select(GESTION_SELECT)
    .sort({ fecha: -1, hora: -1, _id: -1 })
    .lean();
}

async function esTransicionRealContactadoDB(gestion, eventAt) {
  if (!esGestionContactado(gestion)) return false;
  const anterior = await gestionAnteriorMismoCaso(gestion, eventAt);
  if (!anterior || !esValorContactado(anterior.estadoCuenta)) return true;

  // Caso especial: el titular pudo haber liberado la cuenta con Resultado =
  // "No tiene voluntad de arreglo" sin que Mango cambiara inmediatamente el
  // Estado de la Cuenta. En ese escenario, el próximo operador que realmente
  // registre Contactado (resultado + estado Contactado) puede tomar el caso.
  if (!esResultadoContactado(gestion)) return false;
  const keyCaso = casoKey(gestion);
  if (!keyCaso) return false;
  const ultimaVentana = await ContactadoVentana.findOne({
    casoKey: keyCaso,
    iniciaAt: { $lt: eventAt },
  })
    .sort({ iniciaAt: -1 })
    .select("estado calificacionResolucion estadoCuentaResolucion cerradaAt")
    .lean();
  return Boolean(
    ultimaVentana
    && ultimaVentana.estado === "cerrada_terminal"
    && esResultadoSinVoluntadArreglo({ resultadoGestion: ultimaVentana.calificacionResolucion })
  );
}

async function procesarLoteGestiones(gestiones, { activeByPair, now, mesClave, reconstruirTardias = true, operadoresPermitidos = null }) {
  if (!gestiones.length) return { procesados: 0, leidos: 0, contactadosDetectados: 0 };

  // activeByPair conserva el nombre por compatibilidad interna, pero desde V5 la
  // clave es del CASO (DNI + entidad), no operador + DNI. La ventana conserva al
  // operador dueño que generó el Contactado real.
  const activeByCase = activeByPair;
  const unicos = new Map();
  for (const gestion of gestiones) {
    const key = eventoKey(gestion);
    if (!unicos.has(key)) unicos.set(key, { ...gestion, __key: key });
  }
  const eventos = [...unicos.values()].sort(compararEventos);
  const procesadas = await clavesYaProcesadas(eventos.map((e) => e.__key));

  let procesadosNuevos = 0;
  let contactadosDetectados = 0;
  for (const gestion of eventos) {
    if (procesadas.has(gestion.__key)) continue;
    const eventAt = fechaHoraGestionArgentina(gestion.fecha, gestion.hora);
    if (!eventAt) continue;
    const operador = normalizarUsername(gestion.usuario);
    const dni = txt(gestion.dni).replace(/\D/g, "");
    const keyCaso = casoKey(gestion);
    if (!operador || !dni || !keyCaso) continue;

    let activa = activeByCase.get(keyCaso) || null;

    // Si llega una fila histórica anterior al inicio materializado, no puede
    // cambiar el dueño actual. La reconstrucción V5 mensual ya ordena el histórico
    // completo; este guard evita que una importación tardía robe la ventana viva.
    if (activa && eventAt.getTime() <= new Date(activa.iniciaAt).getTime()) {
      continue;
    }

    if (activa && eventAt.getTime() > new Date(activa.venceAt).getTime()) {
      await ContactadoVentana.updateOne(
        { _id: activa._id, estado: "abierta" },
        { $set: { estado: "vencida", cerradaAt: activa.venceAt } }
      );
      activeByCase.delete(keyCaso);
      activa = null;
    }

    if (activa) {
      // Cualquier operador puede modificar el estado visible en Mango. Eso se
      // refleja como estado actual / último operador, pero NO cambia la propiedad.
      aplicarEstadoActual(activa, gestion, eventAt);
      await ContactadoVentana.updateOne(
        { _id: activa._id, estado: "abierta" },
        {
          $set: {
            estadoActual: txt(gestion.estadoCuenta),
            ultimoOperador: operador,
            ultimaGestionAt: eventAt,
            ultimaGestionKey: gestion.__key,
          },
        }
      );

      // Estos Estados de la Cuenta sacan el caso de Contactados inmediatamente,
      // incluso si la gestión fue realizada por otra persona. No hay renovación.
      if (esEstadoCuentaSalidaContactados(gestion)) {
        await ContactadoVentana.updateOne(
          { _id: activa._id, estado: "abierta" },
          { $set: datosCierreTerminal(gestion, eventAt) }
        );
        activeByCase.delete(keyCaso);
        procesadas.add(gestion.__key);
        procesadosNuevos += 1;
        continue;
      }

      // Sólo el operador dueño que originó el Contactado puede renovar sus 72 h.
      // Si otro operador toca el caso, únicamente actualizamos Estado actual /
      // Último operador y conservamos dueño y vencimiento.
      if (operador !== normalizarUsername(activa.operador)) {
        procesadas.add(gestion.__key);
        procesadosNuevos += 1;
        continue;
      }

      // Excepción de Paula: si el propio titular registra "No tiene voluntad de
      // arreglo", libera el caso aunque todavía tenga vigencia. La próxima
      // transición real a Contactado podrá generar un dueño nuevo.
      if (esResultadoSinVoluntadArreglo(gestion)) {
        await ContactadoVentana.updateOne(
          { _id: activa._id, estado: "abierta" },
          { $set: datosCierreTerminal(gestion, eventAt) }
        );
        activeByCase.delete(keyCaso);
        procesadas.add(gestion.__key);
        procesadosNuevos += 1;
        continue;
      }

      const estadoCierre = eventAt.getTime() >= new Date(activa.alertaAt).getTime()
        ? "cumplida"
        : "renovada_anticipada";

      await ContactadoVentana.updateOne(
        { _id: activa._id, estado: "abierta" },
        {
          $set: {
            estado: estadoCierre,
            cerradaAt: eventAt,
            gestionResolucionKey: gestion.__key,
            gestionResolucionId: gestion._id || null,
            calificacionResolucion: calificacionGestion(gestion),
            tipoContactoResolucion: txt(gestion.tipoContacto),
            estadoCuentaResolucion: txt(gestion.estadoCuenta),
          },
        }
      );

      const nuevaData = ventanaDesdeGestion(gestion, {
        serieId: activa.serieId,
        esOrigenContactado: false,
        telefonoFallback: telefonoFallbackVentana(activa),
        mesOrigen: activa.mesOrigen || mesClaveGestion(gestion) || mesClave,
      });
      try {
        const nueva = await ContactadoVentana.create(nuevaData);
        activeByCase.set(keyCaso, nueva.toObject());
        procesadas.add(gestion.__key);
        procesadosNuevos += 1;
      } catch (error) {
        if (Number(error?.code) !== 11000) throw error;
      }
      continue;
    }

    // Sin dueño vigente, una fila Contactado sólo abre una serie si representa
    // una transición REAL desde otro Estado de la Cuenta hacia Contactado.
    if (!esGestionContactado(gestion)) continue;
    if (operadoresPermitidos instanceof Set && !operadoresPermitidos.has(operador)) continue;
    const esOrigenReal = await esTransicionRealContactadoDB(gestion, eventAt);
    if (!esOrigenReal) continue;
    contactadosDetectados += 1;

    const nuevaData = ventanaDesdeGestion(gestion, {
      serieId: randomUUID(),
      esOrigenContactado: true,
      mesOrigen: mesClaveGestion(gestion) || mesClave,
    });
    try {
      const nueva = await ContactadoVentana.create(nuevaData);
      activeByCase.set(keyCaso, nueva.toObject());
      procesadas.add(gestion.__key);
      procesadosNuevos += 1;
    } catch (error) {
      if (Number(error?.code) !== 11000) throw error;
    }
  }

  return { procesados: procesadosNuevos, leidos: gestiones.length, contactadosDetectados };
}

async function expirarVencidas(now = new Date()) {
  // V8: una ventana sigue operativa durante TODO el día argentino que figura
  // como fecha de vencimiento. Esto además protege datos legacy cuyo venceAt
  // quedó guardado con una hora intermedia: nunca pasan a histórico el mismo día.
  const inicioHoy = inicioDiaArgentina(now);
  return ContactadoVentana.updateMany(
    { estado: "abierta", venceAt: { $lt: inicioHoy } },
    [{ $set: { estado: "vencida", cerradaAt: "$venceAt" } }]
  );
}

async function prepararReconstruccionRapidaDelMes(mesClave) {
  const stateKey = `contactados:${SYNC_VERSION}:${mesClave}`;
  const existente = await ContactadoSyncState.findOne({ key: stateKey }).lean();
  if (existente) return { reconstruir: false, state: existente, metadataExistente: new Map() };

  // V5 recompone el mes vigente porque cambia la unidad de propiedad: el dueño
  // es quien produjo la transición real a ESTADO DE LA CUENTA = Contactado.
  const desde = inicioMesArgentina(mesClave);
  const hasta = finMesArgentina(mesClave);
  const filtroMes = {
    $or: [
      { mesOrigen: mesClave },
      // También se eliminan las renovaciones que empiezan este mes aunque la
      // serie haya nacido el mes anterior. Se reconstruyen con el mismo serieId.
      { iniciaAt: { $gte: desde, $lte: hasta } },
    ],
  };

  // Conservamos metadatos por gestión para no perder checks ni el serieId cuando
  // la ventana correcta ya existía. Las observaciones son por serieId y por eso
  // NO se borran durante esta migración.
  const existentesMes = await ContactadoVentana.find(filtroMes).lean();
  const metadataExistente = new Map();
  for (const row of existentesMes) {
    if (!row.gestionInicioKey) continue;
    metadataExistente.set(row.gestionInicioKey, {
      serieId: row.serieId || "",
      clickRealizadoAt: row.clickRealizadoAt || null,
      clickRealizadoPor: row.clickRealizadoPor || "",
    });
  }
  await ContactadoVentana.deleteMany(filtroMes);

  console.log(`⚡ Contactados ${mesClave}: preparando reconstrucción V5 por dueño real, liberación y estados terminales.`);
  return { reconstruir: true, state: null, metadataExistente, ventanasExistentes: existentesMes };
}

function enBloques(items = [], size = 700) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function obtenerParesArrastre(mesClave, primerDia) {
  // Sólo son arrastre las ventanas que NACIERON antes del primer día del mes y
  // seguían vivas (o fueron resueltas) dentro del mes nuevo. La versión anterior
  // miraba cualquier ventana histórica cuyo venceAt fuera posterior al corte,
  // incluso si ya se había cerrado antes de comenzar el mes. Eso podía inflar
  // muchísimo el universo de pares y obligar a releer gestiones innecesarias.
  const rows = await ContactadoVentana.find({
    iniciaAt: { $lt: primerDia },
    venceAt: { $gte: primerDia },
    $or: [
      { cerradaAt: null },
      { cerradaAt: { $gte: primerDia } },
    ],
  })
    .select("operador dni")
    .lean();

  const pares = new Set();
  for (const row of rows) {
    const operador = normalizarUsername(row.operador);
    const dni = txt(row.dni).replace(/\D/g, "");
    if (operador && dni) pares.add(`${operador}|${dni}`);
  }
  return pares;
}

async function obtenerGestionesDeParesEnRango(pares, primerDia, ultimoDia) {
  if (!pares?.size) return [];

  // Agrupar por operador evita leer todas las gestiones de un DNI que pudieron
  // haber sido hechas por otras personas. ReporteGestion normaliza usuario a
  // minúsculas al importar, así que podemos filtrar de forma exacta y aprovechar
  // los índices existentes de usuario/fecha.
  const dnisPorOperador = new Map();
  for (const par of pares) {
    const corte = par.indexOf("|");
    if (corte <= 0) continue;
    const operador = par.slice(0, corte);
    const dni = par.slice(corte + 1);
    if (!operador || !dni) continue;
    if (!dnisPorOperador.has(operador)) dnisPorOperador.set(operador, new Set());
    dnisPorOperador.get(operador).add(dni);
  }

  const eventos = [];
  for (const [operador, dnisSet] of dnisPorOperador.entries()) {
    for (const bloqueDnis of enBloques([...dnisSet], 700)) {
      const rows = await ReporteGestion.find({
        borrado: { $ne: true },
        usuario: operador,
        fecha: { $gte: primerDia, $lte: ultimoDia },
        dni: { $in: bloqueDnis },
      })
        .select(GESTION_SELECT)
        .lean();
      eventos.push(...rows);
    }
  }
  return eventos;
}

async function obtenerGestionesDeCasosEnRango(casos, primerDia, ultimoDia) {
  if (!casos?.size) return [];
  const dnis = [...new Set([...casos].map((key) => String(key).split("|")[0]).filter(Boolean))];
  const eventos = [];
  for (const bloqueDnis of enBloques(dnis, 700)) {
    const rows = await ReporteGestion.find({
      borrado: { $ne: true },
      fecha: { $gte: primerDia, $lte: ultimoDia },
      dni: { $in: bloqueDnis },
    })
      .select(GESTION_SELECT)
      .lean();
    for (const row of rows) {
      if (casos.has(casoKey(row))) eventos.push(row);
    }
  }
  return eventos;
}

async function obtenerEstadosPreviosCasos(casos, antesDe) {
  const out = new Map();
  if (!casos?.size) return out;
  const dnis = [...new Set([...casos].map((key) => String(key).split("|")[0]).filter(Boolean))];
  for (const bloqueDnis of enBloques(dnis, 500)) {
    const rows = await ReporteGestion.aggregate([
      {
        $match: {
          borrado: { $ne: true },
          dni: { $in: bloqueDnis },
          fecha: { $lt: antesDe },
        },
      },
      { $sort: { fecha: -1, hora: -1, _id: -1 } },
      {
        $group: {
          _id: { dni: "$dni", entidad: "$entidad" },
          dni: { $first: "$dni" },
          entidadNumero: { $first: "$entidadNumero" },
          entidad: { $first: "$entidad" },
          estadoCuenta: { $first: "$estadoCuenta" },
          usuario: { $first: "$usuario" },
          fecha: { $first: "$fecha" },
          hora: { $first: "$hora" },
        },
      },
    ]).allowDiskUse(true);
    for (const row of rows) {
      const key = casoKey(row);
      if (casos.has(key) && !out.has(key)) out.set(key, row);
    }
  }
  return out;
}

async function metadataVentanasPorGestionKeys(keys = []) {
  const out = new Map();
  const unicos = [...new Set(keys.filter(Boolean))];
  for (const bloque of enBloques(unicos, 3000)) {
    const rows = await ContactadoVentana.find({ gestionInicioKey: { $in: bloque } })
      .select("gestionInicioKey serieId clickRealizadoAt clickRealizadoPor")
      .lean();
    for (const row of rows) {
      if (!row.gestionInicioKey || out.has(row.gestionInicioKey)) continue;
      out.set(row.gestionInicioKey, {
        serieId: row.serieId || "",
        clickRealizadoAt: row.clickRealizadoAt || null,
        clickRealizadoPor: row.clickRealizadoPor || "",
      });
    }
  }
  return out;
}

export function construirVentanasEnMemoria(eventos = [], {
  now = new Date(),
  estadosPrevios = new Map(),
  metadataExistente = new Map(),
  operadoresPermitidos = null,
} = {}) {
  const unicos = new Map();
  for (const gestion of eventos) {
    const key = eventoKey(gestion);
    if (!unicos.has(key)) unicos.set(key, { ...gestion, __key: key });
  }
  const ordenados = [...unicos.values()].sort(compararEventos);
  const porCaso = new Map();
  for (const gestion of ordenados) {
    const key = casoKey(gestion);
    if (!key || !normalizarUsername(gestion.usuario)) continue;
    if (!porCaso.has(key)) porCaso.set(key, []);
    porCaso.get(key).push(gestion);
  }

  const ventanas = [];
  let origenes = 0;

  for (const [keyCaso, gestionesCaso] of porCaso.entries()) {
    let activa = null;
    let estadoAnterior = txt(estadosPrevios.get(keyCaso)?.estadoCuenta);
    let liberadoPorNoVoluntad = false;

    for (const gestion of gestionesCaso) {
      const eventAt = fechaHoraGestionArgentina(gestion.fecha, gestion.hora);
      if (!eventAt) continue;
      const operador = normalizarUsername(gestion.usuario);

      if (activa && eventAt.getTime() > new Date(activa.venceAt).getTime()) {
        activa.estado = "vencida";
        activa.cerradaAt = activa.venceAt;
        activa = null;
      }

      const transicionAContactado = esGestionContactado(gestion)
        && (!esValorContactado(estadoAnterior) || (liberadoPorNoVoluntad && esResultadoContactado(gestion)));

      if (activa && eventAt.getTime() > new Date(activa.iniciaAt).getTime()) {
        // Siempre mostramos el estado real más reciente aunque lo haya tocado otra persona.
        aplicarEstadoActual(activa, gestion, eventAt);

        // Un Estado de la Cuenta terminal saca el caso del universo de Contactados
        // inmediatamente, aunque la gestión la haya hecho otro operador.
        if (esEstadoCuentaSalidaContactados(gestion)) {
          Object.assign(activa, datosCierreTerminal(gestion, eventAt));
          activa = null;
          liberadoPorNoVoluntad = false;
          estadoAnterior = txt(gestion.estadoCuenta);
          continue;
        }

        // Otro operador no puede renovar ni apropiarse del Contactado vigente.
        if (operador !== normalizarUsername(activa.operador)) {
          estadoAnterior = txt(gestion.estadoCuenta);
          continue;
        }

        // Si el operador dueño marca "No tiene voluntad de arreglo", libera la
        // titularidad aunque todavía queden horas de vigencia.
        if (esResultadoSinVoluntadArreglo(gestion)) {
          Object.assign(activa, datosCierreTerminal(gestion, eventAt));
          activa = null;
          liberadoPorNoVoluntad = true;
          estadoAnterior = txt(gestion.estadoCuenta);
          continue;
        }

        activa.estado = eventAt.getTime() >= new Date(activa.alertaAt).getTime()
          ? "cumplida"
          : "renovada_anticipada";
        activa.cerradaAt = eventAt;
        activa.gestionResolucionKey = gestion.__key;
        activa.gestionResolucionId = gestion._id || null;
        activa.calificacionResolucion = calificacionGestion(gestion);
        activa.tipoContactoResolucion = txt(gestion.tipoContacto);
        activa.estadoCuentaResolucion = txt(gestion.estadoCuenta);

        const meta = metadataExistente.get(gestion.__key) || null;
        activa = ventanaDesdeGestion(gestion, {
          serieId: activa.serieId,
          esOrigenContactado: false,
          telefonoFallback: telefonoFallbackVentana(activa),
          mesOrigen: activa.mesOrigen || mesClaveGestion(gestion),
          metadataExistente: meta,
        });
        ventanas.push(activa);
        estadoAnterior = txt(gestion.estadoCuenta);
        continue;
      }

      if (!activa && transicionAContactado && (!(operadoresPermitidos instanceof Set) || operadoresPermitidos.has(operador))) {
        const meta = metadataExistente.get(gestion.__key) || null;
        activa = ventanaDesdeGestion(gestion, {
          serieId: meta?.serieId || randomUUID(),
          esOrigenContactado: true,
          mesOrigen: mesClaveGestion(gestion),
          metadataExistente: meta,
        });
        ventanas.push(activa);
        origenes += 1;
        liberadoPorNoVoluntad = false;
      }

      if (!esValorContactado(gestion.estadoCuenta)) liberadoPorNoVoluntad = false;
      estadoAnterior = txt(gestion.estadoCuenta);
    }

    if (activa && new Date(activa.venceAt) <= now) {
      activa.estado = "vencida";
      activa.cerradaAt = activa.venceAt;
    }
  }

  return { ventanas, origenes };
}

async function insertarVentanasPorBloques(ventanas = []) {
  let insertadas = 0;
  for (const bloque of enBloques(ventanas, 1000)) {
    if (!bloque.length) continue;
    try {
      const docs = await ContactadoVentana.insertMany(bloque, { ordered: false });
      insertadas += docs.length;
    } catch (error) {
      // insertMany con ordered:false puede informar duplicados aun habiendo
      // insertado el resto. Para esta reconstrucción la colección del mes se
      // limpia antes, así que sólo ignoramos duplicados de forma defensiva.
      if (Array.isArray(error?.insertedDocs)) insertadas += error.insertedDocs.length;
      const soloDuplicados = Array.isArray(error?.writeErrors)
        && error.writeErrors.length
        && error.writeErrors.every((w) => Number(w?.code) === 11000);
      if (!soloDuplicados && Number(error?.code) !== 11000) throw error;
    }
  }
  return insertadas;
}

async function reconstruirMesRapido({
  mesClave,
  primerDia,
  ultimoDia,
  now,
  desdeAnalisis = null,
  metadataSeed = new Map(),
  operadoresPermitidos = null,
}) {
  const inicio = Date.now();
  const desde = desdeAnalisis || primerDia;

  // Candidatos por ESTADO DE LA CUENTA exclusivamente. Luego el constructor
  // cronológico decide cuáles son transiciones reales hacia Contactado.
  const filtroContactados = {
    borrado: { $ne: true },
    fecha: { $gte: desde, $lte: ultimoDia },
    estadoCuenta: CONTACTADO_RX,
  };
  if (operadoresPermitidos instanceof Set) {
    filtroContactados.usuario = { $in: [...operadoresPermitidos] };
  }

  const contactados = await ReporteGestion.find(filtroContactados)
    .select(GESTION_SELECT)
    .lean();

  if (!contactados.length) {
    console.log(`✅ Contactados ${mesClave}: 0 filas con Estado de la Cuenta = Contactado en el período analizado.`);
    return { leidos: 0, contactadosDetectados: 0, procesados: 0, origenes: 0, casosReconstruidos: new Set() };
  }

  const casos = new Set(contactados.map((g) => casoKey(g)).filter(Boolean));
  const [eventos, estadosPrevios, metadataDB] = await Promise.all([
    obtenerGestionesDeCasosEnRango(casos, desde, ultimoDia),
    obtenerEstadosPreviosCasos(casos, desde),
    metadataVentanasPorGestionKeys(contactados.map((g) => eventoKey(g))),
  ]);

  const metadataExistente = new Map(metadataDB);
  for (const [key, value] of metadataSeed || []) metadataExistente.set(key, value);

  const { ventanas } = construirVentanasEnMemoria(eventos, {
    now,
    estadosPrevios,
    metadataExistente,
    operadoresPermitidos,
  });

  // Sólo materializamos las ventanas que INICIAN en el mes solicitado. Las filas
  // del mes anterior se usan como contexto para conservar dueño y serie, pero no
  // se duplican ni se reescriben.
  const desdeMes = inicioMesArgentina(mesClave);
  const hastaMes = finMesArgentina(mesClave);
  const delMes = ventanas.filter((v) => {
    const at = new Date(v.iniciaAt);
    return at >= desdeMes && at <= hastaMes;
  });
  const insertadas = await insertarVentanasPorBloques(delMes);
  const origenesMes = delMes.filter((v) => v.esOrigenContactado).length;

  console.log(
    `✅ Contactados ${mesClave}: reconstrucción V5 · ${origenesMes} Contactados reales · ` +
    `${eventos.length} gestiones del universo analizadas · ${insertadas} ventanas creadas · ${Date.now() - inicio} ms.`
  );
  return {
    leidos: eventos.length,
    contactadosDetectados: origenesMes,
    procesados: insertadas,
    origenes: origenesMes,
    casosReconstruidos: casos,
  };
}

function rangoDiasReporteMesActual(mesClave, now = new Date()) {
  const [year, month] = mesClave.split("-").map(Number);
  const primerDia = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const hoyKey = claveFechaArgentina(now);
  const [hy, hm, hd] = hoyKey.split("-").map(Number);
  const ultimoDia = new Date(Date.UTC(hy, hm - 1, hd, 0, 0, 0, 0));
  return { primerDia, ultimoDia };
}

function rangoDiasReporteMesCompleto(mesClave) {
  const [year, month] = String(mesClave || "").split("-").map(Number);
  const primerDia = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const ultimoDia = new Date(Date.UTC(year, month, 0, 0, 0, 0, 0));
  return { primerDia, ultimoDia };
}

function mapaVentanasAbiertasPorCaso(rows = []) {
  const map = new Map();
  const ordenadas = [...rows].sort((a, b) => new Date(b.iniciaAt || 0) - new Date(a.iniciaAt || 0));
  for (const row of ordenadas) {
    const key = row.casoKey || casoKey(row);
    if (key && !map.has(key)) map.set(key, row);
  }
  return map;
}

async function refrescarEstadoActualVentanasAbiertas(now = new Date()) {
  const abiertas = await ContactadoVentana.find({ estado: "abierta", venceAt: { $gt: now } })
    .select("_id dni entidad entidadNumero casoKey operador iniciaAt estadoActual ultimoOperador ultimaGestionAt ultimaGestionKey")
    .lean();
  if (!abiertas.length) return 0;

  const porCaso = new Map();
  for (const row of abiertas) {
    const key = row.casoKey || casoKey(row);
    if (!key) continue;
    if (!porCaso.has(key)) porCaso.set(key, []);
    porCaso.get(key).push(row);
  }
  const dnis = [...new Set(abiertas.map((r) => txt(r.dni).replace(/\D/g, "")).filter(Boolean))];
  const minima = new Date(Math.min(...abiertas.map((r) => new Date(r.iniciaAt).getTime())));
  const desde = diaUtc(minima) || new Date(0);
  const ultimas = new Map();

  for (const bloqueDnis of enBloques(dnis, 500)) {
    const rows = await ReporteGestion.aggregate([
      {
        $match: {
          borrado: { $ne: true },
          dni: { $in: bloqueDnis },
          fecha: { $gte: desde },
        },
      },
      { $sort: { fecha: -1, hora: -1, _id: -1 } },
      {
        $group: {
          _id: { dni: "$dni", entidad: "$entidad" },
          dni: { $first: "$dni" },
          entidadNumero: { $first: "$entidadNumero" },
          entidad: { $first: "$entidad" },
          usuario: { $first: "$usuario" },
          estadoCuenta: { $first: "$estadoCuenta" },
          fecha: { $first: "$fecha" },
          hora: { $first: "$hora" },
          tipoContacto: { $first: "$tipoContacto" },
          resultadoGestion: { $first: "$resultadoGestion" },
          telMailMarcado: { $first: "$telMailMarcado" },
          observacionGestion: { $first: "$observacionGestion" },
        },
      },
    ]).allowDiskUse(true);
    for (const row of rows) {
      const key = casoKey(row);
      if (porCaso.has(key) && !ultimas.has(key)) ultimas.set(key, row);
    }
  }

  const ops = [];
  for (const [key, ventanas] of porCaso.entries()) {
    const gestion = ultimas.get(key);
    if (!gestion) continue;
    const at = fechaHoraGestionArgentina(gestion.fecha, gestion.hora);
    for (const ventana of ventanas) {
      if (!at || at.getTime() <= new Date(ventana.iniciaAt).getTime()) continue;
      const set = {
        casoKey: key,
        estadoActual: txt(gestion.estadoCuenta),
        ultimoOperador: normalizarUsername(gestion.usuario),
        ultimaGestionAt: at,
        ultimaGestionKey: eventoKey(gestion),
      };
      const salidaPorEstado = esEstadoCuentaSalidaContactados(gestion);
      const salidaPorTitular = normalizarUsername(gestion.usuario) === normalizarUsername(ventana.operador)
        && esResultadoSinVoluntadArreglo(gestion);
      if (salidaPorEstado || salidaPorTitular) Object.assign(set, datosCierreTerminal(gestion, at));

      ops.push({
        updateOne: {
          filter: { _id: ventana._id, estado: "abierta" },
          update: { $set: set },
        },
      });
    }
  }
  for (const bloque of enBloques(ops, 1000)) {
    if (bloque.length) await ContactadoVentana.bulkWrite(bloque, { ordered: false });
  }
  return ops.length;
}

async function ejecutarSincronizacion() {
  const syncStartedAt = new Date();
  const now = syncStartedAt;
  const operadoresPermitidos = await obtenerOperadoresActivosContactados();
  const depuracion = await depurarContactadosMaterializados({ operadoresPermitidos });
  const mesClave = mesClaveArgentina(now);
  const mesAnterior = mesAnteriorClave(mesClave);
  const stateKey = `contactados:${SYNC_VERSION}:${mesClave}`;

  // Conservamos preparado el mes anterior para históricos, pero la V5 reconstruye
  // el mes vigente mirando también sus gestiones como contexto de propiedad.
  await asegurarMesContactados(mesAnterior);

  const prep = await prepararReconstruccionRapidaDelMes(mesClave);
  const state = prep.state || await ContactadoSyncState.findOne({ key: stateKey }).lean();
  const esPrimeraCarga = prep.reconstruir || !state?.ultimoCreatedAt;
  const desdeCreated = state?.ultimoCreatedAt
    ? new Date(Math.max(0, new Date(state.ultimoCreatedAt).getTime() - SOLAPE_SYNC_MS))
    : null;
  const { primerDia, ultimoDia } = rangoDiasReporteMesActual(mesClave, now);

  let procesadosNuevos = 0;
  let leidos = 0;
  let diasProcesados = 0;
  let contactadosDetectados = 0;

  if (esPrimeraCarga) {
    // Para resolver arrastres correctamente analizamos desde el primer día del
    // mes anterior. Sólo se materializan las ventanas que comienzan este mes.
    const { primerDia: primerDiaAnterior } = rangoDiasReporteMesCompleto(mesAnterior);
    const r = await reconstruirMesRapido({
      mesClave,
      primerDia,
      ultimoDia,
      now,
      desdeAnalisis: primerDiaAnterior,
      metadataSeed: prep.metadataExistente || new Map(),
      operadoresPermitidos,
    });
    procesadosNuevos = r.procesados;
    leidos = r.leidos;
    contactadosDetectados = r.contactadosDetectados;

    // Series muy antiguas pueden seguir renovándose aunque durante el período de
    // análisis ya no vuelvan a mostrar Estado de la Cuenta = Contactado. Esas
    // ventanas no participan del error que corregimos y se restauran sin tocarlas.
    const casosReconstruidos = r.casosReconstruidos || new Set();
    const restaurar = (prep.ventanasExistentes || []).filter((row) => {
      const key = row.casoKey || casoKey(row);
      return key && !casosReconstruidos.has(key);
    });
    if (restaurar.length) {
      await insertarVentanasPorBloques(restaurar);
      procesadosNuevos += restaurar.length;
    }
    diasProcesados = 1;
  } else {
    const abiertas = await ContactadoVentana.find({ estado: "abierta" }).lean();
    const activeByPair = mapaVentanasAbiertasPorCaso(abiertas);

    const gestionesNuevas = await ReporteGestion.find({
      borrado: { $ne: true },
      createdAt: { $gte: desdeCreated },
      fecha: { $gte: primerDia, $lte: ultimoDia },
    })
      .select(GESTION_SELECT)
      .lean();

    if (gestionesNuevas.length) {
      const resultado = await procesarLoteGestiones(gestionesNuevas, {
        activeByPair,
        now,
        mesClave,
        reconstruirTardias: true,
        operadoresPermitidos,
      });
      procesadosNuevos = resultado.procesados;
      leidos = resultado.leidos;
      contactadosDetectados = resultado.contactadosDetectados || 0;
      diasProcesados = 1;
    }
  }

  await expirarVencidas(now);
  await refrescarEstadoActualVentanasAbiertas(now);
  const eliminadasTerminales = await asegurarLimpiezaEstadosTerminalesMes(mesClave);

  await ContactadoSyncState.findOneAndUpdate(
    { key: stateKey },
    {
      $set: {
        key: stateKey,
        mesClave,
        ultimoCreatedAt: syncStartedAt,
        ultimaEjecucionAt: new Date(),
        gestionesLeidas: leidos,
        contactadosDetectados,
      },
      $inc: { eventosProcesados: procesadosNuevos },
    },
    { upsert: true }
  );

  if (!esPrimeraCarga && procesadosNuevos > 0) {
    console.log(
      `✅ Contactados ${mesClave}: actualización V5 · ${leidos} gestiones nuevas leídas · ` +
      `${contactadosDetectados} Contactados reales · ${procesadosNuevos} eventos aplicados.`
    );
  }

  return {
    mes: mesClave,
    procesados: procesadosNuevos,
    leidos,
    contactadosDetectados,
    diasProcesados,
    primeraCarga: esPrimeraCarga,
    eliminadasTerminales,
    depuracion,
  };
}

let ultimoErrorSync = "";
let ultimoErrorSyncAt = 0;
let ultimoInicioSync = null;
let ultimoFinSync = null;

export function estadoSincronizacionContactados() {
  return {
    enCurso: Boolean(syncEnCurso),
    inicioAt: ultimoInicioSync,
    finAt: ultimoFinSync,
    error: ultimoErrorSync,
  };
}

export async function sincronizarContactados() {
  if (syncEnCurso) return syncEnCurso;
  ultimoInicioSync = new Date();
  ultimoErrorSync = "";
  syncEnCurso = ejecutarSincronizacion()
    .catch((error) => {
      ultimoErrorSync = error?.message || String(error || "Error de sincronización");
      ultimoErrorSyncAt = Date.now();
      console.error("⚠️ Error sincronizando Contactados:", ultimoErrorSync);
      throw error;
    })
    .finally(() => {
      ultimoFinSync = new Date();
      ultimoDisparoBackgroundAt = Date.now();
      syncEnCurso = null;
    });
  return syncEnCurso;
}

export function sincronizarContactadosEnSegundoPlano() {
  const ahora = Date.now();
  // Una misma pantalla puede pedir catálogo, listado y estadísticas casi juntas.
  // Evitamos disparar varias sincronizaciones incrementales consecutivas por esas lecturas.
  const backoffPorError = ultimoErrorSyncAt > 0 && ahora - ultimoErrorSyncAt < 5 * 60_000;
  if (syncEnCurso || backoffPorError || ahora - ultimoDisparoBackgroundAt < BACKGROUND_SYNC_MIN_INTERVAL_MS) {
    return estadoSincronizacionContactados();
  }
  ultimoDisparoBackgroundAt = ahora;
  sincronizarContactados().catch(() => {});
  return estadoSincronizacionContactados();
}

async function limpiarContinuacionesEstadosTerminales(mesClave) {
  const series = await ContactadoVentana.distinct("serieId", {
    mesOrigen: mesClave,
    $or: [
      { calificacionInicio: PAGO_A_IMPUTAR_RX },
      { estadoCuentaInicio: PAGO_A_IMPUTAR_RX },
      { calificacionInicio: INCOBRABLE_RX },
      { estadoCuentaInicio: INCOBRABLE_RX },
      { calificacionInicio: ACUERDO_PAGO_RX },
      { estadoCuentaInicio: ACUERDO_PAGO_RX },
      { calificacionInicio: ACUERDO_CUMPLIDO_RX },
      { estadoCuentaInicio: ACUERDO_CUMPLIDO_RX },
      { calificacionInicio: NO_VOLUNTAD_ARREGLO_RX },
    ],
  });
  if (!series.length) return 0;

  // Antes se hacía un find por cada serie y, cuando correspondía, un update por
  // cada fila. En meses grandes eso generaba cientos/miles de viajes a Mongo.
  // Leemos todas las series afectadas de una sola vez y resolvemos la limpieza
  // en memoria; después aplicamos los cambios por bloques.
  const rows = await ContactadoVentana.find({ mesOrigen: mesClave, serieId: { $in: series } })
    .select("_id serieId iniciaAt calificacionInicio estadoCuentaInicio esOrigenContactado")
    .sort({ serieId: 1, iniciaAt: 1 })
    .lean();

  const porSerie = new Map();
  for (const row of rows) {
    if (!porSerie.has(row.serieId)) porSerie.set(row.serieId, []);
    porSerie.get(row.serieId).push(row);
  }

  const borrar = [];
  const promoverOrigen = [];
  for (const serieRows of porSerie.values()) {
    for (let i = 0; i < serieRows.length; i += 1) {
      const row = serieRows[i];
      const pseudoGestion = {
        resultadoGestion: row.calificacionInicio,
        estadoCuenta: row.estadoCuentaInicio,
      };
      if (!esGestionTerminalContactados(pseudoGestion)) continue;

      let j = i;
      while (j < serieRows.length) {
        const candidata = serieRows[j];
        const candidataGestion = {
          resultadoGestion: candidata.calificacionInicio,
          estadoCuenta: candidata.estadoCuentaInicio,
        };
        const esNuevoContactado = j > i && esGestionContactado(candidataGestion);
        if (esNuevoContactado) {
          if (!candidata.esOrigenContactado) promoverOrigen.push(candidata._id);
          break;
        }
        borrar.push(candidata._id);
        j += 1;
      }
      i = Math.max(i, j - 1);
    }
  }

  for (const bloque of enBloques(promoverOrigen, 1000)) {
    if (bloque.length) {
      await ContactadoVentana.updateMany(
        { _id: { $in: bloque } },
        { $set: { esOrigenContactado: true } }
      );
    }
  }

  let eliminadas = 0;
  for (const bloque of enBloques(borrar, 2000)) {
    if (!bloque.length) continue;
    const r = await ContactadoVentana.deleteMany({ _id: { $in: bloque } });
    eliminadas += Number(r?.deletedCount || 0);
  }
  return eliminadas;
}

export async function asegurarLimpiezaEstadosTerminalesMes(mesClave) {
  if (limpiezaTerminalMesConfirmada.has(mesClave)) return 0;
  const key = `contactados:cleanup-terminales-v4:${mesClave}`;
  const hecha = await ContactadoSyncState.findOne({ key }).select("_id").lean();
  if (hecha) {
    limpiezaTerminalMesConfirmada.add(mesClave);
    return 0;
  }
  const eliminadas = await limpiarContinuacionesEstadosTerminales(mesClave);
  await ContactadoSyncState.findOneAndUpdate(
    { key },
    { $set: { key, mesClave, ultimaEjecucionAt: new Date(), eventosProcesados: eliminadas } },
    { upsert: true }
  );
  limpiezaTerminalMesConfirmada.add(mesClave);
  return eliminadas;
}

export async function asegurarMesContactados(mesSolicitado) {
  const mesClave = /^\d{4}-\d{2}$/.test(String(mesSolicitado || ""))
    ? String(mesSolicitado)
    : mesClaveArgentina();

  // El mes vigente mantiene su sincronización incremental normal. Esta función
  // conserva el comportamiento bloqueante para jobs/migraciones explícitas; las
  // lecturas HTTP del mes actual usan el disparo en segundo plano del controller.
  if (mesClave === mesClaveArgentina()) {
    await sincronizarContactados();
    return { mes: mesClave, actual: true };
  }

  if (mesesHistoricosConfirmados.has(mesClave)) {
    return { mes: mesClave, preparado: true, desdeCacheMemoria: true };
  }

  const stateKey = `contactados:historico-v8-fin-dia:${mesClave}`;
  const yaPreparado = await ContactadoSyncState.findOne({ key: stateKey }).select("_id").lean();
  if (yaPreparado) {
    mesesHistoricosConfirmados.add(mesClave);
    return { mes: mesClave, preparado: true, desdeCache: true };
  }

  if (syncHistoricoEnCurso.has(mesClave)) return syncHistoricoEnCurso.get(mesClave);

  const tarea = (async () => {
    const existentes = await ContactadoVentana.countDocuments({ mesOrigen: mesClave });
    let resultado = { leidos: 0, contactadosDetectados: 0, procesados: 0, origenes: 0 };

    // Limpieza compatible con históricos ya existentes: las versiones anteriores
    // podían crear una nueva ventana desde un estado terminal (Pago a imputar o
    // estados terminales o No tiene voluntad de arreglo. Eliminamos esa continuación artificial, preservando el
    // ciclo Contactado anterior, sus checks y las observaciones de la serie.
    const eliminadasTerminales = existentes ? await asegurarLimpiezaEstadosTerminalesMes(mesClave) : 0;

    // Los históricos se generan bajo demanda. Si el mes todavía no existe, se
    // reconstruye desde Reporte de Gestiones con la regla nueva.
    if (!existentes) {
      const { primerDia, ultimoDia } = rangoDiasReporteMesCompleto(mesClave);
      // El histórico conserva la producción válida de personas que estaban
      // activas en ese momento aunque hoy ya no formen parte del equipo.
      resultado = await reconstruirMesRapido({
        mesClave,
        primerDia,
        ultimoDia,
        now: new Date(),
      });
    }

    await ContactadoSyncState.findOneAndUpdate(
      { key: stateKey },
      {
        $set: {
          key: stateKey,
          mesClave,
          ultimoCreatedAt: new Date(),
          ultimaEjecucionAt: new Date(),
          gestionesLeidas: Number(resultado.leidos || 0),
          contactadosDetectados: Number(resultado.contactadosDetectados || 0),
        },
        $inc: { eventosProcesados: Number(resultado.procesados || 0) },
      },
      { upsert: true }
    );

    mesesHistoricosConfirmados.add(mesClave);
    return { mes: mesClave, preparado: true, existentes, eliminadasTerminales, ...resultado };
  })().finally(() => {
    syncHistoricoEnCurso.delete(mesClave);
  });

  syncHistoricoEnCurso.set(mesClave, tarea);
  return tarea;
}

export async function reconciliarContactadosTrasCambioGestiones() {
  // Si había una sincronización en curso, dejamos que termine antes de invalidar
  // el estado; de lo contrario podría volver a grabar un cursor incremental viejo.
  if (syncEnCurso) {
    try {
      await syncEnCurso;
    } catch {
      // La reconstrucción forzada de abajo vuelve a intentar desde un estado limpio.
    }
  }

  const operadoresPermitidos = await obtenerOperadoresActivosContactados();
  const depuracion = await depurarContactadosMaterializados({ operadoresPermitidos });
  const mesClave = mesClaveArgentina();

  await ContactadoSyncState.deleteMany({
    $or: [
      { key: `contactados:${SYNC_VERSION}:${mesClave}` },
      { key: `contactados:cleanup-terminales-v4:${mesClave}` },
    ],
  });
  limpiezaTerminalMesConfirmada.delete(mesClave);
  mesesHistoricosConfirmados.delete(mesClave);

  const reconstruccion = await sincronizarContactados();
  return { mes: mesClave, depuracion, reconstruccion };
}

export async function expirarContactadosAhora() {
  return expirarVencidas(new Date());
}

export { detectarTelefono, eventoKey };
