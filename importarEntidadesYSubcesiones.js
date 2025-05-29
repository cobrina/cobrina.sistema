// importarEntidadesYSubcesiones.js
import mongoose from "mongoose";
import dotenv from "dotenv";
import XLSX from "xlsx";
import Entidad from "./models/Entidad.js";
import SubCesion from "./models/SubCesion.js";

// Cargar variables de entorno
dotenv.config();

if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI no definido en .env");
  process.exit(1);
}

// Conectar a MongoDB
try {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Conectado a MongoDB");
} catch (error) {
  console.error("❌ Error conectando a MongoDB:", error.message);
  process.exit(1);
}

// 📌 ENTIDADES
const workbookEnt = XLSX.readFile("./importar/entidades.xlsx");
const hojaEnt = workbookEnt.Sheets[workbookEnt.SheetNames[0]];
const datosEnt = XLSX.utils.sheet_to_json(hojaEnt);

let entidadesImportadas = 0;
for (const fila of datosEnt) {
  const numero = fila["iD"] || fila["ID"] || fila["id"] || fila["Id"];
  const nombre = fila["Descripcion"] || fila["Nombre"] || fila["descripcion"];

  if (!numero || !nombre) {
    console.warn("⚠️ Fila inválida:", fila);
    continue;
  }

  try {
    await Entidad.create({ numero, nombre });
    entidadesImportadas++;
  } catch (error) {
    console.warn("⚠️ Error creando entidad:", error.message);
  }
}

console.log(`✅ Entidades importadas: ${entidadesImportadas}`);

// 📌 SUBCESIONES
const workbookSubs = XLSX.readFile("./importar/SubCesiones.xlsx");
const hojaSubs = workbookSubs.Sheets[workbookSubs.SheetNames[0]];
const datosSubs = XLSX.utils.sheet_to_json(hojaSubs);

let subcesionesImportadas = 0;
for (const fila of datosSubs) {
  const nombre = fila["Nombre"];
  if (!nombre) {
    console.warn("⚠️ Fila inválida:", fila);
    continue;
  }

  try {
    await SubCesion.create({ nombre });
    subcesionesImportadas++;
  } catch (error) {
    console.warn("⚠️ Error creando subcesión:", error.message);
  }
}

console.log(`✅ SubCesiones importadas: ${subcesionesImportadas}`);

// Cerrar conexión
await mongoose.disconnect();
console.log("🔌 Desconectado de MongoDB");
