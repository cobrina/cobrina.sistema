import { feriadosArgentinaParaAnio } from "../config/feriadosArgentina.js";
import { agregarHorasHabilesArgentina, horasHabilesEntreArgentina } from "../utils/contactadosTiempo.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const feriados2026 = feriadosArgentinaParaAnio(2026);
[
  "2026-02-16", "2026-02-17", "2026-03-23", "2026-03-24", "2026-04-03",
  "2026-06-15", "2026-07-10", "2026-08-17", "2026-11-23", "2026-12-07",
].forEach((key) => assert(feriados2026.has(key), `Falta feriado 2026: ${key}`));

// Viernes 14/08/2026 18:00 AR. Lunes 17/08 es feriado.
const inicio = new Date("2026-08-14T21:00:00.000Z");
const alerta = agregarHorasHabilesArgentina(inicio, 48);
const critico = agregarHorasHabilesArgentina(inicio, 60);
const vence = agregarHorasHabilesArgentina(inicio, 72);

assert(alerta.toISOString() === "2026-08-19T21:00:00.000Z", `Alerta incorrecta: ${alerta.toISOString()}`);
assert(critico.toISOString() === "2026-08-20T09:00:00.000Z", `Crítico incorrecto: ${critico.toISOString()}`);
assert(vence.toISOString() === "2026-08-20T21:00:00.000Z", `Vencimiento incorrecto: ${vence.toISOString()}`);
assert(horasHabilesEntreArgentina(inicio, vence) === 72, "El intervalo hábil no suma 72 horas");

console.log("✅ Regla Contactados 48/60/72 h hábiles verificada correctamente");
