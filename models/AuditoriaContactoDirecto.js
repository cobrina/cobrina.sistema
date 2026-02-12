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

    // En planilla: "Cartera" (en tu operativa puede ser Entidad/Cartera)
    cartera: { type: String, default: "", trim: true, maxlength: 120 },

    // ✅ NUEVO: duración en segundos (para LLAMADAS se valida en controller)
    duracionSegundos: { type: Number, default: 0, min: 0, max: 28800 }, // 0..8hs

    // Opcionales
    fechaAudio: { type: Date, default: null },
    horaAprox: { type: String, default: "", trim: true, maxlength: 20 },

    // "llamada entrante/saliente" + "mensaje entrante/saliente"
    tipoInteraccion: {
      type: String,
      default: "LLAMADA_SALIENTE",
      enum: ["LLAMADA_ENTRANTE", "LLAMADA_SALIENTE", "MENSAJE_ENTRANTE", "MENSAJE_SALIENTE","EMAIL_ENTRANTE", "EMAIL_SALIENTE"],
      index: true,
    },

    // Texto libre para ubicar rápido (ID llamada, nota, etc.)
    referencia: { type: String, default: "", trim: true, maxlength: 300 },

    // Guardamos SOLO fallos (IDs 1..24) para que sea liviano
    fallosIds: { type: [Number], default: [] },

    // Scores calculados (0..10)
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
