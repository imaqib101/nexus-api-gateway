import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SlidingWindowRateLimiter, TokenBucketRateLimiter } from "../src/rateLimiter";

describe("TokenBucketRateLimiter — prune() tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prunes idle buckets exceeding maxIdleMs", () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 5, refillRatePerSec: 1 });
    limiter.consume("active-client");
    limiter.consume("stale-client");

    expect(limiter.size()).toBe(2);

    // Advance time by 2 hours
    vi.advanceTimersByTime(2 * 3600 * 1000);

    // Refresh active-client
    limiter.consume("active-client");

    // Prune buckets older than 1 hour
    const pruned = limiter.prune(3600 * 1000);
    expect(pruned).toBe(1);
    expect(limiter.size()).toBe(1);
    expect(limiter.has("active-client")).toBe(true);
    expect(limiter.has("stale-client")).toBe(false);
  });
});

describe("SlidingWindowRateLimiter — unit tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates configuration parameters", () => {
    expect(() => new SlidingWindowRateLimiter({ windowMs: 0, maxRequests: 10 })).toThrow(
      "windowMs must be greater than 0"
    );
    expect(() => new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 0 })).toThrow(
      "maxRequests must be greater than 0"
    );
  });

  it("permits requests within sliding window and tracks remaining count", () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 3 });

    const r1 = limiter.consume("user-1");
    expect(r1.allowed).toBe(true);
    expect(r1.remainingRequests).toBe(2);

    const r2 = limiter.consume("user-1");
    expect(r2.allowed).toBe(true);
    expect(r2.remainingRequests).toBe(1);

    const r3 = limiter.consume("user-1");
    expect(r3.allowed).toBe(true);
    expect(r3.remainingRequests).toBe(0);

    const r4 = limiter.consume("user-1");
    expect(r4.allowed).toBe(false);
    expect(r4.remainingRequests).toBe(0);
    expect(r4.retryAfterMs).toBeGreaterThan(0);
  });

  it("slides window forward and restores capacity as oldest requests expire", () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 2 });

    limiter.consume("client-a"); // at t=0
    vi.advanceTimersByTime(300);
    limiter.consume("client-a"); // at t=300

    // Exhausted at t=300
    expect(limiter.consume("client-a").allowed).toBe(false);

    // Advance 701ms -> t=1001ms. The request from t=0 has expired!
    vi.advanceTimersByTime(701);

    const res = limiter.consume("client-a");
    expect(res.allowed).toBe(true);
    expect(res.remainingRequests).toBe(0); // now has requests from t=300 and t=1001
  });

  it("supports consuming multiple request slots in a single call", () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 5000, maxRequests: 10 });

    const batch = limiter.consume("api-batch", 8);
    expect(batch.allowed).toBe(true);
    expect(batch.remainingRequests).toBe(2);

    const over = limiter.consume("api-batch", 3);
    expect(over.allowed).toBe(false);
    expect(over.remainingRequests).toBe(2);
    expect(over.retryAfterMs).toBeGreaterThan(0);
  });

  it("provides accurate get() snapshot stats", () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 2000, maxRequests: 5 });

    expect(limiter.get("non-existent")).toBeUndefined();

    limiter.consume("key-stat", 2);
    const stats = limiter.get("key-stat");

    expect(stats).toBeDefined();
    expect(stats?.activeCount).toBe(2);
    expect(stats?.remainingRequests).toBe(3);
    expect(stats?.resetMs).toBeGreaterThan(0);
  });

  it("resets single key or all keys cleanly", () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 5 });

    limiter.consume("k1");
    limiter.consume("k2");
    expect(limiter.size()).toBe(2);

    limiter.reset("k1");
    expect(limiter.has("k1")).toBe(false);
    expect(limiter.has("k2")).toBe(true);

    limiter.reset();
    expect(limiter.size()).toBe(0);
  });

  it("prunes expired windows to reclaim memory", () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 5 });

    limiter.consume("fresh-key");
    limiter.consume("stale-key");

    vi.advanceTimersByTime(2000);
    limiter.consume("fresh-key");

    const pruned = limiter.prune();
    expect(pruned).toBe(1);
    expect(limiter.has("fresh-key")).toBe(true);
    expect(limiter.has("stale-key")).toBe(false);
  });
});
