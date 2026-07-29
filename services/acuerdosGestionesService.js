import ExcelJS from "exceljs";

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

  const firstDueISO = fechaISO(firstDue || advanceDate || paymentDate);
  const dueStatus = estadoVencimiento(firstDueISO);

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
    tipoAcuerdo: type,
    fechaAnticipo: fechaISO(advanceDate),
    montoAnticipo: Number(advanceAmount || 0),
    cuotas: Number(installments || 0),
    primerVencimiento: firstDueISO,
    montoCuota: Number(installmentAmount || 0),
    primerPago: Number(firstPayment || 0),
    montoTotalAcuerdo: Number(totalAmount || 0),
    deudaMaxima: Number(maxDebt || 0),
    estadoVencimiento: dueStatus.estado,
    diasVencido: dueStatus.diasVencido,
    diasParaVencer: dueStatus.diasParaVencer,
  };
}


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
    montoTotal: 0,
    deudaMaxima: 0,
    vencidos: 0,
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
        montoTotal: 0,
        deudaMaxima: 0,
        vencidos: 0,
        ...emptyAgreementTypes(),
      });
    }
    const item = map.get(value);
    item.acuerdos += 1;
    if (row.dni) item.dnis.add(row.dni);
    item.primerPago += Number(row.primerPago || 0);
    item.montoTotal += Number(row.montoTotalAcuerdo || 0);
    item.deudaMaxima += Number(row.deudaMaxima || 0);
    if (row.estadoVencimiento === "VENCIDO") item.vencidos += 1;
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
      };
    })
    .sort((a, b) => b.acuerdos - a.acuerdos || b.primerPago - a.primerPago || a.nombre.localeCompare(b.nombre, "es"));
}

const sum = (rows, key) => rows.reduce((acc, row) => acc + Number(row?.[key] || 0), 0);

export function resumirAcuerdos(rows, totalGestiones = 0, gestionesPorOperador = []) {
  const totalMap = new Map(
    gestionesPorOperador.map((row) => [claveSimple(row.operador), Number(row.gestiones || 0)])
  );
  const totalAgreements = rows.length;
  const uniqueDnis = new Set(rows.map((row) => row.dni).filter(Boolean)).size;
  const totalFirstPayment = sum(rows, "primerPago");
  const totalAmount = sum(rows, "montoTotalAcuerdo");
  const totalMaxDebt = sum(rows, "deudaMaxima");
  const overdue = rows.filter((row) => row.estadoVencimiento === "VENCIDO");
  const dueToday = rows.filter((row) => row.estadoVencimiento === "VENCE HOY");
  const upcoming = rows.filter((row) => row.estadoVencimiento === "PRÓXIMO 3 DÍAS");

  const porOperadorConAcuerdos = groupRows(rows, "usuario", totalMap);
  const operatorSummaryMap = new Map(
    porOperadorConAcuerdos.map((row) => [claveSimple(row.nombre), row])
  );

  gestionesPorOperador.forEach((row) => {
    const key = claveSimple(row.operador);
    if (!operatorSummaryMap.has(key)) {
      operatorSummaryMap.set(key, emptyOperatorSummary(row.operador, row.gestiones));
    }
  });

  const porOperador = [...operatorSummaryMap.values()].sort(
    (a, b) => b.acuerdos - a.acuerdos || b.primerPago - a.primerPago || b.totalGestiones - a.totalGestiones || a.nombre.localeCompare(b.nombre, "es")
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

  gestionesPorOperador.forEach((row) => {
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
    ticketPromedioPrimerPago: totalAgreements ? totalFirstPayment / totalAgreements : 0,
    montoTotalAcuerdos: totalAmount,
    deudaMaximaInformada: totalMaxDebt,
    coberturaSobreDeuda: totalMaxDebt ? (totalAmount * 100) / totalMaxDebt : 0,
    vencidos: overdue.length,
    venceHoy: dueToday.length,
    proximos3Dias: upcoming.length,
    montoVencido: sum(overdue, "primerPago"),
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
    11
  );

  const labels = [
    "GESTIONES", "ACUERDOS", "TASA DE ACUERDO", "DNIs CON ACUERDO",
    "PRIMEROS PAGOS", "TICKET PROMEDIO", "MONTO ACORDADO", "VENCIDOS",
  ];
  ws.addRow(labels);
  styleHeader(ws.getRow(4), COLORS.purple);
  const values = ws.addRow([
    summary.totalGestiones,
    summary.totalAcuerdos,
    summary.tasaAcuerdo / 100,
    summary.dnisConAcuerdo,
    summary.totalPrimerPago,
    summary.ticketPromedioPrimerPago,
    summary.montoTotalAcuerdos,
    summary.vencidos,
  ]);
  values.height = 28;
  values.eachCell((cell, col) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.lilac } };
    cell.font = { bold: true, size: 11, color: { argb: COLORS.dark } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    if (col === 3) cell.numFmt = "0.00%";
    if ([5, 6, 7].includes(col)) cell.numFmt = '$ #,##0.00';
  });

  ws.addRow([]);
  ws.addRow(["ESTADO DE VENCIMIENTOS", "CANTIDAD", "MONTO PRIMER PAGO"]);
  styleHeader(ws.getRow(7));
  [
    ["Vencidos", summary.vencidos, summary.montoVencido],
    ["Vence hoy", summary.venceHoy, ""],
    ["Próximos 3 días", summary.proximos3Dias, ""],
  ].forEach((data) => {
    const row = ws.addRow(data);
    styleDataRow(row, { center: [2], moneyCols: [3] });
  });

  ws.addRow([]);
  ws.addRow([
    "OPERADOR", "TOTAL GESTIONES", "ACUERDOS", "PRIMER PAGO TOTAL", "TICKET PROMEDIO 1ER PAGO",
    "MONTO TOTAL ACUERDO", "CANCELACIÓN", "CANCELACIÓN CON ANTICIPO",
    "ACUERDO EN CUOTAS CON ANTICIPO", "ACUERDO EN CUOTAS SIN ANTICIPO", "PARCIAL",
  ]);
  const operatorHeader = ws.lastRow.number;
  styleHeader(ws.getRow(operatorHeader));
  const maxAgreements = Math.max(1, ...(summary.porOperador || []).map((item) => Number(item.acuerdos || 0)));
  (summary.porOperador || []).forEach((item) => {
    const row = ws.addRow([
      item.nombre,
      item.totalGestiones,
      item.acuerdos,
      item.primerPago,
      item.ticketPromedio,
      item.montoTotal,
      item.cancelacion,
      item.cancelacionConAnticipo,
      item.cuotasConAnticipo,
      item.cuotasSinAnticipo,
      item.parcial,
    ]);
    styleDataRow(row, { center: [2, 3, 7, 8, 9, 10, 11], moneyCols: [4, 5, 6] });
    [4, 5, 6].forEach((col) => { row.getCell(col).numFmt = '$ #,##0'; });
    stylePerformanceCells(row, item.acuerdos, maxAgreements);
  });

  const typeStart = ws.lastRow.number + 2;
  ws.getCell(typeStart, 1).value = "TIPOS DE ACUERDO";
  ws.getCell(typeStart, 1).font = { bold: true, color: { argb: COLORS.purple }, size: 11 };
  ws.getRow(typeStart + 1).values = ["TIPO", "ACUERDOS", "DNIs", "PRIMER PAGO", "MONTO TOTAL", "VENCIDOS"];
  styleHeader(ws.getRow(typeStart + 1), COLORS.purple);
  (summary.porTipo || []).forEach((item) => {
    const row = ws.addRow([item.nombre, item.acuerdos, item.dnis, item.primerPago, item.montoTotal, item.vencidos]);
    styleDataRow(row, { center: [2, 3, 6], moneyCols: [4, 5] });
  });

  const entityStart = ws.lastRow.number + 2;
  ws.getCell(entityStart, 1).value = "ENTIDADES";
  ws.getCell(entityStart, 1).font = { bold: true, color: { argb: COLORS.purple }, size: 11 };
  ws.getRow(entityStart + 1).values = ["ENTIDAD", "ACUERDOS", "DNIs", "PRIMER PAGO", "TICKET PROMEDIO", "MONTO TOTAL", "VENCIDOS"];
  styleHeader(ws.getRow(entityStart + 1), COLORS.dark);
  (summary.porEntidad || []).forEach((item) => {
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

  setWidths(ws, [28, 16, 12, 19, 23, 21, 15, 23, 28, 28, 12]);
  ws.views = [{ state: "frozen", ySplit: 4, showGridLines: false }];
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

function addProductivitySheet(workbook, summary) {
  const ws = workbook.addWorksheet("Productividad");
  titleSheet(
    ws,
    "RESUMEN DE ACUERDOS POR OPERADOR",
    "Verde = mejor rendimiento del período | amarillo = medio | naranja = bajo | rojo = activos sin acuerdos",
    11
  );
  ws.addRow([
    "OPERADOR", "TOTAL GESTIONES", "ACUERDOS", "PRIMER PAGO TOTAL", "TICKET PROMEDIO 1ER PAGO",
    "MONTO TOTAL ACUERDO", "CANCELACIÓN", "CANCELACIÓN CON ANTICIPO",
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
      item.ticketPromedio,
      item.montoTotal,
      item.cancelacion,
      item.cancelacionConAnticipo,
      item.cuotasConAnticipo,
      item.cuotasSinAnticipo,
      item.parcial,
    ]);
    styleDataRow(row, { center: [2, 3, 7, 8, 9, 10, 11], moneyCols: [4, 5, 6] });
    [4, 5, 6].forEach((col) => { row.getCell(col).numFmt = '$ #,##0'; });
    stylePerformanceCells(row, item.acuerdos, maxAgreements);
  });
  ws.autoFilter = { from: "A4", to: `K${Math.max(4, operators.length + 4)}` };
  setWidths(ws, [26, 16, 12, 20, 23, 21, 15, 23, 29, 29, 12]);
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 4, showGridLines: false }];
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

function addDailySheet(workbook, summary) {
  const ws = workbook.addWorksheet("Acuerdos_por_dia");
  titleSheet(ws, "ACUERDOS POR DÍA", "Cantidad, primeros pagos y monto acordado por jornada", 4);
  ws.addRow(["FECHA", "ACUERDOS", "PRIMER PAGO", "MONTO TOTAL"]);
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
  titleSheet(ws, "GESTIONES CON ACUERDO", "Datos limpios del acuerdo y gestión original a la derecha", 22);
  ws.addRow([
    "ESTADO VENCIMIENTO", "PRIMER VENCIMIENTO", "DÍAS", "TIPO ACUERDO", "PRIMER PAGO", "MONTO TOTAL",
    "FECHA ANTICIPO", "MONTO ANTICIPO", "CUOTAS", "MONTO CUOTA", "DEUDA MÁXIMA", "DNI",
    "TELÉFONO GESTIÓN", "NOMBRE DEUDOR", "FECHA GESTIÓN", "HORA", "USUARIO", "ENTIDAD",
    "TIPO CONTACTO", "RESULTADO GESTIÓN", "ESTADO DE LA CUENTA", "OBSERVACIÓN ORIGINAL",
  ]);
  styleHeader(ws.getRow(4));

  rows.forEach((item) => {
    const row = ws.addRow([
      item.estadoVencimiento,
      excelDate(item.primerVencimiento),
      item.estadoVencimiento === "VENCIDO" ? item.diasVencido : item.diasParaVencer ?? "",
      item.tipoAcuerdo,
      money(item.primerPago),
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
    ]);
    styleDataRow(row, {
      height: 24,
      center: [1, 2, 3, 7, 9, 12, 13, 15, 16],
      moneyCols: [5, 6, 8, 10, 11],
      dateCols: [2, 7, 15],
      wrapCols: [22],
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
  });

  setWidths(ws, [19, 16, 9, 34, 17, 17, 16, 17, 10, 17, 17, 14, 20, 27, 16, 12, 20, 21, 23, 29, 27, 54]);
  ws.autoFilter = { from: "A4", to: `V${Math.max(4, rows.length + 4)}` };
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 4, showGridLines: false }];
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

function addDueSheet(workbook, rows) {
  const ws = workbook.addWorksheet("Vencidos");
  titleSheet(ws, "ACUERDOS VENCIDOS", "Control de vencimientos y gestión original", 18);
  ws.addRow([
    "PRIMER VENCIMIENTO", "ESTADO", "DÍAS VENCIDO", "PRIMER PAGO", "MONTO TOTAL", "TIPO ACUERDO",
    "OPERADOR", "ENTIDAD", "DNI", "TELÉFONO GESTIÓN", "NOMBRE", "FECHA GESTIÓN", "HORA",
    "RESULTADO", "ESTADO CUENTA", "TIPO CONTACTO", "OBSERVACIÓN ORIGINAL", "ID COBRINA",
  ]);
  styleHeader(ws.getRow(4));

  const dueRows = rows
    .filter((item) => item.estadoVencimiento === "VENCIDO")
    .sort((a, b) => (a.primerVencimiento || "9999").localeCompare(b.primerVencimiento || "9999"));

  dueRows.forEach((item) => {
    const row = ws.addRow([
      excelDate(item.primerVencimiento), item.estadoVencimiento, item.diasVencido,
      money(item.primerPago), money(item.montoTotalAcuerdo), item.tipoAcuerdo,
      item.usuario, item.entidad, Number(item.dni || 0) || item.dni, item.telefonoGestion, item.nombreDeudor,
      excelDate(item.fecha), item.hora, item.resultadoGestion, item.estadoCuenta,
      item.tipoContacto, item.observacionGestion, item.id,
    ]);
    styleDataRow(row, {
      height: 30,
      center: [1, 2, 3, 9, 10, 12, 13],
      moneyCols: [4, 5],
      dateCols: [1, 12],
      wrapCols: [17],
    });
    [1, 2, 3].forEach((col) => {
      row.getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.redSoft } };
      row.getCell(col).font = { color: { argb: COLORS.red }, bold: col === 2 };
    });
  });

  setWidths(ws, [17, 16, 13, 17, 17, 27, 20, 21, 14, 20, 27, 16, 12, 29, 27, 23, 54, 26]);
  ws.autoFilter = { from: "A4", to: `R${Math.max(4, dueRows.length + 4)}` };
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
