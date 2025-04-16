import express from "express";
import {
  exportarProyeccionesCSV,
  exportarEstadisticasPDF,
  exportarResumenPDF,
} from "../controllers/exportController.js";

import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";

const router = express.Router();

// ✅ Exportar proyecciones del usuario a CSV
router.get(
  "/proyecciones/csv",
  verifyToken,
  permitirRoles(["operador", "admin", "super-admin"]),
  exportarProyeccionesCSV
);

// ✅ Exportar estadísticas a PDF (operador, admin o super-admin)
router.get(
  "/estadisticas/pdf",
  verifyToken,
  permitirRoles(["operador", "admin", "super-admin"]),
  exportarEstadisticasPDF
);

router.get("/resumen/pdf", verifyToken, permitirRoles("super-admin"), exportarResumenPDF);

export default router;
