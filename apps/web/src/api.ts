// API client for the web portal. The access token lives in memory only; the refresh token is an HttpOnly cookie (TS §6.2).
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly fieldErrors: { path: string; code: string; message: string }[] = [], readonly details: Record<string, any> | null = null, readonly requestId = '') { super(message); }
}
export const session = { token: null as string | null, platform: false, tenant: '', onSignedOut: () => {} };
try { session.tenant = localStorage.getItem('sf.tenant') ?? ''; } catch { /* storage unavailable */ }
export function setTenant(slug: string) { session.tenant = slug; try { localStorage.setItem('sf.tenant', slug); } catch { /* ignore */ } }
const cookie = (name: string) => document.cookie.split('; ').find((c) => c.startsWith(name + '='))?.split('=')[1] ?? '';

let refreshing: Promise<boolean> | null = null;
export function refresh(): Promise<boolean> {
  if (session.platform || !session.tenant) return Promise.resolve(false);
  refreshing ??= fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': cookie('sf_csrf') }, body: JSON.stringify({ tenant: session.tenant }) })
    .then(async (r) => { if (!r.ok) return false; session.token = (await r.json()).accessToken; return true; }).catch(() => false).finally(() => { refreshing = null; });
  return refreshing;
}
export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, retry = true): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'NETWORK', navigator.onLine ? 'The server could not be reached.' : 'You are offline.'); }
  if (res.status === 401 && retry && session.token && !path.startsWith('/auth/') && !path.startsWith('/platform/auth/')) {
    if (await refresh()) return api(method, path, body, headers, false);
    session.token = null; session.onSignedOut();
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) { const e = data?.error ?? {}; throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Request failed (${res.status})`, e.fieldErrors ?? [], e.details ?? null, e.requestId ?? ''); }
  return data as T;
}
export const get = <T = any>(path: string) => api<T>('GET', path);
export const post = <T = any>(path: string, body: unknown = {}, headers?: Record<string, string>) => api<T>('POST', path, body, headers);
export const patch = <T = any>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const put = <T = any>(path: string, body: unknown) => api<T>('PUT', path, body);
export const del = <T = any>(path: string) => api<T>('DELETE', path);
export const qs = (o: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ''; };
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

export interface StreamEvent { type: string; seq?: number; payload: Record<string, any>; occurredAt?: string }
export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';
/** Server-sent events over fetch (so the bearer token is sent as a header). Reconnects with backoff and catches up from the last sequence. */
export function connectStream(onEvent: (e: StreamEvent) => void, onStatus: (s: StreamStatus) => void): () => void {
  let stopped = false, lastSeq = 0, attempt = 0, ctl: AbortController | null = null;
  const run = async () => {
    while (!stopped) {
      onStatus(attempt ? 'reconnecting' : 'connecting');
      try {
        if (!session.token && !(await refresh())) throw new Error('no session');
        ctl = new AbortController();
        const res = await fetch('/api/v1/realtime/stream', { headers: { Authorization: `Bearer ${session.token}` }, signal: ctl.signal });
        if (res.status === 401) { session.token = null; if (!(await refresh())) { session.onSignedOut(); return; } continue; }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        if (lastSeq) { // fill the gap after a disconnect without reloading everything
          const cu = await get(`/realtime/catch-up?since=${lastSeq}`);
          if (cu.reset) onEvent({ type: 'reset', payload: {} }); else for (const e of cu.events) { lastSeq = Math.max(lastSeq, e.seq); onEvent(e); }
        }
        onStatus('live'); attempt = 0;
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
            if (!ev || !data) continue;
            const parsed = JSON.parse(data);
            if (ev === 'hello') { if (!lastSeq) lastSeq = parsed.seq; continue; }
            if (ev === 'session:revoked' && !parsed.seq) { session.token = null; session.onSignedOut(); return; }
            if (parsed.seq) { if (parsed.seq <= lastSeq) continue; lastSeq = parsed.seq; }
            onEvent({ type: ev, seq: parsed.seq, payload: parsed.payload ?? {}, occurredAt: parsed.occurredAt });
          }
        }
      } catch { /* fall through to retry */ }
      if (stopped) return;
      attempt++; onStatus(navigator.onLine ? 'reconnecting' : 'offline');
      await new Promise((r) => setTimeout(r, Math.min(15000, 500 * 2 ** Math.min(attempt, 5)) * (0.6 + Math.random() * 0.4)));
    }
  };
  void run();
  return () => { stopped = true; ctl?.abort(); };
}
