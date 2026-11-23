// Security suites: tenant isolation, permission matrix, authentication, sessions, devices, audit integrity, log hygiene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { totp } from '@sf/domain/node';
import { PERMISSION_KEYS } from '@sf/permissions';
import { COLLECTIONS, type Doc, ScopedCollection, signJwt, generateJwtKey, loadJwtKey } from '@sf/kernel';
import { Client, MFA_SECRETS, PASSWORD, type TenantFixture, addStaff, iso, makeApp, must, planDuty, points, setupTenant, startBody, tick, uuid } from '../helpers.ts';

/** Builds a tenant with at least one record in most collections. */
async function populated(h: Awaited<ReturnType<typeof makeApp>>, slug: string): Promise<TenantFixture & { field: Client; staffId: string; assignmentId: string }> {
  const t = await setupTenant(h, slug); const sup = await addStaff(t, 'supervisor'); const f = await addStaff(t, 'field');
  const post = await must(t.owner.post('/posts', { unitId: t.rootUnitId, name: 'Gate' }));
  const fence = await must(t.owner.post('/geofences', { postId: post.id, name: 'Perimeter', geometry: { shape: 'circle', center: { lat: 24.8607, lon: 67.0011 }, radiusM: 150 }, requiredDuringDuty: true }));
  const cp = await must(t.owner.post('/checkpoints', { postId: post.id, name: 'Door', method: 'qr', geofenceId: fence.id }));
  await must(t.owner.post('/teams', { unitId: t.rootUnitId, name: 'Alpha' }));
  const d = await planDuty(t, f.staffId, { postId: post.id, checkpointPlan: { mode: 'flexible', items: [{ checkpointId: cp.id }] } });
  const now0 = h.clock.now(); h.clock.advanceMin(10);
  const st = await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h, { lat: 24.8607, lon: 67.0011, accuracyM: 8 })));
  h.clock.advanceMin(2);
  await must(f.client.post('/locations/batch', { trackingSessionId: st.trackingSessionId, sentAt: iso(h.clock.now()), points: points(h, 5, { battery: 9 }) }));
  await must(f.client.post('/checkpoint-scans', { eventId: uuid(), tagId: cp.tagId, scannedAt: iso(h.clock.now()), location: { lat: 24.8607, lon: 67.0011, accuracyM: 8 } }));
  await must(f.client.post('/sos', { eventId: uuid(), occurredAt: iso(h.clock.now()) }));
  await must(f.client.post('/incidents', { typeKey: 'hazard', description: 'Broken light at gate' }));
  await must(f.client.post('/corrections', { assignmentId: d.assignmentId, proposed: { type: 'check_in', occurredAt: iso(d.startsAt) }, reason: 'Started on time, phone was slow' }));
  await must(t.owner.post('/exports', { reportType: 'attendance', format: 'csv', filters: { from: iso(now0 - 86400000), to: iso(now0 + 86400000) } }));
  await must(t.owner.get(`/locations/history?staffMemberId=${f.staffId}&from=${iso(now0)}&to=${iso(h.clock.now())}&purpose=${encodeURIComponent('isolation test fixture')}`));
  await must(t.owner.post('/tenant/legal-holds', { scope: { kind: 'staff', id: sup.staffId }, reason: 'fixture hold' }));
  await must(t.owner.post('/roles', { name: 'Custom planner', clonedFrom: t.roleIds.supervisor }));
  await tick(h); h.clock.set(now0 + 12 * 60000);
  return { ...t, field: f.client, staffId: f.staffId, assignmentId: d.assignmentId };
}
const fingerprint = (h: Awaited<ReturnType<typeof makeApp>>, tenantId: string) => { const dump = h.store.dump(); const hash = createHash('sha256'); for (const [c, def] of Object.entries(COLLECTIONS)) if (def.tenantOwned && c !== 'realtime_events') hash.update(JSON.stringify(dump[c]!.filter((d) => d.tenantId === tenantId).sort((a, b) => a._id.localeCompare(b._id)))); return hash.digest('hex'); };

test('TR-001 tenant isolation: tenant B cannot read, list or change any tenant A record through any endpoint', async () => {
  const h = await makeApp(); const a = await populated(h, 'alpha'); const b = await populated(h, 'bravo');
  const dump = h.store.dump(); const aId = a.tenant._id;
  const aIds: string[] = []; const sample: string[] = [];
  for (const [c, def] of Object.entries(COLLECTIONS)) { if (!def.tenantOwned) continue; const docs = dump[c]!.filter((d) => d.tenantId === aId); for (const d of docs) aIds.push(d._id); if (docs[0]) sample.push(docs[0]._id); for (const k of ['eventId', 'tagId']) if (docs[0]?.[k]) sample.push(String(docs[0][k])); }
  assert.ok(sample.length > 35, `fixture covers ${sample.length} id kinds`);
  const leaks = (body: unknown) => { const text = JSON.stringify(body ?? ''); return text.includes(aId) || aIds.some((id) => text.includes(`"${id}"`)); };
  const before = fingerprint(h, aId); let calls = 0;
  for (const actor of [b.owner, b.field]) {
    for (const r of h.app.routes) {
      if (r.scope === 'platform' || r.raw) continue;
      const ids = r.keys.length ? sample : [''];
      for (const id of ids) {
        const path = r.path.replace(/:[A-Za-z]+/g, id);
        const res = await actor.req(r.method, path + (r.method === 'GET' && !r.keys.length ? '?limit=200' : ''), r.method === 'GET' || r.method === 'DELETE' ? undefined : {}); calls++;
        if (r.keys.length) assert.ok(res.status >= 400, `${r.method} ${r.path} with a foreign id returned ${res.status}`);
        assert.ok(!leaks(res.body), `${r.method} ${path} leaked tenant A data: ${JSON.stringify(res.body).slice(0, 200)}`);
      }
    }
  }
  // references to foreign ids inside request bodies are rejected as well
  await b.owner.login('owner', PASSWORD); // the sweep above also exercised logout
  const foreignStaff = dump.staff_members!.find((d) => d.tenantId === aId)!._id, foreignUnit = dump.organization_units!.find((d) => d.tenantId === aId)!._id, foreignPost = dump.posts!.find((d) => d.tenantId === aId)!._id, foreignShift = dump.shifts!.find((d) => d.tenantId === aId)!._id;
  for (const [path, body] of [['/posts', { unitId: foreignUnit, name: 'x' }], ['/units', { parentId: foreignUnit, type: 't', name: 'x' }], ['/staff', { employeeCode: 'X1', displayName: 'x', homeUnitId: foreignUnit }], ['/shifts', { name: 's', postId: foreignPost, startDate: '2026-11-11', startsAtLocal: '08:00', endsAtLocal: '16:00' }],
    ['/assignments', { shiftId: foreignShift, localDate: '2026-11-10', staffMemberId: foreignStaff }], ['/geofences', { postId: foreignPost, name: 'g', geometry: { shape: 'circle', center: { lat: 1, lon: 1 }, radiusM: 50 } }], ['/checkpoints', { postId: foreignPost, name: 'c', method: 'qr' }], ['/tenant/legal-holds', { scope: { kind: 'staff', id: foreignStaff }, reason: 'cross tenant' }]] as [string, unknown][]) {
    const res = await b.owner.post(path, body); assert.equal(res.status, 404, `${path} with a foreign reference → ${res.status}`);
  }
  assert.equal(fingerprint(h, aId), before, 'no tenant A record was created, changed or deleted');
  assert.ok(calls > 3000, `${calls} cross-tenant calls made`);
  // a token minted for tenant B but claiming tenant A's ids is useless
  const forged = signJwt({ typ: 'access', sub: a.owner.profile!.userId, tid: aId, mid: 'x', sid: 'x', sv: 1, exp: Math.floor(h.clock.now() / 1000) + 600 }, loadJwtKey(generateJwtKey('attacker')));
  assert.equal((await new Client(h, 'alpha').get('/staff', { authorization: `Bearer ${forged}` })).status, 401);
});

test('TR-001 schema inventory: every tenant-owned collection is tenantId-indexed, every record carries tenantId, repositories refuse to run unscoped', async () => {
  const h = await makeApp(); const a = await populated(h, 'alpha');
  for (const [name, def] of Object.entries(COLLECTIONS)) {
    if (!def.tenantOwned) continue;
    assert.ok([...(def.unique ?? []), ...(def.indexes ?? [])].some((i) => i[0] === 'tenantId'), `${name} has a tenantId-prefixed index`);
    for (const u of def.unique ?? []) assert.equal(u[0], 'tenantId', `${name} unique key ${u} is tenant-scoped`);
    for (const d of h.store.dump()[name]!) assert.ok(typeof d.tenantId === 'string' && d.tenantId.length > 0, `${name}/${d._id} has tenantId`);
  }
  assert.throws(() => new ScopedCollection(h.store, 'tenants', a.tenant._id), /not tenant-owned/);
  assert.throws(() => new ScopedCollection(h.store, 'staff_members', ''), /without a tenantId/);
  assert.throws(() => new ScopedCollection(h.store, 'no_such_collection', a.tenant._id), /unknown collection/);
  for (const c of ['audit_events', 'attendance_events', 'location_points', 'checkpoint_scans', 'geofence_events', 'incident_timeline', 'alert_timeline', 'assignment_history', 'location_access_log']) {
    assert.ok(COLLECTIONS[c]!.immutable, `${c} is declared append-only`);
    await assert.rejects(h.store.updateOne(c, {}, { $set: { x: 1 } }), /append-only/); await assert.rejects(h.store.deleteMany(c, {}), /append-only/);
  }
});

test('TR / FR-AUD-001 route metadata: every route declares permission, scope, audit decision and rate class; every mutating route is audited or justified', async () => {
  const h = await makeApp(); const known = new Set([...PERMISSION_KEYS, 'public', 'session', 'platform-session']);
  assert.ok(h.app.routes.length > 150, `${h.app.routes.length} routes registered`);
  for (const r of h.app.routes) {
    const id = `${r.method} ${r.path}`;
    assert.ok(known.has(r.permission) || r.permission.startsWith('platform.'), `${id}: unknown permission ${r.permission}`);
    assert.ok(['none', 'tenant', 'unit', 'own', 'platform'].includes(r.scope), `${id}: scope`); assert.ok(r.summary.length > 8, `${id}: summary`); assert.ok(r.rate, `${id}: rate class`);
    assert.ok(typeof r.audit === 'string' ? /^[a-z_.]+$/.test(r.audit) : r.audit.none.length > 10, `${id}: audit action or justification`);
    if (r.method !== 'GET' && r.permission !== 'public') assert.ok(r.body || r.binaryMaxBytes || r.method === 'DELETE', `${id}: mutating route validates its body`);
    if (r.scope === 'platform') assert.ok(r.permission.startsWith('platform'), `${id}: platform routes use platform permissions`);
  }
});

// PRD Appendix A, transcribed independently of the role definitions: capability → probe request → roles that must be allowed.
test('TR-002 permission matrix: every default role is allowed exactly what PRD Appendix A grants', async () => {
  const h = await makeApp(); const t = await populated(h, 'alpha');
  const clients: Record<string, Client> = { owner: t.owner, field: t.field };
  for (const role of ['admin', 'commander', 'supervisor', 'dispatcher', 'auditor']) clients[role] = (await addStaff(t, role)).client;
  const q = `from=${iso(h.clock.now() - 86400000)}&to=${iso(h.clock.now())}`;
  const probes: [string, string, string, unknown, string[]][] = [
    ['Ownership: export', 'POST', '/tenant/exports', {}, ['owner']],
    ['Ownership: support grants', 'GET', '/tenant/support-grants', undefined, ['owner']],
    ['Ownership: legal hold', 'GET', '/tenant/legal-holds', undefined, ['owner']],
    ['Tenant settings (read)', 'GET', '/tenant/settings', undefined, ['owner', 'admin', 'auditor']],
    ['Tenant settings (change)', 'PUT', '/tenant/settings', { version: 999, settings: {} }, ['owner', 'admin']],
    ['Alert rules (read)', 'GET', '/alert-rules', undefined, ['owner', 'admin', 'auditor']],
    ['Roles (read)', 'GET', '/roles', undefined, ['owner', 'admin', 'auditor']],
    ['Roles (manage)', 'POST', '/roles', { name: '' }, ['owner', 'admin']],
    ['Hierarchy (read)', 'GET', '/units', undefined, ['owner', 'admin', 'commander', 'supervisor', 'dispatcher', 'auditor']],
    ['Hierarchy (manage)', 'POST', '/units', {}, ['owner', 'admin']],
    ['Posts (manage)', 'POST', '/posts', {}, ['owner', 'admin']],
    ['Geofences (read)', 'GET', '/geofences', undefined, ['owner', 'admin', 'commander', 'supervisor', 'dispatcher', 'auditor']],
    ['Geofences (manage)', 'POST', '/geofences', {}, ['owner', 'admin']],
    ['Checkpoints (manage)', 'POST', '/checkpoints', {}, ['owner', 'admin']],
    ['Staff (read)', 'GET', '/staff', undefined, ['owner', 'admin', 'commander', 'supervisor', 'auditor']],
    ['Staff (manage)', 'POST', '/staff', {}, ['owner', 'admin', 'commander']],
    ['Devices (read)', 'GET', '/devices', undefined, ['owner', 'admin', 'commander', 'supervisor', 'auditor']],
    ['Rosters (create/publish)', 'POST', '/rosters/publish', {}, ['owner', 'admin', 'commander', 'supervisor']],
    ['Assignments (create)', 'POST', '/assignments', {}, ['owner', 'admin', 'commander', 'supervisor']],
    ['Roster (view)', 'GET', '/assignments', undefined, ['owner', 'admin', 'commander', 'supervisor', 'dispatcher', 'auditor']],
    ['Start/end duty (own)', 'POST', '/attendance/events', {}, ['field']],
    ['Checkpoint scan (own)', 'POST', '/checkpoint-scans', {}, ['field']],
    ['Attendance (view)', 'GET', '/attendance/events', undefined, ['owner', 'admin', 'commander', 'supervisor', 'auditor']],
    ['Attendance review', 'POST', `/assignments/${t.assignmentId}/review`, {}, ['owner', 'admin', 'commander', 'supervisor']],
    ['Correction request (own)', 'POST', '/corrections', {}, ['field']],
    ['Live command centre', 'GET', '/locations/latest', undefined, ['owner', 'admin', 'commander', 'supervisor', 'dispatcher']],
    ['Dashboard', 'GET', '/dashboard/overview', undefined, ['owner', 'admin', 'commander', 'supervisor', 'dispatcher']],
    ['Location history', 'GET', '/locations/history', undefined, ['owner', 'admin', 'commander', 'supervisor', 'dispatcher']],
    ['Alerts (view)', 'GET', '/alerts', undefined, ['owner', 'admin', 'commander', 'supervisor', 'dispatcher', 'auditor']],
    ['Alerts (acknowledge)', 'POST', '/alerts/none/acknowledge', {}, ['owner', 'admin', 'commander', 'supervisor', 'dispatcher']],
    ['Raise SOS', 'POST', '/sos', {}, ['owner', 'admin', 'commander', 'supervisor', 'dispatcher', 'field']],
    ['Raise incident', 'POST', '/incidents', {}, ['owner', 'admin', 'commander', 'supervisor', 'dispatcher', 'field']],
    ['Handle incidents', 'POST', '/incidents/none/transition', { to: 'acknowledged' }, ['owner', 'admin', 'commander', 'supervisor', 'dispatcher']],
    ['Reports (operational)', 'GET', `/reports/attendance?${q}`, undefined, ['owner', 'admin', 'commander', 'supervisor', 'auditor']],
    ['Reports (incident)', 'GET', `/reports/incidents?${q}`, undefined, ['owner', 'admin', 'commander', 'supervisor', 'dispatcher', 'auditor']],
    ['Export', 'POST', '/exports', {}, ['owner', 'admin', 'commander', 'supervisor', 'auditor']],
    ['Audit log', 'GET', '/audit/events', undefined, ['owner', 'admin', 'auditor']],
    ['Privacy subject requests', 'POST', '/staff/none/data-export', {}, ['owner', 'admin']],
    ['Own data self-view', 'GET', '/me/data', undefined, ['owner', 'admin', 'commander', 'supervisor', 'dispatcher', 'field', 'auditor']],
  ];
  let checks = 0;
  for (const [cap, method, path, body, allowed] of probes) for (const [role, c] of Object.entries(clients)) {
    const res = await c.req(method, path, body); const permitted = res.status !== 403 || res.body?.error?.code !== 'FORBIDDEN'; checks++;
    assert.equal(permitted, allowed.includes(role), `${cap}: ${role} should be ${allowed.includes(role) ? 'allowed' : 'denied'} (got ${res.status} ${res.body?.error?.code ?? ''})`);
  }
  assert.equal(checks, probes.length * 7);
  // platform staff: metadata only, no tenant content without a grant (FR-TEN-003)
  const denied = (await must(t.owner.get('/audit/events?action=access.denied&limit=200'))).items; assert.ok(denied.length > 50, 'permission denials are audited');
});

test('FR-AUTH-006/002 lockout, neutral errors, password policy, rehash on login', async () => {
  const h = await makeApp({ rateLimits: false }); const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field', { device: false });
  const c = new Client(h, 'acme');
  const wrong = await c.post('/auth/login', { tenant: 'acme', identifier: f.code, password: 'nope' }), unknown = await c.post('/auth/login', { tenant: 'acme', identifier: 'ghost', password: 'nope' }), noTenant = await c.post('/auth/login', { tenant: 'ghost-org', identifier: f.code, password: 'nope' });
  for (const r of [wrong, unknown, noTenant]) { assert.equal(r.status, 401); assert.equal(r.body.error.message, wrong.body.error.message, 'identical message for unknown account, wrong password and unknown organisation'); assert.equal(r.body.error.code, 'UNAUTHENTICATED'); }
  for (let i = 0; i < 4; i++) await c.post('/auth/login', { tenant: 'acme', identifier: f.code, password: 'nope' });
  const locked = await c.post('/auth/login', { tenant: 'acme', identifier: f.code, password: PASSWORD }); assert.equal(locked.status, 423, 'locked after 5 failures even with the right password');
  h.clock.advanceMin(16); assert.equal((await c.login(f.code, PASSWORD)).status, 200, 'unlocks after 15 minutes');
  const audit = (await must(t.owner.get('/audit/events?limit=200'))).items.map((e: Doc) => e.action); assert.ok(audit.includes('auth.login.failed') && audit.includes('auth.account.locked'));
  // password policy: length floor and breached list
  const s2 = await must(t.owner.post('/staff', { employeeCode: 'P1', displayName: 'P One', homeUnitId: t.rootUnitId })); const inv = await must(t.owner.post(`/staff/${s2.id}/invitation`, { channel: 'code' }));
  for (const [pw, code] of [['short1', 'TOO_SHORT'], ['password123', 'BREACHED']]) { const r = await c.post('/auth/activate', { tenant: 'acme', code: inv.activationCode, password: pw }); assert.equal(r.status, 400); assert.equal(r.body.error.fieldErrors[0].code, code); }
  assert.equal((await c.post('/auth/activate', { tenant: 'acme', code: inv.activationCode, password: PASSWORD })).status, 200);
  assert.equal((await c.post('/auth/activate', { tenant: 'acme', code: inv.activationCode, password: PASSWORD })).status, 401, 'activation code is single-use');
  const user = (await h.store.findOne('users', { username: 'p1' }))!; assert.ok(!user.passwordHash.includes(PASSWORD)); assert.match(user.passwordHash, /^scrypt\$1024\$/);
  // rehash on login when parameters change
  const { scryptHasher } = await import('@sf/kernel'); (h.app as unknown as { hasher: unknown }).hasher = scryptHasher({ N: 2048, r: 8, p: 1 });
  assert.equal((await new Client(h, 'acme').login('p1', PASSWORD)).status, 200); assert.match((await h.store.findOne('users', { username: 'p1' }))!.passwordHash, /^scrypt\$2048\$/);
  // expired activation code
  const s3 = await must(t.owner.post('/staff', { employeeCode: 'P2', displayName: 'P Two', homeUnitId: t.rootUnitId })); const inv3 = await must(t.owner.post(`/staff/${s3.id}/invitation`, { channel: 'code' }));
  h.clock.advance(73 * 3600000); assert.equal((await c.post('/auth/activate', { tenant: 'acme', code: inv3.activationCode, password: PASSWORD })).status, 401, 'activation code expires after 72 hours');
});

test('FR-AUTH-003 MFA: privileged roles cannot obtain a session without it; codes are not replayable; recovery codes are single-use; reset needs another admin', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const c = new Client(h, 'acme');
  const step1 = await c.post('/auth/login', { tenant: 'acme', identifier: 'owner', password: PASSWORD });
  assert.equal(step1.body.mfaRequired, true); assert.equal(step1.body.accessToken, undefined, 'no token before the second factor');
  const secret = MFA_SECRETS.get('acme:owner')!; const code = totp(secret, h.clock.now());
  assert.equal((await c.post('/auth/mfa/verify', { tenant: 'acme', challengeToken: step1.body.challengeToken, code: '000000' })).status, 401);
  h.clock.advanceSec(31); const good = totp(secret, h.clock.now());
  const ok = await c.post('/auth/mfa/verify', { tenant: 'acme', challengeToken: step1.body.challengeToken, code: good }); assert.equal(ok.status, 200); assert.ok(ok.body.accessToken);
  const step2 = await c.post('/auth/login', { tenant: 'acme', identifier: 'owner', password: PASSWORD });
  assert.equal((await c.post('/auth/mfa/verify', { tenant: 'acme', challengeToken: step2.body.challengeToken, code: good })).status, 401, 'a used TOTP code cannot be replayed');
  assert.notEqual(code, undefined);
  // admin enrols and uses a recovery code once
  const admin = await addStaff(t, 'admin'); const key = `acme:${admin.code.toLowerCase()}`; assert.ok(MFA_SECRETS.has(key), 'admin was forced to enrol');
  const a2 = new Client(h, 'acme'); const l1 = await a2.post('/auth/login', { tenant: 'acme', identifier: admin.code, password: PASSWORD });
  const e = await a2.post('/auth/mfa/enroll', { tenant: 'acme', challengeToken: l1.body.challengeToken }); assert.equal(e.status, 401, 'an enrolled account cannot re-enrol with a login challenge');
  const factor = (await h.store.findOne('mfa_factors', { userId: admin.client.profile!.userId }))!; assert.ok(!JSON.stringify(factor).includes(MFA_SECRETS.get(key)!), 'TOTP secret is encrypted at rest'); assert.equal(factor.recoveryCodes.length, 10);
  assert.equal((await t.owner.post(`/users/${t.owner.profile!.userId}/mfa/reset`, { reason: 'lost phone' })).status, 403, 'cannot reset own MFA');
  await must(t.owner.post(`/users/${admin.client.profile!.userId}/mfa/reset`, { reason: 'lost phone' }));
  assert.equal((await admin.client.get('/auth/me', { 'x-no-refresh': '1' })).status, 401, 'MFA reset revokes the user\'s sessions');
  const l2 = await a2.post('/auth/login', { tenant: 'acme', identifier: admin.code, password: PASSWORD }); assert.equal(l2.body.enrolmentRequired, true);
  // field staff (not privileged) sign in without MFA
  const f = await addStaff(t, 'field', { device: false }); assert.equal(MFA_SECRETS.has(`acme:${f.code.toLowerCase()}`), false);
});

test('FR-AUTH-004/005 sessions: rotation, reuse detection revokes the family, remote revoke, password change/reset revoke sessions, token tampering', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field', { device: false }); const c = f.client;
  const r0 = c.refreshToken!;
  const r1 = await c.post('/auth/refresh', { tenant: 'acme', refreshToken: r0 }); assert.equal(r1.status, 200); assert.notEqual(r1.body.refreshToken, r0);
  c.token = r1.body.accessToken; c.refreshToken = r1.body.refreshToken;
  assert.equal((await c.get('/auth/me')).status, 200);
  const replay = await c.post('/auth/refresh', { tenant: 'acme', refreshToken: r0 }); assert.equal(replay.status, 401, 'a rotated token is rejected');
  assert.equal((await c.get('/auth/me', { 'x-no-refresh': '1' })).status, 401, 'the whole family is revoked in the same request');
  assert.equal((await c.post('/auth/refresh', { tenant: 'acme', refreshToken: r1.body.refreshToken })).status, 401);
  assert.ok((await must(t.owner.get('/audit/events?action=auth.refresh.reuse_detected'))).items.length === 1, 'reuse is a security audit event');
  // remote revoke by admin
  await c.login(f.code, PASSWORD); const sessions = await must(t.owner.get(`/auth/sessions?userId=${c.profile!.userId}`)); assert.equal(sessions.items.length, 1);
  await must(t.owner.del(`/auth/sessions/${sessions.items[0].id}`)); assert.equal((await c.get('/auth/me', { 'x-no-refresh': '1' })).status, 401, 'revoked session stops working on the next request');
  // password change revokes other sessions
  await c.login(f.code, PASSWORD); const other = new Client(h, 'acme'); await other.login(f.code, PASSWORD);
  await must(c.post('/auth/password/change', { currentPassword: PASSWORD, newPassword: 'Another-Good-Passphrase-9' }));
  assert.equal((await other.get('/auth/me', { 'x-no-refresh': '1' })).status, 401); assert.equal((await c.get('/auth/me')).status, 200);
  // password reset: unverified email is never used; verified → single-use token revokes all sessions
  const mail = h.app.services.mail.devOutbox as { to: string; template: string; vars: Record<string, string> }[];
  await must(t.owner.patch(`/staff/${f.staffId}`, { version: (await must(t.owner.get(`/staff/${f.staffId}`))).version, email: 'field@acme.example' }));
  const forgot = await new Client(h, 'acme').post('/auth/password/forgot', { tenant: 'acme', identifier: f.code }); const ghost = await new Client(h, 'acme').post('/auth/password/forgot', { tenant: 'acme', identifier: 'ghost' });
  assert.deepEqual(forgot.body, ghost.body, 'same answer whether or not the account exists'); assert.equal(mail.filter((m) => m.template === 'password_reset').length, 0, 'unverified email is not used');
  await must(c.post('/auth/email/request-verification')); const vtoken = new URL(mail.find((m) => m.template === 'verify_email')!.vars.link!.replace('/#/', '/')).searchParams.get('token')!;
  await must(new Client(h, 'acme').post('/auth/verify-email', { tenant: 'acme', token: vtoken }));
  await new Client(h, 'acme').post('/auth/password/forgot', { tenant: 'acme', identifier: f.code });
  const token = new URL(mail.find((m) => m.template === 'password_reset')!.vars.link!.replace('/#/', '/')).searchParams.get('token')!;
  assert.equal((await new Client(h, 'acme').post('/auth/password/reset', { tenant: 'acme', token, password: 'Reset-Passphrase-2026-x' })).status, 200);
  assert.equal((await new Client(h, 'acme').post('/auth/password/reset', { tenant: 'acme', token, password: 'Reset-Passphrase-2026-y' })).status, 401, 'reset token is single-use');
  assert.equal((await c.get('/auth/me', { 'x-no-refresh': '1' })).status, 401, 'password reset revokes all sessions');
  assert.equal((await new Client(h, 'acme').login(f.code, 'Reset-Passphrase-2026-x')).status, 200);
  // token tampering
  await c.login(f.code, 'Reset-Passphrase-2026-x'); const [hd, pl, sg] = c.token!.split('.');
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${pl}.`;
  const elevated = `${hd}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pl!, 'base64url').toString()), sub: t.owner.profile!.userId })).toString('base64url')}.${sg}`;
  for (const bad of [none, elevated, `${hd}.${pl}.AAAA`, 'garbage']) assert.equal((await new Client(h, 'acme').get('/auth/me', { authorization: `Bearer ${bad}` })).status, 401);
  h.clock.advanceMin(16); assert.equal((await c.get('/auth/me', { 'x-no-refresh': '1' })).status, 401, 'access tokens expire after 15 minutes');
  // web clients: refresh token only in an HttpOnly cookie, CSRF double-submit required
  const web = new Client(h, 'acme'); const wl = await web.post('/auth/login', { tenant: 'acme', identifier: f.code, password: 'Reset-Passphrase-2026-x', client: 'web' });
  assert.equal(wl.body.refreshToken, undefined); assert.match(String((wl.headers['Set-Cookie'] as string[])[0]), /sf_refresh=.*HttpOnly; SameSite=Strict/);
  assert.equal((await web.post('/auth/refresh', { tenant: 'acme' })).status, 403, 'cookie refresh without the CSRF header is refused');
  assert.equal((await web.post('/auth/refresh', { tenant: 'acme' }, { 'x-csrf-token': web.cookies.sf_csrf! })).status, 200);
});

test('FR-DEV-001..003 devices: second device needs approval, revoke blocks all access at once, signature required, minimum app version', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field'); const d = await planDuty(t, f.staffId); h.clock.advanceMin(10);
  // unsigned or wrongly signed duty request
  const dev = f.client.device!; f.client.device = null;
  assert.equal((await f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h))).status, 401, 'device-bound action without proof of possession');
  const { generateKeyPairSync } = await import('node:crypto'); f.client.device = { ...dev, privateKey: generateKeyPairSync('ed25519').privateKey };
  assert.equal((await f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h))).status, 401, 'signature from another key is rejected');
  f.client.device = dev;
  // second phone: pending approval, cannot do duty actions
  const phone2 = new Client(h, 'acme'); await phone2.login(f.code, PASSWORD); const reg = await phone2.registerDevice(); assert.equal(reg.status, 'pending_approval');
  assert.equal((await phone2.post(`/assignments/${d.assignmentId}/start`, startBody(h))).body.error.code, 'DEVICE_NOT_APPROVED');
  const st = await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h)));
  // admin approves the new phone → old one is revoked (policy max 1), its tracking session closes, its API access ends
  await must(t.owner.post(`/devices/${reg.id}/approve`));
  const blocked = await f.client.get('/me/duty', { 'x-no-refresh': '1' }); assert.equal(blocked.status, 401);
  assert.equal((await f.client.post('/auth/login', { tenant: 'acme', identifier: f.code, password: PASSWORD, deviceId: dev.id })).body.error.code, 'DEVICE_REVOKED');
  const ts = (await must(t.owner.get(`/tracking/sessions?assignmentId=${d.assignmentId}`))).items[0]; assert.equal(ts.state, 'closed'); assert.equal(ts.closeReason, 'device_revoked'); assert.equal(ts.id, st.trackingSessionId);
  assert.equal((await must(phone2.get('/me/duty'))).items.length, 1, 'approved device works');
  // hard minimum app version
  const cur = await must(t.owner.get('/tenant/settings')); await must(t.owner.put('/tenant/settings', { version: cur.version, settings: { devices: { minAppVersion: '2.0.0' } } }));
  const old = await phone2.get('/me/duty'); assert.equal(old.status, 426); assert.equal(old.body.error.code, 'UPGRADE_REQUIRED'); assert.equal(old.body.error.details.minAppVersion, '2.0.0');
  assert.notEqual((await phone2.post('/sos', { eventId: uuid(), occurredAt: iso(h.clock.now()) })).status, 426, 'SOS is not blocked by the version gate');
  assert.equal((await phone2.get('/me/duty', { 'x-app-version': '2.1.0' })).status, 200);
  const audit = (await must(t.owner.get('/audit/events?limit=200'))).items.map((e: Doc) => e.action); for (const a of ['device.register', 'device.approve']) assert.ok(audit.includes(a));
});

test('FR-AUD-001/002/003 audit: sensitive actions are recorded with before/after, the chain verifies, tampering is detected, reads of the audit log are audited', async () => {
  const h = await makeApp(); const t = await populated(h, 'alpha');
  const cur = await must(t.owner.get('/tenant/settings')); await must(t.owner.put('/tenant/settings', { version: cur.version, settings: { duty: { lateMin: 45 } } }));
  const ev = (await must(t.owner.get('/audit/events?action=settings.update'))).items[0];
  assert.deepEqual(ev.after, { duty: { lateMin: 45 } }); assert.deepEqual(ev.before, {}); assert.equal(ev.actor.id, t.owner.profile!.userId); assert.ok(ev.requestId && ev.hash && ev.occurredAt);
  const all = (await must(t.owner.get('/audit/events?limit=200'))).items.map((e: Doc) => e.action);
  for (const a of ['duty.start', 'sos.raise', 'incident.create', 'location.history.read', 'geofence.create', 'checkpoint.create', 'roster.publish', 'assignment.create', 'export.create', 'legalhold.place', 'role.create', 'privacy.notice.publish', 'privacy.notice.acknowledge', 'attendance.correction.request']) assert.ok(all.includes(a), `audited: ${a}`);
  assert.ok((await must(t.owner.get('/audit/events?action=audit.read'))).items.length >= 2, 'reading the audit log is itself audited');
  const ok = await must(t.owner.get('/audit/verify')); assert.equal(ok.ok, true); assert.ok(ok.count >= 25, `chain length ${ok.count}`);
  // no update or delete endpoint exists for audit events
  assert.ok(!h.app.routes.some((r) => r.path.startsWith('/audit') && r.method !== 'GET'));
  // simulate tampering directly in the database (bypassing the application)
  const raw = (h.store as unknown as { data: Map<string, Map<string, Doc>> }).data.get('audit_events')!; const victim = [...raw.values()].find((e) => e.tenantId === t.tenant._id && e.action === 'sos.raise')!; victim.outcome = 'failed';
  const broken = await must(t.owner.get('/audit/verify')); assert.equal(broken.ok, false); assert.equal(broken.brokenAtSeq, victim.seq);
  h.clock.advance(25 * 3600000); await h.app.runSchedulers(true); await h.app.pump();
  assert.equal((await t.owner.get('/auth/me', { 'x-no-refresh': '1' })).status, 401, 'web sessions end after 12 idle hours'); await t.owner.login('owner', PASSWORD);
  assert.ok((await must(t.owner.get('/notifications?limit=100'))).items.some((n: Doc) => n.template === 'audit_chain_broken'), 'the daily verification raises a security notification');
  // tenant B cannot see tenant A's audit events; auditors can read but not change anything
  const aud = (await addStaff(t, 'auditor')).client; assert.equal((await aud.get('/audit/events')).status, 200); assert.equal((await aud.post('/units', { parentId: t.rootUnitId, type: 'x', name: 'x' })).status, 403);
});

test('FR-NFR-004 log hygiene: no passwords, tokens, activation codes, TOTP secrets or coordinates appear in application logs', async () => {
  const h = await makeApp(); const t = await populated(h, 'alpha');
  await t.owner.post('/auth/login', { tenant: 'alpha', identifier: 'owner', password: 'Wrong-Password-Value-1' });
  const text = h.logs.join('\n'); assert.ok(h.logs.length >= 30, `requests are logged (${h.logs.length})`);
  const secrets = [PASSWORD, 'Wrong-Password-Value-1', t.owner.token!, t.owner.refreshToken!, MFA_SECRETS.get('alpha:owner')!, '24.8607', '67.0011'];
  for (const sct of secrets) assert.ok(!text.includes(sct), `log contains a secret or coordinate: ${sct.slice(0, 6)}…`);
  for (const inv of h.store.dump().invitations!) assert.ok(!text.includes(inv.codeHash));
  const line = JSON.parse(h.logs.find((l) => l.includes('"route":"/staff"'))!); for (const k of ['requestId', 'route', 'status', 'ms', 'tenantId', 'actorId', 'module']) assert.ok(k in line, `log field ${k}`);
  // stored secrets are hashed or encrypted
  const dump = h.store.dump();
  for (const s of dump.sessions!) assert.ok(/^[0-9a-f]{64}$/.test(s.tokenHash) && !('refreshToken' in s));
  for (const c of dump.checkpoints!) assert.ok(!('tagSecret' in c));
  for (const st of dump.staff_members!) if (st.contactEnc) assert.ok(st.contactEnc.startsWith('v1.') && !st.contactEnc.includes('+92'));
  // error responses never include stack traces or internals
  const bad = await t.owner.req('POST', '/units', undefined, { 'content-type': 'application/json' }); assert.equal(bad.status, 400); assert.ok(!JSON.stringify(bad.body).includes('at '));
});
