// models/JobProceso.js
import mongoose from "mongoose";

const { Schema, Types } = mongoose;

const JOB_TIPOS = ["IMPORT_PAGOS", "IMPORT_ESTADOS", "IMPORT_REMESAS"];
const JOB_ESTADOS = ["EN_PROCESO", "OK", "ERROR"];

const JobProcesoSchema = new Schema(
  {
    tipo: {
      type: String,
      enum: JOB_TIPOS,
      required: true,
    },
    estado: {
      type: String,
      enum: JOB_ESTADOS,
      default: "EN_PROCESO",
      index: true,
    },
    iniciadoPor: {
      type: Types.ObjectId,
      ref: "Empleado", // quien inició el proceso
      required: true,
    },
    iniciadoEn: {
      type: Date,
      default: Date.now,
      index: true,
    },
    finalizadoEn: {
      type: Date,
      default: null,
    },
    archivoHash: {
      type: String, // opcional: hash del archivo subido, útil para detectar duplicados
      default: null,
    },
    progreso: {
      type: Number, // 0–100
      default: 0,
    },
    detalleError: {
      type: String,
      default: null,
    },
  },
  {
    versionKey: false,
    timestamps: false,
  }
);

// models/JobProceso.js (debajo de const JobProcesoSchema = new Schema(...))
JobProcesoSchema.index(
  { tipo: 1, estado: 1 },
  { unique: true, partialFilterExpression: { estado: "EN_PROCESO" }, name: "uk_job_unico_en_proceso" }
);

const JobProceso = mongoose.model("JobProceso", JobProcesoSchema);

export default JobProceso;
export { JOB_TIPOS, JOB_ESTADOS };
