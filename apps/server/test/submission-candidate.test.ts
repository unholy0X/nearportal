import test from "node:test";
import assert from "node:assert/strict";
import { findCandidate, withCandidate } from "../server/portal/submission-candidate.ts";

const accepted = Date.UTC(2026, 10, 5, 16, 4, 32);
const a = { generation: 1, userId: 77, marker: "NP-28D5750673-A1", acceptedAt: accepted, confirmed: true, submission: null };
const pr = (patch: Record<string, unknown> = {}) => ({ number: 5, user: { id: 77 }, base: { ref: "main" }, body: "Fix\n\nNearPortal-Task: NP-28D5750673-A1", state: "closed", merged_at: "2026-11-05T16:10:18Z", created_at: "2026-11-05T16:08:23Z", updated_at: "2026-11-05T16:10:18Z", ...patch });

test("a merged or open PR with the assignment marker is a candidate", () => {
  assert.deepEqual(findCandidate([pr()], a, "main"), { generation: 1, prNumber: 5, merged: true });
  assert.deepEqual(findCandidate([pr({ state: "open", merged_at: null })], a, "main"), { generation: 1, prNumber: 5, merged: false });
});

test("candidates follow the same rules as an explicit submission", () => {
  const none = (p: object, extra: Partial<typeof a> = {}) => assert.equal(findCandidate([p], { ...a, ...extra }, "main"), null);
  none(pr({ user: { id: 99 } }));                               // another author
  none(pr({ base: { ref: "dev" } }));                            // another branch
  none(pr({ body: "NearPortal-Task: NP-28D5750673-A2" }));       // another assignment
  none(pr({ created_at: "2026-11-05T15:00:00Z" }));              // opened before the assignment
  none(pr({ state: "closed", merged_at: null }));                // closed without merge
  none(pr(), { confirmed: false });                              // assignment not confirmed yet
  none(pr(), { submission: { prNumber: 5 } });                    // already submitted
});

test("only the creator and the assignee see the hint, for the current assignment", () => {
  const view = { kind: "fixed", assignment: { ...a } };
  const raw = JSON.stringify({ generation: 1, prNumber: 5, merged: true });
  assert.deepEqual((withCandidate(view, 300, 300, raw)!.assignment as any).candidate, { prNumber: 5, merged: true });
  assert.deepEqual((withCandidate(view, 300, 77, raw)!.assignment as any).candidate, { prNumber: 5, merged: true });
  assert.equal((withCandidate(view, 300, 12, raw)!.assignment as any).candidate, undefined, "visitor");
  assert.equal((withCandidate(view, 300, undefined, raw)!.assignment as any).candidate, undefined, "signed out");
  assert.equal((withCandidate(view, 300, 300, JSON.stringify({ generation: 2, prNumber: 5 }))!.assignment as any).candidate, undefined, "stale generation");
  assert.equal((withCandidate(view, 300, 300, "{bad")!.assignment as any).candidate, undefined, "malformed");
  assert.equal(withCandidate(null, 300, 300, raw), null);
});
