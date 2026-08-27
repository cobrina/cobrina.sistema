// BACKEND/models/AuditoriaContactoDirecto.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const AyudaCriterioSchema = new Schema(
  {
    descripcion: { type: String, default: "" },
    si: { type: String, default: "" },
    parcial: { type: String, default: "" },
    no: { type: String, default: "" },
    noAplica: { type: String, default: "" },
    ejemplos: { type: [String], default: [] },
  },
  { _id: false }
);

const CriterioSnapshotSchema = new Schema(
  {
    id: { type: Number, required: true },
    orden: { type: Number, required: true },
    grupo: { type: String, required: true, enum: ["presentacion", "negociacion", "cierre", "calidad"] },
    label: { type: String, required: true, trim: true },
    ayuda: { type: AyudaCriterioSchema, default: () => ({}) },
  },
  { _id: false }
);

const FormularioSnapshotSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    version: { type: Number, required: true, min: 1 },
    pesos: {
      presentacion: { type: Number, default: 0.1 },
      negociacion: { type: Number, default: 0.4 },
      cierre: { type: Number, default: 0.3 },
      calidad: { type: Number, default: 0.2 },
    },
    criterios: { type: [CriterioSnapshotSchema], default: [] },
  },
  { _id: false }
);

const EvaluacionCriterioSnapshotSchema = new Schema(
  {
    criterioId: { type: Number, required: true },
    orden: { type: Number, required: true },
    bloque: { type: String, required: true, enum: ["presentacion", "negociacion", "cierre", "calidad"] },
    nombre: { type: String, required: true, trim: true },
    respuesta: { type: String, required: true, enum: ["SI", "PARCIAL", "NO", "NO_APLICA"] },
    comentario: { type: String, default: "", trim: true, maxlength: 1000 },
    valorAplicado: { type: Number, default: null, min: 0, max: 1 },
  },
  { _id: false }
);

/**
 * Auditoría manual basada en la planilla "Auditoría de Contactos Directos".
 * - Guarda SOLO datos y resultados (para KPIs).
 * - No integra AsterVoIP / celulares.
 */

const ItemAudioSchema = new Schema(
  {
    telefono: { type: String, required: true, trim: true, maxlength: 60 },
    dni: { type: String, default: "", trim: true, maxlength: 40 },

    cartera: { type: String, default: "", trim: true, maxlength: 120 },

    // ✅ NUEVO PRINCIPAL: duración en minutos
    duracionMinutos: { type: Number, default: 0, min: 0, max: 480 }, // 0..8hs

    // ✅ Compatibilidad temporal con auditorías viejas / front viejo
    duracionSegundos: { type: Number, default: 0, min: 0, max: 28800 }, // 0..8hs

    fechaAudio: { type: Date, default: null },
    horaAprox: { type: String, default: "", trim: true, maxlength: 20 },

    tipoInteraccion: {
      type: String,
      default: "LLAMADA_SALIENTE",
      enum: [
        "LLAMADA_ENTRANTE",
        "LLAMADA_SALIENTE",
        "MENSAJE_ENTRANTE",
        "MENSAJE_SALIENTE",
        "EMAIL_ENTRANTE",
        "EMAIL_SALIENTE",
      ],
      index: true,
    },

    referencia: { type: String, default: "", trim: true, maxlength: 300 },

    // ✅ NUEVO: comentario libre por criterio/fila
    // Ej:
    // {
    //   "1": "Se presentó bien",
    //   "8": "No refutó objeción del titular"
    // }
    comentariosCriterio: {
      type: Map,
      of: { type: String, trim: true, maxlength: 1000 },
      default: {},
    },

    // Resultado explícito por criterio. Mantiene compatibilidad con fallos/parciales históricos.
    resultadosCriterios: {
      type: Map,
      of: {
        type: String,
        enum: ["SI", "PARCIAL", "NO", "NO_APLICA"],
      },
      default: {},
    },
    fallosIds: { type: [Number], default: [] },
    parcialesIds: { type: [Number], default: [] },
    criteriosNoAplica: { type: [Number], default: [] },

    // Snapshot de cada respuesta: permite reconstruir exactamente la matriz usada.
    evaluacionSnapshot: { type: [EvaluacionCriterioSnapshotSchema], default: [] },

    scoreAudio: { type: Number, default: null, min: 0, max: 10 },
    scoreBloques: {
      presentacion: { type: Number, default: null, min: 0, max: 10 },
      negociacion: { type: Number, default: null, min: 0, max: 10 },
      cierre: { type: Number, default: null, min: 0, max: 10 },
      calidad: { type: Number, default: null, min: 0, max: 10 },
    },
  },
  { _id: false }
);

const AuditoriaContactoDirectoSchema = new Schema(
  {
    // Operador auditado
    operadorUsername: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
      maxlength: 120,
    },

    // Auditor (admin/super-admin logueado)
    auditorUsername: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
      maxlength: 120,
    },

    fechaAuditoria: { type: Date, default: Date.now, index: true },

    // Tipo de interlocutor de la auditoría. Auditorías históricas sin este campo
    // se interpretan como TITULAR desde el controlador, sin recalcular su score.
    tipoInterlocutor: {
      type: String,
      enum: ["TITULAR", "FAMILIAR_DIRECTO", "REFERENCIA", "TERCERO", "TERCERO_PAGADOR", "NO_AUDITABLE"],
      default: "TITULAR",
      index: true,
    },
    formularioAplicado: {
      type: String,
      enum: ["TITULAR", "FAMILIAR_DIRECTO", "REFERENCIA", "TERCERO", "TERCERO_PAGADOR", "NINGUNO"],
      default: "TITULAR",
      index: true,
    },
    // Versionado interno. No se muestra como opción al crear nuevas auditorías.
    tipoFormulario: { type: String, default: "", trim: true, index: true },
    versionFormulario: { type: Number, default: null, min: 1, index: true },
    formularioSnapshot: { type: FormularioSnapshotSchema, default: null },

    motivoNoAuditable: { type: String, default: "", trim: true, maxlength: 200 },
    detalleMotivoNoAuditable: { type: String, default: "", trim: true, maxlength: 1000 },

    motivosSeleccion: {
      type: [String],
      default: [],
      // ejemplos: "aleatorio", "prueba", etc
    },

    // ❌ Eliminados:
    // feedbackInformado
    // requiereCoaching

    observacionesGenerales: { type: String, default: "", trim: true, maxlength: 6000 },
    puntosPositivos: { type: String, default: "", trim: true, maxlength: 6000 },
    puntosAMejorar: { type: String, default: "", trim: true, maxlength: 6000 },

    // Diagnóstico global: se guarda pero no modifica matemáticamente el score.
    quienCondujo: {
      type: String,
      enum: ["OPERADOR", "COMPARTIDA", "INTERLOCUTOR", ""],
      default: "",
      index: true,
    },
    justificacionConduccion: { type: String, default: "", trim: true, maxlength: 1500 },
    resultadoComercial: {
      type: String,
      enum: [
        "PAGO_REALIZADO",
        "ACUERDO_CERRADO",
        "PROMESA_FIRME",
        "CONTRAOFERTA_CONCRETA",
        "PENDIENTE_DOCUMENTACION",
        "PROXIMA_ACCION_CONCRETA",
        "CONTACTO_UTIL_SIN_COMPROMISO",
        "SIN_DEFINICION",
        "NO_APLICA",
        "",
      ],
      default: "",
      index: true,
    },

    // Items (máximo 5 audios ideal)
    items: {
      type: [ItemAudioSchema],
      default: [],
      validate: [(arr) => Array.isArray(arr) && arr.length <= 5, "Máximo 5 audios/items por auditoría."],
    },

    // Scores calculados
    scoreFinal: { type: Number, default: null, min: 0, max: 10, index: true },
    scoreBloques: {
      presentacion: { type: Number, default: null, min: 0, max: 10 },
      negociacion: { type: Number, default: null, min: 0, max: 10 },
      cierre: { type: Number, default: null, min: 0, max: 10 },
      calidad: { type: Number, default: null, min: 0, max: 10 },
    },

    semaforo: {
      type: String,
      default: null,
      enum: ["bajo", "medio", "alto", null],
      index: true,
    },

    // Multi-tenant (como reportes): propietario = userId del token (Empleado)
    propietario: { type: Schema.Types.ObjectId, ref: "Empleado", index: true },

    // Housekeeping
    borrado: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// Índices de apoyo (listados + KPIs)
AuditoriaContactoDirectoSchema.index({ operadorUsername: 1, fechaAuditoria: -1 });
AuditoriaContactoDirectoSchema.index({ auditorUsername: 1, fechaAuditoria: -1 });

export default mongoose.model("AuditoriaContactoDirecto", AuditoriaContactoDirectoSchema);
