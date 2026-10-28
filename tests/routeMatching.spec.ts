import { describe, it, expect } from "vitest";
import { NexusGateway, NoRouteError, RateLimitError, NoHealthyTargetError } from "../src/gateway";

describe("route matching", () => {
  it("prefers the longest matching prefix regardless of registration order", () => {
    const gw = new NexusGateway();
    gw.addRoute({ pathPrefix: "/api", targets: ["http://generic:1"] });
    gw.addRoute({ pathPrefix: "/api/v1/inference", targets: ["http://gpu:1"] });
    expect(gw.routeRequest("/api/v1/inference/generate")).toBe("http://gpu:1");
    expect(gw.routeRequest("/api/users")).toBe("http://generic:1");
  });

  it("only matches on path segment boundaries", () => {
    const gw = new NexusGateway();
    gw.addRoute({ pathPrefix: "/api", targets: ["http://a:1"] });
    expect(() => gw.routeRequest("/apiary")).toThrow(NoRouteError);
    expect(gw.routeRequest("/api")).toBe("http://a:1");
    expect(gw.routeRequest("/api?x=1")).toBe("http://a:1");
  });

  it("rejects duplicate and malformed prefixes", () => {
    const gw = new NexusGateway();
    gw.addRoute({ pathPrefix: "/a", targets: ["http://a:1"] });
    expect(() => gw.addRoute({ pathPrefix: "/a", targets: ["http://b:1"] })).toThrow(/already registered/);
    expect(() => gw.addRoute({ pathPrefix: "a", targets: ["http://b:1"] })).toThrow(/must start with/);
  });

  it("removeRoute drops the route and its limiter state", () => {
    const gw = new NexusGateway();
    gw.addRoute({ pathPrefix: "/a", targets: ["http://a:1"], rateLimit: { capacity: 1, refillRatePerSec: 0.001 } });
    gw.routeRequest("/a", { clientIp: "1.1.1.1" });
    expect(gw.removeRoute("/a")).toBe(true);
    expect(gw.removeRoute("/a")).toBe(false);
    expect(() => gw.routeRequest("/a")).toThrow(NoRouteError);
    gw.addRoute({ pathPrefix: "/a", targets: ["http://a:1"], rateLimit: { capacity: 1, refillRatePerSec: 0.001 } });
    expect(gw.routeRequest("/a", { clientIp: "1.1.1.1" })).toBe("http://a:1");
  });
});

describe("rewritePath", () => {
  const gw = new NexusGateway();
  const route = { pathPrefix: "/api/v1", targets: ["http://a:1"], stripPrefix: true };
  it("strips the prefix and keeps the query string", () => {
    expect(gw.rewritePath("/api/v1/users?id=2", route)).toBe("/users?id=2");
    expect(gw.rewritePath("/api/v1", route)).toBe("/");
    expect(gw.rewritePath("/api/v1?x=1", route)).toBe("/?x=1");
  });
  it("leaves the path alone when stripPrefix is off", () => {
    expect(gw.rewritePath("/api/v1/users", { ...route, stripPrefix: false })).toBe("/api/v1/users");
  });
});

describe("typed errors", () => {
  it("carry HTTP status codes", () => {
    const gw = new NexusGateway();
    gw.addRoute({ pathPrefix: "/a", targets: ["http://a:1"], rateLimit: { capacity: 1, refillRatePerSec: 0.001 } });
    gw.routeRequest("/a");
    try {
      gw.routeRequest("/a");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).statusCode).toBe(429);
    }
    gw.removeRoute("/a");
    gw.addRoute({ pathPrefix: "/b", targets: ["http://b:1"] });
    gw.markTargetUnhealthy("http://b:1");
    expect(() => gw.routeRequest("/b")).toThrow(NoHealthyTargetError);
  });
});
