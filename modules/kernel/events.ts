// Outbox relay, durable job queue and realtime hub (TS §10, §20).
// Business writes insert outbox rows and jobs in the same transaction as the change; the relay and worker run after commit.
import type { RealtimeEnvelope, RealtimeEventType } from '@sf/contracts';
import { canonicalJson } from '@sf/domain/node';
import { type Doc, type Store, newId } from './store.ts';
import { type Clock, type Logger, type Metrics, hmacHex, safeEqual } from './util.ts';

export interface EventScope { unitId?: string | null; staffId?: string | null; userId?: string | null; needs?: string; all?: boolean }

// ---------- queue port ----------
export const QUEUE_PRIORITY = { critical: 0, alerts: 1, notifications: 2, derived: 3, scheduled: 4, reports: 5, retention: 6 } as const;
export type QueueName = keyof typeof QUEUE_PRIORITY;
export interface JobHandlerCtx { tenantId: string | null; attempt: number; jobId: string }
export type JobHandler = (payload: any, ctx: JobHandlerCtx) => Promise<void>;
export interface EnqueueOpts { delaySec?: number; queue?: QueueName; dedupeKey?: string; maxAttempts?: number }

export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  constructor(private store: Store, private clock: Clock, private hmacKey: string, private log: Logger, private metrics: Metrics) {}
  register(type: string, handler: JobHandler) { this.handlers.set(type, handler); }
  private sig(tenantId: string | null, type: string, payload: unknown) { return hmacHex(this.hmacKey, `${tenantId ?? ''}|${type}|${canonicalJson(payload)}`); }

  /** Called inside the business transaction. Payloads are signed so tampering in the queue store is detected (TS §5.7). */
  async enqueue(tenantId: string | null, type: string, payload: Record<string, unknown>, opts: EnqueueOpts = {}): Promise<void> {
    if (opts.dedupeKey && (await this.store.findOne('jobs', { dedupeKey: opts.dedupeKey }))) return;
    await this.store.insert('jobs', {
      tenantId, type, payload, sig: this.sig(tenantId, type, payload), state: 'queued', attempts: 0, maxAttempts: opts.maxAttempts ?? 5,
      priority: QUEUE_PRIORITY[opts.queue ?? 'derived'], queue: opts.queue ?? 'derived', runAt: this.clock.now() + (opts.delaySec ?? 0) * 1000,
      createdAt: this.clock.now(), ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
    });
  }
  /** Runs due jobs in priority order. Critical queues are always drained before reports and retention. */
  async tick(max = 200): Promise<number> {
    const due = await this.store.find('jobs', { state: 'queued', runAt: { $lte: this.clock.now() } }, { sort: { priority: 1, runAt: 1, createdAt: 1 }, limit: max });
    let done = 0;
    for (const job of due) {
      const claimed = await this.store.updateOne('jobs', { _id: job._id, state: 'queued' }, { $set: { state: 'running', startedAt: this.clock.now() }, $inc: { attempts: 1 } });
      if (!claimed) continue;
      const handler = this.handlers.get(job.type);
      try {
        if (!safeEqual(this.sig(job.tenantId ?? null, job.type, job.payload), String(job.sig))) throw new PoisonJob('job payload signature mismatch');
        if (!handler) throw new PoisonJob(`no handler for job type ${job.type}`);
        await handler(job.payload, { tenantId: job.tenantId ?? null, attempt: claimed.attempts, jobId: job._id });
        await this.store.updateOne('jobs', { _id: job._id }, { $set: { state: 'done', finishedAt: this.clock.now() }, $unset: ['dedupeKey'] });
        this.metrics.inc('sf_jobs_total', { type: job.type, result: 'done' });
        this.metrics.observe('sf_job_lateness_ms', { queue: job.queue }, Math.max(0, claimed.startedAt - job.runAt));
        done++;
      } catch (e) {
        const dead = e instanceof PoisonJob || claimed.attempts >= job.maxAttempts;
        const backoff = Math.min(15 * 60, 2 ** claimed.attempts) * 1000;
        await this.store.updateOne('jobs', { _id: job._id }, { $set: { state: dead ? 'dead' : 'queued', runAt: this.clock.now() + backoff, lastError: String((e as Error).message).slice(0, 300) } });
        this.metrics.inc('sf_jobs_total', { type: job.type, result: dead ? 'dead' : 'retry' });
        this.log[dead ? 'error' : 'warn']('job failed', { jobId: job._id, type: job.type, attempts: claimed.attempts, dead, error: (e as Error).message });
      }
    }
    return done;
  }
  /** Jobs left "running" by a crashed worker are returned to the queue (handlers are idempotent). */
  async recoverStuck(olderThanMs = 60000) {
    return this.store.updateMany('jobs', { state: 'running', startedAt: { $lt: this.clock.now() - olderThanMs } }, { $set: { state: 'queued' } });
  }
  async stats() {
    const [queued, dead, running] = await Promise.all([this.store.find('jobs', { state: 'queued' }, { sort: { runAt: 1 }, limit: 5000 }), this.store.count('jobs', { state: 'dead' }), this.store.count('jobs', { state: 'running' })]);
    const dueNow = queued.filter((j) => j.runAt <= this.clock.now());
    return { queued: queued.length, due: dueNow.length, running, dead, oldestDueAgeMs: dueNow.length ? this.clock.now() - dueNow[0]!.runAt : 0 };
  }
  async purgeDone(olderThanMs = 24 * 3600000) { return this.store.deleteMany('jobs', { state: 'done', finishedAt: { $lt: this.clock.now() - olderThanMs } }); }
}
export class PoisonJob extends Error {}

// ---------- realtime hub ----------
export interface Subscriber {
  id: string; tenantId: string; userId: string; staffId: string | null; units: '*' | Set<string>; permissions: Set<string>;
  send(env: RealtimeEnvelope): void; lastLocationAt: Map<string, number>;
}
const COORD_EVENTS = new Set<string>(['location:updated']);
export class RealtimeHub {
  private subs = new Map<string, Subscriber>();
  constructor(private clock: Clock, private metrics: Metrics) { metrics.gauge('sf_realtime_connections', () => this.subs.size); }
  /** Rooms are computed by the server from the actor's scope; clients cannot name rooms (TS §5.6). */
  subscribe(sub: Omit<Subscriber, 'id' | 'lastLocationAt'>): { id: string; close(): void; update(p: Partial<Subscriber>): void } {
    const id = newId(); const full: Subscriber = { ...sub, id, lastLocationAt: new Map() };
    this.subs.set(id, full);
    return { id, close: () => this.subs.delete(id), update: (p) => Object.assign(full, p) };
  }
  count(tenantId?: string) { return tenantId ? [...this.subs.values()].filter((s) => s.tenantId === tenantId).length : this.subs.size; }
  static visible(sub: Pick<Subscriber, 'tenantId' | 'userId' | 'staffId' | 'units' | 'permissions'>, tenantId: string, scope: EventScope): boolean {
    if (sub.tenantId !== tenantId) return false;
    if (scope.userId) return scope.userId === sub.userId;
    if (scope.staffId && scope.staffId === sub.staffId) return true;
    if (scope.needs && !sub.permissions.has(scope.needs)) return false;
    if (!scope.needs) return false; // events without a permission requirement are addressed to a user/staff only
    if (sub.units === '*' || scope.all) return true;
    return !!scope.unitId && sub.units.has(scope.unitId);
  }
  /** Coordinates are sent only to roles holding location.live.read (TS §10.3). */
  static shape(sub: Pick<Subscriber, 'permissions'>, env: RealtimeEnvelope): RealtimeEnvelope {
    if (sub.permissions.has('location.live.read')) return env;
    const { lat: _a, lon: _b, accuracyM: _c, ...rest } = env.payload as Record<string, unknown>;
    return { ...env, payload: rest };
  }
  publish(env: RealtimeEnvelope & { scope: EventScope }) {
    for (const sub of this.subs.values()) {
      if (!RealtimeHub.visible(sub, env.tenantId, env.scope)) continue;
      if (COORD_EVENTS.has(env.type)) { // coalesce to ≤ 1 per staff member per second; SOS and alert events are never dropped
        const key = String(env.payload.staffMemberId), last = sub.lastLocationAt.get(key) ?? 0;
        if (this.clock.now() - last < 1000) { this.metrics.inc('sf_realtime_coalesced_total'); continue; }
        sub.lastLocationAt.set(key, this.clock.now());
      }
      try { sub.send(RealtimeHub.shape(sub, env)); this.metrics.inc('sf_realtime_sent_total', { type: env.type }); } catch { this.subs.delete(sub.id); }
    }
  }
}

// ---------- outbox ----------
export type EventConsumer = (event: Doc) => Promise<void>;
export class Outbox {
  private consumers = new Map<string, EventConsumer[]>();
  constructor(private store: Store, private clock: Clock, private hub: RealtimeHub, private log: Logger, private metrics: Metrics) {}
  on(type: string, fn: EventConsumer) { this.consumers.set(type, [...(this.consumers.get(type) ?? []), fn]); }
  async add(tenantId: string | null, type: RealtimeEventType | string, scope: EventScope, payload: Record<string, unknown>, occurredAt?: number) {
    await this.store.insert('outbox_events', { tenantId, type, scope, payload, state: 'pending', attempts: 0, occurredAt: occurredAt ?? this.clock.now(), createdAt: this.clock.now() });
  }
  /** Publishes committed events in order, assigning a per-tenant sequence so clients can detect gaps and catch up. */
  async relay(max = 500): Promise<number> {
    const pending = await this.store.find('outbox_events', { state: 'pending' }, { sort: { createdAt: 1, _id: 1 }, limit: max });
    for (const ev of pending) {
      try {
        if (ev.tenantId && ev.type.includes(':')) {
          const seq = await this.store.nextCounter(ev.tenantId, 'realtime_seq', '');
          const env = { eventId: ev._id, type: ev.type, version: 1 as const, tenantId: ev.tenantId, scope: ev.scope, occurredAt: new Date(ev.occurredAt).toISOString(), emittedAt: new Date(this.clock.now()).toISOString(), seq, payload: ev.payload };
          await this.store.insert('realtime_events', { ...env, _id: ev._id, at: this.clock.now(), purgeAt: this.clock.now() + 15 * 60000 });
          this.hub.publish(env as RealtimeEnvelope & { scope: EventScope });
          this.metrics.observe('sf_realtime_fanout_ms', {}, this.clock.now() - ev.createdAt);
        }
        for (const c of this.consumers.get(ev.type) ?? []) await c(ev);
        await this.store.updateOne('outbox_events', { _id: ev._id }, { $set: { state: 'done', doneAt: this.clock.now() } });
      } catch (e) {
        const attempts = (ev.attempts ?? 0) + 1;
        await this.store.updateOne('outbox_events', { _id: ev._id }, { $set: { state: attempts >= 10 ? 'dead' : 'pending', attempts, lastError: String((e as Error).message).slice(0, 300) } });
        this.log.error('outbox relay failed', { eventId: ev._id, type: ev.type, attempts, error: (e as Error).message });
        if (attempts < 10) break; // keep ordering: retry this event before later ones
      }
    }
    return pending.length;
  }
  async purge() {
    const now = this.clock.now();
    await this.store.deleteMany('outbox_events', { state: 'done', doneAt: { $lt: now - 3600000 } });
    await this.store.deleteMany('realtime_events', { purgeAt: { $lt: now } });
  }
}
