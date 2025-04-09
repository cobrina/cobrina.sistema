import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import Empleado from "../models/Empleado.js";
import dotenv from "dotenv";
import verifyToken from "../middleware/verifyToken.js";
import rateLimit from "express-rate-limit";

dotenv.config();

const router = express.Router();

// 🛡️ Limitar intentos de login: máximo 5 intentos cada 15 minutos
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // máximo 5 intentos por IP
  message: {
    error: "Demasiados intentos fallidos. Intenta nuevamente en 15 minutos.",
  },
  standardHeaders: true, // devuelve info en headers estándar
  legacyHeaders: false, // desactiva headers antiguos
});

// 🟢 LOGIN - POST /auth/login
router.post("/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  try {
    const empleado = await Empleado.findOne({ username });

    if (!empleado) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const match = await bcrypt.compare(password, empleado.password);

    if (!match) {
      return res.status(401).json({ error: "Contraseña incorrecta" });
    }

    // Crear token
    const token = jwt.sign(
      {
        id: empleado._id,
        username: empleado.username,
        role: empleado.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" } // dura 1 día
    );

    res.json({
      message: "Login exitoso",
      token,
      user: {
        id: empleado._id,
        username: empleado.username,
        role: empleado.role,
      },
    });
  } catch (error) {
    console.error("❌ Error en login:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Ruta protegida de prueba
router.get("/protegido", verifyToken, (req, res) => {
  res.json({
    message: "Acceso autorizado",
    user: req.user, // acá viene el id, username y role desde el token
  });
});

export default router;
