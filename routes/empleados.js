// routes/empleadosRoutes.js
import express from "express";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { check, validationResult } from "express-validator";
import Empleado from "../models/Empleado.js";
import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";

const router = express.Router();

// Helpers
const validar = (req, res) => {
  const errores = validationResult(req);
  if (!errores.isEmpty()) {
    res.status(400).json({ errores: errores.array() });
    return false;
  }
  return true;
};
const isObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// 🔐 Todas estas rutas son solo para super-admin
const soloSuper = [verifyToken, permitirRoles("super-admin")];

/* ────────────────────────────────────────────────────────────
   Crear empleado (solo super-admin)
   - Evita duplicados (username / email)
   - Encripta password
   - role: operador o admin (no crear super-admin por acá)
──────────────────────────────────────────────────────────── */
router.post(
  "/crear",
  ...soloSuper,
  [
    check("username").trim().notEmpty().withMessage("El nombre de usuario es obligatorio"),
    check("password").notEmpty().withMessage("La contraseña es obligatoria"),
    check("email").trim().notEmpty().isEmail().withMessage("El correo no es válido"),
    check("role").isIn(["operador", "operador-vip", "admin"]).withMessage("Rol inválido"),
  ],
  async (req, res) => {
    if (!validar(req, res)) return;

    try {
      const { username, password, email, role } = req.body;

      const dupUser = await Empleado.findOne({ username }).lean();
      if (dupUser) return res.status(409).json({ error: "Ese nombre de usuario ya existe" });

      const dupEmail = await Empleado.findOne({ email }).lean();
      if (dupEmail) return res.status(409).json({ error: "Ese correo ya existe" });

      const hashed = await bcrypt.hash(password, 10);

      const nuevo = await Empleado.create({
        username: username.trim(),
        password: hashed,
        email: email.trim(),
        role,
      });

      res.status(201).json({
        message: "✅ Empleado creado exitosamente",
        empleado: { id: nuevo._id, username: nuevo.username, email: nuevo.email, role: nuevo.role },
      });
    } catch (error) {
      if (process.env.NODE_ENV === "development") console.error("❌ crear empleado:", error);
      // manejar posibles errores de índice único si habilitás unique en email
      if (error?.code === 11000) {
        const campo = Object.keys(error.keyPattern || {})[0] || "campo";
        return res.status(409).json({ error: `Duplicado: ${campo} ya está en uso` });
      }
      res.status(500).json({ error: "Error interno del servidor al crear empleado" });
    }
  }
);

/* ────────────────────────────────────────────────────────────
   Listado paginado (solo super-admin)
   - Filtro por búsqueda y role
   - Campos seguros (sin password)
──────────────────────────────────────────────────────────── */
router.get("/paginated", ...soloSuper, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 15, 1), 100);
    const skip = (page - 1) * limit;

    const filtro = {};
    if (req.query.busqueda) {
      const q = String(req.query.busqueda).trim();
      filtro.$or = [
        { username: { $regex: q, $options: "i" } },
        { email: { $regex: q, $options: "i" } },
      ];
    }
    if (req.query.role && req.query.role !== "todos") {
      filtro.role = req.query.role;
    }

    const [total, empleados] = await Promise.all([
      Empleado.countDocuments(filtro),
      Empleado.find(filtro).select("-password").sort({ username: 1 }).skip(skip).limit(limit).lean(),
    ]);

    res.json({ total, page, limit, empleados });
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error("❌ paginated:", error);
    res.status(500).json({ error: "Error al obtener empleados paginados" });
  }
});

/* ────────────────────────────────────────────────────────────
   Actualizar empleado (solo super-admin)
   - Parcial (email/username opcionales)
   - Evita cambiar rol si el objetivo es super-admin
   - Evita duplicados de username/email
   - Permite cambio de password
──────────────────────────────────────────────────────────── */
router.put(
  "/:id",
  ...soloSuper,
  [
    check("id").custom(isObjectId).withMessage("ID inválido"),
    check("email").optional().isEmail().withMessage("El correo no es válido"),
    check("role").optional().isIn(["operador", "operador-vip", "admin", "super-admin"]).withMessage("Rol inválido"),
  ],
  async (req, res) => {
    if (!validar(req, res)) return;

    try {
      const { id } = req.params;
      const { username, email, role, password } = req.body;

      const target = await Empleado.findById(id);
      if (!target) return res.status(404).json({ error: "Empleado no encontrado" });

      // No permitir modificar a super-admin (salvo password/propios datos no sensibles)
      if (target.role === "super-admin" && (role || username)) {
        return res.status(403).json({ error: "No se puede cambiar username/rol de un super-admin" });
      }

      const update = {};

      if (username && username !== target.username) {
        const dupUser = await Empleado.findOne({ username }).lean();
        if (dupUser) return res.status(409).json({ error: "Ese nombre de usuario ya existe" });
        update.username = username.trim();
      }

      if (email && email !== target.email) {
        const dupEmail = await Empleado.findOne({ email }).lean();
        if (dupEmail) return res.status(409).json({ error: "Ese correo ya existe" });
        update.email = email.trim();
      }

      if (role && target.role !== "super-admin") {
        update.role = role;
      }

      if (password) {
        update.password = await bcrypt.hash(password, 10);
      }

      const actualizado = await Empleado.findByIdAndUpdate(id, update, {
        new: true,
        runValidators: true,
      }).select("-password");

      res.json({ message: "✅ Empleado actualizado", empleado: actualizado });
    } catch (error) {
      if (process.env.NODE_ENV === "development") console.error("❌ actualizar empleado:", error);
      if (error?.code === 11000) {
        const campo = Object.keys(error.keyPattern || {})[0] || "campo";
        return res.status(409).json({ error: `Duplicado: ${campo} ya está en uso` });
      }
      res.status(500).json({ error: "Error al actualizar el empleado" });
    }
  }
);

/* ────────────────────────────────────────────────────────────
   Eliminar empleado (solo super-admin)
   - Bloquear eliminarse a sí mismo (opcional pero sano)
   - Bloquear eliminar super-admin
──────────────────────────────────────────────────────────── */
router.delete("/:id", ...soloSuper, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(400).json({ error: "ID inválido" });

    // Evitar autodestrucción
    if (String(req.user.id) === String(id)) {
      return res.status(400).json({ error: "No podés eliminar tu propio usuario" });
    }

    const target = await Empleado.findById(id);
    if (!target) return res.status(404).json({ error: "Empleado no encontrado" });
    if (target.role === "super-admin") {
      return res.status(403).json({ error: "No se puede eliminar un super-admin" });
    }

    await target.deleteOne();
    res.json({ message: "✅ Empleado eliminado correctamente" });
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error("❌ eliminar empleado:", error);
    res.status(500).json({ error: "Error al eliminar empleado" });
  }
});

/* ────────────────────────────────────────────────────────────
   Perfil propio
──────────────────────────────────────────────────────────── */
router.get("/mi-perfil", verifyToken, async (req, res) => {
  try {
    const empleado = await Empleado.findById(req.user.id).select("-password").lean();
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });
    res.json(empleado);
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error(error);
    res.status(500).json({ error: "Error al obtener perfil" });
  }
});

/* ────────────────────────────────────────────────────────────
   Listar todos (solo super-admin)
──────────────────────────────────────────────────────────── */
router.get("/todos", ...soloSuper, async (req, res) => {
  try {
    const empleados = await Empleado.find().select("-password").sort({ username: 1 }).lean();
    res.json(empleados);
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error(error);
    res.status(500).json({ error: "Error al obtener empleados" });
  }
});

/* ────────────────────────────────────────────────────────────
   Activar / Inactivar empleado (solo super-admin)
   Body: { isActive: boolean }
──────────────────────────────────────────────────────────── */
router.patch(
  "/:id/estado",
  ...soloSuper,
  [
    check("id").custom(isObjectId).withMessage("ID inválido"),
    check("isActive")
      .isBoolean()
      .withMessage("isActive debe ser booleano"),
  ],
  async (req, res) => {
    if (!validar(req, res)) return;

    try {
      const { id } = req.params;
      const { isActive } = req.body;

      const empleado = await Empleado.findById(id);
      if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });

      if (empleado.role === "super-admin") {
        return res.status(403).json({ error: "No se puede inactivar un super-admin" });
      }

      empleado.isActive = Boolean(isActive);
      await empleado.save();

      return res.json({
        message: "Estado actualizado",
        empleado: {
          id: empleado._id,
          username: empleado.username,
          role: empleado.role,
          isActive: empleado.isActive,
          ultimaActividad: empleado.ultimaActividad,
        },
      });
    } catch (error) {
      console.error("❌ PATCH /empleados/:id/estado:", error);
      return res.status(500).json({ error: "Error al cambiar estado del empleado" });
    }
  }
);

export default router;
