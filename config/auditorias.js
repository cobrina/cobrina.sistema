export const PESOS_AUDITORIA = Object.freeze({
  presentacion: 0.1,
  negociacion: 0.4,
  cierre: 0.3,
  calidad: 0.2,
});

export const UMBRALES_AUDITORIA = Object.freeze({ bajo: 6.5, alto: 7.5 });

export const TIPOS_INTERLOCUTOR_VIGENTES = Object.freeze([
  "TITULAR",
  "FAMILIAR_DIRECTO",
  "REFERENCIA",
  "TERCERO_PAGADOR",
  "NO_AUDITABLE",
]);

// Se conserva TERCERO sólo para poder reconstruir auditorías históricas.
export const TIPOS_INTERLOCUTOR = Object.freeze([
  ...TIPOS_INTERLOCUTOR_VIGENTES,
  "TERCERO",
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

export const QUIEN_CONDUJO_OPCIONES = Object.freeze([
  "OPERADOR",
  "COMPARTIDA",
  "INTERLOCUTOR",
]);

export const RESULTADO_COMERCIAL_OPCIONES = Object.freeze([
  "PAGO_REALIZADO",
  "ACUERDO_CERRADO",
  "PROMESA_FIRME",
  "CONTRAOFERTA_CONCRETA",
  "PENDIENTE_DOCUMENTACION",
  "PROXIMA_ACCION_CONCRETA",
  "CONTACTO_UTIL_SIN_COMPROMISO",
  "SIN_DEFINICION",
  "NO_APLICA",
]);

const BLOQUES = Object.freeze([
  { key: "presentacion", label: "Presentación", peso: 0.1 },
  { key: "negociacion", label: "Negociación", peso: 0.4 },
  { key: "cierre", label: "Cierre", peso: 0.3 },
  { key: "calidad", label: "Calidad de Gestión", peso: 0.2 },
]);

function ayuda({ descripcion = "", si = "", parcial = "", no = "", noAplica = "", ejemplos = [] } = {}) {
  return { descripcion, si, parcial, no, noAplica, ejemplos };
}

function criterio(grupo, label, ayudaCriterio = {}) {
  return { grupo, label, ayuda: ayuda(ayudaCriterio) };
}

function numerar(lista = []) {
  return lista.map((c, index) => ({
    id: index + 1,
    orden: index + 1,
    grupo: c.grupo,
    label: c.label,
    ayuda: c.ayuda || ayuda(),
  }));
}

const AYUDA_PRESENTACION = ayuda({
  descripcion: "Evalúa si el operador se identifica de forma suficiente al inicio. Cordialidad y presentación no son lo mismo.",
  si: "Saludo + nombre o identificación personal + estudio/empresa, según corresponda.",
  parcial: "La presentación existe pero es incompleta, tardía o recién aclara desde dónde llama cuando el interlocutor pregunta.",
  no: "Sólo dice hola/buen día/estudio, pide DNI directamente o inicia la gestión sin identificarse.",
  noAplica: "Sólo cuando por el tipo de interacción no existe una apertura identificable que pueda evaluarse.",
  ejemplos: ["Buen día, habla Ana de Estudio RDC...", "No alcanza con ser cordial si no se identifica."],
});

const AYUDA_CAPACIDAD = ayuda({
  descripcion: "Busca capacidad económica concreta, no sólo informar pautas o planes.",
  si: "Pregunta cuánto tiene disponible, cuánto puede reunir, máximo real, cuándo cobra/próximo ingreso o posibilidad de anticipo.",
  parcial: "Hace alguna pregunta económica pero no profundiza hasta obtener un dato útil para negociar.",
  no: "Se limita a informar opciones o acepta un 'no puedo' sin indagar capacidad.",
  noAplica: "Cuando el contacto no habilita razonablemente una negociación económica.",
  ejemplos: ["¿Cuánto puede disponer hoy?", "¿Cuál es el máximo que puede reunir y para qué fecha?"],
});

const AYUDA_NEGOCIACION = ayuda({
  descripcion: "Evalúa si el operador negocia activamente y busca mejorar la recuperación, no si sólo enumera planes.",
  si: "Parte de una condición conveniente, obtiene información económica y escala/contraoferta con lógica.",
  parcial: "Hay intento de negociación pero se acepta demasiado rápido una propuesta o falta escalamiento.",
  no: "Sólo informa pautas o toma la propuesta del interlocutor sin trabajarla.",
  noAplica: "Cuando no existe oportunidad real de negociar en ese contacto.",
  ejemplos: ["Antes de bajar la condición, intenta mejorar monto o anticipo."],
});

const AYUDA_OBJECIONES = ayuda({
  descripcion: "Evalúa escucha, respuesta útil y manejo de la objeción sin confrontación innecesaria.",
  si: "Identifica la objeción, responde con información/argumento pertinente y evita entrar en una discusión improductiva.",
  parcial: "Responde pero de forma incompleta, extensa o poco estratégica.",
  no: "Ignora la objeción, confronta, discute o se limita a repetir la misma información.",
  noAplica: "Cuando no hubo objeción o reclamo relevante.",
  ejemplos: [],
});

const AYUDA_VUELTA_NEGOCIACION = ayuda({
  descripcion: "Después de responder una objeción, la conversación debe volver a dinero, definición o próxima acción concreta.",
  si: "Escucha lo necesario, responde y vuelve a una pregunta económica o de definición.",
  parcial: "Responde correctamente pero tarda demasiado en recuperar el eje.",
  no: "La llamada queda atrapada en reclamo, historia personal, discusión o explicación y nunca vuelve al objetivo económico.",
  noAplica: "Cuando no existió una objeción/reclamo que obligara a recuperar el eje.",
  ejemplos: ["Entiendo el reclamo. Ahora, respecto de la condición vigente, ¿cuánto puede disponer hoy?"],
});

const AYUDA_CONDUCCION = ayuda({
  descripcion: "Pregunta central: ¿el operador manejó la llamada o la llamada lo manejó a él? Escuchar sin interrumpir no alcanza.",
  si: "Marca el orden, pregunta, direcciona, responde objeciones y vuelve al objetivo económico hasta llevar la conversación al cierre.",
  parcial: "La conducción es compartida: recupera el eje por momentos, pero el interlocutor determina gran parte del recorrido.",
  no: "El interlocutor pregunta todo, instala temas, propone montos, cambia de tema y decide el cierre mientras el operador principalmente responde.",
  noAplica: "Sólo cuando la interacción es tan breve o incompleta que no permite evaluar conducción.",
  ejemplos: ["No confundir responder correctamente con conducir correctamente."],
});

const AYUDA_SOSTENIBILIDAD = ayuda({
  descripcion: "Evalúa si el acuerdo/propuesta tiene posibilidades reales de cumplimiento según lo dicho en la llamada.",
  si: "Contrasta monto, fecha, ingreso/capacidad y evita cerrar una pauta evidentemente inviable.",
  parcial: "Valida una parte de la capacidad, pero quedan dudas relevantes sobre posibilidad de cumplimiento.",
  no: "Cierra un compromiso sin indagar si puede sostenerse o acepta una promesa claramente inconsistente.",
  noAplica: "Cuando no hubo propuesta, promesa o acuerdo que evaluar.",
  ejemplos: [],
});

const AYUDA_COMPROMISO = ayuda({
  descripcion: "El cierre debe terminar en una definición concreta, no sólo en 'lo voy a ver'.",
  si: "Obtiene pago, acuerdo, promesa firme, contraoferta concreta o próxima acción concreta.",
  parcial: "Hay avance, pero la definición queda incompleta o poco exigible.",
  no: "Finaliza sin definición ni próxima acción concreta.",
  noAplica: "Cuando por el tipo de contacto no corresponde buscar definición económica.",
  ejemplos: [],
});

const AYUDA_URGENCIA = ayuda({
  descripcion: "Evalúa si utiliza historial, urgencia y consecuencias reales/coherentes con el estado del legajo para conseguir definición.",
  si: "Usa sólo consecuencias aplicables al caso (cambio de instancia, pérdida de condición, actualización, derivación, acción legal, etc.).",
  parcial: "La urgencia es genérica o poco conectada con el legajo, pero no es falsa.",
  no: "No usa herramientas de urgencia cuando eran necesarias o afirma consecuencias no sustentadas.",
  noAplica: "Cuando no corresponde aplicar urgencia/consecuencias en ese contacto.",
  ejemplos: ["No se exige mencionar embargo; sólo corresponde cuando sea real y pertinente."],
});

const AYUDA_CONFLICTO = ayuda({
  descripcion: "Evalúa manejo profesional de reclamo/conflicto sin perder el objetivo de gestión.",
  si: "Escucha, ordena, responde con criterio, evita escalar el conflicto y retoma la gestión cuando corresponde.",
  parcial: "Resuelve parcialmente o demora demasiado en ordenar la conversación.",
  no: "Confronta, pierde formalidad, deja crecer el conflicto o abandona el objetivo sin necesidad.",
  noAplica: "Cuando no hubo conflicto/reclamo.",
  ejemplos: [],
});

const AYUDA_CIERRE_MANGO = ayuda({
  descripcion: "Evalúa que Mango refleje fielmente el resultado y la próxima acción acordada.",
  si: "Clasificación, observación y próxima acción coinciden con lo ocurrido y dejan trazabilidad útil.",
  parcial: "La carga existe pero falta un dato relevante o la próxima acción no queda del todo clara.",
  no: "La carga es incorrecta, incompleta o contradice lo sucedido.",
  noAplica: "Sólo cuando no corresponde registrar esa gestión en Mango.",
  ejemplos: [],
});

function simpleHelp(descripcion, noAplica = "Cuando el criterio no corresponde por la situación concreta de la llamada.") {
  return ayuda({
    descripcion,
    si: "Se cumple de forma completa y oportuna.",
    parcial: "Se cumple de forma incompleta, tardía o con oportunidad clara de mejora.",
    no: "No se realiza, se realiza incorrectamente o no logra el objetivo del criterio.",
    noAplica,
  });
}

/* =========================
   FORMULARIOS VIGENTES
   ========================= */
export const CRITERIOS_TITULAR = Object.freeze(numerar([
  criterio("presentacion", "Se presenta completa, cordial y correctamente", AYUDA_PRESENTACION),
  criterio("presentacion", "Identifica y valida correctamente al titular o encargado de pago", simpleHelp("Confirma que está gestionando con la persona correcta antes de avanzar con información sensible o negociación.")),
  criterio("presentacion", "Expone y encuadra claramente el motivo del llamado", simpleHelp("Presenta el motivo de forma clara y ordena el inicio de la gestión.")),

  criterio("negociacion", "Informa correctamente entidad/origen y saldo actualizado", simpleHelp("Brinda información correcta de entidad/origen y saldo vigente, sin confusiones.")),
  criterio("negociacion", "Consulta motivo de atraso y obtiene información útil para negociar", simpleHelp("No pregunta por rutina: usa la respuesta para entender el escenario y orientar la negociación.")),
  criterio("negociacion", "Presenta una condición inicial en orden de mejor recupero", simpleHelp("Inicia por la alternativa de mejor recupero compatible con el caso y escala sólo cuando corresponde.")),
  criterio("negociacion", "Consulta capacidad real de pago", AYUDA_CAPACIDAD),
  criterio("negociacion", "Negocia y escala correctamente la propuesta o anticipo", AYUDA_NEGOCIACION),
  criterio("negociacion", "Maneja correctamente las objeciones", AYUDA_OBJECIONES),
  criterio("negociacion", "Responde la objeción y vuelve a negociación", AYUDA_VUELTA_NEGOCIACION),
  criterio("negociacion", "Conduce y mantiene el control de la llamada", AYUDA_CONDUCCION),

  criterio("cierre", "Utiliza historial, urgencia y/o consecuencias reales para buscar una definición", AYUDA_URGENCIA),
  criterio("cierre", "Analiza si la propuesta o acuerdo es sostenible", AYUDA_SOSTENIBILIDAD),
  criterio("cierre", "Consigue una definición concreta", AYUDA_COMPROMISO),
  criterio("cierre", "Define monto exacto del compromiso", simpleHelp("Cuando existe compromiso económico, deja monto exacto y no expresiones ambiguas.", "Cuando no hubo compromiso económico ni correspondía definir un monto.")),
  criterio("cierre", "Define fecha exacta de pago o nueva comunicación", simpleHelp("Deja una fecha concreta para pago o seguimiento, evitando cierres abiertos.", "Cuando el resultado no requiere fecha de pago ni nueva comunicación.")),
  criterio("cierre", "Informa/confirma medios de pago, comprobante y canal de continuidad cuando corresponde", simpleHelp("Cierra la operatoria indicando cómo pagar, cómo enviar comprobante y por qué canal continuar cuando aplica.", "Cuando no hubo compromiso o no corresponde informar medios/canal.")),

  criterio("calidad", "Mantiene formalidad, claridad y buen trato", simpleHelp("Integra tono, claridad, respeto y manejo de silencios/holdeos sin convertirlos en un criterio aislado.")),
  criterio("calidad", "Transmite seguridad y firmeza sin confrontación innecesaria", simpleHelp("Sostiene una postura segura y firme, sin agresividad ni confrontación improductiva.")),
  criterio("calidad", "Adapta la estrategia al estadio de mora", simpleHelp("La gestión y el nivel de urgencia/negociación son coherentes con la instancia real del legajo.")),
  criterio("calidad", "Maneja correctamente situaciones de conflicto/reclamo", AYUDA_CONFLICTO),
  criterio("calidad", "Analiza el comportamiento del titular y adapta la estrategia", simpleHelp("Lee señales del interlocutor y ajusta preguntas, argumentos y cierre sin repetir un guion rígido.")),
  criterio("calidad", "Registra observaciones correctas y completas en Mango", simpleHelp("La observación deja trazabilidad suficiente, clara y fiel a lo ocurrido.")),
  criterio("calidad", "Realiza correctamente el cierre de gestión / próxima acción en Mango", AYUDA_CIERRE_MANGO),
]));

export const CRITERIOS_FAMILIAR_DIRECTO = Object.freeze(numerar([
  criterio("presentacion", "Se presenta completa, cordial y correctamente", AYUDA_PRESENTACION),
  criterio("presentacion", "Identifica correctamente al familiar directo", simpleHelp("Identifica a la persona y evita tratarla automáticamente como una simple referencia.")),
  criterio("presentacion", "Confirma vínculo con el titular y ubica correctamente el legajo", simpleHelp("Confirma vínculo directo y ubica el caso correcto antes de avanzar.")),

  criterio("negociacion", "Expone claramente entidad, situación y deuda vigente", simpleHelp("Explica el contexto de forma suficiente y ordenada para que el familiar comprenda la situación.")),
  criterio("negociacion", "Detecta cuánto conoce el familiar sobre la situación del titular", simpleHelp("Explora si conoce la deuda/problema y cuán involucrado está, para definir la estrategia.")),
  criterio("negociacion", "Explora activamente la posibilidad de colaboración económica del familiar", AYUDA_CAPACIDAD),
  criterio("negociacion", "Consulta capacidad, monto disponible y posible fecha", AYUDA_CAPACIDAD),
  criterio("negociacion", "Presenta condiciones en orden de mejor recupero", AYUDA_NEGOCIACION),
  criterio("negociacion", "Negocia aporte, anticipo o propuesta del familiar", AYUDA_NEGOCIACION),
  criterio("negociacion", "Maneja objeciones/reclamos y vuelve a negociación", AYUDA_VUELTA_NEGOCIACION),
  criterio("negociacion", "Conduce y mantiene el control de la llamada", AYUDA_CONDUCCION),

  criterio("cierre", "Utiliza historial, urgencia y consecuencias reales para buscar definición", AYUDA_URGENCIA),
  criterio("cierre", "Busca una acción concreta del familiar", ayuda({
    descripcion: "El familiar directo es una oportunidad de cobro: se busca pagar, ayudar, reunir dinero, hablar con el titular o acercar una propuesta.",
    si: "Obtiene una acción concreta y verificable.", parcial: "Hay intención pero la acción queda poco definida.", no: "Queda sólo como mensajero sin explorar una acción útil.", noAplica: "Cuando el familiar no tiene posibilidad razonable de intervenir." })),
  criterio("cierre", "Define monto concreto cuando existe posibilidad económica", simpleHelp("Si aparece capacidad económica, transforma la intención en un monto concreto.", "Cuando no existe posibilidad económica real.")),
  criterio("cierre", "Define fecha/hora concreta de pago o seguimiento", simpleHelp("Fija momento concreto para pago, respuesta o seguimiento.", "Cuando no existe acción que requiera fecha/hora.")),
  criterio("cierre", "Obtiene teléfono/WhatsApp/medio actualizado del titular o familiar como herramienta complementaria", simpleHelp("Actualiza medios útiles sin usar la localización como sustituto automático de la oportunidad de cobro.")),
  criterio("cierre", "Detecta si el familiar se transforma en tercero pagador y permite reclasificar la auditoría", simpleHelp("Si expresa 'yo pago/me hago cargo', reconoce el cambio de rol y corresponde reclasificar a Tercero pagador.", "Cuando no manifiesta voluntad de pagar.")),

  criterio("calidad", "Mantiene formalidad y buen trato", simpleHelp("Sostiene claridad, respeto y profesionalismo.")),
  criterio("calidad", "Transmite firmeza y seguridad", simpleHelp("Conduce con seguridad sin confrontación innecesaria.")),
  criterio("calidad", "Escucha sin perder el eje de cobranza", AYUDA_CONDUCCION),
  criterio("calidad", "Maneja correctamente conflicto/reclamos", AYUDA_CONFLICTO),
  criterio("calidad", "Logra un resultado útil del contacto", simpleHelp("El contacto deja pago/propuesta/acción/localización concreta o información útil para avanzar.")),
  criterio("calidad", "Clasifica y registra correctamente el contacto/observaciones en Mango", simpleHelp("Clasificación y observación reflejan vínculo, resultado y datos relevantes.")),
  criterio("calidad", "Realiza correctamente el cierre de gestión / próxima acción en Mango", AYUDA_CIERRE_MANGO),
]));

export const CRITERIOS_REFERENCIA = Object.freeze(numerar([
  criterio("presentacion", "Se presenta completa, cordial y correctamente", AYUDA_PRESENTACION),
  criterio("presentacion", "Identifica correctamente al tercero", simpleHelp("Identifica con quién habla antes de pedir información o dejar mensaje.")),
  criterio("presentacion", "Consulta vínculo con el titular y confirma si lo conoce", simpleHelp("Determina el vínculo real para saber si es referencia, familiar directo u otro contacto.")),

  criterio("negociacion", "Ubica correctamente el legajo", simpleHelp("Verifica que el contacto corresponda al titular/legajo correcto.")),
  criterio("negociacion", "Explica adecuadamente el motivo del contacto", simpleHelp("Explica el contacto sin exigir a una referencia una negociación que no le corresponde.")),
  criterio("negociacion", "Solicita teléfono actualizado del titular", simpleHelp("Busca un teléfono útil y actual cuando corresponde.")),
  criterio("negociacion", "Solicita otro medio de contacto del titular", simpleHelp("Explora WhatsApp u otro canal útil cuando puede aportar localización.")),
  criterio("negociacion", "Consulta horario o momento para localizar al titular", simpleHelp("Obtiene una ventana concreta para contacto.")),
  criterio("negociacion", "Utiliza historial de intentos para mejorar la localización", simpleHelp("Aprovecha información previa para no repetir intentos improductivos.")),
  criterio("negociacion", "Maneja objeciones del tercero y mantiene el objetivo de localización", AYUDA_OBJECIONES),
  criterio("negociacion", "Conduce y mantiene el control de la llamada", AYUDA_CONDUCCION),

  criterio("cierre", "Transmite mensaje/urgencia coherente con el caso", AYUDA_URGENCIA),
  criterio("cierre", "Consigue compromiso de transmitir el mensaje", simpleHelp("Busca confirmación concreta de que el mensaje será transmitido.")),
  criterio("cierre", "Fija plazo o momento para que el titular se comunique", simpleHelp("Evita dejar el contacto abierto sin horizonte temporal.")),
  criterio("cierre", "Genera una vía concreta de contacto con el titular", simpleHelp("El resultado aporta teléfono, horario, mensaje comprometido u otra vía útil.")),
  criterio("cierre", "Detecta si en realidad es familiar directo y permite reclasificar", simpleHelp("Si es esposo/a, pareja, padre/madre, hijo/a u otro familiar directo involucrado, corresponde pasar a Familiar directo / pareja.", "Cuando claramente no es familiar directo.")),
  criterio("cierre", "Detecta si manifiesta intención de pagar y permite reclasificar a tercero pagador", simpleHelp("Si expresa voluntad real de pagar, corresponde pasar a Tercero pagador.", "Cuando no manifiesta intención de pagar.")),

  criterio("calidad", "Mantiene formalidad, claridad y buen trato", simpleHelp("Sostiene trato profesional durante la localización.")),
  criterio("calidad", "Maneja correctamente objeciones o conflicto", AYUDA_CONFLICTO),
  criterio("calidad", "Logra un resultado útil del contacto", simpleHelp("Obtiene información, mensaje, horario o vía concreta que mejora la posibilidad de contacto.")),
  criterio("calidad", "Clasifica correctamente el contacto en Mango", simpleHelp("La clasificación refleja que se trató de una referencia/tercero no directo.")),
  criterio("calidad", "Registra observaciones correctas y completas en Mango", simpleHelp("Deja datos suficientes sobre vínculo, información obtenida y resultado.")),
  criterio("calidad", "Define correctamente la próxima acción", simpleHelp("Deja trazado qué se hará después y cuándo.")),
  criterio("calidad", "Realiza correctamente el cierre de gestión en Mango", AYUDA_CIERRE_MANGO),
]));

export const CRITERIOS_TERCERO_PAGADOR = Object.freeze(numerar([
  criterio("presentacion", "Se presenta completa, cordial y correctamente", AYUDA_PRESENTACION),
  criterio("presentacion", "Identifica correctamente al tercero pagador y confirma vínculo con el titular", simpleHelp("Identifica a quien efectivamente interviene en el pago y su vínculo con el titular.")),
  criterio("presentacion", "Confirma voluntad de intervenir en el pago y ubica correctamente el legajo", simpleHelp("Valida voluntad real de pagar antes de orientar la negociación.")),

  criterio("negociacion", "Expone entidad, origen, situación y saldo vigente", simpleHelp("Brinda la información necesaria para negociar sin contradicciones.")),
  criterio("negociacion", "Presenta una condición inicial en orden de mejor recupero", AYUDA_NEGOCIACION),
  criterio("negociacion", "Consulta capacidad real de pago", AYUDA_CAPACIDAD),
  criterio("negociacion", "Negocia correctamente monto inicial o anticipo", AYUDA_NEGOCIACION),
  criterio("negociacion", "Escala una propuesta inicial baja y explora alternativas para aumentarla", AYUDA_NEGOCIACION),
  criterio("negociacion", "Trabaja correctamente cancelación versus financiación", simpleHelp("Compara alternativas con criterio de recuperación y capacidad, sin presentar planes como un menú sin estrategia.")),
  criterio("negociacion", "Maneja correctamente objeciones económicas", AYUDA_OBJECIONES),
  criterio("negociacion", "Responde la objeción y vuelve a negociación", AYUDA_VUELTA_NEGOCIACION),
  criterio("negociacion", "Conduce y mantiene el control de la llamada", AYUDA_CONDUCCION),

  criterio("cierre", "Utiliza historial, urgencia y consecuencias reales para conseguir definición", AYUDA_URGENCIA),
  criterio("cierre", "Analiza si el acuerdo o propuesta es sostenible", AYUDA_SOSTENIBILIDAD),
  criterio("cierre", "Define monto exacto del compromiso", simpleHelp("Deja un monto preciso cuando existe compromiso económico.", "Cuando no hubo compromiso económico.")),
  criterio("cierre", "Define fecha exacta de pago", simpleHelp("Deja fecha exacta y verificable.", "Cuando no hubo compromiso de pago.")),
  criterio("cierre", "Confirma quién realizará efectivamente el pago", simpleHelp("Aclara responsable efectivo del pago para evitar compromisos ambiguos.")),
  criterio("cierre", "Informa/confirma medios de pago, comprobante y canal de continuidad", simpleHelp("Cierra la operatoria con instrucciones y canal claro cuando corresponde.", "Cuando no hubo compromiso que requiera esta información.")),

  criterio("calidad", "Mantiene formalidad, claridad y buen trato", simpleHelp("Integra tono, claridad, respeto y manejo de pausas/holdeos.")),
  criterio("calidad", "Transmite seguridad y firmeza sin confrontación innecesaria", simpleHelp("Sostiene la negociación con seguridad y respeto.")),
  criterio("calidad", "Maneja correctamente conflicto/reclamos", AYUDA_CONFLICTO),
  criterio("calidad", "Adapta la estrategia a la capacidad y comportamiento del tercero pagador", simpleHelp("Ajusta preguntas, propuesta y cierre según señales reales de capacidad y predisposición.")),
  criterio("calidad", "Registra correctamente la negociación y observaciones en Mango", simpleHelp("Mango refleja monto, fecha, pagador, condición y contexto relevante.")),
  criterio("calidad", "Realiza correctamente el cierre de gestión / próxima acción en Mango", AYUDA_CIERRE_MANGO),
]));

/* =========================
   FORMULARIOS HISTÓRICOS V1
   No se ofrecen para nuevas auditorías.
   ========================= */
function legacyConstruir(labels) {
  const gruposBase = [[1, 3, "presentacion"], [4, 10, "negociacion"], [11, 16, "cierre"], [17, 24, "calidad"]];
  const grupoPorId = (id) => gruposBase.find(([d, h]) => id >= d && id <= h)?.[2] || "calidad";
  return labels.map((label, idx) => ({ id: idx + 1, orden: idx + 1, grupo: grupoPorId(idx + 1), label, ayuda: ayuda() }));
}

export const CRITERIOS_TITULAR_V1 = Object.freeze(legacyConstruir([
  "Se presenta cordial y correctamente", "Solicita por titular o encargado de pago", "Expone motivo del llamado",
  "Solicita saldo actualizado", "Consulta motivos de atraso", "Negocia el saldo a abonar", "Argumenta ante historial de gestion",
  "Refuta argumentos frente a negativa de pago", "Informa consecuencias de atraso", "Brinda información relevante",
  "Comprometió al titular o encargado de pago", "Solicita teléfonos alternativos / implementa otro medio", "Informa saldo deudor negociado",
  "Fecha de pago o de nueva comunicación (Acuerdo/Contacto)", "Holdeo correcto (Promesa o fecha de nueva comunicación)", "Informa y/o confirma medios de pago",
  "Formalidad", "Transmite urgencia con seguridad y firmeza", "Aplica gestion MORA TARDIA", "Manejo de conflicto",
  "Analiza el comportamiento del titular", "Resolución de conflicto", "Observaciones correctas y completas (Mango)", "Cierre de gestión (Mango)",
]));

export const CRITERIOS_TERCERO_V1 = Object.freeze(legacyConstruir([
  "Se presenta cordial y correctamente", "Identifica correctamente al tercero", "Consulta vínculo con el titular", "Confirma que conoce al titular",
  "Ubica correctamente el legajo", "Informa vínculo o referencia registrada en el legajo", "Expone claramente la situación de la deuda",
  "Explica el motivo del contacto al tercero", "Informa la instancia o urgencia del caso", "Utiliza consecuencias para generar contacto",
  "Utiliza historial de intentos de contacto", "Solicita teléfono actualizado del titular", "Solicita otro medio de contacto del titular",
  "Consulta horario o momento para ubicar al titular", "Consigue compromiso de transmitir el mensaje", "Fija plazo para que el titular se comunique",
  "Explora posibilidad de colaboración del familiar o referencia", "Detecta si el tercero manifiesta intención de pago", "Maneja correctamente las objeciones del tercero",
  "Mantiene firmeza, tono y control de la llamada", "Logra un resultado útil del contacto", "Clasifica correctamente el contacto en Mango",
  "Observaciones correctas y completas en Mango", "Cierre de gestión / próxima acción en Mango",
]));

export const CRITERIOS_TERCERO_PAGADOR_V1 = Object.freeze(legacyConstruir([
  "Se presenta cordial y correctamente", "Identifica correctamente al tercero pagador", "Confirma vínculo con el titular", "Confirma voluntad de intervenir en el pago",
  "Ubica correctamente el legajo", "Expone entidad, origen y situación de la deuda", "Informa saldo y condiciones de negociación", "Presenta opciones en orden de mejor recupero",
  "Consulta capacidad real de pago", "Negocia correctamente monto inicial o anticipo", "Escala una propuesta inicial baja", "Explora alternativas para aumentar el pago",
  "Trabaja correctamente cancelación versus financiación", "Maneja correctamente objeciones económicas", "Utiliza consecuencias y urgencia para conseguir definición",
  "Analiza si el acuerdo es sostenible", "Define monto exacto del compromiso", "Define fecha exacta de pago", "Confirma quién realizará efectivamente el pago",
  "Informa y confirma medios de pago", "Confirma envío de comprobante y canal de continuidad", "Realiza holdeo correcto del acuerdo",
  "Registra correctamente la negociación en Mango", "Cierre de gestión / próxima acción en Mango",
]));

export const FORMULARIOS_AUDITORIA = Object.freeze({
  TITULAR: { key: "TITULAR", label: "Titular", version: 2, criterios: CRITERIOS_TITULAR },
  FAMILIAR_DIRECTO: { key: "FAMILIAR_DIRECTO", label: "Familiar directo / Pareja", version: 1, criterios: CRITERIOS_FAMILIAR_DIRECTO },
  REFERENCIA: { key: "REFERENCIA", label: "Referencia / Tercero no directo", version: 1, criterios: CRITERIOS_REFERENCIA },
  TERCERO_PAGADOR: { key: "TERCERO_PAGADOR", label: "Tercero pagador", version: 2, criterios: CRITERIOS_TERCERO_PAGADOR },
});

export const FORMULARIOS_LEGACY = Object.freeze({
  TITULAR: { key: "TITULAR", label: "Titular", version: 1, criterios: CRITERIOS_TITULAR_V1 },
  TERCERO: { key: "TERCERO", label: "Tercero / Familiar / Referencia", version: 1, criterios: CRITERIOS_TERCERO_V1 },
  TERCERO_PAGADOR: { key: "TERCERO_PAGADOR", label: "Tercero pagador", version: 1, criterios: CRITERIOS_TERCERO_PAGADOR_V1 },
});

export function normalizarTipoInterlocutor(value, fallback = "TITULAR") {
  const raw = String(value || "").trim().toUpperCase().replaceAll(" ", "_");
  if (TIPOS_INTERLOCUTOR.includes(raw)) return raw;
  if (["TERCERO/FAMILIAR/REFERENCIA", "TERCERO_FAMILIAR_REFERENCIA"].includes(raw)) return "TERCERO";
  if (["FAMILIAR", "FAMILIAR_DIRECTO/PAREJA", "FAMILIAR_DIRECTO_PAREJA"].includes(raw)) return "FAMILIAR_DIRECTO";
  if (["REFERENCIA/TERCERO_NO_DIRECTO", "REFERENCIA_TERCERO_NO_DIRECTO"].includes(raw)) return "REFERENCIA";
  return fallback;
}

export function esTipoInterlocutorVigente(value) {
  return TIPOS_INTERLOCUTOR_VIGENTES.includes(normalizarTipoInterlocutor(value));
}

export function formularioAplicadoParaTipo(tipo) {
  const t = normalizarTipoInterlocutor(tipo);
  return t === "NO_AUDITABLE" ? "NINGUNO" : t;
}

export function versionFormularioActual(formulario = "TITULAR") {
  const key = String(formulario || "TITULAR").trim().toUpperCase();
  return FORMULARIOS_AUDITORIA[key]?.version ?? null;
}

export function definicionFormulario(formulario = "TITULAR", version = null) {
  const key = String(formulario || "TITULAR").trim().toUpperCase();
  const v = version == null || version === "" ? null : Number(version);
  if (v != null) {
    if (FORMULARIOS_AUDITORIA[key]?.version === v) return FORMULARIOS_AUDITORIA[key];
    if (FORMULARIOS_LEGACY[key]?.version === v) return FORMULARIOS_LEGACY[key];
  }
  return FORMULARIOS_AUDITORIA[key] || FORMULARIOS_LEGACY[key] || FORMULARIOS_AUDITORIA.TITULAR;
}

export function criteriosParaFormulario(formulario = "TITULAR", version = null) {
  return definicionFormulario(formulario, version)?.criterios || [];
}

export function criterioPorId(formulario, id, version = null) {
  return criteriosParaFormulario(formulario, version).find((c) => c.id === Number(id)) || null;
}

export function crearSnapshotFormulario(formulario, version = null) {
  const def = definicionFormulario(formulario, version);
  return {
    key: def.key,
    label: def.label,
    version: def.version,
    pesos: { ...PESOS_AUDITORIA },
    criterios: def.criterios.map((c) => ({
      id: c.id,
      orden: c.orden ?? c.id,
      grupo: c.grupo,
      label: c.label,
      ayuda: {
        descripcion: c.ayuda?.descripcion || "",
        si: c.ayuda?.si || "",
        parcial: c.ayuda?.parcial || "",
        no: c.ayuda?.no || "",
        noAplica: c.ayuda?.noAplica || "",
        ejemplos: Array.isArray(c.ayuda?.ejemplos) ? [...c.ayuda.ejemplos] : [],
      },
    })),
  };
}

export function valorResultadoCriterio(value) {
  if (value === true || value === 1) return "SI";
  if (value === 0.5) return "PARCIAL";
  if (value === false || value === 0) return "NO";
  const v = String(value ?? "").trim().toLowerCase();
  if (["si", "sí", "ok", "cumple", "completo", "true", "1"].includes(v)) return "SI";
  if (["parcial", "medio", "mitad", "0.5", "0,5"].includes(v)) return "PARCIAL";
  if (["no aplica", "no_aplica", "no-aplica", "na", "n/a", "noaplica"].includes(v)) return "NO_APLICA";
  if (["no", "false", "0"].includes(v)) return "NO";
  return "SIN_RESPUESTA";
}

export function valorAplicadoResultado(estado) {
  const e = valorResultadoCriterio(estado);
  if (e === "SI") return 1;
  if (e === "PARCIAL") return 0.5;
  if (e === "NO") return 0;
  return null;
}

function uniqNums(arr = []) {
  return [...new Set((arr || []).map(Number).filter(Number.isFinite))];
}

function mapToObject(raw) {
  if (raw instanceof Map) return Object.fromEntries(raw);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  return null;
}

function criteriosDesdeInput(formularioOrCriterios = "TITULAR", version = null) {
  if (Array.isArray(formularioOrCriterios)) return formularioOrCriterios;
  return criteriosParaFormulario(formularioOrCriterios, version);
}

export function normalizarResultadosItem(item = {}, formularioOrCriterios = "TITULAR", version = null) {
  const criterios = criteriosDesdeInput(formularioOrCriterios, version);
  const ids = criterios.map((c) => Number(c.id));
  const validos = new Set(ids);
  const resultados = {};
  const resultadosRaw = mapToObject(item.resultadosCriterios);
  const checksRaw = mapToObject(item.checks);

  const tieneResultados = resultadosRaw && Object.keys(resultadosRaw).length > 0;
  const tieneChecks = checksRaw && Object.keys(checksRaw).length > 0;

  if (tieneResultados || tieneChecks) {
    const source = tieneResultados ? resultadosRaw : checksRaw;
    for (const id of ids) resultados[String(id)] = valorResultadoCriterio(source[String(id)] ?? source[id]);
  } else if (Array.isArray(item.fallosIds) || Array.isArray(item.parcialesIds) || Array.isArray(item.criteriosNoAplica)) {
    const fallos = new Set(uniqNums(item.fallosIds || []).filter((id) => validos.has(id)));
    const parciales = new Set(uniqNums(item.parcialesIds || []).filter((id) => validos.has(id)));
    const noAplica = new Set(uniqNums(item.criteriosNoAplica || []).filter((id) => validos.has(id)));
    for (const id of ids) resultados[String(id)] = noAplica.has(id) ? "NO_APLICA" : parciales.has(id) ? "PARCIAL" : fallos.has(id) ? "NO" : "SI";
  } else if (Array.isArray(item.okIds)) {
    const ok = new Set(uniqNums(item.okIds).filter((id) => validos.has(id)));
    for (const id of ids) resultados[String(id)] = ok.has(id) ? "SI" : "NO";
  } else {
    for (const id of ids) resultados[String(id)] = "SIN_RESPUESTA";
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

// Mantiene el peso de cada bloque aunque haya N/A dentro de ese bloque.
// Si un bloque entero queda sin criterios aplicables, ese bloque se excluye y se renormalizan los pesos restantes.
export function calcularScoresAuditoriaItem(resultadosInput = {}, formularioOrCriterios = "TITULAR", version = null, pesosInput = PESOS_AUDITORIA) {
  const criterios = criteriosDesdeInput(formularioOrCriterios, version);
  const resultados = mapToObject(resultadosInput) || {};
  const grupos = BLOQUES.map((b) => b.key);
  const bloqueNumerador = Object.fromEntries(grupos.map((g) => [g, 0]));
  const bloqueDenominador = Object.fromEntries(grupos.map((g) => [g, 0]));

  for (const c of criterios) {
    const estado = valorResultadoCriterio(resultados[String(c.id)] ?? resultados[c.id]);
    if (estado === "NO_APLICA" || estado === "SIN_RESPUESTA") continue;
    const valor = valorAplicadoResultado(estado);
    bloqueNumerador[c.grupo] += valor;
    bloqueDenominador[c.grupo] += 1;
  }

  const scoreBloques = {};
  let sumaPonderada = 0;
  let pesoAplicable = 0;
  for (const grupo of grupos) {
    if (!bloqueDenominador[grupo]) {
      scoreBloques[grupo] = null;
      continue;
    }
    const scoreBloque = bloqueNumerador[grupo] / bloqueDenominador[grupo];
    scoreBloques[grupo] = Number((scoreBloque * 10).toFixed(6));
    const peso = Number(pesosInput?.[grupo] ?? PESOS_AUDITORIA[grupo] ?? 0);
    sumaPonderada += scoreBloque * peso;
    pesoAplicable += peso;
  }

  const scoreAudio = pesoAplicable > 0 ? Number(((sumaPonderada / pesoAplicable) * 10).toFixed(6)) : null;
  return { scoreBloques, scoreAudio, pesoAplicable };
}

export function semaforoAuditoria(scoreFinal) {
  if (scoreFinal == null || scoreFinal === "") return null;
  const score = Number(scoreFinal);
  if (!Number.isFinite(score)) return null;
  if (score < UMBRALES_AUDITORIA.bajo) return "bajo";
  if (score >= UMBRALES_AUDITORIA.alto) return "alto";
  return "medio";
}
