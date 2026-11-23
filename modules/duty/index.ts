// Duty planning: shifts, DST-safe occurrences, assignments, versioned rosters, acknowledgement, coverage (FR-DUTY-001..004, 008).
import { DutyMachine } from '@sf/contracts';
import { addDays, expandOccurrences, isValidTimeZone, overlaps, parseRecurrence } from '@sf/domain';
import { App, AppError, Ctx, type Doc, type Route, created, paginate, s } from '@sf/kernel';

const pageQuery = { limit: s.optional(s.number({ int: true, min: 1, max: 200 })), cursor: s.optional(s.string({ max: 300 })) };
const planSchema = s.object({ mode: s.enum(['ordered', 'flexible']), items: s.array(s.object({ checkpointId: s.id(), required: s.optional(s.boolean()), offsetStartMin: s.optional(s.number({ int: true, min: 0, max: 1440 })), offsetEndMin: s.optional(s.number({ int: true, min: 1, max: 1440 })) }), { max: 50 }) });

async function ensureOccurrence(ctx: Ctx, shift: Doc, localDate: string): Promise<Doc> {
  const occ = expandOccurrences(shift as never, localDate, localDate)[0];
  if (!occ) throw new AppError('VALIDATION_FAILED', 'This shift does not run on that date.', { fieldErrors: [{ path: 'localDate', code: 'NO_OCCURRENCE', message: 'is not a date on which the shift runs' }] });
  return (await ctx.col('shift_occurrences').findOne({ shiftId: shift._id, startsAt: occ.startsAt })) ?? ctx.col('shift_occurrences').insert({ shiftId: shift._id, startsAt: occ.startsAt, endsAt: occ.endsAt, localDate: occ.localDate, createdAt: ctx.now() });
}

/** Overlap policy (FR-DUTY-002): Block → 409; Warn → explicit confirmation recorded in audit; Allow → accepted. */
async function checkOverlap(ctx: Ctx, staffMemberId: string, window: { startsAt: number; endsAt: number } | Doc, exceptId: string | null, confirmed: boolean): Promise<string[]> {
  const others = (await ctx.col('duty_assignments').find({ staffMemberId, status: { $in: ['scheduled', 'started', 'on_break'] }, startsAt: { $lt: window.endsAt } })).filter((a) => a._id !== exceptId && overlaps(a as never, window as never));
  if (!others.length) return [];
  const policy = ctx.settings.duty.overlapPolicy; const ids = others.map((a) => a._id);
  if (policy === 'block') throw new AppError('OVERLAP_CONFLICT', 'This person already has an assignment that overlaps this shift. Your organisation\'s policy blocks overlapping assignments.', { details: { policy, conflictingAssignmentIds: ids } });
  if (policy === 'warn' && !confirmed) throw new AppError('OVERLAP_CONFLICT', 'This person already has an overlapping assignment. Confirm to assign anyway.', { details: { policy, requiresConfirmation: true, conflictingAssignmentIds: ids } });
  return ids;
}
async function validatePlan(ctx: Ctx, plan: { mode: string; items: { checkpointId: string }[] } | undefined, postId: string) {
  if (!plan) return;
  const cps = await ctx.col('checkpoints').find({ _id: { $in: plan.items.map((i) => i.checkpointId) } });
  if (cps.length !== new Set(plan.items.map((i) => i.checkpointId)).size || !cps.every((c) => c.postId === postId && c.status === 'active')) throw new AppError('VALIDATION_FAILED', 'Checkpoints must be active and belong to the assignment\'s post.', { fieldErrors: [{ path: 'checkpointPlan.items', code: 'INVALID', message: 'contains a checkpoint that is not active at this post' }] });
}
async function loadAssignment(ctx: Ctx, id: string): Promise<Doc> {
  const a = await ctx.col('duty_assignments').must(id, 'Assignment');
  if (a.staffMemberId !== ctx.actor.staffMemberId || !a.rosterVersionId) ctx.assertScope(a.unitId, 'Assignment');
  return a;
}
async function history(ctx: Ctx, assignmentId: string, change: string, reason: string | null, detail: Record<string, unknown> = {}) {
  await ctx.col('assignment_history').insert({ assignmentId, at: ctx.now(), actorId: ctx.actor.userId, change, reason, detail });
}
const snap = (a: Doc) => ({ assignmentId: a._id, staffMemberId: a.staffMemberId, postId: a.postId, shiftId: a.shiftId, startsAt: a.startsAt, endsAt: a.endsAt, supervisorId: a.supervisorId ?? null, checkpointIds: (a.checkpointPlan?.items ?? []).map((i: Doc) => i.checkpointId) });

const shiftFields = {
  name: s.string({ min: 1, max: 120 }), postId: s.optional(s.id()), unitId: s.optional(s.id()), startDate: s.date(), startsAtLocal: s.time(), endsAtLocal: s.time(), timezone: s.optional(s.string({ max: 60 })),
  recurrenceRule: s.optional(s.string({ max: 200 })), breakPolicy: s.optional(s.object({ minutes: s.number({ int: true, min: 0, max: 240 }), maxBreaks: s.optional(s.number({ int: true, min: 0, max: 10 })) })),
  minStaffing: s.optional(s.object({ count: s.number({ int: true, min: 0, max: 500 }) })), dutyType: s.optional(s.string({ max: 40 })),
};

const routes: Route[] = [
  { method: 'GET', path: '/shifts', permission: 'shift.read', scope: 'unit', audit: { none: 'shift list read' }, rate: 'read', summary: 'Shift definitions within scope', reqs: ['FR-DUTY-001'], query: s.object({ ...pageQuery, status: s.optional(s.enum(['active', 'archived'])) }),
    async handler(ctx, { query }) { return paginate(ctx.col('shifts'), { ...ctx.scopeFilter('unitId'), ...(query.status ? { status: query.status } : {}) }, query, 'createdAt', -1); } },
  {
    method: 'POST', path: '/shifts', permission: 'shift.create', scope: 'unit', audit: 'shift.create', rate: 'mutation', summary: 'Create a shift definition with optional recurrence (RRULE subset)', reqs: ['FR-DUTY-001', 'FR-DUTY-008'], body: s.object(shiftFields),
    async handler(ctx, { body }) {
      const post = body.postId ? await ctx.col('posts').must(body.postId, 'Post') : null;
      const unitId = post?.unitId ?? body.unitId;
      if (!unitId) throw new AppError('VALIDATION_FAILED', 'Choose a post or a unit for this shift.', { fieldErrors: [{ path: 'unitId', code: 'REQUIRED', message: 'is required when no post is given' }] });
      ctx.assertScope((await ctx.col('organization_units').must(unitId, 'Unit'))._id, 'Unit');
      const timezone = body.timezone ?? post?.timezone ?? ctx.tenant!.timezone;
      if (!isValidTimeZone(timezone)) throw new AppError('VALIDATION_FAILED', 'Unknown timezone.', { fieldErrors: [{ path: 'timezone', code: 'INVALID', message: 'is not a known IANA timezone' }] });
      if (body.recurrenceRule) { const r = parseRecurrence(body.recurrenceRule); if ('error' in r) throw new AppError('VALIDATION_FAILED', 'The recurrence rule is not supported.', { fieldErrors: [{ path: 'recurrenceRule', code: 'INVALID', message: r.error }] }); }
      const shift = await ctx.col('shifts').insert({ ...body, unitId, timezone, recurrenceRule: body.recurrenceRule ?? null, breakPolicy: body.breakPolicy ?? { minutes: 30, maxBreaks: 2 }, minStaffing: body.minStaffing ?? { count: 1 }, status: 'active', createdAt: ctx.now(), updatedAt: ctx.now(), version: 1 });
      ctx.setAudit({ resource: { type: 'shift', id: shift._id }, after: { name: shift.name, unitId } });
      return created(shift);
    },
  },
  { method: 'GET', path: '/shifts/:id', permission: 'shift.read', scope: 'unit', audit: { none: 'read of shift data within scope' }, rate: 'read', summary: 'Shift detail',
    async handler(ctx, { params }) { const sh = await ctx.col('shifts').must(params.id!, 'Shift'); ctx.assertScope(sh.unitId, 'Shift'); return sh; } },
  {
    method: 'PATCH', path: '/shifts/:id', permission: 'shift.update', scope: 'unit', audit: 'shift.update', rate: 'mutation', summary: 'Update a shift definition (existing occurrences and assignments keep their times)', reqs: ['FR-DUTY-001'],
    body: s.object({ version: s.number({ int: true }), name: s.optional(s.string({ min: 1, max: 120 })), minStaffing: s.optional(s.object({ count: s.number({ int: true, min: 0, max: 500 }) })), breakPolicy: s.optional(s.object({ minutes: s.number({ int: true, min: 0, max: 240 }), maxBreaks: s.optional(s.number({ int: true, min: 0, max: 10 })) })), status: s.optional(s.enum(['active', 'archived'])) }),
    async handler(ctx, { params, body }) {
      const sh = await ctx.col('shifts').must(params.id!, 'Shift'); ctx.assertScope(sh.unitId, 'Shift'); const { version, ...set } = body;
      const out = await ctx.col('shifts').updateVersioned(sh._id, version, { ...set, updatedAt: ctx.now() });
      ctx.setAudit({ resource: { type: 'shift', id: sh._id }, before: Object.fromEntries(Object.keys(set).map((k) => [k, sh[k]])), after: set });
      return out;
    },
  },
  {
    method: 'GET', path: '/shifts/:id/occurrences', permission: 'shift.read', scope: 'unit', audit: { none: 'occurrence read' }, rate: 'read', summary: 'Concrete occurrences for a date range (UTC instants, local date)', reqs: ['FR-DUTY-001'], query: s.object({ from: s.date(), to: s.date() }),
    async handler(ctx, { params, query }) {
      const sh = await ctx.col('shifts').must(params.id!, 'Shift'); ctx.assertScope(sh.unitId, 'Shift');
      if (query.to < query.from || query.to > addDays(query.from, 92)) throw new AppError('VALIDATION_FAILED', 'Choose a range of at most 92 days.');
      return { timezone: sh.timezone, items: expandOccurrences(sh as never, query.from, query.to).map((o) => ({ localDate: o.localDate, startsAt: o.startsAt, endsAt: o.endsAt })) };
    },
  },
  // ---- assignments ----
  {
    method: 'GET', path: '/assignments', permission: 'assignment.read', scope: 'unit', audit: { none: 'assignment list read' }, rate: 'read', summary: 'Assignments within scope, filterable by time, unit, post, staff and state', reqs: ['FR-DUTY-002', 'FR-DUTY-004'],
    query: s.object({ ...pageQuery, from: s.optional(s.iso()), to: s.optional(s.iso()), unitId: s.optional(s.id()), postId: s.optional(s.id()), staffMemberId: s.optional(s.id()), status: s.optional(s.string({ max: 20 })), unacknowledged: s.optional(s.boolean()), needsReassignment: s.optional(s.boolean()) }),
    async handler(ctx, { query }) {
      const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') };
      if (query.unitId) { ctx.assertScope(query.unitId, 'Unit'); f.unitId = { $in: [query.unitId, ...(await ctx.col('organization_units').find({ ancestorIds: query.unitId })).map((u) => u._id)].filter((u) => ctx.inScope(u)) }; }
      if (query.from || query.to) f.startsAt = { ...(query.from ? { $gte: Date.parse(query.from) } : {}), ...(query.to ? { $lte: Date.parse(query.to) } : {}) };
      for (const k of ['postId', 'staffMemberId', 'status'] as const) if (query[k]) f[k] = query[k];
      if (query.unacknowledged) { f.rosterState = 'published'; f.ackAt = null; f.status = 'scheduled'; }
      if (query.needsReassignment) f.needsReassignment = true;
      const page = await paginate(ctx.col('duty_assignments'), f, query, 'startsAt', 1);
      // include the assignee's name/code so roles without staff.read (e.g. Dispatcher) see who is on duty, not raw ids
      const ids = [...new Set(page.items.map((a: Doc) => a.staffMemberId as string))];
      const people = new Map((ids.length ? await ctx.col('staff_members').find({ _id: { $in: ids } }) : []).map((p) => [p._id, p]));
      return { ...page, items: page.items.map((a: Doc) => ({ ...a, staffName: people.get(a.staffMemberId)?.displayName ?? null, staffCode: people.get(a.staffMemberId)?.employeeCode ?? null })) };
    },
  },
  {
    method: 'POST', path: '/assignments', permission: 'assignment.create', scope: 'unit', audit: 'assignment.create', rate: 'mutation', summary: 'Assign a staff member to a shift occurrence at a post (draft until the roster is published)', reqs: ['FR-DUTY-002'],
    body: s.object({ shiftId: s.id(), localDate: s.date(), staffMemberId: s.id(), postId: s.optional(s.id()), supervisorId: s.optional(s.id()), checkpointPlan: s.optional(planSchema), confirmOverlap: s.optional(s.boolean()) }),
    async handler(ctx, { body }) {
      const shift = await ctx.col('shifts').must(body.shiftId, 'Shift'); ctx.assertScope(shift.unitId, 'Shift');
      if (shift.status !== 'active') throw new AppError('INVALID_STATE_TRANSITION', 'This shift is archived.');
      const postId = body.postId ?? shift.postId;
      if (!postId) throw new AppError('VALIDATION_FAILED', 'Choose a post for this assignment.', { fieldErrors: [{ path: 'postId', code: 'REQUIRED', message: 'is required because the shift has no default post' }] });
      const post = await ctx.col('posts').must(postId, 'Post'); ctx.assertScope(post.unitId, 'Post');
      const staff = await ctx.col('staff_members').must(body.staffMemberId, 'Staff member'); ctx.assertScope(staff.homeUnitId, 'Staff member');
      if (staff.status === 'suspended' || staff.status === 'offboarded') throw new AppError('INVALID_STATE_TRANSITION', `This person is ${staff.status} and cannot be assigned.`);
      if (body.supervisorId) await ctx.col('staff_members').must(body.supervisorId, 'Supervisor');
      await validatePlan(ctx, body.checkpointPlan, post._id);
      const occ = await ensureOccurrence(ctx, shift, body.localDate);
      if (occ.endsAt <= ctx.now()) throw new AppError('VALIDATION_FAILED', 'This shift occurrence has already ended.');
      const overlapWith = await checkOverlap(ctx, staff._id, occ, null, !!body.confirmOverlap);
      const a = await ctx.col('duty_assignments').insert({
        occurrenceId: occ._id, shiftId: shift._id, shiftName: shift.name, staffMemberId: staff._id, postId: post._id, unitId: post.unitId, supervisorId: body.supervisorId ?? staff.supervisorId ?? null,
        startsAt: occ.startsAt, endsAt: occ.endsAt, localDate: occ.localDate, timezone: shift.timezone, breakPolicy: shift.breakPolicy, checkpointPlan: body.checkpointPlan ?? { mode: 'flexible', items: [] },
        status: 'scheduled', rosterState: 'draft', rosterVersionId: null, rosterVersion: null, ackAt: null, slotKey: `${occ._id}:${staff._id}`, createdAt: ctx.now(), updatedAt: ctx.now(), version: 1,
      });
      await history(ctx, a._id, 'created', null, { overlapConfirmed: overlapWith.length > 0 });
      ctx.setAudit({ resource: { type: 'assignment', id: a._id }, after: snap(a), detail: overlapWith.length ? { overlapConfirmed: true, conflictingAssignmentIds: overlapWith } : undefined });
      return created(a);
    },
  },
  { method: 'GET', path: '/assignments/:id', permission: 'session', scope: 'own', audit: { none: 'assignment read' }, rate: 'read', summary: 'Assignment detail with change history (own published assignment, or any in scope with assignment.read)', reqs: ['FR-DUTY-008'],
    async handler(ctx, { params }) {
      const a = await ctx.col('duty_assignments').must(params.id!, 'Assignment');
      const own = a.staffMemberId === ctx.actor.staffMemberId && a.rosterState === 'published';
      if (!own && !(ctx.can('assignment.read') && ctx.inScope(a.unitId))) throw new AppError('NOT_FOUND', 'Assignment not found');
      return { ...a, history: own && !ctx.can('assignment.read') ? [] : await ctx.col('assignment_history').find({ assignmentId: a._id }, { sort: { at: 1 } }) };
    } },
  {
    method: 'PATCH', path: '/assignments/:id', permission: 'assignment.update', scope: 'unit', audit: 'assignment.update', rate: 'mutation', summary: 'Change or reassign a scheduled assignment; a reason is mandatory and history is kept', reqs: ['FR-DUTY-002', 'FR-DUTY-008'],
    body: s.object({ version: s.number({ int: true }), staffMemberId: s.optional(s.id()), postId: s.optional(s.id()), supervisorId: s.optional(s.id()), checkpointPlan: s.optional(planSchema), reason: s.string({ min: 3, max: 300 }), confirmOverlap: s.optional(s.boolean()) }),
    async handler(ctx, { params, body }) {
      const a = await loadAssignment(ctx, params.id!);
      if (a.status !== 'scheduled') throw new AppError('INVALID_STATE_TRANSITION', 'Only an assignment that has not started can be changed.');
      const set: Record<string, unknown> = { updatedAt: ctx.now() }; const detail: Record<string, unknown> = {};
      if (body.staffMemberId && body.staffMemberId !== a.staffMemberId) {
        const staff = await ctx.col('staff_members').must(body.staffMemberId, 'Staff member'); ctx.assertScope(staff.homeUnitId, 'Staff member');
        if (staff.status === 'suspended' || staff.status === 'offboarded') throw new AppError('INVALID_STATE_TRANSITION', `This person is ${staff.status} and cannot be assigned.`);
        await checkOverlap(ctx, staff._id, a, a._id, !!body.confirmOverlap);
        Object.assign(set, { staffMemberId: staff._id, slotKey: `${a.occurrenceId}:${staff._id}`, ackAt: null, previousStaffMemberId: a.staffMemberId }); detail.reassignedFrom = a.staffMemberId; detail.reassignedTo = staff._id;
      }
      if (body.postId && body.postId !== a.postId) { const post = await ctx.col('posts').must(body.postId, 'Post'); ctx.assertScope(post.unitId, 'Post'); Object.assign(set, { postId: post._id, unitId: post.unitId }); detail.postChanged = true; }
      if (body.supervisorId) { await ctx.col('staff_members').must(body.supervisorId, 'Supervisor'); set.supervisorId = body.supervisorId; }
      if (body.checkpointPlan) { await validatePlan(ctx, body.checkpointPlan, (set.postId as string) ?? a.postId); set.checkpointPlan = body.checkpointPlan; detail.checkpointPlanChanged = true; }
      if (a.rosterState === 'published') set.rosterState = 'revised_unpublished'; // formalised as a new roster version at the next publish
      const out = await ctx.col('duty_assignments').updateVersioned(a._id, body.version, set);
      // A supervisor edit never silently moves a person's assignment: everyone affected is told at once.
      if (a.rosterVersionId) for (const id of new Set([a.staffMemberId, out.staffMemberId])) await ctx.app.services.notify.staff(ctx, id, { template: 'assignment_changed', refType: 'assignment', refId: a._id });
      await history(ctx, a._id, detail.reassignedTo ? 'reassigned' : 'changed', body.reason, detail);
      ctx.setAudit({ resource: { type: 'assignment', id: a._id }, reason: body.reason, before: snap(a), after: snap(out) });
      return out;
    },
  },
  {
    method: 'POST', path: '/assignments/:id/cancel', permission: 'assignment.update', scope: 'unit', audit: 'assignment.cancel', rate: 'mutation', summary: 'Cancel an assignment (closes tracking if the duty had started)', reqs: ['FR-DUTY-003', 'FR-LOC-001'], body: s.object({ reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      const a = await loadAssignment(ctx, params.id!); DutyMachine.assert(a.status, 'cancelled');
      await cancelAssignment(ctx, a, body.reason);
      ctx.setAudit({ resource: { type: 'assignment', id: a._id }, reason: body.reason, before: { status: a.status }, after: { status: 'cancelled' } });
      return { status: 'cancelled' };
    },
  },
  {
    method: 'POST', path: '/assignments/:id/acknowledge', permission: 'session', scope: 'own', audit: 'assignment.acknowledge', rate: 'mutation', summary: 'Staff member acknowledges a published assignment', reqs: ['FR-DUTY-004'], body: s.object({}),
    async handler(ctx, { params }) {
      const a = await ctx.col('duty_assignments').must(params.id!, 'Assignment');
      if (a.staffMemberId !== ctx.actor.staffMemberId || !a.rosterVersionId) throw new AppError('NOT_FOUND', 'Assignment not found');
      if (a.status === 'cancelled') throw new AppError('INVALID_STATE_TRANSITION', 'This assignment was cancelled.');
      const out = a.ackAt ? a : await ctx.col('duty_assignments').update(a._id, { $set: { ackAt: ctx.now() } });
      ctx.setAudit({ resource: { type: 'assignment', id: a._id } });
      return { ackAt: out!.ackAt };
    },
  },
  {
    method: 'GET', path: '/me/duty', permission: 'session', scope: 'own', audit: { none: 'own duty read' }, rate: 'read', summary: 'Current and upcoming published assignments with everything needed offline', reqs: ['FR-MOB-001'],
    async handler(ctx) {
      const id = ctx.actor.staffMemberId; if (!id) return { items: [], syncedAt: ctx.now() };
      const list = (await ctx.col('duty_assignments').find({ staffMemberId: id, endsAt: { $gte: ctx.now() - 12 * 3600000 }, startsAt: { $lte: ctx.now() + 14 * 86400000 } }, { sort: { startsAt: 1 }, limit: 60 })).filter((a) => a.rosterVersionId);
      const posts = await ctx.col('posts').find({ _id: { $in: list.map((a) => a.postId) } });
      const cps = await ctx.col('checkpoints').find({ _id: { $in: list.flatMap((a) => (a.checkpointPlan?.items ?? []).map((i: Doc) => i.checkpointId)) } });
      const sups = await ctx.col('staff_members').find({ _id: { $in: list.map((a) => a.supervisorId).filter(Boolean) } });
      const sessions = await ctx.col('duty_tracking_sessions').find({ staffMemberId: id, state: 'open' });
      const items = await Promise.all(list.map(async (a) => {
        const p = posts.find((x) => x._id === a.postId), sup = sups.find((x) => x._id === a.supervisorId); const ts = sessions.find((x) => x.assignmentId === a._id);
        const exps = await ctx.col('checkpoint_expectations').find({ assignmentId: a._id }, { sort: { windowStart: 1 } });
        return { id: a._id, status: a.status, shiftName: a.shiftName, startsAt: a.startsAt, endsAt: a.endsAt, localDate: a.localDate, timezone: a.timezone, ackAt: a.ackAt, rosterVersion: a.rosterVersion, breakPolicy: a.breakPolicy,
          post: p ? { id: p._id, name: p.name, address: p.address ?? null, instructions: p.instructions ?? null, location: p.location } : null,
          supervisor: sup ? { id: sup._id, displayName: sup.displayName, phone: sup.contactEnc ? JSON.parse(ctx.app.crypto.decrypt(sup.contactEnc)).phone : null } : null,
          checkpointMode: a.checkpointPlan?.mode ?? 'flexible', checkpoints: exps.map((e) => { const c = cps.find((x) => x._id === e.checkpointId); return { expectationId: e._id, checkpointId: e.checkpointId, name: c?.name ?? '', method: c?.method ?? 'qr', instructions: c?.instructions ?? null, required: e.required, order: e.order, windowStart: e.windowStart, windowEnd: e.windowEnd, state: e.state }; }),
          trackingSession: ts ? { id: ts._id, state: ts.state, profile: ts.profile, openedAt: ts.openedAt } : null, window: { earlyMin: ctx.settings.duty.earlyMin, lateMin: ctx.settings.duty.lateMin } };
      }));
      return { items, syncedAt: ctx.now() };
    },
  },
  // ---- rosters ----
  {
    method: 'POST', path: '/rosters/publish', permission: 'roster.publish', scope: 'unit', audit: 'roster.publish', rate: 'mutation', summary: 'Publish a roster for a unit and period: creates an immutable version with a diff and notifies affected staff', reqs: ['FR-DUTY-003', 'FR-DUTY-004', 'FR-CHK-004'],
    body: s.object({ unitId: s.id(), from: s.date(), to: s.date(), expectedVersion: s.number({ int: true, min: 0 }), note: s.optional(s.string({ max: 300 })) }),
    async handler(ctx, { body }) {
      const unit = await ctx.col('organization_units').must(body.unitId, 'Unit'); ctx.assertScope(unit._id, 'Unit');
      if (body.to < body.from || body.to > addDays(body.from, 62)) throw new AppError('VALIDATION_FAILED', 'Choose a period of at most 62 days.');
      const scopeKey = `${unit._id}:${body.from}:${body.to}`; const versions = ctx.col('roster_versions');
      const prev = await versions.findOne({ scopeKey }, { sort: { version: -1 } });
      if ((prev?.version ?? 0) !== body.expectedVersion) throw new AppError('VERSION_CONFLICT', 'This roster was published by someone else since you opened it. Reload to see the current version.', { details: { currentVersion: prev?.version ?? 0 } });
      const unitIds = [unit._id, ...(await ctx.col('organization_units').find({ ancestorIds: unit._id })).map((u) => u._id)];
      const all = (await ctx.col('duty_assignments').find({ unitId: { $in: unitIds }, localDate: { $gte: body.from, $lte: body.to } }, { limit: 20000 }));
      const live = all.filter((a) => a.status !== 'cancelled');
      const before = new Map<string, ReturnType<typeof snap>>((prev?.state === 'published' ? prev.assignmentSnapshot : []).map((x: ReturnType<typeof snap>) => [x.assignmentId, x]));
      const after = new Map(live.map((a) => [a._id, snap(a)]));
      const diff = { added: [...after.keys()].filter((k) => !before.has(k)), removed: [...before.keys()].filter((k) => !after.has(k)), changed: [...after.keys()].filter((k) => before.has(k) && JSON.stringify(before.get(k)) !== JSON.stringify(after.get(k))) };
      const now = ctx.now();
      const rv = await versions.insert({ scopeKey, scope: { unitId: unit._id, from: body.from, to: body.to }, version: (prev?.version ?? 0) + 1, state: 'published', assignmentSnapshot: [...after.values()], diff, note: body.note ?? null, publishedBy: ctx.actor.userId, publishedAt: now, supersedes: prev?._id ?? null });
      for (const a of live) {
        const changed = diff.added.includes(a._id) || diff.changed.includes(a._id);
        await ctx.col('duty_assignments').update(a._id, { $set: { rosterState: 'published', rosterVersionId: rv._id, rosterVersion: rv.version, publishedAt: a.publishedAt ?? now, ...(diff.changed.includes(a._id) ? { ackAt: null } : {}) } });
        if (changed && a.status === 'scheduled') await ctx.app.services.checkpoints.generateExpectations(ctx, a);
      }
      const notifyStaff = async (ids: string[], template: string) => { for (const id of new Set(ids)) await ctx.app.services.notify.staff(ctx, id, { template, refType: 'roster_version', refId: rv._id }); };
      await notifyStaff(diff.added.map((k) => after.get(k)!.staffMemberId), 'roster_published');
      await notifyStaff(diff.changed.flatMap((k) => [after.get(k)!.staffMemberId, before.get(k)!.staffMemberId]), 'roster_revised');
      await notifyStaff(diff.removed.map((k) => before.get(k)!.staffMemberId), 'roster_assignment_removed');
      await ctx.emit('roster:published', { unitId: unit._id, needs: 'roster.read' }, { rosterVersionId: rv._id, scope: rv.scope, version: rv.version });
      ctx.setAudit({ action: prev ? 'roster.revise' : 'roster.publish', resource: { type: 'roster_version', id: rv._id }, after: { version: rv.version, assignments: live.length, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length } });
      return created(rv);
    },
  },
  { method: 'GET', path: '/rosters/versions', permission: 'roster.read', scope: 'unit', audit: { none: 'roster history read' }, rate: 'read', summary: 'Roster version history with actor and time', reqs: ['FR-DUTY-003'], query: s.object({ ...pageQuery, unitId: s.optional(s.id()) }),
    async handler(ctx, { query }) { const f: Record<string, unknown> = { ...ctx.scopeFilter('scope.unitId') }; if (query.unitId) { ctx.assertScope(query.unitId, 'Unit'); f['scope.unitId'] = query.unitId; } const page = await paginate(ctx.col('roster_versions'), f, query, 'publishedAt', -1); return { ...page, items: page.items.map(({ assignmentSnapshot, ...r }) => ({ ...r, assignmentCount: assignmentSnapshot.length })) }; } },
  { method: 'GET', path: '/rosters/versions/:id', permission: 'roster.read', scope: 'unit', audit: { none: 'roster version read' }, rate: 'read', summary: 'One immutable roster version with its snapshot and diff', reqs: ['FR-DUTY-003'],
    async handler(ctx, { params }) { const rv = await ctx.col('roster_versions').must(params.id!, 'Roster version'); ctx.assertScope(rv.scope.unitId, 'Roster version'); return rv; } },
  {
    method: 'POST', path: '/rosters/versions/:id/cancel', permission: 'roster.cancel', scope: 'unit', audit: 'roster.cancel', rate: 'mutation', summary: 'Cancel a published roster version: its unstarted assignments are cancelled and staff are notified', reqs: ['FR-DUTY-003', 'FR-DUTY-004'], body: s.object({ reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      const rv = await ctx.col('roster_versions').must(params.id!, 'Roster version'); ctx.assertScope(rv.scope.unitId, 'Roster version');
      if (rv.state !== 'published') throw new AppError('INVALID_STATE_TRANSITION', 'Only a published roster version can be cancelled.');
      const latest = await ctx.col('roster_versions').findOne({ scopeKey: rv.scopeKey }, { sort: { version: -1 } });
      if (latest!._id !== rv._id) throw new AppError('INVALID_STATE_TRANSITION', 'Only the latest version of a roster can be cancelled.');
      await ctx.col('roster_versions').update(rv._id, { $set: { state: 'cancelled', cancelledBy: ctx.actor.userId, cancelledAt: ctx.now(), cancelReason: body.reason } });
      let cancelled = 0;
      for (const sn of rv.assignmentSnapshot as { assignmentId: string }[]) { const a = await ctx.col('duty_assignments').get(sn.assignmentId); if (a && a.status === 'scheduled') { await cancelAssignment(ctx, a, `roster cancelled: ${body.reason}`); cancelled++; } }
      ctx.setAudit({ resource: { type: 'roster_version', id: rv._id }, reason: body.reason, after: { assignmentsCancelled: cancelled } });
      return { state: 'cancelled', assignmentsCancelled: cancelled };
    },
  },
  {
    method: 'GET', path: '/coverage', permission: 'roster.read', scope: 'unit', audit: { none: 'coverage read' }, rate: 'read', summary: 'Understaffed shifts, unassigned posts and coverage percentage for a period', reqs: ['FR-DUTY-008'], query: s.object({ from: s.date(), to: s.date(), unitId: s.optional(s.id()) }),
    async handler(ctx, { query }) {
      if (query.to < query.from || query.to > addDays(query.from, 31)) throw new AppError('VALIDATION_FAILED', 'Choose a period of at most 31 days.');
      const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') }; if (query.unitId) { ctx.assertScope(query.unitId, 'Unit'); f.unitId = query.unitId; }
      const [shifts, posts, assignments] = await Promise.all([ctx.col('shifts').find({ ...f, status: 'active' }, { limit: 2000 }), ctx.col('posts').find({ ...f, status: 'active' }, { limit: 5000 }), ctx.col('duty_assignments').find({ ...f, localDate: { $gte: query.from, $lte: query.to }, status: { $ne: 'cancelled' } }, { limit: 50000 })]);
      const rows = shifts.flatMap((sh) => expandOccurrences(sh as never, query.from, query.to).map((o) => {
        const assigned = assignments.filter((a) => a.shiftId === sh._id && a.startsAt === o.startsAt); const required = sh.minStaffing?.count ?? 0;
        return { shiftId: sh._id, shiftName: sh.name, postId: sh.postId ?? null, localDate: o.localDate, startsAt: o.startsAt, endsAt: o.endsAt, required, assigned: assigned.length, published: assigned.filter((a) => a.rosterVersionId).length, gap: Math.max(0, required - assigned.length), understaffed: assigned.length < required };
      }));
      const assignedPosts = new Set(assignments.map((a) => a.postId));
      const requiredTotal = rows.reduce((n, r) => n + r.required, 0), filled = rows.reduce((n, r) => n + Math.min(r.required, r.assigned), 0);
      return { asOf: ctx.now(), period: query, occurrences: rows, understaffed: rows.filter((r) => r.understaffed), unassignedPosts: posts.filter((p) => !assignedPosts.has(p._id)).map((p) => ({ id: p._id, name: p.name, unitId: p.unitId })), coveragePct: requiredTotal ? Math.round((filled / requiredTotal) * 1000) / 10 : null, basis: 'measured' };
    },
  },
];

export async function cancelAssignment(ctx: Ctx, a: Doc, reason: string) {
  await ctx.col('duty_assignments').update(a._id, { $set: { status: 'cancelled', cancelReason: reason, cancelledAt: ctx.now(), updatedAt: ctx.now() }, $unset: ['slotKey'], $inc: { version: 1 } });
  await history(ctx, a._id, 'cancelled', reason);
  for (const ts of await ctx.col('duty_tracking_sessions').find({ assignmentId: a._id, state: 'open' })) await ctx.app.services.tracking.close(ctx, ts, 'assignment_cancelled');
  await ctx.col('checkpoint_expectations').updateMany({ assignmentId: a._id, state: 'pending' }, { $set: { state: 'waived', waivedReason: 'assignment cancelled' } });
  if (a.rosterVersionId) await ctx.app.services.notify.staff(ctx, a.staffMemberId, { template: 'assignment_cancelled', refType: 'assignment', refId: a._id });
  await ctx.emit('staff:statusChanged', { unitId: a.unitId, staffId: a.staffMemberId, needs: 'assignment.read' }, { staffMemberId: a.staffMemberId, assignmentId: a._id, state: 'cancelled', occurredAt: new Date(ctx.now()).toISOString() });
}

export function registerDuty(app: App) {
  app.register('duty', routes);
  // Acknowledgement reminders fire once per configured interval (FR-DUTY-004); unstarted assignments become Missed after the window.
  app.schedule('duty.housekeeping', 60, async (tenant) => {
    if (tenant.status !== 'active' && tenant.status !== 'trial') return;
    const ctx = (await app.systemCtxFor(tenant._id, 'duty-housekeeping'))!; const now = app.clock.now(); const every = ctx.settings.duty.ackReminderHours * 3600000;
    for (const a of await ctx.col('duty_assignments').find({ status: 'scheduled', rosterState: 'published', ackAt: null, startsAt: { $gt: now } }, { limit: 2000 })) {
      const last = a.lastAckReminderAt ?? a.publishedAt ?? now;
      if (now - last < every) continue;
      await ctx.col('duty_assignments').update(a._id, { $set: { lastAckReminderAt: now } });
      await app.services.notify.staff(ctx, a.staffMemberId, { template: 'assignment_ack_reminder', refType: 'assignment', refId: a._id, dedupeKey: `ackrem:${a._id}:${Math.floor(now / every)}` });
    }
    for (const a of await ctx.col('duty_assignments').find({ status: 'scheduled', endsAt: { $lt: now } }, { limit: 2000 })) {
      await ctx.col('duty_assignments').update(a._id, { $set: { status: 'missed', updatedAt: now }, $inc: { version: 1 } });
      await ctx.col('assignment_history').insert({ assignmentId: a._id, at: now, actorId: 'system:duty-housekeeping', change: 'missed', reason: 'window elapsed, no start', detail: {} });
    }
  });
}
