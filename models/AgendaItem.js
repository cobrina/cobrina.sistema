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
    completada: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

AgendaItemSchema.index({ propietario: 1, fechaClave: 1, hora: 1 });
AgendaItemSchema.index({ creadoPor: 1, fechaClave: 1, hora: 1 });

export default mongoose.model("AgendaItem", AgendaItemSchema);
