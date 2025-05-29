import mongoose from "mongoose";

const SubCesionSchema = new mongoose.Schema({
  nombre: {
    type: String,
    required: true,
    unique: true,
  },
  // ✅ ya no tiene relación con Entidad
}, { timestamps: true });

export default mongoose.model("SubCesion", SubCesionSchema);
