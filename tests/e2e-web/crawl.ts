// Crawler (ROLE=owner|cmd-01|sup-01|dsp-01|aud-01|fo-001|platform, CHROME_PATH=...): drives every page/tab/action dialog of the built portal against a live API with demo data; reports errors.
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import { testConfig } from '@sf/config';
import { MemoryStore } from '@sf/kernel';
import { createApp } from '../../apps/api/src/app.ts';
import { startBackground, startServer } from '../../apps/api/src/server.ts';
import { buildDemo } from '../../scripts/lib/demo.ts';

const ROLE = process.env.ROLE ?? 'owner'; const ONLY = process.env.ONLY;
const app = await createApp({ config: testConfig({ env: 'development', mfaDevBypass: true, port: 0, host: '127.0.0.1', webDir: 'apps/web/dist', runWorkerInProcess: true, demoMode: true, logLevel: 'silent', bootstrap: { email: 'root@crawl.example', password: 'Crawl-Platform-Pass-2026' } }), store: new MemoryStore() });
const demo = await buildDemo(app, { staffCount: 10 });
const server = await startServer(app); const stopBg = startBackground(app); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } }); ctx.setDefaultTimeout(4000); const page = await ctx.newPage();
let where = 'login'; const issues: string[] = []; let n = 0;
page.on('pageerror', (e) => issues.push(`[${where}] PAGEERROR ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/status of (4\d\d)/.test(m.text())) issues.push(`[${where}] CONSOLE ${m.text().slice(0, 200)}`); });
page.on('response', async (r) => { if (!r.url().includes('/api/v1/') || r.status() < 400) return; let b = ''; try { const j = await r.json(); b = `${j.error?.code}: ${j.error?.message}${j.error?.fieldErrors?.length ? ' ' + JSON.stringify(j.error.fieldErrors.map((f: any) => `${f.path}:${f.code}`)) : ''}`; } catch { /* */ }
  issues.push(`[${where}] HTTP ${r.status()} ${r.request().method()} ${r.url().split('/api/v1')[1]} → ${b}`); });

async function fill(p: Page, scope: string) {
  const today = new Date().toISOString().slice(0, 10);
  for (const el of await p.locator(`${scope} input, ${scope} select, ${scope} textarea`).all()) {
    if (!(await el.isVisible())) continue; const tag = await el.evaluate((e) => e.tagName.toLowerCase()); const type = (await el.getAttribute('type')) ?? 'text'; const name = (await el.getAttribute('name')) ?? ''; n++;
    try {
      if (tag === 'select') { const opts = await el.locator('option').all(); if (opts.length > 1) await el.selectOption({ index: 1 }); continue; }
      if (type === 'checkbox' || type === 'file' || type === 'hidden') continue;
      if ((await el.inputValue()) !== '') continue;
      const v = tag === 'textarea' ? 'Crawler test text for this field' : type === 'email' ? `crawl${n}@example.com` : type === 'password' ? 'Crawl-Password-2026' : type === 'number' ? '5' : type === 'date' ? today : type === 'time' ? '09:00' : type === 'datetime-local' ? `${today}T09:00`
        : /lat/i.test(name) ? '24.8607' : /lon|lng/i.test(name) ? '67.0011' : /slug|code|username/i.test(name) ? `crawl${n}` : /timezone/i.test(name) ? 'Asia/Karachi' : /radius/i.test(name) ? '150' : /phone/i.test(name) ? '+92 300 1234567' : `Crawl ${name} ${n}`;
      await el.fill(v);
    } catch { /* skip */ }
  }
}
async function tryDialogs(p: Page, path: string) {
  const acts = await p.locator('.page-head .row button').all(); const labels: string[] = [];
  for (const b of acts) labels.push((await b.innerText()).trim());
  for (const label of labels) {
    where = `${path} › ${label}`;
    const b = p.locator('.page-head .row button', { hasText: label }).first(); if (!(await b.isVisible().catch(() => false)) || !(await b.isEnabled().catch(() => false))) continue;
    await b.click().catch(() => {}); await p.waitForTimeout(400);
    const dlg = p.locator('[role=dialog]').last();
    await handleDialog(p);
    await p.goto(`${base}/#${path}`); await p.waitForTimeout(500);
  }
}
const outcomes: string[] = [];
async function tryDetail(p: Page, path: string) {
  // click the first data row (many pages open a detail panel), then try each new action button in the main area
  await p.goto(`${base}/#${path}`); await p.waitForTimeout(700);
  const before = new Set(await p.locator('main button, #main button').allInnerTexts().catch(() => []));
  const cell = p.locator('table tbody tr').first().locator('td').first(); if (!(await cell.isVisible().catch(() => false))) return;
  where = `${path} › select row`; await cell.click().catch(() => {}); await p.waitForTimeout(800);
  const after = (await p.locator('main button, #main button').allInnerTexts().catch(() => [])).map((x) => x.trim());
  const fresh = [...new Set(after.filter((x) => x && !before.has(x) && !/^(Sign out|English|×|Close)$/i.test(x)))].slice(0, 10);
  if (fresh.length) outcomes.push(`${path} › detail buttons: ${fresh.join(', ')}`);
  for (const label of fresh) {
    where = `${path} › detail › ${label}`;
    await p.goto(`${base}/#${path}`); await p.waitForTimeout(600); await p.locator('table tbody tr').first().locator('td').first().click().catch(() => {}); await p.waitForTimeout(700);
    const b = p.locator('main button, #main button', { hasText: label }).first(); if (!(await b.isVisible().catch(() => false))) continue;
    await b.click().catch(() => {}); await p.waitForTimeout(700); await handleDialog(p);
  }
}
async function handleDialog(p: Page) {
  const dlg = p.locator('[role=dialog]').last();
  if (!(await dlg.isVisible().catch(() => false))) return;
  await fill(p, '[role=dialog]'); const submit = (await dlg.locator('button[type=submit]').count()) ? dlg.locator('button[type=submit]').first() : dlg.locator('button.primary, button.danger').last();
  let result = 'no-submit';
  if (await submit.isVisible().catch(() => false)) { await submit.click().catch(() => {}); await p.waitForTimeout(1000);
    const left = p.locator('[role=dialog]'); const err = (await left.count()) ? await left.last().locator('.notice.danger, .err').allInnerTexts().catch(() => []) : [];
    result = err.length ? `ERROR: ${err.join(' | ').slice(0, 200)}` : (await left.count()) ? 'submitted (dialog shows result)' : 'submitted & closed'; }
  outcomes.push(`${where}: ${result}`);
  for (let i = 0; i < 3 && (await p.locator('[role=dialog]').count()); i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(150); }
}
async function tryRowActions(p: Page, path: string) {
  // select first row (opens detail panels on many pages), then try every link-button in the first row and in the detail panel
  const row = p.locator('table tbody tr').first(); if (!(await row.isVisible().catch(() => false))) return;
  const rowBtns = await row.locator('button').allInnerTexts();
  for (const label of rowBtns.map((x) => x.trim()).filter(Boolean)) {
    where = `${path} › row › ${label}`;
    const b = p.locator('table tbody tr').first().locator('button', { hasText: label }).first(); if (!(await b.isVisible().catch(() => false))) continue;
    await b.click().catch(() => {}); await p.waitForTimeout(600); await handleDialog(p);
    // detail panel actions (aside / .panel / .detail)
    const panelBtns = await p.locator('aside button, .panel button, .detail button').allInnerTexts().catch(() => []);
    for (const pl of panelBtns.map((x) => x.trim()).filter((x) => x && !/close|×/i.test(x)).slice(0, 8)) {
      where = `${path} › row › ${label} › ${pl}`; const pb = p.locator('aside button, .panel button, .detail button', { hasText: pl }).first();
      if (!(await pb.isVisible().catch(() => false))) continue; await pb.click().catch(() => {}); await p.waitForTimeout(600); await handleDialog(p);
    }
    await p.goto(`${base}/#${path}`); await p.waitForTimeout(600);
  }
}

where = 'login';
if (ROLE === 'platform') {
  await page.goto(`${base}/#/platform`); await page.locator('#f-email').fill('root@crawl.example'); await page.locator('#f-password').fill('Crawl-Platform-Pass-2026'); await page.locator('form button[type=submit]').click();
  await page.getByRole('heading', { name: 'Platform console' }).waitFor({ timeout: 8000 }); where = '/platform'; console.log('platform console opened');
  const tabs = await page.locator('[role=tab]').allInnerTexts(); console.log('tabs', tabs);
  await tryDialogs(page, '/'); await tryRowActions(page, '/');
  console.log('=== dialog outcomes ==='); for (const o of outcomes) console.log(o); console.log(`=== ${issues.length} issues ===`); for (const i of [...new Set(issues)]) console.log(i);
  await browser.close(); stopBg(); server.close(); process.exit(0);
}
await page.goto(`${base}/#/login`); await page.locator('#f-tenant').fill('demo'); await page.locator('#f-identifier').fill(ROLE); await page.locator('#f-password').fill(demo.owner.password);
await page.locator('form button[type=submit]').click(); await page.getByRole('navigation', { name: 'Main' }).waitFor({ timeout: 8000 });
const paths = await page.locator('nav[aria-label=Main] a').evaluateAll((as) => as.map((a) => (a.getAttribute('href') ?? '').replace(/^#/, '')));
console.log(`role ${ROLE}: ${paths.length} pages: ${paths.join(' ')}`);
for (const path of paths) {
  if (ONLY && !path.includes(ONLY)) continue;
  where = path; await page.goto(`${base}/#${path}`); await page.waitForTimeout(900);
  const h1 = await page.locator('h1').first().innerText().catch(() => '(no h1)'); const text = await page.locator('main, #main, body').first().innerText().catch(() => '');
  if (/Something went wrong|Request failed|cannot read/i.test(text)) issues.push(`[${path}] PAGE TEXT shows error: ${text.match(/.{0,80}(Something went wrong|Request failed|cannot read).{0,80}/i)?.[0]}`);
  const tabs = await page.locator('[role=tab]').all(); const tabNames: string[] = []; for (const t of tabs) tabNames.push((await t.innerText()).trim());
  for (const tn of tabNames) { where = `${path} tab ${tn}`; await page.locator('[role=tab]', { hasText: tn }).first().click().catch(() => {}); await page.waitForTimeout(500); }
  console.log(`  ${path.padEnd(16)} h1="${h1}" tabs=[${tabNames.join(', ')}]`);
  await tryDialogs(page, path); await tryRowActions(page, path); await tryDetail(page, path);
}
console.log('\n=== dialog outcomes ==='); for (const o of outcomes) console.log(o);
console.log(`\n=== ${issues.length} issues ===`); for (const i of [...new Set(issues)]) console.log(i);
await browser.close(); stopBg(); server.close(); process.exit(0);
