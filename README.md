# Nexus API Gateway ⚡

[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Vitest](https://img.shields.io/badge/Vitest-Tested-729B1B?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev/)
[![Rate Limiter](https://img.shields.io/badge/Token%20Bucket-Enforced-critical?style=for-the-badge)](https://en.wikipedia.org/wiki/Token_bucket)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/imaqib101/nexus-api-gateway/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/imaqib101/nexus-api-gateway/actions/workflows/ci.yml)

**Reverse Proxy & API Gateway** written in strict TypeScript. 7 load-balancing strategies, active health checks with hysteresis, per-target circuit breakers, token-bucket rate limiting per route and IP, Prometheus metrics, and a config-file-driven CLI. Use it as a library (`NexusGateway` for routing decisions) or run it as a proxy (`ProxyServer` / `nexus-gateway`).

---

## 🏗️ Architecture

```text
Incoming HTTP / WebSocket Traffic
              │
              ▼
┌──────────────────────────────────────────────┐
│             Nexus Gateway Engine             │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
       [ Token Bucket Rate Limiter ] ───► (Exceeded) ──► 429 Too Many Requests
                       │ (Allowed)
                       ▼
         [ Target Health Evaluation ] ───► Filter Unhealthy Nodes
                       │
                       ▼
         [ Multi-Strategy Balancer ]
         ├─ Weighted Round-Robin
         ├─ Least Active Connections
         ├─ Consistent IP-Hashing
         ├─ Latency-Aware (EMA)
         └─ Strict Round-Robin
                       │
                       ▼
   ┌───────────────────┼───────────────────┐
   ▼                   ▼                   ▼
[ Backend Srv 1 ]   [ Backend Srv 2 ]   [ Backend Srv 3 ]
```

---

## ⚙️ Load Balancing Strategies

| Strategy                 | Flag                   | Behavior & Use Case                                                                 |
| :----------------------- | :--------------------- | :---------------------------------------------------------------------------------- |
| **Weighted Round-Robin** | `weighted-round-robin` | Smooth interleaved distribution based on backend server capacity/weight             |
| **Least Connections**    | `least-connections`    | Real-time active connection tracking, routing to least loaded node                  |
| **Consistent Hashing**   | `ip-hash`              | Ring hashing with 100 virtual replicas per node for cache & WebSocket affinity      |
| **Latency-Aware**        | `latency-based`        | Exponential moving average (EMA, α=0.3) targeting lowest response latency           |
| **Round-Robin**          | `round-robin`          | Sequential distribution across healthy targets                                      |
| **Power of Two Choices** | `p2c`                  | Samples two healthy nodes, picks the one with fewer active connections              |
| **Canary**               | `canary`               | Sends a configurable percentage (or `x-canary` header traffic) to the second target |

---

## 🚀 Quick Start

```typescript
import { NexusGateway } from "nexus-api-gateway";

const gateway = new NexusGateway();

// Register AI Inference cluster with Weighted Load Balancing & Token Bucket Rate Limiting
gateway.addRoute({
  pathPrefix: "/api/v1/inference",
  targets: [
    { url: "http://gpu-cluster-a:8080", weight: 3 },
    { url: "http://gpu-cluster-b:8080", weight: 1 },
  ],
  strategy: "weighted-round-robin",
  rateLimit: {
    capacity: 100, // max burst tokens
    refillRatePerSec: 20, // refill rate
  },
});

// Real-time routing decision
const backend = gateway.routeRequest("/api/v1/inference/generate", {
  clientIp: "203.0.113.195",
});
console.log(`Routed to: ${backend}`);
```

---

## 🛡️ Health Checking & Fault Tolerance

```typescript
// Dynamically eject failing nodes
gateway.markTargetUnhealthy("http://gpu-cluster-b:8080");

// Traffic immediately routes exclusively to healthy nodes with zero downtime
const activeBackend = gateway.routeRequest("/api/v1/inference/generate");

// Mark restored upon passing health probes
gateway.markTargetHealthy("http://gpu-cluster-b:8080");
```

---

## 🌐 Running as a proxy

```bash
npm run build
node dist/cli.js --config examples/gateway.json
```

```typescript
import { NexusGateway, ProxyServer, HealthChecker } from "nexus-api-gateway";

const gateway = new NexusGateway();
gateway.addRoute({
  pathPrefix: "/api",
  targets: ["http://app-1:3000", "http://app-2:3000"],
  stripPrefix: true,
});

const proxy = new ProxyServer({
  gateway,
  requestTimeoutMs: 15_000,
  breaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
});
await proxy.listen(8080);
new HealthChecker({ gateway, path: "/health" }).start();
```

| Condition            | Response                           |
| :------------------- | :--------------------------------- |
| No matching route    | `404 NO_ROUTE`                     |
| Rate limit hit       | `429 RATE_LIMITED` + `Retry-After` |
| All targets ejected  | `503 NO_HEALTHY_TARGET`            |
| Target circuit open  | `503 CIRCUIT_OPEN`                 |
| Upstream unreachable | `502 BAD_GATEWAY`                  |
| Upstream timeout     | `504 UPSTREAM_TIMEOUT`             |

Routing uses **longest-prefix match** on path segment boundaries, so `/api/v1/inference` wins over `/api`, and `/apiary` does not match `/api`.

**Admin endpoints** (disable with `adminEndpoints: false`): `GET /_nexus/health`, `GET /_nexus/metrics` (Prometheus text format: request counts by route/target/status, latency histogram, active connections, ejected targets).

---

## 🧪 Testing

```bash
npm test             # run the Vitest suites
npm run test:coverage
```

---

## 🛠️ Development

```bash
npm ci
npm run lint          # ESLint
npm run format:check  # Prettier (use `npm run format` to fix)
npm run typecheck
npm run build
```

Node.js 20 or newer is required (see `.nvmrc`). See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

---

## 👤 Author

**Mohammed Aqib**

- GitHub: [@imaqib101](https://github.com/imaqib101)
- Location: Bengaluru, India
