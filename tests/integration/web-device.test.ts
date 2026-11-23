// Field duty from the web app / PWA: a 'web' device with an Ed25519 key (as WebCrypto makes) signs duty requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { deviceSigningString } from '@sf/kernel';
import { addStaff, iso, makeApp, must, planDuty, points, setupTenant, startBody, uuid } from '../helpers.ts';

test('web device: registers as platform "web", re-binding the same key never creates a second device, signed duty works, unsigned/forged is refused', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field', { device: false });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const reg = await must(f.client.post('/devices/register', { publicKey: pem, platform: 'web', osVersion: 'Android 14', model: 'Web app', appVersion: '1.0.0' }));
  assert.equal(reg.platform, 'web'); assert.equal(reg.status, 'active', 'first device is active');
  const again = await must(f.client.post('/devices/register', { publicKey: pem, platform: 'web', osVersion: 'Android 14', model: 'Web app', appVersion: '1.0.0' }));
  assert.equal(again.id, reg.id, 're-binding after a new sign-in reuses the device'); assert.equal(await h.store.count('devices', { staffMemberId: f.staffId }), 1);
  assert.equal((await f.client.post('/devices/register', { publicKey: pem, platform: 'windows', osVersion: 'x', appVersion: '1.0.0' })).status, 400, 'unknown platform refused');

  const n = await must(f.client.get('/privacy/notices/current')); await must(f.client.post('/privacy/acknowledgements', { version: n.notice.version }));
  const d = await planDuty(t, f.staffId, { startInMin: 1 }); h.clock.advance(2 * 60000);
  const signed = (path: string, body: unknown, key = privateKey) => { const raw = JSON.stringify(body); const ts = iso(h.clock.now()); return f.client.post(path, body, { 'x-device-timestamp': ts, 'x-device-signature': sign(null, Buffer.from(deviceSigningString('POST', `/api/v1${path}`, raw, ts)), key).toString('base64'), 'x-app-version': '1.0.0' }); };

  assert.equal((await f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h))).status, 401, 'unsigned duty action refused');
  const forged = generateKeyPairSync('ed25519').privateKey; assert.equal((await signed(`/assignments/${d.assignmentId}/start`, startBody(h), forged)).status, 401, 'signature from another key refused');
  const start = await must(signed(`/assignments/${d.assignmentId}/start`, startBody(h, { lat: 24.8607, lon: 67.0011, accuracyM: 12 })));
  assert.ok(start.trackingSessionId);
  h.clock.advance(90000); // points recorded after duty start (earlier ones are correctly refused)
  const batch = await must(signed('/locations/batch', { trackingSessionId: start.trackingSessionId, sentAt: iso(h.clock.now()), points: points(h, 3) })); assert.equal(batch.accepted, 3);
  await must(signed('/attendance/events', { ...startBody(h), assignmentId: d.assignmentId, type: 'break_start' }));
  await must(signed('/attendance/events', { ...startBody(h), assignmentId: d.assignmentId, type: 'break_end' }));
  const sos = await signed('/sos', { eventId: uuid(), occurredAt: iso(h.clock.now()), location: { lat: 24.86, lon: 67.0, accuracyM: 10 }, assignmentId: d.assignmentId }); assert.equal(sos.status, 200, JSON.stringify(sos.body));
  const end = await must(signed(`/assignments/${d.assignmentId}/end`, startBody(h))); assert.equal(end.trackingState, 'closed');
  const dev = (await must(t.owner.get('/devices?limit=50'))).items.find((x: any) => x.id === reg.id); assert.equal(dev.platform, 'web', 'admins see it as a web device');
});
