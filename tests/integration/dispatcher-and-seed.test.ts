// Regression tests for fixes found by driving the portal as each role (2026-11-13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemo } from '../../scripts/lib/demo.ts';
import { addStaff, makeApp, must, planDuty, setupTenant, uuid } from '../helpers.ts';

test('Dispatcher can assign incident responders (responder options without staff.read) and sees assignee names in the planner', async () => {
  const h = await makeApp(); const t = await setupTenant(h, 'acme');
  const dsp = await addStaff(t, 'dispatcher'); const field = await addStaff(t, 'field'); const other = await setupTenant(h, 'beta'); await addStaff(other, 'field');
  assert.equal((await dsp.client.get('/staff?status=active&limit=200')).status, 403, 'dispatcher still has no staff list');
  const d = await planDuty(t, field.staffId);

  // planner rows carry the assignee's name and code
  const rows = (await must(dsp.client.get('/assignments?limit=50'))).items; const row = rows.find((a: any) => a.id === d.assignmentId);
  assert.ok(row, 'dispatcher sees the assignment'); assert.match(row.staffName, /field/); assert.equal(row.staffCode, field.code);

  // responders: options are scoped, name/code only, and assigning works end to end
  const inc = await must(dsp.client.post('/incidents', { eventId: uuid(), typeKey: 'hazard', severity: 'medium', description: 'Fence damaged at the north post' }));
  const opts = (await must(dsp.client.get(`/incidents/${inc.incidentId}/responder-options`))).items;
  assert.ok(opts.some((o: any) => o.id === field.staffId)); assert.deepEqual(Object.keys(opts[0]).sort(), ['displayName', 'employeeCode', 'id'], 'no extra personal data');
  assert.equal(opts.length, await h.store.count('staff_members', { tenantId: t.tenant._id, status: 'active' }), 'only this organisation');
  await must(dsp.client.post(`/incidents/${inc.incidentId}/responders`, { staffMemberIds: [field.staffId] }));
  assert.equal((await field.client.get(`/incidents/${inc.incidentId}/responder-options`)).status, 403, 'field staff cannot list responders');
  assert.equal((await other.owner.get(`/incidents/${inc.incidentId}/responder-options`)).status, 404, 'other organisation cannot see the incident');
});

test('demo seed works in simple local mode (no 2FA) and with 2FA on', async () => {
  const simple = await makeApp({ env: 'development', mfaDevBypass: true }); const a = await buildDemo(simple.app, { staffCount: 3 });
  assert.equal(a.owner.totpSecret, '', 'no authenticator in simple mode'); assert.ok(await simple.store.count('staff_members', {}) >= 3);
  const strict = await makeApp(); const b = await buildDemo(strict.app, { staffCount: 3 }); assert.match(b.owner.totpSecret, /^[A-Z2-7]{16,}$/, 'owner enrolled TOTP when 2FA is on');
});
