// BACKEND/routes/reportesGestiones.routes.js
import { Router } from "express";
import {
  ping,
  cargar,
  listar,
  limpiar,
  exportarPDF,
  catalogos,
  resumenDia, 
  calendarioMes,
  calendarioMesMatriz,
  comparativo,
  casosNuevos,
} from "../controllers/reportesGestionesController.js";
import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";

const router = Router();
const guard = [verifyToken, permitirRoles("admin", "super-admin")];


router.get("/ping", guard, ping);
router.post("/cargar", guard, cargar);
router.get("/listar", guard, listar);
router.delete("/limpiar", guard, limpiar);
router.get("/export/pdf", guard, exportarPDF);
router.get("/catalogos", guard, catalogos);
router.get("/analytics/resumen-dia", guard, resumenDia);
router.get("/analytics/calendario-mes", guard, calendarioMes);
router.get("/analytics/calendario-matriz", guard, calendarioMesMatriz);
router.get("/comparativo", guard, comparativo);
router.get("/analytics/casos-nuevos", guard, casosNuevos);

export default router;
