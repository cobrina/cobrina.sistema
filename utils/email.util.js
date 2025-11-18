// utils/email.util.js

// Regex simple/robusto (RFC-lite) con case-insensitive
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;

/** Extrae todos los emails de un string y los normaliza (minúsculas, sin duplicados). */
// BACKEND/utils/email.util.js
export function extraerEmails(s) {
  if (!s) return [];
  const REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
  const arr = String(s).match(REGEX) || [];
  // normalizar a lowercase y únicos
  const uniq = Array.from(new Set(arr.map(m => m.toLowerCase().trim())));
  return uniq;
}


/** Valida un email individual (mismo patrón que arriba, pero anclado). */
export function esEmailValido(email) {
  if (typeof email !== "string") return false;
  const s = email.trim().toLowerCase();
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(s);
}

/** Normaliza un email a minúsculas (si es válido), o devuelve "" si no lo es. */
export function normalizarEmail(email) {
  if (!esEmailValido(email)) return "";
  return email.trim().toLowerCase();
}
