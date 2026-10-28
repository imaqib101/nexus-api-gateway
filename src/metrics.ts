export interface RequestObservation {
  route: string;
  target?: string;
  status: number;
  durationMs: number;
}

const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

/** Minimal in-process metrics registry that renders Prometheus text format. */
export class Metrics {
  private requests = new Map<string, number>();
  private durations = new Map<string, Histogram>();
  private startedAt = Date.now();

  observe(o: RequestObservation): void {
    const labels = `route="${esc(o.route)}",target="${esc(o.target ?? "")}",status="${o.status}"`;
    this.requests.set(labels, (this.requests.get(labels) ?? 0) + 1);

    const hKey = `route="${esc(o.route)}"`;
    let h = this.durations.get(hKey);
    if (!h) {
      h = { buckets: new Array(BUCKETS_MS.length).fill(0), sum: 0, count: 0 };
      this.durations.set(hKey, h);
    }
    BUCKETS_MS.forEach((le, i) => {
      if (o.durationMs <= le) h!.buckets[i]++;
    });
    h.sum += o.durationMs;
    h.count++;
  }

  total(): number {
    let n = 0;
    for (const v of this.requests.values()) n += v;
    return n;
  }

  render(extra: { activeConnections?: Record<string, number>; unhealthyTargets?: string[] } = {}): string {
    const out: string[] = [];

    out.push("# HELP nexus_requests_total Requests handled by the gateway.");
    out.push("# TYPE nexus_requests_total counter");
    for (const [labels, v] of this.requests) out.push(`nexus_requests_total{${labels}} ${v}`);

    out.push("# HELP nexus_request_duration_ms Upstream request duration in milliseconds.");
    out.push("# TYPE nexus_request_duration_ms histogram");
    for (const [labels, h] of this.durations) {
      BUCKETS_MS.forEach((le, i) => out.push(`nexus_request_duration_ms_bucket{${labels},le="${le}"} ${h.buckets[i]}`));
      out.push(`nexus_request_duration_ms_bucket{${labels},le="+Inf"} ${h.count}`);
      out.push(`nexus_request_duration_ms_sum{${labels}} ${h.sum}`);
      out.push(`nexus_request_duration_ms_count{${labels}} ${h.count}`);
    }

    out.push("# HELP nexus_active_connections In-flight requests per target.");
    out.push("# TYPE nexus_active_connections gauge");
    for (const [t, v] of Object.entries(extra.activeConnections ?? {})) {
      out.push(`nexus_active_connections{target="${esc(t)}"} ${v}`);
    }

    out.push("# HELP nexus_target_healthy 1 if the target is in rotation.");
    out.push("# TYPE nexus_target_healthy gauge");
    for (const t of extra.unhealthyTargets ?? []) out.push(`nexus_target_healthy{target="${esc(t)}"} 0`);

    out.push("# HELP nexus_uptime_seconds Seconds since the registry was created.");
    out.push("# TYPE nexus_uptime_seconds gauge");
    out.push(`nexus_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`);

    return out.join("\n") + "\n";
  }
}

function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
