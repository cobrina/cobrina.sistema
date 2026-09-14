import ReporteGestion from "../models/ReporteGestion.js";

const normalizarTexto = (value = "") =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const claveSimple = (value = "") =>
  normalizarTexto(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const claveEntidad = (value = "") => normalizarTexto(value).toUpperCase();

const dniNormalizado = (value = "") => String(value ?? "").replace(/\D/g, "");

export function clavesCasoAcuerdo(row = {}) {
  const dni = dniNormalizado(row?.dni);
  if (!dni) return [];
  const numero = Number(row?.entidadNumero || 0);
  const nombre = claveEntidad(row?.entidad);
  return [
    numero > 0 ? `${dni}|N:${numero}` : "",
    nombre ? `${dni}|T:${nombre}` : "",
  ].filter(Boolean);
}

export const ESTADOS_CUENTA_ACUERDO_BAJADO = [
  "Baja entidad",
  "Asignacion de cuenta",
  "Baja acuerdo",
  "Baja en proceso",
  "Baja interna",
  "Buscando datos",
  "Contactado",
  "Fallecido",
  "Incobrable",
  "Mensaje directo",
  "Mensaje indirecto",
  "No ubicado",
];

const ESTADOS_CUENTA_ACUERDO_BAJADO_KEYS = new Set([
  "baja entidad",
  "asignacion de cuenta",
  "baja acuerdo",
  "baja de acuerdo",
  "baja en proceso",
  "baja interna",
  "buscando datos",
  "contactado",
  "contactada",
  "fallecido",
  "fallecida",
  "incobrable",
  "mensaje directo",
  "mensaje indirecto",
  "no ubicado",
  "no ubicada",
]);

export function esEstadoCuentaFueraDeAcuerdos(value = "") {
  const key = claveSimple(value);
  if (!key) return false;
  if (ESTADOS_CUENTA_ACUERDO_BAJADO_KEYS.has(key)) return true;
  // Mango puede agregar una aclaración después del estado (ej. "Baja acuerdo - ...").
  return [...ESTADOS_CUENTA_ACUERDO_BAJADO_KEYS].some((estado) => key.startsWith(`${estado} `));
}

export function tienePagoValidoAcuerdo(row = {}) {
  const cantidad = Number(row?.cantidadPagosValidos ?? row?.cantidadPagosPosteriores ?? 0);
  const monto = Number(row?.montoPagosValidos ?? row?.montoPagosPosteriores ?? 0);
  const cantidadMismoDia = Number(row?.cantidadPagosMismoDia || 0);
  const montoMismoDia = Number(row?.montoPagosMismoDia || 0);
  const montoPrimerPago = Number(row?.montoPrimerPagoCobrado || 0);
  const estadoPago = claveSimple(row?.estadoPagoAcuerdo || "");
  const estadosConPago = new Set([
    "con pago posterior",
    "con pago valido",
    "pago mismo dia",
    "pago mismo dia valido",
  ]);
  return cantidad > 0 || monto > 0 || cantidadMismoDia > 0 || montoMismoDia > 0 || montoPrimerPago > 0 || estadosConPago.has(estadoPago);
}

export function clasificarSituacionAcuerdo(row = {}) {
  const estadoActual = String(
    row?.estadoCuentaActual ?? row?.ultimaGestionMangoEstadoCuenta ?? row?.estadoCuenta ?? ""
  );
  const tienePago = tienePagoValidoAcuerdo(row);
  const anuladoPorNuevo = Boolean(
    row?.acuerdoAnuladoPorNuevo ||
    row?.acuerdoReemplazadoSinPago ||
    claveSimple(row?.estadoVencimiento || row?.estadoAcuerdo || "") === "anulado x nuevo"
  );

  if (anuladoPorNuevo && !tienePago) {
    return {
      situacionAcuerdo: "ANULADO",
      acuerdoVigente: false,
      acuerdoBajado: true,
      acuerdoAnulado: true,
      acuerdoPagadoBajado: false,
      acuerdoContabilizable: false,
      acuerdoProyectable: false,
      motivoBajaAcuerdo: "Anulado x nuevo (sin pagos)",
    };
  }

  const estadoBajado = esEstadoCuentaFueraDeAcuerdos(estadoActual);
  if (estadoBajado && tienePago) {
    return {
      situacionAcuerdo: "PAGADO_BAJADO",
      acuerdoVigente: true,
      acuerdoBajado: false,
      acuerdoAnulado: false,
      acuerdoPagadoBajado: true,
      acuerdoContabilizable: true,
      // El pago real se conserva en reportería, pero la cuenta ya no debe
      // seguir inflando montos futuros ni vencimientos proyectados.
      acuerdoProyectable: false,
      motivoBajaAcuerdo: estadoActual,
    };
  }

  if (estadoBajado) {
    return {
      situacionAcuerdo: "BAJADO",
      acuerdoVigente: false,
      acuerdoBajado: true,
      acuerdoAnulado: false,
      acuerdoPagadoBajado: false,
      acuerdoContabilizable: false,
      acuerdoProyectable: false,
      motivoBajaAcuerdo: estadoActual,
    };
  }

  return {
    situacionAcuerdo: "ACTIVO",
    acuerdoVigente: true,
    acuerdoBajado: false,
    acuerdoAnulado: false,
    acuerdoPagadoBajado: false,
    acuerdoContabilizable: true,
    acuerdoProyectable: true,
    motivoBajaAcuerdo: "",
  };
}

export function acuerdoSigueEnUniversoActual(row = {}) {
  return clasificarSituacionAcuerdo(row).acuerdoContabilizable;
}

export function acuerdoEsProyectable(row = {}) {
  return clasificarSituacionAcuerdo(row).acuerdoProyectable;
}

export function acuerdoEsBajadoOAnulado(row = {}) {
  const situacion = clasificarSituacionAcuerdo(row).situacionAcuerdo;
  return situacion === "BAJADO" || situacion === "ANULADO";
}

function variantesDni(acuerdos = []) {
  const dnis = [...new Set(acuerdos.map((row) => dniNormalizado(row?.dni)).filter(Boolean))];
  return [...new Set(
    dnis.flatMap((dni) => {
      const numero = Number(dni);
      return Number.isSafeInteger(numero) ? [dni, numero] : [dni];
    })
  )];
}

function snapshotGestion(gestion = {}) {
  return {
    estadoCuentaActual: String(gestion?.estadoCuenta || ""),
    ultimaGestionMangoFecha: gestion?.fecha
      ? new Date(gestion.fecha).toISOString().slice(0, 10)
      : "",
    ultimaGestionMangoHora: String(gestion?.hora || ""),
    ultimaGestionMangoUsuario: String(gestion?.usuario || ""),
    ultimaGestionMangoResultado: String(gestion?.resultadoGestion || ""),
    ultimaGestionMangoEstadoCuenta: String(gestion?.estadoCuenta || ""),
    ultimaGestionMangoTipoContacto: String(gestion?.tipoContacto || ""),
    ultimaGestionMangoObservacion: String(gestion?.observacionGestion || ""),
  };
}

function fechaLimiteMongo(fechaHasta) {
  if (!fechaHasta) return null;
  const d = fechaHasta instanceof Date ? fechaHasta : new Date(fechaHasta);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fechaMinimaAcuerdos(acuerdos = []) {
  let min = null;
  for (const row of acuerdos) {
    const value = row?.fecha;
    let d = null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      d = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
    } else {
      const raw = String(value || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
      d = new Date(`${raw}T00:00:00.000Z`);
    }
    if (!d || Number.isNaN(d.getTime())) continue;
    if (!min || d < min) min = d;
  }
  return min;
}

/**
 * Enriquece cada acuerdo con el ESTADO DE CUENTA de la última gestión del mismo
 * DNI + entidad. Esta función es la fuente canónica para Reportes, Proyecciones,
 * Dashboard y Supervisión, evitando que cada módulo interprete un universo distinto.
 *
 * `fechaHasta` es opcional y sirve para snapshots históricos (p.ej. Supervisión).
 * Sin ese parámetro se toma el estado actual real de Mango.
 */
export async function enriquecerAcuerdosConEstadoCuentaActual(
  acuerdos = [],
  { scope = {}, fechaHasta = null, maxTimeMS = 30000 } = {}
) {
  if (!Array.isArray(acuerdos) || !acuerdos.length) return [];

  const dnis = variantesDni(acuerdos);
  if (!dnis.length) {
    return acuerdos.map((row) => {
      const enriched = {
        ...row,
        estadoCuentaActual: String(row?.estadoCuenta || ""),
        ultimaGestionMangoEstadoCuenta: String(row?.estadoCuenta || ""),
      };
      return { ...enriched, ...clasificarSituacionAcuerdo(enriched) };
    });
  }

  const match = {
    ...scope,
    borrado: { $ne: true },
    dni: { $in: dnis },
  };
  // Nunca necesitamos gestiones anteriores al acuerdo más antiguo del lote:
  // el propio acuerdo ya es una gestión. Acotar por fecha reduce muchísimo la
  // consulta en Dashboard/Supervisión sin cambiar la semántica de “último estado”.
  const desde = fechaMinimaAcuerdos(acuerdos);
  const limite = fechaLimiteMongo(fechaHasta);
  if (desde || limite) {
    match.fecha = {
      ...(desde ? { $gte: desde } : {}),
      ...(limite ? { $lte: limite } : {}),
    };
  }

  // Agrupamos en Mongo para no traer todo el historial de cada DNI. Puede haber
  // más de una variante histórica de entidad; al resolver en memoria elegimos la
  // más reciente que comparta número o nombre canónico con el acuerdo.
  const gestiones = await ReporteGestion.aggregate([
    { $match: match },
    { $sort: { fecha: -1, hora: -1, _id: -1 } },
    {
      $group: {
        _id: {
          dni: "$dni",
          entidadNumero: "$entidadNumero",
          entidad: "$entidad",
        },
        dni: { $first: "$dni" },
        entidadNumero: { $first: "$entidadNumero" },
        entidad: { $first: "$entidad" },
        fecha: { $first: "$fecha" },
        hora: { $first: "$hora" },
        usuario: { $first: "$usuario" },
        resultadoGestion: { $first: "$resultadoGestion" },
        estadoCuenta: { $first: "$estadoCuenta" },
        tipoContacto: { $first: "$tipoContacto" },
        observacionGestion: { $first: "$observacionGestion" },
      },
    },
  ])
    .option({ maxTimeMS, allowDiskUse: true });

  const latestByKey = new Map();
  for (const gestion of gestiones) {
    const snap = snapshotGestion(gestion);
    const stamp = `${snap.ultimaGestionMangoFecha}T${snap.ultimaGestionMangoHora || "00:00:00"}`;
    for (const key of clavesCasoAcuerdo(gestion)) {
      const previo = latestByKey.get(key);
      if (!previo || stamp > previo.__stamp) latestByKey.set(key, { ...snap, __stamp: stamp });
    }
  }

  return acuerdos.map((acuerdo) => {
    let latest = null;
    for (const key of clavesCasoAcuerdo(acuerdo)) {
      const candidate = latestByKey.get(key);
      if (!candidate) continue;
      if (!latest || candidate.__stamp > latest.__stamp) latest = candidate;
    }

    const original = `${String(acuerdo?.fecha || "").slice(0, 10)}T${String(acuerdo?.hora || "00:00:00")}`;
    const estadoFallback = String(acuerdo?.estadoCuenta || "");
    if (!latest) {
      const enriched = {
        ...acuerdo,
        estadoCuentaActual: estadoFallback,
        ultimaGestionMangoEstadoCuenta: String(acuerdo?.ultimaGestionMangoEstadoCuenta || estadoFallback),
      };
      return { ...enriched, ...clasificarSituacionAcuerdo(enriched) };
    }

    const { __stamp, ...visible } = latest;
    const enriched = {
      ...acuerdo,
      ...visible,
      estadoCuentaActual: String(visible.estadoCuentaActual || estadoFallback),
      ultimaGestionMangoEsPosterior: Boolean(visible.ultimaGestionMangoFecha) && __stamp > original,
    };
    return { ...enriched, ...clasificarSituacionAcuerdo(enriched) };
  });
}

export async function filtrarAcuerdosPorEstadoCuentaActual(acuerdos = [], options = {}) {
  const enriquecidos = await enriquecerAcuerdosConEstadoCuentaActual(acuerdos, options);
  const excluidos = enriquecidos.filter((row) => !acuerdoSigueEnUniversoActual(row));
  const activos = enriquecidos.filter(acuerdoSigueEnUniversoActual);
  return {
    rows: activos,
    activos,
    bajados: excluidos,
    excluidos,
    activosCantidad: activos.length,
    bajadosCantidad: excluidos.length,
    excluidosCantidad: excluidos.length,
  };
}
