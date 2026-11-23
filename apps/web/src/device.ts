// Browser device identity for field duty in the web app / PWA (same server rules as the phone app):
// an Ed25519 key pair generated here, the private key NON-EXTRACTABLE and kept in IndexedDB; every duty request is signed
// over "METHOD\npath\nsha256(body)\ntimestamp" exactly like the mobile app (TS §14).
import { post, session } from './api.ts';

const DB = 'sf360-device', STORE = 'keys', APP_VERSION = '1.0.0';
interface Stored { id: string; privateKey: CryptoKey; publicPem: string }

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const tx = open.result.transaction(STORE, mode); const r = fn(tx.objectStore(STORE)); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); tx.oncomplete = () => open.result.close(); };
  });
}
const keyName = (staffMemberId: string) => `${session.tenant}:${staffMemberId}`;
const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

export const deviceSupported = () => typeof indexedDB !== 'undefined' && !!globalThis.crypto?.subtle;
export async function storedDevice(staffMemberId: string): Promise<Stored | null> { try { return (await idb<Stored | undefined>('readonly', (s) => s.get(keyName(staffMemberId)))) ?? null; } catch { return null; } }

/** Register (or re-bind) this browser as the staff member's device. Re-binding the same key never creates a second device. */
export async function registerDevice(staffMemberId: string): Promise<{ id: string; status: string }> {
  let d = await storedDevice(staffMemberId);
  let publicPem = d?.publicPem;
  let privateKey = d?.privateKey;
  if (!d) {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as CryptoKeyPair; // private key cannot be exported
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    publicPem = `-----BEGIN PUBLIC KEY-----\n${b64(spki).match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`; privateKey = kp.privateKey;
  }
  const ua = navigator.userAgent; const os = /Android [\d.]+|iPhone OS [\d_]+|Windows NT [\d.]+|Mac OS X [\d_]+|Linux/.exec(ua)?.[0] ?? 'Browser';
  const r = await post<any>('/devices/register', { publicKey: publicPem, platform: 'web', osVersion: os.slice(0, 40), model: 'Web app', appVersion: APP_VERSION });
  if (!d || d.id !== r.id) { d = { id: r.id, privateKey: privateKey!, publicPem: publicPem! }; await idb('readwrite', (s) => s.put(d, keyName(staffMemberId))); }
  return { id: r.id, status: r.status };
}
export async function forgetDevice(staffMemberId: string) { try { await idb('readwrite', (s) => s.delete(keyName(staffMemberId))); } catch { /* ignore */ } }

/** POST signed with this browser's device key (required by the server for duty actions on a device-bound session). */
export async function signedPost<T = any>(staffMemberId: string, path: string, body: unknown): Promise<T> {
  const d = await storedDevice(staffMemberId);
  if (!d) return post<T>(path, body);
  const raw = JSON.stringify(body); const ts = new Date().toISOString();
  const digest = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
  const sig = b64(await crypto.subtle.sign('Ed25519', d.privateKey, new TextEncoder().encode(`POST\n/api/v1${path}\n${digest}\n${ts}`)));
  return post<T>(path, body, { 'X-Device-Timestamp': ts, 'X-Device-Signature': sig, 'X-App-Version': APP_VERSION });
}
