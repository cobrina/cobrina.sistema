import mongoose from "mongoose";

const proyeccionSchema = new mongoose.Schema(
  {
    dni: {
      type: Number,
      required: true,
    },
    nombreTitular: {
      type: String,
      default: "",
    },
    importe: {
      type: Number,
      required: true,
    },
    concepto: {
      type: String,
      enum: ["Ant-Can", "Anticipo", "Cancelación", "Parcial", "Posible","Cuota"],
      required: false, // ✅ Ya no es obligatorio
    },
    fechaPromesa: {
      type: Date,
    },
    fechaPromesaInicial: {
      type: Date, // 👈 para lógica "Reprogramado"
    },

    fechaProximoLlamado: {
      type: Date, // ✅ Nuevo campo
    },
    importePagado: {
      type: Number,
    },
    estado: {
      type: String,
      enum: [
        "Promesa activa",
        "Pagado",
        "Pagado parcial",
        "Promesa caída",
        "Reprogramado",
        "Pendiente",
        "Sin contacto",
      ],
      default: "Pendiente",
    },
    cartera: {
      type: String,
      required: true,
    },
    fiduciario: {
      type: String,
    },
    observaciones: {
      type: String,
    },
    empleadoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Empleado",
      required: true,
    },
    creado: {
      type: Date,
      default: Date.now,
    },
    ultimaModificacion: {
      type: Date,
      default: Date.now,
    },
    mes: {
      type: Number,
      required: true,
    },
    anio: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("Proyeccion", proyeccionSchema);
