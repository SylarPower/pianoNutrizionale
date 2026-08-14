const CACHE = 'piano-nutrizionale-shell-v4';
const SHELL = ['./','./index.html','./css/style.css','./js/domain.js','./js/data.js','./js/firebase.js','./js/app.js','./manifest.json','./icons/icon-192.svg','./icons/icon-512.svg'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('message', event => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.includes('firestore') || url.pathname.includes('identitytoolkit') || url.pathname.includes('securetoken')) return;
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request).then(response => { const copy=response.clone(); caches.open(CACHE).then(c=>c.put('./index.html',copy)); return response; }).catch(() => caches.match('./index.html')));
  else event.respondWith(caches.match(event.request).then(cached => { const network=fetch(event.request).then(response=>{caches.open(CACHE).then(c=>c.put(event.request,response.clone()));return response;}).catch(()=>cached); return cached || network; }));
});