// Roles, permissions and memberships (FR-RBAC-001..003; TS §6.3).
import { PERMISSION_KEYS, isKnownPermission } from '@sf/permissions';
import { App, AppError, Ctx, type Doc, type Route, created, s } from '@sf/kernel';

const SELF_KEYS = ['duty.own', 'correction.request'];
const RANK: Record<string, number> = { owner: 6, admin: 5, commander: 4, supervisor: 3, dispatcher: 3, auditor: 3, field: 1 };
function assertGrantable(ctx: Ctx, keys: string[]) {
  const unknown = keys.filter((k) => !isKnownPermission(k));
  if (unknown.length) throw new AppError('VALIDATION_FAILED', 'Unknown permission keys.', { fieldErrors: unknown.map((k) => ({ path: 'permissionKeys', code: 'UNKNOWN', message: `${k} is not a platform-defined permission` })) });
  // Nobody can grant a management permission they do not hold. Self-service field keys can be granted by anyone who manages roles.
  const beyond = keys.filter((k) => !ctx.can(k) && !SELF_KEYS.includes(k));
  if (beyond.length) throw new AppError('FORBIDDEN', `You cannot grant permissions you do not hold: ${beyond.join(', ')}`);
}

const routes: Route[] = [
  { method: 'GET', path: '/permissions', permission: 'role.read', scope: 'tenant', audit: { none: 'static catalogue' }, rate: 'read', summary: 'Catalogue of permission keys', reqs: ['FR-RBAC-001'],
    async handler() { return { items: PERMISSION_KEYS }; } },
  { method: 'GET', path: '/roles', permission: 'role.read', scope: 'tenant', audit: { none: 'role list read' }, rate: 'read', summary: 'Roles with their permission keys', reqs: ['FR-RBAC-001'],
    async handler(ctx) { return { items: await ctx.col('roles').find({}, { sort: { isDefault: -1, name: 1 } }) }; } },
  {
    method: 'POST', path: '/roles', permission: 'role.create', scope: 'tenant', audit: 'role.create', rate: 'mutation', summary: 'Create a custom role, usually by cloning a default', reqs: ['FR-RBAC-001'],
    body: s.object({ name: s.string({ min: 2, max: 80 }), clonedFrom: s.optional(s.id()), permissionKeys: s.optional(s.array(s.string({ max: 60 }), { max: 200 })), labels: s.optional(s.object({ en: s.string({ max: 80 }), ar: s.string({ max: 80 }) })) }),
    async handler(ctx, { body }) {
      const src = body.clonedFrom ? await ctx.col('roles').must(body.clonedFrom, 'Role') : null;
      const keys = [...new Set<string>(body.permissionKeys ?? (src?.permissionKeys as string[]) ?? [])].sort();
      assertGrantable(ctx, keys);
      const role = await ctx.col('roles').insert({ key: `custom:${body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: body.name, labels: body.labels ?? { en: body.name, ar: body.name }, permissionKeys: keys, isDefault: false, clonedFrom: src?._id ?? null, createdAt: ctx.now(), version: 1 });
      ctx.setAudit({ resource: { type: 'role', id: role._id }, after: { name: role.name, permissionKeys: keys } });
      return created(role);
    },
  },
  { method: 'GET', path: '/roles/:id', permission: 'role.read', scope: 'tenant', audit: { none: 'read of role data within scope' }, rate: 'read', summary: 'Role detail', async handler(ctx, { params }) { return ctx.col('roles').must(params.id!, 'Role'); } },
  {
    method: 'PATCH', path: '/roles/:id', permission: 'role.update', scope: 'tenant', audit: 'role.update', rate: 'mutation', summary: 'Edit a custom role (defaults are fixed: clone to customise)', reqs: ['FR-RBAC-001', 'FR-RBAC-003'],
    body: s.object({ version: s.number({ int: true }), name: s.optional(s.string({ min: 2, max: 80 })), permissionKeys: s.optional(s.array(s.string({ max: 60 }), { max: 200 })) }),
    async handler(ctx, { params, body }) {
      const role = await ctx.col('roles').must(params.id!, 'Role');
      if (role.isDefault) throw new AppError('FORBIDDEN', 'Default roles cannot be edited. Clone the role and edit the copy.');
      if (body.permissionKeys) assertGrantable(ctx, body.permissionKeys);
      const set: Record<string, unknown> = {}; if (body.name) set.name = body.name; if (body.permissionKeys) set.permissionKeys = [...new Set(body.permissionKeys)].sort();
      const out = await ctx.col('roles').updateVersioned(role._id, body.version, set);
      ctx.setAudit({ resource: { type: 'role', id: role._id }, before: { name: role.name, permissionKeys: role.permissionKeys }, after: set });
      return out;
    },
  },
  {
    method: 'DELETE', path: '/roles/:id', permission: 'role.delete', scope: 'tenant', audit: 'role.delete', rate: 'mutation', summary: 'Delete an unused custom role', reqs: ['FR-RBAC-001'],
    async handler(ctx, { params }) {
      const role = await ctx.col('roles').must(params.id!, 'Role');
      if (role.isDefault) throw new AppError('FORBIDDEN', 'Default roles cannot be deleted.');
      const inUse = await ctx.col('memberships').count({ roleIds: role._id });
      if (inUse) throw new AppError('CONFLICT', `This role is assigned to ${inUse} member(s). Reassign them first.`);
      await ctx.col('roles').delete({ _id: role._id });
      ctx.setAudit({ resource: { type: 'role', id: role._id }, before: { name: role.name } });
      return { ok: true };
    },
  },
  { method: 'GET', path: '/memberships/:id', permission: 'membership.read', scope: 'tenant', audit: { none: 'membership read' }, rate: 'read', summary: 'Membership roles and scope', async handler(ctx, { params }) { return ctx.col('memberships').must(params.id!, 'Member'); } },
  {
    method: 'PATCH', path: '/memberships/:id', permission: 'membership.update', scope: 'tenant', audit: 'membership.update', rate: 'mutation', summary: 'Change a member\'s roles and hierarchy scope (takes effect on the next request)', reqs: ['FR-RBAC-002', 'FR-RBAC-003'],
    body: s.object({ version: s.number({ int: true }), roleIds: s.optional(s.array(s.id(), { min: 1, max: 10 })), scopeUnitIds: s.optional(s.array(s.string({ max: 64 }), { min: 1, max: 50 })), reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      const m = await ctx.col('memberships').must(params.id!, 'Member');
      if (m._id === ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'You cannot change your own roles or scope.');
      const set = await resolveRolesAndScope(ctx, body.roleIds, body.scopeUnitIds, m);
      const out = await ctx.col('memberships').updateVersioned(m._id, body.version, set);
      ctx.setAudit({ resource: { type: 'membership', id: m._id }, reason: body.reason, before: { roleIds: m.roleIds, scopeUnitIds: m.scopeUnitIds }, after: set });
      return out;
    },
  },
];

/** Validates a role/scope assignment: roles exist, the Owner role moves only by ownership transfer, no escalation, units exist. */
export async function resolveRolesAndScope(ctx: Ctx, roleIds: string[] | undefined, scopeUnitIds: string[] | undefined, current?: Doc): Promise<Record<string, unknown>> {
  const set: Record<string, unknown> = {};
  if (roleIds) {
    const roles = await ctx.col('roles').find({ _id: { $in: roleIds } });
    if (roles.length !== new Set(roleIds).size) throw new AppError('VALIDATION_FAILED', 'Unknown role.', { fieldErrors: [{ path: 'roleIds', code: 'UNKNOWN', message: 'contains a role that does not exist' }] });
    const hadOwner = current ? (await ctx.col('roles').find({ _id: { $in: current.roleIds } })).some((r) => r.key === 'owner') : false;
    if (roles.some((r) => r.key === 'owner') !== hadOwner) throw new AppError('FORBIDDEN', 'The Owner role changes only through ownership transfer.');
    // Default roles: Owner/Admin may assign any role up to their own rank; others only roles strictly below their own.
    const myRank = Math.max(0, ...ctx.actor.roleKeys.map((k) => RANK[k] ?? 0)) || (ctx.actor.type === 'system' ? 9 : 0);
    for (const r of roles.filter((x) => x.key !== 'owner')) {
      if (r.isDefault) { const rank = RANK[r.key] ?? 0; if (!(myRank >= 5 ? rank <= myRank : rank < myRank)) throw new AppError('FORBIDDEN', `You cannot assign the ${r.name} role.`); }
      else assertGrantable(ctx, r.permissionKeys as string[]);
    }
    set.roleIds = [...new Set(roleIds)];
  }
  if (scopeUnitIds) {
    if (scopeUnitIds.includes('*')) { if (!ctx.tenantWide) throw new AppError('FORBIDDEN', 'You cannot grant whole-organisation scope.'); set.scopeUnitIds = ['*']; }
    else {
      const units = await ctx.col('organization_units').find({ _id: { $in: scopeUnitIds } });
      if (units.length !== new Set(scopeUnitIds).size || !units.every((u) => ctx.inScope(u._id))) throw new AppError('VALIDATION_FAILED', 'Unknown unit.', { fieldErrors: [{ path: 'scopeUnitIds', code: 'UNKNOWN', message: 'contains a unit that does not exist in your scope' }] });
      set.scopeUnitIds = [...new Set(scopeUnitIds)];
    }
  }
  return set;
}
export function registerAccess(app: App) { app.register('access', routes); }
