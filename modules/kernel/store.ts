// Persistence port, schema inventory and the in-memory / file adapters (TS §5, §7, §8).
// Modules never touch a Store directly: they go through TenantRepo (tenant-scoped) or PlatformRepo.
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError } from '@sf/contracts';

export type Doc = { _id: string; tenantId?: string | null; [k: string]: any };
export type Filter = Record<string, unknown>;
export interface FindOpts { sort?: Record<string, 1 | -1>; limit?: number; skip?: number }
export interface Update { $set?: Record<string, unknown>; $inc?: Record<string, number>; $push?: Record<string, unknown>; $unset?: string[] }

export interface CollectionDef {
  tenantOwned: boolean;
  unique?: string[][];   // each must start with tenantId for tenant-owned collections
  indexes?: string[][];
  immutable?: boolean;   // application code may insert and read only (TS §8.3)
  ttlField?: string;
}
const T = (unique: string[][] = [], indexes: string[][] = [], extra: Partial<CollectionDef> = {}): CollectionDef => ({
  tenantOwned: true, unique: unique.map((u) => ['tenantId', ...u]), indexes: [['tenantId'], ...indexes.map((i) => ['tenantId', ...i])], ...extra,
});
const P = (unique: string[][] = [], indexes: string[][] = []): CollectionDef => ({ tenantOwned: false, unique, indexes });

/** Schema inventory (TS §7.2). A start-up test fails if a tenant-owned collection lacks a tenantId-prefixed index. */
export const COLLECTIONS: Record<string, CollectionDef> = {
  // platform-level (not tenant-owned)
  tenants: P([['slug']], [['status']]),
  platform_users: P([['email']]),
  plans: P([['key']]),
  migration_log: P([['id']]),
  platform_sessions: P([['tokenHash']]),
  platform_audit_events: { tenantOwned: false, unique: [['seq']], indexes: [['occurredAt']], immutable: true },
  // identity, access, privacy
  tenant_setting_versions: T([['version']]),
  users: T([['username'], ['emailKey']]),
  memberships: T([['userId']], [['staffMemberId']]),
  roles: T([['name']]),
  sessions: T([['tokenHash']], [['userId', 'revokedAt'], ['familyId']], { ttlField: 'purgeAt' }),
  used_refresh_tokens: T([['tokenHash']], [], { ttlField: 'purgeAt' }),
  mfa_factors: T([['userId']]),
  invitations: T([['codeHash']], [['staffMemberId']], { ttlField: 'purgeAt' }),
  password_reset_tokens: T([['tokenHash']], [], { ttlField: 'purgeAt' }),
  login_challenges: T([['tokenHash']], [], { ttlField: 'purgeAt' }),
  privacy_notice_versions: T([['version']]),
  policy_acknowledgements: T([['staffMemberId', 'noticeVersion']]),
  support_access_grants: T([], [['expiresAt']]),
  label_sets: T([['key']]),
  // organisation and workforce
  organization_units: T([['codeKey']], [['parentId'], ['ancestorIds']]),
  staff_members: T([['employeeCode']], [['homeUnitId', 'status']]),
  teams: T([['unitId', 'name']]),
  team_memberships: T([['teamId', 'staffMemberId']]),
  posts: T([], [['unitId']]),
  devices: T([['publicKeyFingerprint']], [['staffMemberId', 'status']]),
  device_heartbeat_logs: T([], [['deviceId', 'at']], { ttlField: 'purgeAt' }),
  import_runs: T([['fileHash']]),
  // duty planning and attendance
  shifts: T([], [['status']]),
  shift_occurrences: T([['shiftId', 'startsAt']], [['startsAt']]),
  duty_assignments: T([['slotKey']], [['staffMemberId', 'startsAt'], ['status', 'startsAt'], ['postId', 'startsAt']]),
  assignment_history: T([], [['assignmentId']], { immutable: true }),
  roster_versions: T([['scopeKey', 'version']]),
  attendance_events: T([['eventId']], [['assignmentId', 'receivedAt']], { immutable: true }),
  correction_requests: T([], [['state', 'createdAt']]),
  duty_summaries: T([['assignmentId']]),
  // location, geofence, checkpoints
  duty_tracking_sessions: T([['openKey']], [['assignmentId']]),
  location_points: T([['deviceId', 'trackingSessionId', 'seq']], [['staffMemberId', 'recordedAt'], ['assignmentId', 'recordedAt']], { immutable: true, ttlField: 'expireAt' }),
  staff_location_states: T([['staffMemberId']], [['unitId', 'dutyDisplayState']]),
  location_access_log: T([], [['staffMemberId', 'at']], { immutable: true }),
  geofences: T([], [['postId', 'status']]),
  geofence_states: T([['assignmentId', 'geofenceId']]),
  geofence_events: T([], [['assignmentId', 'eventAt']], { immutable: true }),
  checkpoints: T([['tagId']], [['postId']]),
  checkpoint_expectations: T([['assignmentId', 'checkpointId', 'windowStart']], [['state', 'windowEnd']]),
  checkpoint_scans: T([['eventId']], [['assignmentId', 'receivedAt']], { immutable: true }),
  sync_rejections: T([['eventId']], [['staffMemberId']]),
  // alerts, incidents, notifications
  alert_rules: T([['type']]),
  escalation_policies: T([['name']]),
  alerts: T([['openDedupeKey']], [['state', 'severity', 'firstAt']]),
  alert_timeline: T([], [['alertId', 'at']], { immutable: true }),
  incidents: T([['number']], [['status', 'createdAt']]),
  incident_timeline: T([], [['incidentId', 'at']], { immutable: true }),
  sos_events: T([['eventId']], [['incidentId']]),
  notifications: T([['dedupeKey']], [['recipientUserId', 'createdAt']], { ttlField: 'expireAt' }),
  // files, audit, operations
  file_objects: T([['storageKey']]),
  audit_events: T([['seq']], [['occurredAt'], ['resourceType', 'resourceId']], { immutable: true }),
  subscriptions: T([['planScope']]),
  usage_snapshots: T([['period']]),
  legal_holds: T([], [['releasedAt']]),
  retention_runs: T([], [['startedAt']]),
  export_jobs: T([], [['requestedBy', 'createdAt']]),
  deletion_requests: T([['active']]),
  catalogue_entries: T([['kind', 'key']]),
  idempotency_records: T([['scope', 'key']], [], { ttlField: 'purgeAt' }),
  integration_configs: T([['kind']]),
  // infrastructure (tenantId nullable for platform events/jobs)
  outbox_events: { tenantOwned: false, indexes: [['state', 'createdAt']] },
  realtime_events: { tenantOwned: true, unique: [['tenantId', 'seq']], indexes: [['tenantId', 'seq']], ttlField: 'purgeAt' },
  jobs: { tenantOwned: false, unique: [['dedupeKey']], indexes: [['state', 'priority', 'runAt']] },
  counters: { tenantOwned: false, unique: [['tenantId', 'name', 'period']] },
};

export interface Store {
  readonly kind: string;
  insert(c: string, doc: Record<string, unknown>): Promise<Doc>;
  findOne(c: string, filter: Filter, opts?: FindOpts): Promise<Doc | null>;
  find(c: string, filter: Filter, opts?: FindOpts): Promise<Doc[]>;
  count(c: string, filter: Filter): Promise<number>;
  updateOne(c: string, filter: Filter, update: Update, opts?: { system?: boolean }): Promise<Doc | null>;
  updateMany(c: string, filter: Filter, update: Update, opts?: { system?: boolean }): Promise<number>;
  deleteMany(c: string, filter: Filter, opts?: { retention?: boolean }): Promise<number>;
  nextCounter(tenantId: string | null, name: string, period: string): Promise<number>;
  transaction<R>(fn: () => Promise<R>): Promise<R>;
  ready(): Promise<{ ok: boolean; detail: string }>;
  close(): Promise<void>;
}

export const newId = () => randomBytes(12).toString('hex');
export class DuplicateKeyError extends Error { constructor(readonly collection: string, readonly index: string[]) { super(`duplicate key on ${collection} (${index.join(',')})`); } }

// ---------- filter / update semantics shared by adapters (a strict subset of MongoDB's) ----------
const getPath = (d: any, path: string): unknown => path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), d);
function setPath(d: any, path: string, v: unknown) {
  const ks = path.split('.'); let o = d;
  for (let i = 0; i < ks.length - 1; i++) { if (typeof o[ks[i]!] !== 'object' || o[ks[i]!] === null) o[ks[i]!] = {}; o = o[ks[i]!]; }
  if (v === undefined) delete o[ks[ks.length - 1]!]; else o[ks[ks.length - 1]!] = v;
}
const eq = (field: unknown, v: unknown) => (Array.isArray(field) ? field.includes(v) : field === v || (field === undefined && v === null));
export function matches(doc: Doc, filter: Filter): boolean {
  for (const [k, cond] of Object.entries(filter)) {
    if (k === '$or') { if (!(cond as Filter[]).some((f) => matches(doc, f))) return false; continue; }
    const val = getPath(doc, k);
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      for (const [op, x] of Object.entries(cond as Record<string, any>)) {
        switch (op) {
          case '$in': if (!(x as unknown[]).some((y) => eq(val, y))) return false; break;
          case '$nin': if ((x as unknown[]).some((y) => eq(val, y))) return false; break;
          case '$ne': if (eq(val, x)) return false; break;
          case '$gt': if (!(val !== undefined && val !== null && (val as number) > x)) return false; break;
          case '$gte': if (!(val !== undefined && val !== null && (val as number) >= x)) return false; break;
          case '$lt': if (!(val !== undefined && val !== null && (val as number) < x)) return false; break;
          case '$lte': if (!(val !== undefined && val !== null && (val as number) <= x)) return false; break;
          case '$exists': if ((val !== undefined && val !== null) !== x) return false; break;
          default: throw new Error(`unsupported filter operator ${op}`);
        }
      }
    } else if (!eq(val, cond)) return false;
  }
  return true;
}
export function applyUpdate(doc: Doc, u: Update): Doc {
  const d = structuredClone(doc);
  for (const [k, v] of Object.entries(u.$set ?? {})) setPath(d, k, v);
  for (const [k, v] of Object.entries(u.$inc ?? {})) setPath(d, k, (Number(getPath(d, k)) || 0) + v);
  for (const [k, v] of Object.entries(u.$push ?? {})) setPath(d, k, [...((getPath(d, k) as unknown[]) ?? []), v]);
  for (const k of u.$unset ?? []) setPath(d, k, undefined);
  return d;
}
function sortDocs(docs: Doc[], sort?: Record<string, 1 | -1>): Doc[] {
  if (!sort) return docs;
  const keys = Object.entries(sort);
  return docs.sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = getPath(a, k) as any, y = getPath(b, k) as any;
      if (x === y) continue;
      if (x === undefined || x === null) return -dir; if (y === undefined || y === null) return dir;
      return x < y ? -dir : dir;
    }
    return 0;
  });
}

// ---------- in-memory adapter (tests, and the base of the file adapter) ----------
type Undo = { c: string; id: string; prev: Doc | undefined };
export class MemoryStore implements Store {
  readonly kind: string = 'memory';
  protected data = new Map<string, Map<string, Doc>>();
  private uniq = new Map<string, Map<string, string>>(); // `${collection}#${fields}` -> key -> id
  private als = new AsyncLocalStorage<{ undo: Undo[] }>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor() { for (const c of Object.keys(COLLECTIONS)) this.data.set(c, new Map()); }
  private col(c: string) { const m = this.data.get(c); if (!m) throw new Error(`unknown collection ${c}`); return m; }
  private ukey(doc: Doc, fields: string[]): string | null {
    const vals = fields.map((f) => getPath(doc, f));
    if (vals.some((v, i) => (v === undefined || v === null) && fields[i] !== 'tenantId')) return null; // sparse
    return JSON.stringify(vals);
  }
  private uidx(c: string, fields: string[]) {
    const name = `${c}#${fields.join(',')}`; let m = this.uniq.get(name);
    if (!m) { m = new Map(); this.uniq.set(name, m); }
    return m;
  }
  private put(c: string, doc: Doc, prev: Doc | undefined) {
    const def = COLLECTIONS[c]!;
    for (const fields of def.unique ?? []) {
      const k = this.ukey(doc, fields);
      if (k !== null) { const owner = this.uidx(c, fields).get(k); if (owner && owner !== doc._id) throw new DuplicateKeyError(c, fields); }
    }
    if (prev) this.unindex(c, prev);
    for (const fields of def.unique ?? []) { const k = this.ukey(doc, fields); if (k !== null) this.uidx(c, fields).set(k, doc._id); }
    this.col(c).set(doc._id, doc);
    this.als.getStore()?.undo.push({ c, id: doc._id, prev });
    this.changed();
  }
  private unindex(c: string, doc: Doc) {
    for (const fields of COLLECTIONS[c]!.unique ?? []) { const k = this.ukey(doc, fields); if (k !== null && this.uidx(c, fields).get(k) === doc._id) this.uidx(c, fields).delete(k); }
  }
  private remove(c: string, doc: Doc) {
    this.unindex(c, doc); this.col(c).delete(doc._id);
    this.als.getStore()?.undo.push({ c, id: doc._id, prev: doc }); this.changed();
  }
  protected changed(): void { /* file adapter schedules a snapshot */ }
  private scan(c: string, filter: Filter): Doc[] {
    const m = this.col(c);
    if (typeof filter._id === 'string') { const d = m.get(filter._id); return d && matches(d, filter) ? [d] : []; }
    for (const fields of COLLECTIONS[c]!.unique ?? []) { // point lookup through a fully specified unique index
      if (fields.every((f) => filter[f] !== undefined && (typeof filter[f] !== 'object' || filter[f] === null))) {
        const id = this.uidx(c, fields).get(JSON.stringify(fields.map((f) => filter[f])));
        const d = id ? m.get(id) : undefined;
        return d && matches(d, filter) ? [d] : [];
      }
    }
    const out: Doc[] = [];
    for (const d of m.values()) if (matches(d, filter)) out.push(d);
    return out;
  }
  /** Serialises writers: single writes and transactions never interleave. */
  private exclusive<R>(fn: () => Promise<R>): Promise<R> {
    if (this.als.getStore()) return fn();
    const run = this.chain.then(() => this.als.run({ undo: [] }, async () => {
      const ctx = this.als.getStore()!;
      try { return await fn(); } catch (e) {
        for (const u of ctx.undo.reverse()) {
          const cur = this.col(u.c).get(u.id);
          if (cur) { this.unindex(u.c, cur); this.col(u.c).delete(u.id); }
          if (u.prev) { this.col(u.c).set(u.id, u.prev); for (const f of COLLECTIONS[u.c]!.unique ?? []) { const k = this.ukey(u.prev, f); if (k !== null) this.uidx(u.c, f).set(k, u.id); } }
        }
        throw e;
      }
    }));
    this.chain = run.catch(() => undefined);
    return run;
  }
  transaction<R>(fn: () => Promise<R>): Promise<R> { return this.exclusive(fn); }

  async insert(c: string, doc: Record<string, unknown>): Promise<Doc> {
    return this.exclusive(async () => {
      const d = structuredClone({ ...doc, _id: (doc._id as string) ?? newId() }) as Doc;
      if (this.col(c).has(d._id)) throw new DuplicateKeyError(c, ['_id']);
      this.put(c, d, undefined);
      return structuredClone(d);
    });
  }
  async findOne(c: string, filter: Filter, opts?: FindOpts) { return (await this.find(c, filter, { ...opts, limit: 1 }))[0] ?? null; }
  async find(c: string, filter: Filter, opts: FindOpts = {}) {
    let docs = sortDocs(this.scan(c, filter), opts.sort);
    if (opts.skip) docs = docs.slice(opts.skip);
    if (opts.limit !== undefined) docs = docs.slice(0, opts.limit);
    return docs.map((d) => structuredClone(d));
  }
  async count(c: string, filter: Filter) { return this.scan(c, filter).length; }
  private guard(c: string, system?: boolean) {
    if (COLLECTIONS[c]!.immutable && !system) throw new Error(`collection ${c} is append-only: updates are not permitted`);
  }
  async updateOne(c: string, filter: Filter, update: Update, opts: { system?: boolean } = {}) {
    this.guard(c, opts.system);
    return this.exclusive(async () => {
      const cur = this.scan(c, filter)[0]; if (!cur) return null;
      const next = applyUpdate(cur, update); next._id = cur._id;
      this.put(c, next, cur);
      return structuredClone(next);
    });
  }
  async updateMany(c: string, filter: Filter, update: Update, opts: { system?: boolean } = {}) {
    this.guard(c, opts.system);
    return this.exclusive(async () => {
      const docs = this.scan(c, filter);
      for (const cur of docs) { const next = applyUpdate(cur, update); next._id = cur._id; this.put(c, next, cur); }
      return docs.length;
    });
  }
  async deleteMany(c: string, filter: Filter, opts: { retention?: boolean } = {}) {
    if (COLLECTIONS[c]!.immutable && !opts.retention) throw new Error(`collection ${c} is append-only: deletes need the retention role`);
    return this.exclusive(async () => { const docs = this.scan(c, filter); for (const d of docs) this.remove(c, d); return docs.length; });
  }
  async nextCounter(tenantId: string | null, name: string, period: string) {
    return this.exclusive(async () => {
      const cur = this.scan('counters', { tenantId, name, period })[0];
      if (!cur) { this.put('counters', { _id: newId(), tenantId, name, period, value: 1 }, undefined); return 1; }
      const next = { ...cur, value: cur.value + 1 }; this.put('counters', next, cur); return next.value as number;
    });
  }
  async ready() { return { ok: true, detail: `${this.kind} store` }; }
  async close() { /* nothing */ }
  /** Test/backup helpers */
  dump(): Record<string, Doc[]> { return Object.fromEntries([...this.data].map(([c, m]) => [c, [...m.values()].map((d) => structuredClone(d))])); }
  load(snapshot: Record<string, Doc[]>) {
    for (const m of this.data.values()) m.clear(); this.uniq.clear();
    for (const [c, docs] of Object.entries(snapshot)) { if (!this.data.has(c)) continue; for (const d of docs) { this.col(c).set(d._id, d); for (const f of COLLECTIONS[c]!.unique ?? []) { const k = this.ukey(d, f); if (k !== null) this.uidx(c, f).set(k, d._id); } } }
  }
}

/** Single-node durable adapter for local development and demos: MemoryStore + atomic JSON snapshots. Not for multi-process use. */
export class FileStore extends MemoryStore {
  override readonly kind = 'file';
  private timer: NodeJS.Timeout | null = null;
  private file: string;
  constructor(dir: string) {
    super();
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'smartforce360.db.json');
    if (existsSync(this.file)) this.load(JSON.parse(readFileSync(this.file, 'utf8')));
  }
  protected override changed() { if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 200); this.timer.unref?.(); } }
  flush() { const tmp = this.file + '.tmp'; writeFileSync(tmp, JSON.stringify(this.dump())); renameSync(tmp, this.file); }
  override async close() { if (this.timer) clearTimeout(this.timer); this.flush(); }
  override async ready() { return { ok: true, detail: `file store at ${this.file}` }; }
}

// ---------- tenant-scoped repository layer (TS §5.2) ----------
export class ScopedCollection {
  constructor(private store: Store, readonly name: string, private tenantId: string) {
    const def = COLLECTIONS[name];
    if (!def) throw new Error(`unknown collection ${name}`);
    if (!def.tenantOwned) throw new Error(`collection ${name} is not tenant-owned; use the platform repository`);
    if (!tenantId) throw new Error('tenant-scoped repository used without a tenantId');
  }
  private f(filter: Filter = {}): Filter { return { ...filter, tenantId: this.tenantId }; }
  insert(doc: Record<string, unknown>) { return this.store.insert(this.name, { ...doc, tenantId: this.tenantId }); }
  get(id: string) { return this.store.findOne(this.name, this.f({ _id: id })); }
  async must(id: string, what = 'Resource'): Promise<Doc> { const d = await this.get(id); if (!d) throw new AppError('NOT_FOUND', `${what} not found`); return d; }
  findOne(filter: Filter, opts?: FindOpts) { return this.store.findOne(this.name, this.f(filter), opts); }
  find(filter: Filter = {}, opts?: FindOpts) { return this.store.find(this.name, this.f(filter), opts); }
  count(filter: Filter = {}) { return this.store.count(this.name, this.f(filter)); }
  update(id: string, update: Update) { return this.store.updateOne(this.name, this.f({ _id: id }), update); }
  updateWhere(filter: Filter, update: Update) { return this.store.updateOne(this.name, this.f(filter), update); }
  updateMany(filter: Filter, update: Update) { return this.store.updateMany(this.name, this.f(filter), update); }
  /** Optimistic concurrency (TS §8.5): conditional update on version, 409 with the current version on mismatch. */
  async updateVersioned(id: string, expectedVersion: number | undefined, set: Record<string, unknown>): Promise<Doc> {
    const filter = expectedVersion === undefined ? { _id: id } : { _id: id, version: expectedVersion };
    const out = await this.store.updateOne(this.name, this.f(filter), { $set: set, $inc: { version: 1 } });
    if (out) return out;
    const cur = await this.get(id);
    if (!cur) throw new AppError('NOT_FOUND', 'Resource not found');
    throw new AppError('VERSION_CONFLICT', 'The record was changed by someone else. Reload and try again.', { details: { currentVersion: cur.version } });
  }
  delete(filter: Filter, opts?: { retention?: boolean }) { return this.store.deleteMany(this.name, this.f(filter), opts); }
}
export class TenantRepo {
  constructor(private store: Store, readonly tenantId: string) { if (!tenantId) throw new Error('TenantRepo requires a tenantId'); }
  col(name: string) { return new ScopedCollection(this.store, name, this.tenantId); }
  counter(name: string, period = '') { return this.store.nextCounter(this.tenantId, name, period); }
}
