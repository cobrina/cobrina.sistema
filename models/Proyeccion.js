// models/Proyeccion.js
import mongoose from "mongoose";

/* ───────────── Subdocumento: pagos informados ───────────── */
const PagoInformadoSchema = new mongoose.Schema(
  {
    fecha:      { type: Date, required: true },
    monto:      { type: Number, required: true, min: [0.01, "Monto > 0"] },
    operadorId: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", required: true },

    // flags erróneo
    erroneo:     { type: Boolean, default: false },
    motivoError: { type: String, default: "" },
    marcadoPor:  { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", default: null },
    marcadoEn:   { type: Date, default: null },
  },
  { _id: true }
);

/* ───────────── Schema principal ───────────── */
const proyeccionSchema = new mongoose.Schema(
  {
    dni: { type: Number, required: true, index: true },

    nombreTitular: { type: String, default: "", trim: true },

    // Monto comprometido
    importe: { type: Number, required: true, min: [0.01, "Importe > 0"] },

    // Ant-Can / Anticipo / Cancelación / Parcial / Posible / Cuota
    concepto: {
      type: String,
      enum: ["Ant-Can", "Anticipo", "Cancelación", "Parcial", "Posible", "Cuota"],
      required: false,
    },

    // Fechas clave
    fechaPromesa: { type: Date },
    fechaPromesaInicial: { type: Date }, // para detectar Reprogramado
    fechaProximoLlamado: { type: Date, index: true },

    // Cobrado (se recalcula desde pagosInformados al informar pago)
    importePagado: { type: Number, default: 0, min: 0 },

    // Estado de la promesa
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
        // ── ESTADOS DE CIERRE ──
        "Cerrada cumplida",
        "Cerrada pago parcial",
        "Cerrada incumplida",
      ],
      default: "Pendiente",
      index: true,
    },

    // Control 1-activa (regla de negocio)
    isActiva: { type: Boolean, default: true, index: true },

    /* ───────── Reemplazos de reglas de oro ───────── */
    // Cartera → Entidad
    entidadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Entidad",
      required: true,
      index: true,
    },
    // Fiduciario → SubCesión
    subCesionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubCesion",
      required: true,
      index: true,
    },

    // ID lógico: `${dni}-${entidadId}-${subCesionId}`
    // (indexado, NO único: la unicidad la aplica el índice parcial de "activa")
    idProyeccionLogico: {
      type: String,
      required: true,
      index: true,
    },

    // Contacto (opcional)
    telefono: { type: String, default: "", trim: true },

    // Observaciones
    observaciones: { type: String, default: "", trim: true },

    // Propietario / creador
    empleadoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Empleado",
      required: true,
      index: true,
    },

    // Trazabilidad propia
    creado: { type: Date, default: Date.now },
    ultimaModificacion: { type: Date, default: Date.now },

    // Derivados para filtros rápidos
    mes:  { type: Number, required: true },
    anio: { type: Number, required: true },

    // Gestión telefónica
    vecesTocada:    { type: Number, default: 0 },
    ultimaGestion:  { type: Date, default: null },

    // Pagos informados (fecha + monto + operador)
    pagosInformados: { type: [PagoInformadoSchema], default: [] },
  },
  {
    timestamps: true,   // createdAt / updatedAt
    versionKey: false,
  }
);

/* ───────────── Índices útiles ───────────── */
proyeccionSchema.index({ fechaPromesa: 1 });
proyeccionSchema.index({ empleadoId: 1, fechaPromesa: -1 });
proyeccionSchema.index({ anio: 1, mes: 1 });
proyeccionSchema.index({ "pagosInformados.fecha": -1 });

// búsquedas frecuentes por documento (nuevo esquema)
proyeccionSchema.index({ dni: 1, entidadId: 1, subCesionId: 1 });

// combinación común para listados/estadísticas (nuevo esquema)
proyeccionSchema.index({ estado: 1, entidadId: 1 });
proyeccionSchema.index({ estado: 1, subCesionId: 1 });

/* ── ÚNICA ACTIVA POR DNI+ENTIDAD+SUBCESION ───────────────── */
proyeccionSchema.index(
  { dni: 1, entidadId: 1, subCesionId: 1, isActiva: 1 },
  { unique: true, partialFilterExpression: { isActiva: true } }
);

/* ───────────── Hooks de consistencia ───────────── */

// Completar anio/mes y fechaPromesaInicial + idProyeccionLogico ANTES de validar
proyeccionSchema.pre("validate", function (next) {
  // normalización de strings
  if (typeof this.telefono === "string") this.telefono = this.telefono.trim();
  if (typeof this.nombreTitular === "string") this.nombreTitular = this.nombreTitular.trim();
  if (typeof this.observaciones === "string") this.observaciones = this.observaciones.trim();

  if (this.fechaPromesa instanceof Date && !isNaN(this.fechaPromesa)) {
    const d = new Date(this.fechaPromesa);
    if (!this.anio) this.anio = d.getFullYear();
    if (!this.mes)  this.mes  = d.getMonth() + 1;
    if (!this.fechaPromesaInicial) this.fechaPromesaInicial = this.fechaPromesa;
  }

  // saneo de montos
  if (!Number.isFinite(this.importePagado) || this.importePagado < 0) {
    this.importePagado = 0;
  }

  // id lógico
  if (this.dni && this.entidadId && this.subCesionId) {
    const ent = String(this.entidadId);
    const sub = String(this.subCesionId);
    this.idProyeccionLogico = `${this.dni}-${ent}-${sub}`;
  }

  next();
});

// Mantener ultimaModificacion actualizado siempre que se guarde
proyeccionSchema.pre("save", function (next) {
  this.ultimaModificacion = new Date();

  // asegurar id lógico en save también
  if (this.dni && this.entidadId && this.subCesionId) {
    const ent = String(this.entidadId);
    const sub = String(this.subCesionId);
    this.idProyeccionLogico = `${this.dni}-${ent}-${sub}`;
  }

  next();
});

// Si se actualiza por query, recalcular anio/mes e idProyeccionLogico
proyeccionSchema.pre("findOneAndUpdate", async function (next) {
  const upd = this.getUpdate() || {};
  const $set = upd.$set ? { ...upd.$set } : { ...upd };

  // Fecha → anio/mes/fechaPromesaInicial
  if ($set.fechaPromesa) {
    const d = new Date($set.fechaPromesa);
    if (!isNaN(d)) {
      $set.anio = d.getFullYear();
      $set.mes  = d.getMonth() + 1;
      if (!$set.fechaPromesaInicial) $set.fechaPromesaInicial = $set.fechaPromesa;
    }
  }

  // saneo de montos
  if (typeof $set.importePagado === "number" && $set.importePagado < 0) {
    $set.importePagado = 0;
  }

  // Recalcular idProyeccionLogico con los valores nuevos o actuales
  const needIdLogic =
    $set.dni !== undefined || $set.entidadId !== undefined || $set.subCesionId !== undefined;

  if (needIdLogic) {
    const current = await this.model.findOne(this.getQuery()).select("dni entidadId subCesionId").lean();
    const dni = $set.dni !== undefined ? $set.dni : current?.dni;
    const entidadId = $set.entidadId !== undefined ? $set.entidadId : current?.entidadId;
    const subCesionId = $set.subCesionId !== undefined ? $set.subCesionId : current?.subCesionId;

    if (dni && entidadId && subCesionId) {
      $set.idProyeccionLogico = `${dni}-${String(entidadId)}-${String(subCesionId)}`;
    }
  }

  $set.ultimaModificacion = new Date();

  if (upd.$set) this.setUpdate({ ...upd, $set });
  else this.setUpdate($set);

  next();
});

export default mongoose.model("Proyeccion", proyeccionSchema);
