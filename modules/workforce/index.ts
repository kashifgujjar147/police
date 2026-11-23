// Workforce: staff members, lifecycle, invitations, CSV import and devices (FR-ORG-002..004, 008; FR-DEV-001..005).
import { DeviceMachine, StaffMachine, type StaffStatus } from '@sf/contracts';
import { parseCsv, toCsv } from '@sf/domain';
import { createPublicKey } from 'node:crypto';
import { App, AppError, Ctx, type Doc, type Route, created, paginate, s, sha256 } from '@sf/kernel';
import { issueInvitation, revokeSessions } from '../identity/index.ts';
import { resolveRolesAndScope } from '../access/index.ts';
import { assertPlanLimit } from '../tenancy/provision.ts';

const pageQuery = { limit: s.optional(s.number({ int: true, min: 1, max: 200 })), cursor: s.optional(s.string({ max: 300 })) };
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Role-based masking of sensitive personal fields (FR-ORG-008): contact details only for managers of the record or the person. */
function staffView(ctx: Ctx, st: Doc) {
  const { contactEnc, ...rest } = st;
  const mayContact = ctx.can('staff.update') || st._id === ctx.actor.staffMemberId || st.supervisorId === ctx.actor.staffMemberId;
  let contact: unknown = null;
  if (contactEnc && mayContact) { try { contact = JSON.parse(ctx.app.crypto.decrypt(contactEnc)); } catch { contact = null; } }
  return { ...rest, contact, contactMasked: !!contactEnc && !mayContact };
}
async function loadStaff(ctx: Ctx, id: string): Promise<Doc> {
  const st = await ctx.col('staff_members').must(id, 'Staff member');
  if (st._id !== ctx.actor.staffMemberId) ctx.assertScope(st.homeUnitId, 'Staff member');
  return st;
}

interface NewStaff { employeeCode: string; displayName: string; rankTitle?: string; homeUnitId: string; supervisorId?: string; email?: string; phone?: string; username?: string; roleIds?: string[]; scopeUnitIds?: string[] }
async function createStaff(ctx: Ctx, input: NewStaff): Promise<{ staff: Doc; user: Doc }> {
  const unit = await ctx.col('organization_units').must(input.homeUnitId, 'Home unit'); ctx.assertScope(unit._id, 'Home unit');
  if (input.supervisorId) { const sup = await ctx.col('staff_members').must(input.supervisorId, 'Supervisor'); ctx.assertScope(sup.homeUnitId, 'Supervisor'); }
  const fieldRole = (await ctx.col('roles').findOne({ key: 'field', isDefault: true }))!;
  const rs = await resolveRolesAndScope(ctx, input.roleIds ?? [fieldRole._id], input.scopeUnitIds ?? [unit._id]);
  const now = ctx.now();
  const staff = await ctx.col('staff_members').insert({
    employeeCode: input.employeeCode, displayName: input.displayName, rankTitle: input.rankTitle ?? null, homeUnitId: unit._id, supervisorId: input.supervisorId ?? null, status: 'invited',
    ...(input.email || input.phone ? { contactEnc: ctx.app.crypto.encrypt(JSON.stringify({ email: input.email ?? null, phone: input.phone ?? null })) } : {}), createdAt: now, updatedAt: now, version: 1,
  });
  const user = await ctx.col('users').insert({ username: (input.username ?? input.employeeCode).toLowerCase(), email: input.email ?? null, ...(input.email ? { emailKey: input.email.toLowerCase() } : {}), passwordHash: null, status: 'active', mfaEnabled: false, failedLogins: 0, lockedUntil: null, sessionVersion: 1, createdAt: now });
  await ctx.col('memberships').insert({ userId: user._id, staffMemberId: staff._id, roleIds: rs.roleIds, scopeUnitIds: rs.scopeUnitIds, status: 'active', createdAt: now, version: 1 });
  return { staff: (await ctx.col('staff_members').update(staff._id, { $set: { userId: user._id } }))!, user };
}

/** Closes tracking, revokes sessions and devices, and flags future assignments for reassignment (FR-ORG-004). */
async function withdrawAccess(ctx: Ctx, staff: Doc, reason: string, removeFuture: boolean) {
  const out = { sessionsRevoked: 0, devicesRevoked: 0, assignmentsFlagged: [] as string[], activeDuty: [] as string[] };
  if (staff.userId) { out.sessionsRevoked = await revokeSessions(ctx, { userId: staff.userId }, reason); await ctx.col('users').update(staff.userId, { $inc: { sessionVersion: 1 } }); }
  for (const d of await ctx.col('devices').find({ staffMemberId: staff._id, status: { $in: ['active', 'pending_approval'] } })) { await revokeDevice(ctx, d, reason); out.devicesRevoked++; }
  const active = await ctx.col('duty_assignments').find({ staffMemberId: staff._id, status: { $in: ['started', 'on_break'] } });
  out.activeDuty = active.map((a) => a._id);
  if (removeFuture) for (const a of await ctx.col('duty_assignments').find({ staffMemberId: staff._id, status: 'scheduled', startsAt: { $gt: ctx.now() } })) {
    await ctx.col('duty_assignments').update(a._id, { $set: { status: 'cancelled', cancelReason: reason, needsReassignment: true, updatedAt: ctx.now() }, $unset: ['slotKey'] });
    await ctx.col('assignment_history').insert({ assignmentId: a._id, at: ctx.now(), actorId: ctx.actor.userId, change: 'cancelled', reason });
    out.assignmentsFlagged.push(a._id);
  }
  return out;
}
export async function revokeDevice(ctx: Ctx, device: Doc, reason: string) {
  DeviceMachine.assert(device.status, 'revoked');
  await ctx.col('devices').update(device._id, { $set: { status: 'revoked', revokedAt: ctx.now(), revokedReason: reason }, $unset: ['pushTokenEnc'] });
  await revokeSessions(ctx, { deviceId: device._id }, 'device_revoked');
  for (const ts of await ctx.col('duty_tracking_sessions').find({ deviceId: device._id, state: 'open' })) await ctx.app.services.tracking.close(ctx, ts, 'device_revoked');
}

const staffBody = {
  employeeCode: s.string({ min: 1, max: 40, pattern: /^[A-Za-z0-9._\-؀-ۿ]+$/ }), displayName: s.string({ min: 1, max: 120 }), rankTitle: s.optional(s.string({ max: 80 })), homeUnitId: s.id(), supervisorId: s.optional(s.id()),
  email: s.optional(s.string({ max: 200, pattern: EMAIL })), phone: s.optional(s.string({ max: 30, pattern: /^[+0-9 ()-]{5,30}$/ })), username: s.optional(s.string({ min: 3, max: 60, pattern: /^[a-z0-9._-]+$/i })),
  roleIds: s.optional(s.array(s.id(), { min: 1, max: 10 })), scopeUnitIds: s.optional(s.array(s.string({ max: 64 }), { min: 1, max: 50 })),
};
const IMPORT_COLUMNS = ['employeeCode', 'displayName', 'rankTitle', 'unitCode', 'email', 'phone', 'username'] as const;

async function runImport(ctx: Ctx, csv: string, mapping: Record<string, unknown> | undefined, commit: boolean) {
  const rows = parseCsv(csv, 5001);
  if (rows.length < 2) throw new AppError('VALIDATION_FAILED', 'The file has no data rows.');
  if (rows.length > 5001) throw new AppError('VALIDATION_FAILED', 'A file may contain at most 5,000 rows.');
  const header = rows[0]!.map((h) => h.trim());
  const col = (field: string) => header.indexOf(String(mapping?.[field] ?? field));
  const idx = Object.fromEntries(IMPORT_COLUMNS.map((f) => [f, col(f)])) as Record<(typeof IMPORT_COLUMNS)[number], number>;
  const missing = (['employeeCode', 'displayName', 'unitCode'] as const).filter((f) => idx[f] < 0);
  if (missing.length) throw new AppError('VALIDATION_FAILED', `Required columns are missing: ${missing.join(', ')}. Map them or rename the file columns.`, { details: { header, expected: IMPORT_COLUMNS } });
  const units = await ctx.col('organization_units').find(ctx.scopeFilter('_id'), { limit: 5000 });
  const byCode = new Map(units.filter((u) => u.code).map((u) => [String(u.code).toLowerCase(), u]));
  const existing = new Set((await ctx.col('staff_members').find({}, { limit: 100000 })).map((x) => String(x.employeeCode).toLowerCase()));
  const seen = new Set<string>(); const report: { row: number; employeeCode: string; status: 'ok' | 'skipped' | 'error' | 'created'; reasons: string[] }[] = [];
  let createdCount = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!; const get = (f: (typeof IMPORT_COLUMNS)[number]) => (idx[f] >= 0 ? (r[idx[f]] ?? '').trim() : '');
    const code = get('employeeCode'), reasons: string[] = [];
    if (!code) reasons.push('employeeCode is required'); else if (!/^[A-Za-z0-9._\-؀-ۿ]{1,40}$/.test(code)) reasons.push('employeeCode has invalid characters');
    if (!get('displayName')) reasons.push('displayName is required');
    const unit = byCode.get(get('unitCode').toLowerCase()); if (!unit) reasons.push(`unitCode "${get('unitCode')}" was not found in your scope`);
    if (get('email') && !EMAIL.test(get('email'))) reasons.push('email is not valid');
    if (seen.has(code.toLowerCase())) reasons.push('employeeCode is repeated in this file');
    seen.add(code.toLowerCase());
    if (reasons.length) { report.push({ row: i + 1, employeeCode: code, status: 'error', reasons }); continue; }
    if (existing.has(code.toLowerCase())) { report.push({ row: i + 1, employeeCode: code, status: 'skipped', reasons: ['already exists (idempotent re-run)'] }); continue; }
    if (commit) {
      await createStaff(ctx, { employeeCode: code, displayName: get('displayName'), rankTitle: get('rankTitle') || undefined, homeUnitId: unit!._id, email: get('email') || undefined, phone: get('phone') || undefined, username: get('username') || undefined });
      createdCount++; report.push({ row: i + 1, employeeCode: code, status: 'created', reasons: [] });
    } else report.push({ row: i + 1, employeeCode: code, status: 'ok', reasons: [] });
  }
  const summary = { rows: rows.length - 1, valid: report.filter((x) => x.status === 'ok' || x.status === 'created').length, created: createdCount, skipped: report.filter((x) => x.status === 'skipped').length, errors: report.filter((x) => x.status === 'error').length };
  return { summary, report, header, errorReportCsv: toCsv(['row', 'employeeCode', 'status', 'reasons'], report.filter((x) => x.status !== 'ok' && x.status !== 'created').map((x) => ({ ...x, reasons: x.reasons.join('; ') }))) };
}

const routes: Route[] = [
  {
    method: 'GET', path: '/staff', permission: 'staff.read', scope: 'unit', audit: { none: 'staff list read' }, rate: 'read', summary: 'Staff members within scope', reqs: ['FR-ORG-002', 'FR-ORG-006'],
    query: s.object({ ...pageQuery, status: s.optional(s.enum(['invited', 'active', 'suspended', 'offboarded'])), unitId: s.optional(s.id()), teamId: s.optional(s.id()), q: s.optional(s.string({ max: 80 })) }),
    async handler(ctx, { query }) {
      const f: Record<string, unknown> = { ...ctx.scopeFilter('homeUnitId') };
      if (query.unitId) { ctx.assertScope(query.unitId, 'Unit'); f.homeUnitId = query.unitId; }
      if (query.status) f.status = query.status;
      if (query.teamId) f._id = { $in: (await ctx.col('team_memberships').find({ teamId: query.teamId })).map((m) => m.staffMemberId) };
      if (query.q) { const q = query.q.toLowerCase(); const all = (await ctx.col('staff_members').find(f, { sort: { displayName: 1 }, limit: 5000 })).filter((x) => String(x.displayName).toLowerCase().includes(q) || String(x.employeeCode).toLowerCase().includes(q)); return { items: all.slice(0, 200).map((x) => staffView(ctx, x)), nextCursor: null }; }
      const page = await paginate(ctx.col('staff_members'), f, query, 'createdAt', -1);
      return { ...page, items: page.items.map((x) => staffView(ctx, x)) };
    },
  },
  {
    method: 'POST', path: '/staff', permission: 'staff.create', scope: 'unit', audit: 'staff.create', rate: 'mutation', summary: 'Create a staff member with a sign-in identity (email optional)', reqs: ['FR-ORG-002', 'FR-AUTH-001', 'FR-SUB-001'], body: s.object(staffBody),
    async handler(ctx, { body }) {
      await assertPlanLimit(ctx, 'activeStaff');
      const { staff } = await createStaff(ctx, body);
      ctx.setAudit({ resource: { type: 'staff', id: staff._id }, after: { employeeCode: staff.employeeCode, homeUnitId: staff.homeUnitId } });
      return created(staffView(ctx, staff));
    },
  },
  { method: 'GET', path: '/staff/:id', permission: 'staff.read', scope: 'unit', audit: { none: 'read of staff data within scope' }, rate: 'read', summary: 'Staff member profile (sensitive fields masked by role)', reqs: ['FR-ORG-008'],
    async handler(ctx, { params }) { const st = await loadStaff(ctx, params.id!); const m = await ctx.col('memberships').findOne({ staffMemberId: st._id }); const teams = await ctx.col('team_memberships').find({ staffMemberId: st._id }); return { ...staffView(ctx, st), membershipId: m?._id ?? null, membershipVersion: m?.version ?? null, roleIds: m?.roleIds ?? [], scopeUnitIds: m?.scopeUnitIds ?? [], teamIds: teams.map((t) => t.teamId) }; } },
  {
    method: 'PATCH', path: '/staff/:id', permission: 'staff.update', scope: 'unit', audit: 'staff.update', rate: 'mutation', summary: 'Update a staff member', reqs: ['FR-ORG-002'],
    body: s.object({ version: s.number({ int: true }), displayName: s.optional(s.string({ min: 1, max: 120 })), rankTitle: s.optional(s.string({ max: 80 })), homeUnitId: s.optional(s.id()), supervisorId: s.optional(s.id()), email: s.optional(s.string({ max: 200, pattern: EMAIL })), phone: s.optional(s.string({ max: 30, pattern: /^[+0-9 ()-]{5,30}$/ })) }),
    async handler(ctx, { params, body }) {
      const st = await loadStaff(ctx, params.id!); const { version, email, phone, ...set } = body;
      if (set.homeUnitId) ctx.assertScope((await ctx.col('organization_units').must(set.homeUnitId, 'Home unit'))._id, 'Home unit');
      if (set.supervisorId) { if (set.supervisorId === st._id) throw new AppError('VALIDATION_FAILED', 'A person cannot be their own supervisor.'); ctx.assertScope((await ctx.col('staff_members').must(set.supervisorId, 'Supervisor')).homeUnitId, 'Supervisor'); }
      const patch: Record<string, unknown> = { ...set, updatedAt: ctx.now() };
      if (email !== undefined || phone !== undefined) {
        const cur = st.contactEnc ? JSON.parse(ctx.app.crypto.decrypt(st.contactEnc)) : {};
        patch.contactEnc = ctx.app.crypto.encrypt(JSON.stringify({ email: email ?? cur.email ?? null, phone: phone ?? cur.phone ?? null }));
        if (email && st.userId) await ctx.col('users').update(st.userId, { $set: { email, emailKey: email.toLowerCase(), emailVerifiedAt: null } });
      }
      const out = await ctx.col('staff_members').updateVersioned(st._id, version, patch);
      ctx.setAudit({ resource: { type: 'staff', id: st._id }, before: Object.fromEntries(Object.keys(set).map((k) => [k, st[k]])), after: set, detail: { contactChanged: email !== undefined || phone !== undefined } });
      return staffView(ctx, out);
    },
  },
  ...(['suspend', 'reinstate', 'offboard'] as const).map((action): Route => ({
    method: 'POST', path: `/staff/:id/${action}`, permission: 'staff.lifecycle', scope: 'unit', audit: `staff.${action}`, rate: 'mutation', summary: `Staff lifecycle: ${action}`, reqs: ['FR-ORG-002', 'FR-ORG-004'], body: s.object({ reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      const st = await loadStaff(ctx, params.id!); const to: StaffStatus = action === 'suspend' ? 'suspended' : action === 'offboard' ? 'offboarded' : 'active';
      if (st._id === ctx.actor.staffMemberId) throw new AppError('FORBIDDEN', 'You cannot change your own employment status.');
      StaffMachine.assert(st.status, to);
      const effects = to === 'active' ? null : await withdrawAccess(ctx, st, `staff_${to}`, to === 'offboarded');
      await ctx.col('staff_members').update(st._id, { $set: { status: to, statusReason: body.reason, updatedAt: ctx.now(), ...(to === 'offboarded' ? { offboardedAt: ctx.now() } : {}) }, $inc: { version: 1 } });
      if (to === 'offboarded' && st.userId) await ctx.col('users').update(st.userId, { $set: { status: 'disabled' } });
      ctx.setAudit({ resource: { type: 'staff', id: st._id }, reason: body.reason, before: { status: st.status }, after: { status: to, ...effects } });
      return { status: to, effects };
    },
  })),
  {
    method: 'POST', path: '/staff/:id/invitation', permission: 'staff.invite', scope: 'unit', audit: 'staff.invite', rate: 'mutation', summary: 'Issue a single-use activation code (shown once) or email invitation', reqs: ['FR-AUTH-001'], body: s.object({ channel: s.enum(['code', 'email']) }),
    async handler(ctx, { params, body }) {
      const st = await loadStaff(ctx, params.id!);
      if (st.status === 'offboarded' || st.status === 'suspended') throw new AppError('INVALID_STATE_TRANSITION', 'This person is not active.');
      const user = await ctx.col('users').must(st.userId, 'User account');
      if (body.channel === 'email' && !user.email) throw new AppError('VALIDATION_FAILED', 'This person has no email address. Issue an activation code instead.');
      const inv = await issueInvitation(ctx, { user, staffMemberId: st._id, channel: body.channel, purpose: user.passwordHash ? 'reset' : 'activate' });
      ctx.setAudit({ resource: { type: 'staff', id: st._id }, detail: { channel: body.channel, purpose: user.passwordHash ? 'reset' : 'activate' } });
      return created({ username: user.username, expiresAt: inv.expiresAt, ...(body.channel === 'code' ? { activationCode: inv.code, note: 'Shown once. Hand it to the staff member in person.' } : { sentTo: 'email on file' }) });
    },
  },
  {
    method: 'POST', path: '/staff/import/dry-run', permission: 'staff.import', scope: 'unit', audit: 'staff.import.dry_run', rate: 'mutation', summary: 'Validate a staff CSV and preview per-row results without changing data', reqs: ['FR-ORG-003'],
    body: s.object({ csv: s.string({ min: 1, max: 240000, trim: false }), mapping: s.optional(s.json(1)) }),
    async handler(ctx, { body }) { const out = await runImport(ctx, body.csv, body.mapping, false); ctx.setAudit({ resource: { type: 'staff_import', id: null }, detail: out.summary }); return out; },
  },
  {
    method: 'POST', path: '/staff/import', permission: 'staff.import', scope: 'unit', audit: 'staff.import', rate: 'mutation', summary: 'Import staff from CSV with a per-row success/failure report; re-running the same file creates nothing new', reqs: ['FR-ORG-003'],
    body: s.object({ csv: s.string({ min: 1, max: 240000, trim: false }), mapping: s.optional(s.json(1)) }),
    async handler(ctx, { body }) {
      const fileHash = sha256(body.csv); const prior = await ctx.col('import_runs').findOne({ fileHash });
      const dry = await runImport(ctx, body.csv, body.mapping, false);
      await assertPlanLimit(ctx, 'activeStaff', dry.summary.valid);
      const out = await runImport(ctx, body.csv, body.mapping, true);
      if (prior) await ctx.col('import_runs').update(prior._id, { $set: { lastRunAt: ctx.now(), lastSummary: out.summary }, $inc: { runs: 1 } });
      else await ctx.col('import_runs').insert({ fileHash, firstRunAt: ctx.now(), lastRunAt: ctx.now(), runs: 1, lastSummary: out.summary, requestedBy: ctx.actor.userId });
      ctx.setAudit({ resource: { type: 'staff_import', id: fileHash.slice(0, 16) }, detail: { ...out.summary, rerun: !!prior } });
      return { ...out, rerun: !!prior };
    },
  },
  {
    method: 'POST', path: '/staff/bulk-update', permission: 'staff.update', scope: 'unit', audit: 'staff.bulk_update', rate: 'mutation', summary: 'Bulk update with one audit summary listing the affected count', reqs: ['FR-ORG-008'],
    body: s.object({ staffMemberIds: s.array(s.id(), { min: 1, max: 500 }), set: s.object({ homeUnitId: s.optional(s.id()), rankTitle: s.optional(s.string({ max: 80 })), supervisorId: s.optional(s.id()) }), reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { body }) {
      if (!Object.keys(body.set).length) throw new AppError('VALIDATION_FAILED', 'Nothing to change.');
      if (body.set.homeUnitId) ctx.assertScope((await ctx.col('organization_units').must(body.set.homeUnitId, 'Home unit'))._id, 'Home unit');
      const staff = await ctx.col('staff_members').find({ _id: { $in: body.staffMemberIds }, ...ctx.scopeFilter('homeUnitId') });
      if (staff.length !== new Set(body.staffMemberIds).size) throw new AppError('NOT_FOUND', 'One or more staff members were not found');
      for (const st of staff) await ctx.col('staff_members').update(st._id, { $set: { ...body.set, updatedAt: ctx.now() }, $inc: { version: 1 } });
      ctx.setAudit({ resource: { type: 'staff', id: null }, reason: body.reason, after: body.set, detail: { affectedCount: staff.length } });
      return { affectedCount: staff.length };
    },
  },
  {
    method: 'GET', path: '/staff/:id/summary', permission: 'staff.read', scope: 'unit', audit: { none: 'staff timeline read (no coordinates)' }, rate: 'read', summary: 'Timeline of assignments, attendance, checkpoint events and incidents within scope', reqs: ['FR-ORG-008'],
    async handler(ctx, { params }) {
      const st = await loadStaff(ctx, params.id!); const f = { staffMemberId: st._id };
      const [assignments, attendance, scans, incidents, devices] = await Promise.all([
        ctx.col('duty_assignments').find(f, { sort: { startsAt: -1 }, limit: 30 }), ctx.col('attendance_events').find(f, { sort: { receivedAt: -1 }, limit: 50 }),
        ctx.col('checkpoint_scans').find(f, { sort: { receivedAt: -1 }, limit: 50 }), ctx.col('incidents').find({ reportedByStaffId: st._id }, { sort: { createdAt: -1 }, limit: 20 }), ctx.col('devices').find(f, { sort: { createdAt: -1 }, limit: 10 }),
      ]);
      const strip = (d: Doc) => { const { location: _l, ...rest } = d; return rest; };
      return { staff: staffView(ctx, st), assignments, attendance: attendance.map(strip), scans: scans.map(strip), incidents: incidents.map(strip), devices };
    },
  },
  // ---- devices ----
  { method: 'GET', path: '/devices', permission: 'device.read', scope: 'unit', audit: { none: 'device list read' }, rate: 'read', summary: 'Devices of staff within scope', reqs: ['FR-DEV-001', 'FR-DEV-005'], query: s.object({ ...pageQuery, status: s.optional(s.enum(['pending_approval', 'active', 'revoked'])), staffMemberId: s.optional(s.id()) }),
    async handler(ctx, { query }) { const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') }; if (query.status) f.status = query.status; if (query.staffMemberId) f.staffMemberId = query.staffMemberId; return paginate(ctx.col('devices'), f, query, 'createdAt', -1); } },
  { method: 'GET', path: '/devices/:id', permission: 'device.read', scope: 'unit', audit: { none: 'device read' }, rate: 'read', summary: 'Device detail with last health report',
    async handler(ctx, { params }) { const d = await ctx.col('devices').must(params.id!, 'Device'); ctx.assertScope(d.unitId, 'Device'); return d; } },
  { method: 'PATCH', path: '/devices/:id', permission: 'device.update', scope: 'unit', audit: 'device.update', rate: 'mutation', summary: 'Set a device label', body: s.object({ label: s.string({ max: 80 }) }),
    async handler(ctx, { params, body }) { const d = await ctx.col('devices').must(params.id!, 'Device'); ctx.assertScope(d.unitId, 'Device'); const out = await ctx.col('devices').update(d._id, { $set: { label: body.label } }); ctx.setAudit({ resource: { type: 'device', id: d._id }, after: body }); return out; } },
  {
    method: 'POST', path: '/devices/register', permission: 'session', scope: 'own', audit: 'device.register', rate: 'mutation', summary: 'Bind a device key pair (generated on the device) to the signed-in staff member', reqs: ['FR-DEV-001', 'FR-SUB-001'],
    body: s.object({ publicKey: s.string({ min: 60, max: 400, trim: false }), platform: s.enum(['android', 'ios', 'web']), osVersion: s.string({ max: 40 }), model: s.optional(s.string({ max: 80 })), appVersion: s.string({ max: 20, pattern: /^\d+\.\d+(\.\d+)?$/ }) }),
    async handler(ctx, { body }) {
      if (!ctx.actor.staffMemberId) throw new AppError('FORBIDDEN', 'Only staff members can register a device.');
      let pem: string;
      try { const k = createPublicKey(body.publicKey); if (k.asymmetricKeyType !== 'ed25519') throw new Error('type'); pem = k.export({ type: 'spki', format: 'pem' }).toString(); } catch { throw new AppError('VALIDATION_FAILED', 'The device key is not a valid Ed25519 public key.', { fieldErrors: [{ path: 'publicKey', code: 'INVALID', message: 'must be an Ed25519 public key in PEM format' }] }); }
      const fingerprint = sha256(pem); const policy = ctx.settings.devices;
      const existing = await ctx.col('devices').findOne({ publicKeyFingerprint: fingerprint });
      if (existing) {
        if (existing.staffMemberId !== ctx.actor.staffMemberId || existing.status === 'revoked') throw new AppError('DEVICE_REVOKED', 'This device key cannot be used. Reinstall the app or contact your administrator.');
        await ctx.col('sessions').update(ctx.actor.sessionId!, { $set: { deviceId: existing._id, idleMs: ctx.settings.auth.mobileIdleDays * 86400000 } });
        return existing;
      }
      const active = await ctx.col('devices').count({ staffMemberId: ctx.actor.staffMemberId, status: 'active' });
      let status: 'active' | 'pending_approval' = 'active';
      if (active >= policy.maxActivePerStaff) {
        if (!policy.changeNeedsApproval) throw new AppError('CONFLICT', `You already have ${active} active device(s). Ask an administrator to revoke the old device first.`);
        status = 'pending_approval';
      }
      await assertPlanLimit(ctx, 'devices');
      const staff = (await ctx.col('staff_members').get(ctx.actor.staffMemberId))!;
      const device = await ctx.col('devices').insert({ staffMemberId: staff._id, unitId: staff.homeUnitId, publicKey: pem, publicKeyFingerprint: fingerprint, platform: body.platform, osVersion: body.osVersion, model: body.model ?? null, appVersion: body.appVersion, status, lastSeenAt: ctx.now(), lastHeartbeat: null, createdAt: ctx.now() });
      await ctx.col('sessions').update(ctx.actor.sessionId!, { $set: { deviceId: device._id, idleMs: ctx.settings.auth.mobileIdleDays * 86400000, expiresAt: ctx.now() + ctx.settings.auth.mobileAbsoluteDays * 86400000 } });
      if (status === 'pending_approval') await ctx.app.services.notify.roles(ctx, ['admin', 'owner'], { template: 'device_pending_approval', refType: 'device', refId: device._id });
      ctx.setAudit({ resource: { type: 'device', id: device._id }, after: { status, platform: body.platform, appVersion: body.appVersion } });
      return created(device);
    },
  },
  {
    method: 'POST', path: '/devices/:id/approve', permission: 'device.manage', scope: 'unit', audit: 'device.approve', rate: 'mutation', summary: 'Approve a pending device; older devices beyond the policy maximum are revoked', reqs: ['FR-DEV-001'], body: s.object({}),
    async handler(ctx, { params }) {
      const d = await ctx.col('devices').must(params.id!, 'Device'); ctx.assertScope(d.unitId, 'Device'); DeviceMachine.assert(d.status, 'active');
      const others = await ctx.col('devices').find({ staffMemberId: d.staffMemberId, status: 'active' }, { sort: { createdAt: 1 } });
      const revoke = others.slice(0, Math.max(0, others.length + 1 - ctx.settings.devices.maxActivePerStaff));
      for (const o of revoke) await revokeDevice(ctx, o, 'replaced_by_new_device');
      const out = await ctx.col('devices').update(d._id, { $set: { status: 'active', approvedBy: ctx.actor.userId, approvedAt: ctx.now() } });
      ctx.setAudit({ resource: { type: 'device', id: d._id }, before: { status: d.status }, after: { status: 'active', revokedOlder: revoke.map((x) => x._id) } });
      return out;
    },
  },
  {
    method: 'POST', path: '/devices/:id/revoke', permission: 'session', scope: 'own', audit: 'device.revoke', rate: 'mutation', summary: 'Revoke a device (own device, or any in scope with device.manage); blocks all API access from it', reqs: ['FR-DEV-002'], body: s.object({ reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      const d = await ctx.col('devices').must(params.id!, 'Device');
      const own = d.staffMemberId === ctx.actor.staffMemberId;
      if (!own && !(ctx.can('device.manage') && ctx.inScope(d.unitId))) throw new AppError('NOT_FOUND', 'Device not found');
      await revokeDevice(ctx, d, body.reason);
      ctx.setAudit({ resource: { type: 'device', id: d._id }, reason: body.reason, before: { status: d.status }, after: { status: 'revoked' } });
      return { status: 'revoked' };
    },
  },
  {
    method: 'POST', path: '/devices/heartbeat', permission: 'session', scope: 'own', audit: { none: 'high-frequency device health report' }, rate: 'heartbeat', deviceBound: true, summary: 'Device health: battery, network, permission and background-restriction state, integrity review signals', reqs: ['FR-DEV-004', 'FR-DEV-005', 'FR-MOB-003'],
    body: s.object({ battery: s.optional(s.number({ min: 0, max: 100 })), network: s.optional(s.enum(['wifi', 'cellular', 'none', 'unknown'])), permissions: s.optional(s.object({ location: s.enum(['always', 'while_in_use', 'denied', 'ask_next_time', 'reduced_accuracy', 'revoked']), notifications: s.optional(s.enum(['granted', 'denied'])) })),
      bgRestricted: s.optional(s.boolean()), appVersion: s.optional(s.string({ max: 20 })), osVersion: s.optional(s.string({ max: 40 })), signals: s.optional(s.array(s.enum(['rooted', 'mock_location_enabled', 'developer_mode', 'time_tamper']), { max: 4 })), pendingEvents: s.optional(s.number({ int: true, min: 0 })), oldestPendingAgeSec: s.optional(s.number({ min: 0 })), pushToken: s.optional(s.string({ max: 400 })) }),
    async handler(ctx, { body }) {
      if (!ctx.device) throw new AppError('DEVICE_NOT_APPROVED', 'Register this device first.');
      const { pushToken, ...hb } = body; const at = ctx.now();
      await ctx.col('devices').update(ctx.device._id, { $set: { lastSeenAt: at, lastHeartbeat: { ...hb, at }, ...(body.appVersion ? { appVersion: body.appVersion } : {}), ...(body.osVersion ? { osVersion: body.osVersion } : {}), ...(pushToken ? { pushTokenEnc: ctx.app.crypto.encrypt(pushToken) } : {}) } });
      await ctx.col('device_heartbeat_logs').insert({ deviceId: ctx.device._id, at, battery: body.battery ?? null, network: body.network ?? null, permissions: body.permissions ?? null, purgeAt: at + 14 * 86400000 });
      await ctx.app.services.alerts.onHeartbeat(ctx, ctx.device, body);
      return { ok: true, serverTime: at, nextHeartbeatSec: ctx.settings.devices.heartbeatSec };
    },
  },
  {
    method: 'GET', path: '/mobile/config', permission: 'session', scope: 'own', audit: { none: 'configuration read' }, rate: 'read', summary: 'Sampling profile, thresholds, minimum app version and notice version for the device', reqs: ['FR-LOC-002', 'FR-DEV-003', 'FR-NFR-006'],
    async handler(ctx) {
      const st = ctx.settings; const notice = await ctx.col('privacy_notice_versions').findOne({ effectiveFrom: { $lte: ctx.now() } }, { sort: { version: -1 } });
      const config = { sampling: { movingSec: st.location.movingSec, stationarySec: st.location.stationarySec, minAccuracyM: st.location.minAccuracyM, distanceFilterM: st.location.distanceFilterM, breakTracking: st.duty.breakTracking }, freshness: { liveSec: st.location.liveSec, recentSec: st.location.recentSec },
        sos: { holdSec: st.sos.holdSec, fallbackSec: st.sos.fallbackSec, fallbackInstructions: st.sos.fallbackInstructions, outOfDuty: st.sos.outOfDuty }, queue: { capPoints: st.mobile.queueCapPoints, lateWindowDays: st.location.lateWindowDays }, heartbeatSec: st.devices.heartbeatSec,
        minAppVersion: st.devices.minAppVersion, softMinAppVersion: st.devices.softMinAppVersion, noticeVersion: notice?.version ?? null, settingsVersion: ctx.tenant!.settingsVersion };
      // Signed configuration (FR-LOC-002): the device can detect tampering in transit/storage; the server still validates every point.
      return { config, signature: ctx.app.services.sign(JSON.stringify(config)), serverTime: ctx.now() };
    },
  },
];

export function registerWorkforce(app: App) { app.register('workforce', routes); }
