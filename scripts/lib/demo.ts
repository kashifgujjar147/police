// Demonstration data builder. Every record is created through the real API (same validation, audit and events).
// Data is clearly fictional and the tenant is flagged isDemo. Refused when NODE_ENV=production (TR-026).
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { totp } from '@sf/domain/node';
import { utcToLocalDate, utcToLocalTime } from '@sf/domain';
import { type App, deviceSigningString } from '@sf/kernel';
import { provisionTenant } from '../../modules/tenancy/provision.ts';

export interface DemoActor { username: string; password: string; role: string; staffId: string; token: string; device?: { id: string; key: KeyObject } }
export interface DemoResult { slug: string; tenantId: string; owner: { username: string; password: string; totpSecret: string }; users: DemoActor[]; incidents: string[] }

export async function buildDemo(app: App, opts: { slug?: string; password?: string; staffCount?: number } = {}): Promise<DemoResult> {
  if (app.config.env === 'production') throw new Error('Demo data is refused in production.');
  const slug = opts.slug ?? 'demo'; const password = opts.password ?? 'Demo-Passphrase-2026!'; const now = () => app.clock.now();
  const call = async (method: string, path: string, body: unknown, token?: string, device?: { key: KeyObject }) => {
    const raw = body === undefined ? '' : JSON.stringify(body); const headers: Record<string, string> = {}; if (token) headers.authorization = `Bearer ${token}`;
    if (device) { const ts = new Date(now()).toISOString(); headers['x-device-timestamp'] = ts; headers['x-device-signature'] = sign(null, Buffer.from(deviceSigningString(method, `/api/v1${path.split('?')[0]}`, raw, ts)), device.key).toString('base64'); headers['x-app-version'] = '1.0.0'; }
    const [p, q] = path.split('?'); const r = await app.handle({ method, path: `/api/v1${p}`, query: Object.fromEntries(new URLSearchParams(q ?? '')), headers, rawBody: raw, ip: '127.0.0.1' });
    if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as any;
  };
  if (await app.store.findOne('tenants', { slug })) throw new Error(`A tenant with slug "${slug}" already exists. Remove the data directory to reseed.`);
  const prov = await provisionTenant(app, { name: 'Demo Harbour Security (fictional)', slug, timezone: 'Asia/Karachi', defaultLocale: 'en', planKey: 'professional', isDemo: true, owner: { username: 'owner', email: 'owner@demo.invalid', displayName: 'Olivia Owner (demo)' } }, null);
  await call('POST', '/auth/activate', { tenant: slug, code: prov.ownerActivationCode, password });
  const l1 = await call('POST', '/auth/login', { tenant: slug, identifier: 'owner', password, client: 'mobile' });
  // With 2FA on, the owner enrols TOTP here; in simple local mode (no 2FA) the login already returns a session.
  const en = l1.accessToken ? { secret: '' } : await call('POST', '/auth/mfa/enroll', { tenant: slug, challengeToken: l1.challengeToken });
  const ownerTok = (l1.accessToken ?? (await call('POST', '/auth/mfa/confirm', { tenant: slug, challengeToken: l1.challengeToken, code: totp(en.secret, now()) })).accessToken) as string;
  const O = (m: string, p: string, b?: unknown) => call(m, p, b, ownerTok);
  const root = (await O('GET', '/units')).items[0].id;
  const south = await O('POST', '/units', { parentId: root, type: 'region', name: 'South Region', code: 'SOUTH' }); const north = await O('POST', '/units', { parentId: root, type: 'region', name: 'North Region', code: 'NORTH' });
  const port = await O('POST', '/units', { parentId: south.id, type: 'station', name: 'Port Station', code: 'PORT' }); const clifton = await O('POST', '/units', { parentId: south.id, type: 'station', name: 'Clifton Station', code: 'CLF' }); const airport = await O('POST', '/units', { parentId: north.id, type: 'station', name: 'Airport Station', code: 'AIR' });
  await O('POST', '/privacy/notices', { texts: { en: 'SmartForce 360 records your location only while you are on duty (between duty start and duty end). It also records duty start/end, breaks, checkpoint scans and device health. Supervisors in your chain can see your live position while you are on duty. Every look at your location history is logged and you can see it under "My data". Data is kept for the periods shown in the app.', ar: 'يسجّل سمارت فورس 360 موقعك فقط أثناء المناوبة (بين بدء المناوبة وإنهائها). كما يسجّل أوقات البدء والإنهاء والاستراحات ومسح نقاط التحقق وحالة الجهاز. يمكن للمشرفين في تسلسلك رؤية موقعك المباشر أثناء المناوبة فقط. كل اطلاع على سجل مواقعك يُسجَّل ويمكنك رؤيته في "بياناتي".' } });
  const sites = [
    { unit: port.id, name: 'Port Gate 3', lat: 24.8380, lon: 66.9850 }, { unit: port.id, name: 'Container Yard B', lat: 24.8350, lon: 66.9780 }, { unit: clifton.id, name: 'Clifton Mall Entrance', lat: 24.8138, lon: 67.0299 },
    { unit: clifton.id, name: 'Seaview Promenade', lat: 24.7930, lon: 67.0420 }, { unit: airport.id, name: 'Airport Cargo Terminal', lat: 24.9008, lon: 67.1681 },
  ];
  const posts: any[] = [];
  for (const s of sites) {
    const p = await O('POST', '/posts', { unitId: s.unit, name: s.name, address: `${s.name}, Karachi (demo address)`, location: { lat: s.lat, lon: s.lon }, instructions: 'Check visitor IDs. Report damaged fencing. Call the control room for any vehicle without a pass.' });
    const g = await O('POST', '/geofences', { postId: p.id, name: `${s.name} perimeter`, geometry: { shape: 'circle', center: { lat: s.lat, lon: s.lon }, radiusM: 150 }, requiredDuringDuty: true });
    const c1 = await O('POST', '/checkpoints', { postId: p.id, name: `${s.name} — north door`, method: 'qr', geofenceId: g.id, instructions: 'Scan the QR label beside the door.' });
    const c2 = await O('POST', '/checkpoints', { postId: p.id, name: `${s.name} — control room`, method: 'qr', rotatingPeriodSec: 30 });
    posts.push({ ...p, ...s, checkpoints: [c1, c2] });
  }
  const users: DemoActor[] = [];
  const mk = async (role: string, code: string, name: string, unitId: string, rank: string) => {
    const roles = (await O('GET', '/roles')).items; const st = await O('POST', '/staff', { employeeCode: code, displayName: name, rankTitle: rank, homeUnitId: unitId, roleIds: [roles.find((r: any) => r.key === role).id], scopeUnitIds: role === 'admin' || role === 'auditor' ? ['*'] : [unitId], phone: '+92 300 1234567' });
    const inv = await O('POST', `/staff/${st.id}/invitation`, { channel: 'code' }); await call('POST', '/auth/activate', { tenant: slug, code: inv.activationCode, password });
    const u: DemoActor = { username: code.toLowerCase(), password, role, staffId: st.id, token: '' };
    if (!['admin'].includes(role)) u.token = (await call('POST', '/auth/login', { tenant: slug, identifier: u.username, password, client: 'mobile' })).accessToken;
    users.push(u); return u;
  };
  await mk('commander', 'CMD-01', 'Kamran Commander (demo)', south.id, 'Commander');
  await mk('supervisor', 'SUP-01', 'Sara Supervisor (demo)', port.id, 'Supervisor'); await mk('supervisor', 'SUP-02', 'Bilal Supervisor (demo)', clifton.id, 'Supervisor');
  await mk('dispatcher', 'DSP-01', 'Dina Dispatcher (demo)', root, 'Dispatcher'); await mk('auditor', 'AUD-01', 'Asad Auditor (demo)', root, 'Auditor');
  const first = ['Ali', 'Ayesha', 'Hamza', 'Fatima', 'Usman', 'Zainab', 'Omar', 'Maryam', 'Hassan', 'Hira', 'Imran', 'Sana', 'Faisal', 'Nadia', 'Tariq', 'Rabia', 'Yasir', 'Amna', 'Saad', 'Iqra'];
  const field: DemoActor[] = [];
  for (let i = 0; i < Math.max(8, opts.staffCount ?? 14); i++) {
    const post = posts[i % posts.length]; const u = await mk('field', `FO-${String(i + 1).padStart(3, '0')}`, `${first[i % first.length]} Officer ${i + 1} (demo)`, post.unit, 'Field Officer');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const dev = await call('POST', '/devices/register', { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), platform: i % 3 ? 'android' : 'ios', osVersion: i % 3 ? '14' : '17.5', model: i % 3 ? 'Demo Android' : 'Demo iPhone', appVersion: '1.0.0' }, u.token);
    u.device = { id: dev.id, key: privateKey };
    const n = await call('GET', '/privacy/notices/current', undefined, u.token); await call('POST', '/privacy/acknowledgements', { version: n.notice.version }, u.token, u.device);
    field.push(u);
  }
  // Today's roster: a day shift that started 1 hour ago, plus a night shift later today.
  const tz = 'Asia/Karachi'; const start = now() - 3600000; const date = utcToLocalDate(start, tz);
  const assignments: { u: DemoActor; a: any; post: any }[] = [];
  for (const [pi, post] of posts.entries()) {
    const day = await O('POST', '/shifts', { name: `${post.name} — day`, postId: post.id, startDate: date, startsAtLocal: utcToLocalTime(start, tz), endsAtLocal: utcToLocalTime(start + 8 * 3600000, tz), recurrenceRule: 'FREQ=DAILY', minStaffing: { count: 2 } });
    await O('POST', '/shifts', { name: `${post.name} — night`, postId: post.id, startDate: date, startsAtLocal: utcToLocalTime(start + 8 * 3600000, tz), endsAtLocal: utcToLocalTime(start + 16 * 3600000, tz), recurrenceRule: 'FREQ=DAILY', minStaffing: { count: 1 } });
    for (const u of field.filter((_, i) => i % posts.length === pi)) {
      const a = await O('POST', '/assignments', { shiftId: day.id, localDate: date, staffMemberId: u.staffId, checkpointPlan: { mode: 'flexible', items: post.checkpoints.map((c: any, k: number) => ({ checkpointId: c.id, offsetEndMin: 120 + k * 120 })) } });
      assignments.push({ u, a, post });
    }
  }
  // Two officers with no device yet, for the field simulator / a real phone (tools/field-simulator.ts).
  for (const k of [1, 2]) {
    const post = posts[k - 1]; const u = await mk('field', `SIM-${k}`, `Sim Officer ${k} (demo)`, post.unit, 'Field Officer');
    const day = (await O('GET', `/shifts?limit=200`)).items.find((x: any) => x.postId === post.id && x.name.endsWith('day'));
    await O('POST', '/assignments', { shiftId: day.id, localDate: date, staffMemberId: u.staffId });
  }
  for (const unit of [port.id, clifton.id, airport.id]) await O('POST', '/rosters/publish', { unitId: unit, from: date, to: date, expectedVersion: 0, note: 'Demo roster' });
  // Most officers are on duty with recent positions; one started late; one went quiet (stale); one is outside the fence; one raised an SOS.
  for (const [i, { u, a, post }] of assignments.entries()) {
    if (i === 3) continue; // not started → late-start alert
    const offs = i === 5 ? 0.004 : 0.0004 * ((i % 4) - 1.5);
    const st = await call('POST', `/assignments/${a.id}/start`, { eventId: randomUUID(), occurredAt: new Date(now()).toISOString(), sentAt: new Date(now()).toISOString(), location: { lat: post.lat + offs, lon: post.lon + offs, accuracyM: 12 } }, u.token, u.device);
    await call('POST', `/assignments/${a.id}/acknowledge`, {}, u.token);
    const pts = Array.from({ length: 6 }, (_, k) => ({ seq: k, recordedAt: new Date(now() - (i === 7 ? 30 * 60000 : 0) - (5 - k) * 30000).toISOString(), lat: post.lat + offs + k * 0.00005, lon: post.lon + offs - k * 0.00004, accuracyM: 8 + (k % 3) * 4, battery: i === 9 ? 11 : 80 - i * 3 }));
    await call('POST', '/locations/batch', { trackingSessionId: st.trackingSessionId, sentAt: new Date(now()).toISOString(), points: pts }, u.token, u.device);
    if (i < 6) await call('POST', '/checkpoint-scans', { eventId: randomUUID(), tagId: post.checkpoints[0].tagId, scannedAt: new Date(now()).toISOString(), location: { lat: post.lat, lon: post.lon, accuracyM: 8 } }, u.token, u.device);
  }
  const incidents: string[] = [];
  const sosUser = assignments[1]!.u; const sos = await call('POST', '/sos', { eventId: randomUUID(), occurredAt: new Date(now()).toISOString(), note: 'Demo SOS: aggressive visitor at the gate' }, sosUser.token, sosUser.device); incidents.push(sos.incidentId);
  const rep = assignments[2]!.u; const inc = await call('POST', '/incidents', { eventId: randomUUID(), typeKey: 'hazard', severity: 'medium', description: 'Demo: section of perimeter fence is damaged near the north door.' }, rep.token); incidents.push(inc.incidentId);
  await call('POST', '/corrections', { assignmentId: assignments[4]!.a.id, proposed: { type: 'check_in', occurredAt: new Date(assignments[4]!.a.startsAt).toISOString() }, reason: 'Demo: my phone restarted at the start of the shift.' }, assignments[4]!.u.token);
  await app.pump(); await app.runSchedulers(true); await app.pump();
  return { slug, tenantId: prov.tenant._id, owner: { username: 'owner', password, totpSecret: en.secret }, users, incidents };
}
