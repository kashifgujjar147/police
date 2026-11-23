// Operations screens: overview, command centre, alerts, incidents and SOS, duty planner, attendance, reports, notifications.
import { useEffect, useMemo, useState } from 'react';
import { get, newKey, patch, post, qs } from './api.ts';
import { AsOf, Async, Chip, type Col, Form, FormModal, Fresh, KV, Modal, Num, Page, ReasonModal, Table, Tabs, When, useAct, useApp, useLoad } from './ui.tsx';
import { LiveMap } from './map.tsx';

const isoDay = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (s: string, n: number) => isoDay(new Date(Date.parse(s + 'T12:00:00') + n * 86400000));

export function Overview({ live }: { live: number }) {
  const { t, can } = useApp(); const s = useLoad<any>('/dashboard/overview', [live]); const ob = useLoad<any>(can('tenant.update') ? '/tenant/onboarding' : null);
  const d = s.data;
  return <Page title={t('nav.overview')} actions={d && <AsOf at={d.asOf} onRefresh={() => s.reload()} />}>
    <Async s={s}>{d && <>
      <div className="grid k" style={{ marginBottom: 14 }}>
        <div className="kpi ok"><b><Num n={d.staff.on_duty} /></b><span>{t('ov.onDuty')}</span></div>
        <div className="kpi warn"><b><Num n={d.staff.not_started} /></b><span>{t('ov.notStarted')}</span></div>
        <div className="kpi danger"><b><Num n={d.staff.exception} /></b><span>{t('ov.exceptions')}</span></div>
        <div className="kpi danger"><b><Num n={d.incidents.activeSos} /></b><span>{t('ov.activeSos')}</span></div>
        <div className="kpi stale"><b><Num n={d.staff.stale_offline} /></b><span>{t('ov.stale')}</span></div>
        <div className="kpi"><b><Num n={d.alerts.total} /></b><span>{t('ov.openAlerts')} · {t('sev.critical')} <Num n={d.alerts.critical} /></span></div>
        <div className="kpi"><b><Num n={d.incidents.active} /></b><span>{t('ov.incidents')}</span></div>
        <div className="kpi warn"><b><Num n={d.today.missedCheckpoints} /></b><span>{t('ov.missedCheckpoints')}</span></div>
        <div className="kpi"><b><Num n={d.queues.pendingCorrections} /></b><span>{t('ov.pendingCorrections')}</span></div>
        <div className="kpi"><b><Num n={d.queues.pendingDevices} /></b><span>{t('ov.pendingDevices')}</span></div>
      </div>
      {ob.data && ob.data.completed < ob.data.total && <div className="card"><h2>{t('ov.onboarding')} · <Num n={ob.data.completed} />/<Num n={ob.data.total} /></h2>
        <ul>{ob.data.steps.map((x: any) => <li key={x.key}>{x.done ? '✓' : '○'} {t(`onb.${x.key}`)}</li>)}</ul>
        {can('tenant.update') && ob.data.completed >= ob.data.total - 1 && <button className="primary" onClick={() => void post('/tenant/onboarding/go-live').then(() => ob.reload())}>{t('onb.go_live')}</button>}</div>}
    </>}</Async>
  </Page>;
}

export function CommandCentre({ live, tile }: { live: number; tile: { url: string; attribution: string } }) {
  const { t, can, fmt, labels } = useApp();
  const [f, setF] = useState({ state: '', freshness: '', q: '', unitId: '' }); const [view, setView] = useState<'map' | 'list'>('map'); const [sel, setSel] = useState<string | null>(null); const [hist, setHist] = useState<any>(null);
  const units = useLoad<any>('/units');
  const s = useLoad<any>(`/locations/latest${qs(f)}`, [live]);
  // Freshness labels are recomputed every 15 s even with no new events, so ages never freeze.
  const [, tick] = useState(0); useEffect(() => { const i = setInterval(() => { tick((x) => x + 1); void s.reload(true); }, 15000); return () => clearInterval(i); }, [s.reload]);
  const items: any[] = s.data?.items ?? []; const cur = items.find((x) => x.staffMemberId === sel);
  const pts = items.filter((x) => x.lat !== undefined).map((x) => ({ id: x.staffMemberId, lat: x.lat, lon: x.lon, accuracyM: x.accuracyM, label: x.displayName, state: x.dutyDisplayState, freshness: x.freshness }));
  const states = ['sos', 'exception', 'stale_offline', 'not_started', 'on_duty', 'on_break'];
  return <Page title={t('cmd.title')} actions={<>{s.data && <AsOf at={s.data.asOf} onRefresh={() => s.reload()} />}<div className="row" role="group" aria-label="View"><button aria-pressed={view === 'map'} onClick={() => setView('map')}>{t('common.mapView')}</button><button aria-pressed={view === 'list'} onClick={() => setView('list')}>{t('common.listView')}</button></div></>}>
    <div className="row" style={{ marginBottom: 8 }}>{states.map((st) => <button key={st} aria-pressed={f.state === st} onClick={() => setF({ ...f, state: f.state === st ? '' : st })}><Chip value={st} ns="state" /> <Num n={s.data?.counts?.[st] ?? 0} /></button>)}</div>
    <div className="filters">
      <div className="field"><label htmlFor="cf-q">{t('common.search')}</label><input id="cf-q" value={f.q} onChange={(e: any) => setF({ ...f, q: e.target.value })} /></div>
      <div className="field"><label htmlFor="cf-u">{t('common.unit')}</label><select id="cf-u" value={f.unitId} onChange={(e: any) => setF({ ...f, unitId: e.target.value })}><option value="">{t('common.all')}</option>{units.data?.items.map((u: any) => <option key={u.id} value={u.id}>{'· '.repeat(u.depth)}{u.name}</option>)}</select></div>
      <div className="field"><label htmlFor="cf-f">{t('cmd.filterFresh')}</label><select id="cf-f" value={f.freshness} onChange={(e: any) => setF({ ...f, freshness: e.target.value })}><option value="">{t('common.all')}</option>{['live', 'recent', 'stale', 'unknown'].map((x) => <option key={x} value={x}>{t(`fresh.${x}`)}</option>)}</select></div>
    </div>
    <Async s={s}>
      {!items.length ? <div className="card state">{t('cmd.noStaff')}</div> : view === 'list'
        ? <Table caption={t('cmd.title')} rowKey="staffMemberId" rows={items} selected={sel} onRow={(r) => setSel(r.staffMemberId)} cols={[
          { key: 'displayName', label: t('common.staff'), render: (r) => <><b>{r.displayName}</b> <span className="muted mono">{r.employeeCode}</span></> },
          { key: 'state', label: t('cmd.filterState'), render: (r) => <Chip value={r.dutyDisplayState} ns="state" /> },
          { key: 'fresh', label: t('cmd.filterFresh'), render: (r) => <Fresh freshness={r.freshness} ageSec={r.ageSec} /> },
          { key: 'battery', label: t('cmd.battery'), render: (r) => r.battery === null ? '—' : <><Num n={r.battery} />%</> },
          { key: 'ex', label: t('cmd.exceptions'), render: (r) => <Num n={r.openExceptions} /> }]} />
        : <div className="cmd">
          <div className="list" role="list">{items.map((r) => <button key={r.staffMemberId} className="person" role="listitem" aria-pressed={sel === r.staffMemberId} onClick={() => setSel(r.staffMemberId)}>
            <div className="row" style={{ justifyContent: 'space-between' }}><b>{r.displayName}</b><Chip value={r.dutyDisplayState} ns="state" /></div><Fresh freshness={r.freshness} ageSec={r.ageSec} /></button>)}</div>
          <LiveMap points={pts} selected={sel} onSelect={setSel} tileUrl={tile.url} attribution={tile.attribution} />
        </div>}
    </Async>
    {cur && <div className="card" style={{ marginTop: 12 }} aria-live="polite"><div className="row" style={{ justifyContent: 'space-between' }}><h2>{cur.displayName}</h2><button onClick={() => setSel(null)}>{t('common.close')}</button></div>
      {(cur.freshness === 'stale' || cur.freshness === 'unknown') && <div className="notice warn">{t('cmd.staleWarning')}</div>}
      <KV items={[[t('cmd.filterState'), <Chip value={cur.dutyDisplayState} ns="state" />], [t('cmd.filterFresh'), <Fresh freshness={cur.freshness} ageSec={cur.ageSec} />], [t('att.deviceTime'), <When at={cur.recordedAt} />], [t('att.serverTime'), <When at={cur.receivedAt} />], [t('cmd.battery'), cur.battery === null ? '—' : `${cur.battery}%`], ['±', cur.accuracyM ? `${Math.round(cur.accuracyM)} m` : '—']]} />
      {can('location.history.read') && <div className="row" style={{ marginTop: 10 }}><button onClick={() => setHist({ staff: cur })}>{t('cmd.history')}</button></div>}</div>}
    {hist && !hist.data && <FormModal title={`${t('cmd.history')} — ${hist.staff.displayName}`} onClose={() => setHist(null)} submit={t('common.view')} intro={<p className="notice">{t('cmd.purposeHelp')}</p>}
      initial={{ from: new Date(Date.now() - 8 * 3600000).toISOString().slice(0, 16), to: new Date().toISOString().slice(0, 16) }}
      fields={[{ name: 'from', label: t('common.from'), type: 'datetime-local', required: true }, { name: 'to', label: t('common.to'), type: 'datetime-local', required: true }, { name: 'purpose', label: t('cmd.purpose'), type: 'textarea', required: true }]}
      onSubmit={async (v) => { const data = await get(`/locations/history${qs({ staffMemberId: hist.staff.staffMemberId, from: new Date(v.from).toISOString(), to: new Date(v.to).toISOString(), purpose: v.purpose })}`); setHist({ ...hist, data }); }} />}
    {hist?.data && <Modal title={`${t('cmd.history')} — ${hist.staff.displayName}`} onClose={() => setHist(null)} wide>
      <p className="notice">{hist.data.note}</p>
      <div style={{ height: 320, marginBottom: 10 }}><LiveMap points={hist.data.points.map((p: any, i: number) => ({ id: String(i), lat: p.lat, lon: p.lon, accuracyM: p.accuracyM, label: i === 0 || i === hist.data.points.length - 1 ? new Date(p.recordedAt).toLocaleTimeString() : '', state: 'on_duty', freshness: 'live' }))} selected={null} onSelect={() => {}} tileUrl={tile.url} attribution={tile.attribution} /></div>
      {hist.data.gaps.length > 0 && <div className="notice warn">{t('cmd.gap')}: {hist.data.gaps.map((g: any, i: number) => <span key={i}> <When at={g.from} style="time" />–<When at={g.to} style="time" /></span>)}</div>}
      <Table caption={t('cmd.history')} rowKey="recordedAt" rows={hist.data.points} cols={[{ key: 'recordedAt', label: t('att.deviceTime'), render: (r) => <When at={r.recordedAt} /> }, { key: 'pos', label: '', render: (r) => <span className="mono">{r.lat.toFixed(5)}, {r.lon.toFixed(5)} ±{Math.round(r.accuracyM)} m</span> }, { key: 'sig', label: '⚑', render: (r) => (r.signals ?? []).map((x: any) => x.signal).join(', ') || '—' }]} />
    </Modal>}
  </Page>;
}

export function Alerts({ live }: { live: number }) {
  const { t, can } = useApp(); const act = useAct();
  const [f, setF] = useState({ state: 'active', type: '', severity: '' }); const [sel, setSel] = useState<string | null>(null); const [dlg, setDlg] = useState<string | null>(null);
  const s = useLoad<any>(`/alerts${qs({ ...f, limit: 200 })}`, [live]); const d = useLoad<any>(sel ? `/alerts/${sel}` : null, [live]);
  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const rows = useMemo(() => [...(s.data?.items ?? [])].sort((a, b) => rank[a.severity]! - rank[b.severity]! || (a.state === 'open' ? -1 : 1)), [s.data]);
  const types = ['late_start', 'missed_check_out', 'missed_checkpoint', 'geofence_exception', 'stale_location', 'device_offline', 'low_battery', 'sos'];
  return <Page title={t('nav.alerts')} actions={s.data && <AsOf at={s.data.asOf} onRefresh={() => s.reload()} />}>
    <div className="filters">
      <div className="field"><label htmlFor="af-s">{t('common.status')}</label><select id="af-s" value={f.state} onChange={(e: any) => setF({ ...f, state: e.target.value })}><option value="active">{t('alert.open')} + {t('alert.acknowledged')} + {t('alert.snoozed')}</option><option value="">{t('common.all')}</option>{['open', 'acknowledged', 'snoozed', 'resolved', 'auto_resolved'].map((x) => <option key={x} value={x}>{t(`alert.${x}`)}</option>)}</select></div>
      <div className="field"><label htmlFor="af-t">{t('common.type')}</label><select id="af-t" value={f.type} onChange={(e: any) => setF({ ...f, type: e.target.value })}><option value="">{t('common.all')}</option>{types.map((x) => <option key={x} value={x}>{t(`alert.${x}`)}</option>)}</select></div>
      <div className="field"><label htmlFor="af-v">Severity</label><select id="af-v" value={f.severity} onChange={(e: any) => setF({ ...f, severity: e.target.value })}><option value="">{t('common.all')}</option>{['critical', 'high', 'medium', 'low'].map((x) => <option key={x} value={x}>{t(`sev.${x}`)}</option>)}</select></div>
    </div>
    <div className="grid two"><Async s={s}><Table caption={t('nav.alerts')} rows={rows} selected={sel} onRow={(r) => setSel(r.id)} cols={[
      { key: 'severity', label: 'Severity', render: (r) => <Chip value={r.severity} ns="sev" /> }, { key: 'type', label: t('common.type'), render: (r) => t(`alert.${r.type}`) },
      { key: 'staffName', label: t('common.staff') }, { key: 'state', label: t('common.status'), render: (r) => <Chip value={r.state} ns="alert" /> }, { key: 'firstAt', label: t('common.time'), render: (r) => <When at={r.firstAt} /> }, { key: 'count', label: t('alert.count'), render: (r) => <Num n={r.count} /> }]} /></Async>
      {sel && <Async s={d}>{d.data && <div className="card"><h2>{t(`alert.${d.data.type}`)} <Chip value={d.data.severity} ns="sev" /></h2>
        <KV items={[[t('common.status'), <Chip value={d.data.state} ns="alert" />], [t('common.staff'), d.data.staffMemberId ?? '—'], [t('alert.count'), <Num n={d.data.count} />], ['Escalation step', <Num n={d.data.escalationStep} />]]} />
        {Object.keys(d.data.detail ?? {}).length > 0 && <pre className="small mono">{JSON.stringify(d.data.detail, null, 1)}</pre>}
        {can('alert.manage') && ['open', 'acknowledged', 'snoozed'].includes(d.data.state) && <div className="row" style={{ margin: '10px 0' }}>
          {d.data.state !== 'acknowledged' && <button className="primary" onClick={() => void act(() => post(`/alerts/${sel}/acknowledge`, {}).then(() => { d.reload(); s.reload(); }))}>{t('alert.acknowledge')}</button>}
          {d.data.type !== 'sos' && <><button onClick={() => setDlg('snooze')}>{t('alert.snooze')}</button><button onClick={() => setDlg('resolve')}>{t('alert.resolve')}</button></>}
          {d.data.incidentId && <a className="btn" href={`#/incidents/${d.data.incidentId}`}>{t('inc.open')}</a>}</div>}
        <h3>{t('alert.timeline')}</h3><ul className="timeline">{d.data.timeline.map((x: any) => <li key={x.id}><When at={x.at} /> — <b>{x.type}</b> {x.detail?.reason ? `· ${x.detail.reason}` : ''}{x.detail?.groups ? ` · ${x.detail.groups.join(', ')}` : ''}</li>)}</ul></div>}</Async>}</div>
    {dlg && <ReasonModal title={t(`alert.${dlg}`)} onClose={() => setDlg(null)} extra={dlg === 'snooze' ? [{ name: 'minutes', label: t('common.minutes'), type: 'number', required: true }] : []}
      onSubmit={async (v) => { await post(`/alerts/${sel}/${dlg}`, v); setDlg(null); d.reload(); s.reload(); }} />}
  </Page>;
}

export function Incidents({ live }: { live: number }) {
  const { t, can, fmt } = useApp(); const [f, setF] = useState({ status: 'active', kind: '' }); const [create, setCreate] = useState(false);
  const s = useLoad<any>(`/incidents${qs({ ...f, limit: 200 })}`, [live]); const cat = useLoad<any>('/catalogues?kind=incidentType');
  return <Page title={t('nav.incidents')} actions={<>{s.data && <AsOf at={s.data.asOf} onRefresh={() => s.reload()} />}{can('incident.create') && <button className="primary" onClick={() => setCreate(true)}>{t('inc.report')}</button>}</>}>
    <div className="filters"><div className="field"><label htmlFor="if-s">{t('common.status')}</label><select id="if-s" value={f.status} onChange={(e: any) => setF({ ...f, status: e.target.value })}><option value="active">{t('inc.new')} / {t('inc.acknowledged')} / {t('inc.dispatched')} …</option><option value="">{t('common.all')}</option>{['resolved', 'closed', 'cancelled_false_alarm'].map((x) => <option key={x} value={x}>{t(`inc.${x}`)}</option>)}</select></div>
      <div className="field"><label htmlFor="if-k">{t('common.type')}</label><select id="if-k" value={f.kind} onChange={(e: any) => setF({ ...f, kind: e.target.value })}><option value="">{t('common.all')}</option><option value="sos">{t('inc.kind.sos')}</option><option value="incident">{t('inc.kind.incident')}</option></select></div></div>
    <Async s={s}><Table caption={t('nav.incidents')} rows={s.data?.items ?? []} onRow={(r) => { location.hash = `#/incidents/${r.id}`; }} cols={[
      { key: 'number', label: t('inc.number'), render: (r) => <span className="mono">{r.number}</span> }, { key: 'kind', label: t('common.type'), render: (r) => r.kind === 'sos' ? <Chip value="sos" ns="state" /> : r.typeKey },
      { key: 'severity', label: 'Severity', render: (r) => <Chip value={r.severity} ns="sev" /> }, { key: 'status', label: t('common.status'), render: (r) => <Chip value={r.status} ns="inc" /> }, { key: 'reporterName', label: t('inc.reporter') }, { key: 'createdAt', label: t('common.time'), render: (r) => <When at={r.createdAt} /> }]} /></Async>
    {create && <FormModal title={t('inc.report')} onClose={() => setCreate(false)} submit={t('common.submit')} fields={[{ name: 'typeKey', label: t('common.type'), type: 'select', required: true, options: (cat.data?.items ?? []).filter((c: any) => !c.archived).map((c: any) => ({ value: c.key, label: c.labels?.[fmt.locale] ?? c.key })) }, { name: 'severity', label: 'Severity', type: 'select', options: ['low', 'medium', 'high', 'critical'].map((x) => ({ value: x, label: t(`sev.${x}`) })) }, { name: 'description', label: t('inc.description'), type: 'textarea', required: true }]}
      onSubmit={async (v) => { const r = await post('/incidents', { ...v, eventId: crypto.randomUUID() }); setCreate(false); location.hash = `#/incidents/${r.incidentId}`; }} />}
  </Page>;
}

export function IncidentDetail({ id, live }: { id: string; live: number }) {
  const { t, can } = useApp(); const s = useLoad<any>(`/incidents/${id}`, [live]); const [dlg, setDlg] = useState<string | null>(null); const [noteKey, setNoteKey] = useState(0);
  const staff = useLoad<any>(dlg === 'responders' ? `/incidents/${id}/responder-options` : null); const act = useAct();
  const d = s.data;
  const go = (to: string) => (['resolved', 'cancelled_false_alarm', 'reopened'].includes(to) ? setDlg(to) : void act(() => post(`/incidents/${id}/transition`, { to, version: d.version }).then(() => s.reload())));
  return <Page title={d ? `${d.number}` : t('nav.incidents')} actions={<a className="btn" href="#/incidents">{t('common.back')}</a>}>
    <Async s={s}>{d && <div className="grid two">
      <div className="card">
        {d.kind === 'sos' && <div className="notice danger"><b>{t('inc.kind.sos')}</b> — {t('inc.delivery')}: <Chip value={d.sos?.deliveryState} ns="sos" /></div>}
        {d.sos?.cancellationRequestedAt && <div className="notice warn">{t('inc.cancelRequested')} {d.sos.cancellationReason}</div>}
        <KV items={[[t('common.status'), <Chip value={d.status} ns="inc" />], ['Severity', <Chip value={d.severity} ns="sev" />], [t('common.type'), d.typeKey], [t('inc.reporter'), d.reporter ? `${d.reporter.displayName} (${d.reporter.employeeCode})` : '—'], [t('common.time'), <When at={d.createdAt} />],
          [t('inc.lastLocation'), d.lat !== null && d.lat !== undefined ? <span><span className="mono">{d.lat.toFixed(5)}, {d.lon.toFixed(5)} ±{Math.round(d.accuracyM ?? 0)} m</span> · {t('inc.locationAge', { age: d.locationAgeSec === null ? '—' : `${Math.round(d.locationAgeSec / 60)} ${t('common.minutes')}` })} ({d.locationSource})</span> : t('inc.noLocation')],
          [t('inc.responders'), d.responders.map((r: any) => r.displayName).join(', ') || '—'], [t('inc.description'), d.description]]} />
        {can('incident.manage') && <div className="row" style={{ marginTop: 12 }}>{d.allowedTransitions.map((to: string) => <button key={to} className={to === 'acknowledged' ? 'primary' : ''} onClick={() => go(to)}>{t('inc.moveTo')}: {t(`inc.${to}`)}</button>)}
          {can('incident.dispatch') && ['new', 'acknowledged', 'dispatched', 'on_scene', 'reopened'].includes(d.status) && <button onClick={() => setDlg('responders')}>{t('inc.assign')}</button>}</div>}
      </div>
      <div className="card"><h2>{t('alert.timeline')}</h2><ul className="timeline">{d.timeline.map((x: any) => <li key={x.id}><When at={x.at} /> — <b>{x.type}</b>{x.detail?.text ? `: ${x.detail.text}` : ''}{x.detail?.reason ? ` · ${x.detail.reason}` : ''}{x.detail?.names ? ` · ${x.detail.names.join(', ')}` : ''}{x.detail?.recipients !== undefined ? ` · ${x.detail.recipients}` : ''}</li>)}</ul>
        <Form key={`note-${noteKey}`} fields={[{ name: 'text', label: t('inc.addNote'), type: 'textarea', required: true }]} submit={t('inc.addNote')} onSubmit={async (v) => { await post(`/incidents/${id}/notes`, v); setNoteKey((k) => k + 1); s.reload(); }} /></div>
    </div>}</Async>
    {dlg === 'responders' && <FormModal title={t('inc.assign')} onClose={() => setDlg(null)} fields={[{ name: 'staffMemberId', label: t('common.staff'), type: 'select', required: true, options: (staff.data?.items ?? []).map((x: any) => ({ value: x.id, label: `${x.displayName} (${x.employeeCode})` })) }]} onSubmit={async (v) => { await post(`/incidents/${id}/responders`, { staffMemberIds: [v.staffMemberId] }); setDlg(null); s.reload(); }} />}
    {dlg && dlg !== 'responders' && <ReasonModal title={t(`inc.${dlg}`)} onClose={() => setDlg(null)} extra={dlg === 'resolved' ? [{ name: 'resolutionCode', label: t('inc.resolutionCode'), required: true }] : []} onSubmit={async (v) => { await post(`/incidents/${id}/transition`, { to: dlg, version: d.version, ...v }); setDlg(null); s.reload(); }} />}
  </Page>;
}

export function Planner({ live }: { live: number }) {
  const { t, can, me } = useApp(); const act = useAct();
  const [unitId, setUnit] = useState(''); const [from, setFrom] = useState(isoDay()); const [days, setDays] = useState(7); const [dlg, setDlg] = useState<any>(null); const [tab, setTab] = useState('assignments');
  const to = addDays(from, days - 1); const tz = me.tenant.timezone;
  const units = useLoad<any>('/units'); const posts = useLoad<any>('/posts?limit=200'); const shifts = useLoad<any>('/shifts?limit=200&status=active'); const staff = useLoad<any>(can('staff.read') ? '/staff?status=active&limit=200' : null);
  const unit = unitId || units.data?.items?.[0]?.id || '';
  const asg = useLoad<any>(unit ? `/assignments${qs({ unitId: unit, from: new Date(Date.parse(from + 'T00:00:00Z') - 86400000).toISOString(), to: new Date(Date.parse(to + 'T23:59:59Z') + 86400000).toISOString(), limit: 200 })}` : null, [live]);
  const cov = useLoad<any>(tab === 'coverage' ? `/coverage${qs({ from, to, unitId: unit })}` : null); const ver = useLoad<any>(tab === 'versions' && unit ? `/rosters/versions?unitId=${unit}` : null, [live]);
  const staffName = (id: string) => staff.data?.items.find((x: any) => x.id === id)?.displayName ?? id;
  const rows = (asg.data?.items ?? []).filter((a: any) => a.localDate >= from && a.localDate <= to && a.status !== 'cancelled');
  const publish = async () => {
    const v = await get(`/rosters/versions?unitId=${unit}`); const cur = Math.max(0, ...v.items.filter((x: any) => x.scope.from === from && x.scope.to === to).map((x: any) => x.version));
    await act(() => post('/rosters/publish', { unitId: unit, from, to, expectedVersion: cur }).then((r: any) => { asg.reload(); return r; }), t('plan.published'));
  };
  const recur: Record<string, string> = { none: '', daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY' };
  return <Page title={t('nav.planner')} sub={`${t('rep.timezone')} ${tz}`} actions={can('shift.create') && <><button onClick={() => setDlg({ kind: 'shift' })}>{t('plan.addShift')}</button><button onClick={() => setDlg({ kind: 'assign' })}>{t('plan.assign')}</button>{can('roster.publish') && <button className="primary" onClick={() => void publish()} title={t('plan.publishHelp')}>{t('plan.publish')}</button>}</>}>
    <div className="filters">
      <div className="field"><label htmlFor="pl-u">{t('common.unit')}</label><select id="pl-u" value={unit} onChange={(e: any) => setUnit(e.target.value)}>{units.data?.items.map((u: any) => <option key={u.id} value={u.id}>{'· '.repeat(u.depth)}{u.name}</option>)}</select></div>
      <div className="field"><label htmlFor="pl-f">{t('common.from')}</label><input id="pl-f" type="date" value={from} onChange={(e: any) => setFrom(e.target.value)} /></div>
      <div className="field"><label htmlFor="pl-d">{t('plan.window')}</label><select id="pl-d" value={days} onChange={(e: any) => setDays(Number(e.target.value))}>{[1, 7, 14, 31].map((x) => <option key={x} value={x}>{x}</option>)}</select></div>
    </div>
    <p className="small muted">{t('plan.publishHelp')}</p>
    <Tabs value={tab} onChange={setTab} tabs={[{ id: 'assignments', label: t('plan.assignments') }, { id: 'shifts', label: t('plan.shifts') }, { id: 'coverage', label: t('plan.coverage') }, { id: 'versions', label: t('plan.versions') }]} />
    {tab === 'assignments' && <Async s={asg}><Table caption={t('plan.assignments')} rows={rows} cols={[
      { key: 'localDate', label: t('plan.date') }, { key: 'shiftName', label: t('plan.shifts') }, { key: 'time', label: t('common.time'), render: (r) => <><When at={r.startsAt} style="time" />–<When at={r.endsAt} style="time" /></> },
      { key: 'staff', label: t('common.staff'), render: (r) => (r.staffName ?? staffName(r.staffMemberId)) }, { key: 'post', label: t('common.post'), render: (r) => posts.data?.items.find((p: any) => p.id === r.postId)?.name ?? '—' },
      { key: 'roster', label: t('common.status'), render: (r) => <span className="row"><Chip value={r.rosterState} ns="plan" /><Chip value={r.status} ns="duty" /></span> }, { key: 'ack', label: t('plan.ack'), render: (r) => r.rosterVersionId ? (r.ackAt ? <Chip value="acknowledged" ns="plan.ack" /> : <span className="chip warn">{t('plan.notAck')}</span>) : '—' },
      { key: 'a', label: t('common.actions'), render: (r) => r.status === 'scheduled' && can('assignment.update') ? <span className="row"><button className="link" onClick={() => setDlg({ kind: 'reassign', a: r })}>{t('plan.reassign')}</button><button className="link" onClick={() => setDlg({ kind: 'cancel', a: r })}>{t('plan.cancelAssignment')}</button></span> : r.status !== 'scheduled' ? <a href={`#/attendance/${r.id}`}>{t('att.summary')}</a> : null }]} /></Async>}
    {tab === 'shifts' && <Async s={shifts}><Table caption={t('plan.shifts')} rows={shifts.data?.items ?? []} cols={[{ key: 'name', label: t('common.name') }, { key: 't', label: t('common.time'), render: (r) => <span className="num">{r.startsAtLocal}–{r.endsAtLocal}</span> }, { key: 'recurrenceRule', label: t('plan.recurrence'), render: (r) => <span className="mono small">{r.recurrenceRule ?? '—'}</span> }, { key: 'timezone', label: t('plat.timezone') }, { key: 'm', label: t('plan.minStaff'), render: (r) => <Num n={r.minStaffing?.count} /> }]} /></Async>}
    {tab === 'coverage' && <Async s={cov}>{cov.data && <><div className="grid k" style={{ marginBottom: 10 }}><div className="kpi"><b>{cov.data.coveragePct === null ? '—' : <><Num n={cov.data.coveragePct} />%</>}</b><span>{t('plan.coverage')}</span></div><div className="kpi danger"><b><Num n={cov.data.understaffed.length} /></b><span>{t('plan.understaffed')}</span></div><div className="kpi warn"><b><Num n={cov.data.unassignedPosts.length} /></b><span>{t('plan.unassignedPosts')}</span></div></div>
      <Table caption={t('plan.understaffed')} rowKey="startsAt" rows={cov.data.understaffed} cols={[{ key: 'localDate', label: t('plan.date') }, { key: 'shiftName', label: t('plan.shifts') }, { key: 'need', label: t('plan.minStaff'), render: (r) => <><Num n={r.assigned} /> / <Num n={r.required} /></> }]} /></>}</Async>}
    {tab === 'versions' && <Async s={ver}><Table caption={t('plan.versions')} rows={ver.data?.items ?? []} cols={[{ key: 'v', label: t('common.version'), render: (r) => <Num n={r.version} /> }, { key: 'scope', label: t('plan.window'), render: (r) => `${r.scope.from} → ${r.scope.to}` }, { key: 'state', label: t('common.status'), render: (r) => <Chip value={r.state} ns="plan" /> }, { key: 'publishedAt', label: t('common.time'), render: (r) => <When at={r.publishedAt} /> }, { key: 'diff', label: '±', render: (r) => `+${r.diff.added.length} ~${r.diff.changed.length} −${r.diff.removed.length}` }, { key: 'n', label: t('plan.assignments'), render: (r) => <Num n={r.assignmentCount} /> }]} /></Async>}
    {dlg?.kind === 'shift' && <FormModal title={t('plan.addShift')} onClose={() => setDlg(null)} initial={{ startDate: from, startsAtLocal: '08:00', endsAtLocal: '16:00', recurrence: 'daily', minStaffing: 1 }} fields={[
      { name: 'name', label: t('common.name'), required: true }, { name: 'postId', label: t('common.post'), type: 'select', required: true, options: (posts.data?.items ?? []).map((p: any) => ({ value: p.id, label: p.name })) }, { name: 'startDate', label: t('plan.startDate'), type: 'date', required: true },
      { name: 'startsAtLocal', label: t('plan.startTime'), type: 'time', required: true }, { name: 'endsAtLocal', label: t('plan.endTime'), type: 'time', required: true, help: 'An end before the start means the shift ends the next day.' }, { name: 'recurrence', label: t('plan.recurrence'), type: 'select', options: Object.keys(recur).map((k) => ({ value: k, label: t(`plan.rec.${k}`) })) }, { name: 'minStaffing', label: t('plan.minStaff'), type: 'number' }]}
      onSubmit={async (v) => { await post('/shifts', { name: v.name, postId: v.postId, startDate: v.startDate, startsAtLocal: v.startsAtLocal, endsAtLocal: v.endsAtLocal, ...(recur[v.recurrence] ? { recurrenceRule: recur[v.recurrence] } : {}), minStaffing: { count: v.minStaffing ?? 1 } }); setDlg(null); shifts.reload(); }} />}
    {dlg?.kind === 'assign' && <AssignModal shifts={shifts.data?.items ?? []} staff={staff.data?.items ?? []} posts={posts.data?.items ?? []} date={from} onClose={() => setDlg(null)} onDone={() => { setDlg(null); asg.reload(); }} />}
    {dlg?.kind === 'reassign' && <ReasonModal title={t('plan.reassign')} onClose={() => setDlg(null)} extra={[{ name: 'staffMemberId', label: t('common.staff'), type: 'select', required: true, options: (staff.data?.items ?? []).map((x: any) => ({ value: x.id, label: x.displayName })) }]} onSubmit={async (v) => { await patch(`/assignments/${dlg.a.id}`, { version: dlg.a.version, ...v }); setDlg(null); asg.reload(); }} />}
    {dlg?.kind === 'cancel' && <ReasonModal danger title={t('plan.cancelAssignment')} onClose={() => setDlg(null)} onSubmit={async (v) => { await post(`/assignments/${dlg.a.id}/cancel`, v); setDlg(null); asg.reload(); }} />}
  </Page>;
}
function AssignModal({ shifts, staff, posts, date, onClose, onDone }: { shifts: any[]; staff: any[]; posts: any[]; date: string; onClose(): void; onDone(): void }) {
  const { t } = useApp(); const [confirm, setConfirm] = useState<Record<string, any> | null>(null);
  const send = async (v: Record<string, any>, confirmOverlap = false) => {
    try { await post('/assignments', { ...v, confirmOverlap }); onDone(); }
    catch (e: any) { if (e.code === 'OVERLAP_CONFLICT' && e.details?.requiresConfirmation) { setConfirm(v); return; } throw e; }
  };
  if (confirm) return <Modal title={t('plan.assign')} onClose={onClose}><p className="notice warn">{t('plan.overlapConfirm')}</p><div className="row end"><button onClick={onClose}>{t('common.cancel')}</button><button className="primary" onClick={() => void send(confirm, true)}>{t('common.confirm')}</button></div></Modal>;
  return <FormModal title={t('plan.assign')} onClose={onClose} initial={{ localDate: date }} fields={[
    { name: 'shiftId', label: t('plan.shifts'), type: 'select', required: true, options: shifts.map((s) => ({ value: s.id, label: `${s.name} ${s.startsAtLocal}–${s.endsAtLocal}` })) }, { name: 'localDate', label: t('plan.date'), type: 'date', required: true },
    { name: 'staffMemberId', label: t('common.staff'), type: 'select', required: true, options: staff.map((x) => ({ value: x.id, label: `${x.displayName} (${x.employeeCode})` })) }, { name: 'postId', label: t('common.post'), type: 'select', options: posts.map((p) => ({ value: p.id, label: p.name })) }]} onSubmit={(v) => send(v)} />;
}

export function Attendance({ live }: { live: number }) {
  const { t, can } = useApp(); const [tab, setTab] = useState('corrections'); const [dlg, setDlg] = useState<any>(null);
  const corr = useLoad<any>(`/corrections${qs({ state: tab === 'corrections' ? 'pending' : '', limit: 200 })}`, [live, tab]);
  const done = useLoad<any>(tab === 'review' ? `/assignments${qs({ status: 'ended', limit: 200 })}` : null, [live]); const sysc = useLoad<any>(tab === 'review' ? `/assignments${qs({ status: 'system_closed', limit: 200 })}` : null, [live]);
  const gaps = useLoad<any>(tab === 'gaps' ? '/sync/rejections?limit=200' : null, [live]); const staff = useLoad<any>('/staff?limit=200');
  const name = (id: string) => staff.data?.items.find((x: any) => x.id === id)?.displayName ?? id;
  return <Page title={t('nav.attendance')}>
    <Tabs value={tab} onChange={setTab} tabs={[{ id: 'corrections', label: t('att.corrections') }, { id: 'review', label: t('att.review') }, { id: 'gaps', label: t('att.gaps') }]} />
    {tab === 'corrections' && <Async s={corr}><Table caption={t('att.corrections')} rows={corr.data?.items ?? []} cols={[{ key: 's', label: t('common.staff'), render: (r) => name(r.staffMemberId) }, { key: 'type', label: t('common.type'), render: (r) => t(`att.${r.proposed.type}`) }, { key: 'p', label: t('att.proposed'), render: (r) => <When at={r.proposed.occurredAt} /> }, { key: 'reason', label: t('common.reason') }, { key: 'state', label: t('common.status'), render: (r) => <Chip value={r.state} ns="corr" /> },
      { key: 'a', label: t('common.actions'), render: (r) => can('attendance.correct') && r.state === 'pending' ? <span className="row">{(['approve', 'reject', 'return'] as const).map((d) => <button key={d} className="link" onClick={() => setDlg({ id: r.id, decision: d })}>{t(`common.${d}`)}</button>)}<a href={`#/attendance/${r.assignmentId}`}>{t('att.summary')}</a></span> : null }]} /></Async>}
    {tab === 'review' && <Async s={done}><Table caption={t('att.review')} rows={[...(done.data?.items ?? []), ...(sysc.data?.items ?? [])]} onRow={(r) => { location.hash = `#/attendance/${r.id}`; }} cols={[{ key: 'localDate', label: t('plan.date') }, { key: 's', label: t('common.staff'), render: (r) => name(r.staffMemberId) }, { key: 'shiftName', label: t('plan.shifts') }, { key: 'status', label: t('common.status'), render: (r) => <Chip value={r.status} ns="duty" /> }]} /></Async>}
    {tab === 'gaps' && <Async s={gaps}><Table caption={t('att.gaps')} rows={gaps.data?.items ?? []} cols={[{ key: 's', label: t('common.staff'), render: (r) => name(r.staffMemberId) }, { key: 'type', label: t('common.type') }, { key: 'o', label: t('att.deviceTime'), render: (r) => <When at={r.occurredAt} /> }, { key: 'r', label: t('att.serverTime'), render: (r) => <When at={r.receivedAt} /> }, { key: 'code', label: 'Code', render: (r) => <span className="mono">{r.code}</span> }, { key: 'action', label: t('common.actions') }]} /></Async>}
    {dlg && <FormModal title={t(`common.${dlg.decision}`)} onClose={() => setDlg(null)} submit={t('common.confirm')} fields={[{ name: 'note', label: t('common.note'), type: 'textarea', required: true }]} onSubmit={async (v) => { await post(`/corrections/${dlg.id}/review`, { decision: dlg.decision, note: v.note }); setDlg(null); corr.reload(); }} />}
  </Page>;
}

export function DutySummary({ id, live }: { id: string; live: number }) {
  const { t, can } = useApp(); const s = useLoad<any>(`/assignments/${id}/summary`, [live]); const ev = useLoad<any>(can('attendance.read') ? `/attendance/events?assignmentId=${id}&limit=200` : null, [live]); const [dlg, setDlg] = useState<string | null>(null);
  const d = s.data; const B = ({ b }: { b: string }) => <Chip value={b} ns="basis" />;
  return <Page title={t('att.summary')} actions={<button onClick={() => window.print()}>{t('common.print')}</button>}>
    <p className="small muted">{t('basis.legend')}</p>
    <Async s={s}>{d && <div className="grid two">
      <div className="card"><KV items={[
        [t('common.status'), <Chip value={d.status} ns="duty" />], [t('att.scheduled'), <><When at={d.scheduled.startsAt} /> – <When at={d.scheduled.endsAt} style="time" /> (<Num n={d.scheduled.minutes} /> {t('common.minutes')})</>],
        [t('att.actual'), <><When at={d.actual.startedAt} /> <B b={d.actual.startBasis} /> – <When at={d.actual.endedAt} style="time" /> <B b={d.actual.endBasis} /> {d.actual.minutes !== null && <>(<Num n={d.actual.minutes} /> {t('common.minutes')})</>}</>],
        [t('att.breaks'), <><Num n={d.breaks.count} /> · <Num n={d.breaks.minutes} /> {t('common.minutes')} <B b={d.breaks.basis} /></>],
        [t('att.checkpoints'), <><Num n={d.checkpointResults.completed} />/<Num n={d.checkpointResults.expected} /> · missed <Num n={d.checkpointResults.missed} /> · waived <Num n={d.checkpointResults.waived} /></>],
        [t('att.coverage'), <>{d.coverage.pct === null ? '—' : <><Num n={d.coverage.pct} />%</>} <B b={d.coverage.basis} /> <span className="small muted">{d.coverage.note}</span></>],
        [t('att.exceptions'), d.exceptions.join(', ') || '—'], [t('att.missing'), d.missingEvidence.length ? <ul>{d.missingEvidence.map((m: string) => <li key={m}>{m}</li>)}</ul> : '—'],
        ['Review', d.reviewState ? <>{d.reviewState} · <When at={d.reviewedAt} /> · {d.reviewComment}</> : '—']]} />
        {can('attendance.review') && ['ended', 'system_closed', 'reviewed'].includes(d.status) && <div className="row" style={{ marginTop: 10 }}>{d.status !== 'reviewed' && <button className="primary" onClick={() => setDlg('approve')}>{t('common.approve')}</button>}<button onClick={() => setDlg('return')}>{t('common.return')}</button></div>}
      </div>
      <div className="card"><h2>{t('att.events')}</h2><Async s={ev}><Table caption={t('att.events')} rows={ev.data?.items ?? []} cols={[{ key: 'type', label: t('common.type'), render: (r) => t(`att.${r.type}`) }, { key: 'o', label: t('att.deviceTime'), render: (r) => <When at={r.occurredAt} /> }, { key: 'r', label: t('att.serverTime'), render: (r) => <When at={r.receivedAt} /> }, { key: 'src', label: '', render: (r) => <>{r.source === 'device_offline' && <span className="chip warn">{t('att.offline')}</span>} {(r.validation?.reasonCodes ?? []).join(' ')}</> }]} /></Async></div>
    </div>}</Async>
    {dlg && <FormModal title={t(dlg === 'approve' ? 'common.approve' : 'common.return')} onClose={() => setDlg(null)} submit={t('common.confirm')} fields={[{ name: 'comment', label: t('common.note'), type: 'textarea', required: true }]} onSubmit={async (v) => { await post(`/assignments/${id}/review`, { decision: dlg, comment: v.comment }); setDlg(null); s.reload(); }} />}
  </Page>;
}

export function Reports() {
  const { t, me, can } = useApp(); const cat = useLoad<any>('/reports'); const units = useLoad<any>('/units'); const exps = useLoad<any>(can('export.create') ? '/exports?limit=20' : null);
  const [q, setQ] = useState({ key: '', from: addDays(isoDay(), -7), to: isoDay(), unitId: '' }); const [res, setRes] = useState<any>(null); const [busy, setBusy] = useState(false); const act = useAct();
  const range = () => ({ from: new Date(q.from + 'T00:00:00').toISOString(), to: new Date(q.to + 'T23:59:59').toISOString(), ...(q.unitId ? { unitId: q.unitId } : {}) });
  const run = async () => { setBusy(true); await act(async () => setRes(await get(`/reports/${q.key}${qs(range())}`))); setBusy(false); };
  useEffect(() => { const i = setInterval(() => { if (exps.data?.items.some((x: any) => x.state === 'queued')) void exps.reload(true); }, 3000); return () => clearInterval(i); }, [exps.data]);
  return <Page title={t('nav.reports')} sub={`${t('rep.timezone')} ${me.tenant.timezone}`}>
    <div className="card"><div className="filters">
      <div className="field"><label htmlFor="r-k">{t('rep.choose')}</label><select id="r-k" value={q.key} onChange={(e: any) => setQ({ ...q, key: e.target.value })}><option value="">—</option>{cat.data?.items.map((r: any) => <option key={r.key} value={r.key}>{r.title}</option>)}</select></div>
      <div className="field"><label htmlFor="r-f">{t('common.from')}</label><input id="r-f" type="date" value={q.from} onChange={(e: any) => setQ({ ...q, from: e.target.value })} /></div>
      <div className="field"><label htmlFor="r-t">{t('common.to')}</label><input id="r-t" type="date" value={q.to} onChange={(e: any) => setQ({ ...q, to: e.target.value })} /></div>
      <div className="field"><label htmlFor="r-u">{t('common.unit')}</label><select id="r-u" value={q.unitId} onChange={(e: any) => setQ({ ...q, unitId: e.target.value })}><option value="">{t('common.all')}</option>{units.data?.items.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
      <button className="primary" disabled={!q.key || busy} onClick={() => void run()}>{t('rep.run')}</button>
      {can('export.create') && <button disabled={!q.key} onClick={() => void act(() => post('/exports', { reportType: q.key, format: 'csv', filters: range() }).then(() => exps.reload()), t('rep.exportQueued'))}>{t('common.export')}</button>}
    </div></div>
    {res && <div className="card"><div className="row" style={{ justifyContent: 'space-between' }}><h2>{res.title} · <Num n={res.rowCount} /> {t('rep.rows')}</h2><AsOf at={res.asOf} /></div>
      <p className="small muted">{res.basisNote}</p>{res.incomplete?.note && <div className="notice warn">{t('rep.incomplete')}: {res.incomplete.note}</div>}{res.truncated && <div className="notice warn">Row limit reached.</div>}
      <Table caption={res.title} rowKey="__i" rows={res.rows.map((r: any, i: number) => ({ ...r, __i: i }))} cols={res.columns.map((c: any): Col<any> => ({ key: c.key, label: `${c.label}${c.basis !== 'measured' ? ` (${t(`basis.${c.basis}`)})` : ''}` }))} /></div>}
    {can('export.create') && <div className="card"><h2>{t('rep.exports')}</h2><p className="small muted">{t('rep.linkHelp')}</p><Async s={exps}><Table caption={t('rep.exports')} rows={exps.data?.items ?? []} cols={[{ key: 'reportType', label: t('common.type') }, { key: 'createdAt', label: t('common.time'), render: (r) => <When at={r.createdAt} /> }, { key: 'state', label: t('common.status'), render: (r) => <Chip value={r.state} ns="rep" /> }, { key: 'rowCount', label: t('rep.rows'), render: (r) => <Num n={r.rowCount} /> },
      { key: 'dl', label: '', render: (r) => r.state === 'ready' ? <button className="link" onClick={() => void act(async () => { const x = await get(`/exports/${r.id}`); window.location.href = x.download.url; })}>{t('common.download')}</button> : null }]} /></Async></div>}
  </Page>;
}

export function Notifications({ live }: { live: number }) {
  const { t, fmt } = useApp(); const s = useLoad<any>('/notifications?limit=100', [live]);
  const open = (n: any) => { void post(`/notifications/${n.id}/read`); if (n.refType === 'incident') location.hash = `#/incidents/${n.refId}`; else if (n.refType === 'alert') location.hash = '#/alerts'; else if (n.refType === 'export') location.hash = '#/reports'; else s.reload(); };
  return <Page title={t('nav.notifications')} actions={<button onClick={() => void post('/notifications/read-all').then(() => s.reload())}>{t('notif.markAll')}</button>}>
    <Async s={s}><Table caption={t('nav.notifications')} rows={s.data?.items ?? []} onRow={open} cols={[{ key: 'title', label: t('common.details'), render: (r) => <span style={{ fontWeight: r.readAt ? 400 : 700 }}>{r.critical && <Chip value="critical" ns="sev" />} {r.title?.[fmt.locale] ?? r.template}</span> }, { key: 'createdAt', label: t('common.time'), render: (r) => <When at={r.createdAt} /> }]} /></Async>
  </Page>;
}

export function MyData() {
  const { t } = useApp(); const s = useLoad<any>('/me/data'); const log = useLoad<any>('/me/location-access-log');
  const d = s.data;
  return <Page title={t('nav.myData')}><Async s={s}>{d && <div className="grid two">
    <div className="card"><h2>{t('prv.tracking')}</h2><p><b>{d.tracking.active ? t('prv.trackingOn') : t('prv.trackingOff')}</b></p><h3>{t('prv.collected')}</h3><ul>{d.collected.map((c: string) => <li key={c}>{c}</li>)}</ul><p className="small muted">{t('prv.notice')} v{d.noticeVersion}</p></div>
    <div className="card"><h2>{t('prv.accessLog')}</h2><Async s={log}><Table caption={t('prv.accessLog')} rowKey="at" rows={log.data?.items ?? []} cols={[{ key: 'at', label: t('common.time'), render: (r) => <When at={r.at} /> }, { key: 'accessedBy', label: t('aud.actor') }, { key: 'purpose', label: t('cmd.purpose') }]} /></Async></div>
    <div className="card"><h2>{t('prv.recent')}</h2><Table caption={t('prv.recent')} rowKey="recordedAt" rows={d.recentLocations.slice(0, 50)} cols={[{ key: 'recordedAt', label: t('common.time'), render: (r) => <When at={r.recordedAt} /> }, { key: 'p', label: '', render: (r) => <span className="mono">{r.lat.toFixed(5)}, {r.lon.toFixed(5)}</span> }]} /></div>
    <div className="card"><h2>{t('att.events')}</h2><Table caption={t('att.events')} rows={d.attendance} cols={[{ key: 'type', label: t('common.type'), render: (r) => t(`att.${r.type}`) }, { key: 'occurredAt', label: t('common.time'), render: (r) => <When at={r.occurredAt} /> }]} /></div>
  </div>}</Async></Page>;
}
export { newKey };

/** In-app help, privacy notice, support contact and a diagnostics bundle that contains no secrets (FR-SUP-001). */
export function Help({ status }: { status: string }) {
  const { t, me, locale } = useApp(); const notice = useLoad<any>('/privacy/notices/current'); const [copied, setCopied] = useState(false);
  const diag = { app: 'SmartForce 360 web', build: (document.querySelector('script[src*="app.js"]') as HTMLScriptElement | null)?.src.split('?')[1] ?? 'dev', time: new Date().toISOString(), tenant: me.tenant.slug, tenantStatus: me.tenant.status, timezone: me.tenant.timezone, locale, roles: me.roles, realtime: status, online: navigator.onLine, userAgent: navigator.userAgent, screen: `${screen.width}x${screen.height}` };
  return <Page title="Help & support">
    <div className="grid two">
      <div className="card"><h2>Using SmartForce 360</h2><ul><li><b>{t('nav.command')}</b>: positions are shown with their age. Grey dashed markers are old — treat them as unknown, not as the current location.</li><li><b>{t('nav.alerts')}</b>: acknowledge to stop escalation; snooze and resolve need a reason.</li><li><b>{t('nav.incidents')}</b>: an SOS stays open until a person acknowledges it.</li><li><b>{t('nav.attendance')}</b>: corrections never overwrite the original record.</li></ul><p className="small muted">{t('basis.legend')}</p></div>
      <div className="card"><h2>Support</h2><p>Contact your organisation administrator first. For platform problems your administrator can raise a support request; platform staff cannot see your data unless your Owner approves time-limited access.</p>
        <h3>Diagnostics</h3><p className="small muted">Contains no passwords, tokens or locations. Copy it into your support request.</p><pre className="small mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(diag, null, 1)}</pre>
        <button onClick={() => void navigator.clipboard?.writeText(JSON.stringify(diag)).then(() => setCopied(true))}>{copied ? '✓' : t('common.copy')}</button></div>
      <div className="card"><h2>{t('prv.notice')}</h2><Async s={notice}>{notice.data?.notice ? <><p className="small muted">v{notice.data.notice.version}</p><div style={{ whiteSpace: 'pre-wrap' }}>{notice.data.notice.texts[locale]}</div></> : <p>{t('common.none')}</p>}</Async></div>
    </div>
  </Page>;
}
