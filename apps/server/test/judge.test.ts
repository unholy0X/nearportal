import test from "node:test";
import assert from "node:assert/strict";
import {
  judgeConfig,
  hasTaskMarker,
  preparedPrUrl,
  canAutoMerge,
  canApproveJudgeRun,
} from "../server/portal/judge.ts";
import { loginReturnPath, frontendLoginLocation } from "../server/portal/auth.ts";
import { hash } from "../server/tasks/domain.ts";
import { TaskStore } from "../server/tasks/store.ts";
import { TaskService } from "../server/tasks/service.ts";
import { GitHub, fixtureEvidence } from "../server/tasks/github.ts";
import { SimulatedPayments } from "../server/tasks/payments.ts";
const id = "11111111-1111-4111-a111-111111111111",
  branch = "codex/nearportal-task/judge-1",
  headSha = "a".repeat(40);
test("judge configuration is explicit, bounded, and binds exact prepared commits", () => {
  assert.equal(judgeConfig({}).enabled, false);
  assert.equal(judgeConfig({ PORTAL_JUDGE_AUTO_MERGE: "1" }).autoMerge, false);
  assert.throws(() => judgeConfig({ PORTAL_JUDGE_DEMO: "1" }), /repository/);
  assert.throws(
    () =>
      judgeConfig({
        PORTAL_JUDGE_DEMO: "1",
        PORTAL_JUDGE_REPOSITORY: "client/demo",
        PORTAL_JUDGE_BOUNTIES: JSON.stringify({
          [id]: { branch, headSha: "any" },
        }),
      }),
    /exact prepared/,
  );
  const c = judgeConfig({
    PORTAL_JUDGE_DEMO: "1",
    PORTAL_JUDGE_REPOSITORY: "client/demo",
    PORTAL_JUDGE_BOUNTIES: JSON.stringify({ [id]: { branch, headSha } }),
  });
  assert.equal(c.autoMerge, false);
  assert.deepEqual(c.tasks[id], { branch, headSha });
  const url = new URL(
    preparedPrUrl(
      c.repository,
      "main",
      c.tasks[id]!,
      "NP-1234567890",
      "CSV & quotes",
    ),
  );
  assert.equal(url.searchParams.get("title"), "CSV & quotes");
  assert.ok(hasTaskMarker(url.searchParams.get("body")!, "NP-1234567890"));
});
test("PR identifiers match one exact line with normal GitHub CRLF endings", () => {
  assert.equal(
    hasTaskMarker(
      "Description\r\nNearPortal-Task: NP-1234567890\r\n\r\nCloses #5",
      "NP-1234567890",
    ),
    true,
  );
  assert.equal(
    hasTaskMarker("NearPortal-Task: NP-1234567890-extra", "NP-1234567890"),
    false,
  );
  assert.equal(
    hasTaskMarker("Mention NearPortal-Task: NP-1234567890", "NP-1234567890"),
    false,
  );
});
test("judge OAuth return path cannot redirect outside the app", () => {
  assert.equal(loginReturnPath("/demo"), "/demo");
  assert.equal(loginReturnPath("/bounties/667c9233-0720-4a36-849f-7542ad93486d"), "/bounties/667c9233-0720-4a36-849f-7542ad93486d");
  assert.equal(loginReturnPath("/bounties/667c9233-0720-4a36-849f-7542ad93486d?redirect=https://evil.test"), "/app");
  for (const v of [
    null,
    "https://evil.example",
    "//evil.example",
    "/demo?next=evil",
    "/demo/../auth/github",
  ])
    assert.equal(loginReturnPath(v), "/app");
});
test("automatic judge merge only accepts a funded public sandbox task and the preapproved passing commit", async () => {
  const store = new TaskStore(":memory:");
  const service = new TaskService(
    store,
    new GitHub({}),
    new SimulatedPayments(store),
    {
      mode: "simulation",
      githubMode: "fixture",
      verifier: "verifier",
      recipient: "receiver",
    },
  );
  const created = await service.create({
    title: "CSV",
    criteria: "Pass checks",
    amountCents: 100,
    repository: "client/demo",
  });
  const task = store.get(created.task.id);
  Object.assign(task, {
    mode: "sandbox",
    githubMode: "live",
    openBounty: true,
    portalId: id,
    ownerId: 300,
    funded: true,
    fundedAt: "2026-11-03T10:00:00Z",
    clientAccepted: true,
    developerAccepted: true,
    prNumber: 6,
    fixture: "ready",
  });
  task.policy.submissionCode = "NP-1234567890";
  task.policyHash = hash(task.policy);
  const config = judgeConfig({
    PORTAL_JUDGE_DEMO: "1",
    PORTAL_JUDGE_AUTO_MERGE: "1",
    PORTAL_JUDGE_REPOSITORY: "client/demo",
    PORTAL_JUDGE_BOUNTIES: JSON.stringify({ [id]: { branch, headSha } }),
  });
  const pr = {
    number: 6,
    state: "open",
    draft: false,
    merged: false,
    user: { id: 200 },
    created_at: "2026-11-03T10:01:00Z",
    head: { ref: branch, sha: headSha, repo: { id: 100 } },
    base: { ref: "main", repo: { id: 100, private: false } },
    body: "NearPortal-Task: NP-1234567890",
  };
  const evidence = fixtureEvidence(task);
  const ready = () => canAutoMerge(config, task, pr, evidence, 300, false);
  assert.equal(ready(), true);
  const waitingRun = { ...evidence.runs[0]!, conclusion: "action_required" };
  assert.equal(
    canApproveJudgeRun(config, task, pr, waitingRun, 300, false),
    false,
  );
  config.approveWorkflows = true;
  assert.equal(
    canApproveJudgeRun(config, task, pr, waitingRun, 300, false),
    true,
  );
  assert.equal(
    canApproveJudgeRun(
      config,
      task,
      pr,
      { ...waitingRun, prNumbers: [999] },
      300,
      false,
    ),
    false,
  );
  assert.equal(
    canApproveJudgeRun(
      config,
      task,
      pr,
      { ...waitingRun, path: ".github/workflows/other.yml" },
      300,
      false,
    ),
    false,
  );
  pr.head.repo = {
    id: 101,
    fork: true,
    owner: { id: 200 },
    parent: { id: 100 },
  } as any;
  assert.equal(ready(), true);
  (pr.head.repo as any).parent.id = 999;
  assert.equal(ready(), false);
  pr.head.repo = { id: 100 };
  assert.equal(canAutoMerge(config, task, pr, evidence, 300, true), false);
  for (const field of [
    "funded",
    "clientAccepted",
    "developerAccepted",
  ] as const) {
    task[field] = false;
    assert.equal(ready(), false);
    task[field] = true;
  }
  task.disputed = true;
  assert.equal(ready(), false);
  task.disputed = false;
  task.mode = "simulation";
  assert.equal(ready(), false);
  task.mode = "sandbox";
  pr.head.sha = "b".repeat(40);
  assert.equal(ready(), false);
  pr.head.sha = headSha;
  pr.user.id = 999;
  assert.equal(ready(), false);
  pr.user.id = 200;
  pr.created_at = "2026-11-03T09:00:00Z";
  assert.equal(ready(), false);
  pr.created_at = "2026-11-03T10:01:00Z";
  evidence.checks[0]!.conclusion = "failure";
  assert.equal(ready(), false);
  evidence.checks[0]!.conclusion = "success";
  evidence.protectedFiles[0]!.blobSha = "tampered";
  assert.equal(ready(), false);
  store.close();
});

test('OAuth returns to the fixed frontend without accepting arbitrary redirect destinations',()=>{
 const origin='http://127.0.0.1:8787',frontend='http://127.0.0.1:8791',path='/bounties/667c9233-0720-4a36-849f-7542ad93486d';
 assert.equal(frontendLoginLocation(origin,path,frontend),frontend+path);
 assert.equal(frontendLoginLocation(origin,'//evil.example',frontend),frontend+'/app');
 assert.equal(frontendLoginLocation(origin,path),path);
 for(const bad of ['https://evil.example','http://127.0.0.1:8791/other','http://user@127.0.0.1:8791','http://127.0.0.1:8791?next=evil','https://127.0.0.1:8791'])assert.throws(()=>frontendLoginLocation(origin,path,bad));
});
