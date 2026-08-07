import { normalizeUsername } from "../config/roles.js";

function fechaClaveGestion(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

export function minutosHoraGestion(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const horas = Number(match[1]);
  const minutos = Number(match[2]);
  const segundos = Number(match[3] || 0);
  if (horas < 0 || horas > 23 || minutos < 0 || minutos > 59 || segundos < 0 || segundos > 59) return null;
  return horas * 60 + minutos + segundos / 60;
}

export function horaGestionHHMM(value) {
  const minutos = Number(value);
  if (!Number.isFinite(minutos)) return "";
  const total = Math.max(0, Math.min(24 * 60 - 1, Math.floor(minutos)));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function resumirGestionesPorUsuarioYDia(rows = []) {
  const agrupado = new Map();

  for (const row of rows || []) {
    const username = normalizeUsername(row?.usuario);
    const fechaClave = fechaClaveGestion(row?.fecha);
    const minuto = minutosHoraGestion(row?.hora);
    if (!username || !fechaClave || minuto == null) continue;

    const key = `${username}|${fechaClave}`;
    if (!agrupado.has(key)) agrupado.set(key, { username, fechaClave, minutos: [] });
    agrupado.get(key).minutos.push(minuto);
  }

  const porUsuario = new Map();
  for (const grupo of agrupado.values()) {
    const minutosOrdenados = grupo.minutos.sort((a, b) => a - b);
    const primera = minutosOrdenados[0];
    const ultima = minutosOrdenados[minutosOrdenados.length - 1];
    const gaps = [];
    for (let i = 1; i < minutosOrdenados.length; i += 1) {
      gaps.push(Math.max(0, minutosOrdenados[i] - minutosOrdenados[i - 1]));
    }
    const resumenDia = {
      fechaClave: grupo.fechaClave,
      primeraGestion: horaGestionHHMM(primera),
      ultimaGestion: horaGestionHHMM(ultima),
      minutosFranja: Math.max(0, Math.round(ultima - primera)),
      gestiones: minutosOrdenados.length,
      baches30: gaps.filter((gap) => gap > 30).length,
      baches60: gaps.filter((gap) => gap > 60).length,
      bacheMaximoMin: gaps.length ? Math.round(Math.max(...gaps)) : 0,
    };

    if (!porUsuario.has(grupo.username)) porUsuario.set(grupo.username, []);
    porUsuario.get(grupo.username).push(resumenDia);
  }

  for (const dias of porUsuario.values()) dias.sort((a, b) => a.fechaClave.localeCompare(b.fechaClave));
  return porUsuario;
}

export function resumirActividadMensual(rows = []) {
  const porDia = resumirGestionesPorUsuarioYDia(rows);
  const resumen = new Map();

  for (const [username, dias] of porDia.entries()) {
    const minutosFranja = dias.reduce((sum, dia) => sum + Number(dia.minutosFranja || 0), 0);
    const gestiones = dias.reduce((sum, dia) => sum + Number(dia.gestiones || 0), 0);
    const baches30 = dias.reduce((sum, dia) => sum + Number(dia.baches30 || 0), 0);
    const baches60 = dias.reduce((sum, dia) => sum + Number(dia.baches60 || 0), 0);
    const bacheMaximoMin = dias.reduce((max, dia) => Math.max(max, Number(dia.bacheMaximoMin || 0)), 0);
    resumen.set(username, {
      username,
      minutosFranja,
      gestiones,
      diasConActividad: dias.length,
      baches30,
      baches60,
      bacheMaximoMin,
      dias,
    });
  }

  return resumen;
}

export function actividadDeUsuarioEnFecha(rows = [], fechaClave = "") {
  const porDia = resumirGestionesPorUsuarioYDia(rows);
  const resultado = new Map();
  for (const [username, dias] of porDia.entries()) {
    const dia = dias.find((item) => item.fechaClave === fechaClave) || null;
    if (dia) resultado.set(username, dia);
  }
  return resultado;
}
