// Mobile core: durable offline queue, sync engine, location buffer, SOS controller and signed API client (TS §14, FR-SYN, FR-SOS).
// Platform-independent: storage, clock, network, signing and IDs are injected, so the same code runs in the Expo app,
// the field simulator and the test suite. No React Native imports here.
import { backoffMs, EVENT_PRIORITY, thinPoints } from '@sf/domain';

// ---------- ports ----------
export interface KV { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; del(key: string): Promise<void> }
export interface Transport { request(method: string, path: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: any }> }
export interface Signer { publicKeyPem(): Promise<string>; sign(data: string): Promise<string> }
export interface Env { now(): number; uuid(): string; sha256Hex(s: string): Promise<string> | string; random?(): number }

export class MemoryKV implements KV { m = new Map<string, string>(); async get(k: string) { return this.m.get(k) ?? null; } async set(k: string, v: string) { this.m.set(k, v); } async del(k: string) { this.m.delete(k); } }

// ---------- API client ----------
export class ApiError extends Error { constructor(readonly status: number, readonly code: string, message: string, readonly details: any = null) { super(message); } }
export interface Session { tenant: string; accessToken: string; refreshToken: string; deviceId: string | null; staffMemberId: string | null }
export class Api {
  session: Session | null = null; appVersion = '1.0.0';
  constructor(private t: Transport, private kv: KV, private signer: Signer, private env: Env) {}
  async load() { const s = await this.kv.get('session'); this.session = s ? JSON.parse(s) : null; return this.session; }
  private async save() { if (this.session) await this.kv.set('session', JSON.stringify(this.session)); else await this.kv.del('session'); }
  private async raw(method: string, path: string, body?: unknown, signed = false) {
    const text = body === undefined ? '' : JSON.stringify(body); const h: Record<string, string> = { 'Content-Type': 'application/json', 'X-App-Version': this.appVersion };
    if (this.session?.accessToken) h.Authorization = `Bearer ${this.session.accessToken}`;
    if (signed) { const ts = new Date(this.env.now()).toISOString(); const p = `/api/v1${path.split('?')[0]}`; h['X-Device-Timestamp'] = ts; h['X-Device-Signature'] = await this.signer.sign(`${method.toUpperCase()}\n${p}\n${await this.env.sha256Hex(text)}\n${ts}`); }
    return this.t.request(method, `/api/v1${path}`, text, h);
  }
  async call<T = any>(method: string, path: string, body?: unknown, opts: { signed?: boolean } = {}): Promise<T> {
    let r = await this.raw(method, path, body, opts.signed);
    if (r.status === 401 && this.session?.refreshToken && !path.startsWith('/auth/')) {
      const rr = await this.t.request('POST', '/api/v1/auth/refresh', JSON.stringify({ tenant: this.session.tenant, refreshToken: this.session.refreshToken }), { 'Content-Type': 'application/json' });
      if (rr.status === 200) { this.session.accessToken = rr.body.accessToken; this.session.refreshToken = rr.body.refreshToken; await this.save(); r = await this.raw(method, path, body, opts.signed); }
    }
    if (r.status >= 400) { const e = r.body?.error ?? {}; throw new ApiError(r.status, e.code ?? 'ERROR', e.message ?? `HTTP ${r.status}`, e.details ?? null); }
    return r.body as T;
  }
  async login(tenant: string, identifier: string, password: string): Promise<{ ok: true } | { ok: false; mfa: true; challengeToken: string; enrolment: boolean }> {
    const deviceId = (await this.kv.get('deviceId')) ?? undefined;
    const r = await this.t.request('POST', '/api/v1/auth/login', JSON.stringify({ tenant, identifier, password, client: 'mobile', ...(deviceId ? { deviceId } : {}) }), { 'Content-Type': 'application/json' });
    if (r.status >= 400) throw new ApiError(r.status, r.body?.error?.code ?? 'ERROR', r.body?.error?.message ?? 'Sign-in failed');
    if (r.body.mfaRequired) return { ok: false, mfa: true, challengeToken: r.body.challengeToken, enrolment: r.body.enrolmentRequired };
    this.session = { tenant, accessToken: r.body.accessToken, refreshToken: r.body.refreshToken, deviceId: deviceId ?? null, staffMemberId: r.body.user.staffMemberId }; await this.save();
    return { ok: true };
  }
  async activate(tenant: string, code: string, password: string) { return this.call('POST', '/auth/activate', { tenant, code, password }); }
  /** Binds this install's key pair to the staff member. The private key never leaves the device. */
  async registerDevice(info: { platform: 'android' | 'ios'; osVersion: string; model?: string }) {
    const d = await this.call('POST', '/devices/register', { publicKey: await this.signer.publicKeyPem(), ...info, appVersion: this.appVersion });
    await this.kv.set('deviceId', d.id); this.session!.deviceId = d.id; await this.save(); return d;
  }
  async logout() { try { await this.call('POST', '/auth/logout', {}); } catch { /* offline: local sign-out still happens */ } this.session = null; await this.save(); }
}

// ---------- durable queue ----------
export type QueuedType = 'check_in' | 'check_out' | 'break_start' | 'break_end' | 'scan' | 'incident' | 'sos';
export interface QueuedEvent { eventId: string; type: QueuedType; occurredAt: string; assignmentId?: string; payload?: Record<string, unknown>; attempts: number; nextAt: number; state: 'pending' | 'rejected'; rejection?: { code: string; message: string; action: string } }
export interface QueuedPoint { seq: number; sessionId: string; recordedAt: string; lat: number; lon: number; accuracyM: number; speed?: number; heading?: number; battery?: number; mock?: boolean }
const PRIO: Record<QueuedType, number> = { sos: EVENT_PRIORITY.sos!, check_in: EVENT_PRIORITY.attendance!, check_out: EVENT_PRIORITY.attendance!, break_start: EVENT_PRIORITY.attendance!, break_end: EVENT_PRIORITY.attendance!, scan: EVENT_PRIORITY.scan!, incident: EVENT_PRIORITY.incident! };

/**
 * Write-ahead queue: every action is persisted BEFORE any network attempt, so a crash or force-close loses nothing.
 * Events keep their order; SOS is sent ahead of everything else; location points are batched and thinned only at the cap.
 */
export class Outbox {
  events: QueuedEvent[] = []; points: QueuedPoint[] = []; droppedPoints = 0; seq = 0; tracking: { sessionId: string; assignmentId: string; profile: any } | null = null;
  constructor(private kv: KV, private capPoints = 50000) {}
  async load() { const s = await this.kv.get('outbox'); if (s) Object.assign(this, JSON.parse(s)); return this; }
  async persist() { await this.kv.set('outbox', JSON.stringify({ events: this.events, points: this.points, droppedPoints: this.droppedPoints, seq: this.seq, tracking: this.tracking })); }
  async addEvent(e: Omit<QueuedEvent, 'attempts' | 'nextAt' | 'state'>) { this.events.push({ ...e, attempts: 0, nextAt: 0, state: 'pending' }); await this.persist(); }
  async addPoint(p: Omit<QueuedPoint, 'seq' | 'sessionId'>) {
    if (!this.tracking) return false; // no tracking session → nothing is recorded (FR-LOC-001)
    this.points.push({ ...p, seq: this.seq++, sessionId: this.tracking.sessionId });
    if (this.points.length > this.capPoints) { const r = thinPoints(this.points, this.capPoints); this.points = r.kept; this.droppedPoints += r.dropped; }
    await this.persist(); return true;
  }
  pending() { return this.events.filter((e) => e.state === 'pending'); }
  rejected() { return this.events.filter((e) => e.state === 'rejected'); }
  /** The user acknowledges a rejected record after reading the reason; only then is it removed (FR-SYN-002). */
  async acknowledgeRejection(eventId: string) { this.events = this.events.filter((e) => e.eventId !== eventId); await this.persist(); }
  status(now: number) { const p = this.pending(); const oldest = Math.min(...p.map((e) => Date.parse(e.occurredAt)), ...this.points.map((x) => Date.parse(x.recordedAt))); return { pendingEvents: p.length, pendingPoints: this.points.length, rejected: this.rejected().length, droppedPoints: this.droppedPoints, oldestPendingAgeSec: Number.isFinite(oldest) ? Math.round((now - oldest) / 1000) : 0 }; }
}

// ---------- sync engine ----------
export interface SyncResult { sent: number; accepted: number; duplicates: number; rejected: number; pointsSent: number; offline: boolean; error?: string }
export class SyncEngine {
  online = true; lastSync: number | null = null; lastError: string | null = null; clockSkewMs = 0; private running: Promise<SyncResult> | null = null;
  onChange: () => void = () => {};
  constructor(private api: Api, private box: Outbox, private env: Env) {}
  /** One sync pass. Re-entrant calls share the running pass. Safe to call on every network change, timer and app resume. */
  sync(): Promise<SyncResult> { return (this.running ??= this.pass().finally(() => { this.running = null; this.onChange(); })); }
  private async pass(): Promise<SyncResult> {
    const res: SyncResult = { sent: 0, accepted: 0, duplicates: 0, rejected: 0, pointsSent: 0, offline: false }; const now = this.env.now();
    if (!this.online) return { ...res, offline: true };
    try {
      // 0. SOS goes first, individually, to the dedicated endpoint (any role may raise it; never rate-limited).
      for (const ev of this.box.pending().filter((e) => e.type === 'sos')) {
        const r = await this.api.call('POST', '/sos', { eventId: ev.eventId, occurredAt: ev.occurredAt, sentAt: new Date(this.env.now()).toISOString(), ...(ev.payload ?? {}) }, { signed: !!this.api.session?.deviceId });
        res.sent++; if (r.status === 'duplicate') res.duplicates++; else res.accepted++;
        this.box.events = this.box.events.filter((e) => e.eventId !== ev.eventId); await this.box.persist();
      }
      // 1. Other events in causal order, in batches of up to 100 with per-event results.
      const due = this.box.pending().filter((e) => e.nextAt <= now && e.type !== 'sos').sort((a, b) => PRIO[a.type] - PRIO[b.type] || Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
      for (let i = 0; i < due.length; i += 100) {
        const batch = due.slice(i, i + 100);
        const out = await this.api.call('POST', '/sync/events', { sentAt: new Date(this.env.now()).toISOString(), events: batch.map((e) => ({ eventId: e.eventId, type: e.type, occurredAt: e.occurredAt, ...(e.assignmentId ? { assignmentId: e.assignmentId } : {}), ...(e.payload ? { payload: e.payload } : {}) })) }, { signed: true });
        this.clockSkewMs = out.clockSkewMs ?? 0; res.sent += batch.length;
        for (const r of out.results as any[]) {
          const ev = this.box.events.find((e) => e.eventId === r.eventId)!;
          if (r.status === 'rejected') { ev.state = 'rejected'; ev.rejection = { code: r.code, message: r.message, action: r.action }; res.rejected++; continue; }
          if (r.status === 'duplicate') res.duplicates++; else res.accepted++;
          this.box.events = this.box.events.filter((e) => e.eventId !== r.eventId);
          if (ev.type === 'check_in' && r.trackingSessionId) this.box.tracking = { sessionId: r.trackingSessionId, assignmentId: ev.assignmentId!, profile: r.profile };
          if (ev.type === 'check_out' && this.box.tracking?.assignmentId === ev.assignmentId) this.box.tracking = null;
        }
        await this.box.persist();
      }
      // 2. Location points in batches of 200 per session.
      for (;;) {
        const head = this.box.points[0]; if (!head) break;
        const batch = this.box.points.filter((p) => p.sessionId === head.sessionId).slice(0, 200);
        try {
          const out = await this.api.call('POST', '/locations/batch', { trackingSessionId: head.sessionId, sentAt: new Date(this.env.now()).toISOString(), points: batch.map(({ sessionId: _s, ...p }) => p) }, { signed: true });
          res.pointsSent += out.accepted + out.duplicates;
        } catch (e) {
          if (!(e instanceof ApiError) || e.code !== 'TRACKING_NOT_AUTHORIZED') throw e;
          this.box.droppedPoints += batch.length; // session no longer valid on the server: these cannot be accepted
        }
        const sent = new Set(batch.map((p) => p.seq)); this.box.points = this.box.points.filter((p) => !(p.sessionId === head.sessionId && sent.has(p.seq)));
        await this.box.persist();
      }
      this.lastSync = this.env.now(); this.lastError = null; return res;
    } catch (e) {
      // Network or server failure: back off each pending event (SOS caps at 30 s); nothing is discarded.
      for (const ev of this.box.pending()) { ev.attempts++; ev.nextAt = this.env.now() + backoffMs(ev.attempts, { capMs: ev.type === 'sos' ? 30000 : 15 * 60000, rand: this.env.random }); }
      await this.box.persist();
      if (e instanceof ApiError && e.status < 500 && e.status !== 429) this.lastError = `${e.code}: ${e.message}`; else this.lastError = (e as Error).message;
      return { ...res, offline: !(e instanceof ApiError), error: this.lastError };
    }
  }
}

// ---------- duty actions (always queue first, then sync) ----------
export class Duty {
  constructor(private box: Outbox, private sync: SyncEngine, private env: Env) {}
  private async act(type: QueuedType, assignmentId: string | undefined, payload?: Record<string, unknown>) {
    const eventId = this.env.uuid(); await this.box.addEvent({ eventId, type, occurredAt: new Date(this.env.now()).toISOString(), ...(assignmentId ? { assignmentId } : {}), ...(payload ? { payload } : {}) });
    const r = await this.sync.sync(); return { eventId, queued: !!this.box.events.find((e) => e.eventId === eventId && e.state === 'pending'), rejected: this.box.events.find((e) => e.eventId === eventId && e.state === 'rejected')?.rejection ?? null, sync: r };
  }
  start(assignmentId: string, location?: { lat: number; lon: number; accuracyM: number }) { return this.act('check_in', assignmentId, location ? { location } : undefined); }
  end(assignmentId: string, location?: { lat: number; lon: number; accuracyM: number }) { return this.act('check_out', assignmentId, location ? { location } : undefined); }
  breakStart(assignmentId: string) { return this.act('break_start', assignmentId); }
  breakEnd(assignmentId: string) { return this.act('break_end', assignmentId); }
  /** QR payload format: sf360:cp:<tagId>[:<rotating token>] */
  scan(qr: string, assignmentId?: string, location?: { lat: number; lon: number; accuracyM: number }) {
    const m = /^sf360:cp:([A-Za-z0-9_-]{4,80})(?::([A-Za-z0-9]{4,40}))?$/.exec(qr.trim()); if (!m) throw new Error('This is not a SmartForce 360 checkpoint code.');
    return this.act('scan', assignmentId, { tagId: m[1], ...(m[2] ? { token: m[2] } : {}), ...(location ? { location } : {}) });
  }
  incident(typeKey: string, description: string, opts: { severity?: string; location?: { lat: number; lon: number; accuracyM: number }; assignmentId?: string } = {}) { return this.act('incident', opts.assignmentId, { typeKey, description, ...(opts.severity ? { severity: opts.severity } : {}), ...(opts.location ? { location: opts.location } : {}) }); }
}

// ---------- SOS ----------
export type SosUiState = 'idle' | 'holding' | 'pending_offline' | 'sending' | 'received_by_server' | 'notified' | 'acknowledged_by_human' | 'failed';
/**
 * Press-and-hold SOS with honest status (FR-SOS-001/002): the UI shows only states the server has confirmed.
 * "Acknowledged" appears only after a person acknowledged; while offline the device says it is waiting to send,
 * and after the fallback time it shows the tenant's instructions (call the control room / local emergency number).
 */
export class SosController {
  state: SosUiState = 'idle'; eventId: string | null = null; triggeredAt: number | null = null; number: string | null = null; showFallback = false; fallback: { afterSec: number; instructions: Record<string, string> } = { afterSec: 90, instructions: {} };
  private holdTimer: any = null; onChange: () => void = () => {};
  constructor(private api: Api, private box: Outbox, private sync: SyncEngine, private env: Env, private holdSec = 2, private timers: { set(fn: () => void, ms: number): any; clear(h: any): void } = { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h) }) {}
  pressStart() { if (this.state !== 'idle') return; this.state = 'holding'; this.onChange(); this.holdTimer = this.timers.set(() => void this.trigger(), this.holdSec * 1000); }
  pressCancel() { if (this.state === 'holding') { this.timers.clear(this.holdTimer); this.state = 'idle'; this.onChange(); } }
  async trigger(location?: { lat: number; lon: number; accuracyM: number }, note?: string) {
    this.eventId = this.env.uuid(); this.triggeredAt = this.env.now(); this.showFallback = false;
    await this.box.addEvent({ eventId: this.eventId, type: 'sos', occurredAt: new Date(this.triggeredAt).toISOString(), payload: { ...(location ? { location } : {}), ...(note ? { note } : {}) } });
    this.state = this.sync.online ? 'sending' : 'pending_offline'; this.onChange();
    await this.sync.sync(); await this.refresh();
  }
  /** Poll while active: confirms delivery, resends via the queue if needed, and reveals fallback instructions on time. */
  async refresh() {
    if (!this.eventId) return;
    const queued = this.box.events.find((e) => e.eventId === this.eventId);
    if (queued && queued.state === 'pending') { this.state = this.sync.online && queued.attempts === 0 ? 'sending' : 'pending_offline'; }
    else {
      try { const s = await this.api.call('GET', `/sos/${this.eventId}/status`); this.state = s.deliveryState; this.number = s.number; this.fallback = s.fallback; }
      catch { if (this.state === 'sending') this.state = 'pending_offline'; }
    }
    if (this.state !== 'acknowledged_by_human' && this.triggeredAt && this.env.now() - this.triggeredAt >= this.fallback.afterSec * 1000) this.showFallback = true;
    this.onChange();
  }
  async requestCancel(reason: string) { if (this.eventId && this.state !== 'pending_offline') await this.api.call('POST', `/sos/${this.eventId}/cancel-request`, { reason }); }
  reset() { if (this.state === 'acknowledged_by_human') { this.state = 'idle'; this.eventId = null; this.showFallback = false; this.onChange(); } }
}

// ---------- location sampling policy ----------
/** Decides whether a fix should be recorded under the server-provided profile (moving vs stationary, distance filter, accuracy). */
export class Sampler {
  private last: { at: number; lat: number; lon: number } | null = null;
  constructor(public profile: { movingSec: number; stationarySec: number; minAccuracyM: number; distanceFilterM: number; paused?: boolean }) {}
  accept(fix: { at: number; lat: number; lon: number; accuracyM: number; speed?: number }): boolean {
    if (this.profile.paused) return false;
    if (!this.last) { this.last = fix; return true; }
    const dLat = (fix.lat - this.last.lat) * 111195, dLon = (fix.lon - this.last.lon) * 111195 * Math.cos((fix.lat * Math.PI) / 180); const moved = Math.hypot(dLat, dLon);
    const moving = (fix.speed ?? 0) > 0.8 || moved >= this.profile.distanceFilterM; const every = (moving ? this.profile.movingSec : this.profile.stationarySec) * 1000;
    if (fix.at - this.last.at < every) return false;
    this.last = fix; return true; // poor-accuracy fixes are still recorded with their accuracy; the server labels them
  }
}

/** Ed25519 raw public key (32 bytes) → SPKI PEM, so pure-JS signers can register with the server. */
export function ed25519RawToPem(raw: Uint8Array): string {
  const der = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, ...raw]);
  let b64 = ''; const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < der.length; i += 3) { const n = (der[i]! << 16) | ((der[i + 1] ?? 0) << 8) | (der[i + 2] ?? 0); b64 += A[(n >> 18) & 63]! + A[(n >> 12) & 63]! + (i + 1 < der.length ? A[(n >> 6) & 63] : '=') + (i + 2 < der.length ? A[n & 63] : '='); }
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}
