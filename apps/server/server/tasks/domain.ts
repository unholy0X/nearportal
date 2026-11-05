import type { PayoutDetails } from "./payout.ts";
import { createHash } from "node:crypto";

export interface TaskPolicy {
  version: 1;
  title: string;
  description?: string;
  submissionCode?: string;
  criteria: string[];
  amountCents: number;
  currency: "EUR" | "USD";
  paymentRail?: "base-usdc";
  /** Client destination, fixed in the funding agreement before deposits. */
  refundAddress?: string;
  repository: string;
  repositoryId: number;
  branch: string;
  developerId: number;
  developerLogin: string;
  mergerIds: number[];
  checks: { name: string; appId: number }[];
  workflowPath: string;
  protectedFiles: { path: string; blobSha: string }[];
  baselineSha: string;
  mergeMethod: "squash" | "any";
  verifier: string;
  recipient: string;
  payoutCommitment?: string;
  assignmentRule?: "first-eligible-github-claim";
  /** Fixed price with a delivery deadline (versioned terms, part of the funded agreement). */
  market?: { version: 1; kind: "fixed"; deliveryHours: number };
  /** Current exclusive assignment; part of the assignment policy hash, never of the funding hash. */
  assignment?: { generation: number; marker: string };
}

export interface PrEvidence {
  repositoryId: number;
  prNumber: number;
  url: string;
  authorId: number;
  branch: string;
  headSha: string;
  mergeSha: string | null;
  merged: boolean;
  mergedById: number | null;
  mergedAt: string | null;
  mergeParents: string[];
  checks: {
    id: number;
    name: string;
    appId: number;
    headSha: string;
    status: string;
    conclusion: string | null;
    suiteId: number;
  }[];
  runs: {
    id: number;
    headSha: string;
    path: string;
    suiteId: number;
    prNumbers: number[];
    conclusion: string | null;
  }[];
  protectedFiles: { path: string; blobSha: string }[];
  observedAt: string;
}

export interface Verdict {
  status: "eligible" | "pending" | "blocked";
  reasons: string[];
  evidenceHash: string;
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

/** Pure evaluator. Evidence comes from GitHub API reads, never from a browser/webhook claim. */
export function evaluate(
  policy: TaskPolicy,
  pr: number,
  e: PrEvidence,
): Verdict {
  const blocked: string[] = [];
  const pending: string[] = [];
  if (e.prNumber !== pr || e.repositoryId !== policy.repositoryId)
    blocked.push(
      "The pull request does not match this task's repository and submission.",
    );
  if (e.authorId !== policy.developerId)
    blocked.push("The PR author is not the assigned developer.");
  if (e.branch !== policy.branch)
    blocked.push("The PR targets a different branch.");
  if (!e.merged) pending.push("Waiting for the client to merge the PR.");
  if (e.merged && !policy.mergerIds.includes(e.mergedById ?? -1))
    blocked.push("The PR was not merged by an agreed client maintainer.");
  if (e.merged && (!e.mergeSha || !e.mergeParents.length))
    blocked.push("Verified merge commit evidence is required.");
  if (e.merged && policy.mergeMethod === "squash" && e.mergeParents.length !== 1)
    blocked.push("This existing agreement requires a squash merge with one parent.");
  if (policy.mergeMethod !== "squash" && policy.mergeMethod !== "any")
    blocked.push("Unsupported merge policy.");
  for (const file of policy.protectedFiles) {
    if (
      e.protectedFiles.find((f) => f.path === file.path)?.blobSha !==
      file.blobSha
    )
      blocked.push(`The agreed verification file changed: ${file.path}`);
  }
  for (const required of policy.checks) {
    const checks = e.checks
      .filter(
        (c) =>
          c.name === required.name &&
          c.appId === required.appId &&
          c.headSha === e.headSha,
      )
      .sort((a, b) => b.id - a.id);
    const check = checks[0];
    if (!check || check.status !== "completed") {
      pending.push(`Waiting for ${required.name} on the submitted commit.`);
      continue;
    }
    if (check.conclusion !== "success")
      blocked.push(`${required.name} did not succeed on the submitted commit.`);
    const run = e.runs.find(
      (r) =>
        r.suiteId === check.suiteId &&
        r.headSha === e.headSha &&
        r.path === policy.workflowPath &&
        r.prNumbers.includes(pr),
    );
    // The workflow run proves this selected check's provenance. Its aggregate result
    // also includes unselected jobs; only the selected check's success gates payment.
    if (!run)
      blocked.push(
        `${required.name} has no matching run from the agreed acceptance workflow.`,
      );
  }
  const reasons = [...blocked, ...pending];
  return {
    status: blocked.length
      ? "blocked"
      : pending.length
        ? "pending"
        : "eligible",
    reasons,
    evidenceHash: hash({ policyHash: hash(policy), pr, evidence: e }),
  };
}

export type PaymentState =
  | "NotRequested"
  | "Authorized"
  | "Signing"
  | "Signed"
  | "Submitted"
  | "Processed"
  | "NeedsAttention";
export interface Task {
  id: string;
  mode: "simulation" | "sandbox";
  githubMode: "fixture" | "live";
  bankProfileKey?: string;
  refund?: {state: PaymentState; reference: string|null; error: string|null};
  crypto?: { startBlock: string; scanBlock: string; address: string; depositedUnits: string; surplusUnits: string; verifiedFundingHash?: string; deposits?: { txHash: string; logIndex: number; blockNumber: string; units: string }[]; receiptBackfillTo?: string };
  ownerId?: number;
  mergeMethodAmendment?: import("./merge-policy.ts").MergeMethodAmendment;
  portalId?: string;
  openBounty?: boolean;
  fundingPolicy?: TaskPolicy;
  fundingPolicyHash?: string;
  policy: TaskPolicy;
  policyHash: string;
  payout?: PayoutDetails;
  clientTokenHash: string;
  developerTokenHash: string;
  clientAccepted: boolean;
  developerAccepted: boolean;
  funded: boolean;
  fundedAt: string | null;
  disputed: boolean;
  prNumber: number | null;
  jobId: number | null;
  verdict: Verdict | null;
  evidence: PrEvidence | null;
  payment: {
    state: PaymentState;
    reference: string | null;
    error: string | null;
    /** NEAR transaction that marked the payout processed (explorer receipt). */
    txHash?: string | null;
  };
  /** Timely submission received by the server for the current assignment (fixed-deadline mode). */
  marketSubmission?: { generation: number; prNumber: number; headSha: string; receivedAt: number; relayedAt?: number | null } | null;
  overpayment?: { recordedCents: number; refunds: { amountCents: number; state: string; reference: string; txHash?: string | null }[] };
  fixture: "open" | "failed" | "ready" | "merged" | "tampered";
  timeline: { at: string; message: string }[];
  createdAt: string;
}

export const note = (t: Task, message: string) =>
  t.timeline.push({ at: new Date().toISOString(), message });
