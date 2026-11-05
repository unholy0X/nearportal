import { evaluate, hash, type Task, type PrEvidence, type Verdict } from "./domain.ts";

/** Explicit owner amendment for an existing testnet agreement. Never rewrites its hashes. */
export interface MergeMethodAmendment {
  kind: "any-merge";
  taskId: string;
  ownerId: number;
  policyHash: string;
  fundingPolicyHash: string;
  prNumber: number;
  headSha: string;
  mergeSha: string;
  acceptedAt: string;
}

function validate(t: Task, e: PrEvidence, a: MergeMethodAmendment) {
  if (t.mode !== "sandbox" || t.githubMode !== "live" || t.policy.paymentRail !== "base-usdc")
    throw new Error("Merge amendments are limited to live testnet USDC agreements");
  if (a.kind !== "any-merge" || a.taskId !== t.id || a.ownerId !== t.ownerId || !t.policy.mergerIds.includes(a.ownerId))
    throw new Error("Only the agreed bounty owner can amend the merge method");
  if (!t.funded || !t.clientAccepted || !t.developerAccepted || t.disputed)
    throw new Error("An accepted, funded, undisputed agreement is required");
  if (t.policy.mergeMethod !== "squash" || hash(t.policy) !== t.policyHash || a.policyHash !== t.policyHash ||
      !t.fundingPolicyHash || a.fundingPolicyHash !== t.fundingPolicyHash)
    throw new Error("The original funded agreement changed");
  if (a.prNumber !== t.prNumber || a.prNumber !== e.prNumber || a.headSha !== e.headSha || a.mergeSha !== e.mergeSha ||
      !/^[a-f0-9]{40}$/i.test(a.headSha) || !/^[a-f0-9]{40}$/i.test(a.mergeSha))
    throw new Error("Merge amendment does not match the exact submitted and merged commits");
  const merged = Date.parse(e.mergedAt ?? ""), funded = Date.parse(t.fundedAt ?? ""), accepted = Date.parse(a.acceptedAt);
  if (!e.merged || !Number.isFinite(merged) || !Number.isFinite(funded) || !Number.isFinite(accepted) || merged < funded || accepted < merged)
    throw new Error("Merge amendment requires a merge after funding and before approval");
}

/** Operator must already hold explicit owner authorization; this is not a public HTTP action. */
export function approveAnyMerge(t: Task, e: PrEvidence, ownerId: number, now = new Date().toISOString()): MergeMethodAmendment {
  if (t.payment.state !== "NotRequested") throw new Error("Release has already started");
  const a: MergeMethodAmendment = t.mergeMethodAmendment ?? {
    kind: "any-merge", taskId: t.id, ownerId, policyHash: t.policyHash,
    fundingPolicyHash: t.fundingPolicyHash ?? "", prNumber: t.prNumber!,
    headSha: e.headSha, mergeSha: e.mergeSha!, acceptedAt: now,
  };
  if (a.ownerId !== ownerId) throw new Error("Owner identity does not match");
  validate(t, e, a);
  const verdict = evaluate({ ...t.policy, mergeMethod: "any" }, t.prNumber!, e);
  if (verdict.status !== "eligible") throw new Error(verdict.reasons.join(" "));
  return a;
}

export function evaluateMergePolicy(t: Task, e: PrEvidence): Verdict {
  const a = t.mergeMethodAmendment;
  if (!a) return evaluate(t.policy, t.prNumber!, e);
  const evidenceHash = hash({ policyHash: t.policyHash, pr: t.prNumber, evidence: e, mergeMethodAmendment: a });
  try {
    validate(t, e, a);
    return { ...evaluate({ ...t.policy, mergeMethod: "any" }, t.prNumber!, e), evidenceHash };
  } catch (error) {
    return { status: "blocked", reasons: [(error as Error).message], evidenceHash };
  }
}
