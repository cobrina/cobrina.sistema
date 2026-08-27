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
const gestionPersonal = [
  verifyToken,
  permitirRoles(ROLES.CAPACITADORA, ROLES.ADMINISTRACION, ROLES.SUPERVISOR, ROLES.SUPER_ADMIN),
];
const gestion = [
  verifyToken,
  permitirRoles(ROLES.ADMINISTRACION, ROLES.SUPERVISOR, ROLES.SUPER_ADMIN),
];
const gestionCompleta = [verifyToken, permitirRoles(ROLES.SUPERVISOR, ROLES.SUPER_ADMIN)];

router.get("/resumen-empleados", ...acceso, resumenEmpleados);

router.get("/novedades", ...acceso, listarNovedades);
router.post("/novedades", ...gestionPersonal, crearNovedad);
router.put("/novedades/:id", ...gestionPersonal, actualizarNovedad);
router.delete("/novedades/:id", ...gestionCompleta, eliminarNovedad);

router.get("/adelantos", ...gestion, listarAdelantos);
router.post("/adelantos", ...gestion, crearAdelanto);
router.put("/adelantos/:id", ...gestion, actualizarAdelanto);

router.get("/plantillas/horarios", ...gestionPersonal, descargarPlantillaHorarios);
router.post("/importar/horarios", ...gestionPersonal, uploadSingle("file"), importarHorariosMasivos);
router.get("/plantillas/objetivos", ...gestionPersonal, descargarPlantillaObjetivos);
router.post("/importar/objetivos", ...gestionPersonal, uploadSingle("file"), importarObjetivosMasivos);

router.get("/objetivos", ...acceso, listarObjetivos);
router.post("/objetivos", ...gestionPersonal, guardarObjetivo);
router.put("/objetivos/:id", ...gestionPersonal, actualizarObjetivo);
router.delete("/objetivos/:id", ...gestionCompleta, eliminarObjetivo);

export default router;
