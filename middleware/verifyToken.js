import jwt from "jsonwebtoken";
import Empleado from "../models/Empleado.js";
import { getEffectiveRole } from "../config/roles.js";

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : req.cookies?.token || "";

    if (!token) {
      return res
        .status(401)
        .json({ error: "Token no proporcionado o formato inválido" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
      clockTolerance: 30,
    });

    const id = decoded?.id;
    const usernameToken = decoded?.username;
    if (!id || !usernameToken || !decoded?.role) {
      return res.status(401).json({ error: "Token inválido" });
    }

    const empleado = await Empleado.findById(id)
      .select("isActive role username")
      .lean();

    if (!empleado) {
      return res.status(401).json({ error: "Usuario no existe" });
    }
    if (empleado.isActive === false) {
      return res.status(403).json({ error: "Usuario inactivo" });
    }

    req.user = {
      id: String(empleado._id),
      username: empleado.username || usernameToken,
      role: getEffectiveRole(empleado.role || decoded.role, empleado.username || usernameToken),
    };
    req.userId = req.user.id;
    req.auth = {
      token,
      issuedAt: decoded?.iat || null,
      expiresAt: decoded?.exp || null,
    };

    return next();
  } catch (error) {
    if (process.env.NODE_ENV === "development") {
      console.error("❌ Error al verificar token:", error?.message);
    }

    const mensaje =
      error?.name === "TokenExpiredError"
        ? "Sesión expirada. Por favor iniciá sesión nuevamente."
        : "Token inválido";

    return res.status(401).json({ error: mensaje });
  }
};

export default verifyToken;
