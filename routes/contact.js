import express from "express";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const router = express.Router();

router.post("/", async (req, res) => {
  const { tipo, nombre, empresa, dni, email, telefono, mensaje } = req.body;


  if (!nombre || !email || !telefono || !mensaje || 
      (tipo === "empresa" && !empresa) || 
      (tipo === "deudor" && !dni)) {
    return res.status(400).json({ error: "Por favor, completa todos los campos." });
  }

  try {
    // Configuración del transporte SMTP
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, // mail.rdccollections.com
      port: 465, // Puerto SSL
      secure: true, // true para SSL
      auth: {
        user: process.env.SMTP_USER, // contacto@rdccollections.com
        pass: process.env.SMTP_PASS, // ZWxbfwzGX8YxmpGyaJ2x
      },
    });

    // Construcción del cuerpo del correo
    const mailOptions = {
      from: `"RDC Collections" <${process.env.SMTP_USER}>`,
      to: process.env.SMTP_USER, // El mismo correo que envía, lo recibe
      subject: "Consulta desde la Web",
      html: `
        <h3>Consulta desde la Web</h3>
        <hr />
        <p><strong>Tipo de contacto:</strong> ${tipo}</p>
        <p><strong>Nombre:</strong> ${nombre}</p>
        ${tipo === "empresa" ? `<p><strong>Empresa:</strong> ${empresa}</p>` : ""}
        ${tipo === "deudor" ? `<p><strong>DNI:</strong> ${dni}</p>` : ""}
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Teléfono:</strong> ${telefono}</p>
        <p><strong>Mensaje:</strong> ${mensaje}</p>
      `,
    };

    // Enviar el correo
    await transporter.sendMail(mailOptions);
    res.json({ message: "¡Mensaje enviado con éxito!" });

  } catch (error) {
    console.error("❌ Error enviando correo:", error);
    res.status(500).json({ error: "Hubo un error al enviar el mensaje." });
  }
});

export default router;
