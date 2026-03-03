import fs from 'node:fs/promises';
import path from 'node:path';

export type RepoIdRecord = {
  repoId: string;
  owner: string;
  repo: string;
  registeredAt: string;
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
  // Reverse lookup: find the registered repoId for a given owner/repo.
  getByRepo(owner: string, repo: string): RepoIdRecord | undefined;
  set(record: RepoIdRecord): Promise<void>;
};

class RepoIdStore implements RepoIdStoreInstance {
  #filePath: string;
  #dirPath: string;
  #records: Map<string, RepoIdRecord>;
  // Reverse map: "<owner>/<repo>" → repoId, for one-repoId-per-repo enforcement.
  #repos: Map<string, string>;
  #persistQueue: Promise<void>;

  constructor(options: RepoIdStoreOptions) {
    if (!options.filePath || options.filePath.trim().length === 0) {
      throw new Error('repo id store requires file path');
    }
    this.#filePath = path.resolve(options.filePath);
    this.#dirPath = path.dirname(this.#filePath);
    this.#records = new Map();
    this.#repos = new Map();
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
    return this.#records.get(repoId);
  }

  getByRepo(owner: string, repo: string): RepoIdRecord | undefined {
    const repoId = this.#repos.get(`${owner}/${repo}`);
    return repoId !== undefined ? this.#records.get(repoId) : undefined;
  }

  async set(record: RepoIdRecord): Promise<void> {
    this.#records.set(record.repoId, record);
    this.#repos.set(`${record.owner}/${record.repo}`, record.repoId);
    await this.#persist();
  }

  #hydrate(records: RepoIdRecord[]): void {
    this.#records.clear();
    this.#repos.clear();
    for (let record of records) {
      if (!record || typeof record.repoId !== 'string') continue;
      this.#records.set(record.repoId, record);
      this.#repos.set(`${record.owner}/${record.repo}`, record.repoId);
    }
  }

  async #persist(): Promise<void> {
    let serialized: RepoIdRecord[] = Array.from(this.#records.values());
    let payload: RepoIdStoreData = { records: serialized };
    this.#persistQueue = this.#persistQueue.then(async () => {
      let tmpPath = `${this.#filePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: FILE_MODE });
      await fs.rename(tmpPath, this.#filePath);
    });
    await this.#persistQueue;
  }
}
