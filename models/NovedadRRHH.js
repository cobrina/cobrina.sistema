import mongoose from "mongoose";

const NovedadRRHHSchema = new mongoose.Schema(
  {
    empleadoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Empleado",
      required: true,
      index: true,
    },
    tipo: {
      type: String,
      enum: [
        "falta",
        "falta-justificada",
        "llegada-tarde",
        "cambio-horario",
        "licencia-medica",
        "dia-estudio",
        "permiso",
        "apercibimiento",
        "error-grave-gestion",
        "otro",
      ],
      required: true,
      index: true,
    },
    motivoApercibimiento: {
      type: String,
      enum: [
        "",
        "llegadas-tarde-reiteradas",
        "falta-injustificada",
        "error-grave-gestion",
        "incumplimiento-procedimiento",
        "trato-inadecuado",
        "otro",
      ],
      default: "",
      index: true,
    },
    fechaDesde: { type: Date, required: true, index: true },
    fechaHasta: { type: Date, default: null },
    horarioAnterior: { type: String, default: "", trim: true },
    horarioNuevo: { type: String, default: "", trim: true },
    horaEntradaNueva: {
      type: String,
      default: "",
      trim: true,
      match: [/^$|^([01]\d|2[0-3]):[0-5]\d$/, "Hora de entrada inválida"],
    },
    horaSalidaNueva: {
      type: String,
      default: "",
      trim: true,
      match: [/^$|^([01]\d|2[0-3]):[0-5]\d$/, "Hora de salida inválida"],
    },
    // Una excepción de horario puede dividir la jornada en dos bloques.
    // Los campos anteriores siguen siendo el primer bloque para conservar
    // compatibilidad con todas las novedades históricas.
    jornadaPartidaNueva: { type: Boolean, default: false },
    horaEntradaSegundaNueva: {
      type: String,
      default: "",
      trim: true,
      match: [/^$|^([01]\d|2[0-3]):[0-5]\d$/, "Hora de segunda entrada inválida"],
    },
    horaSalidaSegundaNueva: {
      type: String,
      default: "",
      trim: true,
      match: [/^$|^([01]\d|2[0-3]):[0-5]\d$/, "Hora de segunda salida inválida"],
    },
    toleranciaMinutosNueva: { type: Number, default: 10, min: 0, max: 180 },
    minutosTarde: { type: Number, default: 0, min: 0 },
    justificado: { type: Boolean, default: false },
    descripcion: { type: String, required: true, trim: true, maxlength: 3000 },
    accionTomada: { type: String, default: "", trim: true, maxlength: 2000 },
    estado: {
      type: String,
      enum: ["vigente", "resuelto", "anulado"],
      default: "vigente",
      index: true,
    },
    creadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", required: true },
    modificadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", default: null },
  },
  { timestamps: true, versionKey: false }
);

NovedadRRHHSchema.index({ empleadoId: 1, fechaDesde: -1 });
NovedadRRHHSchema.index({ tipo: 1, estado: 1, fechaDesde: -1 });
NovedadRRHHSchema.index({ empleadoId: 1, tipo: 1, estado: 1, fechaDesde: 1, fechaHasta: 1 });

export default mongoose.model("NovedadRRHH", NovedadRRHHSchema);
