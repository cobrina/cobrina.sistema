import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";
import authRoutes from "./routes/authRoutes.js";
import empleadosRoutes from "./routes/empleados.js";
import certificadosRoutes from "./routes/certificados.js";
import proyeccionRoutes from "./routes/proyeccionRoutes.js";
import usuarioRoutes from "./routes/usuarioRoutes.js";
import colchonRoutes from "./routes/colchonRoutes.js";
import subcesionRoutes from "./routes/subcesionRoutes.js"; // ✅ NUEVO
import entidadRoutes from "./routes/entidadRoutes.js"; // ✅
import stickiesRoutes from "./routes/stickiesRoutes.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ✅ Configuración para Railway / proxies
app.set("trust proxy", 1);

// 🛡️ Seguridad HTTP
app.use(
  helmet() // si servís archivos estáticos cross-origin, podés usar: helmet({ crossOriginResourcePolicy: false })
);
app.disable("x-powered-by");

// 📦 Compresión gzip
app.use(compression());

// 🌍 CORS para producción y desarrollo
const corsOptions = {
  origin(origin, callback) {
    const whitelist = [
      "http://localhost:5173",
      "https://cobrina-rdc.netlify.app",
      "https://cobrina-backend-eue8.onrender.com",
    ];
    // Permitir herramientas sin origin (curl/Postman) o los orígenes de la lista
    if (!origin || whitelist.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("No autorizado por CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // ✅ preflight

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
  const fwd = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  // puede venir "ip1, ip2, ip3"
  const clientIp = String(fwd).split(",")[0].trim();
  if (ipsBloqueadas.some((ip) => ip === clientIp)) {
    return res.status(403).send("🚫 Acceso denegado.");
  }
  next();
});

// 🔒 (Opcional) Rate limit global suave — dejar si lo querés
app.use(
  rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ❗ OJO: no aplicamos acá un limiter para /auth/login
// porque ya lo tenés dentro de routes/authRoutes.js (evitamos duplicado).

// ✅ Rutas activas
app.use("/auth", authRoutes);
app.use("/empleados", empleadosRoutes);
app.use("/certificados", certificadosRoutes);
app.use("/proyecciones", proyeccionRoutes);
app.use("/usuarios", usuarioRoutes);
app.use("/colchon", colchonRoutes);
app.use("/subcesiones", subcesionRoutes); // ✅ NUEVA RUTA ACTIVA
app.use("/entidades", entidadRoutes); // ✅
app.use("/stickies", stickiesRoutes);

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
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

// 🛑 Captura de cierre por Railway
process.on("SIGTERM", () => {
  console.log("🛑 Railway envió SIGTERM, el servidor está siendo detenido.");
  process.exit(0);
});

// 💓 Mantener vivo el contenedor (solo en desarrollo para evitar logs ruidosos)
if (process.env.NODE_ENV !== "production") {
  setInterval(() => {
    console.log("💓 Ping de vida para evitar apagado automático");
  }, 5 * 60 * 1000);
}

// 🚀 Lanzar servidor en 0.0.0.0 para Railway
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `✅ Escuchando en http://0.0.0.0:${PORT} - API lista para recibir peticiones`
  );
});
