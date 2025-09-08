// models/Colchon.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const PagoSchema = new Schema(
  {
    fecha: { type: Date, required: true },
    monto: { type: Number, required: true, min: 0 },
  },
  { _id: true }
);

const PagoInformadoSchema = new Schema(
  {
    fecha: { type: Date, required: true },
    monto: { type: Number, required: true, min: 0 },
    visto: { type: Boolean, default: false },
    erroneo: { type: Boolean, default: false },
    motivoError: { type: String, default: "" },          // 👈 agregado
    operadorId: { type: Schema.Types.ObjectId, ref: "Empleado", required: true },
    marcadoPor: { type: Schema.Types.ObjectId, ref: "Empleado", default: null }, // 👈 agregado
    marcadoEn: { type: Date, default: null },            // 👈 agregado
  },
  { _id: true }
);

const DeudaMesSchema = new Schema(
  {
    mes: { type: String, required: true, trim: true }, // ej: "2025-03"
    anio: { type: Number, required: true },
    montoAdeudado: { type: Number, required: true, min: 0 },
  },
  { _id: true }
);

const ColchonSchema = new Schema(
  {
    // Estado
    estado: {
      type: String,
      enum: ["A cuota", "Cuota 30", "Cuota 60", "Cuota 90", "Caída"],
      default: "A cuota",
      trim: true,
    },
    estadoOriginal: { type: String, default: "", trim: true },

    // Identificaciones obligatorias
    entidadId: { type: Schema.Types.ObjectId, ref: "Entidad", required: true },
    subCesionId: { type: Schema.Types.ObjectId, ref: "SubCesion", required: true },

    // Datos del titular / asignación
    dni: { type: Number, required: true, index: true },
    nombre: { type: String, required: true, trim: true },
    empleadoId: { type: Schema.Types.ObjectId, ref: "Empleado", required: true, index: true },
    turno: { type: String, trim: true },

    // “cartera” opcional (compatibilidad)
    cartera: { type: String, default: "", trim: true, index: true },

    // Clave lógica (dni-entidad-subcesion[-cuotaNumero])
    idCuotaLogico: { type: String, trim: true },

    // Datos de la cuota
    vencimiento: { type: Number, min: 1, max: 31 },
    cuotaNumero: { type: Number, min: 0 },
    importeCuota: { type: Number, required: true, min: 0 },

    // Pagos
    pagos: { type: [PagoSchema], default: [] },
    pagosInformados: { type: [PagoInformadoSchema], default: [] },

    // Saldo / deuda
    saldoPendiente: { type: Number, default: 0, min: 0 },
    deudaPorMes: { type: [DeudaMesSchema], default: [] },

    // Otros
    observaciones: { type: String, trim: true },
    observacionesOperador: { type: String, default: "", trim: true },
    fiduciario: { type: String, trim: true },
    vecesTocada: { type: Number, default: 0, min: 0 },
    ultimaGestion: { type: Date, default: null },
    gestor: { type: String, default: "", trim: true },
    telefono: { type: String, trim: true },

    // Timestamps manuales (mantengo los tuyos)
    creado: { type: Date, default: Date.now },
    ultimaModificacion: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);

// Índices
ColchonSchema.index({ idCuotaLogico: 1 }, { unique: true, sparse: true }); // evita duplicados lógicos
ColchonSchema.index({ entidadId: 1, subCesionId: 1 });
ColchonSchema.index({ estado: 1 });
ColchonSchema.index({ creado: 1 });
ColchonSchema.index({ empleadoId: 1, estado: 1 });
ColchonSchema.index({ cartera: 1, estado: 1 });
// búsqueda libre (nombre/cartera/fiduciario/gestor/telefono)
ColchonSchema.index({ nombre: "text", cartera: "text", fiduciario: "text", gestor: "text", telefono: "text" });

// Autogenerar idCuotaLogico si no viene
ColchonSchema.pre("save", function (next) {
  if (!this.idCuotaLogico) {
    const base = `${this.dni}-${this.entidadId}-${this.subCesionId}`;
    this.idCuotaLogico =
      typeof this.cuotaNumero === "number"
        ? `${base}-${this.cuotaNumero}`
        : base;
  }
  this.ultimaModificacion = new Date();
  next();
});

// Normaliza strings de primer nivel (defensivo)
ColchonSchema.pre("validate", function (next) {
  ["nombre", "cartera", "estadoOriginal", "turno", "fiduciario", "gestor", "telefono", "observaciones", "observacionesOperador"].forEach((k) => {
    if (typeof this[k] === "string") this[k] = this[k].trim();
  });
  next();
});

export default mongoose.model("Colchon", ColchonSchema);
