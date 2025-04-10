import express from "express";
import Empleado from "../models/Empleado.js";
import bcrypt from "bcrypt";
import verifyToken from "../middleware/verifyToken.js";
import { check, validationResult } from "express-validator";

const router = express.Router();

const permitirRoles = (...rolesPermitidos) => {
  return (req, res, next) => {
    if (!rolesPermitidos.includes(req.user.role)) {
      return res.status(403).json({ error: "No tienes permiso para realizar esta acción" });
    }
    next();
  };
};

// ✅ Crear empleado (admin y super-admin)
router.post(
  "/crear",
  verifyToken,
  permitirRoles("admin", "super-admin"),
  [
    check("username", "El nombre de usuario es obligatorio").notEmpty(),
    check("password", "La contraseña es obligatoria").notEmpty(),
    check("email", "El correo no es válido").optional().isEmail(),
    check("role", "El rol es obligatorio").isIn(["operador", "admin"]),
  ],
  async (req, res) => {
    const errores = validationResult(req);
    if (!errores.isEmpty()) {
      return res.status(400).json({ errores: errores.array() });
    }

    try {
      const { username, password, email, role } = req.body;

      const existe = await Empleado.findOne({ username });
      if (existe) {
        return res.status(400).json({ error: "Ese nombre de usuario ya existe" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const nuevoEmpleado = new Empleado({
        username,
        password: hashedPassword,
        email: email || "",
        role,
      });

      await nuevoEmpleado.save();
      res.json({ message: "Empleado creado exitosamente" });
    } catch (error) {
      console.error("❌ Error al crear empleado:", error);
      res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

// ✅ Ver todos los empleados (solo super-admin)
router.get(
  "/todos",
  verifyToken,
  permitirRoles("super-admin"),
  async (req, res) => {
    try {
      const empleados = await Empleado.find().select("-password");
      res.json(empleados);
    } catch (error) {
      res.status(500).json({ error: "Error al obtener empleados" });
    }
  }
);

// ✅ Ver perfil propio
router.get("/mi-perfil", verifyToken, async (req, res) => {
  try {
    const empleado = await Empleado.findById(req.user.id).select("-password");
    res.json(empleado);
  } catch (error) {
    res.status(500).json({ error: "Error al obtener perfil" });
  }
});

// ✅ Actualizar empleado (admin y super-admin)
router.put(
  "/:id",
  verifyToken,
  permitirRoles("admin", "super-admin"),
  [
    check("email", "El correo no es válido").optional().isEmail(),
    check("role").optional().isIn(["operador", "admin"]),
  ],
  async (req, res) => {
    const errores = validationResult(req);
    if (!errores.isEmpty()) {
      return res.status(400).json({ errores: errores.array() });
    }

    try {
      const { username, email, role, password } = req.body;

      const updateData = {};
      if (username) updateData.username = username;
      if (email) updateData.email = email;
      if (role) updateData.role = role;
      if (password) {
        const hashed = await bcrypt.hash(password, 10);
        updateData.password = hashed;
      }

      const empleadoActualizado = await Empleado.findByIdAndUpdate(
        req.params.id,
        updateData,
        { new: true }
      ).select("-password");

      if (!empleadoActualizado) {
        return res.status(404).json({ error: "Empleado no encontrado" });
      }

      res.json({
        message: "Empleado actualizado",
        empleado: empleadoActualizado,
      });
    } catch (error) {
      console.error("❌ Error al actualizar empleado:", error);
      res.status(500).json({ error: "Error al actualizar el empleado" });
    }
  }
);

// ✅ Eliminar empleado (super-admin)
router.delete(
  "/:id",
  verifyToken,
  permitirRoles("super-admin"),
  async (req, res) => {
    try {
      const eliminado = await Empleado.findByIdAndDelete(req.params.id);

      if (!eliminado) {
        return res.status(404).json({ error: "Empleado no encontrado" });
      }

      res.json({ message: "Empleado eliminado correctamente" });
    } catch (error) {
      console.error("❌ Error al eliminar empleado:", error);
      res.status(500).json({ error: "Error al eliminar el empleado" });
    }
  }
);

// ✅ Empleados paginados (solo super-admin)
router.get(
  "/paginated",
  verifyToken,
  permitirRoles("super-admin"),
  async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = 5;
      const skip = (page - 1) * limit;

      const filtro = {};
      if (req.query.busqueda) {
        filtro.$or = [
          { username: { $regex: req.query.busqueda, $options: "i" } },
          { email: { $regex: req.query.busqueda, $options: "i" } },
        ];
      }

      if (req.query.role && req.query.role !== "todos") {
        filtro.role = req.query.role;
      }

      const total = await Empleado.countDocuments(filtro);
      const empleados = await Empleado.find(filtro)
        .select("-password")
        .skip(skip)
        .limit(limit);

      res.json({ total, empleados });
    } catch (error) {
      console.error("❌ Error en paginated:", error);
      res.status(500).json({ error: "Error al obtener empleados paginados" });
    }
  }
);

export default router;
