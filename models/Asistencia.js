import mongoose from "mongoose";

const MarcaSchema = new mongoose.Schema(
  {
    tipo: {
      type: String,
      enum: ["entrada", "salida"],
      required: true,
    },
    fecha: {
      type: Date,
      required: true,
      default: Date.now,
    },
    motivo: {
      type: String,
      enum: ["manual", "cierre-navegador", "automatico-21", "sistema", ""],
      default: "",
    },
  },
  { _id: false }
);

const AsistenciaSchema = new mongoose.Schema(
  {
    empleado: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Empleado",
      required: true,
      index: true,
    },
    fechaClave: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    estado: {
      type: String,
      enum: ["presente", "finalizado"],
      default: "presente",
      index: true,
    },
    marcas: {
      type: [MarcaSchema],
      default: [],
    },
    cierrePendienteDesde: { type: Date, default: null },
    cierrePendienteHasta: { type: Date, default: null },
    motivoCierrePendiente: { type: String, default: "" },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

AsistenciaSchema.index({ empleado: 1, fechaClave: 1 }, { unique: true });
AsistenciaSchema.index({ fechaClave: 1, estado: 1 });

export default mongoose.model("Asistencia", AsistenciaSchema);
