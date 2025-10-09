export type { GistFileInput, CreatedGist, GistFileData };
export { createSecretGist, fetchGistFile };

type GistFileInput = {
  filename: string;
  content: string;
};

type CreatedGist = {
  id: string;
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
  if (!id) {
    throw new Error('gist create missing id');
  }
  return { id };
}

async function fetchGistFile(token: string, gistId: string, filename: string): Promise<GistFileData> {
  let metaRes = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!metaRes.ok) {
    throw new Error(`gist fetch failed (${metaRes.status})`);
  }
  let meta = (await metaRes.json()) as any;
  let files = meta?.files;
  if (typeof files !== 'object' || files === null) {
    throw new Error('gist missing files');
  }
  let file = files[filename];
  if (!file) {
    throw new Error('gist file not found');
  }
  let mediaType = typeof file?.type === 'string' ? String(file.type) : undefined;
  if (file.truncated === false && typeof file.content === 'string') {
    let content = file.content as string;
    return { bytes: new TextEncoder().encode(content), mediaType };
  }
  let rawUrl = typeof file.raw_url === 'string' ? file.raw_url : undefined;
  if (!rawUrl) {
    throw new Error('gist raw url unavailable');
  }
  let rawRes = await fetch(rawUrl, {
    headers: {
      Accept: 'application/vnd.github.v3.raw',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!rawRes.ok) {
    throw new Error(`gist raw fetch failed (${rawRes.status})`);
  }
  let arrayBuffer = await rawRes.arrayBuffer();
  let fetchedType = rawRes.headers.get('content-type') ?? undefined;
  return { bytes: new Uint8Array(arrayBuffer), mediaType: fetchedType ?? mediaType ?? undefined };
}
