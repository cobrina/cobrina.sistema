// routes/entidadesRoutes.js
import express from "express";
import { param } from "express-validator";
import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";
import Entidad from "../models/Entidad.js";
import mongoose from "mongoose";

const router = express.Router();

const soloAdmin = [verifyToken, permitirRoles("super-admin")];
const lecturaTodos = [verifyToken, permitirRoles("super-admin", "admin", "operador", "operador-vip")];

// ➕ Crear (super-admin)
router.post("/", ...soloAdmin, async (req, res) => {
  try {
    const entidad = await Entidad.create(req.body);
    return res.status(201).json(entidad);
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error(error);
    return res.status(400).json({ error: error.message || "No se pudo crear la entidad" });
  }
});

// 🔄 Editar (super-admin)
router.put(
  "/:id",
  ...soloAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "ID inválido" });
      }

      const entidad = await Entidad.findByIdAndUpdate(id, req.body, { new: true, runValidators: true });
      if (!entidad) return res.status(404).json({ error: "Entidad no encontrada" });

      return res.json(entidad);
    } catch (error) {
      if (process.env.NODE_ENV === "development") console.error(error);
      return res.status(400).json({ error: error.message || "No se pudo actualizar la entidad" });
    }
  }
);

// ❌ Eliminar (super-admin)
router.delete("/:id", ...soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const eliminado = await Entidad.findByIdAndDelete(id);
    if (!eliminado) return res.status(404).json({ error: "Entidad no encontrada" });

    return res.json({ mensaje: "Entidad eliminada" });
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error(error);
    return res.status(400).json({ error: error.message || "No se pudo eliminar la entidad" });
  }
});

// 📋 Obtener todas (todos los roles autenticados)
router.get("/", ...lecturaTodos, async (_req, res) => {
  try {
    const entidades = await Entidad.find().sort({ numero: 1 }).lean();
    return res.json(entidades);
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error(error);
    return res.status(500).json({ error: "Error al obtener entidades" });
  }
});

export default router;
