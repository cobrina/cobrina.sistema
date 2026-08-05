import mongoose from "mongoose";
import Entidad from "../models/Entidad.js";

export function normalizarDni(valor) {
  return String(valor ?? "").replace(/\D/g, "").trim();
}

export function normalizarEntidadNumero(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const numero = Number(String(valor).trim());
  return Number.isInteger(numero) && numero > 0 ? numero : null;
}

export function normalizarSubCesionId(valor) {
  const id = valor?._id || valor?.id || valor;
  return mongoose.Types.ObjectId.isValid(String(id || "")) ? String(id) : "";
}

export function construirClaveCaso({ dni, entidadNumero, subCesionId = "" }) {
  const dniNormalizado = normalizarDni(dni);
  const numero = normalizarEntidadNumero(entidadNumero);
  const sub = normalizarSubCesionId(subCesionId);
  if (!dniNormalizado || !numero) return "";
  return sub ? `${dniNormalizado}|${numero}|${sub}` : `${dniNormalizado}|${numero}`;
}

/**
 * Acepta el ObjectId histórico de Entidad o el número operativo canónico.
 * Devuelve siempre ambos valores para que los módulos puedan convivir durante
 * la transición sin migraciones destructivas.
 */
export async function resolverEntidadCanonica({ entidadId, entidadNumero } = {}) {
  const numero = normalizarEntidadNumero(entidadNumero);
  const id = entidadId?._id || entidadId?.id || entidadId;

  let entidad = null;
  if (numero) entidad = await Entidad.findOne({ numero }).lean();
  if (!entidad && mongoose.Types.ObjectId.isValid(String(id || ""))) {
    entidad = await Entidad.findById(id).lean();
  }

  if (!entidad) return null;
  return {
    entidadId: entidad._id,
    entidadNumero: Number(entidad.numero),
    entidadNombre: entidad.nombre,
    entidad,
  };
}

export function variantesTextoEntidad(entidad) {
  if (!entidad) return [];
  const numero = normalizarEntidadNumero(entidad.numero);
  const nombre = String(entidad.nombre || "").trim().toUpperCase();
  return [...new Set([
    numero ? String(numero) : "",
    nombre,
    numero && nombre ? `${numero} - ${nombre}` : "",
    numero && nombre ? `${numero}-${nombre}` : "",
  ].filter(Boolean))];
}
