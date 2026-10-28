import { describe, it, expect, beforeEach } from "vitest";
import { ConsistentHashRing } from "../src/algorithms/consistentHash";

describe("ConsistentHashRing", () => {
  let ring: ConsistentHashRing;

  beforeEach(() => {
    ring = new ConsistentHashRing({ virtualNodes: 100 });
  });

  it("routes a key to a node after addNode", () => {
    ring.addNode("node-A");
    const result = ring.getNode("some-request-key");
    expect(result).toBe("node-A");
  });

  it("returns the same node for the same key (determinism)", () => {
    ring.addNode("node-A");
    ring.addNode("node-B");
    ring.addNode("node-C");

    const key = "user-session-42";
    const first = ring.getNode(key);
    // Call multiple times to confirm determinism
    for (let i = 0; i < 20; i++) {
      expect(ring.getNode(key)).toBe(first);
    }
  });

  it("throws on getNode when ring is empty", () => {
    expect(() => ring.getNode("any-key")).toThrow("ConsistentHashRing is empty");
  });

  it("redistributes keys correctly after removeNode", () => {
    ring.addNode("node-A");
    ring.addNode("node-B");
    ring.addNode("node-C");

    // Collect routing for 300 keys
    const keys = Array.from({ length: 300 }, (_, i) => `key-${i}`);
    const routingBefore = new Map<string, string>(keys.map((k) => [k, ring.getNode(k)]));

    ring.removeNode("node-B");

    let redistributed = 0;
    let routedToRemovedNode = 0;

    for (const k of keys) {
      const after = ring.getNode(k);
      expect(after).not.toBe("node-B"); // B is gone — must never land on B
      if (routingBefore.get(k) !== after) {
        redistributed++;
      }
      if (routingBefore.get(k) === "node-B") {
        routedToRemovedNode++;
      }
    }

    // Keys previously on node-B are redistributed
    expect(redistributed).toBe(routedToRemovedNode);
    // Remaining nodes still serve traffic
    expect(redistributed).toBeGreaterThan(0);
  });

  it("distributes keys roughly evenly across nodes (within 3x)", () => {
    ring.addNode("node-A");
    ring.addNode("node-B");
    ring.addNode("node-C");

    const counts: Record<string, number> = { "node-A": 0, "node-B": 0, "node-C": 0 };
    const total = 3000;

    for (let i = 0; i < total; i++) {
      const node = ring.getNode(`request-key-${i}-uuid-${Math.random()}`);
      counts[node] = (counts[node] ?? 0) + 1;
    }

    const values = Object.values(counts);
    const minCount = Math.min(...values);
    const maxCount = Math.max(...values);

    // No node should have more than 3× the traffic of the least-loaded node
    expect(maxCount).toBeLessThanOrEqual(minCount * 3);
    // Every node should have received at least some traffic
    expect(minCount).toBeGreaterThan(0);
  });

  it("getStats returns correct nodeCount, virtualNodeCount, and distribution", () => {
    ring.addNode("node-A");
    ring.addNode("node-B");

    const stats = ring.getStats();

    expect(stats.nodeCount).toBe(2);
    expect(stats.virtualNodeCount).toBe(200); // 2 nodes × 100 virtual nodes
    expect(Object.keys(stats.distribution)).toHaveLength(2);
    // Distribution entries should sum to virtualNodeCount
    const distSum = Object.values(stats.distribution).reduce((a, b) => a + b, 0);
    expect(distSum).toBe(stats.virtualNodeCount);
  });

  it("getNodes returns only unique physical nodes", () => {
    ring.addNode("node-X");
    ring.addNode("node-Y");
    ring.addNode("node-Z");

    const nodes = ring.getNodes();
    expect(nodes).toHaveLength(3);
    expect(nodes.sort()).toEqual(["node-X", "node-Y", "node-Z"]);
  });

  it("handles a single node — all keys route to it", () => {
    ring.addNode("only-node");
    for (let i = 0; i < 50; i++) {
      expect(ring.getNode(`key-${i}`)).toBe("only-node");
    }
  });
});
