import mongoose from "mongoose";

const carteraSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true, unique: true },
    datosHtml: { type: String, required: true },

    direccion: {
      type: mongoose.Schema.Types.Mixed, // Puede ser ObjectId o string
      required: true,
    },

    editadoPor: {
      type: String, // username del empleado que hizo la última edición
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("Cartera", carteraSchema);
