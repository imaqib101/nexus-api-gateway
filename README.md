# Nexus API Gateway ⚡

[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Vitest](https://img.shields.io/badge/Vitest-Tested-729B1B?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev/)
[![Rate Limiter](https://img.shields.io/badge/Token%20Bucket-Enforced-critical?style=for-the-badge)](https://en.wikipedia.org/wiki/Token_bucket)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

High-throughput, distributed-ready **Reverse Proxy & API Gateway** written in strict TypeScript. Features 5 adaptive load-balancing algorithms, dynamic health checking with automatic circuit ejection, and token-bucket rate limiting per route and IP.

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

| Strategy | Flag | Behavior & Use Case |
| :--- | :--- | :--- |
| **Weighted Round-Robin** | `weighted-round-robin` | Smooth interleaved distribution based on backend server capacity/weight |
| **Least Connections** | `least-connections` | Real-time active connection tracking, routing to least loaded node |
| **Consistent Hashing** | `ip-hash` | Ring hashing with 100 virtual replicas per node for cache & WebSocket affinity |
| **Latency-Aware** | `latency-based` | Exponential moving average (EMA, α=0.3) targeting lowest response latency |
| **Round-Robin** | `round-robin` | Sequential distribution across healthy targets |

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
    { url: "http://gpu-cluster-b:8080", weight: 1 }
  ],
  strategy: "weighted-round-robin",
  rateLimit: {
    capacity: 100, // max burst tokens
    refillRatePerSec: 20 // refill rate
  }
});

// Real-time routing decision
const backend = gateway.routeRequest("/api/v1/inference/generate", {
  clientIp: "203.0.113.195"
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

## 🧪 Testing

```bash
npm test
```

---

## 👤 Author

**Mohammed Aqib**
- GitHub: [@imaqib101](https://github.com/imaqib101)
- Location: Bengaluru, India
