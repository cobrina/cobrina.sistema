// routes/subCesionRoutes.js
import express from "express";
import mongoose from "mongoose";
import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";
import SubCesion from "../models/SubCesion.js";

const router = express.Router();

// Roles permitidos
const soloAdmin = [verifyToken, permitirRoles("super-admin")];
const lecturaTodos = [verifyToken, permitirRoles("super-admin", "admin", "operador", "operador-vip")];

/* ===========================
   🔹 SubCesiones
=========================== */

// ➕ Crear SubCesión ( super-admin)
router.post("/", ...soloAdmin, async (req, res) => {
  try {
    const subcesion = await SubCesion.create(req.body);
    return res.status(201).json(subcesion);
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error(error);
    return res.status(400).json({ error: error.message || "No se pudo crear la SubCesión" });
  }
});

// 🔄 Editar SubCesión ( super-admin)
router.put("/:id", ...soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const subcesion = await SubCesion.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!subcesion) {
      return res.status(404).json({ error: "SubCesión no encontrada" });
    }

    return res.json(subcesion);
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error(error);
    return res.status(400).json({ error: error.message || "Error al actualizar SubCesión" });
  }
});

// ❌ Eliminar SubCesión ( super-admin)
router.delete("/:id", ...soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const eliminado = await SubCesion.findByIdAndDelete(id);
    if (!eliminado) {
      return res.status(404).json({ error: "SubCesión no encontrada" });
    }

    return res.json({ mensaje: "SubCesión eliminada correctamente" });
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error(error);
    return res.status(400).json({ error: error.message || "Error al eliminar SubCesión" });
  }
});

// 📋 Obtener todas las SubCesiones (todos los roles autenticados)
router.get("/", ...lecturaTodos, async (_req, res) => {
  try {
    const subcesiones = await SubCesion.find().sort({ nombre: 1 }).lean();
    return res.json(subcesiones);
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error(error);
    return res.status(500).json({ error: "Error al obtener SubCesiones" });
  }
});

export default router;
