import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export type SessionRecord = {
  id: string;
  userId: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  refreshTokenCiphertext: string;
  refreshExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  lastAccessAt: string;
};

export type SessionStoreOptions = {
  filePath: string;
  encryptionKey: string;
};

const FILE_MODE = 0o600;

class SessionStore {
  #sessions: Map<string, SessionRecord>;
  #filePath: string;
  #dirPath: string;
  #key: Buffer;
  #persistQueue: Promise<void>;

  constructor(options: SessionStoreOptions) {
    if (!options.filePath || options.filePath.trim().length === 0) {
      throw new Error('session store requires file path');
    }
    if (!options.encryptionKey || options.encryptionKey.trim().length === 0) {
      throw new Error('session store requires encryption key');
    }
    let keyBuf = decodeKey(options.encryptionKey);
    if (keyBuf.length !== 32) {
      throw new Error('SESSION_ENCRYPTION_KEY must decode to 32 bytes (use base64 or hex)');
    }
    this.#sessions = new Map();
    this.#filePath = path.resolve(options.filePath);
    this.#dirPath = path.dirname(this.#filePath);
    this.#key = keyBuf;
    this.#persistQueue = Promise.resolve();
  }

  async init(): Promise<void> {
    await fs.mkdir(this.#dirPath, { recursive: true });
    try {
      let data = await fs.readFile(this.#filePath, 'utf8');
      let parsed = JSON.parse(data) as SessionRecord[];
      if (Array.isArray(parsed)) {
        for (let record of parsed) {
          if (record && record.id) {
            this.#sessions.set(record.id, record);
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.#persist();
      } else {
        throw error;
      }
    }
    this.pruneExpired();
  }

  listAll(): SessionRecord[] {
    return Array.from(this.#sessions.values());
  }

  get(id: string): SessionRecord | undefined {
    let record = this.#sessions.get(id);
    if (!record) {
      return undefined;
    }
    let expiresAt = Date.parse(record.refreshExpiresAt);
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
      return undefined;
    }
    return record;
  }

  async create(record: Omit<SessionRecord, 'createdAt' | 'updatedAt' | 'lastAccessAt'>): Promise<SessionRecord> {
    let nowIso = new Date().toISOString();
    let finalRecord: SessionRecord = {
      ...record,
      createdAt: nowIso,
      updatedAt: nowIso,
      lastAccessAt: nowIso,
    };
    this.#sessions.set(finalRecord.id, finalRecord);
    await this.#persist();
    return finalRecord;
  }

  async update(id: string, patch: Partial<SessionRecord>): Promise<SessionRecord | undefined> {
    let existing = this.#sessions.get(id);
    if (!existing) {
      return undefined;
    }
    let merged: SessionRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.#sessions.set(id, merged);
    await this.#persist();
    return merged;
  }

  async touch(id: string): Promise<void> {
    let existing = this.#sessions.get(id);
    if (!existing) {
      return;
    }
    let next: SessionRecord = {
      ...existing,
      lastAccessAt: new Date().toISOString(),
    };
    this.#sessions.set(id, next);
    await this.#persist();
  }

  async delete(id: string): Promise<void> {
    if (!this.#sessions.delete(id)) {
      return;
    }
    await this.#persist();
  }

  async deleteByUser(userId: string): Promise<void> {
    let removed = false;
    for (let record of this.#sessions.values()) {
      if (record.userId === userId) {
        this.#sessions.delete(record.id);
        removed = true;
      }
    }
    if (removed) {
      await this.#persist();
    }
  }

  pruneExpired(): void {
    let removed = false;
    let now = Date.now();
    for (let record of this.#sessions.values()) {
      let expiresAt = Date.parse(record.refreshExpiresAt);
      if (Number.isNaN(expiresAt) || expiresAt <= now) {
        this.#sessions.delete(record.id);
        removed = true;
      }
    }
    if (removed) {
      void this.#persist();
    }
  }

  encryptRefreshToken(token: string): string {
    let iv = crypto.randomBytes(12);
    let cipher = crypto.createCipheriv('aes-256-gcm', this.#key, iv);
    let ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    let tag = cipher.getAuthTag();
    return [iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join(':');
  }

  decryptRefreshToken(payload: string): string {
    let parts = payload.split(':');
    if (parts.length !== 3) {
      throw new Error('invalid refresh token payload');
    }
    let ivB64 = parts[0];
    let dataB64 = parts[1];
    let tagB64 = parts[2];
    if (!ivB64 || !dataB64 || !tagB64) {
      throw new Error('invalid refresh token payload');
    }
    let iv = Buffer.from(ivB64, 'base64');
    let data = Buffer.from(dataB64, 'base64');
    let tag = Buffer.from(tagB64, 'base64');
    let decipher = crypto.createDecipheriv('aes-256-gcm', this.#key, iv);
    decipher.setAuthTag(tag);
    let plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return plaintext;
  }

  async #persist(): Promise<void> {
    this.#persistQueue = this.#persistQueue.then(async () => {
      let tmpPath = `${this.#filePath}.tmp`;
      let payload = JSON.stringify(Array.from(this.#sessions.values()), null, 2);
      await fs.writeFile(tmpPath, payload, { mode: FILE_MODE });
      await fs.rename(tmpPath, this.#filePath);
    });
    await this.#persistQueue;
  }
}

function decodeKey(raw: string): Buffer {
  let trimmed = raw.trim();
  let buf = Buffer.from([]);
  if (/^[A-Fa-f0-9]+$/.test(trimmed) && trimmed.length === 64) {
    buf = Buffer.from(trimmed, 'hex');
  } else {
    try {
      buf = Buffer.from(trimmed, 'base64');
    } catch {
      buf = Buffer.from(trimmed, 'utf8');
    }
  }
  return buf;
}

let singleton: SessionStore | null = null;

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  if (singleton) {
    return singleton;
  }
  singleton = new SessionStore(options);
  return singleton;
}

export function resetSessionStoreForTests(): void {
  singleton = null;
}

export type SessionStoreInstance = ReturnType<typeof createSessionStore>;
