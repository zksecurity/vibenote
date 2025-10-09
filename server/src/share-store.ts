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
  gistFile: string;
  encoding: 'utf8' | 'base64';
  mediaType?: string;
};

type SharedNote = {
  id: string;
  mode: ShareMode;
  gistId: string;
  primaryFile: string;
  primaryEncoding: 'utf8' | 'base64';
  assets: ShareAsset[];
  title?: string;
  createdBy: ShareCreator;
  createdAt: string;
  expiresAt?: string;
  isDisabled: boolean;
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
            records.set(item.id, item);
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
