import {
  acuerdoSigueEnUniversoActual,
  esEstadoCuentaFueraDeAcuerdos,
  clasificarSituacionAcuerdo,
} from "../services/acuerdosEstadoActualService.js";

const fuera = [
  "Baja entidad",
  "Asignacion de cuenta",
  "Asignación de cuenta",
  "Baja acuerdo",
  "Baja de acuerdo",
  "Baja acuerdo - sin continuidad",
  "Baja en proceso",
  "Baja interna",
  "Buscando datos",
  "Contactado",
  "Contactada",
  "Fallecido",
  "Fallecida",
  "Incobrable",
  "Mensaje directo",
  "Mensaje indirecto",
  "No ubicado",
  "No ubicada",
];
const dentro = [
  "Acuerdo de pago",
  "Acuerdo cumplido",
  "Pagos a imputar",
  "",
];

for (const estado of fuera) {
  if (!esEstadoCuentaFueraDeAcuerdos(estado)) {
    throw new Error(`Debía quedar como acuerdo bajado: ${estado}`);
  }
  if (acuerdoSigueEnUniversoActual({ estadoCuentaActual: estado })) {
    throw new Error(`El acuerdo no debía seguir activo: ${estado}`);
  }
  const clasificacion = clasificarSituacionAcuerdo({ estadoCuentaActual: estado });
  if (clasificacion.situacionAcuerdo !== "BAJADO" || !clasificacion.acuerdoBajado) {
    throw new Error(`Clasificación incorrecta para acuerdo bajado: ${estado}`);
  }
}

for (const estado of dentro) {
  if (esEstadoCuentaFueraDeAcuerdos(estado)) {
    throw new Error(`No debía quedar bajado: ${estado}`);
  }
  if (!acuerdoSigueEnUniversoActual({ estadoCuentaActual: estado })) {
    throw new Error(`El acuerdo debía seguir activo: ${estado}`);
  }
  const clasificacion = clasificarSituacionAcuerdo({ estadoCuentaActual: estado });
  if (clasificacion.situacionAcuerdo !== "ACTIVO" || !clasificacion.acuerdoVigente) {
    throw new Error(`Clasificación incorrecta para acuerdo activo: ${estado}`);
  }
}

console.log("✅ Regla canónica Activo/Bajado de Estado de Cuenta para Acuerdos verificada correctamente");

for (const estado of fuera) {
  const clasificacionPagada = clasificarSituacionAcuerdo({
    estadoCuentaActual: estado,
    cantidadPagosValidos: 1,
    montoPagosValidos: 1000,
    estadoPagoAcuerdo: "CON PAGO VÁLIDO",
  });
  if (clasificacionPagada.situacionAcuerdo !== "PAGADO_BAJADO" || !clasificacionPagada.acuerdoContabilizable || clasificacionPagada.acuerdoProyectable) {
    throw new Error(`Un acuerdo con pago y estado bajado debía quedar PAGADO_BAJADO: ${estado}`);
  }
}

const anulado = clasificarSituacionAcuerdo({
  estadoCuentaActual: "Acuerdo de pago",
  acuerdoAnuladoPorNuevo: true,
  cantidadPagosValidos: 0,
  montoPagosValidos: 0,
});
if (anulado.situacionAcuerdo !== "ANULADO" || anulado.acuerdoContabilizable || anulado.acuerdoProyectable) {
  throw new Error("ANULADO X NUEVO sin pagos debía quedar fuera de Activos y Proyecciones");
}

console.log("✅ Regla PAGADO_BAJADO y ANULADO X NUEVO verificada correctamente");
