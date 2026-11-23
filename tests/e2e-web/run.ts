// Browser end-to-end check of the built web portal against a live API with demo data (Chrome via Playwright).
// npm run build:web && npm run test:e2e:web   (CHROME_PATH overrides the browser binary)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import { testConfig } from '@sf/config';
import { totp } from '@sf/domain/node';
import { MemoryStore } from '@sf/kernel';
import { createApp } from '../../apps/api/src/app.ts';
import { startBackground, startServer } from '../../apps/api/src/server.ts';
import { buildDemo } from '../../scripts/lib/demo.ts';

const shots = 'tests/e2e-web/screenshots'; mkdirSync(shots, { recursive: true });
const app = await createApp({ config: testConfig({ port: 0, host: '127.0.0.1', webDir: 'apps/web/dist', runWorkerInProcess: true, demoMode: true, logLevel: 'silent' }), store: new MemoryStore() });
const demo = await buildDemo(app, { staffCount: 10 });
const server = await startServer(app); const stopBg = startBackground(app); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const exe = process.env.CHROME_PATH ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync'] }); console.log('browser launched');
const results: { step: string; ok: boolean; note?: string }[] = []; const errors: string[] = [];
const dumpErrors = () => errors.slice(0, 5).join(' || ');
const step = async (name: string, fn: () => Promise<void>) => { process.stdout.write(`… ${name}\n`); try { await fn(); results.push({ step: name, ok: true }); } catch (e) { results.push({ step: name, ok: false, note: (e as Error).message.split('\n').slice(0, 3).join(' | ') }); try { await curPage?.screenshot({ path: `${shots}/fail-${results.length}.png` }); } catch { /* ignore */ } } };
let curPage: Page | null = null;

async function signIn(page: Page, user: string, password: string, mfaSecret?: string) {
  await page.goto(base + '/'); await page.getByLabel('Organisation ID').fill(demo.slug); await page.getByLabel('Username or email').fill(user); await page.locator('#f-password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (mfaSecret) { await page.waitForTimeout(1100); await page.getByLabel('Authenticator code').fill(totp(mfaSecret, Date.now() + 31000)); await page.getByRole('button', { name: 'Continue' }).click(); }
  await page.getByRole('navigation', { name: 'Main' }).waitFor({ timeout: 8000 });
}
/** Basic accessibility checks without external tooling: labelled controls, page title, one h1, lang/dir, alt on images. */
async function a11y(page: Page, label: string) {
  const issues = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) { const id = el.id; const lab = id && document.querySelector(`label[for="${id}"]`); if (!lab && !el.getAttribute('aria-label') && !el.closest('label')) out.push(`unlabelled ${el.tagName.toLowerCase()}#${id || '?'}`); }
    for (const b of document.querySelectorAll('button')) if (!(b.textContent ?? '').trim() && !b.getAttribute('aria-label')) out.push('button without a name');
    if (document.querySelectorAll('h1').length !== 1) out.push(`h1 count ${document.querySelectorAll('h1').length}`);
    if (!document.documentElement.lang) out.push('no lang'); for (const i of document.querySelectorAll('img')) if (!i.hasAttribute('alt')) out.push('img without alt');
    return out;
  });
  assert.deepEqual(issues, [], `${label}: ${issues.join(', ')}`);
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } }); ctx.setDefaultTimeout(8000); const page = await ctx.newPage(); curPage = page;
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|tile|status of 401|status of 400/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await step('login page renders and is accessible', async () => { await page.goto(base + '/'); await page.getByRole('heading', { name: 'SmartForce 360' }).waitFor(); await a11y(page, 'login'); });
  await step('wrong password shows the neutral error', async () => { await page.getByLabel('Organisation ID').fill('demo'); await page.getByLabel('Username or email').fill('cmd-01'); await page.locator('#f-password').fill('wrong-password-x'); await page.getByRole('button', { name: 'Sign in' }).click(); await page.getByText('The sign-in details are not correct.').waitFor(); });
  await step('commander signs in; overview shows live counters and demo banner', async () => {
    await signIn(page, 'cmd-01', demo.owner.password); await page.getByRole('heading', { name: 'Overview' }).waitFor(); await page.getByText('DEMO DATA').waitFor();
    const onDuty = await page.locator('.kpi', { hasText: 'On duty' }).locator('b').innerText(); assert.ok(Number(onDuty) >= 3, `on duty ${onDuty}`); await a11y(page, 'overview'); await page.screenshot({ path: `${shots}/01-overview.png` });
  });
  await step('SOS banner is shown and opens the incident', async () => { await page.locator('.banner.sos').waitFor(); await page.locator('.banner.sos button').click(); await page.getByText('SOS delivery').waitFor(); await page.screenshot({ path: `${shots}/02-sos-incident.png` }); });
  await step('command centre lists people with state and freshness; stale person is not shown as on duty', async () => {
    await page.getByRole('link', { name: 'Command centre' }).click(); await page.getByRole('heading', { name: 'Command centre' }).waitFor(); await page.locator('.person').first().waitFor();
    const txt = await page.locator('.list').innerText(); assert.match(txt, /On duty/); assert.match(txt, /SOS/); assert.match(txt, /No recent signal|Stale/);
    await page.locator('.map svg circle').first().waitFor(); await a11y(page, 'command'); await page.screenshot({ path: `${shots}/03-command-centre.png` });
    await page.getByRole('button', { name: 'List', exact: true }).click(); await page.locator('table').waitFor(); await page.screenshot({ path: `${shots}/04-command-list.png` });
  });
  await step('location history requires a purpose and shows points', async () => {
    await page.getByRole('button', { name: 'Map', exact: true }).click(); await page.locator('.person').nth(2).click(); await page.getByRole('button', { name: 'Location history' }).click();
    await page.getByRole('button', { name: 'View' }).click(); await page.getByText('Purpose of access is required').or(page.locator('.err')).first().waitFor();
    await page.getByLabel('Purpose of access').fill('E2E test: reviewing patrol coverage'); await page.getByRole('button', { name: 'View' }).click(); await page.getByText('Gaps mean no data').waitFor(); await page.keyboard.press('Escape');
  });
  await step('alerts list shows the late start and the SOS; acknowledging updates state', async () => {
    await page.getByRole('link', { name: 'Alerts' }).click(); await page.locator('tbody tr').first().waitFor(); const t = await page.locator('tbody').innerText(); assert.match(t, /Late start/); assert.match(t, /SOS/);
    await page.locator('tbody tr', { hasText: 'Late start' }).first().click(); await page.getByRole('button', { name: 'Acknowledge' }).click(); await page.locator('.card .chip', { hasText: 'Acknowledged' }).first().waitFor(); await page.screenshot({ path: `${shots}/05-alerts.png` });
  });
  await step('duty planner shows today\'s published assignments with acknowledgement state', async () => { await page.getByRole('link', { name: 'Duty planner' }).click(); await page.getByRole('heading', { name: 'Duty planner' }).waitFor(); await page.locator('tbody tr', { hasText: 'Published' }).first().waitFor(); assert.match(await page.locator('tbody').innerText(), /Published/); await a11y(page, 'planner'); await page.screenshot({ path: `${shots}/06-planner.png` }); });
  await step('report runs with as-of, timezone and basis labels', async () => {
    await page.getByRole('link', { name: 'Reports' }).click(); await page.getByLabel('Choose a report').selectOption('attendance'); await page.getByRole('button', { name: 'Run report' }).click();
    await page.getByText(/Attendance · \d+ rows/).waitFor(); assert.match(await page.locator('main').innerText(), /Times shown in Asia\/Karachi/); await page.screenshot({ path: `${shots}/07-report.png` });
  });
  await step('Arabic switches the whole interface to right-to-left', async () => {
    await page.locator('#lang2').selectOption('ar'); await page.getByRole('link', { name: 'مركز القيادة' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl'); assert.equal(await page.evaluate(() => document.documentElement.lang), 'ar');
    const navX = await page.locator('nav.nav').boundingBox(); assert.ok(navX!.x > 600, 'navigation is on the right in RTL'); await page.screenshot({ path: `${shots}/08-overview-ar.png` });
    await page.getByRole('link', { name: 'مركز القيادة' }).click(); await page.locator('.person').first().waitFor(); await page.screenshot({ path: `${shots}/09-command-ar.png` }); await page.locator('#lang2').selectOption('en');
  });
  await step('field officer sees no command centre (permission-aware navigation)', async () => {
    const c2 = await browser.newContext(); c2.setDefaultTimeout(8000); const p2 = await c2.newPage(); await signIn(p2, 'fo-001', demo.owner.password);
    const nav = await p2.locator('nav.nav').innerText(); assert.ok(!/Command centre|Audit log|Staff/.test(nav), nav); assert.match(nav, /My data/); await p2.screenshot({ path: `${shots}/10-field-web.png` }); await p2.close();
  });
  await step('owner signs in with MFA; audit integrity verifies; staff activation code is shown once', async () => {
    const c3 = await browser.newContext({ viewport: { width: 1366, height: 860 } }); c3.setDefaultTimeout(8000); const p3 = await c3.newPage(); p3.on('pageerror', (e) => errors.push(`pageerror(owner): ${e.message}`));
    await signIn(p3, 'owner', demo.owner.password, demo.owner.totpSecret);
    await p3.getByRole('link', { name: 'Audit log' }).click(); await p3.getByRole('button', { name: 'Verify integrity' }).click(); await p3.getByText(/Audit chain verified: \d+ records/).waitFor(); await p3.screenshot({ path: `${shots}/11-audit.png` });
    await p3.getByRole('link', { name: 'Staff', exact: true }).click(); await p3.getByRole('button', { name: 'Add staff member' }).click();
    await p3.getByLabel('Employee code').fill('E2E-777'); await p3.getByLabel('Full name').fill('E2E Created Officer'); await p3.getByLabel('Home unit').selectOption({ index: 1 }); await p3.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await p3.getByRole('heading', { name: 'E2E Created Officer' }).waitFor(); await p3.getByRole('button', { name: 'Issue activation code' }).click(); await p3.getByTestId('secret').waitFor(); assert.match(await p3.getByTestId('secret').innerText(), /^[A-Z2-9-]{20,}$/);
    await p3.screenshot({ path: `${shots}/12-activation-code.png` }); await p3.getByRole('button', { name: 'Close' }).last().click();
    await p3.getByRole('link', { name: 'Settings' }).click(); await p3.getByLabel('Late start flagged after (min)').fill('45'); await p3.getByRole('button', { name: 'Save' }).click(); await p3.getByText('Saved as version 2').waitFor(); await p3.screenshot({ path: `${shots}/13-settings.png` });
    await p3.close();
  });
  await step('help page offers support contact and a secret-free diagnostics bundle', async () => { await page.getByRole('link', { name: 'Help & support' }).click(); const pre = await page.locator('pre').first().innerText(); assert.match(pre, /"tenant": "demo"/); assert.ok(!/eyJ|password|token"/i.test(pre)); await a11y(page, 'help'); });
  await step('narrow (mobile) viewport keeps the portal usable', async () => { await page.setViewportSize({ width: 390, height: 820 }); await page.getByRole('link', { name: 'Overview' }).click(); await page.getByRole('heading', { name: 'Overview' }).waitFor(); await page.screenshot({ path: `${shots}/14-narrow.png` }); });
  await step('no uncaught page errors or console errors', async () => { assert.equal(errors.length, 0, dumpErrors()); });
} finally { await browser.close(); stopBg(); server.closeAllConnections(); server.close(); }
for (const r of results) console.log(`${r.ok ? 'ok    ' : 'FAIL  '} ${r.step}${r.note ? ` — ${r.note}` : ''}`);
console.log(`\nweb e2e: ${results.filter((r) => r.ok).length}/${results.length} passed; screenshots in ${shots}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
