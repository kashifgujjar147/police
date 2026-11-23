// npm run seed:demo — creates the fictional "demo" tenant in the configured store and prints sign-in details.
import { loadConfig } from '@sf/config';
import { createApp } from '../apps/api/src/app.ts';
import { buildDemo } from './lib/demo.ts';
const config = loadConfig();
if (config.env === 'production') { console.error('Refusing to seed demo data in production.'); process.exit(78); }
const app = await createApp({ config: { ...config, runWorkerInProcess: false, logLevel: 'warn', rateLimits: false }, });
const r = await buildDemo(app, { slug: process.env.DEMO_SLUG ?? 'demo', staffCount: process.env.SEED_STAFF ? Number(process.env.SEED_STAFF) : undefined });
await app.store.close();
console.log(`
Demo tenant created (fictional data, flagged as demo).
  Organisation ID : ${r.slug}
  Password (all)  : ${r.owner.password}
  Owner           : owner   ${r.owner.totpSecret ? `(MFA required) — add this TOTP key to an authenticator app: ${r.owner.totpSecret}` : '(simple local mode: no 2FA)'}
${r.users.map((u) => `  ${u.role.padEnd(11)}: ${u.username}${u.role === 'admin' ? '  (MFA enrolment on first sign-in)' : ''}`).join('\n')}
Start the API (npm start) and open ${config.publicUrl}
`);
