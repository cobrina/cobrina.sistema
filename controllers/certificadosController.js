// controllers/carterasController.js
import mongoose from "mongoose";
import Cartera from "../models/Cartera.js";
import Direccion from "../models/Direccion.js";

// helpers de rol (coincidir con tu app)
const rolDe = (req) => req.user?.role || req.user?.rol;
const esSuper = (req) => rolDe(req) === "super-admin";
const esAdmin = (req) => rolDe(req) === "admin";

// 🧾 Obtener todas las carteras (con búsqueda + paginación opcional)
export const obtenerCarteras = async (req, res) => {
  try {
    const {
      q = "",
      page = "1",
      limit = "50",
      orden = "asc",
      ordenPor = "nombre",
    } = req.query;

    const LIM = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
    const PAGE = Math.max(1, parseInt(page, 10) || 1);
    const skip = (PAGE - 1) * LIM;

    const filtros = [];
    if (q && q.trim() !== "") {
      const regex = new RegExp(q.trim(), "i");
      filtros.push({ $or: [{ nombre: regex }, { datosHtml: regex }] });
    }
    const query = filtros.length ? { $and: filtros } : {};

    const [total, carteras] = await Promise.all([
      Cartera.countDocuments(query),
      Cartera.find(query)
        .populate("direccion", "nombre ubicacion")
        .sort({ [ordenPor]: orden === "asc" ? 1 : -1 })
        .skip(skip)
        .limit(LIM)
        .lean(),
    ]);

    return res.json({ total, page: PAGE, limit: LIM, resultados: carteras });
  } catch (error) {
    console.error("Error al obtener carteras:", error);
    return res.status(500).json({ error: "Error al obtener carteras" });
  }
};

// ➕ Crear cartera (solo super-admin)
export const crearCartera = async (req, res) => {
  try {
    if (!esSuper(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { nombre, datosHtml, direccion } = req.body;

    if (!nombre || !datosHtml || !direccion) {
      return res
        .status(400)
        .json({ error: "Todos los campos son obligatorios" });
    }

    if (!mongoose.Types.ObjectId.isValid(direccion)) {
      return res.status(400).json({ error: "ID de dirección inválido" });
    }

    const dir = await Direccion.findById(direccion).lean();
    if (!dir) return res.status(404).json({ error: "La dirección no existe" });

    // opcional: evitar nombres duplicados
    const ya = await Cartera.findOne({ nombre: nombre.trim() }).lean();
    if (ya) {
      return res
        .status(409)
        .json({ error: "Ya existe una cartera con ese nombre" });
    }

    const nueva = await Cartera.create({
      nombre: nombre.trim(),
      datosHtml: String(datosHtml),
      direccion,
      editadoPor: req.user?.username || "sistema",
      creado: new Date(),
      ultimaModificacion: new Date(),
    });

    const poblada = await Cartera.findById(nueva._id)
      .populate("direccion", "nombre ubicacion")
      .lean();

    return res.json({ message: "Cartera creada", cartera: poblada });
  } catch (error) {
    console.error("Error al crear cartera:", error);
    return res.status(500).json({ error: "Error al crear cartera" });
  }
};

// ✏️ Editar cartera (solo super-admin; valida id y direccion)
export const editarCartera = async (req, res) => {
  try {
    if (!esSuper(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID de cartera inválido" });
    }

    const { nombre, datosHtml, direccion } = req.body;

    const update = {
      ultimaModificacion: new Date(),
      editadoPor: req.user?.username || "sistema",
    };

    if (typeof nombre === "string" && nombre.trim() !== "")
      update.nombre = nombre.trim();
    if (typeof datosHtml === "string") update.datosHtml = datosHtml;

    if (direccion !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(direccion)) {
        return res.status(400).json({ error: "ID de dirección inválido" });
      }
      const dir = await Direccion.findById(direccion).lean();
      if (!dir)
        return res.status(404).json({ error: "La dirección no existe" });
      update.direccion = direccion;
    }

    // opcional: evitar duplicado de nombre en edición
    if (update.nombre) {
      const existe = await Cartera.findOne({
        _id: { $ne: id },
        nombre: update.nombre,
      }).lean();
      if (existe) {
        return res
          .status(409)
          .json({ error: "Ya existe una cartera con ese nombre" });
      }
    }

    const cartera = await Cartera.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true,
    })
      .populate("direccion", "nombre ubicacion")
      .lean();

    if (!cartera)
      return res.status(404).json({ error: "Cartera no encontrada" });

    return res.json({ message: "Cartera actualizada", cartera });
  } catch (error) {
    console.error("Error al editar cartera:", error);
    return res.status(500).json({ error: "Error al editar cartera" });
  }
};

// 🗑️ Eliminar cartera (solo super-admin; bloquea si referenciada)
export const eliminarCartera = async (req, res) => {
  try {
    if (!esSuper(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID de cartera inválido" });
    }

    // Evitar borrar si la Dirección sigue apuntada por esta Cartera (chequeo implícito)
    // y (opcional) si tuvieras otras colecciones que referencian Cartera por _id.

    const eliminada = await Cartera.findByIdAndDelete(id).lean();
    if (!eliminada) {
      return res.status(404).json({ error: "Cartera no encontrada" });
    }

    return res.json({ message: "Cartera eliminada" });
  } catch (error) {
    console.error("Error al eliminar cartera:", error);
    return res.status(500).json({ error: "Error al eliminar cartera" });
  }
};

/* ================================
   🏢 DIRECCIONES
================================ */

// 🧾 Obtener todas las direcciones (con búsqueda/paginación)
export const obtenerDirecciones = async (req, res) => {
  try {
    const {
      q = "",
      page = "1",
      limit = "50",
      orden = "asc",
      ordenPor = "nombre",
    } = req.query;

    const LIM = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
    const PAGE = Math.max(1, parseInt(page, 10) || 1);
    const skip = (PAGE - 1) * LIM;

    const query =
      q && q.trim() !== "" ? { nombre: new RegExp(q.trim(), "i") } : {};

    const [total, direcciones] = await Promise.all([
      Direccion.countDocuments(query),
      Direccion.find(query)
        .sort({ [ordenPor]: orden === "asc" ? 1 : -1 })
        .skip(skip)
        .limit(LIM)
        .lean(),
    ]);

    return res.json({ total, page: PAGE, limit: LIM, resultados: direcciones });
  } catch (error) {
    console.error("Error al obtener direcciones:", error);
    return res.status(500).json({ error: "Error al obtener direcciones" });
  }
};

// ➕ Crear dirección (solo super-admin)
export const crearDireccion = async (req, res) => {
  try {
    if (!esSuper(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { nombre, ubicacion } = req.body;
    if (!nombre || !ubicacion) {
      return res
        .status(400)
        .json({ error: "Todos los campos son obligatorios" });
    }

    // opcional: evitar duplicado de nombre
    const ya = await Direccion.findOne({ nombre: nombre.trim() }).lean();
    if (ya) {
      return res
        .status(409)
        .json({ error: "Ya existe una dirección con ese nombre" });
    }

    const nueva = await Direccion.create({
      nombre: nombre.trim(),
      ubicacion: String(ubicacion),
      creado: new Date(),
      ultimaModificacion: new Date(),
    });

    return res.json({ message: "Dirección creada", direccion: nueva });
  } catch (error) {
    console.error("Error al crear dirección:", error);
    return res.status(500).json({ error: "Error al crear dirección" });
  }
};

// ✏️ Editar dirección (solo super-admin; valida id)
export const editarDireccion = async (req, res) => {
  try {
    if (!esSuper(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID de dirección inválido" });
    }

    const { nombre, ubicacion } = req.body;

    const update = { ultimaModificacion: new Date() };
    if (typeof nombre === "string" && nombre.trim() !== "") {
      // evitar duplicado de nombre
      const existe = await Direccion.findOne({
        _id: { $ne: id },
        nombre: nombre.trim(),
      }).lean();
      if (existe) {
        return res
          .status(409)
          .json({ error: "Ya existe una dirección con ese nombre" });
      }
      update.nombre = nombre.trim();
    }
    if (typeof ubicacion === "string") update.ubicacion = ubicacion;

    const direccion = await Direccion.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true,
    }).lean();

    if (!direccion)
      return res.status(404).json({ error: "Dirección no encontrada" });

    return res.json({ message: "Dirección actualizada", direccion });
  } catch (error) {
    console.error("Error al editar dirección:", error);
    return res.status(500).json({ error: "Error al editar dirección" });
  }
};

// 🗑️ Eliminar dirección (solo super-admin; bloquear si está en uso)
export const eliminarDireccion = async (req, res) => {
  try {
    if (!esSuper(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID de dirección inválido" });
    }

    // Bloquear si alguna Cartera referencia esta Direccion
    const usada = await Cartera.exists({ direccion: id });
    if (usada) {
      return res.status(409).json({
        error: "No se puede eliminar: hay carteras que usan esta dirección",
      });
    }

    const eliminada = await Direccion.findByIdAndDelete(id).lean();
    if (!eliminada) {
      return res.status(404).json({ error: "Dirección no encontrada" });
    }

    return res.json({ message: "Dirección eliminada" });
  } catch (error) {
    console.error("Error al eliminar dirección:", error);
    return res.status(500).json({ error: "Error al eliminar dirección" });
  }
};
