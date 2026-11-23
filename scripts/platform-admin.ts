// npm run platform:admin -- [--email admin@example.com] [--check]
// Creates a Platform Super Admin in the CONFIGURED store (the same one `npm start` uses), with a cryptographically random
// password shown once on this terminal. Never creates a duplicate: an existing account is only reported. The password is
// hashed with the app's configured hasher, never stored or logged in plain text. MFA set-up is required at first sign-in.
import { randomInt } from 'node:crypto';
import { loadConfig } from '@sf/config';
import { createApp } from '../apps/api/src/app.ts';
import { ensurePlatformSetupToken } from '../modules/tenancy/index.ts';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const email = (arg('email') ?? 'admin@smartforce360.com').trim().toLowerCase(); const checkOnly = process.argv.includes('--check');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { console.error('Please enter a valid email address.'); process.exit(64); }
const config = loadConfig();

// The file store keeps all data in memory and rewrites the file on every change: a running server would never see this
// account and would overwrite it. Refuse while one is answering on the configured port.
if (config.store === 'file') {
  const running = await fetch(`http://127.0.0.1:${config.port}/health/live`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  if (running) { console.error(`A server is running on port ${config.port} with the file store (${config.dataDir}). Stop it first, run this again, then start the server.`); process.exit(75); }
}

function strongPassword(len = 24) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#%^*-_=+'];
  const all = sets.join(''); const chars = sets.map((s) => s[randomInt(s.length)]!);
  while (chars.length < len) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j]!, chars[i]!]; }
  return chars.join('');
}

const app = await createApp({ config: { ...config, runWorkerInProcess: false, logLevel: 'error' } });
const where = config.store === 'mongo' ? `MongoDB database "${config.mongoDb}"` : config.store === 'file' ? `file store ${config.dataDir}/smartforce360.db.json` : 'in-memory store (NOT persistent)';
try {
  const existing = await app.store.findOne('platform_users', { email });
  if (existing) {
    console.log(`Account already exists in ${where} — nothing created (no duplicates).`);
    console.log(`  email: ${existing.email}\n  status: ${existing.status}\n  roles: ${(existing.platformRoles as string[]).join(', ')}\n  MFA set up: ${existing.mfa?.verifiedAt ? 'yes' : 'no (required at next sign-in)'}`);
  } else if (checkOnly) {
    console.log(`No platform account with ${email} in ${where}.`);
  } else {
    const password = strongPassword();
    const passwordHash = await app.hasher.hash(password);
    const user = await app.store.insert('platform_users', { email, passwordHash, platformRoles: ['super_admin'], status: 'active', mfa: null, failedLogins: 0, createdAt: app.clock.now(), createdVia: 'cli' });
    const stored = (await app.store.findOne('platform_users', { _id: user._id }))!;
    const verifies = await app.hasher.verify(password, stored.passwordHash), rejectsWrong = !(await app.hasher.verify(`${password}x`, stored.passwordHash));
    await ensurePlatformSetupToken(app); // removes the first-run setup code now that a Super Admin exists
    if (!verifies || !rejectsWrong) throw new Error('password hash verification failed — account not usable');
    console.log(`\nPlatform Super Admin created in ${where}`);
    console.log(`  email:    ${email}\n  role:     super_admin\n  status:   active\n  hash:     ${config.passwordAlgo} — verified with the app's hasher (correct password accepted, wrong one rejected)`);
    console.log(`\n  PASSWORD (shown once, not stored anywhere):  ${password}`);
    console.log('  Put it in your password manager now. At first sign-in you will set up an authenticator app (MFA).\n');
  }
} finally { await app.store.close(); }
process.exit(0);
