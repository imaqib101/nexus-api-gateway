import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { NexusGateway } from "../src/gateway";
import { PowerOfTwoChoicesBalancer, CanaryRoutingBalancer } from "../src/algorithms";

describe("NexusGateway & Routing Integration", () => {
  let serverA: http.Server;
  let serverB: http.Server;
  let urlA: string;
  let urlB: string;

  beforeAll(async () => {
    // Start upstream Mock Server A
    await new Promise<void>((resolve) => {
      serverA = http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("X-Backend-Server", "server-a");
        res.end(JSON.stringify({ backend: "server-a", path: req.url }));
      });
      serverA.listen(0, "127.0.0.1", () => {
        const addr = serverA.address() as any;
        urlA = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // Start upstream Mock Server B
    await new Promise<void>((resolve) => {
      serverB = http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("X-Backend-Server", "server-b");
        res.end(JSON.stringify({ backend: "server-b", path: req.url }));
      });
      serverB.listen(0, "127.0.0.1", () => {
        const addr = serverB.address() as any;
        urlB = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<any>((resolve) => serverA.close(resolve)),
      new Promise<any>((resolve) => serverB.close(resolve))
    ]);
  });

  it("routes to live upstream backends via round-robin", async () => {
    const gateway = new NexusGateway();
    gateway.addRoute({
      pathPrefix: "/api/users",
      targets: [urlA, urlB],
      strategy: "round-robin"
    });

    const target1 = gateway.routeRequest("/api/users/123");
    const target2 = gateway.routeRequest("/api/users/456");
    expect([urlA, urlB]).toContain(target1);
    expect([urlA, urlB]).toContain(target2);
    expect(target1).not.toBe(target2);
  });

  it("routes canary traffic when X-Canary header is present", () => {
    const gateway = new NexusGateway();
    gateway.addRoute({
      pathPrefix: "/v2/checkout",
      targets: [urlA, urlB], // urlA is stable, urlB is canary
      strategy: "canary",
      canaryPercent: 0, // 0% by default, only explicit header
      canaryHeaderKey: "x-canary"
    });

    // Normal traffic -> Stable (urlA)
    const normal = gateway.routeRequest("/v2/checkout", { headers: {} });
    expect(normal).toBe(urlA);

    // Canary traffic with header -> Canary (urlB)
    const canary = gateway.routeRequest("/v2/checkout", {
      headers: { "x-canary": "true" }
    });
    expect(canary).toBe(urlB);
  });

  it("supports Power of Two Choices (P2C) to balance active connections", () => {
    const gateway = new NexusGateway();
    gateway.addRoute({
      pathPrefix: "/services",
      targets: [urlA, urlB],
      strategy: "p2c"
    });

    gateway.incrementActiveConnections(urlA);
    gateway.incrementActiveConnections(urlA);
    // urlA has 2 active connections, urlB has 0

    // P2C should select the lower loaded target (urlB)
    const selected = gateway.routeRequest("/services/data");
    expect(selected).toBe(urlB);

    gateway.decrementActiveConnections(urlA);
    gateway.decrementActiveConnections(urlA);
  });

  it("fails over when one upstream server is marked unhealthy", () => {
    const gateway = new NexusGateway();
    gateway.addRoute({
      pathPrefix: "/payments",
      targets: [urlA, urlB],
      strategy: "round-robin"
    });

    gateway.markTargetUnhealthy(urlA);

    for (let i = 0; i < 5; i++) {
      expect(gateway.routeRequest("/payments/charge")).toBe(urlB);
    }

    gateway.markTargetHealthy(urlA);
  });

  it("enforces rate limits on high-frequency route bursts", () => {
    const gateway = new NexusGateway();
    gateway.addRoute({
      pathPrefix: "/throttled",
      targets: [urlA],
      rateLimit: {
        capacity: 2,
        refillRatePerSec: 1
      }
    });

    expect(gateway.routeRequest("/throttled/1", { clientIp: "10.0.0.1" })).toBe(urlA);
    expect(gateway.routeRequest("/throttled/2", { clientIp: "10.0.0.1" })).toBe(urlA);
    expect(() =>
      gateway.routeRequest("/throttled/3", { clientIp: "10.0.0.1" })
    ).toThrow(/Rate limit exceeded/);
  });
});
