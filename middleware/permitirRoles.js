// verifyToken ya valida en MongoDB que el usuario exista, esté activo y tenga su rol actual.
// Este middleware solo comprueba permisos; evita una segunda consulta y una escritura por request.
export default function permitirRoles(...rolesPermitidos) {
  return (req, res, next) => {
    const rolUsuario = String(req.user?.role || "").trim().toLowerCase();

    if (!req.user?.id || !rolUsuario) {
      return res
        .status(401)
        .json({ error: "Token inválido o usuario no autenticado" });
    }

    if (!rolesPermitidos.includes(rolUsuario)) {
      return res.status(403).json({ error: "No tenés permiso para realizar esta acción" });
    }

    return next();
  };
}
