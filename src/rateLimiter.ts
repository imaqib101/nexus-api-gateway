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

  /**
   * Prune idle buckets that have not been touched for longer than maxIdleMs.
   * Useful for reclaiming memory in long-running gateways.
   * Returns the count of removed buckets.
   */
  prune(maxIdleMs = 3600000): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill >= maxIdleMs) {
        this.buckets.delete(key);
        pruned++;
      }
    }
    return pruned;
  }
}

export interface SlidingWindowConfig {
  /** Size of the sliding time window in milliseconds */
  windowMs: number;
  /** Maximum number of allowed requests within the window */
  maxRequests: number;
}

export interface SlidingWindowResult {
  /** Whether the request is permitted */
  allowed: boolean;
  /** Requests remaining in the current sliding window */
  remainingRequests: number;
  /** Milliseconds until the window completely clears or resets */
  resetMs: number;
  /** Estimated milliseconds until a request slot frees up (if blocked) */
  retryAfterMs?: number;
}

export interface SlidingWindowStats {
  /** Active request timestamps within the current window */
  activeCount: number;
  /** Requests remaining before rate limit is reached */
  remainingRequests: number;
  /** Milliseconds until oldest active request slides out */
  resetMs: number;
}

export class SlidingWindowRateLimiter {
  private windows = new Map<string, number[]>();

  constructor(private config: SlidingWindowConfig) {
    if (config.windowMs <= 0) {
      throw new Error("windowMs must be greater than 0");
    }
    if (config.maxRequests <= 0) {
      throw new Error("maxRequests must be greater than 0");
    }
  }

  /**
   * Attempt to consume request slots within the sliding window for the given key.
   */
  consume(key: string, count = 1): SlidingWindowResult {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    } else {
      // Filter out timestamps outside the active window
      timestamps = timestamps.filter(ts => ts > windowStart);
      this.windows.set(key, timestamps);
    }

    if (timestamps.length + count <= this.config.maxRequests) {
      for (let i = 0; i < count; i++) {
        timestamps.push(now);
      }
      const remainingRequests = this.config.maxRequests - timestamps.length;
      const oldest = timestamps[0];
      const resetMs = oldest ? Math.max(0, oldest + this.config.windowMs - now) : this.config.windowMs;

      return {
        allowed: true,
        remainingRequests,
        resetMs
      };
    }

    // Limit exceeded
    const oldest = timestamps[0];
    const retryAfterMs = oldest ? Math.max(1, oldest + this.config.windowMs - now) : this.config.windowMs;

    return {
      allowed: false,
      remainingRequests: Math.max(0, this.config.maxRequests - timestamps.length),
      resetMs: retryAfterMs,
      retryAfterMs
    };
  }

  /**
   * Return current snapshot stats for a given key without consuming slots.
   */
  get(key: string): SlidingWindowStats | undefined {
    const timestamps = this.windows.get(key);
    if (!timestamps) return undefined;

    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const active = timestamps.filter(ts => ts > windowStart);

    const oldest = active[0];
    const resetMs = oldest ? Math.max(0, oldest + this.config.windowMs - now) : 0;

    return {
      activeCount: active.length,
      remainingRequests: Math.max(0, this.config.maxRequests - active.length),
      resetMs
    };
  }

  has(key: string): boolean {
    return this.windows.has(key);
  }

  size(): number {
    return this.windows.size;
  }

  reset(key?: string): void {
    if (key) {
      this.windows.delete(key);
    } else {
      this.windows.clear();
    }
  }

  /**
   * Prune empty or completely expired windows to reclaim memory.
   * Returns number of pruned keys.
   */
  prune(maxAgeMs?: number): number {
    const now = Date.now();
    const cutoff = now - (maxAgeMs ?? this.config.windowMs);
    let pruned = 0;

    for (const [key, timestamps] of this.windows.entries()) {
      const active = timestamps.filter(ts => ts > cutoff);
      if (active.length === 0) {
        this.windows.delete(key);
        pruned++;
      } else if (active.length < timestamps.length) {
        this.windows.set(key, active);
      }
    }

    return pruned;
  }
}
