import mongoose from "mongoose";
import dotenv from "dotenv";
import Cartera from "../models/Cartera.js";

dotenv.config();

const carteras = [
  {
    nombre: "COMAFI",
    datosHtml: `<ul><li>Razón Social: DIRECT CONTACT SOLUTIONS S.A</li><li>N° cuenta: 0082477-2 999-0</li><li>CUIT: 30-71732811-2 Banco Galicia</li><li>Alias: RDCCOLLECTIONS-01</li><li>CBU: 0070999020000082477200</li></ul>`,
    direccionTexto: "Tucumán 829, 2do piso, CABA",
  },
  {
    nombre: "CREDITIA",
    datosHtml: `<ul><li>Razón Social: CREDITIA FIDEICOMISO FINANCIERO</li><li>CUIT: 30-71213737-8</li><li>Banco Santander Río</li><li>Cta. Cte. Nro. 32820/5 Suc 000</li><li>CBU: 0720000720000003282054</li></ul>`,
    direccionTexto: "BOUCHARD 680, Piso 6, CABA",
  },
  {
    nombre: "RDA",
    datosHtml: `<ul><li>Razón Social: RECUPERO DE ACTIVOS FIDEICOMISO FINANCIERO</li><li>CUIT: 33-71573296-9</li><li>ALIAS: FideicomisoRDA</li><li>Banco Galicia</li><li>CTA: N° 0004194-6 024-7</li><li>CBU: 0070024520000004194671</li></ul>`,
    direccionTexto: "Tucumán 829, 2do piso, CABA",
  },
  {
    nombre: "CREDIPAZ",
    datosHtml: `<ul><li>Razón Social: FIDES CAPITAL S.A</li><li>CUIT: 33-71657750-9</li><li>CTA: 143037609</li><li>CBU: 0340143500143037609001</li></ul>`,
    direccionTexto: "Tucumán 829, 2do piso, CABA",
  },
  {
    nombre: "SOCIEDAD_DE_CREDITO",
    datosHtml: `<ul><li>Razón Social: SOCIEDAD DE CRÉDITO S.A</li><li>Banco Galicia</li><li>CUIT: 30-71531549-8</li><li>Alias: FILA.ALA.TENIS</li><li>CTA: 9674-8-327-9</li><li>CBU: 0070327520000009674891</li></ul>`,
    direccionTexto: "Tucumán 829, 2do piso, CABA",
  },
  {
    nombre: "ANTICIPO",
    datosHtml: `<ul><li>Razón Social: BARSATEX S.A</li><li>N° cuenta: 0008882-8 066-2</li><li>CUIT: 30-71568709-3</li><li>Alias: Anticipo.Argentina</li><li>CBU: 0070066520000008882822</li></ul>`,
    direccionTexto: "Tucumán 829, 2do piso, CABA",
  },
  {
    nombre: "GPYC_CREDITO_DIRECTO",
    datosHtml: `<ul><li>Razón Social: EGEO S.A.C.I</li><li>CUIT: 30-51253606-5</li><li>Cuenta corriente: N° 301400000521451</li><li>CBU: 3380014930000005214515</li></ul>`,
    direccionTexto: "Tucumán 829, 2do piso, CABA",
  },
  {
    nombre: "GPYC_MACRO",
    datosHtml: `<ul><li>Razón Social: BANCO MACRO - CONVENIO SECANE</li><li>CUIT: 30-50001008-4</li><li>CBU: 2850811330094169696931</li></ul>`,
    direccionTexto: "Tucumán 829, 2do piso, CABA",
  },
  {
    nombre: "GPYC_BST",
    datosHtml: `<ul><li>Razón Social: BANCO DE SERVICIOS Y TRANSACCIONES S.A</li><li>CUIT: 30-70496099-5</li><li>CTA: 01-20-24301</li><li>CBU: 3380014930000000243015</li></ul>`,
    direccionTexto: "Tucumán 829, 2do piso, CABA",
  },
  {
    nombre: "GRUPO_BIA",
    datosHtml: `<ul><li>Razón Social: BIA SRL</li><li>CUIT: 33-71793795-9</li><li>Alias: GRUPOBIA.BBVA</li><li>CBU: 0170123020000000951906</li></ul>`,
    direccionTexto: "Tucumán 829, 2do piso, CABA",
  },
  {
    nombre: "FF_GREEN_LIGHT",
    datosHtml: `<ul><li>Razón Social: DIRECT CONTACT SOLUTIONS S.A</li><li>N° cuenta: 0082477-2 999-0</li><li>CUIT: 30-71732811-2 Banco Galicia</li><li>Alias: RDCCOLLECTIONS-01</li><li>CBU: 0070999020000082477200</li></ul>`,
    direccionTexto: "Tucumán 829, 2do piso, CABA",
  },
];

const cargarCarteras = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Conectado a MongoDB");

    for (const { nombre, datosHtml, direccionTexto } of carteras) {
      await Cartera.create({
        nombre,
        datosHtml,
        direccion: direccionTexto,
        editadoPor: "Ceballos1988", // o el usuario admin inicial
      });
    }

    console.log("✅ Carteras insertadas correctamente");
    process.exit();
  } catch (error) {
    console.error("❌ Error al insertar:", error);
    process.exit(1);
  }
};

cargarCarteras();
