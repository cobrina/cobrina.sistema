import mongoose from "mongoose";

const PoderBiaSchema = new mongoose.Schema(
  {
    dni: { type: String, required: true, trim: true, index: true },
    nombreTitular: { type: String, required: true, trim: true, uppercase: true },
    cartera: { type: String, required: true, trim: true },
    fechaDocumento: { type: Date, required: true, index: true },
    entidadNumero: { type: Number, default: 54, index: true },
    entidadNombre: { type: String, default: "GRUPO BIA", trim: true },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", required: true, index: true },
  },
  { timestamps: true, versionKey: false }
);

PoderBiaSchema.index({ dni: 1, fechaDocumento: -1 });

export default mongoose.model("PoderBia", PoderBiaSchema);
