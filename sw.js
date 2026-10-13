// Johnston Clinic Staff Portal — Service Worker
// Handles push notifications and basic offline caching

const CACHE_NAME = 'johnston-portal-v1';
const OFFLINE_URLS = ['/index.html', '/manifest.json'];

// ── Install: cache shell ──────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(OFFLINE_URLS))
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first for API calls, cache-first for shell ────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Let Supabase API calls go straight to network
  if (url.hostname.includes('supabase.co')) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ── Push: show notification ───────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: 'Johnston Clinic', body: 'Schedule updated', tag: 'schedule-update' };
  try { data = { ...data, ...event.data.json() }; } catch (e) {}

  const options = {
    body: data.body,
    tag: data.tag || 'schedule-update',   // collapses duplicate notifs
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    requireInteraction: false,
    data: { url: data.url || '/index.html' }
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// ── Notification click: open/focus the portal ─────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/index.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('index.html') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});
