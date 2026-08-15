import mongoose from "mongoose";

const ContactadoObservacionSchema = new mongoose.Schema(
  {
    serieId: { type: String, required: true, index: true, trim: true, maxlength: 80 },
    ventanaId: { type: mongoose.Schema.Types.ObjectId, ref: "ContactadoVentana", default: null, index: true },
    dni: { type: String, required: true, index: true, trim: true },
    operadorCaso: { type: String, required: true, index: true, trim: true, lowercase: true },
    autorId: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", required: true, index: true },
    autorUsername: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    autorRole: { type: String, default: "", trim: true, maxlength: 80 },
    tipo: { type: String, enum: ["operador", "supervision"], required: true, index: true },
    texto: { type: String, required: true, trim: true, maxlength: 1800 },
  },
  { timestamps: true, versionKey: false }
);

ContactadoObservacionSchema.index({ serieId: 1, createdAt: -1 });
export default mongoose.model("ContactadoObservacion", ContactadoObservacionSchema, "contactados_observaciones");
