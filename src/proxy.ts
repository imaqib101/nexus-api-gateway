import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { CircuitBreaker, type CircuitBreakerOptions } from "./circuitBreaker";
import { GatewayError, NexusGateway, RateLimitError } from "./gateway";
import { Metrics } from "./metrics";

export interface ProxyServerOptions {
  gateway: NexusGateway;
  /** Abort upstream requests that produce no response within this window. */
  requestTimeoutMs?: number;
  /** Per-target circuit breaker settings. */
  breaker?: CircuitBreakerOptions;
  /** Trust an inbound X-Forwarded-For and append to it instead of replacing it. */
  trustProxy?: boolean;
  /** Registry fed by every request; pass one to share it, or read `proxy.metrics`. */
  metrics?: Metrics;
  /** Serve /_nexus/health and /_nexus/metrics. On by default. */
  adminEndpoints?: boolean;
}

export const ADMIN_PREFIX = "/_nexus";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export class ProxyServer {
  private server: http.Server;
  private breakers = new Map<string, CircuitBreaker>();
  private readonly requestTimeoutMs: number;
  readonly metrics: Metrics;

  constructor(private options: ProxyServerOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.metrics = options.metrics ?? new Metrics();
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  get gateway(): NexusGateway {
    return this.options.gateway;
  }

  listen(port: number, host = "0.0.0.0"): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve(this.server.address() as AddressInfo);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
      this.server.closeIdleConnections?.();
    });
  }

  getBreaker(target: string): CircuitBreaker {
    let breaker = this.breakers.get(target);
    if (!breaker) {
      breaker = new CircuitBreaker(this.options.breaker);
      this.breakers.set(target, breaker);
    }
    return breaker;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const rawUrl = req.url ?? "/";
    const clientIp = req.socket.remoteAddress ?? "unknown";

    if (this.options.adminEndpoints !== false && rawUrl.startsWith(ADMIN_PREFIX + "/")) {
      return this.handleAdmin(rawUrl, res);
    }

    const startedAt = Date.now();
    const routeLabel = this.options.gateway.findRoute(rawUrl)?.pathPrefix ?? "unmatched";
    const record = (status: number, target?: string) =>
      this.metrics.observe({ route: routeLabel, target, status, durationMs: Date.now() - startedAt });

    let target: string;
    try {
      target = this.options.gateway.routeRequest(rawUrl, {
        clientIp,
        headers: req.headers
      });
    } catch (err) {
      record(err instanceof GatewayError ? err.statusCode : 500);
      return this.sendError(res, err);
    }

    const breaker = this.getBreaker(target);
    if (!breaker.canExecute()) {
      record(503, target);
      return this.sendJson(res, 503, { error: `Circuit open for ${target}`, code: "CIRCUIT_OPEN" });
    }

    const route = this.options.gateway.findRoute(rawUrl);
    const upstreamPath = route ? this.options.gateway.rewritePath(rawUrl, route) : rawUrl;
    this.forward(req, res, target, upstreamPath, clientIp, breaker, record);
  }

  private handleAdmin(rawUrl: string, res: http.ServerResponse): void {
    const path = rawUrl.split("?")[0];
    const gw = this.options.gateway;
    if (path === ADMIN_PREFIX + "/health") {
      return this.sendJson(res, 200, { status: "ok", routes: gw.getRoutes().length });
    }
    if (path === ADMIN_PREFIX + "/metrics") {
      const targets = new Set<string>();
      for (const r of gw.getRoutes()) for (const t of r.targets) targets.add(typeof t === "string" ? t : t.url);
      const activeConnections: Record<string, number> = {};
      const unhealthyTargets: string[] = [];
      for (const t of targets) {
        activeConnections[t] = gw.getActiveConnections(t);
        if (!gw.isTargetHealthy(t)) unhealthyTargets.push(t);
      }
      const body = this.metrics.render({ activeConnections, unhealthyTargets });
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "content-length": Buffer.byteLength(body) });
      return void res.end(body);
    }
    this.sendJson(res, 404, { error: "Unknown admin endpoint", code: "NO_ROUTE" });
  }

  private forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: string,
    upstreamPath: string,
    clientIp: string,
    breaker: CircuitBreaker,
    record: (status: number, target?: string) => void
  ): void {
    const gw = this.options.gateway;
    const base = new URL(target);
    const transport = base.protocol === "https:" ? https : http;
    const basePath = base.pathname.replace(/\/$/, "");

    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key)) headers[key] = value;
    }
    headers.host = base.host;
    const inboundFor = this.options.trustProxy ? req.headers["x-forwarded-for"] : undefined;
    headers["x-forwarded-for"] = inboundFor ? `${inboundFor}, ${clientIp}` : clientIp;
    headers["x-forwarded-proto"] = "http";
    if (req.headers.host) headers["x-forwarded-host"] = req.headers.host;

    const startedAt = Date.now();
    gw.incrementActiveConnections(target);
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      gw.decrementActiveConnections(target);
      if (ok) {
        gw.recordLatency(target, Date.now() - startedAt);
        breaker.recordSuccess();
      } else {
        breaker.recordFailure();
      }
    };

    const upstream = transport.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || undefined,
        method: req.method,
        path: basePath + upstreamPath,
        headers,
        timeout: this.requestTimeoutMs
      },
      (upRes) => {
        const outHeaders: http.OutgoingHttpHeaders = {};
        for (const [key, value] of Object.entries(upRes.headers)) {
          if (!HOP_BY_HOP.has(key)) outHeaders[key] = value;
        }
        record(upRes.statusCode ?? 502, target);
        res.writeHead(upRes.statusCode ?? 502, outHeaders);
        upRes.pipe(res);
        upRes.on("end", () => settle((upRes.statusCode ?? 502) < 500));
        upRes.on("error", () => {
          settle(false);
          res.destroy();
        });
      }
    );

    upstream.on("timeout", () => {
      settle(false);
      upstream.destroy(new Error("upstream timeout"));
      record(504, target);
      this.sendJson(res, 504, { error: `Upstream timed out: ${target}`, code: "UPSTREAM_TIMEOUT" });
    });
    upstream.on("error", () => {
      if (!settled) record(502, target);
      settle(false);
      this.sendJson(res, 502, { error: `Upstream unreachable: ${target}`, code: "BAD_GATEWAY" });
    });

    // Client went away before the upstream answered: release the slot without blaming the target.
    res.on("close", () => {
      if (!res.writableFinished && !settled) {
        settled = true;
        gw.decrementActiveConnections(target);
        upstream.destroy();
      }
    });

    req.pipe(upstream);
  }

  private sendError(res: http.ServerResponse, err: unknown): void {
    if (err instanceof GatewayError) {
      const extra: Record<string, string> = {};
      if (err instanceof RateLimitError) {
        extra["retry-after"] = String(Math.max(1, Math.ceil(err.retryAfterMs / 1000)));
      }
      return this.sendJson(res, err.statusCode, { error: err.message, code: err.code }, extra);
    }
    this.sendJson(res, 500, { error: "Internal gateway error", code: "INTERNAL" });
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      ...headers
    });
    res.end(payload);
  }
}
