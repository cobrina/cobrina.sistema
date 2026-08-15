import mongoose from "mongoose";

const ContactadoSyncStateSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: "global" },
    mesClave: { type: String, default: "", index: true, maxlength: 7 },
    ultimoCreatedAt: { type: Date, default: null },
    ultimaEjecucionAt: { type: Date, default: null },
    eventosProcesados: { type: Number, default: 0 },
    gestionesLeidas: { type: Number, default: 0 },
    contactadosDetectados: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

export default mongoose.model("ContactadoSyncState", ContactadoSyncStateSchema, "contactados_sync_state");
