import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import permitirModulos from "../middleware/permitirModulos.js";
import {
  generarPoderBia,
  generarPoderGreenLight,
  listarPoderesBia,
} from "../controllers/poderBiaController.js";

const router = Router();
const guard = [verifyToken, permitirModulos("poderes-bia")];

router.get("/", ...guard, listarPoderesBia);
router.post("/generar", ...guard, generarPoderBia);
router.post("/generar/green-light", ...guard, generarPoderGreenLight);

export default router;
