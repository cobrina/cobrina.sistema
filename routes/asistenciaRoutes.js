import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";
import permitirModulos from "../middleware/permitirModulos.js";
import {
  actualizarHorario,
  marcarEntrada,
  marcarSalida,
  programarCierreNavegador,
  miEstado,
  panel,
} from "../controllers/asistenciaController.js";

const router = Router();

router.get("/mi-estado", verifyToken, miEstado);
router.post("/entrada", verifyToken, marcarEntrada);
router.post("/salida", verifyToken, marcarSalida);
router.post("/cierre-navegador", verifyToken, programarCierreNavegador);
router.get(
  "/panel",
  verifyToken,
  permitirModulos("presentismo"),
  panel
);
router.put(
  "/horario/:empleadoId",
  verifyToken,
  permitirRoles("administracion", "supervisor", "super-admin"),
  actualizarHorario
);

export default router;
