// routes/pagosRoutes.js
import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import permitirModulos from "../middleware/permitirModulos.js";

// ⬇️ Ajustá el import del uploader según tu proyecto.
import upload from "../middleware/uploadMiddleware.js";

// Controlador del módulo Pagos
import {
  listPagos,
  exportPagos,
  importPagos,
  importCambiosEstado,
  importRemesas,
  updatePago,
  deletePago,
  kpiHoyVsMesAnterior,
  getPagoByIdPago,
  kpiMtdVsPrev,
  kpiWindowVsPrev,
  kpiUltimosTresMeses,
  analyticsResumen,
  getPagosCatalogos,
  createPagoManual,
} from "../controllers/pagosController.js";

const router = Router();

// Guardas: solo ADMIN y SUPER-ADMIN
const soloAdministradores = [
  verifyToken,
  permitirModulos("pagos"),
];

router.get("/", soloAdministradores, listPagos);
router.get("/catalogos", soloAdministradores, getPagosCatalogos);
router.post("/manual", soloAdministradores, createPagoManual);

router.get("/export", soloAdministradores, exportPagos);

/**
 * KPI: Cobrado hoy vs mismo día hábil del mes anterior
 * (Cuenta TODOS los pagos, sin filtrar por estado)
 * ⚠️ Importante: rutas específicas antes de "/:id(\\d+)" para evitar colisiones
 */
router.get("/kpi/hoy-vs-mes-anterior", soloAdministradores, kpiHoyVsMesAnterior);
router.get("/kpi/mtd-vs-prev", soloAdministradores, kpiMtdVsPrev);
router.get("/kpi/window-vs-prev", soloAdministradores, kpiWindowVsPrev);
router.get("/kpi/ultimos-tres-meses", soloAdministradores, kpiUltimosTresMeses);

/**
 * 📊 NUEVO: analytics resumen (para la solapa de supervisión / operador)
 * Query: fechaDesde, fechaHasta, operador, etc.
 */
router.get("/analytics/resumen", soloAdministradores, analyticsResumen);

/**
 * Import masivo de PAGOS
 * - Recibe archivo (CSV/XLSX) en el campo 'file'
 */
router.post("/import", soloAdministradores, upload.single("file"), importPagos);

/**
 * Import masivo de CAMBIOS DE ESTADO
 * - Columnas: ID_PAGO, NUEVO_ESTADO
 */
router.post(
  "/estados/import",
  soloAdministradores,
  upload.single("file"),
  importCambiosEstado
);

/**
 * Import masivo de REMESAS
 * - Columnas: ID_PAGO, NRO_REMESA (alfanumérico)
 */
router.post(
  "/remesas/import",
  soloAdministradores,
  upload.single("file"),
  importRemesas
);

/**
 * 🔎 Obtener un pago por ID_PAGO (numérico)
 * Debe ir después de las rutas específicas (/export, /kpi, /analytics, /import, etc.)
 */
router.get("/:id(\\d+)", soloAdministradores, getPagoByIdPago);

/**
 * Edición individual (sin tocar estado ni la clave única de negocio)
 */
router.patch("/:id(\\d+)", soloAdministradores, updatePago);

/**
 * Eliminación definitiva del pago
 */
router.delete("/:id(\\d+)", soloAdministradores, deletePago);

export default router;
