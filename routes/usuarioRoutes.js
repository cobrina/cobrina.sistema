import express from "express";
import { obtenerUsuariosActivos } from "../controllers/usuarioController.js";
import  verifyToken  from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";

const router = express.Router();

// ✅ Ruta: obtener lista de usuarios (solo para super-admin)
router.get("/", verifyToken, permitirRoles("super-admin"), obtenerUsuariosActivos);

export default router;
