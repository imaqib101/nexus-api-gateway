import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TokenBucketRateLimiter } from "../src/rateLimiter";

describe("TokenBucketRateLimiter — unit tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("permits initial requests up to bucket capacity", () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 3, refillRatePerSec: 1 });

    const r1 = limiter.consume("client-1");
    expect(r1.allowed).toBe(true);
    expect(r1.remainingTokens).toBe(2);

    const r2 = limiter.consume("client-1");
    expect(r2.allowed).toBe(true);
    expect(r2.remainingTokens).toBe(1);

    const r3 = limiter.consume("client-1");
    expect(r3.allowed).toBe(true);
    expect(r3.remainingTokens).toBe(0);
  });

  it("blocks requests when tokens are exhausted and calculates retryAfterMs", () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillRatePerSec: 2 });

    limiter.consume("user-a");
    limiter.consume("user-a");

    const r3 = limiter.consume("user-a");
    expect(r3.allowed).toBe(false);
    expect(r3.remainingTokens).toBe(0);
    // Missing 1 token with refillRate = 2 tokens/sec -> 0.5s = 500ms
    expect(r3.retryAfterMs).toBe(500);
  });

  it("refills tokens smoothly over time", () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 5, refillRatePerSec: 2 });

    // Consume all 5
    limiter.consume("client-x", 5);
    expect(limiter.consume("client-x").allowed).toBe(false);

    // Advance 1 second -> should add 2 tokens
    vi.advanceTimersByTime(1000);

    const res = limiter.consume("client-x");
    expect(res.allowed).toBe(true);
    expect(res.remainingTokens).toBe(1);
  });

  it("never refills beyond maximum capacity", () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 3, refillRatePerSec: 5 });

    limiter.consume("client-cap"); // 2 remaining

    // Advance 10 seconds -> tokens would calculate to 2 + 50 = 52, capped at 3
    vi.advanceTimersByTime(10000);

    const stats = limiter.get("client-cap");
    expect(stats).toBeDefined();
    expect(stats?.tokens).toBe(3);
  });

  it("tracks independent buckets per key", () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillRatePerSec: 1 });

    expect(limiter.consume("ip-1").allowed).toBe(true);
    expect(limiter.consume("ip-1").allowed).toBe(false);

    // ip-2 has separate bucket
    expect(limiter.consume("ip-2").allowed).toBe(true);
    expect(limiter.consume("ip-2").allowed).toBe(false);
  });

  it("supports consuming multiple tokens at once", () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 10, refillRatePerSec: 1 });

    const r = limiter.consume("batch-job", 7);
    expect(r.allowed).toBe(true);
    expect(r.remainingTokens).toBe(3);

    const rOver = limiter.consume("batch-job", 5);
    expect(rOver.allowed).toBe(false);
    expect(rOver.remainingTokens).toBe(0);
    // Needs 5 - 3 = 2 missing tokens @ 1 token/sec = 2000ms
    expect(rOver.retryAfterMs).toBe(2000);
  });

  it("manages state via size, has, and reset methods", () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 5, refillRatePerSec: 1 });

    expect(limiter.size()).toBe(0);
    expect(limiter.has("k1")).toBe(false);
    expect(limiter.get("k1")).toBeUndefined();

    limiter.consume("k1");
    limiter.consume("k2");
    expect(limiter.size()).toBe(2);
    expect(limiter.has("k1")).toBe(true);

    // Reset single key
    limiter.reset("k1");
    expect(limiter.has("k1")).toBe(false);
    expect(limiter.size()).toBe(1);

    // Reset all
    limiter.reset();
    expect(limiter.size()).toBe(0);
    expect(limiter.has("k2")).toBe(false);
  });
});
