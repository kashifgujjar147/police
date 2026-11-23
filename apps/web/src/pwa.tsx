// PWA: service worker registration and the "Install app" button (Android/desktop prompt; iPhone hint).
import { useEffect, useState } from 'react';

type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: InstallEvent | null = null; const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export function registerPwa() {
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallEvent; notify(); });
  addEventListener('appinstalled', () => { deferred = null; notify(); });
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && secure) addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => { /* app still works online */ }); });
}
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !/CriOS|FxiOS/.test(navigator.userAgent);

export function InstallButton({ t }: { t: (k: string) => string }) {
  const [, tick] = useState(0); const [hint, setHint] = useState(false);
  useEffect(() => { const f = () => tick((n) => n + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  if (isStandalone()) return null;
  if (deferred) return <button type="button" className="install" onClick={async () => { const e = deferred!; await e.prompt(); await e.userChoice; deferred = null; notify(); }}>{t('pwa.install')}</button>;
  if (isIos()) return <span className="install-wrap"><button type="button" className="install" aria-expanded={hint} onClick={() => setHint(!hint)}>{t('pwa.install')}</button>{hint && <span className="small muted" role="note"> {t('pwa.iosHint')}</span>}</span>;
  return null;
}
