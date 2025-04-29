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
    type: String,
    required: [true, "El correo es obligatorio"],
    validate: {
      validator: function (v) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      },
      message: "El correo no es válido"
    }
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
  ultimaActividad: { 
    type: Date, 
    default: Date.now 
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

export default mongoose.model("Empleado", empleadoSchema);
