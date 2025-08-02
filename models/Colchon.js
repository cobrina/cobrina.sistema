import mongoose from "mongoose";

const ColchonSchema = new mongoose.Schema({
  estado: {
    type: String,
    enum: ["A cuota", "Cuota 30", "Cuota 60", "Cuota 90", "Caída"],
    default: "A cuota",
  },
  estadoOriginal: { type: String, default: "" },
  entidadId: { type: mongoose.Schema.Types.ObjectId, ref: "Entidad" },
  dni: { type: Number, required: true },
  nombre: { type: String, required: true },
  empleadoId: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", required: true },
  turno: { type: String },
  cartera: { type: String, required: true },
  idCuotaLogico: { type: String, index: true },
  vencimiento: { type: Number },
  cuotaNumero: { type: Number },
  importeCuota: { type: Number, required: true },

  pagos: [
    {
      fecha: { type: Date, required: true },
      monto: { type: Number, required: true },
    }
  ],

  pagosInformados: [ 
    {
      fecha: { type: Date, required: true },
      monto: { type: Number, required: true },
      visto: { type: Boolean, default: false },
      erroneo: { type: Boolean, default: false },
      operadorId: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", required: true },
    }
  ],

  saldoPendiente: { type: Number, default: 0 },

  deudaPorMes: [
    {
      mes: { type: String, required: true },
      anio: { type: Number, required: true },
      montoAdeudado: { type: Number, required: true },
    }
  ],

  observaciones: { type: String },
  observacionesOperador: { type: String, default: "" },
  fiduciario: { type: String },
  subCesionId: { type: mongoose.Schema.Types.ObjectId, ref: "SubCesion" },
  vecesTocada: { type: Number, default: 0 },
  ultimaGestion: { type: Date, default: null },
  gestor: { type: String, default: "" },
  telefono: { type: String },
  creado: { type: Date, default: Date.now },
  ultimaModificacion: { type: Date, default: Date.now },
}, {
  versionKey: false   // ⛔️ DESACTIVA __v para evitar errores de versión
});

export default mongoose.model("Colchon", ColchonSchema);
