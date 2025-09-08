// models/Empleado.js
import mongoose from "mongoose";

const EmpleadoSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, "El nombre de usuario es obligatorio"],
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 50,
    },
    nombre: {
      type: String,
      trim: true,
      default: "",
      maxlength: 120,
    },
    password: {
      type: String,
      required: [true, "La contraseña es obligatoria"],
      select: false,
    },
    email: {
      type: String,
      required: [true, "El correo es obligatorio"],
      unique: true,
      trim: true,
      lowercase: true,
      validate: {
        validator(v) {
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        },
        message: "El correo no es válido",
      },
    },
    imagen: {
      type: String,
      default: "/user.png",
      trim: true,
    },
    role: {
      type: String,
      enum: ["operador", "operador-vip", "admin", "super-admin"],
      default: "operador",
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    ultimaActividad: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        delete ret.password;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// índices adicionales (no duplicar username/email)
EmpleadoSchema.index({ role: 1, isActive: 1 });

EmpleadoSchema.pre("validate", function (next) {
  if (typeof this.username === "string") this.username = this.username.trim().toLowerCase();
  if (typeof this.email === "string") this.email = this.email.trim().toLowerCase();
  if (typeof this.nombre === "string") this.nombre = this.nombre.trim();
  next();
});

export default mongoose.model("Empleado", EmpleadoSchema);
