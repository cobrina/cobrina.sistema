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
  "residual",
  "ksalinas",
]);

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
