import express from "express";
import {
  crearCuota,
  editarCuota,
  eliminarCuota,
  filtrarCuotas,
  importarExcel,
  exportarExcel,
  obtenerCarterasUnicas
} from "../controllers/colchonController.js";

import verifyToken from "../middleware/verifyToken.js"; // ✅ Autenticación JWT
import upload from "../middleware/uploadMiddleware.js"; // ✅ Subida de archivos

const router = express.Router();

// Crear cuota (solo para usuarios autenticados)
router.post("/", verifyToken, crearCuota);

// Editar cuota
router.put("/:id", verifyToken, editarCuota);

// Eliminar cuota
router.delete("/:id", verifyToken, eliminarCuota);

// Filtrar cuotas
router.get("/", verifyToken, filtrarCuotas);

// Exportar Excel
router.get("/exportar", verifyToken, exportarExcel);

// Importar Excel (subida de archivo)
router.post("/importar", verifyToken, upload.single("archivo"), importarExcel);

// Obtener carteras únicas
router.get("/carteras", verifyToken, obtenerCarterasUnicas);

export default router;
