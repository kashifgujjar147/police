// End-to-end journeys J1–J10 (PRD §11) against the real application with an in-memory store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, PASSWORD, addStaff, iso, makeApp, must, planDuty, points, setupTenant, startBody, tick, uuid } from '../helpers.ts';
import type { Doc } from '@sf/kernel';

test('J1 Provision and onboard: tenant, owner activation with MFA, hierarchy, post, staff invitation', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme');
  assert.equal(t.owner.profile!.roles[0], 'owner');
  const region = await must(t.owner.post('/units', { parentId: t.rootUnitId, type: 'region', name: 'South Region', code: 'SOUTH' }));
  const station = await must(t.owner.post('/units', { parentId: region.id, type: 'station', name: 'Clifton Station', code: 'CLF' }));
  assert.deepEqual(station.ancestorIds, [t.rootUnitId, region.id]);
  await must(t.owner.post('/posts', { unitId: station.id, name: 'Main Gate' }));
  const f = await addStaff(t, 'field', { unitId: station.id });
  assert.equal(f.client.profile!.roles[0], 'field');
  const ob = await must(t.owner.get('/tenant/onboarding'));
  for (const k of ['hierarchy', 'posts', 'staff', 'invitations', 'devices', 'privacy_notice']) assert.equal(ob.steps.find((s: Doc) => s.key === k).done, true, k);
  const audit = await must(t.owner.get('/audit/events?limit=200'));
  for (const action of ['tenant.provision', 'auth.activate', 'auth.mfa.enabled', 'unit.create', 'post.create', 'staff.create', 'staff.invite', 'device.register']) assert.ok(audit.items.some((e: Doc) => e.action === action), `audited: ${action}`);
});

test('J2 Plan and publish: shift, assignment, publish → staff sees it, acknowledges; revision creates a new version with diff', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field'); const f2 = await addStaff(t, 'field');
  const d = await planDuty(t, f.staffId, { publish: false });
  assert.equal((await must(f.client.get('/me/duty'))).items.length, 0, 'draft assignments are not visible to staff');
  const stale = await t.owner.post('/rosters/publish', { unitId: t.rootUnitId, from: d.localDate, to: d.localDate, expectedVersion: 3 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT'); assert.equal(stale.body.error.details.currentVersion, 0);
  const v1 = await must(t.owner.post('/rosters/publish', { unitId: t.rootUnitId, from: d.localDate, to: d.localDate, expectedVersion: 0 }));
  assert.equal(v1.version, 1); assert.deepEqual(v1.diff.added, [d.assignmentId]);
  await tick(h);
  const mine = await must(f.client.get('/me/duty')); assert.equal(mine.items.length, 1); assert.equal(mine.items[0].ackAt, null);
  assert.ok((await must(f.client.get('/notifications'))).items.some((n: Doc) => n.template === 'roster_published'));
  const ack = await must(f.client.post(`/assignments/${d.assignmentId}/acknowledge`)); assert.ok(ack.ackAt);
  // second concurrent publish with the old expected version is rejected
  assert.equal((await t.owner.post('/rosters/publish', { unitId: t.rootUnitId, from: d.localDate, to: d.localDate, expectedVersion: 0 })).status, 409);
  // reassignment needs a reason, keeps history and notifies both people
  const a = await must(t.owner.get(`/assignments/${d.assignmentId}`));
  assert.equal((await t.owner.patch(`/assignments/${d.assignmentId}`, { version: a.version, staffMemberId: f2.staffId })).status, 400, 'reason is mandatory');
  await must(t.owner.patch(`/assignments/${d.assignmentId}`, { version: a.version, staffMemberId: f2.staffId, reason: 'sick leave cover' }));
  const v2 = await must(t.owner.post('/rosters/publish', { unitId: t.rootUnitId, from: d.localDate, to: d.localDate, expectedVersion: 1 }));
  assert.equal(v2.version, 2); assert.deepEqual(v2.diff.changed, [d.assignmentId]);
  const hist = (await must(t.owner.get(`/assignments/${d.assignmentId}`))).history.map((x: Doc) => x.change);
  assert.deepEqual(hist, ['created', 'reassigned']);
  assert.ok((await must(f2.client.get('/notifications'))).items.some((n: Doc) => n.template === 'assignment_changed'));
  const immutable = await must(t.owner.get(`/rosters/versions/${v1.id}`)); assert.equal(immutable.assignmentSnapshot[0].staffMemberId, f.staffId, 'version 1 snapshot is unchanged');
});

test('J3 Work a duty: start, track, checkpoint scan, break, end; tracking stops at duty end', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field');
  const post = await must(t.owner.post('/posts', { unitId: t.rootUnitId, name: 'Depot' }));
  const cp = await must(t.owner.post('/checkpoints', { postId: post.id, name: 'Back door', method: 'qr' }));
  const d = await planDuty(t, f.staffId, { postId: post.id, checkpointPlan: { mode: 'flexible', items: [{ checkpointId: cp.id }] } });
  // no tracking session yet → locations are rejected
  const early = await f.client.post('/locations/batch', { trackingSessionId: 'nope', sentAt: iso(h.clock.now()), points: points(h, 1) });
  assert.equal(early.status, 409); assert.equal(early.body.error.code, 'TRACKING_NOT_AUTHORIZED');
  h.clock.advanceMin(10);
  const start = await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h)));
  assert.equal(start.status, 'accepted'); assert.equal(start.trackingState, 'open');
  h.clock.advanceMin(5);
  const loc = await must(f.client.post('/locations/batch', { trackingSessionId: start.trackingSessionId, sentAt: iso(h.clock.now()), points: points(h, 10) }));
  assert.equal(loc.accepted, 10);
  const replay = await must(f.client.post('/locations/batch', { trackingSessionId: start.trackingSessionId, sentAt: iso(h.clock.now()), points: points(h, 10) }));
  assert.equal(replay.accepted, 0); assert.equal(replay.duplicates, 10, 'replayed batch stores nothing new');
  const scan = await must(f.client.post('/checkpoint-scans', { eventId: uuid(), tagId: cp.tagId, scannedAt: iso(h.clock.now()) }));
  assert.equal(scan.result, 'valid');
  assert.equal((await must(f.client.post('/checkpoint-scans', { eventId: uuid(), tagId: cp.tagId, scannedAt: iso(h.clock.now()) }))).result, 'duplicate');
  assert.equal((await must(f.client.post('/checkpoint-scans', { eventId: uuid(), tagId: 'not-a-real-tag', scannedAt: iso(h.clock.now()) }))).result, 'invalid_token');
  const bs = await must(f.client.post('/attendance/events', { ...startBody(h), assignmentId: d.assignmentId, type: 'break_start' })); assert.equal(bs.assignmentStatus, 'on_break');
  h.clock.advanceMin(15);
  await must(f.client.post('/attendance/events', { ...startBody(h), assignmentId: d.assignmentId, type: 'break_end' }));
  h.clock.advanceMin(60);
  const end = await must(f.client.post(`/assignments/${d.assignmentId}/end`, startBody(h))); assert.equal(end.trackingState, 'closed');
  h.clock.advanceMin(1);
  const after = await must(f.client.post('/locations/batch', { trackingSessionId: start.trackingSessionId, sentAt: iso(h.clock.now()), points: points(h, 1, { fromSeq: 500 }) }));
  assert.equal(after.accepted, 0); assert.equal(after.results[0].reason, 'AFTER_SESSION_CLOSED', 'no location is stored after duty end');
  const sum = await must(t.owner.get(`/assignments/${d.assignmentId}/summary`));
  assert.equal(sum.breaks.count, 1); assert.equal(sum.breaks.minutes, 15); assert.equal(sum.checkpointResults.completed, 1); assert.equal(sum.actual.startBasis, 'measured');
  assert.equal(await h.store.count('location_points', {}), 10);
});

test('J4 Offline duty: queued start/scan/end sync later in order; times preserved; replay is idempotent; invalid event rejected with a reason', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field');
  const post = await must(t.owner.post('/posts', { unitId: t.rootUnitId, name: 'Remote site' })); const cp = await must(t.owner.post('/checkpoints', { postId: post.id, name: 'Pump room', method: 'qr' }));
  const d = await planDuty(t, f.staffId, { postId: post.id, hours: 4, checkpointPlan: { mode: 'flexible', items: [{ checkpointId: cp.id }] } });
  const t0 = d.startsAt + 2 * 60000; // device was offline for the whole shift
  h.clock.set(d.endsAt + 3 * 3600000);
  const ids = [uuid(), uuid(), uuid(), uuid()];
  const batch = { sentAt: iso(h.clock.now()), events: [
    { eventId: ids[0], type: 'check_in', occurredAt: iso(t0), assignmentId: d.assignmentId },
    { eventId: ids[1], type: 'scan', occurredAt: iso(t0 + 30 * 60000), assignmentId: d.assignmentId, payload: { tagId: cp.tagId } },
    { eventId: ids[2], type: 'check_out', occurredAt: iso(d.endsAt - 60000), assignmentId: d.assignmentId },
    { eventId: ids[3], type: 'break_start', occurredAt: iso(d.endsAt), assignmentId: d.assignmentId }, // after check-out: invalid
  ] };
  await tick(h); // the evaluator has already marked the duty Missed; the offline start must still be accepted
  const r = await must(f.client.post('/sync/events', batch));
  assert.deepEqual(r.results.map((x: Doc) => x.status), ['accepted', 'accepted', 'accepted', 'rejected']);
  assert.equal(r.results[1].result, 'valid'); assert.equal(r.results[3].code, 'INVALID_STATE_TRANSITION'); assert.equal(r.results[3].action, 'request_correction');
  const ev = (await must(t.owner.get(`/attendance/events?assignmentId=${d.assignmentId}`))).items;
  const ci = ev.find((e: Doc) => e.type === 'check_in');
  assert.equal(ci.occurredAt, iso(t0), 'device time preserved'); assert.equal(ci.receivedAt, iso(h.clock.now()), 'server receipt time recorded separately'); assert.equal(ci.source, 'device_offline');
  const again = await must(f.client.post('/sync/events', batch));
  assert.deepEqual(again.results.map((x: Doc) => x.status), ['duplicate', 'duplicate', 'duplicate', 'rejected']);
  assert.equal(await h.store.count('attendance_events', {}), 2); assert.equal(await h.store.count('checkpoint_scans', {}), 1);
  const reuse = await must(f.client.post('/sync/events', { sentAt: iso(h.clock.now()), events: [{ eventId: ids[0], type: 'check_in', occurredAt: iso(t0 + 5000), assignmentId: d.assignmentId }] }));
  assert.equal(reuse.results[0].code, 'IDEMPOTENCY_KEY_REUSED');
  const gaps = (await must(t.owner.get('/sync/rejections'))).items;
  assert.ok(gaps.some((g: Doc) => g.eventId === ids[3] && g.code === 'INVALID_STATE_TRANSITION'), 'the rejected event is visible to supervisors as a gap');
});

test('J5 Supervise live: command centre shows states with freshness; stale data is never shown as live; realtime reaches only authorised scopes', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme');
  const north = await must(t.owner.post('/units', { parentId: t.rootUnitId, type: 'region', name: 'North' })); const south = await must(t.owner.post('/units', { parentId: t.rootUnitId, type: 'region', name: 'South' }));
  const supN = await addStaff(t, 'supervisor', { unitId: north.id }); const supS = await addStaff(t, 'supervisor', { unitId: south.id });
  const f = await addStaff(t, 'field', { unitId: north.id }); const d = await planDuty(t, f.staffId, { unitId: north.id });
  const got: Record<string, string[]> = { n: [], s: [], f: [] };
  const sub = (key: string, c: Client, units: string[] | '*', perms: string[]) => h.app.hub.subscribe({ tenantId: t.tenant._id, userId: c.profile!.userId, staffId: c.profile!.staffMemberId, units: units === '*' ? '*' : new Set(units), permissions: new Set(perms), send: (e) => got[key]!.push(e.type + (e.payload.lat !== undefined ? '+coords' : '')) });
  sub('n', supN.client, [north.id], supN.client.profile!.permissions); sub('s', supS.client, [south.id], supS.client.profile!.permissions); sub('f', f.client, [north.id], f.client.profile!.permissions);
  h.clock.advanceMin(10);
  const start = await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h)));
  await must(f.client.post('/locations/batch', { trackingSessionId: start.trackingSessionId, sentAt: iso(h.clock.now()), points: points(h, 3) }));
  await h.app.pump();
  assert.ok(got.n!.includes('duty:started') && got.n!.includes('location:updated+coords'), 'in-scope supervisor receives events with coordinates');
  assert.deepEqual(got.s, [], 'out-of-scope supervisor receives nothing');
  assert.ok(got.f!.includes('location:updated') && !got.f!.some((x) => x.includes('+coords')), 'coordinates are not sent to roles without location.live.read');
  // catch-up after a disconnect returns only authorised events, in order
  const cu = await must(supN.client.get('/realtime/catch-up?since=0')); assert.ok(cu.events.length >= 3); assert.deepEqual(cu.events.map((e: Doc) => e.seq), [...cu.events.map((e: Doc) => e.seq)].sort((a, b) => a - b));
  assert.equal((await must(supS.client.get('/realtime/catch-up?since=0'))).events.length, 0);
  let live = await must(supN.client.get('/locations/latest'));
  assert.equal(live.items.length, 1); assert.equal(live.items[0].freshness, 'live'); assert.equal(live.items[0].dutyDisplayState, 'on_duty'); assert.ok(live.asOf);
  assert.equal((await must(supS.client.get('/locations/latest'))).items.length, 0);
  h.clock.advanceMin(5);
  live = await must(supN.client.get('/locations/latest')); assert.equal(live.items[0].freshness, 'recent'); assert.equal(live.items[0].ageSec, 300);
  h.clock.advanceMin(11); await tick(h);
  live = await must(supN.client.get('/locations/latest'));
  assert.equal(live.items[0].freshness, 'stale'); assert.equal(live.items[0].dutyDisplayState, 'stale_offline', 'a stale position is never presented as on duty');
  const alerts = await must(supN.client.get('/alerts?state=active')); assert.ok(alerts.items.some((a: Doc) => a.type === 'stale_location'));
  assert.equal((await must(supS.client.get('/alerts?state=active'))).items.length, 0);
  assert.equal((await must(supN.client.get('/realtime/catch-up?since=0'))).reset, true, 'beyond the 15-minute window the client is told to reload from REST');
});

test('J6 Handle an exception: scheduled evaluator raises a late-start alert once, escalates on time, acknowledge stops escalation, auto-resolves', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const sup = await addStaff(t, 'supervisor'); const cmd = await addStaff(t, 'commander'); const f = await addStaff(t, 'field');
  const d = await planDuty(t, f.staffId, { startInMin: 5 });
  h.clock.advanceMin(5 + 16); await tick(h); await tick(h); await tick(h); // evaluator runs repeatedly
  let alerts = (await must(sup.client.get('/alerts?state=active'))).items.filter((a: Doc) => a.type === 'late_start');
  assert.equal(alerts.length, 1, 'no duplicate alert for the same condition'); assert.ok(alerts[0].count >= 2, 'occurrence count is updated instead');
  const supNotes = (await must(sup.client.get('/notifications'))).items.filter((n: Doc) => n.template === 'alert_created'); assert.equal(supNotes.length, 1);
  assert.equal((await must(cmd.client.get('/notifications'))).items.filter((n: Doc) => n.template === 'alert_escalated').length, 0);
  h.clock.advanceMin(15); await tick(h);
  assert.equal((await must(cmd.client.get('/notifications'))).items.filter((n: Doc) => n.template === 'alert_escalated').length, 1, 'escalated to Commander after 15 minutes');
  assert.equal((await sup.client.post(`/alerts/${alerts[0].id}/snooze`, { minutes: 10 })).status, 400, 'snooze needs a reason');
  await must(sup.client.post(`/alerts/${alerts[0].id}/acknowledge`, {}));
  const start = await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h)));
  assert.deepEqual(start.reasonCodes, []); // within the 60-minute late window
  const detail = await must(sup.client.get(`/alerts/${alerts[0].id}`));
  assert.equal(detail.state, 'auto_resolved'); assert.deepEqual(detail.timeline.map((x: Doc) => x.type), ['created', 'escalated', 'acknowledged', 'auto_resolved']);
});

test('J7 SOS: one critical incident, recipients notified, escalation until a person acknowledges, duplicates ignored, lifecycle enforced', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const disp = await addStaff(t, 'dispatcher'); const sup = await addStaff(t, 'supervisor'); const cmd = await addStaff(t, 'commander'); const f = await addStaff(t, 'field');
  const d = await planDuty(t, f.staffId); h.clock.advanceMin(10);
  const start = await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h)));
  await must(f.client.post('/locations/batch', { trackingSessionId: start.trackingSessionId, sentAt: iso(h.clock.now()), points: points(h, 2) }));
  h.clock.advanceMin(3);
  const body = { eventId: uuid(), occurredAt: iso(h.clock.now()), sentAt: iso(h.clock.now()) };
  const sos = await must(f.client.post('/sos', body));
  assert.equal(sos.status, 'accepted'); assert.equal(sos.deliveryState, 'notified'); assert.match(sos.number, /^INC-2026-000001$/);
  const dup = await must(f.client.post('/sos', body)); assert.equal(dup.status, 'duplicate'); assert.equal(dup.incidentId, sos.incidentId);
  assert.equal(await h.store.count('incidents', {}), 1, 'a duplicate submission never creates a second incident');
  await h.app.pump();
  const inc = await must(disp.client.get(`/incidents/${sos.incidentId}`));
  assert.equal(inc.severity, 'critical'); assert.equal(inc.reporter.displayName.startsWith('field'), true); assert.equal(inc.locationSource, 'last_known'); assert.equal(inc.locationAgeSec, 180, 'last-known location is shown with its age');
  assert.equal((await must(sup.client.get('/locations/latest'))).items[0].dutyDisplayState, 'sos');
  const count = async (c: Client, tpl: string) => (await must(c.get('/notifications?limit=200'))).items.filter((n: Doc) => n.template === tpl).length;
  assert.equal(await count(disp.client, 'sos_created'), 1); assert.equal(await count(sup.client, 'sos_escalated'), 0);
  h.clock.advanceSec(61); await h.app.pump(); assert.equal(await count(disp.client, 'sos_escalated'), 1, 're-notified after 60 s');
  h.clock.advanceSec(60); await h.app.pump(); assert.equal(await count(sup.client, 'sos_escalated'), 1, 'escalated to Supervisor at 120 s');
  assert.equal((await must(f.client.get(`/sos/${body.eventId}/status`))).deliveryState, 'notified', 'the device is never told "acknowledged" before a person acknowledges');
  assert.equal((await disp.client.post(`/incidents/${sos.incidentId}/transition`, { to: 'closed' })).body.error.code, 'INVALID_STATE_TRANSITION');
  await must(disp.client.post(`/incidents/${sos.incidentId}/transition`, { to: 'acknowledged' }));
  assert.equal((await must(f.client.get(`/sos/${body.eventId}/status`))).deliveryState, 'acknowledged_by_human');
  h.clock.advanceSec(400); await h.app.pump(); assert.equal(await count(cmd.client, 'sos_escalated'), 0, 'no escalation to Commander after acknowledgement');
  await must(disp.client.post(`/incidents/${sos.incidentId}/responders`, { staffMemberIds: [sup.staffId] }));
  await must(disp.client.post(`/incidents/${sos.incidentId}/transition`, { to: 'dispatched' }));
  assert.equal((await disp.client.post(`/incidents/${sos.incidentId}/transition`, { to: 'resolved' })).status, 400, 'resolution code required');
  await must(disp.client.post(`/incidents/${sos.incidentId}/transition`, { to: 'resolved', resolutionCode: 'assisted', reason: 'Officer safe' }));
  await must(disp.client.post(`/incidents/${sos.incidentId}/transition`, { to: 'closed' }));
  const tl = (await must(disp.client.get(`/incidents/${sos.incidentId}/timeline`))).items.map((x: Doc) => x.type);
  assert.deepEqual(tl, ['sos_received', 'recipients_notified', 'escalated', 'escalated', 'status:acknowledged', 'responders_assigned', 'status:dispatched', 'status:resolved', 'status:closed']);
  await must(f.client.post('/locations/batch', { trackingSessionId: start.trackingSessionId, sentAt: iso(h.clock.now()), points: points(h, 1, { fromSeq: 50 }) }));
  assert.equal((await must(sup.client.get('/locations/latest'))).items[0].dutyDisplayState, 'on_duty', 'SOS state clears when the incident is closed');
  const rep = await must(t.owner.get(`/reports/sos_response?from=${iso(h.clock.now() - 86400000)}&to=${iso(h.clock.now())}`));
  assert.equal(rep.rows.length, 1); assert.equal(rep.rows[0].secondsToAck, 121);
});

test('J8 Correct attendance: request → approve appends a correction event, original untouched; reviewer cannot approve own; summary recomputed', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const sup = await addStaff(t, 'supervisor'); const f = await addStaff(t, 'field');
  const d = await planDuty(t, f.staffId, { hours: 2 }); h.clock.advanceMin(40);
  await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h))); h.clock.advanceMin(80);
  await must(f.client.post(`/assignments/${d.assignmentId}/end`, startBody(h)));
  const c = await must(f.client.post('/corrections', { assignmentId: d.assignmentId, proposed: { type: 'check_in', occurredAt: iso(d.startsAt) }, reason: 'Phone was restarting at shift start' }));
  assert.equal((await f.client.post(`/corrections/${c.id}/review`, { decision: 'approve', note: 'self' })).status, 403);
  const before = await must(sup.client.get(`/assignments/${d.assignmentId}/summary`)); assert.equal(before.actual.startBasis, 'measured');
  const ret = await must(sup.client.post(`/corrections/${c.id}/review`, { decision: 'return', note: 'Please add detail' })); assert.equal(ret.state, 'returned');
  await must(f.client.post(`/corrections/${c.id}/resubmit`, { reason: 'Phone restarted at 08:00; supervisor saw me at the gate' }));
  await must(sup.client.post(`/corrections/${c.id}/review`, { decision: 'approve', note: 'Confirmed by gate log' }));
  assert.equal((await sup.client.post(`/corrections/${c.id}/review`, { decision: 'reject', note: 'again' })).status, 409);
  const ev = (await must(sup.client.get(`/attendance/events?assignmentId=${d.assignmentId}`))).items;
  const orig = ev.find((e: Doc) => e.type === 'check_in'), corr = ev.find((e: Doc) => e.type === 'correction');
  assert.equal(orig.occurredAt, iso(d.startsAt + 30 * 60000), 'the original event is preserved'); assert.equal(corr.refEventId, orig.eventId); assert.equal(corr.actor.type, 'reviewer');
  const after = await must(sup.client.get(`/assignments/${d.assignmentId}/summary`));
  assert.equal(after.actual.startedAt, iso(d.startsAt)); assert.equal(after.actual.startBasis, 'estimated', 'corrected values are labelled, not presented as measured');
  await must(sup.client.post(`/assignments/${d.assignmentId}/review`, { decision: 'approve', comment: 'Reviewed with correction' }));
  assert.equal((await must(sup.client.get(`/assignments/${d.assignmentId}`))).status, 'reviewed');
  await assert.rejects(h.store.updateOne('attendance_events', { eventId: orig.eventId }, { $set: { occurredAt: 1 } }), /append-only/);
});

test('J9 Review and report: report has as-of, timezone, basis labels; CSV export carries the same rows and neutralises formulas; download link is short-lived and audited', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field', { name: '=HYPERLINK("http://evil","x")' });
  const d = await planDuty(t, f.staffId, { hours: 1 }); h.clock.advanceMin(12);
  await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h))); h.clock.advanceMin(50); await must(f.client.post(`/assignments/${d.assignmentId}/end`, startBody(h)));
  const q = `from=${iso(h.clock.now() - 86400000)}&to=${iso(h.clock.now() + 86400000)}`;
  const rep = await must(t.owner.get(`/reports/attendance?${q}`));
  assert.equal(rep.timezone, 'Asia/Karachi'); assert.ok(rep.asOf); assert.equal(rep.rows.length, 1); assert.ok(rep.columns.every((c: Doc) => ['measured', 'estimated', 'unknown', 'system_flag'].includes(c.basis)));
  const job = await must(t.owner.post('/exports', { reportType: 'attendance', format: 'csv', filters: { from: iso(h.clock.now() - 86400000), to: iso(h.clock.now() + 86400000) } }));
  await h.app.pump();
  const ready = await must(t.owner.get(`/exports/${job.id}`)); assert.equal(ready.state, 'ready'); assert.equal(ready.rowCount, 1);
  const [path, qs] = ready.download.url.replace('/api/v1', '').split('?');
  const dl = await new Client(h, 'acme').get(`${path}?${qs}`); assert.equal(dl.status, 200);
  const csv = (dl as unknown as { raw: Buffer }).raw.toString('utf8');
  assert.match(csv, /Organisation timezone,Asia\/Karachi/); assert.match(csv, /Column basis/);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), 'cells starting with = are neutralised');
  h.clock.advanceMin(6); assert.equal((await new Client(h, 'acme').get(`${path}?${qs}`)).status, 404, 'the signed link expires after 5 minutes');
  assert.equal((await new Client(h, 'acme').get(`${path}?${qs.replace(/sig=../, 'sig=00')}`)).status, 404);
  const audit = (await must(t.owner.get('/audit/events?limit=200'))).items.map((e: Doc) => e.action);
  for (const a of ['report.view', 'export.create', 'export.generated', 'export.download_link']) assert.ok(audit.includes(a), a);
  assert.equal((await f.client.get(`/reports/attendance?${q}`)).status, 403);
});

test('J10 Offboard: sessions and devices revoked, future assignments flagged; tenant export and deletion with legal hold and certificate', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field');
  const d = await planDuty(t, f.staffId, { startInMin: 600 });
  const off = await must(t.owner.post(`/staff/${f.staffId}/offboard`, { reason: 'Contract ended' }));
  assert.equal(off.effects.sessionsRevoked, 1); assert.equal(off.effects.devicesRevoked, 1); assert.deepEqual(off.effects.assignmentsFlagged, [d.assignmentId]);
  assert.equal((await f.client.get('/me/duty')).status, 401, 'access ends immediately');
  assert.equal((await new Client(h, 'acme').login(f.code.toLowerCase(), PASSWORD)).status, 401);
  assert.equal((await must(t.owner.get('/assignments?needsReassignment=true'))).items.length, 1);
  // subject export then deletion
  const exp = await must(t.owner.post(`/staff/${f.staffId}/data-export`, { reason: 'Subject access request' })); assert.equal(exp.completion.kind, 'subject_export');
  const hold = await must(t.owner.post('/tenant/legal-holds', { scope: { kind: 'staff', id: f.staffId }, reason: 'Pending investigation' }));
  assert.equal((await t.owner.post(`/staff/${f.staffId}/data-deletion`, { reason: 'Erasure request' })).body.error.code, 'LEGAL_HOLD');
  await must(t.owner.post(`/tenant/legal-holds/${hold.id}/release`, { reason: 'Investigation closed' }));
  const del = await must(t.owner.post(`/staff/${f.staffId}/data-deletion`, { reason: 'Erasure request' })); assert.equal(del.completion.deleted.account, true);
  assert.equal((await must(t.owner.get(`/staff/${f.staffId}`))).displayName, 'Deleted staff member');
  // tenant export
  const job = await must(t.owner.post('/tenant/exports')); await h.app.pump();
  const ready = await must(t.owner.get(`/exports/${job.id}`)); assert.equal(ready.state, 'ready');
  const [p, qs] = ready.download.url.replace('/api/v1', '').split('?'); const tar = ((await new Client(h, 'acme').get(`${p}?${qs}`)) as unknown as { raw: Buffer }).raw;
  const text = tar.toString('latin1'); assert.ok(text.includes('manifest.json') && text.includes('data/staff_members.jsonl') && !text.includes('passwordHash') && !text.includes('data/sessions.jsonl'));
  // tenant deletion: dry run, legal hold blocks, grace period, certificate
  const dry = await must(t.owner.post('/tenant/deletion-requests', { confirmSlug: 'acme', reason: 'Leaving', dryRun: true })); assert.ok(dry.wouldDelete.staff_members >= 2);
  const th = await must(t.owner.post('/tenant/legal-holds', { scope: { kind: 'tenant' }, reason: 'Litigation hold' }));
  assert.equal((await t.owner.post('/tenant/deletion-requests', { confirmSlug: 'acme', reason: 'Leaving' })).body.error.code, 'LEGAL_HOLD');
  await must(t.owner.post(`/tenant/legal-holds/${th.id}/release`, { reason: 'Released by counsel' }));
  assert.equal((await t.owner.post('/tenant/deletion-requests', { confirmSlug: 'wrong', reason: 'Leaving' })).status, 400);
  await must(t.owner.post('/tenant/deletion-requests', { confirmSlug: 'acme', reason: 'Leaving' }));
  assert.equal((await t.owner.get('/staff')).body.error.code, 'TENANT_NOT_ACTIVE'); assert.equal((await t.owner.get('/tenant/deletion-requests')).status, 200, 'Owner can still see and cancel');
  h.clock.advance(29 * 86400000); await h.app.runSchedulers(true); assert.equal((await h.store.findOne('tenants', { _id: t.tenant._id }))!.status, 'pending_deletion');
  h.clock.advance(2 * 86400000); await h.app.runSchedulers(true);
  const gone = (await h.store.findOne('tenants', { _id: t.tenant._id }))!;
  assert.equal(gone.status, 'deleted'); assert.ok(gone.deletionCertificate.sha256); assert.ok(gone.deletionCertificate.total > 10);
  for (const c of ['staff_members', 'users', 'audit_events', 'duty_assignments', 'sessions']) assert.equal(await h.store.count(c, { tenantId: t.tenant._id }), 0, c);
  assert.equal((await new Client(h, 'acme').login('owner', PASSWORD)).status, 401);
});
