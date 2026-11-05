import { evaluate, hash, type Task, type PrEvidence } from "../tasks/domain.ts";

export interface JudgeTask {
  branch: string;
  headSha: string;
}
export interface JudgeConfig {
  enabled: boolean;
  autoMerge: boolean;
  approveWorkflows: boolean;
  repository: string;
  proofId: string;
  tasks: Record<string, JudgeTask>;
}
export function judgeConfig(
  source: NodeJS.ProcessEnv = process.env,
): JudgeConfig {
  const enabled = source.PORTAL_JUDGE_DEMO === "1";
  const config: JudgeConfig = {
    enabled,
    autoMerge: enabled && source.PORTAL_JUDGE_AUTO_MERGE === "1",
    approveWorkflows:
      enabled &&
      source.PORTAL_JUDGE_AUTO_MERGE === "1" &&
      source.PORTAL_JUDGE_APPROVE_WORKFLOWS === "1",
    repository: source.PORTAL_JUDGE_REPOSITORY ?? "",
    proofId: source.PORTAL_JUDGE_PROOF_BOUNTY_ID ?? "",
    tasks: {},
  };
  if (!enabled) return config;
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository))
    throw new Error("Set the dedicated judge demo repository");
  const tasks = JSON.parse(source.PORTAL_JUDGE_BOUNTIES ?? "{}");
  if (
    !tasks ||
    typeof tasks !== "object" ||
    Array.isArray(tasks) ||
    Object.keys(tasks).length > 50
  )
    throw new Error("Invalid judge task pool");
  for (const [id, value] of Object.entries(tasks)) {
    const t = value as JudgeTask;
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      !t ||
      typeof t.branch !== "string" ||
      !/^codex\/nearportal-task\/[A-Za-z0-9._/-]{1,150}$/.test(t.branch) ||
      t.branch.includes("..") ||
      !/^[a-f0-9]{40}$/.test(t.headSha)
    )
      throw new Error(
        "Each judge task needs its exact prepared branch and commit SHA",
      );
    config.tasks[id] = { branch: t.branch, headSha: t.headSha };
  }
  return config;
}
export function hasTaskMarker(body: string, code: string) {
  return body
    .split(/\r?\n/)
    .some((line) => line.trim() === `NearPortal-Task: ${code}`);
}
export function preparedPrUrl(
  repository: string,
  base: string,
  task: JudgeTask,
  code: string,
  title: string,
  headOwner?: string,
) {
  const params = new URLSearchParams({
    expand: "1",
    title,
    body: `NearPortal-Task: ${code}\n\nPrepared sandbox judge walkthrough. Verify the acceptance checks before release.`,
  });
  return `https://github.com/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(headOwner ? `${headOwner}:${task.branch}` : task.branch)}?${params}`;
}
/** A prepared sandbox PR only. Normal customer work never enters this policy. */
export function isPreparedJudgePr(
  config: JudgeConfig,
  task: Task,
  pr: any,
  ownerId: number,
  privateRepo: boolean,
) {
  const prepared = config.tasks[task.portalId ?? ""];
  const head = pr.head?.repo;
  const trustedSource =
    head?.id === task.policy.repositoryId ||
    Boolean(
      head?.fork &&
        head?.owner?.id === task.policy.developerId &&
        head?.parent?.id === task.policy.repositoryId,
    );
  if (
    !config.enabled ||
    !config.autoMerge ||
    !prepared ||
    privateRepo ||
    task.mode !== "sandbox" ||
    task.githubMode !== "live" ||
    !task.openBounty ||
    !task.funded ||
    !task.clientAccepted ||
    !task.developerAccepted ||
    !task.policy.developerId ||
    task.policy.developerId === ownerId ||
    task.disputed ||
    hash(task.policy) !== task.policyHash ||
    !task.fundedAt ||
    !(Date.parse(pr.created_at) >= Date.parse(task.fundedAt)) ||
    task.payment.state !== "NotRequested" ||
    task.policy.repository !== config.repository ||
    task.ownerId !== ownerId ||
    !task.policy.mergerIds.includes(ownerId) ||
    pr.number !== task.prNumber ||
    pr.merged ||
    pr.draft ||
    pr.state !== "open" ||
    pr.user?.id !== task.policy.developerId ||
    pr.base?.repo?.id !== task.policy.repositoryId ||
    pr.base?.repo?.private !== false ||
    !trustedSource ||
    pr.base?.ref !== task.policy.branch ||
    pr.head?.ref !== prepared.branch ||
    pr.head?.sha !== prepared.headSha ||
    !hasTaskMarker(String(pr.body ?? ""), task.policy.submissionCode ?? "")
  )
    return false;
  return true;
}
export function canApproveJudgeRun(
  config: JudgeConfig,
  task: Task,
  pr: any,
  run: PrEvidence["runs"][number],
  ownerId: number,
  privateRepo: boolean,
) {
  return (
    config.approveWorkflows &&
    isPreparedJudgePr(config, task, pr, ownerId, privateRepo) &&
    run.headSha === pr.head.sha &&
    run.path === task.policy.workflowPath &&
    run.prNumbers.includes(pr.number) &&
    run.conclusion === "action_required"
  );
}
export function canAutoMerge(
  config: JudgeConfig,
  task: Task,
  pr: any,
  evidence: PrEvidence,
  ownerId: number,
  privateRepo: boolean,
) {
  if (
    !isPreparedJudgePr(config, task, pr, ownerId, privateRepo) ||
    evidence.headSha !== pr.head.sha
  )
    return false;
  const verdict = evaluate(task.policy, task.prNumber!, evidence);
  return (
    verdict.status === "pending" &&
    verdict.reasons.length === 1 &&
    verdict.reasons[0] === "Waiting for the client to merge the PR."
  );
}
