import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";
import PoderBia from "../models/PoderBia.js";
import { normalizarDni } from "../utils/normalizacionNegocio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const assetsDir = path.join(__dirname, "../assets/poder-bia");
const logoBiaPath = path.join(assetsDir, "logo_bia.png");
const firmaLucasPath = path.join(assetsDir, "firma_lucas.png");
const logoGreenLightPath = path.join(assetsDir, "logo_gl.png");
const firmaBravoPath = path.join(assetsDir, "firma_bravo.png");

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function fechaDDMMYYYY(value) {
  if (!value) return "";
  const texto = String(value);
  const soloFecha = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (soloFecha) return `${soloFecha[3]}/${soloFecha[2]}/${soloFecha[1]}`;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const dia = String(date.getUTCDate()).padStart(2, "0");
  const mes = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dia}/${mes}/${date.getUTCFullYear()}`;
}

function fechaLarga(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getUTCDate()} de ${MESES[date.getUTCMonth()]} de ${date.getUTCFullYear()}`;
}

function nombreArchivoSeguro(texto) {
  return String(texto || "PODER")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function prepararDescarga(res, registro, filename) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("X-Cobrina-Document-Id", String(registro._id));
}

export async function generarPoderBia(req, res) {
  try {
    const dni = normalizarDni(req.body.dni);
    const nombreTitular = String(req.body.nombreTitular || "").trim().toUpperCase();
    const cartera = String(req.body.cartera || "").trim();
    const fechaDocumento = req.body.fechaDocumento ? new Date(req.body.fechaDocumento) : new Date();

    if (!dni || !nombreTitular || !cartera || Number.isNaN(fechaDocumento.getTime())) {
      return res.status(400).json({ error: "Completá DNI, titular, cartera y una fecha válida" });
    }

    const registro = await PoderBia.create({
      tipoPoder: "grupo-bia",
      dni,
      nombreTitular,
      cartera,
      fechaDocumento,
      entidadNumero: 54,
      entidadNombre: "GRUPO BIA",
      creadoPor: req.user.id,
    });

    const filename = `${nombreArchivoSeguro(`PODER ${dni} - ${nombreTitular}`)}.pdf`;
    prepararDescarga(res, registro, filename);

    const doc = new PDFDocument({ size: "A4", margins: { top: 36, bottom: 36, left: 85, right: 85 } });
    doc.pipe(res);

    const pageWidth = doc.page.width;
    doc.image(logoBiaPath, pageWidth / 2 - 32, 55, { width: 64, height: 41 });
    doc.font("Helvetica-Bold").fontSize(11).text("Carta poder:", 0, 125, { align: "center" });
    doc.fontSize(12).text("Gestión de Agencia de Cobranzas", 0, 146, { align: "center" });

    const left = 85;
    const rightTextX = pageWidth - 85 - 198;
    doc.font("Helvetica").fontSize(11);
    doc.text("A: quien corresponda", left, 210);
    doc.text("De: BIA S.R.L.", left, 242);
    doc.text("Pje. Sargento Cabral 876 CABA.", left, 257);
    doc.text(`CABA, ${fechaDDMMYYYY(fechaDocumento)}`, rightTextX, 293, { width: 198, align: "right" });
    doc.text("Presente", left, 337);
    doc.text("De nuestra mayor consideración:", left, 359);

    const bodyWidth = pageWidth - 170;
    const p1 = "Mediante el presente documento se procede a habilitar y otorgar suficiente representación en el inicio de la gestión de cobranzas sobre los saldos deudores de los clientes asignados, pertenecientes a las carteras de BIA S.R.L.";
    doc.text(p1, left, 394, { width: bodyWidth, align: "justify", indent: 52, lineGap: 3 });

    const y2 = doc.y + 4;
    doc.text("El presente instrumento es suficiente autorización y habilita a la Agencia ", left, y2, { width: bodyWidth, align: "justify", indent: 52, continued: true, lineGap: 3 });
    doc.font("Helvetica-Bold").text("RDC COLLECTIONS", { continued: true });
    doc.font("Helvetica").text(" realizar la gestión de cobro del titular ", { continued: true });
    doc.font("Helvetica-Bold").text(nombreTitular, { continued: true });
    doc.font("Helvetica").text(" DNI ", { continued: true });
    doc.font("Helvetica-Bold").text(dni, { continued: true });
    doc.font("Helvetica").text(` con la deuda originada con GRUPO BIA – ${cartera}, conforme a las competencias y clausulas incorporadas vigentes en la CO `, { continued: true });
    doc.font("Helvetica-Bold").text("Propuesta de Prestación de Servicios de Agencia de Cobranzas", { continued: true });
    doc.font("Helvetica").text(", aceptada por BIA S.R.L. en calidad de titular.");

    doc.image(firmaLucasPath, pageWidth / 2 - 85, 585, { width: 170, height: 69 });
    doc.font("Helvetica").fontSize(11).text("Lucas Coronel", 0, 658, { align: "center" });
    doc.text("Administrador", 0, 674, { align: "center" });
    doc.end();
  } catch (error) {
    console.error("Generar poder BIA:", error);
    if (!res.headersSent) return res.status(500).json({ error: "No se pudo generar la Carta Poder" });
    return res.end();
  }
}

export async function generarPoderGreenLight(req, res) {
  try {
    const dni = normalizarDni(req.body.dni);
    const nombreTitular = String(req.body.nombreTitular || "").trim().toUpperCase();
    const tratamientoRaw = String(req.body.tratamiento || "").trim().toLowerCase();
    const tratamiento = ["sr", "sra"].includes(tratamientoRaw) ? tratamientoRaw : "";
    const cartera = String(req.body.cartera || "").trim();
    const tipoProducto = String(req.body.tipoProducto || "").trim();
    const numeroProducto = String(req.body.numeroProducto || "").trim().toUpperCase();
    const fechaDocumento = req.body.fechaDocumento ? new Date(req.body.fechaDocumento) : new Date();

    if (!dni || !nombreTitular || !cartera || !tipoProducto || !numeroProducto || Number.isNaN(fechaDocumento.getTime())) {
      return res.status(400).json({
        error: "Completá nombre, DNI, cartera, tipo de producto, número de producto y una fecha válida",
      });
    }

    const registro = await PoderBia.create({
      tipoPoder: "green-light",
      dni,
      nombreTitular,
      tratamiento,
      cartera,
      tipoProducto,
      numeroProducto,
      fechaDocumento,
      entidadNombre: "GREEN LIGHT - BRUBANK",
      creadoPor: req.user.id,
    });

    const filename = `${nombreArchivoSeguro(`PODER GREEN LIGHT ${dni} - ${nombreTitular}`)}.pdf`;
    prepararDescarga(res, registro, filename);

    const doc = new PDFDocument({ size: "A4", margins: { top: 38, bottom: 36, left: 62, right: 62 } });
    doc.pipe(res);
    const pageWidth = doc.page.width;
    const left = 62;
    const bodyWidth = pageWidth - 124;

    doc.image(logoGreenLightPath, pageWidth / 2 - 58, 38, { fit: [116, 92], align: "center", valign: "center" });
    doc.font("Helvetica-Bold").fontSize(12).text(
      "Fideicomiso Financiero Privado Green Light (Brubank S.A.U)",
      left,
      152,
      { width: bodyWidth, align: "center" }
    );

    doc.font("Helvetica").fontSize(10.5).text(
      `Ciudad de Buenos Aires, ${fechaLarga(fechaDocumento)}`,
      left,
      210,
      { width: bodyWidth, align: "right" }
    );
    doc.font("Helvetica").fontSize(11).text("Presente", left, 258, { underline: true });

    const tratamientoTitular = tratamiento === "sra"
      ? "de la Sra. "
      : tratamiento === "sr"
        ? "del Sr. "
        : "de ";
    const p1 = `Por medio del presente en nuestro carácter de acreedores, hacemos constar que el estudio de cobranza RDC Collections y asociados, actualmente se encuentra autorizado como Agente de Recaudación del Fideicomiso Financiero Privado Green Light (Brubank S.A.U), para el cobro de la deuda ${tratamientoTitular}`;
    doc.font("Helvetica").fontSize(10.5).text(p1, left, 310, { width: bodyWidth, align: "justify", indent: 44, continued: true, lineGap: 5 });
    doc.font("Helvetica-Bold").text(nombreTitular, { continued: true });
    doc.font("Helvetica").text(" titular del DNI ", { continued: true });
    doc.font("Helvetica-Bold").text(`${dni}.`);

    const y2 = doc.y + 24;
    doc.font("Helvetica").text("Dicha obligación corresponde a un ", left, y2, { width: bodyWidth, align: "justify", continued: true, lineGap: 5 });
    doc.font("Helvetica-Bold").text(tipoProducto.toUpperCase(), { continued: true });
    doc.font("Helvetica").text(", número de producto N° ", { continued: true });
    doc.font("Helvetica-Bold").text(numeroProducto, { continued: true });
    doc.font("Helvetica").text(" originado en ", { continued: true });
    doc.font("Helvetica-Bold").text(cartera, { continued: true });
    doc.font("Helvetica").text("; siendo SW Invest (SWI) administrador y tenedor.");

    doc.image(firmaBravoPath, pageWidth - 250, 610, { fit: [170, 105], align: "center", valign: "center" });
    doc.font("Helvetica").fontSize(10.5).text("Saluda atentamente", pageWidth - 258, 720, { width: 180, align: "center" });
    doc.text("Apoderado", pageWidth - 258, 736, { width: 180, align: "center" });
    doc.end();
  } catch (error) {
    console.error("Generar poder Green Light:", error);
    if (!res.headersSent) return res.status(500).json({ error: "No se pudo generar la Carta Poder de Green Light" });
    return res.end();
  }
}

export async function listarPoderesBia(req, res) {
  try {
    const query = {};
    if (req.query.dni) query.dni = normalizarDni(req.query.dni);
    if (req.query.tipoPoder) query.tipoPoder = req.query.tipoPoder;
    const items = await PoderBia.find(query)
      .populate("creadoPor", "username nombre")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    return res.json(items);
  } catch {
    return res.status(500).json({ error: "No se pudo obtener el historial de poderes" });
  }
}
