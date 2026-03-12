// BACKEND/models/AuditoriaContactoDirecto.js
import mongoose from "mongoose";

const { Schema } = mongoose;

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

    fallosIds: { type: [Number], default: [] },

    scoreAudio: { type: Number, default: 0, min: 0, max: 10 },
    scoreBloques: {
      presentacion: { type: Number, default: 0, min: 0, max: 10 },
      negociacion: { type: Number, default: 0, min: 0, max: 10 },
      cierre: { type: Number, default: 0, min: 0, max: 10 },
      calidad: { type: Number, default: 0, min: 0, max: 10 },
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

    // Items (máximo 5 audios ideal)
    items: {
      type: [ItemAudioSchema],
      default: [],
      validate: [(arr) => Array.isArray(arr) && arr.length <= 5, "Máximo 5 audios/items por auditoría."],
    },

    // Scores calculados
    scoreFinal: { type: Number, default: 0, min: 0, max: 10, index: true },
    scoreBloques: {
      presentacion: { type: Number, default: 0, min: 0, max: 10 },
      negociacion: { type: Number, default: 0, min: 0, max: 10 },
      cierre: { type: Number, default: 0, min: 0, max: 10 },
      calidad: { type: Number, default: 0, min: 0, max: 10 },
    },

    semaforo: {
      type: String,
      default: "medio",
      enum: ["bajo", "medio", "alto"],
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
