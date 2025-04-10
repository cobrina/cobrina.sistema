import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";

import contactRoutes from "./routes/contact.js";
import authRoutes from "./routes/authRoutes.js";
import empleadosRoutes from "./routes/empleados.js";
import certificadosRoutes from "./routes/certificados.js";
import emailRoutes from "./routes/email.js";

dotenv.config();

const app = express();
app.set("trust proxy", 1); // ✅ Necesario para rate-limit en Render

const PORT = process.env.PORT || 5000;

// 🛡️ Seguridad HTTP
app.use(helmet());
app.disable("x-powered-by"); // 🔒 Oculta Express

// 🌍 CORS
app.use(cors());

// 📦 Parseo de JSON
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ✅ Rutas
app.use("/", emailRoutes);
app.use("/contacto", contactRoutes);
app.use("/auth", authRoutes);
app.use("/empleados", empleadosRoutes);
app.use("/certificados", certificadosRoutes);

// 🏠 Ruta base
app.get("/", (req, res) => {
  res.send("API de Cobrina funcionando! 🎉");
});

// 🧠 Conexión a MongoDB
if (!process.env.MONGO_URI) {
  console.error("❌ Error: MONGO_URI no definido en .env");
  process.exit(1);
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Conectado a MongoDB"))
  .catch((err) => {
    console.error("❌ Error en MongoDB:", err.message);
    process.exit(1);
  });

// 🚀 Iniciar servidor
app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${PORT}`);
});
