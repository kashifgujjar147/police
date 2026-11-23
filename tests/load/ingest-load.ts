// Load test (in-process, memory store): location ingestion throughput and command-centre query latency (FR-NFR-003, FR-LOC-008).
// This measures the application code path, not network, TLS or MongoDB. Production capacity must be re-measured against the
// real deployment (docs/runbooks/load-test.md). Usage: npm run load [-- --staff 300 --batches 3000]
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { testConfig } from '@sf/config';
import { totp } from '@sf/domain/node';
import { type App, MemoryStore, deviceSigningString } from '@sf/kernel';
import { createApp } from '../../apps/api/src/app.ts';
import { provisionTenant } from '../../modules/tenancy/provision.ts';

const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const STAFF = arg('staff', 300), BATCHES = arg('batches', 3000), MAPSTATES = arg('states', 1000);
const app: App = await createApp({ config: testConfig({ logLevel: 'silent', runWorkerInProcess: false }), store: new MemoryStore() });
const call = async (m: string, p: string, body: unknown, token?: string, key?: any) => {
  const raw = JSON.stringify(body ?? {}); const h: Record<string, string> = {}; if (token) h.authorization = `Bearer ${token}`;
  if (key) { const ts = new Date().toISOString(); h['x-device-timestamp'] = ts; h['x-device-signature'] = sign(null, Buffer.from(deviceSigningString(m, `/api/v1${p.split('?')[0]}`, m === 'GET' ? '' : raw, ts)), key).toString('base64'); }
  const [pp, q] = p.split('?'); const t0 = performance.now();
  const r = await app.handle({ method: m, path: `/api/v1${pp}`, query: Object.fromEntries(new URLSearchParams(q ?? '')), headers: h, rawBody: m === 'GET' ? '' : raw, ip: '1.1.1.1' });
  return { r, ms: performance.now() - t0 };
};
const pct = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]!.toFixed(1); };
const PW = 'Load-Test-Passphrase-1';
const prov = await provisionTenant(app, { name: 'Load', slug: 'load', timezone: 'UTC', defaultLocale: 'en', planKey: 'enterprise', owner: { username: 'owner', displayName: 'Owner' } }, null);
await call('POST', '/auth/activate', { tenant: 'load', code: prov.ownerActivationCode, password: PW });
const l = (await call('POST', '/auth/login', { tenant: 'load', identifier: 'owner', password: PW })).r.body as any;
const e = (await call('POST', '/auth/mfa/enroll', { tenant: 'load', challengeToken: l.challengeToken })).r.body as any;
const owner = ((await call('POST', '/auth/mfa/confirm', { tenant: 'load', challengeToken: l.challengeToken, code: totp(e.secret, Date.now()) })).r.body as any).accessToken;
const root = ((await call('GET', '/units', undefined, owner)).r.body as any).items[0].id;
await call('POST', '/privacy/notices', { texts: { en: 'Location only while on duty for load testing purposes.', ar: 'الموقع أثناء المناوبة فقط لأغراض الاختبار.' } }, owner);
const post = (await call('POST', '/posts', { unitId: root, name: 'P' }, owner)).r.body as any;
const today = new Date().toISOString().slice(0, 10); const hh = new Date(Date.now() - 10 * 60000).toISOString().slice(11, 16);
const shift = (await call('POST', '/shifts', { name: 'S', postId: post.id, startDate: today, startsAtLocal: hh, endsAtLocal: new Date(Date.now() + 6 * 3600000).toISOString().slice(11, 16) }, owner)).r.body as any;
const roles = ((await call('GET', '/roles', undefined, owner)).r.body as any).items; const field = roles.find((r: any) => r.key === 'field').id;
console.log(`setting up ${STAFF} on-duty staff…`); const t0 = Date.now();
const people: { token: string; key: any; session: string; seq: number }[] = [];
for (let i = 0; i < STAFF; i++) {
  const st = (await call('POST', '/staff', { employeeCode: `L${i}`, displayName: `Load ${i}`, homeUnitId: root, roleIds: [field] }, owner)).r.body as any;
  const inv = (await call('POST', `/staff/${st.id}/invitation`, { channel: 'code' }, owner)).r.body as any; await call('POST', '/auth/activate', { tenant: 'load', code: inv.activationCode, password: PW });
  const tok = ((await call('POST', '/auth/login', { tenant: 'load', identifier: `l${i}`, password: PW, client: 'mobile' })).r.body as any).accessToken;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'); await call('POST', '/devices/register', { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), platform: 'android', osVersion: '14', appVersion: '1.0.0' }, tok);
  await call('POST', '/privacy/acknowledgements', { version: 1 }, tok);
  await call('POST', '/assignments', { shiftId: shift.id, localDate: today, staffMemberId: st.id }, owner);
  people.push({ token: tok, key: privateKey, session: '', seq: 0 });
}
await call('POST', '/rosters/publish', { unitId: root, from: today, to: today, expectedVersion: 0 }, owner);
for (const p of people) { const duty = ((await call('GET', '/me/duty', undefined, p.token)).r.body as any).items[0]; const s = (await call('POST', `/assignments/${duty.id}/start`, { eventId: randomUUID(), occurredAt: new Date().toISOString() }, p.token, p.key)).r.body as any; p.session = s.trackingSessionId; }
console.log(`setup ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const ingest: number[] = []; let accepted = 0; const t1 = performance.now();
for (let b = 0; b < BATCHES; b++) {
  const p = people[b % people.length]!; const pts = Array.from({ length: 10 }, () => ({ seq: p.seq++, recordedAt: new Date(Date.now() - 1000).toISOString(), lat: 24.86 + Math.random() / 100, lon: 67 + Math.random() / 100, accuracyM: 10 }));
  const { r, ms } = await call('POST', '/locations/batch', { trackingSessionId: p.session, sentAt: new Date().toISOString(), points: pts }, p.token, p.key);
  if (r.status !== 200) throw new Error(`batch ${b}: ${r.status} ${JSON.stringify(r.body)}`); accepted += (r.body as any).accepted; ingest.push(ms);
}
const secs = (performance.now() - t1) / 1000; await app.pump();
// Fill the projection to the map target with synthetic states, then time the command-centre query.
const tenantId = prov.tenant._id; for (let i = people.length; i < MAPSTATES; i++) await app.store.insert('staff_location_states', { tenantId, staffMemberId: `synthetic-${i}`, displayName: `Synthetic ${i}`, unitId: root, dutyState: 'started', lat: 24.8, lon: 67, accuracyM: 10, effectiveTime: Date.now(), recordedAt: Date.now(), receivedAt: Date.now(), openExceptions: 0, activeSos: false });
const latest: number[] = []; for (let i = 0; i < 30; i++) latest.push((await call('GET', '/locations/latest', undefined, owner)).ms);
const dash: number[] = []; for (let i = 0; i < 30; i++) dash.push((await call('GET', '/dashboard/overview', undefined, owner)).ms);
const out = { staff: STAFF, batches: BATCHES, pointsAccepted: accepted, pointsPerSec: Math.round(accepted / secs), ingestBatchMs: { p50: pct(ingest, 0.5), p95: pct(ingest, 0.95), p99: pct(ingest, 0.99) }, latestStates: MAPSTATES, locationsLatestMs: { p50: pct(latest, 0.5), p95: pct(latest, 0.95) }, dashboardMs: { p50: pct(dash, 0.5), p95: pct(dash, 0.95) }, store: 'memory (single process)' };
console.log(JSON.stringify(out, null, 2));
