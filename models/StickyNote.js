import mongoose from "mongoose";

const COLORS = ["yellow", "green", "blue", "pink", "orange", "purple"];

const StickyNoteSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Empleado", index: true, required: true },
    text: { type: String, default: "", maxlength: 1000 },
    color: { type: String, enum: COLORS, default: "yellow" },
    order: { type: Number, default: 0 }, // para ordenar en el tablero
  },
  { timestamps: true }
);

export default mongoose.model("StickyNote", StickyNoteSchema);
export const STICKY_COLORS = COLORS;
