import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import permitirModulos from "../middleware/permitirModulos.js";
import {
  agregarObservacion,
  catalogos,
  estadisticas,
  exportarExcel,
  listarHistoricoVencidos,
  listarObservaciones,
  listarSeguimiento,
  listarVencidosHoy,
  marcarRealizado,
  recuperados,
  resumenAlerta,
} from "../controllers/contactadosController.js";

const router = Router();
const guard = [verifyToken, permitirModulos("contactados")];

router.get("/alerta", guard, resumenAlerta);
router.get("/catalogos", guard, catalogos);
router.get("/seguimiento", guard, listarSeguimiento);
router.get("/vencidos-hoy", guard, listarVencidosHoy);
router.get("/historico", guard, listarHistoricoVencidos);
router.get("/estadisticas", guard, estadisticas);
router.get("/recuperados", guard, recuperados);
router.get("/export/excel", guard, exportarExcel);
router.get("/series/:serieId/observaciones", guard, listarObservaciones);
router.post("/:id/realizado", guard, marcarRealizado);
router.post("/:id/observaciones", guard, agregarObservacion);

export default router;
