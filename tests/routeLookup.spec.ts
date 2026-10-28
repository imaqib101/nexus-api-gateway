import { describe, it, expect } from "vitest";
import { NexusGateway } from "../src/gateway";

describe("NexusGateway Route Lookup & Management", () => {
  it("allows finding routes and checking route rules", () => {
    const gateway = new NexusGateway();
    gateway.addRoute({
      pathPrefix: "/api/v1",
      targets: ["http://localhost:3001"],
      strategy: "round-robin"
    });

    const route = gateway.findRoute("/api/v1/users");
    expect(route).toBeDefined();
    expect(route?.pathPrefix).toBe("/api/v1");
    expect(gateway.getRoutes().length).toBe(1);

    const removed = gateway.removeRoute("/api/v1");
    expect(removed).toBe(true);
    expect(gateway.getRoutes().length).toBe(0);
  });
});
