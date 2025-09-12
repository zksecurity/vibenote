// Git sync helpers backed by GitHub's REST v3 API.
// Uses a stored OAuth token to read and write note files in a repository.

export interface RemoteConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  notesDir: string; // e.g., 'notes'
}

export interface RemoteFile {
  path: string;
  text: string;
  sha: string; // blob sha at HEAD
}

let remote: RemoteConfig | null = loadConfig();

function loadConfig(): RemoteConfig | null {
  const raw = localStorage.getItem('gitnote:config');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RemoteConfig;
  } catch {
    return null;
  }
}

export function configureRemote(cfg: RemoteConfig) {
  remote = cfg;
  localStorage.setItem('gitnote:config', JSON.stringify(cfg));
}

function authHeaders() {
  return {
    Authorization: `Bearer ${remote!.token}`,
    Accept: 'application/vnd.github+json',
  };
}

export async function pullNote(path: string): Promise<RemoteFile | null> {
  if (!remote) return null;
  const url = `https://api.github.com/repos/${remote.owner}/${remote.repo}/contents/${path}?ref=${remote.branch}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to fetch note');
  const data = await res.json();
  const content = atob((data.content as string).replace(/\n/g, ''));
  return { path, text: content, sha: data.sha };
}

export async function commitBatch(
  files: { path: string; text: string; baseSha?: string }[],
  message: string
): Promise<string | null> {
  if (!remote || files.length === 0) return null;
  let commitSha: string | null = null;
  for (const f of files) {
    const url = `https://api.github.com/repos/${remote.owner}/${remote.repo}/contents/${f.path}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        message,
        content: btoa(f.text),
        sha: f.baseSha,
        branch: remote.branch,
      }),
    });
    if (!res.ok) throw new Error('Commit failed');
    const data = await res.json();
    commitSha = data.commit?.sha || commitSha;
  }
  return commitSha;
}

