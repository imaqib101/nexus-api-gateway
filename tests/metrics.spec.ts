import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Metrics } from "../src/metrics";
import { NexusGateway } from "../src/gateway";
import { ProxyServer } from "../src/proxy";

describe("Metrics", () => {
  it("counts requests per label set and renders histogram buckets cumulatively", () => {
    const m = new Metrics();
    m.observe({ route: "/a", target: "http://t:1", status: 200, durationMs: 7 });
    m.observe({ route: "/a", target: "http://t:1", status: 200, durationMs: 300 });
    m.observe({ route: "/a", target: "http://t:1", status: 502, durationMs: 1 });
    const out = m.render();
    expect(out).toContain('nexus_requests_total{route="/a",target="http://t:1",status="200"} 2');
    expect(out).toContain('nexus_requests_total{route="/a",target="http://t:1",status="502"} 1');
    expect(out).toContain('nexus_request_duration_ms_bucket{route="/a",le="10"} 2');
    expect(out).toContain('nexus_request_duration_ms_bucket{route="/a",le="500"} 3');
    expect(out).toContain('nexus_request_duration_ms_count{route="/a"} 3');
    expect(m.total()).toBe(3);
  });

  it("escapes label values", () => {
    const m = new Metrics();
    m.observe({ route: '/a"b', status: 200, durationMs: 1 });
    expect(m.render()).toContain('route="/a\\"b"');
  });
});

describe("admin endpoints", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c()));
  });

  it("serves /_nexus/health and /_nexus/metrics reflecting proxied traffic", async () => {
    const up = http.createServer((_q, r) => r.end("ok"));
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
    closers.push(
      () =>
        new Promise<void>((r) => {
          up.close(() => r());
          up.closeAllConnections();
        }),
    );
    const upUrl = `http://127.0.0.1:${(up.address() as AddressInfo).port}`;

    const gateway = new NexusGateway();
    gateway.addRoute({ pathPrefix: "/api", targets: [upUrl, "http://127.0.0.1:1"] });
    gateway.markTargetUnhealthy("http://127.0.0.1:1");
    const proxy = new ProxyServer({ gateway });
    const { port } = await proxy.listen(0, "127.0.0.1");
    closers.push(() => proxy.close());
    const base = `http://127.0.0.1:${port}`;

    await fetch(`${base}/api/x`);
    await fetch(`${base}/missing`);

    const health = await fetch(`${base}/_nexus/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe("ok");

    const text = await (await fetch(`${base}/_nexus/metrics`)).text();
    expect(text).toContain(`nexus_requests_total{route="/api",target="${upUrl}",status="200"} 1`);
    expect(text).toContain('route="unmatched",target="",status="404"} 1');
    expect(text).toContain('nexus_target_healthy{target="http://127.0.0.1:1"} 0');
    expect(text).toContain(`nexus_active_connections{target="${upUrl}"} 0`);

    expect((await fetch(`${base}/_nexus/nope`)).status).toBe(404);
  });

  it("can be disabled", async () => {
    const gateway = new NexusGateway();
    const proxy = new ProxyServer({ gateway, adminEndpoints: false });
    const { port } = await proxy.listen(0, "127.0.0.1");
    closers.push(() => proxy.close());
    const res = await fetch(`http://127.0.0.1:${port}/_nexus/health`);
    expect((await res.json()).code).toBe("NO_ROUTE");
  });
});
