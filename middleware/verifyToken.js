import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token no proporcionado o formato inválido" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // ✅ Información del usuario disponible en req.user
    next();
  } catch (error) {
    if (process.env.NODE_ENV === "development") {
      console.error("❌ Error al verificar token:", error.message);
    }

    let mensaje = "Token inválido";
    if (error.name === "TokenExpiredError") {
      mensaje = "Sesión expirada. Por favor iniciá sesión nuevamente.";
    }

    return res.status(401).json({ error: mensaje });
  }
};

export default verifyToken;
