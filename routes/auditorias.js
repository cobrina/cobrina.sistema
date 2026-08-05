// BACKEND/routes/auditorias.js
import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import permitirModulos from "../middleware/permitirModulos.js";

import {
  ping,
  catalogos,
  crear,
  listar,
  detalle,
  editar,
  borrar,
  analyticsResumen,
  exportarPDF,
} from "../controllers/auditoriasController.js";

const router = Router();

// ✅ Protegido: solo admin/super-admin
const guard = [verifyToken, permitirModulos("reportes")];

/* =========================
   Básicos
   ========================= */
router.get("/ping", guard, ping);
router.get("/catalogos", guard, catalogos);

/* =========================
   CRUD
   ========================= */
router.post("/crear", guard, crear);
router.get("/listar", guard, listar);
router.get("/:id", guard, detalle);
router.put("/:id", guard, editar);
router.delete("/:id", guard, borrar);

/* =========================
   KPIs / Analytics
   ========================= */
router.get("/analytics/resumen", guard, analyticsResumen);

/* =========================
   Export
   ========================= */
router.get("/export/pdf", guard, exportarPDF);

export default router;
