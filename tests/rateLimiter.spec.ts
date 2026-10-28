import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucketRateLimiter } from "../src/rateLimiter";

describe("TokenBucketRateLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows requests up to capacity then rejects", () => {
    const rl = new TokenBucketRateLimiter({ capacity: 3, refillRatePerSec: 1 });
    expect(rl.consume("a").remainingTokens).toBe(2);
    expect(rl.consume("a").remainingTokens).toBe(1);
    expect(rl.consume("a").remainingTokens).toBe(0);
    const denied = rl.consume("a");
    expect(denied.allowed).toBe(false);
    expect(denied.remainingTokens).toBe(0);
    expect(denied.retryAfterMs).toBe(1000);
  });

  it("refills over time without exceeding capacity", () => {
    const rl = new TokenBucketRateLimiter({ capacity: 2, refillRatePerSec: 2 });
    rl.consume("a", 2);
    expect(rl.consume("a").allowed).toBe(false);
    vi.advanceTimersByTime(500);
    expect(rl.consume("a").allowed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(rl.consume("a", 2).allowed).toBe(true);
    expect(rl.consume("a").allowed).toBe(false);
  });

  it("tracks keys independently", () => {
    const rl = new TokenBucketRateLimiter({ capacity: 1, refillRatePerSec: 1 });
    expect(rl.consume("a").allowed).toBe(true);
    expect(rl.consume("a").allowed).toBe(false);
    expect(rl.consume("b").allowed).toBe(true);
  });

  it("supports multi-token consumption and reports retry delay", () => {
    const rl = new TokenBucketRateLimiter({ capacity: 5, refillRatePerSec: 1 });
    expect(rl.consume("a", 4).allowed).toBe(true);
    const r = rl.consume("a", 3);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(2000);
  });

  it("reset clears one key or all keys", () => {
    const rl = new TokenBucketRateLimiter({ capacity: 1, refillRatePerSec: 1 });
    rl.consume("a");
    rl.consume("b");
    rl.reset("a");
    expect(rl.consume("a").allowed).toBe(true);
    expect(rl.consume("b").allowed).toBe(false);
    rl.reset();
    expect(rl.consume("b").allowed).toBe(true);
  });
});
