// Platform Super Admin accounts: first-run setup code, invitations, no self-registration, validation, hashing, MFA,
// inactive accounts, email normalisation, lockout, logout and sign-in again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { totp } from '@sf/domain/node';
import { ensurePlatformSetupToken, platformSetupTokenPath } from '../../modules/tenancy/index.ts';
import { Client, makeApp, must, setupTenant } from '../helpers.ts';

const PW = 'Correct-Horse-Platform-91';
type H = Awaited<ReturnType<typeof makeApp>>;
async function signIn(h: H, email: string, password: string, secret?: string): Promise<{ c: Client; secret: string }> {
  const c = new Client(h, ''); const l = await c.post('/platform/auth/login', { email, password }); assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(l.body.mfaRequired, true, 'MFA stays mandatory'); assert.equal(l.body.accessToken, undefined, 'no session before the second factor');
  if (l.body.enrolmentRequired) { const en = await must(c.post('/platform/auth/mfa/enroll', { challengeToken: l.body.challengeToken })); secret = en.secret; }
  else h.clock.advanceSec(31);
  const wrong = await c.post('/platform/auth/mfa/verify', { challengeToken: l.body.challengeToken, code: '000000' }); assert.equal(wrong.status, 401, 'wrong MFA code refused');
  const ok = await must(c.post('/platform/auth/mfa/verify', { challengeToken: l.body.challengeToken, code: totp(secret!, h.clock.now()) }));
  c.token = ok.accessToken; return { c, secret: secret! };
}

test('first Super Admin via one-time setup code: no anonymous or self-assigned registration, validation, hashing, MFA, dashboard, logout and sign-in again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-setup-'));
  try {
    const h = await makeApp({ dataDir: dir }); const anon = new Client(h, '');
    assert.equal(existsSync(platformSetupTokenPath(h.app)), false, 'memory store (tests) never writes a setup file on start');
    assert.ok(await ensurePlatformSetupToken(h.app)); const code = readFileSync(platformSetupTokenPath(h.app), 'utf8').trim(); assert.ok(code.length >= 20);

    // no code / wrong code / self-assigned role: nothing is created
    assert.equal((await anon.post('/platform/auth/register', { email: 'x@example.com', password: PW })).status, 403, 'code is required outside simple local mode');
    assert.equal((await anon.post('/platform/auth/register', { code: 'guess-guess-guess', email: 'x@example.com', password: PW })).status, 403);
    assert.equal((await anon.post('/platform/auth/register', { code, email: 'x@example.com', password: PW, platformRoles: ['super_admin'] })).status, 400, 'roles cannot be sent');
    assert.equal(await h.store.count('platform_users', {}), 0);
    // validation (both fields reported, beside the field)
    const bad = await anon.post('/platform/auth/register', { code, email: 'not-an-email', password: 'short' });
    assert.equal(bad.status, 400); assert.deepEqual(bad.body.error.fieldErrors.map((e: any) => e.path).sort(), ['email', 'password']);
    assert.equal((await anon.post('/platform/auth/register', { code, email: 'a@example.com', password: 'passwordpassword' })).body.error.fieldErrors[0].code, 'BREACHED');

    // valid: created with the server-fixed role, hashed, single-use code
    const r = await anon.post('/platform/auth/register', { code: ` ${code} `, email: '  Admin@SmartForce360.com ', password: PW });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.email, 'admin@smartforce360.com'); assert.deepEqual(r.body.platformRoles, ['super_admin']); assert.equal(r.body.mfaSetupRequired, true);
    const u = (await h.store.findOne('platform_users', { email: 'admin@smartforce360.com' }))!;
    assert.equal(u.status, 'active'); assert.ok(!JSON.stringify(u).includes(PW), 'no plaintext password stored'); assert.equal(await h.app.hasher.verify(PW, u.passwordHash), true); assert.equal(await h.app.hasher.verify(`${PW}x`, u.passwordHash), false);
    assert.equal(existsSync(platformSetupTokenPath(h.app)), false, 'setup code file removed after use');
    assert.equal((await anon.post('/platform/auth/register', { code, email: 'second@example.com', password: PW })).status, 403, 'setup code is single-use');
    assert.equal(await ensurePlatformSetupToken(h.app), null, 'no new setup code once a Super Admin exists');
    assert.ok((await h.store.find('platform_audit_events', {})).some((e) => e.action === 'platform.auth.register'));

    // sign-in: normalised email, wrong password generic, MFA enrolment + verification, dashboard
    const wrong = await anon.post('/platform/auth/login', { email: 'admin@smartforce360.com', password: 'Wrong-Password-000' });
    const unknown = await anon.post('/platform/auth/login', { email: 'nobody@smartforce360.com', password: 'Wrong-Password-000' });
    assert.equal(wrong.status, 401); assert.equal(unknown.status, 401); assert.equal(wrong.body.error.message, unknown.body.error.message, 'no account enumeration');
    const { c, secret } = await signIn(h, ' ADMIN@smartforce360.com ', PW);
    assert.equal((await c.get('/platform/tenants')).status, 200); assert.deepEqual((await must(c.get('/platform/auth/me'))).platformRoles, ['super_admin']);
    assert.equal((await c.get('/staff')).status, 403, 'no tenant data access');
    // logout, then sign in again with the enrolled authenticator
    await must(c.post('/platform/auth/logout', {})); assert.equal((await c.get('/platform/tenants')).status, 401);
    const again = await signIn(h, 'admin@smartforce360.com', PW, secret); assert.equal((await again.c.get('/platform/tenants')).status, 200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invitations: only a signed-in Super Admin can issue them; bound to one email; single-use; expire; duplicates refused', async () => {
  const PLATFORM = { email: 'root@platform.example', password: 'Platform-Admin-Passphrase-1' };
  const h = await makeApp({ bootstrap: PLATFORM }); const { c: root } = await signIn(h, PLATFORM.email, PLATFORM.password); const anon = new Client(h, '');
  const t = await setupTenant(h, 'acme');
  assert.equal((await anon.post('/platform/invitations', { email: 'n@example.com' })).status, 401, 'anonymous cannot invite');
  assert.equal((await t.owner.post('/platform/invitations', { email: 'n@example.com' })).status, 403, 'tenant owner cannot invite');
  assert.equal((await root.post('/platform/invitations', { email: 'bad' })).status, 400);
  assert.equal((await root.post('/platform/invitations', { email: PLATFORM.email })).status, 409, 'existing account');

  const inv = await must(root.post('/platform/invitations', { email: 'New.Admin@Example.com' })); assert.ok(inv.code); assert.equal(inv.email, 'new.admin@example.com');
  const list = (await must(root.get('/platform/invitations'))).items; assert.equal(list.length, 1); assert.equal(list[0].code, undefined, 'codes are never listed');
  assert.equal((await anon.post('/platform/auth/register', { code: inv.code, email: 'someone.else@example.com', password: PW })).status, 403, 'bound to the invited email');
  const ok = await anon.post('/platform/auth/register', { code: inv.code, email: 'new.admin@example.com', password: PW }); assert.equal(ok.status, 201); assert.deepEqual(ok.body.platformRoles, ['super_admin']);
  assert.equal((await anon.post('/platform/auth/register', { code: inv.code, email: 'new.admin@example.com', password: PW })).status, 403, 'single-use');
  assert.equal((await root.post('/platform/invitations', { email: 'new.admin@example.com' })).status, 409, 'duplicate email');
  await signIn(h, 'new.admin@example.com', PW);

  const late = await must(root.post('/platform/invitations', { email: 'late@example.com' })); h.clock.advance(73 * 3600000);
  assert.equal((await anon.post('/platform/auth/register', { code: late.code, email: 'late@example.com', password: PW })).status, 403, 'expired after 72 h');
  assert.equal(await h.store.count('platform_users', {}), 2);
});

test('inactive account: correct password gets an account-status message, wrong password stays generic; lockout after 5 failures', async () => {
  const PLATFORM = { email: 'root@platform.example', password: 'Platform-Admin-Passphrase-1' };
  const h = await makeApp({ bootstrap: PLATFORM }); const anon = new Client(h, '');
  const u = (await h.store.findOne('platform_users', { email: PLATFORM.email }))!;
  await h.store.updateOne('platform_users', { _id: u._id }, { $set: { status: 'disabled' } });
  const right = await anon.post('/platform/auth/login', PLATFORM); assert.equal(right.status, 403); assert.match(right.body.error.message, /not active/); assert.equal(right.body.challengeToken, undefined);
  const wrong = await anon.post('/platform/auth/login', { ...PLATFORM, password: 'Wrong-Password-000' }); assert.equal(wrong.status, 401); assert.doesNotMatch(wrong.body.error.message, /active/);
  await h.store.updateOne('platform_users', { _id: u._id }, { $set: { status: 'active', failedLogins: 0 } });
  for (let i = 0; i < 5; i++) assert.equal((await anon.post('/platform/auth/login', { ...PLATFORM, password: 'Wrong-Password-000' })).status, 401);
  assert.equal((await anon.post('/platform/auth/login', PLATFORM)).body.error.code, 'ACCOUNT_LOCKED');
});

test('simple local mode (development): Create account needs no code and makes a Super Admin; sign-in is password only; production still needs a code and 2FA', async () => {
  const h = await makeApp({ env: 'development', mfaDevBypass: true }); const anon = new Client(h, '');
  assert.deepEqual(await must(anon.get('/platform/auth/signup-options')), { codeRequired: false, mfaRequired: false });
  const r = await anon.post('/platform/auth/register', { email: 'Me@Example.com', password: PW }); assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.platformRoles, ['super_admin']); assert.equal(r.body.mfaSetupRequired, false);
  assert.equal((await anon.post('/platform/auth/register', { email: 'me@example.com', password: PW })).status, 409, 'duplicate email');
  assert.equal((await anon.post('/platform/auth/register', { email: 'bad', password: 'short' })).status, 400, 'validation still applies');
  assert.equal((await anon.post('/platform/auth/register', { email: 'x@example.com', password: PW, platformRoles: ['other'] })).status, 400, 'role cannot be sent');
  const l = await must(anon.post('/platform/auth/login', { email: 'me@example.com', password: PW })); assert.equal(l.mfaRequired, false); assert.ok(l.accessToken, 'direct sign-in, no 2FA');
  anon.token = l.accessToken; assert.equal((await anon.get('/platform/tenants')).status, 200, 'dashboard');
  assert.equal((await new Client(h, '').post('/platform/auth/login', { email: 'me@example.com', password: 'Wrong-Password-000' })).status, 401, 'password still checked');

  for (const env of ['production', 'test'] as const) { // forcing the flag outside development changes nothing
    const p = await makeApp({ env, mfaDevBypass: true }); const c = new Client(p, '');
    assert.deepEqual(await must(c.get('/platform/auth/signup-options')), { codeRequired: true, mfaRequired: true }, env);
    assert.equal((await c.post('/platform/auth/register', { email: 'me@example.com', password: PW })).status, 403, `${env}: no open sign-up`);
    assert.equal(await p.store.count('platform_users', {}), 0);
  }
});
