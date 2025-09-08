// middleware/verifyToken.js
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import Empleado from "../models/Empleado.js"; // ⬅️ IMPORTANTE: traemos el modelo
dotenv.config();

const verifyToken = async (req, res, next) => {
  try {
    // 1) Obtener token (header Bearer o cookie "token")
    const authHeader = req.headers.authorization || "";
    let token = null;

    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res
        .status(401)
        .json({ error: "Token no proporcionado o formato inválido" });
    }

    // 2) Verificar firma y claims básicos
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
      // audience: process.env.JWT_AUD,
      // issuer: process.env.JWT_ISS,
      // clockTolerance: 5,
    });

    // 3) Sanitizar payload
    const { id, username } = decoded || {};
    let { role } = decoded || {};
    if (!id || !username || !role) {
      return res
        .status(401)
        .json({ error: "Token inválido (payload incompleto)" });
    }

    // 4) ⛔ Chequear en DB que el usuario siga ACTIVO (y traer rol real)
    const emp = await Empleado.findById(id).select("isActive role");
    if (!emp) {
      return res.status(401).json({ error: "Usuario no existe" });
    }
    if (emp.isActive === false) {
      return res.status(403).json({ error: "Usuario inactivo" });
    }

    // 5) Opcional (recomendado): usar el rol actual de la DB por si cambió
    role = emp.role;

    req.user = { id, username, role };
    req.userId = id; // compat

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
