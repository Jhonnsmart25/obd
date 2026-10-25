'use strict';
// Service Worker: la app abre al instante y sin conexión. Stale-While-Revalidate para los archivos de la app.
// La API (cuentas, pagos y la base de códigos protegida) nunca se guarda aquí.
// Sube VERSION cada vez que cambies archivos de public/.
const VERSION = 'obd-v1';
const SHELL = ['/', '/styles.css', '/obd.js', '/app.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Cualquier ruta de navegación usa el mismo index.html guardado
  const key = req.mode === 'navigate' ? '/' : req;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(key);
    const refresh = fetch(req).then((res) => { if (res.ok) cache.put(key, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    return (await refresh) || new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
