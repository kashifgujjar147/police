// Super Admin view of an organisation's accounts and password reset (owner decision, 2026-11-23).
// Proves: names/usernames/emails/roles listed, no password data ever returned; reset sets a working password once,
// signs the user out, unlocks the account, is audited on both sides; tenant users and non-super-admins are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp } from '@sf/domain/node';
import { Client, PASSWORD, addStaff, makeApp, must, setupTenant } from '../helpers.ts';

const PLATFORM = { email: 'root@platform.example', password: 'Platform-Admin-Passphrase-1' };
async function platformLogin(h: Awaited<ReturnType<typeof makeApp>>) {
  const p = new Client(h, ''); const l = await must(p.post('/platform/auth/login', PLATFORM));
  const en = await must(p.post('/platform/auth/mfa/enroll', { challengeToken: l.challengeToken }));
  const ok = await must(p.post('/platform/auth/mfa/verify', { challengeToken: l.challengeToken, code: totp(en.secret, h.clock.now()) }));
  p.token = ok.accessToken; return p;
}

test('platform: list an organisation\'s accounts without password data; reset a password by click; audited; refused to others', async () => {
  const h = await makeApp({ bootstrap: PLATFORM }); const p = await platformLogin(h);
  const t = await setupTenant(h, 'acme'); const field = await addStaff(t, 'field', { device: false, name: 'Fahad Field' });
  await setupTenant(h, 'beta'); const id = t.tenant._id;

  const list = await must(p.get(`/platform/tenants/${id}/users`));
  assert.equal(list.tenant.slug, 'acme');
  const owner = list.items.find((u: any) => u.username === 'owner'); assert.ok(owner);
  assert.equal(owner.displayName, 'Olivia Owner'); assert.equal(owner.email, 'owner@acme.example'); assert.equal(owner.owner, true); assert.ok(owner.roles.includes('owner'));
  const f = list.items.find((u: any) => u.displayName === 'Fahad Field'); assert.ok(f); assert.ok(f.roles.includes('field'));
  assert.ok(!JSON.stringify(list).match(/passwordHash|scrypt\$|"password"/), 'no password data in the list');
  assert.equal(list.items.length, await h.store.count('users', { tenantId: id }), 'only this organisation');
  assert.equal((await p.get('/platform/tenants/nope/users')).status, 404);

  // lock the owner, then reset: generated password returned once, works, old one fails, sessions revoked, unlocked
  const bad = new Client(h, 'acme'); for (let i = 0; i < 6; i++) await bad.post('/auth/login', { tenant: 'acme', identifier: 'owner', password: 'wrong-password-here' });
  assert.equal((await must(p.get(`/platform/tenants/${id}/users`))).items.find((u: any) => u.id === owner.id).locked, true);
  assert.equal((await p.post(`/platform/tenants/${id}/users/${owner.id}/reset-password`, {})).status, 400, 'a reason is required');
  const r = await must(p.post(`/platform/tenants/${id}/users/${owner.id}/reset-password`, { reason: 'owner forgot password' }));
  assert.equal(r.username, 'owner'); assert.equal(r.tenant, 'acme'); assert.ok(r.password.length >= 12);
  assert.equal((await t.owner.get('/dashboard/overview')).status, 401, 'existing owner session signed out');
  const l = await new Client(h, 'acme').post('/auth/login', { tenant: 'acme', identifier: 'owner', password: r.password, client: 'web' });
  assert.equal(l.status, 200, 'new password works and the account is unlocked'); assert.ok(l.body.mfaRequired || l.body.accessToken);
  assert.equal((await new Client(h, 'acme').post('/auth/login', { tenant: 'acme', identifier: 'owner', password: PASSWORD })).status, 401, 'old password no longer works');
  assert.equal(JSON.stringify(await h.store.find('platform_audit_events', {})).includes(r.password), false, 'the new password is never written to audit');

  // a chosen password must meet the policy
  assert.equal((await p.post(`/platform/tenants/${id}/users/${f.id}/reset-password`, { reason: 'test', password: 'short' })).status, 400);
  const chosen = await must(p.post(`/platform/tenants/${id}/users/${f.id}/reset-password`, { reason: 'set by support', password: 'Field-Passphrase-2026' }));
  assert.equal(chosen.password, 'Field-Passphrase-2026');
  assert.equal((await new Client(h, 'acme').post('/auth/login', { tenant: 'acme', identifier: f.username, password: 'Field-Passphrase-2026' })).status, 200);

  // audited on both sides
  assert.ok((await h.store.find('platform_audit_events', {})).some((e) => e.action === 'platform.tenant.user.password_reset'));
  assert.ok((await h.store.find('platform_audit_events', {})).some((e) => e.action === 'platform.tenant.users.read'));
  assert.ok((await h.store.find('audit_events', { tenantId: id })).some((e) => e.action === 'user.password.reset_by_platform'));

  // tenant sessions and anonymous callers cannot use these routes
  assert.equal((await field.client.get(`/platform/tenants/${id}/users`)).status === 200, false);
  assert.equal((await new Client(h, '').get(`/platform/tenants/${id}/users`)).status, 401);
});
