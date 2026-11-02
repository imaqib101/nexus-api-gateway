export interface RateLimitConfig {
  /** Maximum number of tokens the bucket can hold (burst capacity) */
  capacity: number;
  /** Rate at which tokens are added back to the bucket, in tokens per second */
  refillRatePerSec: number;
}

export interface RateLimitResult {
  /** Whether the request is permitted */
  allowed: boolean;
  /** Tokens remaining in the bucket after this consume operation (floored) */
  remainingTokens: number;
  /** Estimated milliseconds until enough tokens refill to permit the requested amount */
  retryAfterMs?: number;
}

export interface BucketStats {
  /** Current fractional tokens in the bucket */
  tokens: number;
  /** Timestamp (epoch ms) of the last refill calculation */
  lastRefill: number;
}

export class TokenBucketRateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();

  constructor(private config: RateLimitConfig) {}

  /**
   * Consume tokens for a given identifier key.
   * Lazily refills tokens based on elapsed wall-clock time since last refill.
   */
  consume(key: string, tokens = 1): RateLimitResult {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.config.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsedSec = (now - bucket.lastRefill) / 1000;
      bucket.tokens = Math.min(this.config.capacity, bucket.tokens + elapsedSec * this.config.refillRatePerSec);
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return {
        allowed: true,
        remainingTokens: Math.floor(bucket.tokens)
      };
    }

    const missingTokens = tokens - bucket.tokens;
    const retryAfterMs = Math.ceil((missingTokens / this.config.refillRatePerSec) * 1000);

    return {
      allowed: false,
      remainingTokens: 0,
      retryAfterMs
    };
  }

  /**
   * Return current snapshot stats for a given key without consuming tokens.
   */
  get(key: string): BucketStats | undefined {
    const bucket = this.buckets.get(key);
    if (!bucket) return undefined;
    const now = Date.now();
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    const currentTokens = Math.min(this.config.capacity, bucket.tokens + elapsedSec * this.config.refillRatePerSec);
    return {
      tokens: currentTokens,
      lastRefill: bucket.lastRefill
    };
  }

  /**
   * Returns true if the bucket for the key exists in memory.
   */
  has(key: string): boolean {
    return this.buckets.has(key);
  }

  /**
   * Number of tracked keys.
   */
  size(): number {
    return this.buckets.size;
  }

  /**
   * Reset specific key or clear all tracked buckets.
   */
  reset(key?: string): void {
    if (key) {
      this.buckets.delete(key);
    } else {
      this.buckets.clear();
    }
  }
}
