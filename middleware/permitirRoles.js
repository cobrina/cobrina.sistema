import { normalizeStoredRole } from "../config/roles.js";

// verifyToken ya valida en MongoDB que el usuario exista, esté activo y tenga su rol efectivo actual.
export default function permitirRoles(...rolesPermitidos) {
  const permitidos = rolesPermitidos.map(normalizeStoredRole);
  return (req, res, next) => {
    const rolUsuario = normalizeStoredRole(req.user?.role);

    if (!req.user?.id || !rolUsuario) {
      return res
        .status(401)
        .json({ error: "Token inválido o usuario no autenticado" });
    }

    if (!permitidos.includes(rolUsuario)) {
      return res.status(403).json({ error: "No tenés permiso para realizar esta acción" });
    }

    return next();
  };
}
