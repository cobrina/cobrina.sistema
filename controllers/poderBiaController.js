import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";
import PoderBia from "../models/PoderBia.js";
import { normalizarDni } from "../utils/normalizacionNegocio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logoPath = path.join(__dirname, "../assets/poder-bia/logo_bia.png");
const firmaPath = path.join(__dirname, "../assets/poder-bia/firma_lucas.png");

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

function nombreArchivoSeguro(texto) {
  return String(texto || "PODER")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
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
      dni,
      nombreTitular,
      cartera,
      fechaDocumento,
      creadoPor: req.user.id,
    });

    const filename = `${nombreArchivoSeguro(`PODER ${dni} - ${nombreTitular}`)}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("X-Cobrina-Document-Id", String(registro._id));

    const doc = new PDFDocument({ size: "A4", margins: { top: 36, bottom: 36, left: 85, right: 85 } });
    doc.pipe(res);

    const pageWidth = doc.page.width;
    doc.image(logoPath, pageWidth / 2 - 32, 55, { width: 64, height: 41 });
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
    const p1 =
      "Mediante el presente documento se procede a habilitar y otorgar suficiente representación en el inicio de la gestión de cobranzas sobre los saldos deudores de los clientes asignados, pertenecientes a las carteras de BIA S.R.L.";
    doc.text(p1, left, 394, {
      width: bodyWidth,
      align: "justify",
      indent: 52,
      lineGap: 3,
    });

    const y2 = doc.y + 4;
    doc.text("El presente instrumento es suficiente autorización y habilita a la Agencia ", left, y2, {
      width: bodyWidth,
      align: "justify",
      indent: 52,
      continued: true,
      lineGap: 3,
    });
    doc.font("Helvetica-Bold").text("RDC COLLECTIONS", { continued: true });
    doc.font("Helvetica").text(" realizar la gestión de cobro del titular ", { continued: true });
    doc.font("Helvetica-Bold").text(nombreTitular, { continued: true });
    doc.font("Helvetica").text(" DNI ", { continued: true });
    doc.font("Helvetica-Bold").text(dni, { continued: true });
    doc.font("Helvetica").text(` con la deuda originada con GRUPO BIA – ${cartera}, conforme a las competencias y clausulas incorporadas vigentes en la CO `, { continued: true });
    doc.font("Helvetica-Bold").text("Propuesta de Prestación de Servicios de Agencia de Cobranzas", { continued: true });
    doc.font("Helvetica").text(", aceptada por BIA S.R.L. en calidad de titular.");

    doc.image(firmaPath, pageWidth / 2 - 85, 585, { width: 170, height: 69 });
    doc.font("Helvetica").fontSize(11).text("Lucas Coronel", 0, 658, { align: "center" });
    doc.text("Administrador", 0, 674, { align: "center" });

    doc.end();
  } catch (error) {
    console.error("Generar poder BIA:", error);
    if (!res.headersSent) return res.status(500).json({ error: "No se pudo generar la Carta Poder" });
    res.end();
  }
}

export async function listarPoderesBia(req, res) {
  try {
    const query = {};
    if (req.query.dni) query.dni = normalizarDni(req.query.dni);
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
