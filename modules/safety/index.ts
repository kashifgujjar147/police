// Safety: alert rules and lifecycle, escalation, SOS and incidents (FR-ALR-001..005, FR-SOS-001..004, FR-INC-001..005; TS §15–§16).
import { ALERT_TYPES, AlertMachine, type AlertType, IncidentMachine, type IncidentStatus, SosDeliveryMachine } from '@sf/contracts';
import { alertDedupeKey } from '@sf/domain';
import { App, AppError, Ctx, type Doc, type Route, created, paginate, s } from '@sf/kernel';
import { systemClose } from '../attendance/index.ts';

const pageQuery = { limit: s.optional(s.number({ int: true, min: 1, max: 200 })), cursor: s.optional(s.string({ max: 300 })) };
const ACTIVE_INCIDENT: IncidentStatus[] = ['new', 'acknowledged', 'dispatched', 'on_scene', 'reopened'];

// ---------------- alerts ----------------
interface RaiseInput { type: AlertType; subject: string; window?: string; unitId: string | null; staffMemberId?: string | null; assignmentId?: string | null; incidentId?: string | null; detail?: Record<string, unknown> }
async function timeline(ctx: Ctx, alertId: string, type: string, detail: Record<string, unknown> = {}) { await ctx.col('alert_timeline').insert({ alertId, at: ctx.now(), type, actorId: ctx.actor.userId, detail }); }
async function recipientsFor(ctx: Ctx, groups: string[], alert: Doc, n: { template: string; dedupeKey: string; critical?: boolean }): Promise<number> {
  let count = await ctx.app.services.notify.roles(ctx, groups, { ...n, refType: alert.incidentId ? 'incident' : 'alert', refId: alert.incidentId ?? alert._id, unitId: alert.unitId });
  if (groups.includes('supervisor') && alert.assignmentId) { // the assignment's own supervisor is always in the supervisor group
    const a = await ctx.col('duty_assignments').get(alert.assignmentId);
    if (a?.supervisorId && (await ctx.app.services.notify.staff(ctx, a.supervisorId, { ...n, refType: alert.incidentId ? 'incident' : 'alert', refId: alert.incidentId ?? alert._id }))) count++;
  }
  return count;
}
/** Idempotent: an active alert with the same type|subject|window is updated (occurrence count), not duplicated (FR-ALR-002). */
async function raise(ctx: Ctx, input: RaiseInput): Promise<{ alert: Doc; created: boolean; notified: number } | null> {
  const rule = await ctx.col('alert_rules').findOne({ type: input.type });
  if (!rule || !rule.enabled) return null;
  const now = ctx.now(); const key = alertDedupeKey(input.type, input.subject, input.window ?? '');
  const existing = await ctx.col('alerts').findOne({ openDedupeKey: key });
  if (existing) {
    const alert = (await ctx.col('alerts').update(existing._id, { $set: { lastAt: now }, $inc: { count: 1 } }))!;
    return { alert, created: false, notified: 0 };
  }
  const alert = await ctx.col('alerts').insert({ ruleId: rule._id, type: input.type, severity: rule.severity, dedupeKey: key, openDedupeKey: key, subject: input.subject, unitId: input.unitId, staffMemberId: input.staffMemberId ?? null, assignmentId: input.assignmentId ?? null, incidentId: input.incidentId ?? null,
    state: 'open', firstAt: now, lastAt: now, count: 1, detail: input.detail ?? {}, recipientGroups: rule.recipientGroups, escalationPolicyId: rule.escalationPolicyId ?? null, escalationStep: 0, snoozedUntil: null, ackBy: null, ackAt: null });
  await timeline(ctx, alert._id, 'created', { severity: rule.severity });
  const notified = await recipientsFor(ctx, rule.recipientGroups, alert, { template: input.type === 'sos' ? 'sos_created' : 'alert_created', dedupeKey: `alert:${alert._id}:created`, critical: rule.severity === 'critical' });
  const policy = rule.escalationPolicyId ? await ctx.col('escalation_policies').get(rule.escalationPolicyId) : null;
  for (const [i, step] of ((policy?.steps ?? []) as Doc[]).entries()) await ctx.enqueue('alert.escalate', { alertId: alert._id, step: i }, { delaySec: step.afterSec, queue: input.type === 'sos' ? 'critical' : 'alerts', dedupeKey: `esc:${alert._id}:${i}` });
  if (input.type !== 'sos') await ctx.emit('alert:created', { unitId: alert.unitId, needs: 'alert.read' }, { alertId: alert._id, type: alert.type, severity: alert.severity, staffMemberId: alert.staffMemberId, state: 'open', occurredAt: new Date(now).toISOString() });
  if (alert.staffMemberId) await ctx.app.services.location.refreshState(ctx, alert.staffMemberId);
  ctx.app.metrics.inc('sf_alerts_total', { type: input.type });
  return { alert, created: true, notified };
}
async function setAlertState(ctx: Ctx, alert: Doc, to: 'acknowledged' | 'snoozed' | 'resolved' | 'auto_resolved' | 'open', extra: Record<string, unknown>, reason: string | null) {
  AlertMachine.assert(alert.state, to);
  const closing = to === 'resolved' || to === 'auto_resolved';
  const out = (await ctx.col('alerts').update(alert._id, { $set: { state: to, ...extra, ...(closing ? { resolvedAt: ctx.now() } : {}) }, ...(closing ? { $unset: ['openDedupeKey'] } : {}) }))!;
  await timeline(ctx, alert._id, to, { reason });
  await ctx.emit('alert:updated', { unitId: alert.unitId, needs: 'alert.read' }, { alertId: alert._id, type: alert.type, state: to, staffMemberId: alert.staffMemberId, occurredAt: new Date(ctx.now()).toISOString() });
  if (alert.staffMemberId) await ctx.app.services.location.refreshState(ctx, alert.staffMemberId);
  return out;
}
/** Auto-resolve when the condition clears (FR-ALR-003), keeping the full timeline. */
async function resolveFor(ctx: Ctx, type: AlertType, subject: string) {
  for (const a of await ctx.col('alerts').find({ type, subject, state: { $in: ['open', 'acknowledged', 'snoozed'] } })) await setAlertState(ctx, a, 'auto_resolved', {}, 'condition cleared');
}
async function onBattery(ctx: Ctx, ref: { unitId: string | null; staffMemberId: string; deviceId?: string | null; assignmentId?: string | null }, battery: number) {
  const rule = await ctx.col('alert_rules').findOne({ type: 'low_battery' }); if (!rule?.enabled) return;
  const subject = ref.deviceId ?? ref.staffMemberId;
  if (battery <= (rule.thresholds.percent ?? 15)) await raise(ctx, { type: 'low_battery', subject, unitId: ref.unitId, staffMemberId: ref.staffMemberId, assignmentId: ref.assignmentId ?? null, detail: { battery } });
  else if (battery > (rule.thresholds.percent ?? 15) + 5) await resolveFor(ctx, 'low_battery', subject);
}
async function onHeartbeat(ctx: Ctx, device: Doc, hb: { battery?: number }) {
  await resolveFor(ctx, 'device_offline', device._id);
  const ts = await ctx.col('duty_tracking_sessions').findOne({ deviceId: device._id, state: 'open' });
  if (hb.battery !== undefined && ts) await onBattery(ctx, { unitId: ts.unitId, staffMemberId: ts.staffMemberId, deviceId: device._id, assignmentId: ts.assignmentId }, hb.battery);
}
async function onGeofenceEvent(ctx: Ctx, ts: Doc, fence: Doc, ev: Doc) {
  if (!fence.requiredDuringDuty) return;
  if (ev.type === 'entered') { await resolveFor(ctx, 'geofence_exception', `${ts.assignmentId}:${fence._id}`); return; }
  const rule = await ctx.col('alert_rules').findOne({ type: 'geofence_exception' }); if (!rule?.enabled) return;
  if (ev.accuracyM > (rule.thresholds.maxAccuracyM ?? 50)) return; // poor-accuracy exits never raise an exception
  await ctx.enqueue('geofence.outside.check', { assignmentId: ts.assignmentId, geofenceId: fence._id, eventId: ev._id }, { delaySec: (rule.thresholds.outsideMin ?? 5) * 60, queue: 'alerts', dedupeKey: `geo-out:${ev._id}` });
}

// ---------------- incidents and SOS ----------------
async function incTimeline(ctx: Ctx, incidentId: string, type: string, detail: Record<string, unknown> = {}, attachmentFileIds: string[] = []) {
  await ctx.col('incident_timeline').insert({ incidentId, at: ctx.now(), type, actor: { id: ctx.actor.userId, type: ctx.actor.type }, detail, attachmentFileIds });
}
async function nextNumber(ctx: Ctx): Promise<string> { const year = new Date(ctx.now()).getUTCFullYear(); return `INC-${year}-${String(await ctx.repo.counter('incident', String(year))).padStart(6, '0')}`; }
function incidentView(ctx: Ctx, inc: Doc) { const { lat, lon, accuracyM, ...rest } = inc; return ctx.can('incident.read') || inc.reportedByUserId === ctx.actor.userId ? inc : { ...rest }; }
async function unitFor(ctx: Ctx, staffId: string | null, assignmentId?: string): Promise<{ unitId: string | null; assignment: Doc | null }> {
  const a = assignmentId ? await ctx.col('duty_assignments').findOne({ _id: assignmentId, staffMemberId: staffId }) : staffId ? (await ctx.col('duty_assignments').find({ staffMemberId: staffId, status: { $in: ['started', 'on_break'] } }, { limit: 1 }))[0] ?? null : null;
  if (a) return { unitId: a.unitId, assignment: a };
  const st = staffId ? await ctx.col('staff_members').get(staffId) : null;
  return { unitId: st?.homeUnitId ?? null, assignment: null };
}
interface IncidentInput { eventId?: string; typeKey: string; severity?: string; description: string; location?: { lat: number; lon: number; accuracyM: number } | null; assignmentId?: string; occurredAt?: number; attachmentFileIds?: string[]; offline?: boolean }
async function createIncident(ctx: Ctx, input: IncidentInput) {
  if (input.eventId) { const prior = await ctx.col('incidents').findOne({ clientEventId: input.eventId }); if (prior) return { status: 'duplicate', incidentId: prior._id, number: prior.number, incidentStatus: prior.status }; }
  const cat = await ctx.col('catalogue_entries').findOne({ kind: 'incidentType', key: input.typeKey });
  if (!cat || cat.archived) throw new AppError('VALIDATION_FAILED', 'Unknown incident type.', { fieldErrors: [{ path: 'typeKey', code: 'UNKNOWN', message: 'is not an active incident type' }] });
  if (!input.description.trim()) throw new AppError('VALIDATION_FAILED', 'A description is required.', { fieldErrors: [{ path: 'description', code: 'REQUIRED', message: 'is required' }] });
  const { unitId, assignment } = await unitFor(ctx, ctx.actor.staffMemberId ?? null, input.assignmentId);
  const now = ctx.now();
  const inc = await ctx.col('incidents').insert({ number: await nextNumber(ctx), kind: 'incident', typeKey: cat.key, severity: input.severity ?? cat.severityDefault, status: 'new', description: input.description.slice(0, 4000), unitId, postId: assignment?.postId ?? null, assignmentId: assignment?._id ?? null,
    reportedByUserId: ctx.actor.userId, reportedByStaffId: ctx.actor.staffMemberId ?? null, responderStaffIds: [], lat: input.location?.lat ?? null, lon: input.location?.lon ?? null, accuracyM: input.location?.accuracyM ?? null, occurredAt: input.occurredAt ?? now, createdAt: now, updatedAt: now, ...(input.eventId ? { clientEventId: input.eventId } : {}), attachmentFileIds: input.attachmentFileIds ?? [], version: 1 });
  await incTimeline(ctx, inc._id, 'created', { typeKey: cat.key, severity: inc.severity, offline: !!input.offline }, input.attachmentFileIds ?? []);
  await ctx.app.services.notify.roles(ctx, ['dispatcher', 'supervisor'], { template: 'incident_updated', refType: 'incident', refId: inc._id, unitId, dedupeKey: `inc:${inc._id}:created` });
  await ctx.emit('incident:updated', { unitId, needs: 'incident.read' }, { incidentId: inc._id, number: inc.number, status: 'new', severity: inc.severity, kind: 'incident', occurredAt: new Date(now).toISOString() });
  return { status: 'accepted', incidentId: inc._id, number: inc.number, incidentStatus: 'new' };
}

interface SosInput { eventId: string; occurredAt: number; sentAt?: number; location?: { lat: number; lon: number; accuracyM: number } | null; assignmentId?: string; note?: string; offline?: boolean }
/** One transaction: SOS event + critical incident + alert + notifications + escalation jobs + outbox (TS §16.2). Duplicates never create a second incident. */
async function raiseSos(ctx: Ctx, input: SosInput) {
  const now = ctx.now(); const staffId = ctx.actor.staffMemberId ?? null;
  const prior = await ctx.col('sos_events').findOne({ eventId: input.eventId });
  if (prior) { const inc = (await ctx.col('incidents').get(prior.incidentId))!; return { status: 'duplicate', eventId: prior.eventId, incidentId: inc._id, number: inc.number, deliveryState: prior.deliveryState, receivedAt: prior.receivedAt, incidentStatus: inc.status, fallback: fallback(ctx) }; }
  const { unitId, assignment } = await unitFor(ctx, staffId, input.assignmentId);
  if (!assignment && !ctx.settings.sos.outOfDuty && ctx.actor.roleKeys.every((r) => r === 'field')) throw new AppError('FORBIDDEN', 'Your organisation allows SOS only while on duty. Call your control room or the local emergency number.');
  const state = staffId ? await ctx.col('staff_location_states').findOne({ staffMemberId: staffId }) : null;
  const loc = input.location ? { ...input.location, at: input.occurredAt, source: 'device_at_trigger' } : state?.lat !== undefined && state?.lat !== null ? { lat: state.lat, lon: state.lon, accuracyM: state.accuracyM, at: state.recordedAt, source: 'last_known' } : null;
  const recent = staffId ? await ctx.col('sos_events').count({ staffMemberId: staffId, receivedAt: { $gte: now - 86400000 } }) : 0;
  const inc = await ctx.col('incidents').insert({ number: await nextNumber(ctx), kind: 'sos', typeKey: 'personal_safety', severity: 'critical', status: 'new', description: input.note?.slice(0, 1000) ?? 'SOS raised', unitId, postId: assignment?.postId ?? null, assignmentId: assignment?._id ?? null,
    reportedByUserId: ctx.actor.userId, reportedByStaffId: staffId, responderStaffIds: [], lat: loc?.lat ?? null, lon: loc?.lon ?? null, accuracyM: loc?.accuracyM ?? null, locationAt: loc?.at ?? null, locationSource: loc?.source ?? 'none', occurredAt: input.occurredAt, createdAt: now, updatedAt: now, clientEventId: input.eventId, attachmentFileIds: [], abuseFlag: recent >= ctx.settings.sos.abuseThreshold, version: 1 });
  let sos = await ctx.col('sos_events').insert({ eventId: input.eventId, incidentId: inc._id, staffMemberId: staffId, userId: ctx.actor.userId, deviceId: ctx.actor.deviceId ?? null, unitId, triggeredAt: input.occurredAt, receivedAt: now, queuedOffline: !!input.offline, clockSkewMs: input.sentAt !== undefined ? input.sentAt - now : null, deliveryState: 'received_by_server', lastKnownLocation: loc, notifiedAt: null, acknowledgedAt: null, acknowledgedBy: null });
  await incTimeline(ctx, inc._id, 'sos_received', { triggeredAt: new Date(input.occurredAt).toISOString(), queuedOffline: !!input.offline, locationSource: loc?.source ?? 'none', locationAgeSec: loc ? Math.round((now - loc.at) / 1000) : null });
  const r = await raise(ctx, { type: 'sos', subject: inc._id, unitId, staffMemberId: staffId, assignmentId: assignment?._id ?? null, incidentId: inc._id, detail: { number: inc.number } });
  let notified = r?.notified ?? 0;
  if (!notified) notified = await ctx.app.services.notify.roles(ctx, ['owner', 'admin'], { template: 'sos_created', refType: 'incident', refId: inc._id, critical: true, dedupeKey: `sos:${inc._id}:fallback` }); // never leave an SOS with no recipient
  const to = notified > 0 ? 'notified' : 'failed'; SosDeliveryMachine.assert('received_by_server', to);
  sos = (await ctx.col('sos_events').update(sos._id, { $set: { deliveryState: to, notifiedAt: notified ? now : null, recipientsNotified: notified } }))!;
  await incTimeline(ctx, inc._id, notified ? 'recipients_notified' : 'notification_failed', { recipients: notified, channel: 'in_app' });
  await ctx.emit('sos:created', { unitId, staffId, needs: 'incident.read' }, { incidentId: inc._id, number: inc.number, staffMemberId: staffId, eventId: input.eventId, lastKnownLocationAgeSec: loc ? Math.round((now - loc.at) / 1000) : null, occurredAt: new Date(input.occurredAt).toISOString() }, input.occurredAt);
  if (staffId) await ctx.app.services.location.refreshState(ctx, staffId);
  ctx.app.metrics.observe('sf_sos_accept_to_notify_ms', {}, ctx.now() - now);
  return { status: 'accepted', eventId: input.eventId, incidentId: inc._id, number: inc.number, deliveryState: sos.deliveryState, receivedAt: now, incidentStatus: 'new', fallback: fallback(ctx) };
}
const fallback = (ctx: Ctx) => ({ afterSec: ctx.settings.sos.fallbackSec, instructions: ctx.settings.sos.fallbackInstructions });

async function transition(ctx: Ctx, inc: Doc, to: IncidentStatus, body: { reason?: string; resolutionCode?: string }) {
  IncidentMachine.assert(inc.status, to);
  if (to === 'resolved' && !body.resolutionCode) throw new AppError('VALIDATION_FAILED', 'A resolution code is required to resolve an incident.', { fieldErrors: [{ path: 'resolutionCode', code: 'REQUIRED', message: 'is required' }] });
  if ((to === 'cancelled_false_alarm' || to === 'reopened') && !body.reason) throw new AppError('VALIDATION_FAILED', 'A reason is required.', { fieldErrors: [{ path: 'reason', code: 'REQUIRED', message: 'is required' }] });
  const now = ctx.now(); const set: Record<string, unknown> = { status: to, updatedAt: now };
  if (to === 'acknowledged' && !inc.acknowledgedAt) Object.assign(set, { acknowledgedAt: now, acknowledgedBy: ctx.actor.userId, timeToAckSec: Math.round((now - inc.createdAt) / 1000) });
  if (to === 'resolved') Object.assign(set, { resolvedAt: now, resolutionCode: body.resolutionCode, resolutionNote: body.reason ?? null, timeToResolveSec: Math.round((now - inc.createdAt) / 1000) });
  if (to === 'closed') set.closedAt = now; if (to === 'cancelled_false_alarm') Object.assign(set, { cancelledAt: now, cancelReason: body.reason });
  if (to === 'reopened') Object.assign(set, { reopenedAt: now, reopenReason: body.reason });
  const out = (await ctx.col('incidents').update(inc._id, { $set: set, $inc: { version: 1 } }))!;
  await incTimeline(ctx, inc._id, `status:${to}`, { from: inc.status, reason: body.reason ?? null, resolutionCode: body.resolutionCode ?? null });
  if (inc.kind === 'sos') {
    const sos = await ctx.col('sos_events').findOne({ incidentId: inc._id });
    if (sos && sos.deliveryState !== 'acknowledged_by_human' && (to === 'acknowledged' || to === 'cancelled_false_alarm')) {
      SosDeliveryMachine.assert(sos.deliveryState, 'acknowledged_by_human');
      await ctx.col('sos_events').update(sos._id, { $set: { deliveryState: 'acknowledged_by_human', acknowledgedAt: now, acknowledgedBy: ctx.actor.userId } });
      await ctx.emit('sos:deliveryChanged', { staffId: sos.staffMemberId, userId: sos.userId }, { eventId: sos.eventId, incidentId: inc._id, deliveryState: 'acknowledged_by_human', occurredAt: new Date(now).toISOString() });
      if (sos.userId) await ctx.app.services.notify.user(ctx, sos.userId, { template: 'sos_acknowledged', refType: 'incident', refId: inc._id, critical: true, dedupeKey: `sos:${inc._id}:ack` });
    }
    for (const al of await ctx.col('alerts').find({ incidentId: inc._id, state: { $in: ['open', 'acknowledged', 'snoozed'] } })) {
      if (to === 'acknowledged' && al.state === 'open') await setAlertState(ctx, al, 'acknowledged', { ackBy: ctx.actor.userId, ackAt: now }, 'incident acknowledged');
      if (['resolved', 'closed', 'cancelled_false_alarm'].includes(to)) await setAlertState(ctx, al, 'resolved', {}, `incident ${to}`);
    }
  }
  await ctx.emit('incident:updated', { unitId: inc.unitId, needs: 'incident.read' }, { incidentId: inc._id, number: inc.number, status: to, severity: inc.severity, kind: inc.kind, occurredAt: new Date(now).toISOString() });
  if (inc.reportedByStaffId) await ctx.app.services.location.refreshState(ctx, inc.reportedByStaffId);
  return out;
}
async function loadIncident(ctx: Ctx, id: string): Promise<Doc> {
  const inc = await ctx.col('incidents').must(id, 'Incident');
  const own = inc.reportedByUserId === ctx.actor.userId || (!!ctx.actor.staffMemberId && (inc.responderStaffIds as string[]).includes(ctx.actor.staffMemberId));
  if (!own && !(ctx.can('incident.read') && ctx.inScope(inc.unitId))) throw new AppError('NOT_FOUND', 'Incident not found');
  return inc;
}

const routes: Route[] = [
  // ---- alert rules and escalation ----
  { method: 'GET', path: '/alert-rules', permission: 'alertrule.read', scope: 'tenant', audit: { none: 'read of rule data within scope' }, rate: 'read', summary: 'Alert rules with thresholds, severity, recipients and escalation', reqs: ['FR-ALR-001'],
    async handler(ctx) { return { items: await ctx.col('alert_rules').find({}, { sort: { type: 1 } }), types: ALERT_TYPES }; } },
  {
    method: 'PUT', path: '/alert-rules/:id', permission: 'alertrule.update', scope: 'tenant', audit: 'alertrule.update', rate: 'mutation', summary: 'Update a rule; the change is versioned and audited', reqs: ['FR-ALR-001'],
    body: s.object({ version: s.number({ int: true }), enabled: s.boolean(), thresholds: s.json(1), severity: s.enum(['low', 'medium', 'high', 'critical']), recipientGroups: s.array(s.enum(['owner', 'admin', 'commander', 'supervisor', 'dispatcher']), { min: 1, max: 5 }), escalationPolicyId: s.optional(s.id()) }),
    async handler(ctx, { params, body }) {
      const rule = await ctx.col('alert_rules').must(params.id!, 'Alert rule');
      if (rule.type === 'sos' && (!body.enabled || body.severity !== 'critical')) throw new AppError('VALIDATION_FAILED', 'The SOS rule cannot be disabled or downgraded.');
      if (!Object.values(body.thresholds).every((v) => typeof v === 'number' && v >= 0 && v <= 100000)) throw new AppError('VALIDATION_FAILED', 'Thresholds must be numbers.', { fieldErrors: [{ path: 'thresholds', code: 'TYPE', message: 'must contain only non-negative numbers' }] });
      if (body.escalationPolicyId) await ctx.col('escalation_policies').must(body.escalationPolicyId, 'Escalation policy');
      const { version, ...set } = body;
      const out = await ctx.col('alert_rules').updateVersioned(rule._id, version, { ...set, escalationPolicyId: body.escalationPolicyId ?? null, updatedBy: ctx.actor.userId, updatedAt: ctx.now() });
      ctx.setAudit({ resource: { type: 'alert_rule', id: rule._id }, before: { enabled: rule.enabled, thresholds: rule.thresholds, severity: rule.severity, recipientGroups: rule.recipientGroups }, after: set });
      return out;
    },
  },
  { method: 'GET', path: '/escalation-policies', permission: 'alertrule.read', scope: 'tenant', audit: { none: 'policy read' }, rate: 'read', summary: 'Escalation policies', reqs: ['FR-ALR-004'], async handler(ctx) { return { items: await ctx.col('escalation_policies').find({}, { sort: { name: 1 } }) }; } },
  {
    method: 'POST', path: '/escalation-policies', permission: 'escalation.manage', scope: 'tenant', audit: 'escalation.create', rate: 'mutation', summary: 'Create an escalation policy', reqs: ['FR-ALR-004'],
    body: s.object({ name: s.string({ min: 2, max: 80 }), steps: s.array(s.object({ afterSec: s.number({ int: true, min: 10, max: 86400 }), groups: s.array(s.enum(['owner', 'admin', 'commander', 'supervisor', 'dispatcher']), { min: 1, max: 5 }) }), { min: 1, max: 6 }) }),
    async handler(ctx, { body }) { const p = await ctx.col('escalation_policies').insert({ ...body, steps: body.steps.map((x: Doc) => ({ ...x, channels: ['inApp'] })), createdAt: ctx.now(), version: 1 }); ctx.setAudit({ resource: { type: 'escalation_policy', id: p._id }, after: body }); return created(p); },
  },
  {
    method: 'PATCH', path: '/escalation-policies/:id', permission: 'escalation.manage', scope: 'tenant', audit: 'escalation.update', rate: 'mutation', summary: 'Edit escalation steps', reqs: ['FR-ALR-004'],
    body: s.object({ version: s.number({ int: true }), steps: s.array(s.object({ afterSec: s.number({ int: true, min: 10, max: 86400 }), groups: s.array(s.enum(['owner', 'admin', 'commander', 'supervisor', 'dispatcher']), { min: 1, max: 5 }) }), { min: 1, max: 6 }) }),
    async handler(ctx, { params, body }) { const p = await ctx.col('escalation_policies').must(params.id!, 'Escalation policy'); const out = await ctx.col('escalation_policies').updateVersioned(p._id, body.version, { steps: body.steps.map((x: Doc) => ({ ...x, channels: ['inApp'] })) }); ctx.setAudit({ resource: { type: 'escalation_policy', id: p._id }, before: { steps: p.steps }, after: { steps: body.steps } }); return out; },
  },
  // ---- alerts ----
  {
    method: 'GET', path: '/alerts', permission: 'alert.read', scope: 'unit', audit: { none: 'alert list read' }, rate: 'read', summary: 'Alerts within scope, critical first', reqs: ['FR-ALR-002', 'FR-ALR-003'],
    query: s.object({ ...pageQuery, state: s.optional(s.enum(['open', 'acknowledged', 'snoozed', 'resolved', 'auto_resolved', 'active'])), type: s.optional(s.enum(ALERT_TYPES)), severity: s.optional(s.enum(['low', 'medium', 'high', 'critical'])), staffMemberId: s.optional(s.id()) }),
    async handler(ctx, { query }) {
      const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') };
      if (query.state) f.state = query.state === 'active' ? { $in: ['open', 'acknowledged', 'snoozed'] } : query.state;
      for (const k of ['type', 'severity', 'staffMemberId'] as const) if (query[k]) f[k] = query[k];
      const page = await paginate(ctx.col('alerts'), f, query, 'firstAt', -1);
      const staff = await ctx.col('staff_members').find({ _id: { $in: page.items.map((a) => a.staffMemberId).filter(Boolean) } });
      return { ...page, asOf: ctx.now(), items: page.items.map((a) => ({ ...a, staffName: staff.find((x) => x._id === a.staffMemberId)?.displayName ?? null })) };
    },
  },
  { method: 'GET', path: '/alerts/:id', permission: 'alert.read', scope: 'unit', audit: { none: 'read of alert data within scope' }, rate: 'read', summary: 'Alert with its full timeline', reqs: ['FR-ALR-003'],
    async handler(ctx, { params }) { const a = await ctx.col('alerts').must(params.id!, 'Alert'); ctx.assertScope(a.unitId, 'Alert'); return { ...a, timeline: await ctx.col('alert_timeline').find({ alertId: a._id }, { sort: { at: 1 } }) }; } },
  ...(['acknowledge', 'snooze', 'resolve'] as const).map((action): Route => ({
    method: 'POST', path: `/alerts/:id/${action}`, permission: 'alert.manage', scope: 'unit', audit: `alert.${action}`, rate: 'mutation', summary: `Alert lifecycle: ${action} (reason required for snooze and resolve)`, reqs: ['FR-ALR-003'],
    body: action === 'acknowledge' ? s.object({ note: s.optional(s.string({ max: 300 })) }) : action === 'snooze' ? s.object({ minutes: s.number({ int: true, min: 1, max: 480 }), reason: s.string({ min: 3, max: 300 }) }) : s.object({ reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      const a = await ctx.col('alerts').must(params.id!, 'Alert'); ctx.assertScope(a.unitId, 'Alert');
      if (a.type === 'sos' && action !== 'acknowledge') throw new AppError('CONFLICT', 'An SOS alert is closed by handling its incident, not by snoozing or resolving the alert.');
      const b = body as { note?: string; minutes?: number; reason?: string };
      const out = action === 'acknowledge' ? await setAlertState(ctx, a, 'acknowledged', { ackBy: ctx.actor.userId, ackAt: ctx.now() }, b.note ?? null)
        : action === 'snooze' ? await setAlertState(ctx, a, 'snoozed', { snoozedUntil: ctx.now() + b.minutes! * 60000, snoozedBy: ctx.actor.userId }, b.reason!)
        : await setAlertState(ctx, a, 'resolved', { resolvedBy: ctx.actor.userId, resolveReason: b.reason }, b.reason!);
      if (a.type === 'sos' && a.incidentId) { const inc = await ctx.col('incidents').get(a.incidentId); if (inc?.status === 'new') await transition(ctx, inc, 'acknowledged', {}); }
      ctx.setAudit({ resource: { type: 'alert', id: a._id }, reason: b.reason ?? b.note ?? null, before: { state: a.state }, after: { state: out.state } });
      return out;
    },
  })),
  // ---- SOS ----
  {
    method: 'POST', path: '/sos', permission: 'sos.raise', scope: 'own', audit: 'sos.raise', rate: 'sos', deviceBound: true, whenInactive: 'safety', summary: 'Raise an SOS: creates a critical incident, notifies recipients and schedules escalation in one transaction', reqs: ['FR-SOS-001', 'FR-SOS-002', 'FR-SOS-003', 'FR-SOS-004', 'FR-SUB-001'],
    body: s.object({ eventId: s.uuid(), occurredAt: s.iso(), sentAt: s.optional(s.iso()), location: s.optional(s.object({ lat: s.lat(), lon: s.lon(), accuracyM: s.number({ min: 0, max: 10000 }) })), assignmentId: s.optional(s.id()), note: s.optional(s.string({ max: 1000 })) }),
    async handler(ctx, { body }) { const r = await raiseSos(ctx, { ...body, occurredAt: Date.parse(body.occurredAt), sentAt: body.sentAt ? Date.parse(body.sentAt) : undefined }); ctx.setAudit({ resource: { type: 'incident', id: r.incidentId }, detail: { deliveryState: r.deliveryState, duplicate: r.status === 'duplicate' } }); return r; },
  },
  { method: 'GET', path: '/sos/:id/status', permission: 'session', scope: 'own', audit: { none: 'own SOS status read' }, rate: 'read', whenInactive: 'safety', summary: 'Truthful delivery state of an SOS for the person who raised it', reqs: ['FR-SOS-002'],
    async handler(ctx, { params }) {
      const sos = await ctx.col('sos_events').findOne({ eventId: params.id }); if (!sos || sos.userId !== ctx.actor.userId) throw new AppError('NOT_FOUND', 'SOS not found');
      const inc = (await ctx.col('incidents').get(sos.incidentId))!;
      return { eventId: sos.eventId, incidentId: inc._id, number: inc.number, deliveryState: sos.deliveryState, receivedAt: sos.receivedAt, notifiedAt: sos.notifiedAt, acknowledgedAt: sos.acknowledgedAt, incidentStatus: inc.status, cancellationRequestedAt: sos.cancellationRequestedAt ?? null, fallback: fallback(ctx), serverTime: ctx.now() };
    } },
  {
    method: 'POST', path: '/sos/:id/cancel-request', permission: 'session', scope: 'own', audit: 'sos.cancel_request', rate: 'sos', whenInactive: 'safety', summary: 'Ask for an accidental SOS to be cancelled; it stays open until a dispatcher confirms', reqs: ['FR-SOS-004'], body: s.object({ reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      const sos = await ctx.col('sos_events').findOne({ eventId: params.id }); if (!sos || sos.userId !== ctx.actor.userId) throw new AppError('NOT_FOUND', 'SOS not found');
      await ctx.col('sos_events').update(sos._id, { $set: { cancellationRequestedAt: ctx.now(), cancellationReason: body.reason } });
      await incTimeline(ctx, sos.incidentId, 'cancellation_requested', { reason: body.reason });
      const inc = (await ctx.col('incidents').get(sos.incidentId))!;
      await ctx.emit('incident:updated', { unitId: inc.unitId, needs: 'incident.read' }, { incidentId: inc._id, number: inc.number, status: inc.status, severity: inc.severity, kind: 'sos', cancellationRequested: true, occurredAt: new Date(ctx.now()).toISOString() });
      ctx.setAudit({ resource: { type: 'incident', id: inc._id }, reason: body.reason });
      return { incidentStatus: inc.status, note: 'The SOS remains open until a dispatcher confirms the cancellation.' };
    },
  },
  // ---- incidents ----
  {
    method: 'POST', path: '/incidents', permission: 'incident.create', scope: 'own', audit: 'incident.create', rate: 'mutation', summary: 'Report an incident with type, severity, description and optional location and attachments', reqs: ['FR-INC-002'],
    body: s.object({ eventId: s.optional(s.uuid()), typeKey: s.string({ max: 40 }), severity: s.optional(s.enum(['low', 'medium', 'high', 'critical'])), description: s.string({ min: 3, max: 4000 }), location: s.optional(s.object({ lat: s.lat(), lon: s.lon(), accuracyM: s.number({ min: 0, max: 10000 }) })), assignmentId: s.optional(s.id()), attachmentFileIds: s.optional(s.array(s.id(), { max: 5 })) }),
    async handler(ctx, { body }) { const r = await createIncident(ctx, body); ctx.setAudit({ resource: { type: 'incident', id: r.incidentId } }); return created(r); },
  },
  {
    method: 'GET', path: '/incidents', permission: 'session', scope: 'own', audit: { none: 'incident list read' }, rate: 'read', summary: 'Incidents within scope (or own reports for field staff)', reqs: ['FR-INC-001'],
    query: s.object({ ...pageQuery, status: s.optional(s.string({ max: 30 })), kind: s.optional(s.enum(['sos', 'incident'])), severity: s.optional(s.enum(['low', 'medium', 'high', 'critical'])), mine: s.optional(s.boolean()) }),
    async handler(ctx, { query }) {
      const f: Record<string, unknown> = ctx.can('incident.read') && !query.mine ? { ...ctx.scopeFilter('unitId') } : { reportedByUserId: ctx.actor.userId };
      if (query.status) f.status = query.status === 'active' ? { $in: ACTIVE_INCIDENT } : query.status; if (query.kind) f.kind = query.kind; if (query.severity) f.severity = query.severity;
      const page = await paginate(ctx.col('incidents'), f, query, 'createdAt', -1);
      const staff = await ctx.col('staff_members').find({ _id: { $in: page.items.map((i) => i.reportedByStaffId).filter(Boolean) } });
      return { ...page, asOf: ctx.now(), items: page.items.map((i) => ({ ...incidentView(ctx, i), reporterName: staff.find((x) => x._id === i.reportedByStaffId)?.displayName ?? null })) };
    },
  },
  {
    method: 'GET', path: '/incidents/:id', permission: 'session', scope: 'own', audit: { none: 'incident read' }, rate: 'read', summary: 'Incident detail with reporter, location age, responders and SOS delivery state', reqs: ['FR-INC-001', 'FR-SOS-003'],
    async handler(ctx, { params }) {
      const inc = await loadIncident(ctx, params.id!);
      const [sos, staff, timelineItems] = await Promise.all([ctx.col('sos_events').findOne({ incidentId: inc._id }), ctx.col('staff_members').find({ _id: { $in: [inc.reportedByStaffId, ...inc.responderStaffIds].filter(Boolean) } }), ctx.col('incident_timeline').find({ incidentId: inc._id }, { sort: { at: 1 } })]);
      const rep = staff.find((x) => x._id === inc.reportedByStaffId);
      return { ...incidentView(ctx, inc), reporter: rep ? { id: rep._id, displayName: rep.displayName, employeeCode: rep.employeeCode } : null, responders: staff.filter((x) => inc.responderStaffIds.includes(x._id)).map((x) => ({ id: x._id, displayName: x.displayName })),
        locationAgeSec: inc.locationAt ? Math.round((ctx.now() - inc.locationAt) / 1000) : null, sos: sos ? { eventId: sos.eventId, deliveryState: sos.deliveryState, triggeredAt: sos.triggeredAt, receivedAt: sos.receivedAt, notifiedAt: sos.notifiedAt, acknowledgedAt: sos.acknowledgedAt, queuedOffline: sos.queuedOffline, cancellationRequestedAt: sos.cancellationRequestedAt ?? null, cancellationReason: sos.cancellationReason ?? null } : null,
        allowedTransitions: ctx.can('incident.manage') ? IncidentMachine.next(inc.status) : [], timeline: timelineItems };
    },
  },
  {
    method: 'POST', path: '/incidents/:id/transition', permission: 'incident.manage', scope: 'unit', audit: 'incident.transition', rate: 'mutation', summary: 'Move an incident through its lifecycle; invalid transitions are rejected', reqs: ['FR-INC-001', 'FR-INC-004', 'FR-SOS-004'],
    body: s.object({ to: s.enum(['acknowledged', 'dispatched', 'on_scene', 'resolved', 'closed', 'cancelled_false_alarm', 'reopened']), version: s.optional(s.number({ int: true })), reason: s.optional(s.string({ min: 3, max: 1000 })), resolutionCode: s.optional(s.string({ min: 2, max: 60 })) }),
    async handler(ctx, { params, body }) {
      const inc = await ctx.col('incidents').must(params.id!, 'Incident'); ctx.assertScope(inc.unitId, 'Incident');
      if (body.version !== undefined && body.version !== inc.version) throw new AppError('VERSION_CONFLICT', 'This incident was updated by someone else. Reload and try again.', { details: { currentVersion: inc.version } });
      const out = await transition(ctx, inc, body.to, body);
      ctx.setAudit({ action: `incident.${body.to}`, resource: { type: 'incident', id: inc._id }, reason: body.reason ?? null, before: { status: inc.status }, after: { status: body.to, resolutionCode: body.resolutionCode ?? null } });
      return out;
    },
  },
  { method: 'GET', path: '/incidents/:id/responder-options', permission: 'incident.dispatch', scope: 'unit', audit: { none: 'names of staff who can be assigned; needed by dispatchers without staff.read' }, rate: 'read', summary: 'Active staff within scope who can be assigned as responders (name and code only)', reqs: ['FR-INC-003'],
    async handler(ctx, { params }) {
      const inc = await ctx.col('incidents').must(params.id!, 'Incident'); ctx.assertScope(inc.unitId, 'Incident');
      const people = await ctx.col('staff_members').find({ ...ctx.scopeFilter('homeUnitId'), status: 'active' }, { limit: 1000 });
      return { items: people.map((x) => ({ id: x._id, displayName: x.displayName, employeeCode: x.employeeCode })).sort((a, b) => String(a.displayName).localeCompare(String(b.displayName))) };
    } },
  {
    method: 'POST', path: '/incidents/:id/responders', permission: 'incident.dispatch', scope: 'unit', audit: 'incident.responders.assign', rate: 'mutation', summary: 'Assign responders from staff within scope; they are notified', reqs: ['FR-INC-003'], body: s.object({ staffMemberIds: s.array(s.id(), { min: 1, max: 20 }) }),
    async handler(ctx, { params, body }) {
      const inc = await ctx.col('incidents').must(params.id!, 'Incident'); ctx.assertScope(inc.unitId, 'Incident');
      if (!ACTIVE_INCIDENT.includes(inc.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Responders can be assigned only to an active incident.');
      const staff = await ctx.col('staff_members').find({ _id: { $in: body.staffMemberIds }, status: 'active' });
      if (staff.length !== new Set(body.staffMemberIds).size || !staff.every((x) => ctx.inScope(x.homeUnitId))) throw new AppError('VALIDATION_FAILED', 'Responders must be active staff within your scope.', { fieldErrors: [{ path: 'staffMemberIds', code: 'UNKNOWN', message: 'contains someone who is not active in your scope' }] });
      const all = [...new Set([...inc.responderStaffIds, ...body.staffMemberIds])];
      await ctx.col('incidents').update(inc._id, { $set: { responderStaffIds: all, updatedAt: ctx.now() }, $inc: { version: 1 } });
      await incTimeline(ctx, inc._id, 'responders_assigned', { staffMemberIds: body.staffMemberIds, names: staff.map((x) => x.displayName) });
      for (const x of staff) await ctx.app.services.notify.staff(ctx, x._id, { template: 'incident_assigned', refType: 'incident', refId: inc._id, critical: inc.severity === 'critical' });
      await ctx.emit('incident:updated', { unitId: inc.unitId, needs: 'incident.read' }, { incidentId: inc._id, number: inc.number, status: inc.status, severity: inc.severity, kind: inc.kind, occurredAt: new Date(ctx.now()).toISOString() });
      ctx.setAudit({ resource: { type: 'incident', id: inc._id }, after: { responderStaffIds: all } });
      return { responderStaffIds: all };
    },
  },
  {
    method: 'POST', path: '/incidents/:id/notes', permission: 'session', scope: 'own', audit: 'incident.note', rate: 'mutation', summary: 'Append a note (and attachments) to the immutable incident timeline', reqs: ['FR-INC-004'], body: s.object({ text: s.string({ min: 1, max: 4000 }), attachmentFileIds: s.optional(s.array(s.id(), { max: 5 })) }),
    async handler(ctx, { params, body }) { const inc = await loadIncident(ctx, params.id!); await incTimeline(ctx, inc._id, 'note', { text: body.text }, body.attachmentFileIds ?? []); await ctx.col('incidents').update(inc._id, { $set: { updatedAt: ctx.now() } }); ctx.setAudit({ resource: { type: 'incident', id: inc._id } }); return { ok: true }; },
  },
  { method: 'GET', path: '/incidents/:id/timeline', permission: 'session', scope: 'own', audit: { none: 'timeline read' }, rate: 'read', summary: 'Append-only incident timeline', reqs: ['FR-INC-004'],
    async handler(ctx, { params }) { const inc = await loadIncident(ctx, params.id!); return { items: await ctx.col('incident_timeline').find({ incidentId: inc._id }, { sort: { at: 1 } }) }; } },
];

export function registerSafety(app: App) {
  app.register('safety', routes);
  app.services.alerts = { raise, resolveFor, onBattery, onHeartbeat, onGeofenceEvent };
  app.services.sos = { raise: raiseSos }; app.services.incidents = { create: createIncident, transition };

  // Escalation jobs live in the durable queue, so they survive restarts; each step is idempotent (FR-ALR-004, FR-SOS-003).
  app.jobs.register('alert.escalate', async (p, j) => {
    const ctx = await app.systemCtxFor(j.tenantId!, 'escalation'); if (!ctx) return;
    await app.store.transaction(async () => {
      const alert = await ctx.col('alerts').get(p.alertId);
      if (!alert || alert.state === 'resolved' || alert.state === 'auto_resolved' || alert.state === 'acknowledged') return; // acknowledged in time: no further escalation
      if (alert.state === 'snoozed' && alert.snoozedUntil > app.clock.now()) return;
      const policy = alert.escalationPolicyId ? await ctx.col('escalation_policies').get(alert.escalationPolicyId) : null; const step = policy?.steps?.[p.step]; if (!step) return;
      const n = await recipientsFor(ctx, step.groups, alert, { template: alert.type === 'sos' ? 'sos_escalated' : 'alert_escalated', dedupeKey: `alert:${alert._id}:esc${p.step}`, critical: alert.severity === 'critical' });
      await ctx.col('alerts').update(alert._id, { $set: { escalationStep: p.step + 1, lastEscalatedAt: app.clock.now() } });
      await timeline(ctx, alert._id, 'escalated', { step: p.step + 1, groups: step.groups, recipients: n });
      if (alert.incidentId) {
        await incTimeline(ctx, alert.incidentId, 'escalated', { step: p.step + 1, groups: step.groups, recipients: n });
        const sos = await ctx.col('sos_events').findOne({ incidentId: alert.incidentId });
        if (sos && n > 0 && (sos.deliveryState === 'failed' || sos.deliveryState === 'received_by_server')) await ctx.col('sos_events').update(sos._id, { $set: { deliveryState: 'notified', notifiedAt: app.clock.now() } });
        await ctx.emit('sos:created', { unitId: alert.unitId, needs: 'incident.read' }, { incidentId: alert.incidentId, number: alert.detail?.number ?? null, staffMemberId: alert.staffMemberId, renotify: true, step: p.step + 1, occurredAt: new Date(app.clock.now()).toISOString() });
      } else await ctx.emit('alert:updated', { unitId: alert.unitId, needs: 'alert.read' }, { alertId: alert._id, type: alert.type, state: alert.state, escalationStep: p.step + 1, staffMemberId: alert.staffMemberId, occurredAt: new Date(app.clock.now()).toISOString() });
    });
  });
  app.jobs.register('geofence.outside.check', async (p, j) => {
    const ctx = await app.systemCtxFor(j.tenantId!, 'geofence-check'); if (!ctx) return;
    await app.store.transaction(async () => {
      const st = await ctx.col('geofence_states').findOne({ assignmentId: p.assignmentId, geofenceId: p.geofenceId }); const a = await ctx.col('duty_assignments').get(p.assignmentId);
      if (!st || st.track.state !== 'outside' || !a || a.status !== 'started') return; // came back, on break, or duty over
      await raise(ctx, { type: 'geofence_exception', subject: `${a._id}:${p.geofenceId}`, unitId: a.unitId, staffMemberId: a.staffMemberId, assignmentId: a._id, detail: { geofenceId: p.geofenceId, exitEventId: p.eventId } });
    });
  });

  // Scheduled evaluators fire even when the device is offline or the app is closed (FR-ALR-005).
  app.schedule('alerts.evaluators', 30, async (tenant) => {
    if (tenant.status !== 'active' && tenant.status !== 'trial') return;
    const ctx = (await app.systemCtxFor(tenant._id, 'alert-evaluator'))!; const now = app.clock.now();
    const rules = Object.fromEntries((await ctx.col('alert_rules').find({})).map((r) => [r.type, r])) as Record<AlertType, Doc | undefined>;
    const tx = (fn: () => Promise<unknown>) => app.store.transaction(fn);
    const late = rules.late_start;
    if (late?.enabled) for (const a of await ctx.col('duty_assignments').find({ status: 'scheduled', rosterState: { $in: ['published', 'revised_unpublished'] }, startsAt: { $lt: now - (late.thresholds.afterMin ?? 15) * 60000 }, endsAt: { $gt: now } }, { limit: 2000 }))
      await tx(() => raise(ctx, { type: 'late_start', subject: a._id, unitId: a.unitId, staffMemberId: a.staffMemberId, assignmentId: a._id, detail: { startsAt: new Date(a.startsAt).toISOString() } }));
    const mco = rules.missed_check_out, policy = ctx.settings.duty.missedCheckOut;
    for (const a of await ctx.col('duty_assignments').find({ status: { $in: ['started', 'on_break'] }, endsAt: { $lt: now } }, { limit: 2000 })) {
      if (policy === 'auto_close' && now >= a.endsAt + ctx.settings.duty.autoCloseGraceMin * 60000) { await tx(async () => { await systemClose(ctx, a); if (mco?.enabled) await raise(ctx, { type: 'missed_check_out', subject: a._id, unitId: a.unitId, staffMemberId: a.staffMemberId, assignmentId: a._id, detail: { systemClosed: true } }); }); continue; }
      if (policy !== 'remain_open' && mco?.enabled && now >= a.endsAt + (mco.thresholds.afterMin ?? 60) * 60000) await tx(() => raise(ctx, { type: 'missed_check_out', subject: a._id, unitId: a.unitId, staffMemberId: a.staffMemberId, assignmentId: a._id, detail: { endsAt: new Date(a.endsAt).toISOString() } }));
    }
    const stale = rules.stale_location, off = rules.device_offline;
    for (const ts of await ctx.col('duty_tracking_sessions').find({ state: 'open' }, { limit: 5000 })) {
      if (ts.onBreak && ts.profile?.paused) continue;
      const st = await ctx.col('staff_location_states').findOne({ staffMemberId: ts.staffMemberId }); const last = Math.max(st?.effectiveTime ?? 0, ts.openedAt);
      if (stale?.enabled && now - last > (stale.thresholds.afterMin ?? 10) * 60000) await tx(async () => { await raise(ctx, { type: 'stale_location', subject: ts.staffMemberId, window: ts._id, unitId: ts.unitId, staffMemberId: ts.staffMemberId, assignmentId: ts.assignmentId, detail: { lastSeenSecAgo: Math.round((now - last) / 1000) } }); await app.services.location.refreshState(ctx, ts.staffMemberId); });
      const dev = ts.deviceId ? await ctx.col('devices').get(ts.deviceId) : null;
      if (off?.enabled && dev && now - Math.max(dev.lastSeenAt ?? 0, ts.openedAt) > (off.thresholds.afterMin ?? 15) * 60000) await tx(() => raise(ctx, { type: 'device_offline', subject: dev._id, window: ts._id, unitId: ts.unitId, staffMemberId: ts.staffMemberId, assignmentId: ts.assignmentId, detail: {} }));
    }
    for (const a of await ctx.col('alerts').find({ state: 'snoozed', snoozedUntil: { $lte: now } }, { limit: 1000 })) await tx(() => setAlertState(ctx, a, 'open', { snoozedUntil: null }, 'snooze ended'));
  });
}
