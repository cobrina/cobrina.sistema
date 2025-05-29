import express from "express";
import SubCesion from "../models/SubCesion.js";

const router = express.Router();

// ➕ Crear
router.post("/", async (req, res) => {
  try {
    const subcesion = new SubCesion(req.body);
    await subcesion.save();
    res.status(201).json(subcesion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 🔄 Editar
router.put("/:id", async (req, res) => {
  try {
    const subcesion = await SubCesion.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    res.json(subcesion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ❌ Eliminar
router.delete("/:id", async (req, res) => {
  try {
    await SubCesion.findByIdAndDelete(req.params.id);
    res.json({ mensaje: "SubCesión eliminada" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 📋 Obtener todas
router.get("/", async (req, res) => {
  try {
    const subcesiones = await SubCesion.find().sort({ nombre: 1 });
    res.json(subcesiones);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
