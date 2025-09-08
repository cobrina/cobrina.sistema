import mongoose from "mongoose";

const toUpper = (s) => String(s ?? "").trim().toUpperCase();

const EntidadSchema = new mongoose.Schema(
  {
    numero: { type: Number, required: true, unique: true },
    nombre: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      set: toUpper, // ← normaliza
    },
  },
  { timestamps: true }
);

EntidadSchema.pre("findOneAndUpdate", function (next) {
  const upd = this.getUpdate() || {};
  const $set = upd.$set || upd;
  if ($set.nombre != null) $set.nombre = toUpper($set.nombre);
  if (upd.$set) upd.$set = $set; else Object.assign(upd, $set);
  this.setUpdate(upd);
  next();
});

export default mongoose.model("Entidad", EntidadSchema);
