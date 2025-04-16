// middleware/permitirRoles.js


export default function permitirRoles(...rolesPermitidos) {
  return (req, res, next) => {
    const rolUsuario = req.user?.role || req.user?.rol;

    if (!rolUsuario) {
      return res.status(401).json({ error: "Token inválido o usuario no autenticado" });
    }

    if (!rolesPermitidos.includes(rolUsuario)) {
      return res.status(403).json({
        error: `Acceso denegado: se requiere uno de los siguientes roles: ${rolesPermitidos.join(", ")}`,
      });
    }

    next();
  };
}
