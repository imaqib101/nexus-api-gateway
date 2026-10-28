import {
  TargetInput,
  normalizeTarget,
  RoundRobinBalancer,
  WeightedRoundRobinBalancer,
  LeastConnectionsBalancer,
  ConsistentHashBalancer,
  LatencyBasedBalancer,
  PowerOfTwoChoicesBalancer,
  CanaryRoutingBalancer,
} from "./algorithms";
import { TokenBucketRateLimiter, type RateLimitConfig } from "./rateLimiter";

export type RoutingStrategy =
  | "round-robin"
  | "least-connections"
  | "weighted-round-robin"
  | "ip-hash"
  | "latency-based"
  | "p2c"
  | "canary";

export interface RouteRule {
  pathPrefix: string;
  targets: TargetInput[];
  strategy?: RoutingStrategy;
  rateLimit?: RateLimitConfig;
  stripPrefix?: boolean;
  canaryPercent?: number;
  canaryHeaderKey?: string;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NoRouteError extends GatewayError {
  constructor(path: string) {
    super(`No route found for path: ${path}`, 404, "NO_ROUTE");
  }
}

export class RateLimitError extends GatewayError {
  constructor(
    readonly pathPrefix: string,
    readonly retryAfterMs: number,
  ) {
    super(
      `Rate limit exceeded for route "${pathPrefix}". Retry after ${retryAfterMs}ms`,
      429,
      "RATE_LIMITED",
    );
  }
}

export class NoHealthyTargetError extends GatewayError {
  constructor(pathPrefix: string) {
    super(`All backend targets are unhealthy for route: ${pathPrefix}`, 503, "NO_HEALTHY_TARGET");
  }
}

export interface RouteRequestOptions {
  clientIp?: string;
  sessionKey?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export class NexusGateway {
  private routes: RouteRule[] = [];
  private unhealthyTargets = new Set<string>();
  private activeConnections = new Map<string, number>();
  private latenciesEma = new Map<string, number>();

  private roundRobinBalancers = new Map<string, RoundRobinBalancer>();
  private weightedBalancers = new Map<string, WeightedRoundRobinBalancer>();
  private leastConnBalancer = new LeastConnectionsBalancer();
  private hashBalancers = new Map<string, ConsistentHashBalancer>();
  private latencyBalancer = new LatencyBasedBalancer();
  private p2cBalancer = new PowerOfTwoChoicesBalancer();
  private canaryBalancers = new Map<string, CanaryRoutingBalancer>();
  private rateLimiters = new Map<string, TokenBucketRateLimiter>();

  addRoute(rule: RouteRule) {
    if (!rule.pathPrefix.startsWith("/")) {
      throw new Error(`pathPrefix must start with "/": ${rule.pathPrefix}`);
    }
    if (this.routes.some((r) => r.pathPrefix === rule.pathPrefix)) {
      throw new Error(`Route already registered for prefix: ${rule.pathPrefix}`);
    }
    this.routes.push(rule);
    const normalized = rule.targets.map(normalizeTarget);

    if (rule.rateLimit) {
      this.rateLimiters.set(rule.pathPrefix, new TokenBucketRateLimiter(rule.rateLimit));
    }

    // Initialize consistent hash ring if needed
    if (rule.strategy === "ip-hash") {
      const hasher = new ConsistentHashBalancer();
      hasher.updateTargets(normalized.map((t) => t.url));
      this.hashBalancers.set(rule.pathPrefix, hasher);
    }
  }

  removeRoute(pathPrefix: string): boolean {
    const before = this.routes.length;
    this.routes = this.routes.filter((r) => r.pathPrefix !== pathPrefix);
    this.rateLimiters.delete(pathPrefix);
    this.roundRobinBalancers.delete(pathPrefix);
    this.weightedBalancers.delete(pathPrefix);
    this.hashBalancers.delete(pathPrefix);
    this.canaryBalancers.delete(pathPrefix);
    return this.routes.length < before;
  }

  getRoutes(): readonly RouteRule[] {
    return this.routes;
  }

  /**
   * Longest-prefix match on path segment boundaries, so "/api" matches
   * "/api" and "/api/users" but not "/apiary".
   */
  findRoute(path: string): RouteRule | undefined {
    let best: RouteRule | undefined;
    for (const r of this.routes) {
      if (!matchesPrefix(path, r.pathPrefix)) continue;
      if (!best || r.pathPrefix.length > best.pathPrefix.length) best = r;
    }
    return best;
  }

  /** Path as seen by the upstream, honouring `stripPrefix`. */
  rewritePath(path: string, route: RouteRule): string {
    if (!route.stripPrefix) return path;
    const rest = path.slice(route.pathPrefix.length);
    if (rest === "" || rest.startsWith("?")) return "/" + rest;
    return rest.startsWith("/") ? rest : "/" + rest;
  }

  markTargetUnhealthy(targetUrl: string) {
    this.unhealthyTargets.add(targetUrl);
    this.refreshHashRings();
  }

  markTargetHealthy(targetUrl: string) {
    this.unhealthyTargets.delete(targetUrl);
    this.refreshHashRings();
  }

  isTargetHealthy(targetUrl: string): boolean {
    return !this.unhealthyTargets.has(targetUrl);
  }

  incrementActiveConnections(targetUrl: string): void {
    const current = this.activeConnections.get(targetUrl) ?? 0;
    this.activeConnections.set(targetUrl, current + 1);
  }

  decrementActiveConnections(targetUrl: string): void {
    const current = this.activeConnections.get(targetUrl) ?? 0;
    this.activeConnections.set(targetUrl, Math.max(0, current - 1));
  }

  getActiveConnections(targetUrl: string): number {
    return this.activeConnections.get(targetUrl) ?? 0;
  }

  recordLatency(targetUrl: string, durationMs: number): void {
    const previous = this.latenciesEma.get(targetUrl);
    if (previous === undefined) {
      this.latenciesEma.set(targetUrl, durationMs);
    } else {
      // EMA with alpha = 0.3
      const updated = 0.3 * durationMs + 0.7 * previous;
      this.latenciesEma.set(targetUrl, updated);
    }
  }

  routeRequest(path: string, options: RouteRequestOptions = {}): string {
    const route = this.findRoute(path);
    if (!route || route.targets.length === 0) {
      throw new NoRouteError(path);
    }

    // Check rate limit if configured
    if (route.rateLimit) {
      const limiter = this.rateLimiters.get(route.pathPrefix);
      const clientKey = options.clientIp ?? "global";
      const check = limiter?.consume(clientKey);
      if (check && !check.allowed) {
        throw new RateLimitError(route.pathPrefix, check.retryAfterMs ?? 0);
      }
    }

    const allNormalized = route.targets.map(normalizeTarget);
    const healthyTargets = allNormalized.filter((t) => !this.unhealthyTargets.has(t.url));

    if (healthyTargets.length === 0) {
      throw new NoHealthyTargetError(route.pathPrefix);
    }

    const strategy = route.strategy ?? "round-robin";

    switch (strategy) {
      case "weighted-round-robin": {
        let balancer = this.weightedBalancers.get(route.pathPrefix);
        if (!balancer) {
          balancer = new WeightedRoundRobinBalancer();
          this.weightedBalancers.set(route.pathPrefix, balancer);
        }
        return balancer.select(healthyTargets);
      }

      case "least-connections": {
        return this.leastConnBalancer.select(
          healthyTargets.map((t) => t.url),
          this.activeConnections,
        );
      }

      case "ip-hash": {
        let balancer = this.hashBalancers.get(route.pathPrefix);
        if (!balancer) {
          balancer = new ConsistentHashBalancer();
          balancer.updateTargets(healthyTargets.map((t) => t.url));
          this.hashBalancers.set(route.pathPrefix, balancer);
        }
        const clientKey = options.clientIp || options.sessionKey || "default_client";
        return balancer.select(clientKey);
      }

      case "latency-based": {
        return this.latencyBalancer.select(
          healthyTargets.map((t) => t.url),
          this.latenciesEma,
        );
      }

      case "p2c": {
        return this.p2cBalancer.select(
          healthyTargets.map((t) => t.url),
          this.activeConnections,
        );
      }

      case "canary": {
        let balancer = this.canaryBalancers.get(route.pathPrefix);
        if (!balancer) {
          const stable = healthyTargets[0].url;
          const canary = healthyTargets.length > 1 ? healthyTargets[1].url : stable;
          balancer = new CanaryRoutingBalancer({
            stableTarget: stable,
            canaryTarget: canary,
            canaryWeightPercent: route.canaryPercent ?? 10,
            canaryHeaderKey: route.canaryHeaderKey ?? "x-canary",
          });
          this.canaryBalancers.set(route.pathPrefix, balancer);
        }
        return balancer.select({
          headers: options.headers,
          clientKey: options.clientIp || options.sessionKey,
        });
      }

      case "round-robin":
      default: {
        let balancer = this.roundRobinBalancers.get(route.pathPrefix);
        if (!balancer) {
          balancer = new RoundRobinBalancer();
          this.roundRobinBalancers.set(route.pathPrefix, balancer);
        }
        return balancer.select(healthyTargets.map((t) => t.url));
      }
    }
  }

  private refreshHashRings() {
    for (const route of this.routes) {
      if (route.strategy === "ip-hash") {
        const healthy = route.targets
          .map(normalizeTarget)
          .filter((t) => !this.unhealthyTargets.has(t.url))
          .map((t) => t.url);
        const balancer = this.hashBalancers.get(route.pathPrefix);
        if (balancer) {
          balancer.updateTargets(healthy);
        }
      }
    }
  }
}

function matchesPrefix(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  if (prefix.endsWith("/") || path.length === prefix.length) return true;
  const next = path[prefix.length];
  return next === "/" || next === "?" || next === "#";
}
