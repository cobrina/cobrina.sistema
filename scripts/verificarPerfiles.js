import assert from "node:assert/strict";
import {
  ROLES,
  SUPER_ADMIN_USERNAMES,
  getEffectiveRole,
  canAccessModule,
  getProyeccionesScope,
  getColchonScope,
  getColchonWriteLevel,
  canConfirmColchonPayments,
  canAssignAgenda,
  canManageUsers,
  canAssignElevatedRoles,
  canManageTargetUser,
  buildEffectiveRoleFilter,
} from "../config/roles.js";

const M = {
  cert: "certificados",
  recibos: "recibos",
  proy: "proyecciones",
  colchon: "colchon",
  notas: "notas",
  agenda: "agenda",
  presentismo: "presentismo",
  reportes: "reportes",
  admin: "administracion",
  pagos: "pagos",
  contrasenas: "contrasenas",
  usuarios: "usuarios",
  rrhh: "rrhh",
  supervision: "supervision",
  poderesBia: "poderes-bia",
};

const expectedModules = {
  [ROLES.OPERADOR]: [M.proy, M.colchon, M.notas, M.agenda],
  [ROLES.OPERADOR_VIP]: [M.cert, M.recibos, M.proy, M.colchon, M.notas, M.agenda, M.poderesBia],
  [ROLES.CUOTERO]: [M.cert, M.recibos, M.colchon, M.notas, M.agenda, M.pagos, M.contrasenas, M.poderesBia],
  [ROLES.CAPACITADORA]: [M.cert, M.recibos, M.proy, M.colchon, M.notas, M.agenda, M.presentismo, M.reportes, M.contrasenas, M.rrhh, M.poderesBia],
  [ROLES.ADMINISTRACION]: [M.cert, M.recibos, M.proy, M.colchon, M.notas, M.agenda, M.presentismo, M.reportes, M.admin, M.pagos, M.contrasenas, M.usuarios, M.rrhh, M.poderesBia],
  [ROLES.SUPERVISOR]: [M.cert, M.recibos, M.proy, M.colchon, M.notas, M.agenda, M.presentismo, M.reportes, M.admin, M.pagos, M.contrasenas, M.usuarios, M.rrhh, M.supervision, M.poderesBia],
  [ROLES.SUPER_ADMIN]: Object.values(M),
};

for (const [role, allowed] of Object.entries(expectedModules)) {
  for (const moduleName of Object.values(M)) {
    assert.equal(
      canAccessModule(role, moduleName),
      allowed.includes(moduleName),
      `${role}: permiso inesperado en ${moduleName}`
    );
  }
}

assert.equal(getEffectiveRole("admin", "persona"), ROLES.ADMINISTRACION);
assert.equal(getEffectiveRole(ROLES.SUPER_ADMIN, "persona"), ROLES.OPERADOR);
for (const username of SUPER_ADMIN_USERNAMES) {
  assert.equal(getEffectiveRole(ROLES.OPERADOR, username), ROLES.SUPER_ADMIN);
  assert.equal(canAssignElevatedRoles(ROLES.SUPER_ADMIN, username), true);
}
assert.equal(canAssignElevatedRoles(ROLES.SUPER_ADMIN, "otra-persona"), false);
assert.equal(canAssignElevatedRoles(ROLES.SUPERVISOR, "supervisora"), true);
assert.equal(
  canManageTargetUser(
    { role: ROLES.SUPERVISOR, username: "supervisora" },
    { role: ROLES.ADMINISTRACION, username: "admin-1" }
  ),
  true
);
assert.equal(
  canManageTargetUser(
    { role: ROLES.SUPERVISOR, username: "supervisora" },
    { role: ROLES.SUPER_ADMIN, username: SUPER_ADMIN_USERNAMES[0] }
  ),
  false
);

assert.equal(getProyeccionesScope(ROLES.OPERADOR), "own");
assert.equal(getProyeccionesScope(ROLES.CAPACITADORA), "own");
assert.equal(getProyeccionesScope(ROLES.ADMINISTRACION), "own");
assert.equal(getProyeccionesScope(ROLES.SUPERVISOR), "all");
assert.equal(getProyeccionesScope(ROLES.CUOTERO), "none");

assert.equal(getColchonScope(ROLES.OPERADOR), "own");
assert.equal(getColchonScope(ROLES.ADMINISTRACION), "own");
assert.equal(getColchonScope(ROLES.CUOTERO), "all");
assert.equal(getColchonScope(ROLES.SUPERVISOR), "all");
assert.equal(getColchonWriteLevel(ROLES.OPERADOR), "inform-only");
assert.equal(getColchonWriteLevel(ROLES.OPERADOR_VIP), "inform-only");
assert.equal(getColchonWriteLevel(ROLES.CAPACITADORA), "own-full");
assert.equal(getColchonWriteLevel(ROLES.ADMINISTRACION), "own-full");
assert.equal(getColchonWriteLevel(ROLES.CUOTERO), "full");
assert.equal(getColchonWriteLevel(ROLES.SUPERVISOR), "full");
assert.equal(canConfirmColchonPayments(ROLES.CUOTERO), true);
assert.equal(canConfirmColchonPayments(ROLES.ADMINISTRACION), false);

assert.equal(canAssignAgenda(ROLES.OPERADOR), false);
assert.equal(canAssignAgenda(ROLES.OPERADOR_VIP), false);
assert.equal(canAssignAgenda(ROLES.CUOTERO), true);
assert.equal(canAssignAgenda(ROLES.CAPACITADORA), true);
assert.equal(canManageUsers(ROLES.ADMINISTRACION), true);
assert.equal(canManageUsers(ROLES.CAPACITADORA), false);

assert.ok(buildEffectiveRoleFilter(ROLES.SUPER_ADMIN));
assert.ok(buildEffectiveRoleFilter(ROLES.OPERADOR));
assert.ok(buildEffectiveRoleFilter(ROLES.ADMINISTRACION));
assert.equal(buildEffectiveRoleFilter("perfil-inexistente"), null);

console.log("✅ Matriz de perfiles del backend verificada correctamente");
