import express from "express";
import Entidad from "../models/Entidad.js";

const router = express.Router();

// ➕ Crear
router.post("/", async (req, res) => {
  try {
    const entidad = new Entidad(req.body);
    await entidad.save();
    res.status(201).json(entidad);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 🔄 Editar
router.put("/:id", async (req, res) => {
  try {
    const entidad = await Entidad.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    res.json(entidad);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ❌ Eliminar
router.delete("/:id", async (req, res) => {
  try {
    await Entidad.findByIdAndDelete(req.params.id);
    res.json({ mensaje: "Entidad eliminada" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 📋 Obtener todas
router.get("/", async (req, res) => {
  try {
    const entidades = await Entidad.find().sort({ numero: 1 });
    res.json(entidades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
