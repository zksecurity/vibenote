// JSON-backed persistence for shared note metadata used by the sharing feature.
import fs from 'node:fs/promises';
import path from 'node:path';

export type { SharedNote, ShareAsset, ShareStoreOptions, ShareStoreInstance };
export { createShareStore };

type ShareMode = 'unlisted';

type ShareCreator = {
  userId: string;
  githubLogin: string;
};

type ShareMetadata = {
  snapshotSha?: string;
  noteBytes: number;
  assetBytes: number;
};

type ShareAsset = {
  originalPath: string;
  normalizedPath: string;
  gistFile: string;
  encoding: 'utf8' | 'base64';
  mediaType?: string;
};

type SharedNote = {
  id: string;
  mode: ShareMode;
  gistId: string;
  gistOwner: string;
  primaryFile: string;
  primaryEncoding: 'utf8' | 'base64';
  assets: ShareAsset[];
  title?: string;
  createdBy: ShareCreator;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  isDisabled: boolean;
  includeAssets: boolean;
  sourceRepo: string;
  sourcePath: string;
  metadata: ShareMetadata;
};

type ShareStoreOptions = {
  filePath: string;
};

type ShareStoreInstance = {
  init: () => Promise<void>;
  getById: (id: string) => SharedNote | undefined;
  listByUser: (userId: string) => SharedNote[];
  listAll: () => SharedNote[];
  create: (record: SharedNote) => Promise<void>;
  update: (id: string, patch: Partial<SharedNote>) => Promise<SharedNote | undefined>;
  disable: (id: string) => Promise<SharedNote | undefined>;
  delete: (id: string) => Promise<boolean>;
  replaceAll: (records: SharedNote[]) => Promise<void>;
};

const FILE_MODE = 0o600;

function createShareStore(options: ShareStoreOptions): ShareStoreInstance {
  if (!options.filePath || options.filePath.trim().length === 0) {
    throw new Error('share store requires file path');
  }
  let resolvedPath = path.resolve(options.filePath);
  let dir = path.dirname(resolvedPath);
  let records = new Map<string, SharedNote>();
  let persistQueue: Promise<void> = Promise.resolve();

  async function init() {
    await fs.mkdir(dir, { recursive: true });
    try {
      let raw = await fs.readFile(resolvedPath, 'utf8');
      let parsed = JSON.parse(raw) as SharedNote[];
      if (Array.isArray(parsed)) {
        for (let item of parsed) {
      if (item && typeof item.id === 'string' && item.id.trim().length > 0) {
        let normalized = upgradeSharedNote(item as Partial<SharedNote>);
        if (normalized) {
          records.set(normalized.id, normalized);
        }
      }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await persist();
      } else {
        throw error;
      }
    }
  }

  function getById(id: string): SharedNote | undefined {
    let record = records.get(id);
    if (!record) {
      return undefined;
    }
    return record;
  }

  function listByUser(userId: string): SharedNote[] {
    let result: SharedNote[] = [];
    for (let record of records.values()) {
      if (record.createdBy.userId === userId) {
        result.push(record);
      }
    }
    return result;
  }

  function listAll(): SharedNote[] {
    return Array.from(records.values());
  }

  async function create(record: SharedNote) {
    if (records.has(record.id)) {
      throw new Error('share already exists');
    }
    records.set(record.id, record);
    await persist();
  }

  async function update(id: string, patch: Partial<SharedNote>) {
    let existing = records.get(id);
    if (!existing) {
      return undefined;
    }
    let updated: SharedNote = {
      ...existing,
      ...patch,
      metadata: {
        ...existing.metadata,
        ...(patch.metadata ?? {}),
      },
    };
    records.set(id, updated);
    await persist();
    return updated;
  }

  async function disable(id: string) {
    return await update(id, { isDisabled: true });
  }

  async function remove(id: string) {
    let deleted = records.delete(id);
    if (!deleted) {
      return false;
    }
    await persist();
    return true;
  }

  async function replaceAll(entries: SharedNote[]) {
    records.clear();
    for (let entry of entries) {
      records.set(entry.id, entry);
    }
    await persist();
  }

  async function persist() {
    // Serialise writes through a queue so concurrent mutations never corrupt the file.
    persistQueue = persistQueue.then(async () => {
      let tmpPath = `${resolvedPath}.tmp`;
      let payload = JSON.stringify(Array.from(records.values()), null, 2);
      await fs.writeFile(tmpPath, payload, { mode: FILE_MODE });
      await fs.rename(tmpPath, resolvedPath);
    });
    await persistQueue;
  }

  return {
    init,
    getById,
    listByUser,
    listAll,
    create,
    update,
    disable,
    delete: remove,
    replaceAll,
  };
}

function upgradeSharedNote(record: Partial<SharedNote>): SharedNote | null {
  let id = typeof record.id === 'string' ? record.id : null;
  let gistId = typeof record.gistId === 'string' ? record.gistId : null;
  let primaryFile = typeof record.primaryFile === 'string' ? record.primaryFile : null;
  if (!id || !gistId || !primaryFile) {
    return null;
  }
  let createdByUserId =
    typeof record.createdBy?.userId === 'string' ? record.createdBy.userId : record.createdBy?.userId
      ? String(record.createdBy.userId)
      : null;
  let createdByLogin =
    typeof record.createdBy?.githubLogin === 'string'
      ? record.createdBy.githubLogin
      : record.createdBy?.githubLogin
      ? String(record.createdBy.githubLogin)
      : null;
  if (!createdByUserId || !createdByLogin) {
    return null;
  }
  let mode: ShareMode = record.mode === 'unlisted' ? 'unlisted' : 'unlisted';
  let primaryEncoding: 'utf8' | 'base64' =
    record.primaryEncoding === 'base64' ? 'base64' : 'utf8';
  let assets = Array.isArray(record.assets)
    ? record.assets
        .map((asset) => upgradeShareAsset(asset as Partial<ShareAsset>))
        .filter((value): value is ShareAsset => value !== null)
    : [];
  let createdAt =
    typeof record.createdAt === 'string' && record.createdAt.length > 0
      ? record.createdAt
      : new Date().toISOString();
  let updatedAt =
    typeof record.updatedAt === 'string' && record.updatedAt.length > 0
      ? record.updatedAt
      : createdAt;
  let expiresAt =
    typeof record.expiresAt === 'string' && record.expiresAt.length > 0 ? record.expiresAt : undefined;
  let isDisabled = record.isDisabled === true;
  let includeAssets = record.includeAssets !== false;
  let sourceRepo = typeof record.sourceRepo === 'string' ? record.sourceRepo : '';
  let sourcePath = typeof record.sourcePath === 'string' ? record.sourcePath : '';
  let gistOwner =
    typeof record.gistOwner === 'string' && record.gistOwner.length > 0
      ? record.gistOwner
      : createdByLogin;
  let metadata: ShareMetadata = {
    noteBytes: record.metadata?.noteBytes ?? 0,
    assetBytes: record.metadata?.assetBytes ?? 0,
    snapshotSha: record.metadata?.snapshotSha,
  };
  return {
    id,
    mode,
    gistId,
    gistOwner,
    primaryFile,
    primaryEncoding,
    assets,
    title: typeof record.title === 'string' ? record.title : undefined,
    createdBy: { userId: createdByUserId, githubLogin: createdByLogin },
    createdAt,
    updatedAt,
    expiresAt,
    isDisabled,
    includeAssets,
    sourceRepo,
    sourcePath,
    metadata,
  };
}

function upgradeShareAsset(asset: Partial<ShareAsset>): ShareAsset | null {
  let originalPath = typeof asset.originalPath === 'string' ? asset.originalPath : undefined;
  if (!originalPath) return null;
  let normalizedPath =
    typeof asset.normalizedPath === 'string' && asset.normalizedPath.length > 0
      ? asset.normalizedPath
      : normalizeAssetPath(originalPath);
  let gistFile = typeof asset.gistFile === 'string' ? asset.gistFile : undefined;
  if (!gistFile) return null;
  let encoding: 'utf8' | 'base64' = asset.encoding === 'base64' ? 'base64' : 'utf8';
  return {
    originalPath,
    normalizedPath,
    gistFile,
    encoding,
    mediaType: typeof asset.mediaType === 'string' ? asset.mediaType : undefined,
  };
}

function normalizeAssetPath(value: string): string {
  try {
    let addr = value.split('?')[0]?.split('#')[0] ?? value;
    return addr.replace(/^\.\//, '');
  } catch {
    return value;
  }
}
