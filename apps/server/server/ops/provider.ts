// Shared guard for every external provider (GitHub, NEAR RPC, Base RPC, Monerium):
// bounded concurrency, an hourly request budget, timeouts, a circuit breaker with controlled
// half-open recovery, provider-requested pauses (Retry-After / rate-limit reset) and
// single-flight de-duplication of identical in-flight reads.
import { metrics } from "./metrics.ts";
import { log } from "./log.ts";

export class ProviderUnavailable extends Error {
  constructor(readonly provider: string, readonly retryAt: number, reason: string) {
    super(`${provider} temporarily unavailable (${reason}); retrying after ${new Date(retryAt).toISOString()}`);
    this.name = "ProviderUnavailable";
  }
}
/** Thrown by a call to tell the gate the provider itself is failing (5xx, 429, timeout). */
export class ProviderFailure extends Error {
  constructor(message: string, readonly retryAfterMs?: number, readonly status?: number) {
    super(message);
    this.name = "ProviderFailure";
  }
}

/** Equal-jitter exponential backoff: half fixed, half random, capped. */
export function backoff(attempt: number, baseMs: number, capMs: number, random = Math.random) {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export function retryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - now, 3_600_000)) : undefined;
}

export interface GateOptions {
  concurrency?: number;
  hourlyBudget?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  openMs?: number;
  maxQueue?: number;
}

export class ProviderGate {
  private active = 0;
  private waiting: (() => void)[] = [];
  private tokens: number;
  private refilledAt: number;
  private failures = 0;
  private openUntil = 0;
  private halfOpen = false;
  private pausedUntil = 0;
  private inflight = new Map<string, Promise<unknown>>();
  readonly opts: Required<GateOptions>;
  constructor(readonly name: string, options: GateOptions = {}, private readonly now = () => Date.now(), track = true) {
    this.opts = { concurrency: 4, hourlyBudget: 3600, timeoutMs: 15_000, failureThreshold: 5, openMs: 30_000, maxQueue: 200, ...options };
    this.tokens = this.opts.hourlyBudget;
    this.refilledAt = this.now();
    if (!track) return;
    metrics.gauge("provider_inflight", () => this.active, { provider: name });
    metrics.gauge("provider_queue", () => this.waiting.length, { provider: name });
    metrics.gauge("provider_circuit_open", () => (this.openUntil > this.now() ? 1 : 0), { provider: name });
  }
  state() {
    const now = this.now();
    return { provider: this.name, inflight: this.active, queued: this.waiting.length, budget: Math.floor(this.refill()), circuit: this.openUntil > now ? "open" : this.halfOpen ? "half-open" : "closed", pausedUntil: this.pausedUntil > now ? new Date(this.pausedUntil).toISOString() : null, consecutiveFailures: this.failures };
  }
  /** Degraded = calls are currently refused; the server itself remains available. */
  degraded() {
    const now = this.now();
    return this.openUntil > now || this.pausedUntil > now;
  }
  private refill() {
    const now = this.now();
    this.tokens = Math.min(this.opts.hourlyBudget, this.tokens + ((now - this.refilledAt) / 3_600_000) * this.opts.hourlyBudget);
    this.refilledAt = now;
    return this.tokens;
  }
  /** Respect a provider-requested pause (Retry-After, X-RateLimit-Reset). */
  pause(untilMs: number, reason = "rate limited") {
    if (untilMs > this.pausedUntil) {
      this.pausedUntil = untilMs;
      metrics.inc("provider_pauses_total", { provider: this.name });
      log("warn", "provider.pause", { provider: this.name, reason, until: new Date(untilMs).toISOString() });
    }
  }
  private admit(cost: number) {
    const now = this.now();
    if (this.pausedUntil > now) {
      metrics.inc("provider_rejected_total", { provider: this.name, reason: "paused" });
      throw new ProviderUnavailable(this.name, this.pausedUntil, "rate limit");
    }
    if (this.openUntil > now) {
      metrics.inc("provider_rejected_total", { provider: this.name, reason: "circuit" });
      throw new ProviderUnavailable(this.name, this.openUntil, "circuit open");
    }
    if (this.openUntil && !this.halfOpen) this.halfOpen = true; // first call after the open period is the probe
    if (this.refill() < cost) {
      metrics.inc("provider_rejected_total", { provider: this.name, reason: "budget" });
      const wait = ((cost - this.tokens) / this.opts.hourlyBudget) * 3_600_000;
      throw new ProviderUnavailable(this.name, now + Math.ceil(wait), "request budget exhausted");
    }
    this.tokens -= cost;
  }
  private async slot() {
    if (this.active < this.opts.concurrency) {
      this.active++;
      return;
    }
    if (this.waiting.length >= this.opts.maxQueue) {
      metrics.inc("provider_rejected_total", { provider: this.name, reason: "queue" });
      throw new ProviderUnavailable(this.name, this.now() + 1000, "queue full");
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
  }
  private release() {
    this.active--;
    this.waiting.shift()?.();
  }
  private success() {
    if (this.halfOpen || this.failures) log("info", "provider.recovered", { provider: this.name });
    this.failures = 0;
    this.halfOpen = false;
    this.openUntil = 0;
  }
  private failure(error: ProviderFailure) {
    this.failures++;
    if (error.retryAfterMs !== undefined) this.pause(this.now() + error.retryAfterMs, error.message);
    if (this.halfOpen || this.failures >= this.opts.failureThreshold) {
      const open = backoff(Math.min(this.failures - this.opts.failureThreshold, 5), this.opts.openMs, this.opts.openMs * 16);
      this.openUntil = this.now() + Math.max(open, this.opts.openMs / 2);
      this.halfOpen = false;
      metrics.inc("provider_circuit_opened_total", { provider: this.name });
      log("warn", "provider.circuit_open", { provider: this.name, failures: this.failures, until: new Date(this.openUntil).toISOString() });
    }
  }
  /**
   * Run one provider call. `key` de-duplicates identical concurrent reads: callers share the
   * first promise. Writes must not pass a key.
   */
  run<T>(call: (signal: AbortSignal) => Promise<T>, options: { key?: string; cost?: number; op?: string; enforceTimeout?: boolean } = {}): Promise<T> {
    if (options.key) {
      const pending = this.inflight.get(options.key);
      if (pending) {
        metrics.inc("provider_singleflight_hits_total", { provider: this.name });
        return pending as Promise<T>;
      }
    }
    const promise = this.execute(call, options.cost ?? 1, options.op ?? "call", options.enforceTimeout ?? true);
    if (options.key) {
      const k = options.key;
      this.inflight.set(k, promise);
      promise.then(() => this.inflight.delete(k), () => this.inflight.delete(k));
    }
    return promise;
  }
  private async execute<T>(call: (signal: AbortSignal) => Promise<T>, cost: number, op: string, enforce: boolean): Promise<T> {
    this.admit(cost);
    await this.slot();
    const started = this.now();
    const signal = AbortSignal.timeout(this.opts.timeoutMs);
    let timer: NodeJS.Timeout | undefined;
    try {
      // Reads: give up after the timeout even if the client library ignores the signal. Writes pass
      // enforceTimeout:false: abandoning a transaction mid-flight would only hide its outcome.
      const value = enforce
        ? await Promise.race([
            call(signal),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(Object.assign(new Error(`${this.name} timed out`), { name: "TimeoutError" })), this.opts.timeoutMs);
            }),
          ])
        : await call(signal);
      this.success();
      metrics.inc("provider_calls_total", { provider: this.name, op, result: "ok" });
      return value;
    } catch (error) {
      const timeout = (error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError" || signal.aborted;
      if (error instanceof ProviderFailure || timeout) {
        const failure = error instanceof ProviderFailure ? error : new ProviderFailure(`${this.name} timed out`);
        metrics.inc("provider_calls_total", { provider: this.name, op, result: timeout ? "timeout" : failure.status === 429 ? "rate_limited" : "failure" });
        if (failure.status === 429 || failure.status === 403) metrics.inc("provider_429_total", { provider: this.name });
        if (timeout) metrics.inc("provider_timeouts_total", { provider: this.name });
        this.failure(failure);
        throw timeout ? failure : error;
      }
      // A definite answer (4xx, validation error) means the provider is healthy.
      this.success();
      metrics.inc("provider_calls_total", { provider: this.name, op, result: "client_error" });
      throw error;
    } finally {
      clearTimeout(timer);
      metrics.observe("provider_call_ms", this.now() - started, { provider: this.name });
      this.release();
    }
  }
}

const gates = new Map<string, ProviderGate>();
const int = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** Process-wide gate per provider, configured from the environment. */
export function gate(name: "near-rpc" | "base-rpc" | "monerium" | string, defaults: GateOptions = {}) {
  let g = gates.get(name);
  if (!g) {
    const env = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    g = new ProviderGate(name, {
      ...defaults,
      concurrency: int(`${env}_CONCURRENCY`, defaults.concurrency ?? 4),
      hourlyBudget: int(`${env}_HOURLY_BUDGET`, defaults.hourlyBudget ?? 3600),
      timeoutMs: int(`${env}_TIMEOUT_MS`, defaults.timeoutMs ?? 15_000),
    });
    gates.set(name, g);
  }
  return g;
}
export const allGates = () => [...gates.values()];

/** Small TTL cache with a size bound (oldest entries evicted first). */
export class TtlCache<V> {
  private map = new Map<string, { at: number; value: V; ttl: number }>();
  constructor(private readonly max = 1000, private readonly now = () => Date.now()) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > hit.ttl) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: V, ttl: number) {
    this.map.delete(key);
    this.map.set(key, { at: this.now(), value, ttl });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  delete(key: string) {
    this.map.delete(key);
  }
  deleteWhere(test: (key: string) => boolean) {
    for (const k of [...this.map.keys()]) if (test(k)) this.map.delete(k);
  }
  get size() {
    return this.map.size;
  }
}
