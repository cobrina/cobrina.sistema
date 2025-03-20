import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import contactRoutes from "./routes/contact.js"; // ✅ Importar la ruta

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Conectado a MongoDB"))
  .catch((err) => console.error("❌ Error en MongoDB:", err));

app.get("/", (req, res) => {
  res.send("API de Cobrin funcionando! 🎉");
});

// ✅ Verificar si el backend recibe solicitudes de contacto
app.use("/contacto", (req, res, next) => {
  console.log("📩 Solicitud recibida en /contacto:", req.body);
  next();
}, contactRoutes);

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${PORT}`);
});
