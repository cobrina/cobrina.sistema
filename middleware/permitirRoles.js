// middleware/permitirRoles.js
import Empleado from "../models/Empleado.js";

export default function permitirRoles(...rolesPermitidos) {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: "Token inválido o usuario no autenticado" });
      }

      // ✅ Revalidar estado activo y rol
      const emp = await Empleado.findById(userId).select("isActive role");
      if (!emp) return res.status(401).json({ error: "Usuario no existe" });
      if (emp.isActive === false) {
        return res.status(403).json({ error: "Usuario inactivo" });
      }

      const rolUsuario = emp.role; // usar el rol real de la DB
      if (!rolesPermitidos.includes(rolUsuario)) {
        return res.status(403).json({
          error: `Acceso denegado: necesitas uno de estos roles: ${rolesPermitidos.join(", ")}`,
        });
      }

      // ⏱️ Actualizar última actividad
      emp.ultimaActividad = new Date();
      await emp.save();

      // Alinear el rol en req.user por si cambió
      req.user.role = rolUsuario;

      next();
    } catch (error) {
      console.error("❌ Error en permitirRoles:", error);
      return res.status(500).json({ error: "Error interno al validar permisos" });
    }
  };
}
