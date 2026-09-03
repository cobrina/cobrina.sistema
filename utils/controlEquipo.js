import { getEffectiveRole, normalizeUsername, ROLES } from "../config/roles.js";

/**
 * Cuentas técnicas/de prueba que nunca deben aparecer en reportes.
 *
 * REGLA 03/09/2026:
 * - Los reportes de actividad sólo deben contar usuarios que sigan activos en
 *   Empleados. Se conserva `residual` como excepción de negocio porque no es
 *   un operador inactivo: representa cartera/casos sin operador asignado.
 * - Los controles operativos (Control de gestiones y Jornada/Asistencia)
 *   trabajan únicamente con operadores/operadores VIP activos.
 * - En esos controles se excluyen además las cuentas de conducción indicadas
 *   por negocio, aunque por compatibilidad histórica su rol guardado pudiera
 *   no reflejar todavía el rol efectivo.
 */
export const USUARIOS_NO_CONTROLADOS = new Set([
  "probando",
  "probando-admin",
]);

export const USUARIOS_OCULTOS_REPORTES_CONTROL = USUARIOS_NO_CONTROLADOS;
export const USUARIOS_NO_CONTROL_TIEMPOS = USUARIOS_OCULTOS_REPORTES_CONTROL;

// `residual` sigue siendo una fuente válida de actividad para Gestiones,
// Acuerdos y otros reportes de negocio, aunque no sea un empleado activo.
export const USUARIOS_ESPECIALES_REPORTES = new Set([
  "residual",
]);

// Exclusiones explícitas solicitadas para los controles de equipo.
export const USUARIOS_EXCLUIDOS_CONTROLES_OPERATIVOS = new Set([
  "lucas",
  "ksalinas",
  "ceballos1988",
  "prougier",
]);

export function esUsuarioVisibleEnReportesControl(value) {
  const username = normalizeUsername(value);
  return Boolean(username) && !USUARIOS_OCULTOS_REPORTES_CONTROL.has(username);
}

export function esUsuarioEspecialReportes(value) {
  return USUARIOS_ESPECIALES_REPORTES.has(normalizeUsername(value));
}

export function filtrarFilasReportesControl(
  rows = [],
  getUsername = (row) => row?.usuario ?? row?.username ?? row?.operador ?? row?.operadorUsername
) {
  return (rows || []).filter((row) => esUsuarioVisibleEnReportesControl(getUsername(row)));
}

// Universo general de reportes: cualquier empleado activo y visible,
// independientemente del rol. Esto permite seguir contabilizando actividad de
// supervisión/administración cuando corresponde, pero nunca de usuarios dados
// de baja.
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

// Universo estricto de control operativo: sólo operadores activos. Usamos rol
// efectivo para no incorporar por error cuentas reservadas de super-admin que
// históricamente pudieran tener `role: operador` guardado.
export function esEmpleadoOperativoControl(empleado = {}) {
  const username = normalizeUsername(empleado?.username);
  if (!username || empleado?.isActive === false) return false;
  if (!esUsuarioVisibleEnReportesControl(username)) return false;
  if (USUARIOS_EXCLUIDOS_CONTROLES_OPERATIVOS.has(username)) return false;

  const role = getEffectiveRole(empleado?.role, username);
  return [ROLES.OPERADOR, ROLES.OPERADOR_VIP].includes(role);
}

export function filtrarEmpleadosOperativosControl(empleados = []) {
  return (empleados || []).filter(esEmpleadoOperativoControl);
}

export function usernamesOperativosControl(empleados = []) {
  return new Set(
    filtrarEmpleadosOperativosControl(empleados)
      .map((empleado) => normalizeUsername(empleado?.username))
      .filter(Boolean)
  );
}

// Jornada/tiempos usa exactamente el mismo universo operativo que Control de
// gestiones: operadores activos, sin cuentas de conducción.
export function esEmpleadoControlTiempos(empleado = {}) {
  return esEmpleadoOperativoControl(empleado);
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
