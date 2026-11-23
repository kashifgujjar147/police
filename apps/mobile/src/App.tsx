// SmartForce 360 field app: sign-in/activation, privacy notice, today's duty, start/end/break, checkpoint scan,
// incident report, press-and-hold SOS with honest delivery status, offline queue status and own-data view (PRD §8.10).
// STATUS: source written against Expo SDK 52; not compiled or device-tested in the build environment.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, I18nManager, Linking, Pressable, RefreshControl, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import * as Battery from 'expo-battery';
import * as Device from 'expo-device';
import * as Localization from 'expo-localization';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { type Locale, fmtAge, fmtDateTime, translate } from '@sf/i18n';
import { ApiError } from '@sf/mobile-core';
import { api, baseUrl, boot, devicePlatform, duty, outbox, setBaseUrl, sos, sync } from './platform';
import { currentFix, permissionState, requestPermissions, startTracking, stopTracking } from './location';

const M: Record<Locale, Record<string, string>> = {
  en: { today: 'My duty', none: 'No duty assigned for now.', start: 'Start duty', end: 'End duty', brk: 'Start break', brkEnd: 'End break', scan: 'Scan checkpoint', report: 'Report incident', sos: 'Hold for SOS', sosHolding: 'Keep holding…', queue: 'Waiting to send', synced: 'All records sent', rejected: 'Needs your attention', permTitle: 'Location permission', permWhy: 'Your location is recorded only while you are on duty. For tracking to continue when the phone is locked, allow location "all the time". You can change this in phone settings at any time.', allow: 'Allow location', openSettings: 'Open settings', trackingOn: 'On duty — location is being recorded', trackingOff: 'Not on duty — location is not recorded', ack: 'Acknowledge', ackDone: 'Acknowledged', supervisor: 'Supervisor', call: 'Call', server: 'Server address', lastSync: 'Last sync', ok: 'OK', sosFallback: 'No one has confirmed yet.', cancelReq: 'I pressed it by mistake', type: 'Type', description: 'What happened?', send: 'Send', notice: 'Before your first duty', accept: 'I have read and accept', sosSent: 'SOS', mydata: 'My data', fix: 'Request correction' },
  ar: { today: 'مناوبتي', none: 'لا توجد مناوبة مسندة حاليًا.', start: 'بدء المناوبة', end: 'إنهاء المناوبة', brk: 'بدء الاستراحة', brkEnd: 'إنهاء الاستراحة', scan: 'مسح نقطة التحقق', report: 'الإبلاغ عن حادثة', sos: 'اضغط مطولًا للاستغاثة', sosHolding: 'استمر بالضغط…', queue: 'بانتظار الإرسال', synced: 'تم إرسال كل السجلات', rejected: 'يحتاج إلى انتباهك', permTitle: 'إذن الموقع', permWhy: 'يُسجَّل موقعك فقط أثناء المناوبة. لكي يستمر التسجيل عند قفل الهاتف، اسمح بالموقع "طوال الوقت". يمكنك تغيير ذلك من الإعدادات في أي وقت.', allow: 'السماح بالموقع', openSettings: 'فتح الإعدادات', trackingOn: 'في المناوبة — يتم تسجيل الموقع', trackingOff: 'لست في المناوبة — لا يُسجَّل الموقع', ack: 'تأكيد الاستلام', ackDone: 'تم التأكيد', supervisor: 'المشرف', call: 'اتصال', server: 'عنوان الخادم', lastSync: 'آخر مزامنة', ok: 'حسنًا', sosFallback: 'لم يؤكد أحد الاستلام بعد.', cancelReq: 'ضغطت بالخطأ', type: 'النوع', description: 'ماذا حدث؟', send: 'إرسال', notice: 'قبل مناوبتك الأولى', accept: 'قرأت وأوافق', sosSent: 'استغاثة', mydata: 'بياناتي', fix: 'طلب تصحيح' },
};

export default function App() {
  const [locale, setLocale] = useState<Locale>(Localization.getLocales()[0]?.languageCode === 'ar' ? 'ar' : 'en');
  const t = (k: string, v?: Record<string, string | number>) => M[locale][k] ?? translate(locale, k, v);
  const [ready, setReady] = useState(false); const [signedIn, setSignedIn] = useState(false); const [, force] = useState(0); const rerender = useCallback(() => force((x) => x + 1), []);
  useEffect(() => { I18nManager.allowRTL(true); void boot().then(() => { setSignedIn(!!api.session); setReady(true); }); sync.onChange = rerender; sos.onChange = rerender; }, []);
  useEffect(() => { const sub = AppState.addEventListener('change', (s) => { if (s === 'active' && api.session) void sync.sync(); }); return () => sub.remove(); }, []);
  if (!ready) return <SafeAreaView style={s.center}><ActivityIndicator /></SafeAreaView>;
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  return <SafeAreaView style={[s.root, { direction: dir } as any]}><StatusBar style="light" />
    <View style={s.top}><Text style={s.brand}>{translate(locale, 'app.name')}</Text><Pressable accessibilityRole="button" onPress={() => setLocale(locale === 'en' ? 'ar' : 'en')}><Text style={s.topBtn}>{locale === 'en' ? 'العربية' : 'English'}</Text></Pressable></View>
    {signedIn ? <Home t={t} locale={locale} onSignOut={async () => { await stopTracking(); await api.logout(); setSignedIn(false); }} /> : <SignIn t={t} onDone={() => setSignedIn(true)} />}
  </SafeAreaView>;
}

function SignIn({ t, onDone }: { t: (k: string) => string; onDone(): void }) {
  const [mode, setMode] = useState<'login' | 'activate'>('login'); const [v, setV] = useState({ tenant: '', id: '', password: '', code: '', server: baseUrl }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      await setBaseUrl(v.server);
      if (mode === 'activate') { const r = await api.activate(v.tenant, v.code.trim().toUpperCase(), v.password); setV({ ...v, id: r.username }); setMode('login'); setBusy(false); return; }
      const r = await api.login(v.tenant.trim(), v.id.trim(), v.password);
      if (!r.ok) { setErr('This role signs in on the web portal with two-step sign-in.'); return; }
      if (!api.session!.deviceId) await api.registerDevice({ platform: devicePlatform, osVersion: String(Device.osVersion ?? ''), model: Device.modelName ?? undefined });
      onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'The server could not be reached. Check your connection.'); } finally { setBusy(false); }
  };
  return <ScrollView contentContainerStyle={s.pad}>
    <Field label={t('auth.organisation')} value={v.tenant} onChange={(x) => setV({ ...v, tenant: x })} />
    {mode === 'login' ? <Field label={t('auth.identifier')} value={v.id} onChange={(x) => setV({ ...v, id: x })} /> : <Field label={t('auth.activationCode')} value={v.code} onChange={(x) => setV({ ...v, code: x })} />}
    <Field label={mode === 'login' ? t('auth.password') : t('auth.newPassword')} value={v.password} onChange={(x) => setV({ ...v, password: x })} secure />
    <Field label={t('server')} value={v.server} onChange={(x) => setV({ ...v, server: x })} />
    {!!err && <Text style={s.err} accessibilityRole="alert">{err}</Text>}
    <Btn label={mode === 'login' ? t('auth.signIn') : t('auth.activate')} onPress={go} busy={busy} primary />
    <Btn label={mode === 'login' ? t('auth.haveCode') : t('auth.signIn')} onPress={() => setMode(mode === 'login' ? 'activate' : 'login')} />
  </ScrollView>;
}

function Home({ t, locale, onSignOut }: { t: (k: string, v?: any) => string; locale: Locale; onSignOut(): void }) {
  const [data, setData] = useState<any>(null); const [notice, setNotice] = useState<any>(null); const [perm, setPerm] = useState<string>('unknown'); const [view, setView] = useState<'duty' | 'scan' | 'incident' | 'data'>('duty'); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
  const fmt = { locale, timezone: data?.items?.[0]?.timezone ?? 'UTC' };
  const load = useCallback(async () => {
    try { const [d, n] = await Promise.all([api.call('GET', '/me/duty'), api.call('GET', '/privacy/notices/current')]); setData(d); setNotice(n); await outbox.load(); } catch (e) { if (e instanceof ApiError && (e.code === 'DEVICE_REVOKED' || e.status === 401)) onSignOut(); }
    setPerm(await permissionState());
  }, []);
  useEffect(() => { void load(); const i = setInterval(() => void heartbeat(), 5 * 60000); void heartbeat(); return () => clearInterval(i); }, []);
  useEffect(() => { if (outbox.tracking) void startTracking(); else void stopTracking(); }, [outbox.tracking?.sessionId, outbox.tracking?.profile?.paused]);
  const heartbeat = async () => { try { await api.call('POST', '/devices/heartbeat', { battery: Math.round((await Battery.getBatteryLevelAsync()) * 100), network: sync.online ? 'unknown' : 'none', permissions: { location: (await permissionState()) as any }, appVersion: api.appVersion, pendingEvents: outbox.pending().length, oldestPendingAgeSec: outbox.status(Date.now()).oldestPendingAgeSec }, { signed: true }); } catch { /* offline: next heartbeat */ } };
  const act = async (fn: () => Promise<any>) => {
    setBusy(true); setMsg('');
    try { const r = await fn(); await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); if (r?.rejected) setMsg(`${r.rejected.message}`); else if (r?.queued) setMsg(t('queue')); await load(); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  if (notice?.notice && !notice.acknowledged) return <ScrollView contentContainerStyle={s.pad}><Text style={s.h1}>{t('notice')}</Text><Text style={s.body}>{notice.notice.texts[locale]}</Text><Btn primary label={t('accept')} onPress={() => void act(async () => { await api.call('POST', '/privacy/acknowledgements', { version: notice.notice.version }); })} busy={busy} /></ScrollView>;
  const st = outbox.status(Date.now()); const a = data?.items?.find((x: any) => ['started', 'on_break'].includes(x.status)) ?? data?.items?.find((x: any) => x.status === 'scheduled');
  return <View style={{ flex: 1 }}>
    <SosBar t={t} locale={locale} />
    <View style={[s.track, { backgroundColor: outbox.tracking ? '#e2f3e8' : '#eef1f5' }]} accessibilityLiveRegion="polite"><Text style={s.trackTxt}>{outbox.tracking ? `● ${t('trackingOn')}` : `○ ${t('trackingOff')}`}</Text></View>
    {(st.pendingEvents + st.pendingPoints > 0 || st.rejected > 0) && <View style={s.queue}><Text style={s.queueTxt}>{st.rejected ? `⚠ ${t('rejected')}: ${st.rejected} · ` : ''}{t('queue')}: {st.pendingEvents} / {st.pendingPoints} · {fmtAge(st.oldestPendingAgeSec, fmt)}{sync.online ? '' : ' · offline'}</Text></View>}
    {view === 'scan' ? <Scanner t={t} onCode={(code) => { setView('duty'); void act(async () => duty.scan(code, a?.id, await currentFix())); }} onClose={() => setView('duty')} />
      : view === 'incident' ? <IncidentForm t={t} onSend={(type, text) => { setView('duty'); void act(async () => duty.incident(type, text, { location: await currentFix(), assignmentId: a?.id })); }} onClose={() => setView('duty')} />
      : view === 'data' ? <MyData t={t} locale={locale} onClose={() => setView('duty')} />
      : <ScrollView contentContainerStyle={s.pad} refreshControl={<RefreshControl refreshing={false} onRefresh={() => { void sync.sync().then(load); }} />}>
        {perm !== 'always' && <View style={s.card}><Text style={s.h2}>{t('permTitle')}</Text><Text style={s.body}>{t('permWhy')}</Text><Btn label={t('allow')} onPress={() => void requestPermissions().then(setPerm)} /><Btn label={t('openSettings')} onPress={() => void Linking.openSettings()} /></View>}
        {!!msg && <Text style={s.msg} accessibilityRole="alert">{msg}</Text>}
        <Text style={s.h1}>{t('today')}</Text>
        {!a ? <Text style={s.body}>{t('none')}</Text> : <View style={s.card}>
          <Text style={s.h2}>{a.post?.name ?? a.shiftName}</Text>
          <Text style={s.body}>{fmtDateTime(a.startsAt, fmt)} – {fmtDateTime(a.endsAt, fmt, 'time')}</Text>
          {a.post?.instructions && <Text style={s.small}>{a.post.instructions}</Text>}
          {a.supervisor && <Pressable onPress={() => a.supervisor.phone && Linking.openURL(`tel:${a.supervisor.phone}`)} accessibilityRole="button"><Text style={s.link}>{t('supervisor')}: {a.supervisor.displayName} {a.supervisor.phone ? `· ${t('call')}` : ''}</Text></Pressable>}
          {!a.ackAt && <Btn label={t('ack')} onPress={() => void act(() => api.call('POST', `/assignments/${a.id}/acknowledge`, {}))} />}
          {a.status === 'scheduled' && <Btn primary label={t('start')} busy={busy} onPress={() => void act(async () => duty.start(a.id, await currentFix()))} />}
          {a.status === 'started' && <><Btn label={t('scan')} onPress={() => setView('scan')} /><Btn label={t('brk')} onPress={() => void act(() => duty.breakStart(a.id))} /><Btn primary label={t('end')} busy={busy} onPress={() => Alert.alert(t('end'), '', [{ text: translate(locale, 'common.cancel') }, { text: t('ok'), onPress: () => void act(async () => duty.end(a.id, await currentFix())) }])} /></>}
          {a.status === 'on_break' && <Btn primary label={t('brkEnd')} onPress={() => void act(() => duty.breakEnd(a.id))} />}
          {a.checkpoints.map((c: any) => <Text key={c.expectationId} style={s.small}>{c.state === 'completed' ? '✓' : '○'} {c.name} · {fmtDateTime(c.windowEnd, fmt, 'time')}</Text>)}
        </View>}
        {outbox.rejected().map((e) => <View key={e.eventId} style={[s.card, { borderColor: '#a4161a' }]}><Text style={s.h2}>⚠ {e.type} · {fmtDateTime(e.occurredAt, fmt)}</Text><Text style={s.body}>{e.rejection?.message}</Text><Btn label={t('ok')} onPress={() => void outbox.acknowledgeRejection(e.eventId).then(load)} /></View>)}
        <Btn label={t('report')} onPress={() => setView('incident')} /><Btn label={t('mydata')} onPress={() => setView('data')} />
        <Text style={s.small}>{t('lastSync')}: {sync.lastSync ? fmtDateTime(sync.lastSync, fmt) : '—'}{sync.lastError ? ` · ${sync.lastError}` : ''}</Text>
        <Btn label={translate(locale, 'common.signOut')} onPress={onSignOut} />
      </ScrollView>}
  </View>;
}

/** Press and hold for the configured time; release cancels. Status text reflects only server-confirmed states. */
function SosBar({ t, locale }: { t: (k: string) => string; locale: Locale }) {
  useEffect(() => { if (sos.state === 'idle' || sos.state === 'acknowledged_by_human') return; const i = setInterval(() => void sos.refresh(), 5000); return () => clearInterval(i); }, [sos.state]);
  const active = sos.state !== 'idle' && sos.state !== 'holding';
  return <View style={s.sosWrap}>
    <Pressable accessibilityRole="button" accessibilityLabel={t('sos')} accessibilityHint="Press and hold for two seconds" onPressIn={() => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); sos.pressStart(); }} onPressOut={() => sos.pressCancel()} style={[s.sos, sos.state === 'holding' && { backgroundColor: '#7d0017' }]}>
      <Text style={s.sosTxt}>{sos.state === 'holding' ? t('sosHolding') : t('sos')}</Text></Pressable>
    {active && <View style={s.sosStatus} accessibilityLiveRegion="assertive"><Text style={s.sosStatusTxt}>{t('sosSent')} {sos.number ?? ''}: {translate(locale, `sos.${sos.state}`)}</Text>
      {sos.showFallback && <Text style={s.sosStatusTxt}>{t('sosFallback')} {sos.fallback.instructions[locale] ?? ''}</Text>}
      {sos.state === 'acknowledged_by_human' ? <Btn label={t('ok')} onPress={() => sos.reset()} /> : <Btn label={t('cancelReq')} onPress={() => void sos.requestCancel('pressed by mistake')} />}</View>}
  </View>;
}
function Scanner({ t, onCode, onClose }: { t: (k: string) => string; onCode(c: string): void; onClose(): void }) {
  const [perm, ask] = useCameraPermissions(); const done = useRef(false);
  if (!perm?.granted) return <View style={s.pad}><Btn primary label={t('allow')} onPress={() => void ask()} /><Btn label={translate('en', 'common.cancel')} onPress={onClose} /></View>;
  return <View style={{ flex: 1 }}><CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(r) => { if (!done.current) { done.current = true; onCode(r.data); } }} /><Btn label={translate('en', 'common.cancel')} onPress={onClose} /></View>;
}
function IncidentForm({ t, onSend, onClose }: { t: (k: string) => string; onSend(type: string, text: string): void; onClose(): void }) {
  const [type, setType] = useState('hazard'); const [text, setText] = useState('');
  return <ScrollView contentContainerStyle={s.pad}><Text style={s.h1}>{t('report')}</Text><Text style={s.label}>{t('type')}</Text>
    <View style={s.row}>{['personal_safety', 'medical', 'security_breach', 'hazard', 'other'].map((k) => <Pressable key={k} onPress={() => setType(k)} accessibilityRole="radio" accessibilityState={{ selected: type === k }} style={[s.pill, type === k && s.pillOn]}><Text>{k.replace('_', ' ')}</Text></Pressable>)}</View>
    <Field label={t('description')} value={text} onChange={setText} multiline /><Btn primary label={t('send')} onPress={() => text.trim() && onSend(type, text)} /><Btn label="×" onPress={onClose} /></ScrollView>;
}
function MyData({ t, locale, onClose }: { t: (k: string) => string; locale: Locale; onClose(): void }) {
  const [d, setD] = useState<any>(null); const [log, setLog] = useState<any>(null);
  useEffect(() => { void api.call('GET', '/me/data').then(setD).catch(() => {}); void api.call('GET', '/me/location-access-log').then(setLog).catch(() => {}); }, []);
  const fmt = { locale, timezone: 'UTC' };
  return <ScrollView contentContainerStyle={s.pad}><Text style={s.h1}>{t('mydata')}</Text>{d && <><Text style={s.h2}>{translate(locale, 'prv.collected')}</Text>{d.collected.map((c: string) => <Text key={c} style={s.body}>• {c}</Text>)}</>}
    <Text style={s.h2}>{translate(locale, 'prv.accessLog')}</Text>{(log?.items ?? []).map((x: any, i: number) => <Text key={i} style={s.small}>{fmtDateTime(x.at, fmt)} · {x.accessedBy} · {x.purpose}</Text>)}<Btn label="×" onPress={onClose} /></ScrollView>;
}
const Field = ({ label, value, onChange, secure, multiline }: { label: string; value: string; onChange(v: string): void; secure?: boolean; multiline?: boolean }) => <View style={{ marginBottom: 10 }}><Text style={s.label}>{label}</Text><TextInput accessibilityLabel={label} style={[s.input, multiline && { minHeight: 90 }]} value={value} onChangeText={onChange} secureTextEntry={secure} autoCapitalize="none" autoCorrect={false} multiline={multiline} /></View>;
const Btn = ({ label, onPress, primary, busy }: { label: string; onPress(): void; primary?: boolean; busy?: boolean }) => <Pressable accessibilityRole="button" disabled={busy} onPress={onPress} style={[s.btn, primary && s.btnP, busy && { opacity: 0.6 }]}><Text style={[s.btnTxt, primary && { color: '#fff' }]}>{busy ? '…' : label}</Text></Pressable>;

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f4f6f8' }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' }, pad: { padding: 16 },
  top: { backgroundColor: '#0b4f7a', paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', justifyContent: 'space-between' }, brand: { color: '#fff', fontWeight: '700', fontSize: 17 }, topBtn: { color: '#fff', fontSize: 15 },
  h1: { fontSize: 22, fontWeight: '700', marginBottom: 8 }, h2: { fontSize: 17, fontWeight: '700', marginBottom: 6 }, body: { fontSize: 16, lineHeight: 23, marginBottom: 8 }, small: { fontSize: 14, color: '#55606e', marginTop: 4 }, label: { fontWeight: '600', marginBottom: 4, fontSize: 15 },
  input: { borderWidth: 1, borderColor: '#9aa5b1', borderRadius: 8, padding: 12, fontSize: 16, backgroundColor: '#fff' }, err: { color: '#a4161a', fontWeight: '600', marginBottom: 8 }, msg: { backgroundColor: '#fdf0d5', color: '#8a5300', padding: 10, borderRadius: 8, marginBottom: 10 },
  btn: { minHeight: 48, borderRadius: 8, borderWidth: 1, borderColor: '#d5dbe3', backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginTop: 8, paddingHorizontal: 12 }, btnP: { backgroundColor: '#0b4f7a', borderColor: '#0b4f7a' }, btnTxt: { fontSize: 16, fontWeight: '600' },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#d5dbe3', padding: 14, marginBottom: 12 }, link: { color: '#0b4f7a', fontSize: 15, marginVertical: 6, textDecorationLine: 'underline' },
  track: { paddingHorizontal: 16, paddingVertical: 8 }, trackTxt: { fontWeight: '600' }, queue: { backgroundColor: '#fdf0d5', paddingHorizontal: 16, paddingVertical: 6 }, queueTxt: { color: '#8a5300' },
  sosWrap: { padding: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderColor: '#d5dbe3' }, sos: { backgroundColor: '#b00020', borderRadius: 12, minHeight: 64, alignItems: 'center', justifyContent: 'center' }, sosTxt: { color: '#fff', fontSize: 20, fontWeight: '800' },
  sosStatus: { marginTop: 8, backgroundColor: '#fbe4e4', padding: 10, borderRadius: 8 }, sosStatusTxt: { color: '#a4161a', fontWeight: '700', fontSize: 15 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }, pill: { borderWidth: 1, borderColor: '#9aa5b1', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8 }, pillOn: { backgroundColor: '#e3edfa', borderColor: '#1d4f91' },
});
