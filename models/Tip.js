// models/Tip.js
import mongoose from "mongoose";

const TipSchema = new mongoose.Schema(
  {
    title:       { type: String, required: true, trim: true },
    bodyMd:      { type: String, default: "" },
    categories:  [{ type: String, trim: true }],
    visibility:  { type: String, enum: ["all", "admin"], default: "all" },
    isActive:    { type: Boolean, default: true },

    // auditoría básica
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: "Usuario" },
    updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "Usuario" },
  },
  { timestamps: true }
);

export default mongoose.model("Tip", TipSchema);
