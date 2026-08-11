import express from "express";
import verifyToken from "../middleware/verifyToken.js";
import StickyNote, {
  STICKY_COLORS,
  STICKY_PRIORITIES,
  STICKY_STATUSES,
} from "../models/StickyNote.js";
import { mesClaveArgentina, toDateOnly } from "../utils/fecha.util.js";

const router = express.Router();
const MAX_TASKS_PER_USER = 150;

const userIdFrom = (req) => req.usuario?._id || req.user?._id || req.user?.id;
const monthFromDate = (value) => mesClaveArgentina(value ? new Date(value) : new Date());
const cleanText = (value, max) => String(value ?? "").trim().slice(0, max);
const parseDueDate = (value) => toDateOnly(value);
const legacyTitle = (note) => {
  const firstLine = String(note?.text || "").split(/\r?\n/).find((line) => line.trim());
  return cleanText(firstLine || "Tarea sin título", 140);
};

// Obtener mis tareas. Existing sticky notes are normalized on first read so
// they remain visible and become regular cards without a destructive migration.
router.get("/mine", verifyToken, async (req, res) => {
  try {
    const userId = userIdFrom(req);
    const notes = await StickyNote.find({ userId })
      .sort({ status: 1, order: 1, updatedAt: -1 })
      .lean();

    const migrations = [];
    const normalized = notes.map((note) => {
      const patch = {};
      if (!note.title) patch.title = legacyTitle(note);
      if (!note.status) patch.status = "pendiente";
      if (!note.priority) patch.priority = "media";
      if (!note.month) patch.month = monthFromDate(note.createdAt);
      if (Object.keys(patch).length) {
        migrations.push({
          updateOne: { filter: { _id: note._id, userId }, update: { $set: patch } },
        });
      }
      return { ...note, ...patch };
    });
    if (migrations.length) StickyNote.bulkWrite(migrations).catch(() => {});
    res.json(normalized);
  } catch (error) {
    console.error("Error listando tareas personales:", error);
    res.status(500).json({ error: "No se pudieron cargar las tareas" });
  }
});

router.post("/", verifyToken, async (req, res) => {
  try {
    const userId = userIdFrom(req);
    if (!userId) return res.status(401).json({ error: "No se pudo identificar al usuario" });
    const count = await StickyNote.countDocuments({ userId });
    if (count >= MAX_TASKS_PER_USER) {
      return res.status(400).json({ error: `Límite de ${MAX_TASKS_PER_USER} tareas alcanzado` });
    }

    const status = STICKY_STATUSES.includes(req.body?.status) ? req.body.status : "pendiente";
    const priority = STICKY_PRIORITIES.includes(req.body?.priority) ? req.body.priority : "media";
    const color = STICKY_COLORS.includes(req.body?.color) ? req.body.color : "yellow";
    const month = /^\d{4}-\d{2}$/.test(String(req.body?.month || ""))
      ? String(req.body.month)
      : monthFromDate();
    const max = await StickyNote.findOne({ userId, status }).sort({ order: -1 }).select("order").lean();

    const note = await StickyNote.create({
      userId,
      title: cleanText(req.body?.title || req.body?.text || "Nueva tarea", 140),
      text: cleanText(req.body?.text, 4000),
      color,
      status,
      priority,
      month,
      dueDate: parseDueDate(req.body?.dueDate),
      completedAt: status === "finalizada" ? new Date() : null,
      order: max ? Number(max.order || 0) + 1 : 0,
    });
    res.status(201).json(note.toObject ? note.toObject() : note);
  } catch (error) {
    console.error("Error creando tarea:", error);
    res.status(500).json({ error: "No se pudo crear la tarea" });
  }
});

router.put("/reorder/board", verifyToken, async (req, res) => {
  try {
    const userId = userIdFrom(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "No se recibió el nuevo orden" });

    const ids = items.map((item) => item?.id).filter(Boolean);
    const owned = await StickyNote.find({ userId, _id: { $in: ids } })
      .select("_id status completedAt")
      .lean();
    const ownedById = new Map(owned.map((item) => [String(item._id), item]));
    const operations = items
      .filter((item) => ownedById.has(String(item?.id)) && STICKY_STATUSES.includes(item?.status))
      .map((item) => {
        const previous = ownedById.get(String(item.id));
        const completedAt =
          item.status === "finalizada"
            ? previous?.completedAt || new Date()
            : null;
        return {
          updateOne: {
            filter: { _id: item.id, userId },
            update: {
              $set: {
                status: item.status,
                order: Math.max(0, Number(item.order || 0)),
                completedAt,
              },
            },
          },
        };
      });
    if (operations.length) await StickyNote.bulkWrite(operations);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error reordenando tareas:", error);
    res.status(500).json({ error: "No se pudo guardar el nuevo orden" });
  }
});

// Compatibility with the previous note board.
router.put("/reorder/all", verifyToken, async (req, res) => {
  try {
    const userId = userIdFrom(req);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const notes = await StickyNote.find({ userId, _id: { $in: ids } }).select("_id status").lean();
    const byId = new Map(notes.map((note) => [String(note._id), note]));
    const operations = ids
      .filter((id) => byId.has(String(id)))
      .map((id, order) => ({
        updateOne: { filter: { _id: id, userId }, update: { $set: { order } } },
      }));
    if (operations.length) await StickyNote.bulkWrite(operations);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "No se pudo reordenar" });
  }
});

router.put("/:id", verifyToken, async (req, res) => {
  try {
    const userId = userIdFrom(req);
    const update = {};
    if (typeof req.body?.title === "string") update.title = cleanText(req.body.title, 140);
    if (typeof req.body?.text === "string") update.text = cleanText(req.body.text, 4000);
    if (STICKY_COLORS.includes(req.body?.color)) update.color = req.body.color;
    if (STICKY_PRIORITIES.includes(req.body?.priority)) update.priority = req.body.priority;
    if (/^\d{4}-\d{2}$/.test(String(req.body?.month || ""))) update.month = String(req.body.month);
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "dueDate")) {
      update.dueDate = parseDueDate(req.body.dueDate);
    }
    if (STICKY_STATUSES.includes(req.body?.status)) {
      update.status = req.body.status;
      update.completedAt = req.body.status === "finalizada" ? new Date() : null;
    }

    const note = await StickyNote.findOneAndUpdate(
      { _id: req.params.id, userId },
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!note) return res.status(404).json({ error: "Tarea no encontrada" });
    res.json(note);
  } catch (error) {
    console.error("Error actualizando tarea:", error);
    res.status(500).json({ error: "No se pudo actualizar la tarea" });
  }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const userId = userIdFrom(req);
    const deleted = await StickyNote.findOneAndDelete({ _id: req.params.id, userId });
    if (!deleted) return res.status(404).json({ error: "Tarea no encontrada" });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "No se pudo eliminar la tarea" });
  }
});

export default router;
