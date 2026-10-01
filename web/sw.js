const V = 'gameday-v3';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/badge-96.png'];
const ALERTS = 'https://lilemnoqfikkrykkrrpt.supabase.co/functions/v1/alerts';
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first so scores stay fresh; fall back to the last copy when offline.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;
  e.respondWith(fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(V).then(c => c.put(req, copy)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error()))));
});

// ---- live game alerts ----
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Gameday', body: e.data ? e.data.text() : '' }; }
  const opts = {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    timestamp: d.ts || Date.now(),
    silent: !!d.silent,
    vibrate: d.silent ? undefined : [90, 50, 90],
    data: { url: d.url || '/', eventId: d.eventId, sid: d.sid, mt: d.mt },
    actions: d.eventId ? [{ action: 'open', title: 'Open game' }, { action: 'mute', title: 'Mute this game' }] : []
  };
  e.waitUntil(self.registration.showNotification(d.title || 'Gameday', opts));
});

self.addEventListener('notificationclick', e => {
  const n = e.notification, d = n.data || {};
  n.close();
  if (e.action === 'mute' && d.eventId) {
    e.waitUntil(fetch(ALERTS, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'mute', sid: d.sid, mt: d.mt, eventId: String(d.eventId) }) })
      .then(() => self.registration.getNotifications())
      .then(list => list.forEach(x => { if (x.data && x.data.eventId === d.eventId) x.close(); }))
      .catch(() => {}));
    return;
  }
  const url = new URL(d.url || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) { if (c.url.startsWith(self.location.origin)) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
