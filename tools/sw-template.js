/* GetLow offline copy (service worker). tools/build-site.py fills in the
   version and the file list; each upload with changed files gets a new
   version, and the app offers "Update now" when it arrives. */
'use strict';
const VERSION = '__VERSION__';
const CACHE = 'getlow-' + VERSION;
const FILES = __FILES__;
// Three.js comes from a CDN: kept too, so the 3D view works offline
const REMOTE = __REMOTE__;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(FILES);
    for (const url of REMOTE) {
      try {
        const req = new Request(url, { mode: 'no-cors' });
        c.put(req, await fetch(req));
      } catch (err) { /* online-only until next time */ }
    }
  }));
});

// the page asks for the new version to take over ("Update now")
self.addEventListener('message', (e) => { if (e.data === 'skip') self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('getlow-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// the copy on this device first (it's versioned); the network for anything else
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (err) {
      // offline and not cached: open the app itself for page loads
      if (req.mode === 'navigate') return (await c.match('./')) || (await c.match('index.html'));
      throw err;
    }
  }));
});
