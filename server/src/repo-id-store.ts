import fs from 'node:fs/promises';
import path from 'node:path';

export type RepoIdRecord = {
  repoId: string;
  owner: string;
  repo: string;
  registeredAt: string;
  registeredBy: string;
};

export type RepoIdStoreOptions = {
  filePath: string;
};

type RepoIdStoreData = {
  records: RepoIdRecord[];
};

const FILE_MODE = 0o600;

export function createRepoIdStore(options: RepoIdStoreOptions): RepoIdStoreInstance {
  return new RepoIdStore(options);
}

export type RepoIdStoreInstance = {
  init(): Promise<void>;
  get(repoId: string): RepoIdRecord | undefined;
  set(record: RepoIdRecord): Promise<void>;
};

class RepoIdStore implements RepoIdStoreInstance {
  #filePath: string;
  #dirPath: string;
  #keys: Map<string, RepoIdRecord>;
  #persistQueue: Promise<void>;

  constructor(options: RepoIdStoreOptions) {
    if (!options.filePath || options.filePath.trim().length === 0) {
      throw new Error('repo id store requires file path');
    }
    this.#filePath = path.resolve(options.filePath);
    this.#dirPath = path.dirname(this.#filePath);
    this.#keys = new Map();
    this.#persistQueue = Promise.resolve();
  }

  async init(): Promise<void> {
    await fs.mkdir(this.#dirPath, { recursive: true });
    try {
      let raw = await fs.readFile(this.#filePath, 'utf8');
      let parsed = JSON.parse(raw) as RepoIdStoreData | RepoIdRecord[];
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

  get(repoId: string): RepoIdRecord | undefined {
    return this.#keys.get(repoId);
  }

  async set(record: RepoIdRecord): Promise<void> {
    this.#keys.set(record.repoId, record);
    await this.#persist();
  }

  #hydrate(records: RepoIdRecord[]): void {
    this.#keys.clear();
    for (let record of records) {
      if (!record || typeof record.repoId !== 'string') continue;
      this.#keys.set(record.repoId, record);
    }
  }

  async #persist(): Promise<void> {
    let serialized: RepoIdRecord[] = Array.from(this.#keys.values());
    let payload: RepoIdStoreData = { records: serialized };
    this.#persistQueue = this.#persistQueue.then(async () => {
      let tmpPath = `${this.#filePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: FILE_MODE });
      await fs.rename(tmpPath, this.#filePath);
    });
    await this.#persistQueue;
  }
}
