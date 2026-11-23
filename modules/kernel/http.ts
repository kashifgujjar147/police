// HTTP kernel: route registry with mandatory metadata, authentication, tenant context, authorisation,
// validation, idempotency, transactions and audit (TS §5, §6.3, §9.1, §18). Every request passes through here.
import { AppError, DEFAULT_SETTINGS, type ErrorCode, type Schema, type TenantSettings, type TenantStatus, validate } from '@sf/contracts';
import type { AppConfig } from '@sf/config';
import { chainHash } from '@sf/domain/node';
import { compareVersions } from '@sf/domain';
import { type Doc, type Filter, type Store, TenantRepo, DuplicateKeyError } from './store.ts';
import {
  type Clock, type JwtKey, type Logger, Metrics, type PasswordHasher, RateLimiter, type RateClass, deepMerge, deviceSigningString,
  fieldCrypto, loadJwtKey, sha256, uuid, verifyDeviceSignature, verifyJwt,
} from './util.ts';
import { type EnqueueOpts, type EventScope, JobQueue, Outbox, RealtimeHub } from './events.ts';

export interface Req { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; rawBody: string; ip: string; rawBuffer?: Buffer }
export interface Res { status: number; headers: Record<string, string | string[]>; body?: unknown; raw?: Buffer | string; stream?: (write: (chunk: string) => boolean, onClose: (fn: () => void) => void) => void }
export class Reply { constructor(readonly status: number, readonly body: unknown, readonly headers: Record<string, string | string[]> = {}) {} }
export const created = (body: unknown) => new Reply(201, body);

export interface Actor {
  type: 'anonymous' | 'user' | 'platform' | 'support' | 'system';
  userId: string; membershipId?: string; staffMemberId?: string | null; roleKeys: string[];
  permissions: Set<string>; scopeUnitIds: '*' | string[]; assignedUnitIds: string[];
  sessionId?: string; deviceId?: string | null; platformRoles?: string[]; grantId?: string;
}
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface Route<B = any, Q = any> {
  method: Method; path: string;
  /** 'public' | 'session' (any signed-in tenant user) | 'platform-session' | a permission key */
  permission: string;
  /** How the handler limits data: declared for every route and checked by the route-metadata test. */
  scope: 'none' | 'tenant' | 'unit' | 'own' | 'platform';
  /** Audit action key, or an explicit justification for not auditing (FR-AUD-001). */
  audit: string | { none: string };
  rate: RateClass;
  summary: string; reqs?: string[];
  body?: Schema<B>; query?: Schema<Q>;
  deviceBound?: boolean; idempotent?: boolean; tx?: boolean; raw?: boolean;
  /** Binary upload route: body is passed as req.rawBuffer and not parsed as JSON. */
  binaryMaxBytes?: number;
  /** Allowance when the tenant is not Active/Trial: 'safety' (SOS, check-out), 'owner' (export / deletion), 'read'. */
  whenInactive?: 'safety' | 'owner' | 'read';
  handler(ctx: Ctx, input: { body: B; query: Q; params: Record<string, string>; req: Req }): Promise<unknown>;
}
interface Compiled extends Route { module: string; regex: RegExp; keys: string[] }

const SECRET_FIELDS = new Set(['passwordHash', 'tokenHash', 'codeHash', 'secretEnc', 'recoveryCodes', 'configEncrypted', 'tagSecretEnc', 'pushTokenEnc', 'sig', 'publicKey', 'openKey', 'openDedupeKey', 'slotKey', 'emailKey', 'codeKey', 'purgeAt', 'contactEnc', 'storageKey']);
const TS_FIELD = /(At|Until)$|^(at|since|windowStart|windowEnd|effectiveFrom|activeFrom|activeTo|periodStart|periodEnd|effectiveTime)$/;
/** Converts stored documents to API shape: ids, ISO-8601 UTC timestamps, and never any secret material. */
export function toApi(v: unknown, key = ''): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => toApi(x, key));
  if (typeof v === 'number') return TS_FIELD.test(key) && v > 1e11 ? new Date(v).toISOString() : v;
  if (typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (SECRET_FIELDS.has(k)) continue;
    out[k === '_id' ? 'id' : k] = toApi(x, k);
  }
  return out;
}

export interface AuditInput { action: string; resource: { type: string; id?: string | null }; outcome?: 'success' | 'denied' | 'failed'; reason?: string | null; before?: unknown; after?: unknown; detail?: Record<string, unknown> }

export class Ctx {
  auditTarget: Partial<AuditInput> | null = null;
  device: Doc | null = null;
  session: Doc | null = null;
  private _repo: TenantRepo | null = null;
  constructor(readonly app: App, public tenantId: string, public tenant: Doc | null, public settings: TenantSettings, public actor: Actor, readonly requestId: string, readonly ip: string, readonly req: Req | null) {}
  now() { return this.app.clock.now(); }
  get repo(): TenantRepo { if (!this._repo) { if (!this.tenantId) throw new Error('no tenant bound to this request'); this._repo = new TenantRepo(this.app.store, this.tenantId); } return this._repo; }
  col(name: string) { return this.repo.col(name); }
  /** Bind a tenant resolved by a public route (login, activation). */
  bindTenant(tenant: Doc, settings: TenantSettings) { this.tenantId = tenant._id; this.tenant = tenant; this.settings = settings; this._repo = null; }
  can(permission: string) { return this.actor.permissions.has(permission); }
  need(permission: string) { if (!this.can(permission)) throw new AppError('FORBIDDEN', 'You do not have permission to do this.'); }
  get tenantWide() { return this.actor.scopeUnitIds === '*'; }
  inScope(unitId: string | null | undefined): boolean { return this.actor.scopeUnitIds === '*' || (!!unitId && this.actor.scopeUnitIds.includes(unitId)); }
  /** Out-of-scope resources are reported as missing, not forbidden, to avoid enumeration (PRD §6). */
  assertScope(unitId: string | null | undefined, what = 'Resource') { if (!this.inScope(unitId)) throw new AppError('NOT_FOUND', `${what} not found`); }
  scopeFilter(field = 'unitId'): Filter { return this.actor.scopeUnitIds === '*' ? {} : { [field]: { $in: this.actor.scopeUnitIds } }; }
  setAudit(t: Partial<AuditInput>) { this.auditTarget = { ...this.auditTarget, ...t }; }
  audit(input: AuditInput) { return this.app.writeAudit(this, input); }
  emit(type: string, scope: EventScope, payload: Record<string, unknown>, occurredAt?: number) { return this.app.outbox.add(this.tenantId, type, scope, payload, occurredAt); }
  enqueue(type: string, payload: Record<string, unknown>, opts?: EnqueueOpts) { return this.app.jobs.enqueue(this.tenantId, type, payload, opts); }
}

const ANON: Actor = { type: 'anonymous', userId: '', roleKeys: [], permissions: new Set(), scopeUnitIds: [], assignedUnitIds: [] };
export const systemActor = (job: string): Actor => ({ type: 'system', userId: `system:${job}`, roleKeys: [], permissions: new Set(), scopeUnitIds: '*', assignedUnitIds: [] });

export interface AppDeps { store: Store; clock: Clock; config: AppConfig; logger: Logger; hasher: PasswordHasher }
export class App {
  readonly store: Store; readonly clock: Clock; readonly config: AppConfig; readonly log: Logger; readonly hasher: PasswordHasher;
  readonly metrics = new Metrics();
  readonly rate: RateLimiter; readonly hub: RealtimeHub; readonly outbox: Outbox; readonly jobs: JobQueue;
  readonly crypto: ReturnType<typeof fieldCrypto>; readonly jwtKeys: JwtKey[]; readonly signingKey: JwtKey;
  readonly routes: Compiled[] = [];
  readonly schedulers: { name: string; everySec: number; run: (tenant: Doc) => Promise<void>; perTenant: boolean; last: number }[] = [];
  readonly services: Record<string, any> = {};
  private settingsCache = new Map<string, { version: number; settings: TenantSettings }>();
  private pumping: Promise<void> | null = null;

  constructor(deps: AppDeps) {
    this.store = deps.store; this.clock = deps.clock; this.config = deps.config; this.log = deps.logger; this.hasher = deps.hasher;
    this.rate = new RateLimiter(this.clock, deps.config.rateLimits);
    this.hub = new RealtimeHub(this.clock, this.metrics);
    this.outbox = new Outbox(this.store, this.clock, this.hub, this.log, this.metrics);
    this.jobs = new JobQueue(this.store, this.clock, deps.config.jobHmacKey, this.log, this.metrics);
    this.crypto = fieldCrypto(deps.config.fieldEncKey);
    this.jwtKeys = deps.config.jwtKeys.map(loadJwtKey);
    this.signingKey = this.jwtKeys.find((k) => k.kid === deps.config.activeKid)!;
  }

  // ----- registration -----
  register(module: string, routes: Route[]) {
    for (const r of routes) {
      const keys: string[] = [];
      const regex = new RegExp('^' + r.path.replace(/:([A-Za-z]+)/g, (_m, k) => { keys.push(k); return '([A-Za-z0-9_.-]{1,80})'; }) + '$');
      if (this.routes.some((x) => x.method === r.method && x.path === r.path)) throw new Error(`duplicate route ${r.method} ${r.path}`);
      this.routes.push({ ...r, module, regex, keys });
    }
  }
  schedule(name: string, everySec: number, run: (tenant: Doc) => Promise<void>, perTenant = true) { this.schedulers.push({ name, everySec, run, perTenant, last: 0 }); }
  tenantRepo(tenantId: string) { return new TenantRepo(this.store, tenantId); }
  systemCtx(tenant: Doc, job: string, settings?: TenantSettings): Ctx { return new Ctx(this, tenant._id, tenant, settings ?? DEFAULT_SETTINGS, systemActor(job), `job-${uuid()}`, '', null); }
  async systemCtxFor(tenantId: string, job: string): Promise<Ctx | null> {
    const tenant = await this.store.findOne('tenants', { _id: tenantId }); if (!tenant) return null;
    return this.systemCtx(tenant, job, await this.settingsFor(tenant));
  }

  async settingsFor(tenant: Doc): Promise<TenantSettings> {
    const hit = this.settingsCache.get(tenant._id);
    if (hit && hit.version === tenant.settingsVersion) return hit.settings;
    const doc = await this.store.findOne('tenant_setting_versions', { tenantId: tenant._id, version: tenant.settingsVersion });
    const settings = deepMerge(DEFAULT_SETTINGS, doc?.settings ?? {});
    this.settingsCache.set(tenant._id, { version: tenant.settingsVersion, settings });
    return settings;
  }

  // ----- audit: append-only, per-tenant hash chain (TS §18) -----
  async writeAudit(ctx: Ctx | null, input: AuditInput, platform?: { actor: Actor; requestId: string; ip: string }) {
    const tenantId = ctx?.tenantId || null;
    const actor = ctx?.actor ?? platform?.actor ?? ANON;
    const collection = tenantId ? 'audit_events' : 'platform_audit_events';
    const seq = await this.store.nextCounter(tenantId, 'audit_seq', '');
    const prev = await this.store.findOne(collection, tenantId ? { tenantId, seq: seq - 1 } : { seq: seq - 1 });
    const event: Record<string, unknown> = {
      ...(tenantId ? { tenantId } : {}), seq, actor: { id: actor.userId || null, type: actor.type, roles: actor.roleKeys.length ? actor.roleKeys : actor.platformRoles ?? [] },
      action: input.action, resourceType: input.resource.type, resourceId: input.resource.id ?? null, outcome: input.outcome ?? 'success',
      reason: input.reason ?? null, before: input.before ?? null, after: input.after ?? null, detail: input.detail ?? null,
      requestId: ctx?.requestId ?? platform?.requestId ?? null, ip: ctx?.ip ?? platform?.ip ?? null, deviceId: actor.deviceId ?? null,
      occurredAt: this.clock.now(), prevHash: prev?.hash ?? '',
    };
    event.hash = chainHash(String(event.prevHash), event);
    await this.store.insert(collection, event);
  }

  // ----- request handling -----
  private match(method: string, path: string): { route: Compiled; params: Record<string, string> } | 'method' | null {
    let pathHit = false;
    for (const r of this.routes) {
      const m = r.regex.exec(path); if (!m) continue;
      pathHit = true;
      if (r.method !== method) continue;
      return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]!])) };
    }
    return pathHit ? 'method' : null;
  }
  private errorRes(e: unknown, requestId: string, route?: Compiled): Res {
    let err: AppError;
    if (e instanceof AppError) err = e;
    else if (e instanceof DuplicateKeyError) err = new AppError('CONFLICT', 'A record with the same unique value already exists.', { details: { fields: e.index.filter((f) => f !== 'tenantId') } });
    else { this.log.error('unhandled error', { requestId, route: route?.path, error: (e as Error)?.message, stack: (e as Error)?.stack?.split('\n').slice(0, 6).join(' | ') }); err = new AppError('INTERNAL', 'Something went wrong. Please try again.'); }
    const headers: Record<string, string> = {};
    if (err.extra.retryAfterSec) headers['Retry-After'] = String(err.extra.retryAfterSec);
    return { status: err.status, headers, body: { error: { code: err.code, message: err.message, requestId, ...(err.extra.fieldErrors ? { fieldErrors: err.extra.fieldErrors } : {}), ...(err.extra.details ? { details: err.extra.details } : {}) } } };
  }

  async handle(req: Req): Promise<Res> {
    const requestId = uuid(); const started = performance.now();
    let route: Compiled | undefined; let ctx: Ctx | null = null; let res: Res;
    try {
      if (!req.path.startsWith('/api/v1/')) throw new AppError('NOT_FOUND', 'Not found');
      const m = this.match(req.method, req.path.slice('/api/v1'.length));
      if (!m || m === 'method') throw new AppError('NOT_FOUND', 'Not found');
      route = m.route;
      const size = req.rawBuffer?.length ?? Buffer.byteLength(req.rawBody);
      if (size > (route.binaryMaxBytes ?? 256 * 1024)) throw new AppError('PAYLOAD_TOO_LARGE', route.binaryMaxBytes ? 'The file is too large.' : 'Request body is larger than 256 KB.');
      ctx = await this.authenticate(req, route, requestId);
      const rateKey = route.rate === 'login' || route.rate === 'public' ? req.ip : route.rate === 'locations' || route.rate === 'sync' || route.rate === 'heartbeat' ? ctx.actor.deviceId ?? ctx.actor.userId : ctx.actor.userId || req.ip;
      this.rate.take(route.rate, rateKey);
      let body: unknown = undefined;
      if (!route.binaryMaxBytes && (route.method !== 'GET' && route.method !== 'DELETE' || req.rawBody)) {
        try { body = req.rawBody ? JSON.parse(req.rawBody) : {}; } catch { throw new AppError('VALIDATION_FAILED', 'Request body is not valid JSON.'); }
      }
      if (route.body) { const v = validate(route.body, body ?? {}); if (!v.ok) throw new AppError('VALIDATION_FAILED', 'Some fields need attention.', { fieldErrors: v.issues }); body = v.value; }
      let query: unknown = req.query;
      if (route.query) {
        const coerced: Record<string, unknown> = {};
        const js = route.query.json() as { properties?: Record<string, { type?: string }> };
        for (const [k, v] of Object.entries(req.query)) { const t = js.properties?.[k]?.type; coerced[k] = t === 'number' || t === 'integer' ? Number(v) : t === 'boolean' ? v === 'true' : v; }
        const v = validate(route.query, coerced); if (!v.ok) throw new AppError('VALIDATION_FAILED', 'Some query parameters are not valid.', { fieldErrors: v.issues }); query = v.value;
      } else if (Object.keys(req.query).length) throw new AppError('VALIDATION_FAILED', 'This endpoint does not accept query parameters.', { fieldErrors: Object.keys(req.query).map((k) => ({ path: k, code: 'UNKNOWN_FIELD', message: 'is not an accepted parameter' })) });

      const c = ctx, r = route; const input = { body, query, params: m.params, req };
      const idemKey = r.method === 'POST' ? req.headers['idempotency-key'] : undefined;
      const idemScope = `${r.method} ${r.path}:${c.actor.userId}`; const idemHash = sha256(req.rawBody || '{}');
      const run = async (): Promise<Res> => {
        if (idemKey && c.tenantId) {
          if (!/^[A-Za-z0-9_-]{8,80}$/.test(idemKey)) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key has an invalid format.');
          const prior = await c.col('idempotency_records').findOne({ scope: idemScope, key: idemKey });
          if (prior) {
            if (prior.requestHash !== idemHash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
            return { status: 200, headers: { 'Idempotent-Replay': 'true' }, body: prior.responseSnapshot };
          }
        }
        const out = await r.handler(c, input);
        const reply = out instanceof Reply ? out : new Reply(200, out ?? { ok: true });
        if (typeof r.audit === 'string') {
          const t = c.auditTarget ?? {};
          const actor = c.actor.type === 'platform' && !c.tenantId ? { actor: c.actor, requestId, ip: req.ip } : undefined;
          await this.writeAudit(c.tenantId ? c : null, { action: t.action ?? r.audit, resource: { type: t.resource?.type ?? r.path.split('/')[1]!, id: t.resource?.id ?? m.params.id ?? null }, outcome: 'success', reason: t.reason, before: t.before, after: t.after, detail: t.detail }, actor);
        }
        const bodyOut = r.raw ? reply.body : toApi(reply.body);
        if (idemKey && c.tenantId && !r.raw) await c.col('idempotency_records').insert({ scope: idemScope, key: idemKey, requestHash: idemHash, responseSnapshot: bodyOut, createdAt: c.now(), purgeAt: c.now() + 24 * 3600000 });
        if (r.raw && reply.body && typeof reply.body === 'object' && 'stream' in (reply.body as object)) return { status: 200, headers: reply.headers, stream: (reply.body as { stream: Res['stream'] }).stream };
        if (r.raw) return { status: reply.status, headers: reply.headers, raw: reply.body as Buffer | string };
        return { status: reply.status, headers: reply.headers, body: bodyOut };
      };
      const useTx = r.tx ?? r.method !== 'GET';
      res = useTx ? await this.store.transaction(run) : await run();
    } catch (e) {
      res = this.errorRes(e, requestId, route);
      // Denied or failed attempts on audited operations are recorded outside the rolled-back transaction.
      if (route && typeof route.audit === 'string' && ctx && (ctx.actor.type !== 'anonymous' || ctx.auditTarget) && res.status !== 429 && res.status !== 400) {
        const code = (res.body as { error: { code: ErrorCode } }).error.code;
        const t = ctx.auditTarget ?? {};
        try {
          await this.writeAudit(ctx.tenantId ? ctx : null, { action: t.action ?? route.audit, resource: { type: t.resource?.type ?? route.path.split('/')[1]!, id: t.resource?.id ?? null }, outcome: res.status === 401 || res.status === 403 || res.status === 404 ? 'denied' : 'failed', reason: code, detail: t.detail },
            ctx.tenantId ? undefined : { actor: ctx.actor, requestId, ip: req.ip });
        } catch (ae) { this.log.error('audit write failed', { requestId, error: (ae as Error).message }); }
      }
    }
    const ms = performance.now() - started;
    res.headers = { ...securityHeaders(this.config), 'X-Request-Id': requestId, ...res.headers };
    this.metrics.inc('sf_http_requests_total', { class: route?.rate ?? 'none', status: String(res.status) });
    this.metrics.observe('sf_http_latency_ms', { class: route?.rate ?? 'none' }, ms);
    this.log.info('request', { requestId, method: req.method, route: route?.path ?? 'unmatched', status: res.status, ms: Math.round(ms), tenantId: ctx?.tenantId || undefined, actorId: ctx?.actor.userId || undefined, module: route?.module });
    if (req.method !== 'GET' && res.status < 500) this.kick();
    return res;
  }

  private async authenticate(req: Req, route: Compiled, requestId: string): Promise<Ctx> {
    const anon = () => new Ctx(this, '', null, DEFAULT_SETTINGS, ANON, requestId, req.ip, req);
    if (route.permission === 'public') return anon();
    const auth = req.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : req.query.access_token && route.raw ? req.query.access_token : null;
    if (route.raw && req.query.access_token) delete req.query.access_token;
    const claims = token ? verifyJwt(token, this.jwtKeys, this.clock.now()) : null;
    if (!claims) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    const now = this.clock.now();

    if (claims.typ === 'platform') {
      const session = await this.store.findOne('platform_sessions', { _id: claims.sid });
      const user = session && !session.revokedAt && session.expiresAt > now ? await this.store.findOne('platform_users', { _id: claims.sub }) : null;
      if (!user || user.status !== 'active') throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
      const perms = new Set<string>(user.platformRoles.includes('super_admin')
        ? ['platform.tenant.read', 'platform.tenant.create', 'platform.tenant.update', 'platform.tenant.lifecycle', 'platform.ops.read', 'platform.support.request', 'platform.plan.assign', 'platform.integration.manage', 'platform.user.manage']
        : ['platform.tenant.read', 'platform.ops.read', 'platform.support.request']);
      const actor: Actor = { type: 'platform', userId: user._id, roleKeys: [], platformRoles: user.platformRoles, permissions: perms, scopeUnitIds: [], assignedUnitIds: [], sessionId: session!._id };
      if (route.scope === 'platform' || route.permission === 'platform-session') {
        if (route.permission !== 'platform-session' && !perms.has(route.permission)) throw new AppError('FORBIDDEN', 'You do not have permission to do this.');
        return new Ctx(this, '', null, DEFAULT_SETTINGS, actor, requestId, req.ip, req);
      }
      // Tenant content is reachable for platform staff only through an approved, time-boxed, read-only grant (FR-TEN-003).
      const grantId = req.headers['x-support-grant'], grantTenant = req.headers['x-support-tenant'];
      const grant = grantId && grantTenant ? await this.store.findOne('support_access_grants', { _id: grantId, tenantId: grantTenant, platformUserId: user._id }) : null;
      if (!grant || grant.state !== 'approved' || grant.startsAt > now || grant.expiresAt <= now) throw new AppError('FORBIDDEN', 'Platform staff cannot read tenant content without an approved, unexpired support grant.');
      if (route.method !== 'GET' || !grant.scope.includes(route.permission)) throw new AppError('FORBIDDEN', 'This support grant is read-only and does not cover this resource.');
      const tenant = await this.store.findOne('tenants', { _id: grant.tenantId });
      if (!tenant) throw new AppError('NOT_FOUND', 'Not found');
      const ctx = new Ctx(this, tenant._id, tenant, await this.settingsFor(tenant), { ...actor, type: 'support', permissions: new Set<string>(grant.scope), scopeUnitIds: '*', grantId: grant._id }, requestId, req.ip, req);
      await this.writeAudit(ctx, { action: 'support.access', resource: { type: route.path.split('/')[1]!, id: null }, reason: grant.reason, detail: { grantId: grant._id, route: route.path, mode: grant.mode } });
      return ctx;
    }
    if (route.scope === 'platform' || route.permission === 'platform-session' || claims.typ !== 'access') throw new AppError('FORBIDDEN', 'You do not have permission to do this.');

    const repo = this.tenantRepo(String(claims.tid));
    const [session, user, membership, tenant] = await Promise.all([
      repo.col('sessions').get(String(claims.sid)), repo.col('users').get(String(claims.sub)), repo.col('memberships').get(String(claims.mid)), this.store.findOne('tenants', { _id: claims.tid }),
    ]);
    const idleMs = session?.deviceId ? 14 * 86400000 : 12 * 3600000;
    if (!session || session.revokedAt || session.expiresAt <= now || session.lastUsedAt + (session.idleMs ?? idleMs) <= now) throw new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.');
    if (!user || user.status !== 'active' || user.sessionVersion !== claims.sv || !membership || membership.status !== 'active' || !tenant) throw new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.');
    const staff = membership.staffMemberId ? await repo.col('staff_members').get(membership.staffMemberId) : null;
    if (membership.staffMemberId && (!staff || staff.status !== 'active')) throw new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.');
    if (now - session.lastUsedAt > 60000) await repo.col('sessions').update(session._id, { $set: { lastUsedAt: now } });

    const roles = await repo.col('roles').find({ _id: { $in: membership.roleIds } });
    const permissions = new Set<string>(roles.flatMap((r) => r.permissionKeys as string[]));
    let scope: '*' | string[] = '*';
    if (!membership.scopeUnitIds.includes('*')) {
      const units = await repo.col('organization_units').find({ $or: [{ _id: { $in: membership.scopeUnitIds } }, { ancestorIds: { $in: membership.scopeUnitIds } }] });
      scope = units.map((u) => u._id);
    }
    const actor: Actor = { type: 'user', userId: user._id, membershipId: membership._id, staffMemberId: membership.staffMemberId ?? null, roleKeys: roles.map((r) => r.key ?? r.name), permissions, scopeUnitIds: scope, assignedUnitIds: membership.scopeUnitIds, sessionId: session._id, deviceId: session.deviceId ?? null };
    const ctx = new Ctx(this, tenant._id, tenant, await this.settingsFor(tenant), actor, requestId, req.ip, req);
    ctx.session = session;

    // Decision order (TS §6.3): tenant state → device → permission → (handler: scope → resource state → policy)
    const status = tenant.status as TenantStatus;
    if (status !== 'active' && status !== 'trial') {
      const isOwner = actor.roleKeys.includes('owner');
      const allowed = (route.whenInactive === 'owner' && isOwner && ['suspended', 'archived', 'pending_deletion'].includes(status))
        || (route.whenInactive === 'safety' && status === 'suspended' && now - (tenant.suspendedAt ?? 0) <= ctx.settings.tenant.suspendedSosGraceHours * 3600000)
        || (status === 'archived' && route.method === 'GET')
        || (route.path === '/auth/me' || route.path === '/auth/logout');
      if (!allowed) throw new AppError('TENANT_NOT_ACTIVE', `This organisation is ${status.replace('_', ' ')}. Contact your administrator.`);
    }
    if (session.deviceId) {
      const device = await repo.col('devices').get(session.deviceId);
      ctx.device = device;
      if (!device || device.status === 'revoked') throw new AppError('DEVICE_REVOKED', 'This device has been revoked. Unsent records are kept on the device; contact your supervisor.');
      const appVersion = req.headers['x-app-version'];
      if (appVersion && compareVersions(appVersion, ctx.settings.devices.minAppVersion) < 0 && route.whenInactive !== 'safety') throw new AppError('UPGRADE_REQUIRED', 'Update the app to continue. Your unsent records are kept and will sync after the update.', { details: { minAppVersion: ctx.settings.devices.minAppVersion } });
    }
    if (route.permission !== 'session' && !permissions.has(route.permission)) {
      await this.writeAudit(ctx, { action: 'access.denied', resource: { type: route.path.split('/')[1]!, id: null }, outcome: 'denied', reason: 'FORBIDDEN', detail: { permission: route.permission, route: `${route.method} ${route.path}` } });
      throw new AppError('FORBIDDEN', 'You do not have permission to do this.');
    }
    if (route.deviceBound && session.deviceId) {
      if (ctx.device!.status !== 'active') throw new AppError('DEVICE_NOT_APPROVED', 'This device is waiting for approval by an administrator.');
      if (ctx.device!.staffMemberId !== actor.staffMemberId) throw new AppError('DEVICE_REVOKED', 'This device is not registered to you.');
      const ts = req.headers['x-device-timestamp'] ?? '', sig = req.headers['x-device-signature'] ?? '';
      if (!ts || !sig || !verifyDeviceSignature(ctx.device!.publicKey, deviceSigningString(req.method, req.path, req.rawBody, ts), sig)) throw new AppError('UNAUTHENTICATED', 'Device signature is missing or invalid.');
    } else if (route.deviceBound && route.permission === 'duty.own') {
      throw new AppError('DEVICE_NOT_APPROVED', 'Duty actions must come from a registered device.');
    }
    return ctx;
  }

  // ----- background pumping: outbox relay, job worker, schedulers -----
  /** Relay committed events and run due jobs until idle. Called after each mutating request and on a timer. */
  async pump(maxRounds = 20): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const a = await this.outbox.relay(); const b = await this.jobs.tick();
      if (a + b === 0) break;
    }
  }
  kick() { if (!this.config.runWorkerInProcess || this.pumping) return; this.pumping = this.pump().catch((e) => this.log.error('pump failed', { error: (e as Error).message })).finally(() => { this.pumping = null; }); }
  async idle() { while (this.pumping) await this.pumping; }
  /** Runs schedulers that are due. Evaluators are idempotent, so duplicate scheduling is harmless (TS §20). */
  async runSchedulers(force = false): Promise<void> {
    const now = this.clock.now();
    const due = this.schedulers.filter((s) => force || now - s.last >= s.everySec * 1000);
    if (!due.length) return;
    const tenants = await this.store.find('tenants', { status: { $in: ['active', 'trial', 'suspended', 'archived', 'pending_deletion'] } });
    for (const s of due) {
      s.last = now;
      const targets = s.perTenant ? tenants : [{ _id: '' } as Doc];
      for (const t of targets) {
        try { await s.run(t); } catch (e) { this.log.error('scheduler failed', { scheduler: s.name, tenantId: t._id, error: (e as Error).message }); this.metrics.inc('sf_scheduler_failures_total', { name: s.name }); }
      }
    }
    await this.pump();
  }
}

export function securityHeaders(config: AppConfig): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Cross-Origin-Resource-Policy': 'same-origin',
    ...(config.cookieSecure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}
export const parseCookies = (h: string | undefined): Record<string, string> => Object.fromEntries((h ?? '').split(';').map((p) => p.trim().split('=')).filter((p) => p.length === 2 && p[0]).map(([k, v]) => [k!, decodeURIComponent(v!)]));

/** Cursor pagination (TS §9.1): limit ≤ 200, stable sort on (field, _id), opaque cursor. */
export async function paginate(col: { find(f: Filter, o: { sort: Record<string, 1 | -1>; limit: number }): Promise<Doc[]> }, filter: Filter, q: { limit?: number; cursor?: string }, sortField = 'createdAt', dir: 1 | -1 = -1) {
  const limit = Math.min(200, Math.max(1, q.limit ?? 50));
  let f = filter;
  if (q.cursor) {
    let cur: { v: number | string; id: string };
    try { cur = JSON.parse(Buffer.from(q.cursor, 'base64url').toString()); } catch { throw new AppError('VALIDATION_FAILED', 'The cursor is not valid.'); }
    const op = dir === -1 ? '$lt' : '$gt';
    f = { ...filter, $or: [{ [sortField]: { [op]: cur.v } }, { [sortField]: cur.v, _id: { [op]: cur.id } }] };
  }
  const items = await col.find(f, { sort: { [sortField]: dir, _id: dir }, limit: limit + 1 });
  const more = items.length > limit; const page = more ? items.slice(0, limit) : items; const last = page[page.length - 1];
  return { items: page, nextCursor: more && last ? Buffer.from(JSON.stringify({ v: last[sortField], id: last._id })).toString('base64url') : null };
}
