import type { Task, PrEvidence, Verdict } from "./domain.ts";
import { evaluateMergePolicy } from "./merge-policy.ts";

/** All developer payments require the agreed checks and creator merge. No owner waiver. */
export function evaluateRelease(task: Task, evidence: PrEvidence): Verdict {
  return evaluateMergePolicy(task, evidence);
}
