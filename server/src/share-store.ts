import fs from 'node:fs/promises';
import path from 'node:path';

export type ShareRecord = {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  createdByUserId: string;
  createdByLogin: string;
  createdAt: string;
  installationId: number;
};

export type ShareStoreOptions = {
  filePath: string;
};

type ShareRecordInput = Omit<ShareRecord, 'createdAt'>;

type ShareStoreData = {
  records: ShareRecord[];
};

const FILE_MODE = 0o600;

export function createShareStore(options: ShareStoreOptions): ShareStoreInstance {
  return new ShareStore(options);
}

export type ShareStoreInstance = {
  init(): Promise<void>;
  create(record: ShareRecordInput): Promise<ShareRecord>;
  get(id: string): ShareRecord | undefined;
  findActiveByNote(owner: string, repo: string, path: string): ShareRecord | undefined;
  listByRepo(owner: string, repo: string): ShareRecord[];
  revoke(id: string): Promise<boolean>;
};

class ShareStore implements ShareStoreInstance {
  #filePath: string;
  #dirPath: string;
  #shares: Map<string, ShareRecord>;
  #noteIndex: Map<string, string>;
  #persistQueue: Promise<void>;

  constructor(options: ShareStoreOptions) {
    if (!options.filePath || options.filePath.trim().length === 0) {
      throw new Error('share store requires file path');
    }
    this.#filePath = path.resolve(options.filePath);
    this.#dirPath = path.dirname(this.#filePath);
    this.#shares = new Map();
    this.#noteIndex = new Map();
    this.#persistQueue = Promise.resolve();
  }

  async init(): Promise<void> {
    await fs.mkdir(this.#dirPath, { recursive: true });
    try {
      let raw = await fs.readFile(this.#filePath, 'utf8');
      let parsed = JSON.parse(raw) as ShareStoreData | ShareRecord[];
      if (Array.isArray(parsed)) {
        this.#hydrate(parsed);
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) {
        this.#hydrate(parsed.records);
      } else {
        this.#hydrate([]);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.#persist();
      } else {
        throw error;
      }
    }
  }

  async create(record: ShareRecordInput): Promise<ShareRecord> {
    let nowIso = new Date().toISOString();
    let finalRecord: ShareRecord = {
      ...record,
      createdAt: nowIso,
    };
    this.#shares.set(finalRecord.id, finalRecord);
    this.#noteIndex.set(noteKey(finalRecord.owner, finalRecord.repo, finalRecord.path), finalRecord.id);
    await this.#persist();
    return finalRecord;
  }

  get(id: string): ShareRecord | undefined {
    return this.#shares.get(id);
  }

  findActiveByNote(owner: string, repo: string, relativePath: string): ShareRecord | undefined {
    let key = noteKey(owner, repo, relativePath);
    let id = this.#noteIndex.get(key);
    if (!id) return undefined;
    let record = this.#shares.get(id);
    return record;
  }

  listByRepo(owner: string, repo: string): ShareRecord[] {
    let results: ShareRecord[] = [];
    for (let record of this.#shares.values()) {
      if (record.owner === owner && record.repo === repo) {
        results.push(record);
      }
    }
    results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return results;
  }

  async revoke(id: string): Promise<boolean> {
    let existing = this.#shares.get(id);
    if (!existing) return false;
    this.#shares.delete(id);
    this.#noteIndex.delete(noteKey(existing.owner, existing.repo, existing.path));
    await this.#persist();
    return true;
  }

  #hydrate(records: ShareRecord[]): void {
    this.#shares.clear();
    this.#noteIndex.clear();
    for (let record of records) {
      if (!record || typeof record.id !== 'string') continue;
      this.#shares.set(record.id, record);
      this.#noteIndex.set(noteKey(record.owner, record.repo, record.path), record.id);
    }
  }

  async #persist(): Promise<void> {
    let serialized: ShareRecord[] = Array.from(this.#shares.values());
    let payload: ShareStoreData = { records: serialized };
    this.#persistQueue = this.#persistQueue.then(async () => {
      let tmpPath = `${this.#filePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: FILE_MODE });
      await fs.rename(tmpPath, this.#filePath);
    });
    await this.#persistQueue;
  }
}

function noteKey(owner: string, repo: string, filePath: string): string {
  return `${owner.toLowerCase()}::${repo.toLowerCase()}::${filePath}`;
}
