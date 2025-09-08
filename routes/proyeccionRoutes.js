// routes/proyeccionRoutes.js
import express from "express";
import {
  crearProyeccion,
  obtenerProyeccionesPropias,
  actualizarProyeccion,
  eliminarProyeccion,
  obtenerProyeccionesPorOperadorId,
  obtenerEstadisticasPropias,
  obtenerEstadisticasAdmin,
  obtenerProyeccionesFiltradas,
  obtenerResumenGlobal,
  obtenerProyeccionesParaResumen,
  exportarProyeccionesExcel,
  registrarGestion,
  informarPago,
  listarPagosInformados,
  marcarPagoErroneo,
  importarPagosMasivo,      // ← Importación masiva de pagos (DNI + entidadId + subCesionId)
  exportarPagosExcel,
  limpiarPagosProyeccion,
  limpiarObservacionesProyeccion,
  importarProyeccionesMasivo, // ← Importación masiva de proyecciones (Entidad/SubCesión)
} from "../controllers/proyeccionController.js";

import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";
import Proyeccion from "../models/Proyeccion.js";
import multer from "multer";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = express.Router();

/* ===== Permisos según tu matriz =====
   - super-admin → acceso total.
   - admin → ❌ sin acceso.
   - operador-vip → igual que operador (ámbito propio).
   - operador → acceso solo a sus datos.
*/

// Crear proyección (usa entidadId + subCesionId)
router.post("/", verifyToken, permitirRoles("super-admin", "operador", "operador-vip"), crearProyeccion);

// Mis proyecciones
router.get("/mias", verifyToken, permitirRoles("super-admin", "operador", "operador-vip"), obtenerProyeccionesPropias);

// Listado / filtrar (super ve todo; operador y operador-vip solo propias)
router.get("/filtrar", verifyToken, permitirRoles("super-admin", "operador", "operador-vip"), obtenerProyeccionesFiltradas);

// Registrar gestión (solo dueño — controller valida igualmente)
router.post("/:id/gestion", verifyToken, permitirRoles("operador", "operador-vip"), registrarGestion);

// Actualizar (dueño o super-admin)
router.put(
  "/:id",
  verifyToken,
  async (req, res, next) => {
    try {
      const proyeccion = await Proyeccion.findById(req.params.id);
      if (!proyeccion) return res.status(404).json({ error: "Proyección no encontrada" });

      const rol = req.user.role || req.user.rol;
      const esDueno = String(proyeccion.empleadoId) === String(req.user.id);
      const esSuper = rol === "super-admin";

      if (!esDueno && !esSuper) {
        return res.status(403).json({ error: "No tenés permiso para editar esta proyección" });
      }
      next();
    } catch (e) {
      console.error("Permisos edición:", e);
      res.status(500).json({ error: "Error interno en autorización" });
    }
  },
  actualizarProyeccion
);

// Eliminar (dueño o super-admin)
router.delete("/:id", verifyToken, permitirRoles("super-admin", "operador", "operador-vip"), eliminarProyeccion);

// Ver proyecciones de un operador específico (solo super-admin)
router.get("/operador/:id", verifyToken, permitirRoles("super-admin"), obtenerProyeccionesPorOperadorId);

// Estadísticas propias (super-admin, operador, operador-vip)
router.get("/estadisticas", verifyToken, permitirRoles("super-admin", "operador", "operador-vip"), obtenerEstadisticasPropias);

// Estadísticas globales (solo super-admin)
router.get("/admin/estadisticas", verifyToken, permitirRoles("super-admin"), obtenerEstadisticasAdmin);

// Exportar proyecciones (super-admin → todas / operador y operador-vip → propias)
router.get("/exportar/excel", verifyToken, permitirRoles("super-admin", "operador", "operador-vip"), exportarProyeccionesExcel);

// Resumen global (solo super-admin)
router.get("/admin/resumen", verifyToken, permitirRoles("super-admin"), obtenerResumenGlobal);

// Data para resumen (super-admin, operador, operador-vip)
router.get("/resumen/data", verifyToken, permitirRoles("super-admin", "operador", "operador-vip"), obtenerProyeccionesParaResumen);

// Informar pago (operador / operador-vip dueño; super-admin permitido en ruta, control valida)
router.post("/:id/informar-pago", verifyToken, permitirRoles("super-admin", "operador", "operador-vip"), informarPago);

// Ver pagos informados (operador dueño, operador-vip dueño, super-admin)
router.get("/:id/pagos-informados", verifyToken, permitirRoles("super-admin", "operador", "operador-vip"), listarPagosInformados);

// Marcar pago erróneo / quitar (operador, operador-vip o super-admin)
router.patch("/:id/pagos/:pagoId/erroneo", verifyToken, permitirRoles("super-admin", "operador", "operador-vip"), marcarPagoErroneo);
router.patch(
  "/:id/pagos/:pagoId/erroneo/quitar",
  verifyToken,
  permitirRoles("super-admin", "operador", "operador-vip"),
  (req, _res, next) => { req.body.erroneo = false; next(); },
  marcarPagoErroneo
);

// Exportar pagos (super-admin todas / operador y operador-vip propias)
router.get("/exportar/pagos", verifyToken, permitirRoles("super-admin", "operador", "operador-vip"), exportarPagosExcel);

// Importar pagos MASIVO (solo super-admin) — requiere columnas: DNI, EntidadId, SubCesionId, Fecha, Monto
router.post("/pagos/importar", verifyToken, permitirRoles("super-admin"), upload.single("file"), importarPagosMasivo);

// Limpiar pagos (operador/operador-vip → propios; super-admin → todos)
router.patch("/:id/pagos/limpiar", verifyToken, permitirRoles("super-admin", "operador", "operador-vip"), limpiarPagosProyeccion);

// Limpiar observaciones (operador/operador-vip dueño; super-admin)
router.patch("/:id/observaciones/limpiar", verifyToken, permitirRoles("super-admin", "operador", "operador-vip"), limpiarObservacionesProyeccion);

// Importar proyecciones MASIVO (solo super-admin) — usa Entidad/SubCesión
router.post("/importar", verifyToken, permitirRoles("super-admin"), upload.single("file"), importarProyeccionesMasivo);

export default router;
