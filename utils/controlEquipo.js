import { normalizeUsername } from "../config/roles.js";

/**
 * Única exclusión de visualización: cuentas técnicas/de prueba.
 *
 * REGLA 01/09/2026:
 * - Todo usuario real/categoría operativa debe aparecer en Reportes, Supervisión, Acuerdos,
 *   Seguimiento y controles individuales, sin importar si es operador,
 *   administración, supervisor o super-admin.
 * - "No evaluar" deja de ser una regla de ocultamiento. Si tiene actividad,
 *   el dato se muestra.
 * - "residual" NO es una cuenta técnica: representa cartera/casos sin operador activo
 *   y debe contabilizar gestiones, pagos y acuerdos.
 */
export const USUARIOS_NO_CONTROLADOS = new Set([
  "probando",
  "probando-admin",
]);

export const USUARIOS_OCULTOS_REPORTES_CONTROL = USUARIOS_NO_CONTROLADOS;
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

export function esEmpleadoControlado(empleado = {}) {
  const username = normalizeUsername(empleado?.username);
  if (!username || empleado?.isActive === false) return false;
  return esUsuarioVisibleEnReportesControl(username);
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

// Jornada/tiempos usa exactamente el mismo universo visible. Ya no se descartan
// mandos medios o superiores por rol.
export function esEmpleadoControlTiempos(empleado = {}) {
  return esEmpleadoControlado(empleado);
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
