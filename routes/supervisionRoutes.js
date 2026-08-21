import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import permitirModulos from "../middleware/permitirModulos.js";
import { resumenSupervision, resumenGestionesSupervision, resumenContactadosSupervision } from "../controllers/supervisionController.js";

const router = Router();
router.get("/resumen", verifyToken, permitirModulos("supervision"), resumenSupervision);
router.get("/gestiones-resumen", verifyToken, permitirModulos("supervision"), resumenGestionesSupervision);
router.get("/contactados-resumen", verifyToken, permitirModulos("supervision"), resumenContactadosSupervision);
export default router;
