// Recovery codes reach the user (and work once); platform account management with its safety rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp } from '@sf/domain/node';
import { Client, PASSWORD, makeApp, must, setupTenant } from '../helpers.ts';

test('MFA set-up returns 10 one-time recovery codes to the user; one signs in once; stored codes stay hashed', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme');
  const u = await must(t.owner.post('/staff', { employeeCode: 'ADM9', displayName: 'Ada Admin', homeUnitId: t.rootUnitId, roleIds: [t.roleIds.admin], scopeUnitIds: ['*'], phone: '+92 300 0000000' }));
  const inv = await must(t.owner.post(`/staff/${u.id}/invitation`, { channel: 'code' }));
  const c = new Client(h, 'acme'); await must(c.post('/auth/activate', { tenant: 'acme', code: inv.activationCode, password: PASSWORD }));
  const l = await must(c.post('/auth/login', { tenant: 'acme', identifier: 'adm9', password: PASSWORD })); assert.equal(l.enrolmentRequired, true);
  const en = await must(c.post('/auth/mfa/enroll', { tenant: 'acme', challengeToken: l.challengeToken }));
  const conf = await must(c.post('/auth/mfa/confirm', { tenant: 'acme', challengeToken: l.challengeToken, code: totp(en.secret, h.clock.now()) }));
  assert.equal(conf.oneTimeRecoveryCodes?.length, 10, 'codes are returned to the user once'); assert.equal(conf.recoveryCodes, undefined);
  const factor = (await h.store.findOne('mfa_factors', { userId: conf.user.userId }))!; assert.ok(!JSON.stringify(factor).includes(conf.oneTimeRecoveryCodes[0]), 'stored hashed');
  const l2 = await must(c.post('/auth/login', { tenant: 'acme', identifier: 'adm9', password: PASSWORD }));
  const viaCode = await c.post('/auth/mfa/verify', { tenant: 'acme', challengeToken: l2.challengeToken, code: conf.oneTimeRecoveryCodes[0] }); assert.equal(viaCode.status, 200); assert.ok(viaCode.body.accessToken);
  const l3 = await must(c.post('/auth/login', { tenant: 'acme', identifier: 'adm9', password: PASSWORD }));
  assert.equal((await c.post('/auth/mfa/verify', { tenant: 'acme', challengeToken: l3.challengeToken, code: conf.oneTimeRecoveryCodes[0] })).status, 401, 'single use');
});

const ROOT = { email: 'root@platform.example', password: 'Platform-Admin-Passphrase-1' };
async function platformIn(h: Awaited<ReturnType<typeof makeApp>>, email: string, password: string, secret?: string) {
  const p = new Client(h, ''); const l = await must(p.post('/platform/auth/login', { email, password }));
  if (l.enrolmentRequired) secret = (await must(p.post('/platform/auth/mfa/enroll', { challengeToken: l.challengeToken }))).secret; else h.clock.advanceSec(31);
  p.token = (await must(p.post('/platform/auth/mfa/verify', { challengeToken: l.challengeToken, code: totp(secret!, h.clock.now()) }))).accessToken; return { p, secret: secret! };
}

test('platform accounts: change own password, list admins, deactivate/activate, reset another admin\'s 2FA, unlock — with safety rules', async () => {
  const h = await makeApp({ bootstrap: ROOT }); const { p: root, secret: rootSecret } = await platformIn(h, ROOT.email, ROOT.password);
  const inv = await must(root.post('/platform/invitations', { email: 'two@platform.example' }));
  await must(new Client(h, '').post('/platform/auth/register', { code: inv.code, email: 'two@platform.example', password: 'Second-Admin-Passphrase-2' }));
  const { p: two, secret: twoSecret } = await platformIn(h, 'two@platform.example', 'Second-Admin-Passphrase-2');

  const list = (await must(root.get('/platform/users'))).items; assert.deepEqual(list.map((x: any) => x.email), [ROOT.email, 'two@platform.example']);
  assert.ok(list.every((x: any) => x.passwordHash === undefined && x.mfa === undefined), 'no secrets in the list'); assert.equal(list.find((x: any) => x.self).email, ROOT.email);
  const twoId = list.find((x: any) => !x.self).id, rootId = list.find((x: any) => x.self).id;

  // safety rules
  assert.equal((await root.post(`/platform/users/${rootId}/deactivate`, { reason: 'test self' })).status, 403, 'not yourself');
  assert.equal((await root.post(`/platform/users/${rootId}/mfa-reset`, { reason: 'test self' })).status, 403, 'not your own 2FA');
  assert.equal((await new Client(h, '').get('/platform/users')).status, 401);

  // reset another admin's 2FA → signed out; must enrol again
  await must(root.post(`/platform/users/${twoId}/mfa-reset`, { reason: 'lost phone' })); assert.equal((await two.get('/platform/auth/me')).status, 401, 'signed out');
  const again = await must(new Client(h, '').post('/platform/auth/login', { email: 'two@platform.example', password: 'Second-Admin-Passphrase-2' })); assert.equal(again.enrolmentRequired, true); assert.ok(twoSecret);

  // deactivate → cannot sign in; last active Super Admin protected; activate restores
  await must(root.post(`/platform/users/${twoId}/deactivate`, { reason: 'left the company' }));
  assert.equal((await new Client(h, '').post('/platform/auth/login', { email: 'two@platform.example', password: 'Second-Admin-Passphrase-2' })).status, 403);
  assert.equal((await two.post(`/platform/users/${rootId}/deactivate`, { reason: 'x y z' })).status, 401, 'disabled admin has no session');
  await must(root.post(`/platform/users/${twoId}/activate`, { reason: 'came back' }));
  assert.equal((await new Client(h, '').post('/platform/auth/login', { email: 'two@platform.example', password: 'Second-Admin-Passphrase-2' })).status, 200);

  // change own password: wrong current refused; weak refused; other sessions signed out; new password works
  const other = await platformIn(h, ROOT.email, ROOT.password, rootSecret); // a second session for the same admin
  assert.equal((await root.post('/platform/auth/password', { currentPassword: 'wrong-wrong-wrong', newPassword: 'Brand-New-Passphrase-33' })).body.error.fieldErrors[0].path, 'currentPassword');
  assert.equal((await root.post('/platform/auth/password', { currentPassword: ROOT.password, newPassword: 'short' })).body.error.fieldErrors[0].path, 'newPassword');
  await must(root.post('/platform/auth/password', { currentPassword: ROOT.password, newPassword: 'Brand-New-Passphrase-33' }));
  assert.equal((await root.get('/platform/auth/me')).status, 200, 'current session kept');
  assert.equal((await other.p.get('/platform/auth/me')).status, 401, 'other sessions signed out');
  assert.equal((await new Client(h, '').post('/platform/auth/login', { email: ROOT.email, password: ROOT.password })).status, 401, 'old password no longer works');
  assert.equal((await new Client(h, '').post('/platform/auth/login', { email: ROOT.email, password: 'Brand-New-Passphrase-33' })).status, 200);

  // unlock after 5 failures
  for (let i = 0; i < 5; i++) await new Client(h, '').post('/platform/auth/login', { email: ROOT.email, password: 'Wrong-Password-000' });
  assert.equal((await new Client(h, '').post('/platform/auth/login', { email: ROOT.email, password: 'Brand-New-Passphrase-33' })).body.error.code, 'ACCOUNT_LOCKED');
  await must(root.post(`/platform/users/${rootId}/unlock`, { reason: 'self unlock after test' }));
  assert.equal((await new Client(h, '').post('/platform/auth/login', { email: ROOT.email, password: 'Brand-New-Passphrase-33' })).status, 200);
  assert.ok((await h.store.find('platform_audit_events', {})).some((e) => e.action === 'platform.user.mfa_reset'));
});
