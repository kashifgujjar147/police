// Web portal shell: sign-in flows, permission-aware navigation, realtime connection, SOS banner, routing.
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type Locale, dirOf } from '@sf/i18n';
import { ApiError, connectStream, get, patch, post, refresh, session, setTenant, type StreamStatus } from './api.ts';
import { Ctx, Form, type Me, Modal, Secret, makeT, useApp } from './ui.tsx';
import { Alerts, Attendance, CommandCentre, DutySummary, Help, IncidentDetail, Incidents, MyData, Notifications, Overview, Planner, Reports } from './ops.tsx';
import { Account, Audit, Devices, Organisation, Platform, Privacy, Roles, Settings, Sites, Staff } from './admin.tsx';

const initialLocale = (): Locale => { try { const s = localStorage.getItem('sf.locale'); if (s === 'en' || s === 'ar') return s; } catch { /* ignore */ } return navigator.language.startsWith('ar') ? 'ar' : 'en'; };
const useHash = () => { const [h, set] = useState(location.hash || '#/'); useEffect(() => { const f = () => set(location.hash || '#/'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []); return h; };

function AuthScreens({ locale, setLocale, onSignedIn }: { locale: Locale; setLocale(l: Locale): void; onSignedIn(platform: boolean): void }) {
  const t = makeT(locale); const hash = useHash(); const params = new URLSearchParams(hash.split('?')[1] ?? '');
  const [step, setStep] = useState<any>(null); const [mode, setMode] = useState<'login' | 'activate' | 'forgot' | 'platform' | 'platformRegister'>(hash.startsWith('#/activate') ? 'activate' : hash.startsWith('#/platform/register') ? 'platformRegister' : hash.startsWith('#/platform') ? 'platform' : 'login'); const [msg, setMsg] = useState('');
  const [platformEmail, setPlatformEmail] = useState('');
  const [codeRequired, setCodeRequired] = useState(true); // simple local mode: Create account needs no code
  useEffect(() => { void get('/platform/auth/signup-options').then((o: any) => {
    const simple = o.codeRequired === false; setCodeRequired(!simple);
    if (simple && (location.hash === '' || location.hash === '#/')) { setMode('platform'); location.hash = '#/platform'; } // simple local mode: start on email + password
  }).catch(() => {}); }, []);
  // Platform sign-in errors: generic for wrong email/password (no account enumeration), separate network and rate-limit messages.
  const platformErr = (e: unknown, mfa = false) => {
    if (!(e instanceof ApiError)) return e;
    const m = e.code === 'NETWORK' ? t('auth.connectionError') : e.code === 'RATE_LIMITED' ? t('auth.tooManyAttempts')
      : e.code === 'UNAUTHENTICATED' ? (mfa ? (/expired/i.test(e.message) ? e.message : t('auth.mfaWrong')) : t('auth.badCredentials')) : null;
    return m ? new ApiError(e.status, e.code, m, e.fieldErrors, e.details, e.requestId) : e;
  };
  const guard = async <T,>(p: Promise<T>, mfa = false) => { try { return await p; } catch (e) { throw platformErr(e, mfa); } };
  const mfaPost = (platform: boolean, path: string, body: unknown) => (platform ? guard(post(path, body), true) : post(path, body));
  const emailField = { name: 'email', label: t('auth.email'), type: 'email' as const, required: true, autoComplete: 'username', ltr: true, requiredMessage: t('auth.emailRequired'), validate: (x: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x.trim()) ? null : t('auth.emailInvalid')) };
  const ctx = { me: { tenant: { timezone: 'UTC', digitStyle: 'western' } } as any, locale, setLocale, t, fmt: { locale, timezone: 'UTC' }, can: () => false, toast: () => {}, labels: {}, go: () => {} };
  const finish = (r: any, platform = false) => { if (r.recoveryCodes) { setStep({ kind: 'codes', codes: r.recoveryCodes, r, platform }); return; } session.token = r.accessToken; session.platform = platform; onSignedIn(platform); };
  useEffect(() => { // email verification and password reset links
    if (hash.startsWith('#/verify-email')) void post('/auth/verify-email', { tenant: params.get('tenant'), token: params.get('token') }).then(() => setMsg('✓'), (e) => setMsg(e.message));
  }, []);
  const lang = <div className="row end"><label htmlFor="lang" className="sr">{t('common.language')}</label><select id="lang" style={{ width: 'auto' }} value={locale} onChange={(e: any) => setLocale(e.target.value)}><option value="en">English</option><option value="ar">العربية</option></select></div>;
  let body;
  if (hash.startsWith('#/reset')) body = <Form submit={t('common.save')} fields={[{ name: 'password', label: t('auth.newPassword'), type: 'password', required: true, help: t('auth.passwordHelp'), autoComplete: 'new-password' }]} onSubmit={async (v) => { await post('/auth/password/reset', { tenant: params.get('tenant'), token: params.get('token'), password: v.password }); setMsg(t('auth.resetDone')); location.hash = '#/'; }} />;
  else if (step?.kind === 'mfa') body = <><p>{t('auth.mfaHelp')}</p><Form submit={t('auth.continue')} fields={[{ name: 'code', label: t('auth.mfaCode'), required: true, autoComplete: 'one-time-code', ltr: true }]} onSubmit={async (v) => finish(await mfaPost(!!step.platform, step.platform ?'/platform/auth/mfa/verify' : '/auth/mfa/verify', { ...(step.platform ? {} : { tenant: session.tenant }), challengeToken: step.challengeToken, code: v.code }), step.platform)} /></>;
  else if (step?.kind === 'enrol') body = <><h2>{t('auth.mfaSetup')}</h2><p>{t('auth.mfaSetupHelp')}</p><Secret label={t('auth.mfaSecret')} value={step.secret} /><p className="small mono" style={{ wordBreak: 'break-all' }}>{step.uri}</p>
    <Form submit={t('auth.continue')} fields={[{ name: 'code', label: t('auth.mfaCode'), required: true, autoComplete: 'one-time-code', ltr: true }]} onSubmit={async (v) => finish(await mfaPost(!!step.platform, step.platform ?'/platform/auth/mfa/verify' : '/auth/mfa/confirm', { ...(step.platform ? {} : { tenant: session.tenant }), challengeToken: step.challengeToken, code: v.code }), step.platform)} /></>;
  else if (step?.kind === 'codes') body = <><h2>{t('auth.recoveryCodes')}</h2><p>{t('auth.recoveryHelp')}</p><Secret label={t('auth.recoveryCodes')} value={step.codes.join('  ')} /><button className="primary" onClick={() => { session.token = step.r.accessToken; onSignedIn(false); }}>{t('auth.continue')}</button></>;
  else if (mode === 'activate') body = <Form submit={t('auth.activate')} initial={{ tenant: params.get('tenant') ?? session.tenant, code: params.get('code') ?? '' }} fields={[{ name: 'tenant', label: t('auth.organisation'), required: true, ltr: true }, { name: 'code', label: t('auth.activationCode'), required: true, ltr: true }, { name: 'password', label: t('auth.newPassword'), type: 'password', required: true, help: t('auth.passwordHelp'), autoComplete: 'new-password' }]}
    onSubmit={async (v) => { const r = await post('/auth/activate', v); setTenant(v.tenant); setMsg(`${t('auth.activated')} ${t('staff.username')}: ${r.username}`); setMode('login'); location.hash = '#/'; }} />;
  else if (mode === 'forgot') body = <><p className="small">{t('auth.forgotHelp')}</p><Form submit={t('auth.sendLink')} initial={{ tenant: session.tenant }} fields={[{ name: 'tenant', label: t('auth.organisation'), required: true, ltr: true }, { name: 'identifier', label: t('auth.identifier'), required: true, ltr: true }]} onSubmit={async (v) => { const r = await post('/auth/password/forgot', v); setMsg(r.message); setMode('login'); }} /></>;
  else if (mode === 'platformRegister') body = <>{codeRequired && <p className="small">{t('auth.createAccountHelp')}</p>}<Form key={String(codeRequired)} submit={t('auth.createAccount')} initial={{ email: platformEmail }} fields={[
      ...(codeRequired ? [{ name: 'code', label: t('auth.setupCode'), required: true, ltr: true, requiredMessage: t('auth.codeRequired') }] : []), emailField,
      { name: 'password', label: t('auth.password'), type: 'password', required: true, autoComplete: 'new-password', help: t('auth.platformPasswordHelp'), requiredMessage: t('auth.passwordRequired'), validate: (x: string) => (x.length >= 12 ? null : t('auth.platformPasswordHelp')) },
      { name: 'confirm', label: t('auth.confirmPassword'), type: 'password', required: true, autoComplete: 'new-password', requiredMessage: t('auth.passwordRequired'), validate: (x: string, all) => (x === all.password ? null : t('auth.passwordMismatch')) }]}
    onSubmit={async (v) => {
      const r = await guard(post('/platform/auth/register', { ...(v.code ? { code: v.code.trim() } : {}), email: v.email.trim(), password: v.password }));
      setPlatformEmail(r.email); setMsg(r.mfaSetupRequired ? t('auth.accountCreated') : t('auth.accountCreatedSimple')); setMode('platform'); location.hash = '#/platform';
    }} /></>;
  else if (mode === 'platform') body = <Form key={platformEmail} submit={t('auth.signIn')} initial={{ email: platformEmail }} fields={[emailField, { name: 'password', label: t('auth.password'), type: 'password', required: true, autoComplete: 'current-password', requiredMessage: t('auth.passwordRequired') }]}
    onSubmit={async (v) => {
      const r = await guard(post('/platform/auth/login', { email: v.email.trim(), password: v.password }));
      if (r.accessToken) return finish(r, true);
      if (r.enrolmentRequired) {
        const e = await guard(post('/platform/auth/mfa/enroll', { challengeToken: r.challengeToken }), true);
        setStep({ kind: 'enrol', platform: true, challengeToken: r.challengeToken, secret: e.secret, uri: e.otpauthUri });
      } else {
        setStep({ kind: 'mfa', platform: true, challengeToken: r.challengeToken });
      }
    }} />;
  else body = <Form submit={t('auth.signIn')} initial={{ tenant: session.tenant }} fields={[{ name: 'tenant', label: t('auth.organisation'), required: true, autoComplete: 'organization', ltr: true }, { name: 'identifier', label: t('auth.identifier'), required: true, autoComplete: 'username', ltr: true }, { name: 'password', label: t('auth.password'), type: 'password', required: true, autoComplete: 'current-password' }]}
    onSubmit={async (v) => {
      setTenant(v.tenant); const r = await post('/auth/login', { ...v, client: 'web' });
      if (!r.mfaRequired) return finish(r);
      if (r.enrolmentRequired) { const e = await post('/auth/mfa/enroll', { tenant: v.tenant, challengeToken: r.challengeToken }); setStep({ kind: 'enrol', challengeToken: r.challengeToken, secret: e.secret, uri: e.otpauthUri }); } else setStep({ kind: 'mfa', challengeToken: r.challengeToken });
    }} />;
  return <Ctx.Provider value={ctx}><main className="login" id="main"><div className="card">{lang}<h1>{t('app.name')}</h1><p className="muted">{mode === 'platform' ? t('auth.platform') : t('app.tagline')}</p>{msg && <div className="notice" role="status">{msg}</div>}{body}
    {!step && (mode === 'platform' || mode === 'platformRegister') && <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
      {mode === 'platform' ? <button className="link" onClick={() => { setMsg(''); setMode('platformRegister'); location.hash = '#/platform/register'; }}>{t('auth.createAccount')}</button>
        : <button className="link" onClick={() => { setMsg(''); setMode('platform'); location.hash = '#/platform'; }}>{t('auth.signIn')}</button>}
      <button className="link" onClick={() => { setMsg(''); setMode('login'); location.hash = '#/login'; }}>{t('auth.orgSignIn')}</button></div>}
    {!step && mode !== 'platform' && mode !== 'platformRegister' && <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>{mode !== 'login' && <button className="link" onClick={() => setMode('login')}>{t('auth.signIn')}</button>}{mode !== 'activate' && <button className="link" onClick={() => setMode('activate')}>{t('auth.haveCode')}</button>}{mode !== 'forgot' && <button className="link" onClick={() => setMode('forgot')}>{t('auth.forgot')}</button>}<button className="link" onClick={() => { setMode('platform'); location.hash = '#/platform'; }}>{t('auth.platform')}</button></div>}</div></main></Ctx.Provider>;
}

interface NavItem { path: string; key: string; need?: string | string[]; group: 'ops' | 'admin' }
const NAV: NavItem[] = [
  { path: '/', key: 'nav.overview', need: 'dashboard.read', group: 'ops' }, { path: '/command', key: 'nav.command', need: 'location.live.read', group: 'ops' }, { path: '/alerts', key: 'nav.alerts', need: 'alert.read', group: 'ops' },
  { path: '/incidents', key: 'nav.incidents', need: ['incident.read', 'incident.create'], group: 'ops' }, { path: '/planner', key: 'nav.planner', need: 'assignment.read', group: 'ops' }, { path: '/attendance', key: 'nav.attendance', need: 'attendance.read', group: 'ops' }, { path: '/reports', key: 'nav.reports', need: ['report.read', 'report.incident.read'], group: 'ops' },
  { path: '/staff', key: 'nav.staff', need: 'staff.read', group: 'admin' }, { path: '/devices', key: 'nav.devices', need: 'device.read', group: 'admin' }, { path: '/organisation', key: 'nav.organisation', need: 'unit.read', group: 'admin' }, { path: '/sites', key: 'nav.sites', need: 'post.read', group: 'admin' },
  { path: '/roles', key: 'nav.roles', need: 'role.read', group: 'admin' }, { path: '/settings', key: 'nav.settings', need: 'settings.read', group: 'admin' }, { path: '/privacy', key: 'nav.privacy', need: ['legalhold.manage', 'privacy.subject.manage'], group: 'admin' }, { path: '/audit', key: 'nav.audit', need: 'audit.read', group: 'admin' }, { path: '/account', key: 'nav.account', need: 'tenant.read', group: 'admin' },
  { path: '/notifications', key: 'nav.notifications', group: 'ops' }, { path: '/me', key: 'nav.myData', group: 'ops' }, { path: '/help', key: 'nav.help', group: 'ops' },
];

function Shell({ me, locale, setLocale, onSignOut }: { me: Me; locale: Locale; setLocale(l: Locale): void; onSignOut(): void }) {
  const t = useMemo(() => makeT(locale), [locale]); const hash = useHash(); const path = hash.slice(1).split('?')[0] || '/';
  const perms = useMemo(() => new Set(me.permissions), [me]); const can = useCallback((p: string) => perms.has(p), [perms]);
  const [toasts, setToasts] = useState<{ id: number; msg: string; bad?: boolean }[]>([]);
  const toast = useCallback((msg: string, bad?: boolean) => { const id = Date.now() + Math.random(); setToasts((x) => [...x, { id, msg, bad }]); setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 5000); }, []);
  const [live, setLive] = useState(0); const [status, setStatus] = useState<StreamStatus>('connecting'); const [sos, setSos] = useState<any[]>([]); const [unread, setUnread] = useState(0); const [labels, setLabels] = useState<any>({}); const [tile, setTile] = useState({ url: '', attribution: '' });
  const bump = useRef<number | null>(null);
  useEffect(() => {
    void get('/tenant/labels').then((l) => setLabels(l.labels ?? {})).catch(() => {});
    if (can('settings.read')) void get('/tenant/settings').then((s) => setTile({ url: s.effective.map.tileUrl, attribution: s.effective.map.attribution })).catch(() => {});
    const loadSos = () => { if (can('incident.read')) void get('/incidents?kind=sos&status=new&limit=20').then((r) => setSos(r.items)).catch(() => {}); };
    const loadUnread = () => void get('/notifications?limit=1&unread=true').then((r) => setUnread(r.unreadCount)).catch(() => {});
    loadSos(); loadUnread();
    const stop = connectStream((e) => {
      if (e.type === 'sos:created' || (e.type === 'incident:updated' && e.payload.kind === 'sos')) loadSos();
      if (e.type === 'notification:created') { loadUnread(); if (e.payload.critical) beep(); }
      if (bump.current === null) bump.current = window.setTimeout(() => { bump.current = null; setLive((x) => x + 1); }, 400); // coalesce bursts into one refresh
    }, setStatus);
    return stop;
  }, []);
  useEffect(() => { document.getElementById('page-title')?.focus(); }, [path]);
  const ctx = { me, locale, setLocale, t, fmt: { locale, timezone: me.tenant.timezone, digitStyle: me.tenant.digitStyle }, can, toast, labels, go: (p: string) => { location.hash = `#${p}`; } };
  const visible = NAV.filter((n) => !n.need || (Array.isArray(n.need) ? n.need.some(can) : can(n.need)));
  const route = () => {
    const m = (re: RegExp) => re.exec(path)?.[1];
    if (path === '/') return can('dashboard.read') ? <Overview live={live} /> : <MyData />;
    if (path === '/command') return <CommandCentre live={live} tile={tile} />;
    if (path === '/alerts') return <Alerts live={live} />;
    if (path === '/incidents') return <Incidents live={live} />;
    const inc = m(/^\/incidents\/([\w-]+)$/); if (inc) return <IncidentDetail id={inc} live={live} />;
    if (path === '/planner') return <Planner live={live} />;
    if (path === '/attendance') return <Attendance live={live} />;
    const att = m(/^\/attendance\/([\w-]+)$/); if (att) return <DutySummary id={att} live={live} />;
    if (path === '/reports') return <Reports />;
    if (path === '/notifications') return <Notifications live={live} />;
    if (path === '/me') return <MyData />;
    if (path === '/help') return <Help status={status} />;
    if (path === '/staff') return <Staff live={live} />;
    if (path === '/devices') return <Devices live={live} />;
    if (path === '/organisation') return <Organisation />;
    if (path === '/sites') return <Sites />;
    if (path === '/roles') return <Roles />;
    if (path === '/settings') return <Settings />;
    if (path === '/privacy') return <Privacy />;
    if (path === '/audit') return <Audit />;
    if (path === '/account') return <Account />;
    return <div className="card state">404</div>;
  };
  return <Ctx.Provider value={ctx}>
    <a className="skip" href="#main" onClick={(e: any) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>{t('common.skip')}</a>
    <div className="shell">
      <div className="top">{me.demoMode && <div className="banner demo" role="note">{t('app.demo')}</div>}
      {status === 'offline' && <div className="banner offline" role="status">{t('common.offline')}</div>}
      {sos.length > 0 && <div className="banner sos" role="alert">{t('inc.sosBanner', { name: sos[0].reporterName ?? '' })} · {sos[0].number}<button onClick={() => { location.hash = `#/incidents/${sos[0].id}`; }}>{t('inc.open')}</button>{sos.length > 1 && <span>+{sos.length - 1}</span>}</div>}
      <header className="topbar"><span className="brand">{t('app.name')}</span><span className="small">{me.tenant.name}</span><span className="spacer" />
        <span className="small" role="status" aria-live="polite">{status === 'live' ? `● ${t('common.connected')}` : status === 'reconnecting' ? `◌ ${t('common.reconnecting')}` : status === 'offline' ? `◌ ${t('common.disconnected')}` : '…'}</span>
        <a href="#/notifications" style={{ color: '#fff' }}>{t('nav.notifications')}{unread > 0 && ` (${unread})`}</a>
        <label htmlFor="lang2" className="sr">{t('common.language')}</label><select id="lang2" style={{ width: 'auto' }} value={locale} onChange={(e: any) => setLocale(e.target.value)}><option value="en">English</option><option value="ar">العربية</option></select>
        <span className="small">{me.displayName}</span><button onClick={onSignOut}>{t('common.signOut')}</button></header></div>
      <nav className="nav" aria-label="Main">{(['ops', 'admin'] as const).map((g) => { const items = visible.filter((n) => n.group === g); return items.length ? <div key={g}><h2>{t(g === 'ops' ? 'nav.operations' : 'nav.administration')}</h2>{items.map((n) => <a key={n.path} href={`#${n.path}`} aria-current={path === n.path || (n.path !== '/' && path.startsWith(n.path)) ? 'page' : undefined}><span>{t(n.key)}</span>{n.path === '/notifications' && unread > 0 && <b>{unread}</b>}</a>)}</div> : null; })}</nav>
      <main className="main" id="main" tabIndex={-1}>{!me.noticeAcknowledged && me.staffMemberId && me.roles.includes('field') && <NoticeGate />}{route()}</main>
    </div>
    <div className="toast" aria-live="assertive">{toasts.map((x) => <div key={x.id} className={x.bad ? 'bad' : ''}>{x.msg}</div>)}</div>
  </Ctx.Provider>;
}
function NoticeGate() {
  const { t, locale } = useApp(); const [n, setN] = useState<any>(null);
  useEffect(() => { void get('/privacy/notices/current').then(setN); }, []);
  if (!n?.notice || n.acknowledged) return null;
  return <Modal title={t('prv.notice')} onClose={() => {}}><div style={{ whiteSpace: 'pre-wrap' }}>{n.notice.texts[locale]}</div><div className="row end"><button className="primary" onClick={() => void post('/privacy/acknowledgements', { version: n.notice.version }).then(() => setN({ ...n, acknowledged: true }))}>{t('prv.accept')}</button></div></Modal>;
}
function beep() { try { const a = new AudioContext(); const o = a.createOscillator(); o.frequency.value = 880; o.connect(a.destination); o.start(); setTimeout(() => { o.stop(); void a.close(); }, 400); } catch { /* audio may be blocked */ } }

function PlatformShell({ locale, setLocale, onSignOut }: { locale: Locale; setLocale(l: Locale): void; onSignOut(): void }) {
  const t = useMemo(() => makeT(locale), [locale]); const [toasts, setToasts] = useState<string[]>([]);
  const ctx = { me: { tenant: { timezone: 'UTC', digitStyle: 'western', name: '', slug: '' }, permissions: [], roles: [] } as any, locale, setLocale, t, fmt: { locale, timezone: 'UTC' as string }, can: () => true, toast: (m: string) => { setToasts((x) => [...x, m]); setTimeout(() => setToasts((x) => x.slice(1)), 4000); }, labels: {}, go: () => {} };
  return <Ctx.Provider value={ctx}><div className="shell" style={{ gridTemplateColumns: '1fr' }}><header className="topbar"><span className="brand">{t('nav.platform')}</span><span className="spacer" /><select style={{ width: 'auto' }} value={locale} onChange={(e: any) => setLocale(e.target.value)} aria-label={t('common.language')}><option value="en">English</option><option value="ar">العربية</option></select><button onClick={onSignOut}>{t('common.signOut')}</button></header><main className="main" id="main"><Platform /></main></div><div className="toast">{toasts.map((x, i) => <div key={i}>{x}</div>)}</div></Ctx.Provider>;
}

function App() {
  const [locale, setLocaleState] = useState<Locale>(initialLocale()); const [me, setMe] = useState<Me | null>(null); const [phase, setPhase] = useState<'boot' | 'out' | 'in' | 'platform'>('boot');
  const setLocale = (l: Locale) => { setLocaleState(l); try { localStorage.setItem('sf.locale', l); } catch { /* ignore */ } if (phase === 'in') void patch('/auth/me', { locale: l }).catch(() => {}); };
  useEffect(() => { document.documentElement.lang = locale; document.documentElement.dir = dirOf(locale); }, [locale]);
  const loadMe = async () => { try { const m = await get<Me>('/auth/me'); setMe(m); setPhase('in'); } catch (e) { if (e instanceof ApiError && e.status !== 401) throw e; setPhase('out'); } };
  useEffect(() => { session.onSignedOut = () => { setMe(null); setPhase('out'); }; void refresh().then((ok) => (ok ? loadMe() : setPhase('out'))); }, []);
  const signOut = async () => { const wasPlatform = session.platform; try { await post(wasPlatform ? '/platform/auth/logout' : '/auth/logout'); } catch { /* ignore */ } session.token = null; session.platform = false; setMe(null); location.hash = wasPlatform ? '#/platform' : '#/'; setPhase('out'); }; // platform staff return to the platform sign-in
  if (phase === 'boot') return <div className="state">…</div>;
  if (phase === 'out') return <AuthScreens locale={locale} setLocale={setLocale} onSignedIn={(p) => (p ? setPhase('platform') : void loadMe())} />;
  if (phase === 'platform') return <PlatformShell locale={locale} setLocale={setLocale} onSignOut={() => void signOut()} />;
  return <Shell me={me!} locale={locale} setLocale={setLocale} onSignOut={() => void signOut()} />;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
