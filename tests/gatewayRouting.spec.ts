import { describe, it, expect } from "vitest";
import { NexusGateway } from "../src/gateway";

describe("NexusGateway Routing Algorithms", () => {
  it("executes Round-Robin routing sequentially across targets", () => {
    const gateway = new NexusGateway();
    gateway.addRoute({
      pathPrefix: "/api/v1/auth",
      targets: ["http://srv-1:3000", "http://srv-2:3000", "http://srv-3:3000"],
      strategy: "round-robin",
    });

    expect(gateway.routeRequest("/api/v1/auth/login")).toBe("http://srv-1:3000");
    expect(gateway.routeRequest("/api/v1/auth/login")).toBe("http://srv-2:3000");
    expect(gateway.routeRequest("/api/v1/auth/login")).toBe("http://srv-3:3000");
    expect(gateway.routeRequest("/api/v1/auth/login")).toBe("http://srv-1:3000");
  });

  it("distributes traffic proportional to weights in Weighted Round-Robin", () => {
    const gateway = new NexusGateway();
    gateway.addRoute({
      pathPrefix: "/api/v1/inference",
      targets: [
        { url: "http://gpu-heavy:8000", weight: 3 },
        { url: "http://cpu-light:8000", weight: 1 },
      ],
      strategy: "weighted-round-robin",
    });

    const selections: string[] = [];
    for (let i = 0; i < 4; i++) {
      selections.push(gateway.routeRequest("/api/v1/inference/predict"));
    }

    const gpuCount = selections.filter((s) => s.includes("gpu-heavy")).length;
    const cpuCount = selections.filter((s) => s.includes("cpu-light")).length;

    expect(gpuCount).toBe(3);
    expect(cpuCount).toBe(1);
  });

  it("routes dynamically to target with Least Active Connections", () => {
    const gateway = new NexusGateway();
    const t1 = "http://node-a:4000";
    const t2 = "http://node-b:4000";

    gateway.addRoute({
      pathPrefix: "/api/v1/tasks",
      targets: [t1, t2],
      strategy: "least-connections",
    });

    // Simulate node-a having 5 active connections, node-b having 1
    for (let i = 0; i < 5; i++) gateway.incrementActiveConnections(t1);
    gateway.incrementActiveConnections(t2);

    expect(gateway.routeRequest("/api/v1/tasks")).toBe(t2);

    // Node-b receives work and reaches 6 active connections
    for (let i = 0; i < 5; i++) gateway.incrementActiveConnections(t2);

    // Now node-a (5 connections) is lower than node-b (6 connections)
    expect(gateway.routeRequest("/api/v1/tasks")).toBe(t1);
  });

  it("preserves client affinity using Consistent IP-Hashing", () => {
    const gateway = new NexusGateway();
    gateway.addRoute({
      pathPrefix: "/api/v1/ws",
      targets: ["http://socket-cluster-1", "http://socket-cluster-2", "http://socket-cluster-3"],
      strategy: "ip-hash",
    });

    const clientA = "192.168.1.100";
    const clientB = "10.0.4.52";

    const targetA1 = gateway.routeRequest("/api/v1/ws", { clientIp: clientA });
    const targetA2 = gateway.routeRequest("/api/v1/ws", { clientIp: clientA });
    const targetA3 = gateway.routeRequest("/api/v1/ws", { clientIp: clientA });

    // Client A must consistently land on the exact same target node
    expect(targetA1).toBe(targetA2);
    expect(targetA2).toBe(targetA3);

    const targetB1 = gateway.routeRequest("/api/v1/ws", { clientIp: clientB });
    const targetB2 = gateway.routeRequest("/api/v1/ws", { clientIp: clientB });
    expect(targetB1).toBe(targetB2);
  });

  it("routes to lowest latency target in Latency-Based strategy", () => {
    const gateway = new NexusGateway();
    const fastNode = "http://fast-region:80";
    const slowNode = "http://slow-region:80";

    gateway.addRoute({
      pathPrefix: "/api/v1/cdn",
      targets: [fastNode, slowNode],
      strategy: "latency-based",
    });

    gateway.recordLatency(fastNode, 15);
    gateway.recordLatency(slowNode, 180);

    expect(gateway.routeRequest("/api/v1/cdn/asset.js")).toBe(fastNode);
  });
});
