// controllers/tipsController.js
import Tip from "../models/Tip.js";

export async function list(req, res) {
  try {
    const { q, categories, onlyActive } = req.query;
    const filter = {};
    if (onlyActive !== "false") filter.isActive = true;

    if (!["super-admin", "admin"].includes(req.usuario?.rol)) {
      filter.visibility = "all";
    }

    if (q) {
      filter.$or = [
        { title: { $regex: q, $options: "i" } },
        { bodyMd: { $regex: q, $options: "i" } },
        { categories: { $regex: q, $options: "i" } },
      ];
    }

    if (categories) {
      const arr = categories.split(",").map((s) => s.trim()).filter(Boolean);
      if (arr.length) filter.categories = { $in: arr };
    }

    const tips = await Tip.find(filter).sort({ updatedAt: -1 }).lean();
    res.json(tips);
  } catch (e) {
    res.status(500).json({ error: "Error listando tips" });
  }
}

export async function create(req, res) {
  try {
    const data = req.body;
    data.createdBy = req.usuario?._id;
    data.updatedBy = req.usuario?._id;
    const tip = await Tip.create(data);
    res.status(201).json(tip);
  } catch (e) {
    res.status(400).json({ error: "No se pudo crear el tip" });
  }
}

export async function update(req, res) {
  try {
    const { id } = req.params;
    const data = { ...req.body, updatedBy: req.usuario?._id };
    const tip = await Tip.findByIdAndUpdate(id, data, { new: true });
    if (!tip) return res.status(404).json({ error: "Tip no encontrado" });
    res.json(tip);
  } catch (e) {
    res.status(400).json({ error: "No se pudo actualizar el tip" });
  }
}

export async function toggleActive(req, res) {
  try {
    const { id } = req.params;
    const tip = await Tip.findById(id);
    if (!tip) return res.status(404).json({ error: "Tip no encontrado" });
    tip.isActive = !tip.isActive;
    tip.updatedBy = req.usuario?._id;
    await tip.save();
    res.json(tip);
  } catch (e) {
    res.status(400).json({ error: "No se pudo cambiar el estado" });
  }
}

export async function remove(req, res) {
  try {
    const { id } = req.params;
    const tip = await Tip.findByIdAndDelete(id);
    if (!tip) return res.status(404).json({ error: "Tip no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: "No se pudo eliminar el tip" });
  }
}