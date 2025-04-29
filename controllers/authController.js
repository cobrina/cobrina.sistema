// controllers/authController.js

// Solo vamos a crear el HEARTBEAT acá.
import Empleado from "../models/Empleado.js";

export const heartbeat = async (req, res) => {
  try {
    const userId = req.userId; // viene del middleware verifyToken
    if (!userId) {
      return res.status(401).json({ error: "Token inválido" });
    }

    await Empleado.findByIdAndUpdate(userId, { ultimaActividad: new Date() });
    return res.status(200).json({ message: "Heartbeat registrado" });
  } catch (error) {
    console.error("Error en heartbeat:", error);
    return res.status(500).json({ error: "Error en heartbeat" });
  }
};
