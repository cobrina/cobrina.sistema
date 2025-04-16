import express from "express";
import { check, validationResult } from "express-validator";
import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";
import Cartera from "../models/Cartera.js";

const router = express.Router();
const accesoAdmin = [verifyToken, permitirRoles("admin", "super-admin")];

/* ================================
   🏦 CARTERAS (Transferencias)
=================================*/

// ✅ Obtener todas las carteras (solo lectura) para todos los roles
router.get(
  "/carteras",
  verifyToken,
  permitirRoles("super-admin", "admin", "operador"),
  async (req, res) => {
    try {
      const carteras = await Cartera.find();
      res.json(carteras);
    } catch {
      res.status(500).json({ error: "Error al obtener carteras" });
    }
  }
);

// ➕ Crear nueva cartera (solo admin y super-admin)
router.post(
  "/carteras",
  ...accesoAdmin,
  [
    check("nombre", "⚠️ El nombre es obligatorio").notEmpty(),
    check("datosHtml", "⚠️ Los datos HTML son obligatorios").notEmpty(),
    check("direccion", "⚠️ La dirección es obligatoria").notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { nombre, datosHtml, direccion } = req.body;

      const nueva = new Cartera({
        nombre,
        datosHtml,
        direccion,
        editadoPor: req.user.username,
      });

      await nueva.save();
      res.json({ message: "Cartera creada", cartera: nueva });
    } catch {
      res.status(500).json({ error: "Error al crear cartera" });
    }
  }
);

// ✏️ Editar cartera existente (solo admin y super-admin)
router.put(
  "/carteras/:id",
  ...accesoAdmin,
  [
    check("nombre", "⚠️ El nombre es obligatorio").notEmpty(),
    check("datosHtml", "⚠️ Los datos HTML son obligatorios").notEmpty(),
    check("direccion", "⚠️ La dirección es obligatoria").notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const actualizada = await Cartera.findByIdAndUpdate(
        req.params.id,
        {
          ...req.body,
          editadoPor: req.user.username,
        },
        { new: true }
      );
      res.json({ message: "Cartera actualizada", cartera: actualizada });
    } catch {
      res.status(500).json({ error: "Error al actualizar cartera" });
    }
  }
);

// 🗑️ Eliminar cartera (solo admin y super-admin)
router.delete("/carteras/:id", ...accesoAdmin, async (req, res) => {
  try {
    await Cartera.findByIdAndDelete(req.params.id);
    res.json({ message: "Cartera eliminada" });
  } catch {
    res.status(500).json({ error: "Error al eliminar cartera" });
  }
});

export default router;
