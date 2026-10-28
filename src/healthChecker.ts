import { NexusGateway } from "./gateway";
import { normalizeTarget } from "./algorithms";

export interface HealthCheckerOptions {
  gateway: NexusGateway;
  /** Path probed on every target. */
  path?: string;
  intervalMs?: number;
  timeoutMs?: number;
  /** Consecutive failed probes before a target is ejected. */
  unhealthyThreshold?: number;
  /** Consecutive passing probes before an ejected target is restored. */
  healthyThreshold?: number;
  /** Override the probe, e.g. for TCP checks or tests. Resolves true when healthy. */
  probe?: (targetUrl: string, path: string, timeoutMs: number) => Promise<boolean>;
  onStateChange?: (targetUrl: string, healthy: boolean) => void;
}

export async function httpProbe(targetUrl: string, path: string, timeoutMs: number): Promise<boolean> {
  const url = new URL(path, targetUrl);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer();
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

export class HealthChecker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private passes = new Map<string, number>();
  private failures = new Map<string, number>();

  private readonly path: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly unhealthyThreshold: number;
  private readonly healthyThreshold: number;
  private readonly probe: NonNullable<HealthCheckerOptions["probe"]>;

  constructor(private options: HealthCheckerOptions) {
    this.path = options.path ?? "/health";
    this.intervalMs = options.intervalMs ?? 10_000;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.unhealthyThreshold = options.unhealthyThreshold ?? 3;
    this.healthyThreshold = options.healthyThreshold ?? 2;
    this.probe = options.probe ?? httpProbe;
    if (this.unhealthyThreshold < 1 || this.healthyThreshold < 1) {
      throw new Error("health thresholds must be >= 1");
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkAll(), this.intervalMs);
    this.timer.unref();
    void this.checkAll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Probe every distinct target once. Overlapping runs are skipped. */
  async checkAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const urls = new Set<string>();
      for (const route of this.options.gateway.getRoutes()) {
        for (const t of route.targets) urls.add(normalizeTarget(t).url);
      }
      await Promise.all([...urls].map((u) => this.checkOne(u)));
    } finally {
      this.running = false;
    }
  }

  private async checkOne(url: string): Promise<void> {
    const ok = await this.probe(url, this.path, this.timeoutMs);
    const gw = this.options.gateway;
    const wasHealthy = gw.isTargetHealthy(url);

    if (ok) {
      this.failures.set(url, 0);
      const streak = (this.passes.get(url) ?? 0) + 1;
      this.passes.set(url, streak);
      if (!wasHealthy && streak >= this.healthyThreshold) {
        gw.markTargetHealthy(url);
        this.options.onStateChange?.(url, true);
      }
    } else {
      this.passes.set(url, 0);
      const streak = (this.failures.get(url) ?? 0) + 1;
      this.failures.set(url, streak);
      if (wasHealthy && streak >= this.unhealthyThreshold) {
        gw.markTargetUnhealthy(url);
        this.options.onStateChange?.(url, false);
      }
    }
  }
}
