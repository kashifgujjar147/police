// Attendance and duty review (FR-ATT-001..007; TS §12.2). Attendance events are append-only; corrections never overwrite.
import { CorrectionMachine, DutyMachine } from '@sf/contracts';
import { checkStart, classifyPoint, coveragePct, type GeofenceShape } from '@sf/domain';
import { App, AppError, Ctx, type Doc, type Route, created, paginate, s, sha256 } from '@sf/kernel';
import { assertNoticeAcknowledged } from '../privacy/index.ts';

const pageQuery = { limit: s.optional(s.number({ int: true, min: 1, max: 200 })), cursor: s.optional(s.string({ max: 300 })) };
const locSchema = s.optional(s.object({ lat: s.lat(), lon: s.lon(), accuracyM: s.number({ min: 0, max: 5000 }), recordedAt: s.optional(s.iso()) }));
export const attendanceBody = { eventId: s.uuid(), occurredAt: s.iso(), sentAt: s.optional(s.iso()), location: locSchema, offline: s.optional(s.boolean()) };

export interface AttendanceInput { eventId: string; type: 'check_in' | 'check_out' | 'break_start' | 'break_end'; assignmentId: string; occurredAt: number; sentAt?: number; location?: { lat: number; lon: number; accuracyM: number } | null; offline?: boolean }
export interface AttendanceResult { status: 'accepted' | 'accepted_with_exception' | 'duplicate'; eventId: string; reasonCodes: string[]; assignmentStatus: string; trackingState: 'open' | 'closed'; trackingSessionId: string | null; profile?: unknown; serverTime: number; clockSkewMs: number | null }

async function ownAssignment(ctx: Ctx, id: string): Promise<Doc> {
  const a = await ctx.col('duty_assignments').get(id);
  if (!a || a.staffMemberId !== ctx.actor.staffMemberId || !a.rosterVersionId) throw new AppError('NOT_FOUND', 'Assignment not found');
  return a;
}
async function geofenceClassAt(ctx: Ctx, postId: string, loc: AttendanceInput['location']) {
  const fences = await ctx.col('geofences').find({ postId, status: 'active' });
  if (!fences.length) return { cls: 'not_configured' as const, fence: null };
  if (!loc) return { cls: 'none' as const, fence: fences[0]! };
  const results = fences.map((f) => classifyPoint(loc, loc.accuracyM, f.geometry as GeofenceShape).cls);
  return { cls: results.includes('inside') ? 'inside' as const : results.includes('uncertain') ? 'uncertain' as const : 'outside' as const, fence: fences[0]! };
}

/**
 * Records one attendance event idempotently and applies its effects in the caller's transaction:
 * duty start = event + assignment state + tracking session + outbox (TS §8.4).
 */
export async function recordAttendance(ctx: Ctx, input: AttendanceInput): Promise<AttendanceResult> {
  const now = ctx.now(); const events = ctx.col('attendance_events');
  const payloadHash = sha256(JSON.stringify([input.type, input.assignmentId, input.occurredAt, input.location?.lat ?? null, input.location?.lon ?? null]));
  const prior = await events.findOne({ eventId: input.eventId });
  if (prior) { // FR-SYN-001: replay returns the original result; the same key with a different payload is a conflict
    if (prior.payloadHash !== payloadHash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This event id was already used for a different event.');
    return { ...(prior.result as AttendanceResult), status: 'duplicate', serverTime: now };
  }
  const a = await ownAssignment(ctx, input.assignmentId);
  const clockSkewMs = input.sentAt !== undefined ? input.sentAt - now : null;
  const skewed = clockSkewMs !== null && Math.abs(clockSkewMs) > ctx.settings.location.skewToleranceSec * 1000;
  const reasons: string[] = []; if (skewed) reasons.push('CLOCK_SKEW');
  // Online events are judged against server time (authoritative); offline events against the preserved device time.
  const at = input.offline ? input.occurredAt : now;
  let tracking: Doc | null = await ctx.col('duty_tracking_sessions').findOne({ assignmentId: a._id, state: 'open' });
  let next = a.status as string;

  if (input.type === 'check_in') {
    if (a.status === 'cancelled') throw new AppError('INVALID_STATE_TRANSITION', 'This assignment was cancelled.', { details: { code: 'ASSIGNMENT_CANCELLED' } });
    DutyMachine.assert(a.status === 'missed' && input.offline ? 'scheduled' : a.status, 'started');
    await assertNoticeAcknowledged(ctx, a.staffMemberId);
    const policy = ctx.settings.duty.geofenceStart; const geo = policy === 'off' ? { cls: 'not_configured' as const } : await geofenceClassAt(ctx, a.postId, input.location);
    const check = checkStart({ at, startsAt: a.startsAt, endsAt: a.endsAt, earlyMin: ctx.settings.duty.earlyMin, lateMin: ctx.settings.duty.lateMin, geofencePolicy: geo.cls === 'not_configured' ? 'off' : policy, geofenceClass: geo.cls === 'not_configured' ? 'none' : geo.cls });
    if (!check.ok) throw new AppError(check.code, check.code === 'GEOFENCE_REQUIRED' ? 'You need to be at the post to start this duty.' : check.reasonCodes[0] === 'TOO_EARLY' ? `Duty can be started from ${ctx.settings.duty.earlyMin} minutes before the shift.` : 'This shift has already ended.', { details: { reasonCodes: check.reasonCodes } });
    reasons.push(...check.reasonCodes); next = 'started';
    await ctx.col('duty_assignments').update(a._id, { $set: { status: 'started', startedAt: input.occurredAt, startReceivedAt: now, startReasonCodes: reasons, updatedAt: now }, $inc: { version: 1 } });
    if (now <= a.endsAt + ctx.settings.duty.autoCloseGraceMin * 60000) tracking = await ctx.app.services.tracking.open(ctx, a);
    await ctx.emit('duty:started', { unitId: a.unitId, staffId: a.staffMemberId, needs: 'assignment.read' }, { assignmentId: a._id, staffMemberId: a.staffMemberId, occurredAt: new Date(input.occurredAt).toISOString() }, input.occurredAt);
    await ctx.app.services.alerts.resolveFor(ctx, 'late_start', a._id);
  } else if (input.type === 'check_out') {
    DutyMachine.assert(a.status, 'ended'); next = 'ended';
    await ctx.col('duty_assignments').update(a._id, { $set: { status: 'ended', endedAt: input.occurredAt, endReceivedAt: now, updatedAt: now }, $inc: { version: 1 } });
    if (tracking) { await ctx.app.services.tracking.close(ctx, tracking, 'duty_end'); tracking = null; }
    await ctx.emit('duty:ended', { unitId: a.unitId, staffId: a.staffMemberId, needs: 'assignment.read' }, { assignmentId: a._id, staffMemberId: a.staffMemberId, occurredAt: new Date(input.occurredAt).toISOString(), systemClosed: false }, input.occurredAt);
    await ctx.app.services.alerts.resolveFor(ctx, 'missed_check_out', a._id);
  } else {
    const to = input.type === 'break_start' ? 'on_break' : 'started';
    DutyMachine.assert(a.status, to); next = to;
    if (input.type === 'break_start') {
      const taken = await events.count({ assignmentId: a._id, type: 'break_start' });
      if (a.breakPolicy?.maxBreaks !== undefined && taken >= a.breakPolicy.maxBreaks) reasons.push('BREAK_COUNT_EXCEEDED');
    }
    await ctx.col('duty_assignments').update(a._id, { $set: { status: to, updatedAt: now }, $inc: { version: 1 } });
    if (tracking) tracking = await ctx.col('duty_tracking_sessions').update(tracking._id, { $set: { onBreak: to === 'on_break', breakSince: to === 'on_break' ? input.occurredAt : null, profile: ctx.app.services.tracking.profile(ctx, to === 'on_break') } });
    await ctx.emit('staff:statusChanged', { unitId: a.unitId, staffId: a.staffMemberId, needs: 'assignment.read' }, { staffMemberId: a.staffMemberId, assignmentId: a._id, state: to, occurredAt: new Date(input.occurredAt).toISOString() }, input.occurredAt);
  }
  const result: AttendanceResult = { status: reasons.length ? 'accepted_with_exception' : 'accepted', eventId: input.eventId, reasonCodes: reasons, assignmentStatus: next, trackingState: tracking ? 'open' : 'closed', trackingSessionId: tracking?._id ?? null, profile: tracking?.profile, serverTime: now, clockSkewMs };
  await events.insert({ eventId: input.eventId, assignmentId: a._id, staffMemberId: a.staffMemberId, unitId: a.unitId, deviceId: ctx.actor.deviceId ?? null, type: input.type, occurredAt: input.occurredAt, receivedAt: now, clockSkewMs,
    actor: { id: ctx.actor.userId, type: 'staff' }, source: input.offline ? 'device_offline' : 'device', lat: input.location?.lat ?? null, lon: input.location?.lon ?? null, accuracyM: input.location?.accuracyM ?? null,
    validation: { status: result.status, reasonCodes: reasons }, pendingSyncAtCapture: !!input.offline, payloadHash, result });
  await ctx.app.services.location.refreshState(ctx, a.staffMemberId);
  if (input.type === 'check_out') await buildSummary(ctx, (await ctx.col('duty_assignments').get(a._id))!);
  return result;
}

/** System close at shift end + grace (policy auto_close). Labelled system-closed; never overwrites staff events (FR-ATT-004). */
export async function systemClose(ctx: Ctx, a: Doc) {
  const now = ctx.now(); DutyMachine.assert(a.status, 'system_closed');
  await ctx.col('attendance_events').insert({ eventId: `sys-close-${a._id}`, assignmentId: a._id, staffMemberId: a.staffMemberId, unitId: a.unitId, deviceId: null, type: 'system_close', occurredAt: a.endsAt + ctx.settings.duty.autoCloseGraceMin * 60000, receivedAt: now, clockSkewMs: null, actor: { id: 'system:auto-close', type: 'system' }, source: 'system', validation: { status: 'accepted', reasonCodes: ['SYSTEM_CLOSED'] }, payloadHash: '', result: null });
  await ctx.col('duty_assignments').update(a._id, { $set: { status: 'system_closed', systemClosed: true, endedAt: a.endsAt + ctx.settings.duty.autoCloseGraceMin * 60000, updatedAt: now }, $inc: { version: 1 } });
  for (const ts of await ctx.col('duty_tracking_sessions').find({ assignmentId: a._id, state: 'open' })) await ctx.app.services.tracking.close(ctx, ts, 'auto_close');
  await ctx.emit('duty:ended', { unitId: a.unitId, staffId: a.staffMemberId, needs: 'assignment.read' }, { assignmentId: a._id, staffMemberId: a.staffMemberId, occurredAt: new Date(now).toISOString(), systemClosed: true });
  await ctx.app.services.location.refreshState(ctx, a.staffMemberId);
  await buildSummary(ctx, (await ctx.col('duty_assignments').get(a._id))!);
}

/** Duty summary computed from underlying events; every value carries a basis label (FR-ATT-006). */
export async function buildSummary(ctx: Ctx, a: Doc): Promise<Doc> {
  const [events, expectations, scans, points, sessions, alerts, gaps] = await Promise.all([
    ctx.col('attendance_events').find({ assignmentId: a._id }, { sort: { occurredAt: 1 } }), ctx.col('checkpoint_expectations').find({ assignmentId: a._id }), ctx.col('checkpoint_scans').find({ assignmentId: a._id }),
    ctx.col('location_points').find({ assignmentId: a._id }, { sort: { recordedAt: 1 }, limit: 20000 }), ctx.col('duty_tracking_sessions').find({ assignmentId: a._id }), ctx.col('alerts').find({ assignmentId: a._id }), ctx.col('sync_rejections').find({ assignmentId: a._id }),
  ]);
  const of = (t: string) => events.filter((e) => e.type === t);
  const effective = (type: 'check_in' | 'check_out') => { const corr = events.filter((e) => e.type === 'correction' && e.correctedType === type).pop(); const orig = of(type)[0]; return corr ? { at: corr.occurredAt as number, basis: 'estimated' as const, corrected: true } : orig ? { at: orig.occurredAt as number, basis: 'measured' as const, corrected: false } : null; };
  const start = effective('check_in'); const sys = of('system_close')[0];
  const end = effective('check_out') ?? (sys ? { at: sys.occurredAt as number, basis: 'system_flag' as const, corrected: false } : null);
  const bs = of('break_start'), be = of('break_end');
  const breaks = bs.map((b, i) => ({ from: b.occurredAt as number, to: (be[i]?.occurredAt as number | undefined) ?? end?.at ?? null }));
  const breakMinutes = Math.round(breaks.reduce((n, b) => n + (b.to ? b.to - b.from : 0), 0) / 60000);
  const trackedTo = end?.at ?? Math.min(ctx.now(), a.endsAt);
  const cov = start ? coveragePct(points.map((p) => ({ at: p.recordedAt, accuracyM: p.accuracyM })), start.at, trackedTo, ctx.settings.location.minAccuracyM, breaks.filter((b) => b.to).map((b) => ({ from: b.from, to: b.to! }))) : null;
  const byResult: Record<string, number> = {}; for (const sc of scans) byResult[sc.result] = (byResult[sc.result] ?? 0) + 1;
  const exp = { expected: expectations.filter((e) => e.required).length, completed: expectations.filter((e) => e.state === 'completed').length, missed: expectations.filter((e) => e.state === 'missed').length, pending: expectations.filter((e) => e.state === 'pending').length, waived: expectations.filter((e) => e.state === 'waived').length };
  const exceptions = [...new Set([...events.flatMap((e) => (e.validation?.reasonCodes as string[]) ?? []), ...alerts.map((al) => `ALERT_${String(al.type).toUpperCase()}`)])];
  const missing: string[] = [];
  if (!start) missing.push('no duty start recorded'); if (start && !effective('check_out')) missing.push(sys ? 'no check-out by staff member (system-closed)' : 'no check-out recorded');
  if (start && !sessions.length) missing.push('no tracking session (duty started after the tracking window or offline)');
  if (start && cov === null) missing.push('location coverage could not be computed'); else if (cov !== null && cov < 50) missing.push('location coverage below 50% — treat gaps as unknown, not as absence');
  if (exp.missed) missing.push(`${exp.missed} required checkpoint(s) without a valid scan`);
  if (gaps.length) missing.push(`${gaps.length} event(s) rejected at sync and awaiting resolution`);
  const summary = {
    assignmentId: a._id, staffMemberId: a.staffMemberId, unitId: a.unitId,
    scheduled: { startsAt: a.startsAt, endsAt: a.endsAt, minutes: Math.round((a.endsAt - a.startsAt) / 60000), basis: 'measured' },
    actual: { startedAt: start?.at ?? null, endedAt: end?.at ?? null, minutes: start && end ? Math.round((end.at - start.at) / 60000) : null, startBasis: start?.basis ?? 'unknown', endBasis: end?.basis ?? 'unknown', systemClosed: !!sys && !effective('check_out') },
    breaks: { count: breaks.length, minutes: breakMinutes, basis: breaks.every((b) => b.to) ? 'measured' : 'estimated' },
    checkpointResults: { ...exp, scansByResult: byResult, basis: 'measured' },
    coverage: { pct: cov, points: points.length, basis: cov === null ? 'unknown' : 'measured', note: 'Share of tracked minutes with at least one point within the accuracy ceiling. Gaps mean unknown, not absent.' },
    exceptions, missingEvidence: missing, reviewSignals: [...new Set(points.flatMap((p) => (p.signals as { signal: string }[] ?? []).map((x) => x.signal)))], builtAt: ctx.now(),
  };
  const cur = await ctx.col('duty_summaries').findOne({ assignmentId: a._id });
  if (cur?.locked) return cur; // approved summaries change only through an approved correction (which unlocks and rebuilds)
  return cur ? (await ctx.col('duty_summaries').update(cur._id, { $set: summary, $inc: { version: 1 } }))! : ctx.col('duty_summaries').insert({ ...summary, version: 1, locked: false });
}

const routes: Route[] = [
  {
    method: 'POST', path: '/assignments/:id/start', permission: 'duty.own', scope: 'own', audit: 'duty.start', rate: 'mutation', deviceBound: true, summary: 'Start duty: validates assignment, window, device, notice and geofence policy; opens the Tracking Session', reqs: ['FR-ATT-001', 'FR-ATT-002', 'FR-LOC-001', 'FR-PRV-002', 'FR-SYN-001'], body: s.object(attendanceBody),
    async handler(ctx, { params, body }) { ctx.setAudit({ resource: { type: 'assignment', id: params.id } }); const r = await recordAttendance(ctx, { eventId: body.eventId, type: 'check_in', assignmentId: params.id!, occurredAt: Date.parse(body.occurredAt), sentAt: body.sentAt ? Date.parse(body.sentAt) : undefined, location: body.location, offline: body.offline }); ctx.setAudit({ detail: { status: r.status, reasonCodes: r.reasonCodes } }); return r; },
  },
  {
    method: 'POST', path: '/assignments/:id/end', permission: 'duty.own', scope: 'own', audit: 'duty.end', rate: 'mutation', deviceBound: true, whenInactive: 'safety', summary: 'End duty: records check-out and closes the Tracking Session', reqs: ['FR-ATT-001', 'FR-LOC-001', 'FR-SUB-001'], body: s.object(attendanceBody),
    async handler(ctx, { params, body }) { ctx.setAudit({ resource: { type: 'assignment', id: params.id } }); return recordAttendance(ctx, { eventId: body.eventId, type: 'check_out', assignmentId: params.id!, occurredAt: Date.parse(body.occurredAt), sentAt: body.sentAt ? Date.parse(body.sentAt) : undefined, location: body.location, offline: body.offline }); },
  },
  {
    method: 'POST', path: '/attendance/events', permission: 'duty.own', scope: 'own', audit: 'attendance.break', rate: 'mutation', deviceBound: true, summary: 'Break start / break end as separate, auditable events', reqs: ['FR-ATT-003'], body: s.object({ ...attendanceBody, assignmentId: s.id(), type: s.enum(['break_start', 'break_end']) }),
    async handler(ctx, { body }) { ctx.setAudit({ action: `attendance.${body.type}`, resource: { type: 'assignment', id: body.assignmentId } }); return recordAttendance(ctx, { eventId: body.eventId, type: body.type, assignmentId: body.assignmentId, occurredAt: Date.parse(body.occurredAt), sentAt: body.sentAt ? Date.parse(body.sentAt) : undefined, location: body.location, offline: body.offline }); },
  },
  {
    method: 'GET', path: '/attendance/events', permission: 'attendance.read', scope: 'unit', audit: { none: 'attendance read within scope' }, rate: 'read', summary: 'Attendance events within scope (device time and server receipt time both shown)', reqs: ['FR-ATT-001', 'FR-ATT-005'],
    query: s.object({ ...pageQuery, assignmentId: s.optional(s.id()), staffMemberId: s.optional(s.id()), from: s.optional(s.iso()), to: s.optional(s.iso()) }),
    async handler(ctx, { query }) {
      const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') };
      if (query.assignmentId) f.assignmentId = query.assignmentId; if (query.staffMemberId) f.staffMemberId = query.staffMemberId;
      if (query.from || query.to) f.receivedAt = { ...(query.from ? { $gte: Date.parse(query.from) } : {}), ...(query.to ? { $lte: Date.parse(query.to) } : {}) };
      const page = await paginate(ctx.col('attendance_events'), f, query, 'receivedAt', -1);
      return { ...page, items: page.items.map(({ payloadHash: _p, result: _r, lat: _a, lon: _b, ...e }) => ({ ...e, hasLocation: _a !== null && _a !== undefined })) };
    },
  },
  {
    method: 'POST', path: '/corrections', permission: 'correction.request', scope: 'own', audit: 'attendance.correction.request', rate: 'mutation', summary: 'Staff member requests a correction with a reason', reqs: ['FR-ATT-005'],
    body: s.object({ assignmentId: s.id(), proposed: s.object({ type: s.enum(['check_in', 'check_out']), occurredAt: s.iso() }), reason: s.string({ min: 5, max: 1000 }), refEventId: s.optional(s.string({ max: 80 })) }),
    async handler(ctx, { body }) {
      const a = await ownAssignment(ctx, body.assignmentId);
      const at = Date.parse(body.proposed.occurredAt);
      if (at > ctx.now() + 60000 || at < a.startsAt - 12 * 3600000 || at > a.endsAt + 24 * 3600000) throw new AppError('VALIDATION_FAILED', 'The proposed time must be near the shift and not in the future.', { fieldErrors: [{ path: 'proposed.occurredAt', code: 'OUT_OF_RANGE', message: 'is not near this shift' }] });
      const ref = body.refEventId ? await ctx.col('attendance_events').findOne({ eventId: body.refEventId, assignmentId: a._id }) : await ctx.col('attendance_events').findOne({ assignmentId: a._id, type: body.proposed.type });
      const c = await ctx.col('correction_requests').insert({ assignmentId: a._id, staffMemberId: a.staffMemberId, unitId: a.unitId, requestedBy: ctx.actor.userId, proposed: { type: body.proposed.type, occurredAt: at }, reason: body.reason, refEventId: ref?.eventId ?? null, state: 'pending', createdAt: ctx.now(), version: 1 });
      if (a.supervisorId) await ctx.app.services.notify.staff(ctx, a.supervisorId, { template: 'correction_requested', refType: 'correction', refId: c._id });
      ctx.setAudit({ resource: { type: 'correction', id: c._id }, reason: body.reason });
      return created(c);
    },
  },
  {
    method: 'GET', path: '/corrections', permission: 'session', scope: 'own', audit: { none: 'correction list read' }, rate: 'read', summary: 'Correction requests: own, or within scope for reviewers', reqs: ['FR-ATT-005'], query: s.object({ ...pageQuery, state: s.optional(s.enum(['pending', 'approved', 'rejected', 'returned'])) }),
    async handler(ctx, { query }) {
      const f: Record<string, unknown> = ctx.can('attendance.read') ? { ...ctx.scopeFilter('unitId') } : { staffMemberId: ctx.actor.staffMemberId ?? '-' };
      if (query.state) f.state = query.state;
      return paginate(ctx.col('correction_requests'), f, query, 'createdAt', -1);
    },
  },
  {
    method: 'POST', path: '/corrections/:id/resubmit', permission: 'correction.request', scope: 'own', audit: 'attendance.correction.resubmit', rate: 'mutation', summary: 'Resubmit a returned correction with clarification', reqs: ['FR-ATT-005'], body: s.object({ reason: s.string({ min: 5, max: 1000 }) }),
    async handler(ctx, { params, body }) {
      const c = await ctx.col('correction_requests').must(params.id!, 'Correction'); if (c.staffMemberId !== ctx.actor.staffMemberId) throw new AppError('NOT_FOUND', 'Correction not found');
      CorrectionMachine.assert(c.state, 'pending');
      const out = await ctx.col('correction_requests').update(c._id, { $set: { state: 'pending', reason: body.reason, resubmittedAt: ctx.now() }, $inc: { version: 1 } });
      ctx.setAudit({ resource: { type: 'correction', id: c._id }, reason: body.reason }); return out;
    },
  },
  {
    method: 'POST', path: '/corrections/:id/review', permission: 'attendance.correct', scope: 'unit', audit: 'attendance.correction.review', rate: 'mutation', summary: 'Approve, reject or return a correction; approval appends a correction event referencing the original', reqs: ['FR-ATT-005'],
    body: s.object({ decision: s.enum(['approve', 'reject', 'return']), note: s.string({ min: 3, max: 1000 }) }),
    async handler(ctx, { params, body }) {
      const c = await ctx.col('correction_requests').must(params.id!, 'Correction'); ctx.assertScope(c.unitId, 'Correction');
      if (c.staffMemberId === ctx.actor.staffMemberId) throw new AppError('FORBIDDEN', 'You cannot review your own correction request.');
      const to = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : 'returned';
      CorrectionMachine.assert(c.state, to);
      await ctx.col('correction_requests').update(c._id, { $set: { state: to, reviewedBy: ctx.actor.userId, reviewedAt: ctx.now(), reviewNote: body.note }, $inc: { version: 1 } });
      if (to === 'approved') {
        // The original event is never edited: a new 'correction' event references it.
        await ctx.col('attendance_events').insert({ eventId: `corr-${c._id}`, assignmentId: c.assignmentId, staffMemberId: c.staffMemberId, unitId: c.unitId, deviceId: null, type: 'correction', correctedType: c.proposed.type, occurredAt: c.proposed.occurredAt, receivedAt: ctx.now(), clockSkewMs: null,
          actor: { id: ctx.actor.userId, type: 'reviewer' }, source: 'correction', reason: c.reason, refEventId: c.refEventId, correctionRequestId: c._id, validation: { status: 'accepted', reasonCodes: ['CORRECTION'] }, payloadHash: '', result: null });
        const a = (await ctx.col('duty_assignments').get(c.assignmentId))!;
        await ctx.col('duty_summaries').updateMany({ assignmentId: a._id }, { $set: { locked: false } });
        await buildSummary(ctx, a);
      }
      await ctx.app.services.notify.staff(ctx, c.staffMemberId, { template: `correction_${to}`, refType: 'correction', refId: c._id });
      ctx.setAudit({ action: `attendance.correction.${body.decision}`, resource: { type: 'correction', id: c._id }, reason: body.note, before: { state: c.state }, after: { state: to } });
      return ctx.col('correction_requests').get(c._id);
    },
  },
  {
    method: 'GET', path: '/assignments/:id/summary', permission: 'session', scope: 'own', audit: { none: 'duty summary read' }, rate: 'read', summary: 'Duty summary: scheduled vs actual, breaks, checkpoints, exceptions, coverage and missing evidence, each basis-labelled', reqs: ['FR-ATT-006'],
    async handler(ctx, { params }) {
      const a = await ctx.col('duty_assignments').must(params.id!, 'Assignment');
      if (!(a.staffMemberId === ctx.actor.staffMemberId && a.rosterVersionId) && !(ctx.can('attendance.read') && ctx.inScope(a.unitId))) throw new AppError('NOT_FOUND', 'Assignment not found');
      const summary = await ctx.app.store.transaction(() => buildSummary(ctx, a));
      return { ...summary, status: a.status, reviewState: a.reviewState ?? null, reviewedBy: a.reviewedBy ?? null, reviewedAt: a.reviewedAt ?? null, reviewComment: a.reviewComment ?? null };
    },
  },
  {
    method: 'POST', path: '/assignments/:id/review', permission: 'attendance.review', scope: 'unit', audit: 'attendance.review', rate: 'mutation', summary: 'Supervisor review of a completed duty: approve (locks the summary) or return for clarification', reqs: ['FR-ATT-007'],
    body: s.object({ decision: s.enum(['approve', 'return']), comment: s.string({ min: 3, max: 1000 }), attachmentFileIds: s.optional(s.array(s.id(), { max: 5 })) }),
    async handler(ctx, { params, body }) {
      const a = await ctx.col('duty_assignments').must(params.id!, 'Assignment'); ctx.assertScope(a.unitId, 'Assignment');
      if (a.staffMemberId === ctx.actor.staffMemberId) throw new AppError('FORBIDDEN', 'You cannot review your own duty.');
      if (body.decision === 'approve') {
        DutyMachine.assert(a.status, 'reviewed');
        await buildSummary(ctx, a);
        await ctx.col('duty_assignments').update(a._id, { $set: { status: 'reviewed', statusBeforeReview: a.status, reviewState: 'approved', reviewedBy: ctx.actor.userId, reviewedAt: ctx.now(), reviewComment: body.comment, reviewAttachmentFileIds: body.attachmentFileIds ?? [] }, $inc: { version: 1 } });
        await ctx.col('duty_summaries').updateMany({ assignmentId: a._id }, { $set: { locked: true, lockedAt: ctx.now() } });
      } else {
        if (!['ended', 'system_closed', 'reviewed'].includes(a.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Only a completed duty can be returned for clarification.');
        await ctx.col('duty_assignments').update(a._id, { $set: { status: a.status === 'reviewed' ? a.statusBeforeReview ?? 'ended' : a.status, reviewState: 'returned', reviewedBy: ctx.actor.userId, reviewedAt: ctx.now(), reviewComment: body.comment }, $inc: { version: 1 } });
        await ctx.col('duty_summaries').updateMany({ assignmentId: a._id }, { $set: { locked: false } });
        await ctx.app.services.notify.staff(ctx, a.staffMemberId, { template: 'duty_returned_for_clarification', refType: 'assignment', refId: a._id });
      }
      ctx.setAudit({ action: `attendance.review.${body.decision}`, resource: { type: 'assignment', id: a._id }, reason: body.comment, before: { status: a.status, reviewState: a.reviewState ?? null } });
      return ctx.col('duty_assignments').get(a._id);
    },
  },
];
export function registerAttendance(app: App) { app.register('attendance', routes); app.services.attendance = { recordAttendance, systemClose, buildSummary }; }
