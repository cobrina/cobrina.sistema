// BACKEND/server.js - COBRINA RDC
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";

// 📦 Rutas
import authRoutes from "./routes/authRoutes.js";
import empleadosRoutes from "./routes/empleados.js";
import certificadosRoutes from "./routes/certificados.js";
import proyeccionRoutes from "./routes/proyeccionRoutes.js";
import usuarioRoutes from "./routes/usuarioRoutes.js";
import colchonRoutes from "./routes/colchonRoutes.js";
import subcesionRoutes from "./routes/subcesionRoutes.js";
import entidadRoutes from "./routes/entidadRoutes.js";
import stickiesRoutes from "./routes/stickiesRoutes.js";
import tipsRoutes from "./routes/tipsRoutes.js";
import reportesGestionesRoutes from "./routes/reportesGestiones.js"; // ✅ NUEVO

// 👇 Modelo para manejar índices de la colección de reportes
import ReporteGestion from "./models/ReporteGestion.js"; // ✅ NUEVO
import auditoriasRoutes from "./routes/auditorias.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.set("trust proxy", 1);

// 🛡️ Seguridad HTTP
app.use(
  helmet()
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
  const clientIp = String(fwd).split(",")[0].trim();
  if (ipsBloqueadas.some((ip) => ip === clientIp)) {
    return res.status(403).send("🚫 Acceso denegado.");
  }
  next();
});

// 🔒 Rate limit global suave
app.use(
  rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ✅ Rutas activas
app.use("/auth", authRoutes);
app.use("/empleados", empleadosRoutes);
app.use("/certificados", certificadosRoutes);
app.use("/proyecciones", proyeccionRoutes);
app.use("/usuarios", usuarioRoutes);
app.use("/colchon", colchonRoutes);
app.use("/subcesiones", subcesionRoutes);
app.use("/entidades", entidadRoutes);
app.use("/api/stickies", stickiesRoutes);
app.use("/api/tips", tipsRoutes); // Tips de Cobranza
app.use("/api/reportes-gestiones", reportesGestionesRoutes); // ✅ NUEVA RUTA
app.use("/api/auditorias", auditoriasRoutes);

// 🔵 Ruta de prueba
app.get("/", (req, res) => {
  res.send("API de Cobrina funcionando! 🎉");
});

// 🧠 Conexión a MongoDB + índices para ReporteGestion
if (!process.env.MONGO_URI) {
  console.error("❌ Error: MONGO_URI no definido en .env");
  process.exit(1);
}

const mongoOpts = {
  family: 4, // fuerza IPv4 (más amigable para algunos hosts)
  serverSelectionTimeoutMS: 15000,
  connectTimeoutMS: 15000,
  socketTimeoutMS: 45000,
};

mongoose
  .connect(process.env.MONGO_URI, mongoOpts)
  .then(async () => {
    console.log("✅ Conectado a MongoDB");

    // 👉 Gestión explícita de índices para ReporteGestion (igual que PROCob)
    const col = ReporteGestion.collection;
    console.log("📚 Colección ReporteGestion:", col.collectionName);

    // 1) Dropear índices actuales (no borra datos)
    try {
      await col.dropIndexes();
      console.log("🧹 Índices anteriores de ReporteGestion eliminados.");
    } catch (e) {
      const msg = String(e?.message || "");
      if (!msg.includes("ns not found") && !msg.includes("index not found")) {
        console.warn("⚠️ Aviso al eliminar índices:", msg);
      } else {
        console.log("ℹ️ No había índices previos para borrar en ReporteGestion.");
      }
    }

    // 2) Índice ÚNICO principal
    await col.createIndex(
      {
        dni: 1,
        fecha: 1,
        hora: 1,
        usuario: 1,
        tipoContacto: 1,
        resultadoGestion: 1,
        estadoCuenta: 1,
        entidad: 1,
      },
      {
        name: "uniq_dni_fecha_hora_usuario_tipo_result_estado_entidad",
        unique: true,
        // partialFilterExpression: { borrado: false }, // si algún día usás borrado lógico
      }
    );
    console.log("✅ Índice único creado en ReporteGestion.");

    // 3) Índices de apoyo para filtros/listados
    await Promise.all([
      col.createIndex({ fecha: -1 }),
      col.createIndex({ usuario: 1, fecha: -1 }),
      col.createIndex({ entidad: 1, fecha: -1 }),
      col.createIndex({ tipoContacto: 1, fecha: -1 }),
      col.createIndex({ estadoCuenta: 1, fecha: -1 }),
    ]);
    console.log("🔧 Índices de apoyo creados en ReporteGestion.");
  })
  .catch((err) => {
    console.error("❌ Error conectando/sincronizando MongoDB:", err.message);
    process.exit(1);
  });

// 🧠 Captura de errores globales
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("SIGTERM", () => {
  console.log("🛑 Render envió SIGTERM, el servidor está siendo detenido.");
  process.exit(0);
});

// 💓 Mantener vivo el contenedor (solo en desarrollo)
if (process.env.NODE_ENV !== "production") {
  setInterval(() => {
    console.log("💓 Ping de vida para evitar apagado automático");
  }, 5 * 60 * 1000);
}

// 🚀 Lanzar servidor en 0.0.0.0 para Render
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `✅ Escuchando en http://0.0.0.0:${PORT} - API lista para recibir peticiones`
  );
});
