import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import {
  actualizarAgendaItem,
  alternarCompletada,
  crearAgendaItem,
  eliminarAgendaItem,
  listarAgenda,
  listarDestinatariosAgenda,
} from "../controllers/agendaController.js";

const router = Router();

router.get("/destinatarios", verifyToken, listarDestinatariosAgenda);
router.get("/", verifyToken, listarAgenda);
router.post("/", verifyToken, crearAgendaItem);
router.put("/:id", verifyToken, actualizarAgendaItem);
router.patch("/:id/completada", verifyToken, alternarCompletada);
router.delete("/:id", verifyToken, eliminarAgendaItem);

export default router;
