// Offline-queue rules shared by the mobile sync engine (TS §14): priorities, backoff, thinning.
export const EVENT_PRIORITY: Record<string, number> = { sos: 0, attendance: 1, scan: 2, incident: 3, correction: 3, location: 4 };

/** Exponential backoff with jitter: base 2 s, cap 15 min (SOS cap 30 s). `rand` is injected for tests. */
export function backoffMs(attempt: number, opts: { baseMs?: number; capMs?: number; rand?: () => number } = {}): number {
  const base = opts.baseMs ?? 2000, cap = opts.capMs ?? 15 * 60000, rand = opts.rand ?? Math.random;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + (exp / 2) * rand());
}

export interface QueuedPoint { seq: number; sessionId: string }
/**
 * At the cap, thin the oldest location points: keep every n-th, never the first or last of a session (TS §14.6).
 * Returns the points to keep and how many were dropped. Non-location events are never passed here.
 */
export function thinPoints<T extends QueuedPoint>(points: T[], cap: number, keepEvery = 2): { kept: T[]; dropped: number } {
  if (points.length <= cap) return { kept: points, dropped: 0 };
  const firstLast = new Set<T>();
  const bySession = new Map<string, T[]>();
  for (const p of points) { const l = bySession.get(p.sessionId) ?? []; l.push(p); bySession.set(p.sessionId, l); }
  for (const l of bySession.values()) { firstLast.add(l[0]!); firstLast.add(l[l.length - 1]!); }
  let excess = points.length - cap;
  const kept: T[] = [];
  let n = 0;
  for (const p of points) { // points are ordered oldest first
    if (excess > 0 && !firstLast.has(p) && n++ % keepEvery !== 0) { excess--; continue; }
    kept.push(p);
  }
  return { kept, dropped: points.length - kept.length };
}
