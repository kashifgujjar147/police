// Privacy and employee transparency (FR-PRV-001..003, 006): notices, acknowledgement gating, self-view, subject export/deletion.
import { App, AppError, Ctx, type Doc, type Route, created, s } from '@sf/kernel';
import { revokeSessions } from '../identity/index.ts';

export async function currentNotice(ctx: Ctx): Promise<Doc | null> {
  return ctx.col('privacy_notice_versions').findOne({ effectiveFrom: { $lte: ctx.now() } }, { sort: { version: -1 } });
}
/** Tracking cannot start until the current notice version is acknowledged (FR-PRV-002). */
export async function assertNoticeAcknowledged(ctx: Ctx, staffMemberId: string) {
  const notice = await currentNotice(ctx);
  if (!notice) throw new AppError('NOTICE_NOT_ACKNOWLEDGED', 'Your organisation has not published a privacy notice yet. Duty tracking cannot start until it does.');
  const ack = await ctx.col('policy_acknowledgements').findOne({ staffMemberId, noticeVersion: notice.version });
  if (!ack) throw new AppError('NOTICE_NOT_ACKNOWLEDGED', 'Read and accept the current privacy notice before starting duty.', { details: { noticeVersion: notice.version } });
}
export async function activeHoldFor(ctx: Ctx, kind: 'tenant' | 'staff' | 'incident', id?: string): Promise<Doc | null> {
  const holds = await ctx.col('legal_holds').find({ releasedAt: null });
  return holds.find((h) => h.scope.kind === 'tenant' || (h.scope.kind === kind && h.scope.id === id)) ?? null;
}
const SUBJECT_CLASSES: [string, string][] = [['duty_assignments', 'staffMemberId'], ['attendance_events', 'staffMemberId'], ['correction_requests', 'staffMemberId'], ['location_points', 'staffMemberId'], ['geofence_events', 'staffMemberId'], ['checkpoint_scans', 'staffMemberId'], ['sos_events', 'staffMemberId'], ['incidents', 'reportedByStaffId'], ['policy_acknowledgements', 'staffMemberId'], ['devices', 'staffMemberId'], ['location_access_log', 'staffMemberId']];

const routes: Route[] = [
  { method: 'GET', path: '/privacy/notices/current', permission: 'session', scope: 'own', audit: { none: 'notice read' }, rate: 'read', summary: 'Current privacy notice (localised) and whether the caller has accepted it', reqs: ['FR-PRV-002'],
    async handler(ctx) { const n = await currentNotice(ctx); const ack = n && ctx.actor.staffMemberId ? await ctx.col('policy_acknowledgements').findOne({ staffMemberId: ctx.actor.staffMemberId, noticeVersion: n.version }) : null; return { notice: n, acknowledged: !!ack, acknowledgedAt: ack?.acknowledgedAt ?? null }; } },
  { method: 'GET', path: '/privacy/notices', permission: 'settings.read', scope: 'tenant', audit: { none: 'notice history read' }, rate: 'read', summary: 'All notice versions with acceptance counts', reqs: ['FR-PRV-002'],
    async handler(ctx) { const items = await ctx.col('privacy_notice_versions').find({}, { sort: { version: -1 } }); return { items: await Promise.all(items.map(async (n) => ({ ...n, acknowledgements: await ctx.col('policy_acknowledgements').count({ noticeVersion: n.version }) }))) }; } },
  {
    method: 'POST', path: '/privacy/notices', permission: 'privacy.notice.manage', scope: 'tenant', audit: 'privacy.notice.publish', rate: 'mutation', summary: 'Publish a new notice version; staff must re-acknowledge before tracking', reqs: ['FR-PRV-002'],
    body: s.object({ texts: s.object({ en: s.string({ min: 20, max: 20000 }), ar: s.string({ min: 20, max: 20000 }) }), effectiveFrom: s.optional(s.iso()) }),
    async handler(ctx, { body }) {
      const last = await ctx.col('privacy_notice_versions').findOne({}, { sort: { version: -1 } });
      const n = await ctx.col('privacy_notice_versions').insert({ version: (last?.version ?? 0) + 1, texts: body.texts, effectiveFrom: body.effectiveFrom ? Date.parse(body.effectiveFrom) : ctx.now(), publishedBy: ctx.actor.userId, createdAt: ctx.now() });
      ctx.setAudit({ resource: { type: 'privacy_notice', id: String(n.version) }, after: { version: n.version } });
      return created(n);
    },
  },
  {
    method: 'POST', path: '/privacy/acknowledgements', permission: 'session', scope: 'own', audit: 'privacy.notice.acknowledge', rate: 'mutation', summary: 'Record acceptance of a notice version (version, time, device)', reqs: ['FR-PRV-002'], body: s.object({ version: s.number({ int: true, min: 1 }) }),
    async handler(ctx, { body }) {
      if (!ctx.actor.staffMemberId) throw new AppError('FORBIDDEN', 'Only staff members acknowledge the notice.');
      const n = await currentNotice(ctx);
      if (!n || n.version !== body.version) throw new AppError('CONFLICT', 'A newer notice has been published. Read the current version.', { details: { currentVersion: n?.version ?? null } });
      const prior = await ctx.col('policy_acknowledgements').findOne({ staffMemberId: ctx.actor.staffMemberId, noticeVersion: n.version });
      const ack = prior ?? await ctx.col('policy_acknowledgements').insert({ staffMemberId: ctx.actor.staffMemberId, noticeVersion: n.version, acknowledgedAt: ctx.now(), deviceId: ctx.actor.deviceId ?? null });
      ctx.setAudit({ resource: { type: 'privacy_notice', id: String(n.version) } });
      return ack;
    },
  },
  {
    method: 'GET', path: '/me/data', permission: 'self.read', scope: 'own', audit: { none: 'own data self-view' }, rate: 'read', summary: 'What is collected, whether tracking is active, own recent locations and attendance', reqs: ['FR-PRV-001'],
    async handler(ctx) {
      const id = ctx.actor.staffMemberId; if (!id) return { staff: null };
      const since = ctx.now() - 7 * 86400000; const n = await currentNotice(ctx);
      const [staff, session, attendance, points, acks, devices] = await Promise.all([
        ctx.col('staff_members').get(id), ctx.col('duty_tracking_sessions').findOne({ staffMemberId: id, state: 'open' }), ctx.col('attendance_events').find({ staffMemberId: id, receivedAt: { $gte: since } }, { sort: { receivedAt: -1 }, limit: 200 }),
        ctx.col('location_points').find({ staffMemberId: id, recordedAt: { $gte: ctx.now() - 86400000 } }, { sort: { recordedAt: -1 }, limit: 500 }), ctx.col('policy_acknowledgements').find({ staffMemberId: id }, { sort: { noticeVersion: -1 } }), ctx.col('devices').find({ staffMemberId: id }),
      ]);
      return {
        staff: staff ? { id: staff._id, employeeCode: staff.employeeCode, displayName: staff.displayName, rankTitle: staff.rankTitle, status: staff.status } : null,
        tracking: { active: !!session, since: session?.openedAt ?? null, assignmentId: session?.assignmentId ?? null, profile: session?.profile ?? null },
        collected: ['duty start, end and break times', 'location points only while a duty tracking session is open', 'checkpoint scans', 'device health (battery, network, permission state)', 'incident and SOS reports you file'],
        noticeVersion: n?.version ?? null, acknowledgements: acks, attendance, recentLocations: points.map((p) => ({ recordedAt: p.recordedAt, lat: p.lat, lon: p.lon, accuracyM: p.accuracyM, assignmentId: p.assignmentId })), devices, retentionDays: ctx.settings.retentionDays,
      };
    },
  },
  { method: 'GET', path: '/me/location-access-log', permission: 'self.read', scope: 'own', audit: { none: 'own access log self-view' }, rate: 'read', summary: 'Who accessed the caller\'s location history, when and why', reqs: ['FR-PRV-001', 'FR-LOC-006'],
    async handler(ctx) {
      if (!ctx.actor.staffMemberId) return { items: [] };
      const items = await ctx.col('location_access_log').find({ staffMemberId: ctx.actor.staffMemberId }, { sort: { at: -1 }, limit: 200 });
      const staff = await ctx.col('staff_members').find({ userId: { $in: items.map((i) => i.accessedByUserId) } });
      return { items: items.map((i) => ({ at: i.at, purpose: i.purpose, range: { from: i.from, to: i.to }, accessedBy: staff.find((x) => x.userId === i.accessedByUserId)?.displayName ?? (i.actorType === 'support' ? 'Platform support (approved grant)' : 'Authorised user'), actorType: i.actorType })) };
    } },
  {
    method: 'POST', path: '/staff/:id/data-export', permission: 'privacy.subject.manage', scope: 'tenant', audit: 'privacy.subject.export', rate: 'export', summary: 'Export every data class held about one person', reqs: ['FR-PRV-003'], body: s.object({ reason: s.string({ min: 5, max: 500 }) }),
    async handler(ctx, { params, body }) {
      const st = await ctx.col('staff_members').must(params.id!, 'Staff member');
      const data: Record<string, Doc[]> = {}; const counts: Record<string, number> = {};
      for (const [c, field] of SUBJECT_CLASSES) { data[c] = await ctx.col(c).find({ [field]: st._id }, { limit: 200000 }); counts[c] = data[c]!.length; }
      const user = st.userId ? await ctx.col('users').get(st.userId) : null;
      const pkg = { schema: 'smartforce360.subject-export/1', generatedAt: new Date(ctx.now()).toISOString(), staffMember: { ...st, contact: st.contactEnc ? JSON.parse(ctx.app.crypto.decrypt(st.contactEnc)) : null, contactEnc: undefined }, account: user ? { username: user.username, email: user.email, createdAt: user.createdAt, lastLoginAt: user.lastLoginAt ?? null } : null, classes: data, counts };
      const file = await ctx.app.services.files.storeGenerated(ctx, { class: 'subject-export', name: `subject-export-${st.employeeCode}.json`, mime: 'application/json', data: Buffer.from(JSON.stringify(pkg, null, 1)), ownerRef: { type: 'staff', id: st._id } });
      ctx.setAudit({ resource: { type: 'staff', id: st._id }, reason: body.reason, detail: { counts, fileId: file._id } });
      return created({ completion: { kind: 'subject_export', staffMemberId: st._id, counts, completedAt: ctx.now() }, fileId: file._id, download: await ctx.app.services.files.signedUrl(ctx, file) });
    },
  },
  {
    method: 'POST', path: '/staff/:id/data-deletion', permission: 'privacy.subject.manage', scope: 'tenant', audit: 'privacy.subject.delete', rate: 'mutation', summary: 'Delete or pseudonymise a person\'s data, honouring legal hold and retention', reqs: ['FR-PRV-003', 'FR-PRV-005'],
    body: s.object({ reason: s.string({ min: 5, max: 500 }), dryRun: s.optional(s.boolean()) }),
    async handler(ctx, { params, body }) {
      const st = await ctx.col('staff_members').must(params.id!, 'Staff member');
      const hold = await activeHoldFor(ctx, 'staff', st._id);
      const counts = { locationPoints: await ctx.col('location_points').count({ staffMemberId: st._id }), devices: await ctx.col('devices').count({ staffMemberId: st._id }), retainedPseudonymised: (await ctx.col('attendance_events').count({ staffMemberId: st._id })) + (await ctx.col('checkpoint_scans').count({ staffMemberId: st._id })) };
      if (body.dryRun) { ctx.setAudit({ action: 'privacy.subject.delete.dry_run', resource: { type: 'staff', id: st._id }, detail: counts }); return { dryRun: true, blockedByLegalHold: !!hold, wouldDelete: counts }; }
      if (hold) throw new AppError('LEGAL_HOLD', 'A legal hold covers this person. Deletion is blocked until the hold is released.', { details: { holdId: hold._id } });
      if (st.status !== 'offboarded') throw new AppError('INVALID_STATE_TRANSITION', 'Offboard the person before deleting their personal data.');
      await ctx.col('location_points').delete({ staffMemberId: st._id }, { retention: true });
      await ctx.col('staff_location_states').delete({ staffMemberId: st._id });
      await ctx.col('devices').delete({ staffMemberId: st._id });
      await ctx.col('team_memberships').delete({ staffMemberId: st._id });
      if (st.userId) { await revokeSessions(ctx, { userId: st.userId }, 'subject_deleted'); await ctx.col('mfa_factors').delete({ userId: st.userId }); await ctx.col('memberships').delete({ userId: st.userId }); await ctx.col('users').delete({ _id: st.userId }); }
      if (st.photoFileId) await ctx.app.services.files.remove(ctx, st.photoFileId);
      // Attendance, scans and incident records are retained per retention policy but no longer identify the person.
      const pseudo = `DELETED-${st._id.slice(-6).toUpperCase()}`;
      await ctx.col('staff_members').update(st._id, { $set: { employeeCode: pseudo, displayName: 'Deleted staff member', rankTitle: null, supervisorId: null, userId: null, photoFileId: null, pseudonymisedAt: ctx.now() }, $unset: ['contactEnc'], $inc: { version: 1 } });
      const completion = { kind: 'subject_deletion', staffMemberId: st._id, deleted: { locationPoints: counts.locationPoints, devices: counts.devices, account: true, contact: true }, retainedPseudonymised: counts.retainedPseudonymised, completedAt: ctx.now() };
      ctx.setAudit({ resource: { type: 'staff', id: st._id }, reason: body.reason, detail: completion });
      return { completion };
    },
  },
];
export function registerPrivacy(app: App) { app.register('privacy', routes); }
