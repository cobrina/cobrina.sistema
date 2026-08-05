import "dotenv/config";
import mongoose from "mongoose";
import Entidad from "../models/Entidad.js";
import Proyeccion from "../models/Proyeccion.js";
import Colchon from "../models/Colchon.js";
import AcuerdoPago from "../models/AcuerdoPago.js";
import ReporteGestion from "../models/ReporteGestion.js";

const aplicar = process.argv.includes("--apply");

async function revisarPorObjectId(Modelo, nombre) {
  const docs = await Modelo.find({
    entidadId: { $ne: null },
    $or: [
      { entidadNumero: { $exists: false } },
      { entidadNumero: null },
      { entidadNumero: { $lte: 0 } },
    ],
  })
    .select("_id entidadId entidadNumero dni")
    .lean();

  let corregibles = 0;
  let sinEntidad = 0;
  let actualizados = 0;

  for (const doc of docs) {
    const entidad = await Entidad.findById(doc.entidadId).select("numero nombre").lean();
    if (!entidad?.numero) {
      sinEntidad += 1;
      continue;
    }
    corregibles += 1;
    if (aplicar) {
      await Modelo.updateOne({ _id: doc._id }, { $set: { entidadNumero: Number(entidad.numero) } });
      actualizados += 1;
    }
  }

  return { nombre, revisados: docs.length, corregibles, sinEntidad, actualizados };
}

function normalizarTexto(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

async function revisarPorTexto(Modelo, nombre) {
  const entidades = await Entidad.find({}).select("numero nombre").lean();
  const porTexto = new Map();
  const porNumero = new Map();
  for (const entidad of entidades) {
    const numero = Number(entidad.numero);
    const nombreNormalizado = normalizarTexto(entidad.nombre);
    porNumero.set(numero, numero);
    [
      String(numero),
      nombreNormalizado,
      `${numero} - ${nombreNormalizado}`,
      `${numero}-${nombreNormalizado}`,
    ].forEach((clave) => porTexto.set(normalizarTexto(clave), numero));
  }

  const docs = await Modelo.find({
    $or: [
      { entidadNumero: { $exists: false } },
      { entidadNumero: null },
      { entidadNumero: { $lte: 0 } },
    ],
  })
    .select("_id entidad entidadNumero dni")
    .lean();

  let corregibles = 0;
  let sinEntidad = 0;
  let actualizados = 0;
  const ejemplosSinEntidad = [];

  for (const doc of docs) {
    const texto = String(doc.entidad || "").trim();
    const textoNormalizado = normalizarTexto(texto);
    const numeroInicial = textoNormalizado.match(/^(\d+)\s*(?:-|$)/)?.[1];
    const numeroIngresado = numeroInicial ? Number(numeroInicial) : null;
    const numero =
      (numeroIngresado != null ? porNumero.get(numeroIngresado) : null) ||
      porTexto.get(textoNormalizado);

    if (!numero) {
      sinEntidad += 1;
      if (ejemplosSinEntidad.length < 20) ejemplosSinEntidad.push({ id: doc._id, dni: doc.dni, entidad: texto });
      continue;
    }

    corregibles += 1;
    if (aplicar) {
      await Modelo.updateOne({ _id: doc._id }, { $set: { entidadNumero: numero } });
      actualizados += 1;
    }
  }

  return { nombre, revisados: docs.length, corregibles, sinEntidad, actualizados, ejemplosSinEntidad };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("Falta MONGO_URI");
  await mongoose.connect(process.env.MONGO_URI, {
    family: 4,
    serverSelectionTimeoutMS: 15000,
  });

  const entidadesDuplicadas = await Entidad.aggregate([
    { $group: { _id: "$numero", cantidad: { $sum: 1 }, ids: { $push: "$_id" } } },
    { $match: { cantidad: { $gt: 1 } } },
  ]);

  const resultados = await Promise.all([
    revisarPorObjectId(Proyeccion, "Proyecciones"),
    revisarPorObjectId(Colchon, "Colchón"),
    revisarPorTexto(AcuerdoPago, "Acuerdos de pago"),
    revisarPorTexto(ReporteGestion, "Reporte de gestiones"),
  ]);

  console.log(JSON.stringify({
    modo: aplicar ? "APLICAR" : "SOLO DIAGNOSTICO",
    regla: "El número de Administración > Entidades es el identificador canónico",
    entidadesDuplicadas,
    resultados,
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
