import express from "express";
import { obtenerUsuariosActivos } from "../controllers/usuarioController.js";
import  verifyToken  from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";

const router = express.Router();

// Catálogo de usuarios activos para filtros globales y asignación de agenda.
router.get(
  "/",
  verifyToken,
  permitirRoles("cuotero", "capacitadora", "administracion", "supervisor", "super-admin"),
  obtenerUsuariosActivos
);

export default router;
