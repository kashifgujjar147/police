// Deployment config: JWT keys may be given as raw JSON or base64 JSON (safe to paste into Railway Variables).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { loadConfig } from '@sf/config';

test('JWT_KEYS_JSON accepts raw JSON and base64-encoded JSON; garbage is refused', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = JSON.stringify([{ kid: 'k-1', privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }]);
  const base = { NODE_ENV: 'production', STORE: 'mongo', MONGO_URL: 'mongodb://x', FIELD_ENC_KEY: Buffer.alloc(32, 1).toString('base64'), JOB_HMAC_KEY: 'j'.repeat(40), FILE_URL_KEY: 'f'.repeat(40), CORS_ORIGINS: 'https://app.example', PUBLIC_URL: 'https://app.example' };
  assert.equal(loadConfig({ ...base, JWT_KEYS_JSON: keys }).activeKid, 'k-1');
  assert.equal(loadConfig({ ...base, JWT_KEYS_JSON: Buffer.from(keys).toString('base64') }).activeKid, 'k-1');
  assert.throws(() => loadConfig({ ...base, JWT_KEYS_JSON: 'not-json-not-base64!!' }), /JWT_KEYS_JSON is not valid JSON/);
});
