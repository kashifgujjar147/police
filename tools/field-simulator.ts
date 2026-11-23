// Field simulator: drives N simulated phones (the same mobile-core sync engine as the app) against a running API.
// Usage: npm run simulate -- --url http://localhost:8080 --tenant demo --password 'Demo-Passphrase-2026!' --users fo-001,fo-002 --minutes 5 [--offline-every 4] [--approver cmd-01]
// The demo seed already gives each field user a device, so a simulated phone is a second device and needs approval (--approver).
import { Api, Duty, MemoryKV, Outbox, SosController, SyncEngine } from '@sf/mobile-core';
import { fetchTransport, nodeEnv, nodeSigner } from '../packages/mobile-core/src/node.ts';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const url = arg('url', 'http://localhost:8080')!, tenant = arg('tenant', 'demo')!, password = arg('password', 'Demo-Passphrase-2026!')!;
const users = arg('users', 'fo-001,fo-002,fo-004')!.split(','), minutes = Number(arg('minutes', '3')), offlineEvery = Number(arg('offline-every', '0')), sosUser = arg('sos'), approver = arg('approver');
const env = nodeEnv(); const transport = fetchTransport(url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function phone(user: string, idx: number) {
  const kv = new MemoryKV(); const api = new Api(transport, kv, nodeSigner(), env); const box = new Outbox(kv); const sync = new SyncEngine(api, box, env); const duty = new Duty(box, sync, env);
  const r = await api.login(tenant, user, password); if (!r.ok) throw new Error(`${user}: MFA accounts cannot be simulated`);
  const dev = await api.registerDevice({ platform: 'android', osVersion: '14', model: 'Simulator' });
  if (dev.status === 'pending_approval') { // a second device needs approval (FR-DEV-001): use the real workflow, never a shortcut
    if (!approver) { console.log(`${user}: this simulated device is waiting for approval — pass --approver <commander/admin username without MFA>, or approve it in Staff › Devices`); return; }
    const a = new Api(transport, new MemoryKV(), nodeSigner(), env); const l = await a.login(tenant, approver, password); if (!l.ok) throw new Error(`${approver}: approver needs MFA; use a Commander account`);
    await a.call('POST', `/devices/${dev.id}/approve`, {}); console.log(`${user}: device approved by ${approver} (older device revoked by policy)`);
  }
  const n = await api.call('GET', '/privacy/notices/current'); if (n.notice && !n.acknowledged) await api.call('POST', '/privacy/acknowledgements', { version: n.notice.version });
  const today = (await api.call('GET', '/me/duty')).items; const a = today.find((x: any) => x.status === 'scheduled') ?? today.find((x: any) => x.status === 'started');
  if (!a) { console.log(`${user}: no assignment today`); return; }
  const base = a.post?.location ?? { lat: 24.86, lon: 67.0 };
  if (a.status === 'scheduled') { const s = await duty.start(a.id, { ...base, accuracyM: 10 }); console.log(`${user}: start → ${s.rejected ? `rejected ${s.rejected.code}` : s.queued ? 'queued' : 'accepted'}`); }
  if (!box.tracking) { console.log(`${user}: no tracking session — ${a.status === 'started' ? 'duty was already started on another device; pick a user whose duty is still scheduled' : 'start was not accepted (see above)'}`); return; }
  const end = Date.now() + minutes * 60000; let k = 0;
  while (Date.now() < end) {
    k++; const ang = (k + idx * 40) / 15; await box.addPoint({ recordedAt: new Date().toISOString(), lat: base.lat + Math.sin(ang) * 0.0006, lon: base.lon + Math.cos(ang) * 0.0006, accuracyM: 6 + (k % 5) * 3, battery: Math.max(5, 90 - k) });
    if (offlineEvery && k % offlineEvery === 0) sync.online = !sync.online; // flip connectivity to exercise the offline queue
    if (k % 2 === 0) { const res = await sync.sync(); process.stdout.write(`${user}: ${sync.online ? 'online ' : 'OFFLINE'} sent=${res.pointsSent} queued=${box.points.length}\n`); }
    if (sosUser === user && k === 3) { const ctl = new SosController(api, box, sync, env); await ctl.trigger({ ...base, accuracyM: 10 }, 'Simulator SOS'); console.log(`${user}: SOS → ${ctl.state}`); }
    await sleep(15000);
  }
  sync.online = true; await duty.end(a.id, { ...base, accuracyM: 10 }); await sync.sync(); console.log(`${user}: ended duty, queue empty=${box.pending().length === 0 && box.points.length === 0}`);
}
await Promise.all(users.map((u, i) => phone(u, i).catch((e) => console.error(`${u}: ${e.message}`))));
