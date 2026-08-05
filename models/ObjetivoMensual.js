import mongoose from "mongoose";

const ObjetivoMensualSchema = new mongoose.Schema(
  {
    mes: { type: String, required: true, match: /^\d{4}-\d{2}$/, index: true },
    alcance: {
      type: String,
      enum: ["equipo", "operador", "entidad", "entidad-subcesion"],
      required: true,
      index: true,
    },
    empleadoId: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", default: null, index: true },
    entidadNumero: { type: Number, min: 1, default: null, index: true },
    subCesionId: { type: mongoose.Schema.Types.ObjectId, ref: "SubCesion", default: null, index: true },
    montoObjetivo: { type: Number, required: true, min: 0 },
    observaciones: { type: String, default: "", trim: true, maxlength: 1000 },
    activo: { type: Boolean, default: true, index: true },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", required: true },
    modificadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", default: null },
  },
  { timestamps: true, versionKey: false }
);

ObjetivoMensualSchema.index(
  { mes: 1, alcance: 1, empleadoId: 1, entidadNumero: 1, subCesionId: 1 },
  { unique: true, name: "uk_objetivo_mensual_alcance" }
);

export default mongoose.model("ObjetivoMensual", ObjetivoMensualSchema);
