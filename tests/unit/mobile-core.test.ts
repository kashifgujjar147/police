// Mobile sync engine against the real API in-process, with the network switched off and on (FR-SYN, FR-SOS, TS §14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api, Duty, MemoryKV, Outbox, Sampler, SosController, SyncEngine, ed25519RawToPem } from '@sf/mobile-core';
import { appTransport, nodeEnv, nodeSigner } from '../../packages/mobile-core/src/node.ts';
import { createPublicKey } from 'node:crypto';
import { PASSWORD, addStaff, makeApp, must, planDuty, setupTenant, tick } from '../helpers.ts';

async function device(h: Awaited<ReturnType<typeof makeApp>>, slug: string, code: string, kv = new MemoryKV()) {
  const net = appTransport(h.app); const env = { ...nodeEnv(() => h.clock.now()), random: () => 1 }; const signer = nodeSigner();
  const api = new Api(net, kv, signer, env); const box = await new Outbox(kv, 50).load(); const sync = new SyncEngine(api, box, env); const duty = new Duty(box, sync, env);
  assert.deepEqual(await api.login(slug, code, PASSWORD), { ok: true }); await api.registerDevice({ platform: 'android', osVersion: '14' });
  const n = await api.call('GET', '/privacy/notices/current'); await api.call('POST', '/privacy/acknowledgements', { version: n.notice.version });
  return { api, box, sync, duty, net, env, kv, signer };
}
const offline = (d: { net: { link: { up: boolean } }; sync: SyncEngine }, down: boolean) => { d.net.link.up = !down; d.sync.online = !down; };

test('FR-SYN-001..004 offline duty: actions queue durably, survive an app restart, sync in order, tracking points flow, nothing is lost or duplicated', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field', { device: false });
  const post = await must(t.owner.post('/posts', { unitId: t.rootUnitId, name: 'Remote' })); const cp = await must(t.owner.post('/checkpoints', { postId: post.id, name: 'Pump', method: 'qr' }));
  const d0 = await planDuty(t, f.staffId, { postId: post.id, checkpointPlan: { mode: 'flexible', items: [{ checkpointId: cp.id }] } });
  const kv = new MemoryKV(); let d = await device(h, 'acme', f.code, kv);
  h.clock.advanceMin(10); offline(d, true);
  const s1 = await d.duty.start(d0.assignmentId, { lat: 24.86, lon: 67.0, accuracyM: 10 }); assert.equal(s1.queued, true);
  assert.equal(await d.box.addPoint({ recordedAt: new Date(h.clock.now()).toISOString(), lat: 1, lon: 1, accuracyM: 5 }), false, 'no tracking session yet → no point recorded');
  h.clock.advanceMin(20); await d.duty.scan(`sf360:cp:${cp.tagId}`, d0.assignmentId);
  assert.throws(() => d.duty.scan('https://evil.example/x'), /not a SmartForce 360 checkpoint/);
  // force-close the app: a new process loads the same storage
  const box2 = await new Outbox(kv, 50).load(); assert.equal(box2.pending().length, 2, 'queued events survive a restart');
  d = { ...d, box: box2, sync: new SyncEngine(d.api, box2, d.env) }; d.duty = new Duty(box2, d.sync, d.env);
  offline(d, false); const r = await d.sync.sync(); assert.deepEqual([r.accepted, r.rejected], [2, 0]);
  assert.ok(box2.tracking, 'tracking session opened by the synced duty start');
  const ev = (await must(t.owner.get(`/attendance/events?assignmentId=${d0.assignmentId}`))).items[0]; assert.equal(ev.source, 'device_offline'); assert.equal(Date.parse(ev.occurredAt), Date.parse(ev.receivedAt) - 20 * 60000, 'original device time is preserved');
  // points while offline, thinned only at the cap, first/last kept
  offline(d, true);
  for (let i = 0; i < 80; i++) { h.clock.advanceSec(30); await box2.addPoint({ recordedAt: new Date(h.clock.now()).toISOString(), lat: 24.86 + i * 1e-5, lon: 67, accuracyM: 9 }); }
  assert.ok(box2.points.length <= 50 && box2.droppedPoints > 0); const st = box2.status(h.clock.now()); assert.ok(st.oldestPendingAgeSec > 0 && st.pendingPoints === box2.points.length);
  const queuedPts = box2.points.length; offline(d, false); const r2 = await d.sync.sync(); assert.equal(r2.pointsSent, queuedPts); assert.equal(box2.points.length, 0);
  assert.equal(await h.store.count('location_points', {}), r2.pointsSent);
  // replay after a lost response: same ids → duplicates, no new rows
  const end = await d.duty.end(d0.assignmentId); assert.equal(end.queued, false); assert.equal(box2.tracking, null);
  const before = await h.store.count('attendance_events', {}); await d.box.addEvent({ eventId: ev.eventId, type: 'check_in', occurredAt: ev.occurredAt, assignmentId: d0.assignmentId, payload: { location: { lat: 24.86, lon: 67.0, accuracyM: 10 } } });
  const again = await d.sync.sync(); assert.equal(again.duplicates, 1); assert.equal(await h.store.count('attendance_events', {}), before);
  // a rejected event stays visible with its reason until the user acknowledges it
  const bad = await d.duty.breakStart(d0.assignmentId); assert.equal(bad.rejected!.code, 'INVALID_STATE_TRANSITION'); assert.equal(bad.rejected!.action, 'request_correction');
  assert.equal(box2.rejected().length, 1); await box2.acknowledgeRejection(bad.eventId); assert.equal(box2.rejected().length, 0);
});

test('FR-SOS-001..004 SOS from the device: hold to trigger, honest offline state, fallback instructions, sends first on reconnect, acknowledged only by a person', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const disp = await addStaff(t, 'dispatcher'); const f = await addStaff(t, 'field', { device: false });
  const d = await device(h, 'acme', f.code);
  const timers: (() => void)[] = []; const sos = new SosController(d.api, d.box, d.sync, d.env, 2, { set: (fn) => timers.push(fn), clear: () => timers.pop() });
  sos.pressStart(); assert.equal(sos.state, 'holding'); sos.pressCancel(); assert.equal(sos.state, 'idle', 'releasing early does not send');
  offline(d, true); await d.duty.incident('hazard', 'queued before the SOS');
  sos.pressStart(); timers.shift()!(); await new Promise((r) => setTimeout(r, 10));
  assert.equal(sos.state, 'pending_offline', 'offline SOS is never shown as delivered'); assert.equal(sos.showFallback, false);
  h.clock.advanceSec(91); await sos.refresh(); assert.equal(sos.showFallback, true, 'fallback instructions after 90 s without confirmation');
  offline(d, false); await d.sync.sync(); await sos.refresh();
  assert.equal(sos.state, 'notified'); assert.match(sos.number!, /^INC-/);
  const incs = (await must(disp.client.get('/incidents?limit=10'))).items; assert.equal(incs.find((i: any) => i.kind === 'sos').number, 'INC-2026-000001', 'the SOS was sent before the incident that was queued earlier');
  const id = incs.find((i: any) => i.kind === 'sos').id; const detail = await must(disp.client.get(`/incidents/${id}`)); assert.equal(detail.sos.queuedOffline, false);
  await sos.requestCancel('pressed by mistake'); assert.equal((await must(disp.client.get(`/incidents/${id}`))).status, 'new', 'a cancellation request does not close the SOS');
  await must(disp.client.post(`/incidents/${id}/transition`, { to: 'acknowledged' })); await sos.refresh(); assert.equal(sos.state, 'acknowledged_by_human');
  sos.reset(); assert.equal(sos.state, 'idle');
});

test('TS §14 device bits: sampler honours moving/stationary intervals and break pause; raw Ed25519 keys convert to PEM the server accepts; sessions persist', async () => {
  const s = new Sampler({ movingSec: 30, stationarySec: 120, minAccuracyM: 100, distanceFilterM: 10 });
  assert.ok(s.accept({ at: 0, lat: 24, lon: 67, accuracyM: 5 })); assert.ok(!s.accept({ at: 60000, lat: 24, lon: 67, accuracyM: 5 }), 'stationary: wait 120 s');
  assert.ok(s.accept({ at: 121000, lat: 24, lon: 67, accuracyM: 5 })); assert.ok(s.accept({ at: 152000, lat: 24.001, lon: 67, accuracyM: 5 }), 'moving: 30 s');
  s.profile.paused = true; assert.ok(!s.accept({ at: 999999, lat: 25, lon: 67, accuracyM: 5 }), 'paused on break');
  const raw = new Uint8Array(32).map((_, i) => i * 7); const k = createPublicKey(ed25519RawToPem(raw)); assert.equal(k.asymmetricKeyType, 'ed25519');
  assert.deepEqual([...(k.export({ format: 'der', type: 'spki' }) as Buffer).subarray(12)], [...raw]);
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field', { device: false }); const kv = new MemoryKV(); const d = await device(h, 'acme', f.code, kv);
  const api2 = new Api(appTransport(h.app), kv, d.signer, d.env); await api2.load(); assert.equal(api2.session!.deviceId, d.api.session!.deviceId);
  h.clock.advanceMin(20); assert.ok((await api2.call('GET', '/me/duty')).syncedAt, 'expired access token is refreshed transparently');
  await tick(h); await api2.logout(); assert.equal(api2.session, null);
});
