import { describe, it, expect } from "vitest";
import { NexusGateway } from "../src/gateway";

describe("NexusGateway Resilience, Health Checks & Rate Limiting", () => {
  it("automatically ejects unhealthy targets from the routing pool", () => {
    const gateway = new NexusGateway();
    const primary = "http://primary-db:5432";
    const replica = "http://replica-db:5432";

    gateway.addRoute({
      pathPrefix: "/db",
      targets: [primary, replica],
      strategy: "round-robin"
    });

    expect(gateway.routeRequest("/db")).toBe(primary);

    // Primary encounters health failure
    gateway.markTargetUnhealthy(primary);

    // Both requests must now route exclusively to the healthy replica
    expect(gateway.routeRequest("/db")).toBe(replica);
    expect(gateway.routeRequest("/db")).toBe(replica);

    // Mark primary as restored
    gateway.markTargetHealthy(primary);
    expect(gateway.isTargetHealthy(primary)).toBe(true);
  });

  it("throws descriptive error when all targets are unhealthy", () => {
    const gateway = new NexusGateway();
    const srv = "http://dead-cluster:9000";
    gateway.addRoute({
      pathPrefix: "/critical",
      targets: [srv]
    });

    gateway.markTargetUnhealthy(srv);

    expect(() => gateway.routeRequest("/critical")).toThrow(
      "All backend targets are unhealthy for route: /critical"
    );
  });

  it("enforces Token Bucket rate limits and throws when capacity is exhausted", () => {
    const gateway = new NexusGateway();
    gateway.addRoute({
      pathPrefix: "/rate-limited",
      targets: ["http://api:8080"],
      rateLimit: {
        capacity: 2,
        refillRatePerSec: 1
      }
    });

    // 1st and 2nd allowed (capacity = 2)
    expect(gateway.routeRequest("/rate-limited", { clientIp: "10.0.0.1" })).toBe("http://api:8080");
    expect(gateway.routeRequest("/rate-limited", { clientIp: "10.0.0.1" })).toBe("http://api:8080");

    // 3rd call immediately should fail
    expect(() =>
      gateway.routeRequest("/rate-limited", { clientIp: "10.0.0.1" })
    ).toThrow(/Rate limit exceeded for route "\/rate-limited"/);

    // Another client with separate IP is not blocked
    expect(gateway.routeRequest("/rate-limited", { clientIp: "10.0.0.2" })).toBe("http://api:8080");
  });
});
