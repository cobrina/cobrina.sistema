import Empleado from "../models/Empleado.js";

// 👤 Obtener todos los usuarios activos (para super-admin)
export const obtenerUsuariosActivos = async (req, res) => {
  try {
    // Solo campos útiles para filtros: nombre, _id, email, rol
    const usuarios = await Empleado.find({}, "username _id email role");

    // Opcional: filtrar activos solamente
    const activos = usuarios.filter((u) => u.activo !== false); // Por si en el futuro agregás bajas

    res.json(activos);
  } catch (error) {
    console.error("❌ Error al obtener usuarios activos:", error);
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
};
