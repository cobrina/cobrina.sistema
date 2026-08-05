// routes/tipsRoutes.js
import { Router } from "express";
import { list, create, update, toggleActive, remove } from "../controllers/tipsController.js";
import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";

const router = Router();

router.get("/", verifyToken, list);
router.post("/", verifyToken, permitirRoles("administracion", "supervisor", "super-admin"), create);
router.put("/:id", verifyToken, permitirRoles("administracion", "supervisor", "super-admin"), update);
router.patch("/:id/toggle", verifyToken, permitirRoles("administracion", "supervisor", "super-admin"), toggleActive);
/** ➕ NUEVO: eliminar */
router.delete("/:id", verifyToken, permitirRoles("administracion", "supervisor", "super-admin"), remove);

export default router;
