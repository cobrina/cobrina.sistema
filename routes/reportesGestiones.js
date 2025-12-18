// BACKEND/routes/reportesGestiones.routes.js
import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";

import {
  ping,
  cargar,
  listar,
  limpiar,
  exportarPDF,
  catalogos,
  comparativo,
  // ✅ Analytics
  analyticsResumen,          // NUEVO
  resumenDia,                // NUEVO
  calendarioMes,             // NUEVO
  calendarioMesMatriz,       // NUEVO
  casosNuevos,               // NUEVO
  ultimaActualizacion,       // NUEVO
} from "../controllers/reportesGestionesController.js";

const router = Router();

// ✅ Protegido: solo admin/super-admin
const guard = [verifyToken, permitirRoles("admin", "super-admin")];

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

/* =========================
   Comparativo
   ========================= */
router.get("/comparativo", guard, comparativo);

/* =========================
   Analytics (NUEVO)
   ========================= */
router.get("/analytics/resumen", guard, analyticsResumen);
router.get("/analytics/resumen-dia", guard, resumenDia);
router.get("/analytics/calendario-mes", guard, calendarioMes);
router.get("/analytics/calendario-matriz", guard, calendarioMesMatriz);
router.get("/analytics/casos-nuevos", guard, casosNuevos);
router.get("/analytics/ultima-actualizacion", guard, ultimaActualizacion);

export default router;
