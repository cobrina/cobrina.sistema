import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";

// 📦 Rutas del sistema Cobrina
import authRoutes from "./routes/authRoutes.js";
import empleadosRoutes from "./routes/empleados.js";
import certificadosRoutes from "./routes/certificados.js";
import proyeccionRoutes from "./routes/proyeccionRoutes.js";
import usuarioRoutes from "./routes/usuarioRoutes.js";
import colchonRoutes from "./routes/colchonRoutes.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ✅ Configuración para Railway
app.set("trust proxy", 1);

// 🛡️ Seguridad HTTP
app.use(helmet());
app.disable("x-powered-by");

// 📦 Compresión gzip
app.use(compression());

// 🌍 CORS para producción y desarrollo
const corsOptions = {
  origin: [
    "http://localhost:5173",
    "https://cobrina-rdc.netlify.app"
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
app.use(cors(corsOptions));

// 📦 JSON y formularios grandes
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// 🔒 Bloqueo de IPs sospechosas
const ipsBloqueadas = [
  "149.102.242.103",
  "108.162.238.44",
  "10.223.177.97",
  "108.162.246.89",
  "10.223.154.22",
  "186.137.152.45",
];
app.use((req, res, next) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  if (ipsBloqueadas.some((bloqueada) => ip.includes(bloqueada))) {
    return res.status(403).send("🚫 Acceso denegado.");
  }
  next();
});

// 🔒 Limitar intentos de login
const limiterLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "⚠️ Demasiados intentos de login. Intentá nuevamente en 15 minutos.",
});
app.use("/auth/login", limiterLogin);

// ✅ Rutas activas
app.use("/auth", authRoutes);
app.use("/empleados", empleadosRoutes);
app.use("/certificados", certificadosRoutes);
app.use("/proyecciones", proyeccionRoutes);
app.use("/usuarios", usuarioRoutes);
app.use("/colchon", colchonRoutes);

// 🔵 Ruta de prueba
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
    console.error("❌ Error conectando MongoDB:", err.message);
    process.exit(1);
  });

// 🧠 Captura de errores globales
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// 💓 Mantener vivo el contenedor
setInterval(() => {
  console.log('💓 Ping de vida para evitar apagado automático');
}, 5 * 60 * 1000); // cada 5 minutos

// 🚀 Lanzar servidor en 0.0.0.0 para Railway
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor corriendo en el puerto ${PORT}`);
});
