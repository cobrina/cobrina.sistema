import mongoose from "mongoose";
import Pago from "../models/Pago.js";
import {
  normalizarDni,
  normalizarEntidadNumero,
  normalizarSubCesionId,
} from "../utils/normalizacionNegocio.js";

function inicioDia(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function finDia(valor) {
  const d = inicioDia(valor);
  if (!d) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

export function rangoMesVigente(fecha = new Date()) {
  const base = new Date(fecha);
  return {
    desde: new Date(base.getFullYear(), base.getMonth(), 1, 0, 0, 0, 0),
    hasta: new Date(base.getFullYear(), base.getMonth() + 1, 0, 23, 59, 59, 999),
  };
}

function serializarPago(pago) {
  return {
    _id: pago._id,
    idPago: pago.idPago,
    dni: pago.dni,
    entidadNumero: pago.entidadId,
    subCesionId: pago.subCesionId,
    fechaPago: pago.fechaPago,
    monto: pago.monto,
    conceptoCodigo: pago.conceptoCodigo,
    conceptoTexto: pago.conceptoTexto,
    operadorUsername: pago.operadorUsername,
    estado: pago.estado,
    createdAt: pago.createdAt,
  };
}

/**
 * Busca pagos reales sin permitir nunca una coincidencia por DNI solo.
 * - Con subcesión: DNI + número de entidad + subcesión.
 * - Sin subcesión: DNI + número de entidad, únicamente si los resultados
 *   pertenecen a una sola subcesión. Si hay más, requiere revisión.
 */
export async function buscarPagosReales({
  dni,
  entidadNumero,
  subCesionId = "",
  fechaDesde = null,
  fechaHasta = null,
  fechaCorte = null,
  limite = 500,
} = {}) {
  const dniNormalizado = normalizarDni(dni);
  const numero = normalizarEntidadNumero(entidadNumero);
  const sub = normalizarSubCesionId(subCesionId);

  if (!dniNormalizado || !numero) {
    return {
      estadoVinculacion: "datos-insuficientes",
      mensaje: "La vinculación exige DNI y número de entidad.",
      pagosAplicables: [],
      pagosMismoDia: [],
      pagosAnteriores: [],
      totalAplicable: 0,
    };
  }

  const query = { dni: dniNormalizado, entidadId: numero };
  if (sub) query.subCesionId = new mongoose.Types.ObjectId(sub);

  const desde = fechaDesde ? inicioDia(fechaDesde) : null;
  const hasta = fechaHasta ? finDia(fechaHasta) : null;
  if (desde || hasta) {
    query.fechaPago = {};
    if (desde) query.fechaPago.$gte = desde;
    if (hasta) query.fechaPago.$lte = hasta;
  }

  const pagos = await Pago.find(query)
    .sort({ fechaPago: 1, idPago: 1 })
    .limit(Math.max(1, Math.min(Number(limite) || 500, 2000)))
    .lean({ virtuals: true });

  if (!sub && pagos.length) {
    const subcesiones = [...new Set(pagos.map((p) => String(p.subCesionId || "")).filter(Boolean))];
    if (subcesiones.length > 1) {
      return {
        estadoVinculacion: "requiere-revision",
        mensaje: "Hay pagos del mismo DNI y entidad en más de una subcesión.",
        subCesionesDetectadas: subcesiones,
        pagosAplicables: [],
        pagosMismoDia: [],
        pagosAnteriores: [],
        totalAplicable: 0,
      };
    }
  }

  const corte = inicioDia(fechaCorte);
  const pagosAplicables = [];
  const pagosMismoDia = [];
  const pagosAnteriores = [];

  for (const pago of pagos) {
    const fechaPago = inicioDia(pago.fechaPago);
    if (!corte || (fechaPago && fechaPago.getTime() > corte.getTime())) {
      pagosAplicables.push(serializarPago(pago));
    } else if (fechaPago && fechaPago.getTime() === corte.getTime()) {
      pagosMismoDia.push(serializarPago(pago));
    } else {
      pagosAnteriores.push(serializarPago(pago));
    }
  }

  return {
    estadoVinculacion: pagos.length ? "coincidencia-exacta" : "sin-pagos",
    mensaje: pagos.length
      ? "Coincidencia por DNI, número de entidad y subcesión."
      : "No se encontraron pagos reales con la clave indicada.",
    clave: {
      dni: dniNormalizado,
      entidadNumero: numero,
      subCesionId: sub || null,
    },
    pagosAplicables,
    pagosMismoDia,
    pagosAnteriores,
    totalAplicable: pagosAplicables.reduce((sum, p) => sum + Number(p.monto || 0), 0),
    totalMismoDia: pagosMismoDia.reduce((sum, p) => sum + Number(p.monto || 0), 0),
    totalEncontrado: pagos.reduce((sum, p) => sum + Number(p.monto || 0), 0),
  };
}

export async function buscarPagosMesVigente(params = {}) {
  const { desde, hasta } = rangoMesVigente();
  return buscarPagosReales({ ...params, fechaDesde: desde, fechaHasta: hasta });
}
