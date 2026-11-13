import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import { NexusGateway, MethodNotAllowedError, parseConfig } from "../src";
import { ProxyServer } from "../src/proxy";

describe("HTTP Method Filtering and Segregation", () => {
  const closers: Array<() => Promise<void>> = [];

  const startServer = async (
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
  ): Promise<{ port: number; server: http.Server }> => {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        })
    );
    const port = (server.address() as AddressInfo).port;
    return { port, server };
  };

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c()));
  });

  it("routes GET and POST on same pathPrefix to separate upstreams (CQRS pattern)", () => {
    const gw = new NexusGateway();

    gw.addRoute({
      pathPrefix: "/api/orders",
      methods: ["GET"],
      targets: ["http://read-replica:3000"]
    });

    gw.addRoute({
      pathPrefix: "/api/orders",
      methods: ["POST", "PUT"],
      targets: ["http://primary-write:3000"]
    });

    // GET request
    const getTarget = gw.routeRequest("/api/orders", { method: "GET" });
    expect(getTarget).toBe("http://read-replica:3000");

    // POST request
    const postTarget = gw.routeRequest("/api/orders", { method: "POST" });
    expect(postTarget).toBe("http://primary-write:3000");

    // PUT request
    const putTarget = gw.routeRequest("/api/orders", { method: "PUT" });
    expect(putTarget).toBe("http://primary-write:3000");
  });

  it("throws MethodNotAllowedError with allowed methods when an unpermitted method is used", () => {
    const gw = new NexusGateway();

    gw.addRoute({
      pathPrefix: "/api/items",
      methods: ["GET", "HEAD"],
      targets: ["http://backend:8080"]
    });

    try {
      gw.routeRequest("/api/items", { method: "DELETE" });
      expect.fail("Expected MethodNotAllowedError");
    } catch (err) {
      expect(err).toBeInstanceOf(MethodNotAllowedError);
      const mErr = err as MethodNotAllowedError;
      expect(mErr.statusCode).toBe(405);
      expect(mErr.code).toBe("METHOD_NOT_ALLOWED");
      expect(mErr.method).toBe("DELETE");
      expect(mErr.allowedMethods).toEqual(["GET", "HEAD"]);
    }
  });

  it("prevents registering conflicting routes with overlapping methods on the same pathPrefix", () => {
    const gw = new NexusGateway();

    gw.addRoute({
      pathPrefix: "/api/v1",
      methods: ["GET", "POST"],
      targets: ["http://backend1:8080"]
    });

    expect(() => {
      gw.addRoute({
        pathPrefix: "/api/v1",
        methods: ["POST", "DELETE"],
        targets: ["http://backend2:8080"]
      });
    }).toThrow(/Route already registered for prefix: \/api\/v1/);
  });

  it("removes specific method route when method is passed to removeRoute", () => {
    const gw = new NexusGateway();

    gw.addRoute({
      pathPrefix: "/api/data",
      methods: ["GET"],
      targets: ["http://read:8080"]
    });

    gw.addRoute({
      pathPrefix: "/api/data",
      methods: ["POST"],
      targets: ["http://write:8080"]
    });

    expect(gw.getRoutes()).toHaveLength(2);

    const removed = gw.removeRoute("/api/data", "GET");
    expect(removed).toBe(true);
    expect(gw.getRoutes()).toHaveLength(1);

    // POST should still be routeable
    expect(gw.routeRequest("/api/data", { method: "POST" })).toBe("http://write:8080");

    // GET now throws 405 because only POST is allowed
    expect(() => gw.routeRequest("/api/data", { method: "GET" })).toThrow(MethodNotAllowedError);
  });

  it("validates methods array in parseConfig", () => {
    expect(() => {
      parseConfig({
        routes: [
          {
            pathPrefix: "/api",
            targets: ["http://localhost:3000"],
            methods: []
          }
        ]
      });
    }).toThrow(/methods must be a non-empty array/);

    const valid = parseConfig({
      routes: [
        {
          pathPrefix: "/api",
          targets: ["http://localhost:3000"],
          methods: ["GET", "POST"]
        }
      ]
    });
    expect(valid.routes[0].methods).toEqual(["GET", "POST"]);
  });

  it("responds with HTTP 405 and Allow header when proxy receives an unpermitted method", async () => {
    const upstream = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const gw = new NexusGateway();
    gw.addRoute({
      pathPrefix: "/api/read-only",
      methods: ["GET"],
      targets: [`http://127.0.0.1:${upstream.port}`]
    });

    const proxy = new ProxyServer({
      gateway: gw,
      adminEndpoints: false
    });

    const addr = await proxy.listen(0, "127.0.0.1");
    closers.push(() => proxy.close());

    // 1. Permitted GET should succeed (200)
    const getRes = await fetch(`http://127.0.0.1:${addr.port}/api/read-only`, {
      method: "GET"
    });
    expect(getRes.status).toBe(200);

    // 2. Disallowed POST should return 405 with Allow header
    const postRes = await fetch(`http://127.0.0.1:${addr.port}/api/read-only`, {
      method: "POST",
      body: JSON.stringify({ test: 123 }),
      headers: { "content-type": "application/json" }
    });

    expect(postRes.status).toBe(405);
    expect(postRes.headers.get("allow")).toBe("GET");
    const json = (await postRes.json()) as { error: string; code: string };
    expect(json.code).toBe("METHOD_NOT_ALLOWED");
    expect(json.error).toContain("Method POST not allowed");
  });
});
