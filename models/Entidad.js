import mongoose from "mongoose";

const EntidadSchema = new mongoose.Schema({
  numero: {
    type: Number,
    required: true,
    unique: true,
  },
  nombre: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  }
}, { timestamps: true });

export default mongoose.model("Entidad", EntidadSchema);
