import {
  ROLES,
  getEffectiveRole,
  normalizeStoredRole,
  normalizeUsername,
} from "../config/roles.js";

// Personas que pueden tener gestiones/acuerdos válidos, pero no forman parte
// del control visual de presentismo, horas ni rendimiento individual.
export const USUARIOS_NO_CONTROLADOS = new Set([
  "probando",
  "probando-admin",
  "merlo.alejandra",
  "ksalinas",
]);


// Usuarios que siguen existiendo en Cobrina/RDC, pero no deben aparecer en
// los cuadros de control de jornada, tiempos y baches.
export const USUARIOS_NO_CONTROL_TIEMPOS = new Set([
  "amerlo",
  "residual",
  "svillasboa",
]);

export function esEmpleadoControlTiempos(empleado = {}) {
  const username = normalizeUsername(empleado?.username);
  return esEmpleadoControlado(empleado) && !USUARIOS_NO_CONTROL_TIEMPOS.has(username);
}

export function filtrarEmpleadosControlTiempos(empleados = []) {
  return (empleados || []).filter(esEmpleadoControlTiempos);
}

export function usernamesControlTiempos(empleados = []) {
  return new Set(
    filtrarEmpleadosControlTiempos(empleados)
      .map((empleado) => normalizeUsername(empleado?.username))
      .filter(Boolean)
  );
}

export function esEmpleadoControlado(empleado = {}) {
  const username = normalizeUsername(empleado?.username);
  const rolGuardado = normalizeStoredRole(empleado?.role);
  const rolEfectivo = getEffectiveRole(empleado?.role, empleado?.username);

  if (!username || USUARIOS_NO_CONTROLADOS.has(username)) return false;
  if ([ROLES.SUPERVISOR, ROLES.SUPER_ADMIN].includes(rolGuardado)) return false;
  if ([ROLES.SUPERVISOR, ROLES.SUPER_ADMIN].includes(rolEfectivo)) return false;
  return true;
}

export function filtrarEmpleadosControlados(empleados = []) {
  return (empleados || []).filter(esEmpleadoControlado);
}

export function usernamesControlados(empleados = []) {
  return new Set(
    filtrarEmpleadosControlados(empleados)
      .map((empleado) => normalizeUsername(empleado?.username))
      .filter(Boolean)
  );
}
