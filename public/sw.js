// Minimal SW used to flush pending note edits during tab close.
// It now also precaches core assets so VibeNote can be installed as a PWA.
// It does not read IndexedDB or localStorage; the page passes payloads via postMessage.

const APP_SHELL_CACHE = 'vibenote-app-shell-v1';
const ASSET_CACHE = 'vibenote-asset-v1';
const APP_SHELL_URLS = [
  '/',
  '/index.html',
  '/assets/manifest.webmanifest',
  '/assets/favicon.svg',
  '/assets/favicon-32x32.png',
  '/assets/apple-touch-icon.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        let cache = await caches.open(APP_SHELL_CACHE);
        await cache.addAll(APP_SHELL_URLS);
      } catch {
        // Ignore failures; we will populate the cache lazily later.
      }
    })()
  );
  // Activate immediately so a controller is available on first load
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      let cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name !== APP_SHELL_CACHE && name !== ASSET_CACHE)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  let request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  if (!shouldHandleAsAsset(request, url)) return;

  event.respondWith(
    (async () => {
      let cache = await caches.open(ASSET_CACHE);
      let cached = await cache.match(request);
      if (cached) {
        event.waitUntil(updateAssetCache(cache, request));
        return cached;
      }
      let response = await updateAssetCache(cache, request);
      if (response) return response;
      if (cached) return cached;
      return fetch(request);
    })()
  );
});

async function handleNavigationRequest(request) {
  let cache = await caches.open(APP_SHELL_CACHE);
  let pathname = '/';
  try {
    pathname = new URL(request.url).pathname || '/';
  } catch {}
  try {
    let response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
      if (pathname === '/') {
        await cache.put('/', response.clone());
      }
    }
    return response;
  } catch (error) {
    let cached = (await cache.match(request)) || (await cache.match('/'));
    if (cached) return cached;
    throw error;
  }
}

function shouldHandleAsAsset(request, url) {
  if (url.pathname === '/sw.js') return false;
  if (url.pathname.startsWith('/assets/')) return true;
  if (url.pathname.endsWith('.webmanifest')) return true;
  let destinations = ['style', 'script', 'worker', 'font', 'image'];
  return destinations.includes(request.destination);
}

async function updateAssetCache(cache, request) {
  try {
    let response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return undefined;
  }
}

async function putFile(config, file, token) {
  const url = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
    config.repo
  )}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      message: file.message || 'vibenote: background save',
      content: btoa(unescape(encodeURIComponent(file.text || ''))),
      sha: file.baseSha || undefined,
      branch: config.branch || 'main',
    }),
  });
  // Ignore failures; this is best effort during shutdown
  return res.ok;
}

async function flush(payload) {
  const { token, config, files } = payload || {};
  if (!token || !config || !Array.isArray(files) || files.length === 0) return;
  // Serialize pushes to avoid hitting GitHub abuse heuristics on shutdown
  for (const f of files) {
    try {
      // Use waitUntil at top-level caller
      // eslint-disable-next-line no-await-in-loop
      await putFile(config, f, token);
    } catch {
      // ignore
    }
  }
}

// Lightweight IndexedDB queue for retries
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('vibenote', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('flushQueue')) {
        db.createObjectStore('flushQueue', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queuePayload(payload) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('flushQueue', 'readwrite');
    tx.objectStore('flushQueue').add({ createdAt: Date.now(), payload });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function readAllQueued() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('flushQueue', 'readonly');
    const req = tx.objectStore('flushQueue').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function clearQueued(ids) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('flushQueue', 'readwrite');
    const store = tx.objectStore('flushQueue');
    ids.forEach((id) => store.delete(id));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function processQueue() {
  const items = await readAllQueued();
  if (!Array.isArray(items) || items.length === 0) return;
  for (const item of items) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await flush(item.payload);
      await clearQueued([item.id]);
    } catch {
      // keep for next retry
    }
  }
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'vibenote-flush') return;
  event.waitUntil(
    (async () => {
      await queuePayload(data.payload);
      try {
        if ('sync' in self.registration) {
          await self.registration.sync.register('vibenote-flush');
        }
      } catch {}
      await flush(data.payload);
    })()
  );
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'vibenote-flush') {
    event.waitUntil(processQueue());
  }
});
