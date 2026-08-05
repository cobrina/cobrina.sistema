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
  const ahora = new Date();
  const anio = match ? Number(match[1]) : ahora.getFullYear();
  const numeroMes = match ? Number(match[2]) : ahora.getMonth() + 1;
  return {
    mes: `${anio}-${String(numeroMes).padStart(2, "0")}`,
    desde: new Date(anio, numeroMes - 1, 1, 0, 0, 0, 0),
    hasta: new Date(anio, numeroMes, 0, 23, 59, 59, 999),
    desdeClave: `${anio}-${String(numeroMes).padStart(2, "0")}-01`,
    hastaClave: `${anio}-${String(numeroMes).padStart(2, "0")}-${String(new Date(anio, numeroMes, 0).getDate()).padStart(2, "0")}`,
  };
}

export function minutosDeHorario(entrada, salida) {
  const [eh, em] = String(entrada || "").split(":").map(Number);
  const [sh, sm] = String(salida || "").split(":").map(Number);
  if (![eh, em, sh, sm].every(Number.isFinite)) return 0;
  return Math.max(0, sh * 60 + sm - (eh * 60 + em));
}

export function fechaClaveDesdeValor(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
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

function novedadCubreFecha(novedad, fechaClave) {
  if (!novedad || novedad.estado === "anulado") return false;
  const desde = fechaClaveDesdeValor(novedad.fechaDesde);
  const hasta = fechaClaveDesdeValor(novedad.fechaHasta) || desde;
  return Boolean(desde && fechaClave >= desde && fechaClave <= hasta);
}

function ultimaNovedad(novedades, tipo, fechaClave) {
  return (Array.isArray(novedades) ? novedades : [])
    .filter((novedad) => novedad?.tipo === tipo && novedadCubreFecha(novedad, fechaClave))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || b.fechaDesde) - new Date(a.updatedAt || a.createdAt || a.fechaDesde))[0] || null;
}

/**
 * Devuelve el horario que debe usarse para una fecha concreta.
 * - Una licencia médica vigente deja el esperado del día en 0.
 * - Un cambio de horario reemplaza entrada/salida únicamente en las fechas cargadas.
 * - Sin novedades se conserva el horario base del empleado.
 */
export function horarioEfectivoParaFecha(empleado, fechaClave, novedades = []) {
  const base = empleado?.horarioLaboral || {};
  const diasBase = Array.isArray(base.dias) && base.dias.length ? base.dias : [1, 2, 3, 4, 5];
  const date = fechaClaveADateUTC(fechaClave);
  const weekday = date?.getUTCDay();
  const licencia = ultimaNovedad(novedades, "licencia-medica", fechaClave);
  if (licencia) {
    return {
      programado: false,
      licenciaMedica: true,
      cambioHorario: false,
      entrada: "",
      salida: "",
      toleranciaMinutos: 0,
      minutosEsperados: 0,
      novedad: licencia,
      etiqueta: "Licencia médica",
    };
  }

  const cambio = ultimaNovedad(novedades, "cambio-horario", fechaClave);
  const entradaCambio = String(cambio?.horaEntradaNueva || "").trim();
  const salidaCambio = String(cambio?.horaSalidaNueva || "").trim();
  const tieneCambioValido = Boolean(cambio && minutosDeHorario(entradaCambio, salidaCambio) > 0);
  const entrada = tieneCambioValido ? entradaCambio : String(base.entrada || "").trim();
  const salida = tieneCambioValido ? salidaCambio : String(base.salida || "").trim();
  const programado = tieneCambioValido || diasBase.includes(weekday);
  const minutosEsperados = programado ? minutosDeHorario(entrada, salida) : 0;
  const toleranciaMinutos = tieneCambioValido
    ? Number(cambio?.toleranciaMinutosNueva ?? base.toleranciaMinutos ?? 10)
    : Number(base.toleranciaMinutos ?? 10);

  return {
    programado: Boolean(programado && minutosEsperados > 0),
    licenciaMedica: false,
    cambioHorario: tieneCambioValido,
    entrada,
    salida,
    toleranciaMinutos: Number.isFinite(toleranciaMinutos) ? toleranciaMinutos : 10,
    minutosEsperados,
    novedad: cambio,
    etiqueta: minutosEsperados ? `${entrada}–${salida}` : "Sin horario",
  };
}

export function minutosEsperadosEnRango(empleado, desdeClave, hastaClave, novedades = []) {
  return clavesEntre(desdeClave, hastaClave).reduce(
    (total, fechaClave) => total + horarioEfectivoParaFecha(empleado, fechaClave, novedades).minutosEsperados,
    0
  );
}

export function minutosEsperadosHastaHoy(empleado, mes, novedades = []) {
  const { desde, hasta, desdeClave, hastaClave } = rangoMesLocal(mes);
  const hoy = new Date();
  const fin = hoy < hasta && hoy >= desde ? hoy : hasta;
  if (fin < desde) return 0;
  const finClave = `${fin.getFullYear()}-${String(fin.getMonth() + 1).padStart(2, "0")}-${String(fin.getDate()).padStart(2, "0")}`;
  return minutosEsperadosEnRango(empleado, desdeClave, finClave || hastaClave, novedades);
}
