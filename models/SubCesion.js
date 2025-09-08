import mongoose from "mongoose";

const toUpper = (s) => String(s ?? "").trim().toUpperCase();

const SubCesionSchema = new mongoose.Schema(
  {
    nombre: {
      type: String,
      required: true,
      unique: true,     // un solo nombre en todo el catálogo
      set: toUpper,     // ← normaliza al asignar (create/save)
    },
  },
  { timestamps: true }
);

// También normaliza en actualizaciones tipo findOneAndUpdate
SubCesionSchema.pre("findOneAndUpdate", function (next) {
  const upd = this.getUpdate() || {};
  const $set = upd.$set || upd;
  if ($set.nombre != null) $set.nombre = toUpper($set.nombre);
  if (upd.$set) upd.$set = $set; else Object.assign(upd, $set);
  this.setUpdate(upd);
  next();
});

export default mongoose.model("SubCesion", SubCesionSchema);
