// Platform Super Admin console: the routes not exercised by other suites (found by runtime route-coverage, 2026-11-13).
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

test('platform console: profile, plans, tenant detail and rename, usage counts, suspend → resume restores access, logout revokes the session', async () => {
  const h = await makeApp({ bootstrap: PLATFORM }); const p = await platformLogin(h);
  const t = await setupTenant(h, 'acme'); await addStaff(t, 'field', { device: false }); const sup = await addStaff(t, 'supervisor');
  const other = await setupTenant(h, 'beta');

  // profile
  const me = await must(p.get('/platform/auth/me')); assert.deepEqual(me.platformRoles, ['super_admin']); assert.ok(me.permissions.includes('platform.tenant.lifecycle'));
  // plan catalogue comes from the store, ordered, and never exposes internals
  const plans = (await must(p.get('/platform/plans'))).items; assert.ok(plans.length >= 1); assert.deepEqual(plans.map((x: any) => x.key), [...plans.map((x: any) => x.key)].sort());
  assert.ok(plans.some((x: any) => x.key === 'professional'));

  // tenant detail reflects real counts
  const id = t.tenant._id; const detail = await must(p.get(`/platform/tenants/${id}`));
  assert.equal(detail.slug, 'acme'); assert.equal(detail.status, 'active'); assert.equal(detail.usage.activeStaff, await h.store.count('staff_members', { tenantId: id, status: 'active' }));
  assert.equal((await p.get('/platform/tenants/does-not-exist')).status, 404);

  // rename persists (detail + list) and is audited; validation rejects junk
  const renamed = await must(p.patch(`/platform/tenants/${id}`, { name: 'Acme Guarding Ltd' })); assert.equal(renamed.name, 'Acme Guarding Ltd');
  assert.equal((await must(p.get(`/platform/tenants/${id}`))).name, 'Acme Guarding Ltd');
  assert.ok((await must(p.get('/platform/tenants'))).items.some((x: any) => x.id === id && x.name === 'Acme Guarding Ltd'));
  assert.equal((await p.patch(`/platform/tenants/${id}`, { name: 'x' })).status, 400, 'name too short');
  assert.equal((await p.patch(`/platform/tenants/${id}`, { slug: 'hijack' })).status, 400, 'slug cannot be changed through this route');
  assert.equal((await h.store.findOne('tenants', { _id: id }))!.slug, 'acme');
  assert.equal((await p.patch('/platform/tenants/does-not-exist', { name: 'Nobody Here' })).status, 404);
  assert.ok((await h.store.find('platform_audit_events', {})).some((e) => e.action === 'platform.tenant.update'));

  // usage: one row per live tenant, counts match the store
  const usage = (await must(p.get('/platform/usage'))).items; assert.deepEqual(usage.map((u: any) => u.slug).sort(), ['acme', 'beta']);
  for (const u of usage) assert.equal(u.activeStaff, await h.store.count('staff_members', { tenantId: u.tenantId, status: 'active' }), `${u.slug} activeStaff`);

  // suspend blocks staff access (the Owner keeps access for export, by design); resume restores it; other tenants unaffected
  assert.equal((await sup.client.get('/dashboard/overview')).status, 200);
  await must(p.post(`/platform/tenants/${id}/suspend`, { reason: 'Contract review' }));
  const blocked = await sup.client.get('/dashboard/overview'); assert.equal(blocked.body.error?.code, 'TENANT_NOT_ACTIVE', `suspended: ${JSON.stringify(blocked.body)}`);
  assert.equal((await must(other.owner.get('/tenant'))).status, 'active');
  assert.equal((await p.post(`/platform/tenants/${id}/resume`, { reason: 'x' })).status, 400, 'a reason is required');
  const resumed = await must(p.post(`/platform/tenants/${id}/resume`, { reason: 'Contract renewed' })); assert.equal(resumed.status ?? (await must(p.get(`/platform/tenants/${id}`))).status, 'active');
  assert.equal((await must(p.get(`/platform/tenants/${id}`))).status, 'active');
  assert.equal((await sup.client.get('/dashboard/overview')).status, 200, 'staff access restored after resume');
  const back = new Client(h, 'acme'); assert.equal((await back.login('owner', PASSWORD)).status, 200, 'sign-in works after resume');
  assert.equal((await p.post(`/platform/tenants/${id}/resume`, { reason: 'again please' })).status, 409, 'resuming an active tenant is an invalid transition');

  // tenant users can never reach these routes
  for (const path of ['/platform/auth/me', '/platform/plans', `/platform/tenants/${id}`, '/platform/usage']) assert.equal((await back.get(path)).status, 403, path);
  assert.equal((await back.patch(`/platform/tenants/${id}`, { name: 'Self Renamed' })).status, 403);

  // logout revokes the platform session immediately
  await must(p.post('/platform/auth/logout', {}));
  assert.equal((await p.get('/platform/auth/me')).status, 401, 'token no longer accepted after logout');
  assert.equal((await p.get('/platform/tenants')).status, 401);
});
