import jwt from "jsonwebtoken";

const SIN_VENCIMIENTO = new Set([
  "",
  "0",
  "false",
  "none",
  "never",
  "sin-vencimiento",
  "sin_vencimiento",
]);

export const obtenerConfiguracionVencimiento = () => {
  const valor = String(process.env.JWT_EXPIRES_IN || "").trim();
  const sinVencimiento = SIN_VENCIMIENTO.has(valor.toLowerCase());
  return {
    sinVencimiento,
    expiresIn: sinVencimiento ? "" : valor,
  };
};

export const firmarTokenSesion = (payload) => {
  const { sinVencimiento, expiresIn } = obtenerConfiguracionVencimiento();
  const opciones = { algorithm: "HS256" };
  if (!sinVencimiento) opciones.expiresIn = expiresIn;
  return jwt.sign(payload, process.env.JWT_SECRET, opciones);
};
