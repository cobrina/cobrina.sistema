import mongoose from "mongoose";

const { Schema } = mongoose;

const OperadorSchema = new Schema(
  {
    username: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    nombre: { type: String, default: "", trim: true, maxlength: 160 },
  },
  { _id: false }
);

const TemaSchema = new Schema(
  {
    clave: { type: String, required: true, trim: true, maxlength: 80 },
    label: { type: String, default: "", trim: true, maxlength: 160 },
    detalle: { type: String, default: "", trim: true, maxlength: 3000 },
  },
  { _id: false }
);

const AuditoriaRefSchema = new Schema(
  {
    auditoriaId: { type: Schema.Types.ObjectId, ref: "AuditoriaContactoDirecto", required: true },
    fechaAuditoria: { type: Date, default: null },
    scoreFinal: { type: Number, default: null },
    semaforo: { type: String, default: "", trim: true, maxlength: 40 },
    tipoInterlocutor: { type: String, default: "", trim: true, maxlength: 60 },
    puntosAMejorar: { type: String, default: "", trim: true, maxlength: 6000 },
    puntosPositivos: { type: String, default: "", trim: true, maxlength: 6000 },
    observacionesGenerales: { type: String, default: "", trim: true, maxlength: 6000 },
    dnis: { type: [String], default: [] },
    telefonos: { type: [String], default: [] },
  },
  { _id: false }
);

const DudaSchema = new Schema(
  {
    area: { type: String, default: "OTRO", trim: true, maxlength: 80 },
    duda: { type: String, required: true, trim: true, maxlength: 4000 },
    resolucion: {
      type: String,
      enum: ["RESUELTA", "PARCIAL", "PENDIENTE"],
      default: "RESUELTA",
      index: true,
    },
    derivarA: { type: String, default: "", trim: true, maxlength: 120 },
    respuesta: { type: String, default: "", trim: true, maxlength: 4000 },
  },
  { _id: true }
);

const CompromisoSchema = new Schema(
  {
    texto: { type: String, required: true, trim: true, maxlength: 4000 },
    responsable: {
      type: String,
      enum: ["OPERADOR", "CAPACITADORA", "SUPERVISION", "SISTEMAS", "OTRO"],
      default: "OPERADOR",
    },
    fechaObjetivo: { type: Date, default: null },
    requiereSeguimiento: { type: Boolean, default: false },
    cumplido: { type: Boolean, default: false },
  },
  { _id: true }
);

const SeguimientoSchema = new Schema(
  {
    fecha: { type: Date, default: Date.now },
    resultado: {
      type: String,
      required: true,
      enum: ["MEJORO", "MEJORA_PARCIAL", "PERSISTE", "SIN_INFO"],
    },
    observacion: { type: String, default: "", trim: true, maxlength: 6000 },
    realizadoPor: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    auditoriasNuevas: { type: [Schema.Types.ObjectId], default: [] },
  },
  { _id: true, timestamps: true }
);

const CapacitacionSchema = new Schema(
  {
    operadores: {
      type: [OperadorSchema],
      default: [],
      validate: [
        (arr) => Array.isArray(arr) && arr.length >= 1 && arr.length <= 40,
        "Debe existir al menos un operador y como máximo 40.",
      ],
    },
    capacitadoraUsername: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
      maxlength: 120,
    },
    creadaPorUsername: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 120,
    },
    asignadaPorUsername: { type: String, default: "", trim: true, lowercase: true, maxlength: 120 },

    fechaCapacitacion: { type: Date, default: Date.now, index: true },
    horaInicio: { type: String, default: "", trim: true, maxlength: 5 },
    horaFin: { type: String, default: "", trim: true, maxlength: 5 },
    duracionMinutos: { type: Number, default: 0, min: 0, max: 1440 },

    tipoCapacitacion: {
      type: String,
      enum: ["INDIVIDUAL", "GRUPAL"],
      default: "INDIVIDUAL",
    },
    modalidad: {
      type: String,
      enum: ["PRESENCIAL", "MEET", "TELEFONICA", "OTRA"],
      default: "PRESENCIAL",
    },
    estado: {
      type: String,
      enum: ["PENDIENTE", "EN_CAPACITACION", "REALIZADA", "REQUIERE_SEGUIMIENTO", "CERRADA"],
      default: "PENDIENTE",
      index: true,
    },

    motivos: { type: [String], default: [] },
    origen: {
      type: String,
      enum: ["AUDITORIA", "REPORTE_GESTIONES", "SEGUIMIENTO", "CONSULTA_OPERADOR", "SUPERVISION", "GENERAL", "OTRO"],
      default: "GENERAL",
      index: true,
    },
    notaAsignacion: { type: String, default: "", trim: true, maxlength: 6000 },
    focosAsignados: { type: [String], default: [] },
    periodoGestiones: {
      desde: { type: Date, default: null },
      hasta: { type: Date, default: null },
    },
    agendaProgramada: {
      fechaClave: { type: String, default: "", match: /^$|^\d{4}-\d{2}-\d{2}$/ },
      hora: { type: String, default: "", match: /^$|^([01]\d|2[0-3]):[0-5]\d$/ },
      avisarMinutosAntes: { type: Number, default: 15, min: 0, max: 1440 },
      agendaItemIds: { type: [Schema.Types.ObjectId], default: [] },
      actualizadaPorUsername: { type: String, default: "", trim: true, lowercase: true, maxlength: 120 },
    },

    temasGestion: { type: [TemaSchema], default: [] },
    herramientas: { type: [TemaSchema], default: [] },
    materiales: { type: [String], default: [] },

    recepcion: {
      type: String,
      enum: ["", "MUY_RECEPTIVO", "RECEPTIVO", "NEUTRAL", "RESISTENCIA", "NO_ACUERDO"],
      default: "",
    },
    participacion: {
      type: String,
      enum: ["", "ALTA", "MEDIA", "BAJA"],
      default: "",
    },
    comprension: {
      type: String,
      enum: ["", "COMPRENDIO", "PARCIAL", "REQUIERE_REFUERZO"],
      default: "",
    },
    reconocePuntos: {
      type: String,
      enum: ["", "SI", "PARCIAL", "NO"],
      default: "",
    },
    observacionCapacitadora: { type: String, default: "", trim: true, maxlength: 12000 },
    fortalezas: { type: String, default: "", trim: true, maxlength: 8000 },
    puntoPrincipalReforzar: { type: String, default: "", trim: true, maxlength: 8000 },
    recomendacionSupervision: { type: String, default: "", trim: true, maxlength: 8000 },
    hallazgos: { type: [String], default: [] },
    dudas: { type: [DudaSchema], default: [] },
    compromisos: { type: [CompromisoSchema], default: [] },

    requiereSeguimiento: { type: Boolean, default: false, index: true },
    fechaSeguimiento: { type: Date, default: null, index: true },
    seguimientos: { type: [SeguimientoSchema], default: [] },

    auditorias: { type: [AuditoriaRefSchema], default: [] },

    cerradaAt: { type: Date, default: null },
    borrado: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, versionKey: false }
);

CapacitacionSchema.index({ "operadores.username": 1, fechaCapacitacion: -1 });
CapacitacionSchema.index({ estado: 1, fechaSeguimiento: 1 });
CapacitacionSchema.index({ "auditorias.auditoriaId": 1 });
CapacitacionSchema.index({ createdAt: -1 });

export default mongoose.model("Capacitacion", CapacitacionSchema);
