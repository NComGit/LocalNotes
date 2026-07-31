/* ============================================================================
 * LocalNotes Manager - Service Worker
 * ----------------------------------------------------------------------------
 * Offline-first application shell cache. This worker ONLY ever caches the
 * static application wrapper (HTML/CSS/JS + the vendored /lib/ libraries).
 * It never touches, mirrors, uploads or inspects the user's notes: those live
 * exclusively on the local file system behind the File System Access API and
 * are read/written directly by app.js.
 * ==========================================================================*/

const VERSION = 'localnotes-v1.0.0';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

/* Core files required to boot the app with zero network availability. */
const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  './lib/idb-keyval.js',
  './lib/alasql.js',
  './lib/hugerte/hugerte.min.js'
];

/* ---------------------------------------------------------------------------
 * INSTALL - pre-cache the shell. Individual failures are tolerated so that a
 * missing optional file (e.g. a library not yet vendored) cannot brick install.
 * -------------------------------------------------------------------------*/
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try {
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (response && (response.ok || response.type === 'opaque')) {
          await cache.put(url, response);
        }
      } catch (err) {
        /* Non-fatal: the runtime handler will cache it on first successful hit. */
        console.warn('[sw] could not precache', url, err && err.message);
      }
    }));
    await self.skipWaiting();
  })());
});

/* ---------------------------------------------------------------------------
 * ACTIVATE - drop stale versioned caches and take control immediately.
 * -------------------------------------------------------------------------*/
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
        .map((key) => caches.delete(key))
    );
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (_) { /* ignore */ }
    }
    await self.clients.claim();
  })());
});

/* ---------------------------------------------------------------------------
 * FETCH - navigation requests fall back to the cached shell; same-origin GETs
 * are served cache-first then revalidated in the background (stale-while-
 * revalidate). Cross-origin requests are passed straight through untouched:
 * the app makes none, but templates may legitimately want to be self-contained.
 * -------------------------------------------------------------------------*/
self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /* Blob and data URLs (template modules, asset previews) bypass the worker. */
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const network = await fetch(request);
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(request, network.clone());
        return network;
      } catch (err) {
        const cached = await caches.match('./index.html');
        return cached || new Response(
          '<!DOCTYPE html><meta charset="utf-8"><title>Offline</title>' +
          '<body style="font:14px system-ui;padding:2rem;background:#FCFCFA;color:#1a1c1b">' +
          '<h1 style="font:600 24px Georgia,serif">LocalNotes is offline</h1>' +
          '<p>The application shell is not cached yet. Reconnect once to install it.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      /* Background revalidation - never blocks the response. */
      event.waitUntil((async () => {
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(request, fresh.clone());
          }
        } catch (_) { /* offline: keep the cached copy */ }
      })());
      return cached;
    }

    try {
      const network = await fetch(request);
      if (network && network.ok) {
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(request, network.clone());
      }
      return network;
    } catch (err) {
      return new Response('', { status: 504, statusText: 'Offline and not cached' });
    }
  })());
});

/* ---------------------------------------------------------------------------
 * MESSAGES - lets the Settings panel force an update or purge the shell cache.
 * -------------------------------------------------------------------------*/
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (data.type === 'PURGE_CACHES') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      if (event.source && event.source.postMessage) {
        event.source.postMessage({ type: 'CACHES_PURGED' });
      }
    })());
  }
  if (data.type === 'GET_VERSION' && event.source && event.source.postMessage) {
    event.source.postMessage({ type: 'VERSION', version: VERSION });
  }
});
