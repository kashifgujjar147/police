// DST-safe local time handling and shift recurrence (FR-DUTY-001). Pure; uses only Intl.
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}
export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
/** Offset (ms) of the zone at a UTC instant: local = utc + offset. */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = Object.fromEntries(fmt(tz).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}
/** Convert a wall-clock date+time in a zone to a UTC instant. Times inside a spring-forward gap move forward. */
export function localToUtcMs(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(first, tz);
  return second;
}
export function utcToLocalDate(utcMs: number, tz: string): string {
  return new Date(utcMs + tzOffsetMs(utcMs, tz)).toISOString().slice(0, 10);
}
export function utcToLocalTime(utcMs: number, tz: string): string {
  return new Date(utcMs + tzOffsetMs(utcMs, tz)).toISOString().slice(11, 16);
}
export function addDays(date: string, n: number): string {
  const t = Date.parse(date + 'T00:00:00Z') + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export const weekdayOf = (date: string): (typeof DAYS)[number] => DAYS[new Date(date + 'T00:00:00Z').getUTCDay()]!;

export interface Recurrence { freq: 'DAILY' | 'WEEKLY'; interval: number; byDay: string[] | null; until: string | null; count: number | null }
/** RRULE subset: FREQ=DAILY|WEEKLY;INTERVAL=n;BYDAY=MO,TU;UNTIL=YYYYMMDD;COUNT=n */
export function parseRecurrence(rule: string): Recurrence | { error: string } {
  const out: Recurrence = { freq: 'DAILY', interval: 1, byDay: null, until: null, count: null };
  let sawFreq = false;
  for (const part of rule.replace(/^RRULE:/i, '').split(';').filter(Boolean)) {
    const [k, v] = part.split('=');
    if (!k || !v) return { error: `malformed part "${part}"` };
    switch (k.toUpperCase()) {
      case 'FREQ': if (v !== 'DAILY' && v !== 'WEEKLY') return { error: 'FREQ must be DAILY or WEEKLY' }; out.freq = v; sawFreq = true; break;
      case 'INTERVAL': out.interval = Number(v); if (!Number.isInteger(out.interval) || out.interval < 1 || out.interval > 52) return { error: 'INTERVAL must be 1–52' }; break;
      case 'BYDAY': out.byDay = v.split(','); if (!out.byDay.every((x) => (DAYS as readonly string[]).includes(x))) return { error: 'BYDAY has an unknown day' }; break;
      case 'UNTIL': if (!/^\d{8}/.test(v)) return { error: 'UNTIL must be YYYYMMDD' }; out.until = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`; break;
      case 'COUNT': out.count = Number(v); if (!Number.isInteger(out.count) || out.count < 1 || out.count > 1000) return { error: 'COUNT must be 1–1000' }; break;
      default: return { error: `unsupported rule part ${k}` };
    }
  }
  if (!sawFreq) return { error: 'FREQ is required' };
  return out;
}

export interface ShiftDef { startDate: string; startsAtLocal: string; endsAtLocal: string; timezone: string; recurrenceRule?: string | null }
export interface Occurrence { localDate: string; startsAt: number; endsAt: number }

/** Expand a shift into concrete occurrences whose local date falls in [from, to]. Overnight shifts belong to the start date. */
export function expandOccurrences(shift: ShiftDef, from: string, to: string, max = 400): Occurrence[] {
  const out: Occurrence[] = [];
  const make = (date: string): Occurrence => {
    const startsAt = localToUtcMs(date, shift.startsAtLocal, shift.timezone);
    const endDate = shift.endsAtLocal <= shift.startsAtLocal ? addDays(date, 1) : date;
    return { localDate: date, startsAt, endsAt: localToUtcMs(endDate, shift.endsAtLocal, shift.timezone) };
  };
  if (!shift.recurrenceRule) {
    if (shift.startDate >= from && shift.startDate <= to) out.push(make(shift.startDate));
    return out;
  }
  const r = parseRecurrence(shift.recurrenceRule);
  if ('error' in r) return out;
  let produced = 0;
  for (let date = shift.startDate, n = 0; date <= to && n < 4000; date = addDays(date, 1), n++) {
    if (r.until && date > r.until) break;
    const dayIndex = Math.round((Date.parse(date) - Date.parse(shift.startDate)) / 86400000);
    let match: boolean;
    if (r.freq === 'DAILY') match = dayIndex % r.interval === 0 && (!r.byDay || r.byDay.includes(weekdayOf(date)));
    else {
      const startDow = new Date(shift.startDate + 'T00:00:00Z').getUTCDay();
      const week = Math.floor((dayIndex + startDow) / 7);
      match = week % r.interval === 0 && (r.byDay ? r.byDay.includes(weekdayOf(date)) : weekdayOf(date) === weekdayOf(shift.startDate));
    }
    if (!match) continue;
    produced++;
    if (r.count && produced > r.count) break;
    if (date >= from) out.push(make(date));
    if (out.length >= max) break;
  }
  return out;
}
