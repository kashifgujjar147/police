// Tenancy & Platform: platform console, tenant lifecycle, settings, support grants, subscription (PRD §7, §8.18–8.20; TS §9.2).
import { BREACHED_PASSWORDS, mfaBypassActive, mfaLoginSkipped } from '@sf/config';
import { DEFAULT_SETTINGS, PLATFORM_BOUNDS, TenantMachine, type TenantStatus } from '@sf/contracts';
import { base32Encode, verifyTotp } from '@sf/domain/node';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { App, AppError, Ctx, type Doc, Reply, type Route, created, deepMerge, paginate, randomToken, s, sha256, signJwt } from '@sf/kernel';
import { checkPasswordPolicy, isPrivileged, revokeSessions } from '../identity/index.ts';
import { ensurePlans, planLimits, provisionTenant, usageCounts } from './provision.ts';

const NEUTRAL = 'The sign-in details are not correct.';
const tenantView = (t: Doc) => ({ id: t._id, name: t.name, slug: t.slug, status: t.status, planKey: t.planKey, timezone: t.timezone, defaultLocale: t.defaultLocale, isDemo: !!t.isDemo, createdAt: t.createdAt, suspendedAt: t.suspendedAt ?? null, deletionScheduledAt: t.deletionScheduledAt ?? null, deletionCertificate: t.deletionCertificate ?? null, version: t.version });

async function platformTokens(ctx: Ctx, user: Doc) {
  const now = ctx.now(); const session = await ctx.app.store.insert('platform_sessions', { userId: user._id, tokenHash: sha256(randomToken(32)), createdAt: now, expiresAt: now + 12 * 3600000, revokedAt: null, ip: ctx.ip });
  const iat = Math.floor(now / 1000);
  return { mfaRequired: false, accessToken: signJwt({ typ: 'platform', sub: user._id, sid: session._id, iat, exp: iat + 900 * 4 }, ctx.app.signingKey), expiresIn: 3600, user: { id: user._id, email: user.email, platformRoles: user.platformRoles } };
}
async function platformChallenge(ctx: Ctx, token: string) {
  const ch = await ctx.app.store.findOne('platform_sessions', { tokenHash: sha256(token), kind: 'challenge' });
  if (!ch || ch.revokedAt || ch.expiresAt <= ctx.now() || (ch.attempts ?? 0) >= 5) throw new AppError('UNAUTHENTICATED', 'This sign-in step has expired. Start again.');
  return { ch, user: (await ctx.app.store.findOne('platform_users', { _id: ch.userId }))! };
}

// ---------- Platform Super Admin accounts: first-run setup code and invitations ----------
// Nobody can self-register: an account needs either the one-time setup code (exists only while no active Super Admin
// exists, and only in a server-side file) or an invitation code issued by a signed-in Super Admin. The role is always
// set by the server; the request cannot carry one (unknown fields are rejected by the validator).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const normEmail = (e: string) => e.trim().toLowerCase();
const BAD_CODE = 'This setup or invitation code is not valid or has expired.';
export const PLATFORM_SETUP_FILE = 'platform-setup-token.txt';
export const platformSetupTokenPath = (app: App) => join(app.config.dataDir, PLATFORM_SETUP_FILE);
export async function hasActiveSuperAdmin(app: App) { return (await app.store.find('platform_users', {})).some((u) => u.status === 'active' && (u.platformRoles as string[] | undefined)?.includes('super_admin')); }
/** Platform accounts are always privileged: same floor as tenant privileged roles (min 12, max 128, not a common password). */
export function platformPasswordErrors(password: string) {
  const errs: { path: string; code: string; message: string }[] = [];
  if (password.length < 12) errs.push({ path: 'password', code: 'TOO_SHORT', message: 'Use at least 12 characters.' });
  if (password.length > 128) errs.push({ path: 'password', code: 'TOO_LONG', message: 'Use at most 128 characters.' });
  if (BREACHED_PASSWORDS.has(password.toLowerCase())) errs.push({ path: 'password', code: 'BREACHED', message: 'This password is too common. Choose another.' });
  return errs;
}
/** First run only: while no active Super Admin exists, keep a one-time setup code in a server-only file (like a CI server's initial admin password). */
export async function ensurePlatformSetupToken(app: App): Promise<string | null> {
  const file = platformSetupTokenPath(app);
  try {
    if (await hasActiveSuperAdmin(app)) { rmSync(file, { force: true }); return null; }
    if (!existsSync(file)) { mkdirSync(app.config.dataDir, { recursive: true }); writeFileSync(file, `${randomBytes(18).toString('base64url')}\n`, { mode: 0o600 }); }
  } catch (e) { // never block startup (e.g. read-only or root-owned volume); PLATFORM_ADMIN_EMAIL/PASSWORD still creates the first admin
    app.log.warn('could not write the platform setup code file; set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD to create the first Super Admin', { file, error: (e as Error).message });
    return null;
  }
  app.log.warn('No Platform Super Admin exists yet. A one-time setup code is in the server file below: use it under "Create account" on the Platform sign-in page, or run `npm run platform:admin` with the server stopped.', { file });
  return file;
}
function readSetupToken(app: App): string | null { try { return readFileSync(platformSetupTokenPath(app), 'utf8').trim() || null; } catch { return null; } }
const sameSecret = (a: string, b: string) => timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));

/** Validates tenant settings overrides: known keys only, same types as defaults, platform floors and ceilings. */
export function validateSettings(candidate: unknown, base: unknown = DEFAULT_SETTINGS, path = 'settings'): { path: string; code: string; message: string }[] {
  const errs: { path: string; code: string; message: string }[] = [];
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return [{ path, code: 'TYPE', message: 'must be an object' }];
  for (const [k, v] of Object.entries(candidate)) {
    const b = (base as Record<string, unknown>)[k], p = `${path}.${k}`;
    if (b === undefined) { errs.push({ path: p, code: 'UNKNOWN_FIELD', message: 'is not a known setting' }); continue; }
    if (Array.isArray(b)) { if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) errs.push({ path: p, code: 'TYPE', message: 'must be a list of text values' }); }
    else if (typeof b === 'object' && b !== null) errs.push(...validateSettings(v, b, p));
    else if (typeof v !== typeof b) errs.push({ path: p, code: 'TYPE', message: `must be a ${typeof b}` });
    else if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) errs.push({ path: p, code: 'TOO_SMALL', message: 'must be zero or more' });
  }
  if (path === 'settings' && !errs.length) {
    const m = deepMerge(DEFAULT_SETTINGS, candidate);
    const bad = (p: string, message: string) => errs.push({ path: `settings.${p}`, code: 'OUT_OF_BOUNDS', message });
    if (m.auth.passwordMinPrivileged < PLATFORM_BOUNDS.passwordMinPrivileged) bad('auth.passwordMinPrivileged', `cannot be below the platform floor of ${PLATFORM_BOUNDS.passwordMinPrivileged}`);
    if (m.auth.passwordMin < PLATFORM_BOUNDS.passwordMin) bad('auth.passwordMin', `cannot be below the platform floor of ${PLATFORM_BOUNDS.passwordMin}`);
    for (const r of ['owner', 'admin']) if (!m.auth.mfaRequiredRoles.includes(r)) bad('auth.mfaRequiredRoles', 'MFA cannot be made optional for Owner and Admin');
    for (const [cls, [lo, hi]] of Object.entries(PLATFORM_BOUNDS.retentionDays)) { const d = (m.retentionDays as Record<string, number>)[cls]!; if (d < lo || d > hi) bad(`retentionDays.${cls}`, `must be between ${lo} and ${hi} days`); }
    if (!['block', 'warn', 'allow'].includes(m.duty.overlapPolicy)) bad('duty.overlapPolicy', 'must be block, warn or allow');
    if (!['remain_open', 'auto_close', 'flag'].includes(m.duty.missedCheckOut)) bad('duty.missedCheckOut', 'must be remain_open, auto_close or flag');
    if (!['off', 'warn', 'require'].includes(m.duty.geofenceStart)) bad('duty.geofenceStart', 'must be off, warn or require');
    if (m.location.liveSec >= m.location.recentSec) bad('location.liveSec', 'must be shorter than the Recent threshold');
    if (m.sos.holdSec < 1 || m.sos.holdSec > 10) bad('sos.holdSec', 'must be between 1 and 10 seconds');
    if (m.map.tileUrl && !/^https:\/\/[^\s]+\{z\}[^\s]*\{x\}[^\s]*\{y\}/.test(m.map.tileUrl)) bad('map.tileUrl', 'must be an https URL containing {z}, {x} and {y}');
  }
  return errs;
}

async function setTenantStatus(ctx: Ctx, tenant: Doc, to: TenantStatus, extra: Record<string, unknown> = {}): Promise<Doc> {
  TenantMachine.assert(tenant.status, to);
  const out = (await ctx.app.store.updateOne('tenants', { _id: tenant._id }, { $set: { status: to, updatedAt: ctx.now(), ...extra }, $inc: { version: 1 } }))!;
  const tctx = ctx.tenantId ? ctx : ctx.app.systemCtx(out, 'tenant-lifecycle');
  if (!ctx.tenantId) tctx.actor = ctx.actor;
  if (to === 'suspended' || to === 'pending_deletion' || to === 'archived') {
    // Suspended: no sign-in except Owner export; existing sessions keep SOS during the grace window (D-14).
    const open = await tctx.col('duty_tracking_sessions').find({ state: 'open' });
    for (const ts of open) await tctx.col('duty_tracking_sessions').update(ts._id, { $set: { state: 'closed', closedAt: ctx.now(), closeReason: `tenant_${to}`, graceUntil: ctx.now() }, $unset: ['openKey'] });
  }
  await tctx.emit('tenant:stateChanged', { needs: 'tenant.read', all: true }, { status: to });
  if (!ctx.tenantId) await ctx.app.writeAudit(tctx, { action: `tenant.${to}`, resource: { type: 'tenant', id: tenant._id }, before: { status: tenant.status }, after: { status: to }, reason: (extra.statusReason as string) ?? null });
  return out;
}

const platformRoutes: Route[] = [
  {
    method: 'POST', path: '/platform/auth/login', permission: 'public', scope: 'none', audit: 'platform.auth.login', rate: 'login', tx: false, summary: 'Platform staff sign-in (MFA always required)', reqs: ['FR-AUTH-003'],
    body: s.object({ email: s.string({ max: 200 }), password: s.string({ max: 200, trim: false }) }),
    async handler(ctx, { body }) {
      const user = await ctx.app.store.findOne('platform_users', { email: normEmail(body.email) });
      ctx.setAudit({ action: 'platform.auth.login.failed', resource: { type: 'platform_user', id: user?._id ?? null } });
      if (!user) { await ctx.app.hasher.hash(body.password.slice(0, 32)); throw new AppError('UNAUTHENTICATED', NEUTRAL); }
      const simple = mfaBypassActive(ctx.app.config); // simple local mode: no lockout, so testing never gets stuck (production keeps it)
      if (!simple && user.lockedUntil && user.lockedUntil > ctx.now()) throw new AppError('ACCOUNT_LOCKED', 'This account is temporarily locked.');
      if (!(await ctx.app.hasher.verify(body.password, user.passwordHash))) {
        const failed = (user.failedLogins ?? 0) + 1;
        if (!simple) await ctx.app.store.updateOne('platform_users', { _id: user._id }, { $set: { failedLogins: failed >= 5 ? 0 : failed, lockedUntil: failed >= 5 ? ctx.now() + 15 * 60000 : null } });
        throw new AppError('UNAUTHENTICATED', NEUTRAL);
      }
      // Only after the correct password: say the account is inactive (no enumeration for anyone without the password).
      if (user.status !== 'active') { ctx.setAudit({ action: 'platform.auth.login.inactive' }); throw new AppError('FORBIDDEN', 'This account is not active. Ask another Platform Super Admin to reactivate it.'); }
      ctx.setAudit({ action: 'platform.auth.password_ok' });

      // Password-only sign-in: local development bypass, or AUTH_MFA_LOGIN_DISABLED=true (see @sf/config mfaLoginSkipped).
      // Lockout above, and setup/invitation codes for new accounts, are unaffected.
      if (mfaLoginSkipped(ctx.app.config)) {
        await ctx.app.store.updateOne('platform_users', { _id: user._id }, { $set: { failedLogins: 0, lastLoginAt: ctx.now() } });
        ctx.setAudit({ action: mfaBypassActive(ctx.app.config) ? 'platform.auth.login.success.dev_mfa_bypass' : 'platform.auth.login.success.mfa_disabled', resource: { type: 'platform_user', id: user._id } });
        return platformTokens(ctx, user);
      }

      const token = randomToken(24);
      await ctx.app.store.insert('platform_sessions', { kind: 'challenge', userId: user._id, tokenHash: sha256(token), attempts: 0, createdAt: ctx.now(), expiresAt: ctx.now() + 10 * 60000, revokedAt: null });
      return { mfaRequired: true, enrolmentRequired: !user.mfa?.verifiedAt, challengeToken: token };
    },
  },
  {
    method: 'POST', path: '/platform/auth/mfa/enroll', permission: 'public', scope: 'none', audit: 'platform.auth.mfa.enroll', rate: 'login', summary: 'Create a TOTP secret for a platform user', reqs: ['FR-AUTH-003'], body: s.object({ challengeToken: s.string({ max: 100 }) }),
    async handler(ctx, { body }) {
      const { user } = await platformChallenge(ctx, body.challengeToken);
      if (user.mfa?.verifiedAt) throw new AppError('CONFLICT', 'MFA is already set up.');
      const secret = base32Encode(randomBytes(20));
      await ctx.app.store.updateOne('platform_users', { _id: user._id }, { $set: { mfa: { secretEnc: ctx.app.crypto.encrypt(secret), verifiedAt: null, lastStep: -1 } } });
      ctx.setAudit({ resource: { type: 'platform_user', id: user._id } });
      return { secret, otpauthUri: `otpauth://totp/SmartForce360%20Platform:${encodeURIComponent(user.email)}?secret=${secret}&issuer=SmartForce360` };
    },
  },
  {
    method: 'POST', path: '/platform/auth/mfa/verify', permission: 'public', scope: 'none', audit: 'platform.auth.login.success', rate: 'login', tx: false, summary: 'Complete platform sign-in with TOTP', reqs: ['FR-AUTH-003'],
    body: s.object({ challengeToken: s.string({ max: 100 }), code: s.string({ min: 6, max: 6 }) }),
    async handler(ctx, { body }) {
      const { ch, user } = await platformChallenge(ctx, body.challengeToken);
      ctx.setAudit({ resource: { type: 'platform_user', id: user._id } });
      const step = user.mfa?.secretEnc ? verifyTotp(ctx.app.crypto.decrypt(user.mfa.secretEnc), body.code, ctx.now(), user.mfa.lastStep ?? -1) : null;
      if (step === null) { await ctx.app.store.updateOne('platform_sessions', { _id: ch._id }, { $inc: { attempts: 1 } }); ctx.setAudit({ action: 'platform.auth.mfa.failed' }); throw new AppError('UNAUTHENTICATED', 'That code is not correct.'); }
      await ctx.app.store.updateOne('platform_users', { _id: user._id }, { $set: { 'mfa.lastStep': step, 'mfa.verifiedAt': user.mfa.verifiedAt ?? ctx.now(), failedLogins: 0, lastLoginAt: ctx.now() } });
      await ctx.app.store.updateOne('platform_sessions', { _id: ch._id }, { $set: { revokedAt: ctx.now() } });
      return platformTokens(ctx, user);
    },
  },
  {
    method: 'POST', path: '/platform/auth/register', permission: 'public', scope: 'none', audit: 'platform.auth.register', rate: 'login', tx: false,
    summary: 'Create a Platform Super Admin account with the one-time setup code (first run) or an invitation code; the role is set by the server', reqs: ['FR-AUTH-003'],
    body: s.object({ code: s.optional(s.string({ max: 200 })), email: s.string({ min: 1, max: 200 }), password: s.string({ min: 1, max: 200, trim: false }) }),
    async handler(ctx, { body }) {
      ctx.setAudit({ action: 'platform.auth.register.failed', resource: { type: 'platform_user', id: null } });
      const email = normEmail(body.email);
      const fieldErrors = [...(EMAIL_RE.test(email) ? [] : [{ path: 'email', code: 'FORMAT', message: 'Please enter a valid email address.' }]), ...platformPasswordErrors(body.password)];
      if (fieldErrors.length) throw new AppError('VALIDATION_FAILED', 'Please correct the highlighted fields.', { fieldErrors });
      // Simple local mode (development only, see @sf/config): open sign-up, no code. Production always needs a code.
      const openSignup = mfaBypassActive(ctx.app.config);
      const code = (body.code ?? '').trim(); const setup = readSetupToken(ctx.app);
      const viaSetup = !openSignup && !!code && !!setup && sameSecret(code, setup) && !(await hasActiveSuperAdmin(ctx.app));
      let invite: Doc | null = null;
      if (!openSignup && !viaSetup) {
        if (!code) throw new AppError('FORBIDDEN', BAD_CODE);
        invite = await ctx.app.store.findOne('platform_sessions', { tokenHash: sha256(code), kind: 'invite' });
        if (!invite || invite.revokedAt || invite.expiresAt <= ctx.now() || invite.email !== email) throw new AppError('FORBIDDEN', BAD_CODE);
      }
      if (await ctx.app.store.findOne('platform_users', { email })) throw new AppError('CONFLICT', 'An account with this email already exists. Sign in instead.');
      if (invite && !(await ctx.app.store.updateOne('platform_sessions', { _id: invite._id, revokedAt: null }, { $set: { revokedAt: ctx.now(), usedAt: ctx.now() } }))) throw new AppError('FORBIDDEN', BAD_CODE);
      const via = openSignup ? 'dev_open_signup' : viaSetup ? 'setup_code' : 'invitation';
      const user = await ctx.app.store.insert('platform_users', { email, passwordHash: await ctx.app.hasher.hash(body.password), platformRoles: ['super_admin'], status: 'active', mfa: null, failedLogins: 0, createdAt: ctx.now(), createdVia: via, invitedBy: invite?.invitedBy ?? null });
      if (viaSetup) rmSync(platformSetupTokenPath(ctx.app), { force: true }); // single use
      ctx.setAudit({ action: 'platform.auth.register', resource: { type: 'platform_user', id: user._id }, after: { email, platformRoles: ['super_admin'], via } });
      return created({ id: user._id, email, platformRoles: user.platformRoles, mfaSetupRequired: !openSignup });
    },
  },
  { method: 'GET', path: '/platform/auth/signup-options', permission: 'public', scope: 'none', audit: { none: 'public sign-up options' }, rate: 'read', summary: 'Whether Create account needs a setup/invitation code and whether 2FA is asked (simple local mode)', reqs: ['FR-AUTH-003'],
    async handler(ctx) { const simple = mfaBypassActive(ctx.app.config); return { codeRequired: !simple, mfaRequired: !simple }; } },
  {
    method: 'POST', path: '/platform/invitations', permission: 'platform.user.manage', scope: 'platform', audit: 'platform.user.invite', rate: 'mutation',
    summary: 'Invite another Platform Super Admin; the one-time code is returned once and expires in 72 h', reqs: ['FR-AUTH-003'], body: s.object({ email: s.string({ min: 1, max: 200 }) }),
    async handler(ctx, { body }) {
      const email = normEmail(body.email);
      if (!EMAIL_RE.test(email)) throw new AppError('VALIDATION_FAILED', 'Please correct the highlighted fields.', { fieldErrors: [{ path: 'email', code: 'FORMAT', message: 'Please enter a valid email address.' }] });
      if (await ctx.app.store.findOne('platform_users', { email })) throw new AppError('CONFLICT', 'A platform account with this email already exists.');
      for (const old of await ctx.app.store.find('platform_sessions', { kind: 'invite', email, revokedAt: null })) await ctx.app.store.updateOne('platform_sessions', { _id: old._id }, { $set: { revokedAt: ctx.now() } }); // one live code per email
      const code = randomToken(24), expiresAt = ctx.now() + 72 * 3600000;
      const inv = await ctx.app.store.insert('platform_sessions', { kind: 'invite', email, tokenHash: sha256(code), platformRoles: ['super_admin'], invitedBy: ctx.actor.userId, createdAt: ctx.now(), expiresAt, revokedAt: null, usedAt: null });
      ctx.setAudit({ resource: { type: 'platform_invitation', id: inv._id }, after: { email, expiresAt } });
      return created({ id: inv._id, email, code, expiresAt });
    },
  },
  { method: 'GET', path: '/platform/invitations', permission: 'platform.user.manage', scope: 'platform', audit: { none: 'pending invitation list; codes are never returned again' }, rate: 'read', summary: 'Pending Super Admin invitations', reqs: ['FR-AUTH-003'],
    async handler(ctx) { return { items: (await ctx.app.store.find('platform_sessions', { kind: 'invite' })).filter((i) => !i.revokedAt && i.expiresAt > ctx.now()).map((i) => ({ id: i._id, email: i.email, createdAt: i.createdAt, expiresAt: i.expiresAt })) }; } },
  { method: 'GET', path: '/platform/auth/me', permission: 'platform-session', scope: 'platform', audit: { none: 'own profile read' }, rate: 'read', summary: 'Platform user profile',
    async handler(ctx) { return { id: ctx.actor.userId, platformRoles: ctx.actor.platformRoles, permissions: [...ctx.actor.permissions], demoMode: ctx.app.config.demoMode }; } },
  { method: 'POST', path: '/platform/auth/logout', permission: 'platform-session', scope: 'platform', audit: 'platform.auth.logout', rate: 'mutation', summary: 'End the platform session', body: s.object({}),
    async handler(ctx) { await ctx.app.store.updateOne('platform_sessions', { _id: ctx.actor.sessionId }, { $set: { revokedAt: ctx.now() } }); return { ok: true }; } },
  // ---------- Platform account management (own password; other admins: list, activate/deactivate, 2FA reset, unlock) ----------
  { method: 'POST', path: '/platform/auth/password', permission: 'platform-session', scope: 'platform', audit: 'platform.user.password', rate: 'login', summary: 'Change your own platform password (current password required); other sessions are signed out', reqs: ['FR-AUTH-002'],
    body: s.object({ currentPassword: s.string({ min: 1, max: 200, trim: false }), newPassword: s.string({ min: 1, max: 200, trim: false }) }),
    async handler(ctx, { body }) {
      const user = (await ctx.app.store.findOne('platform_users', { _id: ctx.actor.userId }))!; ctx.setAudit({ resource: { type: 'platform_user', id: user._id } });
      if (!(await ctx.app.hasher.verify(body.currentPassword, user.passwordHash))) throw new AppError('VALIDATION_FAILED', 'Please correct the highlighted fields.', { fieldErrors: [{ path: 'currentPassword', code: 'WRONG', message: 'is not correct' }] });
      const errs = platformPasswordErrors(body.newPassword).map((e) => ({ ...e, path: 'newPassword' }));
      if (body.newPassword === body.currentPassword) errs.push({ path: 'newPassword', code: 'SAME', message: 'must be different from the current password' });
      if (errs.length) throw new AppError('VALIDATION_FAILED', 'Please correct the highlighted fields.', { fieldErrors: errs });
      await ctx.app.store.updateOne('platform_users', { _id: user._id }, { $set: { passwordHash: await ctx.app.hasher.hash(body.newPassword), passwordChangedAt: ctx.now(), failedLogins: 0, lockedUntil: null } });
      await ctx.app.store.updateMany('platform_sessions', { userId: user._id, revokedAt: null, _id: { $ne: ctx.actor.sessionId } }, { $set: { revokedAt: ctx.now() } });
      return { ok: true };
    } },
  { method: 'GET', path: '/platform/users', permission: 'platform.user.manage', scope: 'platform', audit: { none: 'platform account list (no secrets)' }, rate: 'read', summary: 'Platform accounts with status, roles, 2FA and lock state', reqs: ['FR-AUTH-006'],
    async handler(ctx) {
      return { items: (await ctx.app.store.find('platform_users', {})).sort((a, b) => String(a.email).localeCompare(String(b.email))).map((u) => ({ id: u._id, email: u.email, status: u.status, platformRoles: u.platformRoles, mfaEnrolled: !!u.mfa?.verifiedAt, locked: !!(u.lockedUntil && u.lockedUntil > ctx.now()), lastLoginAt: u.lastLoginAt ?? null, createdAt: u.createdAt ?? null, self: u._id === ctx.actor.userId })) };
    } },
  ...(['deactivate', 'activate', 'mfa-reset', 'unlock'] as const).map((action): Route => ({
    method: 'POST', path: `/platform/users/:id/${action}`, permission: 'platform.user.manage', scope: 'platform', audit: `platform.user.${action.replace('-', '_')}`, rate: 'mutation',
    summary: { deactivate: 'Deactivate another platform account (signs it out; never yourself or the last active Super Admin)', activate: 'Re-activate a platform account', 'mfa-reset': 'Reset another admin\'s 2FA after a lost phone (they set it up again at next sign-in)', unlock: 'Unlock a platform account locked by failed sign-ins' }[action],
    reqs: ['FR-AUTH-003'], body: s.object({ reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      const u = await ctx.app.store.findOne('platform_users', { _id: params.id }); if (!u) throw new AppError('NOT_FOUND', 'Platform account not found');
      if (action !== 'unlock' && action !== 'activate' && u._id === ctx.actor.userId) throw new AppError('FORBIDDEN', 'This must be done by another Super Admin.');
      const signOut = () => ctx.app.store.updateMany('platform_sessions', { userId: u._id, revokedAt: null }, { $set: { revokedAt: ctx.now() } });
      if (action === 'deactivate') {
        if (u.status !== 'active') throw new AppError('INVALID_STATE_TRANSITION', 'This account is not active.');
        const others = (await ctx.app.store.find('platform_users', {})).filter((x) => x._id !== u._id && x.status === 'active' && (x.platformRoles as string[]).includes('super_admin'));
        if (!others.length) throw new AppError('CONFLICT', 'You cannot deactivate the last active Super Admin.');
        await ctx.app.store.updateOne('platform_users', { _id: u._id }, { $set: { status: 'disabled' } }); await signOut();
      } else if (action === 'activate') {
        if (u.status === 'active') throw new AppError('INVALID_STATE_TRANSITION', 'This account is already active.');
        await ctx.app.store.updateOne('platform_users', { _id: u._id }, { $set: { status: 'active', failedLogins: 0, lockedUntil: null } });
      } else if (action === 'mfa-reset') {
        await ctx.app.store.updateOne('platform_users', { _id: u._id }, { $set: { mfa: null } }); await signOut();
      } else await ctx.app.store.updateOne('platform_users', { _id: u._id }, { $set: { failedLogins: 0, lockedUntil: null } });
      ctx.setAudit({ resource: { type: 'platform_user', id: u._id }, reason: body.reason, before: { status: u.status, mfaEnrolled: !!u.mfa?.verifiedAt }, after: { action } });
      return { ok: true };
    },
  })),
  {
    method: 'GET', path: '/platform/tenants', permission: 'platform.tenant.read', scope: 'platform', audit: { none: 'metadata list without tenant content' }, rate: 'read', summary: 'Tenant list: state, plan and usage metadata only', reqs: ['FR-TEN-004'],
    async handler(ctx) {
      const tenants = await ctx.app.store.find('tenants', {}, { sort: { createdAt: -1 }, limit: 500 });
      return { items: await Promise.all(tenants.map(async (t) => ({ ...tenantView(t), usage: t.status === 'deleted' ? null : await usageCounts(ctx.app.systemCtx(t, 'platform-usage')) }))) };
    },
  },
  {
    method: 'POST', path: '/platform/tenants', permission: 'platform.tenant.create', scope: 'platform', audit: { none: 'tenant.provision is written inside the provisioning transaction' }, rate: 'mutation', tx: false, summary: 'Provision a tenant in one idempotent transaction', reqs: ['FR-TEN-002'],
    body: s.object({ name: s.string({ min: 2, max: 120 }), slug: s.string({ min: 3, max: 60, pattern: /^[a-z0-9][a-z0-9-]*[a-z0-9]$/ }), timezone: s.string({ max: 60 }), defaultLocale: s.enum(['en', 'ar']), planKey: s.string({ max: 40 }), trial: s.optional(s.boolean()),
      owner: s.object({ username: s.string({ min: 3, max: 60, pattern: /^[a-z0-9._-]+$/i }), email: s.optional(s.string({ max: 200, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ })), displayName: s.string({ min: 2, max: 120 }) }) }),
    async handler(ctx, { body, req }) {
      const key = req.headers['idempotency-key'];
      const existing = await ctx.app.store.findOne('tenants', { slug: body.slug });
      if (existing) {
        if (key && existing.provisionKey === key) return new Reply(200, { tenant: tenantView(existing), replayed: true, note: 'Tenant was already provisioned with this Idempotency-Key. The activation code is shown only once; issue a new one if needed.' }, { 'Idempotent-Replay': 'true' });
        throw new AppError('CONFLICT', 'A tenant with this slug already exists.', { details: { fields: ['slug'] } });
      }
      const out = await provisionTenant(ctx.app, body, ctx);
      if (key) await ctx.app.store.updateOne('tenants', { _id: out.tenant._id }, { $set: { provisionKey: key } });
      return created({ tenant: tenantView(out.tenant), ownerActivationCode: out.ownerActivationCode, ownerActivationExpiresAt: out.ownerActivationExpiresAt });
    },
  },
  { method: 'GET', path: '/platform/tenants/:id', permission: 'platform.tenant.read', scope: 'platform', audit: { none: 'metadata read' }, rate: 'read', summary: 'Tenant metadata', reqs: ['FR-TEN-004'],
    async handler(ctx, { params }) { const t = await ctx.app.store.findOne('tenants', { _id: params.id }); if (!t) throw new AppError('NOT_FOUND', 'Tenant not found'); const tc = ctx.app.systemCtx(t, 'platform'); return { ...tenantView(t), usage: t.status === 'deleted' ? null : await usageCounts(tc), limits: t.status === 'deleted' ? null : await planLimits(tc) }; } },
  {
    method: 'PATCH', path: '/platform/tenants/:id', permission: 'platform.tenant.update', scope: 'platform', audit: 'platform.tenant.update', rate: 'mutation', summary: 'Update tenant metadata', reqs: ['FR-TEN-004'], body: s.object({ name: s.optional(s.string({ min: 2, max: 120 })) }),
    async handler(ctx, { params, body }) { const t = await ctx.app.store.updateOne('tenants', { _id: params.id }, { $set: { ...body, updatedAt: ctx.now() }, $inc: { version: 1 } }); if (!t) throw new AppError('NOT_FOUND', 'Tenant not found'); ctx.setAudit({ resource: { type: 'tenant', id: t._id }, after: body }); return tenantView(t); },
  },
  ...(['suspend', 'resume', 'archive'] as const).map((action): Route => ({
    method: 'POST', path: `/platform/tenants/:id/${action}`, permission: 'platform.tenant.lifecycle', scope: 'platform', audit: `platform.tenant.${action}`, rate: 'mutation', summary: `Tenant lifecycle: ${action}`, reqs: ['FR-TEN-001'], body: s.object({ reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      const t = await ctx.app.store.findOne('tenants', { _id: params.id }); if (!t) throw new AppError('NOT_FOUND', 'Tenant not found');
      const to: TenantStatus = action === 'suspend' ? 'suspended' : action === 'archive' ? 'archived' : 'active';
      const out = await setTenantStatus(ctx, t, to, { statusReason: body.reason, ...(to === 'suspended' ? { suspendedAt: ctx.now() } : {}) });
      ctx.setAudit({ resource: { type: 'tenant', id: t._id }, reason: body.reason, before: { status: t.status }, after: { status: to } });
      return tenantView(out);
    },
  })),
  {
    method: 'PUT', path: '/platform/tenants/:id/plan', permission: 'platform.plan.assign', scope: 'platform', audit: 'platform.plan.assign', rate: 'mutation', summary: 'Assign a plan manually (no payment is taken or implied)', reqs: ['FR-SUB-004'],
    body: s.object({ planKey: s.string({ max: 40 }), limitsOverride: s.optional(s.json()), reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      const t = await ctx.app.store.findOne('tenants', { _id: params.id }); const plan = await ctx.app.store.findOne('plans', { key: body.planKey });
      if (!t) throw new AppError('NOT_FOUND', 'Tenant not found');
      if (!plan) throw new AppError('VALIDATION_FAILED', 'Unknown plan.', { fieldErrors: [{ path: 'planKey', code: 'INVALID', message: 'is not a known plan' }] });
      const tc = ctx.app.systemCtx(t, 'plan-assign'); tc.actor = ctx.actor;
      await tc.col('subscriptions').updateWhere({ planScope: 'current' }, { $set: { planKey: plan.key, limitsOverride: body.limitsOverride ?? null, assignedBy: ctx.actor.userId, assignedAt: ctx.now(), paymentState: 'not_applicable_manual_assignment' } });
      await ctx.app.store.updateOne('tenants', { _id: t._id }, { $set: { planKey: plan.key } });
      await ctx.app.writeAudit(tc, { action: 'subscription.plan.assigned', resource: { type: 'subscription', id: t._id }, reason: body.reason, before: { planKey: t.planKey }, after: { planKey: plan.key } });
      ctx.setAudit({ resource: { type: 'tenant', id: t._id }, reason: body.reason, before: { planKey: t.planKey }, after: { planKey: plan.key } });
      return { ok: true, planKey: plan.key };
    },
  },
  // ---------- Organisation accounts (Super Admin only; owner decision 2026-11-23) ----------
  // Passwords are stored only as one-way hashes, so they can never be shown. The Super Admin can see who the accounts are
  // and set a new password; the new password is returned once, the user's sessions are signed out, and both the Platform
  // and the organisation audit logs record the reset.
  { method: 'GET', path: '/platform/tenants/:id/users', permission: 'platform.tenant.users', scope: 'platform', audit: 'platform.tenant.users.read', rate: 'read',
    summary: 'Accounts of an organisation: name, username, email, roles, status (no password data)', reqs: ['FR-AUTH-006'],
    async handler(ctx, { params }) {
      const t = await ctx.app.store.findOne('tenants', { _id: params.id }); if (!t || t.status === 'deleted') throw new AppError('NOT_FOUND', 'Tenant not found');
      const tc = ctx.app.systemCtx(t, 'platform-tenant-users');
      const [users, ms, roles, staff] = await Promise.all([tc.col('users').find({}, { sort: { createdAt: 1 }, limit: 5000 }), tc.col('memberships').find({}), tc.col('roles').find({}), tc.col('staff_members').find({})]);
      ctx.setAudit({ resource: { type: 'tenant', id: t._id }, detail: { count: users.length } });
      return { tenant: { id: t._id, name: t.name, slug: t.slug }, items: users.map((u) => {
        const m = ms.find((x) => x.userId === u._id); const st = m?.staffMemberId ? staff.find((x) => x._id === m.staffMemberId) : null;
        const rs = roles.filter((r) => (m?.roleIds ?? []).includes(r._id));
        return { id: u._id, username: u.username, displayName: st?.displayName ?? u.username, email: u.email ?? null, roles: rs.map((r) => r.key ?? r.name), roleNames: rs.map((r) => r.name), owner: !!m && m._id === t.ownerMembershipId,
          status: u.status, activated: !!u.passwordHash, mfaEnabled: !!u.mfaEnabled, locked: !!(u.lockedUntil && u.lockedUntil > ctx.now()), lastLoginAt: u.lastLoginAt ?? null, createdAt: u.createdAt ?? null };
      }) };
    } },
  { method: 'POST', path: '/platform/tenants/:id/users/:userId/reset-password', permission: 'platform.tenant.users', scope: 'platform', audit: 'platform.tenant.user.password_reset', rate: 'mutation',
    summary: 'Set a new password for an organisation account (generated unless given); returned once; signs the user out and unlocks the account', reqs: ['FR-AUTH-007'],
    body: s.object({ reason: s.string({ min: 3, max: 300 }), password: s.optional(s.string({ min: 1, max: 200, trim: false })) }),
    async handler(ctx, { params, body }) {
      const t = await ctx.app.store.findOne('tenants', { _id: params.id }); if (!t || t.status === 'deleted') throw new AppError('NOT_FOUND', 'Tenant not found');
      const tc = ctx.app.systemCtx(t, 'platform-password-reset', await ctx.app.settingsFor(t)); tc.actor = ctx.actor;
      const user = await tc.col('users').get(params.userId!); if (!user) throw new AppError('NOT_FOUND', 'User not found');
      const membership = await tc.col('memberships').findOne({ userId: user._id });
      const password = body.password ?? `Sf-${randomBytes(12).toString('base64url')}`;
      checkPasswordPolicy(password, membership ? await isPrivileged(tc, membership) : true, tc);
      const firstPassword = !user.passwordHash;
      await tc.col('users').update(user._id, { $set: { passwordHash: await ctx.app.hasher.hash(password), failedLogins: 0, lockedUntil: null, passwordChangedAt: ctx.now(),
        ...(firstPassword && user.status === 'invited' ? { status: 'active', activatedAt: ctx.now() } : {}) }, $inc: { sessionVersion: 1 } });
      if (firstPassword) await tc.col('invitations').updateMany({ userId: user._id, usedAt: null, revokedAt: null }, { $set: { revokedAt: ctx.now() } });
      await revokeSessions(tc, { userId: user._id }, 'platform_password_reset');
      await ctx.app.writeAudit(tc, { action: 'user.password.reset_by_platform', resource: { type: 'user', id: user._id }, reason: body.reason, detail: { platformUserId: ctx.actor.userId, generated: !body.password } });
      ctx.setAudit({ resource: { type: 'user', id: user._id }, reason: body.reason, detail: { tenantId: t._id, username: user.username, generated: !body.password } });
      return { ok: true, username: user.username, tenant: t.slug, password };
    } },
  { method: 'GET', path: '/platform/plans', permission: 'platform.tenant.read', scope: 'platform', audit: { none: 'catalogue read' }, rate: 'read', summary: 'Plan catalogue',
    async handler(ctx) { return { items: await ctx.app.store.find('plans', {}, { sort: { key: 1 } }) }; } },
  {
    method: 'GET', path: '/platform/health', permission: 'platform.ops.read', scope: 'platform', audit: { none: 'operational metadata' }, rate: 'read', summary: 'Platform health: store, queues, realtime, integrations (secrets masked)', reqs: ['FR-TEN-004', 'FR-TEN-005'],
    async handler(ctx) {
      const [store, queue, pendingOutbox] = await Promise.all([ctx.app.store.ready(), ctx.app.jobs.stats(), ctx.app.store.count('outbox_events', { state: 'pending' })]);
      const c = ctx.app.config;
      return { asOf: ctx.now(), store: { kind: ctx.app.store.kind, ...store }, queue, outbox: { pending: pendingOutbox, dead: await ctx.app.store.count('outbox_events', { state: 'dead' }) }, realtime: { connections: ctx.app.hub.count() },
        backup: ctx.app.services.backupStatus?.() ?? { state: 'unknown', detail: 'No backup has been reported to this instance. See docs/runbooks/backup-restore.md.' },
        integrations: [{ kind: 'email', enabled: !!c.smtp, configured: !!c.smtp, detail: c.smtp ? `SMTP host set (${'*'.repeat(6)})` : 'not configured; in-app notifications remain the source of truth', lastDelivery: ctx.app.services.mail.lastResult ?? null },
          { kind: 'push', enabled: false, configured: false, detail: 'no push provider adapter is enabled (D-09)' }, { kind: 'sms', enabled: false, configured: false, detail: 'disabled by default' }] };
    },
  },
  { method: 'GET', path: '/platform/usage', permission: 'platform.ops.read', scope: 'platform', audit: { none: 'aggregate metadata' }, rate: 'read', summary: 'Usage per tenant (counts only)', reqs: ['FR-SUB-002'],
    async handler(ctx) { const tenants = await ctx.app.store.find('tenants', { status: { $ne: 'deleted' } }); return { asOf: ctx.now(), items: await Promise.all(tenants.map(async (t) => ({ tenantId: t._id, slug: t.slug, planKey: t.planKey, ...(await usageCounts(ctx.app.systemCtx(t, 'usage'))) }))) }; } },
  {
    method: 'POST', path: '/platform/support-grants', permission: 'platform.support.request', scope: 'platform', audit: 'support.grant.request', rate: 'mutation', summary: 'Request time-boxed, read-only access to tenant content (or break-glass with Owner notification)', reqs: ['FR-TEN-003'],
    body: s.object({ tenantId: s.id(), reason: s.string({ min: 10, max: 500 }), scope: s.array(s.enum(['location.live.read', 'dashboard.read', 'report.read', 'audit.read', 'incident.read', 'alert.read', 'staff.read', 'assignment.read']), { min: 1, max: 8 }), hours: s.number({ min: 1, max: 72, int: true }), mode: s.optional(s.enum(['grant', 'break_glass'])) }),
    async handler(ctx, { body }) {
      const t = await ctx.app.store.findOne('tenants', { _id: body.tenantId }); if (!t || t.status === 'deleted') throw new AppError('NOT_FOUND', 'Tenant not found');
      const breakGlass = body.mode === 'break_glass';
      if (breakGlass && !ctx.actor.platformRoles?.includes('super_admin')) throw new AppError('FORBIDDEN', 'Break-glass access needs a Platform Super Admin.');
      const tc = ctx.app.systemCtx(t, 'support-grant'); tc.actor = ctx.actor; const now = ctx.now();
      const grant = await tc.col('support_access_grants').insert({ platformUserId: ctx.actor.userId, reason: body.reason, scope: body.scope, mode: breakGlass ? 'break_glass' : 'grant', requestedHours: breakGlass ? 1 : body.hours,
        state: breakGlass ? 'approved' : 'requested', startsAt: breakGlass ? now : null, expiresAt: breakGlass ? now + 3600000 : null, approvedBy: null, createdAt: now });
      await ctx.app.writeAudit(tc, { action: breakGlass ? 'support.grant.break_glass' : 'support.grant.request', resource: { type: 'support_access_grant', id: grant._id }, reason: body.reason, detail: { scope: body.scope } });
      await ctx.app.services.notify.roles(tc, ['owner'], { template: breakGlass ? 'support_break_glass' : 'support_grant_requested', refType: 'support_access_grant', refId: grant._id, critical: breakGlass });
      ctx.setAudit({ resource: { type: 'support_access_grant', id: grant._id }, reason: body.reason, detail: { tenantId: t._id, mode: grant.mode } });
      return created(grant);
    },
  },
];

const tenantRoutes: Route[] = [
  { method: 'GET', path: '/tenant', permission: 'tenant.read', scope: 'tenant', audit: { none: 'organisation profile read' }, rate: 'read', summary: 'Organisation profile', whenInactive: 'owner',
    async handler(ctx) { const t = ctx.tenant!; return { ...tenantView(t), weekStart: t.weekStart, weekendDays: t.weekendDays, digitStyle: t.digitStyle, goLiveAt: t.goLiveAt ?? null }; } },
  {
    method: 'PATCH', path: '/tenant', permission: 'tenant.update', scope: 'tenant', audit: 'tenant.update', rate: 'mutation', summary: 'Update organisation profile, timezone, week and digit settings', reqs: ['FR-SET-001', 'FR-I18N-002'],
    body: s.object({ name: s.optional(s.string({ min: 2, max: 120 })), timezone: s.optional(s.string({ max: 60 })), defaultLocale: s.optional(s.enum(['en', 'ar'])), weekStart: s.optional(s.enum(['SU', 'MO', 'SA'])), weekendDays: s.optional(s.array(s.enum(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']), { max: 3 })), digitStyle: s.optional(s.enum(['western', 'arabic_indic'])) }),
    async handler(ctx, { body, req }) {
      if (body.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: body.timezone }); } catch { throw new AppError('VALIDATION_FAILED', 'Unknown timezone.', { fieldErrors: [{ path: 'timezone', code: 'INVALID', message: 'is not a known IANA timezone' }] }); } }
      const ifMatch = req.headers['if-match']; const filter: Record<string, unknown> = { _id: ctx.tenantId }; if (ifMatch) filter.version = Number(ifMatch);
      const before = Object.fromEntries(Object.keys(body).map((k) => [k, ctx.tenant![k]]));
      const out = await ctx.app.store.updateOne('tenants', filter, { $set: { ...body, updatedAt: ctx.now() }, $inc: { version: 1 } });
      if (!out) throw new AppError('VERSION_CONFLICT', 'The organisation profile was changed by someone else. Reload and try again.', { details: { currentVersion: ctx.tenant!.version } });
      ctx.setAudit({ resource: { type: 'tenant', id: ctx.tenantId }, before, after: body });
      return tenantView(out);
    },
  },
  { method: 'GET', path: '/tenant/settings', permission: 'settings.read', scope: 'tenant', audit: { none: 'settings read' }, rate: 'read', summary: 'Effective settings with defaults and the current version', reqs: ['FR-SET-001'],
    async handler(ctx) { const v = await ctx.col('tenant_setting_versions').findOne({ version: ctx.tenant!.settingsVersion }); return { version: ctx.tenant!.settingsVersion, effective: ctx.settings, overrides: v?.settings ?? {}, bounds: PLATFORM_BOUNDS, changedBy: v?.changedBy ?? null, changedAt: v?.createdAt ?? null }; } },
  { method: 'GET', path: '/tenant/settings/versions', permission: 'settings.read', scope: 'tenant', audit: { none: 'settings history read' }, rate: 'read', summary: 'Settings version history', reqs: ['FR-SET-001'],
    async handler(ctx) { return { items: await ctx.col('tenant_setting_versions').find({}, { sort: { version: -1 }, limit: 100 }) }; } },
  {
    method: 'PUT', path: '/tenant/settings', permission: 'settings.update', scope: 'tenant', audit: 'settings.update', rate: 'mutation', summary: 'Replace settings overrides; creates a new audited version', reqs: ['FR-SET-001', 'FR-ALR-001'],
    body: s.object({ version: s.number({ int: true, min: 1 }), settings: s.json() }),
    async handler(ctx, { body }) {
      const errs = validateSettings(body.settings);
      if (errs.length) throw new AppError('VALIDATION_FAILED', 'Some settings are not valid.', { fieldErrors: errs });
      if (body.version !== ctx.tenant!.settingsVersion) throw new AppError('VERSION_CONFLICT', 'Settings were changed by someone else. Reload and try again.', { details: { currentVersion: ctx.tenant!.settingsVersion } });
      const prev = await ctx.col('tenant_setting_versions').findOne({ version: body.version }); const next = body.version + 1;
      await ctx.col('tenant_setting_versions').insert({ version: next, settings: body.settings, changedBy: ctx.actor.userId, createdAt: ctx.now() });
      const ok = await ctx.app.store.updateOne('tenants', { _id: ctx.tenantId, settingsVersion: body.version }, { $set: { settingsVersion: next, updatedAt: ctx.now() } });
      if (!ok) throw new AppError('VERSION_CONFLICT', 'Settings were changed by someone else. Reload and try again.');
      ctx.setAudit({ resource: { type: 'tenant_settings', id: String(next) }, before: prev?.settings ?? {}, after: body.settings });
      return { version: next, effective: deepMerge(DEFAULT_SETTINGS, body.settings) };
    },
  },
  { method: 'GET', path: '/tenant/labels', permission: 'tenant.read', scope: 'tenant', audit: { none: 'read of label data within scope' }, rate: 'read', summary: 'Terminology labels (EN/AR)', reqs: ['FR-SET-003'],
    async handler(ctx) { return (await ctx.col('label_sets').findOne({ key: 'labels' })) ?? { labels: {}, version: 0 }; } },
  {
    method: 'PUT', path: '/tenant/labels', permission: 'settings.update', scope: 'tenant', audit: 'labels.update', rate: 'mutation', summary: 'Update terminology labels', reqs: ['FR-SET-003'], body: s.object({ version: s.number({ int: true }), labels: s.json() }),
    async handler(ctx, { body }) { const cur = await ctx.col('label_sets').findOne({ key: 'labels' }); const out = await ctx.col('label_sets').updateVersioned(cur!._id, body.version, { labels: body.labels, updatedAt: ctx.now() }); ctx.setAudit({ resource: { type: 'label_set', id: cur!._id }, before: cur!.labels, after: body.labels }); return out; },
  },
  {
    method: 'GET', path: '/tenant/onboarding', permission: 'tenant.read', scope: 'tenant', audit: { none: 'checklist read' }, rate: 'read', summary: 'Onboarding checklist computed from real data', reqs: ['FR-TEN-002'],
    async handler(ctx) {
      const n = async (c: string, f = {}) => ctx.col(c).count(f);
      const steps = [
        { key: 'profile', done: !!ctx.tenant!.timezone }, { key: 'hierarchy', done: (await n('organization_units')) > 1 }, { key: 'posts', done: (await n('posts')) > 0 },
        { key: 'geofences_checkpoints', done: (await n('geofences')) + (await n('checkpoints')) > 0 }, { key: 'staff', done: (await n('staff_members')) > 1 }, { key: 'invitations', done: (await n('invitations')) > 1 },
        { key: 'devices', done: (await n('devices')) > 0 }, { key: 'alert_recipients', done: (await n('memberships', {})) > 1 }, { key: 'privacy_notice', done: (await n('privacy_notice_versions')) > 0 },
        { key: 'test_sos', done: (await n('sos_events')) > 0 }, { key: 'go_live', done: !!ctx.tenant!.goLiveAt },
      ];
      return { steps, completed: steps.filter((x) => x.done).length, total: steps.length };
    },
  },
  { method: 'POST', path: '/tenant/onboarding/go-live', permission: 'tenant.update', scope: 'tenant', audit: 'tenant.go_live', rate: 'mutation', summary: 'Record go-live confirmation', reqs: ['FR-TEN-002'], body: s.object({}),
    async handler(ctx) { await ctx.app.store.updateOne('tenants', { _id: ctx.tenantId }, { $set: { goLiveAt: ctx.now(), status: ctx.tenant!.status === 'trial' ? 'active' : ctx.tenant!.status } }); ctx.setAudit({ resource: { type: 'tenant', id: ctx.tenantId } }); return { ok: true }; } },
  { method: 'GET', path: '/tenant/usage', permission: 'tenant.read', scope: 'tenant', audit: { none: 'read of usage data within scope' }, rate: 'read', summary: 'Current usage against plan limits and monthly snapshots', reqs: ['FR-SUB-002'], whenInactive: 'owner',
    async handler(ctx) { if (!ctx.can('settings.read')) throw new AppError('FORBIDDEN', 'You do not have permission to do this.'); return { asOf: ctx.now(), usage: await usageCounts(ctx), limits: await planLimits(ctx), snapshots: await ctx.col('usage_snapshots').find({}, { sort: { period: -1 }, limit: 24 }) }; } },
  { method: 'GET', path: '/tenant/subscription', permission: 'tenant.read', scope: 'tenant', audit: { none: 'subscription read' }, rate: 'read', summary: 'Plan and subscription state (no payment data is held)', reqs: ['FR-SUB-001', 'FR-SUB-004'], whenInactive: 'owner',
    async handler(ctx) { const sub = await ctx.col('subscriptions').findOne({ planScope: 'current' }); const plan = await ctx.app.store.findOne('plans', { key: sub?.planKey }); return { subscription: sub, plan, limits: await planLimits(ctx), billing: { provider: null, note: 'Plans are assigned manually by the platform operator. No payment is processed or recorded by this system.' } }; } },
  { method: 'GET', path: '/tenant/support-grants', permission: 'support.grant.manage', scope: 'tenant', audit: { none: 'grant list read' }, rate: 'read', summary: 'Support-access requests and grants', reqs: ['FR-TEN-003'],
    async handler(ctx) { return { items: await ctx.col('support_access_grants').find({}, { sort: { createdAt: -1 }, limit: 200 }) }; } },
  ...(['approve', 'deny', 'revoke'] as const).map((action): Route => ({
    method: 'POST', path: `/tenant/support-grants/:id/${action}`, permission: 'support.grant.manage', scope: 'tenant', audit: `support.grant.${action}`, rate: 'mutation', summary: `Owner decision on a support grant: ${action}`, reqs: ['FR-TEN-003'], body: s.object({ note: s.optional(s.string({ max: 300 })) }),
    async handler(ctx, { params, body }) {
      const g = await ctx.col('support_access_grants').must(params.id!, 'Support grant'); const now = ctx.now();
      if (action === 'approve' && g.state !== 'requested') throw new AppError('INVALID_STATE_TRANSITION', 'Only a requested grant can be approved.');
      if (action === 'deny' && g.state !== 'requested') throw new AppError('INVALID_STATE_TRANSITION', 'Only a requested grant can be denied.');
      if (action === 'revoke' && g.state !== 'approved') throw new AppError('INVALID_STATE_TRANSITION', 'Only an approved grant can be revoked.');
      const set = action === 'approve' ? { state: 'approved', approvedBy: ctx.actor.userId, startsAt: now, expiresAt: now + g.requestedHours * 3600000 } : action === 'deny' ? { state: 'denied', decidedBy: ctx.actor.userId } : { state: 'revoked', revokedBy: ctx.actor.userId, expiresAt: now };
      const out = await ctx.col('support_access_grants').update(g._id, { $set: { ...set, decisionNote: body.note ?? null, decidedAt: now } });
      ctx.setAudit({ resource: { type: 'support_access_grant', id: g._id }, reason: body.note, before: { state: g.state }, after: { state: set.state } });
      return out;
    },
  })),
  {
    method: 'POST', path: '/tenant/deletion-requests', permission: 'tenant.delete', scope: 'tenant', audit: 'tenant.deletion.requested', rate: 'mutation', whenInactive: 'owner', summary: 'Request tenant deletion after the grace period (blocked by legal hold)', reqs: ['FR-EXP-002', 'FR-PRV-005'],
    body: s.object({ confirmSlug: s.string({ max: 80 }), reason: s.string({ min: 3, max: 300 }), dryRun: s.optional(s.boolean()) }),
    async handler(ctx, { body }) {
      if (body.confirmSlug !== ctx.tenant!.slug) throw new AppError('VALIDATION_FAILED', 'Type the organisation identifier exactly to confirm.', { fieldErrors: [{ path: 'confirmSlug', code: 'MISMATCH', message: 'does not match this organisation' }] });
      const holds = await ctx.col('legal_holds').count({ releasedAt: null });
      const counts = await ctx.app.services.retention.tenantCounts(ctx);
      if (body.dryRun) { ctx.setAudit({ action: 'tenant.deletion.dry_run', resource: { type: 'tenant', id: ctx.tenantId } }); return { dryRun: true, blockedByLegalHold: holds > 0, wouldDelete: counts, graceDays: ctx.settings.tenant.deletionGraceDays }; }
      if (holds > 0) throw new AppError('LEGAL_HOLD', 'An active legal hold blocks deletion. Release the hold first.', { details: { activeHolds: holds } });
      const scheduledAt = ctx.now() + ctx.settings.tenant.deletionGraceDays * 86400000;
      const dr = await ctx.col('deletion_requests').insert({ active: 'active', requestedBy: ctx.actor.userId, reason: body.reason, requestedAt: ctx.now(), scheduledAt, state: 'pending', previousStatus: ctx.tenant!.status });
      await setTenantStatus(ctx, ctx.tenant!, 'pending_deletion', { deletionScheduledAt: scheduledAt });
      ctx.setAudit({ resource: { type: 'tenant', id: ctx.tenantId }, reason: body.reason, detail: { scheduledAt: new Date(scheduledAt).toISOString() } });
      return created({ ...dr, wouldDelete: counts });
    },
  },
  { method: 'GET', path: '/tenant/deletion-requests', permission: 'tenant.delete', scope: 'tenant', audit: { none: 'deletion request read' }, rate: 'read', whenInactive: 'owner', summary: 'Deletion requests and their state', reqs: ['FR-EXP-002'],
    async handler(ctx) { return { items: await ctx.col('deletion_requests').find({}, { sort: { requestedAt: -1 } }) }; } },
  {
    method: 'DELETE', path: '/tenant/deletion-requests', permission: 'tenant.delete', scope: 'tenant', audit: 'tenant.deletion.cancelled', rate: 'mutation', whenInactive: 'owner', summary: 'Cancel a pending deletion during the grace period', reqs: ['FR-EXP-002'],
    async handler(ctx) {
      const dr = await ctx.col('deletion_requests').findOne({ active: 'active' });
      if (!dr) throw new AppError('NOT_FOUND', 'No pending deletion request');
      await ctx.col('deletion_requests').update(dr._id, { $set: { state: 'cancelled', cancelledAt: ctx.now(), cancelledBy: ctx.actor.userId }, $unset: ['active'] });
      await setTenantStatus(ctx, ctx.tenant!, 'active', { deletionScheduledAt: null });
      ctx.setAudit({ resource: { type: 'tenant', id: ctx.tenantId } });
      return { ok: true };
    },
  },
  { method: 'GET', path: '/tenant/legal-holds', permission: 'legalhold.manage', scope: 'tenant', audit: { none: 'legal hold list read' }, rate: 'read', summary: 'Legal holds', reqs: ['FR-PRV-005'],
    async handler(ctx) { return { items: await ctx.col('legal_holds').find({}, { sort: { placedAt: -1 } }) }; } },
  {
    method: 'POST', path: '/tenant/legal-holds', permission: 'legalhold.manage', scope: 'tenant', audit: 'legalhold.place', rate: 'mutation', summary: 'Place a legal hold that suspends deletion for a scope', reqs: ['FR-PRV-005'],
    body: s.object({ scope: s.object({ kind: s.enum(['tenant', 'staff', 'incident']), id: s.optional(s.id()) }), reason: s.string({ min: 5, max: 500 }) }),
    async handler(ctx, { body }) {
      if (body.scope.kind !== 'tenant') { if (!body.scope.id) throw new AppError('VALIDATION_FAILED', 'A scope id is required.', { fieldErrors: [{ path: 'scope.id', code: 'REQUIRED', message: 'is required' }] }); await ctx.col(body.scope.kind === 'staff' ? 'staff_members' : 'incidents').must(body.scope.id, 'Hold subject'); }
      const h = await ctx.col('legal_holds').insert({ scope: body.scope, reason: body.reason, placedBy: ctx.actor.userId, placedAt: ctx.now(), releasedAt: null });
      ctx.setAudit({ resource: { type: 'legal_hold', id: h._id }, reason: body.reason, after: body.scope }); return created(h);
    },
  },
  { method: 'POST', path: '/tenant/legal-holds/:id/release', permission: 'legalhold.manage', scope: 'tenant', audit: 'legalhold.release', rate: 'mutation', summary: 'Release a legal hold', reqs: ['FR-PRV-005'], body: s.object({ reason: s.string({ min: 5, max: 500 }) }),
    async handler(ctx, { params, body }) { const h = await ctx.col('legal_holds').must(params.id!, 'Legal hold'); if (h.releasedAt) throw new AppError('INVALID_STATE_TRANSITION', 'This hold is already released.'); const out = await ctx.col('legal_holds').update(h._id, { $set: { releasedAt: ctx.now(), releasedBy: ctx.actor.userId, releaseReason: body.reason } }); ctx.setAudit({ resource: { type: 'legal_hold', id: h._id }, reason: body.reason }); return out; } },
  {
    method: 'POST', path: '/tenant/ownership-transfer', permission: 'tenant.transfer', scope: 'tenant', audit: 'tenant.ownership.transfer', rate: 'mutation', summary: 'Transfer ownership to another active member', reqs: ['FR-RBAC-001'], body: s.object({ membershipId: s.id(), reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { body }) {
      const target = await ctx.col('memberships').must(body.membershipId, 'Member'); const ownerRole = (await ctx.col('roles').findOne({ key: 'owner', isDefault: true }))!; const adminRole = (await ctx.col('roles').findOne({ key: 'admin', isDefault: true }))!;
      if (target.status !== 'active' || target._id === ctx.actor.membershipId) throw new AppError('VALIDATION_FAILED', 'Choose another active member.');
      await ctx.col('memberships').update(target._id, { $set: { roleIds: [...new Set([...target.roleIds, ownerRole._id])], scopeUnitIds: ['*'] }, $inc: { version: 1 } });
      const me = (await ctx.col('memberships').get(ctx.actor.membershipId!))!;
      await ctx.col('memberships').update(me._id, { $set: { roleIds: [...new Set([...me.roleIds.filter((r: string) => r !== ownerRole._id), adminRole._id])] }, $inc: { version: 1 } });
      await ctx.app.store.updateOne('tenants', { _id: ctx.tenantId }, { $set: { ownerMembershipId: target._id } });
      await revokeSessions(ctx, { userId: { $in: [target.userId, me.userId] } }, 'ownership_transfer');
      ctx.setAudit({ resource: { type: 'tenant', id: ctx.tenantId }, reason: body.reason, before: { ownerMembershipId: me._id }, after: { ownerMembershipId: target._id } });
      return { ok: true };
    },
  },
  { method: 'GET', path: '/tenant/integrations', permission: 'integration.read', scope: 'tenant', audit: { none: 'masked integration status read' }, rate: 'read', summary: 'Integration status; secret values are never returned', reqs: ['FR-TEN-005'],
    async handler(ctx) {
      const cfg = await ctx.col('integration_configs').find({});
      return { items: ['email', 'push', 'sms', 'tiles'].map((kind) => { const c = cfg.find((x) => x.kind === kind); return { kind, enabled: !!c?.enabled, configured: !!c?.configEncrypted, configuredFields: c?.fieldNames ?? [], lastHealth: c?.lastHealth ?? null, lastDeliveryResult: c?.lastDeliveryResult ?? null, adapterAvailable: kind === 'email' || kind === 'tiles' }; }) };
    } },
  {
    method: 'PUT', path: '/tenant/integrations/:id', permission: 'integration.manage', scope: 'tenant', audit: 'integration.update', rate: 'mutation', summary: 'Enable, disable or configure an integration (secrets are write-only)', reqs: ['FR-TEN-005'],
    body: s.object({ enabled: s.boolean(), config: s.optional(s.json(2)) }),
    async handler(ctx, { params, body }) {
      const kind = params.id!; if (!['email', 'push', 'sms', 'tiles'].includes(kind)) throw new AppError('NOT_FOUND', 'Integration not found');
      const cur = await ctx.col('integration_configs').findOne({ kind });
      const set: Record<string, unknown> = { enabled: body.enabled, updatedAt: ctx.now(), updatedBy: ctx.actor.userId };
      if (body.config) { set.configEncrypted = ctx.app.crypto.encrypt(JSON.stringify(body.config)); set.fieldNames = Object.keys(body.config); }
      if (cur) await ctx.col('integration_configs').update(cur._id, { $set: set }); else await ctx.col('integration_configs').insert({ kind, ...set });
      ctx.setAudit({ resource: { type: 'integration', id: kind }, before: { enabled: !!cur?.enabled }, after: { enabled: body.enabled, fieldsChanged: body.config ? Object.keys(body.config) : [] } });
      return { kind, enabled: body.enabled, configured: !!(body.config || cur?.configEncrypted) };
    },
  },
  { method: 'GET', path: '/users', permission: 'membership.read', scope: 'tenant', audit: { none: 'account list read' }, rate: 'read', summary: 'User accounts with membership, lock and MFA state', reqs: ['FR-AUTH-006'], query: s.object({ limit: s.optional(s.number({ int: true, min: 1, max: 200 })), cursor: s.optional(s.string({ max: 300 })) }),
    async handler(ctx, { query }) {
      const page = await paginate(ctx.col('users'), {}, query, 'createdAt', -1); const ms = await ctx.col('memberships').find({ userId: { $in: page.items.map((u) => u._id) } });
      return { ...page, items: page.items.map((u) => { const m = ms.find((x) => x.userId === u._id); return { id: u._id, username: u.username, email: u.email, status: u.status, mfaEnabled: !!u.mfaEnabled, locked: !!(u.lockedUntil && u.lockedUntil > ctx.now()), lastLoginAt: u.lastLoginAt ?? null, activated: !!u.passwordHash, membershipId: m?._id, roleIds: m?.roleIds ?? [], scopeUnitIds: m?.scopeUnitIds ?? [], staffMemberId: m?.staffMemberId ?? null }; }) };
    } },
];

export function registerTenancy(app: App) {
  app.register('tenancy', [...platformRoutes, ...tenantRoutes]);
  app.services.tenancy = { setTenantStatus, provisionTenant, ensurePlans };
  // Monthly usage snapshots (FR-SUB-002)
  app.schedule('usage.snapshot', 6 * 3600, async (tenant) => {
    if (tenant.status === 'deleted') return;
    const ctx = app.systemCtx(tenant, 'usage-snapshot'); const period = new Date(app.clock.now()).toISOString().slice(0, 7); const usage = await usageCounts(ctx);
    const cur = await ctx.col('usage_snapshots').findOne({ period });
    if (cur) await ctx.col('usage_snapshots').update(cur._id, { $set: { ...usage, takenAt: app.clock.now() } }); else await ctx.col('usage_snapshots').insert({ period, ...usage, takenAt: app.clock.now() });
  });
  // Support grants expire automatically (FR-TEN-003)
  app.schedule('support.grant.expiry', 60, async (tenant) => {
    const ctx = app.systemCtx(tenant, 'grant-expiry');
    for (const g of await ctx.col('support_access_grants').find({ state: 'approved', expiresAt: { $lte: app.clock.now() } })) {
      await ctx.col('support_access_grants').update(g._id, { $set: { state: 'expired' } });
      await app.writeAudit(ctx, { action: 'support.grant.expired', resource: { type: 'support_access_grant', id: g._id } });
    }
  });
}
export async function bootstrapPlatform(app: App) {
  await ensurePlans(app);
  const b = app.config.bootstrap;
  const existing = b ? await app.store.findOne('platform_users', { email: normEmail(b.email) }) : null;
  if (b && !existing) {
    await app.store.insert('platform_users', { email: normEmail(b.email), passwordHash: await app.hasher.hash(b.password), platformRoles: ['super_admin'], status: 'active', mfa: null, failedLogins: 0, createdAt: app.clock.now() });
    app.log.info('platform super admin created from PLATFORM_ADMIN_EMAIL', {});
  } else if (b && existing && mfaBypassActive(app.config)) {
    // Simple local mode only: the .env password is the source of truth on every start (also unlocks the account).
    const roles = (existing.platformRoles as string[]).includes('super_admin') ? existing.platformRoles : [...existing.platformRoles, 'super_admin'];
    const same = await app.hasher.verify(b.password, existing.passwordHash);
    await app.store.updateOne('platform_users', { _id: existing._id }, { $set: { ...(same ? {} : { passwordHash: await app.hasher.hash(b.password) }), platformRoles: roles, status: 'active', failedLogins: 0, lockedUntil: null } });
    app.log.info(same ? 'platform super admin from .env is ready' : 'platform super admin password updated from PLATFORM_ADMIN_PASSWORD (simple local mode)', {});
  } else if (b) app.log.info('PLATFORM_ADMIN_EMAIL already exists; PLATFORM_ADMIN_PASSWORD is used only when the account is first created and is ignored now', {});
  if (app.store.kind !== 'memory') await ensurePlatformSetupToken(app); // persistent stores only; tests use memory
}
