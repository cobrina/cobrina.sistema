import express from "express";
import {
  crearCuota,
  editarCuota,
  eliminarCuota,
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

const router = express.Router();

// 📤 Exportar cuotas a Excel
router.get("/exportar", verifyToken, exportarExcel);

// 📤 Exportar pagos
router.get("/exportar-pagos", verifyToken, exportarPagos);

// 📥 Descargar modelos de Excel
router.get("/modelo", verifyToken, descargarModeloColchon);
router.get("/modelo-pagos", verifyToken, descargarModeloPagos);

// 📥 Importar desde Excel
router.post("/importar", verifyToken, upload.single("archivo"), importarExcel);
router.post(
  "/importar-pagos",
  verifyToken,
  upload.single("archivo"),
  importarPagosDesdeExcel
);

// 🔍 Consultas auxiliares
router.get("/carteras", verifyToken, obtenerCarterasUnicas);
router.get("/estadisticas", verifyToken, obtenerEstadisticasColchon);

// ✅ Pagos informados (operadores)
router.get(
  "/informar-pago/pendientes",
  verifyToken,
  obtenerPagosInformadosPendientes
);
router.post("/:id/informar-pago", verifyToken, informarPago);
router.put(
  "/:id/informar-pago/:pagoId/visto",
  verifyToken,
  marcarPagoInformadoComoVisto
);
router.put(
  "/:id/informar-pago/:pagoId/erroneo",
  verifyToken,
  marcarPagoComoErroneo
);
router.delete("/:id/informar-pago/:pagoId", verifyToken, eliminarPagoInformado);

// ✅ Pagos reales (admin)
router.post("/:id/pagos", verifyToken, agregarPago);
router.delete("/:cuotaId/pago/:pagoId", verifyToken, eliminarPagoReal);

// ✅ Limpiar pagos y observaciones
router.put("/:id/limpiar", verifyToken, limpiarCuota);

// ✅ CRUD Cuotas
router.post("/", verifyToken, crearCuota);
router.put("/:id", verifyToken, editarCuota);
router.delete("/vaciar", verifyToken, eliminarTodasLasCuotas);
router.delete("/:id", verifyToken, eliminarCuota);
router.put("/gestionar/:id", verifyToken, registrarGestionCuota);

// 🔍 Obtener cuota específica (¡último!)
router.get("/:id", getCuotaPorId);

// 🔍 Filtrar cuotas (¡último también!)
router.get("/", verifyToken, filtrarCuotas);



export default router;
