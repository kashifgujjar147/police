// Browser check of the installable PWA and field "My duty": service worker + manifest, device set-up (WebCrypto Ed25519),
// privacy notice, start duty, location sharing reaches the server, break, SOS, end duty. Real clock, built portal, live API.
// Uses a TEST geolocation (Playwright) — not anyone's real position.   CHROME_PATH=... npx tsx tests/e2e-web/pwa-field.ts
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { testConfig } from '@sf/config';
import { MemoryStore } from '@sf/kernel';
import { createApp } from '../../apps/api/src/app.ts';
import { startServer } from '../../apps/api/src/server.ts';
import { PASSWORD, addStaff, planDuty, setupTenant, type Harness } from '../helpers.ts';

const store = new MemoryStore(); const config = testConfig({ webDir: 'apps/web/dist', port: 0, host: '127.0.0.1', runWorkerInProcess: false, logLevel: 'silent' });
const app = await createApp({ config, store }); const h = { app, store, clock: { now: () => Date.now() } as never, logs: [], config } as Harness;
const t = await setupTenant(h, 'acme'); const f = await addStaff(t, 'field', { device: false }); const d = await planDuty(t, f.staffId, { startInMin: 1 });
const server = await startServer(app); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, permissions: ['geolocation'], geolocation: { latitude: 24.8607, longitude: 67.0011, accuracy: 15 } });
ctx.setDefaultTimeout(10000); const page = await ctx.newPage(); const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
const results: [string, boolean, string?][] = [];
const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); results.push([name, true]); console.log(`ok    ${name}`); } catch (e) { results.push([name, false]); console.log(`FAIL  ${name} — ${(e as Error).message.split('\n')[0]}`); await page.screenshot({ path: `tests/e2e-web/screenshots/pwa-fail-${results.length}.png` }).catch(() => {}); } };

await step('manifest is valid and icons load', async () => {
  const m = await (await fetch(`${base}/manifest.webmanifest`)).json(); assert.equal(m.display, 'standalone'); assert.equal(m.start_url, '/');
  for (const i of m.icons) assert.equal((await fetch(base + i.src)).status, 200, i.src);
  assert.equal((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
});
await step('service worker registers and controls the page', async () => {
  await page.goto(`${base}/#/login`); await page.waitForFunction(() => navigator.serviceWorker?.controller !== undefined);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope); assert.equal(scope, `${base}/`);
  assert.equal(await page.locator('link[rel=manifest]').count(), 1);
});
await step('field officer signs in and lands on My duty', async () => {
  await page.reload(); await page.locator('#f-tenant').fill('acme'); await page.locator('#f-identifier').fill(f.code.toLowerCase()); await page.locator('#f-password').fill(PASSWORD);
  await page.locator('form button[type=submit]').click(); await page.getByRole('heading', { name: 'My duty' }).waitFor();
});
await step('accept the privacy notice (app-wide gate, fits a phone screen)', async () => {
  const dlg = page.getByRole('dialog'); await dlg.waitFor(); const box = (await dlg.boundingBox())!; assert.ok(box.x >= 0 && box.x + box.width <= 412 + 1, `dialog fits the screen (${Math.round(box.x)}..${Math.round(box.x + box.width)})`);
  await dlg.locator('button.primary').click(); await dlg.waitFor({ state: 'detached' });
});
await step('set up this device (WebCrypto key, non-extractable)', async () => {
  await page.getByRole('button', { name: 'Set up this device' }).click(); await page.getByText('This device is ready for duty.').waitFor();
  const dev = (await store.find('devices', { staffMemberId: f.staffId }))[0]; assert.equal(dev?.platform, 'web'); assert.equal(dev?.status, 'active');
  const extractable = await page.evaluate(() => new Promise<boolean>((res) => { const o = indexedDB.open('sf360-device'); o.onsuccess = () => { const r = o.result.transaction('keys').objectStore('keys').getAll(); r.onsuccess = () => res((r.result[0] as any).privateKey.extractable); }; }));
  assert.equal(extractable, false, 'private key cannot be exported');
});
await step('start duty → location sharing is on', async () => {
  await page.getByRole('button', { name: 'Start duty' }).click(); await page.getByRole('button', { name: 'End duty' }).waitFor(); await page.getByText('Sharing location').waitFor({ timeout: 15000 });
  assert.equal((await store.find('duty_assignments', { _id: d.assignmentId }))[0]?.status, 'started');
});
await step('location points reach the server (within the 30 s send interval)', async () => {
  const deadline = Date.now() + 45000; let n = 0; while (Date.now() < deadline && !(n = await store.count('location_points', { staffMemberId: f.staffId }))) await page.waitForTimeout(1000);
  assert.ok(n >= 1, 'points stored'); const pt = (await store.find('location_points', { staffMemberId: f.staffId }))[0]!; assert.ok(Math.abs(pt.lat - 24.8607) < 1e-6 && Math.abs(pt.lon - 67.0011) < 1e-6);
  await page.getByText(/last sent/).waitFor();
});
await step('break start and end', async () => {
  await page.getByRole('button', { name: 'Start break' }).click(); await page.getByRole('button', { name: 'End break' }).waitFor();
  await page.getByRole('button', { name: 'End break' }).click(); await page.getByRole('button', { name: 'Start break' }).waitFor();
});
await step('SOS asks for confirmation, then reaches the server', async () => {
  await page.getByRole('button', { name: 'SOS', exact: true }).click(); await page.getByRole('button', { name: 'Send SOS now' }).click();
  await page.getByText('SOS sent.').waitFor(); assert.equal(await store.count('sos_events', { staffMemberId: f.staffId }), 1);
});
await step('end duty → sharing stops', async () => { await page.getByRole('button', { name: 'End duty' }).click(); await page.getByText('Sharing location').waitFor({ state: 'detached', timeout: 15000 }); const st = (await store.find('duty_assignments', { _id: d.assignmentId }))[0]?.status; const shown = await page.locator('.notice').allInnerTexts(); assert.equal(st, 'ended', `status ${st}; page: ${shown.join(' | ')}`); });
await step('opens without internet (app shell from the service worker); no data is cached', async () => {
  await ctx.setOffline(true); await page.reload(); await page.locator('#root *').first().waitFor();
  const cached = await page.evaluate(async () => { const out: string[] = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname); return out; });
  assert.ok(cached.includes('/app.js')); assert.ok(!cached.some((u) => u.startsWith('/api/')), `no API data cached: ${cached.join(',')}`); await ctx.setOffline(false);
});
await step('no page errors', async () => { assert.deepEqual(errors, []); });
await page.screenshot({ path: 'tests/e2e-web/screenshots/pwa-my-duty.png', fullPage: true });
await browser.close(); server.close();
const failed = results.filter((r) => !r[1]).length; console.log(`\npwa field e2e: ${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
