import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import permitirModulos from "../middleware/permitirModulos.js";
import { generarPoderBia, listarPoderesBia } from "../controllers/poderBiaController.js";

const router = Router();
const guard = [verifyToken, permitirModulos("poderes-bia")];

router.get("/", ...guard, listarPoderesBia);
router.post("/generar", ...guard, generarPoderBia);

export default router;
