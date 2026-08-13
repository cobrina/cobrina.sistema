import { claveFechaCalendario, fechaClaveArgentina, mesClaveArgentina } from "./fecha.util.js";

export function minutosTrabajadosDesdeMarcas(marcas = []) {
  const ordenadas = [...(Array.isArray(marcas) ? marcas : [])]
    .filter((m) => m?.fecha)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  let entrada = null;
  let total = 0;
  for (const marca of ordenadas) {
    const fecha = new Date(marca.fecha);
    if (Number.isNaN(fecha.getTime())) continue;
    if (marca.tipo === "entrada") entrada = fecha;
    if (marca.tipo === "salida" && entrada) {
      total += Math.max(0, Math.round((fecha - entrada) / 60000));
      entrada = null;
    }
  }
  return total;
}

export function rangoMesLocal(mes) {
  const match = String(mes || "").match(/^(\d{4})-(\d{2})$/);
  const mesBase = match ? `${match[1]}-${match[2]}` : mesClaveArgentina();
  const [anio, numeroMes] = mesBase.split("-").map(Number);
  const ultimoDia = new Date(Date.UTC(anio, numeroMes, 0, 12)).getUTCDate();
  const desdeClave = `${anio}-${String(numeroMes).padStart(2, "0")}-01`;
  const hastaClave = `${anio}-${String(numeroMes).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`;
  return {
    mes: mesBase,
    // Los campos de pago/novedad son fechas calendario persistidas en UTC.
    desde: new Date(Date.UTC(anio, numeroMes - 1, 1, 0, 0, 0, 0)),
    hasta: new Date(Date.UTC(anio, numeroMes, 0, 23, 59, 59, 999)),
    desdeClave,
    hastaClave,
  };
}

export function minutosDeHorario(entrada, salida) {
  const [eh, em] = String(entrada || "").split(":").map(Number);
  const [sh, sm] = String(salida || "").split(":").map(Number);
  if (![eh, em, sh, sm].every(Number.isFinite)) return 0;
  return Math.max(0, sh * 60 + sm - (eh * 60 + em));
}

export function minutosHoraHHMM(value) {
  const match = String(value || "").trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function bloquesHorarioDesdeNovedad(novedad = null, base = {}) {
  const entrada1 = String(novedad?.horaEntradaNueva || base?.entrada || "").trim();
  const salida1 = String(novedad?.horaSalidaNueva || base?.salida || "").trim();
  const bloques = minutosDeHorario(entrada1, salida1) > 0
    ? [{ entrada: entrada1, salida: salida1 }]
    : [];

  const partida = Boolean(novedad?.jornadaPartidaNueva);
  const entrada2 = String(novedad?.horaEntradaSegundaNueva || "").trim();
  const salida2 = String(novedad?.horaSalidaSegundaNueva || "").trim();
  if (partida && minutosDeHorario(entrada2, salida2) > 0) {
    bloques.push({ entrada: entrada2, salida: salida2 });
  }
  return bloques;
}

export function minutosEsperadosBloques(bloques = []) {
  return (Array.isArray(bloques) ? bloques : []).reduce(
    (total, bloque) => total + minutosDeHorario(bloque?.entrada, bloque?.salida),
    0
  );
}

export function descansoProgramadoSolapadoMin(bloques = [], desdeMin, hastaMin) {
  if (!Number.isFinite(desdeMin) || !Number.isFinite(hastaMin) || hastaMin <= desdeMin) return 0;
  const ordenados = (Array.isArray(bloques) ? bloques : [])
    .map((bloque) => ({
      inicio: minutosHoraHHMM(bloque?.entrada),
      fin: minutosHoraHHMM(bloque?.salida),
    }))
    .filter((bloque) => Number.isFinite(bloque.inicio) && Number.isFinite(bloque.fin) && bloque.fin > bloque.inicio)
    .sort((a, b) => a.inicio - b.inicio);

  let descanso = 0;
  for (let index = 0; index < ordenados.length - 1; index += 1) {
    const inicioDescanso = ordenados[index].fin;
    const finDescanso = ordenados[index + 1].inicio;
    if (finDescanso <= inicioDescanso) continue;
    const inicio = Math.max(desdeMin, inicioDescanso);
    const fin = Math.min(hastaMin, finDescanso);
    if (fin > inicio) descanso += fin - inicio;
  }
  return Math.max(0, Math.round(descanso));
}

// Fuente principal de horas: primera a última gestión del día.
// Si existe una jornada partida, el descanso programado entre bloques no se
// considera tiempo trabajado. Las horas extra antes/después de la franja sí
// quedan visibles porque son actividad elegida por el operador.
export function minutosActividadSegunHorario(primeraMin, ultimaMin, horario = {}) {
  if (!Number.isFinite(primeraMin) || !Number.isFinite(ultimaMin) || ultimaMin <= primeraMin) return 0;
  const bruto = ultimaMin - primeraMin;
  const descanso = descansoProgramadoSolapadoMin(horario?.bloquesHorario || [], primeraMin, ultimaMin);
  return Math.max(0, Math.round(bruto - descanso));
}

export function intervalosAjustadosPorDescanso(intervalos = [], horario = {}) {
  return (Array.isArray(intervalos) ? intervalos : []).map((intervalo) => {
    const desdeMin = Number(intervalo?.desdeMin);
    const hastaMin = Number(intervalo?.hastaMin);
    const duracionMin = Number.isFinite(desdeMin) && Number.isFinite(hastaMin)
      ? Math.max(0, hastaMin - desdeMin)
      : Math.max(0, Number(intervalo?.duracionMin || 0));
    const descansoMin = Number.isFinite(desdeMin) && Number.isFinite(hastaMin)
      ? descansoProgramadoSolapadoMin(horario?.bloquesHorario || [], desdeMin, hastaMin)
      : 0;
    return {
      ...intervalo,
      duracionOriginalMin: Math.round(duracionMin),
      descansoProgramadoMin: Math.round(descansoMin),
      duracionMin: Math.max(0, Math.round(duracionMin - descansoMin)),
    };
  });
}

// Convierte los huecos entre gestiones en tramos que realmente caen dentro de
// horas laborales. Si hay jornada partida, el descanso entre bloques se corta
// por completo: nunca se suma ni se presenta como bache. En horario libre, al
// no existir una franja fija, se conservan los intervalos reales entre gestiones.
// Break flexible por jornada (sin horario fijo):
// - jornada de 4 h: hasta 20 min continuos
// - jornada de 6 h: hasta 30 min continuos
// - horario libre: conserva la referencia operativa de 4 h => 20 min
// El beneficio se aplica una sola vez por día al corte continuo más largo.
export function minutosBreakFlexiblePermitido(horario = {}) {
  if (horario?.horarioLibre) return 20;
  const esperados = Math.max(0, Math.round(Number(horario?.minutosEsperados || 0)));
  if (esperados === 240) return 20;
  if (esperados === 360) return 30;
  return 0;
}

export function aplicarBreakFlexible(intervalos = [], horario = {}) {
  const permitidoMin = minutosBreakFlexiblePermitido(horario);
  const fuente = (Array.isArray(intervalos) ? intervalos : [])
    .map((intervalo, index) => {
      const desdeMin = Number(intervalo?.desdeMin);
      const hastaMin = Number(intervalo?.hastaMin);
      const duracionOriginalMin = Number.isFinite(desdeMin) && Number.isFinite(hastaMin)
        ? Math.max(0, Math.round(hastaMin - desdeMin))
        : Math.max(0, Math.round(Number(intervalo?.duracionMin || 0)));
      return {
        ...intervalo,
        __breakIndex: index,
        duracionOriginalMin,
        breakConsideradoMin: 0,
        breakPermitidoMin: permitidoMin,
        duracionMin: duracionOriginalMin,
      };
    })
    .filter((intervalo) => intervalo.duracionOriginalMin > 0);

  if (!permitidoMin || !fuente.length) {
    return { intervalos: fuente.map(({ __breakIndex, ...rest }) => rest), breakDetalle: null, permitidoMin };
  }

  // Solo hace falta identificar el break cuando el corte ya alcanza 20 min,
  // que es el umbral desde el que los reportes empiezan a vigilar continuidad.
  const candidatos = fuente
    .filter((intervalo) => intervalo.duracionOriginalMin >= 20)
    .sort((a, b) => b.duracionOriginalMin - a.duracionOriginalMin || a.desdeMin - b.desdeMin);
  const elegido = candidatos[0] || null;
  if (!elegido) {
    return { intervalos: fuente.map(({ __breakIndex, ...rest }) => rest), breakDetalle: null, permitidoMin };
  }

  const breakConsideradoMin = Math.min(permitidoMin, elegido.duracionOriginalMin);
  const excedenteMin = Math.max(0, elegido.duracionOriginalMin - breakConsideradoMin);
  const intervalosSalida = fuente.map((intervalo) => {
    const seleccionado = intervalo.__breakIndex === elegido.__breakIndex;
    const { __breakIndex, ...rest } = intervalo;
    if (!seleccionado) return rest;
    return {
      ...rest,
      breakConsideradoMin,
      duracionMin: excedenteMin,
      breakFlexible: true,
    };
  });

  return {
    intervalos: intervalosSalida,
    permitidoMin,
    breakDetalle: {
      desdeMin: elegido.desdeMin,
      hastaMin: elegido.hastaMin,
      duracionOriginalMin: elegido.duracionOriginalMin,
      breakConsideradoMin,
      breakPermitidoMin: permitidoMin,
      excedenteMin,
      actual: Boolean(elegido.actual),
      abiertoAlCorte: Boolean(elegido.abiertoAlCorte),
      corteDatosHora: elegido.corteDatosHora || "",
    },
  };
}

export function intervalosLaboralesSinDescanso(intervalos = [], horario = {}) {
  const fuente = (Array.isArray(intervalos) ? intervalos : [])
    .map((intervalo) => ({
      ...intervalo,
      desdeMin: Number(intervalo?.desdeMin),
      hastaMin: Number(intervalo?.hastaMin),
    }))
    .filter((intervalo) => Number.isFinite(intervalo.desdeMin) && Number.isFinite(intervalo.hastaMin) && intervalo.hastaMin > intervalo.desdeMin);

  const bloques = (Array.isArray(horario?.bloquesHorario) ? horario.bloquesHorario : [])
    .map((bloque) => ({
      inicio: minutosHoraHHMM(bloque?.entrada),
      fin: minutosHoraHHMM(bloque?.salida),
    }))
    .filter((bloque) => Number.isFinite(bloque.inicio) && Number.isFinite(bloque.fin) && bloque.fin > bloque.inicio)
    .sort((a, b) => a.inicio - b.inicio);

  if (!bloques.length) {
    return fuente.map((intervalo) => ({
      ...intervalo,
      duracionMin: Math.max(0, Math.round(intervalo.hastaMin - intervalo.desdeMin)),
    }));
  }

  const resultado = [];
  for (const intervalo of fuente) {
    for (const bloque of bloques) {
      const desdeMin = Math.max(intervalo.desdeMin, bloque.inicio);
      const hastaMin = Math.min(intervalo.hastaMin, bloque.fin);
      if (hastaMin <= desdeMin) continue;
      resultado.push({
        ...intervalo,
        desdeMin,
        hastaMin,
        duracionMin: Math.max(0, Math.round(hastaMin - desdeMin)),
        recortadoPorHorario: desdeMin !== intervalo.desdeMin || hastaMin !== intervalo.hastaMin,
      });
    }
  }
  return resultado.sort((a, b) => a.desdeMin - b.desdeMin || a.hastaMin - b.hastaMin);
}

export function minutoDentroDeBloque(minuto, bloques = []) {
  if (!Number.isFinite(minuto)) return false;
  return (Array.isArray(bloques) ? bloques : []).some((bloque) => {
    const inicio = minutosHoraHHMM(bloque?.entrada);
    const fin = minutosHoraHHMM(bloque?.salida);
    return Number.isFinite(inicio) && Number.isFinite(fin) && minuto >= inicio && minuto <= fin;
  });
}

export function minutoEnDescansoProgramado(minuto, bloques = []) {
  if (!Number.isFinite(minuto)) return false;
  const ordenados = (Array.isArray(bloques) ? bloques : [])
    .map((bloque) => ({ inicio: minutosHoraHHMM(bloque?.entrada), fin: minutosHoraHHMM(bloque?.salida) }))
    .filter((bloque) => Number.isFinite(bloque.inicio) && Number.isFinite(bloque.fin) && bloque.fin > bloque.inicio)
    .sort((a, b) => a.inicio - b.inicio);
  for (let i = 0; i < ordenados.length - 1; i += 1) {
    if (minuto > ordenados[i].fin && minuto < ordenados[i + 1].inicio) return true;
  }
  return false;
}

export function fechaClaveDesdeValor(value) {
  return claveFechaCalendario(value);
}

function fechaClaveADateUTC(fechaClave) {
  const match = String(fechaClave || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0));
}

export function clavesEntre(desdeClave, hastaClave) {
  const desde = fechaClaveADateUTC(desdeClave);
  const hasta = fechaClaveADateUTC(hastaClave);
  if (!desde || !hasta || hasta < desde) return [];
  const claves = [];
  for (let cursor = new Date(desde); cursor <= hasta; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    claves.push(cursor.toISOString().slice(0, 10));
  }
  return claves;
}

export function novedadCubreFecha(novedad, fechaClave) {
  if (!novedad || novedad.estado === "anulado") return false;
  const desde = fechaClaveDesdeValor(novedad.fechaDesde);
  const hasta = fechaClaveDesdeValor(novedad.fechaHasta) || desde;
  return Boolean(desde && fechaClave >= desde && fechaClave <= hasta);
}

export function novedadSolapaRango(novedad, desdeClave, hastaClave) {
  if (!novedad || novedad.estado === "anulado") return false;
  const desde = fechaClaveDesdeValor(novedad.fechaDesde);
  const hasta = fechaClaveDesdeValor(novedad.fechaHasta) || desde;
  return Boolean(desde && desdeClave && hastaClave && desde <= hastaClave && hasta >= desdeClave);
}

function ultimaNovedad(novedades, tipo, fechaClave) {
  return (Array.isArray(novedades) ? novedades : [])
    .filter((novedad) => novedad?.tipo === tipo && novedadCubreFecha(novedad, fechaClave))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || b.fechaDesde) - new Date(a.updatedAt || a.createdAt || a.fechaDesde))[0] || null;
}

/**
 * Devuelve el horario que debe usarse para una fecha concreta.
 * - Una licencia médica vigente deja el esperado del día en 0.
 * - La modalidad libre informa actividad real sin exigir una franja ni horas esperadas.
 * - Un cambio de horario reemplaza entrada/salida únicamente en las fechas cargadas.
 * - Sin novedades se conserva el horario base del empleado.
 */
export function horarioEfectivoParaFecha(empleado, fechaClave, novedades = []) {
  const base = empleado?.horarioLaboral || {};
  const diasBase = Array.isArray(base.dias) && base.dias.length ? base.dias : [1, 2, 3, 4, 5];
  const date = fechaClaveADateUTC(fechaClave);
  const weekday = date?.getUTCDay();
  const modalidad = String(base.modalidad || "fijo").trim().toLowerCase() === "libre" ? "libre" : "fijo";
  const licencia = ultimaNovedad(novedades, "licencia-medica", fechaClave);
  if (licencia) {
    return {
      programado: false,
      licenciaMedica: true,
      cambioHorario: false,
      horarioLibre: modalidad === "libre",
      jornadaPartida: false,
      entrada: "",
      salida: "",
      bloquesHorario: [],
      toleranciaMinutos: 0,
      minutosEsperados: 0,
      novedad: licencia,
      etiqueta: "Licencia médica",
    };
  }

  if (modalidad === "libre") {
    return {
      programado: false,
      licenciaMedica: false,
      cambioHorario: false,
      horarioLibre: true,
      jornadaPartida: false,
      entrada: "",
      salida: "",
      bloquesHorario: [],
      toleranciaMinutos: 0,
      minutosEsperados: 0,
      novedad: null,
      etiqueta: "Horario libre",
    };
  }

  const cambio = ultimaNovedad(novedades, "cambio-horario", fechaClave);
  const bloquesCambio = cambio ? bloquesHorarioDesdeNovedad(cambio, {}) : [];
  const tieneCambioValido = bloquesCambio.length > 0;
  const bloquesBase = bloquesHorarioDesdeNovedad(null, base);
  const bloquesHorario = tieneCambioValido ? bloquesCambio : bloquesBase;
  const entrada = bloquesHorario[0]?.entrada || "";
  const salida = bloquesHorario.at(-1)?.salida || "";
  const programado = tieneCambioValido || diasBase.includes(weekday);
  const minutosEsperados = programado ? minutosEsperadosBloques(bloquesHorario) : 0;
  const toleranciaMinutos = tieneCambioValido
    ? Number(cambio?.toleranciaMinutosNueva ?? base.toleranciaMinutos ?? 10)
    : Number(base.toleranciaMinutos ?? 10);
  const jornadaPartida = bloquesHorario.length > 1;

  return {
    programado: Boolean(programado && minutosEsperados > 0),
    licenciaMedica: false,
    cambioHorario: tieneCambioValido,
    horarioLibre: false,
    jornadaPartida,
    entrada,
    salida,
    bloquesHorario,
    toleranciaMinutos: Number.isFinite(toleranciaMinutos) ? toleranciaMinutos : 10,
    minutosEsperados,
    novedad: cambio,
    etiqueta: minutosEsperados
      ? bloquesHorario.map((bloque) => `${bloque.entrada}–${bloque.salida}`).join(" / ")
      : "Sin horario",
  };
}

export function minutosEsperadosEnRango(empleado, desdeClave, hastaClave, novedades = []) {
  return clavesEntre(desdeClave, hastaClave).reduce(
    (total, fechaClave) => total + horarioEfectivoParaFecha(empleado, fechaClave, novedades).minutosEsperados,
    0
  );
}

export function minutosEsperadosHastaHoy(empleado, mes, novedades = []) {
  const { desdeClave, hastaClave } = rangoMesLocal(mes);
  const hoyClave = fechaClaveArgentina();
  if (hoyClave < desdeClave) return 0;
  const finClave = hoyClave < hastaClave ? hoyClave : hastaClave;
  return minutosEsperadosEnRango(empleado, desdeClave, finClave, novedades);
}
