import mongoose from "mongoose";

const ColchonSchema = new mongoose.Schema({
  cartera: { type: String, required: true },
  dni: { type: Number, required: true },
  nombreTitular: { type: String, required: true },
  cuotaNumero: { type: Number, required: true },
  importeCuota: { type: Number, required: true },
  saldoPendiente: { type: Number, required: true },
  fechaVencimiento: { type: Date, required: true },
  fechaPago: { type: Date },
  estado: {
    type: String,
    enum: ["A cuota", "Cuota 30", "Cuota 60", "Cuota 90"],
    default: "A cuota",
  },
    observaciones: { type: String },
  fiduciario: { type: String },
  empleadoId: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", required: true },
  creado: { type: Date, default: Date.now },
  ultimaModificacion: { type: Date, default: Date.now }
});

export default mongoose.model("Colchon", ColchonSchema);
