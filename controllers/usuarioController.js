// controllers/usuarioController.js
import Empleado from "../models/Empleado.js";

/**
 * GET /usuarios
 * Solo super-admin. Lista de usuarios con filtros y paginación.
 * Query params opcionales:
 *  - q: búsqueda (username/email)
 *  - role: operador | operador-vip | admin | super-admin
 *  - includeInactive: "true" para incluir dados de baja (si existe campo activo=false)
 *  - limit: número máx. (default 100)
 *  - page: página (default 1)
 */
export const obtenerUsuariosActivos = async (req, res) => {
  try {
    // ✅ Enforce super-admin (además de cualquier middleware que tengas)
    const rol = req.user?.role || req.user?.rol;
    if (rol !== "super-admin") {
      return res.status(403).json({ error: "No autorizado" });
    }

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

    const query = {};

    // 🔎 Búsqueda por username o email
    if (q && String(q).trim() !== "") {
      const regex = new RegExp(String(q).trim(), "i");
      query.$or = [{ username: regex }, { email: regex }];
    }

    // 🎚️ Filtro por rol
    if (roleFilter) {
      query.role = roleFilter;
    }

    // ✅ Activos por defecto (si existe el campo activo, respétalo)
    //   - Si no existe en tu schema, esta condición no afecta.
   
   if (String(includeInactive).toLowerCase() !== "true") {
   query.$or = [
     ...(query.$or || []),
     { isActive: { $exists: false } }, // si no existe, lo tomamos como activo
     { isActive: true },
   ];
 }

    // 📄 Proyección segura (solo lo necesario)
    const projection = "username email role ultimaActividad isActive";

    // 🔢 Total y resultados
    const [total, usuarios] = await Promise.all([
      Empleado.countDocuments(query),
      Empleado.find(query, projection).sort({ username: 1 }).skip(skip).limit(LIM).lean(),
    ]);

    // ✨ Normalizar salida
    const items = usuarios.map((u) => ({
      id: String(u._id),
      username: u.username,
      email: u.email,
      role: u.role,
      activo: u.isActive !== false, // si no existe el campo, lo consideramos activo
      ultimaActividad: u.ultimaActividad || null,
    }));

    return res.json({
      total,
      page: PAGE,
      limit: LIM,
      resultados: items,
    });
  } catch (error) {
    console.error("❌ Error al obtener usuarios:", error);
    return res.status(500).json({ error: "Error al obtener usuarios" });
  }
};
