import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import StickyNote, { STICKY_COLORS } from "../models/StickyNote.js";

const router = express.Router();

// Obtener mis notas (ordenadas)
router.get("/mine", verifyToken, async (req, res) => {
  const userId = req.usuario?._id || req.user?._id || req.user?.id;
  const notes = await StickyNote.find({ userId }).sort({ order: 1, updatedAt: -1 });
  res.json(notes);
});

// Crear (máx. 10 por usuario)
router.post("/", verifyToken, async (req, res) => {
  const userId = req.usuario?._id || req.user?._id || req.user?.id;
  const count = await StickyNote.countDocuments({ userId });
  if (count >= 10) return res.status(400).json({ error: "Límite de 10 notas alcanzado" });

  let { text = "", color = "yellow" } = req.body || {};
  if (!STICKY_COLORS.includes(color)) color = "yellow";

  const max = await StickyNote.findOne({ userId }).sort({ order: -1 }).select("order");
  const order = max ? max.order + 1 : 0;

  const note = await StickyNote.create({ userId, text, color, order });
  res.status(201).json(note);
});

// Editar contenido/color
router.put("/:id", verifyToken, async (req, res) => {
  const userId = req.usuario?._id || req.user?._id || req.user?.id;
  const { id } = req.params;
  const update = {};
  if (typeof req.body.text === "string") update.text = req.body.text;
  if (req.body.color && STICKY_COLORS.includes(req.body.color)) update.color = req.body.color;

  const note = await StickyNote.findOneAndUpdate(
    { _id: id, userId },
    { $set: update },
    { new: true }
  );
  if (!note) return res.status(404).json({ error: "Nota no encontrada" });
  res.json(note);
});

// Reordenar (recibe array de ids en el orden deseado)
router.put("/reorder/all", verifyToken, async (req, res) => {
  const userId = req.usuario?._id || req.user?._id || req.user?.id;
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: "Formato inválido" });

  const notes = await StickyNote.find({ userId, _id: { $in: ids } }).select("_id");
  const setIds = new Set(notes.map(n => String(n._id)));

  // Solo reasignamos las que realmente son del usuario
  let order = 0;
  const bulk = ids
    .filter(id => setIds.has(String(id)))
    .map(id => ({
      updateOne: {
        filter: { _id: id, userId },
        update: { $set: { order: order++ } }
      }
    }));

  if (bulk.length) await StickyNote.bulkWrite(bulk);
  res.json({ ok: true });
});

// Eliminar
router.delete("/:id", verifyToken, async (req, res) => {
  const userId = req.usuario?._id || req.user?._id || req.user?.id;
  const { id } = req.params;
  const deleted = await StickyNote.findOneAndDelete({ _id: id, userId });
  if (!deleted) return res.status(404).json({ error: "Nota no encontrada" });
  res.json({ ok: true });
});

export default router;
