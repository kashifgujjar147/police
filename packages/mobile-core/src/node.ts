// Node adapters for mobile-core (field simulator and tests). The Expo app ships its own adapters in apps/mobile/src/platform.ts.
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { App } from '@sf/kernel';
import type { Env, Signer, Transport } from './index.ts';

export const nodeEnv = (now: () => number = Date.now): Env => ({ now, uuid: () => randomUUID(), sha256Hex: (s) => createHash('sha256').update(s).digest('hex') });
export function nodeSigner(): Signer & { key: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { key: privateKey, publicKeyPem: async () => publicKey.export({ type: 'spki', format: 'pem' }).toString(), sign: async (d) => sign(null, Buffer.from(d), privateKey).toString('base64') };
}
/** HTTP transport over fetch (real server). */
export const fetchTransport = (base: string): Transport => ({
  async request(method, path, body, headers) {
    const r = await fetch(base + path, { method, headers, body: method === 'GET' ? undefined : body });
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
  },
});
/** In-process transport (tests): calls the application kernel directly. `link.up = false` simulates no connectivity. */
export function appTransport(app: App, link = { up: true }): Transport & { link: { up: boolean } } {
  return {
    link,
    async request(method, path, body, headers) {
      if (!link.up) throw new Error('Network request failed');
      const [p, q] = path.split('?'); const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      const r = await app.handle({ method, path: p!, query: Object.fromEntries(new URLSearchParams(q ?? '')), headers: h, rawBody: body, ip: '10.9.9.9' });
      return { status: r.status, body: r.body };
    },
  };
}
