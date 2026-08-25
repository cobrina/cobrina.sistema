// BACKEND/routes/reportesGestiones.routes.js
import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import permitirModulos from "../middleware/permitirModulos.js";
import { seguimientoOperadores, seguimientoAuditorias } from "../controllers/reportesSeguimientoController.js";
import { calidadGestiones } from "../controllers/calidadGestionesController.js";

import {
  ping,
  cargar,
  listar,
  limpiar,
  exportarPDF,
  exportarGestionesExcel,
  catalogos,
  comparativo,
  // ✅ Analytics
  analyticsResumen,          // NUEVO
  resumenDia,                // NUEVO
  actividadRango,            // pulso operativo diario
  calendarioMes,             // NUEVO
  calendarioMesMatriz,       // NUEVO
  asistenciaMes,             // V16 · calendario + matriz en una sola consulta
  casosNuevos,               // NUEVO
  ultimaActualizacion,       // NUEVO
  analyticsAcuerdos,
  exportarAcuerdosExcel,
  exportarAcuerdosEstadisticasExcel,
  exportarAcuerdosGestionesExcel,
  exportarAcuerdosVencidosExcel,
} from "../controllers/reportesGestionesController.js";

const router = Router();

// ✅ Protegido: solo admin/super-admin
const guard = [verifyToken, permitirModulos("reportes")];

/* =========================
   Básicos
   ========================= */
router.get("/ping", guard, ping);
router.get("/catalogos", guard, catalogos);

/* =========================
   Carga y mantenimiento
   ========================= */
router.post("/cargar", guard, cargar);
router.get("/listar", guard, listar);
router.delete("/limpiar", guard, limpiar);

/* =========================
   Export
   ========================= */
router.get("/export/pdf", guard, exportarPDF);
router.get("/export/excel", guard, exportarGestionesExcel);

/* =========================
   Comparativo
   ========================= */
router.get("/comparativo", guard, comparativo);

/* =========================
   Analytics (NUEVO)
   ========================= */
router.get("/analytics/resumen", guard, analyticsResumen);
router.get("/analytics/seguimiento-operadores", guard, seguimientoOperadores);
router.get("/analytics/seguimiento-auditorias", guard, seguimientoAuditorias);
router.get("/analytics/calidad-gestiones", guard, calidadGestiones);
router.get("/analytics/resumen-dia", guard, resumenDia);
router.get("/analytics/actividad-rango", guard, actividadRango);
router.get("/analytics/calendario-mes", guard, calendarioMes);
router.get("/analytics/calendario-matriz", guard, calendarioMesMatriz);
router.get("/analytics/asistencia-mes", guard, asistenciaMes);
router.get("/analytics/casos-nuevos", guard, casosNuevos);
router.get("/analytics/ultima-actualizacion", guard, ultimaActualizacion);
router.get("/analytics/acuerdos", guard, analyticsAcuerdos);
router.get("/analytics/acuerdos/excel", guard, exportarAcuerdosExcel);
router.get("/analytics/acuerdos/estadisticas-excel", guard, exportarAcuerdosEstadisticasExcel);
router.get("/analytics/acuerdos/gestiones-excel", guard, exportarAcuerdosGestionesExcel);
router.get("/analytics/acuerdos/vencidos-excel", guard, exportarAcuerdosVencidosExcel);

export default router;
