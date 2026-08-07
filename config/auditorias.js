export const PESOS_AUDITORIA = Object.freeze({
  presentacion: 0.1,
  negociacion: 0.4,
  cierre: 0.3,
  calidad: 0.2,
});

export const UMBRALES_AUDITORIA = Object.freeze({ bajo: 6.5, alto: 7.5 });

export const TIPOS_INTERLOCUTOR = Object.freeze([
  "TITULAR",
  "TERCERO",
  "TERCERO_PAGADOR",
  "NO_AUDITABLE",
]);

export const MOTIVOS_NO_AUDITABLE = Object.freeze([
  "Contestador / IVR",
  "No contesta",
  "Llamada cortada sin interacción",
  "Audio vacío",
  "Grabación dañada",
  "Fuera de servicio",
  "Sin conversación útil",
  "Otro",
]);

const gruposBase = [
  [1, 3, "presentacion"],
  [4, 10, "negociacion"],
  [11, 16, "cierre"],
  [17, 24, "calidad"],
];

function grupoPorId(id) {
  return gruposBase.find(([desde, hasta]) => id >= desde && id <= hasta)?.[2] || "calidad";
}

function construirCriterios(labels) {
  return labels.map((label, idx) => ({
    id: idx + 1,
    grupo: grupoPorId(idx + 1),
    label,
  }));
}

export const CRITERIOS_TITULAR = Object.freeze(
  construirCriterios([
    "Se presenta cordial y correctamente",
    "Solicita por titular o encargado de pago",
    "Expone motivo del llamado",
    "Solicita saldo actualizado",
    "Consulta motivos de atraso",
    "Negocia el saldo a abonar",
    "Argumenta ante historial de gestion",
    "Refuta argumentos frente a negativa de pago",
    "Informa consecuencias de atraso",
    "Brinda información relevante",
    "Comprometió al titular o encargado de pago",
    "Solicita teléfonos alternativos / implementa otro medio",
    "Informa saldo deudor negociado",
    "Fecha de pago o de nueva comunicación (Acuerdo/Contacto)",
    "Holdeo correcto (Promesa o fecha de nueva comunicación)",
    "Informa y/o confirma medios de pago",
    "Formalidad",
    "Transmite urgencia con seguridad y firmeza",
    "Aplica gestion MORA TARDIA",
    "Manejo de conflicto",
    "Analiza el comportamiento del titular",
    "Resolución de conflicto",
    "Observaciones correctas y completas (Mango)",
    "Cierre de gestión (Mango)",
  ])
);

export const CRITERIOS_TERCERO = Object.freeze(
  construirCriterios([
    "Se presenta cordial y correctamente",
    "Identifica correctamente al tercero",
    "Consulta vínculo con el titular",
    "Confirma que conoce al titular",
    "Ubica correctamente el legajo",
    "Informa vínculo o referencia registrada en el legajo",
    "Expone claramente la situación de la deuda",
    "Explica el motivo del contacto al tercero",
    "Informa la instancia o urgencia del caso",
    "Utiliza consecuencias para generar contacto",
    "Utiliza historial de intentos de contacto",
    "Solicita teléfono actualizado del titular",
    "Solicita otro medio de contacto del titular",
    "Consulta horario o momento para ubicar al titular",
    "Consigue compromiso de transmitir el mensaje",
    "Fija plazo para que el titular se comunique",
    "Explora posibilidad de colaboración del familiar o referencia",
    "Detecta si el tercero manifiesta intención de pago",
    "Maneja correctamente las objeciones del tercero",
    "Mantiene firmeza, tono y control de la llamada",
    "Logra un resultado útil del contacto",
    "Clasifica correctamente el contacto en Mango",
    "Observaciones correctas y completas en Mango",
    "Cierre de gestión / próxima acción en Mango",
  ])
);

export const CRITERIOS_TERCERO_PAGADOR = Object.freeze(
  construirCriterios([
    "Se presenta cordial y correctamente",
    "Identifica correctamente al tercero pagador",
    "Confirma vínculo con el titular",
    "Confirma voluntad de intervenir en el pago",
    "Ubica correctamente el legajo",
    "Expone entidad, origen y situación de la deuda",
    "Informa saldo y condiciones de negociación",
    "Presenta opciones en orden de mejor recupero",
    "Consulta capacidad real de pago",
    "Negocia correctamente monto inicial o anticipo",
    "Escala una propuesta inicial baja",
    "Explora alternativas para aumentar el pago",
    "Trabaja correctamente cancelación versus financiación",
    "Maneja correctamente objeciones económicas",
    "Utiliza consecuencias y urgencia para conseguir definición",
    "Analiza si el acuerdo es sostenible",
    "Define monto exacto del compromiso",
    "Define fecha exacta de pago",
    "Confirma quién realizará efectivamente el pago",
    "Informa y confirma medios de pago",
    "Confirma envío de comprobante y canal de continuidad",
    "Realiza holdeo correcto del acuerdo",
    "Registra correctamente la negociación en Mango",
    "Cierre de gestión / próxima acción en Mango",
  ])
);

export const FORMULARIOS_AUDITORIA = Object.freeze({
  TITULAR: {
    key: "TITULAR",
    label: "Titular",
    criterios: CRITERIOS_TITULAR,
  },
  TERCERO: {
    key: "TERCERO",
    label: "Tercero / Familiar / Referencia",
    criterios: CRITERIOS_TERCERO,
  },
  TERCERO_PAGADOR: {
    key: "TERCERO_PAGADOR",
    label: "Tercero pagador",
    criterios: CRITERIOS_TERCERO_PAGADOR,
  },
});

export function normalizarTipoInterlocutor(value, fallback = "TITULAR") {
  const raw = String(value || "").trim().toUpperCase().replaceAll(" ", "_");
  if (TIPOS_INTERLOCUTOR.includes(raw)) return raw;
  if (["TERCERO/FAMILIAR/REFERENCIA", "TERCERO_FAMILIAR_REFERENCIA"].includes(raw)) return "TERCERO";
  return fallback;
}

export function formularioAplicadoParaTipo(tipo) {
  const t = normalizarTipoInterlocutor(tipo);
  return t === "NO_AUDITABLE" ? "NINGUNO" : t;
}

export function criteriosParaFormulario(formulario = "TITULAR") {
  const key = String(formulario || "TITULAR").trim().toUpperCase();
  return FORMULARIOS_AUDITORIA[key]?.criterios || CRITERIOS_TITULAR;
}

export function criterioPorId(formulario, id) {
  return criteriosParaFormulario(formulario).find((c) => c.id === Number(id)) || null;
}

export function valorResultadoCriterio(value) {
  if (value === true || value === 1) return "SI";
  if (value === 0.5) return "PARCIAL";
  if (value === false || value === 0) return "NO";

  const v = String(value ?? "").trim().toLowerCase();
  if (["si", "sí", "ok", "cumple", "completo", "true", "1"].includes(v)) return "SI";
  if (["parcial", "medio", "mitad", "0.5", "0,5"].includes(v)) return "PARCIAL";
  if (["no aplica", "no_aplica", "no-aplica", "na", "n/a", "noaplica"].includes(v)) return "NO_APLICA";
  return "NO";
}

function uniqNums(arr = []) {
  return [...new Set((arr || []).map(Number).filter(Number.isFinite))];
}

function mapToObject(raw) {
  if (raw instanceof Map) return Object.fromEntries(raw);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  return null;
}

export function normalizarResultadosItem(item = {}, formulario = "TITULAR") {
  const criterios = criteriosParaFormulario(formulario);
  const ids = criterios.map((c) => c.id);
  const validos = new Set(ids);
  const resultados = {};

  const resultadosRaw = mapToObject(item.resultadosCriterios);
  const checksRaw = mapToObject(item.checks);

  if (resultadosRaw || checksRaw) {
    const source = resultadosRaw || checksRaw;
    for (const id of ids) {
      resultados[String(id)] = valorResultadoCriterio(source[String(id)] ?? source[id]);
    }
  } else if (
    Array.isArray(item.fallosIds) ||
    Array.isArray(item.parcialesIds) ||
    Array.isArray(item.criteriosNoAplica)
  ) {
    const fallos = new Set(uniqNums(item.fallosIds || []).filter((id) => validos.has(id)));
    const parciales = new Set(uniqNums(item.parcialesIds || []).filter((id) => validos.has(id)));
    const noAplica = new Set(uniqNums(item.criteriosNoAplica || []).filter((id) => validos.has(id)));
    for (const id of ids) {
      resultados[String(id)] = noAplica.has(id)
        ? "NO_APLICA"
        : parciales.has(id)
          ? "PARCIAL"
          : fallos.has(id)
            ? "NO"
            : "SI";
    }
  } else if (Array.isArray(item.okIds)) {
    const ok = new Set(uniqNums(item.okIds).filter((id) => validos.has(id)));
    for (const id of ids) resultados[String(id)] = ok.has(id) ? "SI" : "NO";
  } else {
    for (const id of ids) resultados[String(id)] = "NO";
  }

  const fallosIds = [];
  const parcialesIds = [];
  const criteriosNoAplica = [];
  for (const id of ids) {
    const estado = resultados[String(id)];
    if (estado === "NO") fallosIds.push(id);
    else if (estado === "PARCIAL") parcialesIds.push(id);
    else if (estado === "NO_APLICA") criteriosNoAplica.push(id);
  }

  return { resultadosCriterios: resultados, fallosIds, parcialesIds, criteriosNoAplica };
}

export function calcularScoresAuditoriaItem(resultadosInput = {}, formulario = "TITULAR") {
  const criterios = criteriosParaFormulario(formulario);
  const resultados = mapToObject(resultadosInput) || {};
  const grupos = ["presentacion", "negociacion", "cierre", "calidad"];
  const cantidadPorGrupo = Object.fromEntries(
    grupos.map((grupo) => [grupo, criterios.filter((c) => c.grupo === grupo).length])
  );

  let numerador = 0;
  let denominador = 0;
  const bloqueNumerador = Object.fromEntries(grupos.map((g) => [g, 0]));
  const bloqueDenominador = Object.fromEntries(grupos.map((g) => [g, 0]));

  for (const criterio of criterios) {
    const estado = valorResultadoCriterio(resultados[String(criterio.id)] ?? resultados[criterio.id]);
    if (estado === "NO_APLICA") continue;

    const cantidad = cantidadPorGrupo[criterio.grupo] || 1;
    const pesoCriterio = (PESOS_AUDITORIA[criterio.grupo] || 0) / cantidad;
    const valor = estado === "SI" ? 1 : estado === "PARCIAL" ? 0.5 : 0;

    numerador += pesoCriterio * valor;
    denominador += pesoCriterio;
    bloqueNumerador[criterio.grupo] += valor;
    bloqueDenominador[criterio.grupo] += 1;
  }

  const scoreBloques = {};
  for (const grupo of grupos) {
    scoreBloques[grupo] = bloqueDenominador[grupo]
      ? Number(((bloqueNumerador[grupo] / bloqueDenominador[grupo]) * 10).toFixed(6))
      : null;
  }

  const scoreAudio = denominador > 0
    ? Number(((numerador / denominador) * 10).toFixed(6))
    : null;

  return { scoreBloques, scoreAudio, pesoAplicable: denominador };
}

export function semaforoAuditoria(scoreFinal) {
  if (scoreFinal == null || scoreFinal === "") return null;
  const score = Number(scoreFinal);
  if (!Number.isFinite(score)) return null;
  if (score < UMBRALES_AUDITORIA.bajo) return "bajo";
  if (score >= UMBRALES_AUDITORIA.alto) return "alto";
  return "medio";
}
