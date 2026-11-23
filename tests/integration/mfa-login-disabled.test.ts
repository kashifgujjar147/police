// AUTH_MFA_LOGIN_DISABLED=true (temporary owner decision, 2026-11-23): password-only sign-in in any environment,
// while lockout and setup/invitation codes for new Platform accounts stay enforced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, mfaLoginSkipped } from '@sf/config';
import { Client, PASSWORD, makeApp, setupTenant } from '../helpers.ts';

const PLATFORM = { email: 'root@platform.example', password: 'Platform-Admin-Passphrase-1' };
const PROD = { NODE_ENV: 'production', MONGO_URL: 'mongodb://x', JWT_KEYS_JSON: '[{"kid":"k","privatePem":"p","publicPem":"q"}]', FIELD_ENC_KEY: Buffer.alloc(32).toString('base64'), JOB_HMAC_KEY: 'x'.repeat(32), FILE_URL_KEY: 'x'.repeat(32), CORS_ORIGINS: 'https://a.example', PUBLIC_URL: 'https://a.example' };

test('config: AUTH_MFA_LOGIN_DISABLED=true is accepted in production; ignored in test; off by default', () => {
  assert.equal(loadConfig({ ...PROD, AUTH_MFA_LOGIN_DISABLED: 'true' }).mfaLoginDisabled, true);
  assert.equal(loadConfig(PROD).mfaLoginDisabled, false);
  assert.equal(loadConfig({ NODE_ENV: 'test', STORE: 'memory', AUTH_MFA_LOGIN_DISABLED: 'true' }).mfaLoginDisabled, false);
  assert.equal(mfaLoginSkipped({ env: 'production', mfaDevBypass: false, mfaLoginDisabled: true }), true);
  assert.equal(mfaLoginSkipped({ env: 'production', mfaDevBypass: true, mfaLoginDisabled: false }), false);
});

test('production with AUTH_MFA_LOGIN_DISABLED: password-only sign-in; lockout and Platform sign-up codes still enforced', async () => {
  const h = await makeApp({ bootstrap: PLATFORM }); await setupTenant(h, 'acme');
  Object.assign(h.app.config, { env: 'production', mfaDevBypass: false, mfaLoginDisabled: true });

  const pl = await new Client(h, '').post('/platform/auth/login', PLATFORM);
  assert.equal(pl.status, 200); assert.ok(pl.body.accessToken, 'platform session issued without MFA'); assert.equal(pl.body.challengeToken, undefined);
  const ol = await new Client(h, 'acme').post('/auth/login', { tenant: 'acme', identifier: 'owner', password: PASSWORD, client: 'web' });
  assert.equal(ol.status, 200); assert.ok(ol.body.accessToken, 'owner session issued without MFA'); assert.equal(ol.body.challengeToken, undefined);

  const x = new Client(h, '');
  for (let i = 0; i < 5; i++) assert.equal((await x.post('/platform/auth/login', { ...PLATFORM, password: 'Wrong-Passphrase-000' })).status, 401);
  assert.equal((await x.post('/platform/auth/login', PLATFORM)).body.error?.code, 'ACCOUNT_LOCKED', 'platform lockout still applies');

  const reg = await new Client(h, '').post('/platform/auth/register', { email: 'intruder@evil.example', password: 'Some-Long-Passphrase-42' });
  assert.equal(reg.status, 403, 'creating a Platform account still needs a setup or invitation code');
  assert.deepEqual((await new Client(h, '').get('/platform/auth/signup-options')).body, { codeRequired: true, mfaRequired: true });
});
