// In-process metrics for the single-instance demo. Exposed as Prometheus text on an admin-only
// endpoint; never includes identifiers, tokens or payment details (labels are fixed vocabularies).
import { monitorEventLoopDelay } from "node:perf_hooks";

type Labels = Record<string, string | number>;
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
const key = (name: string, labels: Labels = {}) => {
  const parts = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, "_")}"`);
  return parts.length ? `${name}{${parts.join(",")}}` : name;
};
// Hard bound on series so a label bug cannot grow memory without limit.
const MAX_SERIES = 5000;

class Histogram {
  counts = new Array(BUCKETS.length + 1).fill(0);
  sum = 0;
  n = 0;
  observe(v: number) {
    this.sum += v;
    this.n++;
    const i = BUCKETS.findIndex((b) => v <= b);
    this.counts[i < 0 ? BUCKETS.length : i]++;
  }
  /** Bucket-interpolated quantile (upper bound of the bucket holding q). */
  quantile(q: number) {
    if (!this.n) return 0;
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      seen += this.counts[i];
      if (seen >= q * this.n) return BUCKETS[i] ?? Infinity;
    }
    return Infinity;
  }
}

export class Metrics {
  private counters = new Map<string, number>();
  private histograms = new Map<string, Histogram>();
  private gauges = new Map<string, () => number>();
  private loop = monitorEventLoopDelay({ resolution: 20 });
  constructor() {
    this.loop.enable();
  }
  inc(name: string, labels?: Labels, n = 1) {
    const k = key(name, labels);
    if (!this.counters.has(k) && this.counters.size >= MAX_SERIES) return;
    this.counters.set(k, (this.counters.get(k) ?? 0) + n);
  }
  observe(name: string, ms: number, labels?: Labels) {
    const k = key(name, labels);
    let h = this.histograms.get(k);
    if (!h) {
      if (this.histograms.size >= MAX_SERIES) return;
      this.histograms.set(k, (h = new Histogram()));
    }
    h.observe(ms);
  }
  gauge(name: string, read: () => number, labels?: Labels) {
    this.gauges.set(key(name, labels), read);
  }
  counter(name: string, labels?: Labels) {
    return this.counters.get(key(name, labels)) ?? 0;
  }
  /** Sum of a counter across all label sets. */
  total(name: string) {
    let n = 0;
    for (const [k, v] of this.counters) if (k === name || k.startsWith(name + "{")) n += v;
    return n;
  }
  eventLoopLagMs() {
    return {
      p50: this.loop.percentile(50) / 1e6,
      p99: this.loop.percentile(99) / 1e6,
      max: this.loop.max / 1e6,
    };
  }
  resetEventLoop() {
    this.loop.reset();
  }
  histogram(name: string, labels?: Labels) {
    const h = this.histograms.get(key(name, labels));
    return h ? { n: h.n, p50: h.quantile(0.5), p95: h.quantile(0.95), p99: h.quantile(0.99), mean: h.sum / h.n } : null;
  }
  prometheus() {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [k, read] of this.gauges) {
      let v = NaN;
      try { v = read(); } catch { /* gauge source unavailable */ }
      lines.push(`${k} ${v}`);
    }
    for (const [k, h] of this.histograms) {
      const brace = k.indexOf("{");
      const name = brace < 0 ? k : k.slice(0, brace);
      const labels = brace < 0 ? "" : k.slice(brace + 1, -1);
      let cumulative = 0;
      BUCKETS.forEach((b, i) => {
        cumulative += h.counts[i];
        lines.push(`${name}_bucket{${labels ? labels + "," : ""}le="${b}"} ${cumulative}`);
      });
      lines.push(`${name}_bucket{${labels ? labels + "," : ""}le="+Inf"} ${h.n}`);
      lines.push(`${name}_sum${brace < 0 ? "" : `{${labels}}`} ${h.sum}`);
      lines.push(`${name}_count${brace < 0 ? "" : `{${labels}}`} ${h.n}`);
    }
    const lag = this.eventLoopLagMs();
    lines.push(`nodejs_eventloop_lag_p50_ms ${lag.p50}`, `nodejs_eventloop_lag_p99_ms ${lag.p99}`, `nodejs_eventloop_lag_max_ms ${lag.max}`);
    const mem = process.memoryUsage();
    lines.push(`process_resident_memory_bytes ${mem.rss}`, `nodejs_heap_used_bytes ${mem.heapUsed}`);
    return lines.join("\n") + "\n";
  }
}

export const metrics = new Metrics();
