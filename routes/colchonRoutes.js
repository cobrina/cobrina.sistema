import express from "express";
import multer from "multer";
import {
  crearCuota,
  filtrarCuotas,
  importarExcel,
  exportarExcel,
  editarCuota,    // 👈 NUEVO
  eliminarCuota 
} from "../controllers/colchonController.js";
import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";

const router = express.Router();
const upload = multer();

router.post("/crear", verifyToken, crearCuota);
router.get("/filtrar", verifyToken, filtrarCuotas);
router.post("/importar-excel", verifyToken, permitirRoles("super-admin"), upload.single("file"), importarExcel);
router.get("/exportar-excel", verifyToken, exportarExcel);
router.put("/:id", verifyToken, editarCuota);    // ✏️ Editar cuota
router.delete("/:id", verifyToken, eliminarCuota); // 🗑️ Eliminar cuota

export default router;
