import Empleado from "../models/Empleado.js";
import Asistencia from "../models/Asistencia.js";
import { firmarTokenSesion, obtenerConfiguracionVencimiento } from "../utils/jwtSesion.js";

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

    const ahoraSegundos = Math.floor(Date.now() / 1000);
    const expiresAt = Number(req.auth?.expiresAt || 0);
    const expiraEnSegundos = expiresAt > 0 ? expiresAt - ahoraSegundos : Infinity;
    const renovarAntesDe = Number(process.env.JWT_REFRESH_WINDOW_SECONDS || 24 * 60 * 60);
    const { sinVencimiento, expiresIn } = obtenerConfiguracionVencimiento();
    let token = "";

    // Si se despliega esta versión sobre tokens antiguos con vencimiento, el
    // primer heartbeat los reemplaza por una sesión sin fecha fija. Cuando la
    // caducidad está configurada explícitamente, se conserva la renovación móvil.
    const debeRenovar = sinVencimiento
      ? expiresAt > 0
      : !Number.isFinite(expiraEnSegundos) || expiraEnSegundos <= renovarAntesDe;

    if (debeRenovar) {
      token = firmarTokenSesion({
        id: userId,
        username: req.user.username,
        role: req.user.role,
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Heartbeat registrado",
      token: token || undefined,
      token_type: token ? "Bearer" : undefined,
      expires_in: token && !sinVencimiento ? expiresIn : undefined,
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
