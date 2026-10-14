// Johnston Clinic Staff Portal — Service Worker
// Handles push notifications and basic offline caching

const CACHE_NAME = 'johnston-portal-v5';
const OFFLINE_URLS = ['/index.html', '/manifest.json'];

// ── Install: cache shell, skip waiting immediately ───────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(OFFLINE_URLS))
  );
  self.skipWaiting(); // take control immediately, don't wait for old SW to die
});

// ── Activate: clean ALL old caches, claim clients ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()) // take control of all open tabs/windows
  );
});

// ── Fetch: always network-first, never serve stale HTML ──────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Let Supabase API calls go straight to network, no caching
  if (url.hostname.includes('supabase.co')) return;

  // For HTML pages: always try network first, cache only as offline fallback
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then(res => {
          // Update cache with fresh response
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // For everything else: network first, cache fallback
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ── Message: allow page to tell SW to skip waiting ───────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// ── Push: show notification ───────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: 'Johnston Clinic', body: 'Schedule updated', tag: 'schedule-update' };
  try { data = { ...data, ...event.data.json() }; } catch (e) {}

  const options = {
    body: data.body,
    tag: data.tag || 'schedule-update',
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
