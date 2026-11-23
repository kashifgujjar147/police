// React Native adapters for mobile-core: storage, transport, device key, environment, connectivity.
// STATUS: written against the Expo SDK 52 APIs; not compiled or run on a device in the build environment.
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { ed25519 } from '@noble/curves/ed25519';
import { Api, Duty, type Env, type KV, Outbox, SosController, SyncEngine, type Signer, type Transport, ed25519RawToPem } from '@sf/mobile-core';

/** Queue and session live in app storage (sandboxed per app). The signing key lives in the OS keystore via SecureStore. */
const kv: KV = { get: (k) => AsyncStorage.getItem(`sf.${k}`), set: (k, v) => AsyncStorage.setItem(`sf.${k}`, v), del: (k) => AsyncStorage.removeItem(`sf.${k}`) };
const toB64 = (u: Uint8Array) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return global.btoa(s); };
const toHex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

async function deviceKey(): Promise<Uint8Array> {
  const stored = await SecureStore.getItemAsync('sf_device_key', { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  if (stored) return fromHex(stored);
  const sk = Crypto.getRandomBytes(32); await SecureStore.setItemAsync('sf_device_key', toHex(sk), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  return sk;
}
const signer: Signer = {
  async publicKeyPem() { return ed25519RawToPem(ed25519.getPublicKey(await deviceKey())); },
  async sign(data) { return toB64(ed25519.sign(new TextEncoder().encode(data), await deviceKey())); },
};
const env: Env = { now: () => Date.now(), uuid: () => Crypto.randomUUID(), sha256Hex: (s) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, s) };

export let baseUrl: string = (Constants.expoConfig?.extra as { apiBaseUrl?: string })?.apiBaseUrl ?? 'http://10.0.2.2:8080';
export async function setBaseUrl(url: string) { baseUrl = url.replace(/\/+$/, ''); await kv.set('baseUrl', baseUrl); }
const transport: Transport = {
  async request(method, path, body, headers) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20000);
    try { const r = await fetch(baseUrl + path, { method, headers, body: method === 'GET' ? undefined : body, signal: ctl.signal }); return { status: r.status, body: (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : null }; }
    finally { clearTimeout(timer); }
  },
};

export const api = new Api(transport, kv, signer, env);
export const outbox = new Outbox(kv);
export const sync = new SyncEngine(api, outbox, env);
export const duty = new Duty(outbox, sync, env);
export const sos = new SosController(api, outbox, sync, env, 2);
export const devicePlatform = Platform.OS === 'ios' ? 'ios' as const : 'android' as const;

let started = false;
/** Loads persisted state, then syncs whenever connectivity returns and every 30 s while the app runs. */
export async function boot() {
  if (started) return; started = true;
  const saved = await kv.get('baseUrl'); if (saved) baseUrl = saved;
  await api.load(); await outbox.load();
  NetInfo.addEventListener((s) => { const was = sync.online; sync.online = !!s.isConnected && s.isInternetReachable !== false; if (sync.online && !was) void sync.sync(); sync.onChange(); });
  setInterval(() => { if (api.session) void sync.sync(); }, 30000);
}
export { env, kv };
