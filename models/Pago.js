// models/Pago.js
import mongoose from "mongoose";
import Counter from "./Counter.js"; // ⬅️ necesario para autoincrementar idPago

const { Schema, Types } = mongoose;

/** Estados permitidos (se cambian SOLO por import masivo) */
export const PAGO_ESTADOS = ["INGRESADO", "VERIFICADO", "REMESADO", "FACTURADO"];

/** Conceptos (sigla -> texto para mostrar en la vista y export) */
export const CONCEPTOS_MAP = {
  PGPR: "Pago Parcial",
  PGTOT: "Pago Total",
  PGAD: "Adelanto/Anticipo",
  PGCUO: "Cuota",
  PGFIN: "Cuota Final",
  ANTCAN: "Anticipo Cancelación",
};

const PagoSchema = new Schema(
  {
    // ⬇️ ID corto numérico, único y requerido
    idPago: {
      type: Number,
      unique: true,
      index: true,
      required: [true, "ID_PAGO es obligatorio"],
    },

    /* Identificación de persona */
    dni: {
      type: String,
      required: [true, "DNI es obligatorio"],
      trim: true,
      index: true,
    },
    titularNombre: {
      type: String,
      required: [true, "El nombre del titular es obligatorio"],
      trim: true,
    },

    /* Catálogos (mismos que usa Colchón) */
    // ENTIDAD: guardamos el número (ej: 1 = CREDITIA)
    entidadId: {
      type: Number,
      required: [true, "ENTIDAD_ID es obligatorio"],
      index: true,
    },
    // SUBCESIÓN ≡ Cartera (referencia al catálogo existente)
    subCesionId: {
      type: Types.ObjectId,
      ref: "SubCesion",
      required: [true, "SUBCESION_ID es obligatorio"],
      index: true,
    },

    /* Datos del pago */
    conceptoCodigo: {
      type: String,
      required: [true, "CONCEPTO es obligatorio"],
      enum: Object.keys(CONCEPTOS_MAP),
    },
    fechaPago: {
      type: Date,
      required: [true, "FECHA_PAGO es obligatoria"],
      index: true,
    },
    monto: {
      type: Number,
      required: [true, "MONTO es obligatorio"],
      min: [0, "MONTO debe ser >= 0"],
    },

    /* Operador (empleado) */
    // guardamos username (obligatorio) y opcionalmente el _id resuelto
    operadorUsername: {
      type: String,
      required: [true, "OPERADOR (username) es obligatorio"],
      trim: true,
      lowercase: true,
      index: true,
    },
    operadorId: {
      type: Types.ObjectId,
      ref: "Empleado",
      default: null,
      index: true,
    },

    /* Datos internos */
    cuentaDestino: { type: String, trim: true, default: "" },
    nroRemesa: {
      type: String,
      trim: true,
      default: "",
      index: true,
      validate: {
        validator: (v) => !v || /^[A-Za-z0-9._-]+$/.test(v),
        message: "NRO_REMESA solo permite letras, números, '-', '_' o '.'",
      },
    },

    /* Estado (solo se cambia por import masivo) */
    estado: {
      type: String,
      enum: PAGO_ESTADOS,
      default: "INGRESADO",
      index: true,
    },

    /* Observaciones */
    observaciones: { type: String, trim: true, default: "" },

    /* Auditoría opcional */
    creadoPor: { type: Types.ObjectId, ref: "Empleado", default: null },
    modificadoPor: { type: Types.ObjectId, ref: "Empleado", default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* ---------- Hooks ---------- */
/** Asigna idPago autoincremental si no viene seteado (solo en creación) */
PagoSchema.pre("validate", async function (next) {
  try {
    if (this.isNew && (this.idPago === undefined || this.idPago === null)) {
      const c = await Counter.findOneAndUpdate(
        { sequenceName: "pagos" },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
      this.idPago = c.seq;
    }
    next();
  } catch (err) {
    next(err);
  }
});

/* Virtual: texto amigable del concepto para UI/export */
PagoSchema.virtual("conceptoTexto").get(function () {
  return CONCEPTOS_MAP[this.conceptoCodigo] || this.conceptoCodigo;
});

/* Normalizaciones suaves */
PagoSchema.pre("validate", function (next) {
  if (typeof this.titularNombre === "string") {
    this.titularNombre = this.titularNombre.trim().toUpperCase();
  }
  if (typeof this.conceptoCodigo === "string") {
    this.conceptoCodigo = this.conceptoCodigo.trim().toUpperCase();
  }
  if (typeof this.estado === "string") {
    this.estado = this.estado.trim().toUpperCase();
  }
  if (typeof this.dni === "string") this.dni = this.dni.trim();
  next();
});

/* ---------- ÍNDICES ---------- */
/* Clave única de negocio para detectar duplicados al importar pagos:
   (dni, entidadId, subCesionId, fechaPago, monto)
   Sugerencia: al importar, normalizá fechaPago al inicio del día (00:00)
   para evitar duplicados falsos por hora/minuto. */
PagoSchema.index(
  { dni: 1, entidadId: 1, subCesionId: 1, fechaPago: 1, monto: 1 },
  { unique: true, name: "uk_pago_clave_negocio" }
);

/* Lecturas frecuentes / filtros */
PagoSchema.index(
  { entidadId: 1, subCesionId: 1, estado: 1, fechaPago: -1, _id: -1 },
  { name: "idx_listado_principal" }
);
PagoSchema.index({ nroRemesa: 1, _id: -1 }, { name: "idx_por_remesa" });
PagoSchema.index({ dni: 1, fechaPago: -1, _id: -1 }, { name: "idx_por_dni_fecha" });

/* Índice único explícito del idPago (ya marcado arriba en el campo) */
PagoSchema.index({ idPago: 1 }, { unique: true, name: "uk_idPago" });

const Pago = mongoose.model("Pago", PagoSchema);
export default Pago;
