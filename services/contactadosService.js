import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import ReporteGestion from "../models/ReporteGestion.js";
import ContactadoVentana from "../models/ContactadoVentana.js";
import ContactadoSyncState from "../models/ContactadoSyncState.js";
import ContactadoObservacion from "../models/ContactadoObservacion.js";
import {
  agregarHorasHabilesArgentina,
  fechaHoraGestionArgentina,
  claveFechaArgentina,
  inicioMesArgentina,
  finMesArgentina,
} from "../utils/contactadosTiempo.js";

const CONTACTADO_RX = /contactad[oa]/i;
const PAGO_A_IMPUTAR_RX = /pago\s+a\s+imputar/i;
const ACUERDO_PAGO_RX = /^\s*acuerdo\s+de\s+pago(?:\s*[-–—:]?\s*cumplido)?\s*$/i;
const DIA_MS = 86_400_000;
const SOLAPE_SYNC_MS = 5 * 60 * 1000;
const SYNC_VERSION = "mensual-v3-fast";
const GESTION_SELECT = "_id dni nombreDeudor fecha hora usuario tipoContacto resultadoGestion estadoCuenta telMailMarcado observacionGestion entidad entidadNumero createdAt";
const BACKGROUND_SYNC_MIN_INTERVAL_MS = 45_000;
let syncEnCurso = null;
let ultimoDisparoBackgroundAt = 0;
const syncHistoricoEnCurso = new Map();
const limpiezaTerminalMesConfirmada = new Set();

function txt(value) {
  return String(value ?? "").trim();
}

function normalizarUsername(value) {
  return txt(value).toLowerCase();
}

function mesClaveArgentina(date = new Date()) {
  return claveFechaArgentina(date).slice(0, 7);
}

function mesClaveGestion(gestion = {}) {
  const fecha = gestion?.fecha instanceof Date ? gestion.fecha : new Date(gestion?.fecha);
  if (Number.isNaN(fecha?.getTime?.())) return "";
  return `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function esGestionPagoAImputar(gestion = {}) {
  return PAGO_A_IMPUTAR_RX.test(`${txt(gestion.resultadoGestion)} | ${txt(gestion.estadoCuenta)}`);
}

export function esGestionAcuerdoPago(gestion = {}) {
  return ACUERDO_PAGO_RX.test(txt(gestion.resultadoGestion))
    || ACUERDO_PAGO_RX.test(txt(gestion.estadoCuenta));
}

export function esGestionTerminalContactados(gestion = {}) {
  return esGestionPagoAImputar(gestion) || esGestionAcuerdoPago(gestion);
}

export function esGestionContactado(gestion = {}) {
  const texto = `${txt(gestion.resultadoGestion)} | ${txt(gestion.estadoCuenta)}`;
  return CONTACTADO_RX.test(texto) && !esGestionTerminalContactados(gestion);
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

function ventanaDesdeGestion(gestion, { serieId, esOrigenContactado = false, telefonoFallback = null, mesOrigen = "" } = {}) {
  const iniciaAt = fechaHoraGestionArgentina(gestion.fecha, gestion.hora);
  const tel = detectarTelefono(gestion.telMailMarcado);
  const telefono = tel.telefonoVisible ? tel : (telefonoFallback || tel);
  return {
    serieId: serieId || randomUUID(),
    mesOrigen: mesOrigen || mesClaveGestion(gestion),
    gestionInicioKey: eventoKey(gestion),
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
    venceAt: agregarHorasHabilesArgentina(iniciaAt, 72),
    estado: "abierta",
    esOrigenContactado,
    calificacionInicio: calificacionGestion(gestion),
    tipoContactoInicio: txt(gestion.tipoContacto),
    estadoCuentaInicio: txt(gestion.estadoCuenta),
    observacionGestionInicio: txt(gestion.observacionGestion).slice(0, 3000),
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
    mesOrigen: mesClave,
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

  // "Pago a imputar" informa que el pago ya fue comunicado. Resuelve la ventana
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
    mesOrigen: mesClave,
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
    mesOrigen: mesClave,
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

async function clavesYaProcesadas(keys = [], mesClave = "") {
  const out = new Set();
  // Evita construir un $in gigantesco si una jornada tiene muchísimas gestiones.
  const TAMANIO = 5000;
  for (let i = 0; i < keys.length; i += TAMANIO) {
    const bloque = keys.slice(i, i + TAMANIO);
    const rows = await ContactadoVentana.find({ gestionInicioKey: { $in: bloque }, ...(mesClave ? { mesOrigen: mesClave } : {}) })
      .select("gestionInicioKey")
      .lean();
    rows.forEach((row) => {
      if (row.gestionInicioKey) out.add(row.gestionInicioKey);
    });
  }
  return out;
}

async function procesarLoteGestiones(gestiones, { activeByPair, now, mesClave, reconstruirTardias = true }) {
  if (!gestiones.length) return { procesados: 0, leidos: 0, contactadosDetectados: 0 };

  const unicos = new Map();
  for (const gestion of gestiones) {
    const key = eventoKey(gestion);
    if (!unicos.has(key)) unicos.set(key, { ...gestion, __key: key });
  }
  const eventos = [...unicos.values()].sort(compararEventos);
  const procesadas = await clavesYaProcesadas(eventos.map((e) => e.__key), mesClave);

  let procesadosNuevos = 0;
  let contactadosDetectados = 0;
  for (const gestion of eventos) {
    if (esGestionContactado(gestion)) contactadosDetectados += 1;
    if (procesadas.has(gestion.__key)) continue;
    const eventAt = fechaHoraGestionArgentina(gestion.fecha, gestion.hora);
    if (!eventAt) continue;
    const operador = normalizarUsername(gestion.usuario);
    const dni = txt(gestion.dni).replace(/\D/g, "");
    if (!operador || !dni) continue;

    const pairKey = `${operador}|${dni}`;
    let activa = activeByPair.get(pairKey) || null;

    // Una carga tardía puede traer una gestión anterior a la ventana que hoy
    // está abierta. Primero intentamos insertarla dentro de una ventana histórica.
    if (activa && eventAt.getTime() <= new Date(activa.iniciaAt).getTime()) {
      const reconciliada = await reconciliarEventoHistorico(gestion, eventAt, operador, dni, activeByPair, now, mesClave);
      if (reconciliada) {
        procesadas.add(gestion.__key);
        procesadosNuevos += 1;
        continue;
      }
      const creadaHistorica = await crearContactadoHistoricoAntesDeVentana(
        gestion,
        eventAt,
        operador,
        dni,
        activeByPair,
        now,
        mesClave
      );
      if (creadaHistorica) {
        procesadas.add(gestion.__key);
        procesadosNuevos += 1;
      }
      continue;
    }

    if (activa && eventAt.getTime() > new Date(activa.venceAt).getTime()) {
      await ContactadoVentana.updateOne(
        { _id: activa._id, estado: "abierta" },
        { $set: { estado: "vencida", cerradaAt: activa.venceAt } }
      );
      activeByPair.delete(pairKey);
      activa = null;
    }

    if (activa) {
      const iniciaMs = new Date(activa.iniciaAt).getTime();
      if (eventAt.getTime() <= iniciaMs) continue;

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

      if (esGestionTerminalContactados(gestion)) {
        activeByPair.delete(pairKey);
        procesadas.add(gestion.__key);
        procesadosNuevos += 1;
        continue;
      }

      const nuevaData = ventanaDesdeGestion(gestion, {
        serieId: activa.serieId,
        esOrigenContactado: false,
        telefonoFallback: telefonoFallbackVentana(activa),
        mesOrigen: activa.mesOrigen || mesClave,
      });
      try {
        const nueva = await ContactadoVentana.create(nuevaData);
        activeByPair.set(pairKey, nueva.toObject());
        procesadas.add(gestion.__key);
        procesadosNuevos += 1;
      } catch (error) {
        if (Number(error?.code) !== 11000) throw error;
      }
      continue;
    }

    // En la reconstrucción inicial del mes los eventos vienen cronológicos, por
    // lo que una gestión sin ventana activa y que NO es Contactado no puede
    // aportar nada. Saltearla acá evita una consulta Mongo por cada gestión común
    // y hace que la primera carga mensual sea muchísimo más rápida.
    if (!reconstruirTardias && !esGestionContactado(gestion)) continue;

    if (reconstruirTardias) {
      const reconciliada = await reconciliarEventoHistorico(gestion, eventAt, operador, dni, activeByPair, now, mesClave);
      if (reconciliada) {
        procesadas.add(gestion.__key);
        procesadosNuevos += 1;
        continue;
      }

      // Si es un Contactado importado tarde y ya existe una ventana posterior,
      // lo reconstruimos sin convertirlo erróneamente en una ventana abierta actual.
      const creadaHistorica = await crearContactadoHistoricoAntesDeVentana(
        gestion,
        eventAt,
        operador,
        dni,
        activeByPair,
        now,
        mesClave
      );
      if (creadaHistorica) {
        procesadas.add(gestion.__key);
        procesadosNuevos += 1;
        continue;
      }
    }

    if (!esGestionContactado(gestion)) continue;
    const nuevaData = ventanaDesdeGestion(gestion, {
      serieId: randomUUID(),
      esOrigenContactado: true,
      mesOrigen: mesClave || mesClaveGestion(gestion),
    });
    try {
      const nueva = await ContactadoVentana.create(nuevaData);
      activeByPair.set(pairKey, nueva.toObject());
      procesadas.add(gestion.__key);
      procesadosNuevos += 1;
    } catch (error) {
      if (Number(error?.code) !== 11000) throw error;
    }
  }

  return { procesados: procesadosNuevos, leidos: gestiones.length, contactadosDetectados };
}

async function expirarVencidas(now = new Date()) {
  return ContactadoVentana.updateMany(
    { estado: "abierta", venceAt: { $lte: now } },
    [{ $set: { estado: "vencida", cerradaAt: "$venceAt" } }]
  );
}

async function prepararReconstruccionRapidaDelMes(mesClave) {
  const stateKey = `contactados:${SYNC_VERSION}:${mesClave}`;
  const existente = await ContactadoSyncState.findOne({ key: stateKey }).lean();
  if (existente) return { reconstruir: false, state: existente };

  // Migración única desde las versiones iniciales. Esas versiones podían quedar
  // procesando durante minutos y dejar ventanas parciales aunque el frontend ya
  // hubiera agotado su timeout. Para garantizar un mes consistente, V3 recompone
  // solamente el mes vigente una sola vez y no toca Reporte de Gestiones ni Pagos.
  const desde = inicioMesArgentina(mesClave);
  const hasta = finMesArgentina(mesClave);
  const filtroMes = {
    $or: [
      { mesOrigen: mesClave },
      {
        iniciaAt: { $gte: desde, $lte: hasta },
        $or: [{ mesOrigen: { $exists: false } }, { mesOrigen: "" }],
      },
    ],
  };
  const series = await ContactadoVentana.distinct("serieId", filtroMes);
  if (series.length) await ContactadoObservacion.deleteMany({ serieId: { $in: series } });
  await ContactadoVentana.deleteMany(filtroMes);

  // Las marcas viejas se dejan como auditoría técnica, pero ya no gobiernan el
  // módulo: V3 usa una clave mensual/versionada propia.
  console.log(`⚡ Contactados ${mesClave}: preparando reconstrucción rápida del mes vigente.`);
  return { reconstruir: true, state: null };
}

function enBloques(items = [], size = 700) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function construirVentanasEnMemoria(eventos = [], { now, mesClave }) {
  const unicos = new Map();
  for (const gestion of eventos) {
    const key = eventoKey(gestion);
    if (!unicos.has(key)) unicos.set(key, { ...gestion, __key: key });
  }
  const ordenados = [...unicos.values()].sort(compararEventos);
  const porPar = new Map();
  for (const gestion of ordenados) {
    const operador = normalizarUsername(gestion.usuario);
    const dni = txt(gestion.dni).replace(/\D/g, "");
    if (!operador || !dni) continue;
    const key = `${operador}|${dni}`;
    if (!porPar.has(key)) porPar.set(key, []);
    porPar.get(key).push(gestion);
  }

  const ventanas = [];
  let origenes = 0;

  for (const gestionesPar of porPar.values()) {
    let activa = null;
    for (const gestion of gestionesPar) {
      const eventAt = fechaHoraGestionArgentina(gestion.fecha, gestion.hora);
      if (!eventAt) continue;

      if (activa && eventAt.getTime() > new Date(activa.venceAt).getTime()) {
        activa.estado = "vencida";
        activa.cerradaAt = activa.venceAt;
        activa = null;
      }

      if (!activa) {
        if (!esGestionContactado(gestion)) continue;
        activa = ventanaDesdeGestion(gestion, {
          serieId: randomUUID(),
          esOrigenContactado: true,
          mesOrigen: mesClave,
        });
        ventanas.push(activa);
        origenes += 1;
        continue;
      }

      if (eventAt.getTime() <= new Date(activa.iniciaAt).getTime()) continue;

      activa.estado = eventAt.getTime() >= new Date(activa.alertaAt).getTime()
        ? "cumplida"
        : "renovada_anticipada";
      activa.cerradaAt = eventAt;
      activa.gestionResolucionKey = gestion.__key;
      activa.gestionResolucionId = gestion._id || null;
      activa.calificacionResolucion = calificacionGestion(gestion);
      activa.tipoContactoResolucion = txt(gestion.tipoContacto);
      activa.estadoCuentaResolucion = txt(gestion.estadoCuenta);

      if (esGestionTerminalContactados(gestion)) {
        activa = null;
        continue;
      }

      activa = ventanaDesdeGestion(gestion, {
        serieId: activa.serieId,
        esOrigenContactado: false,
        telefonoFallback: telefonoFallbackVentana(activa),
        mesOrigen: mesClave,
      });
      ventanas.push(activa);
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

async function reconstruirMesRapido({ mesClave, primerDia, ultimoDia, now }) {
  const inicio = Date.now();

  // PASO 1: localizar únicamente las gestiones que realmente califican como
  // Contactado. Ya no recorremos ni procesamos cada gestión común del mes.
  const contactados = await ReporteGestion.find({
    borrado: { $ne: true },
    fecha: { $gte: primerDia, $lte: ultimoDia },
    $or: [
      { resultadoGestion: CONTACTADO_RX },
      { estadoCuenta: CONTACTADO_RX },
    ],
  })
    .select(GESTION_SELECT)
    .lean();

  if (!contactados.length) {
    console.log(`✅ Contactados ${mesClave}: 0 gestiones calificadas Contactado en el mes vigente.`);
    return { leidos: 0, contactadosDetectados: 0, procesados: 0, origenes: 0 };
  }

  // PASO 2: sólo necesitamos las gestiones de DNI+operador que tuvieron por lo
  // menos un Contactado. Todo el resto de reportegestions queda fuera del cálculo.
  const pares = new Set();
  const dnis = new Set();
  for (const g of contactados) {
    const operador = normalizarUsername(g.usuario);
    const dni = txt(g.dni).replace(/\D/g, "");
    if (!operador || !dni) continue;
    pares.add(`${operador}|${dni}`);
    dnis.add(dni);
  }

  const eventos = [];
  for (const bloqueDnis of enBloques([...dnis], 700)) {
    const rows = await ReporteGestion.find({
      borrado: { $ne: true },
      fecha: { $gte: primerDia, $lte: ultimoDia },
      dni: { $in: bloqueDnis },
    })
      .select(GESTION_SELECT)
      .lean();
    for (const row of rows) {
      const par = `${normalizarUsername(row.usuario)}|${txt(row.dni).replace(/\D/g, "")}`;
      if (pares.has(par)) eventos.push(row);
    }
  }

  const { ventanas, origenes } = construirVentanasEnMemoria(eventos, { now, mesClave });
  const insertadas = await insertarVentanasPorBloques(ventanas);
  console.log(
    `✅ Contactados ${mesClave}: reconstrucción rápida · ${contactados.length} Contactados detectados · ` +
    `${eventos.length} gestiones relevantes leídas · ${insertadas} ventanas creadas · ${Date.now() - inicio} ms.`
  );
  return {
    leidos: eventos.length,
    contactadosDetectados: contactados.length,
    procesados: insertadas,
    origenes,
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

async function ejecutarSincronizacion() {
  const syncStartedAt = new Date();
  const now = syncStartedAt;
  const mesClave = mesClaveArgentina(now);
  const stateKey = `contactados:${SYNC_VERSION}:${mesClave}`;
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
    const r = await reconstruirMesRapido({ mesClave, primerDia, ultimoDia, now });
    procesadosNuevos = r.procesados;
    leidos = r.leidos;
    contactadosDetectados = r.contactadosDetectados;
    diasProcesados = 1;
  } else {
    const abiertas = await ContactadoVentana.find({ estado: "abierta", mesOrigen: mesClave }).lean();
    const activeByPair = new Map(abiertas.map((v) => [`${v.operador}|${v.dni}`, v]));

    // Las actualizaciones son pequeñas: sólo registros importados desde el último
    // corte y cuya FECHA pertenece al mes vigente. Esto sí puede procesarse en
    // forma incremental sin reconstruir nada.
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
      });
      procesadosNuevos = resultado.procesados;
      leidos = resultado.leidos;
      contactadosDetectados = resultado.contactadosDetectados || 0;
      diasProcesados = 1;
    }
  }

  await expirarVencidas(now);
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
      `✅ Contactados ${mesClave}: actualización · ${leidos} gestiones nuevas leídas · ` +
      `${contactadosDetectados} Contactado · ${procesadosNuevos} eventos procesados.`
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
  };
}

let ultimoErrorSync = "";
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
  if (syncEnCurso || ahora - ultimoDisparoBackgroundAt < BACKGROUND_SYNC_MIN_INTERVAL_MS) {
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
      { calificacionInicio: ACUERDO_PAGO_RX },
      { estadoCuentaInicio: ACUERDO_PAGO_RX },
    ],
  });
  if (!series.length) return 0;

  let eliminadas = 0;
  for (const serieId of series) {
    const rows = await ContactadoVentana.find({ mesOrigen: mesClave, serieId })
      .select("_id iniciaAt calificacionInicio estadoCuentaInicio esOrigenContactado")
      .sort({ iniciaAt: 1 })
      .lean();

    const borrar = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const pseudoGestion = {
        resultadoGestion: row.calificacionInicio,
        estadoCuenta: row.estadoCuentaInicio,
      };
      if (!esGestionTerminalContactados(pseudoGestion)) continue;

      // Pago a imputar, Acuerdo de pago y Acuerdo de pago cumplido sacan el caso
      // del circuito vivo de Contactados. Se borra la ventana artificial que esas
      // gestiones pudieron haber iniciado en versiones anteriores y toda su
      // continuación hasta que aparezca un Contactado real nuevo.
      let j = i;
      while (j < rows.length) {
        const candidata = rows[j];
        const candidataGestion = {
          resultadoGestion: candidata.calificacionInicio,
          estadoCuenta: candidata.estadoCuentaInicio,
        };
        const esNuevoContactado = j > i && esGestionContactado(candidataGestion);
        if (esNuevoContactado) {
          if (!candidata.esOrigenContactado) {
            await ContactadoVentana.updateOne({ _id: candidata._id }, { $set: { esOrigenContactado: true } });
          }
          break;
        }
        borrar.push(candidata._id);
        j += 1;
      }
      i = Math.max(i, j - 1);
    }

    if (borrar.length) {
      const r = await ContactadoVentana.deleteMany({ _id: { $in: borrar } });
      eliminadas += Number(r?.deletedCount || 0);
    }
  }
  return eliminadas;
}

export async function asegurarLimpiezaEstadosTerminalesMes(mesClave) {
  if (limpiezaTerminalMesConfirmada.has(mesClave)) return 0;
  const key = `contactados:cleanup-terminales-v2:${mesClave}`;
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

  // El mes vigente mantiene su sincronización incremental normal.
  if (mesClave === mesClaveArgentina()) {
    await sincronizarContactados();
    return { mes: mesClave, actual: true };
  }

  const stateKey = `contactados:historico-v3-terminales:${mesClave}`;
  const yaPreparado = await ContactadoSyncState.findOne({ key: stateKey }).lean();
  if (yaPreparado) return { mes: mesClave, preparado: true, desdeCache: true };

  if (syncHistoricoEnCurso.has(mesClave)) return syncHistoricoEnCurso.get(mesClave);

  const tarea = (async () => {
    const existentes = await ContactadoVentana.countDocuments({ mesOrigen: mesClave });
    let resultado = { leidos: 0, contactadosDetectados: 0, procesados: 0, origenes: 0 };

    // Limpieza compatible con históricos ya existentes: las versiones anteriores
    // podían crear una nueva ventana desde un estado terminal (Pago a imputar o
    // Acuerdo de pago). Eliminamos esa continuación artificial, preservando el
    // ciclo Contactado anterior, sus checks y las observaciones de la serie.
    const eliminadasTerminales = existentes ? await limpiarContinuacionesEstadosTerminales(mesClave) : 0;

    // Los históricos se generan bajo demanda. Si el mes todavía no existe, se
    // reconstruye desde Reporte de Gestiones con la regla nueva.
    if (!existentes) {
      const { primerDia, ultimoDia } = rangoDiasReporteMesCompleto(mesClave);
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

    return { mes: mesClave, preparado: true, existentes, eliminadasTerminales, ...resultado };
  })().finally(() => {
    syncHistoricoEnCurso.delete(mesClave);
  });

  syncHistoricoEnCurso.set(mesClave, tarea);
  return tarea;
}

export async function expirarContactadosAhora() {
  return expirarVencidas(new Date());
}

export { detectarTelefono, eventoKey };
