import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";

import contactRoutes from "./routes/contact.js";
import authRoutes from "./routes/authRoutes.js";
import empleadosRoutes from "./routes/empleados.js";
import certificadosRoutes from "./routes/certificados.js"; // 👈 lo usás bien acá
import emailRoutes from "./routes/email.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use("/", emailRoutes);

const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Conectado a MongoDB"))
  .catch((err) => console.error("❌ Error en MongoDB:", err));

app.get("/", (req, res) => {
  res.send("API de Cobrina funcionando! 🎉");
});

app.use(
  "/contacto",
  (req, res, next) => {
    console.log("📩 Solicitud recibida en /contacto:", req.body);
    next();
  },
  contactRoutes
);

app.use("/auth", authRoutes);
app.use("/empleados", empleadosRoutes);
app.use("/certificados", certificadosRoutes); // 👈 rutas para certificados

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${PORT}`);
});
