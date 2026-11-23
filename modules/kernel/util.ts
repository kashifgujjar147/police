// Cross-cutting primitives: clock, crypto, tokens, logger with redaction, metrics, rate limiting.
import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scrypt,
  sign as edSign, timingSafeEqual, verify as edVerify, type KeyObject,
} from 'node:crypto';
import { AppError } from '@sf/contracts';

// ---- Clock port (TS §1.2-9): all time-dependent logic uses an injected clock ----
export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };
export class FakeClock implements Clock {
  constructor(private t: number = Date.parse('2026-11-10T06:00:00Z')) {}
  now() { return this.t; }
  set(t: number | string) { this.t = typeof t === 'string' ? Date.parse(t) : t; }
  advance(ms: number) { this.t += ms; }
  advanceSec(s: number) { this.t += s * 1000; }
  advanceMin(m: number) { this.t += m * 60000; }
}

// ---- tokens and hashing ----
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const hmacHex = (key: string, data: string) => createHmac('sha256', key).update(data).digest('hex');
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const uuid = () => crypto.randomUUID();
/** Human-enterable activation / reset code: 128 bits, grouped. */
export function activationCode(): string {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = randomBytes(26);
  return [...b].map((x) => a[x % 32]).join('').replace(/(.{5})(?=.)/g, '$1-').slice(0, 30);
}

// ---- password hashing port ----
// Baseline in this build is scrypt from node:crypto (maintained, memory-hard). TS §2.1 names Argon2id; an Argon2id
// adapter is selected when PASSWORD_ALGO=argon2id and the optional `argon2` package is installed. See docs/DECISIONS_AND_ASSUMPTIONS.md (DEC-05).
export interface HashParams { N: number; r: number; p: number }
export interface PasswordHasher { hash(password: string): Promise<string>; verify(password: string, stored: string): Promise<boolean>; needsRehash(stored: string): boolean }
export function scryptHasher(params: HashParams): PasswordHasher {
  const run = (pw: string, salt: Buffer, p: HashParams) => new Promise<Buffer>((res, rej) =>
    scrypt(pw.normalize('NFKC'), salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: 256 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
  return {
    async hash(pw) { const salt = randomBytes(16); const k = await run(pw, salt, params); return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${k.toString('base64')}`; },
    async verify(pw, stored) {
      const [algo, N, r, p, salt, key] = stored.split('$');
      if (algo !== 'scrypt' || !salt || !key) return false;
      const k = await run(pw, Buffer.from(salt, 'base64'), { N: +N!, r: +r!, p: +p! });
      const expect = Buffer.from(key, 'base64');
      return k.length === expect.length && timingSafeEqual(k, expect);
    },
    needsRehash(stored) { const [algo, N, r, p] = stored.split('$'); return algo !== 'scrypt' || +N! !== params.N || +r! !== params.r || +p! !== params.p; },
  };
}
export async function argon2Hasher(): Promise<PasswordHasher | null> {
  try {
    const name = 'argon2';
    const argon2: any = await import(name);
    const opts = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
    return {
      hash: (pw) => argon2.hash(pw.normalize('NFKC'), opts),
      verify: async (pw, stored) => (stored.startsWith('$argon2') ? argon2.verify(stored, pw.normalize('NFKC')) : false),
      needsRehash: (stored) => !stored.startsWith('$argon2id') || argon2.needsRehash(stored, opts),
    };
  } catch { return null; }
}

// ---- field-level encryption for (enc) fields: AES-256-GCM (TS §22.1) ----
export function fieldCrypto(keyB64: string) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('FIELD_ENC_KEY must be 32 bytes, base64-encoded');
  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
    },
    decrypt(blob: string): string {
      const [v, iv, tag, enc] = blob.split('.');
      if (v !== 'v1' || !iv || !tag || !enc) throw new Error('unreadable encrypted field');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
    },
  };
}

// ---- access tokens: JWT signed with Ed25519 (EdDSA), kid rotation (TS §6.2) ----
export interface JwtKey { kid: string; privateKey?: KeyObject; publicKey: KeyObject }
export function generateJwtKey(kid = `k${Date.now().toString(36)}`) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { kid, privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}
export const loadJwtKey = (k: { kid: string; privatePem?: string; publicPem: string }): JwtKey => ({ kid: k.kid, privateKey: k.privatePem ? createPrivateKey(k.privatePem) : undefined, publicKey: createPublicKey(k.publicPem) });
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function signJwt(claims: Record<string, unknown>, key: JwtKey): string {
  if (!key.privateKey) throw new Error('signing key has no private part');
  const head = `${b64u({ alg: 'EdDSA', typ: 'JWT', kid: key.kid })}.${b64u(claims)}`;
  return `${head}.${edSign(null, Buffer.from(head), key.privateKey).toString('base64url')}`;
}
export function verifyJwt(token: string, keys: JwtKey[], nowMs: number): Record<string, any> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
    if (header.alg !== 'EdDSA') return null; // no algorithm confusion: only EdDSA is ever accepted
    const key = keys.find((k) => k.kid === header.kid);
    if (!key) return null;
    if (!edVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key.publicKey, Buffer.from(parts[2]!, 'base64url'))) return null;
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) return null;
    return claims;
  } catch { return null; }
}
/** Device proof of possession (TS §6.2): Ed25519 signature over method, path, body hash and device timestamp. */
export const deviceSigningString = (method: string, path: string, body: string, timestamp: string) => `${method.toUpperCase()}\n${path}\n${sha256(body)}\n${timestamp}`;
export function verifyDeviceSignature(publicKeyPem: string, signingString: string, signatureB64: string): boolean {
  try { return edVerify(null, Buffer.from(signingString), createPublicKey(publicKeyPem), Buffer.from(signatureB64, 'base64')); } catch { return false; }
}

// ---- structured logger with redaction (TS §23; FR-NFR-004) ----
const REDACT = /pass(word)?|token|secret|authorization|cookie|signature|^code$|recovery|^lat$|^lon$|^lng$|latitude|longitude|coordinates|^location$|^pos$|privatekey|^key$/i;
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, REDACT.test(k) ? '[redacted]' : redact(x, depth + 1)]));
}
export interface Logger { info(msg: string, f?: Record<string, unknown>): void; warn(msg: string, f?: Record<string, unknown>): void; error(msg: string, f?: Record<string, unknown>): void }
export function createLogger(sink: (line: string) => void, clock: Clock = systemClock, level: 'info' | 'warn' | 'error' | 'silent' = 'info'): Logger {
  const rank = { info: 0, warn: 1, error: 2, silent: 3 };
  const write = (lvl: 'info' | 'warn' | 'error') => (msg: string, f: Record<string, unknown> = {}) => {
    if (rank[lvl] < rank[level]) return;
    sink(JSON.stringify({ t: new Date(clock.now()).toISOString(), level: lvl, msg, ...(redact(f) as object) }));
  };
  return { info: write('info'), warn: write('warn'), error: write('error') };
}

// ---- metrics (Prometheus text exposition) ----
export class Metrics {
  private counters = new Map<string, number>();
  private hist = new Map<string, number[]>();
  private gauges = new Map<string, () => number>();
  inc(name: string, labels: Record<string, string> = {}, by = 1) { const k = this.key(name, labels); this.counters.set(k, (this.counters.get(k) ?? 0) + by); }
  observe(name: string, labels: Record<string, string>, value: number) { const k = this.key(name, labels); const a = this.hist.get(k) ?? []; a.push(value); if (a.length > 5000) a.shift(); this.hist.set(k, a); }
  gauge(name: string, fn: () => number) { this.gauges.set(name, fn); }
  private key(name: string, labels: Record<string, string>) { const l = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(','); return l ? `${name}{${l}}` : name; }
  quantile(name: string, labels: Record<string, string>, q: number): number | null {
    const a = [...(this.hist.get(this.key(name, labels)) ?? [])].sort((x, y) => x - y);
    return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))]! : null;
  }
  render(): string {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [k, a] of this.hist) {
      const s = [...a].sort((x, y) => x - y); const base = k.includes('{') ? k.slice(0, -1) + ',' : k + '{';
      for (const q of [0.5, 0.95, 0.99]) lines.push(`${base}quantile="${q}"} ${s[Math.min(s.length - 1, Math.floor(q * s.length))]}`);
      lines.push(`${k.replace(/(\{|$)/, '_count$1')} ${a.length}`);
    }
    for (const [k, fn] of this.gauges) lines.push(`${k} ${fn()}`);
    return lines.join('\n') + '\n';
  }
}

// ---- rate limiting: token buckets per class and key (TS §9.1) ----
export const RATE_CLASSES = {
  public: { capacity: 60, perSec: 60 / 60 }, login: { capacity: 10, perSec: 10 / 60 }, refresh: { capacity: 30, perSec: 30 / 60 },
  read: { capacity: 600, perSec: 600 / 60 }, mutation: { capacity: 120, perSec: 120 / 60 }, export: { capacity: 5, perSec: 5 / 3600 },
  locations: { capacity: 12, perSec: 12 / 60 }, sync: { capacity: 30, perSec: 30 / 60 }, heartbeat: { capacity: 30, perSec: 30 / 60 },
  sos: { capacity: Infinity, perSec: Infinity }, // SOS is never hard-throttled; abuse is flagged instead
} as const;
export type RateClass = keyof typeof RATE_CLASSES;
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private clock: Clock, public enabled = true) {}
  take(cls: RateClass, key: string, custom?: { capacity: number; perSec: number }): void {
    if (!this.enabled) return;
    const def = custom ?? RATE_CLASSES[cls];
    if (def.capacity === Infinity) return;
    const k = `${cls}:${key}`, now = this.clock.now();
    const b = this.buckets.get(k) ?? { tokens: def.capacity, at: now };
    b.tokens = Math.min(def.capacity, b.tokens + ((now - b.at) / 1000) * def.perSec); b.at = now;
    if (b.tokens < 1) { this.buckets.set(k, b); throw new AppError('RATE_LIMITED', 'Too many requests. Please wait and try again.', { retryAfterSec: Math.ceil((1 - b.tokens) / def.perSec) }); }
    b.tokens -= 1; this.buckets.set(k, b);
    if (this.buckets.size > 50000) for (const [key2, v] of this.buckets) if (now - v.at > 3600000) this.buckets.delete(key2);
  }
}

export const deepMerge = <T>(base: T, over: unknown): T => {
  if (over === null || over === undefined || typeof base !== 'object' || base === null || Array.isArray(base) || typeof over !== 'object' || Array.isArray(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out as T;
};
