import nodemailer from "nodemailer";

// Transporter usando cuenta de Gmail
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_GMAIL_USER,
    pass: process.env.SMTP_GMAIL_PASS,
  },
});

export const enviarRecibo = async (req, res) => {
  try {
    const { emailDestino, nombreArchivo, base64Pdf } = req.body;

    // 🛡️ Validación básica
    if (!emailDestino || !nombreArchivo || !base64Pdf) {
      return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    if (!emailDestino.includes("@")) {
      return res.status(400).json({ error: "Email destino inválido" });
    }

    // Verificar que sea un archivo PDF en base64
    if (!base64Pdf.startsWith("data:application/pdf;base64,")) {
      return res.status(400).json({ error: "Formato de archivo inválido. Solo se acepta PDF en base64." });
    }

    const pdfBuffer = Buffer.from(base64Pdf.split(",")[1], "base64");

    await transporter.sendMail({
      from: `"RDC Collections" <${process.env.SMTP_GMAIL_USER}>`,
      to: emailDestino,
      subject: "📄 Recibo de pago",
      text: "Adjuntamos su recibo de pago en formato PDF.",
      attachments: [
        {
          filename: nombreArchivo,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    res.json({ message: "✅ Recibo enviado por correo" });

  } catch (error) {
    console.error("❌ Error al enviar email:", error.message);
    res.status(500).json({ error: "Error al enviar el recibo. Intente nuevamente." });
  }
};
