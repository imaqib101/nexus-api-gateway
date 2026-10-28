export interface RateLimitConfig {
  capacity: number;
  refillRatePerSec: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remainingTokens: number;
  retryAfterMs?: number;
}

export class TokenBucketRateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();

  constructor(private config: RateLimitConfig) {}

  consume(key: string, tokens = 1): RateLimitResult {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.config.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsedSec = (now - bucket.lastRefill) / 1000;
      bucket.tokens = Math.min(
        this.config.capacity,
        bucket.tokens + elapsedSec * this.config.refillRatePerSec,
      );
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return {
        allowed: true,
        remainingTokens: Math.floor(bucket.tokens),
      };
    }

    const missingTokens = tokens - bucket.tokens;
    const retryAfterMs = Math.ceil((missingTokens / this.config.refillRatePerSec) * 1000);

    return {
      allowed: false,
      remainingTokens: 0,
      retryAfterMs,
    };
  }

  reset(key?: string): void {
    if (key) {
      this.buckets.delete(key);
    } else {
      this.buckets.clear();
    }
  }
}
