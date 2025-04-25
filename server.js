import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

// 📦 Rutas
import contactRoutes from "./routes/contact.js";
import authRoutes from "./routes/authRoutes.js";
import empleadosRoutes from "./routes/empleados.js";
import certificadosRoutes from "./routes/certificados.js";
import proyeccionRoutes from './routes/proyeccionRoutes.js';
import usuarioRoutes from "./routes/usuarioRoutes.js";


dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ✅ Trust proxy para Render (necesario para rate-limit y detección de IP)
app.set("trust proxy", 1);

// 🛡️ Seguridad HTTP básica
app.use(helmet());
app.disable("x-powered-by");

// 🌍 CORS
app.use(cors());

// 📦 Parseo de JSON y formularios grandes (hasta 10mb)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// 🔒 IPs bloqueadas (bots o abusos)
const ipsBloqueadas = [
  "149.102.242.103",
  "108.162.238.44",
  "10.223.177.97",
  "108.162.246.89",
  "10.223.154.22"
];

app.use((req, res, next) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  if (ipsBloqueadas.some(bloqueada => ip.includes(bloqueada))) {
    return res.status(403).send("🚫 Acceso denegado.");
  }
  next();
});

// 🛡️ Middleware de Rate Limiting
const limiterLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "⚠️ Demasiados intentos de login. Intentá nuevamente en 15 minutos.",
});

const limiterContacto = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: "⚠️ Demasiados envíos de contacto. Intentá más tarde.",
});

// Aplicar límites
app.use("/auth/login", limiterLogin);
app.use("/contacto", limiterContacto);

// ✅ Rutas activas
app.use("/contacto", contactRoutes);
app.use("/auth", authRoutes);
app.use("/empleados", empleadosRoutes);
app.use("/certificados", certificadosRoutes);
app.use("/proyecciones", proyeccionRoutes); // ✅ Rutas de proyecciones
app.use("/usuarios", usuarioRoutes);

// Ruta base
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
