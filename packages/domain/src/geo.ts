// Pure geometry and geofence evaluation (TS §12.3). No I/O.
export interface LatLon { lat: number; lon: number }
export type GeofenceShape = { shape: 'circle'; center: LatLon; radiusM: number } | { shape: 'polygon'; ring: LatLon[] };
export type GeoClass = 'inside' | 'outside' | 'uncertain';

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Local equirectangular projection in metres around an origin — accurate for geofence-sized areas. */
function toXY(p: LatLon, o: LatLon): [number, number] {
  return [rad(p.lon - o.lon) * R * Math.cos(rad(o.lat)), rad(p.lat - o.lat) * R];
}
function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
export function pointInPolygon(p: LatLon, ring: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}
/** Signed distance to the boundary in metres: positive inside, negative outside. */
export function signedDistanceM(p: LatLon, g: GeofenceShape): number {
  if (g.shape === 'circle') return g.radiusM - haversineM(p, g.center);
  const pts = g.ring.map((v) => toXY(v, p));
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) min = Math.min(min, segDist([0, 0], pts[i]!, pts[(i + 1) % pts.length]!));
  return pointInPolygon(p, g.ring) ? min : -min;
}

function segmentsCross(a: LatLon, b: LatLon, c: LatLon, d: LatLon): boolean {
  const o = (p: LatLon, q: LatLon, r: LatLon) => Math.sign((q.lon - p.lon) * (r.lat - p.lat) - (q.lat - p.lat) * (r.lon - p.lon));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
/** FR-GEO-001: invalid or self-intersecting polygons are rejected. Returns a reason or null when valid. */
export function validateShape(g: GeofenceShape): string | null {
  const okPt = (p: LatLon) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
  if (g.shape === 'circle') {
    if (!okPt(g.center)) return 'centre is not a valid coordinate';
    if (!(g.radiusM >= 10 && g.radiusM <= 50000)) return 'radius must be between 10 m and 50 km';
    return null;
  }
  let ring = g.ring;
  if (ring.length > 1 && ring[0]!.lat === ring[ring.length - 1]!.lat && ring[0]!.lon === ring[ring.length - 1]!.lon) ring = ring.slice(0, -1);
  if (ring.length < 3) return 'a polygon needs at least 3 distinct points';
  if (ring.length > 200) return 'a polygon may have at most 200 points';
  if (!ring.every(okPt)) return 'polygon has an invalid coordinate';
  const n = ring.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
    if (segmentsCross(ring[i]!, ring[(i + 1) % n]!, ring[j]!, ring[(j + 1) % n]!)) return 'polygon edges cross each other';
  }
  let area = 0;
  for (let i = 0; i < n; i++) { const a = ring[i]!, b = ring[(i + 1) % n]!; area += a.lon * b.lat - b.lon * a.lat; }
  if (Math.abs(area) < 1e-12) return 'polygon has no area';
  return null;
}

/** Accuracy-aware classification (FR-GEO-002): a point whose accuracy radius straddles the boundary is uncertain. */
export function classifyPoint(p: LatLon, accuracyM: number, g: GeofenceShape): { cls: GeoClass; distanceM: number; confidence: number } {
  const d = signedDistanceM(p, g);
  const cls: GeoClass = d >= accuracyM ? 'inside' : d <= -accuracyM ? 'outside' : 'uncertain';
  const confidence = cls === 'uncertain' || d === 0 ? 0 : Math.max(0, Math.min(1, 1 - accuracyM / Math.abs(d)));
  return { cls, distanceM: d, confidence };
}

export interface GeofenceTrackState {
  state: 'unknown' | 'inside' | 'outside';
  since: number | null;
  candidate: { type: 'enter' | 'exit'; since: number } | null;
  ignored: number; // points skipped for poor accuracy or uncertainty (kept for audit)
}
export const initialGeofenceState = (): GeofenceTrackState => ({ state: 'unknown', since: null, candidate: null, ignored: 0 });
export interface GeofencePolicy { dwellSec: number; exitDwellSec: number; accuracyCeilingM: number }

/**
 * Hysteresis reducer: a transition is confirmed only after classified points keep agreeing for the dwell time.
 * Uncertain points neither confirm nor cancel a candidate. Returns the new state and at most one event.
 */
export function reduceGeofence(
  prev: GeofenceTrackState, pt: { at: number; pos: LatLon; accuracyM: number }, g: GeofenceShape, policy: GeofencePolicy,
): { state: GeofenceTrackState; event: null | { type: 'entered' | 'exited'; at: number; accuracyM: number; confidence: number } } {
  const st: GeofenceTrackState = { ...prev, candidate: prev.candidate ? { ...prev.candidate } : null };
  if (pt.accuracyM > policy.accuracyCeilingM) { st.ignored++; return { state: st, event: null }; }
  const { cls, confidence } = classifyPoint(pt.pos, pt.accuracyM, g);
  if (cls === 'uncertain') { st.ignored++; return { state: st, event: null }; }
  const want = cls === 'inside' ? 'enter' : 'exit';
  const settled = (cls === 'inside' && st.state === 'inside') || (cls === 'outside' && st.state === 'outside');
  if (settled) { st.candidate = null; return { state: st, event: null }; }
  if (st.state === 'unknown' && cls === 'outside') { // nothing to report: was never inside
    st.state = 'outside'; st.since = pt.at; st.candidate = null; return { state: st, event: null };
  }
  if (!st.candidate || st.candidate.type !== want) st.candidate = { type: want, since: pt.at };
  const dwellMs = (want === 'enter' ? policy.dwellSec : policy.exitDwellSec) * 1000;
  if (pt.at - st.candidate.since >= dwellMs) {
    st.state = cls; st.since = st.candidate.since; st.candidate = null;
    return { state: st, event: { type: want === 'enter' ? 'entered' : 'exited', at: pt.at, accuracyM: pt.accuracyM, confidence } };
  }
  return { state: st, event: null };
}
