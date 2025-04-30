import express from "express";
import {
  crearCuota,
  editarCuota,
  eliminarCuota,
  filtrarCuotas,
  importarExcel,
  exportarExcel,
  obtenerCarterasUnicas,
  
} from "../controllers/colchonController.js";
import { obtenerUsuariosActivos } from "../controllers/usuarioController.js";

import verifyToken from "../middleware/verifyToken.js";
import upload from "../middleware/uploadMiddleware.js";

const router = express.Router();

// ✅ Alias opcional para mantener el nombre "proteger"
const proteger = verifyToken;

// Rutas principales
router.get("/filtrar", proteger, filtrarCuotas);
router.post("/crear", proteger, crearCuota);
router.put("/editar/:id", proteger, editarCuota);
router.delete("/eliminar/:id", proteger, eliminarCuota);

// Rutas de archivos
router.post("/importar-excel", proteger, upload.single("file"), importarExcel);
router.get("/exportar-excel", proteger, exportarExcel);

// 🔵 Rutas auxiliares para filtros
router.get("/carteras", proteger, obtenerCarterasUnicas);
router.get("/usuarios", proteger, obtenerUsuariosActivos);


export default router;
