import mongoose from "mongoose";

const pagoInformadoMangoSchema = new mongoose.Schema(
  {
    acuerdoGestionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReporteGestion",
      required: true,
      index: true,
    },
    fecha: { type: Date, required: true, index: true },
    monto: { type: Number, required: true, min: [0.01, "Monto > 0"] },
    operadorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Empleado",
      required: true,
      index: true,
    },
    erroneo: { type: Boolean, default: false, index: true },
    motivoError: { type: String, default: "" },
    marcadoPor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Empleado",
      default: null,
    },
    marcadoEn: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

pagoInformadoMangoSchema.index({ acuerdoGestionId: 1, fecha: -1, createdAt: -1 });
pagoInformadoMangoSchema.index({ acuerdoGestionId: 1, erroneo: 1 });

export default mongoose.model(
  "PagoInformadoMango",
  pagoInformadoMangoSchema,
  "pagos_informados_mango"
);
