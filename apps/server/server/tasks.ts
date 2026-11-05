import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { portalRuntime } from "./portal/http.ts";
import { taskRuntime } from "./tasks/http.ts";
import { metrics } from "./ops/metrics.ts";
import { log, withRequestId } from "./ops/log.ts";
import { RateLimiter, makeClientIp } from "./portal/rate-limit.ts";
import { hostedConfig } from "./ops/hosted.ts";
import { maintenanceEnabled, maintenanceGate } from "./ops/maintenance.ts";

const hosted = hostedConfig();
const { service, handler } = await taskRuntime();

// One worker instance per database. The lock lives in the database itself, with a heartbeat, so a
// second process (or container on the same volume) refuses to start its workers.
const instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const lockTtlMs = 45_000;
service.store.db.exec("CREATE TABLE IF NOT EXISTS instance_lock(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, heartbeat INTEGER NOT NULL)");
function claimInstance() {
  service.store.transaction(() => {
    const row = service.store.db.prepare("SELECT owner,heartbeat FROM instance_lock WHERE id=1").get() as { owner: string; heartbeat: number } | undefined;
    if (row && row.owner !== instanceId && Date.now() - row.heartbeat < lockTtlMs)
      throw new Error(`Another NearPortal instance (${row.owner}) is running its workers on this database. Stop it first; only one instance is supported.`);
    service.store.db.prepare("INSERT INTO instance_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,heartbeat=excluded.heartbeat").run(instanceId, Date.now());
  });
}
claimInstance();

const portal = await portalRuntime(service);
const maintenance = maintenanceEnabled();
service.continuous = !maintenance;
if (!maintenance) service.reconcile();
const heartbeat = setInterval(() => {
  try {
    claimInstance();
  } catch (error) {
    log("error", "instance.lock_lost", { error });
    void stop("lock-lost");
  }
}, 10_000);

// Workers: each pass dispatches due tasks into free slots (bounded by WORKER_CONCURRENCY); a slow
// task occupies one slot only. Passes never overlap for the same task.
const interval = setInterval(() => {
  if (maintenance) return;
  service.tick().catch((e) => log("error", "task_worker.failed", { error: e }));
}, 1000);
let portalRunning: Promise<void> | null = null;
const portalInterval = setInterval(() => {
  if (maintenance) return;
  if (portalRunning) return;
  portalRunning = portal.portal.tick().catch((e) => log("error", "portal_worker.failed", { error: e })).finally(() => {
    portalRunning = null;
  });
}, 2000);
const reconcile = setInterval(() => {
  if (maintenance) return;
  const added = service.reconcile();
  if (added) log("info", "worker.reconciled", { added });
}, 60_000);
const housekeeping = setInterval(() => {
  const sessions = portal.store.pruneExpired();
  const deliveries = service.store.pruneDeliveries();
  if (sessions || deliveries) log("info", "housekeeping", { sessions, deliveries });
}, 3_600_000);
let treasuryRunning: Promise<void> | null = null;
const treasuryInterval = setInterval(() => {
  if (maintenance) return;
  if (treasuryRunning) return;
  treasuryRunning = portal.treasury.tick().catch(() => {
    log("warn", "treasury.reconciliation_deferred", { note: "No replacement transfer sent." });
  }).finally(() => { treasuryRunning = null; });
}, 5000);

const host = process.env.HOST ?? "127.0.0.1";
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) &&
  !process.env.TASK_ADMIN_TOKEN
)
  throw new Error(
    "Set TASK_ADMIN_TOKEN before exposing the demo server beyond localhost.",
  );
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://github.com; object-src 'none'";
const securityHeaders = (html: boolean) => ({
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": CSP,
  ...(hosted.https ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  ...(html ? { "Cache-Control": "no-cache", "X-Frame-Options": "DENY" } : {}),
});

// Hosted mode: the Aurora landing and workspace pages are served by this process on the single
// public origin (SITE_DIR = built landing). Local mode keeps the separate 8791 preview server.
const site = hosted.siteDir
  ? ((await import(pathToFileURL(resolve(hosted.siteDir, "site.mjs")).href)) as { siteTarget: (p: string) => { page?: string; file?: string } | null })
  : null;
function serveFile(res: ServerResponse, root: string, relative: string, method: string, immutable: boolean) {
  const file = resolve(root, relative);
  if (!file.startsWith(`${root}${sep}`) || !existsSync(file) || !statSync(file).isFile()) return false;
  const html = extname(file) === ".html";
  res.writeHead(200, {
    "Content-Type": mime[extname(file)] ?? "application/octet-stream",
    ...securityHeaders(html),
    ...(html ? {} : { "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300" }),
  });
  res.end(method === "HEAD" ? undefined : readFileSync(file));
  return true;
}

const metricsToken = process.env.METRICS_TOKEN || process.env.TASK_ADMIN_TOKEN || "";
const allowedMetrics = (req: IncomingMessage) => {
  const supplied = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!metricsToken) return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") && !req.headers["x-forwarded-for"];
  return supplied.length === metricsToken.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(metricsToken));
};
const edgeLimiter = new RateLimiter();
const clientIp = makeClientIp();
const route = (path: string) =>
  path.startsWith("/api/") || path.startsWith("/auth/")
    ? path.replace(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/g, ":id").replace(/NP-[A-F0-9]{10}/g, ":code").replace(/\/\d+(?=\/|$)/g, "/:n").slice(0, 80)
    : "static";

let draining = false;
const server = createServer((req, res) =>
  withRequestId(String(req.headers["x-request-id"] ?? ""), async () => {
    const started = performance.now();
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    res.on("finish", () => {
      const ms = performance.now() - started;
      const r = route(path);
      metrics.observe("http_request_ms", ms, { route: r });
      metrics.inc("http_requests_total", { status: Math.floor(res.statusCode / 100) + "xx", method: req.method ?? "GET" });
      if (ms > 2000 || res.statusCode >= 500) log("warn", "http.slow_or_failed", { method: req.method, route: r, status: res.statusCode, ms: Math.round(ms) });
    });
    try {
      if (draining && !path.endsWith("/livez")) {
        res.writeHead(503, { "Retry-After": "5", Connection: "close" });
        res.end("Restarting");
        return;
      }
      if (path === "/api/ops/metrics" && req.method === "GET") {
        if (!allowedMetrics(req)) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store" });
        res.end(metrics.prometheus());
        return;
      }
      if (path === "/api/github/webhook" || path.startsWith("/api/tasks")) {
        const quota = edgeLimiter.take(path === "/api/github/webhook" ? "webhook" : req.method === "GET" ? "anon-read" : "auth", clientIp(req));
        if (!quota.ok) {
          res.writeHead(429, { "Retry-After": String(quota.retryAfterSeconds), "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Too many requests", retryAfterSeconds: quota.retryAfterSeconds }));
          return;
        }
      }
      if (maintenanceGate(req, res)) return;
      if (await portal.agent.handler(req, res)) return;
      if (await portal.handler(req, res)) return;
      if (await handler(req, res)) return;
      if (path.startsWith("/api/")) {
        res.writeHead(404);
        res.end("Unknown API route");
        return;
      }
      if (!["GET", "HEAD"].includes(req.method ?? "")) {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      if (site) {
        const target = site.siteTarget(path);
        if (target && serveFile(res, resolve(hosted.siteDir!), target.page ?? target.file!, req.method!, false)) return;
      }
      const root = resolve("dist");
      let relative: string;
      try {
        relative = extname(path) ? `.${decodeURIComponent(path)}` : "index.html";
      } catch {
        relative = "missing";
      }
      if (serveFile(res, root, relative, req.method!, extname(path) !== "")) return;
      res.writeHead(404);
      res.end(existsSync(root) ? "Not found" : "Run npm run build, or use npm run demo for the Vite preview.");
    } catch (error) {
      log("error", "http.unhandled", { error });
      if (!res.headersSent) res.writeHead(500);
      res.end("Server error");
    }
  }),
);
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 64;
const port = Number(process.env.PORT ?? 8787);
server.listen(port, host, () =>
  log("info", "server.listening", {
    url: `http://${host}:${port}/`,
    publicOrigin: hosted.publicOrigin,
    mode: service.config.mode,
    maintenance,
    github: service.config.githubMode,
    site: Boolean(site),
    webhooks: Boolean(process.env.GITHUB_WEBHOOK_SECRET),
    instance: instanceId,
  }),
);

// Graceful stop: refuse new work, let in-flight requests and worker passes finish within a
// bounded grace period, release the instance lock, then exit. Interrupted work is resumed from
// the durable queue on the next start (uncertain payment steps are reconciled, never resent).
async function stop(signal: string) {
  if (draining) return;
  draining = true;
  log("info", "server.draining", { signal });
  for (const t of [interval, reconcile, portalInterval, treasuryInterval, housekeeping, heartbeat]) clearInterval(t);
  server.close();
  const deadline = Date.now() + Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);
  while (Date.now() < deadline && (service.busy > 0 || portalRunning || treasuryRunning)) await new Promise((r) => setTimeout(r, 200));
  const clean = service.busy === 0 && !portalRunning && !treasuryRunning;
  try {
    service.store.db.prepare("DELETE FROM instance_lock WHERE owner=?").run(instanceId);
  } catch { /* database already closed */ }
  log(clean ? "info" : "warn", "server.stopped", { clean, inflight: service.busy });
  process.exit(clean ? 0 : 1);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
