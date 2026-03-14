// sw.js — Service Worker para PWA
const CACHE_NAME = 'moshiClaw-v1';

// Recursos a cachear para modo offline básico
const STATIC_CACHE = [
  '/',
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // No cachear APIs ni WebSocket
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    return;
  }

  // Network-first para la app, fallback a caché
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── Notificaciones: click abre la app y navega al agente ──────────────────
self.addEventListener('notificationclick', (event) => {
  const agentId = event.notification.data?.agentId || null;
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Buscar pestaña ya abierta
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage({ type: 'cc_notification_click', agentId });
          return client.focus();
        }
      }
      // Si no hay ventana abierta, abrir la app
      return clients.openWindow('/').then(win => {
        if (win) win.postMessage({ type: 'cc_notification_click', agentId });
      });
    })
  );
});
