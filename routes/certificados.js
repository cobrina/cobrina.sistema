// routes/carterasRoutes.js
import express from "express";
import mongoose from "mongoose";
import { check, validationResult, param } from "express-validator";
import verifyToken from "../middleware/verifyToken.js";
import permitirRoles from "../middleware/permitirRoles.js";
import Cartera from "../models/Cartera.js";
import Direccion from "../models/Direccion.js";

// 🆕 NUEVO: importo multer y xlsx
import multer from "multer";
import * as XLSX from "xlsx";

const router = express.Router();

// 🆕 NUEVO: memory storage simple para upload
const upload = multer({ storage: multer.memoryStorage() });

// Admin y super-admin para mutaciones
const soloAdmin = [verifyToken, permitirRoles("admin", "super-admin")];
// Lectura para todos los roles válidos
const lecturaTodos = [
  verifyToken,
  permitirRoles("super-admin", "admin", "operador", "operador-vip"),
];

const validar = (req, res) => {
  const errors = validationResult(req);
  if (!errors.length) return true;
  res.status(400).json({ errors: errors.array() });
  return false;
};

/* ================================
   Helpers
================================ */
// Normaliza "direccion": si viene un ObjectId busca el doc y devuelve el texto.
// Si viene texto, lo devuelve limpio. Si no existe/vale, retorna "".
const normalizarDireccion = async (raw) => {
  if (raw == null) return "";
  const val = String(raw).trim();

  // ¿es un ObjectId?
  if (mongoose.Types.ObjectId.isValid(val)) {
    const d = await Direccion.findById(val).lean();
    if (!d) return "";
    // Ajustá las claves si tu modelo tiene otro nombre del campo
    const texto =
      d.direccion || d.texto || d.nombre || d.address || d.label || "";
    return String(texto).trim();
  }

  // si no es ObjectId, asumimos texto libre
  return val;
};

/* ================================
   🏦 CARTERAS (Transferencias)
================================ */

// ✅ Obtener todas (cualquier rol autenticado)
router.get("/carteras", ...lecturaTodos, async (_req, res) => {
  try {
    const carteras = await Cartera.find().sort({ nombre: 1 }).lean();
    return res.json(carteras);
  } catch (e) {
    if (process.env.NODE_ENV === "development") console.error(e);
    return res.status(500).json({ error: "Error al obtener carteras" });
  }
});

// ➕ Crear (solo admin/super-admin)
router.post(
  "/carteras",
  ...soloAdmin,
  [
    check("nombre")
      .trim()
      .notEmpty()
      .withMessage("⚠️ El nombre es obligatorio"),
    check("datosHtml")
      .trim()
      .notEmpty()
      .withMessage("⚠️ Los datos HTML son obligatorios"),
    check("direccion").custom((v) => {
      if (typeof v === "string" && v.trim() !== "") return true; // texto
      if (mongoose.Types.ObjectId.isValid(String(v))) return true; // o ID
      throw new Error("⚠️ La dirección es obligatoria (texto o ID de dirección)");
    }),
  ],
  async (req, res) => {
    if (!validar(req, res)) return;
    try {
      const { nombre, datosHtml, direccion } = req.body;

      // Convertimos a texto siempre
      const dirTexto = await normalizarDireccion(direccion);
      if (!dirTexto) {
        return res.status(400).json({ error: "Dirección inválida" });
      }

      // Opcional: evitar duplicados por nombre
      const existe = await Cartera.findOne({ nombre: nombre.trim() }).lean();
      if (existe)
        return res.status(409).json({ error: "Ese nombre de cartera ya existe" });

      const nueva = await Cartera.create({
        nombre: nombre.trim(),
        datosHtml: datosHtml.trim(),
        direccion: dirTexto, // 👈 guardamos SIEMPRE texto
        editadoPor: req.user.username,
      });

      return res
        .status(201)
        .json({ message: "Cartera creada", cartera: nueva });
    } catch (e) {
      if (process.env.NODE_ENV === "development") console.error(e);
      return res.status(500).json({ error: "Error al crear cartera" });
    }
  }
);

// ✏️ Editar (solo admin/super-admin)
router.put(
  "/carteras/:id",
  ...soloAdmin,
  [
    param("id")
      .custom((id) => mongoose.Types.ObjectId.isValid(id))
      .withMessage("ID inválido"),
    check("nombre")
      .optional()
      .trim()
      .notEmpty()
      .withMessage("⚠️ El nombre es obligatorio"),
    check("datosHtml")
      .optional()
      .trim()
      .notEmpty()
      .withMessage("⚠️ Los datos HTML son obligatorios"),
    check("direccion")
      .optional()
      .custom((v) => {
        if (typeof v === "string" && v.trim() !== "") return true;
        if (mongoose.Types.ObjectId.isValid(String(v))) return true;
        throw new Error("Dirección inválida (texto o ID)");
      }),
  ],

  async (req, res) => {
    if (!validar(req, res)) return;
    try {
      const update = { editadoPor: req.user.username };

      if (req.body.nombre) update.nombre = req.body.nombre.trim();
      if (req.body.datosHtml) update.datosHtml = req.body.datosHtml.trim();

      if (req.body.direccion) {
        update.direccion = await normalizarDireccion(req.body.direccion);
        if (!update.direccion) {
          return res.status(400).json({ error: "Dirección inválida" });
        }
      }

      const actualizada = await Cartera.findByIdAndUpdate(
        req.params.id,
        update,
        { new: true, runValidators: true }
      );

      if (!actualizada) {
        return res.status(404).json({ error: "Cartera no encontrada" });
      }

      return res.json({ message: "Cartera actualizada", cartera: actualizada });
    } catch (e) {
      if (process.env.NODE_ENV === "development") console.error(e);
      return res.status(500).json({ error: "Error al actualizar cartera" });
    }
  }
);

// 🗑️ Eliminar (solo admin/super-admin)
router.delete("/carteras/:id", ...soloAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const eliminada = await Cartera.findByIdAndDelete(req.params.id);
    if (!eliminada) {
      return res.status(404).json({ error: "Cartera no encontrada" });
    }

    return res.json({ message: "Cartera eliminada" });
  } catch (e) {
    if (process.env.NODE_ENV === "development") console.error(e);
    return res.status(500).json({ error: "Error al eliminar cartera" });
  }
});

/* ================================
   🆕 EXPORT / IMPORT (mínimo cambio)
================================ */

// ⬇️ Exportar TODAS las carteras a Excel (orden limpio)
router.get("/carteras/export", ...soloAdmin, async (_req, res) => {
  try {
    const carteras = await Cartera.find().sort({ nombre: 1 }).lean();

    const fmtAR = (d) =>
      d ? new Date(d).toLocaleString("es-AR", { hour12: false }) : "";

    const rows = carteras.map((c) => ({
      NOMBRE: c.nombre || "",
      DIRECCION: c.direccion || "",
      // HTML sin saltos/espacios extra para que se lea prolijo en Excel
      DATOS_HTML: (c.datosHtml || "").replace(/\s+/g, " ").trim(),
      EDITADO_POR: c.editadoPor || "",
      FECHA_ULTIMA_EDICION: fmtAR(c.updatedAt),
      FECHA_CREACION: fmtAR(c.createdAt),
    }));

    const ws = XLSX.utils.json_to_sheet(rows, { skipHeader: false });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Carteras");

    // (opcional) ajustar ancho columnas
    ws["!cols"] = [
      { wch: 28 }, // NOMBRE
      { wch: 36 }, // DIRECCION
      { wch: 80 }, // DATOS_HTML
      { wch: 20 }, // EDITADO_POR
      { wch: 22 }, // FECHA_ULTIMA_EDICION
      { wch: 22 }, // FECHA_CREACION
    ];

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="carteras_${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx"`
    );
    return res.status(200).send(buf);
  } catch (e) {
    if (process.env.NODE_ENV === "development") console.error(e);
    return res.status(500).json({ error: "Error al exportar carteras" });
  }
});


// ⬆️ Importar carteras desde Excel (upsert por NOMBRE)
router.post(
  "/carteras/import",
  ...soloAdmin,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file?.buffer) {
        return res.status(400).json({ error: "Falta archivo" });
      }

      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

      // Columnas esperadas: NOMBRE, DIRECCION, DATOS_HTML
      const resultados = [];
      const errores = [];

      for (let i = 0; i < rows.length; i++) {
        const fila = rows[i];
        const NOMBRE = String(fila.NOMBRE || "").trim();
        const DIRECCION = String(fila.DIRECCION || "").trim();
        const DATOS_HTML = String(fila.DATOS_HTML || "").trim();

        if (!NOMBRE) {
          errores.push({ fila: i + 2, error: "Falta NOMBRE" });
          continue;
        }
        if (!DIRECCION) {
          errores.push({ fila: i + 2, error: "Falta DIRECCION" });
          continue;
        }

        const update = {
          direccion: DIRECCION,
          datosHtml: DATOS_HTML,
          editadoPor: req.user?.username || "import",
        };

        const prev = await Cartera.findOne({ nombre: NOMBRE }).lean();
        if (!prev) {
          await Cartera.create({ nombre: NOMBRE, ...update });
          resultados.push({ nombre: NOMBRE, accion: "creada" });
        } else {
          await Cartera.findByIdAndUpdate(prev._id, update, {
            new: true,
            runValidators: true,
          });
          resultados.push({ nombre: NOMBRE, accion: "actualizada" });
        }
      }

      return res.json({ ok: true, resultados, errores });
    } catch (e) {
      if (process.env.NODE_ENV === "development") console.error(e);
      return res.status(500).json({ error: "Error al importar carteras" });
    }
  }
);

// 📄 Plantilla XLSX con ejemplo
router.get("/carteras/plantilla", ...soloAdmin, (_req, res) => {
  try {
    const headers = ["NOMBRE", "DIRECCION", "DATOS_HTML"];

    const EJEMPLO_HTML = `<ul style="margin:0; padding:0; list-style:none;">
      <li>Razón Social: NOMBRE DE LA EMPRESA</li>
      <li>Banco: BANCO</li>
      <li>Cuenta: 00000000/0</li>
      <li>CBU: 0000000000000000000000</li>
      <li>Alias: alias.ejemplo.banco</li>
      <li>CUIT: XX-XXXXXXXX-X</li>
    </ul>`;

    const ejemploHtmlPlano = EJEMPLO_HTML.replace(/\s+/g, " ").trim();

    const ejemplo = {
      NOMBRE: "BANCO PRUEBA SA",
      DIRECCION: "Av. Corrientes 1234, CABA",
      DATOS_HTML: ejemploHtmlPlano,
    };

    const ws = XLSX.utils.json_to_sheet([ejemplo], { header: headers });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Plantilla");

    // ancho de columnas cómodo
    ws["!cols"] = [{ wch: 28 }, { wch: 36 }, { wch: 80 }];

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="plantilla_import_carteras.xlsx"'
    );
    return res.status(200).send(buf);
  } catch (e) {
    if (process.env.NODE_ENV === "development") console.error(e);
    return res.status(500).json({ error: "Error al generar plantilla" });
  }
});


export default router;
