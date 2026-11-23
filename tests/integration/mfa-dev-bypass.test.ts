// Temporary local-development MFA bypass (NODE_ENV=development + AUTH_MFA_REQUIRED=false).
// Proves: password-only admin sign-in in development; MFA fully enforced everywhere else; no request can switch it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig, mfaBypassActive, mfaDevBypassFromEnv } from '@sf/config';
import { totp } from '@sf/domain/node';
import { sha256 } from '@sf/kernel';
import { Client, MFA_SECRETS, PASSWORD, addStaff, makeApp, must, setupTenant } from '../helpers.ts';

const PLATFORM = { email: 'root@platform.example', password: 'Platform-Admin-Passphrase-1' };
type H = Awaited<ReturnType<typeof makeApp>>;
/** Switches a running app's config, as if it had been started with the given environment. */
const runAs = (h: H, env: 'development' | 'test' | 'production', mfaDevBypass: boolean) => { Object.assign(h.app.config, { env, mfaDevBypass }); };

async function enrolPlatform(h: H) {
  const p = new Client(h, ''); const l = await p.post('/platform/auth/login', PLATFORM); assert.equal(l.body.enrolmentRequired, true);
  const en = await p.post('/platform/auth/mfa/enroll', { challengeToken: l.body.challengeToken });
  const ok = await p.post('/platform/auth/mfa/verify', { challengeToken: l.body.challengeToken, code: totp(en.body.secret, h.clock.now()) }); assert.equal(ok.status, 200);
  return en.body.secret as string;
}
/** Sets up a tenant whose MFA-required roles go beyond Owner/Admin, with every admin-type account already MFA-enrolled. */
async function enrolledTenant(h: H) {
  const t = await setupTenant(h, 'acme'); // owner enrols MFA during setup
  const cur = await must(t.owner.get('/tenant/settings'));
  await must(t.owner.put('/tenant/settings', { version: cur.version, settings: { auth: { mfaRequiredRoles: ['owner', 'admin', 'commander', 'auditor'] } } }));
  const admin = await addStaff(t, 'admin'), commander = await addStaff(t, 'commander'), auditor = await addStaff(t, 'auditor'), field = await addStaff(t, 'field', { device: false });
  for (const s of [admin, commander, auditor]) assert.ok(MFA_SECRETS.has(`acme:${s.code.toLowerCase()}`), 'enrolled before the bypass is switched on');
  return { t, admin, commander, auditor, field };
}
const noSecondFactor = (b: any) => {
  assert.equal(b.mfaRequired, false); assert.ok(b.accessToken, 'session issued directly');
  for (const k of ['challengeToken', 'enrolmentRequired', 'recoveryCodes', 'secret', 'otpauthUri']) assert.equal(b[k], undefined, `no ${k} in a development sign-in`);
};

test('config: simple local mode is ON by default in development (incl. unset NODE_ENV), OFF with AUTH_MFA_REQUIRED=true, never in test/production', () => {
  for (const env of [{ NODE_ENV: 'development' }, { NODE_ENV: 'development', AUTH_MFA_REQUIRED: 'false' }, {}, { AUTH_MFA_REQUIRED: 'false' }] as Record<string, string>[])
    assert.equal(mfaDevBypassFromEnv(env), true, JSON.stringify(env));
  for (const env of [
    { NODE_ENV: 'development', AUTH_MFA_REQUIRED: 'true' }, { AUTH_MFA_REQUIRED: 'true' }, { NODE_ENV: 'Development' }, { NODE_ENV: 'test' }, { NODE_ENV: 'test', AUTH_MFA_REQUIRED: 'false' },
    { NODE_ENV: 'production' }, { NODE_ENV: 'production', AUTH_MFA_REQUIRED: 'false' }, { NODE_ENV: 'staging', AUTH_MFA_REQUIRED: 'false' },
  ] as Record<string, string>[]) assert.equal(mfaDevBypassFromEnv(env), false, JSON.stringify(env));
  assert.equal(loadConfig({ NODE_ENV: 'test', STORE: 'memory', AUTH_MFA_REQUIRED: 'false' }).mfaDevBypass, false, 'ignored in test');
  const dir = mkdtempSync(join(tmpdir(), 'sf-mfa-'));
  try {
    assert.equal(loadConfig({ NODE_ENV: 'development', STORE: 'memory', DATA_DIR: dir }).mfaDevBypass, true, 'npm run dev');
    assert.equal(loadConfig({ STORE: 'memory', DATA_DIR: dir }).mfaDevBypass, true, 'npm start locally (NODE_ENV unset)');
    assert.equal(loadConfig({ NODE_ENV: 'development', STORE: 'memory', DATA_DIR: dir, AUTH_MFA_REQUIRED: 'true' }).mfaDevBypass, false, 'npm run dev:mfa');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.throws(() => loadConfig({ NODE_ENV: 'production', AUTH_MFA_REQUIRED: 'false' }), (e: Error) => e instanceof ConfigError && /AUTH_MFA_REQUIRED=false is refused in production/.test(e.message));
  // runtime guard: even a forced config flag is ignored outside development
  assert.equal(mfaBypassActive({ env: 'production', mfaDevBypass: true }), false);
  assert.equal(mfaBypassActive({ env: 'test', mfaDevBypass: true }), false);
  assert.equal(mfaBypassActive({ env: 'development', mfaDevBypass: false }), false);
  assert.equal(mfaBypassActive({ env: 'development', mfaDevBypass: true }), true);
});

test('development bypass: every admin portal signs in with password only; enrolled factors untouched; passwords, lockout and RBAC still enforced', async () => {
  const h = await makeApp({ bootstrap: PLATFORM });
  await enrolPlatform(h); const { t, admin, commander, auditor, field } = await enrolledTenant(h);
  const factorsBefore = JSON.stringify(await h.store.find('mfa_factors', {})); const platformMfaBefore = JSON.stringify((await h.store.findOne('platform_users', { email: PLATFORM.email }))!.mfa);
  runAs(h, 'development', true);

  // Platform Super Admin → Platform dashboard
  const p = new Client(h, ''); const pl = await p.post('/platform/auth/login', PLATFORM); assert.equal(pl.status, 200); noSecondFactor(pl.body);
  assert.deepEqual(pl.body.user.platformRoles, ['super_admin'], 'no change to platform roles'); p.token = pl.body.accessToken;
  assert.equal((await p.get('/platform/tenants')).status, 200); assert.equal((await p.get('/staff')).status, 403, 'platform session still has no tenant access');
  assert.equal((await new Client(h, '').post('/platform/auth/login', { ...PLATFORM, password: 'Wrong-Passphrase-000' })).status, 401, 'platform password still verified');

  // Organisation Owner, Admin and other MFA-required roles (all previously enrolled) → Organisation dashboard
  const signed: Record<string, Client> = {};
  for (const [role, id] of [['owner', 'owner'], ['admin', admin.code], ['commander', commander.code], ['auditor', auditor.code]] as const) {
    const c = new Client(h, 'acme'); const r = await c.post('/auth/login', { tenant: 'acme', identifier: id, password: PASSWORD, client: 'web' });
    assert.equal(r.status, 200, `${role}: ${JSON.stringify(r.body)}`); noSecondFactor(r.body); assert.ok(r.body.user.mfaEnabled, `${role} keeps MFA enrolled`);
    assert.deepEqual(r.body.user.roles, [role], `${role}: roles unchanged`); c.token = r.body.accessToken; signed[role] = c;
  }
  // a field user (no MFA requirement) is unaffected
  const fr = await new Client(h, 'acme').post('/auth/login', { tenant: 'acme', identifier: field.code, password: PASSWORD }); noSecondFactor(fr.body);
  const fc = new Client(h, 'acme'); fc.token = fr.body.accessToken;

  // RBAC unchanged: dashboards for roles that have it, 403 for those that do not; no platform access for tenant users
  assert.equal((await signed.owner!.get('/dashboard/overview')).status, 200); assert.equal((await signed.admin!.get('/dashboard/overview')).status, 200);
  assert.equal((await signed.auditor!.get('/dashboard/overview')).status, 403, 'auditor still has no dashboard permission');
  assert.equal((await fc.get('/dashboard/overview')).status, 403, 'field user cannot reach the admin dashboard'); assert.equal((await fc.get('/roles')).status, 403); assert.equal((await fc.get('/audit/events')).status, 403);
  for (const c of [signed.owner!, signed.admin!, fc]) assert.equal((await c.get('/platform/tenants')).status, 403, 'tenant sessions never reach platform routes');
  assert.equal((await new Client(h, 'acme').get('/dashboard/overview')).status, 401, 'no session, no dashboard');
  assert.equal((await new Client(h, 'other').post('/auth/login', { tenant: 'other', identifier: 'owner', password: PASSWORD })).status, 401, 'tenant isolation: unknown tenant');

  // A never-enrolled privileged account goes straight in and nothing is created for it
  const newAdmin = await addStaff(t, 'admin'); assert.equal(MFA_SECRETS.has(`acme:${newAdmin.code.toLowerCase()}`), false, 'no forced enrolment in development');
  assert.equal(await h.store.count('mfa_factors', { userId: newAdmin.client.profile!.userId }), 0);

  // Password verification and lockout still apply
  const x = new Client(h, 'acme');
  for (let i = 0; i < 5; i++) { const r = await x.post('/auth/login', { tenant: 'acme', identifier: admin.code, password: 'wrong-password-here' }); assert.equal(r.status, 401); assert.equal(r.body.accessToken, undefined); }
  const locked = await x.post('/auth/login', { tenant: 'acme', identifier: admin.code, password: PASSWORD }); assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED', 'lockout holds even with the right password');

  // Stored MFA secrets and recovery codes are left exactly as they were; bypass is audited
  assert.equal(JSON.stringify(await h.store.find('mfa_factors', {})), factorsBefore);
  assert.equal(JSON.stringify((await h.store.findOne('platform_users', { email: PLATFORM.email }))!.mfa), platformMfaBefore);
  const audits = (await must(signed.owner!.get('/audit/events?action=auth.login.dev_mfa_bypass'))).items; assert.ok(audits.length >= 4, 'each bypassed sign-in is audited');
  assert.ok((await h.store.find('platform_audit_events', {})).some((e) => e.action === 'platform.auth.login.success.dev_mfa_bypass'));
});

test('production and test: MFA stays mandatory even with the bypass flag forced on; TOTP and recovery codes keep working; requests cannot switch it', async () => {
  for (const env of ['production', 'test'] as const) {
    MFA_SECRETS.clear();
    const h = await makeApp({ bootstrap: PLATFORM }); const platformSecret = await enrolPlatform(h); const { t, admin } = await enrolledTenant(h);
    runAs(h, env, true); // simulate a manipulated/leaked AUTH_MFA_REQUIRED=false: the runtime guard must still refuse

    // Platform: challenge, no token; TOTP completes sign-in
    const p = new Client(h, ''); const pl = await p.post('/platform/auth/login', PLATFORM);
    assert.equal(pl.body.mfaRequired, true, env); assert.equal(pl.body.accessToken, undefined); assert.equal(pl.body.enrolmentRequired, false);
    h.clock.advanceSec(31); assert.equal((await p.post('/platform/auth/mfa/verify', { challengeToken: pl.body.challengeToken, code: totp(platformSecret, h.clock.now()) })).status, 200);

    // Organisation Owner/Admin: challenge, no token, even with tampered body fields and headers
    for (const id of ['owner', admin.code]) {
      const c = new Client(h, 'acme');
      const r = await c.post('/auth/login', { tenant: 'acme', identifier: id, password: PASSWORD, client: 'web' }, { 'x-auth-mfa-required': 'false', 'x-node-env': 'development' });
      assert.equal(r.body.mfaRequired, true, `${env} ${id}`); assert.equal(r.body.accessToken, undefined, 'no session before the second factor');
      const tampered = await c.post('/auth/login', { tenant: 'acme', identifier: id, password: PASSWORD, mfaRequired: false, AUTH_MFA_REQUIRED: 'false' });
      assert.equal(tampered.body.accessToken, undefined, 'extra body fields cannot skip MFA');
      assert.equal((await c.post('/auth/mfa/verify', { tenant: 'acme', challengeToken: r.body.challengeToken, code: '000000' })).status, 401, 'wrong code refused');
      h.clock.advanceSec(31); const ok = await c.post('/auth/mfa/verify', { tenant: 'acme', challengeToken: r.body.challengeToken, code: totp(MFA_SECRETS.get(`acme:${id.toLowerCase()}`)!, h.clock.now()) });
      assert.equal(ok.status, 200); assert.ok(ok.body.accessToken, 'TOTP verification works');
    }
    // Password still mandatory
    const bad = await new Client(h, 'acme').post('/auth/login', { tenant: 'acme', identifier: 'owner', password: 'wrong-password-here' }); assert.equal(bad.status, 401); assert.equal(bad.body.challengeToken, undefined);

    // New enrolment and recovery codes: reset admin MFA, re-enrol, then sign in with a single-use recovery code
    await must(t.owner.post(`/users/${admin.client.profile!.userId}/mfa/reset`, { reason: 'lost phone' }));
    const a = new Client(h, 'acme'); const l = await a.post('/auth/login', { tenant: 'acme', identifier: admin.code, password: PASSWORD }); assert.equal(l.body.enrolmentRequired, true, 'enrolment still forced');
    const en = await a.post('/auth/mfa/enroll', { tenant: 'acme', challengeToken: l.body.challengeToken }); assert.ok(en.body.secret);
    const conf = await a.post('/auth/mfa/confirm', { tenant: 'acme', challengeToken: l.body.challengeToken, code: totp(en.body.secret, h.clock.now()) }); assert.equal(conf.status, 200); assert.ok(conf.body.accessToken);
    const factor = (await h.store.findOne('mfa_factors', { userId: admin.client.profile!.userId }))!; assert.equal(factor.recoveryCodes.length, 10, 'recovery codes issued');
    // plain codes are not exposed by the API response layer, so plant a known one in place of the first stored hash
    const rc = 'abcde-12345'; await h.store.updateOne('mfa_factors', { _id: factor._id }, { $set: { 'recoveryCodes.0.hash': sha256(rc) } });
    const l2 = await a.post('/auth/login', { tenant: 'acme', identifier: admin.code, password: PASSWORD });
    const viaRc = await a.post('/auth/mfa/verify', { tenant: 'acme', challengeToken: l2.body.challengeToken, code: rc }); assert.equal(viaRc.status, 200); assert.ok(viaRc.body.accessToken, 'recovery code works');
    const l3 = await a.post('/auth/login', { tenant: 'acme', identifier: admin.code, password: PASSWORD });
    assert.equal((await a.post('/auth/mfa/verify', { tenant: 'acme', challengeToken: l3.body.challengeToken, code: rc })).status, 401, 'recovery code is single-use');

    assert.equal(await h.store.count('audit_events', { action: 'auth.login.dev_mfa_bypass' }), 0, `${env}: no bypass ever happened`);
    assert.ok(!(await h.store.find('platform_audit_events', {})).some((e) => e.action === 'platform.auth.login.success.dev_mfa_bypass'));
  }
});
