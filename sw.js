/* Piano Nutrizionale — service worker PWA.
 * Shell versionata, network-first per la navigazione, cache per gli asset,
 * nessuna intercettazione delle richieste Firebase (altri origin), pulizia
 * delle cache obsolete. Tutti i percorsi sono relativi per GitHub Pages
 * (sottocartella /pianoNutrizionale/).
 */
// IMPORTANTE: incrementare CACHE_VERSION a OGNI modifica di CSS, JS o index.html.
const CACHE_VERSION = 6;
const CACHE = `piano-nutrizionale-shell-v${CACHE_VERSION}`;
const SHELL = [
  './',
  './index.html',
  './offline.html',
  './css/style.css',
  './js/domain.js',
  './js/data.js',
  './js/firebase.js',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg'
];

const FIREBASE_HOSTS = [
  'firebaseapp.com',
  'firebaseio.com',
  'googleapis.com',
  'gstatic.com',
  'google.com'
];

self.addEventListener('install', event => {
  // L'aggiornamento resta in attesa finché il banner non invia SKIP_WAITING.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isFirebaseRequest(url) {
  return FIREBASE_HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host));
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Non intercettare mai Firebase Auth, Firestore o App Check.
  if (url.origin !== self.location.origin || isFirebaseRequest(url)) return;

  // Navigazione: network-first, fallback alla shell in cache (o offline.html).
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html').then(cached => cached || caches.match('./offline.html')))
    );
    return;
  }

  // Asset statici: cache-first con aggiornamento in background (stale-while-revalidate).
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
