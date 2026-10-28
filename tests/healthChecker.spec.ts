import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NexusGateway } from "../src/gateway";
import { HealthChecker, httpProbe } from "../src/healthChecker";

function setup(results: Record<string, boolean>) {
  const gateway = new NexusGateway();
  gateway.addRoute({ pathPrefix: "/a", targets: ["http://a:1", "http://b:1"] });
  const events: Array<[string, boolean]> = [];
  const checker = new HealthChecker({
    gateway,
    unhealthyThreshold: 2,
    healthyThreshold: 2,
    probe: async (url) => results[url],
    onStateChange: (u, h) => events.push([u, h]),
  });
  return { gateway, checker, events };
}

describe("HealthChecker", () => {
  afterEach(() => vi.useRealTimers());

  it("ejects a target only after N consecutive failures", async () => {
    const { gateway, checker, events } = setup({ "http://a:1": true, "http://b:1": false });
    await checker.checkAll();
    expect(gateway.isTargetHealthy("http://b:1")).toBe(true);
    await checker.checkAll();
    expect(gateway.isTargetHealthy("http://b:1")).toBe(false);
    expect(gateway.isTargetHealthy("http://a:1")).toBe(true);
    expect(events).toEqual([["http://b:1", false]]);
  });

  it("restores a target after M consecutive passes and resets streaks on flaps", async () => {
    const results: Record<string, boolean> = { "http://a:1": true, "http://b:1": false };
    const { gateway, checker, events } = setup(results);
    await checker.checkAll();
    await checker.checkAll();
    expect(gateway.isTargetHealthy("http://b:1")).toBe(false);

    results["http://b:1"] = true;
    await checker.checkAll();
    results["http://b:1"] = false; // flap resets the pass streak
    await checker.checkAll();
    results["http://b:1"] = true;
    await checker.checkAll();
    expect(gateway.isTargetHealthy("http://b:1")).toBe(false);
    await checker.checkAll();
    expect(gateway.isTargetHealthy("http://b:1")).toBe(true);
    expect(events.at(-1)).toEqual(["http://b:1", true]);
  });

  it("start/stop drives checks on an interval", async () => {
    vi.useFakeTimers();
    const gateway = new NexusGateway();
    gateway.addRoute({ pathPrefix: "/a", targets: ["http://a:1"] });
    const probe = vi.fn(async () => true);
    const checker = new HealthChecker({ gateway, probe, intervalMs: 1000 });
    checker.start();
    checker.start(); // idempotent
    await vi.advanceTimersByTimeAsync(3000);
    expect(probe.mock.calls.length).toBe(4); // immediate + 3 ticks
    checker.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(probe.mock.calls.length).toBe(4);
  });

  it("rejects invalid thresholds", () => {
    expect(
      () => new HealthChecker({ gateway: new NexusGateway(), unhealthyThreshold: 0 }),
    ).toThrow();
  });
});

describe("httpProbe", () => {
  it("treats 2xx/3xx as healthy, 5xx and connection errors as unhealthy", async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = req.url === "/bad" ? 500 : 200;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await httpProbe(url, "/health", 500)).toBe(true);
    expect(await httpProbe(url, "/bad", 500)).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await httpProbe(url, "/health", 500)).toBe(false);
  });
});
