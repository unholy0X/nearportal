// Deadline bounties: detect a PR that carries the assignment marker but has not been submitted.
// Display only. It never binds a PR or records a submission: the assigned developer's explicit
// submission (server reception time + exact commit) remains the delivery proof.
import { hasTaskMarker } from "./judge.ts";

export interface CandidateAssignment { generation: number; userId: number; marker: string; acceptedAt: number | null; confirmed: boolean; submission: unknown }
export interface Candidate { generation: number; prNumber: number; merged: boolean }

/** Mirrors the checks of FixedBounties.submit(): assigned author, agreed branch, marker, opened after the assignment, not closed unmerged. */
export function findCandidate(prs: any[], a: CandidateAssignment, branch: string): Candidate | null {
  if (!a.confirmed || a.submission || a.acceptedAt == null) return null;
  const match = prs
    .filter((p) => p?.user?.id === a.userId && p?.base?.ref === branch && hasTaskMarker(String(p?.body ?? ""), a.marker) &&
      Date.parse(p?.created_at ?? "") >= a.acceptedAt! - 60_000 && (p?.state === "open" || Boolean(p?.merged_at)))
    .sort((x, y) => Date.parse(y.updated_at ?? "") - Date.parse(x.updated_at ?? ""))[0];
  return match ? { generation: a.generation, prNumber: Number(match.number), merged: Boolean(match.merged_at) } : null;
}

/** Only the creator and the assignee see the hint, and only for the current, unsubmitted assignment. */
export function withCandidate<V extends { assignment: (CandidateAssignment & Record<string, unknown>) | null }>(view: V | null, ownerId: number, viewerId: number | undefined, raw: string | undefined): V | null {
  const a = view?.assignment;
  if (!view || !a || a.submission || viewerId == null || (viewerId !== ownerId && viewerId !== a.userId)) return view;
  try {
    const c = JSON.parse(raw || "null") as Candidate | null;
    if (c && c.generation === a.generation && Number.isSafeInteger(c.prNumber) && c.prNumber > 0)
      return { ...view, assignment: { ...a, candidate: { prNumber: c.prNumber, merged: Boolean(c.merged) } } };
  } catch { /* a stale or malformed hint is simply not shown */ }
  return view;
}
