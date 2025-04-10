import express from "express";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import axios from "axios";
import { check, validationResult } from "express-validator";

dotenv.config();

const router = express.Router();

router.post(
  "/",
  [
    check("tipo").isIn(["empresa", "deudor"]).withMessage("Tipo inválido"),
    check("nombre", "El nombre es obligatorio").trim().notEmpty(),
    check("email", "Correo inválido").isEmail(),
    check("telefono", "Teléfono obligatorio").trim().notEmpty(),
    check("mensaje", "Mensaje obligatorio").trim().notEmpty(),
    check("empresa").custom((value, { req }) => {
      if (req.body.tipo === "empresa" && !value) {
        throw new Error("Empresa obligatoria para tipo empresa");
      }
      return true;
    }),
    check("dni").custom((value, { req }) => {
      if (req.body.tipo === "deudor" && !value) {
        throw new Error("DNI obligatorio para tipo deudor");
      }
      return true;
    }),
    check("token", "Token de reCAPTCHA no enviado").notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "Campos inválidos", details: errors.array() });
    }

    const { tipo, nombre, empresa, dni, email, telefono, mensaje, token } = req.body;

    // ✅ Validación de reCAPTCHA
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

    // 📧 Enviar correo con Gmail
    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.SMTP_GMAIL_USER,
          pass: process.env.SMTP_GMAIL_PASS,
        },
      });

      const mailOptions = {
        from: `"RDC Collections" <${process.env.SMTP_GMAIL_USER}>`,
        to: process.env.SMTP_GMAIL_USER,
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
  }
);

export default router;
