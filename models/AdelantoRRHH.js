import mongoose from "mongoose";
import { fechaClaveArgentina, toDateOnly } from "../utils/fecha.util.js";

const AdelantoRRHHSchema = new mongoose.Schema(
  {
    empleadoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Empleado",
      required: true,
      index: true,
    },
    fechaSolicitud: { type: Date, required: true, default: () => toDateOnly(fechaClaveArgentina()), index: true },
    monto: { type: Number, required: true, min: 0.01 },
    motivo: { type: String, required: true, trim: true, maxlength: 1000 },
    estado: {
      type: String,
      enum: ["solicitado", "aprobado", "entregado", "rechazado", "descontado", "cancelado"],
      default: "solicitado",
      index: true,
    },
    fechaResolucion: { type: Date, default: null },
    fechaEntrega: { type: Date, default: null },
    periodoDescuento: { type: String, default: "", match: /^$|^\d{4}-\d{2}$/ },
    observaciones: { type: String, default: "", trim: true, maxlength: 2000 },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", required: true },
    modificadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", default: null },
  },
  { timestamps: true, versionKey: false }
);

AdelantoRRHHSchema.index({ empleadoId: 1, fechaSolicitud: -1 });
AdelantoRRHHSchema.index({ estado: 1, fechaSolicitud: -1 });

export default mongoose.model("AdelantoRRHH", AdelantoRRHHSchema);
