import crypto from "node:crypto";

export interface IdempotencyRecord {
  key: string;
  fingerprint: string;
  status: "in-progress" | "completed";
  statusCode?: number;
  headers?: Record<string, string | string[] | undefined>;
  body?: Buffer;
  createdAt: number;
  expiresAt: number;
}

export interface IdempotencyStoreOptions {
  /** Time-to-live for completed records in milliseconds (default: 300,000ms = 5 minutes) */
  ttlMs?: number;
  /** Maximum number of records before triggering prune or LRU eviction */
  maxRecords?: number;
}

export type AcquireResult =
  | { state: "acquired" }
  | { state: "in-progress" }
  | { state: "mismatch"; existingFingerprint: string }
  | { state: "cached"; record: IdempotencyRecord };

export class IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();
  readonly ttlMs: number;
  readonly maxRecords: number;

  constructor(options: IdempotencyStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 300_000;
    this.maxRecords = options.maxRecords ?? 10_000;
  }

  /**
   * Generates a deterministic SHA-256 fingerprint for request payload verification.
   */
  static generateFingerprint(method: string, path: string, body?: Buffer | string): string {
    const hash = crypto.createHash("sha256");
    hash.update(method.toUpperCase());
    hash.update(":");
    hash.update(path);
    hash.update(":");
    if (body) {
      if (typeof body === "string") {
        hash.update(body);
      } else {
        hash.update(body);
      }
    }
    return hash.digest("hex");
  }

  /**
   * Attempts to acquire an idempotency lock for the given key and fingerprint.
   */
  acquire(key: string, fingerprint: string): AcquireResult {
    const now = Date.now();
    const existing = this.records.get(key);

    if (existing) {
      // Check if expired
      if (now >= existing.expiresAt) {
        this.records.delete(key);
      } else {
        if (existing.fingerprint !== fingerprint) {
          return { state: "mismatch", existingFingerprint: existing.fingerprint };
        }
        if (existing.status === "in-progress") {
          return { state: "in-progress" };
        }
        return { state: "cached", record: existing };
      }
    }

    if (this.records.size >= this.maxRecords) {
      this.prune();
    }

    const record: IdempotencyRecord = {
      key,
      fingerprint,
      status: "in-progress",
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };

    this.records.set(key, record);
    return { state: "acquired" };
  }

  /**
   * Marks a pending idempotency lock as completed and caches the upstream response.
   */
  complete(
    key: string,
    statusCode: number,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer | string = Buffer.alloc(0)
  ): void {
    const record = this.records.get(key);
    if (!record) return;

    record.status = "completed";
    record.statusCode = statusCode;
    record.headers = headers;
    record.body = typeof body === "string" ? Buffer.from(body) : body;
    record.expiresAt = Date.now() + this.ttlMs;
  }

  /**
   * Release or cancel a pending lock (e.g. on upstream network failure or client disconnect).
   */
  release(key: string): boolean {
    const record = this.records.get(key);
    if (record && record.status === "in-progress") {
      this.records.delete(key);
      return true;
    }
    return false;
  }

  /**
   * Direct lookup of a key.
   */
  get(key: string): IdempotencyRecord | undefined {
    const now = Date.now();
    const record = this.records.get(key);
    if (record && now >= record.expiresAt) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  /**
   * Delete a specific key.
   */
  delete(key: string): boolean {
    return this.records.delete(key);
  }

  /**
   * Returns current active record count.
   */
  size(): number {
    return this.records.size;
  }

  /**
   * Clear all records.
   */
  clear(): void {
    this.records.clear();
  }

  /**
   * Remove expired records.
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, record] of this.records.entries()) {
      if (now >= record.expiresAt) {
        this.records.delete(key);
        pruned++;
      }
    }
    return pruned;
  }
}
