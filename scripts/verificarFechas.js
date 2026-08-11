import assert from "node:assert/strict";
import {
  claveFechaCalendario,
  fechaClaveArgentina,
  finDiaArgentinaUTC,
  inicioDiaArgentinaUTC,
  inicioDiaCalendarioUTC,
  mesClaveArgentina,
  siguienteDiaArgentinaUTC,
  toDateOnly,
} from "../utils/fecha.util.js";

const tardeUTC = new Date("2026-08-12T00:30:00.000Z"); // 11/08 21:30 en Buenos Aires
assert.equal(fechaClaveArgentina(tardeUTC), "2026-08-11");
assert.equal(mesClaveArgentina(tardeUTC), "2026-08");

assert.equal(claveFechaCalendario("2026-08-11T00:00:00.000Z"), "2026-08-11");
assert.equal(toDateOnly("2026-08-11").toISOString(), "2026-08-11T12:00:00.000Z");
assert.equal(inicioDiaCalendarioUTC("2026-08-11").toISOString(), "2026-08-11T00:00:00.000Z");

assert.equal(inicioDiaArgentinaUTC("2026-08-11").toISOString(), "2026-08-11T03:00:00.000Z");
assert.equal(siguienteDiaArgentinaUTC("2026-08-11").toISOString(), "2026-08-12T03:00:00.000Z");
assert.equal(finDiaArgentinaUTC("2026-08-11").toISOString(), "2026-08-12T02:59:59.999Z");

console.log(`OK fechas backend · TZ proceso=${process.env.TZ || "sistema"}`);
