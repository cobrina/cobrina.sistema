import {
  ROLES,
  getEffectiveRole,
  normalizeStoredRole,
  normalizeUsername,
} from "../config/roles.js";

/**
 * Usuarios que siguen siendo válidos para cálculos globales (gestiones,
 * acuerdos, recuperos, etc.), pero no deben aparecer identificados en tablas,
 * rankings ni controles individuales de Reportes / Supervisión / RRHH.
 *
 * IMPORTANTE: esta lista NO borra ni descarta su actividad. Solo gobierna la
 * visibilidad individual en módulos de control.
 */
export const USUARIOS_NO_CONTROLADOS = new Set([
  // Usuarios técnicos / históricamente excluidos
  "ceballos1988",
  "prougier",
  "paular",
  "probando",
  "probando-admin",
  "residual",

  // Exclusiones históricas del control de asistencia
  "paredez.patricia",
  "pparedez",
  "lucas",

  // Exclusiones operativas solicitadas
  "amerlo",
  "svillasboa",
  "merlo.alejandra",
  "ksalinas",
]);

// Alias semántico para consumidores que trabajan directamente con filas de
// reportes y no con documentos Empleado.
export const USUARIOS_OCULTOS_REPORTES_CONTROL = USUARIOS_NO_CONTROLADOS;

// Se conserva por compatibilidad con imports anteriores. Las exclusiones de
// jornada ahora forman parte de la lista general para que no reaparezcan en
// otro cuadro de control por tener una regla distinta.
export const USUARIOS_NO_CONTROL_TIEMPOS = USUARIOS_OCULTOS_REPORTES_CONTROL;

export function esUsuarioVisibleEnReportesControl(value) {
  const username = normalizeUsername(value);
  return Boolean(username) && !USUARIOS_OCULTOS_REPORTES_CONTROL.has(username);
}

export function filtrarFilasReportesControl(
  rows = [],
  getUsername = (row) => row?.usuario ?? row?.username ?? row?.operador ?? row?.operadorUsername
) {
  return (rows || []).filter((row) => esUsuarioVisibleEnReportesControl(getUsername(row)));
}

export function esEmpleadoControlTiempos(empleado = {}) {
  const username = normalizeUsername(empleado?.username);
  const rolEfectivo = getEffectiveRole(empleado?.role, empleado?.username);
  // Defensa puntual: abernat pertenece a Administración y no debe entrar en Jornada/Asistencia,
  // incluso si un registro histórico tuviera el rol mal cargado.
  if (username === "abernat") return false;
  if ([ROLES.ADMINISTRACION, ROLES.SUPERVISOR, ROLES.SUPER_ADMIN].includes(rolEfectivo)) return false;
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
