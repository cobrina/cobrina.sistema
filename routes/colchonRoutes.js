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
  importarPagosDesdeExcel,
  descargarModeloPagos,
  exportarPagos,
  eliminarTodasLasCuotas,
  obtenerEstadisticasColchon,
  getCuotaPorId,
  registrarGestionCuota,
} from "../controllers/colchonController.js";

import verifyToken from "../middleware/verifyToken.js";
import upload from "../middleware/uploadMiddleware.js";
import permitirRoles from "../middleware/permitirRoles.js";

const router = express.Router();

// Helpers de permisos
const soloSuper = [verifyToken, permitirRoles("super-admin")];
const superYOps = [verifyToken, permitirRoles("super-admin", "operador", "operador-vip")];
// ⚠️ admin queda afuera a propósito

/* ================================
   📥 Descarga de modelos
================================ */
router.get("/modelo",       ...soloSuper, descargarModeloColchon);
router.get("/modelo-pagos", ...soloSuper, descargarModeloPagos);

/* ================================
   📤 Exportaciones
================================ */
router.get("/exportar",       ...superYOps, exportarExcel);
router.get("/exportar-pagos", ...superYOps, exportarPagos);

/* ================================
   📥 Importaciones (solo super-admin)
================================ */
router.post(
  "/importar",
  ...soloSuper,
  upload.single("archivo"),
  importarExcel
);
router.post(
  "/importar-pagos",
  ...soloSuper,
  upload.single("archivo"),
  importarPagosDesdeExcel
);

/* ================================
   🔍 Consultas auxiliares / stats
================================ */
router.get("/carteras",     ...superYOps, obtenerCarterasUnicas);
router.get("/estadisticas", ...superYOps, obtenerEstadisticasColchon);

/* ================================
   💬 Pagos informados (ops y super-admin)
================================ */
router.get("/informar-pago/pendientes", ...superYOps, obtenerPagosInformadosPendientes);
router.post("/:id([0-9a-fA-F]{24})/informar-pago", ...superYOps, informarPago);
router.put("/:id([0-9a-fA-F]{24})/informar-pago/:pagoId([0-9a-fA-F]{24})/visto",   ...superYOps, marcarPagoInformadoComoVisto);
router.put("/:id([0-9a-fA-F]{24})/informar-pago/:pagoId([0-9a-fA-F]{24})/erroneo", ...superYOps, marcarPagoComoErroneo);
router.delete("/:id([0-9a-fA-F]{24})/informar-pago/:pagoId([0-9a-fA-F]{24})",      ...superYOps, eliminarPagoInformado);

/* ================================
   💰 Pagos reales (solo super-admin)
================================ */
router.post("/:id([0-9a-fA-F]{24})/pagos",                                           ...soloSuper, agregarPago);
router.delete("/:cuotaId([0-9a-fA-F]{24})/pago/:pagoId([0-9a-fA-F]{24})",            ...soloSuper, eliminarPagoReal);

/* ================================
   🧹 Limpiar pagos/obs
================================ */
router.put("/:id([0-9a-fA-F]{24})/limpiar", ...superYOps, limpiarCuota);

/* ================================
   ☎️ Registrar gestión
================================ */
router.put("/gestionar/:id([0-9a-fA-F]{24})", ...superYOps, registrarGestionCuota);

/* ================================
   🧱 CRUD de cuotas
================================ */
router.post("/", ...superYOps, crearCuota);

// ⚠️ RUTA FIJA ANTES QUE LAS PARAMÉTRICAS
router.delete("/vaciar", ...soloSuper, eliminarTodasLasCuotas);
router.post("/eliminar-seleccion", ...soloSuper, eliminarCuotasSeleccionadas);

// Rutas con :id limitadas a ObjectId
router.put("/:id([0-9a-fA-F]{24})",    ...superYOps, editarCuota);
router.delete("/:id([0-9a-fA-F]{24})", ...superYOps, eliminarCuota);
router.get("/:id([0-9a-fA-F]{24})",    ...superYOps, getCuotaPorId);

/* ================================
   🔍 Listado
================================ */
router.get("/", ...superYOps, filtrarCuotas);

export default router;
