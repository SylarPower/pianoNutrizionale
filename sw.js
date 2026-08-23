/* Piano Nutrizionale — service worker PWA.
 * Shell versionata, network-first per la navigazione, cache per gli asset,
 * nessuna intercettazione delle richieste Firebase (altri origin), pulizia
 * delle cache obsolete. Tutti i percorsi sono relativi per GitHub Pages
 * (sottocartella /pianoNutrizionale/).
 */
// IMPORTANTE: incrementare CACHE_VERSION a OGNI modifica di CSS, JS o index.html.
const CACHE_VERSION = 25;
const CACHE = `piano-nutrizionale-shell-v${CACHE_VERSION}`;
const SHELL = [
  './',
  './index.html',
  './offline.html',
  './css/style.css',
  './js/domain.js',
  './js/data.js',
  './js/prices.js',
  './js/firebase.js',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg'
];

// SDK Firebase compat servito da CDN: file statici immutabili (l'URL contiene
// la versione), quindi cache-first. Senza questa cache, offline con la cache
// HTTP scaduta l'app non riusciva nemmeno a inizializzarsi.
const FIREBASE_SDK_PREFIX = 'https://www.gstatic.com/firebasejs/';
const FIREBASE_SDK = [
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-check-compat.js'
];

// Lettore barcode per la sezione Prezzi: URL versionato e immutabile come
// l'SDK Firebase, quindi precache in installazione e cache-first.
const PRICE_LIBS = [
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'
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
  event.waitUntil(caches.open(CACHE).then(cache =>
    cache.addAll(SHELL).then(() =>
      // La CDN irraggiungibile non deve far fallire l'installazione della shell:
      // SDK e librerie verranno comunque messi in cache al primo fetch riuscito.
      cache.addAll(FIREBASE_SDK.concat(PRICE_LIBS)).catch(() => {})
    )
  ));
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

// Solo i file statici della libreria (www.gstatic.com/firebasejs/...): le
// chiamate runtime a Firestore, Auth e App Check NON devono mai passare da qui.
function isFirebaseSdkAsset(url) {
  return url.href.startsWith(FIREBASE_SDK_PREFIX);
}

// Asset di librerie esterne versionate e immutabili (lettore barcode).
function isCachedCdnAsset(url) {
  return isFirebaseSdkAsset(url) || PRICE_LIBS.includes(url.href);
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // SDK Firebase e librerie CDN: cache-first, file versionati e immutabili.
  if (isCachedCdnAsset(url)) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
        // Nessuna risposta opaca o di errore in cache: solo copie utilizzabili.
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      }))
    );
    return;
  }

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
