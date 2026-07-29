self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  // Minimal service worker: network first, then cache (though no cache setup here for simplicity, just a pass-through)
  e.respondWith(fetch(e.request).catch(() => new Response('Offline', { status: 503 })));
});
