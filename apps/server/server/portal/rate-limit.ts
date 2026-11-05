// Request quotas. Authenticated traffic is limited per GitHub user and per action category, so
// users behind one proxy or NAT never share a quota; anonymous and sign-in traffic is limited per
// client IP. Proxy headers are honoured only when the TCP peer is an explicitly trusted proxy.
import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { metrics } from "../ops/metrics.ts";

export interface Rule {
  limit: number;
  windowMs: number;
}
export type Category =
  | "auth"
  | "anon-read"
  | "ip-ceiling"
  | "read"
  | "expensive-read"
  | "mutation"
  | "refresh"
  | "access-check"
  | "wallet"
  | "bank"
  | "webhook";

const minute = 60_000;
const env = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isSafeInteger(v) && v > 0 ? v : fallback;
};
export const defaultRules = (): Record<Category, Rule> => ({
  // Per client IP.
  auth: { limit: env("RATE_AUTH_PER_MIN", 300), windowMs: minute },
  "anon-read": { limit: env("RATE_ANON_READ_PER_MIN", 1200), windowMs: minute },
  "ip-ceiling": { limit: env("RATE_IP_CEILING_PER_MIN", 6000), windowMs: minute },
  webhook: { limit: env("RATE_WEBHOOK_PER_MIN", 600), windowMs: minute },
  // Per authenticated user.
  read: { limit: env("RATE_USER_READ_PER_MIN", 600), windowMs: minute },
  "expensive-read": { limit: env("RATE_USER_PROVIDER_READ_PER_MIN", 30), windowMs: minute },
  mutation: { limit: env("RATE_USER_MUTATION_PER_MIN", 60), windowMs: minute },
  refresh: { limit: env("RATE_USER_REFRESH_PER_MIN", 6), windowMs: minute },
  "access-check": { limit: env("RATE_USER_ACCESS_CHECK_PER_MIN", 10), windowMs: minute },
  wallet: { limit: env("RATE_USER_WALLET_PER_MIN", 10), windowMs: minute },
  bank: { limit: env("RATE_USER_BANK_PER_MIN", 5), windowMs: minute },
});

/** Token buckets with a hard key bound and periodic expiry of idle (full) buckets. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private sweptAt: number;
  constructor(
    private readonly rules: Record<Category, Rule> = defaultRules(),
    private readonly maxKeys = 50_000,
    private readonly now = () => Date.now(),
  ) {
    this.sweptAt = now();
  }
  take(category: Category, subject: string, cost = 1): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const rule = this.rules[category];
    const t = this.now();
    if (t - this.sweptAt > minute) this.sweep(t);
    const k = `${category}:${subject}`;
    const rate = rule.limit / rule.windowMs;
    const bucket = this.buckets.get(k) ?? { tokens: rule.limit, at: t };
    bucket.tokens = Math.min(rule.limit, bucket.tokens + (t - bucket.at) * rate);
    bucket.at = t;
    this.buckets.delete(k);
    this.buckets.set(k, bucket); // most recently used last
    while (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
    if (bucket.tokens < cost) {
      metrics.inc("http_rate_limited_total", { category });
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((cost - bucket.tokens) / rate / 1000)) };
    }
    bucket.tokens -= cost;
    return { ok: true };
  }
  /** Idle buckets that have refilled completely carry no information: drop them. */
  sweep(t = this.now()) {
    this.sweptAt = t;
    for (const [k, b] of this.buckets) {
      const rule = this.rules[k.slice(0, k.indexOf(":")) as Category];
      if (!rule || b.tokens + (t - b.at) * (rule.limit / rule.windowMs) >= rule.limit) this.buckets.delete(k);
    }
  }
  get size() {
    return this.buckets.size;
  }
}

const normalize = (ip: string) => (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip);

/** TRUSTED_PROXIES: comma-separated IPs or CIDRs of the reverse proxies in front of this server. */
export function trustedProxies(spec = process.env.TRUSTED_PROXIES ?? "") {
  const list = new BlockList();
  let any = false;
  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [address, bits] = raw.split("/");
    const family = isIP(address ?? "");
    if (!family) throw new Error(`TRUSTED_PROXIES entry is not an IP or CIDR: ${raw}`);
    const type = family === 4 ? "ipv4" : "ipv6";
    if (bits === undefined) list.addAddress(address!, type);
    else {
      const prefix = Number(bits);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) throw new Error(`Invalid CIDR prefix: ${raw}`);
      list.addSubnet(address!, prefix, type);
    }
    any = true;
  }
  return { list, any };
}

export function makeClientIp(proxies = trustedProxies()) {
  const trusted = (ip: string) => {
    const family = isIP(ip);
    return Boolean(family && proxies.any && proxies.list.check(ip, family === 4 ? "ipv4" : "ipv6"));
  };
  /**
   * The peer address, unless the peer is a trusted proxy: then the right-most X-Forwarded-For entry
   * that is not itself a trusted proxy. Entries further left are client-controlled and ignored, so a
   * forged header cannot select another quota.
   */
  return (req: IncomingMessage): string => {
    const peer = normalize(req.socket.remoteAddress ?? "unknown");
    if (!trusted(peer)) return peer;
    const header = req.headers["x-forwarded-for"];
    const hops = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((s) => normalize(s.trim())).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i]!;
      if (!isIP(hop)) return peer; // malformed chain: do not guess
      if (!trusted(hop)) return hop;
    }
    return peer;
  };
}

/** Category for a portal request. Provider-backed reads get their own small quota. */
export function categorize(method: string, path: string): { category: Category; perUser: boolean } {
  if (path.startsWith("/auth/") || path === "/api/portal/local-login") return { category: "auth", perUser: false };
  const p = path.replace(/^\/api\/portal/, "");
  if (method === "GET" || method === "HEAD") {
    if (/^\/(?:repositories|repository-setup|workflow-checks|verification-files|treasury)$/.test(p) || /\/deposit$/.test(p)) return { category: "expensive-read", perUser: true };
    return { category: "read", perUser: true };
  }
  if (/\/refresh$/.test(p)) return { category: "refresh", perUser: true };
  if (/\/(?:check-access|request-access)$/.test(p)) return { category: "access-check", perUser: true };
  if (/\/wallet-challenge$/.test(p)) return { category: "wallet", perUser: true };
  if (p === "/bank") return { category: "bank", perUser: true };
  return { category: "mutation", perUser: true };
}
