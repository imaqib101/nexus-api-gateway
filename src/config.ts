import { readFileSync } from "node:fs";
import { NexusGateway, type RouteRule, type RoutingStrategy } from "./gateway";
import type { CircuitBreakerOptions } from "./circuitBreaker";
import type { HealthCheckerOptions } from "./healthChecker";

export interface NexusConfig {
  port: number;
  host: string;
  requestTimeoutMs?: number;
  trustProxy?: boolean;
  breaker?: CircuitBreakerOptions;
  healthCheck?: Pick<
    HealthCheckerOptions,
    "path" | "intervalMs" | "timeoutMs" | "unhealthyThreshold" | "healthyThreshold"
  >;
  routes: RouteRule[];
}

const STRATEGIES: RoutingStrategy[] = [
  "round-robin",
  "least-connections",
  "weighted-round-robin",
  "ip-hash",
  "latency-based",
  "p2c",
  "canary",
];

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid gateway config:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positive(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Validate untrusted JSON and return a typed config, or throw ConfigError listing every problem. */
export function parseConfig(raw: unknown): NexusConfig {
  const problems: string[] = [];
  if (!isObj(raw)) throw new ConfigError(["config must be a JSON object"]);

  const port = raw.port ?? 8080;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    problems.push("port must be an integer between 0 and 65535");
  }
  const host = raw.host ?? "0.0.0.0";
  if (typeof host !== "string" || host === "") problems.push("host must be a non-empty string");

  for (const key of ["requestTimeoutMs"] as const) {
    if (raw[key] !== undefined && !positive(raw[key]))
      problems.push(`${key} must be a positive number`);
  }
  if (raw.trustProxy !== undefined && typeof raw.trustProxy !== "boolean")
    problems.push("trustProxy must be a boolean");

  if (raw.breaker !== undefined) {
    if (
      !isObj(raw.breaker) ||
      !positive(raw.breaker.failureThreshold) ||
      !positive(raw.breaker.resetTimeoutMs)
    ) {
      problems.push("breaker needs positive failureThreshold and resetTimeoutMs");
    }
  }
  if (raw.healthCheck !== undefined && !isObj(raw.healthCheck))
    problems.push("healthCheck must be an object");

  const routes = raw.routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    problems.push("routes must be a non-empty array");
  } else {
    const seen = new Set<string>();
    routes.forEach((r, i) => {
      const at = `routes[${i}]`;
      if (!isObj(r)) return void problems.push(`${at} must be an object`);
      if (typeof r.pathPrefix !== "string" || !r.pathPrefix.startsWith("/")) {
        problems.push(`${at}.pathPrefix must be a string starting with "/"`);
      } else if (seen.has(r.pathPrefix)) {
        problems.push(`${at}.pathPrefix "${r.pathPrefix}" is duplicated`);
      } else {
        seen.add(r.pathPrefix);
      }
      if (!Array.isArray(r.targets) || r.targets.length === 0) {
        problems.push(`${at}.targets must be a non-empty array`);
      } else {
        r.targets.forEach((t, j) => {
          const url = typeof t === "string" ? t : isObj(t) ? t.url : undefined;
          if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
            problems.push(`${at}.targets[${j}] needs an http(s) url`);
          }
          if (isObj(t) && t.weight !== undefined && !positive(t.weight)) {
            problems.push(`${at}.targets[${j}].weight must be positive`);
          }
        });
      }
      if (r.strategy !== undefined && !STRATEGIES.includes(r.strategy as RoutingStrategy)) {
        problems.push(`${at}.strategy must be one of ${STRATEGIES.join(", ")}`);
      }
      if (r.rateLimit !== undefined) {
        if (
          !isObj(r.rateLimit) ||
          !positive(r.rateLimit.capacity) ||
          !positive(r.rateLimit.refillRatePerSec)
        ) {
          problems.push(`${at}.rateLimit needs positive capacity and refillRatePerSec`);
        }
      }
      if (
        r.canaryPercent !== undefined &&
        (typeof r.canaryPercent !== "number" || r.canaryPercent < 0 || r.canaryPercent > 100)
      ) {
        problems.push(`${at}.canaryPercent must be between 0 and 100`);
      }
    });
  }

  if (problems.length) throw new ConfigError(problems);
  return { ...(raw as unknown as NexusConfig), port: port as number, host: host as string };
}

export function loadConfig(path: string): NexusConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError([`cannot read ${path}: ${(err as Error).message}`]);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError([`${path} is not valid JSON: ${(err as Error).message}`]);
  }
  return parseConfig(json);
}

export function createGatewayFromConfig(config: NexusConfig): NexusGateway {
  const gateway = new NexusGateway();
  for (const route of config.routes) gateway.addRoute(route);
  return gateway;
}
