// Domain helpers that need a hash/HMAC primitive (node:crypto). Kept out of the browser-safe index.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
export const sha256Hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** Audit hash chain (TS §18): hash = SHA-256(prevHash ‖ canonicalJson(event without hash)). */
export function chainHash(prevHash: string, event: Record<string, unknown>): string {
  const { hash: _h, _id: _i, ...rest } = event;
  return sha256Hex(prevHash + canonicalJson(rest));
}
export function verifyChain(events: Record<string, unknown>[], genesis = ''): { ok: true; count: number } | { ok: false; brokenAtSeq: number; reason: string } {
  let prev = genesis;
  for (const e of events) {
    if (e.prevHash !== prev) return { ok: false, brokenAtSeq: Number(e.seq), reason: 'prevHash does not match the previous record' };
    if (chainHash(prev, e) !== e.hash) return { ok: false, brokenAtSeq: Number(e.seq), reason: 'record content does not match its hash' };
    prev = String(e.hash);
  }
  return { ok: true, count: events.length };
}

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch); if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1]! & 15;
  const code = ((h[off]! & 127) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}
export const totp = (secretB32: string, atMs: number, digits = 6) => hotp(base32Decode(secretB32), Math.floor(atMs / 30000), digits);
/** Accepts the current step ±1; returns the matched step so a code cannot be replayed. */
export function verifyTotp(secretB32: string, code: string, atMs: number, lastUsedStep = -1): number | null {
  const step = Math.floor(atMs / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastUsedStep) continue;
    const expect = Buffer.from(hotp(base32Decode(secretB32), s)), got = Buffer.from(code.padEnd(6).slice(0, 6));
    if (expect.length === got.length && timingSafeEqual(expect, got)) return s;
  }
  return null;
}

// ---- Rotating checkpoint token (TS §13): HMAC(secret, tagId ‖ floor(t/period)); current and previous period accepted ----
export function checkpointToken(secret: string, tagId: string, atMs: number, periodSec: number): string {
  return createHmac('sha256', secret).update(`${tagId}|${Math.floor(atMs / 1000 / periodSec)}`).digest('hex').slice(0, 16);
}
export function verifyCheckpointToken(secret: string, tagId: string, token: string, atMs: number, periodSec: number): boolean {
  return [0, -1].some((k) => {
    const exp = Buffer.from(checkpointToken(secret, tagId, atMs + k * periodSec * 1000, periodSec)), got = Buffer.from(token);
    return exp.length === got.length && timingSafeEqual(exp, got);
  });
}
