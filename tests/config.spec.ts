import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, createGatewayFromConfig, loadConfig, parseConfig } from "../src/config";

const valid = {
  port: 9000,
  routes: [{ pathPrefix: "/a", targets: ["http://a:1", { url: "http://b:1", weight: 2 }], strategy: "p2c" }]
};

describe("parseConfig", () => {
  it("accepts a valid config and applies defaults", () => {
    const c = parseConfig({ routes: valid.routes });
    expect(c.port).toBe(8080);
    expect(c.host).toBe("0.0.0.0");
  });

  it("reports every problem at once", () => {
    try {
      parseConfig({
        port: 99999,
        routes: [
          { pathPrefix: "a", targets: [] },
          { pathPrefix: "/b", targets: ["ftp://x"], strategy: "random", rateLimit: { capacity: 0 } },
          { pathPrefix: "/b", targets: ["http://x"], canaryPercent: 101 }
        ]
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toContain("port must be");
      expect(msg).toContain('routes[0].pathPrefix must be a string starting with "/"');
      expect(msg).toContain("routes[0].targets must be a non-empty array");
      expect(msg).toContain("routes[1].targets[0] needs an http(s) url");
      expect(msg).toContain("routes[1].strategy must be one of");
      expect(msg).toContain("routes[1].rateLimit needs");
      expect(msg).toContain('routes[2].pathPrefix "/b" is duplicated');
      expect(msg).toContain("routes[2].canaryPercent");
    }
  });

  it("rejects non-objects and empty route lists", () => {
    expect(() => parseConfig([])).toThrow(ConfigError);
    expect(() => parseConfig({ routes: [] })).toThrow(/non-empty array/);
  });
});

describe("loadConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-"));

  it("loads the shipped example", () => {
    const c = loadConfig(join(__dirname, "..", "examples", "gateway.json"));
    const gw = createGatewayFromConfig(c);
    expect(gw.getRoutes().length).toBe(2);
    expect(gw.routeRequest("/api/v1/inference/x")).toMatch(/gpu-cluster/);
  });

  it("fails loudly on missing files and bad JSON", () => {
    expect(() => loadConfig(join(dir, "missing.json"))).toThrow(/cannot read/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ nope");
    expect(() => loadConfig(bad)).toThrow(/not valid JSON/);
  });
});
