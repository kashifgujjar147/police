// "My duty" for field staff in the web app / installed PWA: device set-up, privacy notice, start/break/end duty,
// location sharing while the app is open, SOS. Same server rules as the phone app (signed device requests, gates, audit).
// Browsers stop location when the app is closed or the phone is locked: the screen says so plainly (never shows fake "live").
import { useEffect, useRef, useState } from 'react';
import { ApiError, post } from './api.ts';
import { deviceSupported, registerDevice, signedPost, storedDevice } from './device.ts';
import { Async, Modal, Page, When, useApp, useLoad } from './ui.tsx';

type Fix = { lat: number; lon: number; accuracyM: number };
const iso = () => new Date().toISOString();
const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
let lastFix: (Fix & { at: number }) | null = null; // kept fresh by location sharing; actions reuse it instead of waiting for GPS again
function currentFix(): Promise<Fix | null> {
  if (lastFix && Date.now() - lastFix.at < 60000) { const { at: _at, ...f } = lastFix; return Promise.resolve(f); }
  return new Promise((res) => {
    if (!('geolocation' in navigator)) return res(null);
    navigator.geolocation.getCurrentPosition((p) => { const f = { lat: p.coords.latitude, lon: p.coords.longitude, accuracyM: Math.min(10000, Math.max(0, p.coords.accuracy)) }; lastFix = { ...f, at: Date.now() }; res(f); }, () => res(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
  });
}

export function MyDuty({ live }: { live: number }) {
  const { t, me } = useApp(); const sid = me.staffMemberId!;
  const duty = useLoad<any>('/me/duty', [live]); // the privacy notice gate is app-wide (NoticeGate)
  const [dev, setDev] = useState<'checking' | 'unsupported' | 'none' | 'active' | 'pending_approval' | 'error'>('checking'); const [devErr, setDevErr] = useState('');
  const [busy, setBusy] = useState(''); const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const bind = async () => {
    setDevErr('');
    try { const d = await registerDevice(sid); setDev(d.status === 'active' ? 'active' : 'pending_approval'); } catch (e) { setDev('error'); setDevErr(msg(e)); }
  };
  useEffect(() => { void (async () => { if (!deviceSupported()) return setDev('unsupported'); if (await storedDevice(sid)) await bind(); else setDev('none'); })(); }, [sid]);

  const act = async (label: string, fn: () => Promise<any>) => {
    setBusy(label); setResult(null);
    try { const r = await fn(); const exc = r?.reasonCodes?.length ? ` (${r.reasonCodes.join(', ')})` : ''; setResult({ ok: true, text: `${t('fd.done')}${exc}` }); duty.reload(); }
    catch (e) { setResult({ ok: false, text: msg(e) }); }
    finally { setBusy(''); }
  };
  const body = async (extra: Record<string, unknown> = {}) => { const fix = await currentFix(); return { eventId: crypto.randomUUID(), occurredAt: iso(), sentAt: iso(), ...(fix ? { location: fix } : {}), ...extra }; };

  const items: any[] = duty.data?.items ?? []; const current = items.find((a) => a.status === 'started' || a.status === 'on_break');
  const upcoming = items.filter((a) => a.status === 'scheduled');

  return <Page title={t('nav.myDuty')} sub={t('fd.sub')}>
    <SosButton sid={sid} hasDevice={dev === 'active'} assignmentId={current?.id} />
    <div className="card">
      <h2>{t('fd.device')}</h2>
      {dev === 'checking' && <p className="muted">{t('common.loading')}</p>}
      {dev === 'unsupported' && <div className="notice danger" role="alert">{t('fd.unsupported')}</div>}
      {dev === 'none' && <><p>{t('fd.setupHelp')}</p><button className="primary" onClick={() => void bind()}>{t('fd.setup')}</button></>}
      {dev === 'pending_approval' && <div className="notice warn" role="status">{t('fd.pending')} <button className="link" onClick={() => void bind()}>{t('common.refresh')}</button></div>}
      {dev === 'active' && <p className="ok-text">✓ {t('fd.ready')}</p>}
      {dev === 'error' && <div className="notice danger" role="alert">{devErr} <button className="link" onClick={() => void bind()}>{t('common.retry')}</button></div>}
    </div>
    {result && <div className={`notice ${result.ok ? '' : 'danger'}`} role={result.ok ? 'status' : 'alert'}>{result.text}</div>}
    <Async s={duty}>
      {current && <div className="card duty-now">
        <h2>{current.post?.name ?? current.shiftName} — {t(`duty.${current.status === 'on_break' ? 'started' : current.status}`)}{current.status === 'on_break' ? ` · ${t('fd.onBreak')}` : ''}</h2>
        <p className="small muted"><When at={current.startsAt} /> → <When at={current.endsAt} style="time" />{current.supervisor ? ` · ${current.supervisor.displayName}${current.supervisor.phone ? ` ${current.supervisor.phone}` : ''}` : ''}</p>
        {current.trackingSession?.state === 'open' && dev === 'active' && <LocationShare sid={sid} sessionId={current.trackingSession.id} />}
        <div className="row">
          {current.status === 'started' && <button disabled={!!busy || dev !== 'active'} onClick={() => void act('b1', async () => signedPost(sid, '/attendance/events', await body({ assignmentId: current.id, type: 'break_start' })))}>{t('fd.breakStart')}</button>}
          {current.status === 'on_break' && <button disabled={!!busy || dev !== 'active'} onClick={() => void act('b2', async () => signedPost(sid, '/attendance/events', await body({ assignmentId: current.id, type: 'break_end' })))}>{t('fd.breakEnd')}</button>}
          <button className="danger" disabled={!!busy || dev !== 'active'} onClick={() => void act('end', async () => signedPost(sid, `/assignments/${current.id}/end`, await body()))}>{busy === 'end' ? t('common.loading') : t('fd.end')}</button>
        </div>
      </div>}
      <div className="card"><h2>{t('fd.upcoming')}</h2>
        {!upcoming.length && <p className="muted">{t('fd.noDuty')}</p>}
        {upcoming.map((a) => <div key={a.id} className="duty-row"><div><b>{a.post?.name ?? a.shiftName}</b><div className="small muted"><When at={a.startsAt} /> → <When at={a.endsAt} style="time" /></div></div>
          <button className="primary" disabled={!!busy || dev !== 'active' || !!current} onClick={() => void act('start', async () => signedPost(sid, `/assignments/${a.id}/start`, await body()))}>{busy === 'start' ? t('common.loading') : t('fd.start')}</button></div>)}
        {dev !== 'active' && upcoming.length > 0 && <p className="small muted">{t('fd.needDevice')}</p>}
      </div>
    </Async>
    <p className="small muted">{t('fd.foregroundOnly')}</p>
  </Page>;
}

/** Sends location while this screen is open; clear states for denied/unavailable; queued points survive network gaps. */
function LocationShare({ sid, sessionId }: { sid: string; sessionId: string }) {
  const { t } = useApp();
  const [state, setState] = useState<'starting' | 'live' | 'denied' | 'unavailable'>('starting'); const [acc, setAcc] = useState<number | null>(null);
  const [lastSent, setLastSent] = useState<number | null>(null); const [queued, setQueued] = useState(0); const [awake, setAwake] = useState(false);
  const buf = useRef<any[]>([]); const lock = useRef<any>(null); const stopped = useRef(false);
  useEffect(() => {
    if (!('geolocation' in navigator)) { setState('unavailable'); return; }
    const seqKey = `sf.seq.${sessionId}`;
    const watch = navigator.geolocation.watchPosition((p) => {
      const seq = Number(localStorage.getItem(seqKey) ?? '0'); localStorage.setItem(seqKey, String(seq + 1));
      buf.current.push({ seq, recordedAt: new Date(p.timestamp).toISOString(), lat: p.coords.latitude, lon: p.coords.longitude, accuracyM: Math.min(10000, Math.max(0, p.coords.accuracy)),
        ...(p.coords.speed !== null && p.coords.speed >= 0 ? { speed: p.coords.speed } : {}), ...(p.coords.heading !== null && p.coords.heading >= 0 && p.coords.heading <= 360 ? { heading: p.coords.heading } : {}) });
      if (buf.current.length > 500) buf.current.splice(0, buf.current.length - 500);
      lastFix = { lat: p.coords.latitude, lon: p.coords.longitude, accuracyM: Math.min(10000, Math.max(0, p.coords.accuracy)), at: Date.now() };
      setState('live'); setAcc(Math.round(p.coords.accuracy)); setQueued(buf.current.length);
    }, (e) => setState(e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable'), { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
    const flush = async () => {
      if (stopped.current || !buf.current.length || !navigator.onLine) return;
      const batch = buf.current.slice(0, 200);
      try { await signedPost(sid, '/locations/batch', { trackingSessionId: sessionId, sentAt: new Date().toISOString(), points: batch }); buf.current.splice(0, batch.length); setLastSent(Date.now()); setQueued(buf.current.length); }
      catch (e) { if (e instanceof ApiError && e.code === 'TRACKING_NOT_AUTHORIZED') { stopped.current = true; buf.current = []; } }
    };
    const timer = setInterval(() => void flush(), 30000); const onVis = () => { if (document.visibilityState === 'hidden') void flush(); };
    addEventListener('online', flush); document.addEventListener('visibilitychange', onVis);
    return () => { navigator.geolocation.clearWatch(watch); clearInterval(timer); removeEventListener('online', flush); document.removeEventListener('visibilitychange', onVis); void flush(); };
  }, [sid, sessionId]);
  useEffect(() => { const re = () => { if (awake && document.visibilityState === 'visible') void (navigator as any).wakeLock?.request('screen').then((l: any) => { lock.current = l; }).catch(() => {}); };
    document.addEventListener('visibilitychange', re); return () => { document.removeEventListener('visibilitychange', re); }; }, [awake]);
  const toggleAwake = async () => {
    if (awake) { await lock.current?.release?.(); lock.current = null; setAwake(false); return; }
    try { lock.current = await (navigator as any).wakeLock.request('screen'); setAwake(true); } catch { setAwake(false); }
  };
  return <div className={`notice ${state === 'live' ? '' : state === 'starting' ? 'warn' : 'danger'}`} role="status" aria-live="polite">
    {state === 'live' && <>📍 {t('fd.sharing')} · ±{acc} m{lastSent ? <> · {t('fd.lastSent')} <When at={lastSent} style="time" /></> : ''}{queued ? ` · ${t('fd.queued', { n: queued })}` : ''}</>}
    {state === 'starting' && t('fd.locStarting')}{state === 'denied' && t('fd.locDenied')}{state === 'unavailable' && t('fd.locUnavailable')}
    {'wakeLock' in navigator && <> <button className="link" onClick={() => void toggleAwake()} aria-pressed={awake}>{awake ? t('fd.screenOnOff') : t('fd.screenOn')}</button></>}
  </div>;
}

function SosButton({ sid, hasDevice, assignmentId }: { sid: string; hasDevice: boolean; assignmentId?: string }) {
  const { t } = useApp(); const [ask, setAsk] = useState(false); const [st, setSt] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle'); const [err, setErr] = useState('');
  const send = async () => {
    setAsk(false); setSt('sending'); setErr('');
    const key = 'sf.sos.pending'; const pending = JSON.parse(localStorage.getItem(key) ?? 'null'); // same eventId on retry: never two SOS
    const eventId = pending?.eventId ?? crypto.randomUUID(); const occurredAt = pending?.occurredAt ?? new Date().toISOString(); localStorage.setItem(key, JSON.stringify({ eventId, occurredAt }));
    const fix = await currentFix();
    const b = { eventId, occurredAt, sentAt: new Date().toISOString(), ...(fix ? { location: fix } : {}), ...(assignmentId ? { assignmentId } : {}) };
    try { await (hasDevice ? signedPost(sid, '/sos', b) : post('/sos', b)); localStorage.removeItem(key); setSt('sent'); } catch (e) { setSt('failed'); setErr(msg(e)); }
  };
  return <div className="sos-box">
    <button className="sos-btn" onClick={() => setAsk(true)} disabled={st === 'sending'}>{st === 'sending' ? t('common.loading') : 'SOS'}</button>
    {st === 'sent' && <p className="ok-text" role="status">✓ {t('fd.sosSent')}</p>}
    {st === 'failed' && <p className="notice danger" role="alert">{t('fd.sosFailed')} {err} <button className="link" onClick={() => void send()}>{t('common.retry')}</button></p>}
    {ask && <Modal title={t('fd.sosConfirm')} onClose={() => setAsk(false)}><p>{t('fd.sosHelp')}</p><div className="row end"><button onClick={() => setAsk(false)}>{t('common.cancel')}</button><button className="danger" onClick={() => void send()}>{t('fd.sosSend')}</button></div></Modal>}
  </div>;
}
