// Test helper: minimal CacheStorage implementation for exercising Cache API flows.
export { MockCacheStorage };

type CacheBucket = Map<string, string>;

class MockCache {
  private bucket: CacheBucket;

  constructor(bucket: CacheBucket) {
    this.bucket = bucket;
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    let key = toKey(request);
    let value = this.bucket.get(key);
    if (value === undefined) return undefined;
    return new Response(value);
  }

  async matchAll(): Promise<readonly Response[]> {
    return [];
  }

  async add(): Promise<never> {
    throw new Error('MockCache does not support add');
  }

  async addAll(): Promise<never> {
    throw new Error('MockCache does not support addAll');
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    let key = toKey(request);
    let cloned = response.clone();
    let text = await cloned.text();
    this.bucket.set(key, text);
  }

  async delete(request: RequestInfo | URL, options?: CacheQueryOptions): Promise<boolean> {
    void options;
    let key = toKey(request);
    return this.bucket.delete(key);
  }

  async keys(): Promise<readonly Request[]> {
    return [];
  }
}

class MockCacheStorage implements CacheStorage {
  private buckets = new Map<string, CacheBucket>();

  async open(name: string): Promise<Cache> {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(name, bucket);
    }
    return new MockCache(bucket) as unknown as Cache;
  }

  async match(): Promise<Response | undefined> {
    return undefined;
  }

  async has(name: string): Promise<boolean> {
    return this.buckets.has(name);
  }

  async delete(name: string): Promise<boolean> {
    return this.buckets.delete(name);
  }

  async keys(): Promise<string[]> {
    return Array.from(this.buckets.keys());
  }

  peek(name: string, id: string): string | null {
    let bucket = this.buckets.get(name);
    if (!bucket) return null;
    let value = bucket.get(id);
    return value ?? null;
  }

  clear(): void {
    this.buckets.clear();
  }
}

function toKey(request: RequestInfo | URL): string {
  if (typeof request === 'string') return request;
  if (request instanceof Request) return request.url;
  return request.toString();
}
