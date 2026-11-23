// Field verification: tracking sessions, location ingestion and projection, geofences, checkpoints, offline sync, realtime
// (FR-LOC-001..007, FR-GEO-001..003, FR-CHK-001..004, FR-SYN-001..004, FR-CMD-003; TS §10–§14).
import { type GeofenceShape, classifyPoint, displayState, effectiveTime, freshness, initialGeofenceState, pointSignals, reduceGeofence, validateScan, validateShape } from '@sf/domain';
import { checkpointToken, verifyCheckpointToken } from '@sf/domain/node';
import { App, AppError, Ctx, type Doc, RealtimeHub, Reply, type Route, created, paginate, randomToken, s, toApi } from '@sf/kernel';
import { attendanceBody, recordAttendance } from '../attendance/index.ts';

const pageQuery = { limit: s.optional(s.number({ int: true, min: 1, max: 200 })), cursor: s.optional(s.string({ max: 300 })) };
const latLon = s.object({ lat: s.lat(), lon: s.lon() });
const geometry = s.object({ shape: s.enum(['circle', 'polygon']), center: s.optional(latLon), radiusM: s.optional(s.number({ min: 1, max: 100000 })), ring: s.optional(s.array(latLon, { max: 250 })) });
function toShape(g: { shape: string; center?: { lat: number; lon: number }; radiusM?: number; ring?: { lat: number; lon: number }[] }): GeofenceShape {
  const shape: GeofenceShape | null = g.shape === 'circle' && g.center && g.radiusM ? { shape: 'circle', center: g.center, radiusM: g.radiusM } : g.shape === 'polygon' && g.ring ? { shape: 'polygon', ring: g.ring } : null;
  const reason = shape ? validateShape(shape) : 'geometry is incomplete';
  if (!shape || reason) throw new AppError('VALIDATION_FAILED', 'The geofence shape is not valid.', { fieldErrors: [{ path: 'geometry', code: 'INVALID_GEOMETRY', message: reason! }] });
  return shape;
}

// ---------------- tracking sessions ----------------
function profile(ctx: Ctx, onBreak: boolean) {
  const l = ctx.settings.location, mode = ctx.settings.duty.breakTracking;
  return { movingSec: onBreak && mode === 'reduced' ? l.movingSec * 4 : l.movingSec, stationarySec: onBreak && mode === 'reduced' ? l.stationarySec * 4 : l.stationarySec, minAccuracyM: l.minAccuracyM, distanceFilterM: l.distanceFilterM, paused: onBreak && mode === 'pause' };
}
async function openTracking(ctx: Ctx, a: Doc): Promise<Doc> {
  const cur = await ctx.col('duty_tracking_sessions').findOne({ openKey: a._id });
  if (cur) return cur;
  return ctx.col('duty_tracking_sessions').insert({ assignmentId: a._id, staffMemberId: a.staffMemberId, unitId: a.unitId, postId: a.postId, deviceId: ctx.actor.deviceId ?? null, state: 'open', openKey: a._id, openedAt: ctx.now(), closedAt: null, closeReason: null, onBreak: false, profile: profile(ctx, false), accepted: 0, rejected: 0 });
}
/** Closing is mandatory on duty end, assignment cancellation, auto-close, device revocation, sign-out and suspension (FR-LOC-001). */
async function closeTracking(ctx: Ctx, ts: Doc, reason: string) {
  await ctx.col('duty_tracking_sessions').update(ts._id, { $set: { state: 'closed', closedAt: ctx.now(), closeReason: reason, graceUntil: ctx.now() + ctx.settings.location.closeGraceSec * 1000 }, $unset: ['openKey'] });
  await refreshState(ctx, ts.staffMemberId);
}

// ---------------- latest-state projection ----------------
async function refreshState(ctx: Ctx, staffMemberId: string, point?: Doc): Promise<void> {
  const now = ctx.now(); const states = ctx.col('staff_location_states');
  const [cur, staff, active, openAlerts, sos] = await Promise.all([
    states.findOne({ staffMemberId }), ctx.col('staff_members').get(staffMemberId),
    ctx.col('duty_assignments').find({ staffMemberId, status: { $in: ['started', 'on_break'] } }, { limit: 1 }),
    ctx.col('alerts').count({ staffMemberId, state: { $in: ['open', 'acknowledged'] }, type: { $nin: ['sos', 'stale_location', 'device_offline', 'low_battery'] } }), ctx.col('incidents').count({ reportedByStaffId: staffMemberId, kind: 'sos', status: { $in: ['new', 'acknowledged', 'dispatched', 'on_scene', 'reopened'] } }),
  ]);
  if (!staff) return;
  let a = active[0] ?? null;
  if (!a) a = (await ctx.col('duty_assignments').find({ staffMemberId, rosterState: { $in: ['published', 'revised_unpublished'] }, startsAt: { $lte: now + 3600000 }, endsAt: { $gte: now - 3600000 } }, { sort: { startsAt: -1 }, limit: 1 }))[0] ?? null;
  const set: Record<string, unknown> = { staffMemberId, displayName: staff.displayName, employeeCode: staff.employeeCode, unitId: a?.unitId ?? staff.homeUnitId, assignmentId: a?._id ?? null, postId: a?.postId ?? null, dutyState: a?.status ?? null, openExceptions: openAlerts, activeSos: sos > 0, updatedAt: now };
  if (point && (!cur?.effectiveTime || point.effectiveTime >= cur.effectiveTime)) Object.assign(set, { lat: point.lat, lon: point.lon, accuracyM: point.accuracyM, recordedAt: point.recordedAt, receivedAt: point.receivedAt, effectiveTime: point.effectiveTime, battery: point.battery ?? cur?.battery ?? null, mock: !!point.mock });
  const eff = (set.effectiveTime as number | undefined) ?? cur?.effectiveTime ?? null;
  set.dutyDisplayState = a || sos > 0 ? displayState({ duty: a?.status ?? 'scheduled', activeSos: sos > 0, openExceptions: openAlerts, fresh: freshness(now, eff, ctx.settings.location) }) : 'checked_out';
  if (cur) await states.update(cur._id, { $set: set }); else if (a || point || sos > 0) await states.insert(set);
}
function stateView(ctx: Ctx, st: Doc, withCoords: boolean) {
  const now = ctx.now(); const fresh = freshness(now, st.effectiveTime, ctx.settings.location);
  // Display state is derived at read time so a stale position is never presented as current (FR-CMD-002).
  const display = st.dutyState || st.activeSos ? displayState({ duty: st.dutyState ?? 'scheduled', activeSos: !!st.activeSos, openExceptions: st.openExceptions ?? 0, fresh }) : 'checked_out';
  const base = { staffMemberId: st.staffMemberId, displayName: st.displayName, employeeCode: st.employeeCode, unitId: st.unitId, postId: st.postId, assignmentId: st.assignmentId, dutyState: st.dutyState, dutyDisplayState: display, freshness: fresh, ageSec: st.effectiveTime ? Math.max(0, Math.round((now - st.effectiveTime) / 1000)) : null, recordedAt: st.recordedAt ?? null, receivedAt: st.receivedAt ?? null, battery: st.battery ?? null, openExceptions: st.openExceptions ?? 0, activeSos: !!st.activeSos };
  return withCoords && st.lat !== undefined ? { ...base, lat: st.lat, lon: st.lon, accuracyM: st.accuracyM } : base;
}

// ---------------- geofence pipeline ----------------
async function evaluateGeofences(ctx: Ctx, ts: Doc, points: Doc[]) {
  const fences = await ctx.col('geofences').find({ postId: ts.postId, status: 'active' });
  for (const f of fences) {
    const key = { assignmentId: ts.assignmentId, geofenceId: f._id };
    const cur = await ctx.col('geofence_states').findOne(key); let st = cur?.track ?? initialGeofenceState(); let lastAt = cur?.lastAt ?? 0;
    const policy = { ...ctx.settings.geofence, ...(f.policy ?? {}) };
    for (const p of points) {
      if (p.recordedAt <= lastAt) continue; // late or out-of-order points are stored but never re-open a decided transition
      if ((f.activeFrom && p.recordedAt < f.activeFrom) || (f.activeTo && p.recordedAt > f.activeTo)) continue;
      const r = reduceGeofence(st, { at: p.recordedAt, pos: { lat: p.lat, lon: p.lon }, accuracyM: p.accuracyM }, f.geometry as GeofenceShape, policy); st = r.state; lastAt = p.recordedAt;
      if (!r.event) continue;
      const ev = await ctx.col('geofence_events').insert({ ...key, staffMemberId: ts.staffMemberId, unitId: ts.unitId, postId: ts.postId, type: r.event.type, eventAt: r.event.at, receivedAt: ctx.now(), accuracyM: r.event.accuracyM, confidence: r.event.confidence, policyVersion: f.version, geofenceName: f.name });
      await ctx.emit(r.event.type === 'entered' ? 'geofence:entered' : 'geofence:exited', { unitId: ts.unitId, needs: 'geofence.read' }, { staffMemberId: ts.staffMemberId, assignmentId: ts.assignmentId, geofenceId: f._id, eventId: ev._id, occurredAt: new Date(r.event.at).toISOString() }, r.event.at);
      await ctx.app.services.alerts.onGeofenceEvent(ctx, ts, f, ev);
    }
    if (cur) await ctx.col('geofence_states').update(cur._id, { $set: { track: st, lastAt } }); else await ctx.col('geofence_states').insert({ ...key, staffMemberId: ts.staffMemberId, track: st, lastAt });
  }
}

// ---------------- location ingestion ----------------
const pointSchema = s.object({ seq: s.number({ int: true, min: 0 }), recordedAt: s.iso(), lat: s.lat(), lon: s.lon(), accuracyM: s.number({ min: 0, max: 10000 }), speed: s.optional(s.number({ min: 0, max: 400 })), heading: s.optional(s.number({ min: 0, max: 360 })), altitude: s.optional(s.number({ min: -1000, max: 20000 })), provider: s.optional(s.enum(['gps', 'network', 'fused', 'unknown'])), mock: s.optional(s.boolean()), battery: s.optional(s.number({ min: 0, max: 100 })), background: s.optional(s.boolean()) });
async function ingestBatch(ctx: Ctx, body: { trackingSessionId: string; sentAt: string; points: { seq: number; recordedAt: string; lat: number; lon: number; accuracyM: number; [k: string]: unknown }[] }) {
  const now = ctx.now(); const cfg = ctx.settings.location;
  const ts = await ctx.col('duty_tracking_sessions').get(body.trackingSessionId);
  // Tracking gate (FR-LOC-001): no Tracking Session for this person and device → the whole batch is rejected.
  if (!ts || ts.staffMemberId !== ctx.actor.staffMemberId || (ts.deviceId && ts.deviceId !== ctx.actor.deviceId)) {
    ctx.app.metrics.inc('sf_location_points_total', { result: 'rejected_unauthorized' }, body.points.length);
    throw new AppError('TRACKING_NOT_AUTHORIZED', 'There is no active duty tracking session for these points. Locations are only accepted while you are on duty.');
  }
  const clockSkewMs = Date.parse(body.sentAt) - now;
  const seqs = body.points.map((p) => p.seq);
  const dup = new Set((await ctx.col('location_points').find({ deviceId: ts.deviceId, trackingSessionId: ts._id, seq: { $in: seqs } })).map((d) => d.seq as number));
  const results: { seq: number; status: 'accepted' | 'duplicate' | 'rejected'; reason?: string }[] = []; const accepted: Doc[] = [];
  let prev = await ctx.col('location_points').findOne({ trackingSessionId: ts._id }, { sort: { recordedAt: -1 } });
  const seen = new Set<number>();
  for (const p of [...body.points].sort((x, y) => Date.parse(x.recordedAt) - Date.parse(y.recordedAt))) {
    const recordedAt = Date.parse(p.recordedAt);
    const reject = (reason: string) => results.push({ seq: p.seq, status: 'rejected', reason });
    if (dup.has(p.seq) || seen.has(p.seq)) { results.push({ seq: p.seq, status: 'duplicate' }); continue; }
    seen.add(p.seq);
    if (recordedAt < ts.openedAt - 5000) { reject('BEFORE_SESSION_OPENED'); continue; }
    if (ts.state === 'closed' && recordedAt > ts.closedAt) { reject('AFTER_SESSION_CLOSED'); continue; } // nothing is collected after duty ends
    if (now - recordedAt > cfg.lateWindowDays * 86400000) { reject('OLDER_THAN_LATE_WINDOW'); continue; }
    if (ts.onBreak && ts.profile?.paused && ts.state === 'open' && recordedAt >= (ts.breakSince ?? Infinity)) { reject('TRACKING_PAUSED_ON_BREAK'); continue; }
    const signals = pointSignals({ pos: { lat: p.lat, lon: p.lon }, at: recordedAt, accuracyM: p.accuracyM, mock: !!p.mock }, prev ? { pos: { lat: prev.lat, lon: prev.lon }, at: prev.recordedAt, accuracyM: prev.accuracyM } : null, cfg, clockSkewMs);
    const doc = await ctx.col('location_points').insert({ staffMemberId: ts.staffMemberId, deviceId: ts.deviceId, assignmentId: ts.assignmentId, trackingSessionId: ts._id, unitId: ts.unitId, seq: p.seq, lat: p.lat, lon: p.lon, accuracyM: p.accuracyM, speed: p.speed ?? null, heading: p.heading ?? null, altitude: p.altitude ?? null, provider: p.provider ?? 'unknown', mock: !!p.mock, battery: p.battery ?? null,
      recordedAt, receivedAt: now, effectiveTime: effectiveTime(recordedAt, now), clockSkewMs, signals, expireAt: now + ctx.settings.retentionDays.location_points * 86400000 });
    accepted.push(doc); prev = doc; results.push({ seq: p.seq, status: 'accepted' });
  }
  const rejected = results.filter((r) => r.status === 'rejected').length;
  if (accepted.length || rejected) await ctx.col('duty_tracking_sessions').update(ts._id, { $inc: { accepted: accepted.length, rejected } });
  if (accepted.length) {
    await evaluateGeofences(ctx, ts, accepted);
    const latest = accepted.reduce((m, p) => (p.effectiveTime >= m.effectiveTime ? p : m));
    await refreshState(ctx, ts.staffMemberId, latest);
    if (latest.battery !== null) await ctx.app.services.alerts.onBattery(ctx, ts, latest.battery);
    await ctx.app.services.alerts.resolveFor(ctx, 'stale_location', ts.staffMemberId);
    if (ctx.device) await ctx.col('devices').update(ctx.device._id, { $set: { lastSeenAt: now } });
    const st = (await ctx.col('staff_location_states').findOne({ staffMemberId: ts.staffMemberId }))!;
    await ctx.emit('location:updated', { unitId: ts.unitId, staffId: ts.staffMemberId, needs: 'location.live.read' }, { ...stateView(ctx, st, true), recordedAt: new Date(latest.recordedAt).toISOString() } as Record<string, unknown>, latest.recordedAt);
  }
  ctx.app.metrics.inc('sf_location_points_total', { result: 'accepted' }, accepted.length); ctx.app.metrics.inc('sf_location_points_total', { result: 'rejected' }, rejected);
  ctx.app.metrics.observe('sf_location_ingest_lag_ms', {}, accepted.length ? now - accepted[accepted.length - 1]!.recordedAt : 0);
  return { trackingSessionId: ts._id, sessionState: ts.state, serverTime: now, clockSkewMs, accepted: accepted.length, duplicates: results.filter((r) => r.status === 'duplicate').length, rejected, results };
}

// ---------------- checkpoints ----------------
async function generateExpectations(ctx: Ctx, a: Doc) {
  await ctx.col('checkpoint_expectations').delete({ assignmentId: a._id, state: 'pending' });
  const done = new Set((await ctx.col('checkpoint_expectations').find({ assignmentId: a._id })).map((e) => `${e.checkpointId}:${e.windowStart}`));
  let order = 0;
  for (const item of (a.checkpointPlan?.items ?? []) as Doc[]) {
    const windowStart = a.startsAt + (item.offsetStartMin ?? 0) * 60000, windowEnd = item.offsetEndMin !== undefined ? a.startsAt + item.offsetEndMin * 60000 : a.endsAt; order++;
    if (done.has(`${item.checkpointId}:${windowStart}`)) continue;
    await ctx.col('checkpoint_expectations').insert({ assignmentId: a._id, staffMemberId: a.staffMemberId, unitId: a.unitId, checkpointId: item.checkpointId, order, required: item.required ?? true, windowStart, windowEnd, state: 'pending', createdAt: ctx.now() });
  }
}
export interface ScanInput { eventId: string; tagId: string; assignmentId?: string; token?: string; scannedAt: number; location?: { lat: number; lon: number; accuracyM: number } | null; offline?: boolean }
async function recordScan(ctx: Ctx, input: ScanInput) {
  const now = ctx.now(); const prior = await ctx.col('checkpoint_scans').findOne({ eventId: input.eventId });
  if (prior) { if (prior.tagId !== input.tagId || prior.scannedAt !== input.scannedAt) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This event id was already used for a different scan.'); return { ...(prior.response as object), status: 'duplicate' }; }
  const staffId = ctx.actor.staffMemberId!;
  const cp = await ctx.col('checkpoints').findOne({ tagId: input.tagId });
  const a = input.assignmentId ? await ctx.col('duty_assignments').findOne({ _id: input.assignmentId, staffMemberId: staffId }) : (await ctx.col('duty_assignments').find({ staffMemberId: staffId, status: { $in: ['started', 'on_break'] } }, { limit: 1 }))[0] ?? null;
  const activeAt = !!a && ['started', 'on_break', 'ended', 'system_closed', 'reviewed'].includes(a.status) && input.scannedAt >= (a.startedAt ?? Infinity) - 60000 && (a.endedAt === undefined || a.endedAt === null || input.scannedAt <= a.endedAt);
  const exps = cp && a ? await ctx.col('checkpoint_expectations').find({ assignmentId: a._id, checkpointId: cp._id }, { sort: { windowStart: 1 } }) : [];
  const grace = (cp?.graceMin ?? ctx.settings.checkpoints.graceMin) * 60000;
  const exp = exps.find((e) => e.state === 'pending' && input.scannedAt >= e.windowStart && input.scannedAt <= e.windowEnd + grace) ?? exps.find((e) => input.scannedAt >= e.windowStart && input.scannedAt <= e.windowEnd + grace) ?? exps.find((e) => e.state === 'pending') ?? exps[exps.length - 1] ?? null;
  let geoClass: 'inside' | 'outside' | 'uncertain' | 'none' | 'not_required' = 'not_required';
  if (cp?.geofenceId) { const f = await ctx.col('geofences').get(cp.geofenceId); geoClass = !f ? 'not_required' : !input.location ? 'none' : classifyPoint(input.location, input.location.accuracyM, f.geometry as GeofenceShape).cls; }
  const earlier = exp && a?.checkpointPlan?.mode === 'ordered' ? await ctx.col('checkpoint_expectations').find({ assignmentId: a._id, required: true, order: { $lt: exp.order } }) : [];
  const result = validateScan({
    checkpointFound: !!cp && cp.status === 'active', assignmentActive: activeAt, inPlan: !!exp, scannedAt: input.scannedAt, windowStart: exp?.windowStart ?? null, windowEnd: exp ? exp.windowEnd + grace : null,
    tokenRequired: !!cp?.rotating, tokenValid: !!cp?.rotating && !!input.token && verifyCheckpointToken(ctx.app.crypto.decrypt(cp.tagSecretEnc), cp.tagId, input.token, input.scannedAt, cp.rotating.periodSec),
    geofenceClass: geoClass, ordered: a?.checkpointPlan?.mode === 'ordered', previousCompleted: earlier.every((e) => e.state === 'completed' || e.state === 'waived'), alreadyValid: exp?.state === 'completed',
  });
  const response = { eventId: input.eventId, status: 'accepted', result, checkpointId: cp?._id ?? null, checkpointName: cp?.name ?? null, expectationId: exp?._id ?? null, serverTime: now };
  const scan = await ctx.col('checkpoint_scans').insert({ eventId: input.eventId, tagId: input.tagId, checkpointId: cp?._id ?? null, expectationId: exp?._id ?? null, assignmentId: a?._id ?? null, staffMemberId: staffId, unitId: a?.unitId ?? cp?.unitId ?? null, deviceId: ctx.actor.deviceId ?? null,
    scannedAt: input.scannedAt, receivedAt: now, offline: !!input.offline, lat: input.location?.lat ?? null, lon: input.location?.lon ?? null, accuracyM: input.location?.accuracyM ?? null, geofenceClass: geoClass, result, response });
  if (result === 'valid' && exp) { await ctx.col('checkpoint_expectations').update(exp._id, { $set: { state: 'completed', completedByScanId: scan._id, completedAt: input.scannedAt } }); await ctx.app.services.alerts.resolveFor(ctx, 'missed_checkpoint', exp._id); }
  if (a) await ctx.emit('checkpoint:scanned', { unitId: a.unitId, staffId, needs: 'checkpoint.read' }, { scanId: scan._id, staffMemberId: staffId, assignmentId: a._id, checkpointId: cp?._id ?? null, result, occurredAt: new Date(input.scannedAt).toISOString() }, input.scannedAt);
  return response;
}
const scanBody = { eventId: s.uuid(), tagId: s.string({ min: 4, max: 80 }), assignmentId: s.optional(s.id()), token: s.optional(s.string({ max: 40 })), scannedAt: s.iso(), location: s.optional(s.object({ lat: s.lat(), lon: s.lon(), accuracyM: s.number({ min: 0, max: 5000 }) })), offline: s.optional(s.boolean()) };

const routes: Route[] = [
  // ---- locations ----
  {
    method: 'POST', path: '/locations/batch', permission: 'duty.own', scope: 'own', audit: { none: 'high-volume telemetry; rejections are counted in metrics and on the tracking session' }, rate: 'locations', deviceBound: true, summary: 'Ingest up to 200 location points for an open Tracking Session; per-point results', reqs: ['FR-LOC-001', 'FR-LOC-002', 'FR-LOC-003', 'FR-LOC-007', 'FR-SYN-001'],
    body: s.object({ trackingSessionId: s.id(), sentAt: s.iso(), points: s.array(pointSchema, { min: 1, max: 200 }) }),
    async handler(ctx, { body }) { return ingestBatch(ctx, body); },
  },
  {
    method: 'GET', path: '/locations/latest', permission: 'location.live.read', scope: 'unit', audit: { none: 'live view; history access is audited separately' }, rate: 'read', summary: 'Latest state per staff member within scope, each with freshness and age', reqs: ['FR-LOC-004', 'FR-CMD-001', 'FR-CMD-002'],
    query: s.object({ unitId: s.optional(s.id()), postId: s.optional(s.id()), teamId: s.optional(s.id()), state: s.optional(s.string({ max: 30 })), freshness: s.optional(s.enum(['live', 'recent', 'stale', 'unknown'])), q: s.optional(s.string({ max: 80 })) }),
    async handler(ctx, { query }) {
      const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') };
      if (query.unitId) { ctx.assertScope(query.unitId, 'Unit'); f.unitId = { $in: [query.unitId, ...(await ctx.col('organization_units').find({ ancestorIds: query.unitId })).map((u) => u._id)].filter((u) => ctx.inScope(u)) }; }
      if (query.postId) f.postId = query.postId;
      if (query.teamId) f.staffMemberId = { $in: (await ctx.col('team_memberships').find({ teamId: query.teamId })).map((m) => m.staffMemberId) };
      let items = (await ctx.col('staff_location_states').find(f, { limit: 10000 })).map((st) => stateView(ctx, st, true)).filter((v) => v.dutyDisplayState !== 'checked_out' || v.activeSos);
      const counts: Record<string, number> = {}; for (const v of items) counts[v.dutyDisplayState] = (counts[v.dutyDisplayState] ?? 0) + 1;
      if (query.state) items = items.filter((v) => v.dutyDisplayState === query.state);
      if (query.freshness) items = items.filter((v) => v.freshness === query.freshness);
      if (query.q) { const q = query.q.toLowerCase(); items = items.filter((v) => String(v.displayName).toLowerCase().includes(q) || String(v.employeeCode).toLowerCase().includes(q)); }
      const rank: Record<string, number> = { sos: 0, exception: 1, stale_offline: 2, not_started: 3, on_duty: 4, on_break: 5, checked_out: 6 };
      items.sort((x, y) => rank[x.dutyDisplayState]! - rank[y.dutyDisplayState]! || String(x.displayName).localeCompare(String(y.displayName)));
      return { asOf: ctx.now(), thresholds: { liveSec: ctx.settings.location.liveSec, recentSec: ctx.settings.location.recentSec }, counts, total: items.length, items };
    },
  },
  {
    method: 'GET', path: '/locations/history', permission: 'location.history.read', scope: 'unit', audit: 'location.history.read', rate: 'read', tx: true, summary: 'Location history for one person in a time range; purpose is mandatory and every read is logged', reqs: ['FR-LOC-006', 'FR-PRV-006'],
    query: s.object({ staffMemberId: s.id(), from: s.iso(), to: s.iso(), purpose: s.string({ min: 5, max: 300 }) }),
    async handler(ctx, { query }) {
      const st = await ctx.col('staff_members').must(query.staffMemberId, 'Staff member'); ctx.assertScope(st.homeUnitId, 'Staff member');
      const from = Date.parse(query.from), to = Date.parse(query.to);
      ctx.setAudit({ resource: { type: 'staff', id: st._id }, reason: query.purpose, detail: { from: query.from, to: query.to } });
      if (to <= from || to - from > 48 * 3600000) throw new AppError('VALIDATION_FAILED', 'Choose a range of at most 48 hours.');
      if (ctx.actor.roleKeys.length === 1 && ctx.actor.roleKeys[0] === 'dispatcher') { // Dispatcher: only for staff on an active incident
        const inc = await ctx.col('incidents').find({ status: { $in: ['new', 'acknowledged', 'dispatched', 'on_scene', 'reopened'] }, $or: [{ reportedByStaffId: st._id }, { responderStaffIds: st._id }] }, { limit: 1 });
        if (!inc.length) throw new AppError('FORBIDDEN', 'Dispatchers can open location history only for staff involved in an active incident.');
      }
      const points = await ctx.col('location_points').find({ staffMemberId: st._id, recordedAt: { $gte: from, $lte: to } }, { sort: { recordedAt: 1 }, limit: 20000 });
      await ctx.col('location_access_log').insert({ staffMemberId: st._id, accessedByUserId: ctx.actor.userId, actorType: ctx.actor.type, purpose: query.purpose, from, to, at: ctx.now(), points: points.length });
      const gapMs = ctx.settings.location.stationarySec * 3 * 1000; const gaps: { from: number; to: number }[] = [];
      for (let i = 1; i < points.length; i++) if (points[i]!.recordedAt - points[i - 1]!.recordedAt > gapMs) gaps.push({ from: points[i - 1]!.recordedAt, to: points[i]!.recordedAt });
      return { asOf: ctx.now(), staffMemberId: st._id, range: { from, to }, basis: 'measured', note: 'Gaps mean no data was received (unknown), not that the person was absent. Locations exist only for on-duty periods.',
        points: points.map((p) => ({ recordedAt: p.recordedAt, receivedAt: p.receivedAt, lat: p.lat, lon: p.lon, accuracyM: p.accuracyM, assignmentId: p.assignmentId, signals: p.signals, mock: p.mock })), gaps };
    },
  },
  { method: 'GET', path: '/tracking/sessions', permission: 'attendance.read', scope: 'unit', audit: { none: 'tracking session metadata read' }, rate: 'read', summary: 'Tracking sessions with open/close reasons and accepted/rejected counts', reqs: ['FR-LOC-001'], query: s.object({ ...pageQuery, assignmentId: s.optional(s.id()), staffMemberId: s.optional(s.id()), state: s.optional(s.enum(['open', 'closed'])) }),
    async handler(ctx, { query }) { const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') }; for (const k of ['assignmentId', 'staffMemberId', 'state'] as const) if (query[k]) f[k] = query[k]; return paginate(ctx.col('duty_tracking_sessions'), f, query, 'openedAt', -1); } },
  // ---- offline sync ----
  {
    method: 'POST', path: '/sync/events', permission: 'duty.own', scope: 'own', audit: 'sync.events', rate: 'sync', deviceBound: true, tx: false, whenInactive: 'safety', summary: 'Batch of queued offline events, validated individually in causal order with per-event results', reqs: ['FR-SYN-001', 'FR-SYN-002', 'FR-SYN-003', 'FR-SYN-004'],
    body: s.object({ sentAt: s.iso(), events: s.array(s.object({ eventId: s.uuid(), type: s.enum(['check_in', 'check_out', 'break_start', 'break_end', 'scan', 'incident', 'sos']), occurredAt: s.iso(), assignmentId: s.optional(s.id()), payload: s.optional(s.json(4)) }), { min: 1, max: 100 }) }),
    async handler(ctx, { body }) {
      const sentAt = Date.parse(body.sentAt); const results: Record<string, unknown>[] = [];
      for (const ev of body.events) { // causal order is the client's queue order; each event is its own transaction
        const occurredAt = Date.parse(ev.occurredAt); const p = (ev.payload ?? {}) as Record<string, any>;
        try {
          const out = await ctx.app.store.transaction(async () => {
            if (ev.type === 'scan') return recordScan(ctx, { eventId: ev.eventId, tagId: String(p.tagId ?? ''), assignmentId: ev.assignmentId, token: p.token, scannedAt: occurredAt, location: p.location ?? null, offline: true });
            if (ev.type === 'sos') return ctx.app.services.sos.raise(ctx, { eventId: ev.eventId, occurredAt, sentAt, location: p.location ?? null, assignmentId: ev.assignmentId, note: p.note, offline: true });
            if (ev.type === 'incident') return ctx.app.services.incidents.create(ctx, { eventId: ev.eventId, typeKey: String(p.typeKey ?? 'other'), description: String(p.description ?? ''), severity: p.severity, location: p.location ?? null, assignmentId: ev.assignmentId, occurredAt, offline: true });
            if (!ev.assignmentId) throw new AppError('VALIDATION_FAILED', 'assignmentId is required for attendance events.');
            return recordAttendance(ctx, { eventId: ev.eventId, type: ev.type, assignmentId: ev.assignmentId, occurredAt, sentAt, location: p.location ?? null, offline: true });
          });
          results.push({ eventId: ev.eventId, type: ev.type, ...(toApi(out) as object) });
        } catch (e) {
          if (!(e instanceof AppError) || e.status >= 500) throw e;
          // Rejections carry a specific code and a next action; the device keeps the record visible until acknowledged (FR-SYN-002).
          const action = e.code === 'OUTSIDE_DUTY_WINDOW' || e.code === 'INVALID_STATE_TRANSITION' || e.code === 'GEOFENCE_REQUIRED' ? 'request_correction' : e.code === 'NOTICE_NOT_ACKNOWLEDGED' ? 'acknowledge_notice' : e.code === 'NOT_FOUND' ? 'contact_supervisor' : 'review';
          results.push({ eventId: ev.eventId, type: ev.type, status: 'rejected', code: e.code, message: e.message, details: e.extra.details ?? null, action });
          await ctx.app.store.transaction(async () => {
            if (await ctx.col('sync_rejections').findOne({ eventId: ev.eventId })) return;
            const a = ev.assignmentId ? await ctx.col('duty_assignments').get(ev.assignmentId) : null;
            await ctx.col('sync_rejections').insert({ eventId: ev.eventId, type: ev.type, staffMemberId: ctx.actor.staffMemberId, assignmentId: a?.staffMemberId === ctx.actor.staffMemberId ? a!._id : null, unitId: a?.staffMemberId === ctx.actor.staffMemberId ? a!.unitId : null, occurredAt, receivedAt: ctx.now(), code: e.code, action, resolvedAt: null });
          });
        }
      }
      const tally = (st: string) => results.filter((r) => r.status === st).length;
      ctx.setAudit({ resource: { type: 'device', id: ctx.actor.deviceId ?? null }, detail: { events: results.length, accepted: tally('accepted'), acceptedWithException: tally('accepted_with_exception'), duplicate: tally('duplicate'), rejected: tally('rejected') } });
      return { serverTime: ctx.now(), clockSkewMs: sentAt - ctx.now(), results };
    },
  },
  { method: 'GET', path: '/sync/rejections', permission: 'attendance.read', scope: 'unit', audit: { none: 'gap list read' }, rate: 'read', summary: 'Events rejected at sync: gaps a supervisor needs to see', reqs: ['FR-SYN-002'], query: s.object({ ...pageQuery, staffMemberId: s.optional(s.id()) }),
    async handler(ctx, { query }) { const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') }; if (query.staffMemberId) f.staffMemberId = query.staffMemberId; return paginate(ctx.col('sync_rejections'), f, query, 'receivedAt', -1); } },
  // ---- geofences ----
  { method: 'GET', path: '/geofences', permission: 'geofence.read', scope: 'unit', audit: { none: 'geofence list read' }, rate: 'read', summary: 'Geofences within scope (current versions unless history is requested)', reqs: ['FR-GEO-001'], query: s.object({ postId: s.optional(s.id()), includeHistory: s.optional(s.boolean()) }),
    async handler(ctx, { query }) { const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') }; if (query.postId) f.postId = query.postId; if (!query.includeHistory) f.status = 'active'; return { items: await ctx.col('geofences').find(f, { sort: { createdAt: -1 }, limit: 2000 }) }; } },
  {
    method: 'POST', path: '/geofences', permission: 'geofence.manage', scope: 'unit', audit: 'geofence.create', rate: 'mutation', summary: 'Create a circle or polygon geofence for a post', reqs: ['FR-GEO-001'],
    body: s.object({ postId: s.id(), name: s.string({ min: 1, max: 120 }), geometry, requiredDuringDuty: s.optional(s.boolean()), activeFrom: s.optional(s.iso()), activeTo: s.optional(s.iso()), policy: s.optional(s.object({ dwellSec: s.optional(s.number({ int: true, min: 0, max: 3600 })), exitDwellSec: s.optional(s.number({ int: true, min: 0, max: 3600 })), accuracyCeilingM: s.optional(s.number({ min: 5, max: 1000 })) })) }),
    async handler(ctx, { body }) {
      const post = await ctx.col('posts').must(body.postId, 'Post'); ctx.assertScope(post.unitId, 'Post');
      const g = await ctx.col('geofences').insert({ postId: post._id, unitId: post.unitId, name: body.name, geometry: toShape(body.geometry), requiredDuringDuty: body.requiredDuringDuty ?? false, activeFrom: body.activeFrom ? Date.parse(body.activeFrom) : null, activeTo: body.activeTo ? Date.parse(body.activeTo) : null, policy: body.policy ?? null, status: 'active', version: 1, lineageId: null, createdAt: ctx.now(), createdBy: ctx.actor.userId });
      ctx.setAudit({ resource: { type: 'geofence', id: g._id }, after: { name: g.name, shape: g.geometry.shape, postId: post._id } });
      return created(g);
    },
  },
  { method: 'GET', path: '/geofences/:id', permission: 'geofence.read', scope: 'unit', audit: { none: 'geofence read' }, rate: 'read', summary: 'Geofence detail',
    async handler(ctx, { params }) { const g = await ctx.col('geofences').must(params.id!, 'Geofence'); ctx.assertScope(g.unitId, 'Geofence'); return g; } },
  {
    method: 'PATCH', path: '/geofences/:id', permission: 'geofence.manage', scope: 'unit', audit: 'geofence.update', rate: 'mutation', summary: 'Edit a geofence: the old version is kept and a new version becomes active', reqs: ['FR-GEO-001'],
    body: s.object({ version: s.number({ int: true }), name: s.optional(s.string({ min: 1, max: 120 })), geometry: s.optional(geometry), requiredDuringDuty: s.optional(s.boolean()), archive: s.optional(s.boolean()) }),
    async handler(ctx, { params, body }) {
      const g = await ctx.col('geofences').must(params.id!, 'Geofence'); ctx.assertScope(g.unitId, 'Geofence');
      if (g.status !== 'active') throw new AppError('INVALID_STATE_TRANSITION', 'Only the active version can be edited.');
      if (g.version !== body.version) throw new AppError('VERSION_CONFLICT', 'This geofence was changed by someone else. Reload and try again.', { details: { currentVersion: g.version } });
      await ctx.col('geofences').update(g._id, { $set: { status: body.archive ? 'archived' : 'superseded', supersededAt: ctx.now() } });
      ctx.setAudit({ resource: { type: 'geofence', id: g._id }, before: { version: g.version, name: g.name }, after: { archived: !!body.archive, version: g.version + 1 } });
      if (body.archive) return { status: 'archived' };
      const { _id, tenantId: _t, ...rest } = g;
      return ctx.col('geofences').insert({ ...rest, name: body.name ?? g.name, geometry: body.geometry ? toShape(body.geometry) : g.geometry, requiredDuringDuty: body.requiredDuringDuty ?? g.requiredDuringDuty, status: 'active', version: g.version + 1, lineageId: g.lineageId ?? _id, previousId: _id, createdAt: ctx.now(), createdBy: ctx.actor.userId });
    },
  },
  { method: 'GET', path: '/geofence-events', permission: 'geofence.read', scope: 'unit', audit: { none: 'geofence event read' }, rate: 'read', summary: 'Entered/exited events with accuracy, confidence and policy version', reqs: ['FR-GEO-002'], query: s.object({ ...pageQuery, assignmentId: s.optional(s.id()), staffMemberId: s.optional(s.id()) }),
    async handler(ctx, { query }) { const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') }; if (query.assignmentId) f.assignmentId = query.assignmentId; if (query.staffMemberId) f.staffMemberId = query.staffMemberId; return paginate(ctx.col('geofence_events'), f, query, 'eventAt', -1); } },
  // ---- checkpoints ----
  { method: 'GET', path: '/checkpoints', permission: 'checkpoint.read', scope: 'unit', audit: { none: 'checkpoint list read' }, rate: 'read', summary: 'Checkpoints within scope', reqs: ['FR-CHK-001'], query: s.object({ postId: s.optional(s.id()) }),
    async handler(ctx, { query }) { const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') }; if (query.postId) f.postId = query.postId; const items = await ctx.col('checkpoints').find(f, { sort: { name: 1 }, limit: 5000 }); return { items: items.map((c) => (ctx.can('checkpoint.manage') ? { ...c, qrPayload: `sf360:cp:${c.tagId}` } : { ...c, tagId: undefined })) }; } },
  {
    method: 'POST', path: '/checkpoints', permission: 'checkpoint.manage', scope: 'unit', audit: 'checkpoint.create', rate: 'mutation', summary: 'Create a checkpoint with an unguessable identifier (optionally a rotating code)', reqs: ['FR-CHK-001', 'FR-CHK-003'],
    body: s.object({ postId: s.id(), name: s.string({ min: 1, max: 120 }), method: s.enum(['qr', 'nfc', 'geo']), instructions: s.optional(s.string({ max: 1000 })), graceMin: s.optional(s.number({ int: true, min: 0, max: 240 })), geofenceId: s.optional(s.id()), rotatingPeriodSec: s.optional(s.number({ int: true, min: 15, max: 3600 })) }),
    async handler(ctx, { body }) {
      const post = await ctx.col('posts').must(body.postId, 'Post'); ctx.assertScope(post.unitId, 'Post');
      if (body.geofenceId) { const f = await ctx.col('geofences').must(body.geofenceId, 'Geofence'); if (f.postId !== post._id) throw new AppError('VALIDATION_FAILED', 'The geofence must belong to the same post.'); }
      const c = await ctx.col('checkpoints').insert({ postId: post._id, unitId: post.unitId, name: body.name, method: body.method, tagId: randomToken(18), instructions: body.instructions ?? null, graceMin: body.graceMin ?? null, geofenceId: body.geofenceId ?? null,
        rotating: body.rotatingPeriodSec ? { periodSec: body.rotatingPeriodSec } : null, ...(body.rotatingPeriodSec ? { tagSecretEnc: ctx.app.crypto.encrypt(randomToken(32)) } : {}), status: 'active', createdAt: ctx.now(), version: 1 });
      ctx.setAudit({ resource: { type: 'checkpoint', id: c._id }, after: { name: c.name, postId: post._id, method: c.method } });
      return created({ ...c, qrPayload: `sf360:cp:${c.tagId}` });
    },
  },
  {
    method: 'PATCH', path: '/checkpoints/:id', permission: 'checkpoint.manage', scope: 'unit', audit: 'checkpoint.update', rate: 'mutation', summary: 'Update or archive a checkpoint', reqs: ['FR-CHK-001'],
    body: s.object({ version: s.number({ int: true }), name: s.optional(s.string({ min: 1, max: 120 })), instructions: s.optional(s.string({ max: 1000 })), graceMin: s.optional(s.number({ int: true, min: 0, max: 240 })), status: s.optional(s.enum(['active', 'archived'])) }),
    async handler(ctx, { params, body }) { const c = await ctx.col('checkpoints').must(params.id!, 'Checkpoint'); ctx.assertScope(c.unitId, 'Checkpoint'); const { version, ...set } = body; const out = await ctx.col('checkpoints').updateVersioned(c._id, version, set); ctx.setAudit({ resource: { type: 'checkpoint', id: c._id }, before: { name: c.name, status: c.status }, after: set }); return out; },
  },
  {
    method: 'POST', path: '/checkpoints/:id/reissue', permission: 'checkpoint.manage', scope: 'unit', audit: 'checkpoint.reissue', rate: 'mutation', summary: 'Issue a new identifier; the previous one stops working immediately', reqs: ['FR-CHK-001'], body: s.object({ reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      const c = await ctx.col('checkpoints').must(params.id!, 'Checkpoint'); ctx.assertScope(c.unitId, 'Checkpoint');
      const out = (await ctx.col('checkpoints').update(c._id, { $set: { tagId: randomToken(18), reissuedAt: ctx.now(), ...(c.rotating ? { tagSecretEnc: ctx.app.crypto.encrypt(randomToken(32)) } : {}) }, $inc: { version: 1 } }))!;
      ctx.setAudit({ resource: { type: 'checkpoint', id: c._id }, reason: body.reason });
      return { ...out, qrPayload: `sf360:cp:${out.tagId}` };
    },
  },
  { method: 'GET', path: '/checkpoints/:id/code', permission: 'checkpoint.manage', scope: 'unit', audit: { none: 'short-lived display code read' }, rate: 'read', summary: 'Current rotating code for an on-site display', reqs: ['FR-CHK-003'],
    async handler(ctx, { params }) { const c = await ctx.col('checkpoints').must(params.id!, 'Checkpoint'); ctx.assertScope(c.unitId, 'Checkpoint'); if (!c.rotating) throw new AppError('CONFLICT', 'This checkpoint does not use rotating codes.'); const p = c.rotating.periodSec; return { tagId: c.tagId, token: checkpointToken(ctx.app.crypto.decrypt(c.tagSecretEnc), c.tagId, ctx.now(), p), periodSec: p, validUntil: (Math.floor(ctx.now() / 1000 / p) + 1) * p * 1000 }; } },
  {
    method: 'POST', path: '/checkpoint-scans', permission: 'duty.own', scope: 'own', audit: { none: 'every scan attempt is itself an immutable record with its result' }, rate: 'mutation', deviceBound: true, summary: 'Record a checkpoint scan; exactly one result with a stable reason code', reqs: ['FR-CHK-002', 'FR-CHK-003', 'FR-SYN-001'], body: s.object(scanBody),
    async handler(ctx, { body }) { return recordScan(ctx, { ...body, scannedAt: Date.parse(body.scannedAt) }); },
  },
  { method: 'GET', path: '/checkpoint-scans', permission: 'checkpoint.read', scope: 'unit', audit: { none: 'scan list read (no coordinates)' }, rate: 'read', summary: 'Scan attempts with results', reqs: ['FR-CHK-002'], query: s.object({ ...pageQuery, assignmentId: s.optional(s.id()), staffMemberId: s.optional(s.id()), result: s.optional(s.string({ max: 20 })) }),
    async handler(ctx, { query }) { const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') }; for (const k of ['assignmentId', 'staffMemberId', 'result'] as const) if (query[k]) f[k] = query[k]; const page = await paginate(ctx.col('checkpoint_scans'), f, query, 'receivedAt', -1); return { ...page, items: page.items.map(({ lat: _a, lon: _b, response: _r, tagId: _t, ...x }: Doc) => x) }; } },
  { method: 'GET', path: '/checkpoint-expectations', permission: 'checkpoint.read', scope: 'unit', audit: { none: 'expectation list read' }, rate: 'read', summary: 'Expected checkpoint visits and their state', reqs: ['FR-CHK-004'], query: s.object({ ...pageQuery, assignmentId: s.optional(s.id()), state: s.optional(s.enum(['pending', 'completed', 'missed', 'waived'])) }),
    async handler(ctx, { query }) { const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') }; if (query.assignmentId) f.assignmentId = query.assignmentId; if (query.state) f.state = query.state; return paginate(ctx.col('checkpoint_expectations'), f, query, 'windowEnd', -1); } },
  {
    method: 'POST', path: '/checkpoint-expectations/:id/waive', permission: 'attendance.review', scope: 'unit', audit: 'checkpoint.expectation.waive', rate: 'mutation', summary: 'Waive an expected checkpoint with a reason', reqs: ['FR-CHK-004'], body: s.object({ reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) { const e = await ctx.col('checkpoint_expectations').must(params.id!, 'Expectation'); ctx.assertScope(e.unitId, 'Expectation'); if (e.state === 'completed') throw new AppError('INVALID_STATE_TRANSITION', 'This checkpoint was already completed.'); const out = await ctx.col('checkpoint_expectations').update(e._id, { $set: { state: 'waived', waivedBy: ctx.actor.userId, waivedReason: body.reason, waivedAt: ctx.now() } }); await ctx.app.services.alerts.resolveFor(ctx, 'missed_checkpoint', e._id); ctx.setAudit({ resource: { type: 'checkpoint_expectation', id: e._id }, reason: body.reason, before: { state: e.state } }); return out; },
  },
  // ---- realtime ----
  {
    method: 'GET', path: '/realtime/stream', permission: 'session', scope: 'own', audit: { none: 'realtime subscription' }, rate: 'read', raw: true, summary: 'Server-sent event stream; rooms are computed by the server from the caller\'s scope', reqs: ['FR-CMD-003', 'FR-RBAC-003'],
    async handler(ctx) {
      const actor = ctx.actor; const app = ctx.app; const tenantId = ctx.tenantId;
      const stream = (write: (chunk: string) => boolean, onClose: (fn: () => void) => void) => {
        const sub = app.hub.subscribe({ tenantId, userId: actor.userId, staffId: actor.staffMemberId ?? null, units: actor.scopeUnitIds === '*' ? '*' : new Set(actor.scopeUnitIds), permissions: actor.permissions, send: (env) => { write(`id: ${env.seq}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`); } });
        void app.store.findOne('counters', { tenantId, name: 'realtime_seq', period: '' }).then((c) => write(`event: hello\ndata: ${JSON.stringify({ seq: c?.value ?? 0, serverTime: new Date(app.clock.now()).toISOString() })}\n\n`));
        const beat = setInterval(() => write(`: keep-alive ${Date.now()}\n\n`), 20000); beat.unref?.();
        // Revocation and role/scope changes take effect on the open connection within 10 s (TS §10.2).
        const recheck = setInterval(async () => {
          try {
            const repo = app.tenantRepo(tenantId); const [sess, m] = await Promise.all([repo.col('sessions').get(actor.sessionId!), repo.col('memberships').get(actor.membershipId!)]);
            if (!sess || sess.revokedAt || !m || m.status !== 'active') { write(`event: session:revoked\ndata: {}\n\n`); stop(); return; }
            const roles = await repo.col('roles').find({ _id: { $in: m.roleIds } });
            const units = m.scopeUnitIds.includes('*') ? '*' as const : new Set((await repo.col('organization_units').find({ $or: [{ _id: { $in: m.scopeUnitIds } }, { ancestorIds: { $in: m.scopeUnitIds } }] })).map((u) => u._id));
            sub.update({ permissions: new Set(roles.flatMap((r) => r.permissionKeys as string[])), units });
          } catch { /* next tick retries */ }
        }, 10000); recheck.unref?.();
        const stop = () => { clearInterval(beat); clearInterval(recheck); sub.close(); };
        onClose(stop);
      };
      return new Reply(200, { stream }, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    },
  },
  {
    method: 'GET', path: '/realtime/catch-up', permission: 'session', scope: 'own', audit: { none: 'realtime catch-up' }, rate: 'read', summary: 'Events since a sequence number for reconnect without a full reload (bounded: 15 minutes / 10,000 events)', reqs: ['FR-CMD-003'], query: s.object({ since: s.number({ int: true, min: 0 }) }),
    async handler(ctx, { query }) {
      const sub = { tenantId: ctx.tenantId, userId: ctx.actor.userId, staffId: ctx.actor.staffMemberId ?? null, units: ctx.actor.scopeUnitIds === '*' ? '*' as const : new Set(ctx.actor.scopeUnitIds), permissions: ctx.actor.permissions };
      const oldest = await ctx.col('realtime_events').findOne({ purgeAt: { $gt: ctx.now() } }, { sort: { seq: 1 } });
      const cur = (await ctx.app.store.findOne('counters', { tenantId: ctx.tenantId, name: 'realtime_seq', period: '' }))?.value ?? 0;
      if (query.since < cur && (!oldest || oldest.seq > query.since + 1)) return { reset: true, seq: cur, events: [] }; // too far behind: client reloads from REST
      const evs = await ctx.col('realtime_events').find({ seq: { $gt: query.since } }, { sort: { seq: 1 }, limit: 10000 });
      return new Reply(200, { reset: false, seq: cur, events: evs.filter((e) => RealtimeHub.visible(sub, ctx.tenantId, e.scope)).map((e) => { const { _id, at: _at, purgeAt: _p, scope: _s, ...env } = e; return RealtimeHub.shape(sub, env as never); }) });
    },
  },
];

export function registerField(app: App) {
  app.register('field', routes);
  app.services.tracking = { open: openTracking, close: closeTracking, profile };
  app.services.location = { refreshState, stateView, ingestBatch };
  app.services.checkpoints = { generateExpectations, recordScan };
  // Missed-checkpoint evaluator: runs on a schedule, so it fires even when the device is offline (FR-CHK-004).
  app.schedule('checkpoints.missed', 30, async (tenant) => {
    if (tenant.status !== 'active' && tenant.status !== 'trial') return;
    const ctx = (await app.systemCtxFor(tenant._id, 'checkpoint-evaluator'))!; const now = app.clock.now();
    for (const e of await ctx.col('checkpoint_expectations').find({ state: 'pending', windowEnd: { $lt: now - ctx.settings.checkpoints.graceMin * 60000 } }, { limit: 2000 })) {
      const [a, cp] = await Promise.all([ctx.col('duty_assignments').get(e.assignmentId), ctx.col('checkpoints').get(e.checkpointId)]);
      if (now < e.windowEnd + (cp?.graceMin ?? ctx.settings.checkpoints.graceMin) * 60000) continue;
      const started = a && ['started', 'on_break', 'ended', 'system_closed', 'reviewed'].includes(a.status);
      await app.store.transaction(async () => {
        await ctx.col('checkpoint_expectations').update(e._id, { $set: started ? { state: 'missed', missedAt: now } : { state: 'waived', waivedReason: 'duty was not started' } });
        if (started && e.required) await app.services.alerts.raise(ctx, { type: 'missed_checkpoint', subject: e._id, unitId: e.unitId, staffMemberId: e.staffMemberId, assignmentId: e.assignmentId, detail: { checkpointId: e.checkpointId, checkpointName: cp?.name ?? null, windowEnd: new Date(e.windowEnd).toISOString() } });
      });
    }
  });
  app.schedule('realtime.purge', 300, async () => { await app.outbox.purge(); await app.jobs.purgeDone(); }, false);
}
export { attendanceBody };
