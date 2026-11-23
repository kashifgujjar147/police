// Functional rules across modules: scope, planning, attendance policy, privacy gates, field verification, platform operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkpointToken } from '@sf/domain/node';
import { type Doc, MemoryStore } from '@sf/kernel';
import { createApp } from '@sf/app';
import { Client, PASSWORD, addStaff, iso, makeApp, must, planDuty, points, setupTenant, startBody, tick, uuid } from '../helpers.ts';
import { provisionTenant } from '../../modules/tenancy/provision.ts';
import { sniffMime, stripMetadata } from '../../modules/records/index.ts';

const setSettings = async (c: Client, settings: unknown) => { const cur = await must(c.get('/tenant/settings')); return must(c.put('/tenant/settings', { version: cur.version, settings })); };
const HQ = { lat: 24.8607, lon: 67.0011 }; const north = (m: number) => ({ lat: HQ.lat + m / 111195, lon: HQ.lon });

test('FR-RBAC-002/003 hierarchy scope: scoped roles see only their subtree, out-of-scope ids read as missing, role and scope changes apply on the next request', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme');
  const n = await must(t.owner.post('/units', { parentId: t.rootUnitId, type: 'region', name: 'North', code: 'N' })); const n1 = await must(t.owner.post('/units', { parentId: n.id, type: 'station', name: 'N-1', code: 'N1' })); const s = await must(t.owner.post('/units', { parentId: t.rootUnitId, type: 'region', name: 'South', code: 'S' }));
  const cmdN = await addStaff(t, 'commander', { unitId: n.id }); const fN = await addStaff(t, 'field', { unitId: n1.id }); const fS = await addStaff(t, 'field', { unitId: s.id });
  const list = await must(cmdN.client.get('/staff')); const ids = list.items.map((x: Doc) => x.id);
  assert.ok(ids.includes(fN.staffId) && !ids.includes(fS.staffId), 'scope includes descendants of the assigned unit only');
  assert.equal((await cmdN.client.get(`/staff/${fS.staffId}`)).status, 404, 'out-of-scope resource is reported as missing, not forbidden');
  assert.deepEqual((await must(cmdN.client.get('/units'))).items.map((u: Doc) => u.name).sort(), ['N-1', 'North']);
  assert.equal((await cmdN.client.post('/staff', { employeeCode: 'X9', displayName: 'x', homeUnitId: s.id })).status, 404, 'cannot create staff outside scope');
  assert.equal((await cmdN.client.post('/staff', { employeeCode: 'X8', displayName: 'x', homeUnitId: n.id, roleIds: [t.roleIds.admin] })).status, 403, 'cannot grant a role above own');
  assert.equal((await cmdN.client.post('/staff', { employeeCode: 'X7', displayName: 'x', homeUnitId: n.id, roleIds: [t.roleIds.supervisor], scopeUnitIds: ['*'] })).status, 403, 'cannot grant whole-organisation scope');
  // masking: supervisor (read-only) does not see contact details; commander (manager) does
  const supN = await addStaff(t, 'supervisor', { unitId: n.id }); const masked = await must(supN.client.get(`/staff/${fN.staffId}`)); assert.equal(masked.contact, null); assert.equal(masked.contactMasked, true);
  assert.equal((await must(cmdN.client.get(`/staff/${fN.staffId}`))).contact.phone, '+92 300 0000000');
  // scope change takes effect immediately
  const prof = await must(t.owner.get(`/staff/${cmdN.staffId}`));
  await must(t.owner.patch(`/memberships/${prof.membershipId}`, { version: prof.membershipVersion, scopeUnitIds: [s.id], reason: 'moved to South' }));
  const after = (await must(cmdN.client.get('/staff'))).items.map((x: Doc) => x.id); assert.ok(after.includes(fS.staffId) && !after.includes(fN.staffId));
  // role removal takes effect immediately
  const m2 = await must(t.owner.get(`/memberships/${prof.membershipId}`)); await must(t.owner.patch(`/memberships/${prof.membershipId}`, { version: m2.version, roleIds: [t.roleIds.auditor], reason: 'role change' }));
  assert.equal((await cmdN.client.post('/staff', { employeeCode: 'X6', displayName: 'x', homeUnitId: s.id })).status, 403);
  assert.equal((await t.owner.patch(`/memberships/${t.owner.profile!.userId}`, { version: 1, roleIds: [t.roleIds.admin], reason: 'test' })).status, 404);
  // default roles are fixed; custom roles cannot exceed the creator
  const roles = (await must(t.owner.get('/roles'))).items; assert.equal(roles.filter((r: Doc) => r.isDefault).length, 7);
  assert.equal((await t.owner.patch(`/roles/${t.roleIds.supervisor}`, { version: 1, permissionKeys: [] })).status, 403);
  const adm = await addStaff(t, 'admin'); assert.equal((await adm.client.post('/roles', { name: 'Sneaky', permissionKeys: ['tenant.delete'] })).status, 403, 'no privilege escalation through custom roles');
  assert.equal((await adm.client.post('/roles', { name: 'Bad', permissionKeys: ['made.up'] })).status, 400);
});

test('FR-ORG-001 hierarchy: move recomputes descendant paths atomically, cycles are rejected, merge keeps posts and staff', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const mk = (parentId: string, name: string) => must(t.owner.post('/units', { parentId, type: 'unit', name }));
  const a = await mk(t.rootUnitId, 'A'), b = await mk(t.rootUnitId, 'B'), a1 = await mk(a.id, 'A1'), a11 = await mk(a1.id, 'A11');
  assert.equal((await t.owner.post(`/units/${a.id}/move`, { newParentId: a11.id, reason: 'cycle' })).status, 400, 'cannot move a unit under its own descendant');
  assert.equal((await t.owner.post(`/units/${a.id}/move`, { newParentId: a.id, reason: 'self' })).status, 400);
  await must(t.owner.post(`/units/${a1.id}/move`, { newParentId: b.id, reason: 'restructure' }));
  const moved = await must(t.owner.get(`/units/${a11.id}`)); assert.deepEqual(moved.ancestorIds, [t.rootUnitId, b.id, a1.id]); assert.equal(moved.depth, 3);
  const post = await must(t.owner.post('/posts', { unitId: a.id, name: 'P' })); const f = await addStaff(t, 'field', { unitId: a.id });
  await must(t.owner.post(`/units/${a.id}/merge`, { intoUnitId: b.id, reason: 'merge regions' }));
  assert.equal((await must(t.owner.get(`/posts/${post.id}`))).unitId, b.id); assert.equal((await must(t.owner.get(`/staff/${f.staffId}`))).homeUnitId, b.id); assert.equal((await must(t.owner.get(`/units/${a.id}`))).status, 'archived');
  let parent = t.rootUnitId; let last = 201; for (let i = 0; i < 10 && last === 201; i++) { const r = await t.owner.post('/units', { parentId: parent, type: 'l', name: `L${i}` }); last = r.status; if (last === 201) parent = r.body.id; }
  assert.equal(last, 400, 'depth is limited to 10 levels');
});

test('FR-ORG-003 staff import: dry-run changes nothing, per-row report, re-running the same file creates no duplicates', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); await must(t.owner.post('/units', { parentId: t.rootUnitId, type: 'station', name: 'Station 1', code: 'ST1' }));
  const csv = 'employeeCode,displayName,rankTitle,unitCode,email\nA100,Ayesha Khan,Guard,ST1,ayesha@example.com\nA101,"Bilal, Ahmed",Guard,ST1,\nA102,,Guard,ST1,\nA103,Dana,Guard,NOPE,\nA100,Dup,Guard,ST1,\nA104,Erum,Guard,ST1,not-an-email\n';
  const before = await h.store.count('staff_members', {});
  const dry = await must(t.owner.post('/staff/import/dry-run', { csv })); assert.deepEqual(dry.summary, { rows: 6, valid: 2, created: 0, skipped: 0, errors: 4 }); assert.equal(await h.store.count('staff_members', {}), before, 'dry-run writes nothing');
  assert.deepEqual(dry.report.filter((r: Doc) => r.status === 'error').map((r: Doc) => r.row), [4, 5, 6, 7]); assert.match(dry.errorReportCsv, /unitCode ""NOPE"" was not found|unitCode "NOPE"/);
  const run = await must(t.owner.post('/staff/import', { csv })); assert.equal(run.summary.created, 2); assert.equal(run.rerun, false);
  const again = await must(t.owner.post('/staff/import', { csv })); assert.equal(again.summary.created, 0); assert.equal(again.summary.skipped, 2); assert.equal(again.rerun, true);
  assert.equal(await h.store.count('staff_members', {}), before + 2);
  const mapped = await must(t.owner.post('/staff/import/dry-run', { csv: 'ID,Name,Unit\nB1,Zed,ST1\n', mapping: { employeeCode: 'ID', displayName: 'Name', unitCode: 'Unit' } })); assert.equal(mapped.summary.valid, 1);
  assert.equal((await t.owner.post('/staff/import/dry-run', { csv: 'foo,bar\n1,2\n' })).status, 400);
});

test('FR-DUTY-001/002 planning: overnight DST-safe occurrences through the API; overlap policy Block / Warn / Allow', async () => {
  const h = await makeApp({}, '2026-03-05T10:00:00Z'); const t = await setupTenant(h, 'acme', { timezone: 'America/New_York' }); const f = await addStaff(t, 'field');
  const post = await must(t.owner.post('/posts', { unitId: t.rootUnitId, name: 'Night post' }));
  const night = await must(t.owner.post('/shifts', { name: 'Night', postId: post.id, startDate: '2026-03-06', startsAtLocal: '22:00', endsAtLocal: '06:00', recurrenceRule: 'FREQ=DAILY' }));
  const occ = (await must(t.owner.get(`/shifts/${night.id}/occurrences?from=2026-03-06&to=2026-03-09`))).items;
  assert.equal(occ[0].startsAt, '2026-03-07T03:00:00.000Z'); assert.equal(occ[1].endsAt, '2026-03-08T10:00:00.000Z', 'spring-forward night ends at 06:00 local (EDT)'); assert.equal(occ[2].startsAt, '2026-03-09T02:00:00.000Z');
  assert.equal((await t.owner.post('/shifts', { name: 'Bad', postId: post.id, startDate: '2026-03-06', startsAtLocal: '08:00', endsAtLocal: '16:00', recurrenceRule: 'FREQ=YEARLY' })).status, 400);
  const day = await must(t.owner.post('/shifts', { name: 'Late', postId: post.id, startDate: '2026-03-06', startsAtLocal: '23:00', endsAtLocal: '03:00' }));
  await must(t.owner.post('/assignments', { shiftId: night.id, localDate: '2026-03-06', staffMemberId: f.staffId }));
  const blocked = await t.owner.post('/assignments', { shiftId: day.id, localDate: '2026-03-06', staffMemberId: f.staffId }); assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'OVERLAP_CONFLICT'); assert.equal(blocked.body.error.details.policy, 'block');
  await setSettings(t.owner, { duty: { overlapPolicy: 'warn' } });
  const warn = await t.owner.post('/assignments', { shiftId: day.id, localDate: '2026-03-06', staffMemberId: f.staffId }); assert.equal(warn.status, 409); assert.equal(warn.body.error.details.requiresConfirmation, true);
  const confirmed = await t.owner.post('/assignments', { shiftId: day.id, localDate: '2026-03-06', staffMemberId: f.staffId, confirmOverlap: true }); assert.equal(confirmed.status, 201);
  assert.equal((await must(t.owner.get('/audit/events?action=assignment.create'))).items[0].detail.overlapConfirmed, true, 'the confirmation is recorded in audit');
  assert.equal((await t.owner.post('/assignments', { shiftId: night.id, localDate: '2026-03-06', staffMemberId: f.staffId })).status, 409, 'the same person cannot be assigned twice to one occurrence');
  const cov = await must(t.owner.get('/coverage?from=2026-03-06&to=2026-03-07')); assert.equal(cov.occurrences.length, 3); assert.equal(cov.understaffed.length, 1); assert.equal(cov.understaffed[0].localDate, '2026-03-07');
});

test('FR-ATT-001/002/004, FR-PRV-002 duty start gates: window, privacy notice, geofence Require/Warn, clock skew flag, missed check-out policies', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const sup = await addStaff(t, 'supervisor'); const f = await addStaff(t, 'field');
  const post = await must(t.owner.post('/posts', { unitId: t.rootUnitId, name: 'Gate', location: HQ })); await must(t.owner.post('/geofences', { postId: post.id, name: 'Site', geometry: { shape: 'circle', center: HQ, radiusM: 100 } }));
  const d = await planDuty(t, f.staffId, { postId: post.id, startInMin: 45, hours: 2 });
  const early = await f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h)); assert.equal(early.status, 409); assert.equal(early.body.error.code, 'OUTSIDE_DUTY_WINDOW'); assert.deepEqual(early.body.error.details.reasonCodes, ['TOO_EARLY']);
  h.clock.advanceMin(20);
  // a new notice version requires re-acknowledgement before tracking can start
  await must(t.owner.post('/privacy/notices', { texts: { en: 'Updated notice: location is collected only on duty.', ar: 'إشعار محدث: يتم جمع الموقع أثناء المناوبة فقط.' } }));
  const gate = await f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h)); assert.equal(gate.status, 403); assert.equal(gate.body.error.code, 'NOTICE_NOT_ACKNOWLEDGED'); assert.equal(gate.body.error.details.noticeVersion, 2);
  assert.equal(await h.store.count('duty_tracking_sessions', {}), 0, 'no tracking session without acknowledgement');
  const ack = await must(f.client.post('/privacy/acknowledgements', { version: 2 })); assert.ok(ack.acknowledgedAt && ack.deviceId);
  // geofence policy: Require blocks when clearly outside; uncertain accuracy does not block under Warn
  await setSettings(t.owner, { duty: { geofenceStart: 'require' } });
  const outside = await f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h, { ...north(500), accuracyM: 10 })); assert.equal(outside.body.error.code, 'GEOFENCE_REQUIRED');
  await setSettings(t.owner, { duty: { geofenceStart: 'warn' } });
  const skewed = { eventId: uuid(), occurredAt: iso(h.clock.now()), sentAt: iso(h.clock.now() + 3 * 3600000), location: { ...north(98), accuracyM: 40 } }; // device clock 3 h fast, accuracy straddles the edge
  const ok = await must(f.client.post(`/assignments/${d.assignmentId}/start`, skewed)); assert.equal(ok.status, 'accepted_with_exception'); assert.deepEqual(ok.reasonCodes.sort(), ['CLOCK_SKEW', 'GEOFENCE_UNCERTAIN']);
  const again = await must(f.client.post(`/assignments/${d.assignmentId}/start`, skewed)); assert.equal(again.status, 'duplicate'); assert.equal(await h.store.count('duty_tracking_sessions', {}), 1);
  assert.equal((await f.client.post(`/assignments/${d.assignmentId}/start`, { ...skewed, occurredAt: iso(h.clock.now() + 1000) })).body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  // missed check-out: default policy Flag → alert to supervisor, duty stays open
  h.clock.set(d.endsAt + 61 * 60000); await tick(h);
  assert.ok((await must(sup.client.get('/alerts?state=active'))).items.some((a: Doc) => a.type === 'missed_check_out')); assert.equal((await must(t.owner.get(`/assignments/${d.assignmentId}`))).status, 'started');
  // policy Auto-close → system-closed, tracking closed, labelled as system action
  await setSettings(t.owner, { duty: { missedCheckOut: 'auto_close', geofenceStart: 'warn' } }); await tick(h);
  const closed = await must(t.owner.get(`/assignments/${d.assignmentId}`)); assert.equal(closed.status, 'system_closed');
  assert.equal((await must(t.owner.get(`/tracking/sessions?assignmentId=${d.assignmentId}`))).items[0].closeReason, 'auto_close');
  const sum = await must(t.owner.get(`/assignments/${d.assignmentId}/summary`)); assert.equal(sum.actual.systemClosed, true); assert.equal(sum.actual.endBasis, 'system_flag'); assert.ok(sum.missingEvidence.some((m: string) => m.includes('system-closed')));
  const sys = (await must(t.owner.get(`/attendance/events?assignmentId=${d.assignmentId}`))).items.find((e: Doc) => e.type === 'system_close'); assert.equal(sys.actor.type, 'system');
});

test('FR-LOC-003/006/007, FR-PRV-001/006 locations: validation, late window, future clocks, review signals, history needs a purpose and is logged for the employee', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const disp = await addStaff(t, 'dispatcher'); const f = await addStaff(t, 'field'); const other = await addStaff(t, 'field');
  const d = await planDuty(t, f.staffId); h.clock.advanceMin(10); const st = await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h))); h.clock.advanceMin(3);
  const send = (pts: unknown[], sentAt = h.clock.now()) => f.client.post('/locations/batch', { trackingSessionId: st.trackingSessionId, sentAt: iso(sentAt), points: pts });
  assert.equal((await send([{ seq: 1, recordedAt: iso(h.clock.now()), lat: 91, lon: 0, accuracyM: 5 }])).status, 400, 'invalid coordinates are rejected');
  assert.equal((await send(Array.from({ length: 201 }, (_, i) => ({ seq: i, recordedAt: iso(h.clock.now()), lat: 1, lon: 1, accuracyM: 5 })))).status, 400, 'at most 200 points per batch');
  assert.equal((await other.client.post('/locations/batch', { trackingSessionId: st.trackingSessionId, sentAt: iso(h.clock.now()), points: points(h, 1) })).body.error.code, 'TRACKING_NOT_AUTHORIZED', 'another person cannot post into the session');
  const now = h.clock.now();
  const r = await must(send([
    { seq: 1, recordedAt: iso(now - 60000), ...HQ, accuracyM: 10 },
    { seq: 2, recordedAt: iso(now - 30000), ...north(40000), accuracyM: 10, mock: true }, // 40 km in 30 s
    { seq: 3, recordedAt: iso(now + 6 * 3600000), ...HQ, accuracyM: 10 }, // device clock in the future
    { seq: 4, recordedAt: iso(now - 20 * 60000), ...HQ, accuracyM: 10 }, // before the session opened
  ]));
  assert.deepEqual(r.results.map((x: Doc) => `${x.seq}:${x.status}${x.reason ? ':' + x.reason : ''}`).sort(), ['1:accepted', '2:accepted', '3:accepted', '4:rejected:BEFORE_SESSION_OPENED']);
  const pts = (await h.store.find('location_points', {}, { sort: { seq: 1 } })); assert.deepEqual(pts[1]!.signals.map((x: Doc) => x.signal).sort(), ['implausible_speed', 'mock_location']); assert.ok(pts[1]!.signals[0].facts);
  assert.equal(pts[2]!.effectiveTime, now, 'a future device time is clamped to receipt time for freshness');
  const live = (await must(t.owner.get('/locations/latest'))).items[0]; assert.equal(live.ageSec, 0); assert.equal(live.freshness, 'live');
  // history: purpose is mandatory, dispatcher only during an active incident, every read is logged and visible to the employee
  const range = `staffMemberId=${f.staffId}&from=${iso(now - 3600000)}&to=${iso(now + 7 * 3600000)}`;
  assert.equal((await t.owner.get(`/locations/history?${range}`)).status, 400, 'no purpose, no history');
  assert.equal((await disp.client.get(`/locations/history?${range}&purpose=routine%20check`)).status, 403, 'dispatcher without an active incident');
  await must(f.client.post('/sos', { eventId: uuid(), occurredAt: iso(now) }));
  const hist = await must(disp.client.get(`/locations/history?${range}&purpose=${encodeURIComponent('Responding to SOS INC-2026-000001')}`)); assert.equal(hist.points.length, 3); assert.equal(hist.basis, 'measured'); assert.match(hist.note, /unknown/);
  const log = await must(f.client.get('/me/location-access-log')); assert.equal(log.items.length, 1); assert.equal(log.items[0].purpose, 'Responding to SOS INC-2026-000001'); assert.ok(log.items[0].accessedBy.startsWith('dispatcher'));
  assert.equal((await must(t.owner.get('/audit/events?action=location.history.read'))).items.filter((e: Doc) => e.outcome === 'success').length, 1);
  const me = await must(f.client.get('/me/data')); assert.equal(me.tracking.active, true); assert.equal(me.recentLocations.length, 3); assert.ok(me.collected.length >= 4);
  assert.equal((await must(other.client.get('/me/data'))).recentLocations.length, 0, 'self-view returns only the caller\'s own data');
  // late window: points older than 7 days are rejected
  h.clock.advance(8 * 86400000); const late = await must(send([{ seq: 9, recordedAt: iso(now - 30000), ...HQ, accuracyM: 10 }])); assert.equal(late.results[0].reason, 'OLDER_THAN_LATE_WINDOW');
});

test('FR-GEO-001..003 geofence: invalid shapes rejected, edits are versioned, a noisy track yields one exit; exception alert after 5 minutes outside clears on return', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const sup = await addStaff(t, 'supervisor'); const f = await addStaff(t, 'field');
  const post = await must(t.owner.post('/posts', { unitId: t.rootUnitId, name: 'Yard', location: HQ }));
  const bow = await t.owner.post('/geofences', { postId: post.id, name: 'bad', geometry: { shape: 'polygon', ring: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, { lat: 0, lon: 1 }, { lat: 1, lon: 0 }] } }); assert.equal(bow.status, 400); assert.equal(bow.body.error.fieldErrors[0].code, 'INVALID_GEOMETRY');
  const g1 = await must(t.owner.post('/geofences', { postId: post.id, name: 'Yard fence', geometry: { shape: 'circle', center: HQ, radiusM: 80 }, requiredDuringDuty: true }));
  const g2 = await must(t.owner.patch(`/geofences/${g1.id}`, { version: 1, geometry: { shape: 'circle', center: HQ, radiusM: 100 } })); assert.equal(g2.version, 2); assert.equal(g2.previousId, g1.id);
  assert.equal((await must(t.owner.get(`/geofences/${g1.id}`))).status, 'superseded', 'history is preserved'); assert.equal((await must(t.owner.get('/geofences'))).items.length, 1);
  assert.equal((await t.owner.patch(`/geofences/${g2.id}`, { version: 1, name: 'stale edit' })).status, 409);
  const d = await planDuty(t, f.staffId, { postId: post.id }); h.clock.advanceMin(10); const st = await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h, { ...HQ, accuracyM: 5 })));
  let seq = 0; const step = async (m: number, acc = 8) => { h.clock.advanceSec(15); await must(f.client.post('/locations/batch', { trackingSessionId: st.trackingSessionId, sentAt: iso(h.clock.now()), points: [{ seq: seq++, recordedAt: iso(h.clock.now()), ...north(m), accuracyM: acc }] })); };
  for (let i = 0; i < 4; i++) await step(10); // inside → entered after 30 s dwell
  for (let i = 0; i < 8; i++) await step(i % 2 ? 108 : 92, 15); // jitter on the boundary: uncertain, no events
  for (let i = 0; i < 6; i++) await step(300); // clearly outside for 90 s → one exit
  const ev = (await must(sup.client.get(`/geofence-events?assignmentId=${d.assignmentId}`))).items.map((e: Doc) => e.type).reverse(); assert.deepEqual(ev, ['entered', 'exited']);
  const one = (await must(sup.client.get(`/geofence-events?assignmentId=${d.assignmentId}`))).items[0]; assert.ok(one.accuracyM && one.confidence > 0.5 && one.policyVersion === 2);
  await tick(h); assert.equal((await must(sup.client.get('/alerts?state=active&type=geofence_exception'))).items.length, 0, 'not yet 5 minutes outside');
  for (let i = 0; i < 20; i++) await step(300); await tick(h);
  const al = (await must(sup.client.get('/alerts?state=active&type=geofence_exception'))).items; assert.equal(al.length, 1);
  assert.equal((await must(sup.client.get('/locations/latest'))).items[0].dutyDisplayState, 'exception');
  for (let i = 0; i < 4; i++) await step(10); await tick(h);
  assert.equal((await must(sup.client.get(`/alerts/${al[0].id}`))).state, 'auto_resolved'); assert.equal((await must(sup.client.get('/locations/latest'))).items[0].dutyDisplayState, 'on_duty');
});

test('FR-CHK-002..004 checkpoints: wrong location, ordered plan, rotating code, reissue, missed checkpoint raised while the device is offline', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const sup = await addStaff(t, 'supervisor'); const f = await addStaff(t, 'field');
  const post = await must(t.owner.post('/posts', { unitId: t.rootUnitId, name: 'Plant' })); const fence = await must(t.owner.post('/geofences', { postId: post.id, name: 'Pump zone', geometry: { shape: 'circle', center: HQ, radiusM: 30 } }));
  const a = await must(t.owner.post('/checkpoints', { postId: post.id, name: 'A gate', method: 'qr' })), b = await must(t.owner.post('/checkpoints', { postId: post.id, name: 'B pump', method: 'qr', geofenceId: fence.id })), c = await must(t.owner.post('/checkpoints', { postId: post.id, name: 'C roof', method: 'qr', rotatingPeriodSec: 30 }));
  assert.notEqual(a.tagId, b.tagId); assert.ok(a.tagId.length >= 20, 'identifiers are unguessable');
  const d = await planDuty(t, f.staffId, { postId: post.id, hours: 2, checkpointPlan: { mode: 'ordered', items: [{ checkpointId: a.id, offsetEndMin: 30 }, { checkpointId: b.id, offsetEndMin: 60 }, { checkpointId: c.id, offsetEndMin: 90 }] } });
  h.clock.advanceMin(10); await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h)));
  const scan = async (tagId: string, extra: Record<string, unknown> = {}) => (await must(f.client.post('/checkpoint-scans', { eventId: uuid(), tagId, scannedAt: iso(h.clock.now()), ...extra }))).result;
  assert.equal(await scan(b.tagId, { location: { ...HQ, accuracyM: 5 } }), 'out_of_order');
  assert.equal(await scan(a.tagId), 'valid');
  assert.equal(await scan(b.tagId, { location: { ...north(400), accuracyM: 5 } }), 'wrong_location');
  assert.equal(await scan(b.tagId, { location: { ...HQ, accuracyM: 5 } }), 'valid');
  assert.equal(await scan(c.tagId), 'invalid_token', 'a rotating checkpoint needs the current code');
  const code = await must(t.owner.get(`/checkpoints/${c.id}/code`)); const secretless = checkpointToken('guess', code.tagId, h.clock.now(), 30); assert.notEqual(secretless, code.token);
  h.clock.advanceSec(65); assert.equal(await scan(c.tagId, { token: code.token }), 'invalid_token', 'a photographed code expires');
  assert.equal(await scan(c.tagId, { token: (await must(t.owner.get(`/checkpoints/${c.id}/code`))).token }), 'valid');
  const re = await must(t.owner.post(`/checkpoints/${a.id}/reissue`, { reason: 'label damaged' })); assert.notEqual(re.tagId, a.tagId); assert.equal(await scan(a.tagId), 'invalid_token', 'the old identifier stops working');
  assert.equal((await must(sup.client.get('/checkpoints'))).items[0].tagId, undefined, 'identifiers are shown only to checkpoint managers');
  // a second duty where the device goes offline: the scheduled evaluator still raises the missed checkpoint
  const f2 = await addStaff(t, 'field'); const d2 = await planDuty(t, f2.staffId, { postId: post.id, hours: 2, checkpointPlan: { mode: 'flexible', items: [{ checkpointId: b.id, offsetEndMin: 30 }] } });
  h.clock.advanceMin(10); await must(f2.client.post(`/assignments/${d2.assignmentId}/start`, startBody(h)));
  h.clock.advanceMin(39); await tick(h); assert.equal((await must(sup.client.get('/alerts?type=missed_checkpoint&state=active'))).items.length, 0, 'still inside window + 10 min grace');
  h.clock.advanceMin(2); await tick(h); await tick(h);
  const missed = (await must(sup.client.get('/alerts?type=missed_checkpoint&state=active'))).items; assert.equal(missed.length, 1); assert.equal(missed[0].detail.checkpointName, 'B pump');
  const exp = (await must(sup.client.get(`/checkpoint-expectations?assignmentId=${d2.assignmentId}`))).items[0]; assert.equal(exp.state, 'missed');
  await must(sup.client.post(`/checkpoint-expectations/${exp.id}/waive`, { reason: 'Pump room locked for maintenance' })); assert.equal((await must(sup.client.get(`/alerts/${missed[0].id}`))).state, 'auto_resolved');
  const rep = await must(t.owner.get(`/reports/missed_checkpoints?from=${iso(h.clock.now() - 86400000)}&to=${iso(h.clock.now())}`)); assert.equal(rep.rows.length, 0, 'waived expectations are not reported as missed');
});

test('FR-SET-001, TS §8.5/§9.1 settings and API conventions: versioning, platform bounds, optimistic concurrency, Idempotency-Key, strict validation, injection guard', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme');
  const v1 = await must(t.owner.get('/tenant/settings')); assert.equal(v1.version, 1); assert.equal(v1.effective.location.liveSec, 120);
  const v2 = await must(t.owner.put('/tenant/settings', { version: 1, settings: { location: { liveSec: 90 } } })); assert.equal(v2.version, 2); assert.equal(v2.effective.location.liveSec, 90); assert.equal(v2.effective.location.recentSec, 600);
  assert.equal((await t.owner.put('/tenant/settings', { version: 1, settings: {} })).body.error.code, 'VERSION_CONFLICT');
  for (const [bad, path] of [[{ auth: { passwordMin: 6 } }, 'settings.auth.passwordMin'], [{ retentionDays: { audit: 30 } }, 'settings.retentionDays.audit'], [{ auth: { mfaRequiredRoles: [] } }, 'settings.auth.mfaRequiredRoles'], [{ nope: 1 }, 'settings.nope'], [{ location: { liveSec: 'fast' } }, 'settings.location.liveSec'], [{ map: { tileUrl: 'http://x/{z}/{x}/{y}.png' } }, 'settings.map.tileUrl']] as [unknown, string][]) {
    const r = await t.owner.put('/tenant/settings', { version: 2, settings: bad }); assert.equal(r.status, 400); assert.equal(r.body.error.fieldErrors[0].path, path);
  }
  assert.equal((await must(t.owner.get('/tenant/settings/versions'))).items.length, 2);
  // optimistic concurrency on a resource
  const post = await must(t.owner.post('/posts', { unitId: t.rootUnitId, name: 'P' })); await must(t.owner.patch(`/posts/${post.id}`, { version: 1, name: 'P2' }));
  const stale = await t.owner.patch(`/posts/${post.id}`, { version: 1, name: 'P3' }); assert.equal(stale.status, 409); assert.equal(stale.body.error.details.currentVersion, 2);
  // Idempotency-Key: replay returns the original response, a different payload is a conflict
  const key = { 'idempotency-key': 'create-unit-0001' }; const body = { parentId: t.rootUnitId, type: 'region', name: 'East' };
  const first = await t.owner.post('/units', body, key), second = await t.owner.post('/units', body, key);
  assert.equal(first.status, 201); assert.equal(second.headers['Idempotent-Replay'], 'true'); assert.equal(second.body.id, first.body.id); assert.equal((await must(t.owner.get('/units'))).items.length, 2);
  assert.equal((await t.owner.post('/units', { ...body, name: 'West' }, key)).body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  // strict validation and injection guard
  const unk = await t.owner.post('/units', { ...body, name: 'X', isAdmin: true }); assert.equal(unk.status, 400); assert.deepEqual(unk.body.error.fieldErrors.map((e: Doc) => `${e.path}:${e.code}`), ['isAdmin:UNKNOWN_FIELD']);
  assert.equal((await t.owner.post('/auth/login', { tenant: 'acme', identifier: { $ne: '' }, password: { $gt: '' } })).status, 400, 'operator objects are rejected where text is expected');
  assert.equal((await t.owner.get('/staff?status[$ne]=active')).status, 400); assert.equal((await t.owner.get('/staff?limit=5000')).status, 400);
  assert.equal((await t.owner.put('/tenant/labels', { version: 1, labels: { post: { $where: 'x' } } })).status, 400);
  assert.equal((await t.owner.req('POST', '/units', undefined, {})).status, 400);
  const raw = await h.app.handle({ method: 'POST', path: '/api/v1/units', query: {}, headers: { authorization: `Bearer ${t.owner.token}` }, rawBody: '{"parentId":', ip: '1.1.1.1' }); assert.equal(raw.status, 400);
  const big = await h.app.handle({ method: 'POST', path: '/api/v1/units', query: {}, headers: { authorization: `Bearer ${t.owner.token}` }, rawBody: JSON.stringify({ name: 'x'.repeat(300000) }), ip: '1.1.1.1' }); assert.equal(big.status, 413);
  assert.equal((await t.owner.get('/no/such/route')).status, 404);
  const err = (await t.owner.get('/posts/unknown')).body.error; assert.deepEqual(Object.keys(err).sort(), ['code', 'message', 'requestId']);
  for (const hd of ['X-Content-Type-Options', 'X-Frame-Options', 'Content-Security-Policy', 'Referrer-Policy', 'Cache-Control', 'X-Request-Id']) assert.ok((await t.owner.get('/tenant')).headers[hd], `security header ${hd}`);
  // pagination: stable cursor, no duplicates
  for (let i = 0; i < 7; i++) await must(t.owner.post('/posts', { unitId: t.rootUnitId, name: `Q${i}` }));
  const seen: string[] = []; let cursor: string | null = ''; while (cursor !== null) { const page: Doc = await must(t.owner.get(`/posts?limit=3${cursor ? `&cursor=${cursor}` : ''}`)); seen.push(...page.items.map((x: Doc) => x.id)); cursor = page.nextCursor; }
  assert.equal(seen.length, 8); assert.equal(new Set(seen).size, 8); assert.equal((await t.owner.get('/posts?cursor=garbage')).status, 400);
});

test('FR-TEN-001..004, FR-SUB-001/004 platform: MFA console, provisioning is atomic and idempotent, suspension, plan limits never block SOS, support grants are read-only, time-boxed and audited', async () => {
  const h = await makeApp({ bootstrap: { email: 'root@platform.example', password: 'Platform-Admin-Passphrase-1' } });
  const p = new Client(h, ''); const l = await p.post('/platform/auth/login', { email: 'root@platform.example', password: 'Platform-Admin-Passphrase-1' }); assert.equal(l.body.mfaRequired, true); assert.equal(l.body.enrolmentRequired, true);
  const en = await p.post('/platform/auth/mfa/enroll', { challengeToken: l.body.challengeToken }); const { totp } = await import('@sf/domain/node');
  const tok = await p.post('/platform/auth/mfa/verify', { challengeToken: l.body.challengeToken, code: totp(en.body.secret, h.clock.now()) }); assert.equal(tok.status, 200); p.token = tok.body.accessToken;
  const body = { name: 'Harbour Security', slug: 'harbour', timezone: 'Asia/Riyadh', defaultLocale: 'ar', planKey: 'pilot', owner: { username: 'owner', displayName: 'Hana Owner' } };
  const created = await p.post('/platform/tenants', body, { 'idempotency-key': 'prov-harbour-1' }); assert.equal(created.status, 201); assert.ok(created.body.ownerActivationCode);
  const replay = await p.post('/platform/tenants', body, { 'idempotency-key': 'prov-harbour-1' }); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.ownerActivationCode, undefined);
  assert.equal((await p.post('/platform/tenants', body)).status, 409); assert.equal(await h.store.count('tenants', {}), 1); assert.equal(await h.store.count('roles', {}), 7); assert.equal(await h.store.count('alert_rules', {}), 8);
  // atomicity: a failure in the middle of provisioning leaves nothing behind
  const orig = h.store.insert.bind(h.store); let n = 0; h.store.insert = (c, d) => { if (c === 'catalogue_entries' && ++n === 3) throw new Error('simulated storage failure'); return orig(c, d); };
  await assert.rejects(provisionTenant(h.app, { ...body, slug: 'broken', defaultLocale: 'en' } as never, null)); h.store.insert = orig;
  assert.equal(await h.store.count('tenants', {}), 1, 'no partial tenant'); assert.equal(await h.store.count('roles', {}), 7); assert.equal(await h.store.count('users', {}), 1);
  // owner activates; platform sees metadata only
  const owner = new Client(h, 'harbour'); await must(owner.post('/auth/activate', { tenant: 'harbour', code: created.body.ownerActivationCode, password: PASSWORD })); await owner.login('owner', PASSWORD);
  const t = { tenant: (await h.store.findOne('tenants', { slug: 'harbour' }))!, slug: 'harbour', owner, rootUnitId: (await must(owner.get('/units'))).items[0].id, roleIds: Object.fromEntries((await must(owner.get('/roles'))).items.map((r: Doc) => [r.key, r.id])), h };
  await must(owner.post('/privacy/notices', { texts: { en: 'Location is collected only while on duty.', ar: 'يتم جمع الموقع أثناء المناوبة فقط.' } }));
  const list = await must(p.get('/platform/tenants')); assert.deepEqual(Object.keys(list.items[0].usage).sort(), ['activeStaff', 'devices', 'points', 'posts', 'storageBytes']);
  assert.equal((await p.get('/staff')).status, 403, 'platform staff cannot read tenant content without a grant'); assert.equal((await owner.get('/platform/tenants')).status, 403, 'tenant users cannot reach platform routes');
  // support grant: request → owner approves → read-only, scoped, audited, expires
  const g = await must(p.post('/platform/support-grants', { tenantId: t.tenant._id, reason: 'Investigating missing alerts ticket #4411', scope: ['alert.read'], hours: 2 }));
  const hdr = { 'x-support-grant': g.id, 'x-support-tenant': t.tenant._id };
  assert.equal((await p.get('/alerts', hdr)).status, 403, 'not usable before the Owner approves');
  await tick(h); assert.ok((await must(owner.get('/notifications'))).items.some((x: Doc) => x.template === 'support_grant_requested'));
  await must(owner.post(`/tenant/support-grants/${g.id}/approve`, {}));
  assert.equal((await p.get('/alerts', hdr)).status, 200); assert.equal((await p.get('/staff', hdr)).status, 403, 'outside the granted scope'); assert.equal((await p.post('/alerts/x/acknowledge', {}, hdr)).status, 403, 'grants are read-only');
  const sa = (await must(owner.get('/audit/events?action=support.access'))).items; assert.equal(sa.length, 1); assert.equal(sa[0].actor.type, 'support'); assert.match(sa[0].reason, /ticket #4411/);
  h.clock.advance(2 * 3600000 + 1000);
  const l2 = await p.post('/platform/auth/login', { email: 'root@platform.example', password: 'Platform-Admin-Passphrase-1' }); assert.equal(l2.body.enrolmentRequired, false);
  p.token = (await p.post('/platform/auth/mfa/verify', { challengeToken: l2.body.challengeToken, code: totp(en.body.secret, h.clock.now()) })).body.accessToken;
  assert.equal((await p.get('/alerts', hdr)).status, 403, 'expires automatically'); await owner.login('owner', PASSWORD);
  // plan limits: pilot allows 50 staff; creation is blocked with a clear message but SOS still works
  await must(p.put(`/platform/tenants/${t.tenant._id}/plan`, { planKey: 'pilot', limitsOverride: { activeStaff: 2, posts: 1, devices: 5 }, reason: 'test limits' }));
  const f = await addStaff(t, 'field'); const over = await owner.post('/staff', { employeeCode: 'Z1', displayName: 'z', homeUnitId: t.rootUnitId }); assert.equal(over.status, 403); assert.equal(over.body.error.code, 'PLAN_LIMIT_REACHED'); assert.match(over.body.error.message, /SOS are not affected/);
  await must(owner.post('/posts', { unitId: t.rootUnitId, name: 'One' })); assert.equal((await owner.post('/posts', { unitId: t.rootUnitId, name: 'Two' })).body.error.code, 'PLAN_LIMIT_REACHED');
  assert.equal((await f.client.post('/sos', { eventId: uuid(), occurredAt: iso(h.clock.now()) })).status, 200); assert.equal((await must(owner.get('/tenant/subscription'))).billing.provider, null);
  // suspension: sign-in blocked, SOS and check-out keep working during the grace window, reads blocked
  await must(p.post(`/platform/tenants/${t.tenant._id}/suspend`, { reason: 'Contract lapsed' }));
  assert.equal((await f.client.get('/me/duty')).body.error.code, 'TENANT_NOT_ACTIVE'); const sg = await f.client.post('/sos', { eventId: uuid(), occurredAt: iso(h.clock.now()) }); assert.equal(sg.status, 200, 'SOS works during the 24 h grace ' + JSON.stringify(sg.body));
  assert.equal((await owner.get('/tenant')).status, 200, 'Owner keeps access for export'); assert.equal((await owner.post('/tenant/exports')).status, 201);
  h.clock.advance(25 * 3600000); await f.client.login(f.code, PASSWORD, { deviceId: f.client.device!.id }); assert.equal((await f.client.post('/sos', { eventId: uuid(), occurredAt: iso(h.clock.now()) })).body.error.code, 'TENANT_NOT_ACTIVE');
  const l3 = await p.post('/platform/auth/login', { email: 'root@platform.example', password: 'Platform-Admin-Passphrase-1' });
  p.token = (await p.post('/platform/auth/mfa/verify', { challengeToken: l3.body.challengeToken, code: totp(en.body.secret, h.clock.now()) })).body.accessToken;
  assert.equal((await p.post(`/platform/tenants/${t.tenant._id}/archive`, { reason: 'x y z' })).status, 200); assert.equal((await p.post(`/platform/tenants/${t.tenant._id}/suspend`, { reason: 'x y z' })).status, 409, 'invalid lifecycle transition');
  const health = await must(p.get('/platform/health')); assert.equal(health.store.ok, true); assert.ok(!JSON.stringify(health).match(/password|secret|key/i));
  assert.ok((await h.store.find('platform_audit_events', {})).some((e) => e.action === 'platform.tenant.suspend'));
});

test('TS §20, FR-ALR-004 durability: a worker restart mid-escalation neither loses nor duplicates notifications; poison jobs go to the dead letter state', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const disp = await addStaff(t, 'dispatcher'); const sup = await addStaff(t, 'supervisor'); const f = await addStaff(t, 'field');
  await must(f.client.post('/sos', { eventId: uuid(), occurredAt: iso(h.clock.now()) }));
  assert.equal(await h.store.count('jobs', { type: 'alert.escalate', state: 'queued' }), 3, 'escalation steps are persisted with the SOS');
  // "crash": a brand-new application instance over the same database picks the jobs up
  const app2 = await createApp({ config: h.config, store: h.store, clock: h.clock, logSink: () => {} });
  h.clock.advanceSec(61); await app2.pump(); await app2.pump(); await h.app.pump();
  h.clock.advanceSec(60); await Promise.all([app2.pump(), h.app.pump()]); // two workers racing over the same queue
  const count = async (c: Client) => (await must(c.get('/notifications?limit=200'))).items.filter((x: Doc) => x.template === 'sos_escalated').length;
  assert.equal(await count(disp.client), 1); assert.equal(await count(sup.client), 1, 'exactly one escalation notification per step');
  // a tampered job payload is detected and parked, without blocking the queue
  const job = (await h.store.find('jobs', { state: 'queued' }))[0]!; await h.store.updateOne('jobs', { _id: job._id }, { $set: { 'payload.alertId': 'someone-elses', runAt: h.clock.now() } });
  await h.app.pump(); assert.equal((await h.store.findOne('jobs', { _id: job._id }))!.state, 'dead'); assert.match((await h.store.findOne('jobs', { _id: job._id }))!.lastError, /signature/);
  assert.ok(h.logs.some((l) => l.includes('job failed')));
});

test('FR-PRV-004/005, FR-INC-005 retention with legal hold; file uploads are type-checked, stripped of metadata and served by short-lived links', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field'); const g = await addStaff(t, 'field');
  for (const who of [f, g]) { const d = await planDuty(t, who.staffId, { hours: 1 }); h.clock.advanceMin(11); const st = await must(who.client.post(`/assignments/${d.assignmentId}/start`, startBody(h))); h.clock.advanceMin(3); await must(who.client.post('/locations/batch', { trackingSessionId: st.trackingSessionId, sentAt: iso(h.clock.now()), points: points(h, 4) })); await must(who.client.post(`/assignments/${d.assignmentId}/end`, startBody(h))); }
  h.clock.advance(91 * 86400000); await t.owner.login('owner', PASSWORD);
  await must(t.owner.post('/tenant/legal-holds', { scope: { kind: 'staff', id: g.staffId }, reason: 'Disciplinary case 12' }));
  const dry = await must(t.owner.post('/retention/runs', { dryRun: true })); assert.deepEqual([dry.result.location_points.eligible, dry.result.location_points.deleted, dry.result.location_points.skippedForLegalHold], [8, 0, 4]); assert.equal(await h.store.count('location_points', {}), 8);
  const run = await must(t.owner.post('/retention/runs', { dryRun: false })); assert.equal(run.result.location_points.deleted, 4); assert.equal(run.result.attendance.deleted, 0, 'attendance is kept for 2 years');
  assert.deepEqual((await h.store.find('location_points', {})).map((p) => p.staffMemberId), Array(4).fill(g.staffId), 'held data is retained');
  assert.ok((await must(t.owner.get('/audit/events?action=retention.run'))).items[0].detail.location_points === 4); assert.equal((await must(t.owner.get('/audit/verify'))).ok, true);
  // files
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif\0\0GPS:24.86'), Buffer.from([0xff, 0xdb, 0x00, 0x04, 1, 2]), Buffer.from([0xff, 0xda, 0x00, 0x02, 9, 9, 0xff, 0xd9])]);
  assert.equal(sniffMime(jpeg), 'image/jpeg'); assert.ok(!stripMetadata(jpeg, 'image/jpeg').includes('GPS'), 'EXIF segment is removed'); assert.equal(sniffMime(Buffer.from('MZ\x90\x00binary')), null);
  await f.client.login(f.code, PASSWORD, { deviceId: f.client.device!.id });
  assert.equal((await f.client.post('/files/upload-intents', { class: 'incident-attachment', name: 'x.exe', mime: 'application/x-msdownload', sizeBytes: 10 })).status, 400);
  assert.equal((await f.client.post('/files/upload-intents', { class: 'incident-attachment', name: 'big.jpg', mime: 'image/jpeg', sizeBytes: 50 * 1048576 })).status, 413);
  const intent = await must(f.client.post('/files/upload-intents', { class: 'incident-attachment', name: '../../etc/photo.jpg', mime: 'image/jpeg', sizeBytes: jpeg.length }));
  const put = (id: string, data: Buffer, c = f.client) => h.app.handle({ method: 'PUT', path: `/api/v1/files/${id}/content`, query: {}, headers: { authorization: `Bearer ${c.token}` }, rawBody: '', rawBuffer: data, ip: '1.1.1.1' });
  const fake = await must(f.client.post('/files/upload-intents', { class: 'incident-attachment', name: 'fake.jpg', mime: 'image/jpeg', sizeBytes: 20 }));
  assert.equal((await put(fake.fileId, Buffer.from('<script>alert(1)</script>'))).status, 400, 'content that does not match the declared type is rejected');
  assert.equal((await put(intent.fileId, jpeg, g.client)).status, 401);
  const up = await put(intent.fileId, jpeg); assert.equal(up.status, 200); const meta = up.body as Doc; assert.equal(meta.metadataStripped, true); assert.ok(meta.sha256); assert.equal(meta.name, '.._.._etc_photo.jpg'); assert.ok(!JSON.stringify(meta).includes('incident-attachment/'), 'storage keys are never exposed');
  const inc = await must(f.client.post('/incidents', { typeKey: 'hazard', description: 'Fence damaged', attachmentFileIds: [intent.fileId] }));
  const link = await must(t.owner.get(`/files/${intent.fileId}/url`)); const [path, qs] = link.url.replace('/api/v1', '').split('?');
  const dl = await new Client(h, 'acme').get(`${path}?${qs}`); assert.equal(dl.headers['Content-Disposition'], 'attachment; filename=".._.._etc_photo.jpg"'); assert.ok(!(dl as unknown as { raw: Buffer }).raw.includes('GPS'));
  await g.client.login(g.code, PASSWORD, { deviceId: g.client.device!.id });
  assert.equal((await g.client.get(`/files/${intent.fileId}/url`)).status, 404, 'another field officer cannot fetch the attachment'); assert.ok(inc.incidentId);
  assert.ok((await must(t.owner.get('/audit/events?action=file.access'))).items.length >= 1);
});

test('TS §9.1 rate limits and FR-SOS-004: logins and ingestion are limited per class with Retry-After; SOS is never throttled', async () => {
  const h = await makeApp({ rateLimits: true }); h.app.rate.enabled = false; const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field'); h.app.rate.enabled = true;
  const c = new Client(h, 'acme'); let last = 0, retry = ''; for (let i = 0; i < 12; i++) { const r = await c.post('/auth/login', { tenant: 'acme', identifier: `u${i}`, password: 'x' }, { 'x-test-ip': '9.9.9.9' }); last = r.status; retry = String(r.headers['Retry-After'] ?? ''); }
  assert.equal(last, 429); assert.ok(Number(retry) > 0, 'Retry-After is set'); assert.equal((await c.post('/auth/login', { tenant: 'acme', identifier: 'x', password: 'x' }, { 'x-test-ip': '8.8.8.8' })).status, 401, 'limits are per IP');
  const d = await planDuty(t, f.staffId); h.clock.advanceMin(10); const st = await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h)));
  let limited = 0; for (let i = 0; i < 15; i++) { const r = await f.client.post('/locations/batch', { trackingSessionId: st.trackingSessionId, sentAt: iso(h.clock.now()), points: points(h, 1, { fromSeq: i }) }); if (r.status === 429) limited++; }
  assert.equal(limited, 3, '12 batches per device per minute');
  for (let i = 0; i < 40; i++) assert.equal((await f.client.post('/sos', { eventId: uuid(), occurredAt: iso(h.clock.now()) })).status, 200, 'SOS is never rate-limited');
  assert.equal((await must(t.owner.get('/incidents?kind=sos&limit=200'))).items.filter((i: Doc) => i.abuseFlag).length, 10, 'repeated SOS is flagged for review instead of blocked');
});

test('FR-NOT-001/002, FR-SET-002/003 notifications are deduplicated per recipient; catalogues and labels are tenant-configurable and bilingual', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const sup = await addStaff(t, 'supervisor'); const f = await addStaff(t, 'field');
  await must(f.client.post('/incidents', { eventId: uuid(), typeKey: 'medical', description: 'Visitor fainted at gate' })); await tick(h);
  const n = await must(sup.client.get('/notifications')); assert.equal(n.unreadCount, 1); assert.deepEqual(Object.keys(n.items[0].title), ['en', 'ar']);
  await must(sup.client.post(`/notifications/${n.items[0].id}/read`)); assert.equal((await must(sup.client.get('/notifications?unread=true'))).items.length, 0);
  assert.equal((await f.client.post(`/notifications/${n.items[0].id}/read`)).status, 404, 'cannot touch another user\'s notification');
  const del = await must(t.owner.get('/notifications/deliveries?channel=in_app')); assert.ok(del.items.every((x: Doc) => x.state === 'delivered' && x.detail === undefined));
  const cat = await must(t.owner.post('/catalogues', { kind: 'incidentType', key: 'trespass', labels: { en: 'Trespass', ar: 'تعدٍّ' }, severityDefault: 'high' }));
  assert.equal((await must(f.client.post('/incidents', { typeKey: 'trespass', description: 'Person climbed fence' }))).incidentStatus, 'new');
  await must(t.owner.patch(`/catalogues/${cat.id}`, { archived: true })); assert.equal((await f.client.post('/incidents', { typeKey: 'trespass', description: 'again' })).status, 400, 'archived types cannot be used for new incidents');
  assert.equal((await must(t.owner.get('/incidents'))).items.filter((i: Doc) => i.typeKey === 'trespass').length, 1, 'historical records keep the archived value');
  const labels = await must(t.owner.get('/tenant/labels')); assert.equal(labels.labels.post.ar, 'الموقع');
  await must(t.owner.put('/tenant/labels', { version: labels.version, labels: { ...labels.labels, post: { en: 'Checkpoint site', ar: 'موقع الحراسة' } } })); assert.equal((await must(f.client.get('/tenant/labels'))).labels.post.en, 'Checkpoint site');
  const store2 = new MemoryStore(); store2.load(h.store.dump()); assert.equal(await store2.count('incidents', {}), 2, 'a store snapshot restores all records');
});
