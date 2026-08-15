import mongoose from "mongoose";

const { Schema } = mongoose;

const ContactadoVentanaSchema = new Schema(
  {
    serieId: { type: String, required: true, index: true, trim: true, maxlength: 80 },
    // Mes calendario argentino en el que nació el Contactado que originó la serie.
    // Permite que cada mes sea un universo independiente sin arrastrar casos previos.
    mesOrigen: { type: String, default: "", index: true, trim: true, maxlength: 7 },
    gestionInicioKey: { type: String, required: true, unique: true, index: true, maxlength: 80 },
    gestionResolucionKey: { type: String, default: "", index: true, maxlength: 80 },
    gestionInicioId: { type: Schema.Types.ObjectId, ref: "ReporteGestion", default: null },
    gestionResolucionId: { type: Schema.Types.ObjectId, ref: "ReporteGestion", default: null },

    dni: { type: String, required: true, index: true, trim: true },
    nombreDeudor: { type: String, default: "", trim: true, maxlength: 240 },
    operador: { type: String, required: true, index: true, trim: true, lowercase: true },
    entidad: { type: String, default: "", index: true, trim: true, maxlength: 120 },
    entidadNumero: { type: Number, default: null, index: true },

    telefonoOriginal: { type: String, default: "", trim: true, maxlength: 1000 },
    telefonoVisible: { type: String, default: "", trim: true, maxlength: 80 },
    whatsappNumero: { type: String, default: "", trim: true, maxlength: 30 },
    whatsappDisponible: { type: Boolean, default: false },

    iniciaAt: { type: Date, required: true, index: true },
    alertaAt: { type: Date, required: true, index: true },
    criticoAt: { type: Date, required: true, index: true },
    venceAt: { type: Date, required: true, index: true },
    cerradaAt: { type: Date, default: null, index: true },

    estado: {
      type: String,
      enum: ["abierta", "renovada_anticipada", "cumplida", "vencida", "reasignada"],
      default: "abierta",
      index: true,
    },
    esOrigenContactado: { type: Boolean, default: false },

    calificacionInicio: { type: String, default: "", maxlength: 240 },
    tipoContactoInicio: { type: String, default: "", maxlength: 180 },
    estadoCuentaInicio: { type: String, default: "", maxlength: 180 },
    observacionGestionInicio: { type: String, default: "", maxlength: 3000 },

    calificacionResolucion: { type: String, default: "", maxlength: 240 },
    tipoContactoResolucion: { type: String, default: "", maxlength: 180 },
    estadoCuentaResolucion: { type: String, default: "", maxlength: 180 },

    clickRealizadoAt: { type: Date, default: null, index: true },
    clickRealizadoPor: { type: String, default: "", trim: true, lowercase: true, maxlength: 120 },
  },
  { timestamps: true, versionKey: false }
);

ContactadoVentanaSchema.index({ mesOrigen: 1, estado: 1, operador: 1, venceAt: 1 });
ContactadoVentanaSchema.index({ estado: 1, operador: 1, venceAt: 1 });
ContactadoVentanaSchema.index({ estado: 1, venceAt: 1, operador: 1 });
ContactadoVentanaSchema.index({ dni: 1, operador: 1, iniciaAt: -1 });
ContactadoVentanaSchema.index({ serieId: 1, iniciaAt: 1 });
ContactadoVentanaSchema.index({ estado: 1, cerradaAt: -1 });
ContactadoVentanaSchema.index({ mesOrigen: 1, esOrigenContactado: 1, iniciaAt: 1 });

export default mongoose.model("ContactadoVentana", ContactadoVentanaSchema, "contactados_ventanas");
