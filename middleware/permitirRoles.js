// middleware/permitirRoles.js

export default function permitirRoles(...rolesPermitidos) {
  return (req, res, next) => {
    if (!rolesPermitidos.includes(req.user.role)) {
      return res.status(403).json({ error: "No tenés permiso para realizar esta acción" });
    }
    next();
  };
}
