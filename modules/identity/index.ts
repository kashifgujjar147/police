// Identity & Access: sign-in, MFA, sessions, activation, password reset (PRD §8.1; TS §6).
import { BREACHED_PASSWORDS, mfaBypassActive, mfaLoginSkipped } from '@sf/config';
import { PRIVILEGED_ROLES } from '@sf/permissions';
import { base32Encode, verifyTotp } from '@sf/domain/node';
import { randomBytes } from 'node:crypto';
import { App, AppError, Ctx, type Doc, Reply, type Route, activationCode, parseCookies, randomToken, s, sha256, signJwt } from '@sf/kernel';

const NEUTRAL = 'The sign-in details are not correct.'; // identical for unknown account and wrong password (FR-AUTH-006)

export function checkPasswordPolicy(password: string, privileged: boolean, ctx: Ctx) {
  const min = Math.max(privileged ? ctx.settings.auth.passwordMinPrivileged : ctx.settings.auth.passwordMin, privileged ? 12 : 10);
  const errs: { path: string; code: string; message: string }[] = [];
  if (password.length < min) errs.push({ path: 'password', code: 'TOO_SHORT', message: `must be at least ${min} characters` });
  if (password.length > 128) errs.push({ path: 'password', code: 'TOO_LONG', message: 'must be at most 128 characters' });
  if (BREACHED_PASSWORDS.has(password.toLowerCase())) errs.push({ path: 'password', code: 'BREACHED', message: 'is on a list of commonly used passwords; choose another' });
  if (errs.length) throw new AppError('VALIDATION_FAILED', 'This password does not meet the policy.', { fieldErrors: errs });
}

export async function revokeSessions(ctx: Ctx, filter: Record<string, unknown>, reason: string): Promise<number> {
  const sessions = await ctx.col('sessions').find({ ...filter, revokedAt: null });
  for (const sess of sessions) {
    await ctx.col('sessions').update(sess._id, { $set: { revokedAt: ctx.now(), revokedReason: reason } });
    await ctx.emit('session:revoked', { userId: sess.userId }, { sessionId: sess._id, reason });
  }
  return sessions.length;
}

interface Tokens { accessToken: string; expiresIn: number; refreshToken: string; csrf: string; session: Doc }
async function createSession(ctx: Ctx, user: Doc, membership: Doc, opts: { deviceId?: string | null; userAgent?: string }): Promise<Tokens> {
  const a = ctx.settings.auth, now = ctx.now(), mobile = !!opts.deviceId;
  const refreshToken = randomToken(32);
  const session = await ctx.col('sessions').insert({
    userId: user._id, membershipId: membership._id, deviceId: opts.deviceId ?? null, familyId: randomToken(12), tokenHash: sha256(refreshToken),
    createdAt: now, lastUsedAt: now, idleMs: mobile ? a.mobileIdleDays * 86400000 : a.webIdleHours * 3600000,
    expiresAt: now + (mobile ? a.mobileAbsoluteDays : a.webAbsoluteDays) * 86400000, revokedAt: null, ip: ctx.ip, userAgent: (opts.userAgent ?? '').slice(0, 200),
  });
  return { ...accessFor(ctx, user, session), refreshToken, csrf: randomToken(16), session };
}
function accessFor(ctx: Ctx, user: Doc, session: Doc) {
  const iat = Math.floor(ctx.now() / 1000), ttl = ctx.settings.auth.accessTokenTtlSec;
  return { accessToken: signJwt({ typ: 'access', sub: user._id, tid: ctx.tenantId, mid: session.membershipId, sid: session._id, sv: user.sessionVersion, iat, exp: iat + ttl }, ctx.app.signingKey), expiresIn: ttl };
}
function tokenReply(ctx: Ctx, t: Tokens, extra: Record<string, unknown>, client: string, status = 200): Reply {
  const secure = ctx.app.config.cookieSecure ? '; Secure' : '';
  const maxAge = Math.floor((t.session.expiresAt - ctx.now()) / 1000);
  const headers = client === 'web' ? { 'Set-Cookie': [
    `sf_refresh=${t.refreshToken}; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=${maxAge}${secure}`,
    `sf_csrf=${t.csrf}; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`,
  ] } : undefined;
  return new Reply(status, { mfaRequired: false, accessToken: t.accessToken, expiresIn: t.expiresIn, ...(client === 'web' ? {} : { refreshToken: t.refreshToken }), session: { id: t.session._id, expiresAt: t.session.expiresAt }, ...extra }, headers);
}

async function resolveTenant(ctx: Ctx, slug: string): Promise<boolean> {
  const tenant = await ctx.app.store.findOne('tenants', { slug: slug.toLowerCase() });
  if (!tenant || tenant.status === 'deleted' || tenant.status === 'provisioning') return false;
  ctx.bindTenant(tenant, await ctx.app.settingsFor(tenant));
  return true;
}
async function findUser(ctx: Ctx, identifier: string): Promise<Doc | null> {
  const id = identifier.trim().toLowerCase();
  return (await ctx.col('users').findOne({ username: id })) ?? (id.includes('@') ? await ctx.col('users').findOne({ emailKey: id }) : null);
}
async function userProfile(ctx: Ctx, user: Doc, membership: Doc) {
  const roles = await ctx.col('roles').find({ _id: { $in: membership.roleIds } });
  const staff = membership.staffMemberId ? await ctx.col('staff_members').get(membership.staffMemberId) : null;
  const notice = await ctx.col('privacy_notice_versions').findOne({ effectiveFrom: { $lte: ctx.now() } }, { sort: { version: -1 } });
  const ack = notice && staff ? await ctx.col('policy_acknowledgements').findOne({ staffMemberId: staff._id, noticeVersion: notice.version }) : null;
  return {
    userId: user._id, username: user.username, email: user.email ?? null, emailVerified: !!user.emailVerifiedAt, mfaEnabled: !!user.mfaEnabled, locale: user.locale ?? ctx.tenant!.defaultLocale,
    staffMemberId: staff?._id ?? null, displayName: staff?.displayName ?? user.username, roles: roles.map((r) => r.key ?? r.name), roleNames: roles.map((r) => r.name),
    permissions: [...new Set(roles.flatMap((r) => r.permissionKeys as string[]))].sort(), scopeUnitIds: membership.scopeUnitIds,
    noticeVersion: notice?.version ?? null, noticeAcknowledged: !notice || !!ack,
  };
}
const isPrivileged = async (ctx: Ctx, membership: Doc) => (await ctx.col('roles').find({ _id: { $in: membership.roleIds } })).some((r) => (PRIVILEGED_ROLES as string[]).includes(r.key) || ctx.settings.auth.mfaRequiredRoles.includes(r.key));

async function challenge(ctx: Ctx, user: Doc, purpose: 'mfa' | 'enrol', meta: Record<string, unknown>) {
  const token = randomToken(24);
  await ctx.col('login_challenges').insert({ tokenHash: sha256(token), userId: user._id, purpose, meta, attempts: 0, expiresAt: ctx.now() + 10 * 60000, purgeAt: ctx.now() + 3600000 });
  return token;
}
async function useChallenge(ctx: Ctx, token: string): Promise<Doc> {
  const ch = await ctx.col('login_challenges').findOne({ tokenHash: sha256(token) });
  if (!ch || ch.usedAt || ch.expiresAt <= ctx.now() || ch.attempts >= 5) throw new AppError('UNAUTHENTICATED', 'This sign-in step has expired. Start again.');
  return ch;
}
function newRecoveryCodes() {
  const plain = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));
  return { plain, stored: plain.map((c) => ({ hash: sha256(c), usedAt: null })) };
}
async function completeLogin(ctx: Ctx, user: Doc, meta: { deviceId?: string | null; client: string; userAgent?: string }, extra: Record<string, unknown> = {}) {
  const membership = (await ctx.col('memberships').findOne({ userId: user._id }))!;
  await ctx.col('users').update(user._id, { $set: { failedLogins: 0, lockedUntil: null, lastLoginAt: ctx.now() } });
  const t = await createSession(ctx, user, membership, meta);
  ctx.setAudit({ action: 'auth.login.success', resource: { type: 'user', id: user._id }, detail: { sessionId: t.session._id, deviceId: meta.deviceId ?? null } });
  return tokenReply(ctx, t, { user: await userProfile(ctx, user, membership), ...extra }, meta.client);
}

const routes: Route[] = [
  {
    method: 'POST', path: '/auth/login', permission: 'public', scope: 'none', audit: 'auth.login', rate: 'login', tx: false,
    summary: 'Sign in with tenant, identifier and password', reqs: ['FR-AUTH-001', 'FR-AUTH-002', 'FR-AUTH-003', 'FR-AUTH-006'],
    body: s.object({ tenant: s.string({ min: 1, max: 80 }), identifier: s.string({ min: 1, max: 200 }), password: s.string({ min: 1, max: 200, trim: false }), client: s.optional(s.enum(['web', 'mobile'])), deviceId: s.optional(s.id()) }),
    async handler(ctx, { body, req }) {
      const tenantOk = await resolveTenant(ctx, body.tenant);
      const user = tenantOk ? await findUser(ctx, body.identifier) : null;
      ctx.app.rate.take('login', `acct:${body.tenant}:${body.identifier.toLowerCase()}`, { capacity: 5, perSec: 5 / 60 });
      if (!user || !user.passwordHash) { await ctx.app.hasher.verify(body.password, DUMMY_HASH); ctx.setAudit({ action: 'auth.login.failed', resource: { type: 'user', id: null }, detail: { reason: 'unknown_account' } }); if (!tenantOk) ctx.auditTarget = null; throw new AppError('UNAUTHENTICATED', NEUTRAL); }
      ctx.setAudit({ action: 'auth.login.failed', resource: { type: 'user', id: user._id } });
      if (user.lockedUntil && user.lockedUntil > ctx.now()) throw new AppError('ACCOUNT_LOCKED', 'This account is temporarily locked. Try again later or ask an administrator to unlock it.', { retryAfterSec: Math.ceil((user.lockedUntil - ctx.now()) / 1000) });
      const ok = await ctx.app.hasher.verify(body.password, user.passwordHash);
      if (!ok || user.status !== 'active') {
        if (!ok) {
          const failed = (user.failedLogins ?? 0) + 1, lock = failed >= ctx.settings.auth.lockThreshold;
          await ctx.col('users').update(user._id, { $set: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? ctx.now() + ctx.settings.auth.lockMinutes * 60000 : null } });
          if (lock) await ctx.audit({ action: 'auth.account.locked', resource: { type: 'user', id: user._id }, reason: 'too_many_failed_logins' });
        }
        throw new AppError('UNAUTHENTICATED', NEUTRAL);
      }
      if (ctx.app.hasher.needsRehash(user.passwordHash)) await ctx.col('users').update(user._id, { $set: { passwordHash: await ctx.app.hasher.hash(body.password) } });
      const membership = await ctx.col('memberships').findOne({ userId: user._id });
      if (!membership || membership.status !== 'active') throw new AppError('UNAUTHENTICATED', NEUTRAL);
      let deviceId: string | null = null;
      if (body.deviceId) {
        const device = await ctx.col('devices').get(body.deviceId);
        if (!device || device.staffMemberId !== membership.staffMemberId) throw new AppError('UNAUTHENTICATED', NEUTRAL);
        if (device.status === 'revoked') throw new AppError('DEVICE_REVOKED', 'This device has been revoked. Unsent records are kept on the device; contact your supervisor.');
        deviceId = device._id;
      }
      const meta = { deviceId, client: body.client ?? 'web', userAgent: req.headers['user-agent'] };
      // Password-only sign-in: local development bypass, or AUTH_MFA_LOGIN_DISABLED=true (see @sf/config mfaLoginSkipped).
      // Password, status, lockout, membership and device checks above still apply; MFA factors are left untouched.
      if (mfaLoginSkipped(ctx.app.config)) {
        const dev = mfaBypassActive(ctx.app.config);
        await ctx.audit({ action: dev ? 'auth.login.dev_mfa_bypass' : 'auth.login.mfa_disabled', resource: { type: 'user', id: user._id }, reason: dev ? 'development_only' : 'AUTH_MFA_LOGIN_DISABLED' });
        return completeLogin(ctx, user, meta);
      }
      const factor = await ctx.col('mfa_factors').findOne({ userId: user._id });
      ctx.setAudit({ action: 'auth.login.password_ok', detail: { secondFactorPending: true } });
      if (factor?.verifiedAt) return { mfaRequired: true, enrolmentRequired: false, challengeToken: await challenge(ctx, user, 'mfa', meta) };
      if (await isPrivileged(ctx, membership)) return { mfaRequired: true, enrolmentRequired: true, challengeToken: await challenge(ctx, user, 'enrol', meta) };
      return completeLogin(ctx, user, meta);
    },
  },
  {
    method: 'POST', path: '/auth/mfa/verify', permission: 'public', scope: 'none', audit: 'auth.mfa.verify', rate: 'login', tx: false,
    summary: 'Complete sign-in with a TOTP or single-use recovery code', reqs: ['FR-AUTH-003'],
    body: s.object({ tenant: s.string({ max: 80 }), challengeToken: s.string({ max: 100 }), code: s.string({ min: 6, max: 20 }) }),
    async handler(ctx, { body }) {
      if (!(await resolveTenant(ctx, body.tenant))) throw new AppError('UNAUTHENTICATED', NEUTRAL);
      const ch = await useChallenge(ctx, body.challengeToken);
      const user = (await ctx.col('users').get(ch.userId))!; const factor = await ctx.col('mfa_factors').findOne({ userId: user._id });
      if (ch.purpose !== 'mfa' || !factor?.verifiedAt) throw new AppError('UNAUTHENTICATED', NEUTRAL);
      ctx.setAudit({ resource: { type: 'user', id: user._id } });
      const code = body.code.replace(/\s/g, '');
      const step = /^\d{6}$/.test(code) ? verifyTotp(ctx.app.crypto.decrypt(factor.secretEnc), code, ctx.now(), factor.lastStep ?? -1) : null;
      const rec = step === null ? (factor.recoveryCodes as { hash: string; usedAt: number | null }[]).findIndex((r) => r.hash === sha256(code.toLowerCase()) && !r.usedAt) : -1;
      if (step === null && rec < 0) {
        await ctx.col('login_challenges').update(ch._id, { $inc: { attempts: 1 } });
        ctx.setAudit({ action: 'auth.mfa.failed' });
        throw new AppError('UNAUTHENTICATED', 'That code is not correct.');
      }
      if (step !== null) await ctx.col('mfa_factors').update(factor._id, { $set: { lastStep: step } });
      else { await ctx.col('mfa_factors').update(factor._id, { $set: { [`recoveryCodes.${rec}.usedAt`]: ctx.now() } }); await ctx.audit({ action: 'auth.mfa.recovery_code_used', resource: { type: 'user', id: user._id } }); }
      await ctx.col('login_challenges').update(ch._id, { $set: { usedAt: ctx.now() } });
      return completeLogin(ctx, user, ch.meta);
    },
  },
  {
    method: 'POST', path: '/auth/mfa/begin', permission: 'session', scope: 'own', audit: { none: 'creates a short-lived challenge only; enrolment itself is audited' }, rate: 'mutation',
    summary: 'Start voluntary MFA enrolment for the signed-in user', reqs: ['FR-AUTH-003'], body: s.object({}),
    async handler(ctx) { const user = (await ctx.col('users').get(ctx.actor.userId))!; return { challengeToken: await challenge(ctx, user, 'enrol', { existingSession: true }) }; },
  },
  {
    method: 'POST', path: '/auth/mfa/enroll', permission: 'public', scope: 'none', audit: 'auth.mfa.enroll', rate: 'login',
    summary: 'Create a TOTP secret for the pending login', reqs: ['FR-AUTH-003'], body: s.object({ tenant: s.string({ max: 80 }), challengeToken: s.string({ max: 100 }) }),
    async handler(ctx, { body }) {
      if (!(await resolveTenant(ctx, body.tenant))) throw new AppError('UNAUTHENTICATED', NEUTRAL);
      const ch = await useChallenge(ctx, body.challengeToken);
      if (ch.purpose !== 'enrol') throw new AppError('UNAUTHENTICATED', NEUTRAL);
      const user = (await ctx.col('users').get(ch.userId))!;
      const secret = base32Encode(randomBytes(20));
      await ctx.col('mfa_factors').delete({ userId: user._id, verifiedAt: null });
      if (await ctx.col('mfa_factors').findOne({ userId: user._id })) throw new AppError('CONFLICT', 'MFA is already set up. Ask another administrator to reset it.');
      await ctx.col('mfa_factors').insert({ userId: user._id, type: 'totp', secretEnc: ctx.app.crypto.encrypt(secret), verifiedAt: null, recoveryCodes: [], createdAt: ctx.now() });
      ctx.setAudit({ resource: { type: 'user', id: user._id } });
      return { secret, otpauthUri: `otpauth://totp/SmartForce360:${encodeURIComponent(user.username)}?secret=${secret}&issuer=SmartForce360&algorithm=SHA1&digits=6&period=30` };
    },
  },
  {
    method: 'POST', path: '/auth/mfa/confirm', permission: 'public', scope: 'none', audit: 'auth.mfa.enabled', rate: 'login',
    summary: 'Verify the first TOTP code, activate MFA and return single-use recovery codes', reqs: ['FR-AUTH-003'],
    body: s.object({ tenant: s.string({ max: 80 }), challengeToken: s.string({ max: 100 }), code: s.string({ min: 6, max: 6 }) }),
    async handler(ctx, { body }) {
      if (!(await resolveTenant(ctx, body.tenant))) throw new AppError('UNAUTHENTICATED', NEUTRAL);
      const ch = await useChallenge(ctx, body.challengeToken);
      const factor = await ctx.col('mfa_factors').findOne({ userId: ch.userId });
      if (ch.purpose !== 'enrol' || !factor || factor.verifiedAt) throw new AppError('UNAUTHENTICATED', NEUTRAL);
      const step = verifyTotp(ctx.app.crypto.decrypt(factor.secretEnc), body.code, ctx.now());
      if (step === null) throw new AppError('VALIDATION_FAILED', 'That code is not correct.', { fieldErrors: [{ path: 'code', code: 'INVALID', message: 'does not match the authenticator app' }] });
      const codes = newRecoveryCodes();
      await ctx.col('mfa_factors').update(factor._id, { $set: { verifiedAt: ctx.now(), lastStep: step, recoveryCodes: codes.stored } });
      const user = (await ctx.col('users').update(ch.userId, { $set: { mfaEnabled: true } }))!;
      await ctx.col('login_challenges').update(ch._id, { $set: { usedAt: ctx.now() } });
      ctx.setAudit({ resource: { type: 'user', id: user._id } });
      if (ch.meta.existingSession) return { oneTimeRecoveryCodes: codes.plain }; // not 'recoveryCodes': that key is stripped from responses (stored hashes)
      await ctx.audit({ action: 'auth.mfa.enabled', resource: { type: 'user', id: user._id } });
      return completeLogin(ctx, user, ch.meta, { oneTimeRecoveryCodes: codes.plain });
    },
  },
  {
    method: 'POST', path: '/auth/refresh', permission: 'public', scope: 'none', audit: { none: 'routine token rotation; reuse of a rotated token is audited as a security event' }, rate: 'public', tx: false,
    summary: 'Rotate the refresh token; reuse of a rotated token revokes the family', reqs: ['FR-AUTH-004'],
    body: s.object({ tenant: s.string({ max: 80 }), refreshToken: s.optional(s.string({ max: 200 })) }),
    async handler(ctx, { body, req }) {
      if (!(await resolveTenant(ctx, body.tenant))) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
      const cookies = parseCookies(req.headers['cookie']); const fromCookie = !body.refreshToken;
      const token = body.refreshToken ?? cookies.sf_refresh;
      if (!token) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
      if (fromCookie && (!cookies.sf_csrf || cookies.sf_csrf !== req.headers['x-csrf-token'])) throw new AppError('FORBIDDEN', 'The request could not be verified. Reload the page and try again.');
      const hash = sha256(token);
      return ctx.app.store.transaction(async () => {
        const used = await ctx.col('used_refresh_tokens').findOne({ tokenHash: hash });
        if (used) { // replay of a rotated token: the whole family is revoked within this request (FR-AUTH-004)
          const n = await revokeSessions(ctx, { familyId: used.familyId }, 'refresh_token_reuse');
          await ctx.audit({ action: 'auth.refresh.reuse_detected', resource: { type: 'session', id: used.sessionId }, outcome: 'denied', reason: 'rotated refresh token was presented again', detail: { familyId: used.familyId, sessionsRevoked: n } });
          return new Reply(401, { error: { code: 'UNAUTHENTICATED', message: 'Your session has ended. Sign in again.', requestId: ctx.requestId } });
        }
        const session = await ctx.col('sessions').findOne({ tokenHash: hash });
        const user = session ? await ctx.col('users').get(session.userId) : null;
        if (!session || session.revokedAt || session.expiresAt <= ctx.now() || session.lastUsedAt + session.idleMs <= ctx.now() || !user || user.status !== 'active') throw new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.');
        ctx.app.rate.take('refresh', session._id);
        const next = randomToken(32);
        await ctx.col('used_refresh_tokens').insert({ tokenHash: hash, familyId: session.familyId, sessionId: session._id, usedAt: ctx.now(), purgeAt: session.expiresAt });
        const updated = (await ctx.col('sessions').update(session._id, { $set: { tokenHash: sha256(next), lastUsedAt: ctx.now() } }))!;
        return tokenReply(ctx, { ...accessFor(ctx, user, updated), refreshToken: next, csrf: cookies.sf_csrf ?? randomToken(16), session: updated }, {}, fromCookie ? 'web' : 'mobile');
      });
    },
  },
  {
    method: 'POST', path: '/auth/logout', permission: 'session', scope: 'own', audit: 'auth.logout', rate: 'mutation', summary: 'Revoke the current session', reqs: ['FR-AUTH-005'], body: s.object({}),
    async handler(ctx) {
      await revokeSessions(ctx, { _id: ctx.actor.sessionId }, 'logout'); ctx.setAudit({ resource: { type: 'session', id: ctx.actor.sessionId } });
      return new Reply(200, { ok: true }, { 'Set-Cookie': ['sf_refresh=; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=0', 'sf_csrf=; SameSite=Strict; Path=/; Max-Age=0'] });
    },
  },
  {
    method: 'POST', path: '/auth/activate', permission: 'public', scope: 'none', audit: 'auth.activate', rate: 'login',
    summary: 'Activate an account with a single-use, expiring code and set a password', reqs: ['FR-AUTH-001'],
    body: s.object({ tenant: s.string({ max: 80 }), code: s.string({ min: 6, max: 60 }), password: s.string({ min: 1, max: 200, trim: false }) }),
    async handler(ctx, { body }) {
      if (!(await resolveTenant(ctx, body.tenant))) throw new AppError('UNAUTHENTICATED', 'This activation code is not valid.');
      const inv = await ctx.col('invitations').findOne({ codeHash: sha256(body.code.trim().toUpperCase()) });
      ctx.setAudit({ resource: { type: 'invitation', id: inv?._id ?? null } });
      if (!inv || inv.usedAt || inv.revokedAt || inv.expiresAt <= ctx.now()) throw new AppError('UNAUTHENTICATED', 'This activation code is not valid or has expired. Ask your administrator for a new one.');
      const user = (await ctx.col('users').get(inv.userId))!; const membership = (await ctx.col('memberships').findOne({ userId: user._id }))!;
      checkPasswordPolicy(body.password, await isPrivileged(ctx, membership), ctx);
      await ctx.col('invitations').update(inv._id, { $set: { usedAt: ctx.now() } });
      await ctx.col('users').update(user._id, { $set: { passwordHash: await ctx.app.hasher.hash(body.password), status: 'active', activatedAt: ctx.now(), ...(inv.channel === 'email' && user.email ? { emailVerifiedAt: ctx.now() } : {}) }, $inc: { sessionVersion: 1 } });
      if (inv.staffMemberId) { const st = await ctx.col('staff_members').get(inv.staffMemberId); if (st?.status === 'invited') await ctx.col('staff_members').update(st._id, { $set: { status: 'active', updatedAt: ctx.now() } }); }
      if (inv.purpose === 'reset') await revokeSessions(ctx, { userId: user._id }, 'password_reset');
      return { ok: true, username: user.username };
    },
  },
  {
    method: 'POST', path: '/auth/password/forgot', permission: 'public', scope: 'none', audit: 'auth.password.reset_requested', rate: 'login',
    summary: 'Request a password reset link (always answers the same way)', reqs: ['FR-AUTH-007', 'FR-AUTH-009'], body: s.object({ tenant: s.string({ max: 80 }), identifier: s.string({ max: 200 }) }),
    async handler(ctx, { body }) {
      const user = (await resolveTenant(ctx, body.tenant)) ? await findUser(ctx, body.identifier) : null;
      if (!ctx.tenantId) ctx.auditTarget = null;
      if (user && user.status === 'active' && user.email && user.emailVerifiedAt) { // an unverified address is never used for reset
        const token = randomToken(32);
        await ctx.col('password_reset_tokens').insert({ userId: user._id, tokenHash: sha256(token), expiresAt: ctx.now() + ctx.settings.auth.resetMinutes * 60000, usedAt: null, purgeAt: ctx.now() + 86400000 });
        await ctx.app.services.mail.send(ctx, user.email, 'password_reset', { link: `${ctx.app.config.publicUrl}/#/reset?tenant=${ctx.tenant!.slug}&token=${token}` }, user._id);
        ctx.setAudit({ resource: { type: 'user', id: user._id } });
      } else if (ctx.tenantId) ctx.setAudit({ resource: { type: 'user', id: null }, detail: { delivered: false } });
      return { ok: true, message: 'If the account exists and has a verified email address, a reset link has been sent.' };
    },
  },
  {
    method: 'POST', path: '/auth/password/reset', permission: 'public', scope: 'none', audit: 'auth.password.reset', rate: 'login',
    summary: 'Set a new password with a single-use token; revokes all sessions', reqs: ['FR-AUTH-007'],
    body: s.object({ tenant: s.string({ max: 80 }), token: s.string({ max: 200 }), password: s.string({ min: 1, max: 200, trim: false }) }),
    async handler(ctx, { body }) {
      if (!(await resolveTenant(ctx, body.tenant))) throw new AppError('UNAUTHENTICATED', 'This reset link is not valid.');
      const t = await ctx.col('password_reset_tokens').findOne({ tokenHash: sha256(body.token) });
      ctx.setAudit({ resource: { type: 'user', id: t?.userId ?? null } });
      if (!t || t.usedAt || t.expiresAt <= ctx.now()) throw new AppError('UNAUTHENTICATED', 'This reset link is not valid or has expired.');
      const user = (await ctx.col('users').get(t.userId))!; const membership = (await ctx.col('memberships').findOne({ userId: user._id }))!;
      checkPasswordPolicy(body.password, await isPrivileged(ctx, membership), ctx);
      await ctx.col('password_reset_tokens').update(t._id, { $set: { usedAt: ctx.now() } });
      await ctx.col('users').update(user._id, { $set: { passwordHash: await ctx.app.hasher.hash(body.password), failedLogins: 0, lockedUntil: null }, $inc: { sessionVersion: 1 } });
      await revokeSessions(ctx, { userId: user._id }, 'password_reset');
      return { ok: true };
    },
  },
  {
    method: 'POST', path: '/auth/password/change', permission: 'session', scope: 'own', audit: 'auth.password.change', rate: 'mutation', summary: 'Change own password; other sessions are revoked', reqs: ['FR-AUTH-007'],
    body: s.object({ currentPassword: s.string({ max: 200, trim: false }), newPassword: s.string({ max: 200, trim: false }) }),
    async handler(ctx, { body }) {
      const user = (await ctx.col('users').get(ctx.actor.userId))!;
      if (!(await ctx.app.hasher.verify(body.currentPassword, user.passwordHash))) throw new AppError('VALIDATION_FAILED', 'The current password is not correct.', { fieldErrors: [{ path: 'currentPassword', code: 'INVALID', message: 'is not correct' }] });
      checkPasswordPolicy(body.newPassword, ctx.actor.roleKeys.some((r) => (PRIVILEGED_ROLES as string[]).includes(r)), ctx);
      await ctx.col('users').update(user._id, { $set: { passwordHash: await ctx.app.hasher.hash(body.newPassword) } });
      await revokeSessions(ctx, { userId: user._id, _id: { $ne: ctx.actor.sessionId } }, 'password_change');
      ctx.setAudit({ resource: { type: 'user', id: user._id } });
      return { ok: true };
    },
  },
  {
    method: 'POST', path: '/auth/email/request-verification', permission: 'session', scope: 'own', audit: 'auth.email.verification_requested', rate: 'mutation', summary: 'Send a single-use verification link to own email address', reqs: ['FR-AUTH-009'], body: s.object({}),
    async handler(ctx) {
      const user = (await ctx.col('users').get(ctx.actor.userId))!;
      if (!user.email) throw new AppError('VALIDATION_FAILED', 'No email address is set on this account.');
      const token = randomToken(32);
      await ctx.col('password_reset_tokens').insert({ userId: user._id, kind: 'verify_email', email: user.email, tokenHash: sha256(token), expiresAt: ctx.now() + 24 * 3600000, usedAt: null, purgeAt: ctx.now() + 7 * 86400000 });
      await ctx.app.services.mail.send(ctx, user.email, 'verify_email', { link: `${ctx.app.config.publicUrl}/#/verify-email?tenant=${ctx.tenant!.slug}&token=${token}` }, user._id);
      return { ok: true };
    },
  },
  {
    method: 'POST', path: '/auth/verify-email', permission: 'public', scope: 'none', audit: 'auth.email.verified', rate: 'login', summary: 'Verify an email address with a single-use token', reqs: ['FR-AUTH-009'],
    body: s.object({ tenant: s.string({ max: 80 }), token: s.string({ max: 200 }) }),
    async handler(ctx, { body }) {
      if (!(await resolveTenant(ctx, body.tenant))) throw new AppError('UNAUTHENTICATED', 'This link is not valid.');
      const t = await ctx.col('password_reset_tokens').findOne({ tokenHash: sha256(body.token) });
      const user = t ? await ctx.col('users').get(t.userId) : null;
      if (!t || t.kind !== 'verify_email' || t.usedAt || t.expiresAt <= ctx.now() || !user || user.email !== t.email) throw new AppError('UNAUTHENTICATED', 'This link is not valid or has expired.');
      await ctx.col('password_reset_tokens').update(t._id, { $set: { usedAt: ctx.now() } });
      await ctx.col('users').update(user._id, { $set: { emailVerifiedAt: ctx.now() } });
      ctx.setAudit({ resource: { type: 'user', id: user._id } });
      return { ok: true };
    },
  },
  {
    method: 'GET', path: '/auth/me', permission: 'session', scope: 'own', audit: { none: 'own profile read' }, rate: 'read', summary: 'Profile, permissions, scope and privacy-notice status', reqs: ['FR-RBAC-002'],
    async handler(ctx) {
      const user = (await ctx.col('users').get(ctx.actor.userId))!; const membership = (await ctx.col('memberships').get(ctx.actor.membershipId!))!;
      return { ...(await userProfile(ctx, user, membership)), tenant: { id: ctx.tenantId, name: ctx.tenant!.name, slug: ctx.tenant!.slug, status: ctx.tenant!.status, timezone: ctx.tenant!.timezone, defaultLocale: ctx.tenant!.defaultLocale, weekStart: ctx.tenant!.weekStart, weekendDays: ctx.tenant!.weekendDays, digitStyle: ctx.tenant!.digitStyle }, deviceId: ctx.actor.deviceId, deviceStatus: ctx.device?.status ?? null, demoMode: ctx.app.config.demoMode, serverTime: ctx.now() };
    },
  },
  {
    method: 'PATCH', path: '/auth/me', permission: 'session', scope: 'own', audit: 'user.profile.update', rate: 'mutation', summary: 'Update own language preference', reqs: ['FR-I18N-001'], body: s.object({ locale: s.enum(['en', 'ar']) }),
    async handler(ctx, { body }) { await ctx.col('users').update(ctx.actor.userId, { $set: { locale: body.locale } }); ctx.setAudit({ resource: { type: 'user', id: ctx.actor.userId } }); return { ok: true }; },
  },
  {
    method: 'GET', path: '/auth/sessions', permission: 'session', scope: 'own', audit: { none: 'own session list' }, rate: 'read', summary: 'List sessions (own, or another user with session.revoke)', reqs: ['FR-AUTH-005'], query: s.object({ userId: s.optional(s.id()) }),
    async handler(ctx, { query }) {
      const userId = query.userId && query.userId !== ctx.actor.userId ? (ctx.need('session.revoke'), query.userId) : ctx.actor.userId;
      const items = await ctx.col('sessions').find({ userId, revokedAt: null, expiresAt: { $gt: ctx.now() } }, { sort: { lastUsedAt: -1 }, limit: 100 });
      return { items: items.map((x) => ({ id: x._id, deviceId: x.deviceId, createdAt: x.createdAt, lastUsedAt: x.lastUsedAt, expiresAt: x.expiresAt, ip: x.ip, userAgent: x.userAgent, current: x._id === ctx.actor.sessionId })) };
    },
  },
  {
    method: 'DELETE', path: '/auth/sessions/:id', permission: 'session', scope: 'own', audit: 'session.revoke', rate: 'mutation', summary: 'Revoke a session remotely', reqs: ['FR-AUTH-005'],
    async handler(ctx, { params }) {
      const sess = await ctx.col('sessions').must(params.id!, 'Session');
      if (sess.userId !== ctx.actor.userId && !ctx.can('session.revoke')) throw new AppError('NOT_FOUND', 'Session not found');
      await revokeSessions(ctx, { _id: sess._id }, sess.userId === ctx.actor.userId ? 'revoked_by_user' : 'revoked_by_admin');
      ctx.setAudit({ resource: { type: 'session', id: sess._id }, detail: { userId: sess.userId } });
      return { ok: true };
    },
  },
  {
    method: 'POST', path: '/users/:id/mfa/reset', permission: 'user.mfa.reset', scope: 'tenant', audit: 'user.mfa.reset', rate: 'mutation', summary: 'Reset another user\'s MFA (never your own)', reqs: ['FR-AUTH-003'], body: s.object({ reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      if (params.id === ctx.actor.userId) throw new AppError('FORBIDDEN', 'MFA reset must be done by another authorised administrator.');
      const user = await ctx.col('users').must(params.id!, 'User');
      await ctx.col('mfa_factors').delete({ userId: user._id });
      await ctx.col('users').update(user._id, { $set: { mfaEnabled: false }, $inc: { sessionVersion: 1 } });
      await revokeSessions(ctx, { userId: user._id }, 'mfa_reset');
      ctx.setAudit({ resource: { type: 'user', id: user._id }, reason: body.reason });
      return { ok: true };
    },
  },
  {
    method: 'POST', path: '/users/:id/unlock', permission: 'membership.update', scope: 'tenant', audit: 'user.unlock', rate: 'mutation', summary: 'Unlock a locked account', reqs: ['FR-AUTH-006'], body: s.object({}),
    async handler(ctx, { params }) { const u = await ctx.col('users').must(params.id!, 'User'); await ctx.col('users').update(u._id, { $set: { failedLogins: 0, lockedUntil: null } }); ctx.setAudit({ resource: { type: 'user', id: u._id } }); return { ok: true }; },
  },
];

let DUMMY_HASH = 'scrypt$1024$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Creates a user account for a staff member (or owner) and returns a single-use activation code, shown once. */
export async function issueInvitation(ctx: Ctx, opts: { user: Doc; staffMemberId?: string | null; channel: 'code' | 'email'; purpose?: 'activate' | 'reset' }): Promise<{ code: string; expiresAt: number }> {
  const code = activationCode(); const expiresAt = ctx.now() + ctx.settings.auth.activationHours * 3600000;
  await ctx.col('invitations').updateMany({ userId: opts.user._id, usedAt: null, revokedAt: null }, { $set: { revokedAt: ctx.now() } });
  await ctx.col('invitations').insert({ userId: opts.user._id, staffMemberId: opts.staffMemberId ?? null, codeHash: sha256(code), channel: opts.channel, purpose: opts.purpose ?? 'activate', expiresAt, usedAt: null, revokedAt: null, createdAt: ctx.now(), purgeAt: expiresAt + 7 * 86400000 });
  if (opts.channel === 'email' && opts.user.email) await ctx.app.services.mail.send(ctx, opts.user.email, 'invitation', { code, link: `${ctx.app.config.publicUrl}/#/activate?tenant=${ctx.tenant!.slug}&code=${code}` }, opts.user._id);
  return { code, expiresAt };
}

export function registerIdentity(app: App) {
  app.register('identity', routes);
  void app.hasher.hash('dummy-password-for-timing').then((h) => { DUMMY_HASH = h; });
  app.schedule('identity.purge', 3600, async (tenant) => {
    const repo = app.tenantRepo(tenant._id), now = app.clock.now();
    for (const c of ['used_refresh_tokens', 'invitations', 'password_reset_tokens', 'login_challenges', 'idempotency_records']) await repo.col(c).delete({ purgeAt: { $lt: now } });
    await repo.col('sessions').delete({ expiresAt: { $lt: now - 30 * 86400000 } });
  });
}
