// routes/colchonRoutes.js
import express from "express";
import {
  crearCuota,
  editarCuota,
  eliminarCuota,
  eliminarCuotasSeleccionadas,
  filtrarCuotas,
  importarExcel,
  exportarExcel,
  obtenerCarterasUnicas,
  agregarPago,
  informarPago,
  marcarPagoInformadoComoVisto,
  obtenerPagosInformadosPendientes,
  marcarPagoComoErroneo,
  marcarPagoComoVisto,
  eliminarPagoInformado,
  descargarModeloColchon,
  eliminarPagoReal,
  limpiarCuota,
  descargarModeloPagos,
  exportarPagos,
  eliminarTodasLasCuotas,
  obtenerEstadisticasColchon,
  getCuotaPorId,
  registrarGestionCuota,
  obtenerConciliacionPagosCuota,
  rechazarImportacionPagosColchon,
} from "../controllers/colchonController.js";

import verifyToken from "../middleware/verifyToken.js";
import upload from "../middleware/uploadMiddleware.js";
import permitirRoles from "../middleware/permitirRoles.js";
import permitirModulos from "../middleware/permitirModulos.js";
import { ROLES } from "../config/roles.js";

const router = express.Router();
const accesoColchon = [verifyToken, permitirModulos("colchon")];
const soloSuper = [verifyToken, permitirRoles(ROLES.SUPER_ADMIN)];
const confirmaPagos = [
  verifyToken,
  permitirRoles(ROLES.CUOTERO, ROLES.SUPERVISOR, ROLES.SUPER_ADMIN),
];

// Modelos, importaciones y vaciado masivo: únicamente super-admin.
router.get("/modelo", ...soloSuper, descargarModeloColchon);
router.get("/modelo-pagos", ...soloSuper, descargarModeloPagos);
router.post("/importar", ...soloSuper, upload.single("archivo"), importarExcel);
router.post("/importar-pagos", ...soloSuper, rechazarImportacionPagosColchon);
router.delete("/vaciar", ...soloSuper, eliminarTodasLasCuotas);
router.post("/eliminar-seleccion", ...soloSuper, eliminarCuotasSeleccionadas);

// Consultas y exportaciones respetan alcance propio/global en el controller.
router.get("/exportar", ...accesoColchon, exportarExcel);
router.get("/exportar-pagos", ...accesoColchon, exportarPagos);
router.get("/carteras", ...accesoColchon, obtenerCarterasUnicas);
router.get("/estadisticas", ...accesoColchon, obtenerEstadisticasColchon);
router.get("/", ...accesoColchon, filtrarCuotas);

// Pagos informados: todos los perfiles con acceso pueden informar.
// Cuotero/a, supervisor/a y super-admin revisan avisos; el dinero real se carga solo en Pagos.
router.get(
  "/informar-pago/pendientes",
  ...confirmaPagos,
  obtenerPagosInformadosPendientes
);
router.post(
  "/:id([0-9a-fA-F]{24})/informar-pago",
  ...accesoColchon,
  informarPago
);
router.put(
  "/:id([0-9a-fA-F]{24})/informar-pago/:pagoId([0-9a-fA-F]{24})/visto",
  ...confirmaPagos,
  marcarPagoInformadoComoVisto
);
router.put(
  "/:id([0-9a-fA-F]{24})/informar-pago/:pagoId([0-9a-fA-F]{24})/erroneo",
  ...accesoColchon,
  marcarPagoComoErroneo
);
router.delete(
  "/:id([0-9a-fA-F]{24})/informar-pago/:pagoId([0-9a-fA-F]{24})",
  ...accesoColchon,
  eliminarPagoInformado
);

router.get(
  "/:id([0-9a-fA-F]{24})/conciliacion-pagos",
  ...accesoColchon,
  obtenerConciliacionPagosCuota
);
router.put(
  "/:id([0-9a-fA-F]{24})/informar-pago/:pagoId([0-9a-fA-F]{24})/confirmar-visto",
  ...confirmaPagos,
  marcarPagoComoVisto
);

router.post("/:id([0-9a-fA-F]{24})/pagos", ...confirmaPagos, agregarPago);
router.delete(
  "/:cuotaId([0-9a-fA-F]{24})/pago/:pagoId([0-9a-fA-F]{24})",
  ...confirmaPagos,
  eliminarPagoReal
);

// Escritura fina: el controller aplica inform-only, own-full o full.
router.put("/:id([0-9a-fA-F]{24})/limpiar", ...accesoColchon, limpiarCuota);
router.put(
  "/gestionar/:id([0-9a-fA-F]{24})",
  ...accesoColchon,
  registrarGestionCuota
);
router.post("/", ...accesoColchon, crearCuota);
router.put("/:id([0-9a-fA-F]{24})", ...accesoColchon, editarCuota);
router.delete("/:id([0-9a-fA-F]{24})", ...accesoColchon, eliminarCuota);
router.get("/:id([0-9a-fA-F]{24})", ...accesoColchon, getCuotaPorId);

export default router;
