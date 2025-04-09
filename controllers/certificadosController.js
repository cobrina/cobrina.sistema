import Cartera from "../models/Cartera.js";
import Direccion from "../models/Direccion.js";

/* ================================
   🏦 CARTERAS (Transferencias)
=================================*/

// 🧾 Obtener todas las carteras
export const obtenerCarteras = async (req, res) => {
  try {
    const carteras = await Cartera.find().populate("direccion");
    res.json(carteras);
  } catch (error) {
    console.error("Error al obtener carteras:", error.message);
    res.status(500).json({ error: "Error al obtener carteras" });
  }
};

// ➕ Crear cartera
export const crearCartera = async (req, res) => {
  try {
    const { nombre, datosHtml, direccion } = req.body;

    if (!nombre || !datosHtml || !direccion) {
      return res.status(400).json({ error: "Todos los campos son obligatorios" });
    }

    // Si es un ObjectId, validamos que exista
    if (mongoose.Types.ObjectId.isValid(direccion)) {
      const direccionExistente = await Direccion.findById(direccion);
      if (!direccionExistente) {
        return res.status(400).json({ error: "La dirección no existe" });
      }
    }

    const nueva = new Cartera({
      nombre,
      datosHtml,
      direccion,
      editadoPor: req.user.username,
    });

    await nueva.save();
    res.json({ message: "Cartera creada", cartera: nueva });
  } catch (error) {
    console.error("Error al crear cartera:", error.message);
    res.status(500).json({ error: "Error al crear cartera" });
  }
};

// ✏️ Editar cartera
export const editarCartera = async (req, res) => {
  try {
    const { direccion } = req.body;

    if (mongoose.Types.ObjectId.isValid(direccion)) {
      const direccionExistente = await Direccion.findById(direccion);
      if (!direccionExistente) {
        return res.status(400).json({ error: "La dirección no existe" });
      }
    }

    const cartera = await Cartera.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        editadoPor: req.user.username,
      },
      { new: true }
    );

    if (!cartera) {
      return res.status(404).json({ error: "Cartera no encontrada" });
    }

    res.json({ message: "Cartera actualizada", cartera });
  } catch (error) {
    console.error("Error al editar cartera:", error.message);
    res.status(500).json({ error: "Error al editar cartera" });
  }
};


// 🗑️ Eliminar cartera
export const eliminarCartera = async (req, res) => {
  try {
    const eliminada = await Cartera.findByIdAndDelete(req.params.id);
    if (!eliminada) {
      return res.status(404).json({ error: "Cartera no encontrada" });
    }
    res.json({ message: "Cartera eliminada" });
  } catch (error) {
    console.error("Error al eliminar cartera:", error.message);
    res.status(500).json({ error: "Error al eliminar cartera" });
  }
};

/* ================================
   🏢 DIRECCIONES (Pago en oficina)
=================================*/

// 🧾 Obtener todas las direcciones
export const obtenerDirecciones = async (req, res) => {
  try {
    const direcciones = await Direccion.find();
    res.json(direcciones);
  } catch (error) {
    console.error("Error al obtener direcciones:", error.message);
    res.status(500).json({ error: "Error al obtener direcciones" });
  }
};

// ➕ Crear dirección
export const crearDireccion = async (req, res) => {
  try {
    const nueva = new Direccion(req.body);
    await nueva.save();
    res.json({ message: "Dirección creada", direccion: nueva });
  } catch (error) {
    console.error("Error al crear dirección:", error.message);
    res.status(500).json({ error: "Error al crear dirección" });
  }
};

// ✏️ Editar dirección
export const editarDireccion = async (req, res) => {
  try {
    const direccion = await Direccion.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!direccion) {
      return res.status(404).json({ error: "Dirección no encontrada" });
    }
    res.json({ message: "Dirección actualizada", direccion });
  } catch (error) {
    console.error("Error al editar dirección:", error.message);
    res.status(500).json({ error: "Error al editar dirección" });
  }
};

// 🗑️ Eliminar dirección
export const eliminarDireccion = async (req, res) => {
  try {
    const eliminada = await Direccion.findByIdAndDelete(req.params.id);
    if (!eliminada) {
      return res.status(404).json({ error: "Dirección no encontrada" });
    }
    res.json({ message: "Dirección eliminada" });
  } catch (error) {
    console.error("Error al eliminar dirección:", error.message);
    res.status(500).json({ error: "Error al eliminar dirección" });
  }
};
