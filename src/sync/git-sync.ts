// Placeholder Git sync API using GitHub REST v3.
// Implementations should authenticate via a personal token kept in localStorage (MVP)
// and operate on repo contents endpoints.

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

let remote: RemoteConfig | null = null;

export function configureRemote(cfg: RemoteConfig) {
  remote = cfg;
}

export async function pullNote(path: string): Promise<RemoteFile | null> {
  if (!remote) return null;
  // TODO: GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
  // decode base64 content -> text, capture sha
  return null;
}

export async function commitBatch(
  files: { path: string; text: string; baseSha?: string }[],
  message: string
): Promise<string | null> {
  if (!remote) return null;
  // TODO: Either multiple PUT /contents/<path> commits or a single tree+commit API usage
  // For MVP, a loop with PUT contents is acceptable.
  return null;
}

