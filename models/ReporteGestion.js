// BACKEND/models/ReporteGestion.js
import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Orden requerido de columnas de importación:
 * DNI, NOMBRE DEUDOR, FECHA, HORA, USUARIO, TIPO CONTACTO,
 * RESULTADO GESTION, ESTADO DE LA CUENTA, TEL-MAIL MARCADO,
 * OBSERVACION GESTION, ENTIDAD
 *
 * 🔑 Clave única de negocio (CON propietario):
 * PROPIETARIO + DNI + FECHA + HORA + USUARIO + TIPO CONTACTO + RESULTADO GESTION + ESTADO DE LA CUENTA + ENTIDAD
 */

/* =========================
   Helpers de normalización
   ========================= */
// Fecha a “día UTC” (00:00:00Z) para consistencia de rangos
function toDateOnlyUTC(v) {
  if (!v) return v;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return v;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Normalizador de hora a "HH:mm:ss"
function normalizarHoraStr(v) {
  const s = String(v || "").trim();
  if (!s) return "00:00:00";
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const hh = Math.min(23, Math.max(0, Number(m[1] || 0)));
    const mm = Math.min(59, Math.max(0, Number(m[2] || 0)));
    const ss = Math.min(59, Math.max(0, Number(m[3] || 0)));
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(
      2,
      "0"
    )}:${String(ss).padStart(2, "0")}`;
  }
  // Soporte "174412", "835", etc.
  if (/^\d{3,6}$/.test(s)) {
    const p = s.padStart(6, "0");
    const hh = Math.min(23, Number(p.slice(0, 2)));
    const mm = Math.min(59, Number(p.slice(2, 4)));
    const ss = Math.min(59, Number(p.slice(4, 6)));
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(
      2,
      "0"
    )}:${String(ss).padStart(2, "0")}`;
  }
  return "00:00:00";
}

/* =========================
   Schema
   ========================= */
const ReporteGestionSchema = new Schema(
  {
    dni: { type: String, required: true, index: true, trim: true, maxlength: 20 },
    nombreDeudor: { type: String, default: "", trim: true, maxlength: 240 },

    // Día UTC (siempre “sin hora”)
    fecha: { type: Date, required: true, index: true, set: toDateOnlyUTC },

    // HH:mm:ss (string) para consultas y clave natural
    hora: {
      type: String,
      default: "",
      trim: true,
      set: normalizarHoraStr,
      maxlength: 8, // "HH:mm:ss"
    },

    // Operador (username normalizado en minúsculas desde el importador/controlador)
    usuario: { type: String, required: true, index: true, trim: true, maxlength: 120 },

    // Filtros adicionales
    tipoContacto: { type: String, default: "", trim: true, maxlength: 180 },
    resultadoGestion: { type: String, default: "", trim: true, maxlength: 240 },
    estadoCuenta: { type: String, default: "", trim: true, maxlength: 180 },

    // Texto libre del discador (teléfono o mail)
    telMailMarcado: { type: String, default: "", trim: true, maxlength: 1000 },

    // Observación de la gestión
    observacionGestion: { type: String, default: "", trim: true, maxlength: 3000 },

    // Cartera/entidad visible (normalizada a MAYÚSCULAS desde el controlador)
    entidad: { type: String, index: true, default: "", trim: true, maxlength: 120 },

    // Identificador canónico de Entidad.numero. Es la clave usada para cruces con Pagos.
    entidadNumero: { type: Number, index: true, default: null },

    // Derivados útiles (normalizados a minúsculas en pre-save)
    mailsDetectados: { type: [String], default: [] },

    // Housekeeping
    fuenteArchivo: { type: String, default: "", maxlength: 260 },
    propietario: { type: Schema.Types.ObjectId, ref: "Usuario", index: true },
    borrado: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

/** Collation por defecto (case-insensitive, acentos suaves) */
ReporteGestionSchema.set("collation", { locale: "es", strength: 2 });

/* ======================================================
   ÍNDICES: listados, filtros y performance de analytics
   ====================================================== */

// Listados/filtros frecuentes
ReporteGestionSchema.index({ propietario: 1, fecha: -1 });
ReporteGestionSchema.index({ propietario: 1, usuario: 1, fecha: -1 });
ReporteGestionSchema.index({ propietario: 1, entidad: 1, fecha: -1 });
ReporteGestionSchema.index({ propietario: 1, entidadNumero: 1, fecha: -1 });
ReporteGestionSchema.index({ propietario: 1, dni: 1, entidadNumero: 1, fecha: -1 });
ReporteGestionSchema.index({ propietario: 1, tipoContacto: 1, fecha: -1 });
ReporteGestionSchema.index({ propietario: 1, estadoCuenta: 1, fecha: -1 });
ReporteGestionSchema.index({ propietario: 1, resultadoGestion: 1, fecha: -1 });

// Para búsquedas por DNI dentro del scope del propietario
ReporteGestionSchema.index({ propietario: 1, dni: 1, fecha: -1 }); // consultas por DNI + rango
ReporteGestionSchema.index({ propietario: 1, dni: 1 }); // fallback si no hay rango

// 🔥 Claves para el cálculo de “casos nuevos (90 días)” SIN $lookup
// 1) Distinct dni en un rango de fechas → conviene tener fecha al frente
ReporteGestionSchema.index({ propietario: 1, fecha: 1, dni: 1 }, { name: "idx_prop_fecha_dni" });
// 2) También conservamos la variante inversa para otras consultas (ya existente arriba)
ReporteGestionSchema.index({ propietario: 1, dni: 1, fecha: -1 }, { name: "idx_prop_dni_fecha_desc" });

// Ordenamiento típico para listados
ReporteGestionSchema.index(
  { propietario: 1, fecha: -1, hora: -1, _id: 1 },
  { name: "listado_por_propietario_fecha_hora" }
);
ReporteGestionSchema.index(
  { propietario: 1, usuario: 1, fecha: -1, hora: -1 },
  { name: "listado_por_operador_fecha_hora" }
);
ReporteGestionSchema.index(
  { propietario: 1, dni: 1, fecha: -1, usuario: 1 },
  { name: "previo_por_dni_usuario_fecha" }
);

// ✅ Clave ÚNICA de negocio (CON propietario):
// propietario + dni + fecha + hora + usuario + tipoContacto + resultadoGestion + estadoCuenta + entidad
// (Si hora viene vacía, el setter la normaliza a "00:00:00")
ReporteGestionSchema.index(
  {
    propietario: 1, // ✅ clave multi-tenant
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
    unique: true,
    name: "uniq_prop_dni_fecha_hora_usuario_tipo_result_estado_entidad",
    // Si quisieras ignorar borrados lógicos en la unicidad:
    // partialFilterExpression: { borrado: false },
  }
);

/* ======================================================
   Hooks de normalización antes de guardar
   ====================================================== */
ReporteGestionSchema.pre("save", function (next) {
  if (this.dni) this.dni = this.dni.toString().replace(/\D/g, "");
  if (Array.isArray(this.mailsDetectados)) {
    this.mailsDetectados = this.mailsDetectados
      .map((m) => (m || "").toLowerCase().trim())
      .filter(Boolean);
  }
  // fecha ya se normaliza a día UTC por el setter
  // hora ya se normaliza por el setter
  next();
});

const ReporteGestion = mongoose.model("ReporteGestion", ReporteGestionSchema);
export default ReporteGestion;
