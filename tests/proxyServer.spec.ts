import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NexusGateway } from "../src/gateway";
import { ProxyServer } from "../src/proxy";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function startUpstream(handler: Handler): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe("ProxyServer", () => {
  const closers: Array<() => Promise<void>> = [];
  let gateway: NexusGateway;

  const track = (server: http.Server) =>
    closers.push(
      () =>
        new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections?.();
        }),
    );

  async function startProxy(opts: Partial<ConstructorParameters<typeof ProxyServer>[0]> = {}) {
    const proxy = new ProxyServer({ gateway, ...opts });
    const addr = await proxy.listen(0, "127.0.0.1");
    closers.push(() => proxy.close());
    return { proxy, base: `http://127.0.0.1:${addr.port}` };
  }

  beforeEach(() => {
    gateway = new NexusGateway();
  });

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c()));
  });

  it("forwards method, path, body and response", async () => {
    const seen: { method?: string; url?: string; body: string; xff?: string | string[] } = {
      body: "",
    };
    const up = await startUpstream((req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      seen.xff = req.headers["x-forwarded-for"];
      req.on("data", (c) => (seen.body += c));
      req.on("end", () => {
        res.writeHead(201, { "x-upstream": "yes" });
        res.end("created");
      });
    });
    track(up.server);
    gateway.addRoute({ pathPrefix: "/api", targets: [up.url] });
    const { base } = await startProxy();

    const r = await fetch(`${base}/api/items?a=1`, { method: "POST", body: "hello" });
    expect(r.status).toBe(201);
    expect(r.headers.get("x-upstream")).toBe("yes");
    expect(await r.text()).toBe("created");
    expect(seen).toMatchObject({ method: "POST", url: "/api/items?a=1", body: "hello" });
    expect(String(seen.xff)).toMatch(/127\.0\.0\.1/);
  });

  it("strips the route prefix when configured", async () => {
    let url = "";
    const up = await startUpstream((req, res) => {
      url = req.url!;
      res.end("ok");
    });
    track(up.server);
    gateway.addRoute({ pathPrefix: "/svc", targets: [up.url], stripPrefix: true });
    const { base } = await startProxy();
    await fetch(`${base}/svc/users/7?x=1`);
    expect(url).toBe("/users/7?x=1");
  });

  it("returns 404 for unknown routes and 429 with Retry-After when limited", async () => {
    const up = await startUpstream((_req, res) => res.end("ok"));
    track(up.server);
    gateway.addRoute({
      pathPrefix: "/lim",
      targets: [up.url],
      rateLimit: { capacity: 1, refillRatePerSec: 0.01 },
    });
    const { base } = await startProxy();

    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/lim`)).status).toBe(200);
    const limited = await fetch(`${base}/lim`);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await limited.json()).code).toBe("RATE_LIMITED");
  });

  it("returns 502 when the upstream is down and opens the circuit after repeated failures", async () => {
    const dead = await startUpstream((_req, res) => res.end());
    const deadUrl = dead.url;
    await new Promise<void>((r) => dead.server.close(() => r()));
    gateway.addRoute({ pathPrefix: "/dead", targets: [deadUrl] });
    const { base, proxy } = await startProxy({
      breaker: { failureThreshold: 2, resetTimeoutMs: 60_000 },
    });

    expect((await fetch(`${base}/dead`)).status).toBe(502);
    expect((await fetch(`${base}/dead`)).status).toBe(502);
    const tripped = await fetch(`${base}/dead`);
    expect(tripped.status).toBe(503);
    expect((await tripped.json()).code).toBe("CIRCUIT_OPEN");
    expect(proxy.getBreaker(deadUrl).canExecute()).toBe(false);
  });

  it("returns 504 on upstream timeout and releases the connection slot", async () => {
    const up = await startUpstream(() => {
      /* never respond */
    });
    track(up.server);
    gateway.addRoute({ pathPrefix: "/slow", targets: [up.url] });
    const { base } = await startProxy({ requestTimeoutMs: 50 });
    expect((await fetch(`${base}/slow`)).status).toBe(504);
    expect(gateway.getActiveConnections(up.url)).toBe(0);
  });

  it("tracks active connections and records latency for completed requests", async () => {
    const up = await startUpstream((_req, res) => setTimeout(() => res.end("ok"), 20));
    track(up.server);
    gateway.addRoute({ pathPrefix: "/t", targets: [up.url], strategy: "latency-based" });
    const { base } = await startProxy();
    await fetch(`${base}/t`);
    expect(gateway.getActiveConnections(up.url)).toBe(0);
    // a second request now routes using the recorded EMA without throwing
    expect((await fetch(`${base}/t`)).status).toBe(200);
  });

  it("balances across targets and skips unhealthy ones", async () => {
    const a = await startUpstream((_q, res) => res.end("a"));
    const b = await startUpstream((_q, res) => res.end("b"));
    track(a.server);
    track(b.server);
    gateway.addRoute({ pathPrefix: "/lb", targets: [a.url, b.url] });
    const { base } = await startProxy();
    const bodies = new Set([
      await (await fetch(`${base}/lb`)).text(),
      await (await fetch(`${base}/lb`)).text(),
    ]);
    expect(bodies).toEqual(new Set(["a", "b"]));
    gateway.markTargetUnhealthy(b.url);
    for (let i = 0; i < 3; i++) expect(await (await fetch(`${base}/lb`)).text()).toBe("a");
  });
});
