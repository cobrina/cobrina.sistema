import mongoose from "mongoose";

const AgendaItemSchema = new mongoose.Schema(
  {
    propietario: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Empleado",
      required: true,
      index: true,
    },
    creadoPor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Empleado",
      required: false,
      default: null,
      index: true,
    },
    creadoPorUsername: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      maxlength: 80,
    },
    fechaClave: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    hora: {
      type: String,
      required: true,
      trim: true,
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
    },
    titulo: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
    },
    detalle: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1200,
    },
    tipo: {
      type: String,
      enum: ["tarea", "reunion", "recordatorio"],
      default: "tarea",
      index: true,
    },
    avisarMinutosAntes: {
      type: Number,
      default: 0,
      min: 0,
      max: 1440,
    },
    origenSistema: {
      type: String,
      enum: ["", "capacitacion"],
      default: "",
      index: true,
    },
    referenciaId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    completada: {
      type: Boolean,
      default: false,
      index: true,
    },
    serieId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    recurrencia: {
      type: String,
      enum: ["", "semanal", "mensual"],
      default: "",
      index: true,
    },
    recurrenciaHasta: {
      type: String,
      default: "",
      match: /^$|^\d{4}-\d{2}-\d{2}$/,
    },
    indiceRecurrencia: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

AgendaItemSchema.index({ propietario: 1, fechaClave: 1, hora: 1 });
AgendaItemSchema.index({ creadoPor: 1, fechaClave: 1, hora: 1 });
AgendaItemSchema.index({ serieId: 1, fechaClave: 1 });

export default mongoose.model("AgendaItem", AgendaItemSchema);
