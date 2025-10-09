// Lightweight helpers around the GitHub Gist REST API used for per-user sharing.
export type { GistFileInput, GistFilePatch, CreatedGist, UpdatedGist, GistFileData };
export { createSecretGist, updateSecretGist, downloadGistFile };

type GistFileInput = {
  filename: string;
  content: string;
};

type GistFilePatch = {
  filename: string;
  content?: string;
  delete?: boolean;
};

type CreatedGist = {
  id: string;
  ownerLogin: string;
  htmlUrl?: string;
  revision?: string;
};

type UpdatedGist = {
  revision?: string;
};

type GistFileData = {
  bytes: Uint8Array;
  mediaType?: string;
};

async function createSecretGist(token: string, files: GistFileInput[], description: string): Promise<CreatedGist> {
  if (files.length === 0) {
    throw new Error('gist requires at least one file');
  }
  let body: Record<string, unknown> = {
    description,
    public: false,
    files: {},
  };
  let filesPayload = body.files as Record<string, { content: string }>;
  for (let file of files) {
    filesPayload[file.filename] = { content: file.content };
  }
  let res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`gist create failed (${res.status})`);
  }
  let json = (await res.json()) as any;
  let id = typeof json?.id === 'string' ? json.id : undefined;
  if (!id) throw new Error('gist create missing id');
  let ownerLogin =
    typeof json?.owner?.login === 'string' && json.owner.login.length > 0 ? json.owner.login : undefined;
  let revision = typeof json?.history?.[0]?.version === 'string' ? json.history[0].version : undefined;
  let htmlUrl = typeof json?.html_url === 'string' ? json.html_url : undefined;
  return {
    id,
    ownerLogin: ownerLogin ?? '',
    htmlUrl,
    revision,
  };
}

async function updateSecretGist(token: string, gistId: string, files: GistFilePatch[], description?: string): Promise<UpdatedGist> {
  let filesPayload: Record<string, { content?: string | null }> = {};
  for (let file of files) {
    if (file.delete) {
      filesPayload[file.filename] = { content: null };
    } else if (typeof file.content === 'string') {
      filesPayload[file.filename] = { content: file.content };
    }
  }
  let body: Record<string, unknown> = { files: filesPayload };
  if (typeof description === 'string') {
    body.description = description;
  }
  let res = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`gist update failed (${res.status})`);
  }
  let json = (await res.json()) as any;
  let revision = typeof json?.history?.[0]?.version === 'string' ? json.history[0].version : undefined;
  return { revision };
}

async function downloadGistFile(ownerLogin: string, gistId: string, filename: string): Promise<GistFileData> {
  let rawUrl = buildRawUrl(ownerLogin, gistId, filename);
  let res = await fetch(rawUrl, {
    headers: { Accept: 'application/vnd.github.v3.raw' },
  });
  if (!res.ok) {
    throw new Error(`gist raw fetch failed (${res.status})`);
  }
  let bytes = new Uint8Array(await res.arrayBuffer());
  let mediaType = res.headers.get('content-type') ?? undefined;
  return { bytes, mediaType: mediaType ?? undefined };
}

function buildRawUrl(owner: string, gistId: string, filename: string): string {
  let encodedOwner = encodeURIComponent(owner);
  let encodedId = encodeURIComponent(gistId);
  let encodedFile = filename
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://gist.githubusercontent.com/${encodedOwner}/${encodedId}/raw/${encodedFile}`;
}
