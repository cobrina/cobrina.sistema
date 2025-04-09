import express from "express";
import multer from "multer";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

const router = express.Router();
const upload = multer();

// Transporter de contacto (One Page)
const transporterContacto = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Transporter para recibos y certificados (Gmail)
const transporterRecibos = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_GMAIL_USER,
    pass: process.env.SMTP_GMAIL_PASS,
  },
});

router.post("/enviar-recibo", upload.single("archivo"), async (req, res) => {
  try {
    const { emailDestino } = req.body;
    const archivo = req.file;

    if (!archivo) {
      return res.status(400).json({ error: "No se recibió el archivo" });
    }

    await transporterRecibos.sendMail({
      from: `"RDC Collections" <${process.env.SMTP_GMAIL_USER}>`,
      to: emailDestino,
      subject: "📄 Recibo de pago",
      text: "Adjunto encontrarás tu recibo de pago.",
      attachments: [
        {
          filename: archivo.originalname,
          content: archivo.buffer,
        },
      ],
    });

    res.json({ message: "Correo enviado con éxito" });
  } catch (error) {
    console.error("❌ Error al enviar correo:", error);
    res.status(500).json({
      error:
        error.message.includes("Invalid login") ||
        error.message.includes("Application-specific")
          ? "Error de autenticación con Gmail. Verificá tu contraseña de app."
          : error.message || "Error al enviar el correo",
    });
  }
});

router.post("/enviar-certificado", upload.single("archivo"), async (req, res) => {
  try {
    const { emailDestino } = req.body;
    const archivo = req.file;

    if (!archivo) {
      return res.status(400).json({ error: "No se recibió el archivo" });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_GMAIL_HOST,
      port: 465,
      secure: true,
      auth: {
        user: process.env.SMTP_GMAIL_USER,
        pass: process.env.SMTP_GMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: `"RDC Collections" <${process.env.SMTP_GMAIL_USER}>`,
      to: emailDestino,
      subject: `📄 Certificado de deuda – ${archivo.originalname.replace(/_/g, " ").replace(/\.pdf$/, "")}`,
      text: "Adjuntamos su certificado de deuda en formato PDF.",
      attachments: [
        {
          filename: archivo.originalname,
          content: archivo.buffer,
        },
      ],
    });

    res.json({ message: "Correo enviado con éxito" });
  } catch (error) {
    console.error("Error al enviar certificado:", error);
    res.status(500).json({ error: "Error al enviar el certificado" });
  }
});


export default router;
