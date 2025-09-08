// backend/models/Direccion.js
import mongoose from "mongoose";

const DireccionSchema = new mongoose.Schema({
  calle: String,
  numero: String,
  ciudad: String,
  provincia: String,
  pais: String,
  cp: String,
}, { timestamps: true });

export default mongoose.model("Direccion", DireccionSchema);
