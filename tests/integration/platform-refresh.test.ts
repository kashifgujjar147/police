// Platform web session survives a page reload: HttpOnly refresh cookie + CSRF header, rotated on use,
// ended by logout, deactivation/2FA reset and the 12 h absolute expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp } from '@sf/domain/node';
import { Client, makeApp, must } from '../helpers.ts';

const PLATFORM = { email: 'root@platform.example', password: 'Platform-Admin-Passphrase-1' };
type H = Awaited<ReturnType<typeof makeApp>>;
async function signIn(h: H, who = PLATFORM, secret?: string) {
  const p = new Client(h, ''); const l = await must(p.post('/platform/auth/login', who));
  let s = secret; if (!s) s = (await must(p.post('/platform/auth/mfa/enroll', { challengeToken: l.challengeToken }))).secret as string;
  h.clock.advanceSec(31); const ok = await must(p.post('/platform/auth/mfa/verify', { challengeToken: l.challengeToken, code: totp(s, h.clock.now()) }));
  p.token = ok.accessToken; return { p, secret: s };
}
/** A page reload: the in-memory access token is gone, the browser still sends its cookies. */
const reload = (p: Client) => { p.token = null; return p.post('/platform/auth/refresh', {}, { 'x-csrf-token': p.cookies.sf_pcsrf ?? '' }); };

test('platform session: restored after reload via refresh cookie; CSRF and rotation enforced; logout, revocation and expiry end it', async () => {
  const h = await makeApp({ bootstrap: PLATFORM }); const { p, secret } = await signIn(h);
  assert.ok(p.cookies.sf_prefresh && p.cookies.sf_pcsrf, 'refresh + csrf cookies set at sign-in');

  const old = p.cookies.sf_prefresh;
  const r = await reload(p); assert.equal(r.status, 200); assert.ok(r.body.accessToken); assert.deepEqual(r.body.user.platformRoles, ['super_admin']);
  assert.notEqual(p.cookies.sf_prefresh, old, 'cookie rotated');
  p.token = r.body.accessToken; assert.equal((await p.get('/platform/tenants')).status, 200, 'restored session works');

  // the previous cookie no longer works; CSRF header is required
  const stale = new Client(h, ''); stale.cookies = { sf_prefresh: old!, sf_pcsrf: p.cookies.sf_pcsrf! };
  assert.equal((await stale.post('/platform/auth/refresh', {}, { 'x-csrf-token': p.cookies.sf_pcsrf! })).status, 401);
  assert.equal((await p.post('/platform/auth/refresh', {}, { 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await new Client(h, '').post('/platform/auth/refresh', {})).status, 401, 'no cookie, no session');

  // logout clears the cookie and ends the session
  p.token = (await reload(p)).body.accessToken; const kept = { ...p.cookies };
  await must(p.post('/platform/auth/logout')); assert.equal(p.cookies.sf_prefresh, undefined, 'cookie cleared');
  const after = new Client(h, ''); after.cookies = kept; assert.equal((await after.post('/platform/auth/refresh', {}, { 'x-csrf-token': kept.sf_pcsrf! })).status, 401, 'revoked session cannot be restored');

  // 12 h absolute expiry
  const { p: p2 } = await signIn(h, PLATFORM, secret);
  h.clock.advanceSec(11 * 3600); assert.equal((await reload(p2)).status, 200, 'still valid within 12 h');
  h.clock.advanceSec(3600 + 1); assert.equal((await reload(p2)).status, 401, 'expired after 12 h');
});

test('platform session: another Super Admin deactivating the account ends a restorable session', async () => {
  const h = await makeApp({ bootstrap: PLATFORM }); const { p: root } = await signIn(h);
  const inv = await must(root.post('/platform/invitations', { email: 'second@platform.example' }));
  const second = { email: 'second@platform.example', password: 'Second-Admin-Passphrase-2' };
  assert.equal((await new Client(h, '').post('/platform/auth/register', { code: inv.code, ...second })).status, 201);
  const { p } = await signIn(h, second);
  const id = (await must(root.get('/platform/users'))).items.find((u: any) => u.email === second.email).id;
  await must(root.post(`/platform/users/${id}/deactivate`, { reason: 'left the company' }));
  assert.equal((await reload(p)).status, 401);
});
