// Organisation: hierarchy units, posts (sites) and teams (FR-ORG-001, 005, 006; TS §5.5).
import { isValidTimeZone } from '@sf/domain';
import { App, AppError, type Doc, type Route, created, paginate, s } from '@sf/kernel';
import { assertPlanLimit } from '../tenancy/provision.ts';

const MAX_DEPTH = 10;
const pageQuery = { limit: s.optional(s.number({ int: true, min: 1, max: 200 })), cursor: s.optional(s.string({ max: 300 })) };

const routes: Route[] = [
  { method: 'GET', path: '/units', permission: 'unit.read', scope: 'unit', audit: { none: 'hierarchy read' }, rate: 'read', summary: 'Organisation units within the caller\'s scope', reqs: ['FR-ORG-001'],
    async handler(ctx) { return { items: await ctx.col('organization_units').find(ctx.scopeFilter('_id'), { sort: { depth: 1, name: 1 }, limit: 5000 }) }; } },
  {
    method: 'POST', path: '/units', permission: 'unit.create', scope: 'unit', audit: 'unit.create', rate: 'mutation', summary: 'Create an organisation unit under a parent', reqs: ['FR-ORG-001'],
    body: s.object({ parentId: s.id(), type: s.string({ min: 1, max: 40 }), name: s.string({ min: 1, max: 120 }), code: s.optional(s.string({ max: 40 })) }),
    async handler(ctx, { body }) {
      const parent = await ctx.col('organization_units').must(body.parentId, 'Parent unit'); ctx.assertScope(parent._id, 'Parent unit');
      if (parent.depth + 1 >= MAX_DEPTH) throw new AppError('VALIDATION_FAILED', `The hierarchy supports at most ${MAX_DEPTH} levels.`);
      const unit = await ctx.col('organization_units').insert({ parentId: parent._id, type: body.type, name: body.name, code: body.code ?? null, ...(body.code ? { codeKey: body.code.toLowerCase() } : {}), ancestorIds: [...parent.ancestorIds, parent._id], depth: parent.depth + 1, status: 'active', createdAt: ctx.now(), updatedAt: ctx.now(), version: 1 });
      ctx.setAudit({ resource: { type: 'unit', id: unit._id }, after: { name: unit.name, parentId: parent._id } });
      return created(unit);
    },
  },
  { method: 'GET', path: '/units/:id', permission: 'unit.read', scope: 'unit', audit: { none: 'read of unit data within scope' }, rate: 'read', summary: 'Unit detail',
    async handler(ctx, { params }) { const u = await ctx.col('organization_units').must(params.id!, 'Unit'); ctx.assertScope(u._id, 'Unit'); return u; } },
  {
    method: 'PATCH', path: '/units/:id', permission: 'unit.update', scope: 'unit', audit: 'unit.update', rate: 'mutation', summary: 'Rename a unit or change its code/status', reqs: ['FR-ORG-001'],
    body: s.object({ version: s.number({ int: true }), name: s.optional(s.string({ min: 1, max: 120 })), type: s.optional(s.string({ max: 40 })), code: s.optional(s.string({ max: 40 })), status: s.optional(s.enum(['active', 'archived'])) }),
    async handler(ctx, { params, body }) {
      const u = await ctx.col('organization_units').must(params.id!, 'Unit'); ctx.assertScope(u._id, 'Unit');
      const { version, ...set } = body; const patch: Record<string, unknown> = { ...set, updatedAt: ctx.now() }; if (body.code) patch.codeKey = body.code.toLowerCase();
      const out = await ctx.col('organization_units').updateVersioned(u._id, version, patch);
      ctx.setAudit({ resource: { type: 'unit', id: u._id }, before: { name: u.name, code: u.code, status: u.status }, after: set });
      return out;
    },
  },
  {
    method: 'POST', path: '/units/:id/move', permission: 'unit.move', scope: 'unit', audit: 'unit.move', rate: 'mutation', summary: 'Move a unit; descendant paths are recomputed atomically and cycles are rejected', reqs: ['FR-ORG-001'],
    body: s.object({ newParentId: s.id(), reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      const units = ctx.col('organization_units');
      const u = await units.must(params.id!, 'Unit'); const np = await units.must(body.newParentId, 'New parent unit');
      ctx.assertScope(u._id, 'Unit'); ctx.assertScope(np._id, 'New parent unit');
      if (!u.parentId) throw new AppError('VALIDATION_FAILED', 'The top unit cannot be moved.');
      if (np._id === u._id || np.ancestorIds.includes(u._id)) throw new AppError('VALIDATION_FAILED', 'A unit cannot be moved under itself or one of its own descendants.');
      const newAnc = [...np.ancestorIds, np._id]; const descendants = await units.find({ ancestorIds: u._id });
      const deepest = Math.max(0, ...descendants.map((d) => d.depth - u.depth));
      if (newAnc.length + deepest >= MAX_DEPTH) throw new AppError('VALIDATION_FAILED', `The move would exceed ${MAX_DEPTH} levels.`);
      await units.update(u._id, { $set: { parentId: np._id, ancestorIds: newAnc, depth: newAnc.length, updatedAt: ctx.now() }, $inc: { version: 1 } });
      for (const d of descendants) {
        const tail = d.ancestorIds.slice(d.ancestorIds.indexOf(u._id));
        await units.update(d._id, { $set: { ancestorIds: [...newAnc, ...tail], depth: newAnc.length + tail.length, updatedAt: ctx.now() }, $inc: { version: 1 } });
      }
      ctx.setAudit({ resource: { type: 'unit', id: u._id }, reason: body.reason, before: { parentId: u.parentId }, after: { parentId: np._id, descendantsUpdated: descendants.length } });
      return units.get(u._id);
    },
  },
  {
    method: 'POST', path: '/units/:id/merge', permission: 'unit.move', scope: 'unit', audit: 'unit.merge', rate: 'mutation', summary: 'Merge a unit into another: posts, staff, teams and child units move; the source is archived', reqs: ['FR-ORG-001'],
    body: s.object({ intoUnitId: s.id(), reason: s.string({ min: 3, max: 300 }) }),
    async handler(ctx, { params, body }) {
      const units = ctx.col('organization_units'); const src = await units.must(params.id!, 'Unit'); const dst = await units.must(body.intoUnitId, 'Target unit');
      ctx.assertScope(src._id, 'Unit'); ctx.assertScope(dst._id, 'Target unit');
      if (!src.parentId || src._id === dst._id || dst.ancestorIds.includes(src._id)) throw new AppError('VALIDATION_FAILED', 'Choose a target that is not the unit itself or below it.');
      const moved = { posts: await ctx.col('posts').updateMany({ unitId: src._id }, { $set: { unitId: dst._id } }), staff: await ctx.col('staff_members').updateMany({ homeUnitId: src._id }, { $set: { homeUnitId: dst._id } }), teams: await ctx.col('teams').updateMany({ unitId: src._id }, { $set: { unitId: dst._id } }), children: 0 };
      const dstAnc = [...dst.ancestorIds, dst._id];
      for (const d of await units.find({ ancestorIds: src._id })) {
        const tail = d.ancestorIds.slice(d.ancestorIds.indexOf(src._id) + 1);
        await units.update(d._id, { $set: { parentId: d.parentId === src._id ? dst._id : d.parentId, ancestorIds: [...dstAnc, ...tail], depth: dstAnc.length + tail.length }, $inc: { version: 1 } }); moved.children++;
      }
      for (const m of await ctx.col('memberships').find({ scopeUnitIds: src._id })) await ctx.col('memberships').update(m._id, { $set: { scopeUnitIds: [...new Set((m.scopeUnitIds as string[]).map((x) => (x === src._id ? dst._id : x)))] } });
      await units.update(src._id, { $set: { status: 'archived', mergedIntoId: dst._id, updatedAt: ctx.now() }, $inc: { version: 1 } });
      ctx.setAudit({ resource: { type: 'unit', id: src._id }, reason: body.reason, after: { mergedIntoId: dst._id, ...moved } });
      return { ok: true, moved };
    },
  },
  // ---- posts ----
  { method: 'GET', path: '/posts', permission: 'post.read', scope: 'unit', audit: { none: 'post list read' }, rate: 'read', summary: 'Posts (sites) within scope', reqs: ['FR-ORG-005'], query: s.object({ ...pageQuery, unitId: s.optional(s.id()), status: s.optional(s.enum(['active', 'archived'])) }),
    async handler(ctx, { query }) { const f: Record<string, unknown> = { ...ctx.scopeFilter('unitId') }; if (query.unitId) { ctx.assertScope(query.unitId, 'Unit'); f.unitId = query.unitId; } if (query.status) f.status = query.status; return paginate(ctx.col('posts'), f, query, 'createdAt', -1); } },
  {
    method: 'POST', path: '/posts', permission: 'post.create', scope: 'unit', audit: 'post.create', rate: 'mutation', summary: 'Create a post belonging to exactly one unit', reqs: ['FR-ORG-005', 'FR-SUB-001'],
    body: s.object({ unitId: s.id(), name: s.string({ min: 1, max: 120 }), code: s.optional(s.string({ max: 40 })), address: s.optional(s.string({ max: 300 })), location: s.optional(s.object({ lat: s.lat(), lon: s.lon() })), timezone: s.optional(s.string({ max: 60 })), instructions: s.optional(s.string({ max: 2000 })), operatingHours: s.optional(s.string({ max: 200 })) }),
    async handler(ctx, { body }) {
      const unit = await ctx.col('organization_units').must(body.unitId, 'Unit'); ctx.assertScope(unit._id, 'Unit');
      if (body.timezone && !isValidTimeZone(body.timezone)) throw new AppError('VALIDATION_FAILED', 'Unknown timezone.', { fieldErrors: [{ path: 'timezone', code: 'INVALID', message: 'is not a known IANA timezone' }] });
      await assertPlanLimit(ctx, 'posts');
      const post = await ctx.col('posts').insert({ ...body, timezone: body.timezone ?? ctx.tenant!.timezone, location: body.location ?? null, status: 'active', createdAt: ctx.now(), updatedAt: ctx.now(), version: 1 });
      ctx.setAudit({ resource: { type: 'post', id: post._id }, after: { name: post.name, unitId: post.unitId } });
      return created(post);
    },
  },
  { method: 'GET', path: '/posts/:id', permission: 'post.read', scope: 'unit', audit: { none: 'read of post data within scope' }, rate: 'read', summary: 'Post detail',
    async handler(ctx, { params }) { const p = await ctx.col('posts').must(params.id!, 'Post'); ctx.assertScope(p.unitId, 'Post'); return p; } },
  {
    method: 'PATCH', path: '/posts/:id', permission: 'post.update', scope: 'unit', audit: 'post.update', rate: 'mutation', summary: 'Update a post', reqs: ['FR-ORG-005'],
    body: s.object({ version: s.number({ int: true }), name: s.optional(s.string({ min: 1, max: 120 })), code: s.optional(s.string({ max: 40 })), address: s.optional(s.string({ max: 300 })), location: s.optional(s.object({ lat: s.lat(), lon: s.lon() })), timezone: s.optional(s.string({ max: 60 })), instructions: s.optional(s.string({ max: 2000 })), operatingHours: s.optional(s.string({ max: 200 })), status: s.optional(s.enum(['active', 'archived'])) }),
    async handler(ctx, { params, body }) {
      const p = await ctx.col('posts').must(params.id!, 'Post'); ctx.assertScope(p.unitId, 'Post');
      if (body.timezone && !isValidTimeZone(body.timezone)) throw new AppError('VALIDATION_FAILED', 'Unknown timezone.', { fieldErrors: [{ path: 'timezone', code: 'INVALID', message: 'is not a known IANA timezone' }] });
      const { version, ...set } = body;
      const out = await ctx.col('posts').updateVersioned(p._id, version, { ...set, updatedAt: ctx.now() });
      ctx.setAudit({ resource: { type: 'post', id: p._id }, before: Object.fromEntries(Object.keys(set).filter((k) => k !== 'location').map((k) => [k, p[k]])), after: Object.fromEntries(Object.entries(set).filter(([k]) => k !== 'location')), detail: { locationChanged: !!body.location } });
      return out;
    },
  },
  // ---- teams ----
  { method: 'GET', path: '/teams', permission: 'team.read', scope: 'unit', audit: { none: 'team list read' }, rate: 'read', summary: 'Teams within scope with member ids', reqs: ['FR-ORG-006'],
    async handler(ctx) { const teams = await ctx.col('teams').find(ctx.scopeFilter('unitId'), { sort: { name: 1 }, limit: 1000 }); const tm = await ctx.col('team_memberships').find({ teamId: { $in: teams.map((t) => t._id) } }); return { items: teams.map((t) => ({ ...t, staffMemberIds: tm.filter((m) => m.teamId === t._id).map((m) => m.staffMemberId) })) }; } },
  { method: 'POST', path: '/teams', permission: 'team.manage', scope: 'unit', audit: 'team.create', rate: 'mutation', summary: 'Create a team in a unit', reqs: ['FR-ORG-006'], body: s.object({ unitId: s.id(), name: s.string({ min: 1, max: 80 }) }),
    async handler(ctx, { body }) { const u = await ctx.col('organization_units').must(body.unitId, 'Unit'); ctx.assertScope(u._id, 'Unit'); const t = await ctx.col('teams').insert({ ...body, createdAt: ctx.now(), version: 1 }); ctx.setAudit({ resource: { type: 'team', id: t._id }, after: body }); return created(t); } },
  { method: 'PATCH', path: '/teams/:id', permission: 'team.manage', scope: 'unit', audit: 'team.update', rate: 'mutation', summary: 'Rename a team', reqs: ['FR-ORG-006'], body: s.object({ version: s.number({ int: true }), name: s.string({ min: 1, max: 80 }) }),
    async handler(ctx, { params, body }) { const t = await ctx.col('teams').must(params.id!, 'Team'); ctx.assertScope(t.unitId, 'Team'); const out = await ctx.col('teams').updateVersioned(t._id, body.version, { name: body.name }); ctx.setAudit({ resource: { type: 'team', id: t._id }, before: { name: t.name }, after: { name: body.name } }); return out; } },
  {
    method: 'PUT', path: '/teams/:id/members', permission: 'team.manage', scope: 'unit', audit: 'team.members.set', rate: 'mutation', summary: 'Replace team members (a person may be in several teams)', reqs: ['FR-ORG-006'], body: s.object({ staffMemberIds: s.array(s.id(), { max: 500 }) }),
    async handler(ctx, { params, body }) {
      const t = await ctx.col('teams').must(params.id!, 'Team'); ctx.assertScope(t.unitId, 'Team');
      const staff = await ctx.col('staff_members').find({ _id: { $in: body.staffMemberIds } });
      if (staff.length !== new Set(body.staffMemberIds).size || !staff.every((x: Doc) => ctx.inScope(x.homeUnitId))) throw new AppError('VALIDATION_FAILED', 'Unknown staff member.', { fieldErrors: [{ path: 'staffMemberIds', code: 'UNKNOWN', message: 'contains someone who does not exist in your scope' }] });
      const before = await ctx.col('team_memberships').count({ teamId: t._id });
      await ctx.col('team_memberships').delete({ teamId: t._id });
      for (const id of new Set(body.staffMemberIds)) await ctx.col('team_memberships').insert({ teamId: t._id, staffMemberId: id, createdAt: ctx.now() });
      ctx.setAudit({ resource: { type: 'team', id: t._id }, before: { members: before }, after: { members: new Set(body.staffMemberIds).size } });
      return { ok: true, count: new Set(body.staffMemberIds).size };
    },
  },
];
export function registerOrganisation(app: App) { app.register('organisation', routes); }
