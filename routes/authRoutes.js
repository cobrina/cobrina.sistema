// routes/authRoutes.js
import express from "express";
import { heartbeat } from "../controllers/authController.js";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { check, validationResult } from "express-validator";
import rateLimit from "express-rate-limit";
import Empleado from "../models/Empleado.js";
import verifyToken from "../middleware/verifyToken.js";
import { getEffectiveRole } from "../config/roles.js";
import { firmarTokenSesion, obtenerConfiguracionVencimiento } from "../utils/jwtSesion.js";

dotenv.config();

const router = express.Router();

// 🔐 sanity check JWT secret
if (!process.env.JWT_SECRET) {
  console.warn("⚠️ JWT_SECRET no está definido. Configuralo en el .env");
}

// 🛡️ Rate limit login: 5/15m
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Demasiados intentos fallidos. Probá en 15 minutos." },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// 🟢 POST /auth/login
// 🟢 POST /auth/login
router.post(
  "/login",
  loginLimiter,
  [
    check("username", "⚠️ El nombre de usuario es obligatorio").trim().isLength({ min: 3 }),
    check("password", "⚠️ La contraseña es obligatoria").notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const usernameRaw = String(req.body.username || "");
    const password = String(req.body.password || "");
    const username = usernameRaw.trim();

    try {
      // Buscar por username (case-insensitive) y traer el hash + isActive
      const empleado = await Empleado.findOne({
        username: {
          $regex: new RegExp(`^${username.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}$`, "i"),
        },
      }).select("+password role username email ultimaActividad isActive");

      if (!empleado) {
        // mismo status para no revelar si existe o no
        return res.status(401).json({ error: "Usuario o contraseña inválidos" });
      }

      if (!empleado.password) {
        return res.status(500).json({ error: "Cuenta sin contraseña definida" });
      }

      // ✅ Si el usuario está inactivo, bloquear login
      if (empleado.isActive === false) {
        return res.status(403).json({ error: "Usuario inactivo" });
      }

      const ok = await bcrypt.compare(password, empleado.password);
      if (!ok) {
        return res.status(401).json({ error: "Usuario o contraseña inválidos" });
      }

      const effectiveRole = getEffectiveRole(empleado.role, empleado.username);

      const payload = {
        id: empleado._id,
        username: empleado.username,
        role: effectiveRole,
      };

      // Por defecto la sesión no vence por una fecha fija. Si alguna instalación
      // necesita caducidad, puede configurarla explícitamente con JWT_EXPIRES_IN.
      const token = firmarTokenSesion(payload);
      const { sinVencimiento, expiresIn } = obtenerConfiguracionVencimiento();

      // Actualizar última actividad (sin romper si falla)
      empleado.ultimaActividad = new Date();
      empleado.save().catch(() => {});

      return res.json({
        message: "Login exitoso",
        token,
        token_type: "Bearer",
        expires_in: sinVencimiento ? undefined : expiresIn,
        user: {
          id: empleado._id,
          username: empleado.username,
          role: effectiveRole,
        },
      });
    } catch (error) {
      if (process.env.NODE_ENV === "development") {
        console.error("❌ Error en login:", error);
      }
      return res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);


// ❤️ Heartbeat (mantiene sesión viva/actividad)
router.post("/heartbeat", verifyToken, heartbeat);

// 🔐 Ruta protegida de prueba
router.get("/protegido", verifyToken, (req, res) => {
  res.json({ message: "Acceso autorizado", user: req.user });
});

export default router;
