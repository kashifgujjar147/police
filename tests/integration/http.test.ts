// Real HTTP: server adapter, health/readiness, metrics protection, CORS allow-list, SSE stream with server-computed rooms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { startServer } from '../../apps/api/src/server.ts';
import { addStaff, iso, makeApp, must, planDuty, points, setupTenant, startBody } from '../helpers.ts';

test('TS §23/§10 HTTP adapter: health, readiness, protected metrics, CORS allow-list, security headers and a live SSE stream', async () => {
  const h = await makeApp({ port: 0, host: '127.0.0.1', corsOrigins: ['https://console.example'], metricsToken: 'metrics-token-for-test', webDir: '/nonexistent' });
  const t = await setupTenant(h, 'acme'); const sup = await addStaff(t, 'supervisor'); const f = await addStaff(t, 'field'); const d = await planDuty(t, f.staffId);
  const server = await startServer(h.app); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/health/live`)).json(), { status: 'ok' });
    const ready = await fetch(`${base}/health/ready`); assert.equal(ready.status, 200); assert.equal((await ready.json()).store, 'ok');
    assert.equal((await fetch(`${base}/metrics`)).status, 401); const m = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer metrics-token-for-test' } }); assert.match(await m.text(), /sf_http_requests_total/);
    const pre = await fetch(`${base}/api/v1/staff`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }); assert.equal(pre.status, 403); assert.equal(pre.headers.get('access-control-allow-origin'), null);
    const ok = await fetch(`${base}/api/v1/staff`, { method: 'OPTIONS', headers: { origin: 'https://console.example' } }); assert.equal(ok.headers.get('access-control-allow-origin'), 'https://console.example');
    const api = await fetch(`${base}/api/v1/tenant`); assert.equal(api.status, 401); assert.equal(api.headers.get('x-content-type-options'), 'nosniff'); assert.equal(api.headers.get('cache-control'), 'no-store'); assert.ok(api.headers.get('x-request-id'));
    assert.equal((await fetch(`${base}/`)).status, 404, 'web portal not built in this test');
    // SSE: the supervisor's stream receives events for their scope
    const ac = new AbortController(); const res = await fetch(`${base}/api/v1/realtime/stream`, { headers: { authorization: `Bearer ${sup.client.token}` }, signal: ac.signal });
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type')!, /text\/event-stream/);
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
    const until = async (needle: string) => { const end = Date.now() + 4000; while (!buf.includes(needle) && Date.now() < end) { const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r2) => setTimeout(() => r2({ done: true, value: undefined }), 500))]); if (r.value) buf += dec.decode(r.value); } return buf.includes(needle); };
    assert.ok(await until('event: hello'));
    h.clock.advanceMin(10); const st = await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h)));
    await must(f.client.post('/locations/batch', { trackingSessionId: st.trackingSessionId, sentAt: iso(h.clock.now()), points: points(h, 1) })); await h.app.pump();
    assert.ok(await until('event: location:updated'), 'location event delivered over SSE'); assert.ok(buf.includes('event: duty:started')); assert.match(buf, /"seq":\d+/);
    assert.equal((await fetch(`${base}/api/v1/realtime/stream`)).status, 401, 'stream requires authentication');
    ac.abort(); await new Promise((r) => setTimeout(r, 50)); assert.equal(h.app.hub.count(), 0, 'subscription is released on disconnect');
  } finally { server.closeAllConnections(); server.close(); }
});
