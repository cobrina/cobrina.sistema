import express from "express";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { check, validationResult } from "express-validator";
import Empleado from "../models/Empleado.js";
import NovedadRRHH from "../models/NovedadRRHH.js";
import verifyToken from "../middleware/verifyToken.js";
import permitirModulos from "../middleware/permitirModulos.js";
import permitirRoles from "../middleware/permitirRoles.js";
import {
  ROLES,
  ASSIGNABLE_ROLES,
  buildEffectiveRoleFilter,
  canAssignElevatedRoles,
  canManageTargetUser,
  getEffectiveRole,
  isDesignatedSuperAdmin,
  normalizeAssignableRole,
} from "../config/roles.js";
import { fechaClaveArgentina, inicioDiaCalendarioUTC, finDiaCalendarioUTC } from "../utils/fecha.util.js";
import { invalidateSeguimientoCache } from "../controllers/reportesSeguimientoController.js";

const router = express.Router();
const gestoresUsuarios = [verifyToken, permitirModulos("usuarios")];
const gestoresContrasenas = [
  verifyToken,
  permitirRoles(
    ROLES.CUOTERO,
    ROLES.CAPACITADORA,
    ROLES.ADMINISTRACION,
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN
  ),
];

const validar = (req, res) => {
  const errores = validationResult(req);
  if (!errores.isEmpty()) {
    res.status(400).json({ errores: errores.array() });
    return false;
  }
  return true;
};

const isObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

function empleadoSeguro(empleado) {
  const raw = empleado?.toObject ? empleado.toObject() : { ...empleado };
  delete raw.password;
  raw.role = getEffectiveRole(raw.role, raw.username);
  return raw;
}


function limpiarHorarioLaboral(raw = {}) {
  const recibido = raw && typeof raw === "object" ? raw : {};
  const tieneConfiguracion = Object.keys(recibido).length > 0;
  const modalidad = String(recibido?.modalidad || "fijo").toLowerCase() === "libre" ? "libre" : "fijo";
  if (modalidad === "libre") {
    return { modalidad: "libre", dias: [], entrada: "", salida: "", toleranciaMinutos: 0 };
  }

  const dias = Array.isArray(recibido?.dias)
    ? [...new Set(recibido.dias.map(Number).filter((dia) => Number.isInteger(dia) && dia >= 0 && dia <= 6))]
    : [1, 2, 3, 4, 5];
  const entrada = String(recibido?.entrada || (tieneConfiguracion ? "" : "09:00")).trim();
  const salida = String(recibido?.salida || (tieneConfiguracion ? "" : "18:00")).trim();
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;

  if (!dias.length) {
    const error = new Error("Seleccioná al menos un día laboral");
    error.statusCode = 400;
    throw error;
  }
  if (!hhmm.test(entrada) || !hhmm.test(salida)) {
    const error = new Error("Completá una hora de entrada y salida válida");
    error.statusCode = 400;
    throw error;
  }
  const [eh, em] = entrada.split(":").map(Number);
  const [sh, sm] = salida.split(":").map(Number);
  if (sh * 60 + sm <= eh * 60 + em) {
    const error = new Error("La hora de salida debe ser posterior a la entrada");
    error.statusCode = 400;
    throw error;
  }

  const tolerancia = Number(recibido?.toleranciaMinutos ?? 10);
  return {
    modalidad: "fijo",
    dias,
    entrada,
    salida,
    toleranciaMinutos: Number.isFinite(tolerancia)
      ? Math.max(0, Math.min(180, Math.round(tolerancia)))
      : 10,
  };
}

function rolSolicitadoParaActor(req, rawRole) {
  const role = normalizeAssignableRole(rawRole || ROLES.OPERADOR);
  if (!role) throw new Error("Rol inválido");

  if (!canAssignElevatedRoles(req.user.role, req.user.username) && role !== ROLES.OPERADOR) {
    throw new Error("No tenés permiso para asignar ese perfil");
  }
  return role;
}

router.post(
  "/crear",
  ...gestoresUsuarios,
  [
    check("username").trim().notEmpty().withMessage("El nombre de usuario es obligatorio"),
    check("password").notEmpty().withMessage("La contraseña es obligatoria"),
    check("email").trim().notEmpty().isEmail().withMessage("El correo no es válido"),
    check("role").optional().isString().withMessage("Rol inválido"),
  ],
  async (req, res) => {
    if (!validar(req, res)) return;

    try {
      const username = String(req.body.username || "").trim().toLowerCase();
      const email = String(req.body.email || "").trim().toLowerCase();
      const role = rolSolicitadoParaActor(req, req.body.role);

      if (
        isDesignatedSuperAdmin(username) &&
        getEffectiveRole(req.user.role, req.user.username) !== ROLES.SUPER_ADMIN
      ) {
        return res.status(403).json({
          error: "Ese nombre de usuario está reservado para un super-admin autorizado",
        });
      }

      const [dupUser, dupEmail] = await Promise.all([
        Empleado.findOne({ username }).lean(),
        Empleado.findOne({ email }).lean(),
      ]);
      if (dupUser) return res.status(409).json({ error: "Ese nombre de usuario ya existe" });
      if (dupEmail) return res.status(409).json({ error: "Ese correo ya existe" });

      const horarioLaboral = limpiarHorarioLaboral(req.body.horarioLaboral || {});
      const nuevo = await Empleado.create({
        username,
        nombre: String(req.body.nombre || "").trim(),
        celular: String(req.body.celular || "").trim(),
        password: await bcrypt.hash(String(req.body.password), 10),
        email,
        role,
        isActive: req.body.isActive !== false,
        horarioLaboral,
      });

      // Leemos nuevamente desde Mongo para devolver exactamente lo que quedó
      // persistido. Así la ficha y Jornada/Asistencia comparten una única fuente.
      const persistido = await Empleado.findById(nuevo._id).select("-password").lean();
      invalidateSeguimientoCache();

      return res.status(201).json({
        message: "✅ Empleado creado exitosamente",
        empleado: empleadoSeguro(persistido || nuevo),
      });
    } catch (error) {
      if (error?.message?.includes("super-admin") || error?.message === "Rol inválido") {
        return res.status(403).json({ error: error.message });
      }
      if (process.env.NODE_ENV === "development") console.error("❌ crear empleado:", error);
      if (error?.statusCode === 400) return res.status(400).json({ error: error.message });
      if (error?.code === 11000) {
        const campo = Object.keys(error.keyPattern || {})[0] || "campo";
        return res.status(409).json({ error: `Duplicado: ${campo} ya está en uso` });
      }
      return res.status(500).json({ error: "Error interno del servidor al crear empleado" });
    }
  }
);


router.get("/password-reset/users", ...gestoresContrasenas, async (req, res) => {
  try {
    const actorRole = getEffectiveRole(req.user.role, req.user.username);
    const empleados = await Empleado.find({ isActive: { $ne: false } })
      .select("username nombre email role")
      .sort({ username: 1 })
      .lean();

    const visibles = empleados
      .map(empleadoSeguro)
      .filter((empleado) => {
        if (empleado.role === ROLES.SUPER_ADMIN) return false;
        if (actorRole === ROLES.SUPERVISOR) return true;
        return [ROLES.OPERADOR, ROLES.OPERADOR_VIP].includes(empleado.role);
      });

    return res.json(visibles);
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error("Listar usuarios para contraseña:", error);
    return res.status(500).json({ error: "No se pudieron obtener los usuarios" });
  }
});

router.patch(
  "/password-reset/:id",
  ...gestoresContrasenas,
  [
    check("id").custom(isObjectId).withMessage("ID inválido"),
    check("password")
      .isString()
      .isLength({ min: 6, max: 100 })
      .withMessage("La contraseña debe tener entre 6 y 100 caracteres"),
  ],
  async (req, res) => {
    if (!validar(req, res)) return;
    try {
      const target = await Empleado.findById(req.params.id).select("+password");
      if (!target) return res.status(404).json({ error: "Operador no encontrado" });
      const actorRole = getEffectiveRole(req.user.role, req.user.username);
      const targetRole = getEffectiveRole(target.role, target.username);
      const permitido = actorRole === ROLES.SUPERVISOR
        ? targetRole !== ROLES.SUPER_ADMIN
        : [ROLES.OPERADOR, ROLES.OPERADOR_VIP].includes(targetRole);
      if (!permitido) {
        return res.status(403).json({
          error: actorRole === ROLES.SUPERVISOR
            ? "No se puede restablecer la contraseña de un super-admin"
            : "Solo se pueden restablecer contraseñas de operadores y operadores VIP",
        });
      }
      target.password = await bcrypt.hash(String(req.body.password), 10);
      await target.save();
      return res.json({ ok: true, message: `Contraseña actualizada para ${target.username}` });
    } catch (error) {
      if (process.env.NODE_ENV === "development") console.error("Cambiar contraseña:", error);
      return res.status(500).json({ error: "No se pudo actualizar la contraseña" });
    }
  }
);

router.get("/paginated", ...gestoresUsuarios, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 100);
    const skip = (page - 1) * limit;
    const filtro = {};

    if (req.query.busqueda) {
      const q = String(req.query.busqueda).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filtro.$or = [
        { nombre: { $regex: q, $options: "i" } },
        { username: { $regex: q, $options: "i" } },
        { email: { $regex: q, $options: "i" } },
        { celular: { $regex: q, $options: "i" } },
      ];
    }

    if (req.query.role && req.query.role !== "todos") {
      const roleFilter = buildEffectiveRoleFilter(req.query.role);
      if (!roleFilter) return res.status(400).json({ error: "Perfil inválido" });
      Object.assign(filtro, roleFilter);
    }

    if (req.query.includeInactive !== "true") filtro.isActive = { $ne: false };

    const [total, empleados] = await Promise.all([
      Empleado.countDocuments(filtro),
      Empleado.find(filtro).select("-password").sort({ username: 1 }).skip(skip).limit(limit).lean(),
    ]);

    const hoyClave = fechaClaveArgentina();
    const hoyDesde = inicioDiaCalendarioUTC(hoyClave);
    const hoyHasta = finDiaCalendarioUTC(hoyClave);
    const licencias = empleados.length
      ? await NovedadRRHH.find({
          empleadoId: { $in: empleados.map((empleado) => empleado._id) },
          tipo: "licencia-medica",
          estado: "vigente",
          fechaDesde: { $lte: hoyHasta },
          $or: [{ fechaHasta: null }, { fechaHasta: { $gte: hoyDesde } }],
        }).sort({ fechaDesde: -1, createdAt: -1 }).lean()
      : [];
    const licenciaPorEmpleado = new Map();
    for (const licencia of licencias) {
      const key = String(licencia.empleadoId);
      if (!licenciaPorEmpleado.has(key)) licenciaPorEmpleado.set(key, licencia);
    }

    return res.json({
      total,
      page,
      limit,
      assignableRoles: canAssignElevatedRoles(req.user.role, req.user.username)
        ? ASSIGNABLE_ROLES
        : [ROLES.OPERADOR],
      empleados: empleados.map((empleado) => ({
        ...empleadoSeguro(empleado),
        licenciaMedicaActual: licenciaPorEmpleado.get(String(empleado._id)) || null,
      })),
    });
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error("❌ paginated:", error);
    return res.status(500).json({ error: "Error al obtener empleados paginados" });
  }
});

router.put(
  "/:id",
  ...gestoresUsuarios,
  [
    check("id").custom(isObjectId).withMessage("ID inválido"),
    check("email").optional().isEmail().withMessage("El correo no es válido"),
    check("role").optional().isString().withMessage("Rol inválido"),
  ],
  async (req, res) => {
    if (!validar(req, res)) return;

    try {
      const target = await Empleado.findById(req.params.id);
      if (!target) return res.status(404).json({ error: "Empleado no encontrado" });
      if (!canManageTargetUser(req.user, target)) {
        return res.status(403).json({ error: "No tenés permiso para modificar este usuario" });
      }

      const update = {};
      const username = req.body.username !== undefined
        ? String(req.body.username || "").trim().toLowerCase()
        : "";
      const email = req.body.email !== undefined
        ? String(req.body.email || "").trim().toLowerCase()
        : "";

      if (username && username !== target.username) {
        if (isDesignatedSuperAdmin(username)) {
          return res.status(403).json({
            error: "Los nombres de super-admin están reservados y no pueden reasignarse",
          });
        }
        const dupUser = await Empleado.findOne({ username, _id: { $ne: target._id } }).lean();
        if (dupUser) return res.status(409).json({ error: "Ese nombre de usuario ya existe" });
        update.username = username;
      }

      if (email && email !== target.email) {
        const dupEmail = await Empleado.findOne({ email, _id: { $ne: target._id } }).lean();
        if (dupEmail) return res.status(409).json({ error: "Ese correo ya existe" });
        update.email = email;
      }

      if (req.body.nombre !== undefined) update.nombre = String(req.body.nombre || "").trim();
      if (req.body.celular !== undefined) update.celular = String(req.body.celular || "").trim();
      if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
      if (req.body.horarioLaboral !== undefined) update.horarioLaboral = limpiarHorarioLaboral(req.body.horarioLaboral || {});

      if (req.body.role !== undefined) {
        update.role = rolSolicitadoParaActor(req, req.body.role);
      }

      if (req.body.password) update.password = await bcrypt.hash(String(req.body.password), 10);

      const actualizado = await Empleado.findByIdAndUpdate(target._id, update, {
        new: true,
        runValidators: true,
      }).select("-password");

      if (req.body.horarioLaboral !== undefined) invalidateSeguimientoCache();
      return res.json({ message: "✅ Empleado actualizado", empleado: empleadoSeguro(actualizado) });
    } catch (error) {
      if (error?.message?.includes("super-admin") || error?.message === "Rol inválido") {
        return res.status(403).json({ error: error.message });
      }
      if (process.env.NODE_ENV === "development") console.error("❌ actualizar empleado:", error);
      if (error?.statusCode === 400) return res.status(400).json({ error: error.message });
      if (error?.code === 11000) {
        const campo = Object.keys(error.keyPattern || {})[0] || "campo";
        return res.status(409).json({ error: `Duplicado: ${campo} ya está en uso` });
      }
      return res.status(500).json({ error: "Error al actualizar el empleado" });
    }
  }
);

router.delete("/:id", ...gestoresUsuarios, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ error: "ID inválido" });
    if (String(req.user.id) === String(req.params.id)) {
      return res.status(400).json({ error: "No podés eliminar tu propio usuario" });
    }

    const target = await Empleado.findById(req.params.id);
    if (!target) return res.status(404).json({ error: "Empleado no encontrado" });
    if (!canManageTargetUser(req.user, target)) {
      return res.status(403).json({ error: "No tenés permiso para eliminar este usuario" });
    }

    await target.deleteOne();
    return res.json({ message: "✅ Empleado eliminado correctamente" });
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error("❌ eliminar empleado:", error);
    return res.status(500).json({ error: "Error al eliminar empleado" });
  }
});

router.get("/mi-perfil", verifyToken, async (req, res) => {
  try {
    const empleado = await Empleado.findById(req.user.id).select("-password").lean();
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });
    return res.json(empleadoSeguro(empleado));
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error(error);
    return res.status(500).json({ error: "Error al obtener perfil" });
  }
});

router.get("/todos", ...gestoresUsuarios, async (req, res) => {
  try {
    const empleados = await Empleado.find().select("-password").sort({ username: 1 }).lean();
    return res.json(empleados.map(empleadoSeguro));
  } catch (error) {
    if (process.env.NODE_ENV === "development") console.error(error);
    return res.status(500).json({ error: "Error al obtener empleados" });
  }
});

router.patch(
  "/:id/estado",
  ...gestoresUsuarios,
  [
    check("id").custom(isObjectId).withMessage("ID inválido"),
    check("isActive").isBoolean().withMessage("isActive debe ser booleano"),
  ],
  async (req, res) => {
    if (!validar(req, res)) return;

    try {
      if (String(req.user.id) === String(req.params.id) && req.body.isActive === false) {
        return res.status(400).json({ error: "No podés inactivar tu propio usuario" });
      }

      const empleado = await Empleado.findById(req.params.id);
      if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });
      if (!canManageTargetUser(req.user, empleado)) {
        return res.status(403).json({ error: "No tenés permiso para cambiar el estado de este usuario" });
      }

      empleado.isActive = Boolean(req.body.isActive);
      await empleado.save();

      return res.json({ message: "Estado actualizado", empleado: empleadoSeguro(empleado) });
    } catch (error) {
      if (process.env.NODE_ENV === "development") console.error("❌ PATCH /empleados/:id/estado:", error);
      return res.status(500).json({ error: "Error al cambiar estado del empleado" });
    }
  }
);

export default router;
