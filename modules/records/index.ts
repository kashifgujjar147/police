// Records: reports and exports, files, audit log, retention, tenant export/deletion, catalogues, dashboard
// (FR-RPT-001..003, FR-AUD-001..003, FR-PRV-004..005, FR-EXP-001..002, FR-INC-005, FR-CMD-004; TS §17–§19).
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Basis } from '@sf/contracts';
import { csvCell, toCsv, utcToLocalDate } from '@sf/domain';
import { sha256Hex, verifyChain } from '@sf/domain/node';
import { App, AppError, COLLECTIONS, Ctx, type Doc, Reply, type Route, created, hmacHex, paginate, randomToken, s, safeEqual, toApi } from '@sf/kernel';
import { activeHoldFor } from '../privacy/index.ts';

const pageQuery = { limit: s.optional(s.number({ int: true, min: 1, max: 200 })), cursor: s.optional(s.string({ max: 300 })) };

// ---------------- file storage port ----------------
export interface FileStorage { put(key: string, data: Buffer): Promise<void>; get(key: string): Promise<Buffer | null>; delete(key: string): Promise<void> }
export class MemoryFileStorage implements FileStorage { private m = new Map<string, Buffer>(); async put(k: string, d: Buffer) { this.m.set(k, d); } async get(k: string) { return this.m.get(k) ?? null; } async delete(k: string) { this.m.delete(k); } }
export class DiskFileStorage implements FileStorage {
  constructor(private root: string) { mkdirSync(root, { recursive: true }); }
  private p(key: string) { if (!/^[A-Za-z0-9/_-]+$/.test(key) || key.includes('..')) throw new Error('invalid storage key'); return join(this.root, key); }
  async put(key: string, data: Buffer) { mkdirSync(dirname(this.p(key)), { recursive: true }); writeFileSync(this.p(key), data, { mode: 0o600 }); }
  async get(key: string) { return existsSync(this.p(key)) ? readFileSync(this.p(key)) : null; }
  async delete(key: string) { rmSync(this.p(key), { force: true }); }
}
/** Server-side type detection from magic bytes; the declared type is never trusted (TS §19). */
export function sniffMime(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b.length >= 5 && b.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return null;
}
/** Removes EXIF/XMP/comment segments from JPEG and textual/EXIF chunks from PNG without re-encoding pixels. */
export function stripMetadata(b: Buffer, mime: string): Buffer {
  if (mime === 'image/jpeg') {
    const out: Buffer[] = [b.subarray(0, 2)]; let i = 2;
    while (i + 4 <= b.length && b[i] === 0xff) {
      const marker = b[i + 1]!; if (marker === 0xda) break; // start of scan: copy the rest verbatim
      const len = b.readUInt16BE(i + 2); const seg = b.subarray(i, i + 2 + len);
      if (!((marker === 0xe1) || (marker === 0xed) || (marker === 0xfe))) out.push(seg); // drop APP1 (EXIF/XMP), APP13 (IPTC), COM
      i += 2 + len;
    }
    out.push(b.subarray(i)); return Buffer.concat(out);
  }
  if (mime === 'image/png') {
    const out: Buffer[] = [b.subarray(0, 8)]; let i = 8;
    while (i + 12 <= b.length) { const len = b.readUInt32BE(i); const type = b.subarray(i + 4, i + 8).toString('latin1'); const chunk = b.subarray(i, i + 12 + len); if (!['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'].includes(type)) out.push(chunk); i += 12 + len; }
    return Buffer.concat(out);
  }
  return b;
}
function tarPack(files: { name: string; data: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const h = Buffer.alloc(512); h.write(f.name.slice(0, 99), 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(f.data.length.toString(8).padStart(11, '0') + '\0', 124); h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136); h.write('        ', 148); h.write('0', 156); h.write('ustar\0' + '00', 257);
    let sum = 0; for (const x of h) sum += x; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024)); return Buffer.concat(blocks);
}

async function storeGenerated(ctx: Ctx, f: { class: string; name: string; mime: string; data: Buffer; ownerRef?: { type: string; id: string } }): Promise<Doc> {
  const key = `${ctx.tenantId}/${f.class}/${randomToken(16)}`;
  await (ctx.app.services.storage as FileStorage).put(key, f.data);
  return ctx.col('file_objects').insert({ storageKey: key, class: f.class, name: f.name, mime: f.mime, sizeBytes: f.data.length, sha256: sha256Hex(f.data), scanState: 'generated', state: 'ready', ownerRef: f.ownerRef ?? null, uploadedBy: ctx.actor.userId, createdAt: ctx.now() });
}
/** Short-lived signed download URL (default 5 minutes); the object key is never exposed (TS §19). */
async function signedUrl(ctx: Ctx, file: Doc): Promise<{ url: string; expiresAt: number }> {
  const exp = ctx.now() + ctx.settings.files.urlSec * 1000;
  const sig = hmacHex(ctx.app.config.fileUrlKey, `dl|${ctx.tenantId}|${file._id}|${exp}`);
  return { url: `/api/v1/files/download/${file._id}?t=${ctx.tenantId}&exp=${exp}&sig=${sig}`, expiresAt: exp };
}
async function removeFile(ctx: Ctx, id: string) { const f = await ctx.col('file_objects').get(id); if (f) { await (ctx.app.services.storage as FileStorage).delete(f.storageKey); await ctx.col('file_objects').delete({ _id: id }); } }

// ---------------- reports ----------------
interface Column { key: string; label: string; basis: Basis }
interface Report { key: string; title: string; permission: 'report.read' | 'report.incident.read' | 'audit.read'; columns: Column[]; note: string; run(ctx: Ctx, f: Filters): Promise<Record<string, unknown>[]> }
interface Filters { from: number; to: number; unitId?: string; staffMemberId?: string; postId?: string }
const col = (key: string, label: string, basis: Basis = 'measured'): Column => ({ key, label, basis });
const iso = (t: unknown) => (typeof t === 'number' ? new Date(t).toISOString() : '');
async function names(ctx: Ctx, ids: unknown[]) { const st = await ctx.col('staff_members').find({ _id: { $in: [...new Set(ids.filter(Boolean))] } }, { limit: 20000 }); return new Map(st.map((x) => [x._id, x])); }
function base(ctx: Ctx, f: Filters, timeField: string, unitField = 'unitId'): Record<string, unknown> {
  const q: Record<string, unknown> = { ...ctx.scopeFilter(unitField), [timeField]: { $gte: f.from, $lte: f.to } };
  if (f.unitId) q[unitField] = f.unitId; if (f.staffMemberId) q.staffMemberId = f.staffMemberId; if (f.postId) q.postId = f.postId;
  return q;
}
const withStaff = async (ctx: Ctx, rows: Doc[], map: (r: Doc, st: Doc | undefined) => Record<string, unknown>) => { const n = await names(ctx, rows.map((r) => r.staffMemberId ?? r.reportedByStaffId)); return rows.map((r) => map(r, n.get(r.staffMemberId ?? r.reportedByStaffId))); };
const staffCols = [col('employeeCode', 'Employee code'), col('staffName', 'Staff member')];
const sc = (st: Doc | undefined) => ({ employeeCode: st?.employeeCode ?? '', staffName: st?.displayName ?? '' });

export const REPORTS: Report[] = [
  { key: 'attendance', title: 'Attendance', permission: 'report.read', note: 'Actual times come from device events; corrected values are labelled estimated; system-closed duties are system flags.',
    columns: [...staffCols, col('localDate', 'Date'), col('shift', 'Shift'), col('scheduledStart', 'Scheduled start'), col('scheduledEnd', 'Scheduled end'), col('actualStart', 'Actual start'), col('actualEnd', 'Actual end'), col('status', 'Status'), col('breakMinutes', 'Break minutes'), col('coveragePct', 'Location coverage %'), col('exceptions', 'Exceptions', 'system_flag'), col('basis', 'Basis of actual times', 'system_flag')],
    async run(ctx, f) { const rows = await ctx.col('duty_assignments').find({ ...base(ctx, f, 'startsAt'), status: { $ne: 'cancelled' } }, { sort: { startsAt: 1 }, limit: 100001 }); const sums = new Map((await ctx.col('duty_summaries').find({ assignmentId: { $in: rows.map((r) => r._id) } }, { limit: 100001 })).map((x) => [x.assignmentId, x]));
      return withStaff(ctx, rows, (a, st) => { const su = sums.get(a._id); return { ...sc(st), localDate: a.localDate, shift: a.shiftName, scheduledStart: iso(a.startsAt), scheduledEnd: iso(a.endsAt), actualStart: iso(su?.actual?.startedAt ?? a.startedAt), actualEnd: iso(su?.actual?.endedAt ?? a.endedAt), status: a.status, breakMinutes: su?.breaks?.minutes ?? '', coveragePct: su?.coverage?.pct ?? '', exceptions: (su?.exceptions ?? a.startReasonCodes ?? []).join(' '), basis: a.systemClosed ? 'system_flag' : su?.actual?.startBasis ?? (a.startedAt ? 'measured' : 'unknown') }; }); } },
  { key: 'late_starts', title: 'Late starts', permission: 'report.read', note: 'Lateness is measured from the scheduled start to the recorded duty start.',
    columns: [...staffCols, col('localDate', 'Date'), col('scheduledStart', 'Scheduled start'), col('actualStart', 'Actual start'), col('minutesLate', 'Minutes late')],
    async run(ctx, f) { const rows = (await ctx.col('duty_assignments').find(base(ctx, f, 'startsAt'), { sort: { startsAt: 1 }, limit: 100001 })).filter((a) => a.startedAt && a.startedAt > a.startsAt + 60000); return withStaff(ctx, rows, (a, st) => ({ ...sc(st), localDate: a.localDate, scheduledStart: iso(a.startsAt), actualStart: iso(a.startedAt), minutesLate: Math.round((a.startedAt - a.startsAt) / 60000) })); } },
  { key: 'absences', title: 'Absences (no duty start recorded)', permission: 'report.read', note: 'A row means no duty start was received for a published assignment. It is a system flag, not proof of absence: the device may have been offline.',
    columns: [...staffCols, col('localDate', 'Date'), col('shift', 'Shift'), col('scheduledStart', 'Scheduled start'), col('finding', 'Finding', 'system_flag')],
    async run(ctx, f) { const rows = await ctx.col('duty_assignments').find({ ...base(ctx, f, 'startsAt'), status: 'missed' }, { sort: { startsAt: 1 }, limit: 100001 }); return withStaff(ctx, rows, (a, st) => ({ ...sc(st), localDate: a.localDate, shift: a.shiftName, scheduledStart: iso(a.startsAt), finding: 'no duty start recorded' })); } },
  { key: 'missed_checkpoints', title: 'Missed checkpoints', permission: 'report.read', note: 'A missed checkpoint means no valid scan was received in the window plus grace.',
    columns: [...staffCols, col('checkpoint', 'Checkpoint'), col('windowStart', 'Window start'), col('windowEnd', 'Window end'), col('state', 'State', 'system_flag')],
    async run(ctx, f) { const rows = await ctx.col('checkpoint_expectations').find({ ...base(ctx, f, 'windowEnd'), state: 'missed' }, { sort: { windowEnd: 1 }, limit: 100001 }); const cps = new Map((await ctx.col('checkpoints').find({}, { limit: 10000 })).map((c) => [c._id, c.name])); return withStaff(ctx, rows, (e, st) => ({ ...sc(st), checkpoint: cps.get(e.checkpointId) ?? '', windowStart: iso(e.windowStart), windowEnd: iso(e.windowEnd), state: e.state })); } },
  { key: 'geofence_exceptions', title: 'Geofence exceptions', permission: 'report.read', note: 'Exit and entry events are confirmed only after the dwell time with accuracy within the ceiling; uncertain points produce no event.',
    columns: [...staffCols, col('geofence', 'Geofence'), col('type', 'Event'), col('eventAt', 'Time'), col('accuracyM', 'Accuracy (m)'), col('confidence', 'Confidence', 'estimated')],
    async run(ctx, f) { const rows = await ctx.col('geofence_events').find(base(ctx, f, 'eventAt'), { sort: { eventAt: 1 }, limit: 100001 }); return withStaff(ctx, rows, (e, st) => ({ ...sc(st), geofence: e.geofenceName, type: e.type, eventAt: iso(e.eventAt), accuracyM: Math.round(e.accuracyM), confidence: Math.round(e.confidence * 100) / 100 })); } },
  { key: 'location_coverage', title: 'Location coverage', permission: 'report.read', note: 'Coverage is the share of tracked minutes with at least one point within the accuracy ceiling. Low coverage means unknown, not absent.',
    columns: [...staffCols, col('localDate', 'Date'), col('trackedMinutes', 'Tracked minutes'), col('points', 'Points received'), col('coveragePct', 'Coverage %'), col('basis', 'Basis', 'system_flag')],
    async run(ctx, f) { const rows = await ctx.col('duty_summaries').find({ ...ctx.scopeFilter('unitId'), 'scheduled.startsAt': { $gte: f.from, $lte: f.to }, ...(f.staffMemberId ? { staffMemberId: f.staffMemberId } : {}), ...(f.unitId ? { unitId: f.unitId } : {}) }, { limit: 100001 }); return withStaff(ctx, rows, (su, st) => ({ ...sc(st), localDate: utcToLocalDate(su.scheduled.startsAt, ctx.tenant!.timezone), trackedMinutes: su.actual.minutes ?? '', points: su.coverage.points, coveragePct: su.coverage.pct ?? '', basis: su.coverage.basis })); } },
  { key: 'incidents', title: 'Incidents', permission: 'report.incident.read', note: 'Times are server times of each recorded action.',
    columns: [col('number', 'Number'), col('kind', 'Kind'), col('type', 'Type'), col('severity', 'Severity'), col('status', 'Status'), col('reportedBy', 'Reported by'), col('createdAt', 'Created'), col('timeToAckSec', 'Seconds to acknowledge'), col('timeToResolveSec', 'Seconds to resolve'), col('resolutionCode', 'Resolution')],
    async run(ctx, f) { const rows = await ctx.col('incidents').find({ ...base(ctx, f, 'createdAt'), ...(f.staffMemberId ? { staffMemberId: undefined, reportedByStaffId: f.staffMemberId } : {}) }, { sort: { createdAt: 1 }, limit: 100001 }); return withStaff(ctx, rows, (i, st) => ({ number: i.number, kind: i.kind, type: i.typeKey, severity: i.severity, status: i.status, reportedBy: st?.displayName ?? '', createdAt: iso(i.createdAt), timeToAckSec: i.timeToAckSec ?? '', timeToResolveSec: i.timeToResolveSec ?? '', resolutionCode: i.resolutionCode ?? '' })); } },
  { key: 'sos_response', title: 'SOS response time', permission: 'report.incident.read', note: 'Trigger time is the device time; receipt, notification and acknowledgement are server times. An SOS queued offline shows the delay between trigger and receipt.',
    columns: [col('number', 'Incident'), col('staffName', 'Raised by'), col('triggeredAt', 'Triggered (device)'), col('receivedAt', 'Received (server)'), col('notifiedAt', 'Recipients notified'), col('acknowledgedAt', 'Acknowledged by a person'), col('secondsToAck', 'Seconds to acknowledge'), col('queuedOffline', 'Queued offline', 'system_flag'), col('deliveryState', 'Delivery state', 'system_flag')],
    async run(ctx, f) { const rows = await ctx.col('sos_events').find(base(ctx, f, 'receivedAt'), { sort: { receivedAt: 1 }, limit: 100001 }); const incs = new Map((await ctx.col('incidents').find({ _id: { $in: rows.map((r) => r.incidentId) } }, { limit: 100001 })).map((i) => [i._id, i.number])); return withStaff(ctx, rows, (e, st) => ({ number: incs.get(e.incidentId) ?? '', staffName: st?.displayName ?? '', triggeredAt: iso(e.triggeredAt), receivedAt: iso(e.receivedAt), notifiedAt: iso(e.notifiedAt), acknowledgedAt: iso(e.acknowledgedAt), secondsToAck: e.acknowledgedAt ? Math.round((e.acknowledgedAt - e.receivedAt) / 1000) : '', queuedOffline: e.queuedOffline ? 'yes' : 'no', deliveryState: e.deliveryState })); } },
  { key: 'device_offline_gaps', title: 'Device and offline gaps', permission: 'report.read', note: 'Stale-location and device-offline alerts raised by scheduled evaluators. A gap means no data was received.',
    columns: [...staffCols, col('type', 'Type', 'system_flag'), col('firstAt', 'From'), col('resolvedAt', 'Until'), col('minutes', 'Minutes', 'estimated'), col('state', 'State')],
    async run(ctx, f) { const rows = await ctx.col('alerts').find({ ...base(ctx, f, 'firstAt'), type: { $in: ['stale_location', 'device_offline', 'low_battery'] } }, { sort: { firstAt: 1 }, limit: 100001 }); return withStaff(ctx, rows, (a, st) => ({ ...sc(st), type: a.type, firstAt: iso(a.firstAt), resolvedAt: iso(a.resolvedAt), minutes: a.resolvedAt ? Math.round((a.resolvedAt - a.firstAt) / 60000) : '', state: a.state })); } },
  { key: 'corrections', title: 'Attendance corrections', permission: 'report.read', note: 'Approved corrections are appended as new events; the original event is preserved.',
    columns: [...staffCols, col('type', 'Corrected event'), col('proposedTime', 'Proposed time', 'estimated'), col('state', 'State'), col('reason', 'Reason'), col('reviewNote', 'Review note'), col('createdAt', 'Requested')],
    async run(ctx, f) { const rows = await ctx.col('correction_requests').find(base(ctx, f, 'createdAt'), { sort: { createdAt: 1 }, limit: 100001 }); return withStaff(ctx, rows, (c, st) => ({ ...sc(st), type: c.proposed.type, proposedTime: iso(c.proposed.occurredAt), state: c.state, reason: c.reason, reviewNote: c.reviewNote ?? '', createdAt: iso(c.createdAt) })); } },
  { key: 'audit_extract', title: 'Audit extract', permission: 'audit.read', note: 'Append-only audit events with their sequence and hash for independent verification.',
    columns: [col('seq', 'Sequence'), col('occurredAt', 'Time'), col('actorId', 'Actor'), col('actorType', 'Actor type'), col('action', 'Action'), col('resourceType', 'Resource'), col('resourceId', 'Resource id'), col('outcome', 'Outcome'), col('reason', 'Reason'), col('hash', 'Hash')],
    async run(ctx, f) { const rows = await ctx.col('audit_events').find({ occurredAt: { $gte: f.from, $lte: f.to } }, { sort: { seq: 1 }, limit: 100001 }); return rows.map((e) => ({ seq: e.seq, occurredAt: iso(e.occurredAt), actorId: e.actor.id ?? '', actorType: e.actor.type, action: e.action, resourceType: e.resourceType, resourceId: e.resourceId ?? '', outcome: e.outcome, reason: e.reason ?? '', hash: e.hash })); } },
];
const reportQuery = { from: s.iso(), to: s.iso(), unitId: s.optional(s.id()), staffMemberId: s.optional(s.id()), postId: s.optional(s.id()) };
async function runReport(ctx: Ctx, key: string, q: { from: string; to: string; unitId?: string; staffMemberId?: string; postId?: string }) {
  const rep = REPORTS.find((r) => r.key === key); if (!rep) throw new AppError('NOT_FOUND', 'Report not found');
  if (!ctx.can(rep.permission)) throw new AppError('FORBIDDEN', 'You do not have permission to view this report.');
  const f: Filters = { from: Date.parse(q.from), to: Date.parse(q.to), unitId: q.unitId, staffMemberId: q.staffMemberId, postId: q.postId };
  if (f.to <= f.from || f.to - f.from > 93 * 86400000) throw new AppError('VALIDATION_FAILED', 'Choose a range of at most 93 days.');
  if (f.unitId) ctx.assertScope(f.unitId, 'Unit');
  const rows = await rep.run(ctx, f); const limit = ctx.settings.exports.rowLimit;
  const pendingSync = await ctx.col('sync_rejections').count({ ...ctx.scopeFilter('unitId'), resolvedAt: null, receivedAt: { $gte: f.from } });
  const openSessions = await ctx.col('duty_tracking_sessions').count({ ...ctx.scopeFilter('unitId'), state: 'open' });
  return { report: rep, filters: q, asOf: ctx.now(), timezone: ctx.tenant!.timezone, rows: rows.slice(0, limit), truncated: rows.length > limit,
    incomplete: { pendingSyncRejections: pendingSync, dutiesInProgress: openSessions, note: pendingSync || openSessions ? 'Data may be incomplete: some duties are still in progress or some device records were rejected at sync and are awaiting resolution.' : null } };
}

// ---------------- retention ----------------
const RETENTION: Record<string, [string, string][]> = {
  location_points: [['location_points', 'recordedAt']], attendance: [['attendance_events', 'receivedAt'], ['correction_requests', 'createdAt']],
  geofence_checkpoint: [['geofence_events', 'eventAt'], ['checkpoint_scans', 'receivedAt']], incidents: [['incident_timeline', 'at'], ['sos_events', 'receivedAt'], ['incidents', 'createdAt']],
  audit: [['audit_events', 'occurredAt']], security: [['location_access_log', 'at'], ['device_heartbeat_logs', 'at']], notifications: [['notifications', 'createdAt']],
};
async function runRetention(ctx: Ctx, dryRun: boolean) {
  const holds = await ctx.col('legal_holds').find({ releasedAt: null }); const now = ctx.now();
  const tenantHold = holds.some((h) => h.scope.kind === 'tenant'); const heldStaff = holds.filter((h) => h.scope.kind === 'staff').map((h) => h.scope.id); const heldInc = holds.filter((h) => h.scope.kind === 'incident').map((h) => h.scope.id);
  const result: Record<string, { cutoff: string; eligible: number; deleted: number; skippedForLegalHold: number }> = {};
  for (const [cls, targets] of Object.entries(RETENTION)) {
    const cutoff = now - (ctx.settings.retentionDays as Record<string, number>)[cls]! * 86400000; let eligible = 0, deleted = 0, held = 0;
    for (const [c, field] of targets) {
      const f: Record<string, unknown> = { [field]: { $lt: cutoff } };
      if (c === 'incidents') f.status = { $in: ['closed', 'cancelled_false_alarm'] };
      const n = await ctx.col(c).count(f); eligible += n;
      if (tenantHold) { held += n; continue; }
      const keep: Record<string, unknown> = { ...f };
      if (heldStaff.length && ['location_points', 'attendance_events', 'correction_requests', 'geofence_events', 'checkpoint_scans', 'sos_events', 'location_access_log'].includes(c)) keep.staffMemberId = { $nin: heldStaff };
      if (heldInc.length && (c === 'incident_timeline' || c === 'sos_events')) keep.incidentId = { $nin: heldInc };
      if (heldInc.length && c === 'incidents') keep._id = { $nin: heldInc };
      const m = await ctx.col(c).count(keep); held += n - m;
      if (!dryRun && m) {
        if (c === 'audit_events') { // keep the chain verifiable after purge: remember the hash the first retained record must link to
          const last = await ctx.col(c).findOne(keep, { sort: { seq: -1 } });
          if (last) await ctx.app.store.updateOne('tenants', { _id: ctx.tenantId }, { $set: { auditAnchor: { seq: last.seq, hash: last.hash } } });
        }
        deleted += await ctx.col(c).delete(keep, { retention: true });
      }
    }
    result[cls] = { cutoff: new Date(cutoff).toISOString(), eligible, deleted, skippedForLegalHold: held };
  }
  const run = await ctx.col('retention_runs').insert({ startedAt: now, finishedAt: ctx.now(), dryRun, requestedBy: ctx.actor.userId, result, activeLegalHolds: holds.length });
  await ctx.app.writeAudit(ctx, { action: dryRun ? 'retention.dry_run' : 'retention.run', resource: { type: 'retention_run', id: run._id }, detail: Object.fromEntries(Object.entries(result).map(([k, v]) => [k, dryRun ? v.eligible : v.deleted])) });
  return run;
}
async function tenantCounts(ctx: Ctx) { const out: Record<string, number> = {}; for (const [c, def] of Object.entries(COLLECTIONS)) if (def.tenantOwned) { const n = await ctx.col(c).count({}); if (n) out[c] = n; } return out; }
const EXPORT_SKIP = new Set(['sessions', 'used_refresh_tokens', 'mfa_factors', 'invitations', 'password_reset_tokens', 'login_challenges', 'idempotency_records', 'realtime_events', 'integration_configs']);
async function buildTenantExport(ctx: Ctx): Promise<Doc> {
  const files: { name: string; data: Buffer }[] = []; const manifest: { collection: string; file: string; records: number; sha256: string }[] = [];
  for (const [c, def] of Object.entries(COLLECTIONS)) {
    if (!def.tenantOwned || EXPORT_SKIP.has(c)) continue;
    const docs = await ctx.col(c).find({}, { limit: 5000000 }); if (!docs.length) continue;
    const data = Buffer.from(docs.map((d) => JSON.stringify(toApi(d))).join('\n') + '\n'); // toApi strips password hashes, token hashes and encrypted secrets
    files.push({ name: `data/${c}.jsonl`, data }); manifest.push({ collection: c, file: `data/${c}.jsonl`, records: docs.length, sha256: sha256Hex(data) });
  }
  const attachments = (await ctx.col('file_objects').find({}, { limit: 100000 })).map((f) => ({ id: f._id, name: f.name, class: f.class, mime: f.mime, sizeBytes: f.sizeBytes, sha256: f.sha256 }));
  files.unshift({ name: 'attachments-manifest.json', data: Buffer.from(JSON.stringify(attachments, null, 1)) });
  files.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ schema: 'smartforce360.tenant-export/1', tenant: { id: ctx.tenantId, name: ctx.tenant!.name, slug: ctx.tenant!.slug }, generatedAt: new Date(ctx.now()).toISOString(), excluded: [...EXPORT_SKIP], note: 'Credentials, session tokens and integration secrets are never exported.', collections: manifest }, null, 1)) });
  return storeGenerated(ctx, { class: 'tenant-export', name: `tenant-export-${ctx.tenant!.slug}.tar`, mime: 'application/x-tar', data: tarPack(files) });
}

const routes: Route[] = [
  // ---- reports and exports ----
  { method: 'GET', path: '/reports', permission: 'session', scope: 'tenant', audit: { none: 'report catalogue' }, rate: 'read', summary: 'Catalogue of reports the caller may run', reqs: ['FR-RPT-001'],
    async handler(ctx) { return { items: REPORTS.filter((r) => ctx.can(r.permission)).map((r) => ({ key: r.key, title: r.title, note: r.note, columns: r.columns })) }; } },
  {
    method: 'GET', path: '/reports/:id', permission: 'session', scope: 'unit', audit: 'report.view', rate: 'read', tx: true, summary: 'Run a report with filters; every result states its as-of time, timezone, filters and basis labels', reqs: ['FR-RPT-001', 'FR-RPT-002'], query: s.object(reportQuery),
    async handler(ctx, { params, query }) {
      ctx.setAudit({ resource: { type: 'report', id: params.id }, detail: { filters: query } });
      const r = await runReport(ctx, params.id!, query);
      return { key: r.report.key, title: r.report.title, asOf: r.asOf, timezone: r.timezone, filters: r.filters, columns: r.report.columns, basisNote: r.report.note, incomplete: r.incomplete, truncated: r.truncated, rowCount: r.rows.length, rows: r.rows };
    },
  },
  {
    method: 'POST', path: '/exports', permission: 'export.create', scope: 'unit', audit: 'export.create', rate: 'export', summary: 'Queue a CSV export with the same filters, definitions and basis labels as the on-screen report', reqs: ['FR-RPT-003', 'FR-AUD-003'],
    body: s.object({ reportType: s.string({ max: 40 }), filters: s.object(reportQuery), format: s.enum(['csv']) }),
    async handler(ctx, { body }) {
      const rep = REPORTS.find((r) => r.key === body.reportType); if (!rep) throw new AppError('NOT_FOUND', 'Report not found');
      if (!ctx.can(rep.permission)) throw new AppError('FORBIDDEN', 'You do not have permission to export this report.');
      if (body.filters.unitId) ctx.assertScope(body.filters.unitId, 'Unit');
      const job = await ctx.col('export_jobs').insert({ reportType: rep.key, filters: body.filters, format: 'csv', requestedBy: ctx.actor.userId, requestedByMembershipId: ctx.actor.membershipId, state: 'queued', rowCount: null, fileId: null, createdAt: ctx.now() });
      await ctx.enqueue('export.run', { exportId: job._id }, { queue: 'reports', dedupeKey: `export:${job._id}` });
      ctx.setAudit({ resource: { type: 'export', id: job._id }, detail: { reportType: rep.key, filters: body.filters } });
      return created(job);
    },
  },
  { method: 'GET', path: '/exports', permission: 'export.create', scope: 'own', audit: { none: 'own export list' }, rate: 'read', summary: 'Own export jobs', reqs: ['FR-RPT-003'], query: s.object(pageQuery),
    async handler(ctx, { query }) { return paginate(ctx.col('export_jobs'), { requestedBy: ctx.actor.userId }, query, 'createdAt', -1); } },
  {
    method: 'GET', path: '/exports/:id', permission: 'export.create', scope: 'own', audit: 'export.download_link', rate: 'read', tx: true, summary: 'Export state and, when ready, a short-lived download link (re-authorised on every request)', reqs: ['FR-RPT-003'],
    async handler(ctx, { params }) {
      const job = await ctx.col('export_jobs').must(params.id!, 'Export'); if (job.requestedBy !== ctx.actor.userId) throw new AppError('NOT_FOUND', 'Export not found');
      const file = job.fileId ? await ctx.col('file_objects').get(job.fileId) : null;
      ctx.setAudit({ resource: { type: 'export', id: job._id }, detail: { state: job.state, rowCount: job.rowCount } });
      return { ...job, download: file ? await signedUrl(ctx, file) : null };
    },
  },
  // ---- files ----
  {
    method: 'POST', path: '/files/upload-intents', permission: 'session', scope: 'own', audit: 'file.upload_intent', rate: 'mutation', summary: 'Declare an upload and receive a short-lived upload URL', reqs: ['FR-INC-005'],
    body: s.object({ class: s.enum(['incident-attachment', 'review-attachment', 'staff-photo']), name: s.string({ min: 1, max: 120 }), mime: s.string({ max: 60 }), sizeBytes: s.number({ int: true, min: 1 }) }),
    async handler(ctx, { body }) {
      const f = ctx.settings.files;
      if (!f.allowedMime.includes(body.mime)) throw new AppError('VALIDATION_FAILED', `This file type is not allowed. Allowed: ${f.allowedMime.join(', ')}.`, { fieldErrors: [{ path: 'mime', code: 'NOT_ALLOWED', message: 'is not an allowed file type' }] });
      if (body.sizeBytes > f.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', `Files may be at most ${Math.round(f.maxBytes / 1048576)} MB.`);
      const exp = ctx.now() + 15 * 60000;
      const file = await ctx.col('file_objects').insert({ storageKey: `${ctx.tenantId}/${body.class}/${randomToken(16)}`, class: body.class, name: body.name.replace(/[^\w.\- ؀-ۿ]/g, '_'), mime: body.mime, sizeBytes: body.sizeBytes, state: 'pending', scanState: 'pending', uploadedBy: ctx.actor.userId, createdAt: ctx.now(), uploadExpiresAt: exp });
      ctx.setAudit({ resource: { type: 'file', id: file._id }, detail: { class: body.class, mime: body.mime, sizeBytes: body.sizeBytes } });
      return created({ fileId: file._id, upload: { method: 'PUT', url: `/api/v1/files/${file._id}/content`, expiresAt: exp, headers: { 'Content-Type': body.mime } } });
    },
  },
  {
    method: 'PUT', path: '/files/:id/content', permission: 'session', scope: 'own', audit: 'file.upload', rate: 'mutation', binaryMaxBytes: 10 * 1024 * 1024, summary: 'Upload the file bytes; the server sniffs the real type, strips image metadata and stores a checksum', reqs: ['FR-INC-005'],
    async handler(ctx, { params, req }) {
      const file = await ctx.col('file_objects').must(params.id!, 'File'); ctx.setAudit({ resource: { type: 'file', id: file._id } });
      if (file.uploadedBy !== ctx.actor.userId || file.state !== 'pending' || file.uploadExpiresAt < ctx.now()) throw new AppError('NOT_FOUND', 'File not found');
      const data = req.rawBuffer ?? Buffer.alloc(0);
      if (!data.length || data.length > ctx.settings.files.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', 'The file is empty or too large.');
      const real = sniffMime(data);
      if (!real || real !== file.mime) { await ctx.col('file_objects').update(file._id, { $set: { state: 'rejected', rejectReason: 'TYPE_MISMATCH' } }); return new Reply(400, { error: { code: 'VALIDATION_FAILED', message: 'The file content does not match its declared type.', requestId: ctx.requestId, fieldErrors: [{ path: 'file', code: 'TYPE_MISMATCH', message: `detected ${real ?? 'an unsupported type'}` }] } }); }
      const clean = stripMetadata(data, real);
      const scan = await (ctx.app.services.scanner?.scan(clean) ?? Promise.resolve('unscanned'));
      if (scan === 'infected') { await ctx.col('file_objects').update(file._id, { $set: { state: 'rejected', rejectReason: 'MALWARE', scanState: 'infected' } }); return new Reply(400, { error: { code: 'VALIDATION_FAILED', message: 'The file was rejected by the malware scan.', requestId: ctx.requestId } }); }
      await (ctx.app.services.storage as FileStorage).put(file.storageKey, clean);
      const out = await ctx.col('file_objects').update(file._id, { $set: { state: 'ready', sizeBytes: clean.length, sha256: sha256Hex(clean), scanState: scan, metadataStripped: clean.length !== data.length, uploadedAt: ctx.now() } });
      ctx.setAudit({ detail: { sizeBytes: clean.length, scanState: scan } });
      return out;
    },
  },
  {
    method: 'GET', path: '/files/:id/url', permission: 'session', scope: 'own', audit: 'file.access', rate: 'read', tx: true, summary: 'Issue a short-lived signed download URL after re-checking authorisation', reqs: ['FR-INC-005'],
    async handler(ctx, { params }) {
      const file = await ctx.col('file_objects').must(params.id!, 'File'); ctx.setAudit({ resource: { type: 'file', id: file._id }, detail: { class: file.class } });
      const need: Record<string, string> = { 'incident-attachment': 'incident.read', 'review-attachment': 'attendance.read', 'staff-photo': 'staff.read', 'subject-export': 'privacy.subject.manage', 'tenant-export': 'tenant.export', export: 'export.create' };
      const own = file.uploadedBy === ctx.actor.userId;
      if (file.state !== 'ready' || !(own || (need[file.class] && ctx.can(need[file.class]!))) || ((file.class === 'export' || file.class === 'tenant-export' || file.class === 'subject-export') && !own)) throw new AppError('NOT_FOUND', 'File not found');
      return { fileId: file._id, name: file.name, mime: file.mime, sizeBytes: file.sizeBytes, sha256: file.sha256, ...(await signedUrl(ctx, file)) };
    },
  },
  {
    method: 'GET', path: '/files/download/:id', permission: 'public', scope: 'none', audit: { none: 'bearer of a short-lived signed URL; issuing the URL is audited' }, rate: 'public', raw: true, summary: 'Download by signed URL', reqs: ['FR-INC-005'], query: s.object({ t: s.id(), exp: s.number({ int: true }), sig: s.string({ min: 64, max: 64 }) }),
    async handler(ctx, { params, query }) {
      const ok = safeEqual(hmacHex(ctx.app.config.fileUrlKey, `dl|${query.t}|${params.id}|${query.exp}`), query.sig) && query.exp > ctx.now();
      const file = ok ? await ctx.app.tenantRepo(query.t).col('file_objects').get(params.id!) : null;
      const data = file?.state === 'ready' ? await (ctx.app.services.storage as FileStorage).get(file.storageKey) : null;
      if (!file || !data) throw new AppError('NOT_FOUND', 'This link is not valid or has expired.');
      return new Reply(200, data, { 'Content-Type': file.mime, 'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`, 'Content-Length': String(data.length) });
    },
  },
  // ---- audit ----
  {
    method: 'GET', path: '/audit/events', permission: 'audit.read', scope: 'tenant', audit: 'audit.read', rate: 'read', tx: true, summary: 'Search audit events by actor, action, resource and time; this read is itself audited', reqs: ['FR-AUD-003'],
    query: s.object({ ...pageQuery, actorId: s.optional(s.string({ max: 64 })), action: s.optional(s.string({ max: 80 })), resourceType: s.optional(s.string({ max: 40 })), resourceId: s.optional(s.string({ max: 64 })), outcome: s.optional(s.enum(['success', 'denied', 'failed'])), from: s.optional(s.iso()), to: s.optional(s.iso()) }),
    async handler(ctx, { query }) {
      const f: Record<string, unknown> = {};
      if (query.actorId) f['actor.id'] = query.actorId; for (const k of ['action', 'resourceType', 'resourceId', 'outcome'] as const) if (query[k]) f[k] = query[k];
      if (query.from || query.to) f.occurredAt = { ...(query.from ? { $gte: Date.parse(query.from) } : {}), ...(query.to ? { $lte: Date.parse(query.to) } : {}) };
      ctx.setAudit({ resource: { type: 'audit_log', id: null }, detail: { filters: { ...query, cursor: undefined } } });
      return paginate(ctx.col('audit_events'), f, query, 'seq', -1);
    },
  },
  { method: 'GET', path: '/audit/verify', permission: 'audit.read', scope: 'tenant', audit: 'audit.verify', rate: 'read', tx: true, summary: 'Verify the tenant\'s audit hash chain from its anchor', reqs: ['FR-AUD-002'],
    async handler(ctx) { const r = await verifyAudit(ctx); ctx.setAudit({ resource: { type: 'audit_log', id: null }, detail: { ok: r.ok } }); return r; } },
  // ---- retention ----
  { method: 'GET', path: '/retention/policies', permission: 'settings.read', scope: 'tenant', audit: { none: 'policy read' }, rate: 'read', summary: 'Retention period per data class and recent runs', reqs: ['FR-PRV-004'],
    async handler(ctx) { return { retentionDays: ctx.settings.retentionDays, classes: Object.fromEntries(Object.entries(RETENTION).map(([k, v]) => [k, v.map(([c]) => c)])), activeLegalHolds: await ctx.col('legal_holds').count({ releasedAt: null }), runs: await ctx.col('retention_runs').find({}, { sort: { startedAt: -1 }, limit: 20 }) }; } },
  { method: 'POST', path: '/retention/runs', permission: 'retention.manage', scope: 'tenant', audit: { none: 'retention.run / retention.dry_run is written by the run itself with per-class counts' }, rate: 'mutation', summary: 'Run retention now, or dry-run to see what would be deleted', reqs: ['FR-PRV-004', 'FR-PRV-005'], body: s.object({ dryRun: s.boolean() }),
    async handler(ctx, { body }) { return created(await runRetention(ctx, body.dryRun)); } },
  // ---- tenant export ----
  { method: 'POST', path: '/tenant/exports', permission: 'tenant.export', scope: 'tenant', audit: 'tenant.export.request', rate: 'export', whenInactive: 'owner', summary: 'Owner requests a complete tenant export (JSON Lines per collection, manifest with checksums)', reqs: ['FR-EXP-001'], body: s.object({}),
    async handler(ctx) { const job = await ctx.col('export_jobs').insert({ reportType: 'tenant_export', filters: {}, format: 'tar', requestedBy: ctx.actor.userId, state: 'queued', rowCount: null, fileId: null, createdAt: ctx.now() }); await ctx.enqueue('tenant.export', { exportId: job._id }, { queue: 'reports', dedupeKey: `texport:${job._id}` }); ctx.setAudit({ resource: { type: 'export', id: job._id } }); return created(job); } },
  // ---- catalogues ----
  { method: 'GET', path: '/catalogues', permission: 'catalogue.read', scope: 'tenant', audit: { none: 'catalogue read' }, rate: 'read', summary: 'Catalogue entries (incident types, duty types) with EN/AR labels', reqs: ['FR-SET-002'], query: s.object({ kind: s.optional(s.string({ max: 40 })) }),
    async handler(ctx, { query }) { return { items: await ctx.col('catalogue_entries').find(query.kind ? { kind: query.kind } : {}, { sort: { kind: 1, key: 1 } }) }; } },
  { method: 'POST', path: '/catalogues', permission: 'catalogue.manage', scope: 'tenant', audit: 'catalogue.create', rate: 'mutation', summary: 'Add a catalogue entry', reqs: ['FR-SET-002'],
    body: s.object({ kind: s.enum(['incidentType', 'dutyType', 'exceptionReason', 'resolutionCode']), key: s.string({ min: 2, max: 40, pattern: /^[a-z0-9_]+$/ }), labels: s.object({ en: s.string({ min: 1, max: 80 }), ar: s.string({ min: 1, max: 80 }) }), severityDefault: s.optional(s.enum(['low', 'medium', 'high', 'critical'])) }),
    async handler(ctx, { body }) { const c = await ctx.col('catalogue_entries').insert({ ...body, severityDefault: body.severityDefault ?? 'low', archived: false, createdAt: ctx.now() }); ctx.setAudit({ resource: { type: 'catalogue', id: c._id }, after: body }); return created(c); } },
  { method: 'PATCH', path: '/catalogues/:id', permission: 'catalogue.manage', scope: 'tenant', audit: 'catalogue.update', rate: 'mutation', summary: 'Relabel or archive a catalogue entry (archived values stay valid on historical records)', reqs: ['FR-SET-002'],
    body: s.object({ labels: s.optional(s.object({ en: s.string({ min: 1, max: 80 }), ar: s.string({ min: 1, max: 80 }) })), archived: s.optional(s.boolean()), severityDefault: s.optional(s.enum(['low', 'medium', 'high', 'critical'])) }),
    async handler(ctx, { params, body }) { const c = await ctx.col('catalogue_entries').must(params.id!, 'Catalogue entry'); const out = await ctx.col('catalogue_entries').update(c._id, { $set: body }); ctx.setAudit({ resource: { type: 'catalogue', id: c._id }, before: { labels: c.labels, archived: c.archived }, after: body }); return out; } },
  // ---- dashboard ----
  {
    method: 'GET', path: '/dashboard/overview', permission: 'dashboard.read', scope: 'unit', audit: { none: 'aggregate counters' }, rate: 'read', summary: 'Operational overview for the caller\'s scope with data freshness', reqs: ['FR-CMD-001'], query: s.object({ unitId: s.optional(s.id()) }),
    async handler(ctx, { query }) {
      const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') }; if (query.unitId) { ctx.assertScope(query.unitId, 'Unit'); f.unitId = query.unitId; }
      const now = ctx.now(); const dayStart = now - 24 * 3600000;
      const states = (await ctx.col('staff_location_states').find(f, { limit: 10000 })).map((st) => ctx.app.services.location.stateView(ctx, st, false) as { dutyDisplayState: string; freshness: string; activeSos: boolean });
      const byState: Record<string, number> = { on_duty: 0, on_break: 0, not_started: 0, exception: 0, sos: 0, stale_offline: 0 }; for (const v of states) if (v.dutyDisplayState in byState) byState[v.dutyDisplayState]!++;
      const alerts = await ctx.col('alerts').find({ ...f, state: { $in: ['open', 'acknowledged', 'snoozed'] } }, { limit: 5000 });
      const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 }; for (const a of alerts) bySeverity[a.severity]!++;
      const [activeIncidents, activeSos, scheduledToday, missedCp, pendingCorrections, pendingDevices] = await Promise.all([
        ctx.col('incidents').count({ ...f, status: { $in: ['new', 'acknowledged', 'dispatched', 'on_scene', 'reopened'] } }), ctx.col('incidents').count({ ...f, kind: 'sos', status: { $in: ['new', 'acknowledged', 'dispatched', 'on_scene', 'reopened'] } }),
        ctx.col('duty_assignments').count({ ...f, startsAt: { $gte: dayStart, $lte: now + 12 * 3600000 }, status: { $ne: 'cancelled' } }), ctx.col('checkpoint_expectations').count({ ...f, state: 'missed', windowEnd: { $gte: dayStart } }),
        ctx.col('correction_requests').count({ ...f, state: 'pending' }), ctx.col('devices').count({ ...f, status: 'pending_approval' }),
      ]);
      return { asOf: now, staff: { ...byState, total: states.filter((v) => v.dutyDisplayState !== 'checked_out').length, fresh: states.filter((v) => v.freshness === 'live').length }, alerts: { ...bySeverity, total: alerts.length }, incidents: { active: activeIncidents, activeSos }, today: { assignments: scheduledToday, missedCheckpoints: missedCp }, queues: { pendingCorrections, pendingDevices }, realtimeConnections: ctx.app.hub.count(ctx.tenantId) };
    },
  },
];

async function verifyAudit(ctx: Ctx) {
  const tenant = (await ctx.app.store.findOne('tenants', { _id: ctx.tenantId }))!;
  const events = await ctx.col('audit_events').find({}, { sort: { seq: 1 }, limit: 2000000 });
  const r = verifyChain(events, tenant.auditAnchor?.hash ?? '');
  return { ...r, anchorSeq: tenant.auditAnchor?.seq ?? 0, verifiedAt: ctx.now(), firstSeq: events[0]?.seq ?? null, lastSeq: events[events.length - 1]?.seq ?? null };
}

export function registerRecords(app: App, storage: FileStorage) {
  app.register('records', routes);
  app.services.storage = storage;
  app.services.files = { storeGenerated, signedUrl, remove: removeFile };
  app.services.retention = { run: runRetention, tenantCounts };
  app.services.sign = (data: string) => hmacHex(app.config.fileUrlKey, `cfg|${data}`);
  app.services.verifyAudit = verifyAudit;

  app.jobs.register('export.run', async (p, j) => {
    const ctx = await app.systemCtxFor(j.tenantId!, 'export'); if (!ctx) return;
    const job = await ctx.col('export_jobs').get(p.exportId); if (!job || job.state === 'ready') return;
    // The export runs with the requester's CURRENT permissions and scope, re-read at execution time (TS §17.2).
    const m = job.requestedByMembershipId ? await ctx.col('memberships').get(job.requestedByMembershipId) : null; const user = await ctx.col('users').get(job.requestedBy);
    if (!m || m.status !== 'active' || !user || user.status !== 'active') { await ctx.col('export_jobs').update(job._id, { $set: { state: 'failed', failureCode: 'REQUESTER_NO_LONGER_AUTHORISED' } }); return; }
    const roles = await ctx.col('roles').find({ _id: { $in: m.roleIds } });
    const units = m.scopeUnitIds.includes('*') ? '*' as const : (await ctx.col('organization_units').find({ $or: [{ _id: { $in: m.scopeUnitIds } }, { ancestorIds: { $in: m.scopeUnitIds } }] })).map((u) => u._id);
    ctx.actor = { type: 'user', userId: user._id, membershipId: m._id, staffMemberId: m.staffMemberId, roleKeys: roles.map((r) => r.key), permissions: new Set(roles.flatMap((r) => r.permissionKeys as string[])), scopeUnitIds: units, assignedUnitIds: m.scopeUnitIds };
    try {
      const r = await runReport(ctx, job.reportType, job.filters);
      const head = [['SmartForce 360 export', r.report.title], ['Generated at (UTC)', new Date(r.asOf).toISOString()], ['Organisation timezone', r.timezone], ['Filters', JSON.stringify(r.filters)], ['Basis', r.report.note], ['Column basis', r.report.columns.map((c) => `${c.label}=${c.basis}`).join('; ')], ['Completeness', r.incomplete.note ?? 'No known gaps at generation time'], ['Rows', String(r.rows.length) + (r.truncated ? ' (truncated at the row limit)' : '')], []]
        .map((row) => row.map(csvCell).join(',')).join('\r\n');
      const labelled = r.rows.map((row) => Object.fromEntries(r.report.columns.map((c) => [c.label, row[c.key]])));
      const csv = head + '\r\n' + toCsv(r.report.columns.map((c) => c.label), labelled);
      await app.store.transaction(async () => {
        const file = await storeGenerated(ctx, { class: 'export', name: `${r.report.key}-${new Date(r.asOf).toISOString().slice(0, 10)}.csv`, mime: 'text/csv', data: Buffer.from('﻿' + csv) });
        await ctx.col('export_jobs').update(job._id, { $set: { state: 'ready', rowCount: r.rows.length, fileId: file._id, finishedAt: app.clock.now(), truncated: r.truncated } });
        await app.writeAudit(ctx, { action: 'export.generated', resource: { type: 'export', id: job._id }, detail: { reportType: job.reportType, filters: job.filters, rowCount: r.rows.length } });
        await app.services.notify.user(ctx, user._id, { template: 'export_ready', refType: 'export', refId: job._id, dedupeKey: `export:${job._id}` });
      });
    } catch (e) {
      if (e instanceof AppError && e.status < 500) { await ctx.col('export_jobs').update(job._id, { $set: { state: 'failed', failureCode: e.code } }); return; }
      throw e;
    }
  });
  app.jobs.register('tenant.export', async (p, j) => {
    const ctx = await app.systemCtxFor(j.tenantId!, 'tenant-export'); if (!ctx) return;
    const job = await ctx.col('export_jobs').get(p.exportId); if (!job || job.state === 'ready') return;
    ctx.actor = { ...ctx.actor, userId: job.requestedBy };
    await app.store.transaction(async () => {
      const file = await buildTenantExport(ctx);
      await ctx.col('export_jobs').update(job._id, { $set: { state: 'ready', fileId: file._id, finishedAt: app.clock.now(), sha256: file.sha256 } });
      await app.writeAudit(ctx, { action: 'tenant.export.generated', resource: { type: 'export', id: job._id }, detail: { sizeBytes: file.sizeBytes, sha256: file.sha256 } });
      await app.services.notify.user(ctx, job.requestedBy, { template: 'export_ready', refType: 'export', refId: job._id, dedupeKey: `export:${job._id}` });
    });
  });

  app.schedule('retention.nightly', 24 * 3600, async (tenant) => {
    if (!['active', 'trial', 'suspended', 'archived'].includes(tenant.status)) return;
    const ctx = (await app.systemCtxFor(tenant._id, 'retention'))!; await app.store.transaction(() => runRetention(ctx, false));
  });
  // Daily hash-chain verification; a failure is a security alert to the Owner (FR-AUD-002).
  app.schedule('audit.verify', 24 * 3600, async (tenant) => {
    if (tenant.status === 'deleted') return;
    const ctx = (await app.systemCtxFor(tenant._id, 'audit-verify'))!; const r = await verifyAudit(ctx);
    app.metrics.inc('sf_audit_verify_total', { result: r.ok ? 'ok' : 'broken' });
    if (!r.ok) { app.log.error('audit chain verification failed', { tenantId: tenant._id, brokenAtSeq: (r as { brokenAtSeq: number }).brokenAtSeq }); await app.services.notify.roles(ctx, ['owner'], { template: 'audit_chain_broken', refType: 'audit_log', refId: String((r as { brokenAtSeq: number }).brokenAtSeq), critical: true, dedupeKey: `auditbroken:${new Date(app.clock.now()).toISOString().slice(0, 10)}` }); }
  });
  // Tenant deletion after the grace period: irreversible, blocked by legal hold, ends with a certificate (FR-EXP-002).
  app.schedule('tenant.deletion', 3600, async (tenant) => {
    if (tenant.status !== 'pending_deletion' || !tenant.deletionScheduledAt || tenant.deletionScheduledAt > app.clock.now()) return;
    const ctx = (await app.systemCtxFor(tenant._id, 'tenant-deletion'))!;
    if (await activeHoldFor(ctx, 'tenant')) { app.log.warn('tenant deletion blocked by legal hold', { tenantId: tenant._id }); return; }
    const counts = await tenantCounts(ctx);
    for (const f of await ctx.col('file_objects').find({}, { limit: 1000000 })) await storage.delete(f.storageKey);
    await app.store.transaction(async () => {
      for (const [c, def] of Object.entries(COLLECTIONS)) if (def.tenantOwned) await app.store.deleteMany(c, { tenantId: tenant._id }, { retention: true });
      await app.store.deleteMany('jobs', { tenantId: tenant._id }); await app.store.deleteMany('outbox_events', { tenantId: tenant._id }); await app.store.deleteMany('counters', { tenantId: tenant._id });
      const certificate = { tenantId: tenant._id, slug: tenant.slug, deletedAt: new Date(app.clock.now()).toISOString(), recordsDeleted: counts, total: Object.values(counts).reduce((a, b) => a + b, 0), backups: 'Backups expire under the documented backup-retention schedule; restore tooling replays deletions (docs/runbooks/backup-restore.md).' };
      await app.store.updateOne('tenants', { _id: tenant._id }, { $set: { status: 'deleted', name: `deleted-${tenant._id.slice(-6)}`, slug: `deleted-${tenant._id}`, deletedAt: app.clock.now(), deletionCertificate: { ...certificate, sha256: sha256Hex(JSON.stringify(certificate)) } }, $unset: ['ownerMembershipId', 'provisionKey'] });
      await app.writeAudit(null, { action: 'tenant.deleted', resource: { type: 'tenant', id: tenant._id }, detail: { total: certificate.total } }, { actor: ctx.actor, requestId: ctx.requestId, ip: '' });
    });
  });
}
