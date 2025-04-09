import nodemailer from "nodemailer";

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

    const pdfBuffer = Buffer.from(base64Pdf.split(",")[1], "base64");

    await transporter.sendMail({
      from: `"RDC Collections" <${process.env.SMTP_USER}>`,
      to: emailDestino,
      subject: "Recibo de pago",
      text: "Adjuntamos su recibo de pago en formato PDF.",
      attachments: [
        {
          filename: nombreArchivo,
          content: pdfBuffer,
        },
      ],
    });

    res.json({ message: "Recibo enviado por correo" });
  } catch (error) {
    console.error("Error al enviar email:", error.message);
    res.status(500).json({ error: "Error al enviar el recibo" });
  }
};
