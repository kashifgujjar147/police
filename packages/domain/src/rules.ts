// Pure business rules: freshness, duty windows, overlap, display classification, review signals, checkpoint validation.
import type { DutyDisplayState, DutyState, Freshness, ScanResult } from '@sf/contracts';
import { haversineM, type LatLon } from './geo.ts';

/** effectiveTime = min(recordedAt, receivedAt): a device clock set in the future cannot make a point look fresher (TS §11.3). */
export const effectiveTime = (recordedAt: number, receivedAt: number) => Math.min(recordedAt, receivedAt);

export function freshness(now: number, effective: number | null | undefined, t: { liveSec: number; recentSec: number }): Freshness {
  if (effective === null || effective === undefined) return 'unknown';
  const age = (now - effective) / 1000;
  if (age <= t.liveSec) return 'live';
  if (age <= t.recentSec) return 'recent';
  return 'stale';
}

export type StartCheck = { ok: true; reasonCodes: string[] } | { ok: false; code: 'OUTSIDE_DUTY_WINDOW' | 'GEOFENCE_REQUIRED'; reasonCodes: string[] };
/** FR-ATT-001 / TS §12.2. `at` is the device time the person started; uncertain geofence never blocks under Warn. */
export function checkStart(input: {
  at: number; startsAt: number; endsAt: number; earlyMin: number; lateMin: number;
  geofencePolicy: 'off' | 'warn' | 'require'; geofenceClass: 'inside' | 'outside' | 'uncertain' | 'none';
}): StartCheck {
  const reasons: string[] = [];
  if (input.at < input.startsAt - input.earlyMin * 60000) return { ok: false, code: 'OUTSIDE_DUTY_WINDOW', reasonCodes: ['TOO_EARLY'] };
  if (input.at > input.endsAt) return { ok: false, code: 'OUTSIDE_DUTY_WINDOW', reasonCodes: ['SHIFT_ENDED'] };
  if (input.at > input.startsAt + input.lateMin * 60000) reasons.push('LATE_START');
  if (input.geofencePolicy !== 'off' && input.geofenceClass !== 'inside') {
    if (input.geofenceClass === 'none') reasons.push('NO_LOCATION_AT_START');
    else if (input.geofenceClass === 'uncertain') reasons.push('GEOFENCE_UNCERTAIN');
    else if (input.geofencePolicy === 'require') return { ok: false, code: 'GEOFENCE_REQUIRED', reasonCodes: ['OUTSIDE_GEOFENCE'] };
    else reasons.push('OUTSIDE_GEOFENCE_WARN');
    if (input.geofencePolicy === 'require' && input.geofenceClass === 'none') return { ok: false, code: 'GEOFENCE_REQUIRED', reasonCodes: ['NO_LOCATION_AT_START'] };
  }
  return { ok: true, reasonCodes: reasons };
}

export const overlaps = (a: { startsAt: number; endsAt: number }, b: { startsAt: number; endsAt: number }) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/** Display classification for the command centre (PRD §8.11): derived from duty state + SOS + alerts + freshness. */
export function displayState(i: { duty: DutyState; activeSos: boolean; openExceptions: number; fresh: Freshness }): DutyDisplayState {
  if (i.activeSos) return 'sos';
  if (i.duty === 'scheduled' || i.duty === 'missed') return 'not_started';
  if (i.duty === 'ended' || i.duty === 'system_closed' || i.duty === 'reviewed' || i.duty === 'cancelled') return 'checked_out';
  if (i.openExceptions > 0) return 'exception';
  if (i.duty === 'on_break') return 'on_break';
  if (i.fresh === 'stale' || i.fresh === 'unknown') return 'stale_offline';
  return 'on_duty';
}

export interface PointLite { pos: LatLon; at: number; accuracyM: number; mock?: boolean }
/** Review signals with supporting facts (FR-LOC-007). Signals are never findings. */
export function pointSignals(p: PointLite, prev: PointLite | null, cfg: { minAccuracyM: number; implausibleSpeedMps: number; skewSignalSec: number }, clockSkewMs: number): { signal: string; facts: Record<string, number> }[] {
  const out: { signal: string; facts: Record<string, number> }[] = [];
  if (p.accuracyM > cfg.minAccuracyM) out.push({ signal: 'low_accuracy', facts: { accuracyM: p.accuracyM, thresholdM: cfg.minAccuracyM } });
  if (p.mock) out.push({ signal: 'mock_location', facts: {} });
  if (Math.abs(clockSkewMs) > cfg.skewSignalSec * 1000) out.push({ signal: 'clock_skew', facts: { clockSkewMs } });
  if (prev && p.at > prev.at) {
    const dt = (p.at - prev.at) / 1000;
    const dist = Math.max(0, haversineM(prev.pos, p.pos) - prev.accuracyM - p.accuracyM);
    const speed = dist / dt;
    if (speed > cfg.implausibleSpeedMps) out.push({ signal: 'implausible_speed', facts: { speedMps: Math.round(speed), distanceM: Math.round(dist), seconds: Math.round(dt) } });
  }
  return out;
}

/** Checkpoint scan validation order (TS §13). Exactly one result for every attempt. */
export function validateScan(i: {
  checkpointFound: boolean; assignmentActive: boolean; inPlan: boolean; scannedAt: number;
  windowStart: number | null; windowEnd: number | null; tokenRequired: boolean; tokenValid: boolean;
  geofenceClass: 'inside' | 'outside' | 'uncertain' | 'none' | 'not_required';
  ordered: boolean; previousCompleted: boolean; alreadyValid: boolean;
}): ScanResult {
  if (!i.checkpointFound) return 'invalid_token';
  if (!i.assignmentActive || !i.inPlan) return 'not_assigned';
  if (i.windowStart !== null && i.scannedAt < i.windowStart) return 'early';
  if (i.windowEnd !== null && i.scannedAt > i.windowEnd) return 'late';
  if (i.tokenRequired && !i.tokenValid) return 'invalid_token';
  if (i.geofenceClass === 'outside') return 'wrong_location';
  if (i.ordered && !i.previousCompleted) return 'out_of_order';
  if (i.alreadyValid) return 'duplicate';
  return 'valid';
}

/** Alert de-duplication key: type|subject|window (TS §15.1). */
export const alertDedupeKey = (type: string, subject: string, window: string) => `${type}|${subject}|${window}`;

/** Location coverage: share of tracked minutes that have at least one point within the accuracy ceiling. */
export function coveragePct(points: { at: number; accuracyM: number }[], from: number, to: number, maxAccuracyM: number, excluded: { from: number; to: number }[] = []): number | null {
  const total = Math.floor((to - from) / 60000);
  if (total <= 0) return null;
  const isExcluded = (m: number) => excluded.some((e) => from + m * 60000 >= e.from && from + m * 60000 < e.to);
  const covered = new Set<number>();
  for (const p of points) if (p.accuracyM <= maxAccuracyM && p.at >= from && p.at < to) covered.add(Math.floor((p.at - from) / 60000));
  let need = 0, have = 0;
  for (let m = 0; m < total; m++) { if (isExcluded(m)) continue; need++; if (covered.has(m)) have++; }
  return need === 0 ? null : Math.round((have / need) * 1000) / 10;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0), pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0); }
  return 0;
}
