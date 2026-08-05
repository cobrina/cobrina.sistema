// BACKEND/models/AcuerdoPago.js
import mongoose from "mongoose";

const AcuerdoPagoSchema = new mongoose.Schema(
  {
    // 🔐 Multi-tenant (dueño de los datos)
    propietario: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    // 🔑 Clave única por mes (regla tuya)
    // key = `${mes}|${dni}|${entidad}`
    key: { type: String, required: true },

    // 📅 Mes YYYY-MM
    mes: { type: String, required: true, index: true },

    // Identificación
    dni: { type: String, required: true, index: true },
    entidad: { type: String, required: true, index: true }, // UPPER
    // Número operativo del catálogo Entidades. Es opcional para conservar
    // acuerdos históricos importados antes de la normalización.
    entidadNumero: { type: Number, min: 1, default: null, index: true },
    nombreDeudor: { type: String, default: "" }, // <- viene de personas_cContacto

    // Datos del acuerdo (lo que viene del excel)
    idGestion: { type: String, default: "" },
    resultado: { type: String, default: "" }, // <- Acuerdo libre / Acuerdo parcial / etc

    operador: { type: String, default: "", index: true }, // lower
    estadoCuenta: { type: String, default: "", index: true }, // estadire_9_cDescripcio

    // Normalizados para filtros / orden
    fechaHora: { type: Date, required: true, index: true }, // para decidir "último"
    fecha: { type: Date, required: true, index: true }, // día UTC
    hora: { type: String, default: "00:00:00" },

    // Desmenuzado (como tu Excel)
    tipoAcuerdo: { type: String, default: "", index: true }, // Cancelación / Cuotas con/sin anticipo / Parcial
    cuotasCantidad: { type: Number, default: null },
    montoCuota: { type: Number, default: null },
    primerVto: { type: Date, default: null },

    anticipoMonto: { type: Number, default: 0 },
    anticipoVto: { type: Date, default: null }, // ✅ vencimiento del anticipo

    // ✅ Deuda (en el excel viene “Deuda mínima total” y “Deuda máxima total”)
    deudaMin: { type: Number, default: null },
    deudaMax: { type: Number, default: null },

    // KPIs
    primerPago: { type: Number, default: null },
    montoTotalAcuerdo: { type: Number, default: null },

    // ✅ Observaciones “limpias”
    observacionCorta: { type: String, default: "" },
    observacionResumen: { type: String, default: "" },
    observacionFull: { type: String, default: "" },

    // Auditoría (compat)
    observacionRaw: { type: String, default: "" },
    warnings: [{ type: String }],

    // info del import
    fuenteArchivo: { type: String, default: "" },
  },
  { timestamps: true }
);

// ✅ Único por propietario + key (key ya incluye mes|dni|entidad)
AcuerdoPagoSchema.index(
  { propietario: 1, key: 1 },
  { unique: true, name: "uniq_propietario_key_mes_dni_entidad" }
);

// índices extra útiles (filtros comunes)
AcuerdoPagoSchema.index({ propietario: 1, mes: 1, entidad: 1, dni: 1 });

// ✅ índice para listar por fecha/hora (como tu tabla)
AcuerdoPagoSchema.index({ propietario: 1, fecha: -1, hora: -1 });

export default mongoose.model("AcuerdoPago", AcuerdoPagoSchema, "acuerdos_pago");
