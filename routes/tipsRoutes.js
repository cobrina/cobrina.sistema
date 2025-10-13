// routes/tipsRoutes.js
import { Router } from "express";
import { list, create, update, toggleActive, remove } from "../controllers/tipsController.js";
import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";

const router = Router();

router.get("/", verifyToken, list);
router.post("/", verifyToken, permitirRoles("super-admin"), create);
router.put("/:id", verifyToken, permitirRoles("super-admin"), update);
router.patch("/:id/toggle", verifyToken, permitirRoles("super-admin"), toggleActive);
/** ➕ NUEVO: eliminar */
router.delete("/:id", verifyToken, permitirRoles("super-admin"), remove);

export default router;
