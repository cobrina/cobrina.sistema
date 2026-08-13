// BACKEND/server.js - COBRINA RDC
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
import subcesionRoutes from "./routes/subcesionRoutes.js";
import entidadRoutes from "./routes/entidadRoutes.js";
import stickiesRoutes from "./routes/stickiesRoutes.js";
import reportesGestionesRoutes from "./routes/reportesGestiones.js";
import auditoriasRoutes from "./routes/auditorias.js";
import asistenciaRoutes from "./routes/asistenciaRoutes.js";
import agendaRoutes from "./routes/agendaRoutes.js";
import pagosRoutes from "./routes/pagosRoutes.js";
import acuerdosPagoRoutes from "./routes/acuerdosPagoRoutes.js";
import tipsRoutes from "./routes/tipsRoutes.js";
import rrhhRoutes from "./routes/rrhhRoutes.js";
import poderBiaRoutes from "./routes/poderBiaRoutes.js";
import supervisionRoutes from "./routes/supervisionRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import { procesarCierresAutomaticos } from "./controllers/asistenciaController.js";
import { limpiarRegistrosPersonalesAntiguos } from "./utils/retencionPersonal.js";

dotenv.config();

const requiredEnv = ["MONGO_URI", "JWT_SECRET"];
const missingEnv = requiredEnv.filter((key) => !String(process.env[key] || "").trim());
if (missingEnv.length) {
  console.error(`❌ Faltan variables de entorno obligatorias: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const app = express();
const BUILD_ID = "rdc-green-light-ui-2026-08-06.10";
const PORT = Number(process.env.PORT) || 5000;
let httpServer = null;
let shuttingDown = false;

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet());
app.use(compression());

const defaultOrigins = [
  "http://localhost:5173",
  "https://cobrina-rdc.netlify.app",
];
const envOrigins = String(process.env.CORS_ORIGINS || process.env.FRONTEND_URL || "")
  .split(",")
  .map((value) => value.trim().replace(/\/$/, ""))
  .filter(Boolean);
const allowedOrigins = new Set([...defaultOrigins, ...envOrigins]);

const corsOptions = {
  origin(origin, callback) {
    const normalizedOrigin = String(origin || "").replace(/\/$/, "");
    if (!origin || allowedOrigins.has(normalizedOrigin)) {
      return callback(null, true);
    }
    const error = new Error("Origen no autorizado por CORS");
    error.status = 403;
    return callback(error);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Cobrina-Confirm-Delete"],
  exposedHeaders: ["Content-Disposition", "Content-Length", "X-Cobrina-Export-Rows"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Pagos e importaciones pueden enviar lotes grandes. Se conserva el límite histórico.
app.use(express.json({ limit: "100mb" }));
app.use(
  express.urlencoded({
    extended: true,
    limit: "100mb",
    parameterLimit: 1_000_000,
  })
);

const ipsBloqueadas = new Set([
  "149.102.242.103",
  "108.162.238.44",
  "10.223.177.97",
  "108.162.246.89",
  "10.223.154.22",
  "186.137.152.45",
]);

app.use((req, res, next) => {
  const forwarded = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  const clientIp = String(forwarded).split(",")[0].trim();
  if (ipsBloqueadas.has(clientIp)) {
    return res.status(403).json({ error: "Acceso denegado" });
  }
  return next();
});

app.use(
  rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Demasiadas solicitudes. Esperá unos segundos y reintentá." },
  })
);

app.get("/health", (_req, res) => {
  const dbState = mongoose.connection.readyState;
  return res.status(dbState === 1 ? 200 : 503).json({
    ok: dbState === 1,
    service: "cobrina-rdc-backend",
    database: dbState === 1 ? "connected" : "unavailable",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/version", (_req, res) => {
  return res.json({
    ok: true,
    service: "cobrina-rdc-backend",
    build: BUILD_ID,
    modulos: {
      rrhh: true,
      supervision: true,
      pagosInternos: true,
      poderesBia: true,
      poderGreenLight: true,
      dashboardPorPerfil: true,
      cambioContrasenas: true,
      acuerdosMango: true,
      misTareas: true,
    },
    rutasCriticas: [
      "/api/pagos",
      "/api/rrhh/resumen-empleados",
      "/api/supervision/resumen",
      "/api/poderes-bia/generar",
      "/api/poderes-bia/generar/green-light",
      "/api/dashboard/resumen",
      "/api/empleados/password-reset/users",
      "/proyecciones/acuerdos-mango",
      "/api/stickies",
    ],
  });
});

app.use("/auth", authRoutes);
app.use("/empleados", empleadosRoutes);
app.use("/api/empleados", empleadosRoutes);
app.use("/certificados", certificadosRoutes);
app.use("/proyecciones", proyeccionRoutes);
app.use("/api/proyecciones", proyeccionRoutes); // alias de compatibilidad
app.use("/usuarios", usuarioRoutes);
app.use("/colchon", colchonRoutes);
app.use("/subcesiones", subcesionRoutes);
app.use("/api/subcesiones", subcesionRoutes);
app.use("/entidades", entidadRoutes);
app.use("/api/entidades", entidadRoutes);
app.use("/api/stickies", stickiesRoutes);
app.use("/api/tips", tipsRoutes);
app.use("/api/reportes-gestiones", reportesGestionesRoutes);
app.use("/api/auditorias", auditoriasRoutes);
app.use("/api/asistencia", asistenciaRoutes);
app.use("/api/agenda", agendaRoutes);
app.use("/api/rrhh", rrhhRoutes);
app.use("/rrhh", rrhhRoutes); // alias de compatibilidad
app.use("/api/poderes-bia", poderBiaRoutes);
app.use("/poderes-bia", poderBiaRoutes); // alias de compatibilidad
app.use("/api/supervision", supervisionRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/supervision", supervisionRoutes); // alias de compatibilidad

// Pagos internos habilitados en RDC, con la misma lógica operativa de Procob.
app.use("/api/pagos", pagosRoutes);
app.use("/pagos", pagosRoutes); // alias de compatibilidad
app.use("/api/acuerdos-pago", acuerdosPagoRoutes);

app.get("/", (_req, res) => {
  res.json({ ok: true, message: "API de Cobrina RDC funcionando", build: BUILD_ID });
});

app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

app.use((error, _req, res, _next) => {
  if (
    error?.type === "entity.too.large" ||
    error?.status === 413 ||
    error?.code === "LIMIT_FILE_SIZE"
  ) {
    return res.status(413).json({
      error: "El archivo o la carga es demasiado grande. Límite: 100 MB.",
    });
  }

  if (String(error?.message || "").includes("Formato no permitido")) {
    return res.status(400).json({ error: error.message });
  }

  const status = Number(error?.status) || 500;
  if (process.env.NODE_ENV === "development") {
    console.error("❌ Error HTTP:", error);
  }
  return res.status(status).json({
    error: status >= 500 ? "Error interno del servidor" : error.message,
  });
});

const mongoOptions = {
  family: 4,
  serverSelectionTimeoutMS: 20000,
  connectTimeoutMS: 20000,
  socketTimeoutMS: 90000,
  heartbeatFrequencyMS: 10000,
  maxPoolSize: 25,
  minPoolSize: 2,
  maxIdleTimeMS: 60000,
  retryReads: true,
  retryWrites: true,
};

async function start() {
  try {
    await mongoose.connect(process.env.MONGO_URI, mongoOptions);
    console.log("✅ Conectado a MongoDB");
    console.log("🔒 Los índices y datos existentes no se modifican automáticamente al iniciar.");

    httpServer = app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ API RDC lista en el puerto ${PORT}`);
    });

    await procesarCierresAutomaticos();
    const asistenciaTimer = setInterval(() => {
      procesarCierresAutomaticos();
    }, 60_000);
    asistenciaTimer.unref?.();

    const ejecutarRetencion = async () => {
      try {
        const resultado = await limpiarRegistrosPersonalesAntiguos();
        if (!resultado?.skipped && (resultado?.tareas || resultado?.agenda)) {
          console.log(`🧹 Retención personal: ${resultado.tareas || 0} tareas y ${resultado.agenda || 0} actividades de agenda eliminadas.`);
        }
      } catch (error) {
        console.error("⚠️ No se pudo ejecutar la retención automática de tareas/agenda:", error?.message || error);
      }
    };
    await ejecutarRetencion();
    const retencionTimer = setInterval(ejecutarRetencion, 24 * 60 * 60 * 1000);
    retencionTimer.unref?.();
  } catch (error) {
    console.error("❌ Error conectando a MongoDB:", error?.message || error);
    process.exit(1);
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 Cerrando servidor por ${signal}...`);

  const forceExit = setTimeout(() => process.exit(1), 10000);
  forceExit.unref();

  try {
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
    await mongoose.connection.close(false);
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    console.error("❌ Error durante el cierre:", error?.message || error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
  shutdown("uncaughtException");
});

start();
