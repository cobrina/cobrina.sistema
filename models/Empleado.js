import mongoose from "mongoose";

const empleadoSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, "El nombre de usuario es obligatorio"],
    unique: true,
    trim: true
  },
  password: {
    type: String,
    required: [true, "La contraseña es obligatoria"]
  },
  email: {
    type: String // ✅ Email opcional para todos los roles
  },
  imagen: {
    type: String,
    default: "/user.png"
  },
  role: {
    type: String,
    enum: ["operador", "admin", "super-admin"],
    default: "operador"
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// ✅ Se eliminó la validación que obligaba el email para admin/super-admin

export default mongoose.model("Empleado", empleadoSchema);
