// Real-location check: takes a genuine, permission-granted geolocation fix from Chrome and pushes it through the real
// signed ingestion → live view → freshness ageing → purpose-gated history pipeline. Also checks a denied permission.
// It never prints coordinates (they are the tester's real position).
//   CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npx tsx tests/e2e-web/gps-browser.ts
// Limitation: this proves the server pipeline with real data; the field app's own capture (apps/mobile, expo-location)
// still needs a real Android/iOS device.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { addStaff, iso, makeApp, must, planDuty, setupTenant, startBody } from '../helpers.ts';

type Fix = { ok: true; lat: number; lon: number; accuracyM: number; at: number } | { ok: false; code: number; message: string };
const page = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>gps</title>'); });
await new Promise<void>((res) => page.listen(0, '127.0.0.1', res)); // 127.0.0.1 is a secure context, as HTTPS is in production
const url = `http://127.0.0.1:${(page.address() as AddressInfo).port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: process.env.HEADED !== '1' });
const read = async (grant: boolean): Promise<Fix> => {
  const ctx = await browser.newContext(); if (grant) await ctx.grantPermissions(['geolocation'], { origin: url.replace(/\/$/, '') });
  const p = await ctx.newPage(); await p.goto(url);
  const r = await p.evaluate(() => new Promise<Fix>((res) => navigator.geolocation.getCurrentPosition(
    (g) => res({ ok: true, lat: g.coords.latitude, lon: g.coords.longitude, accuracyM: g.coords.accuracy, at: g.timestamp }),
    (e) => res({ ok: false, code: e.code, message: e.message }), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 })));
  await ctx.close(); return r;
};
const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, note?: string) => { results.push([name, ok, note]); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`); };

try {
  const denied = await read(false);
  check('denied permission is reported as an error, never a position', !denied.ok, denied.ok ? 'got a position!' : `code ${denied.code} (1 = PERMISSION_DENIED)`);
  const fix = await read(true);
  if (!fix.ok) { check('real geolocation fix from Chrome', false, `BLOCKED: browser returned error ${fix.code} ${fix.message} (no location provider on this machine?)`); throw new Error('no fix'); }
  check('real geolocation fix from Chrome', Number.isFinite(fix.lat) && Number.isFinite(fix.lon) && Math.abs(fix.lat) <= 90 && Math.abs(fix.lon) <= 180, `accuracy ±${Math.round(fix.accuracyM)} m`);

  const h = await makeApp({}, iso(Date.now())); const t = await setupTenant(h, 'gps');
  const f = await addStaff(t, 'field'); const sup = await addStaff(t, 'supervisor');
  const d = await planDuty(t, f.staffId, { startInMin: 1 }); h.clock.advance(2 * 60000);
  const start = await must(f.client.post(`/assignments/${d.assignmentId}/start`, startBody(h)));
  const recordedAt = iso(Math.min(h.clock.now(), fix.at)); // a real fix taken just now, stamped with its own time
  const ing = await must(f.client.post('/locations/batch', { trackingSessionId: start.trackingSessionId, sentAt: iso(h.clock.now()), points: [{ seq: 0, recordedAt, lat: fix.lat, lon: fix.lon, accuracyM: Math.min(fix.accuracyM, 10000) }] }));
  check('device-signed batch with the real fix is accepted', (ing.accepted ?? ing.acceptedCount ?? 1) >= 1, JSON.stringify({ accepted: ing.accepted, duplicates: ing.duplicates, rejected: ing.rejected }));
  const dup = await must(f.client.post('/locations/batch', { trackingSessionId: start.trackingSessionId, sentAt: iso(h.clock.now()), points: [{ seq: 0, recordedAt, lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM }] }));
  check('replaying the same point is not stored twice', (await h.store.count('location_points', { staffMemberId: f.staffId })) === 1, JSON.stringify({ accepted: dup.accepted, duplicates: dup.duplicates }));

  const live = (await must(sup.client.get('/locations/latest'))).items.find((x: any) => x.staffMemberId === f.staffId);
  check('supervisor live view shows that person at the real position', !!live && Math.abs(live.lat - fix.lat) < 1e-9 && Math.abs(live.lon - fix.lon) < 1e-9, live ? `freshness=${live.freshness}, state=${live.dutyDisplayState}` : 'not listed');
  check('fresh fix is labelled live', live?.freshness === 'live');
  h.clock.advance(15 * 60000);
  const aged = (await must(sup.client.get('/locations/latest'))).items.find((x: any) => x.staffMemberId === f.staffId);
  check('after 15 min without updates it is no longer shown as live', !!aged && aged.freshness !== 'live', `freshness=${aged?.freshness}`);
  const from = iso(h.clock.now() - 3600000), to = iso(h.clock.now());
  const noPurpose = await sup.client.get(`/locations/history?staffMemberId=${f.staffId}&from=${from}&to=${to}`);
  check('history without a purpose is refused', noPurpose.status === 400, `status ${noPurpose.status}`);
  const hist = await must(sup.client.get(`/locations/history?staffMemberId=${f.staffId}&from=${from}&to=${to}&purpose=${encodeURIComponent('GPS pipeline verification')}`));
  check('history with a purpose returns the real point', hist.points?.length === 1 && Math.abs(hist.points[0].lat - fix.lat) < 1e-9);
  const other = await setupTenant(h, 'gps-other');
  const cross = await other.owner.get(`/locations/history?staffMemberId=${f.staffId}&from=${from}&to=${to}&purpose=${encodeURIComponent('cross tenant probe')}`);
  check('another organisation cannot read this location', cross.status === 404 || cross.status === 403, `status ${cross.status}`);
  check('the field officer cannot read the live map', (await f.client.get('/locations/latest')).status === 403);
} catch (e) { if ((e as Error).message !== 'no fix') check('unexpected error', false, (e as Error).message); }
finally { await browser.close(); page.close(); }
const failed = results.filter((r) => !r[1]).length;
console.log(`\ngps check: ${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
