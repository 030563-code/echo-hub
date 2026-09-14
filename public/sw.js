/*
 * Echo Barrier Hub service worker.
 *
 * ITS ONLY JOB IS TO MAKE THE APP INSTALLABLE. It caches build assets and
 * nothing else, on purpose.
 *
 * This app shows live stock, live purchase orders and live invoices. A worker
 * that cached pages or data would hand someone yesterday's barrier count in a
 * window that looks exactly like the real thing, and they would act on it. So:
 *
 *   - Only /_next/static/ is cached. Those files are content-hashed, so a
 *     cached copy can never be the wrong version of anything.
 *   - Page loads always go to the network. If the network is gone, the offline
 *     card is shown instead of a stale page. No figures, ever, from cache.
 *   - Anything that is not a GET is not touched at all, which covers every
 *     Server Action the Hub runs.
 *   - React Server Component payloads (a GET back to the page URL) are not
 *     cached either, because only /_next/static/ is.
 *
 * tests/unit/service-worker-guard.test.ts fails the build if that changes.
 */

const VERSION = 'v1';
const ASSET_CACHE = `eb-hub-assets-${VERSION}`;
const SHELL_CACHE = `eb-hub-shell-${VERSION}`;
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL, '/icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Drop every cache from an older version, so a deploy cannot leave a stale
  // worker serving assets nothing references any more.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== ASSET_CACHE && k !== SHELL_CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Server Actions and every other write: never intercepted.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Build assets are content-hashed and immutable: cache first, and fill the
  // cache on the way past.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // A page load. Network only. Offline shows the card, never a cached page.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Everything else, data included, goes straight to the network untouched.
});
