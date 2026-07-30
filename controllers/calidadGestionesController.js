import mongoose from "mongoose";
import ReporteGestion from "../models/ReporteGestion.js";

const CACHE_TTL_MS = 120_000;
const MAX_RANGE_DAYS = 92;
const MAX_ROWS = 80_000;
const cache = new Map();

const MEANINGFUL_RESULTS = new Set([
  "contactado",
  "mensaje directo",
  "mensaje indirecto",
  "dice que pago",
  "acuerdo libre",
  "bajo acuerdo",
  "pago a imputar",
  "acuerdo caido",
  "no tiene voluntad de arreglo",
  "acuerdo parcial",
  "no reconoce deuda",
  "no tiene dinero",
  "fallecido",
  "cancelacion anterior",
]);

const NO_ANSWER_RESULTS = new Set([
  "no contesta",
  "mensaje contestador",
  "ocupado",
  "fuera de servicio",
]);

const INBOUND_IMPOSSIBLE_RESULTS = new Set([
  ...NO_ANSWER_RESULTS,
  "mail libre",
  "envio whatsapp",
  "nota",
  "cambio de linea",
  "imposible ubicar titular",
]);

const LOW_EVIDENCE_RESULTS = new Set([
  ...NO_ANSWER_RESULTS,
  "mail libre",
  "envio whatsapp",
  "mensaje directo",
  "mensaje indirecto",
  "nota",
  "cambio de linea",
  "imposible ubicar titular",
]);

const ALERT_DEFINITIONS = {
  repetida_mismo_dia: {
    label: "Carga idéntica repetida",
    badge: "Revisión prioritaria",
    tone: "alta",
    description:
      "La misma gestión fue registrada más de una vez sobre el mismo DNI durante el día.",
  },
  entrante_con_plantilla: {
    label: "Canal de gestión mal seleccionado",
    badge: "Corregir clasificación",
    tone: "observacion",
    description:
      "La gestión figura como llamada entrante, pero la observación corresponde a un mensaje o una campaña iniciada desde el estudio.",
  },
  entrante_resultado_incoherente: {
    label: "Canal o tipo de gestión a corregir",
    badge: "Corregir clasificación",
    tone: "observacion",
    description:
      "La gestión figura como llamada entrante telefónica, pero el resultado corresponde a otro canal o a una campaña automática.",
  },
  contacto_sin_observacion: {
    label: "Contacto sin explicación de lo conversado",
    badge: "Completar registro",
    tone: "media",
    description:
      "Se informó que hubo contacto, acuerdo, pago o una respuesta del titular, pero no quedó asentado qué pasó ni cómo continuó la gestión.",
  },
  sin_destino: {
    label: "Medio de contacto sin dato",
    badge: "Completar registro",
    tone: "media",
    description:
      "El canal informado no cuenta con teléfono o correo en el campo correspondiente.",
  },
  rafaga_llamadas: {
    label: "Actividad concentrada para validar",
    badge: "Revisión prioritaria",
    tone: "alta",
    description:
      "Se registraron llamadas sobre varios DNI en un período muy breve.",
  },
  corta_bache: {
    label: "Gestión aislada que parece cortar un bache",
    badge: "Validar gestión",
    tone: "media",
    description:
      "Una o pocas acciones sin explicación real o con texto plantilla quedaron entre dos períodos largos sin registros y pueden dar la impresión de haberse cargado solo para cortar el bache.",
  },
};

function getUserId(req) {
  return req?.user?.id || req?.usuario?._id || req?.userId || null;
}

function getRole(req) {
  return req?.user?.rol || req?.user?.role || req?.usuario?.rol || req?.usuario?.role || "";
}

function ownerScope(req) {
  const userId = getUserId(req);
  const role = String(getRole(req) || "").toLowerCase();
  const onlyMine = String(req?.query?.onlyMine || "").toLowerCase() === "true";
  if (!userId) return {};
  if (["admin", "super-admin", "superadmin"].includes(role) && !onlyMine) return {};
  return { propietario: new mongoose.Types.ObjectId(userId) };
}

function startDay(raw) {
  const value = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function endDay(raw) {
  const value = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function splitCsv(raw) {
  const values = Array.isArray(raw) ? raw : String(raw || "").split(",");
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function canonical(value) {
  return stripAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function exactText(value) {
  return stripAccents(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function compactExact(value) {
  return exactText(value).replace(/\s+/g, "");
}

function isoDay(date) {
  const parsed = date instanceof Date ? date : new Date(date);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function timestampOf(row) {
  const day = isoDay(row.fecha);
  const time = /^\d{2}:\d{2}:\d{2}$/.test(String(row.hora || ""))
    ? String(row.hora)
    : "00:00:00";
  const date = new Date(`${day}T${time}.000Z`);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function emailType(row) {
  const type = canonical(row.tipoContacto);
  return type.includes("mail") || type.includes("email");
}

function callType(row) {
  return canonical(row.tipoContacto).includes("llamada");
}

function inboundCallType(row) {
  return canonical(row.tipoContacto).includes("llamada entrante");
}

function inboundIvrType(row) {
  const type = canonical(row.tipoContacto);
  return type.includes("llamada entrante") && type.includes("ivr");
}

function inboundHumanCallType(row) {
  return inboundCallType(row) && !inboundIvrType(row);
}

function whatsappType(row) {
  return canonical(row.tipoContacto).includes("whatsapp");
}

function hasEmail(value) {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(String(value || ""));
}

function hasPhone(value) {
  return /\d{7,}/.test(String(value || "").replace(/\D/g, ""));
}

function meaningful(row) {
  return MEANINGFUL_RESULTS.has(canonical(row.resultadoGestion));
}

function lowEvidence(row) {
  return LOW_EVIDENCE_RESULTS.has(canonical(row.resultadoGestion)) || emailType(row) || whatsappType(row);
}

function suspiciousGapAction(row) {
  if (!lowEvidence(row)) return false;
  // Una gestión con una explicación concreta de una conversación real no se
  // observa solo por haber quedado entre dos pausas. Para el control de baches
  // se consideran únicamente acciones sin observación o con texto plantilla
  // de un envío/campaña.
  return !hasRealObservation(row) || looksLikeOutboundTemplate(row);
}

function cleanObservation(value) {
  return canonical(value).replace(
    /^(observacion corta|obervacion corta|observacion|obervacion|asunto)\s*/,
    "",
  );
}

function hasRealObservation(row) {
  const text = cleanObservation(row.observacionGestion);
  return Boolean(text && !["sin observacion", "s o", "n a", "no aplica"].includes(text));
}

function inferOutboundMessageChannel(row) {
  const raw = String(row.observacionGestion || "");
  const text = canonical(raw);
  const result = canonical(row.resultadoGestion);
  if (!text) return "";

  const emailMarkers = [
    /^\s*asunto\s*:/i.test(raw),
    hasEmail(raw),
    text.includes("correo"),
    text.includes("e mail"),
    text.includes("email"),
    result === "mail libre",
  ].filter(Boolean).length;
  if (emailMarkers >= 2 || /^\s*asunto\s*:/i.test(raw)) return "Envío e-mail";

  const whatsappMarkers = [
    text.includes("whatsapp"),
    text.includes("whats app"),
    text.includes("wa me"),
    text.includes("wsp"),
    result === "envio whatsapp",
  ].filter(Boolean).length;
  if (whatsappMarkers >= 1) return "WhatsApp envío";

  const smsMarkers = [
    text.includes("sms"),
    text.includes("mensaje de texto"),
    text.includes("envio sms"),
  ].filter(Boolean).length;
  if (smsMarkers >= 1) return "Envío SMS";

  if (text.length < 55) return "";

  const strongPhrases = [
    "por medio de la presente",
    "se sugiere comunicarse",
    "nos dirigimos a usted",
    "notificacion al sr",
    "notificacion a la sra",
    "instancia legal prejudicial",
    "debido a su deuda con",
    "deuda pendiente que mantiene",
    "comunicarse al estudio",
  ];
  if (strongPhrases.some((phrase) => text.includes(phrase))) {
    return "Canal de envío correspondiente";
  }

  const genericMarkers = [
    text.includes("le informamos que"),
    text.includes("contacto fijo"),
    text.includes("comunicate"),
    text.includes("comuniquese"),
  ].filter(Boolean).length;

  return genericMarkers >= 2 ? "Canal de envío correspondiente" : "";
}

function looksLikeOutboundTemplate(row) {
  return Boolean(inferOutboundMessageChannel(row));
}

function rowKey(row) {
  return String(row._id || `${row.usuario}-${row.fecha}-${row.hora}-${row.dni}`);
}

function addFlag(row, id, points = 0, meta = {}) {
  if (!row.__flags.has(id)) {
    row.__flags.set(id, { id, ...meta });
    row.__score += points;
  }
}

function severity(score) {
  if (score >= 40) return "alta";
  if (score >= 25) return "media";
  if (score > 0) return "leve";
  return "sin_alertas";
}

function compareAlerts(a, b) {
  const order = { alta: 3, media: 2, leve: 1, sin_alertas: 0 };
  return (
    (order[b.__severity] || 0) - (order[a.__severity] || 0) ||
    b.__timestamp - a.__timestamp ||
    String(a.usuario || "").localeCompare(String(b.usuario || ""), "es")
  );
}

const EXAMPLE_TYPES = Object.keys(ALERT_DEFINITIONS);

function blankExamples() {
  return Object.fromEntries(EXAMPLE_TYPES.map((id) => [id, []]));
}

function blankCounters(username = "") {
  return {
    username,
    totalGestiones: 0,
    dnisUnicos: new Set(),
    sinAlertas: 0,
    paraRevisar: 0,
    leves: 0,
    medias: 0,
    altas: 0,
    repetidasMismoDia: 0,
    entrantesClasificacion: 0,
    entrantesConPlantilla: 0,
    entrantesResultadoIncoherente: 0,
    contactosSinObservacion: 0,
    sinDestino: 0,
    rafagas: new Set(),
    cortaBaches: new Set(),
    ejemplos: blankExamples(),
    __exampleKeys: new Set(),
  };
}

function compactObservation(value, maxLength = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function exampleFromRow(row, flag) {
  return {
    id: rowKey(row),
    fecha: isoDay(row.fecha),
    hora: row.hora || "",
    dni: row.dni || "",
    nombreDeudor: row.nombreDeudor || "",
    entidad: row.entidad || "",
    tipoContacto: row.tipoContacto || "",
    resultadoGestion: row.resultadoGestion || "",
    telMailMarcado: row.telMailMarcado || "",
    observacionGestion: compactObservation(row.observacionGestion),
    detalle: reasonDetail(flag, row),
  };
}

function saveExample(target, row, flag) {
  const examples = target.ejemplos?.[flag.id];
  if (!examples || examples.length >= 2) return;
  const clusterKey = ["rafaga_llamadas", "corta_bache"].includes(flag.id)
    ? flag.clusterId || rowKey(row)
    : rowKey(row);
  const key = `${flag.id}|${clusterKey}`;
  if (target.__exampleKeys.has(key)) return;
  target.__exampleKeys.add(key);
  examples.push(exampleFromRow(row, flag));
}

function countFlag(target, row, flag) {
  if (flag.id === "repetida_mismo_dia") target.repetidasMismoDia += 1;
  else if (flag.id === "entrante_con_plantilla") target.entrantesConPlantilla += 1;
  else if (flag.id === "entrante_resultado_incoherente") target.entrantesResultadoIncoherente += 1;
  else if (flag.id === "contacto_sin_observacion") target.contactosSinObservacion += 1;
  else if (flag.id === "sin_destino") target.sinDestino += 1;
  else if (flag.id === "rafaga_llamadas") target.rafagas.add(flag.clusterId || rowKey(row));
  else if (flag.id === "corta_bache") target.cortaBaches.add(flag.clusterId || rowKey(row));
  saveExample(target, row, flag);
}

function finishCounters(item) {
  const { __exampleKeys, ...safeItem } = item;
  const result = {
    ...safeItem,
    dnisUnicos: item.dnisUnicos.size,
    rafagas: item.rafagas.size,
    cortaBaches: item.cortaBaches.size,
    porcentajeSinAlertas: item.totalGestiones
      ? Number(((item.sinAlertas / item.totalGestiones) * 100).toFixed(1))
      : 100,
  };
  return result;
}

function summarizeRows(rows) {
  const overall = blankCounters();
  const byUser = new Map();

  const ensure = (username) => {
    if (!byUser.has(username)) byUser.set(username, blankCounters(username));
    return byUser.get(username);
  };

  for (const row of rows) {
    const item = ensure(row.usuario || "sin-usuario");
    overall.totalGestiones += 1;
    item.totalGestiones += 1;
    overall.dnisUnicos.add(row.dni);
    item.dnisUnicos.add(row.dni);

    if (row.__score === 0) {
      overall.sinAlertas += 1;
      item.sinAlertas += 1;
    } else {
      overall.paraRevisar += 1;
      item.paraRevisar += 1;
      overall[row.__severity === "alta" ? "altas" : row.__severity === "media" ? "medias" : "leves"] += 1;
      item[row.__severity === "alta" ? "altas" : row.__severity === "media" ? "medias" : "leves"] += 1;
    }

    for (const flag of row.__flags.values()) {
      countFlag(overall, row, flag);
      countFlag(item, row, flag);
    }

    if (row.__flags.has("entrante_con_plantilla") || row.__flags.has("entrante_resultado_incoherente")) {
      overall.entrantesClasificacion += 1;
      item.entrantesClasificacion += 1;
    }
  }

  const operadores = [...byUser.values()]
    .map(finishCounters)
    .sort(
      (a, b) =>
        b.altas - a.altas ||
        b.paraRevisar - a.paraRevisar ||
        a.username.localeCompare(b.username, "es"),
    );

  return { total: finishCounters(overall), operadores };
}

function reasonDetail(flag, row) {
  if (flag.id === "repetida_mismo_dia") {
    const interval = Number(flag.intervaloMinutos || 0);
    return `La misma carga ya figuraba a las ${flag.horaAnterior || "—"}${
      interval ? ` y volvió a registrarse ${interval} min después` : ""
    }.`;
  }
  if (flag.id === "entrante_con_plantilla") {
    const suggested = flag.canalSugerido || "el canal de envío correspondiente";
    return `La gestión quedó como “${row.tipoContacto || "llamada entrante"}”, pero la observación muestra un mensaje enviado desde el estudio. Por el contenido, debería revisarse como “${suggested}”.`;
  }
  if (flag.id === "entrante_resultado_incoherente") {
    const result = canonical(flag.resultado);
    if (NO_ANSWER_RESULTS.has(result)) {
      return `La gestión quedó como “${row.tipoContacto || "llamada entrante"}” y el resultado fue “${flag.resultado || "sin contacto"}”. Si provino de una campaña automática, probablemente correspondía “Llamada entrante - IVR”.`;
    }
    if (result === "mail libre") {
      return `La gestión quedó como “${row.tipoContacto || "llamada entrante"}”, pero el resultado fue “${flag.resultado}”, propio de un envío de e-mail.`;
    }
    if (result === "envio whatsapp") {
      return `La gestión quedó como “${row.tipoContacto || "llamada entrante"}”, pero el resultado fue “${flag.resultado}”, propio de un envío de WhatsApp.`;
    }
    return `La gestión quedó como “${row.tipoContacto || "llamada entrante"}” y el resultado fue “${flag.resultado || "incompatible"}”, que corresponde a otro tipo de gestión.`;
  }
  if (flag.id === "contacto_sin_observacion") {
    return `El resultado fue “${row.resultadoGestion || "contacto"}”, pero no se explicó qué dijo la persona, qué se ofreció ni cómo quedó la gestión.`;
  }
  if (flag.id === "sin_destino") {
    return "No se encontró teléfono o correo en el campo de destino del reporte.";
  }
  if (flag.id === "rafaga_llamadas") {
    return `${flag.dnisDistintos || 0} DNI distintos fueron registrados como llamadas en ${flag.ventanaSegundos || 60} segundos.`;
  }
  if (flag.id === "corta_bache") {
    return `La gestión quedó entre una pausa de ${flag.pausaAnteriorMin || 0} min y otra de ${flag.pausaPosteriorMin || 0} min. Además, no tiene una explicación concreta de una conversación real o contiene un texto plantilla de envío. Por su ubicación, da la impresión de haberse cargado para cortar el bache.`;
  }
  return ALERT_DEFINITIONS[flag.id]?.description || "Registro para revisar.";
}

function reasonAction(flag) {
  if (flag.id === "repetida_mismo_dia") {
    return "Verificá en Mango cuál de las dos cargas corresponde y evitá registrar nuevamente una gestión ya guardada.";
  }
  if (flag.id === "entrante_con_plantilla") {
    const suggested = flag.canalSugerido || "el canal de envío correspondiente";
    return `Si la observación es el texto que vos enviaste, cargá “${suggested}” o la opción específica que corresponda. Usá “WhatsApp chat” solo si hubo intercambio, “WhatsApp entrante” si la persona inició la conversación y “Llamada entrante - telef.” únicamente cuando una persona llamó y fue atendida.`;
  }
  if (flag.id === "entrante_resultado_incoherente") {
    const result = canonical(flag.resultado);
    if (NO_ANSWER_RESULTS.has(result)) {
      return "Si fue una campaña automática, cargala como “Llamada entrante - IVR”, aunque haya quedado cortada, ocupado, contestador o fuera de servicio. Usá “Llamada entrante - telef.” solamente cuando una persona llame y sea atendida; si vos iniciaste la llamada, elegí “Llamada saliente”.";
    }
    if (result === "mail libre") {
      return "Si solo enviaste un correo, registrá “Envío e-mail”. No debe quedar como llamada entrante telefónica.";
    }
    if (result === "envio whatsapp") {
      return "Si solo enviaste un mensaje, registrá “WhatsApp envío”. Usá “WhatsApp chat” cuando hubo intercambio y “WhatsApp entrante” cuando la persona inició la conversación.";
    }
    return "Elegí el canal que corresponda a la acción real. “Llamada entrante - telef.” se utiliza únicamente cuando una persona llama y es atendida.";
  }
  if (flag.id === "contacto_sin_observacion") {
    return "Cuando hablaste con el titular, un familiar o un tercero, dejá una referencia breve de lo ocurrido. Si cargás “Bajo acuerdo”, “No tiene voluntad de arreglo” o cualquier resultado de contacto, explicá qué dijo, qué se ofreció y cómo quedó el caso.";
  }
  if (flag.id === "sin_destino") {
    return "Completá o seleccioná el teléfono o correo utilizado para que la gestión pueda verificarse.";
  }
  if (flag.id === "rafaga_llamadas") {
    return "Revisá que cada llamada corresponda a un intento real y que el canal y el resultado hayan quedado correctamente informados.";
  }
  if (flag.id === "corta_bache") {
    return "Mostrá la gestión real en Mango y verificá que el canal, el resultado y la observación estén completos. Si la acción existió, tiene que poder respaldarse; si no existió, no debe cargarse para interrumpir el bache.";
  }
  return "Revisá el registro en Mango y corregí el dato cuando corresponda.";
}

function formatAlert(row) {
  return {
    id: rowKey(row),
    fecha: isoDay(row.fecha),
    hora: row.hora || "",
    usuario: row.usuario || "",
    dni: row.dni || "",
    nombreDeudor: row.nombreDeudor || "",
    entidad: row.entidad || "",
    tipoContacto: row.tipoContacto || "",
    resultadoGestion: row.resultadoGestion || "",
    estadoCuenta: row.estadoCuenta || "",
    telMailMarcado: row.telMailMarcado || "",
    observacionGestion: row.observacionGestion || "",
    severidad: row.__severity,
    motivos: [...row.__flags.values()].map((flag) => ({
      ...ALERT_DEFINITIONS[flag.id],
      ...flag,
      detalle: reasonDetail(flag, row),
      indicacion: reasonAction(flag),
    })),
  };
}

function buildDaily(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.usuario}|${isoDay(row.fecha)}`;
    if (!map.has(key)) {
      map.set(key, {
        usuario: row.usuario,
        fecha: isoDay(row.fecha),
        total: 0,
        paraRevisar: 0,
        altas: 0,
        repetidasMismoDia: 0,
        entrantesIncoherentes: 0,
        cortaBaches: new Set(),
      });
    }
    const item = map.get(key);
    item.total += 1;
    if (row.__score > 0) item.paraRevisar += 1;
    if (row.__severity === "alta") item.altas += 1;
    if (row.__flags.has("repetida_mismo_dia")) item.repetidasMismoDia += 1;
    if (row.__flags.has("entrante_con_plantilla") || row.__flags.has("entrante_resultado_incoherente")) {
      item.entrantesIncoherentes += 1;
    }
    const gapFlag = row.__flags.get("corta_bache");
    if (gapFlag) item.cortaBaches.add(gapFlag.clusterId || rowKey(row));
  }
  return [...map.values()]
    .map((item) => ({ ...item, cortaBaches: item.cortaBaches.size }))
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || a.usuario.localeCompare(b.usuario, "es"));
}

export function analyzeQualityRows(rawRows) {
  const rows = rawRows.map((source) => ({
    ...source,
    usuario: String(source.usuario || "").toLowerCase(),
    dni: String(source.dni || "").replace(/\D/g, ""),
    __timestamp: timestampOf(source),
    __score: 0,
    __flags: new Map(),
    __severity: "sin_alertas",
  }));

  for (const row of rows) {
    const result = canonical(row.resultadoGestion);

    if (emailType(row) && !hasEmail(row.telMailMarcado)) {
      addFlag(row, "sin_destino", 25);
    }
    if ((callType(row) || whatsappType(row)) && !hasPhone(row.telMailMarcado)) {
      addFlag(row, "sin_destino", 25);
    }

    if (meaningful(row) && !hasRealObservation(row)) {
      addFlag(row, "contacto_sin_observacion", 20);
    }

    // Las campañas IVR pueden terminar cortadas, ocupadas o fuera de servicio.
    // Esos resultados solo se observan cuando fueron cargados como una entrada humana.
    if (inboundHumanCallType(row) && INBOUND_IMPOSSIBLE_RESULTS.has(result)) {
      addFlag(row, "entrante_resultado_incoherente", 10, {
        resultado: row.resultadoGestion || "",
      });
    }

    if (inboundHumanCallType(row) && looksLikeOutboundTemplate(row)) {
      addFlag(row, "entrante_con_plantilla", 10, {
        canalSugerido: inferOutboundMessageChannel(row),
      });
    }
  }

  const duplicateMap = new Map();
  for (const row of rows) {
    const key = [
      row.usuario,
      isoDay(row.fecha),
      row.dni,
      exactText(row.tipoContacto),
      exactText(row.resultadoGestion),
      compactExact(row.telMailMarcado),
      exactText(row.observacionGestion),
    ].join("|");
    if (!duplicateMap.has(key)) duplicateMap.set(key, []);
    duplicateMap.get(key).push(row);
  }

  for (const group of duplicateMap.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.__timestamp - b.__timestamp);
    for (let index = 1; index < group.length; index += 1) {
      const previous = group[index - 1];
      const current = group[index];
      const seconds = Math.max(0, (current.__timestamp - previous.__timestamp) / 1000);
      const observationIsEmpty = !hasRealObservation(current);
      if (observationIsEmpty && seconds > 120) continue;
      addFlag(current, "repetida_mismo_dia", 45, {
        horaAnterior: previous.hora || "",
        intervaloMinutos: Number((seconds / 60).toFixed(1)),
      });
    }
  }

  const activityMap = new Map();
  for (const row of rows) {
    const key = `${row.usuario}|${isoDay(row.fecha)}`;
    if (!activityMap.has(key)) activityMap.set(key, []);
    activityMap.get(key).push(row);
  }

  let clusterCounter = 0;
  for (const group of activityMap.values()) {
    group.sort((a, b) => a.__timestamp - b.__timestamp);

    for (let start = 0; start < group.length; start += 1) {
      let end = start;
      while (end < group.length && group[end].__timestamp - group[start].__timestamp <= 60_000) {
        end += 1;
      }
      const windowRows = group.slice(start, end).filter(callType);
      const uniqueDnis = new Set(windowRows.map((row) => row.dni).filter(Boolean));
      if (uniqueDnis.size >= 5) {
        clusterCounter += 1;
        const clusterId = `rafaga-${clusterCounter}`;
        for (const row of windowRows) {
          addFlag(row, "rafaga_llamadas", 40, {
            clusterId,
            dnisDistintos: uniqueDnis.size,
            ventanaSegundos: 60,
          });
        }
        start = Math.max(start, end - 1);
      }
    }

    let index = 0;
    while (index < group.length) {
      let matched = false;
      for (const size of [3, 2, 1]) {
        const endIndex = index + size - 1;
        if (endIndex >= group.length || index === 0 || endIndex + 1 >= group.length) continue;
        if (group[endIndex].__timestamp - group[index].__timestamp > 180_000) continue;

        const previousGapMin = (group[index].__timestamp - group[index - 1].__timestamp) / 60_000;
        const nextGapMin = (group[endIndex + 1].__timestamp - group[endIndex].__timestamp) / 60_000;
        const clusterRows = group.slice(index, endIndex + 1);

        if (previousGapMin >= 20 && nextGapMin >= 20 && clusterRows.every(suspiciousGapAction)) {
          clusterCounter += 1;
          const clusterId = `bache-${clusterCounter}`;
          for (const row of clusterRows) {
            addFlag(row, "corta_bache", 25, {
              clusterId,
              pausaAnteriorMin: Number(previousGapMin.toFixed(1)),
              pausaPosteriorMin: Number(nextGapMin.toFixed(1)),
            });
          }
          index = endIndex + 1;
          matched = true;
          break;
        }
      }
      if (!matched) index += 1;
    }
  }

  for (const row of rows) row.__severity = severity(row.__score);
  return { rows };
}

export async function calidadGestiones(req, res) {
  const startedAt = Date.now();
  try {
    const desde = startDay(req.query.desde);
    const hasta = endDay(req.query.hasta);
    if (!desde || !hasta || hasta < desde) {
      return res.status(400).json({ error: "Rango de fechas inválido." });
    }

    const rangeDays = Math.ceil((hasta.getTime() - desde.getTime()) / 86_400_000);
    if (rangeDays > MAX_RANGE_DAYS) {
      return res.status(400).json({
        error: `El análisis de calidad admite hasta ${MAX_RANGE_DAYS} días por consulta.`,
      });
    }

    const operators = splitCsv(req.query.operador).map((value) => value.toLowerCase());
    const entities = splitCsv(req.query.entidad).map((value) => value.toUpperCase());
    const scope = ownerScope(req);
    const match = {
      ...scope,
      borrado: { $ne: true },
      fecha: { $gte: desde, $lte: hasta },
    };
    if (operators.length === 1) match.usuario = operators[0];
    else if (operators.length > 1) match.usuario = { $in: operators };
    if (entities.length === 1) match.entidad = entities[0];
    else if (entities.length > 1) match.entidad = { $in: entities };

    const cacheKey = JSON.stringify({
      scope: String(scope?.propietario || ""),
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
      operators,
      entities,
    });
    const cached = cache.get(cacheKey);
    let analysis;

    if (cached && cached.expiresAt > Date.now()) {
      analysis = cached.analysis;
    } else {
      const sourceRows = await ReporteGestion.find(match)
        .select(
          "dni nombreDeudor fecha hora usuario tipoContacto resultadoGestion estadoCuenta telMailMarcado observacionGestion entidad",
        )
        .sort({ usuario: 1, fecha: 1, hora: 1, _id: 1 })
        .limit(MAX_ROWS + 1)
        .maxTimeMS(20_000)
        .lean();

      if (sourceRows.length > MAX_ROWS) {
        return res.status(413).json({
          error: `La consulta supera ${MAX_ROWS.toLocaleString("es-AR")} gestiones. Aplicá un rango u operador más acotado.`,
        });
      }

      analysis = analyzeQualityRows(sourceRows);
      cache.set(cacheKey, { analysis, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    const { rows } = analysis;
    const summary = summarizeRows(rows);
    const selectedSeverity = canonical(req.query.severidad);
    const selectedType = String(req.query.tipoAlerta || "").trim();

    let alertRows = rows.filter((row) => row.__score > 0);
    if (["alta", "media", "leve"].includes(selectedSeverity)) {
      alertRows = alertRows.filter((row) => row.__severity === selectedSeverity);
    }
    if (selectedType && ALERT_DEFINITIONS[selectedType]) {
      alertRows = alertRows.filter((row) => row.__flags.has(selectedType));
    }
    alertRows.sort(compareAlerts);

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(10, Math.min(100, Number(req.query.limit) || 40));
    const pages = Math.max(1, Math.ceil(alertRows.length / limit));
    const safePage = Math.min(page, pages);
    const start = (safePage - 1) * limit;

    return res.json({
      ok: true,
      rango: {
        desde: desde.toISOString().slice(0, 10),
        hasta: hasta.toISOString().slice(0, 10),
      },
      resumen: summary.total,
      operadores: summary.operadores,
      dias: buildDaily(rows),
      detalle: {
        total: alertRows.length,
        page: safePage,
        pages,
        limit,
        items: alertRows.slice(start, start + limit).map(formatAlert),
      },
      definiciones: ALERT_DEFINITIONS,
      criterios: {
        objetivo:
          "El informe conserva la trazabilidad del trabajo y permite medir el resultado real de las campañas de mail, SMS e IVR.",
        registros:
          "No hace falta escribir una observación extensa. Sí es obligatorio explicar qué ocurrió cuando hubo contacto con el titular, un familiar o un tercero, especialmente en resultados como “Bajo acuerdo” o “No tiene voluntad de arreglo”.",
        canales:
          "El canal debe reflejar cómo se originó la gestión. Las campañas IVR pueden quedar cortadas, ocupadas, en contestador o fuera de servicio y deben cargarse como “Llamada entrante - IVR”.",
        validacion:
          "Las gestiones idénticas repetidas y las acciones aisladas entre pausas largas se validan con Mango porque pueden dar la impresión de haberse cargado para completar actividad o cortar un bache.",
      },
      meta: {
        gestionesAnalizadas: rows.length,
        generadoEn: new Date().toISOString(),
        duracionMs: Date.now() - startedAt,
        cache: Boolean(cached && cached.expiresAt > Date.now()),
      },
    });
  } catch (error) {
    console.error("calidadGestiones:", error);
    const timeout = error?.code === 50 || error?.codeName === "MaxTimeMSExpired";
    return res.status(timeout ? 504 : 500).json({
      error: timeout
        ? "El análisis de calidad superó el tiempo esperado. Probá un rango menor o un operador puntual."
        : error?.message || "No se pudo calcular la calidad de las gestiones.",
    });
  }
}

export function invalidateCalidadCache() {
  cache.clear();
}
