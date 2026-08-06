import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import { resumenDashboard } from "../controllers/dashboardController.js";

const router = Router();
router.get("/resumen", verifyToken, resumenDashboard);
export default router;
