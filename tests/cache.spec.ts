import { describe, it, expect } from "vitest";
import { ResponseCache } from "../src/cache";

describe("ResponseCache", () => {
  it("builds deterministic keys with sorted vary headers", () => {
    const k1 = ResponseCache.buildKey("get", "/v1/items?page=1", {
      "Accept-Encoding": "gzip",
      Authorization: "Bearer abc",
    });
    const k2 = ResponseCache.buildKey("GET", "/v1/items?page=1", {
      Authorization: "Bearer abc",
      "Accept-Encoding": "gzip",
    });

    expect(k1).toBe(k2);
    expect(k1).toBe("GET:/v1/items?page=1|accept-encoding=gzip&authorization=Bearer abc");
  });

  it("stores and retrieves responses within TTL and expires them afterward", () => {
    let clock = 1_000;
    const cache = new ResponseCache({
      defaultTtlMs: 5_000,
      now: () => clock,
    });

    const stored = cache.set("GET:/health", {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true}'),
    });
    expect(stored).toBe(true);

    clock = 3_500;
    const hit = cache.get("GET:/health");
    expect(hit.hit).toBe(true);
    expect(hit.ageSeconds).toBe(2);
    expect(hit.entry?.body.toString()).toBe('{"ok":true}');

    clock = 6_000;
    const expired = cache.get("GET:/health");
    expect(expired.hit).toBe(false);
    expect(cache.stats().size).toBe(0);
  });

  it("evicts least recently used entry when maxEntries is reached", () => {
    const cache = new ResponseCache({ maxEntries: 2, defaultTtlMs: 10_000 });
    const ok = (body: string) => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from(body),
    });

    cache.set("GET:/a", ok("a"));
    cache.set("GET:/b", ok("b"));
    // Touch /a so /b becomes the LRU entry
    expect(cache.get("GET:/a").hit).toBe(true);

    cache.set("GET:/c", ok("c"));

    expect(cache.get("GET:/b").hit).toBe(false);
    expect(cache.get("GET:/a").hit).toBe(true);
    expect(cache.get("GET:/c").hit).toBe(true);
    expect(cache.stats().evictions).toBe(1);
  });

  it("respects Cache-Control directives, status codes, and maxBodyBytes", () => {
    let clock = 0;
    const cache = new ResponseCache({
      defaultTtlMs: 10_000,
      maxBodyBytes: 10,
      now: () => clock,
    });

    expect(
      cache.set("GET:/no-store", {
        statusCode: 200,
        headers: { "cache-control": "no-store" },
        body: Buffer.from("ok"),
      })
    ).toBe(false);

    expect(
      cache.set("GET:/err", {
        statusCode: 500,
        headers: {},
        body: Buffer.from("err"),
      })
    ).toBe(false);

    expect(
      cache.set("GET:/big", {
        statusCode: 200,
        headers: {},
        body: Buffer.from("0123456789abcdef"),
      })
    ).toBe(false);

    expect(
      cache.set("GET:/short", {
        statusCode: 200,
        headers: { "cache-control": "public, max-age=2" },
        body: Buffer.from("hi"),
      })
    ).toBe(true);

    clock = 1_500;
    expect(cache.get("GET:/short").hit).toBe(true);
    clock = 2_000;
    expect(cache.get("GET:/short").hit).toBe(false);
  });

  it("supports prefix invalidation and reports accurate hitRate stats", () => {
    const cache = new ResponseCache({ defaultTtlMs: 10_000 });
    const ok = { statusCode: 200, headers: {}, body: Buffer.from("1") };

    cache.set("GET:/users/1", ok);
    cache.set("GET:/users/2", ok);
    cache.set("GET:/posts/1", ok);

    cache.get("GET:/users/1"); // hit
    cache.get("GET:/missing"); // miss

    expect(cache.invalidateByPrefix("GET:/users/")).toBe(2);
    expect(cache.get("GET:/posts/1").hit).toBe(true);

    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3);
  });
});
