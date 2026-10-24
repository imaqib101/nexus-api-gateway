export interface WeightedTarget {
  url: string;
  weight?: number;
}

export type TargetInput = string | WeightedTarget;

export function normalizeTarget(target: TargetInput): WeightedTarget {
  if (typeof target === "string") {
    return { url: target, weight: 1 };
  }
  return { url: target.url, weight: target.weight ?? 1 };
}

export class RoundRobinBalancer {
  private counter = 0;

  select(targets: string[]): string {
    if (targets.length === 0) throw new Error("No healthy targets available");
    const target = targets[this.counter % targets.length];
    this.counter = (this.counter + 1) % Number.MAX_SAFE_INTEGER;
    return target;
  }
}

export class WeightedRoundRobinBalancer {
  private currentWeights: Map<string, number> = new Map();

  select(targets: WeightedTarget[]): string {
    if (targets.length === 0) throw new Error("No healthy targets available");
    if (targets.length === 1) return targets[0].url;

    let totalWeight = 0;
    let bestTarget: WeightedTarget | null = null;
    let maxWeight = -Infinity;

    for (const t of targets) {
      const weight = Math.max(1, t.weight ?? 1);
      totalWeight += weight;

      const current = (this.currentWeights.get(t.url) ?? 0) + weight;
      this.currentWeights.set(t.url, current);

      if (current > maxWeight) {
        maxWeight = current;
        bestTarget = t;
      }
    }

    if (bestTarget) {
      this.currentWeights.set(bestTarget.url, maxWeight - totalWeight);
      return bestTarget.url;
    }

    return targets[0].url;
  }
}

export class LeastConnectionsBalancer {
  select(targets: string[], activeConnections: Map<string, number>): string {
    if (targets.length === 0) throw new Error("No healthy targets available");

    let leastTarget = targets[0];
    let minConns = activeConnections.get(leastTarget) ?? 0;

    for (let i = 1; i < targets.length; i++) {
      const target = targets[i];
      const conns = activeConnections.get(target) ?? 0;
      if (conns < minConns) {
        minConns = conns;
        leastTarget = target;
      }
    }

    return leastTarget;
  }
}

export class ConsistentHashBalancer {
  private ring: { hash: number; targetUrl: string }[] = [];
  private replicas: number;

  constructor(replicas = 100) {
    this.replicas = replicas;
  }

  private hashKey(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash;
  }

  updateTargets(targets: string[]): void {
    this.ring = [];
    for (const target of targets) {
      for (let r = 0; r < this.replicas; r++) {
        const replicaKey = `${target}#replica_${r}`;
        const hash = this.hashKey(replicaKey);
        this.ring.push({ hash, targetUrl: target });
      }
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  select(clientKey: string): string {
    if (this.ring.length === 0) throw new Error("No targets mapped in hash ring");

    const hash = this.hashKey(clientKey);
    let low = 0;
    let high = this.ring.length - 1;

    // Binary search for upper bound in the ring
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.ring[mid].hash >= hash) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    const idx = low < this.ring.length ? low : 0;
    return this.ring[idx].targetUrl;
  }
}

export class LatencyBasedBalancer {
  select(targets: string[], latenciesEma: Map<string, number>): string {
    if (targets.length === 0) throw new Error("No healthy targets available");

    let bestTarget = targets[0];
    let minLatency = latenciesEma.get(bestTarget) ?? 0;

    for (let i = 1; i < targets.length; i++) {
      const target = targets[i];
      const lat = latenciesEma.get(target) ?? 0;
      if (lat < minLatency) {
        minLatency = lat;
        bestTarget = target;
      }
    }

    return bestTarget;
  }
}
