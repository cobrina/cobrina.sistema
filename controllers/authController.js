import Empleado from "../models/Empleado.js";
import Asistencia from "../models/Asistencia.js";

export const heartbeat = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Token inválido o ausente" });
    }

    const ahora = new Date();
    const [resultado] = await Promise.all([
      Empleado.updateOne(
        { _id: userId, isActive: { $ne: false } },
        { $set: { ultimaActividad: ahora } }
      ),
      Asistencia.updateMany(
        { empleado: userId, estado: "presente" },
        {
          $set: {
            cierrePendienteDesde: null,
            cierrePendienteHasta: null,
            motivoCierrePendiente: "",
          },
        }
      ),
    ]);

    if (!resultado.matchedCount) {
      return res.status(404).json({ error: "Usuario no encontrado o inactivo" });
    }

    return res.status(200).json({
      ok: true,
      message: "Heartbeat registrado",
      user: {
        id: userId,
        username: req.user.username,
        role: req.user.role,
        ultimaActividad: ahora,
      },
      now: ahora.getTime(),
    });
  } catch (error) {
    console.error("❌ Error en heartbeat:", error?.message || error);
    return res.status(500).json({ error: "Error interno en heartbeat" });
  }
};
