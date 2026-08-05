// BACKEND/routes/acuerdosPagoRoutes.js
import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import permitirModulos from "../middleware/permitirModulos.js";
import { uploadSingle } from "../middleware/uploadMiddleware.js";

import {
  ping,
  preview,
  importar,
  listar,
  limpiar,
  catalogos,
  exportarXlsx,
  // exportarPdf,            // ✅ activar cuando confirmemos uso en front
  analyticsResumen,
  resumenOperador,
  acuerdosPorDia,
  analyticsCalendarioMes,    // ✅ NUEVO
  ultimosTresMeses,
  comparativo,
} from "../controllers/acuerdosPagoController.js";

const router = Router();

// Solo admin/super-admin (igual que reportes-gestiones)
const guard = [verifyToken, permitirModulos("reportes")];

router.get("/ping", guard, ping);

// Import mensual
router.post("/preview", guard, uploadSingle("file"), preview);
router.post("/importar", guard, uploadSingle("file"), importar);

// Tabla
router.get("/listar", guard, listar);

// Catálogos
router.get("/catalogos", guard, catalogos);

// Borrado por filtros
router.delete("/limpiar", guard, limpiar);

// Export
router.get("/export/xlsx", guard, exportarXlsx);
// router.get("/export/pdf", guard, exportarPdf); // ✅ si el front lo llama, lo habilitamos

// Analytics
router.get("/analytics/resumen", guard, analyticsResumen);
router.get("/analytics/resumen-operador", guard, resumenOperador);
router.get("/analytics/por-dia", guard, acuerdosPorDia);

// ✅ NUEVO: calendario mensual completo (para “Acuerdos por operador x día” en calendario)
router.get("/analytics/calendario-mes", guard, analyticsCalendarioMes);

router.get("/analytics/ultimos-3-meses", guard, ultimosTresMeses);
router.get("/analytics/calendario-mes", guard, analyticsCalendarioMes);

// Comparativo rango vs anterior
router.get("/comparativo", guard, comparativo);

export default router;
