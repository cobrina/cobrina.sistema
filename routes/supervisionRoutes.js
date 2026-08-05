import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import permitirModulos from "../middleware/permitirModulos.js";
import { resumenSupervision } from "../controllers/supervisionController.js";

const router = Router();
router.get("/resumen", verifyToken, permitirModulos("supervision"), resumenSupervision);
export default router;
