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
} from "../controllers/proyeccionController.js";

import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";
import Proyeccion from "../models/Proyeccion.js"; // 👉 necesario para el chequeo por ID
import { exportarProyeccionesExcel } from "../controllers/proyeccionController.js";

const router = express.Router();

// ✅ Crear proyección (todos los empleados pueden)
router.post("/", verifyToken, permitirRoles("super-admin", "admin", "operador"), crearProyeccion);

// ✅ Obtener proyecciones propias (todos los empleados pueden)
router.get("/mias", verifyToken, permitirRoles("super-admin", "admin", "operador"), obtenerProyeccionesPropias);

// ✅ Obtener proyecciones con filtros y paginación
router.get("/filtrar", verifyToken, permitirRoles("super-admin", "admin", "operador"), obtenerProyeccionesFiltradas);

// ✅ Actualizar una proyección propia (con chequeo personalizado)
router.put("/:id", verifyToken, async (req, res, next) => {
  try {
    const proyeccion = await Proyeccion.findById(req.params.id);

    if (!proyeccion) {
      return res.status(404).json({ error: "Proyección no encontrada" });
    }

    // Solo puede editar su propia proyección o ser admin/super-admin
    if (
      proyeccion.empleadoId.toString() !== req.user.id &&
      !["admin", "super-admin"].includes(req.user.role)
    ) {
      return res.status(403).json({ error: "No tenés permiso para editar esta proyección" });
    }

    next(); // ✅ Si todo OK, continúa al controller
  } catch (error) {
    console.error("Error al verificar permisos de edición:", error);
    return res.status(500).json({ error: "Error interno en autorización" });
  }
}, actualizarProyeccion);

// ✅ Eliminar una proyección propia
router.delete("/:id", verifyToken, permitirRoles("super-admin", "admin", "operador"), eliminarProyeccion);

// ✅ Ver proyecciones de un operador específico (solo admin/super-admin)
router.get("/operador/:id", verifyToken, permitirRoles("admin", "super-admin"), obtenerProyeccionesPorOperadorId);

// ✅ Estadísticas del usuario logueado
router.get("/estadisticas", verifyToken, permitirRoles("super-admin", "admin", "operador"), obtenerEstadisticasPropias);

// ✅ Estadísticas globales (solo admin/super-admin)
router.get("/admin/estadisticas", verifyToken, permitirRoles("admin", "super-admin"), obtenerEstadisticasAdmin);

router.get("/exportar/excel", verifyToken, permitirRoles("super-admin", "admin", "operador"), exportarProyeccionesExcel);

router.get("/admin/resumen", verifyToken, permitirRoles("super-admin"), obtenerResumenGlobal);

router.get("/resumen/data", verifyToken, permitirRoles("super-admin", "admin", "operador"), obtenerProyeccionesParaResumen);

export default router;
