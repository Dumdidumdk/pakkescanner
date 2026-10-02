// Service worker: gemmer appens filer på telefonen, så scanner-siden virker uden net.
// Strategi: prøv nettet først (så man altid får nyeste version), brug cachen hvis nettet er væk.
// API-kald og billeder caches aldrig – scanninger håndteres af køen i queue.js.
const CACHE = 'pakkescanner-v1';
const APP_FILES = [
  '/',
  '/index.html',
  '/scan.html',
  '/css/style.css',
  '/js/common.js',
  '/js/login.js',
  '/js/queue.js',
  '/js/scan.js',
  '/vendor/html5-qrcode.min.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/photos/')) return;

  event.respondWith(networkFirst(event.request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    // Omdirigering (fx til login) må ikke gemmes som selve siden
    if (response.redirected) return Response.redirect(response.url, 302);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') return (await cache.match('/scan.html')) || Response.error();
    return Response.error();
  }
}
