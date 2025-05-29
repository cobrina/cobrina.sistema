import mongoose from "mongoose";

const ColchonSchema = new mongoose.Schema({
  estado: {
    type: String,
    enum: ["A cuota", "Cuota 30", "Cuota 60", "Cuota 90"],
    default: "A cuota",
  },
  entidadId: { type: mongoose.Schema.Types.ObjectId, ref: "Entidad" },
  idPago: { type: Number },
  dni: { type: Number, required: true },
  nombre: { type: String, required: true },
  empleadoId: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", required: true },
  turno: { type: String },
  cartera: { type: String, required: true },
  mesGenerado: { type: String },

  vencimiento: { type: Number },                  // Día de vencimiento de la cuota
  cuotaNumero: { type: Number },                  // Cantidad de cuotas (antes llamado 'cuotas')
  importeCuota: { type: Number, required: true }, // Monto de cada cuota
  importePagado: { type: Number, default: 0 },    // Monto total pagado en el mes (acumulativo)
  saldoPendiente: { type: Number, default: 0 },   // Deuda acumulada de meses anteriores

  observaciones: { type: String },
  fiduciario: { type: String },
  subCesionId: { type: mongoose.Schema.Types.ObjectId, ref: "SubCesion" },
  creado: { type: Date, default: Date.now },
  ultimaModificacion: { type: Date, default: Date.now }
});

export default mongoose.model("Colchon", ColchonSchema);
