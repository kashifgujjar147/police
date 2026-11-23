// Test harness: real application, in-memory store, fake clock. Requests go through the same kernel as production traffic.
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { testConfig, type AppConfig } from '@sf/config';
import { totp } from '@sf/domain/node';
import { type App, type Doc, FakeClock, MemoryStore, type Res, deviceSigningString, parseCookies } from '@sf/kernel';
import { createApp } from '@sf/app';
import { provisionTenant } from '../modules/tenancy/provision.ts';

export interface Harness { app: App; clock: FakeClock; store: MemoryStore; logs: string[]; config: AppConfig }
const openMongo: { close(): Promise<void> }[] = [];
export async function makeApp(over: Partial<AppConfig> = {}, start = '2026-11-10T06:00:00Z'): Promise<Harness> {
  const clock = new FakeClock(Date.parse(start)); const logs: string[] = [];
  // TEST_STORE=mongo runs the same suite against a real MongoDB replica set (a fresh database per test).
  let store: MemoryStore;
  if (process.env.TEST_STORE === 'mongo') {
    const { MongoStore } = await import('../modules/kernel/mongo-store.ts');
    store = (await MongoStore.connect(process.env.MONGO_URL ?? 'mongodb://localhost:27017/?directConnection=true', `sf360_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`)) as unknown as MemoryStore;
    if (!openMongo.length) { const { after } = await import('node:test'); after(async () => { for (const s of openMongo.splice(0)) await s.close().catch(() => {}); }); } // open clients kept the test process alive forever
    openMongo.push(store);
  }
  else store = new MemoryStore();
  const config = testConfig({ runWorkerInProcess: false, logLevel: 'info', ...over });
  const app = await createApp({ config, store, clock, logSink: (l) => logs.push(l) });
  return { app, clock, store, logs, config };
}
export const iso = (t: number) => new Date(t).toISOString();
export const uuid = () => randomUUID();

export class Client {
  token: string | null = null; cookies: Record<string, string> = {}; refreshToken: string | null = null;
  device: { id: string; privateKey: KeyObject; publicPem: string } | null = null; profile: Doc | null = null;
  extraHeaders: Record<string, string> = {};
  constructor(readonly h: Harness, readonly tenant: string) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res & { body: any }> {
    const [p, qs] = path.split('?'); const rawBody = body === undefined ? '' : JSON.stringify(body);
    const hd: Record<string, string> = { ...this.extraHeaders, ...headers };
    if (this.token && !hd.authorization) hd.authorization = `Bearer ${this.token}`;
    if (Object.keys(this.cookies).length) hd.cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.device) { const ts = iso(this.h.clock.now()); hd['x-device-timestamp'] = ts; hd['x-device-signature'] = sign(null, Buffer.from(deviceSigningString(method, `/api/v1${p}`, rawBody, ts)), this.device.privateKey).toString('base64'); hd['x-app-version'] ??= '1.0.0'; }
    const res = await this.h.app.handle({ method, path: `/api/v1${p}`, query: Object.fromEntries(new URLSearchParams(qs ?? '')), headers: hd, rawBody, ip: hd['x-test-ip'] ?? '10.0.0.1' });
    // Access tokens live 15 minutes: like the real clients, refresh once and retry on 401.
    if (res.status === 401 && this.refreshToken && this.token && !p!.startsWith('/auth/') && !headers['x-no-refresh']) {
      const rr = await this.h.app.handle({ method: 'POST', path: '/api/v1/auth/refresh', query: {}, headers: {}, rawBody: JSON.stringify({ tenant: this.tenant, refreshToken: this.refreshToken }), ip: '10.0.0.1' });
      if (rr.status === 200) { const b = rr.body as { accessToken: string; refreshToken: string }; this.token = b.accessToken; this.refreshToken = b.refreshToken; return this.req(method, path, body, { ...headers, 'x-no-refresh': '1' }); }
    }
    const set = res.headers['Set-Cookie']; for (const c of Array.isArray(set) ? set : set ? [set] : []) { const [kv] = c.split(';'); const [k, v] = kv!.split('='); if (v) this.cookies[k!] = v; else delete this.cookies[k!]; }
    return res as Res & { body: any };
  }
  get = (path: string, headers?: Record<string, string>) => this.req('GET', path, undefined, headers);
  post = (path: string, body: unknown = {}, headers?: Record<string, string>) => this.req('POST', path, body, headers);
  patch = (path: string, body: unknown) => this.req('PATCH', path, body);
  put = (path: string, body: unknown) => this.req('PUT', path, body);
  del = (path: string) => this.req('DELETE', path);
  /** Full sign-in including MFA enrolment/verification when the role requires it. */
  async login(identifier: string, password: string, opts: { client?: 'web' | 'mobile'; deviceId?: string } = {}): Promise<Res & { body: any }> {
    let r = await this.post('/auth/login', { tenant: this.tenant, identifier, password, client: opts.client ?? 'mobile', ...(opts.deviceId ? { deviceId: opts.deviceId } : {}) });
    if (r.status === 200 && r.body.mfaRequired) {
      const key = `${this.tenant}:${identifier}`;
      if (r.body.enrolmentRequired) {
        const e = await this.post('/auth/mfa/enroll', { tenant: this.tenant, challengeToken: r.body.challengeToken }); MFA_SECRETS.set(key, e.body.secret);
        r = await this.post('/auth/mfa/confirm', { tenant: this.tenant, challengeToken: r.body.challengeToken, code: totp(e.body.secret, this.h.clock.now()) });
      } else { this.h.clock.advanceSec(31); r = await this.post('/auth/mfa/verify', { tenant: this.tenant, challengeToken: r.body.challengeToken, code: totp(MFA_SECRETS.get(key)!, this.h.clock.now()) }); }
    }
    if (r.status === 200 && r.body.accessToken) { this.token = r.body.accessToken; this.refreshToken = r.body.refreshToken ?? null; this.profile = r.body.user; }
    return r;
  }
  async registerDevice(appVersion = '1.0.0'): Promise<Doc> {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const r = await this.post('/devices/register', { publicKey: publicPem, platform: 'android', osVersion: '14', model: 'Test A14', appVersion });
    if (r.status >= 300) throw new Error(`device register failed: ${JSON.stringify(r.body)}`);
    this.device = { id: r.body.id, privateKey, publicPem }; return r.body;
  }
}
export const MFA_SECRETS = new Map<string, string>();
export const PASSWORD = 'Correct-Horse-Battery-42';

export interface TenantFixture { tenant: Doc; slug: string; owner: Client; rootUnitId: string; roleIds: Record<string, string>; h: Harness }
export async function setupTenant(h: Harness, slug: string, opts: { timezone?: string; plan?: string } = {}): Promise<TenantFixture> {
  const out = await provisionTenant(h.app, { name: `Org ${slug}`, slug, timezone: opts.timezone ?? 'Asia/Karachi', defaultLocale: 'en', planKey: opts.plan ?? 'professional', owner: { username: 'owner', email: `owner@${slug}.example`, displayName: 'Olivia Owner' } }, null);
  const owner = new Client(h, slug);
  const act = await owner.post('/auth/activate', { tenant: slug, code: out.ownerActivationCode, password: PASSWORD });
  if (act.status !== 200) throw new Error(`activate failed ${JSON.stringify(act.body)}`);
  const login = await owner.login('owner', PASSWORD);
  if (login.status !== 200) throw new Error(`owner login failed ${JSON.stringify(login.body)}`);
  const units = await owner.get('/units'); const roles = await owner.get('/roles');
  const notice = await owner.post('/privacy/notices', { texts: { en: 'We collect your location only while you are on duty. '.repeat(2), ar: 'نجمع موقعك فقط أثناء المناوبة. نجمع موقعك فقط أثناء المناوبة.' } });
  if (notice.status !== 201) throw new Error(`notice failed ${JSON.stringify(notice.body)}`);
  return { tenant: out.tenant, slug, owner, rootUnitId: units.body.items[0].id, roleIds: Object.fromEntries(roles.body.items.map((r: Doc) => [r.key, r.id])), h };
}
let codeSeq = 0;
/** Creates a staff member through the API, activates the account and signs in. Field staff also get a registered device and accept the notice. */
export async function addStaff(t: TenantFixture, role: string, opts: { unitId?: string; scopeUnitIds?: string[]; name?: string; code?: string; device?: boolean } = {}): Promise<{ client: Client; staffId: string; code: string }> {
  const code = opts.code ?? `E${String(++codeSeq).padStart(4, '0')}`;
  const body: Record<string, unknown> = { employeeCode: code, displayName: opts.name ?? `${role} ${code}`, homeUnitId: opts.unitId ?? t.rootUnitId, roleIds: [t.roleIds[role]], scopeUnitIds: opts.scopeUnitIds ?? (role === 'admin' ? ['*'] : [opts.unitId ?? t.rootUnitId]), phone: '+92 300 0000000' };
  const c = await t.owner.post('/staff', body); if (c.status !== 201) throw new Error(`create staff failed ${JSON.stringify(c.body)}`);
  const inv = await t.owner.post(`/staff/${c.body.id}/invitation`, { channel: 'code' }); if (inv.status !== 201) throw new Error(`invite failed ${JSON.stringify(inv.body)}`);
  const client = new Client(t.h, t.slug);
  const act = await client.post('/auth/activate', { tenant: t.slug, code: inv.body.activationCode, password: PASSWORD }); if (act.status !== 200) throw new Error(`activate failed ${JSON.stringify(act.body)}`);
  const l = await client.login(code.toLowerCase(), PASSWORD); if (l.status !== 200) throw new Error(`login failed ${JSON.stringify(l.body)}`);
  if (role === 'field' && opts.device !== false) { await client.registerDevice(); const n = await client.get('/privacy/notices/current'); await client.post('/privacy/acknowledgements', { version: n.body.notice.version }); }
  return { client, staffId: c.body.id, code };
}
export interface DutyFixture { postId: string; shiftId: string; assignmentId: string; startsAt: number; endsAt: number; localDate: string }
/** Post + shift starting `startInMin` from now (tenant timezone) + published assignment for the staff member. */
export async function planDuty(t: TenantFixture, staffId: string, opts: { startInMin?: number; hours?: number; unitId?: string; postId?: string; checkpointPlan?: unknown; publish?: boolean } = {}): Promise<DutyFixture> {
  const { utcToLocalDate, utcToLocalTime } = await import('@sf/domain');
  const tz = t.tenant.timezone; const start = t.h.clock.now() + (opts.startInMin ?? 10) * 60000; const end = start + (opts.hours ?? 8) * 3600000; const unitId = opts.unitId ?? t.rootUnitId;
  const postId = opts.postId ?? (await must(t.owner.post('/posts', { unitId, name: `Gate ${++codeSeq}`, location: { lat: 24.8607, lon: 67.0011 } }))).id;
  const localDate = utcToLocalDate(start, tz);
  const shift = await must(t.owner.post('/shifts', { name: `Shift ${++codeSeq}`, postId, startDate: localDate, startsAtLocal: utcToLocalTime(start, tz), endsAtLocal: utcToLocalTime(end, tz) }));
  const a = await must(t.owner.post('/assignments', { shiftId: shift.id, localDate, staffMemberId: staffId, ...(opts.checkpointPlan ? { checkpointPlan: opts.checkpointPlan } : {}) }));
  if (opts.publish !== false) await must(t.owner.post('/rosters/publish', { unitId, from: localDate, to: localDate, expectedVersion: await rosterVersion(t, unitId, localDate) }));
  return { postId, shiftId: shift.id, assignmentId: a.id, startsAt: Date.parse(a.startsAt), endsAt: Date.parse(a.endsAt), localDate };
}
export async function rosterVersion(t: TenantFixture, unitId: string, date: string): Promise<number> {
  const v = await t.owner.get(`/rosters/versions?unitId=${unitId}`); return Math.max(0, ...v.body.items.filter((x: Doc) => x.scope.from === date && x.scope.to === date).map((x: Doc) => x.version));
}
export async function must(p: Promise<Res & { body: any }>): Promise<any> { const r = await p; if (r.status >= 300) throw new Error(`request failed ${r.status}: ${JSON.stringify(r.body)}`); return r.body; }
export const startBody = (h: Harness, loc?: { lat: number; lon: number; accuracyM: number }) => ({ eventId: uuid(), occurredAt: iso(h.clock.now()), sentAt: iso(h.clock.now()), ...(loc ? { location: loc } : {}) });
/** Relay outbox + run due jobs + run all schedulers, as the worker would. */
export async function tick(h: Harness) { await h.app.pump(); await h.app.runSchedulers(true); await h.app.pump(); }
export function points(h: Harness, n: number, opts: { fromSeq?: number; lat?: number; lon?: number; stepSec?: number; accuracyM?: number; battery?: number } = {}) {
  const now = h.clock.now(); const step = (opts.stepSec ?? 30) * 1000;
  return Array.from({ length: n }, (_, i) => ({ seq: (opts.fromSeq ?? 0) + i, recordedAt: iso(now - (n - 1 - i) * step), lat: (opts.lat ?? 24.8607) + i * 0.00001, lon: opts.lon ?? 67.0011, accuracyM: opts.accuracyM ?? 12, ...(opts.battery !== undefined ? { battery: opts.battery } : {}) }));
}
export { parseCookies };
