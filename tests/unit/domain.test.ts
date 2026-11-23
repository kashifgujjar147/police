import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineM, classifyPoint, reduceGeofence, initialGeofenceState, validateShape, signedDistanceM, type GeofenceShape,
  localToUtcMs, expandOccurrences, parseRecurrence, freshness, effectiveTime, checkStart, displayState, validateScan,
  csvCell, toCsv, parseCsv, backoffMs, thinPoints, pointSignals, coveragePct, overlaps, compareVersions,
} from '@sf/domain';
import { chainHash, verifyChain, totp, verifyTotp, checkpointToken, verifyCheckpointToken, base32Encode, canonicalJson } from '@sf/domain/node';
import { ALL_MACHINES, DutyMachine, IncidentMachine, SosDeliveryMachine, AppError, validate, s } from '@sf/contracts';

const centre = { lat: 24.8607, lon: 67.0011 };
const circle: GeofenceShape = { shape: 'circle', center: centre, radiusM: 100 };
const north = (m: number) => ({ lat: centre.lat + m / 111195, lon: centre.lon });
const policy = { dwellSec: 30, exitDwellSec: 60, accuracyCeilingM: 100 };

test('FR-GEO-002 haversine and signed distance are accurate to within 1 m at geofence scale', () => {
  assert.ok(Math.abs(haversineM(centre, north(100)) - 100) < 1);
  assert.ok(Math.abs(signedDistanceM(north(40), circle) - 60) < 1);
  const sq: GeofenceShape = { shape: 'polygon', ring: [north(-50), { lat: north(-50).lat, lon: centre.lon + 0.001 }, { lat: north(50).lat, lon: centre.lon + 0.001 }, north(50)] };
  const inside = { lat: centre.lat, lon: centre.lon + 0.0005 };
  assert.ok(signedDistanceM(inside, sq) > 40);
  assert.ok(signedDistanceM({ lat: centre.lat, lon: centre.lon - 0.0005 }, sq) < -40);
});

test('FR-GEO-002 a point whose accuracy radius straddles the boundary is uncertain, not inside/outside', () => {
  assert.equal(classifyPoint(north(20), 10, circle).cls, 'inside');
  assert.equal(classifyPoint(north(200), 10, circle).cls, 'outside');
  assert.equal(classifyPoint(north(95), 20, circle).cls, 'uncertain');
  assert.equal(classifyPoint(north(105), 20, circle).cls, 'uncertain');
});

test('FR-GEO-001 invalid and self-intersecting polygons are rejected', () => {
  const bow: GeofenceShape = { shape: 'polygon', ring: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, { lat: 0, lon: 1 }, { lat: 1, lon: 0 }] };
  assert.match(validateShape(bow)!, /cross/);
  assert.match(validateShape({ shape: 'polygon', ring: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] })!, /at least 3/);
  assert.match(validateShape({ shape: 'circle', center: centre, radiusM: 1 })!, /radius/);
  assert.equal(validateShape({ shape: 'polygon', ring: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 }] }), null);
  assert.equal(validateShape(circle), null);
});

function replay(track: { t: number; m: number; acc: number }[]) {
  let st = initialGeofenceState(); const events: string[] = [];
  for (const p of track) {
    const r = reduceGeofence(st, { at: p.t * 1000, pos: north(p.m), accuracyM: p.acc }, circle, policy);
    st = r.state; if (r.event) events.push(r.event.type);
  }
  return { events, st };
}
test('FR-GEO-002 noisy track fixture: jitter at the boundary yields at most one enter and one exit per physical crossing', () => {
  const track: { t: number; m: number; acc: number }[] = [];
  let t = 0;
  for (let i = 0; i < 10; i++) track.push({ t: (t += 10), m: 300 - i * 15, acc: 10 }); // approach from outside
  for (let i = 0; i < 12; i++) track.push({ t: (t += 10), m: 100 + (i % 2 ? 12 : -12), acc: 15 }); // jitter exactly on the boundary
  for (let i = 0; i < 10; i++) track.push({ t: (t += 10), m: 60 - i * 5, acc: 10 }); // well inside
  for (let i = 0; i < 6; i++) track.push({ t: (t += 10), m: 20, acc: 400 }); // tunnel: poor accuracy, ignored
  for (let i = 0; i < 12; i++) track.push({ t: (t += 10), m: 100 + (i % 2 ? 14 : -14), acc: 15 }); // jitter on the way out
  for (let i = 0; i < 12; i++) track.push({ t: (t += 10), m: 160 + i * 20, acc: 10 }); // leave
  const { events, st } = replay(track);
  assert.deepEqual(events, ['entered', 'exited']);
  assert.ok(st.ignored > 0, 'uncertain/poor points are counted, not used');
});
test('FR-GEO-002 a single stray outside point does not produce an exit (dwell not met)', () => {
  const track = [{ t: 0, m: 10, acc: 5 }, { t: 40, m: 10, acc: 5 }, { t: 50, m: 300, acc: 5 }, { t: 60, m: 10, acc: 5 }, { t: 200, m: 10, acc: 5 }];
  assert.deepEqual(replay(track).events, ['entered']);
});

test('FR-DUTY-001 weekly shifts keep their local start time across a DST change', () => {
  const occ = expandOccurrences({ startDate: '2026-03-02', startsAtLocal: '08:00', endsAtLocal: '16:00', timezone: 'America/New_York', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO' }, '2026-03-01', '2026-03-20');
  assert.deepEqual(occ.map((o) => o.localDate), ['2026-03-02', '2026-03-09', '2026-03-16']);
  assert.equal(new Date(occ[0]!.startsAt).toISOString(), '2026-03-02T13:00:00.000Z'); // EST (UTC-5)
  assert.equal(new Date(occ[1]!.startsAt).toISOString(), '2026-03-09T12:00:00.000Z'); // EDT (UTC-4) after 8 March
  assert.equal(occ[1]!.endsAt - occ[1]!.startsAt, 8 * 3600000);
});
test('FR-DUTY-001 overnight shifts belong to the start date and span the DST night correctly', () => {
  const occ = expandOccurrences({ startDate: '2026-03-07', startsAtLocal: '22:00', endsAtLocal: '06:00', timezone: 'America/New_York', recurrenceRule: 'FREQ=DAILY;COUNT=2' }, '2026-03-07', '2026-03-10');
  assert.equal(occ.length, 2);
  assert.equal(occ[0]!.localDate, '2026-03-07');
  assert.equal(occ[0]!.endsAt - occ[0]!.startsAt, 7 * 3600000, 'the spring-forward night is 7 real hours');
  assert.equal(localToUtcMs('2026-11-10', '09:00', 'Asia/Karachi'), Date.parse('2026-11-10T04:00:00Z'));
  assert.equal(localToUtcMs('2026-11-10', '09:00', 'Asia/Riyadh'), Date.parse('2026-11-10T06:00:00Z'));
});
test('FR-DUTY-001 recurrence subset parsing rejects unsupported rules', () => {
  assert.ok('error' in parseRecurrence('FREQ=MONTHLY'));
  assert.ok('error' in parseRecurrence('INTERVAL=2'));
  assert.deepEqual(parseRecurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;UNTIL=20261231'), { freq: 'WEEKLY', interval: 2, byDay: ['SU', 'TU'], until: '2026-12-31', count: null });
  const occ = expandOccurrences({ startDate: '2026-11-01', startsAtLocal: '06:00', endsAtLocal: '14:00', timezone: 'Asia/Riyadh', recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU' }, '2026-11-01', '2026-11-30');
  assert.deepEqual(occ.map((o) => o.localDate), ['2026-11-01', '2026-11-03', '2026-11-15', '2026-11-17', '2026-11-29']);
});

test('FR-LOC-004 freshness labels follow tenant thresholds; FR-LOC-003 future device clock cannot look fresher', () => {
  const t = { liveSec: 120, recentSec: 600 }, now = 1_000_000_000;
  assert.equal(freshness(now, now - 60_000, t), 'live');
  assert.equal(freshness(now, now - 120_000, t), 'live');
  assert.equal(freshness(now, now - 121_000, t), 'recent');
  assert.equal(freshness(now, now - 601_000, t), 'stale');
  assert.equal(freshness(now, null, t), 'unknown');
  assert.equal(effectiveTime(now + 3_600_000, now), now);
});

test('FR-ATT-001 duty start window and geofence policy', () => {
  const base = { startsAt: 100 * 60000, endsAt: 580 * 60000, earlyMin: 30, lateMin: 60 };
  const at = (min: number) => min * 60000;
  assert.deepEqual(checkStart({ ...base, at: at(69), geofencePolicy: 'off', geofenceClass: 'none' }), { ok: false, code: 'OUTSIDE_DUTY_WINDOW', reasonCodes: ['TOO_EARLY'] });
  assert.deepEqual(checkStart({ ...base, at: at(70), geofencePolicy: 'off', geofenceClass: 'none' }), { ok: true, reasonCodes: [] });
  assert.deepEqual(checkStart({ ...base, at: at(161), geofencePolicy: 'off', geofenceClass: 'none' }), { ok: true, reasonCodes: ['LATE_START'] });
  assert.equal(checkStart({ ...base, at: at(600), geofencePolicy: 'off', geofenceClass: 'none' }).ok, false);
  assert.deepEqual(checkStart({ ...base, at: at(100), geofencePolicy: 'warn', geofenceClass: 'outside' }), { ok: true, reasonCodes: ['OUTSIDE_GEOFENCE_WARN'] });
  assert.deepEqual(checkStart({ ...base, at: at(100), geofencePolicy: 'warn', geofenceClass: 'uncertain' }), { ok: true, reasonCodes: ['GEOFENCE_UNCERTAIN'] });
  assert.equal((checkStart({ ...base, at: at(100), geofencePolicy: 'require', geofenceClass: 'outside' }) as { code: string }).code, 'GEOFENCE_REQUIRED');
  assert.equal(checkStart({ ...base, at: at(100), geofencePolicy: 'require', geofenceClass: 'inside' }).ok, true);
  assert.ok(overlaps({ startsAt: 1, endsAt: 5 }, { startsAt: 4, endsAt: 9 }));
  assert.ok(!overlaps({ startsAt: 1, endsAt: 5 }, { startsAt: 5, endsAt: 9 }));
});

test('FR-CMD-001/002 display classification never shows stale data as on duty', () => {
  assert.equal(displayState({ duty: 'started', activeSos: false, openExceptions: 0, fresh: 'live' }), 'on_duty');
  assert.equal(displayState({ duty: 'started', activeSos: false, openExceptions: 0, fresh: 'stale' }), 'stale_offline');
  assert.equal(displayState({ duty: 'started', activeSos: true, openExceptions: 2, fresh: 'stale' }), 'sos');
  assert.equal(displayState({ duty: 'started', activeSos: false, openExceptions: 1, fresh: 'live' }), 'exception');
  assert.equal(displayState({ duty: 'on_break', activeSos: false, openExceptions: 0, fresh: 'unknown' }), 'on_break');
  assert.equal(displayState({ duty: 'scheduled', activeSos: false, openExceptions: 0, fresh: 'unknown' }), 'not_started');
  assert.equal(displayState({ duty: 'ended', activeSos: false, openExceptions: 0, fresh: 'live' }), 'checked_out');
});

test('FR-CHK-002 every checkpoint scan reason code is reproducible', () => {
  const ok = { checkpointFound: true, assignmentActive: true, inPlan: true, scannedAt: 50, windowStart: 0, windowEnd: 100, tokenRequired: false, tokenValid: false, geofenceClass: 'not_required' as const, ordered: false, previousCompleted: true, alreadyValid: false };
  assert.equal(validateScan(ok), 'valid');
  assert.equal(validateScan({ ...ok, checkpointFound: false }), 'invalid_token');
  assert.equal(validateScan({ ...ok, assignmentActive: false }), 'not_assigned');
  assert.equal(validateScan({ ...ok, inPlan: false }), 'not_assigned');
  assert.equal(validateScan({ ...ok, scannedAt: -1 }), 'early');
  assert.equal(validateScan({ ...ok, scannedAt: 101 }), 'late');
  assert.equal(validateScan({ ...ok, tokenRequired: true }), 'invalid_token');
  assert.equal(validateScan({ ...ok, geofenceClass: 'outside' }), 'wrong_location');
  assert.equal(validateScan({ ...ok, geofenceClass: 'uncertain' }), 'valid');
  assert.equal(validateScan({ ...ok, ordered: true, previousCompleted: false }), 'out_of_order');
  assert.equal(validateScan({ ...ok, alreadyValid: true }), 'duplicate');
});
test('FR-CHK-003 rotating token accepts the current and previous period only', () => {
  const t0 = 1_800_000_000_000, tok = checkpointToken('secret', 'tag-1', t0, 30);
  assert.ok(verifyCheckpointToken('secret', 'tag-1', tok, t0, 30));
  assert.ok(verifyCheckpointToken('secret', 'tag-1', tok, t0 + 30_000, 30));
  assert.ok(!verifyCheckpointToken('secret', 'tag-1', tok, t0 + 61_000, 30), 'a photographed code expires');
  assert.ok(!verifyCheckpointToken('secret', 'tag-2', tok, t0, 30));
});

test('FR-RPT-003 CSV cells beginning with = + - @ are neutralised', () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('+1'), "'+1"); assert.equal(csvCell('-1'), "'-1"); assert.equal(csvCell('@x'), "'@x");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(toCsv(['a', 'b'], [{ a: 1, b: '=x' }]), "a,b\r\n1,'=x\r\n");
  assert.deepEqual(parseCsv('a,b\r\n"x,1","y ""q"""\n\n3,4'), [['a', 'b'], ['x,1', 'y "q"'], ['3', '4']]);
});

test('FR-AUD-002 hash chain detects an altered record', () => {
  const events: Record<string, unknown>[] = []; let prev = '';
  for (let i = 1; i <= 5; i++) { const e: Record<string, unknown> = { seq: i, action: 'x', n: i, prevHash: prev }; e.hash = chainHash(prev, e); prev = String(e.hash); events.push(e); }
  assert.deepEqual(verifyChain(events), { ok: true, count: 5 });
  const tampered = events.map((e) => ({ ...e })); tampered[2]!.n = 999;
  assert.deepEqual(verifyChain(tampered), { ok: false, brokenAtSeq: 3, reason: 'record content does not match its hash' });
  const removed = events.filter((_, i) => i !== 1);
  assert.equal((verifyChain(removed) as { brokenAtSeq: number }).brokenAtSeq, 3);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test('FR-AUTH-003 TOTP matches RFC 6238 test vector and codes cannot be replayed', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp(secret, 59_000, 8), '94287082');
  assert.equal(totp(secret, 1111111109_000, 8), '07081804');
  const now = 1_800_000_000_000, code = totp(secret, now);
  const step = verifyTotp(secret, code, now);
  assert.ok(step !== null);
  assert.equal(verifyTotp(secret, code, now, step!), null, 'same code rejected once used');
  assert.equal(verifyTotp(secret, '000000', now) === null || totp(secret, now) === '000000', true);
});

test('TS §14 backoff is bounded and thinning never drops the first or last point of a session', () => {
  assert.equal(backoffMs(1, { rand: () => 1 }), 2000);
  assert.equal(backoffMs(30, { rand: () => 1 }), 15 * 60000);
  assert.equal(backoffMs(10, { rand: () => 1, capMs: 30000 }), 30000);
  const pts = Array.from({ length: 100 }, (_, i) => ({ seq: i, sessionId: i < 50 ? 'a' : 'b' }));
  const { kept, dropped } = thinPoints(pts, 80);
  assert.ok(dropped > 0 && kept.length <= 100 - dropped + 0);
  for (const s of [0, 49, 50, 99]) assert.ok(kept.some((p) => p.seq === s));
  assert.equal(thinPoints(pts, 100).dropped, 0);
});

test('FR-LOC-007 review signals carry supporting facts', () => {
  const cfg = { minAccuracyM: 100, implausibleSpeedMps: 70, skewSignalSec: 120 };
  const a = { pos: centre, at: 0, accuracyM: 10 }, b = { pos: north(50000), at: 60_000, accuracyM: 10, mock: true };
  const sig = pointSignals(b, a, cfg, 3 * 3600_000).map((x) => x.signal).sort();
  assert.deepEqual(sig, ['clock_skew', 'implausible_speed', 'mock_location']);
  assert.deepEqual(pointSignals({ pos: centre, at: 1, accuracyM: 500 }, null, cfg, 0).map((x) => x.signal), ['low_accuracy']);
  assert.equal(coveragePct([{ at: 0, accuracyM: 10 }, { at: 61_000, accuracyM: 10 }, { at: 125_000, accuracyM: 900 }], 0, 240_000, 100), 50);
  assert.equal(coveragePct([], 0, 0, 100), null);
  assert.ok(compareVersions('1.2.0', '1.10.0') < 0); assert.equal(compareVersions('2.0', '2.0.0'), 0);
});

test('FR-INC-001 / PRD §5.2 state machines: every listed edge is allowed and every other edge is rejected', () => {
  for (const m of ALL_MACHINES) {
    for (const from of m.states) for (const to of m.states) {
      const allowed = (m.transitions as Record<string, readonly string[]>)[from]!.includes(to);
      assert.equal((m as { can(a: string, b: string): boolean }).can(from, to), allowed, `${m.name} ${from}->${to}`);
    }
  }
  assert.throws(() => IncidentMachine.assert('new', 'closed'), (e: unknown) => e instanceof AppError && e.code === 'INVALID_STATE_TRANSITION' && e.status === 409);
  assert.ok(IncidentMachine.can('dispatched', 'resolved'), 'On Scene may be skipped');
  assert.ok(!SosDeliveryMachine.can('pending_offline', 'notified'), 'an offline SOS can never jump to notified');
  assert.ok(!SosDeliveryMachine.can('sending', 'acknowledged_by_human'));
  assert.ok(DutyMachine.can('reviewed', 'ended') && !DutyMachine.can('ended', 'started'));
});

test('TS §8.1 validation rejects unknown fields, operator keys and wrong types with field-level errors', () => {
  const schema = s.object({ name: s.string({ min: 2 }), n: s.optional(s.number({ int: true })), meta: s.optional(s.json()) });
  assert.deepEqual(validate(schema, { name: 'ok', n: 2 }), { ok: true, value: { name: 'ok', n: 2 } });
  const bad = validate(schema, { name: { $ne: '' }, extra: 1, meta: { $where: 'x' } });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.issues.map((i) => `${i.path}:${i.code}`).sort(), ['extra:UNKNOWN_FIELD', 'meta.$where:UNSAFE_KEY', 'name:TYPE']);
});
