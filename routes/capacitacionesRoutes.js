import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import permitirModulos from "../middleware/permitirModulos.js";
import permitirRoles from "../middleware/permitirRoles.js";
import {
  catalogos,
  crearPendiente,
  editarPendiente,
  desdeAuditoria,
  crear,
  editar,
  listar,
  pendientes,
  seguimientosPendientes,
  detalle,
  agregarSeguimiento,
  editarSeguimiento,
  borrarSeguimiento,
  borrar,
  resumen,
  exportarPDF,
  exportarIndividualPDF,
  exportarExcel,
} from "../controllers/capacitacionesController.js";

const router = Router();
const lectura = [verifyToken, permitirModulos("reportes")];
const escritura = [
  verifyToken,
  permitirRoles("capacitadora", "administracion", "supervisor", "super-admin"),
];

router.get("/catalogos", ...lectura, catalogos);
router.get("/resumen", ...lectura, resumen);
router.get("/pendientes", ...lectura, pendientes);
router.get("/seguimientos", ...lectura, seguimientosPendientes);
router.get("/listar", ...lectura, listar);
router.get("/export/pdf", ...lectura, exportarPDF);
router.get("/export/excel", ...lectura, exportarExcel);
router.get("/:id/pdf", ...lectura, exportarIndividualPDF);
router.get("/:id", ...lectura, detalle);

router.post("/pendiente", ...escritura, crearPendiente);
router.put("/pendiente/:id", ...escritura, editarPendiente);
router.post("/desde-auditoria/:auditoriaId", ...escritura, desdeAuditoria);
router.post("/crear", ...escritura, crear);
router.put("/:id", ...escritura, editar);
router.post("/:id/seguimientos", ...escritura, agregarSeguimiento);
router.put("/:id/seguimientos/:seguimientoId", ...escritura, editarSeguimiento);
router.delete("/:id/seguimientos/:seguimientoId", ...escritura, borrarSeguimiento);
router.delete("/:id", ...escritura, borrar);

export default router;
