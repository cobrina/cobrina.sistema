// controllers/authController.js
import Empleado from "../models/Empleado.js";

// controllers/authController.js
export const heartbeat = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Token inválido o ausente" });

    const empleado = await Empleado.findById(userId).select("username role ultimaActividad");
    if (!empleado) return res.status(404).json({ error: "Usuario no encontrado" });

    empleado.ultimaActividad = new Date();
    await empleado.save();

    return res.status(200).json({
      ok: true,
      message: "Heartbeat registrado",
      user: {
        id: empleado._id,
        username: empleado.username,
        role: empleado.role,
        ultimaActividad: empleado.ultimaActividad,
      },
      now: Date.now(),
    });
  } catch (error) {
    console.error("❌ Error en heartbeat:", error);
    return res.status(500).json({ error: "Error interno en heartbeat" });
  }
};

