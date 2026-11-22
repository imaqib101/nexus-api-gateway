import { describe, it, expect, vi } from "vitest";
import { IdempotencyStore } from "../src/idempotency";

describe("IdempotencyStore", () => {
  it("acquires new idempotency key with in-progress state", () => {
    const store = new IdempotencyStore();
    const fp = IdempotencyStore.generateFingerprint("POST", "/payments", JSON.stringify({ amount: 100 }));

    const res1 = store.acquire("key-123", fp);
    expect(res1.state).toBe("acquired");
    expect(store.size()).toBe(1);

    const record = store.get("key-123");
    expect(record).toBeDefined();
    expect(record?.status).toBe("in-progress");
  });

  it("returns in-progress for concurrent requests with same key and fingerprint", () => {
    const store = new IdempotencyStore();
    const fp = IdempotencyStore.generateFingerprint("POST", "/orders", "{}");

    store.acquire("order-key", fp);
    const concurrent = store.acquire("order-key", fp);

    expect(concurrent.state).toBe("in-progress");
  });

  it("detects fingerprint mismatch when same key is reused with different payload", () => {
    const store = new IdempotencyStore();
    const fp1 = IdempotencyStore.generateFingerprint("POST", "/transfer", "{\"amount\":50}");
    const fp2 = IdempotencyStore.generateFingerprint("POST", "/transfer", "{\"amount\":5000}");

    store.acquire("transfer-key", fp1);
    const mismatch = store.acquire("transfer-key", fp2);

    expect(mismatch.state).toBe("mismatch");
    if (mismatch.state === "mismatch") {
      expect(mismatch.existingFingerprint).toBe(fp1);
    }
  });

  it("caches completed response and replays on subsequent acquire", () => {
    const store = new IdempotencyStore();
    const fp = IdempotencyStore.generateFingerprint("POST", "/items", "{\"name\":\"widget\"}");

    store.acquire("create-item-1", fp);
    store.complete(
      "create-item-1",
      201,
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ id: 99, name: "widget" }))
    );

    const cached = store.acquire("create-item-1", fp);
    expect(cached.state).toBe("cached");
    if (cached.state === "cached") {
      expect(cached.record.statusCode).toBe(201);
      expect(cached.record.headers?.["content-type"]).toBe("application/json");
      expect(cached.record.body?.toString()).toContain("\"id\":99");
    }
  });

  it("releases in-progress lock on network or upstream error so client can retry", () => {
    const store = new IdempotencyStore();
    const fp = IdempotencyStore.generateFingerprint("POST", "/dispatch", "{}");

    store.acquire("dispatch-1", fp);
    expect(store.release("dispatch-1")).toBe(true);

    // After release, immediate retry can re-acquire
    const retry = store.acquire("dispatch-1", fp);
    expect(retry.state).toBe("acquired");
  });

  it("does not release completed records", () => {
    const store = new IdempotencyStore();
    const fp = IdempotencyStore.generateFingerprint("POST", "/safe", "{}");

    store.acquire("safe-1", fp);
    store.complete("safe-1", 200, {}, "ok");

    expect(store.release("safe-1")).toBe(false);
    expect(store.get("safe-1")?.status).toBe("completed");
  });

  it("evicts expired records according to ttlMs", () => {
    vi.useFakeTimers();
    try {
      const store = new IdempotencyStore({ ttlMs: 1000 });
      const fp = IdempotencyStore.generateFingerprint("POST", "/temp", "{}");

      store.acquire("temp-key", fp);
      store.complete("temp-key", 200, {}, "done");

      expect(store.get("temp-key")).toBeDefined();

      // Advance clock past TTL
      vi.advanceTimersByTime(1500);

      expect(store.get("temp-key")).toBeUndefined();
      expect(store.prune()).toBe(0); // already removed on get
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes expired records in batch", () => {
    vi.useFakeTimers();
    try {
      const store = new IdempotencyStore({ ttlMs: 500 });
      const fp = IdempotencyStore.generateFingerprint("POST", "/batch", "{}");

      store.acquire("k1", fp);
      store.acquire("k2", fp);
      expect(store.size()).toBe(2);

      vi.advanceTimersByTime(600);
      const pruned = store.prune();
      expect(pruned).toBe(2);
      expect(store.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("generates deterministic SHA-256 fingerprints across string and Buffer inputs", () => {
    const fpStr = IdempotencyStore.generateFingerprint("post", "/api/v1", "{\"a\":1}");
    const fpBuf = IdempotencyStore.generateFingerprint("POST", "/api/v1", Buffer.from("{\"a\":1}"));
    expect(fpStr).toBe(fpBuf);
    expect(fpStr).toHaveLength(64); // SHA-256 hex string
  });
});
