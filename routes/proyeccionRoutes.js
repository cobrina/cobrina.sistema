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
  importarPagosMasivo,
  exportarPagosExcel,
  limpiarPagosProyeccion,
  limpiarObservacionesProyeccion,
  importarProyeccionesMasivo,
  eliminarProyeccionesMasivo,
  buscarCoincidenciasAcuerdosMango,
  listarAcuerdosMangoParaProyecciones,
  exportarAcuerdosMangoProyeccionesExcel,
  obtenerConciliacionPagosProyeccion,
  cerrarProyeccionPorAcuerdoMango,
  informarPagoAcuerdoMango,
  listarPagosInformadosAcuerdoMango,
  marcarPagoInformadoMangoErroneo,
} from "../controllers/proyeccionController.js";

import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";
import permitirModulos from "../middleware/permitirModulos.js";
import Proyeccion from "../models/Proyeccion.js";
import { getProyeccionesScope, ROLES } from "../config/roles.js";
import multer from "multer";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = express.Router();
const accesoProyecciones = [verifyToken, permitirModulos("proyecciones")];

const permitirDuenoOAmbitoGlobal = async (req, res, next) => {
  try {
    const proyeccion = await Proyeccion.findById(req.params.id).select("empleadoId");
    if (!proyeccion) return res.status(404).json({ error: "Proyección no encontrada" });

    const scope = getProyeccionesScope(req.user.role || req.user.rol);
    const esDueno = String(proyeccion.empleadoId) === String(req.user.id);
    if (scope !== "all" && !esDueno) {
      return res.status(403).json({ error: "No tenés permiso sobre esta proyección" });
    }
    next();
  } catch (error) {
    console.error("Permisos de proyección:", error);
    res.status(500).json({ error: "Error interno en autorización" });
  }
};

// Acceso propio: operador, operador VIP, capacitadora y administración.
// Acceso global: supervisor y super-admin.
router.post("/", ...accesoProyecciones, crearProyeccion);
router.get("/mias", ...accesoProyecciones, obtenerProyeccionesPropias);
router.get("/filtrar", ...accesoProyecciones, obtenerProyeccionesFiltradas);
router.get(
  "/coincidencias-mango",
  ...accesoProyecciones,
  buscarCoincidenciasAcuerdosMango
);
router.get(
  "/acuerdos-mango",
  ...accesoProyecciones,
  listarAcuerdosMangoParaProyecciones
);
router.get(
  "/acuerdos-mango/exportar/excel",
  ...accesoProyecciones,
  exportarAcuerdosMangoProyeccionesExcel
);

router.post(
  "/acuerdos-mango/:id([0-9a-fA-F]{24})/informar-pago",
  ...accesoProyecciones,
  informarPagoAcuerdoMango
);
router.get(
  "/acuerdos-mango/:id([0-9a-fA-F]{24})/pagos-informados",
  ...accesoProyecciones,
  listarPagosInformadosAcuerdoMango
);
router.patch(
  "/acuerdos-mango/:id([0-9a-fA-F]{24})/pagos-informados/:pagoId([0-9a-fA-F]{24})/erroneo",
  ...accesoProyecciones,
  marcarPagoInformadoMangoErroneo
);

router.post(
  "/:id/gestion",
  verifyToken,
  permitirRoles(
    ROLES.OPERADOR,
    ROLES.OPERADOR_VIP,
    ROLES.CAPACITADORA,
    ROLES.ADMINISTRACION,
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN
  ),
  registrarGestion
);

router.patch(
  "/:id/cerrar-por-mango",
  ...accesoProyecciones,
  permitirDuenoOAmbitoGlobal,
  cerrarProyeccionPorAcuerdoMango
);
router.put("/:id", ...accesoProyecciones, permitirDuenoOAmbitoGlobal, actualizarProyeccion);
router.delete("/:id", ...accesoProyecciones, permitirDuenoOAmbitoGlobal, eliminarProyeccion);

// Operaciones destructivas o cargas masivas: únicamente super-admin.
router.delete(
  "/admin/eliminar-masivo",
  verifyToken,
  permitirRoles(ROLES.SUPER_ADMIN),
  eliminarProyeccionesMasivo
);
router.post(
  "/pagos/importar",
  verifyToken,
  permitirRoles(ROLES.SUPER_ADMIN),
  upload.single("file"),
  importarPagosMasivo
);
router.post(
  "/importar",
  verifyToken,
  permitirRoles(ROLES.SUPER_ADMIN),
  upload.single("file"),
  importarProyeccionesMasivo
);

router.get(
  "/operador/:id",
  verifyToken,
  permitirRoles(ROLES.SUPERVISOR, ROLES.SUPER_ADMIN),
  obtenerProyeccionesPorOperadorId
);
router.get("/estadisticas", ...accesoProyecciones, obtenerEstadisticasPropias);
router.get(
  "/admin/estadisticas",
  verifyToken,
  permitirRoles(ROLES.SUPERVISOR, ROLES.SUPER_ADMIN),
  obtenerEstadisticasAdmin
);
router.get("/exportar/excel", ...accesoProyecciones, exportarProyeccionesExcel);
router.get(
  "/admin/resumen",
  verifyToken,
  permitirRoles(ROLES.SUPERVISOR, ROLES.SUPER_ADMIN),
  obtenerResumenGlobal
);
router.get("/resumen/data", ...accesoProyecciones, obtenerProyeccionesParaResumen);

router.post("/:id/informar-pago", ...accesoProyecciones, permitirDuenoOAmbitoGlobal, informarPago);
router.get(
  "/:id/conciliacion-pagos",
  ...accesoProyecciones,
  permitirDuenoOAmbitoGlobal,
  obtenerConciliacionPagosProyeccion
);
router.get("/:id/pagos-informados", ...accesoProyecciones, permitirDuenoOAmbitoGlobal, listarPagosInformados);
router.patch(
  "/:id/pagos/:pagoId/erroneo",
  ...accesoProyecciones,
  permitirDuenoOAmbitoGlobal,
  marcarPagoErroneo
);
router.patch(
  "/:id/pagos/:pagoId/erroneo/quitar",
  ...accesoProyecciones,
  permitirDuenoOAmbitoGlobal,
  (req, _res, next) => {
    req.body.erroneo = false;
    next();
  },
  marcarPagoErroneo
);
router.get("/exportar/pagos", ...accesoProyecciones, exportarPagosExcel);
router.patch("/:id/pagos/limpiar", ...accesoProyecciones, permitirDuenoOAmbitoGlobal, limpiarPagosProyeccion);
router.patch(
  "/:id/observaciones/limpiar",
  ...accesoProyecciones,
  permitirDuenoOAmbitoGlobal,
  limpiarObservacionesProyeccion
);

export default router;
