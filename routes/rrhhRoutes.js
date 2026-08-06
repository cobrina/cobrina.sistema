import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import permitirModulos from "../middleware/permitirModulos.js";
import permitirRoles from "../middleware/permitirRoles.js";
import { uploadSingle } from "../middleware/uploadMiddleware.js";
import { ROLES } from "../config/roles.js";
import {
  listarNovedades,
  crearNovedad,
  actualizarNovedad,
  eliminarNovedad,
  listarAdelantos,
  crearAdelanto,
  actualizarAdelanto,
  listarObjetivos,
  guardarObjetivo,
  actualizarObjetivo,
  eliminarObjetivo,
  descargarPlantillaHorarios,
  importarHorariosMasivos,
  descargarPlantillaObjetivos,
  importarObjetivosMasivos,
  resumenEmpleados,
} from "../controllers/rrhhController.js";

const router = Router();
const acceso = [verifyToken, permitirModulos("rrhh")];
const gestion = [
  verifyToken,
  permitirRoles(ROLES.ADMINISTRACION, ROLES.SUPERVISOR, ROLES.SUPER_ADMIN),
];
const gestionCompleta = [verifyToken, permitirRoles(ROLES.SUPERVISOR, ROLES.SUPER_ADMIN)];

router.get("/resumen-empleados", ...acceso, resumenEmpleados);

router.get("/novedades", ...acceso, listarNovedades);
router.post("/novedades", ...gestion, crearNovedad);
router.put("/novedades/:id", ...gestion, actualizarNovedad);
router.delete("/novedades/:id", ...gestionCompleta, eliminarNovedad);

router.get("/adelantos", ...gestion, listarAdelantos);
router.post("/adelantos", ...gestion, crearAdelanto);
router.put("/adelantos/:id", ...gestion, actualizarAdelanto);

router.get("/plantillas/horarios", ...gestion, descargarPlantillaHorarios);
router.post("/importar/horarios", ...gestion, uploadSingle("file"), importarHorariosMasivos);
router.get("/plantillas/objetivos", ...gestion, descargarPlantillaObjetivos);
router.post("/importar/objetivos", ...gestion, uploadSingle("file"), importarObjetivosMasivos);

router.get("/objetivos", ...acceso, listarObjetivos);
router.post("/objetivos", ...gestion, guardarObjetivo);
router.put("/objetivos/:id", ...gestion, actualizarObjetivo);
router.delete("/objetivos/:id", ...gestionCompleta, eliminarObjetivo);

export default router;
