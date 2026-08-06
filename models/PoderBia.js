import mongoose from "mongoose";

const PoderBiaSchema = new mongoose.Schema(
  {
    tipoPoder: {
      type: String,
      enum: ["grupo-bia", "green-light"],
      default: "grupo-bia",
      index: true,
    },
    dni: { type: String, required: true, trim: true, index: true },
    nombreTitular: { type: String, required: true, trim: true, uppercase: true },
    cartera: { type: String, default: "", trim: true },
    tratamiento: { type: String, enum: ["sr", "sra", ""], default: "", trim: true },
    tipoProducto: { type: String, default: "", trim: true },
    numeroProducto: { type: String, default: "", trim: true },
    fechaDocumento: { type: Date, required: true, index: true },
    entidadNumero: { type: Number, default: null, index: true },
    entidadNombre: { type: String, default: "", trim: true },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", required: true, index: true },
  },
  { timestamps: true, versionKey: false }
);

PoderBiaSchema.index({ tipoPoder: 1, dni: 1, fechaDocumento: -1 });

export default mongoose.model("PoderBia", PoderBiaSchema);
