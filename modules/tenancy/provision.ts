// Tenant provisioning (FR-TEN-002): tenant, default roles, policies, catalogues and the Owner invitation in ONE transaction.
import { DEFAULT_ALERT_RULES, DEFAULT_CATALOGUES, DEFAULT_LABELS, DEFAULT_PLANS, DEFAULT_SETTINGS } from '@sf/contracts';
import { ROLE_KEYS, ROLE_NAMES, defaultRolePermissions } from '@sf/permissions';
import { isValidTimeZone } from '@sf/domain';
import { App, AppError, Ctx, type Doc, newId } from '@sf/kernel';
import { issueInvitation } from '../identity/index.ts';

export interface ProvisionInput {
  name: string; slug: string; timezone: string; defaultLocale: 'en' | 'ar'; planKey: string; trial?: boolean; isDemo?: boolean;
  owner: { username: string; email?: string; displayName: string };
}
export async function ensurePlans(app: App) {
  for (const p of DEFAULT_PLANS) if (!(await app.store.findOne('plans', { key: p.key }))) await app.store.insert('plans', { ...p, createdAt: app.clock.now() });
}
export async function provisionTenant(app: App, input: ProvisionInput, platformCtx: Ctx | null): Promise<{ tenant: Doc; ownerActivationCode: string; ownerActivationExpiresAt: number }> {
  if (!isValidTimeZone(input.timezone)) throw new AppError('VALIDATION_FAILED', 'Unknown timezone.', { fieldErrors: [{ path: 'timezone', code: 'INVALID', message: 'is not a known IANA timezone' }] });
  const plan = await app.store.findOne('plans', { key: input.planKey });
  if (!plan) throw new AppError('VALIDATION_FAILED', 'Unknown plan.', { fieldErrors: [{ path: 'planKey', code: 'INVALID', message: 'is not a known plan' }] });
  return app.store.transaction(async () => {
    const now = app.clock.now(), tenantId = newId();
    const tenant = await app.store.insert('tenants', {
      _id: tenantId, name: input.name, slug: input.slug.toLowerCase(), status: 'provisioning', planKey: plan.key, timezone: input.timezone, defaultLocale: input.defaultLocale,
      weekStart: input.defaultLocale === 'ar' ? 'SU' : 'MO', weekendDays: input.defaultLocale === 'ar' ? ['FR', 'SA'] : ['SA', 'SU'], digitStyle: 'western',
      settingsVersion: 1, isDemo: !!input.isDemo, createdAt: now, updatedAt: now, version: 1,
    });
    const ctx = app.systemCtx(tenant, 'provisioning', DEFAULT_SETTINGS);
    if (platformCtx) ctx.actor = { ...platformCtx.actor };
    await ctx.col('tenant_setting_versions').insert({ version: 1, settings: {}, changedBy: ctx.actor.userId, createdAt: now });
    const roleIds: Record<string, string> = {};
    for (const key of ROLE_KEYS) {
      const r = await ctx.col('roles').insert({ key, name: ROLE_NAMES[key].en, labels: ROLE_NAMES[key], permissionKeys: defaultRolePermissions(key), isDefault: true, clonedFrom: null, createdAt: now, version: 1 });
      roleIds[key] = r._id;
    }
    const policy = await ctx.col('escalation_policies').insert({ name: 'Default SOS escalation', steps: DEFAULT_ALERT_RULES.find((r) => r.type === 'sos')!.escalation.map((s) => ({ ...s, channels: ['inApp'] })), createdAt: now, version: 1 });
    for (const rule of DEFAULT_ALERT_RULES) {
      const own = rule.type === 'sos' ? policy._id : rule.escalation.length ? (await ctx.col('escalation_policies').insert({ name: `Default ${rule.type} escalation`, steps: rule.escalation.map((s) => ({ ...s, channels: ['inApp'] })), createdAt: now, version: 1 }))._id : null;
      await ctx.col('alert_rules').insert({ type: rule.type, enabled: true, thresholds: rule.thresholds, severity: rule.severity, recipientGroups: rule.recipients, escalationPolicyId: own, version: 1, createdAt: now });
    }
    for (const c of DEFAULT_CATALOGUES) await ctx.col('catalogue_entries').insert({ ...c, archived: false, createdAt: now });
    await ctx.col('label_sets').insert({ key: 'labels', labels: DEFAULT_LABELS, version: 1, updatedAt: now });
    await ctx.col('subscriptions').insert({ planScope: 'current', planKey: plan.key, state: input.trial ? 'trial' : 'active', periodStart: now, periodEnd: null, limitsOverride: null, assignedBy: ctx.actor.userId, createdAt: now });
    const root = await ctx.col('organization_units').insert({ parentId: null, type: 'hq', name: input.name, ancestorIds: [], depth: 0, status: 'active', createdAt: now, updatedAt: now, version: 1 });
    const staff = await ctx.col('staff_members').insert({ employeeCode: 'OWNER-001', displayName: input.owner.displayName, rankTitle: 'Organisation Owner', homeUnitId: root._id, supervisorId: null, status: 'invited', createdAt: now, updatedAt: now, version: 1 });
    const user = await ctx.col('users').insert({ username: input.owner.username.toLowerCase(), email: input.owner.email ?? null, ...(input.owner.email ? { emailKey: input.owner.email.toLowerCase() } : {}), passwordHash: null, status: 'active', mfaEnabled: false, failedLogins: 0, lockedUntil: null, sessionVersion: 1, createdAt: now });
    const membership = await ctx.col('memberships').insert({ userId: user._id, staffMemberId: staff._id, roleIds: [roleIds.owner!], scopeUnitIds: ['*'], status: 'active', createdAt: now, version: 1 });
    await ctx.col('staff_members').update(staff._id, { $set: { userId: user._id } });
    const inv = await issueInvitation(ctx, { user, staffMemberId: staff._id, channel: 'code' });
    const live = (await app.store.updateOne('tenants', { _id: tenantId }, { $set: { status: input.trial ? 'trial' : 'active', ownerMembershipId: membership._id } }))!;
    await app.writeAudit(ctx, { action: 'tenant.provision', resource: { type: 'tenant', id: tenantId }, after: { name: input.name, slug: live.slug, plan: plan.key, status: live.status } });
    return { tenant: live, ownerActivationCode: inv.code, ownerActivationExpiresAt: inv.expiresAt };
  });
}

/** Plan limits (FR-SUB-001): block new creation with a clear message; never block SOS, check-out or reads. */
export async function planLimits(ctx: Ctx): Promise<Record<string, number>> {
  const sub = await ctx.col('subscriptions').findOne({ planScope: 'current' });
  const plan = await ctx.app.store.findOne('plans', { key: sub?.planKey ?? ctx.tenant!.planKey });
  return { ...(plan?.limits ?? {}), ...(sub?.limitsOverride ?? {}) };
}
export async function usageCounts(ctx: Ctx) {
  const [activeStaff, posts, devices, points, files] = await Promise.all([
    ctx.col('staff_members').count({ status: { $in: ['invited', 'active', 'suspended'] } }), ctx.col('posts').count({ status: 'active' }),
    ctx.col('devices').count({ status: { $in: ['active', 'pending_approval'] } }), ctx.col('location_points').count({}), ctx.col('file_objects').find({}, { limit: 100000 }),
  ]);
  return { activeStaff, posts, devices, points, storageBytes: files.reduce((n, f) => n + (f.sizeBytes ?? 0), 0) };
}
export async function assertPlanLimit(ctx: Ctx, key: 'activeStaff' | 'posts' | 'devices', adding = 1) {
  const limits = await planLimits(ctx); const usage = await usageCounts(ctx);
  if (limits[key] !== undefined && usage[key] + adding > limits[key]!) {
    const label = { activeStaff: 'staff members', posts: 'sites', devices: 'devices' }[key];
    throw new AppError('PLAN_LIMIT_REACHED', `Your plan allows ${limits[key]} ${label}. Existing data, check-out and SOS are not affected. Ask your platform contact to change the plan.`, { details: { limit: limits[key], current: usage[key], key } });
  }
}
