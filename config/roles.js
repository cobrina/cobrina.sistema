export const ROLES = Object.freeze({
  OPERADOR: "operador",
  OPERADOR_VIP: "operador-vip",
  CUOTERO: "cuotero",
  CAPACITADORA: "capacitadora",
  ADMINISTRACION: "administracion",
  SUPERVISOR: "supervisor",
  SUPER_ADMIN: "super-admin",
});

export const SUPER_ADMIN_USERNAMES = Object.freeze([
  "ceballos1988",
  "paular",
  "prougier",
]);

const SUPER_ADMIN_SET = new Set(SUPER_ADMIN_USERNAMES);
const SUPER_ADMIN_USERNAME_PATTERNS = SUPER_ADMIN_USERNAMES.map(
  (username) => new RegExp(`^${username}$`, "i")
);

export const ROLE_LABELS = Object.freeze({
  [ROLES.OPERADOR]: "Operador",
  [ROLES.OPERADOR_VIP]: "Operador VIP",
  [ROLES.CUOTERO]: "Cuotero/a",
  [ROLES.CAPACITADORA]: "Capacitadora",
  [ROLES.ADMINISTRACION]: "Administración",
  [ROLES.SUPERVISOR]: "Supervisor/a",
  [ROLES.SUPER_ADMIN]: "Super-admin",
});

export const ASSIGNABLE_ROLES = Object.freeze([
  ROLES.OPERADOR,
  ROLES.OPERADOR_VIP,
  ROLES.CUOTERO,
  ROLES.CAPACITADORA,
  ROLES.ADMINISTRACION,
  ROLES.SUPERVISOR,
]);

export const ALL_EFFECTIVE_ROLES = Object.freeze([
  ...ASSIGNABLE_ROLES,
  ROLES.SUPER_ADMIN,
]);

export function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeStoredRole(value) {
  const role = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\s]+/g, "-");

  if (role === "admin" || role === "administracion") return ROLES.ADMINISTRACION;
  if (role === "cuotero-a" || role === "cuotera" || role === "cuotero") return ROLES.CUOTERO;
  if (role === "supervisor-a" || role === "supervisora" || role === "supervisor") return ROLES.SUPERVISOR;
  if (role === "capacitador" || role === "capacitadora") return ROLES.CAPACITADORA;
  return role;
}

export function isDesignatedSuperAdmin(username) {
  return SUPER_ADMIN_SET.has(normalizeUsername(username));
}

export function getEffectiveRole(role, username) {
  const normalized = normalizeStoredRole(role);
  const designated = isDesignatedSuperAdmin(username);

  if (designated) return ROLES.SUPER_ADMIN;
  if (normalized === ROLES.SUPER_ADMIN) return ROLES.OPERADOR;
  if (ALL_EFFECTIVE_ROLES.includes(normalized)) return normalized;
  return ROLES.OPERADOR;
}

export function normalizeAssignableRole(role) {
  const normalized = normalizeStoredRole(role);
  return ASSIGNABLE_ROLES.includes(normalized) ? normalized : "";
}

/**
 * Convierte un perfil efectivo en un filtro compatible con los valores que
 * pueden existir actualmente en MongoDB. Es importante porque:
 * - `admin` sigue siendo compatible como Administración.
 * - los tres usernames reservados son siempre super-admin, aunque su campo
 *   `role` todavía tenga un valor anterior.
 * - un `super-admin` histórico que no sea uno de esos tres se trata como
 *   Operador hasta que sea reasignado.
 */
export function buildEffectiveRoleFilter(role) {
  const normalized = normalizeStoredRole(role);
  if (!ALL_EFFECTIVE_ROLES.includes(normalized)) return null;

  const designated = { username: { $in: SUPER_ADMIN_USERNAME_PATTERNS } };
  const notDesignated = { username: { $nin: SUPER_ADMIN_USERNAME_PATTERNS } };

  if (normalized === ROLES.SUPER_ADMIN) return designated;

  if (normalized === ROLES.OPERADOR) {
    return {
      $and: [
        notDesignated,
        { role: { $in: [ROLES.OPERADOR, ROLES.SUPER_ADMIN] } },
      ],
    };
  }

  if (normalized === ROLES.ADMINISTRACION) {
    return {
      $and: [
        notDesignated,
        { role: { $in: ["admin", ROLES.ADMINISTRACION] } },
      ],
    };
  }

  return { $and: [notDesignated, { role: normalized }] };
}

const MODULE_ACCESS = Object.freeze({
  certificados: new Set([
    ROLES.OPERADOR_VIP,
    ROLES.CUOTERO,
    ROLES.CAPACITADORA,
    ROLES.ADMINISTRACION,
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN,
  ]),
  recibos: new Set([
    ROLES.OPERADOR_VIP,
    ROLES.CUOTERO,
    ROLES.CAPACITADORA,
    ROLES.ADMINISTRACION,
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN,
  ]),
  proyecciones: new Set([
    ROLES.OPERADOR,
    ROLES.OPERADOR_VIP,
    ROLES.CAPACITADORA,
    ROLES.ADMINISTRACION,
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN,
  ]),
  colchon: new Set(ALL_EFFECTIVE_ROLES),
  notas: new Set(ALL_EFFECTIVE_ROLES),
  agenda: new Set(ALL_EFFECTIVE_ROLES),
  presentismo: new Set([
    ROLES.CAPACITADORA,
    ROLES.ADMINISTRACION,
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN,
  ]),
  reportes: new Set([
    ROLES.CAPACITADORA,
    ROLES.ADMINISTRACION,
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN,
  ]),
  administracion: new Set([
    ROLES.ADMINISTRACION,
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN,
  ]),
  pagos: new Set([
    ROLES.ADMINISTRACION,
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN,
  ]),
  usuarios: new Set([
    ROLES.ADMINISTRACION,
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN,
  ]),
  rrhh: new Set([
    ROLES.CAPACITADORA,
    ROLES.ADMINISTRACION,
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN,
  ]),
  supervision: new Set([
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN,
  ]),
  "poderes-bia": new Set([
    ROLES.OPERADOR_VIP,
    ROLES.CUOTERO,
    ROLES.CAPACITADORA,
    ROLES.ADMINISTRACION,
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN,
  ]),
});

export function canAccessModule(role, moduleName) {
  const normalized = normalizeStoredRole(role);
  return MODULE_ACCESS[moduleName]?.has(normalized) || false;
}

export function getProyeccionesScope(role) {
  const normalized = normalizeStoredRole(role);
  if ([ROLES.SUPERVISOR, ROLES.SUPER_ADMIN].includes(normalized)) return "all";
  if ([ROLES.OPERADOR, ROLES.OPERADOR_VIP, ROLES.CAPACITADORA, ROLES.ADMINISTRACION].includes(normalized)) return "own";
  return "none";
}

export function getColchonScope(role) {
  const normalized = normalizeStoredRole(role);
  if ([ROLES.CUOTERO, ROLES.SUPERVISOR, ROLES.SUPER_ADMIN].includes(normalized)) return "all";
  if ([ROLES.OPERADOR, ROLES.OPERADOR_VIP, ROLES.CAPACITADORA, ROLES.ADMINISTRACION].includes(normalized)) return "own";
  return "none";
}

export function getColchonWriteLevel(role) {
  const normalized = normalizeStoredRole(role);
  if ([ROLES.CUOTERO, ROLES.SUPERVISOR, ROLES.SUPER_ADMIN].includes(normalized)) return "full";
  if ([ROLES.CAPACITADORA, ROLES.ADMINISTRACION].includes(normalized)) return "own-full";
  if ([ROLES.OPERADOR, ROLES.OPERADOR_VIP].includes(normalized)) return "inform-only";
  return "none";
}

export function canConfirmColchonPayments(role) {
  return [ROLES.CUOTERO, ROLES.SUPERVISOR, ROLES.SUPER_ADMIN].includes(normalizeStoredRole(role));
}

export function canAssignAgenda(role) {
  return [
    ROLES.CUOTERO,
    ROLES.CAPACITADORA,
    ROLES.ADMINISTRACION,
    ROLES.SUPERVISOR,
    ROLES.SUPER_ADMIN,
  ].includes(normalizeStoredRole(role));
}

export function canManageUsers(role) {
  return [ROLES.ADMINISTRACION, ROLES.SUPERVISOR, ROLES.SUPER_ADMIN].includes(normalizeStoredRole(role));
}

export function canAssignElevatedRoles(role, username) {
  return normalizeStoredRole(role) === ROLES.SUPER_ADMIN && isDesignatedSuperAdmin(username);
}

export function canManageTargetUser(actor, target) {
  const actorRole = getEffectiveRole(actor?.role, actor?.username);
  const targetRole = getEffectiveRole(target?.role, target?.username);

  if (targetRole === ROLES.SUPER_ADMIN) return false;
  if (actorRole === ROLES.SUPER_ADMIN) return true;
  return canManageUsers(actorRole) && targetRole === ROLES.OPERADOR;
}
