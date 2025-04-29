import express from "express";
import {heartbeat } from "../controllers/authController.js"; // 👈 Agregamos heartbeat
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { check, validationResult } from "express-validator";
import rateLimit from "express-rate-limit";
import Empleado from "../models/Empleado.js";
import verifyToken from "../middleware/verifyToken.js";

dotenv.config();

const router = express.Router();

// 🛡️ Limitar intentos de login: máximo 5 intentos cada 15 minutos
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    error: "Demasiados intentos fallidos. Intenta nuevamente en 15 minutos.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// 🟢 LOGIN - POST /auth/login
router.post(
  "/login",
  loginLimiter,
  [
    check("username", "⚠️ El nombre de usuario es obligatorio").notEmpty().isLength({ min: 3 }),
    check("password", "⚠️ La contraseña es obligatoria").notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

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

      const token = jwt.sign(
        {
          id: empleado._id,
          username: empleado.username,
          role: empleado.role,
        },
        process.env.JWT_SECRET,
        { expiresIn: "1d" }
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
  }
);

// Nuevo: Heartbeat
router.post("/heartbeat", verifyToken, heartbeat);

// 🔐 Ruta protegida de prueba
router.get("/protegido", verifyToken, (req, res) => {
  res.json({
    message: "Acceso autorizado",
    user: req.user,
  });
});

export default router;
