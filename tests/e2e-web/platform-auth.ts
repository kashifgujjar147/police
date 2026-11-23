// Browser check of the Platform sign-in page: validation messages, password eye toggle, Create account with the one-time
// setup code, sign-in with MFA enrolment, dashboard, logout, sign-in again. Built portal + live API (memory store).
//   npm run build:web && CHROME_PATH=... npx tsx tests/e2e-web/platform-auth.ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { testConfig } from '@sf/config';
import { totp } from '@sf/domain/node';
import { MemoryStore } from '@sf/kernel';
import { createApp } from '../../apps/api/src/app.ts';
import { startServer } from '../../apps/api/src/server.ts';
import { ensurePlatformSetupToken, platformSetupTokenPath } from '../../modules/tenancy/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'sf-plat-e2e-'));
const app = await createApp({ config: testConfig({ port: 0, host: '127.0.0.1', webDir: 'apps/web/dist', runWorkerInProcess: false, logLevel: 'silent', dataDir: dir }), store: new MemoryStore() });
await ensurePlatformSetupToken(app); const setupCode = readFileSync(platformSetupTokenPath(app), 'utf8').trim();
const server = await startServer(app); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage(); const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/401|403|400|409/.test(m.text())) errors.push(m.text()); });
const results: [string, boolean, string?][] = [];
const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); results.push([name, true]); console.log(`ok    ${name}`); } catch (e) { results.push([name, false, (e as Error).message.split('\n')[0]]); console.log(`FAIL  ${name} — ${(e as Error).message.split('\n')[0]}`); await page.screenshot({ path: `tests/e2e-web/screenshots/platform-fail-${results.length}.png` }).catch(() => {}); } };
const fieldErr = (p: Page, name: string) => p.locator(`#f-${name}-e`);
const EMAIL = 'admin@smartforce360.com', PW = 'Browser-Test-Platform-77';

await step('platform sign-in page opens', async () => { await page.goto(`${base}/#/platform`); await page.locator('form button[type=submit]').waitFor(); assert.ok(await page.getByText('Platform staff sign-in').isVisible()); });
await step('empty submit shows both field messages beside the fields', async () => {
  await page.locator('form button[type=submit]').click();
  assert.equal(await fieldErr(page, 'email').textContent(), 'Please enter your email address.'); assert.equal(await fieldErr(page, 'password').textContent(), 'Please enter your password.');
  assert.equal(await page.locator('#f-email').getAttribute('aria-invalid'), 'true');
});
await step('invalid email format is caught in the browser', async () => { await page.locator('#f-email').fill('not-an-email'); await page.locator('form button[type=submit]').click(); assert.equal(await fieldErr(page, 'email').textContent(), 'Please enter a valid email address.'); });
await step('password eye toggle shows/hides without changing the value, keyboard accessible', async () => {
  const pw = page.locator('#f-password'); await pw.fill('Secret-Value-123'); assert.equal(await pw.getAttribute('type'), 'password');
  const eye = page.getByRole('button', { name: 'Show password' }); assert.equal(await eye.getAttribute('aria-pressed'), 'false');
  await eye.focus(); await page.keyboard.press('Enter'); assert.equal(await pw.getAttribute('type'), 'text'); assert.equal(await pw.inputValue(), 'Secret-Value-123');
  const hide = page.getByRole('button', { name: 'Hide password' }); assert.equal(await hide.getAttribute('aria-pressed'), 'true');
  await hide.click(); assert.equal(await pw.getAttribute('type'), 'password'); assert.equal(await pw.inputValue(), 'Secret-Value-123');
});
await step('wrong credentials show the generic message (no account enumeration)', async () => {
  await page.locator('#f-email').fill('nobody@smartforce360.com'); await page.locator('#f-password').fill('Wrong-Password-000'); await page.locator('form button[type=submit]').click();
  await page.getByRole('alert').filter({ hasText: 'The email or password is incorrect.' }).waitFor({ timeout: 5000 });
});
await step('Create account: validation, password mismatch, wrong code refused', async () => {
  await page.getByRole('button', { name: 'Create account' }).click(); await page.locator('#f-code').waitFor();
  await page.locator('form button[type=submit]').click();
  assert.equal(await fieldErr(page, 'code').textContent(), 'Please enter the setup or invitation code.'); assert.equal(await fieldErr(page, 'email').textContent(), 'Please enter your email address.');
  await page.locator('#f-code').fill('wrong-code-wrong-code'); await page.locator('#f-email').fill(EMAIL); await page.locator('#f-password').fill(PW); await page.locator('#f-confirm').fill(PW + 'x');
  await page.locator('form button[type=submit]').click(); assert.equal(await fieldErr(page, 'confirm').textContent(), 'The passwords do not match.');
  assert.equal(await page.getByRole('button', { name: 'Show password' }).count(), 2, 'eye toggle on both password fields');
  await page.locator('#f-confirm').fill(PW); await page.locator('form button[type=submit]').click();
  await page.getByRole('alert').filter({ hasText: 'not valid or has expired' }).waitFor({ timeout: 5000 });
});
await step('Create account with the one-time setup code, then back on sign-in with email prefilled', async () => {
  await page.locator('#f-code').fill(setupCode); await page.locator('form button[type=submit]').click();
  await page.getByText('Account created. Sign in to set up your authenticator app.').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#f-email').inputValue(), EMAIL);
});
let secret = '';
await step('sign in → MFA enrolment → authenticator code → Platform dashboard', async () => {
  await page.locator('#f-password').fill(PW); await page.locator('form button[type=submit]').click();
  await page.getByLabel('Authenticator code').waitFor({ timeout: 5000 });
  secret = (await page.locator('.secret').first().textContent())?.replace(/\s/g, '') ?? ''; // read from the page, as a user would
  assert.match(secret, /^[A-Z2-7]{16,}$/, 'TOTP secret shown for the authenticator app');
  await page.getByLabel('Authenticator code').fill('000000'); await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('alert').filter({ hasText: 'authenticator code is not correct' }).waitFor({ timeout: 5000 });
  await page.getByLabel('Authenticator code').fill(totp(secret, Date.now())); await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Platform console' }).waitFor({ timeout: 8000 });
  assert.ok(await page.getByRole('button', { name: 'Invite Super Admin' }).isVisible(), 'invite action available to Super Admin');
});
await step('invite Super Admin shows a one-time code', async () => {
  await page.getByRole('button', { name: 'Invite Super Admin' }).click(); await page.locator('#f-email').fill('second.admin@smartforce360.com'); await page.getByRole('button', { name: 'Create' }).click();
  await page.getByText('Invitation code').first().waitFor({ timeout: 5000 }); await page.getByRole('button', { name: 'Close' }).last().click();
});
await step('sign out, then sign in again with the enrolled authenticator', async () => {
  await page.getByRole('button', { name: /Sign out|Log out/i }).first().click(); await page.getByText('Platform staff sign-in').waitFor({ timeout: 5000 }); // lands on the platform sign-in, no extra click
  await page.locator('#f-email').fill(EMAIL); await page.locator('#f-password').fill(PW); await page.locator('form button[type=submit]').click();
  await page.getByLabel('Authenticator code').waitFor({ timeout: 5000 }); await new Promise((r) => setTimeout(r, 31000)); // next TOTP step (codes are single-use)
  await page.getByLabel('Authenticator code').fill(totp(secret, Date.now())); await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Platform console' }).waitFor({ timeout: 8000 });
});
await step('no uncaught page errors', async () => { assert.deepEqual(errors, [], errors.join(' || ')); });
await page.screenshot({ path: 'tests/e2e-web/screenshots/platform-dashboard.png' });
await browser.close(); server.close(); rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r[1]).length; console.log(`\nplatform auth e2e: ${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
