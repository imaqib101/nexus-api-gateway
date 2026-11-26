export interface CachedResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  storedAt: number;
  expiresAt: number;
}

export interface ResponseCacheOptions {
  /** Maximum number of entries retained in the LRU cache. Defaults to 500. */
  maxEntries?: number;
  /** Default time-to-live in milliseconds when no Cache-Control max-age is present. Defaults to 30_000. */
  defaultTtlMs?: number;
  /** Maximum response body size in bytes eligible for caching. Defaults to 1 MiB. */
  maxBodyBytes?: number;
  /** HTTP status codes eligible for caching. Defaults to [200]. */
  cacheableStatuses?: number[];
  /** Respect Cache-Control directives (no-store, no-cache, private, max-age). Defaults to true. */
  respectCacheControl?: boolean;
  /** Injectable clock for deterministic testing. */
  now?: () => number;
}

export interface CacheLookupResult {
  hit: boolean;
  entry?: CachedResponse;
  ageSeconds?: number;
}

export interface CacheStats {
  size: number;
  maxEntries: number;
  hits: number;
  misses: number;
  evictions: number;
  hitRate: number;
}

export class ResponseCache {
  private readonly store = new Map<string, CachedResponse>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly maxBodyBytes: number;
  private readonly cacheableStatuses: Set<number>;
  private readonly respectCacheControl: boolean;
  private readonly now: () => number;

  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: ResponseCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 500);
    this.defaultTtlMs = Math.max(0, options.defaultTtlMs ?? 30_000);
    this.maxBodyBytes = Math.max(1, options.maxBodyBytes ?? 1024 * 1024);
    this.cacheableStatuses = new Set(options.cacheableStatuses ?? [200]);
    this.respectCacheControl = options.respectCacheControl ?? true;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Build a deterministic cache key from HTTP method, URL path/query, and optional vary headers.
   */
  static buildKey(
    method: string,
    url: string,
    varyHeaders?: Record<string, string | undefined>
  ): string {
    const normalizedMethod = method.toUpperCase();
    if (!varyHeaders || Object.keys(varyHeaders).length === 0) {
      return `${normalizedMethod}:${url}`;
    }

    const varyPart = Object.keys(varyHeaders)
      .sort()
      .map((k) => `${k.toLowerCase()}=${varyHeaders[k] ?? ""}`)
      .join("&");

    return `${normalizedMethod}:${url}|${varyPart}`;
  }

  /**
   * Parse Cache-Control header to determine cacheability and effective TTL in ms.
   */
  resolveTtlMs(cacheControlHeader?: string | string[]): number | null {
    if (!this.respectCacheControl || !cacheControlHeader) {
      return this.defaultTtlMs;
    }

    const raw = Array.isArray(cacheControlHeader)
      ? cacheControlHeader.join(",")
      : cacheControlHeader;
    const directives = raw
      .toLowerCase()
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);

    if (
      directives.includes("no-store") ||
      directives.includes("no-cache") ||
      directives.includes("private")
    ) {
      return null;
    }

    for (const directive of directives) {
      if (directive.startsWith("max-age=")) {
        const seconds = Number(directive.slice("max-age=".length));
        if (Number.isFinite(seconds) && seconds >= 0) {
          return seconds === 0 ? null : seconds * 1000;
        }
      }
    }

    return this.defaultTtlMs;
  }

  /**
   * Look up a cached response by key. Expired entries are evicted on access.
   */
  get(key: string): CacheLookupResult {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return { hit: false };
    }

    const currentTime = this.now();
    if (currentTime >= entry.expiresAt) {
      this.store.delete(key);
      this.misses += 1;
      return { hit: false };
    }

    // Refresh LRU recency by reinserting at the tail of the Map
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits += 1;

    return {
      hit: true,
      entry,
      ageSeconds: Math.max(0, Math.floor((currentTime - entry.storedAt) / 1000)),
    };
  }

  /**
   * Store a response if it meets status, size, and Cache-Control eligibility.
   * Returns true if stored, false if skipped.
   */
  set(
    key: string,
    response: {
      statusCode: number;
      headers: Record<string, string | string[]>;
      body: Buffer;
    },
    ttlOverrideMs?: number
  ): boolean {
    if (!this.cacheableStatuses.has(response.statusCode)) {
      return false;
    }
    if (response.body.byteLength > this.maxBodyBytes) {
      return false;
    }

    const ttlMs =
      ttlOverrideMs !== undefined
        ? ttlOverrideMs
        : this.resolveTtlMs(response.headers["cache-control"]);

    if (ttlMs === null || ttlMs <= 0) {
      return false;
    }

    const currentTime = this.now();

    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
        this.evictions += 1;
      }
    }

    this.store.set(key, {
      statusCode: response.statusCode,
      headers: { ...response.headers },
      body: Buffer.from(response.body),
      storedAt: currentTime,
      expiresAt: currentTime + ttlMs,
    });

    return true;
  }

  invalidate(key: string): boolean {
    return this.store.delete(key);
  }

  invalidateByPrefix(prefix: string): number {
    let removed = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.store.clear();
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }
}
