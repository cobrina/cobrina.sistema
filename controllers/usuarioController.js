import Empleado from "../models/Empleado.js";
import { buildEffectiveRoleFilter, getEffectiveRole } from "../config/roles.js";

export const obtenerUsuariosActivos = async (req, res) => {
  try {
    const {
      q = "",
      role: roleFilter,
      includeInactive = "false",
      limit = "100",
      page = "1",
    } = req.query;

    const LIM = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
    const PAGE = Math.max(1, parseInt(page, 10) || 1);
    const skip = (PAGE - 1) * LIM;
    const condiciones = [];

    if (q && String(q).trim()) {
      const safe = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(safe, "i");
      condiciones.push({ $or: [{ username: regex }, { email: regex }] });
    }

    if (roleFilter && String(roleFilter) !== "todos") {
      const effectiveRoleFilter = buildEffectiveRoleFilter(roleFilter);
      if (!effectiveRoleFilter) {
        return res.status(400).json({ error: "Perfil inválido" });
      }
      condiciones.push(effectiveRoleFilter);
    }

    if (String(includeInactive).toLowerCase() !== "true") {
      condiciones.push({ isActive: { $ne: false } });
    }

    const query = condiciones.length ? { $and: condiciones } : {};
    const projection = "username nombre email role ultimaActividad isActive";

    const [total, usuarios] = await Promise.all([
      Empleado.countDocuments(query),
      Empleado.find(query, projection).sort({ username: 1 }).skip(skip).limit(LIM).lean(),
    ]);

    const items = usuarios.map((u) => ({
      id: String(u._id),
      username: u.username,
      nombre: u.nombre || "",
      email: u.email,
      role: getEffectiveRole(u.role, u.username),
      activo: u.isActive !== false,
      ultimaActividad: u.ultimaActividad || null,
    }));

    return res.json({ total, page: PAGE, limit: LIM, resultados: items });
  } catch (error) {
    console.error("❌ Error al obtener usuarios:", error);
    return res.status(500).json({ error: "Error al obtener usuarios" });
  }
};
