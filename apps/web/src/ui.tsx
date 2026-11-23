// Shared UI building blocks: app context, async state, tables, forms, modals, state chips.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { type FormatOpts, type Locale, fmtAge, fmtDateTime, fmtNumber, translate } from '@sf/i18n';
import { ApiError, get } from './api.ts';

export interface Me { userId: string; username: string; displayName: string; staffMemberId: string | null; roles: string[]; permissions: string[]; scopeUnitIds: string[]; noticeAcknowledged: boolean; tenant: { id: string; name: string; slug: string; status: string; timezone: string; defaultLocale: Locale; digitStyle: 'western' | 'arabic_indic' }; demoMode: boolean; platform?: boolean }
export interface AppCtx { me: Me; locale: Locale; setLocale(l: Locale): void; t(key: string, vars?: Record<string, string | number>): string; fmt: FormatOpts; can(p: string): boolean; toast(msg: string, bad?: boolean): void; labels: Record<string, any>; go(path: string): void }
export const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);
export const makeT = (locale: Locale) => (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars);

export function useLoad<T = any>(path: string | null, deps: unknown[] = []) {
  const [state, set] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const seq = useRef(0);
  const reload = useCallback(async (quiet = false) => {
    if (!path) { set({ data: null, error: null, loading: false }); return; }
    const mine = ++seq.current; if (!quiet) set((s) => ({ ...s, loading: true, error: null }));
    try { const data = await get<T>(path); if (mine === seq.current) set({ data, error: null, loading: false }); }
    catch (e) { if (mine === seq.current) set((s) => ({ data: quiet ? s.data : null, error: e as ApiError, loading: false })); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload, ...deps]);
  return { ...state, reload };
}

export function Async({ s, children, empty }: { s: { data: unknown; error: ApiError | null; loading: boolean; reload(): void }; children: ReactNode; empty?: boolean }) {
  const { t } = useApp();
  if (s.loading && !s.data) return <div className="card" aria-busy="true" aria-label={t('common.loading')}><div className="skeleton" style={{ width: '60%' }} /><div className="skeleton" /><div className="skeleton" style={{ width: '80%' }} /></div>;
  if (s.error && !s.data) return <div className="card state error" role="alert"><p>{s.error.status === 403 ? t('common.noPermission') : s.error.message}</p>{s.error.status !== 403 && <button onClick={() => s.reload()}>{t('common.retry')}</button>}</div>;
  if (empty) return <div className="card state">{t('common.none')}</div>;
  return <>{children}</>;
}

export function Page({ title, sub, actions, children }: { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  useEffect(() => { document.title = `${title} · SmartForce 360`; }, [title]);
  return <section aria-labelledby="page-title"><div className="page-head"><div className="grow"><h1 id="page-title" tabIndex={-1}>{title}</h1>{sub && <p>{sub}</p>}</div><div className="row">{actions}</div></div>{children}</section>;
}

export interface Col<R> { key: string; label: string; render?(row: R): ReactNode; num?: boolean }
export function Table<R extends Record<string, any>>({ cols, rows, onRow, selected, rowKey = 'id', caption }: { cols: Col<R>[]; rows: R[]; onRow?(r: R): void; selected?: string | null; rowKey?: string; caption: string }) {
  const { t } = useApp();
  if (!rows.length) return <div className="card state">{t('common.none')}</div>;
  return <div className="table-wrap"><table><caption className="sr">{caption}</caption><thead><tr>{cols.map((c) => <th key={c.key} scope="col">{c.label}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={String(r[rowKey] ?? i)} className={`${onRow ? 'click' : ''} ${selected && r[rowKey] === selected ? 'sel' : ''}`} onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? (e: any) => { if (e.key === 'Enter') onRow(r); } : undefined}>
      {cols.map((c) => <td key={c.key}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}</tr>)}</tbody></table></div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button'); first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) { // keep focus inside the dialog
        const f = [...ref.current.querySelectorAll<HTMLElement>('input, select, textarea, button, a[href]')].filter((x) => !x.hasAttribute('disabled'));
        if (!f.length) return; const a = f[0]!, z = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey); return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, []);
  return <div className="modal-back" onMouseDown={(e: any) => { if (e.target === e.currentTarget) onClose(); }}><div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}><h2>{title}</h2>{children}</div></div>;
}

export interface FieldDef {
  name: string; label: string; type?: 'text' | 'number' | 'select' | 'textarea' | 'date' | 'time' | 'checkbox' | 'password' | 'datetime-local' | 'email'; options?: { value: string; label: string }[]; required?: boolean; help?: string; autoComplete?: string; ltr?: boolean;
  /** When set, an empty value is caught in the browser and this message is shown beside the field. */
  requiredMessage?: string;
  /** Browser-side check before submitting; return a message to show beside the field, or null. The server still validates. */
  validate?(value: any, all: Record<string, any>): string | null | undefined;
}
const EyeIcon = ({ off }: { off: boolean }) => <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
  <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />{off && <path d="M3 3l18 18" />}</svg>;
/** Schema-driven form. Server field errors are shown beside the matching input; submit is disabled while pending to prevent double submission. */
export function Form({ fields, initial = {}, submit, onSubmit, onCancel, danger }: { fields: FieldDef[]; initial?: Record<string, any>; submit: string; onSubmit(v: Record<string, any>): Promise<void>; onCancel?(): void; danger?: boolean }) {
  const { t } = useApp();
  const [v, setV] = useState<Record<string, any>>(initial); const [busy, setBusy] = useState(false); const [err, setErr] = useState<ApiError | null>(null);
  const [ce, setCe] = useState<Record<string, string>>({}); const [shown, setShown] = useState<Record<string, boolean>>({});
  const fe = (name: string) => err?.fieldErrors.find((e) => e.path === name || e.path.endsWith(`.${name}`) || e.path.startsWith(`${name}.`) || e.path.startsWith(`${name}[`));
  const go = async (e: any) => {
    e.preventDefault(); if (busy) return;
    const local: Record<string, string> = {};
    for (const f of fields) { const x = v[f.name]; const empty = x === undefined || x === null || (typeof x === 'string' && x.trim() === '');
      const m = empty ? (f.requiredMessage ?? (f.required && f.type !== 'checkbox' ? t('common.required') : null)) : (f.validate?.(x, v) ?? null); if (m) local[f.name] = m; }
    setCe(local); if (Object.keys(local).length) { setErr(null); document.getElementById(`f-${fields.find((f) => local[f.name])!.name}`)?.focus(); return; }
    setBusy(true); setErr(null);
    const out: Record<string, any> = {};
    for (const f of fields) { const x = v[f.name]; if (f.type === 'checkbox') out[f.name] = !!x; else if (x === undefined || x === '') continue; else out[f.name] = f.type === 'number' ? Number(x) : x; }
    try { await onSubmit(out); } catch (ex) { setErr(ex instanceof ApiError ? ex : new ApiError(0, 'ERROR', String((ex as Error).message))); } finally { setBusy(false); }
  };
  return <form onSubmit={go} noValidate>
    {err && <div className="notice danger" role="alert">{err.code === 'VERSION_CONFLICT' ? t('common.conflict') : err.message}{err.fieldErrors.filter((e) => !fields.some((f) => fe(f.name) === e)).map((e) => <div key={e.path} className="small">{e.path}: {e.message}</div>)}</div>}
    {fields.map((f) => { const id = `f-${f.name}`; const e = fe(f.name); const le = ce[f.name]; const bad = !!(e || le); const common = { id, name: f.name, required: f.required, 'aria-invalid': bad, 'aria-describedby': bad ? `${id}-e` : f.help ? `${id}-h` : undefined, dir: f.ltr ? 'ltr' : undefined, autoComplete: f.autoComplete ?? 'off' };
      const set = (x: any) => { setV((p) => ({ ...p, [f.name]: x })); if (le) setCe((p) => { const n = { ...p }; delete n[f.name]; return n; }); };
      return <div className={`field ${f.type === 'checkbox' ? 'inline' : ''}`} key={f.name}>
        {f.type === 'checkbox' && <input type="checkbox" {...common} checked={!!v[f.name]} onChange={(ev: any) => set(ev.target.checked)} />}
        <label htmlFor={id}>{f.label}{f.required && <span aria-hidden="true"> *</span>}</label>
        {f.type === 'select' ? <select {...common} value={v[f.name] ?? ''} onChange={(ev: any) => set(ev.target.value)}><option value="">—</option>{f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          : f.type === 'textarea' ? <textarea {...common} value={v[f.name] ?? ''} onChange={(ev: any) => set(ev.target.value)} />
          : f.type === 'password' ? <div className="pw"><input type={shown[f.name] ? 'text' : 'password'} {...common} value={v[f.name] ?? ''} onChange={(ev: any) => set(ev.target.value)} />
              <button type="button" className="pw-toggle" aria-controls={id} aria-pressed={!!shown[f.name]} aria-label={shown[f.name] ? t('auth.hidePassword') : t('auth.showPassword')} title={shown[f.name] ? t('auth.hidePassword') : t('auth.showPassword')}
                onClick={() => setShown((p) => ({ ...p, [f.name]: !p[f.name] }))}><EyeIcon off={!!shown[f.name]} /></button></div>
          : f.type !== 'checkbox' ? <input type={f.type ?? 'text'} {...common} value={v[f.name] ?? ''} onChange={(ev: any) => set(ev.target.value)} step={f.type === 'number' ? 'any' : undefined} /> : null}
        {f.help && <div className="help" id={`${id}-h`}>{f.help}</div>}{le ? <div className="err" id={`${id}-e`} role="alert">{le}</div> : e && <div className="err" id={`${id}-e`}>{f.label} {e.message}</div>}
      </div>; })}
    <div className="row end">{onCancel && <button type="button" onClick={onCancel}>{t('common.cancel')}</button>}<button type="submit" className={danger ? 'danger' : 'primary'} disabled={busy}>{busy ? t('common.loading') : submit}</button></div>
  </form>;
}
export function FormModal(p: { title: string; fields: FieldDef[]; initial?: Record<string, any>; submit?: string; onSubmit(v: Record<string, any>): Promise<void>; onClose(): void; danger?: boolean; intro?: ReactNode }) {
  const { t } = useApp();
  return <Modal title={p.title} onClose={p.onClose}>{p.intro}<Form fields={p.fields} initial={p.initial} submit={p.submit ?? t('common.save')} onSubmit={p.onSubmit} onCancel={p.onClose} danger={p.danger} /></Modal>;
}
/** Sensitive actions always ask for a reason (recorded in the audit log). */
export function ReasonModal({ title, onSubmit, onClose, danger, intro, extra = [] }: { title: string; onSubmit(v: Record<string, any>): Promise<void>; onClose(): void; danger?: boolean; intro?: ReactNode; extra?: FieldDef[] }) {
  const { t } = useApp();
  return <FormModal title={title} onClose={onClose} danger={danger} submit={t('common.confirm')} intro={intro} onSubmit={onSubmit} fields={[...extra, { name: 'reason', label: t('common.reason'), type: 'textarea', required: true, help: t('common.reasonRequired') }]} />;
}

// State is never shown by colour alone: every chip has a shape and a text label (FR-A11Y-001).
const CHIP: Record<string, [string, string]> = {
  on_duty: ['ok', '●'], on_break: ['info', '◐'], not_started: ['warn', '○'], checked_out: ['plain', '◻'], exception: ['danger', '▲'], sos: ['sos', '✚'], stale_offline: ['stale', '◌'],
  live: ['ok', '●'], recent: ['info', '◐'], stale: ['stale', '◌'], unknown: ['stale', '?'],
  low: ['plain', '▽'], medium: ['warn', '◆'], high: ['danger', '▲'], critical: ['sos', '✚'],
  open: ['danger', '▲'], acknowledged: ['info', '✓'], snoozed: ['warn', '⏸'], resolved: ['ok', '✓'], auto_resolved: ['ok', '✓'],
  new: ['danger', '▲'], dispatched: ['info', '➤'], on_scene: ['info', '◉'], closed: ['plain', '◻'], cancelled_false_alarm: ['plain', '✕'], reopened: ['warn', '↺'],
  scheduled: ['plain', '○'], started: ['ok', '●'], ended: ['plain', '◻'], system_closed: ['warn', '◆'], missed: ['danger', '✕'], cancelled: ['plain', '✕'], reviewed: ['ok', '✓'],
  draft: ['warn', '✎'], published: ['ok', '✓'], revised_unpublished: ['warn', '✎'], invited: ['warn', '○'], active: ['ok', '●'], suspended: ['danger', '⏸'], offboarded: ['plain', '◻'], pending_approval: ['warn', '○'], revoked: ['plain', '✕'],
  success: ['ok', '✓'], denied: ['danger', '✕'], failed: ['danger', '✕'], measured: ['ok', '●'], estimated: ['warn', '≈'], system_flag: ['info', '⚑'], pending: ['warn', '○'], approved: ['ok', '✓'], rejected: ['danger', '✕'], returned: ['warn', '↺'],
  received_by_server: ['info', '◐'], notified: ['info', '➤'], acknowledged_by_human: ['ok', '✓'], completed: ['ok', '✓'], waived: ['plain', '–'], ready: ['ok', '✓'], queued: ['warn', '○'], valid: ['ok', '✓'],
};
export function Chip({ value, ns }: { value: string | null | undefined; ns: string }) {
  const { t } = useApp(); if (!value) return <span className="muted">—</span>;
  const [cls, icon] = CHIP[value] ?? ['plain', '•']; const key = `${ns}.${value}`; const label = t(key);
  return <span className={`chip ${cls}`}><i aria-hidden="true">{icon}</i>{label === key ? value.replace(/_/g, ' ') : label}</span>;
}
export function Fresh({ freshness, ageSec }: { freshness: string; ageSec: number | null }) {
  const { t, fmt } = useApp();
  return <span className="row" style={{ gap: 6 }}><Chip value={freshness} ns="fresh" /><span className="small muted">{ageSec === null ? t('fresh.never') : t('fresh.age', { age: fmtAge(ageSec, fmt) })}</span></span>;
}
export const When = ({ at, style }: { at: string | number | null | undefined; style?: 'datetime' | 'date' | 'time' }) => { const { fmt } = useApp(); return <span className="num">{fmtDateTime(at, fmt, style)}</span>; };
export const Num = ({ n }: { n: number | null | undefined }) => { const { fmt } = useApp(); return <span className="num">{fmtNumber(n, fmt)}</span>; };
export function AsOf({ at, onRefresh }: { at: string | number | null | undefined; onRefresh?(): void }) {
  const { t } = useApp(); return <span className="small muted row" style={{ gap: 6 }}>{t('common.asOf')} <When at={at} />{onRefresh && <button className="link" onClick={onRefresh}>{t('common.refresh')}</button>}</span>;
}
export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string }[]; value: string; onChange(id: string): void }) {
  return <div className="tabs" role="tablist">{tabs.map((x) => <button key={x.id} role="tab" aria-selected={value === x.id} onClick={() => onChange(x.id)}>{x.label}</button>)}</div>;
}
export function Secret({ label, value }: { label: string; value: string }) {
  const { t, toast } = useApp();
  return <div className="stack"><div className="notice warn">{t('common.shownOnce')}</div><div><label>{label}</label><div className="secret" data-testid="secret">{value}</div></div><button onClick={() => { void navigator.clipboard?.writeText(value).then(() => toast('✓')); }}>{t('common.copy')}</button></div>;
}
/** Runs an action with a toast for success or the server's message for failure. */
export function useAct() {
  const { toast, t } = useApp();
  return async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast(ok); return true; } catch (e) { toast(e instanceof ApiError && e.code === 'VERSION_CONFLICT' ? t('common.conflict') : (e as Error).message, true); return false; } };
}
export const KV = ({ items }: { items: [string, ReactNode][] }) => <dl className="kv">{items.map(([k, v]) => <><dt key={`k${k}`}>{k}</dt><dd key={`v${k}`}>{v ?? '—'}</dd></>)}</dl>;
