import type { GitHub } from "../tasks/github.ts";

// Read names actually reported by Actions; never execute a workflow or infer a
// payment condition from its friendly title. The chosen check is still verified
// against the submitted commit by the existing verifier.
export async function workflowChecks(gh: Pick<GitHub, "get">, repository: string, path: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
  if (!/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(path)) throw new Error("Invalid workflow path");
  const workflow = await gh.get<{ id: number; path: string }>(`/repos/${repository}/actions/workflows/${encodeURIComponent(path.split("/").at(-1)!)}`);
  if (workflow.path !== path || !Number.isSafeInteger(workflow.id)) throw new Error("Workflow not found");
  const runs = await gh.get<{ workflow_runs: { id: number }[] }>(`/repos/${repository}/actions/workflows/${workflow.id}/runs?per_page=3`);
  for (const run of runs.workflow_runs.slice(0, 3)) {
    if (!Number.isSafeInteger(run.id)) continue;
    const jobs = await gh.get<{ total_count: number; jobs: { name: string }[] }>(`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100&filter=latest`);
    // Never present an incomplete matrix as a single unambiguous check.
    if (jobs.total_count > 100) return { checkNames: [], source: "too-many-jobs" };
    const checkNames = [...new Set(jobs.jobs.map(job => job.name).filter(name => typeof name === "string" && name.trim() && name.length <= 200))];
    if (checkNames.length) return { checkNames, source: "workflow-run", runId: run.id };
  }
  return { checkNames: [], source: "no-jobs" };
}
