#!/usr/bin/env node
import { createGatewayFromConfig, loadConfig, ConfigError } from "./config";
import { HealthChecker } from "./healthChecker";
import { ProxyServer } from "./proxy";

function usage(): never {
  console.error("usage: nexus-gateway --config <path/to/gateway.json>");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--config");
  if (i === -1 || !args[i + 1]) usage();

  const config = loadConfig(args[i + 1]);
  const gateway = createGatewayFromConfig(config);
  const proxy = new ProxyServer({
    gateway,
    requestTimeoutMs: config.requestTimeoutMs,
    trustProxy: config.trustProxy,
    breaker: config.breaker,
  });

  const checker = config.healthCheck
    ? new HealthChecker({
        gateway,
        ...config.healthCheck,
        onStateChange: (url, healthy) =>
          console.log(`[health] ${url} -> ${healthy ? "UP" : "DOWN"}`),
      })
    : undefined;

  const addr = await proxy.listen(config.port, config.host);
  checker?.start();
  console.log(
    `[nexus] listening on ${addr.address}:${addr.port} with ${config.routes.length} route(s)`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[nexus] ${signal} received, draining`);
    checker?.stop();
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
