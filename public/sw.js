// Minimal SW used to flush pending note edits during tab close.
// It does not read IndexedDB or localStorage; the page passes payloads via postMessage.

self.addEventListener('install', () => {
  // Activate immediately so a controller is available on first load
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

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

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'vibenote-flush') return;
  event.waitUntil(flush(data.payload));
});

