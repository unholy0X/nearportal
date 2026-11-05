import type { IncomingMessage, ServerResponse } from "node:http";
import { validWebhook, GitHub } from "./github.ts";
import { TaskStore } from "./store.ts";
import { SimulatedPayments, sandboxPayments } from "./payments.ts";
import { TaskService } from "./service.ts";
import { shortIban } from "./payout.ts";
import { env } from "../env.ts";
import { inspectSetup, type SetupStatus } from "./setup.ts";
import { metrics } from "../ops/metrics.ts";
import type { Task } from "./domain.ts";
import { maintenanceEnabled, maintenanceGate, pausedPayments } from "../ops/maintenance.ts";
import { bankPaymentsEnabled, disabledBankPayments } from "../ops/payment-rails.ts";

/** Events NearPortal acts on. Everything else is acknowledged and ignored. */
export const WEBHOOK_EVENTS = new Set(["ping", "pull_request", "pull_request_review", "check_run", "check_suite", "workflow_run", "push"]);
interface WebhookPayload {
  repository?: { id?: number };
  number?: number;
  pull_request?: { number?: number; head?: { sha?: string } };
  check_run?: { head_sha?: string; pull_requests?: { number?: number }[] };
  check_suite?: { head_sha?: string; pull_requests?: { number?: number }[] };
  workflow_run?: { head_sha?: string; pull_requests?: { number?: number }[] };
}
/**
 * Only the tasks the event can affect: same repository, then the PR number or head SHA named by
 * the event. Unbound claimed tasks in that repository are returned for PR discovery.
 */
export function webhookTargets(all: Task[], event: string, payload: WebhookPayload) {
  if (!WEBHOOK_EVENTS.has(event) || event === "ping" || typeof payload.repository?.id !== "number") return { taskIds: [], discovery: [] };
  const active = all.filter((t) => t.githubMode === "live" && t.policy.repositoryId === payload.repository!.id && t.payment.state !== "Processed" && !t.disputed);
  const run = payload.check_run ?? payload.check_suite ?? payload.workflow_run;
  const numbers = new Set<number>([payload.number, payload.pull_request?.number, ...(run?.pull_requests ?? []).map((p) => p.number)].filter((n): n is number => Number.isSafeInteger(n)));
  const sha = run?.head_sha ?? payload.pull_request?.head?.sha;
  const bound = active.filter((t) => t.prNumber !== null);
  const taskIds = event === "push"
    ? bound.map((t) => t.id)
    : bound.filter((t) => numbers.has(t.prNumber!) || (sha && t.evidence?.headSha === sha)).map((t) => t.id);
  const discovery = event === "pull_request" ? active.filter((t) => t.prNumber === null && t.policy.developerId && t.funded).map((t) => t.id) : [];
  return { taskIds, discovery };
}

export async function readBody(
  req: IncomingMessage,
  limit = 1_000_000,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += Buffer.byteLength(chunk);
    if (length > limit) throw new Error("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(data));
};

export async function taskRuntime() {
  const mode = process.env.TASK_PAYMENT_MODE ?? "simulation";
  const githubMode = process.env.TASK_GITHUB_MODE ?? "fixture";
  if (
    !["simulation", "sandbox"].includes(mode) ||
    !["fixture", "live"].includes(githubMode)
  )
    throw new Error("Invalid task demo mode");
  if (
    !["127.0.0.1", "localhost", "::1"].includes(
      process.env.HOST ?? "127.0.0.1",
    ) &&
    !process.env.TASK_ADMIN_TOKEN
  )
    throw new Error(
      "Set TASK_ADMIN_TOKEN before exposing the task demo beyond localhost.",
    );
  const store = new TaskStore(
    process.env.TASK_DB ?? `${env.dataDir}/github-tasks.sqlite`,
  );
  const github = new GitHub({
    token: process.env.GITHUB_TOKEN,
    appId: process.env.GITHUB_APP_ID,
    installationId: process.env.GITHUB_INSTALLATION_ID,
    privateKeyFile: process.env.GITHUB_APP_PRIVATE_KEY_FILE,
    useGhCli: process.env.GITHUB_USE_CLI === "1",
  });
  // Simulation mode uses a simulated escrow chain (same market rules as the contracts, no funds).
  const { simEscrows } = await import("../market/sim-chain.ts");
  const payments =
    maintenanceEnabled() ? pausedPayments() : mode === "sandbox"
      ? bankPaymentsEnabled() ? await sandboxPayments(store) : disabledBankPayments()
      : new SimulatedPayments(store, simEscrows(store.db, { now: () => Date.now(), verifier: "local-demo-verifier" }));
  const service = new TaskService(store, github, payments, {
    mode: mode as "simulation" | "sandbox",
    githubMode: githubMode as "fixture" | "live",
    verifier:
      mode === "sandbox"
        ? (bankPaymentsEnabled() ? process.env.GITHUB_VERIFIER_ACCOUNT_ID! : process.env.CRYPTO_VERIFIER_ACCOUNT_ID!)
        : "local-demo-verifier",
    ...(mode === "sandbox"
      ? {
          sandboxPayoutIbans: (process.env.TASK_SANDBOX_PAYOUT_IBANS ?? "")
            .split(",")
            .map((s) => s.replace(/\s/g, "").toUpperCase())
            .filter(Boolean),
        }
      : {}),
    recipient: "Developer supplies payout details before acceptance",
    ...(mode === "sandbox" ? { cryptoVerifier: process.env.CRYPTO_VERIFIER_ACCOUNT_ID } : {}),
    ...(mode === "sandbox"
      ? {
          refundShortIban: shortIban(
            (process.env.TASK_CLIENT_IBAN ?? "")
              .replace(/\s/g, "")
              .toUpperCase(),
          ),
        }
      : {}),
  });
  return {
    service,
    handler: taskHandler(service, {
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
      adminToken: process.env.TASK_ADMIN_TOKEN ?? "",
    }),
  };
}

export function taskHandler(
  service: TaskService,
  config: { webhookSecret: string; adminToken: string },
) {
  let setupCache: { at: number; result: SetupStatus } | undefined;
  return async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (
      !url.pathname.startsWith("/api/tasks") &&
      url.pathname !== "/api/github/webhook"
    )
      return false;
    if (maintenanceGate(req, res)) return true;
    try {
      if (url.pathname === "/api/github/webhook") {
        if (req.method !== "POST") {
          json(res, 405, { error: "POST required" });
          return true;
        }
        const raw = await readBody(req);
        if (
          !validWebhook(
            raw,
            String(req.headers["x-hub-signature-256"] ?? ""),
            config.webhookSecret,
          )
        ) {
          json(res, 401, { error: "Invalid GitHub signature" });
          return true;
        }
        const delivery = String(req.headers["x-github-delivery"] ?? "");
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(delivery))
          throw new Error("Invalid delivery ID");
        const event = String(req.headers["x-github-event"] ?? "");
        if (!/^[a-z_]{1,64}$/.test(event)) throw new Error("Invalid event type");
        const payload = JSON.parse(raw.toString("utf8")) as WebhookPayload;
        const { taskIds, discovery } = webhookTargets(service.store.all(), event, payload);
        // The delivery and its wake-ups commit together before GitHub gets its 2xx; a duplicate
        // delivery ID is acknowledged without effect. Order does not matter: woken tasks re-read
        // GitHub's current state, and the periodic reconciliation covers missed deliveries.
        const accepted = service.store.delivery(delivery, taskIds, event);
        if (accepted && discovery.length) service.onDiscoveryWake?.(discovery);
        metrics.inc("github_webhooks_total", { event: WEBHOOK_EVENTS.has(event) ? event : "other", result: accepted ? "accepted" : "duplicate" });
        json(res, 202, { accepted, duplicate: !accepted, woke: taskIds.length });
        return true;
      }
      // Block cross-origin browser mutations; role capabilities travel in Authorization,
      // never in query strings or referrers. This demo has no cookies or ambient authority.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) {
        json(res, 403, { error: "Cross-origin request rejected" });
        return true;
      }
      const bearer = String(req.headers.authorization ?? "").replace(
        /^Bearer /,
        "",
      );
      if (req.method === "GET" && url.pathname === "/api/tasks/setup") {
        if (service.config.githubMode !== "live") {
          json(res, 200, { simulation: true });
          return true;
        }
        if (!setupCache || Date.now() - setupCache.at > 30_000)
          setupCache = {
            at: Date.now(),
            result: await inspectSetup(service.github),
          };
        json(res, 200, setupCache.result);
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/tasks/config") {
        json(res, 200, {
          ...service.config,
          adminRequired: Boolean(config.adminToken),
          notice: modeNotice(service.config.mode, service.config.githubMode),
        });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/tasks") {
        if (config.adminToken && bearer !== config.adminToken) {
          json(res, 401, {
            error: "Demo administrator token required to create a task",
          });
          return true;
        }
        const input = JSON.parse((await readBody(req)).toString("utf8"));
        const result = await service.exclusive("create", () => service.create(input));
        json(res, 201, result);
        return true;
      }
      const match =
        /^\/api\/tasks\/([a-f0-9-]{36})(?:\/(accept|fund|pr|simulate|verify|dispute|deposit|payout))?$/.exec(
          url.pathname,
        );
      if (!match) {
        json(res, 404, { error: "Task endpoint not found" });
        return true;
      }
      await service.exclusive(`task:${match[1]}`, async () => {
        const { task, role } = service.authorize(match[1]!, bearer);
        if (req.method === "GET" && !match[2]) {
          json(res, 200, { task: service.public(task), role });
          return;
        }
        if (req.method === "GET" && match[2] === "deposit") {
          json(res, 200, await service.payments.deposit(task));
          return;
        }
        if (req.method !== "POST") {
          json(res, 405, { error: "Method not allowed" });
          return;
        }
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        switch (match[2]) {
          case "payout":
            service.setPayout(task, role, body);
            break;
          case "accept":
            service.accept(task, role, body.policyHash);
            break;
          case "fund":
            if (role !== "client") throw new Error("Only the client can fund");
            service.fund(task);
            break;
          case "pr":
            if (role !== "developer")
              throw new Error("Only the developer can link a PR");
            service.bindPr(task, body.number);
            break;
          case "simulate":
            service.simulate(task, body.action, role);
            break;
          case "verify":
            service.store.enqueue(task.id);
            break;
          case "dispute":
            await service.dispute(task, role);
            break;
          default:
            throw new Error("Unknown task action");
        }
        json(res, 200, {
          task: service.public(service.store.get(task.id)),
          role,
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      json(
        res,
        /access link|Only the/.test(message)
          ? 403
          : message === "Task not found"
            ? 404
            : 400,
        { error: message },
      );
    }
    return true;
  };
}

function modeNotice(mode: string, githubMode: string) {
  return mode === "sandbox"
    ? "NEAR testnet + Monerium sandbox. GitHub is live; bank funds are simulated by the payment provider."
    : githubMode === "live"
      ? "Live GitHub verification with simulated payments. No real money moves."
      : "Local simulation. GitHub events and payments are simulated; no real money moves.";
}
