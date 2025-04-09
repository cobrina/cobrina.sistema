import express from "express";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const router = express.Router();

router.post("/", async (req, res) => {
  const { tipo, nombre, empresa, dni, email, telefono, mensaje, token } = req.body;

  // ✅ Validación del token reCAPTCHA
  if (!token) {
    return res.status(400).json({ error: "Token de reCAPTCHA no enviado." });
  }

  try {
    const secretKey = process.env.RECAPTCHA_SECRET;
    const verifyURL = `https://www.google.com/recaptcha/api/siteverify?secret=${secretKey}&response=${token}`;

    const { data } = await axios.post(verifyURL);

    if (!data.success || data.score < 0.5) {
      return res.status(403).json({ error: "⚠️ ReCAPTCHA falló. Actividad sospechosa." });
    }

    console.log("✅ reCAPTCHA validado. Score:", data.score);

  } catch (error) {
    console.error("❌ Error validando reCAPTCHA:", error);
    return res.status(500).json({ error: "Error al verificar el reCAPTCHA." });
  }

  // Validación de campos
  if (
    !nombre ||
    !email ||
    !telefono ||
    !mensaje ||
    (tipo === "empresa" && !empresa) ||
    (tipo === "deudor" && !dni)
  ) {
    return res.status(400).json({ error: "Por favor, completa todos los campos." });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: 465,
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const mailOptions = {
      from: `"RDC Collections" <${process.env.SMTP_USER}>`,
      to: process.env.SMTP_USER,
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

    await transporter.sendMail(mailOptions);
    res.json({ message: "¡Mensaje enviado con éxito!" });

  } catch (error) {
    console.error("❌ Error enviando correo:", error);
    res.status(500).json({ error: "Hubo un error al enviar el mensaje." });
  }
});


export default router;
