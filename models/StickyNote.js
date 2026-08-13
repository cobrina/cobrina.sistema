import mongoose from "mongoose";

const COLORS = ["yellow", "green", "blue", "pink", "orange", "purple"];
const STATUSES = ["pendiente", "en-curso", "en-espera", "finalizada"];
const PRIORITIES = ["baja", "media", "alta"];

const StickyNoteSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Empleado",
      index: true,
      required: true,
    },
    // title/status/month turn the old sticky-note collection into a personal
    // Kanban board without discarding existing records.
    title: { type: String, default: "", trim: true, maxlength: 140 },
    text: { type: String, default: "", maxlength: 4000 },
    color: { type: String, enum: COLORS, default: "yellow" },
    status: { type: String, enum: STATUSES, default: "pendiente", index: true },
    priority: { type: String, enum: PRIORITIES, default: "media", index: true },
    month: {
      type: String,
      default: "",
      validate: {
        validator: (value) => !value || /^\d{4}-\d{2}$/.test(value),
        message: "El mes debe tener formato YYYY-MM",
      },
      index: true,
    },
    dueDate: { type: Date, default: null, index: true },
    completedAt: { type: Date, default: null },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

StickyNoteSchema.index({ userId: 1, status: 1, order: 1 });
StickyNoteSchema.index({ userId: 1, month: 1, status: 1 });
StickyNoteSchema.index({ updatedAt: 1 });

export default mongoose.model("StickyNote", StickyNoteSchema);
export const STICKY_COLORS = COLORS;
export const STICKY_STATUSES = STATUSES;
export const STICKY_PRIORITIES = PRIORITIES;
