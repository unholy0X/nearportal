import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentWorld, KEY } from "./agent-world.ts";

test("maintenance: real server boots without custody keys, permits device login, blocks business actions and never runs queued work", { timeout: 55_000 }, async (t) => {
  const saved = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "np-maintenance-"));
  const dbPath = join(dir, "github-tasks.sqlite");
  const w = await agentWorld({ dir, path: dbPath });
  const token = await w.login("owner");
  const b = await w.bounty(token);
  w.tasks.enqueue(b.taskId!);
  const session = w.sessions.owner!;
  await w.close();
  const snapshot = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return JSON.stringify(Object.fromEntries(["tasks", "queue", "releases", "portal_bounties"].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]))); }
    finally { db.close(); }
  };
  const before = snapshot();
  const socket = createServer();
  await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((r) => socket.close(() => r()));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", resolve("test/loopback-only.mjs"), "--import", "tsx", "server/tasks.ts"], {
    cwd: resolve("."),
    env: { PATH: process.env.PATH, ENV_FILE: "/dev/null", DATA_DIR: dir, PORT: String(port), HOST: "127.0.0.1", APP_ORIGIN: origin, NEARPORTAL_MAINTENANCE: "1", TASK_PAYMENT_MODE: "sandbox", TASK_GITHUB_MODE: "live", GITHUB_USE_CLI: "0", NEAR_CREDENTIALS_DIR: join(dir, "no-keys"), PORTAL_ENCRYPTION_KEY: KEY.toString("base64"), GITHUB_OAUTH_CLIENT_ID: "fixture-id", GITHUB_OAUTH_CLIENT_SECRET: "fixture-secret" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (b) => { logs += b; }); child.stderr.on("data", (b) => { logs += b; });
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const request = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };
  for (let i = 0; ; i++) {
    try { if ((await request("/api/portal/readyz")).status === 200) break; } catch { /* startup */ }
    assert.ok(i < 100 && child.exitCode === null, logs);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await request("/api/agent/v1/meta")).body.data.maintenance, true);
  const oauth = await request("/auth/github");
  assert.equal(oauth.status, 302);
  assert.equal(new URL(oauth.headers.get("location")!).origin, "https://github.com");
  const start = await request("/api/agent/device/code", { clientName: "maintenance-test", scopes: ["read", "create", "contribute"] });
  assert.equal(start.status, 200);
  const authHeaders = { Cookie: session.cookie, "X-CSRF-Token": session.csrf };
  assert.equal((await request("/api/agent/device/decision", { code: start.body.data.userCode, decision: "approve", scopes: ["read", "create", "contribute"] }, authHeaders)).status, 200);
  const issued = await request("/api/agent/device/token", { deviceCode: start.body.data.deviceCode });
  const bearer = { Authorization: `Bearer ${issued.body.data.accessToken}` };
  assert.equal((await request("/api/agent/v1/account", undefined, bearer)).body.data.capabilities.fixedDeadlineUsdc, false);
  assert.equal((await request("/api/agent/v1/activity", undefined, bearer)).status, 200);
  assert.equal((await request("/api/agent/v1/bounties", undefined, bearer)).status, 200);
  for (const path of ["/api/agent/v1/prepare", "/api/agent/v1/batches", `/api/agent/v1/bounties/${b.id}/claim`, `/api/agent/v1/bounties/${b.id}/submit`, `/api/portal/bounties/${b.id}/publish`, `/api/portal/bounties/${b.id}/fund`, `/api/tasks/${b.taskId}/verify`, "/api/github/webhook", "/api/future-mutation"]) {
    const result = await request(path, {}, { ...bearer, ...authHeaders });
    assert.equal(result.status, 503, path);
    if (path.startsWith("/api/agent/")) assert.equal(result.body.error.code, "capability_disabled");
  }
  for (const path of ["/api/agent/v1/funding?batch=x", `/api/tasks/${b.taskId}/deposit`, `/api/portal/bounties/${b.id}/deposit`]) assert.equal((await request(path, undefined, bearer)).status, 503);
  assert.equal((await request("/api/agent/v1/logout", {}, bearer)).status, 200);
  assert.equal((await request("/api/agent/v1/account", undefined, bearer)).status, 401);
  // Longer than the normal worker-stalled threshold; readiness must report a deliberate pause.
  await new Promise((r) => setTimeout(r, 31_000));
  const ready = await request("/api/portal/readyz");
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, "maintenance");
  assert.equal(ready.body.worker.paused, true);
  assert.equal(ready.body.worker.inflight, 0);
  assert.equal(snapshot(), before, "funded tasks, queued work and payment records remain unchanged");
  child.kill("SIGTERM");
  assert.equal(await exited, 0, logs);
  assert.match(logs, /"event":"server.stopped".*"clean":true/);
});
