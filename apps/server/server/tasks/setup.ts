import type { GitHub } from "./github.ts";

// Repository inspected by the /tasks setup check. The defaults are placeholders; the protected
// paths follow the judge task repository layout (acceptance test and package.json at the root).
export const demoRepository = {
  repository: process.env.TASK_SETUP_REPOSITORY ?? "OWNER/REPOSITORY",
  client: process.env.TASK_SETUP_CLIENT ?? "OWNER",
  branch: "main",
  workflowPath: ".github/workflows/acceptance.yml",
  protectedPaths: ["test/acceptance.test.mjs", "package.json"],
};

export interface SetupStatus {
  account: string;
  repository: string;
  repositoryId: number;
  branch: string;
  client: string;
  clientCanMerge: boolean;
  squashEnabled: boolean;
  files: { path: string; ready: boolean; blobSha?: string }[];
  ready: boolean;
  developer: "pending";
  checkedAt: string;
}

/** Read-only readiness check. It never creates a task or relaxes party separation. */
export async function inspectSetup(github: GitHub, settings = demoRepository): Promise<SetupStatus> {
  const [account, repo, branch, permission] = await Promise.all([
    github.get<{ login: string }>("/user").catch((error) => {
      // Installation tokens can read repositories but do not represent a user.
      if (error instanceof Error && error.message.includes("(403)")) return { login: "GitHub App installation" };
      throw error;
    }),
    github.get<{ id: number; allow_squash_merge: boolean }>(`/repos/${settings.repository}`),
    github.get<{ commit: { sha: string } }>(`/repos/${settings.repository}/branches/${encodeURIComponent(settings.branch)}`),
    github.get<{ permission: string }>(`/repos/${settings.repository}/collaborators/${encodeURIComponent(settings.client)}/permission`),
  ]);
  const files = await Promise.all([settings.workflowPath, ...settings.protectedPaths].map(async (path) => {
    try { const file = await github.file(settings.repository, path, branch.commit.sha); return { path, ready: true, blobSha: file.blobSha }; }
    catch (error) {
      if (error instanceof Error && error.message.includes("(404)")) return { path, ready: false };
      throw error;
    }
  }));
  const clientCanMerge = ["admin", "maintain", "write"].includes(permission.permission);
  return { account: account.login, repository: settings.repository, repositoryId: repo.id, branch: settings.branch,
    client: settings.client, clientCanMerge, squashEnabled: repo.allow_squash_merge, files,
    ready: clientCanMerge && files.every((f) => f.ready), developer: "pending", checkedAt: new Date().toISOString() };
}
