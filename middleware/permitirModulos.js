import { canAccessModule } from "../config/roles.js";

export default function permitirModulos(...modulos) {
  return (req, res, next) => {
    if (!req.user?.id || !req.user?.role) {
      return res.status(401).json({ error: "Token inválido o usuario no autenticado" });
    }

    const permitido = modulos.some((modulo) => canAccessModule(req.user.role, modulo));
    if (!permitido) {
      return res.status(403).json({ error: "No tenés permiso para acceder a este módulo" });
    }

    return next();
  };
}
