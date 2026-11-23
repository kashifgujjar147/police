// SmartForce 360 service worker: makes the portal installable and lets the app shell open offline.
// Rules: API/auth/health traffic is NEVER cached (no personal or operational data on the device);
// the shell is network-first, so every deploy is picked up immediately when online.
const CACHE = 'sf360-shell-v1';
const SHELL = ['/', '/app.js', '/app.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health') || url.pathname === '/metrics') return; // never cache data
  const key = req.mode === 'navigate' ? '/' : url.pathname;
  const cacheable = req.mode === 'navigate' || SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/');
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok && cacheable) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key).then((hit) => hit || caches.match('/')))
  );
});
