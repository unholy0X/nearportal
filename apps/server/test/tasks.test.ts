import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, hash, type Task } from "../server/tasks/domain.ts";
import {
  fixtureEvidence,
  GitHub,
  validWebhook,
} from "../server/tasks/github.ts";
import { payoutFor } from "../server/tasks/payout.ts";
import { fundingBlocker, SimulatedPayments } from "../server/tasks/payments.ts";
import { TaskService } from "../server/tasks/service.ts";
import { TaskStore } from "../server/tasks/store.ts";
import { taskHandler } from "../server/tasks/http.ts";
import { inspectSetup } from "../server/tasks/setup.ts";

const config = {
  mode: "simulation",
  githubMode: "fixture",
  verifier: "demo-verifier",
  recipient: "demo-developer",
} as const;
const bank = {
  firstName: "Demo",
  lastName: "Developer",
  iban: "FR1420041010050500013M02606",
  country: "FR",
};
const input = {
  title: "CSV export",
  criteria: "Escape commas and quotes\nPass the immutable acceptance tests",
  amountCents: 10_000,
};

test("setup reads the connected account and fails closed when protected files are missing", async () => {
  let missing = false;
  const github = new GitHub({ token: "test-token" }, async (url) => {
    const path = new URL(String(url)).pathname;
    let result: unknown;
    if (path === "/user") result = { login: "demo-maintainer" };
    else if (path.endsWith("/permission")) result = { permission: "admin" };
    else if (path.includes("/branches/")) result = { commit: { sha: "base" } };
    else if (path.includes("/contents/")) {
      if (missing) return new Response("{}", { status: 404 });
      result = { type: "file", sha: "blob" };
    } else result = { id: 1444312023, allow_squash_merge: false };
    return new Response(JSON.stringify(result));
  });
  const ready = await inspectSetup(github);
  assert.equal(ready.account, "demo-maintainer");
  assert.equal(ready.ready, true);
  assert.equal(ready.developer, "pending");
  missing = true;
  const pending = await inspectSetup(github);
  assert.equal(pending.ready, false);
  assert.ok(pending.files.every((f) => !f.ready));
});
function setup(path = ":memory:") {
  const store = new TaskStore(path);
  const github = new GitHub({});
  const service = new TaskService(
    store,
    github,
    new SimulatedPayments(store),
    config,
  );
  return { store, service };
}
async function prepared(service: TaskService) {
  const created = await service.create(input);
  let task = service.store.get(created.task.id);
  service.setPayout(task, "developer", bank);
  task = service.store.get(task.id);
  service.accept(task, "client", task.policyHash);
  task = service.store.get(task.id);
  service.accept(task, "developer", task.policyHash);
  task = service.store.get(task.id);
  service.fund(task);
  task = service.store.get(task.id);
  service.bindPr(task, 7);
  return service.store.get(task.id);
}

test("policy rejects wrong repository, branch, author, merger, source and stale checks", async () => {
  const { service, store } = setup();
  const task = await prepared(service);
  task.fixture = "merged";
  const good = fixtureEvidence(task);
  assert.equal(evaluate(task.policy, 7, good).status, "eligible");
  for (const evidence of [
    { ...good, repositoryId: 999 },
    { ...good, prNumber: 8 },
    { ...good, authorId: 999 },
    { ...good, branch: "other" },
    { ...good, mergedById: task.policy.developerId },
    { ...good, mergeParents: [] },
    { ...good, protectedFiles: [] },
    { ...good, checks: good.checks.map((c) => ({ ...c, appId: 999 })) },
    { ...good, checks: good.checks.map((c) => ({ ...c, headSha: "old" })) },
    { ...good, runs: [] },
    { ...good, runs: good.runs.map((r) => ({ ...r, path: "untrusted.yml" })) },
    {
      ...good,
      checks: good.checks.map((c) => ({ ...c, conclusion: "skipped" })),
    },
  ])
    assert.notEqual(evaluate(task.policy, 7, evidence).status, "eligible");
  assert.equal(
    evaluate(task.policy, 7, { ...good, merged: false }).status,
    "pending",
  );
  store.close();
});

test("latest matching check failure overrides an earlier success", async () => {
  const { service, store } = setup();
  const task = await prepared(service);
  task.fixture = "merged";
  const evidence = fixtureEvidence(task);
  evidence.checks.push({
    ...evidence.checks[0]!,
    id: 900,
    conclusion: "failure",
  });
  assert.equal(evaluate(task.policy, 7, evidence).status, "blocked");
  store.close();
});

test("only selected jobs gate release; unrelated jobs and aggregate run conclusions do not", async () => {
  const { service, store } = setup();
  const task = await prepared(service);
  task.fixture = "merged";
  const good = fixtureEvidence(task);
  for (const conclusion of [null, "failure", "cancelled", "timed_out", "success"]) {
    const evidence = structuredClone(good);
    evidence.runs[0]!.conclusion = conclusion;
    evidence.checks.push({ ...evidence.checks[0]!, id: 999, name: "unselected-escrow", status: conclusion === null ? "in_progress" : "completed", conclusion });
    assert.equal(evaluate(task.policy, 7, evidence).status, "eligible", `aggregate run: ${conclusion}`);
    assert.equal(evaluate(task.policy, 7, { ...evidence, merged: false }).status, "pending");
  }
  // A selected second job must still succeed, even though aggregate success is irrelevant.
  const evidence = structuredClone(good);
  evidence.runs[0]!.conclusion = null;
  const selected = { ...task.policy, checks: [...task.policy.checks, { name: "escrow", appId: good.checks[0]!.appId }] };
  assert.equal(evaluate(selected, 7, evidence).status, "pending");
  evidence.checks.push({ ...good.checks[0]!, id: 999, name: "escrow", conclusion: "failure" });
  assert.equal(evaluate(selected, 7, evidence).status, "blocked");
  evidence.checks.at(-1)!.conclusion = "success";
  assert.equal(evaluate(selected, 7, evidence).status, "eligible");
  store.close();
});

test("selected check still requires exact workflow, suite, commit and PR provenance", async () => {
  const { service, store } = setup();
  const task = await prepared(service);
  task.fixture = "merged";
  const good = fixtureEvidence(task);
  for (const patch of [{ path: "other.yml" }, { suiteId: 999 }, { headSha: "old" }, { prNumbers: [8] }]) {
    const evidence = structuredClone(good);
    Object.assign(evidence.runs[0]!, patch);
    assert.equal(evaluate(task.policy, 7, evidence).status, "blocked");
  }
  store.close();
});

test("worker automatically pays once when selected job succeeds while another job is running", async () => {
  const { service, store } = setup();
  const task = await prepared(service);
  task.fixture = "merged";
  const evidence = fixtureEvidence(task);
  evidence.runs[0]!.conclusion = null;
  evidence.checks.push({ ...evidence.checks[0]!, id: 999, name: "unselected-escrow", status: "in_progress", conclusion: null });
  task.githubMode = "live";
  store.save(task);
  service.github.evidence = async () => structuredClone(evidence);
  store.enqueue(task.id);
  await service.tick();
  assert.equal(store.get(task.id).verdict?.status, "eligible");
  assert.equal(store.get(task.id).payment.state, "Processed");
  store.enqueue(task.id);
  await service.tick();
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM releases").get() as { n: number }).n, 1);
  store.close();
});

test("worker holds failed checks, then waits for merge, then pays automatically once", async () => {
  const { service, store } = setup();
  const task = await prepared(service);
  service.simulate(task, "failed", "developer");
  await service.tick();
  assert.equal(store.get(task.id).verdict?.status, "blocked");
  assert.equal(store.get(task.id).payment.state, "NotRequested");
  service.simulate(store.get(task.id), "tampered", "developer");
  await service.tick();
  assert.equal(store.get(task.id).verdict?.status, "blocked");
  service.simulate(store.get(task.id), "ready", "developer");
  await service.tick();
  assert.equal(store.get(task.id).verdict?.status, "pending");
  service.simulate(store.get(task.id), "merged", "client");
  await service.tick();
  const paid = store.get(task.id);
  assert.equal(paid.payment.state, "Processed");
  assert.equal(paid.payment.reference, `SIM-${task.id}`);
  for (let i = 0; i < 3; i++) {
    store.enqueue(task.id);
    await service.tick();
  }
  assert.equal(
    store
      .get(task.id)
      .timeline.filter((e) => e.message.includes("payment completed")).length,
    1,
  );
  assert.equal(
    (
      store.db.prepare("SELECT COUNT(*) AS n FROM releases").get() as {
        n: number;
      }
    ).n,
    1,
  );
  store.close();
});

test("funding, role acceptance and a fixed PR are required", async () => {
  const { service, store } = setup();
  const created = await service.create(input);
  const t = store.get(created.task.id);
  assert.throws(() => service.fund(t), /Both parties/);
  assert.throws(() => service.bindPr(t, 1), /fund/);
  assert.throws(() => service.accept(t, "client", "changed"), /exact policy/);
  assert.throws(() => service.authorize(t.id, "forged"), /access link/);
  const preparedTask = await prepared(service);
  assert.throws(() => service.bindPr(preparedTask, 8), /already bound/);
  store.close();
});

test("a dispute or policy corruption prevents payout", async () => {
  const { service, store } = setup();
  let task = await prepared(service);
  task.fixture = "merged";
  store.save(task);
  await service.dispute(task);
  store.enqueue(task.id);
  await service.tick();
  assert.equal(store.get(task.id).payment.state, "NotRequested");
  task = await prepared(service);
  task.fixture = "merged";
  task.policy.amountCents += 1;
  store.save(task);
  store.enqueue(task.id);
  await service.tick();
  assert.match(store.get(task.id).payment.error!, /integrity/);
  assert.equal(store.get(task.id).payment.state, "NotRequested");
  store.close();
});

test("restart resumes an authorized release from durable state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nearportal-task-test-"));
  const path = join(dir, "tasks.sqlite");
  let { store, service } = setup(path);
  const task = await prepared(service);
  task.fixture = "merged";
  task.evidence = fixtureEvidence(task);
  task.verdict = evaluate(task.policy, 7, task.evidence);
  task.payment.state = "Authorized";
  store.authorize(task, task.verdict.evidenceHash);
  store.close();
  ({ store, service } = setup(path));
  service.reconcile();
  await service.tick();
  assert.equal(store.get(task.id).payment.state, "Processed");
  assert.equal(
    (
      store.db.prepare("SELECT COUNT(*) AS n FROM releases").get() as {
        n: number;
      }
    ).n,
    1,
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("live evidence for a merge before funding cannot release the reward", async () => {
  const { service, store } = setup();
  const task = await prepared(service);
  task.githubMode = "live";
  task.fixture = "merged";
  store.save(task);
  service.github.evidence = async () => ({
    ...fixtureEvidence(task),
    mergedAt: new Date(Date.parse(task.fundedAt!) - 1000).toISOString(),
  });
  store.enqueue(task.id);
  await service.tick();
  assert.equal(store.get(task.id).verdict?.status, "blocked");
  assert.match(store.get(task.id).verdict!.reasons.join(), /before.*funding/);
  assert.equal(store.get(task.id).payment.state, "NotRequested");
  store.close();
});

test("a GitHub outage holds payment and preserves queued work for reconciliation", async () => {
  const { service, store } = setup();
  const task = await prepared(service);
  task.githubMode = "live";
  store.save(task);
  service.github.evidence = async () => {
    throw new Error("GitHub temporarily unavailable");
  };
  store.enqueue(task.id);
  await service.tick();
  assert.equal(store.get(task.id).payment.state, "NotRequested");
  assert.match(store.get(task.id).payment.error!, /unavailable/);
  assert.equal(
    (store.db.prepare("SELECT COUNT(*) AS n FROM queue").get() as { n: number })
      .n,
    1,
  );
  store.close();
});

test("webhook HMAC validates exact bytes, and deliveries enqueue only once", async () => {
  const raw = Buffer.from('{"repository":{"id":100}}');
  const secret = "a-test-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  assert.equal(validWebhook(raw, signature, secret), true);
  assert.equal(
    validWebhook(Buffer.concat([raw, Buffer.from(" ")]), signature, secret),
    false,
  );
  assert.equal(validWebhook(raw, signature, ""), false);
  const { service, store } = setup();
  const t = await prepared(service);
  assert.equal(store.delivery("delivery-1", [t.id]), true);
  assert.equal(store.delivery("delivery-1", [t.id]), false);
  assert.equal(store.due().length, 1);
  store.close();
});

test("sandbox payments cannot use simulated GitHub evidence", () => {
  const { store, service } = setup();
  assert.throws(
    () =>
      new TaskService(store, service.github, service.payments, {
        ...config,
        mode: "sandbox",
      }),
    /live GitHub/,
  );
  store.close();
});

test("GitHub API adapter binds checks and protected blobs to exact PR revisions", async () => {
  const { service, store } = setup();
  const task = await prepared(service);
  const requested: string[] = [];
  const mock: typeof fetch = async (url) => {
    const path = String(url);
    requested.push(path);
    let result: unknown;
    if (path.includes("/pulls/7"))
      result = {
        number: 7,
        base: { repo: { id: 100 }, ref: "main" },
        head: { sha: "head" },
        user: { id: 200 },
        merged: true,
        merged_by: { id: 300 },
        merged_at: "2026-11-03T12:00:00Z",
        merge_commit_sha: "b".repeat(40),
        html_url: "https://github.com/example/repo/pull/7",
      };
    else if (path.includes("check-runs"))
      result = {
        check_runs: [
          {
            id: 1,
            name: "acceptance",
            app: { id: 15368 },
            head_sha: "head",
            status: "completed",
            conclusion: "success",
            check_suite: { id: 2 },
          },
        ],
      };
    else if (path.includes("/actions/runs"))
      result = {
        workflow_runs: [
          {
            id: 3,
            head_sha: "head",
            path: task.policy.workflowPath,
            check_suite_id: 2,
            pull_requests: [{ number: 7 }],
            conclusion: "success",
          },
        ],
      };
    else if (path.includes("/contents/"))
      result = { type: "file", sha: "1".repeat(40) };
    else if (path.endsWith("/commits/" + "b".repeat(40)))
      result = { parents: [{ sha: "base" }] };
    else throw new Error(`Unexpected test request: ${path}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const evidence = await new GitHub({ token: "test-token" }, mock).evidence(
    task,
  );
  assert.equal(evaluate(task.policy, 7, evidence).status, "eligible");
  assert.ok(requested.some((p) => p.includes("commits/head/check-runs")));
  assert.ok(requested.some((p) => p.includes("ref=" + "b".repeat(40))));
  assert.ok(requested.some((p) => p.includes("ref=head")));
  store.close();
});

test("HTTP demo: capabilities, acceptance, funding, PR, merge and automatic payment", async () => {
  const { service, store } = setup();
  const handler = taskHandler(service, {
    webhookSecret: "secret",
    adminToken: "",
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (path: string, token = "", body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: (await response.json()) as any };
  };
  try {
    const created = await call("/api/tasks", "", input);
    assert.equal(created.status, 201);
    let { task } = created.data;
    const { clientToken, developerToken } = created.data;
    const path = `/api/tasks/${task.id}`;
    assert.equal((await call(path)).status, 403);
    assert.equal((await call(`${path}/fund`, developerToken, {})).status, 403);
    assert.equal((await call(`${path}/payout`, clientToken, bank)).status, 403);
    assert.equal(
      (
        await call(`${path}/accept`, developerToken, {
          policyHash: task.policyHash,
        })
      ).status,
      400,
    );
    const destination = await call(`${path}/payout`, developerToken, bank);
    assert.equal(destination.status, 200);
    assert.equal(JSON.stringify(destination.data).includes(bank.iban), false);
    assert.equal("payout" in destination.data.task, false);
    task = destination.data.task;
    await call(`${path}/accept`, clientToken, { policyHash: task.policyHash });
    await call(`${path}/accept`, developerToken, {
      policyHash: task.policyHash,
    });
    assert.equal((await call(`${path}/fund`, clientToken, {})).status, 200);
    await call(`${path}/pr`, developerToken, { number: 1 });
    await call(`${path}/simulate`, developerToken, { action: "ready" });
    await service.tick();
    assert.equal(
      (await call(path, clientToken)).data.task.verdict.status,
      "pending",
    );
    await call(`${path}/simulate`, clientToken, { action: "merged" });
    await service.tick();
    const result = (await call(path, developerToken)).data.task;
    assert.equal(result.payment.state, "Processed");
    assert.equal("clientTokenHash" in result, false);
    assert.equal(hash(result.policy), result.policyHash);
    assert.equal(
      (await call(`${path}/simulate`, developerToken, { action: "merged" }))
        .status,
      400,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("HTTP webhook rejects a forged signature and durably deduplicates valid deliveries", async () => {
  const { service, store } = setup();
  const created = await service.create(input);
  const task = store.get(created.task.id);
  task.githubMode = "live";
  task.prNumber = 7;
  store.save(task);
  const other = store.get((await service.create(input)).task.id);
  other.githubMode = "live";
  other.prNumber = 8;
  store.save(other);
  const handler = taskHandler(service, {
    webhookSecret: "webhook-secret",
    adminToken: "",
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/github/webhook`;
  const raw = JSON.stringify({ action: "synchronize", number: 7, repository: { id: task.policy.repositoryId } });
  const signature = `sha256=${createHmac("sha256", "webhook-secret").update(raw).digest("hex")}`;
  try {
    const post = (sig: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          "X-Hub-Signature-256": sig,
          "X-GitHub-Delivery": "delivery-123",
          ...(event ? { "X-GitHub-Event": event } : {}),
        },
        body: raw,
      });
    let event = "pull_request";
    assert.equal((await post("forged")).status, 401);
    event = "";
    assert.equal((await post(signature)).status, 400, "an event type is required");
    event = "pull_request";
    const first = await post(signature);
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { accepted: true, duplicate: false, woke: 1 });
    const second = await post(signature);
    assert.deepEqual(await second.json(), { accepted: false, duplicate: true, woke: 1 });
    // Only the task bound to PR #7 is woken; PR #8 in the same repository is untouched.
    assert.deepEqual(store.due(), [task.id]);
    assert.equal(store.get(task.id).payment.state, "NotRequested");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("payout details are private, validated, policy-bound and immutable after acceptance", async () => {
  const { service, store } = setup();
  const created = await service.create(input);
  let task = store.get(created.task.id);
  assert.throws(
    () => service.accept(task, "developer", task.policyHash),
    /save payout/,
  );
  assert.throws(
    () => service.setPayout(task, "client", bank),
    /Only the developer/,
  );
  for (const invalid of [
    { ...bank, iban: "FR0020041010050500013M02606" },
    { ...bank, country: "XX" },
    { ...bank, firstName: "" },
  ])
    assert.throws(() => service.setPayout(task, "developer", invalid));
  const oldHash = task.policyHash;
  service.setPayout(task, "developer", {
    ...bank,
    iban: "fr14 2004 1010 0505 0001 3m02 606",
  });
  task = store.get(task.id);
  assert.equal(payoutFor(task).iban, bank.iban);
  assert.notEqual(task.policyHash, oldHash);
  assert.throws(() => service.accept(task, "client", oldHash), /exact policy/);
  const publicJson = JSON.stringify(service.public(task));
  assert.equal(publicJson.includes(bank.iban), false);
  assert.equal(publicJson.includes(task.payout!.salt), false);
  const other = await service.create(input);
  const second = store.get(other.task.id);
  service.setPayout(second, "developer", bank);
  assert.notEqual(second.policy.payoutCommitment, task.policy.payoutCommitment);
  service.accept(task, "client", task.policyHash);
  assert.throws(() => service.setPayout(task, "developer", bank), /locked/);
  task.payout!.iban = "DE89370400440532013000";
  assert.throws(() => payoutFor(task), /integrity/);
  store.close();
});

test("a changed private destination blocks automatic release", async () => {
  const { service, store } = setup();
  const task = await prepared(service);
  task.fixture = "merged";
  task.payout!.lastName = "Changed";
  store.save(task);
  store.enqueue(task.id);
  await service.tick();
  assert.equal(store.get(task.id).payment.state, "NotRequested");
  assert.match(store.get(task.id).payment.error!, /destination integrity/);
  store.close();
});

test("developer destination must differ from the client refund mask", async () => {
  const { service, store } = setup();
  const guarded = new TaskService(store, service.github, service.payments, {
    ...config,
    refundShortIban: "FR14...2606",
  });
  const created = await guarded.create(input);
  assert.throws(
    () => guarded.setPayout(store.get(created.task.id), "developer", bank),
    /refund account/,
  );
  store.close();
});

test("provider-issued fictional IBAN exceptions apply only to explicitly configured sandbox tasks", async () => {
  const { service, store } = setup();
  // Monerium sandbox example IBAN; use one issued to your own Monerium sandbox account.
  const fictional = { ...bank, iban: "EE321481067847125559" };
  const simulation = new TaskService(store, service.github, service.payments, {
    ...config,
    sandboxPayoutIbans: [fictional.iban],
  });
  const created = await simulation.create(input);
  const task = store.get(created.task.id);
  assert.throws(
    () => simulation.setPayout(task, "developer", fictional),
    /valid SEPA IBAN/,
  );
  const sandbox = new TaskService(store, service.github, service.payments, {
    ...config,
    mode: "sandbox",
    githubMode: "live",
    sandboxPayoutIbans: [fictional.iban],
  });
  sandbox.setPayout(task, "developer", fictional);
  assert.equal(payoutFor(task).iban, fictional.iban);
  assert.throws(
    () =>
      sandbox.setPayout(task, "developer", {
        ...fictional,
        iban: "EE321481067847125558",
      }),
    /valid SEPA IBAN/,
  );
  store.close();
});

test("GitHub adapter pins the merge-SHA API contract and holds incomplete merge metadata", async () => {
  const { service, store } = setup();
  const task = await prepared(service);
  const mock: typeof fetch = async (url, options) => {
    assert.equal(
      new Headers(options?.headers).get("X-GitHub-Api-Version"),
      "2022-11-28",
    );
    assert.ok(String(url).endsWith("/pulls/7"));
    return new Response(
      JSON.stringify({ merged: true, merge_commit_sha: null }),
    );
  };
  await assert.rejects(
    () => new GitHub({ token: "test-token" }, mock).evidence(task),
    /valid merge commit SHA/,
  );
  store.close();
});

test("empty workflow PR metadata needs matching GitHub commit association and run origin", async () => {
  const { service, store } = setup();
  const task = await prepared(service);
  let associated = true;
  let correctOrigin = true;
  const mock: typeof fetch = async (url) => {
    const path = String(url);
    let data: unknown;
    if (path.endsWith("/pulls/7"))
      data = {
        number: 7,
        base: { repo: { id: 100 }, ref: "main" },
        head: { sha: "head", ref: "work", repo: { id: 100 } },
        user: { id: 200 },
        merged: false,
        merged_by: null,
        merged_at: null,
        html_url: "https://github.com/example/repo/pull/7",
      };
    else if (path.includes("check-runs"))
      data = {
        check_runs: [
          {
            id: 1,
            name: "acceptance",
            app: { id: 15368 },
            head_sha: "head",
            status: "completed",
            conclusion: "success",
            check_suite: { id: 2 },
          },
        ],
      };
    else if (path.includes("/actions/runs"))
      data = {
        workflow_runs: [
          {
            id: 3,
            event: "pull_request",
            head_sha: "head",
            head_branch: "work",
            head_repository: { id: correctOrigin ? 100 : 999 },
            path: task.policy.workflowPath,
            check_suite_id: 2,
            pull_requests: [],
            conclusion: "success",
          },
        ],
      };
    else if (path.includes("/contents/"))
      data = { type: "file", sha: "1".repeat(40) };
    else if (path.includes("/commits/head/pulls"))
      data = associated
        ? [
            {
              number: 7,
              head: { sha: "head", repo: { id: 100 } },
              base: { repo: { id: 100 } },
            },
          ]
        : [];
    else throw new Error(`Unexpected test request: ${path}`);
    return new Response(JSON.stringify(data));
  };
  const github = new GitHub({ token: "test-token" }, mock);
  assert.deepEqual((await github.evidence(task)).runs[0]!.prNumbers, [7]);
  associated = false;
  assert.deepEqual((await github.evidence(task)).runs[0]!.prNumbers, []);
  associated = true;
  correctOrigin = false;
  assert.deepEqual((await github.evidence(task)).runs[0]!.prNumbers, []);
  store.close();
});

test("sandbox funding admission orders jobs without deadlocking and isolates bank profiles", async () => {
  const { service, store } = setup();
  const base = await prepared(service);
  const first: Task = {
    ...structuredClone(base),
    id: "first",
    mode: "sandbox",
    jobId: 3,
    funded: false,
    bankProfileKey: "bank-one",
  };
  const second: Task = { ...structuredClone(first), id: "second", jobId: 4 };
  const queued: Task = { ...structuredClone(first), id: "queued", jobId: null };
  assert.equal(
    fundingBlocker([first, second, queued], first, "bank-one"),
    undefined,
  );
  assert.equal(
    fundingBlocker([first, second, queued], second, "bank-one")?.id,
    "first",
  );
  assert.equal(
    fundingBlocker([first, second, queued], queued, "bank-one")?.id,
    "first",
  );
  first.funded = true;
  assert.equal(fundingBlocker([first, second], second, "bank-one"), undefined);
  second.bankProfileKey = "bank-two";
  assert.equal(fundingBlocker([first, second], queued, "bank-one"), undefined);
  store.close();
});
