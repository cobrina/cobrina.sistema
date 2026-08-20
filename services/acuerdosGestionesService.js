import ExcelJS from "exceljs";
import { esUsuarioVisibleEnReportesControl } from "../utils/controlEquipo.js";

const TIPOS_ACUERDO = [
  "Cancelación",
  "Cancelación con anticipo",
  "Acuerdo en cuotas con anticipo",
  "Acuerdo en cuotas sin anticipo",
  "Parcial",
];

const COLORS = {
  dark: "FF190044",
  purple: "FF6D2BFF",
  lilac: "FFF3E8FF",
  soft: "FFFAF5FF",
  green: "FF00B884",
  greenSoft: "FFDFF3EA",
  fuchsia: "FFE400D8",
  turquoise: "FF00B8D9",
  yellow: "FFFFF2CC",
  orangeSoft: "FFFFD9C2",
  red: "FFC00000",
  redSoft: "FFFCE4D6",
  gray: "FFEDEDED",
  grayDark: "FFBFBFBF",
  white: "FFFFFFFF",
  text: "FF1F1F1F",
};

const normalizarTexto = (value) =>
  String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const sinAcentos = (value) =>
  normalizarTexto(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const claveSimple = (value) =>
  sinAcentos(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const fechaISO = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate()
  ).padStart(2, "0")}`;
};

const dateFromISO = (raw) => {
  const match = String(raw || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
};

function parseFechaFlexible(value, fallbackYear = null) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const text = normalizarTexto(value);
  if (!text) return null;

  const buildDate = (day, month, year) => {
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return date.getUTCFullYear() === Number(year) &&
      date.getUTCMonth() === Number(month) - 1 &&
      date.getUTCDate() === Number(day)
      ? date
      : null;
  };

  let match = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    const date = buildDate(match[1], match[2], year);
    if (date) return date;
  }

  match = text.match(/\b(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})\b/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    const date = buildDate(match[1], match[2], year);
    if (date) return date;
  }

  match = text.match(/\b(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\b/);
  if (match) {
    const date = buildDate(match[3], match[2], match[1]);
    if (date) return date;
  }

  if (Number(fallbackYear) > 1900) {
    match = text.match(/\b(\d{1,2})[\/\-.\s]+(\d{1,2})\b/);
    if (match) {
      const date = buildDate(match[1], match[2], Number(fallbackYear));
      if (date) return date;
    }
  }

  return null;
}

function parseNumero(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  let text = normalizarTexto(value).replace(/AR\$/gi, "").replace(/\$/g, "").replace(/\s/g, "");
  const match = text.match(/-?\d[\d.,]*/);
  if (!match) return null;
  text = match[0];

  if (text.includes(",") && text.includes(".")) {
    text = text.lastIndexOf(",") > text.lastIndexOf(".")
      ? text.replace(/\./g, "").replace(",", ".")
      : text.replace(/,/g, "");
  } else if (text.includes(".")) {
    const parts = text.split(".");
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3)) {
      text = parts.join("");
    }
  } else if (text.includes(",")) {
    const parts = text.split(",");
    text = parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3
      ? parts.join("")
      : text.replace(",", ".");
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function extraerValorPorLabel(text, labels) {
  const source = normalizarTexto(text);
  if (!source) return "";

  const labelsByKey = new Set(labels.map((label) => claveSimple(label)));
  const chunks = source
    .split(/\s+-\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  // Formato moderno: "Campo: valor" o "Campo = valor".
  for (const chunk of chunks) {
    const pair = chunk.match(/^([^:=]{2,80}?)\s*[:=]\s*(.+)$/);
    if (!pair) continue;
    if (labelsByKey.has(claveSimple(pair[1]))) return normalizarTexto(pair[2]);
  }

  // Formato histórico de Mango: "Campo - valor - Campo - valor".
  for (let index = 0; index < chunks.length - 1; index += 1) {
    if (labelsByKey.has(claveSimple(chunks[index]))) {
      return normalizarTexto(chunks[index + 1]);
    }
  }

  // Respaldo para observaciones que no separan todos los campos de igual manera.
  for (const label of labels) {
    const escaped = label.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const regex = new RegExp(
      `(?:^|\\s-\\s|\\b)${escaped}\\s*(?::|=|\\s-\\s)\\s*(.*?)(?=\\s+-\\s+[^-:=]{2,80}(?::|=|\\s-\\s)|$)`,
      "i"
    );
    const found = source.match(regex);
    if (found) return normalizarTexto(found[1]);
  }
  return "";
}

function extraerMonto(text, labels) {
  const value = extraerValorPorLabel(text, labels);
  if (!value) return null;
  return parseNumero(value);
}

function extraerEntero(text, labels) {
  const value = extraerValorPorLabel(text, labels);
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : null;
}

function extraerFecha(text, labels, fallbackYear = null) {
  return parseFechaFlexible(extraerValorPorLabel(text, labels), fallbackYear);
}

function extraerPrimeraFechaLibre(text, fallbackYear = null) {
  const source = normalizarTexto(text);
  if (!source) return null;
  const regex = /\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}\s+\d{1,2}(?:\s+\d{2,4})?|\d{4}[\/-]\d{1,2}[\/-]\d{1,2})\b/g;
  for (const match of source.matchAll(regex)) {
    const parsed = parseFechaFlexible(match[0], fallbackYear);
    if (parsed) return parsed;
  }
  return null;
}

function extraerTelefonoGestion(doc = {}) {
  const telMail = normalizarTexto(doc.telMailMarcado);
  const observacion = normalizarTexto(doc.observacionGestion);
  const fuentes = [
    telMail,
    extraerValorPorLabel(observacion, [
      "Teléfono marcado",
      "Telefono marcado",
      "Teléfono",
      "Telefono",
      "Celular",
      "Número llamado",
      "Numero llamado",
    ]),
  ].filter(Boolean);

  const encontrados = [];
  fuentes.forEach((fuente) => {
    const matches = String(fuente).match(/(?:\+?\d[\d\s().-]{5,}\d)/g) || [];
    matches.forEach((match) => {
      const limpio = match
        .replace(/[^\d+]/g, "")
        .replace(/(?!^)\+/g, "");
      const cantidadDigitos = limpio.replace(/\D/g, "").length;
      if (cantidadDigitos >= 6 && cantidadDigitos <= 16 && !encontrados.includes(limpio)) {
        encontrados.push(limpio);
      }
    });
  });

  if (encontrados.length) return encontrados.join(" / ");
  if (telMail && !telMail.includes("@") && /\d{6,}/.test(telMail.replace(/\D/g, ""))) {
    return telMail;
  }
  return "";
}

export function esAcuerdoCaido(doc = {}) {
  const combined = claveSimple(
    [doc.resultadoGestion, doc.observacionGestion, doc.tipoAcuerdo, doc.estadoCuenta, doc.tipoContacto]
      .filter(Boolean)
      .join(" ")
  );
  return (
    combined.includes("acuerdo caido") ||
    combined.includes("caida de acuerdo") ||
    combined.includes("caida acuerdo") ||
    combined.includes("caido acuerdo") ||
    combined.includes("caido el acuerdo") ||
    combined.includes("acuerdo cayo") ||
    combined.includes("se cayo el acuerdo") ||
    combined.replace(/\s/g, "").includes("acuerdocaido")
  );
}

export function esBajaAcuerdo(doc = {}) {
  const result = claveSimple(doc.resultadoGestion);
  const accountState = claveSimple(doc.estadoCuenta);
  const combined = claveSimple(
    [doc.resultadoGestion, doc.observacionGestion, doc.tipoAcuerdo, doc.estadoCuenta, doc.tipoContacto]
      .filter(Boolean)
      .join(" ")
  );

  const explicitLowAgreement = result === "bajo acuerdo" || result === "baja acuerdo";
  const explicitCancellation =
    accountState.includes("baja acuerdo") ||
    combined.includes("baja de acuerdo") ||
    combined.includes("dar de baja el acuerdo") ||
    combined.includes("dio de baja el acuerdo") ||
    combined.includes("acuerdo dado de baja") ||
    combined.replace(/\s/g, "").includes("bajaacuerdo");

  return explicitLowAgreement || explicitCancellation || esAcuerdoCaido(doc);
}

function clasificarTipoAcuerdo(observation, installments, advanceAmount, result) {
  const obs = claveSimple(observation);
  const res = claveSimple(result);
  const hasAdvance = Number(advanceAmount || 0) > 0;
  const installmentsValue = Number(installments || 0);

  if (res.includes("parcial") || obs.includes("pppar") || obs.includes("parcial")) return "Parcial";
  if (res.includes("anticipo") || obs.includes("vcto del anticipo") || hasAdvance) {
    return installmentsValue > 0 ? "Acuerdo en cuotas con anticipo" : "Cancelación con anticipo";
  }
  if (res.includes("cuota") || installmentsValue > 1) return "Acuerdo en cuotas sin anticipo";
  return "Cancelación";
}

function hoyArgentinaISO() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function estadoVencimiento(dateISO, todayISO = hoyArgentinaISO()) {
  const due = dateFromISO(dateISO);
  const today = dateFromISO(todayISO);
  if (!due || !today) return { estado: "SIN FECHA", diasVencido: 0, diasParaVencer: null };
  const delta = Math.round((today.getTime() - due.getTime()) / 86400000);
  if (delta > 0) return { estado: "VENCIDO", diasVencido: delta, diasParaVencer: -delta };
  if (delta === 0) return { estado: "VENCE HOY", diasVencido: 0, diasParaVencer: 0 };
  if (delta >= -3) return { estado: "PRÓXIMO 3 DÍAS", diasVencido: 0, diasParaVencer: -delta };
  return { estado: "PENDIENTE", diasVencido: 0, diasParaVencer: -delta };
}

export function transformarGestionEnAcuerdo(doc = {}) {
  const result = normalizarTexto(doc.resultadoGestion);
  if (!claveSimple(result).includes("acuerdo") || esBajaAcuerdo(doc)) return null;

  const observation = normalizarTexto(doc.observacionGestion);
  const gestionDate = parseFechaFlexible(doc.fecha);
  const gestionYear = gestionDate?.getUTCFullYear() || null;
  const resultKey = claveSimple(result);
  const obsKey = claveSimple(observation);
  const partial = resultKey.includes("parcial") || obsKey.includes("pppar");

  const maxDebt = extraerMonto(observation, [
    "Deuda máxima total",
    "Deuda maxima total",
    "Suma total adeudada",
    "Deuda total",
  ]);
  const advanceDate = extraerFecha(observation, [
    "Fecha del anticipo",
    "Fecha anticipo",
    "Vcto. del anticipo",
    "Vencimiento anticipo",
  ], gestionYear);
  let advanceAmount = extraerMonto(observation, ["Monto del anticipo", "Monto anticipo"]);
  if (partial) advanceAmount = null;

  const installments = extraerEntero(observation, [
    "Cantidad de cuota/s",
    "Cantidad de cuota s",
    "Cantidad de cuotas",
    "Cuotas",
  ]);
  let firstDue = extraerFecha(observation, [
    "Primer vencimiento",
    "Primer vto",
    "PrimerVto",
    "PPPAR Fecha vencimiento",
    "Fecha vencimiento",
    "Fecha de vencimiento",
    "Vencimiento",
    "Fecha de pago",
    "Fecha pago",
    "Fecha del pago",
    "Fecha 1er pago",
    "Fecha primer pago",
    "Fecha del primer pago",
    "Primer pago fecha",
    "Fec. pago",
    "Fec pago",
    "Vencimiento de pago",
    "Vto. de pago",
    "Vto pago",
  ], gestionYear);
  if (!firstDue) firstDue = extraerPrimeraFechaLibre(observation, gestionYear);

  let installmentAmount = extraerMonto(observation, ["Monto de cuota", "Monto cuota"]);
  const partialAmount = extraerMonto(observation, ["Monto"]);
  const explicitTotalAmount = extraerMonto(observation, [
    "Monto total del acuerdo",
    "Monto total acuerdo",
    "Total del acuerdo",
    "Total acuerdo",
    "Saldo acordado",
    "Saldo negociado",
    "Saldo a cancelar",
    "Saldo del acuerdo",
    "Saldo total",
    "Saldos",
    "Saldo",
    "Importe total",
  ]);
  if (installmentAmount == null && partial) installmentAmount = partialAmount;

  let totalAmount = Number(explicitTotalAmount || 0) > 0 ? explicitTotalAmount : null;
  if (totalAmount == null && partial) totalAmount = partialAmount ?? installmentAmount;
  else if (totalAmount == null && installments && installmentAmount != null) {
    totalAmount = installments * installmentAmount + Number(advanceAmount || 0);
  } else if (totalAmount == null && installmentAmount != null) totalAmount = installmentAmount;
  else if (totalAmount == null && advanceAmount != null) totalAmount = advanceAmount;
  else if (totalAmount == null && partialAmount != null) totalAmount = partialAmount;

  const firstPayment = Number(advanceAmount || 0) > 0
    ? advanceAmount
    : Number(partialAmount || 0) > 0
    ? partialAmount
    : Number(installmentAmount || 0) > 0
    ? installmentAmount
    : explicitTotalAmount;

  const type = clasificarTipoAcuerdo(observation, installments, advanceAmount, result);
  let paymentDate = advanceDate || firstDue;
  const hasPaymentAmount = Number(firstPayment || 0) > 0 || Number(totalAmount || 0) > 0;

  // En gestiones históricas a veces el acuerdo libre/cancelación trae el monto,
  // pero no repite la fecha de pago. En ese caso usamos la fecha de la gestión
  // como respaldo para no perder acuerdos viejos ya cerrados.
  if (!paymentDate && hasPaymentAmount && (type === "Cancelación" || type === "Cancelación con anticipo")) {
    paymentDate = gestionDate;
  }

  const hasPaymentDate = Boolean(paymentDate);

  // Un resultado que solo dice “acuerdo”, pero no contiene fecha de pago ni montos/saldos,
  // no es un acuerdo válido para estadísticas. También evita contar registros incompletos.
  if (!hasPaymentDate || !hasPaymentAmount) return null;

  // El importe que usamos como proyección es el PRIMER PAGO real.
  // Si existe anticipo, su fecha es la fecha del primer pago; si no, usamos
  // el primer vencimiento / fecha de pago detectada. Esto evita proyectar una
  // cuota futura cuando el acuerdo exige un anticipo antes.
  const firstPaymentDate = Number(advanceAmount || 0) > 0
    ? (advanceDate || paymentDate || firstDue)
    : (firstDue || paymentDate || advanceDate);
  const firstPaymentDateISO = fechaISO(firstPaymentDate);
  const firstDueISO = fechaISO(firstDue || advanceDate || paymentDate);
  const dueStatus = estadoVencimiento(firstPaymentDateISO || firstDueISO);

  return {
    id: String(doc._id || ""),
    dni: normalizarTexto(doc.dni).replace(/\D/g, ""),
    nombreDeudor: normalizarTexto(doc.nombreDeudor),
    fecha: fechaISO(parseFechaFlexible(doc.fecha)),
    hora: normalizarTexto(doc.hora),
    usuario: normalizarTexto(doc.usuario),
    tipoContacto: normalizarTexto(doc.tipoContacto),
    resultadoGestion: result,
    estadoCuenta: normalizarTexto(doc.estadoCuenta),
    telefonoGestion: extraerTelefonoGestion(doc),
    telMailMarcado: normalizarTexto(doc.telMailMarcado),
    observacionGestion: observation,
    entidad: normalizarTexto(doc.entidad),
    entidadNumero: Number(doc.entidadNumero || 0) || null,
    tipoAcuerdo: type,
    fechaAnticipo: fechaISO(advanceDate),
    montoAnticipo: Number(advanceAmount || 0),
    cuotas: Number(installments || 0),
    primerVencimiento: firstDueISO,
    fechaPrimerPago: firstPaymentDateISO || firstDueISO,
    montoCuota: Number(installmentAmount || 0),
    primerPago: Number(firstPayment || 0),
    montoTotalAcuerdo: Number(totalAmount || 0),
    deudaMaxima: Number(maxDebt || 0),
    estadoVencimiento: dueStatus.estado,
    diasVencido: dueStatus.diasVencido,
    diasParaVencer: dueStatus.diasParaVencer,
  };
}


/**
 * Clave estable para comparar acuerdos del mismo caso.
 * Preferimos DNI + número de entidad; si el número no está disponible usamos
 * el nombre normalizado. Esto mantiene compatibilidad con gestiones históricas.
 */
export function claveCasoAcuerdo(row = {}) {
  const dni = normalizarTexto(row?.dni).replace(/\D/g, "");
  if (!dni) return "";
  const entidadNumero = Number(row?.entidadNumero || 0);
  const entidadTexto = claveSimple(row?.entidad);
  const entidad = entidadNumero > 0 ? `N:${entidadNumero}` : entidadTexto ? `T:${entidadTexto}` : "";
  return entidad ? `${dni}|${entidad}` : "";
}

export function selloAcuerdo(row = {}) {
  const fecha = String(row?.fecha || "").slice(0, 10);
  const horaRaw = String(row?.hora || "00:00:00");
  const hora = /^\d{2}:\d{2}:\d{2}$/.test(horaRaw)
    ? horaRaw
    : /^\d{2}:\d{2}$/.test(horaRaw)
    ? `${horaRaw}:00`
    : "00:00:00";
  return `${fecha}T${hora}|${String(row?.id || row?._id || "")}`;
}

/**
 * Fallback conservador cuando no hay módulo Pagos disponible. Conserva un solo
 * acuerdo por caso (DNI + entidad), tomando la gestión más reciente.
 *
 * Cuando Pagos está disponible NO usamos esta función para el cálculo final:
 * primero vinculamos pagos y después resolvemos episodios efectivos.
 */
export function deduplicarAcuerdosPorCasoMasReciente(rows = []) {
  const mapa = new Map();
  const sinClave = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const key = claveCasoAcuerdo(row);
    if (!key) {
      sinClave.push(row);
      continue;
    }
    const previo = mapa.get(key);
    if (!previo || selloAcuerdo(row) >= selloAcuerdo(previo)) mapa.set(key, row);
  }

  return [...mapa.values(), ...sinClave].sort((a, b) => selloAcuerdo(b).localeCompare(selloAcuerdo(a)));
}


function paymentDateISO(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : fechaISO(date);
}

/**
 * Vincula pagos con acuerdos sin convertir la ausencia del módulo Pagos en una falla.
 * La coincidencia principal es DNI + entidad (cuando el catálogo permite resolverla).
 * Se consideran válidos los pagos cuya FECHA_PAGO sea el mismo día o posterior a la
 * gestión que generó el acuerdo. Los pagos del mismo día quedan además identificados
 * por separado y se informa si coinciden con el importe esperado. También conserva el
 * pago inmediatamente anterior para detectar acuerdos cargados tarde en Mango.
 */
export function vincularPagosPosteriores(
  acuerdos = [],
  pagos = [],
  entidades = [],
  { disponible = false, motivo = "" } = {}
) {
  const entityNumberByName = new Map(
    (entidades || []).map((item) => [claveSimple(item?.nombre), Number(item?.numero)])
  );
  const paymentsByCase = new Map();

  (pagos || []).forEach((payment) => {
    const dni = normalizarTexto(payment?.dni).replace(/\D/g, "");
    const entidadNumero = Number(payment?.entidadId || 0);
    const fecha = paymentDateISO(payment?.fechaPago);
    if (!dni || !entidadNumero || !fecha) return;
    const key = `${dni}|${entidadNumero}`;
    if (!paymentsByCase.has(key)) paymentsByCase.set(key, []);
    const clavePago = String(
      payment?._id ||
      payment?.idPago ||
      `${dni}|${entidadNumero}|${fecha}|${Number(payment?.monto || 0)}|${String(payment?.subCesionId || "")}|${normalizarTexto(payment?.operadorUsername)}`
    );
    paymentsByCase.get(key).push({
      idPago: payment?.idPago ?? "",
      clavePago,
      fecha,
      monto: Number(payment?.monto || 0),
      entidadId: entidadNumero,
      subCesionId: String(payment?.subCesionId || ""),
      conceptoCodigo: normalizarTexto(payment?.conceptoCodigo),
      estado: normalizarTexto(payment?.estado),
      operadorUsername: normalizarTexto(payment?.operadorUsername),
    });
  });

  paymentsByCase.forEach((items) => items.sort((a, b) => a.fecha.localeCompare(b.fecha)));

  // Cada acuerdo toma pagos solamente hasta el acuerdo inmediatamente siguiente
  // del mismo DNI/entidad. A diferencia de la versión anterior, también cerramos
  // la ventana cuando hay dos acuerdos EL MISMO DÍA. Como Pagos no guarda hora,
  // el acuerdo más reciente de ese día es el único que puede apropiarse de pagos
  // de esa fecha. Esto evita que un mismo pago se duplique en dos renegociaciones.
  const agreementWindows = new Map();
  const agreementsByKey = new Map();
  (acuerdos || []).forEach((agreement, index) => {
    const dni = normalizarTexto(agreement?.dni).replace(/\D/g, "");
    const entityNumber = Number(
      agreement?.entidadNumero || entityNumberByName.get(claveSimple(agreement?.entidad)) || 0
    );
    const key = `${dni}|${entityNumber}`;
    if (!dni || !entityNumber) return;
    if (!agreementsByKey.has(key)) agreementsByKey.set(key, []);
    agreementsByKey.get(key).push({
      index,
      fecha: String(agreement?.fecha || "").slice(0, 10),
      sello: selloAcuerdo(agreement),
    });
  });
  agreementsByKey.forEach((items) => {
    items.sort((a, b) => a.sello.localeCompare(b.sello) || a.index - b.index);
    items.forEach((item, position) => {
      const next = items[position + 1] || null;
      agreementWindows.set(item.index, {
        fecha: next?.fecha || "",
        mismoDia: Boolean(next && next.fecha === item.fecha),
      });
    });
  });

  return (acuerdos || []).map((agreement, agreementIndex) => {
    const base = {
      ...agreement,
      integracionPagosDisponible: Boolean(disponible),
      integracionPagosMotivo: motivo || "",
      estadoPagoAcuerdo: disponible ? "SIN PAGO VÁLIDO" : "SIN DATOS DE PAGOS",
      cantidadPagosPosteriores: 0,
      montoPagosPosteriores: 0,
      cantidadPagosEstrictamentePosteriores: 0,
      montoPagosEstrictamentePosteriores: 0,
      cantidadPagosValidos: 0,
      montoPagosValidos: 0,
      ultimoPagoPosterior: "",
      ultimoPagoValido: "",
      ultimoPagoAnterior: "",
      montoUltimoPagoAnterior: 0,
      conceptoUltimoPagoAnterior: "",
      diasPagoAnterior: null,
      cantidadPagosMismoDia: 0,
      montoPagosMismoDia: 0,
      coincidenciaImporteMismoDia: false,
      primerPagoEsperado: Number(agreement?.primerPago || agreement?.montoAnticipo || agreement?.montoCuota || 0),
      montoPrimerPagoCobrado: 0,
      fechaPrimerPagoCobrado: "",
      primerPagoCubierto: false,
      montoPagosLuegoPrimerPago: 0,
      coincidenciaPagoPor: "",
      requiereRevisionPagos: false,
      motivoRevisionPagos: "",
      subCesionesPagosDetectadas: [],
      operadorGestion: agreement?.operador || agreement?.usuario || "",
      operadorPago: "",
    };

    if (!disponible) return base;

    const dni = normalizarTexto(agreement?.dni).replace(/\D/g, "");
    const agreementDate = String(agreement?.fecha || "").slice(0, 10);
    const entityNumber = Number(
      agreement?.entidadNumero || entityNumberByName.get(claveSimple(agreement?.entidad)) || 0
    );
    if (!dni || !agreementDate || !entityNumber) {
      return {
        ...base,
        estadoPagoAcuerdo: "REQUIERE REVISIÓN",
        requiereRevisionPagos: true,
        motivoRevisionPagos: !entityNumber
          ? "El acuerdo no tiene número de entidad y no puede cruzarse solo por DNI."
          : "El acuerdo no tiene DNI o fecha válida.",
      };
    }

    const candidates = paymentsByCase.get(`${dni}|${entityNumber}`) || [];
    const windowInfo = agreementWindows.get(agreementIndex) || { fecha: "", mismoDia: false };
    const nextAgreementDate = windowInfo.fecha || "";
    const insideWindow = (payment) => {
      if (!nextAgreementDate) return true;
      if (windowInfo.mismoDia) return payment.fecha < agreementDate;
      return payment.fecha < nextAgreementDate;
    };
    const previous = candidates.filter((payment) => payment.fecha < agreementDate);
    const sameDay = candidates.filter((payment) => payment.fecha === agreementDate && insideWindow(payment));
    const later = candidates.filter((payment) => payment.fecha > agreementDate && insideWindow(payment));
    const validPayments = [...sameDay, ...later].sort((a, b) => a.fecha.localeCompare(b.fecha));
    const subCesiones = [...new Set(validPayments.map((payment) => payment.subCesionId).filter(Boolean))];
    const lastPrevious = previous.at(-1) || null;
    const daysBefore = lastPrevious
      ? Math.max(0, Math.round((dateFromISO(agreementDate).getTime() - dateFromISO(lastPrevious.fecha).getTime()) / 86400000))
      : null;

    if (subCesiones.length > 1) {
      return {
        ...base,
        estadoPagoAcuerdo: "REQUIERE REVISIÓN",
        requiereRevisionPagos: true,
        motivoRevisionPagos: "Hay pagos del mismo DNI y entidad en más de una subcesión.",
        subCesionesPagosDetectadas: subCesiones,
        ultimoPagoAnterior: lastPrevious?.fecha || "",
        montoUltimoPagoAnterior: Number(lastPrevious?.monto || 0),
        conceptoUltimoPagoAnterior: normalizarTexto(lastPrevious?.conceptoCodigo),
        diasPagoAnterior: daysBefore,
        coincidenciaPagoPor: "DNI + entidad",
        ventanaPagoHasta: nextAgreementDate || "",
      };
    }

    const amountLater = later.reduce((total, payment) => total + Number(payment.monto || 0), 0);
    const amountSameDay = sameDay.reduce((total, payment) => total + Number(payment.monto || 0), 0);
    const amountValid = amountLater + amountSameDay;
    const expectedAmount = Number(
      agreement?.primerPago || agreement?.montoAnticipo || agreement?.montoCuota || 0
    );
    const sameDayMatchesExpected = expectedAmount > 0 && sameDay.some(
      (payment) => Math.abs(Number(payment.monto || 0) - expectedAmount) < 0.01
    );

    // Separamos cuánto del cobro puede imputarse al PRIMER PAGO esperado.
    // Sirve para comparar proyección vs. primer pago efectivamente cobrado sin
    // mezclar cuotas posteriores del mismo acuerdo. Si hay varios pagos parciales,
    // acumulamos cronológicamente hasta cubrir el importe esperado.
    let montoAplicadoPrimerPago = 0;
    let fechaPrimerPagoCobrado = "";
    if (validPayments.length) {
      fechaPrimerPagoCobrado = validPayments[0].fecha || "";
      if (expectedAmount > 0) {
        let restante = expectedAmount;
        for (const payment of validPayments) {
          if (restante <= 0) break;
          const monto = Math.max(0, Number(payment.monto || 0));
          const aplicado = Math.min(restante, monto);
          montoAplicadoPrimerPago += aplicado;
          restante -= aplicado;
        }
      } else {
        montoAplicadoPrimerPago = Math.max(0, Number(validPayments[0]?.monto || 0));
      }
    }
    const primerPagoCubierto = expectedAmount > 0
      ? montoAplicadoPrimerPago + 0.01 >= expectedAmount
      : montoAplicadoPrimerPago > 0;
    const montoPagosLuegoPrimerPago = Math.max(0, amountValid - montoAplicadoPrimerPago);

    const state = later.length
      ? "CON PAGO VÁLIDO"
      : sameDay.length
      ? "PAGO MISMO DÍA VÁLIDO"
      : "SIN PAGO VÁLIDO";
    const paymentOwner = validPayments.at(-1)?.operadorUsername || "";

    return {
      ...base,
      estadoPagoAcuerdo: state,
      // Compatibilidad: estos campos históricos pasan a representar todos los pagos válidos
      // (posteriores + mismo día) para que reportes y exportaciones no omitan cobros válidos.
      cantidadPagosPosteriores: validPayments.length,
      montoPagosPosteriores: amountValid,
      cantidadPagosEstrictamentePosteriores: later.length,
      montoPagosEstrictamentePosteriores: amountLater,
      cantidadPagosValidos: validPayments.length,
      montoPagosValidos: amountValid,
      ultimoPagoPosterior: later.at(-1)?.fecha || "",
      ultimoPagoValido: validPayments.at(-1)?.fecha || "",
      ultimoPagoAnterior: lastPrevious?.fecha || "",
      montoUltimoPagoAnterior: Number(lastPrevious?.monto || 0),
      conceptoUltimoPagoAnterior: normalizarTexto(lastPrevious?.conceptoCodigo),
      diasPagoAnterior: daysBefore,
      cantidadPagosMismoDia: sameDay.length,
      montoPagosMismoDia: amountSameDay,
      coincidenciaImporteMismoDia: sameDayMatchesExpected,
      primerPagoEsperado: expectedAmount,
      montoPrimerPagoCobrado: montoAplicadoPrimerPago,
      fechaPrimerPagoCobrado,
      primerPagoCubierto,
      montoPagosLuegoPrimerPago,
      coincidenciaPagoPor: "DNI + entidad",
      ventanaPagoHasta: nextAgreementDate || "",
      pagosValidos: validPayments,
      operadorPago: paymentOwner,
      // El acuerdo siempre pertenece a quien lo generó. El operador que imputó
      // el pago se conserva aparte en operadorPago; mezclar ambos falseaba la
      // productividad por operador en Reporte de Acuerdos.
      operador: agreement?.operador || agreement?.usuario || "",
      usuario: agreement?.usuario || agreement?.operador || "",
    };
  });
}

/**
 * Resuelve "episodios efectivos" de acuerdo por DNI + entidad.
 *
 * Regla de negocio:
 * - si un acuerdo fue reemplazado por otro y NO registró ningún pago válido,
 *   se considera una renegociación/sustitución y no se duplica la productividad;
 * - si el acuerdo anterior SÍ tuvo pago antes del nuevo acuerdo, ambos cuentan
 *   como episodios efectivos distintos;
 * - el acuerdo más reciente del caso siempre queda visible aunque todavía no
 *   tenga pago, porque sigue siendo el compromiso vigente.
 *
 * Sin datos de Pagos conservamos el criterio histórico (último acuerdo por caso),
 * porque no existe evidencia suficiente para afirmar que hubo dos episodios reales.
 */
export function resolverEpisodiosAcuerdos(rows = []) {
  const input = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!input.length) {
    return {
      rows: [],
      descartados: [],
      meta: {
        disponiblePagos: false,
        acuerdosCrudos: 0,
        acuerdosEfectivos: 0,
        acuerdosReemplazadosSinPago: 0,
        casosConMasDeUnEpisodio: 0,
        episodiosAdicionalesPagados: 0,
      },
    };
  }

  const pagosDisponibles = input.some((row) => Boolean(row?.integracionPagosDisponible));
  if (!pagosDisponibles) {
    const effective = deduplicarAcuerdosPorCasoMasReciente(input).map((row) => ({
      ...row,
      episodioEfectivo: true,
      episodioNumero: 1,
      episodioMotivo: "ULTIMO_ACUERDO_SIN_CRUCE_PAGOS",
      acuerdoReemplazadoSinPago: false,
    }));
    return {
      rows: effective,
      descartados: input.filter((row) => !effective.some((keep) => String(keep.id || keep._id || "") === String(row.id || row._id || ""))),
      meta: {
        disponiblePagos: false,
        acuerdosCrudos: input.length,
        acuerdosEfectivos: effective.length,
        acuerdosReemplazadosSinPago: Math.max(0, input.length - effective.length),
        casosConMasDeUnEpisodio: 0,
        episodiosAdicionalesPagados: 0,
      },
    };
  }

  const grupos = new Map();
  const sinClave = [];
  for (const row of input) {
    const key = claveCasoAcuerdo(row);
    if (!key) {
      sinClave.push(row);
      continue;
    }
    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key).push(row);
  }

  const efectivos = [];
  const descartados = [];
  let casosConMasDeUnEpisodio = 0;
  let episodiosAdicionalesPagados = 0;

  grupos.forEach((items, key) => {
    const ordenados = [...items].sort((a, b) => selloAcuerdo(a).localeCompare(selloAcuerdo(b)));
    const keepGroup = [];

    ordenados.forEach((row, index) => {
      const esUltimo = index === ordenados.length - 1;
      const tienePago = Number(row?.cantidadPagosValidos ?? row?.cantidadPagosPosteriores ?? 0) > 0 ||
        ["CON PAGO POSTERIOR", "CON PAGO VÁLIDO", "PAGO MISMO DÍA", "PAGO MISMO DÍA VÁLIDO"].includes(String(row?.estadoPagoAcuerdo || ""));

      if (esUltimo || tienePago) {
        keepGroup.push({
          ...row,
          episodioEfectivo: true,
          episodioMotivo: esUltimo
            ? (tienePago ? "ULTIMO_ACUERDO_CON_PAGO" : "ULTIMO_ACUERDO_VIGENTE")
            : "ACUERDO_PAGADO_ANTES_DE_REACUERDO",
          acuerdoReemplazadoSinPago: false,
        });
      } else {
        descartados.push({
          ...row,
          episodioEfectivo: false,
          episodioMotivo: "REEMPLAZADO_SIN_PAGO",
          acuerdoReemplazadoSinPago: true,
          reemplazadoPorAcuerdoId: String(ordenados[index + 1]?.id || ordenados[index + 1]?._id || ""),
        });
      }
    });

    if (keepGroup.length > 1) {
      casosConMasDeUnEpisodio += 1;
      episodiosAdicionalesPagados += keepGroup.length - 1;
    }

    keepGroup.forEach((row, idx) => {
      efectivos.push({
        ...row,
        episodioCaso: key,
        episodioNumero: idx + 1,
        episodiosCaso: keepGroup.length,
        esReacuerdoEfectivo: keepGroup.length > 1 && idx > 0,
      });
    });
  });

  sinClave.forEach((row) => efectivos.push({
    ...row,
    episodioEfectivo: true,
    episodioNumero: 1,
    episodiosCaso: 1,
    episodioMotivo: "SIN_CLAVE_CASO",
    acuerdoReemplazadoSinPago: false,
  }));

  efectivos.sort((a, b) => selloAcuerdo(b).localeCompare(selloAcuerdo(a)));

  return {
    rows: efectivos,
    descartados,
    meta: {
      disponiblePagos: true,
      acuerdosCrudos: input.length,
      acuerdosEfectivos: efectivos.length,
      acuerdosReemplazadosSinPago: descartados.length,
      casosConMasDeUnEpisodio,
      episodiosAdicionalesPagados,
    },
  };
}

const sum = (rows, key) => rows.reduce((acc, row) => acc + Number(row?.[key] || 0), 0);

function emptyAgreementTypes() {
  return {
    cancelacion: 0,
    cancelacionConAnticipo: 0,
    cuotasConAnticipo: 0,
    cuotasSinAnticipo: 0,
    parcial: 0,
  };
}

function addAgreementTypeCounter(item, type) {
  if (type === "Cancelación") item.cancelacion += 1;
  else if (type === "Cancelación con anticipo") item.cancelacionConAnticipo += 1;
  else if (type === "Acuerdo en cuotas con anticipo") item.cuotasConAnticipo += 1;
  else if (type === "Acuerdo en cuotas sin anticipo") item.cuotasSinAnticipo += 1;
  else if (type === "Parcial") item.parcial += 1;
}

function emptyOperatorSummary(nombre, totalGestiones = 0) {
  return {
    nombre: normalizarTexto(nombre) || "Sin dato",
    acuerdos: 0,
    dnis: 0,
    primerPago: 0,
    primerPagoCobrado: 0,
    acuerdosPrimerPagoCubierto: 0,
    reacuerdosEfectivos: 0,
    montoTotal: 0,
    deudaMaxima: 0,
    vencidos: 0,
    conPagoPosterior: 0,
    pagoMismoDia: 0,
    sinPagoPosterior: 0,
    sinDatosPagos: 0,
    cantidadPagosPosteriores: 0,
    montoPagosPosteriores: 0,
    montoPagosMismoDia: 0,
    tasaPagoPosterior: 0,
    totalGestiones: Number(totalGestiones || 0),
    tasaAcuerdo: 0,
    ticketPromedio: 0,
    ...emptyAgreementTypes(),
  };
}

function groupRows(rows, key, totalGestionesMap = null) {
  const map = new Map();
  rows.forEach((row) => {
    const value = normalizarTexto(row?.[key]) || "Sin dato";
    if (!map.has(value)) {
      map.set(value, {
        nombre: value,
        acuerdos: 0,
        dnis: new Set(),
        primerPago: 0,
        primerPagoCobrado: 0,
        acuerdosPrimerPagoCubierto: 0,
        reacuerdosEfectivos: 0,
        montoTotal: 0,
        deudaMaxima: 0,
        vencidos: 0,
        conPagoPosterior: 0,
        pagoMismoDia: 0,
        sinPagoPosterior: 0,
        sinDatosPagos: 0,
        cantidadPagosPosteriores: 0,
        montoPagosPosteriores: 0,
        montoPagosMismoDia: 0,
        ...emptyAgreementTypes(),
      });
    }
    const item = map.get(value);
    item.acuerdos += 1;
    if (row.dni) item.dnis.add(row.dni);
    item.primerPago += Number(row.primerPago || 0);
    item.primerPagoCobrado += Number(row.montoPrimerPagoCobrado || 0);
    if (row.primerPagoCubierto) item.acuerdosPrimerPagoCubierto += 1;
    if (row.esReacuerdoEfectivo) item.reacuerdosEfectivos += 1;
    item.montoTotal += Number(row.montoTotalAcuerdo || 0);
    item.deudaMaxima += Number(row.deudaMaxima || 0);
    if (row.estadoVencimiento === "VENCIDO") item.vencidos += 1;
    const tienePagoValido = [
      "CON PAGO POSTERIOR",
      "CON PAGO VÁLIDO",
      "PAGO MISMO DÍA",
      "PAGO MISMO DÍA VÁLIDO",
    ].includes(row.estadoPagoAcuerdo);
    const tienePagoMismoDia = Number(row.cantidadPagosMismoDia || 0) > 0;
    if (tienePagoValido) item.conPagoPosterior += 1;
    if (tienePagoMismoDia) item.pagoMismoDia += 1;
    if (["SIN PAGO POSTERIOR", "SIN PAGO VÁLIDO"].includes(row.estadoPagoAcuerdo)) item.sinPagoPosterior += 1;
    else if (row.estadoPagoAcuerdo === "SIN DATOS DE PAGOS") item.sinDatosPagos += 1;
    item.cantidadPagosPosteriores += Number(row.cantidadPagosPosteriores || 0);
    item.montoPagosPosteriores += Number(row.montoPagosPosteriores || 0);
    item.montoPagosMismoDia += Number(row.montoPagosMismoDia || 0);
    addAgreementTypeCounter(item, row.tipoAcuerdo);
  });

  return [...map.values()]
    .map((item) => {
      const totalGestiones = Number(totalGestionesMap?.get(claveSimple(item.nombre)) || 0);
      return {
        ...item,
        dnis: item.dnis.size,
        totalGestiones,
        tasaAcuerdo: totalGestiones ? (item.acuerdos * 100) / totalGestiones : 0,
        ticketPromedio: item.acuerdos ? item.primerPago / item.acuerdos : 0,
        tasaPagoPosterior: item.acuerdos ? (item.conPagoPosterior * 100) / item.acuerdos : 0,
      };
    })
    .sort((a, b) => b.acuerdos - a.acuerdos || b.primerPago - a.primerPago || a.nombre.localeCompare(b.nombre, "es"));
}

export function resumirAcuerdos(rows, totalGestiones = 0, gestionesPorOperador = [], integracionPagos = {}) {
  // Los totales generales se calculan con TODA la actividad. Solo las vistas
  // identificadas por operador respetan la lista central de ocultos de control.
  const rowsVisiblesControl = rows.filter((row) =>
    esUsuarioVisibleEnReportesControl(row?.usuario)
  );
  const gestionesPorOperadorVisibles = gestionesPorOperador.filter((row) =>
    esUsuarioVisibleEnReportesControl(row?.operador)
  );
  const totalMap = new Map(
    gestionesPorOperadorVisibles.map((row) => [claveSimple(row.operador), Number(row.gestiones || 0)])
  );
  const totalAgreements = rows.length;
  const uniqueDnis = new Set(rows.map((row) => row.dni).filter(Boolean)).size;
  const totalFirstPayment = sum(rows, "primerPago");
  const totalFirstPaymentCollected = sum(rows, "montoPrimerPagoCobrado");
  const agreementsFirstPaymentCovered = rows.filter((row) => Boolean(row.primerPagoCubierto)).length;
  const effectiveReagreements = rows.filter((row) => Boolean(row.esReacuerdoEfectivo)).length;
  const totalAmount = sum(rows, "montoTotalAcuerdo");
  const totalMaxDebt = sum(rows, "deudaMaxima");
  const overdue = rows.filter((row) => row.estadoVencimiento === "VENCIDO");
  const dueToday = rows.filter((row) => row.estadoVencimiento === "VENCE HOY");
  const upcoming = rows.filter((row) => row.estadoVencimiento === "PRÓXIMO 3 DÍAS");
  const paymentAvailable = Boolean(integracionPagos?.disponible);
  const estadosConPagoValido = new Set([
    "CON PAGO POSTERIOR",
    "CON PAGO VÁLIDO",
    "PAGO MISMO DÍA",
    "PAGO MISMO DÍA VÁLIDO",
  ]);
  const estadosMismoDia = new Set(["PAGO MISMO DÍA", "PAGO MISMO DÍA VÁLIDO"]);
  const estadosSinPagoValido = new Set(["SIN PAGO POSTERIOR", "SIN PAGO VÁLIDO"]);
  const agreementsWithLaterPayment = paymentAvailable
    ? rows.filter((row) => estadosConPagoValido.has(row.estadoPagoAcuerdo))
    : [];
  const agreementsSameDayPayment = paymentAvailable
    ? rows.filter((row) => estadosMismoDia.has(row.estadoPagoAcuerdo) || Number(row.cantidadPagosMismoDia || 0) > 0)
    : [];
  const agreementsWithoutLaterPayment = paymentAvailable
    ? rows.filter((row) => estadosSinPagoValido.has(row.estadoPagoAcuerdo))
    : [];
  const agreementsWithoutPaymentData = rows.filter(
    (row) => row.estadoPagoAcuerdo === "SIN DATOS DE PAGOS"
  );
  const overdueWithLaterPayment = paymentAvailable
    ? overdue.filter((row) => estadosConPagoValido.has(row.estadoPagoAcuerdo))
    : [];
  const overdueSameDayPayment = paymentAvailable
    ? overdue.filter((row) => estadosMismoDia.has(row.estadoPagoAcuerdo) || Number(row.cantidadPagosMismoDia || 0) > 0)
    : [];
  const overdueWithoutLaterPayment = paymentAvailable
    ? overdue.filter((row) => estadosSinPagoValido.has(row.estadoPagoAcuerdo))
    : [];

  const porOperadorConAcuerdos = groupRows(rowsVisiblesControl, "usuario", totalMap);
  const operatorSummaryMap = new Map(
    porOperadorConAcuerdos.map((row) => [claveSimple(row.nombre), row])
  );

  gestionesPorOperadorVisibles.forEach((row) => {
    const key = claveSimple(row.operador);
    if (!operatorSummaryMap.has(key)) {
      operatorSummaryMap.set(key, emptyOperatorSummary(row.operador, row.gestiones));
    }
  });

  // Reporte de Acuerdos también necesita explicar de dónde vino la recaudación
  // del período. El backend del reporte entrega el mismo criterio que Supervisión:
  // dinero de acuerdos generados en el período vs. cuotas/pagos de acuerdos
  // anteriores. Sumamos también operadores que tuvieron cobros aunque no hayan
  // generado acuerdos ni gestiones dentro del filtro, para no esconder recaudación.
  const recaudacionPeriodo = integracionPagos?.recaudacionPeriodo || null;
  const recaudacionPorOperadorMap = new Map();
  if (recaudacionPeriodo?.disponible) {
    for (const row of recaudacionPeriodo?.porOperador || []) {
      const key = claveSimple(row?.operador);
      if (!key) continue;
      recaudacionPorOperadorMap.set(key, row);
      if (!operatorSummaryMap.has(key)) {
        operatorSummaryMap.set(key, emptyOperatorSummary(row?.operador, 0));
      }
    }
  }

  const porOperador = [...operatorSummaryMap.values()]
    .map((item) => {
      const cobro = recaudacionPorOperadorMap.get(claveSimple(item.nombre)) || {};
      return {
        ...item,
        recaudacionPeriodoDisponible: Boolean(recaudacionPeriodo?.disponible),
        recaudadoMes: Number(cobro?.recaudadoMes || 0),
        recaudadoAcuerdosPeriodo: Number(cobro?.recaudadoAcuerdosPeriodo || 0),
        recaudadoCarteraAnterior: Number(cobro?.recaudadoCarteraAnterior || 0),
        cantidadPagosMes: Number(cobro?.cantidadPagosMes || 0),
        cantidadPagosAcuerdosPeriodo: Number(cobro?.cantidadPagosAcuerdosPeriodo || 0),
        cantidadPagosCarteraAnterior: Number(cobro?.cantidadPagosCarteraAnterior || 0),
      };
    })
    .sort(
      (a, b) => b.acuerdos - a.acuerdos || b.primerPago - a.primerPago || b.recaudadoMes - a.recaudadoMes || b.totalGestiones - a.totalGestiones || a.nombre.localeCompare(b.nombre, "es")
    );
  const sinAcuerdos = porOperador
    .filter((row) => Number(row.totalGestiones || 0) > 0 && Number(row.acuerdos || 0) === 0)
    .map((row) => ({ operador: row.nombre, gestiones: Number(row.totalGestiones || 0) }))
    .sort((a, b) => b.gestiones - a.gestiones || a.operador.localeCompare(b.operador, "es"));

  const porDiaMap = new Map();
  const operadorDiaMap = new Map();
  rows.forEach((row) => {
    const key = row.fecha || "Sin fecha";
    if (!porDiaMap.has(key)) porDiaMap.set(key, { fecha: key, acuerdos: 0, primerPago: 0, montoTotal: 0 });
    const item = porDiaMap.get(key);
    item.acuerdos += 1;
    item.primerPago += Number(row.primerPago || 0);
    item.montoTotal += Number(row.montoTotalAcuerdo || 0);
  });

  rowsVisiblesControl.forEach((row) => {
    const key = row.fecha || "Sin fecha";
    const operador = normalizarTexto(row.usuario) || "Sin operador";
    const operadorKey = claveSimple(operador);
    if (!operadorDiaMap.has(operadorKey)) {
      operadorDiaMap.set(operadorKey, { operador, gestiones: 0, totalAcuerdos: 0, diasMap: new Map() });
    }
    const operatorItem = operadorDiaMap.get(operadorKey);
    operatorItem.totalAcuerdos += 1;
    if (key !== "Sin fecha") {
      if (!operatorItem.diasMap.has(key)) {
        operatorItem.diasMap.set(key, { fecha: key, acuerdos: 0, primerPago: 0, montoTotal: 0 });
      }
      const dayItem = operatorItem.diasMap.get(key);
      dayItem.acuerdos += 1;
      dayItem.primerPago += Number(row.primerPago || 0);
      dayItem.montoTotal += Number(row.montoTotalAcuerdo || 0);
    }
  });

  gestionesPorOperadorVisibles.forEach((row) => {
    const operador = normalizarTexto(row.operador) || "Sin operador";
    const operadorKey = claveSimple(operador);
    if (!operadorDiaMap.has(operadorKey)) {
      operadorDiaMap.set(operadorKey, { operador, gestiones: 0, totalAcuerdos: 0, diasMap: new Map() });
    }
    operadorDiaMap.get(operadorKey).gestiones = Number(row.gestiones || 0);
  });

  const calendarioOperadores = [...operadorDiaMap.values()]
    .map((item) => ({
      operador: item.operador,
      gestiones: item.gestiones,
      totalAcuerdos: item.totalAcuerdos,
      dias: [...item.diasMap.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)),
    }))
    .sort((a, b) => a.operador.localeCompare(b.operador, "es", { sensitivity: "base" }));

  return {
    totalGestiones,
    totalAcuerdos: totalAgreements,
    tasaAcuerdo: totalGestiones ? (totalAgreements * 100) / totalGestiones : 0,
    dnisConAcuerdo: uniqueDnis,
    totalPrimerPago: totalFirstPayment,
    totalPrimerPagoCobrado: totalFirstPaymentCollected,
    acuerdosPrimerPagoCubierto: agreementsFirstPaymentCovered,
    reacuerdosEfectivos: effectiveReagreements,
    ticketPromedioPrimerPago: totalAgreements ? totalFirstPayment / totalAgreements : 0,
    montoTotalAcuerdos: totalAmount,
    deudaMaximaInformada: totalMaxDebt,
    coberturaSobreDeuda: totalMaxDebt ? (totalAmount * 100) / totalMaxDebt : 0,
    vencidos: overdue.length,
    venceHoy: dueToday.length,
    proximos3Dias: upcoming.length,
    montoVencido: sum(overdue, "primerPago"),
    vencidosConPagoPosterior: overdueWithLaterPayment.length,
    vencidosConPagoValido: overdueWithLaterPayment.length,
    vencidosPagoMismoDia: overdueSameDayPayment.length,
    vencidosSinPagoPosterior: overdueWithoutLaterPayment.length,
    vencidosSinPagoValido: overdueWithoutLaterPayment.length,
    montoPagosPosterioresVencidos: sum(overdueWithLaterPayment, "montoPagosPosteriores"),
    montoPagosValidosVencidos: sum(overdueWithLaterPayment, "montoPagosPosteriores"),
    montoPagosMismoDiaVencidos: sum(overdueSameDayPayment, "montoPagosMismoDia"),
    acuerdosConPagoPosterior: agreementsWithLaterPayment.length,
    acuerdosConPagoValido: agreementsWithLaterPayment.length,
    acuerdosPagoMismoDia: agreementsSameDayPayment.length,
    acuerdosSinPagoPosterior: agreementsWithoutLaterPayment.length,
    acuerdosSinPagoValido: agreementsWithoutLaterPayment.length,
    acuerdosSinDatosPagos: paymentAvailable ? agreementsWithoutPaymentData.length : rows.length,
    cantidadPagosPosteriores: sum(rows, "cantidadPagosPosteriores"),
    cantidadPagosValidos: sum(rows, "cantidadPagosPosteriores"),
    totalPagosPosteriores: sum(rows, "montoPagosPosteriores"),
    totalPagosValidos: sum(rows, "montoPagosPosteriores"),
    totalPagosMismoDia: sum(rows, "montoPagosMismoDia"),
    tasaPagoPosterior: paymentAvailable && rows.length
      ? (agreementsWithLaterPayment.length * 100) / rows.length
      : 0,
    tasaPagoValido: paymentAvailable && rows.length
      ? (agreementsWithLaterPayment.length * 100) / rows.length
      : 0,
    ticketPromedioPagoPosterior: agreementsWithLaterPayment.length
      ? sum(rows, "montoPagosPosteriores") / agreementsWithLaterPayment.length
      : 0,
    ticketPromedioPagoValido: agreementsWithLaterPayment.length
      ? sum(rows, "montoPagosPosteriores") / agreementsWithLaterPayment.length
      : 0,
    seguimientoPagos: {
      disponible: paymentAvailable,
      acuerdosAnalizados: rows.length,
      conPagoPosterior: agreementsWithLaterPayment.length,
      conPagoValido: agreementsWithLaterPayment.length,
      pagoMismoDia: agreementsSameDayPayment.length,
      sinPagoPosterior: agreementsWithoutLaterPayment.length,
      sinPagoValido: agreementsWithoutLaterPayment.length,
      sinDatosPagos: paymentAvailable ? agreementsWithoutPaymentData.length : rows.length,
      cantidadPagosPosteriores: sum(rows, "cantidadPagosPosteriores"),
      cantidadPagosValidos: sum(rows, "cantidadPagosPosteriores"),
      montoPagosPosteriores: sum(rows, "montoPagosPosteriores"),
      montoPagosValidos: sum(rows, "montoPagosPosteriores"),
      montoPagosMismoDia: sum(rows, "montoPagosMismoDia"),
      primerPagoCobrado: totalFirstPaymentCollected,
      acuerdosPrimerPagoCubierto: agreementsFirstPaymentCovered,
      reacuerdosEfectivos: effectiveReagreements,
      acuerdosCrudos: Number(integracionPagos?.acuerdosCrudos ?? integracionPagos?.episodios?.acuerdosCrudos ?? rows.length),
      acuerdosReemplazadosSinPago: Number(integracionPagos?.acuerdosReemplazadosSinPago ?? integracionPagos?.episodios?.acuerdosReemplazadosSinPago ?? 0),
      casosConMasDeUnEpisodio: Number(integracionPagos?.casosConMasDeUnEpisodio ?? integracionPagos?.episodios?.casosConMasDeUnEpisodio ?? 0),
      tasaConPagoPosterior: paymentAvailable && rows.length
        ? (agreementsWithLaterPayment.length * 100) / rows.length
        : 0,
      tasaConPagoValido: paymentAvailable && rows.length
        ? (agreementsWithLaterPayment.length * 100) / rows.length
        : 0,
      ticketPromedioPosterior: agreementsWithLaterPayment.length
        ? sum(rows, "montoPagosPosteriores") / agreementsWithLaterPayment.length
        : 0,
      ticketPromedioValido: agreementsWithLaterPayment.length
        ? sum(rows, "montoPagosPosteriores") / agreementsWithLaterPayment.length
        : 0,
      periodoHasta: String(integracionPagos?.periodoHasta || ""),
      motivo: integracionPagos?.motivo || "",
    },
    integracionPagos: {
      disponible: paymentAvailable,
      motivo: integracionPagos?.motivo || "",
      pagosConsultados: Number(integracionPagos?.pagosConsultados || 0),
      acuerdosEvaluados: Number(integracionPagos?.acuerdosEvaluados || rows.length),
      acuerdosCrudos: Number(integracionPagos?.acuerdosCrudos ?? integracionPagos?.episodios?.acuerdosCrudos ?? rows.length),
      acuerdosEfectivos: Number(integracionPagos?.acuerdosEfectivos ?? integracionPagos?.episodios?.acuerdosEfectivos ?? rows.length),
      acuerdosReemplazadosSinPago: Number(integracionPagos?.acuerdosReemplazadosSinPago ?? integracionPagos?.episodios?.acuerdosReemplazadosSinPago ?? 0),
      casosConMasDeUnEpisodio: Number(integracionPagos?.casosConMasDeUnEpisodio ?? integracionPagos?.episodios?.casosConMasDeUnEpisodio ?? 0),
      episodiosAdicionalesPagados: Number(integracionPagos?.episodiosAdicionalesPagados ?? integracionPagos?.episodios?.episodiosAdicionalesPagados ?? 0),
      periodoHasta: String(integracionPagos?.periodoHasta || ""),
    },
    recaudacionPeriodo: {
      disponible: Boolean(recaudacionPeriodo?.disponible),
      motivo: recaudacionPeriodo?.motivo || "",
      total: Number(recaudacionPeriodo?.total || 0),
      recaudadoMes: Number(recaudacionPeriodo?.total || 0),
      recaudadoAcuerdosPeriodo: Number(recaudacionPeriodo?.recaudadoAcuerdosPeriodo || 0),
      recaudadoCarteraAnterior: Number(recaudacionPeriodo?.recaudadoCarteraAnterior || 0),
      cantidadPagos: Number(recaudacionPeriodo?.cantidadPagos || 0),
      cantidadPagosAcuerdosPeriodo: Number(recaudacionPeriodo?.cantidadPagosAcuerdosPeriodo || 0),
      cantidadPagosCarteraAnterior: Number(recaudacionPeriodo?.cantidadPagosCarteraAnterior || 0),
      periodoDesde: String(recaudacionPeriodo?.periodoDesde || ""),
      periodoHasta: String(recaudacionPeriodo?.periodoHasta || ""),
    },
    crucePagos: {
      disponible: paymentAvailable,
      acuerdosVencidosAnalizados: overdue.length,
      conPagoPosterior: overdueWithLaterPayment.length,
      conPagoValido: overdueWithLaterPayment.length,
      pagoMismoDia: overdueSameDayPayment.length,
      sinPagoPosterior: overdueWithoutLaterPayment.length,
      sinPagoValido: overdueWithoutLaterPayment.length,
      sinDatosPagos: paymentAvailable
        ? overdue.filter((row) => row.estadoPagoAcuerdo === "SIN DATOS DE PAGOS").length
        : overdue.length,
      pagosRelacionados: overdue.reduce(
        (total, row) => total + Number(row.cantidadPagosPosteriores || 0),
        0
      ),
      montoPosterior: sum(overdueWithLaterPayment, "montoPagosPosteriores"),
      montoValido: sum(overdueWithLaterPayment, "montoPagosPosteriores"),
      montoMismoDia: sum(overdueSameDayPayment, "montoPagosMismoDia"),
      entidadesSinDatos: [...new Set(
        overdue
          .filter((row) => row.estadoPagoAcuerdo === "SIN DATOS DE PAGOS")
          .map((row) => row.entidad)
          .filter(Boolean)
      )],
      periodoHasta: String(integracionPagos?.periodoHasta || ""),
    },
    porOperador,
    porEntidad: groupRows(rows, "entidad"),
    porTipo: groupRows(rows, "tipoAcuerdo"),
    porDia: [...porDiaMap.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)),
    calendarioOperadores,
    operadoresSinAcuerdos: sinAcuerdos,
  };
}

function excelDate(iso) {
  const date = dateFromISO(iso);
  return date || null;
}

function money(value) {
  return Number(value || 0);
}

function styleHeader(row, color = COLORS.dark) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    cell.font = { color: { argb: COLORS.white }, bold: true, size: 10 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD9D9D9" } },
      left: { style: "thin", color: { argb: "FFD9D9D9" } },
      bottom: { style: "thin", color: { argb: "FFD9D9D9" } },
      right: { style: "thin", color: { argb: "FFD9D9D9" } },
    };
  });
  row.height = 28;
}

function titleSheet(ws, title, subtitle, columns) {
  ws.mergeCells(1, 1, 1, columns);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title;
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.dark } };
  titleCell.font = { color: { argb: COLORS.white }, bold: true, size: 15 };
  titleCell.alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(1).height = 27;

  ws.mergeCells(2, 1, 2, columns);
  const subtitleCell = ws.getCell(2, 1);
  subtitleCell.value = subtitle;
  subtitleCell.font = { color: { argb: "FF71627D" }, italic: true, size: 9 };
  subtitleCell.alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(2).height = 20;
  ws.getRow(3).height = 8;
}

function setWidths(ws, widths) {
  widths.forEach((width, index) => {
    ws.getColumn(index + 1).width = width;
  });
}

function styleDataRow(row, { height = 23, center = [], moneyCols = [], dateCols = [], wrapCols = [] } = {}) {
  row.height = height;
  row.eachCell({ includeEmpty: true }, (cell, col) => {
    cell.alignment = {
      horizontal: center.includes(col) ? "center" : "left",
      vertical: "middle",
      wrapText: wrapCols.includes(col),
    };
    cell.border = {
      bottom: { style: "hair", color: { argb: "FFE8E0EF" } },
      right: { style: "hair", color: { argb: "FFF0EAF5" } },
    };
    if (moneyCols.includes(col)) cell.numFmt = '$ #,##0.00';
    if (dateCols.includes(col)) cell.numFmt = 'dd/mm/yyyy';
  });
}

function performanceFill(agreements, maxAgreements) {
  const value = Number(agreements || 0);
  const max = Math.max(1, Number(maxAgreements || 0));
  if (value <= 0) return { fill: COLORS.redSoft, font: COLORS.red };
  if (value >= max * 0.8) return { fill: COLORS.greenSoft, font: "FF075D43" };
  if (value >= max * 0.3) return { fill: COLORS.yellow, font: "FF6A5200" };
  return { fill: COLORS.orangeSoft, font: "FF8A3B12" };
}

function stylePerformanceCells(row, agreements, maxAgreements) {
  const tone = performanceFill(agreements, maxAgreements);
  [1, 3].forEach((col) => {
    const cell = row.getCell(col);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: tone.fill } };
    cell.font = { ...cell.font, color: { argb: tone.font }, bold: true };
  });
}

function addStatisticsSheet(workbook, summary, metadata) {
  const ws = workbook.addWorksheet("Estadisticas");
  titleSheet(
    ws,
    "ESTADÍSTICAS DE ACUERDOS DE PAGO",
    `Período ${metadata.desde || "inicio"} a ${metadata.hasta || "actualidad"} · sin detalle de gestiones`,
    18
  );

  const labels = [
    "GESTIONES", "ACUERDOS EFECTIVOS", "TASA DE ACUERDO", "DNIs CON ACUERDO",
    "1ER PAGO PROYECTADO", "1ER PAGO COBRADO", "TICKET PROMEDIO", "MONTO CONTRACTUAL",
    "REACUERDOS EFECTIVOS", "VENCIDOS",
  ];
  ws.addRow(labels);
  styleHeader(ws.getRow(4), COLORS.purple);
  const values = ws.addRow([
    summary.totalGestiones,
    summary.totalAcuerdos,
    summary.tasaAcuerdo / 100,
    summary.dnisConAcuerdo,
    summary.totalPrimerPago,
    summary.totalPrimerPagoCobrado,
    summary.ticketPromedioPrimerPago,
    summary.montoTotalAcuerdos,
    summary.reacuerdosEfectivos,
    summary.vencidos,
  ]);
  values.height = 28;
  values.eachCell((cell, col) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.lilac } };
    cell.font = { bold: true, size: 11, color: { argb: COLORS.dark } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    if (col === 3) cell.numFmt = "0.00%";
    if ([5, 6, 7, 8].includes(col)) cell.numFmt = '$ #,##0.00';
  });

  ws.addRow([]);
  ws.addRow(["ESTADO DE VENCIMIENTOS", "CANTIDAD", "MONTO PRIMER PAGO"]);
  styleHeader(ws.getRow(7));
  const vencimientosRows = [
    ["Vencidos", summary.vencidos, summary.montoVencido],
    ["Vence hoy", summary.venceHoy, ""],
    ["Próximos 3 días", summary.proximos3Dias, ""],
  ];
  if (summary.integracionPagos?.disponible) {
    vencimientosRows.push(
      ["Vencidos con pago válido", summary.vencidosConPagoValido ?? summary.vencidosConPagoPosterior, summary.montoPagosValidosVencidos ?? summary.montoPagosPosterioresVencidos],
      ["Vencidos con pago el mismo día (válido)", summary.vencidosPagoMismoDia, summary.montoPagosMismoDiaVencidos],
      ["Vencidos sin pago válido", summary.vencidosSinPagoValido ?? summary.vencidosSinPagoPosterior, ""]
    );
  } else {
    vencimientosRows.push(["Cruce con Pagos", "Sin datos cargados", ""]);
  }
  vencimientosRows.forEach((data) => {
    const row = ws.addRow(data);
    styleDataRow(row, { center: [2], moneyCols: [3] });
  });

  ws.addRow([]);
  ws.addRow(["SEGUIMIENTO REAL DE PAGOS DEL ACUERDO", "VALOR", "DETALLE"]);
  styleHeader(ws.lastRow, COLORS.green);
  const paymentSummaryRows = summary.integracionPagos?.disponible
    ? [
        ["Acuerdos efectivos", summary.totalAcuerdos || 0, `${summary.integracionPagos?.acuerdosReemplazadosSinPago || 0} reemplazado(s) sin pago no duplican productividad`],
        ["Casos con más de un episodio", summary.integracionPagos?.casosConMasDeUnEpisodio || 0, `${summary.reacuerdosEfectivos || 0} reacuerdo(s) efectivo(s) adicional(es)`],
        ["Acuerdos con pago válido", summary.seguimientoPagos?.conPagoValido ?? summary.seguimientoPagos?.conPagoPosterior ?? 0, `${Number(summary.seguimientoPagos?.tasaConPagoValido ?? summary.seguimientoPagos?.tasaConPagoPosterior ?? 0).toFixed(1)}% de los acuerdos`],
        ["Primer pago cobrado", summary.totalPrimerPagoCobrado || 0, `${summary.acuerdosPrimerPagoCubierto || 0} primer(os) pago(s) cubierto(s)`],
        ["Cobrado válido", summary.seguimientoPagos?.montoPagosValidos ?? summary.seguimientoPagos?.montoPagosPosteriores ?? 0, `${summary.seguimientoPagos?.cantidadPagosValidos ?? summary.seguimientoPagos?.cantidadPagosPosteriores ?? 0} pago(s) válido(s)`],
        ["Cobro acuerdos del período", summary.recaudacionPeriodo?.recaudadoAcuerdosPeriodo || 0, `${summary.recaudacionPeriodo?.cantidadPagosAcuerdosPeriodo || 0} pago(s) real(es) imputados a acuerdos generados en el período`],
        ["Cobro acuerdos anteriores", summary.recaudacionPeriodo?.recaudadoCarteraAnterior || 0, `${summary.recaudacionPeriodo?.cantidadPagosCarteraAnterior || 0} cuota(s) / pago(s) de acuerdos anteriores`],
        ["Recaudado total período", summary.recaudacionPeriodo?.recaudadoMes || 0, `${summary.recaudacionPeriodo?.cantidadPagos || 0} pago(s) reales en total`],
        ["Incluyen pago el mismo día", summary.seguimientoPagos?.pagoMismoDia || 0, "Se considera válido y también se identifica por separado"],
        ["Sin pago válido", summary.seguimientoPagos?.sinPagoValido ?? summary.seguimientoPagos?.sinPagoPosterior ?? 0, "Sin cobro desde la fecha del acuerdo dentro de la ventana"],
      ]
    : [["Cruce con Pagos", "Sin datos cargados", summary.integracionPagos?.motivo || "La empresa no utiliza o no tiene cargado el módulo Pagos"]];
  paymentSummaryRows.forEach((data) => {
    const row = ws.addRow(data);
    const moneyRow = ["Primer pago cobrado", "Cobrado válido", "Cobro acuerdos del período", "Cobro acuerdos anteriores", "Recaudado total período"].includes(String(data?.[0] || ""));
    styleDataRow(row, { center: [2], moneyCols: moneyRow && summary.integracionPagos?.disponible ? [2] : [] });
  });

  ws.addRow([]);
  ws.addRow([
    "OPERADOR", "TOTAL GESTIONES", "ACUERDOS EFECTIVOS", "1ER PAGO PROYECTADO", "1ER PAGO COBRADO",
    "TICKET PROMEDIO 1ER PAGO", "MONTO CONTRACTUAL", "REACUERDOS EFECTIVOS",
    "ACUERDOS CON PAGO", "COBRADO VINCULADO", "COBRO ACUERDOS DEL PERÍODO", "COBRO ACUERDOS ANTERIORES",
    "RECAUDADO TOTAL PERÍODO", "CANCELACIÓN", "CANCELACIÓN CON ANTICIPO",
    "ACUERDO EN CUOTAS CON ANTICIPO", "ACUERDO EN CUOTAS SIN ANTICIPO", "PARCIAL",
  ]);
  const operatorHeader = ws.lastRow.number;
  styleHeader(ws.getRow(operatorHeader));
  const maxAgreements = Math.max(1, ...(summary.porOperador || []).map((item) => Number(item.acuerdos || 0)));
  summary.porOperador.forEach((item) => {
    const row = ws.addRow([
      item.nombre,
      item.totalGestiones,
      item.acuerdos,
      item.primerPago,
      item.primerPagoCobrado,
      item.ticketPromedio,
      item.montoTotal,
      item.reacuerdosEfectivos,
      item.conPagoPosterior,
      item.montoPagosPosteriores,
      item.recaudadoAcuerdosPeriodo,
      item.recaudadoCarteraAnterior,
      item.recaudadoMes,
      item.cancelacion,
      item.cancelacionConAnticipo,
      item.cuotasConAnticipo,
      item.cuotasSinAnticipo,
      item.parcial,
    ]);
    styleDataRow(row, { center: [2, 3, 8, 9, 14, 15, 16, 17, 18], moneyCols: [4, 5, 6, 7, 10, 11, 12, 13] });
    [4, 5, 6, 7, 10, 11, 12, 13].forEach((col) => { row.getCell(col).numFmt = '$ #,##0'; });
    stylePerformanceCells(row, item.acuerdos, maxAgreements);
  });

  const typeStart = ws.lastRow.number + 2;
  ws.getCell(typeStart, 1).value = "TIPOS DE ACUERDO";
  ws.getCell(typeStart, 1).font = { bold: true, color: { argb: COLORS.purple }, size: 11 };
  ws.getRow(typeStart + 1).values = ["TIPO", "ACUERDOS", "DNIs", "1ER PAGO PROYECTADO", "MONTO CONTRACTUAL", "VENCIDOS"];
  styleHeader(ws.getRow(typeStart + 1), COLORS.purple);
  summary.porTipo.forEach((item) => {
    const row = ws.addRow([item.nombre, item.acuerdos, item.dnis, item.primerPago, item.montoTotal, item.vencidos]);
    styleDataRow(row, { center: [2, 3, 6], moneyCols: [4, 5] });
  });

  const entityStart = ws.lastRow.number + 2;
  ws.getCell(entityStart, 1).value = "ENTIDADES";
  ws.getCell(entityStart, 1).font = { bold: true, color: { argb: COLORS.purple }, size: 11 };
  ws.getRow(entityStart + 1).values = ["ENTIDAD", "ACUERDOS", "DNIs", "1ER PAGO PROYECTADO", "TICKET PROMEDIO 1ER PAGO", "MONTO CONTRACTUAL", "VENCIDOS"];
  styleHeader(ws.getRow(entityStart + 1), COLORS.dark);
  summary.porEntidad.forEach((item) => {
    const row = ws.addRow([item.nombre, item.acuerdos, item.dnis, item.primerPago, item.ticketPromedio, item.montoTotal, item.vencidos]);
    styleDataRow(row, { center: [2, 3, 7], moneyCols: [4, 5, 6] });
  });

  if (summary.operadoresSinAcuerdos?.length) {
    const noStart = ws.lastRow.number + 2;
    ws.getCell(noStart, 1).value = "OPERADORES CON GESTIONES Y SIN ACUERDOS";
    ws.getCell(noStart, 1).font = { bold: true, color: { argb: COLORS.red } };
    ws.getRow(noStart + 1).values = ["OPERADOR", "GESTIONES"];
    styleHeader(ws.getRow(noStart + 1), COLORS.red);
    summary.operadoresSinAcuerdos.forEach((item) => {
      const row = ws.addRow([item.operador, item.gestiones]);
      styleDataRow(row, { center: [2] });
    });
  }

  setWidths(ws, [28, 16, 15, 19, 19, 23, 21, 17, 18, 21, 23, 23, 22, 15, 23, 28, 28, 12]);
  ws.views = [{ state: "frozen", ySplit: 4, showGridLines: false }];
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

function addProductivitySheet(workbook, summary) {
  const ws = workbook.addWorksheet("Productividad");
  titleSheet(
    ws,
    "RESUMEN DE ACUERDOS POR OPERADOR",
    "Verde = mejor rendimiento del período | amarillo = medio | naranja = bajo | rojo = activos sin acuerdos",
    18
  );
  ws.addRow([
    "OPERADOR", "TOTAL GESTIONES", "ACUERDOS EFECTIVOS", "1ER PAGO PROYECTADO", "1ER PAGO COBRADO",
    "TICKET PROMEDIO 1ER PAGO", "MONTO CONTRACTUAL", "REACUERDOS EFECTIVOS",
    "ACUERDOS CON PAGO", "COBRADO VINCULADO", "COBRO ACUERDOS DEL PERÍODO", "COBRO ACUERDOS ANTERIORES",
    "RECAUDADO TOTAL PERÍODO", "CANCELACIÓN", "CANCELACIÓN CON ANTICIPO",
    "ACUERDO EN CUOTAS CON ANTICIPO", "ACUERDO EN CUOTAS SIN ANTICIPO", "PARCIAL",
  ]);
  styleHeader(ws.getRow(4));

  const operators = summary.porOperador || [];
  const maxAgreements = Math.max(1, ...operators.map((item) => Number(item.acuerdos || 0)));
  operators.forEach((item) => {
    const row = ws.addRow([
      item.nombre,
      item.totalGestiones,
      item.acuerdos,
      item.primerPago,
      item.primerPagoCobrado,
      item.ticketPromedio,
      item.montoTotal,
      item.reacuerdosEfectivos,
      item.conPagoPosterior,
      item.montoPagosPosteriores,
      item.recaudadoAcuerdosPeriodo,
      item.recaudadoCarteraAnterior,
      item.recaudadoMes,
      item.cancelacion,
      item.cancelacionConAnticipo,
      item.cuotasConAnticipo,
      item.cuotasSinAnticipo,
      item.parcial,
    ]);
    styleDataRow(row, { center: [2, 3, 8, 9, 14, 15, 16, 17, 18], moneyCols: [4, 5, 6, 7, 10, 11, 12, 13] });
    [4, 5, 6, 7, 10, 11, 12, 13].forEach((col) => { row.getCell(col).numFmt = '$ #,##0'; });
    stylePerformanceCells(row, item.acuerdos, maxAgreements);
  });
  ws.autoFilter = { from: "A4", to: `R${Math.max(4, operators.length + 4)}` };
  setWidths(ws, [26, 16, 15, 20, 20, 23, 21, 18, 20, 21, 23, 23, 22, 15, 23, 29, 29, 12]);
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 4, showGridLines: false }];
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

function addDailySheet(workbook, summary) {
  const ws = workbook.addWorksheet("Acuerdos_por_dia");
  titleSheet(ws, "ACUERDOS POR DÍA", "Cantidad de episodios efectivos, 1er pago proyectado y monto contractual por jornada", 4);
  ws.addRow(["FECHA", "ACUERDOS EFECTIVOS", "1ER PAGO PROYECTADO", "MONTO CONTRACTUAL"]);
  styleHeader(ws.getRow(4));
  summary.porDia.forEach((item) => {
    const row = ws.addRow([excelDate(item.fecha), item.acuerdos, item.primerPago, item.montoTotal]);
    styleDataRow(row, { center: [1, 2], dateCols: [1], moneyCols: [3, 4] });
  });
  ws.autoFilter = { from: "A4", to: `D${Math.max(4, summary.porDia.length + 4)}` };
  setWidths(ws, [16, 14, 20, 20]);
  ws.views = [{ state: "frozen", ySplit: 4, showGridLines: false }];
}

const MONTH_NAMES = [
  "ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO",
  "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE",
];

function monthKeys(metadata) {
  const start = dateFromISO(metadata.desde) || dateFromISO(hoyArgentinaISO());
  const end = dateFromISO(metadata.hasta) || start;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const output = [];
  while (cursor <= last && output.length < 12) {
    output.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return output;
}

function addCalendarSheet(workbook, summary, metadata) {
  const ws = workbook.addWorksheet("Calendario");
  titleSheet(
    ws,
    "CALENDARIO OPERADORES × DÍAS",
    "Cantidad de acuerdos por operador y jornada. Las celdas más intensas representan mayor volumen dentro del mes.",
    32
  );
  setWidths(ws, [24, ...Array(31).fill(5.2)]);

  const operators = summary.calendarioOperadores || [];
  let rowCursor = 4;

  monthKeys(metadata).forEach(({ year, month }, monthIndex) => {
    const dayCount = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
    const allMonthValues = operators.flatMap((operator) =>
      (operator.dias || []).filter((day) => String(day.fecha || "").startsWith(monthKey))
    );
    const maxValue = Math.max(1, ...allMonthValues.map((day) => Number(day.acuerdos || 0)));

    if (monthIndex > 0) rowCursor += 2;
    ws.mergeCells(rowCursor, 1, rowCursor, dayCount + 1);
    const monthCell = ws.getCell(rowCursor, 1);
    monthCell.value = `USUARIOS × DÍAS — ${MONTH_NAMES[month]} ${year}`;
    monthCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.lilac } };
    monthCell.font = { color: { argb: COLORS.purple }, bold: true, size: 12 };
    monthCell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(rowCursor).height = 24;
    rowCursor += 1;

    const header = ws.getRow(rowCursor);
    header.getCell(1).value = "GESTOR";
    for (let day = 1; day <= dayCount; day += 1) {
      header.getCell(day + 1).value = String(day).padStart(2, "0");
    }
    styleHeader(header, COLORS.lilac);
    header.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { color: { argb: COLORS.purple }, bold: true, size: 9 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.lilac } };
    });
    header.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
    rowCursor += 1;

    operators.forEach((operator) => {
      const byDate = new Map((operator.dias || []).map((day) => [day.fecha, day]));
      const row = ws.getRow(rowCursor);
      row.height = 22;
      row.getCell(1).value = operator.operador;
      row.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
      row.getCell(1).font = { color: { argb: "FF55455F" }, size: 9 };

      for (let day = 1; day <= dayCount; day += 1) {
        const iso = `${monthKey}-${String(day).padStart(2, "0")}`;
        const item = byDate.get(iso);
        const agreements = Number(item?.acuerdos || 0);
        const cell = row.getCell(day + 1);
        cell.value = agreements || "—";
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.font = { bold: agreements > 0, size: 8, color: { argb: agreements ? COLORS.text : "FF9D92A5" } };

        const ratio = agreements / maxValue;
        const fill = agreements === 0
          ? "FFF3F1F7"
          : ratio >= 0.75
          ? "FFBFE8D3"
          : ratio >= 0.45
          ? "FFE1F2DF"
          : ratio >= 0.2
          ? "FFFFE7C5"
          : "FFFFD0D5";
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
        cell.border = {
          top: { style: "thin", color: { argb: "FFFFFFFF" } },
          left: { style: "thin", color: { argb: "FFFFFFFF" } },
          bottom: { style: "thin", color: { argb: "FFFFFFFF" } },
          right: { style: "thin", color: { argb: "FFFFFFFF" } },
        };
        if (item) {
          cell.note = `${agreements} acuerdos | Primeros pagos: $ ${Number(item.primerPago || 0).toLocaleString("es-AR")}`;
        }
      }
      rowCursor += 1;
    });

    if (!operators.length) {
      ws.mergeCells(rowCursor, 1, rowCursor, dayCount + 1);
      const empty = ws.getCell(rowCursor, 1);
      empty.value = "No hay operadores para este período.";
      empty.alignment = { horizontal: "center", vertical: "middle" };
      empty.font = { italic: true, color: { argb: "FF81758B" } };
      rowCursor += 1;
    }
  });

  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 5, showGridLines: false }];
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

function addAgreementRowsSheet(workbook, rows) {
  const ws = workbook.addWorksheet("Gestiones_con_acuerdo");
  titleSheet(
    ws,
    "GESTIONES CON ACUERDO",
    "Acuerdos efectivos por episodio · proyección de 1er pago separada del monto contractual · cruce opcional con Pagos",
    38
  );
  ws.addRow([
    "ESTADO VENCIMIENTO", "PRIMER VENCIMIENTO", "DÍAS", "EPISODIO", "REACUERDO EFECTIVO",
    "CRUCE CON PAGOS", "PAGOS VÁLIDOS", "MONTO PAGOS VÁLIDOS", "ÚLTIMO PAGO ANTERIOR", "MONTO ÚLTIMO PAGO ANTERIOR",
    "DÍAS ANTES", "PAGOS MISMO DÍA", "TIPO ACUERDO", "1ER PAGO PROYECTADO", "1ER PAGO COBRADO",
    "FECHA 1ER PAGO COBRADO", "1ER PAGO CUBIERTO", "MONTO CONTRACTUAL", "FECHA ANTICIPO", "MONTO ANTICIPO",
    "CUOTAS", "MONTO CUOTA", "DEUDA MÁXIMA", "DNI", "TELÉFONO GESTIÓN", "NOMBRE DEUDOR", "FECHA GESTIÓN",
    "HORA", "USUARIO ACUERDO", "ENTIDAD", "TIPO CONTACTO", "RESULTADO GESTIÓN",
    "ESTADO DE LA CUENTA", "OBSERVACIÓN ORIGINAL", "ÚLTIMA GESTIÓN MANGO",
    "HORA ÚLTIMA GESTIÓN", "ÚLTIMO GESTOR", "RESULTADO ÚLTIMA GESTIÓN",
  ]);
  styleHeader(ws.getRow(4));

  rows.forEach((item) => {
    const episodio = item.episodioNumero
      ? `${item.episodioNumero}${Number(item.episodiosCaso || 0) > 1 ? ` de ${item.episodiosCaso}` : ""}`
      : "—";
    const row = ws.addRow([
      item.estadoVencimiento,
      excelDate(item.primerVencimiento),
      item.estadoVencimiento === "VENCIDO" ? item.diasVencido : item.diasParaVencer ?? "",
      episodio,
      item.esReacuerdoEfectivo ? "SÍ" : "NO",
      item.estadoPagoAcuerdo,
      item.cantidadPagosPosteriores,
      money(item.montoPagosPosteriores),
      excelDate(item.ultimoPagoAnterior),
      money(item.montoUltimoPagoAnterior),
      item.diasPagoAnterior ?? "",
      item.cantidadPagosMismoDia,
      item.tipoAcuerdo,
      money(item.primerPago),
      money(item.montoPrimerPagoCobrado),
      excelDate(item.fechaPrimerPagoCobrado),
      item.primerPagoCubierto ? "SÍ" : "NO",
      money(item.montoTotalAcuerdo),
      excelDate(item.fechaAnticipo),
      money(item.montoAnticipo),
      item.cuotas,
      money(item.montoCuota),
      money(item.deudaMaxima),
      Number(item.dni || 0) || item.dni,
      item.telefonoGestion,
      item.nombreDeudor,
      excelDate(item.fecha),
      item.hora,
      item.usuario,
      item.entidad,
      item.tipoContacto,
      item.resultadoGestion,
      item.estadoCuenta,
      item.observacionGestion,
      excelDate(item.ultimaGestionMangoFecha),
      item.ultimaGestionMangoHora,
      item.ultimaGestionMangoUsuario,
      item.ultimaGestionMangoResultado,
    ]);
    styleDataRow(row, {
      height: 24,
      center: [1, 2, 3, 4, 5, 6, 7, 9, 11, 12, 16, 17, 19, 21, 24, 25, 27, 28, 35, 36],
      moneyCols: [8, 10, 14, 15, 18, 20, 22, 23],
      dateCols: [2, 9, 16, 19, 27, 35],
      wrapCols: [34, 38],
    });

    const fillColor = item.estadoVencimiento === "VENCIDO"
      ? COLORS.redSoft
      : item.estadoVencimiento === "VENCE HOY"
      ? COLORS.yellow
      : item.estadoVencimiento === "PRÓXIMO 3 DÍAS"
      ? COLORS.lilac
      : COLORS.greenSoft;
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
    row.getCell(1).font = { bold: true, color: { argb: item.estadoVencimiento === "VENCIDO" ? COLORS.red : COLORS.dark } };

    if (item.esReacuerdoEfectivo) {
      [4, 5].forEach((col) => {
        row.getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.lilac } };
        row.getCell(col).font = { bold: true, color: { argb: COLORS.purple } };
      });
    }

    const paymentCell = row.getCell(6);
    const paymentFill = ["CON PAGO POSTERIOR", "CON PAGO VÁLIDO"].includes(item.estadoPagoAcuerdo)
      ? COLORS.greenSoft
      : ["PAGO MISMO DÍA", "PAGO MISMO DÍA VÁLIDO"].includes(item.estadoPagoAcuerdo)
      ? COLORS.yellow
      : ["SIN PAGO POSTERIOR", "SIN PAGO VÁLIDO"].includes(item.estadoPagoAcuerdo)
      ? COLORS.redSoft
      : COLORS.gray;
    paymentCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: paymentFill } };
    paymentCell.font = { bold: true, color: { argb: ["SIN PAGO POSTERIOR", "SIN PAGO VÁLIDO"].includes(item.estadoPagoAcuerdo) ? COLORS.red : COLORS.dark } };

    if (item.primerPagoCubierto) {
      [15, 17].forEach((col) => {
        row.getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.greenSoft } };
        row.getCell(col).font = { bold: true, color: { argb: "FF075D43" } };
      });
    }
  });

  setWidths(ws, [19, 16, 9, 11, 18, 24, 15, 22, 19, 22, 12, 16, 31, 20, 19, 20, 18, 19, 16, 17, 10, 17, 17, 14, 20, 27, 16, 12, 20, 21, 23, 29, 27, 54, 17, 13, 20, 34]);
  ws.autoFilter = { from: "A4", to: `AL${Math.max(4, rows.length + 4)}` };
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 4, showGridLines: false }];
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

function addDueSheet(workbook, rows) {
  const ws = workbook.addWorksheet("Vencidos");
  titleSheet(
    ws,
    "ACUERDOS EFECTIVOS VENCIDOS",
    "Episodios vigentes/efectivos · primer pago proyectado y cobrado · cruce con pagos válidos",
    30
  );
  ws.addRow([
    "PRIMER VENCIMIENTO", "ESTADO", "DÍAS VENCIDO", "EPISODIO", "REACUERDO EFECTIVO",
    "CRUCE CON PAGOS", "PAGOS VÁLIDOS", "MONTO PAGOS VÁLIDOS", "ÚLTIMO PAGO ANTERIOR", "MONTO ÚLTIMO PAGO ANTERIOR",
    "DÍAS ANTES", "PAGOS MISMO DÍA", "1ER PAGO PROYECTADO", "1ER PAGO COBRADO", "FECHA 1ER PAGO COBRADO",
    "1ER PAGO CUBIERTO", "MONTO CONTRACTUAL", "TIPO ACUERDO", "OPERADOR ACUERDO", "ENTIDAD", "DNI", "TELÉFONO GESTIÓN", "NOMBRE",
    "FECHA GESTIÓN", "HORA", "RESULTADO", "ESTADO CUENTA", "TIPO CONTACTO",
    "OBSERVACIÓN ORIGINAL", "ID COBRINA",
  ]);
  styleHeader(ws.getRow(4));

  const dueRows = rows
    .filter((item) => item.estadoVencimiento === "VENCIDO")
    .sort((a, b) => (a.primerVencimiento || "9999").localeCompare(b.primerVencimiento || "9999"));

  dueRows.forEach((item) => {
    const episodio = item.episodioNumero
      ? `${item.episodioNumero}${Number(item.episodiosCaso || 0) > 1 ? ` de ${item.episodiosCaso}` : ""}`
      : "—";
    const row = ws.addRow([
      excelDate(item.primerVencimiento), item.estadoVencimiento, item.diasVencido,
      episodio, item.esReacuerdoEfectivo ? "SÍ" : "NO",
      item.estadoPagoAcuerdo, item.cantidadPagosPosteriores, money(item.montoPagosPosteriores),
      excelDate(item.ultimoPagoAnterior), money(item.montoUltimoPagoAnterior), item.diasPagoAnterior ?? "", item.cantidadPagosMismoDia,
      money(item.primerPago), money(item.montoPrimerPagoCobrado), excelDate(item.fechaPrimerPagoCobrado), item.primerPagoCubierto ? "SÍ" : "NO",
      money(item.montoTotalAcuerdo), item.tipoAcuerdo,
      item.usuario, item.entidad, Number(item.dni || 0) || item.dni, item.telefonoGestion, item.nombreDeudor,
      excelDate(item.fecha), item.hora, item.resultadoGestion, item.estadoCuenta,
      item.tipoContacto, item.observacionGestion, item.id,
    ]);
    styleDataRow(row, {
      height: 30,
      center: [1, 2, 3, 4, 5, 6, 7, 9, 11, 12, 15, 16, 21, 22, 24, 25],
      moneyCols: [8, 10, 13, 14, 17],
      dateCols: [1, 9, 15, 24],
      wrapCols: [29],
    });
    [1, 2, 3].forEach((col) => {
      row.getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.redSoft } };
      row.getCell(col).font = { color: { argb: COLORS.red }, bold: col === 2 };
    });
    if (item.esReacuerdoEfectivo) {
      [4, 5].forEach((col) => {
        row.getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.lilac } };
        row.getCell(col).font = { bold: true, color: { argb: COLORS.purple } };
      });
    }
    const paymentCell = row.getCell(6);
    const paymentFill = ["CON PAGO POSTERIOR", "CON PAGO VÁLIDO"].includes(item.estadoPagoAcuerdo)
      ? COLORS.greenSoft
      : ["PAGO MISMO DÍA", "PAGO MISMO DÍA VÁLIDO"].includes(item.estadoPagoAcuerdo)
      ? COLORS.yellow
      : ["SIN PAGO POSTERIOR", "SIN PAGO VÁLIDO"].includes(item.estadoPagoAcuerdo)
      ? COLORS.redSoft
      : COLORS.gray;
    paymentCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: paymentFill } };
    paymentCell.font = { bold: true, color: { argb: ["SIN PAGO POSTERIOR", "SIN PAGO VÁLIDO"].includes(item.estadoPagoAcuerdo) ? COLORS.red : COLORS.dark } };
    if (item.primerPagoCubierto) {
      [14, 16].forEach((col) => {
        row.getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.greenSoft } };
        row.getCell(col).font = { bold: true, color: { argb: "FF075D43" } };
      });
    }
  });

  setWidths(ws, [17, 16, 13, 11, 18, 24, 15, 22, 19, 22, 12, 16, 20, 19, 20, 18, 19, 27, 20, 21, 14, 20, 27, 16, 12, 29, 27, 23, 54, 26]);
  ws.autoFilter = { from: "A4", to: `AD${Math.max(4, dueRows.length + 4)}` };
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 4, showGridLines: false }];
}

export async function crearExcelAcuerdos({ rows = [], summary = {}, metadata = {}, kind = "estadisticas", overdueOnly = false }) {
  const workbook = new ExcelJS.Workbook();
  const excelRows = rows.slice();

  workbook.creator = "COBRINA";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.properties.date1904 = false;

  const exportKind = overdueOnly ? "vencidos" : kind;
  if (exportKind === "gestiones") {
    addAgreementRowsSheet(workbook, excelRows);
  } else if (exportKind === "vencidos") {
    addDueSheet(workbook, excelRows);
  } else {
    addStatisticsSheet(workbook, summary, metadata);
    addProductivitySheet(workbook, summary);
    addDailySheet(workbook, summary);
    addCalendarSheet(workbook, summary, metadata);
  }

  return workbook.xlsx.writeBuffer();
}

export { TIPOS_ACUERDO, hoyArgentinaISO };
