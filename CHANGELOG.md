# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/). Versions follow semver.

## [1.2.0] - Unreleased

### Added

- `ProxyServer`: real HTTP reverse proxy (header hygiene, `X-Forwarded-*`, timeouts, 502/503/504 mapping).
- Per-target circuit breaker wired into the proxy.
- `HealthChecker`: active probes with consecutive-failure/success thresholds.
- `Metrics` registry plus `/_nexus/metrics` (Prometheus) and `/_nexus/health`.
- JSON config loader (`parseConfig`/`loadConfig`) and `nexus-gateway` CLI.
- `removeRoute`, `getRoutes`, `findRoute`, `rewritePath`; `GatewayError` hierarchy with HTTP status codes.
- CI workflow (Node 20/22), LICENSE, CONTRIBUTING.

### Fixed

- Route matching now uses longest prefix on segment boundaries (`/api` no longer shadows `/api/v1/...` or matches `/apiary`).
- `stripPrefix` was declared but never applied.
- Duplicate or malformed route prefixes are rejected at registration.

## [1.1.0]

- P2C and canary balancers, consistent-hash ring with virtual nodes, circuit breaker, telemetry.

## [1.0.0]

- Round-robin, weighted round-robin, least-connections, IP-hash, latency-based balancing; token-bucket rate limiting.
