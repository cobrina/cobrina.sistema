function leerBooleano(nombre, valorPorDefecto = false) {
  const valor = process.env[nombre];
  if (valor === undefined || valor === null || valor === "") return valorPorDefecto;
  return ["1", "true", "si", "sí", "yes", "on"].includes(String(valor).trim().toLowerCase());
}

/**
 * Interruptor de transición.
 *
 * Fuente única de pagos reales: cuando está activa, Colchón y Proyecciones
 * nunca convierten avisos de cuotera u operadores en dinero aplicado.
 * La validación se realiza exclusivamente contra la colección Pago.
 */
export const PAGOS_FUENTE_UNICA_ACTIVA = leerBooleano(
  "PAGOS_FUENTE_UNICA_ACTIVA",
  true
);
