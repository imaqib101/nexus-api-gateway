import * as crypto from 'crypto';

export interface ConsistentHashOptions {
  virtualNodes?: number; // default 150
  hashFn?: (key: string) => number;
}

function defaultHashFn(key: string): number {
  const buf = crypto.createHash('md5').update(key).digest();
  // Read first 4 bytes as unsigned 32-bit big-endian integer
  return buf.readUInt32BE(0);
}

export class ConsistentHashRing {
  private ring: Map<number, string> = new Map();
  private sortedHashes: number[] = [];
  private readonly virtualNodes: number;
  private readonly hashFn: (key: string) => number;

  constructor(options: ConsistentHashOptions = {}) {
    this.virtualNodes = options.virtualNodes ?? 150;
    this.hashFn = options.hashFn ?? defaultHashFn;
  }

  addNode(node: string): void {
    for (let i = 0; i < this.virtualNodes; i++) {
      const virtualKey = `${node}#vnode_${i}`;
      const hash = this.hashFn(virtualKey);
      this.ring.set(hash, node);
    }
    this.rebuildSortedHashes();
  }

  removeNode(node: string): void {
    for (let i = 0; i < this.virtualNodes; i++) {
      const virtualKey = `${node}#vnode_${i}`;
      const hash = this.hashFn(virtualKey);
      this.ring.delete(hash);
    }
    this.rebuildSortedHashes();
  }

  getNode(key: string): string {
    if (this.sortedHashes.length === 0) {
      throw new Error('ConsistentHashRing is empty: add at least one node before routing');
    }

    const hash = this.hashFn(key);

    // Binary search: find the first hash >= target (clockwise successor)
    let low = 0;
    let high = this.sortedHashes.length - 1;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.sortedHashes[mid] < hash) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    // Wrap around: if hash is beyond all ring entries, use the first entry
    const idx = this.sortedHashes[low] >= hash ? low : 0;
    const ringHash = this.sortedHashes[idx];
    const node = this.ring.get(ringHash);

    if (node === undefined) {
      throw new Error(`Internal error: hash ${ringHash} not found in ring`);
    }

    return node;
  }

  getNodes(): string[] {
    const nodes = new Set<string>(this.ring.values());
    return Array.from(nodes);
  }

  getStats(): {
    nodeCount: number;
    virtualNodeCount: number;
    distribution: Record<string, number>;
  } {
    const nodes = this.getNodes();
    const distribution: Record<string, number> = {};

    for (const node of nodes) {
      distribution[node] = 0;
    }

    for (const node of this.ring.values()) {
      distribution[node] = (distribution[node] ?? 0) + 1;
    }

    return {
      nodeCount: nodes.length,
      virtualNodeCount: this.ring.size,
      distribution,
    };
  }

  private rebuildSortedHashes(): void {
    this.sortedHashes = Array.from(this.ring.keys()).sort((a, b) => a - b);
  }
}
