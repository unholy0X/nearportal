import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, hash, type Task, type PrEvidence } from "../server/tasks/domain.ts";
import { approveAnyMerge, evaluateMergePolicy } from "../server/tasks/merge-policy.ts";
const sha = (s: string) => s.repeat(40);
function fixture() {
  const policy = { version: 1, title: "Test", criteria: ["pass"], amountCents: 1, currency: "USD", paymentRail: "base-usdc",
    repository: "owner/repo", repositoryId: 1, branch: "main", developerId: 2, developerLogin: "dev", mergerIds: [1],
    checks: [{ name: "acceptance", appId: 15368 }], workflowPath: ".github/workflows/test.yml",
    protectedFiles: [{ path: "tests.ts", blobSha: "unchanged" }], baselineSha: sha("a"), mergeMethod: "squash",
    verifier: "verifier.testnet", recipient: "0x" + "1".repeat(40) } as const;
  const t = { id: "task", mode: "sandbox", githubMode: "live", ownerId: 1, policy, policyHash: hash(policy),
    fundingPolicyHash: "f".repeat(64), funded: true, fundedAt: "2026-11-04T10:00:00Z", clientAccepted: true,
    developerAccepted: true, prNumber: 9, disputed: false, payment: { state: "NotRequested" } } as unknown as Task;
  const e: PrEvidence = { repositoryId: 1, prNumber: 9, url: "", authorId: 2, branch: "main", headSha: sha("c"), mergeSha: sha("d"),
    merged: true, mergedById: 1, mergedAt: "2026-11-04T11:00:00Z", mergeParents: [sha("a"), sha("c")],
    checks: [{ id: 1, name: "acceptance", appId: 15368, headSha: sha("c"), status: "completed", conclusion: "success", suiteId: 1 }],
    runs: [{ id: 1, headSha: sha("c"), path: policy.workflowPath, suiteId: 1, prNumbers: [9], conclusion: "success" }],
    protectedFiles: [...policy.protectedFiles], observedAt: "2026-11-04T12:00:00Z" };
  return { t, e };
}
const approve = (t: Task, e: PrEvidence, owner = 1) => approveAnyMerge(t, e, owner, "2026-11-04T12:00:00Z");
test("any merge accepts squash, regular and rebased merge evidence; old agreements stay pinned", () => {
  const { t, e } = fixture();
  assert.equal(evaluate(t.policy, 9, e).status, "blocked");
  for (const parents of [[sha("a")], [sha("a"), sha("c")]])
    assert.equal(evaluate({ ...t.policy, mergeMethod: "any" }, 9, { ...e, mergeParents: parents }).status, "eligible");
  for (const patch of [{ mergeParents: [] }, { mergeSha: null }, { merged: false }, { authorId: 3 }, { mergedById: 2 },
    { branch: "other" }, { repositoryId: 3 }, { checks: [] }, { runs: [] }, { protectedFiles: [] }])
    assert.notEqual(evaluate({ ...t.policy, mergeMethod: "any" }, 9, { ...e, ...patch }).status, "eligible");
});
test("explicit merge amendment is idempotent, keeps hashes, and never waives selected CI", () => {
  const { t, e } = fixture(), before = JSON.stringify(t.policy);
  t.mergeMethodAmendment = approve(t, e);
  assert.deepEqual(approve(t, e), t.mergeMethodAmendment);
  assert.equal(evaluateMergePolicy(t, e).status, "eligible");
  assert.equal(JSON.stringify(t.policy), before);
  assert.equal(t.policyHash, hash(t.policy));
  assert.notEqual(evaluateMergePolicy(t, { ...e, checks: [] }).status, "eligible");
  assert.equal(evaluateMergePolicy(t, { ...e, runs: [] }).status, "blocked");
});
test("merge amendment fails closed on changed parties, commits, funds, timing or release", () => {
  for (const mutate of [
    (t: Task, e: PrEvidence) => { t.disputed = true; },
    (t: Task, e: PrEvidence) => { t.funded = false; },
    (t: Task, e: PrEvidence) => { t.policy.recipient = "other"; },
    (t: Task, e: PrEvidence) => { t.ownerId = 3; },
    (t: Task, e: PrEvidence) => { e.headSha = sha("e"); },
    (t: Task, e: PrEvidence) => { e.mergeSha = sha("e"); },
    (t: Task, e: PrEvidence) => { e.prNumber = 10; },
    (t: Task, e: PrEvidence) => { e.mergedAt = "2026-11-04T09:00:00Z"; },
  ]) {
    const { t, e } = fixture(); t.mergeMethodAmendment = approve(t, e); mutate(t, e);
    assert.equal(evaluateMergePolicy(t, e).status, "blocked");
  }
  const { t, e } = fixture(); assert.throws(() => approve(t, e, 2));
  t.payment.state = "Authorized"; assert.throws(() => approve(t, e));
});
