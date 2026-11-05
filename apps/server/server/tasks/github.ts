import { createHash, createHmac, createSign, timingSafeEqual } from "node:crypto";
import { ProviderFailure, ProviderGate, TtlCache, backoff, retryAfterMs } from "../ops/provider.ts";
import { metrics } from "../ops/metrics.ts";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrEvidence, Task, TaskPolicy } from "./domain.ts";

export function validWebhook(
  raw: Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

/** Error carrying GitHub's HTTP status; the message keeps the historical "(status)" format. */
export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

// Per credential (and per fetch implementation, which isolates tests): a provider gate with its
// own budget and Retry-After pause, ETag revalidation, and a cache for SHA-addressed content.
interface CredentialState {
  gate: ProviderGate;
  etags: TtlCache<{ etag: string; body: unknown; at: number }>;
  immutable: TtlCache<unknown>;
}
const states = new WeakMap<object, Map<string, CredentialState>>();
const SHA = /^[a-f0-9]{40}$/i;
/** Responses addressed by commit SHA never change. */
export function immutablePath(path: string) {
  const url = new URL(path, "https://api.github.com");
  if (/^\/repos\/[^/]+\/[^/]+\/contents\//.test(url.pathname)) return SHA.test(url.searchParams.get("ref") ?? "");
  const commit = /^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)$/.exec(url.pathname);
  return Boolean(commit && SHA.test(commit[1]!));
}
const numberEnv = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
export function githubState(request: object, credential: string): CredentialState {
  let byCredential = states.get(request);
  if (!byCredential) states.set(request, (byCredential = new Map()));
  let state = byCredential.get(credential);
  if (!state) {
    state = {
      gate: new ProviderGate("github", {
        concurrency: numberEnv("GITHUB_CONCURRENCY", 4),
        hourlyBudget: numberEnv("GITHUB_HOURLY_BUDGET", 3000),
        timeoutMs: numberEnv("GITHUB_TIMEOUT_MS", 20_000),
        failureThreshold: 5,
        openMs: 30_000,
      }, undefined, false),
      etags: new TtlCache(2000),
      immutable: new TtlCache(5000),
    };
    byCredential.set(credential, state);
    // Bound the number of tracked credentials; the oldest is dropped (it only loses cache).
    if (byCredential.size > 500) byCredential.delete(byCredential.keys().next().value!);
  }
  return state;
}
/** Test harnesses point this at a local mock; hosted mode refuses any other value. */
export const apiBase = () => process.env.GITHUB_API_BASE ?? "https://api.github.com";
const credentialId = (secret: string) => createHash("sha256").update(secret).digest("hex").slice(0, 24);
let cliToken: { value: string; at: number } | undefined;

/** Translate rate-limit signals into a pause and a ProviderFailure the gate understands. */
async function inspect(response: Response, state: CredentialState, method: string) {
  const now = Date.now();
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
  const reserve = numberEnv("GITHUB_RATE_RESERVE", 100);
  if (remaining !== null && Number(remaining) <= reserve && Number.isFinite(reset) && reset > now)
    state.gate.pause(reset, "primary rate limit reserve reached");
  if (response.status === 429 || response.status === 403) {
    const text = response.status === 403 ? await response.clone().text().catch(() => "") : "";
    const limited = response.status === 429 || remaining === "0" || response.headers.has("retry-after") || /rate limit/i.test(text);
    if (limited) {
      const wait = retryAfterMs(response.headers.get("retry-after")) ?? (remaining === "0" && reset > now ? reset - now : 60_000);
      metrics.inc("github_rate_limited_total", { status: response.status });
      throw new ProviderFailure(`GitHub ${method} failed (${response.status}); GitHub rate limit reached, retrying later.`, wait, response.status);
    }
  }
  if (response.status >= 500) throw new ProviderFailure(`GitHub ${method} failed (${response.status}); GitHub is unavailable, retrying later.`, undefined, response.status);
}

export class GitHub {
  private cached?: { token: string; expiresAt: number };
  constructor(
    private readonly config: {
      token?: string;
      getToken?: () => Promise<string>;
      appId?: string;
      installationId?: string;
      privateKeyFile?: string;
      useGhCli?: boolean;
    },
    private readonly request: typeof fetch = fetch,
  ) {}
  /** Stable, non-reversible identifier of the credential used for quota and cache isolation. */
  credential() {
    if (this.config.token) return `token:${credentialId(this.config.token)}`;
    if (this.config.useGhCli) return "cli";
    return `app:${this.config.appId ?? ""}:${this.config.installationId ?? ""}`;
  }
  private state() {
    return githubState(this.request, this.credential());
  }
  private async token(): Promise<string> {
    if (this.config.token) return this.config.token;
    if (this.config.useGhCli) {
      // Read the already-authorized CLI credential into memory; never print or persist it.
      if (cliToken && Date.now() - cliToken.at < 300_000) return cliToken.value;
      const result = await promisify(execFile)("gh", ["auth", "token"], {
        timeout: 10_000,
      });
      cliToken = { value: result.stdout.trim(), at: Date.now() };
      return cliToken.value;
    }
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000)
      return this.cached.token;
    const { appId, installationId, privateKeyFile } = this.config;
    if (!appId || !installationId || !privateKeyFile)
      throw new Error(
        "Configure a GitHub App installation or GITHUB_TOKEN for live verification.",
      );
    const now = Math.floor(Date.now() / 1000);
    const body = [
      Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
        "base64url",
      ),
      Buffer.from(
        JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
      ).toString("base64url"),
    ].join(".");
    const signer = createSign("RSA-SHA256").update(body);
    const jwt = `${body}.${signer.sign(readFileSync(privateKeyFile), "base64url")}`;
    const response = await this.request(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok)
      throw new Error(
        `GitHub installation authentication failed (${response.status})`,
      );
    const result = (await response.json()) as {
      token: string;
      expires_at: string;
    };
    this.cached = {
      token: result.token,
      expiresAt: Date.parse(result.expires_at),
    };
    return result.token;
  }
  /**
   * Read through the credential's gate. Identical concurrent reads share one request; SHA-addressed
   * content is served from cache; other reads revalidate with ETags (304s do not consume GitHub's
   * primary quota). `maxAgeMs` lets non-payment metadata reuse a recent answer without a request.
   */
  async get<T>(path: string, options: { maxAgeMs?: number } = {}): Promise<T> {
    if (this.config.getToken) this.config.token = await this.config.getToken();
    const state = this.state();
    if (immutablePath(path)) {
      const hit = state.immutable.get(path);
      if (hit !== undefined) {
        metrics.inc("github_cache_hits_total", { kind: "immutable" });
        return structuredClone(hit) as T;
      }
    }
    if (options.maxAgeMs) {
      const recent = state.etags.get(path);
      if (recent && Date.now() - recent.at < options.maxAgeMs) {
        metrics.inc("github_cache_hits_total", { kind: "recent" });
        return structuredClone(recent.body) as T;
      }
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await state.gate.run((signal) => this.fetchOnce(path, state, signal), { key: path, op: "read" });
        return structuredClone(value) as T;
      } catch (error) {
        // Bounded retry for transient 5xx/timeouts only; rate limits pause the gate instead.
        const transient = error instanceof ProviderFailure && error.retryAfterMs === undefined;
        if (!transient || attempt >= 2) throw error;
        await new Promise((r) => setTimeout(r, backoff(attempt, 500, 4000)));
      }
    }
  }
  private async fetchOnce(path: string, state: CredentialState, signal: AbortSignal): Promise<unknown> {
    const cached = state.etags.get(path);
    const response = await this.request(`${apiBase()}${path}`, {
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(cached ? { "If-None-Match": cached.etag } : {}),
      },
      signal,
    });
    await inspect(response, state, "read");
    if (response.status === 304 && cached) {
      metrics.inc("github_cache_hits_total", { kind: "etag" });
      state.etags.set(path, { ...cached, at: Date.now() }, 3_600_000);
      return cached.body;
    }
    if (!response.ok) {
      if (response.status === 401) {
        // A revoked or rotated credential must not keep serving cached answers.
        state.etags.deleteWhere(() => true);
        state.immutable.deleteWhere(() => true);
      }
      throw new GitHubError(
        response.status,
        `GitHub read failed (${response.status}); check installation permissions and repository access.`,
      );
    }
    const body = (await response.json()) as unknown;
    const etag = response.headers.get("etag");
    if (etag) state.etags.set(path, { etag, body, at: Date.now() }, 3_600_000);
    if (immutablePath(path)) state.immutable.set(path, body, 86_400_000);
    return body;
  }
  /** Non-idempotent writes: admitted by the same gate (budget, pause, circuit) but never retried. */
  async write<T>(path: string, method: string, body: unknown): Promise<T> {
    if (this.config.getToken) this.config.token = await this.config.getToken();
    const state = this.state();
    return state.gate.run(async (signal) => {
      const response = await this.request(`${apiBase()}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(body),
        signal,
      });
      await inspect(response, state, method);
      if (!response.ok)
        throw new GitHubError(response.status, `GitHub ${method} failed (${response.status}). Check repository permissions.`);
      return (await response.json()) as T;
    }, { op: "write", enforceTimeout: false });
  }
  private async list<T>(path: string, key: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.get<Record<string, T[]>>(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const rows = data[key];
      if (!Array.isArray(rows))
        throw new Error("Unexpected GitHub pagination response");
      all.push(...rows);
      if (rows.length < 100) return all;
    }
    throw new Error(
      "GitHub evidence exceeds the demo pagination limit; manual review required.",
    );
  }
  async file(
    repository: string,
    path: string,
    ref: string,
  ): Promise<{ path: string; blobSha: string }> {
    const file = await this.get<{ type: string; sha: string }>(
      `/repos/${repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
    );
    if (file.type !== "file")
      throw new Error(`Protected path must be a file: ${path}`);
    return { path, blobSha: file.sha };
  }
  async policy(input: {
    repository: string;
    branch: string;
    developer: string;
    open?: boolean;
    maintainer: string;
    workflowPath: string;
    protectedPaths: string[];
    checkName: string;
    checkAppId: number;
  }): Promise<
    Pick<
      TaskPolicy,
      | "repositoryId"
      | "baselineSha"
      | "developerId"
      | "developerLogin"
      | "mergerIds"
      | "protectedFiles"
      | "checks"
    >
  > {
    const [repo, developer, maintainer, branch, permission] = await Promise.all(
      [
        this.get<{ id: number; allow_squash_merge: boolean }>(
          `/repos/${input.repository}`,
        ),
        input.open
          ? Promise.resolve({ id: 0, login: "Unclaimed" })
          : this.get<{ id: number; login: string }>(
              `/users/${encodeURIComponent(input.developer)}`,
            ),
        this.get<{ id: number }>(
          `/users/${encodeURIComponent(input.maintainer)}`,
        ),
        this.get<{ commit: { sha: string } }>(
          `/repos/${input.repository}/branches/${encodeURIComponent(input.branch)}`,
        ),
        this.get<{ permission: string }>(
          `/repos/${input.repository}/collaborators/${encodeURIComponent(input.maintainer)}/permission`,
        ),
      ],
    );
    if (!["admin", "maintain", "write"].includes(permission.permission))
      throw new Error(
        "The client maintainer must have repository write permission.",
      );
    if (developer.id === maintainer.id)
      throw new Error(
        "Use separate client-maintainer and developer identities.",
      );
    const protectedFiles = await Promise.all(
      [...new Set([input.workflowPath, ...input.protectedPaths])].map((path) =>
        this.file(input.repository, path, branch.commit.sha),
      ),
    );
    return {
      repositoryId: repo.id,
      baselineSha: branch.commit.sha,
      developerId: developer.id,
      developerLogin: developer.login,
      mergerIds: [maintainer.id],
      protectedFiles,
      checks: [{ name: input.checkName, appId: input.checkAppId }],
    };
  }
  async evidence(t: Task): Promise<PrEvidence> {
    const repo = t.policy.repository;
    const pr = await this.get<any>(`/repos/${repo}/pulls/${t.prNumber}`);
    // Pin the API version that supplies the post-merge SHA; never substitute a branch tip.
    if (
      pr.merged &&
      (typeof pr.merge_commit_sha !== "string" ||
        !/^[a-f0-9]{40}$/i.test(pr.merge_commit_sha))
    )
      throw new Error(
        "GitHub did not supply a valid merge commit SHA; automatic payment is held.",
      );
    const [checks, runs, protectedFiles, commit] = await Promise.all([
      this.list<any>(
        `/repos/${repo}/commits/${pr.head.sha}/check-runs?filter=latest`,
        "check_runs",
      ),
      this.list<any>(
        `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(pr.head.sha)}&event=pull_request`,
        "workflow_runs",
      ),
      Promise.all(
        t.policy.protectedFiles.map((file) =>
          this.file(repo, file.path, pr.head.sha),
        ),
      ),
      pr.merged
        ? this.get<any>(`/repos/${repo}/commits/${pr.merge_commit_sha}`)
        : Promise.resolve(null),
    ]);
    // GitHub can return an empty run.pull_requests even for a genuine PR run.
    // Recover that association only from GitHub's commit→PR endpoint, and only for
    // the same PR head, source repository/branch, and pull_request event.
    const candidates = runs.filter(
      (r) =>
        !r.pull_requests?.length &&
        r.event === "pull_request" &&
        r.head_sha === pr.head.sha &&
        r.head_branch === pr.head.ref &&
        r.head_repository?.id === pr.head.repo?.id,
    );
    if (candidates.length) {
      const associated = await this.get<any[]>(
        `/repos/${repo}/commits/${pr.head.sha}/pulls?per_page=100`,
      );
      if (!Array.isArray(associated))
        throw new Error("Unexpected GitHub commit association response");
      const matches = associated.some(
        (p) =>
          p.number === pr.number &&
          p.head?.sha === pr.head.sha &&
          p.head?.repo?.id === pr.head.repo?.id &&
          p.base?.repo?.id === pr.base.repo.id,
      );
      if (matches)
        for (const run of candidates)
          run.pull_requests = [{ number: pr.number }];
    }
    // Also pin the protected files in the resulting merged tree, not just the PR branch.
    if (pr.merged) {
      const mergedFiles = await Promise.all(
        t.policy.protectedFiles.map((file) =>
          this.file(repo, file.path, pr.merge_commit_sha),
        ),
      );
      for (const file of mergedFiles)
        if (
          protectedFiles.find((f) => f.path === file.path)?.blobSha !==
          file.blobSha
        )
          throw new Error(
            `Verification file changed in the merge: ${file.path}`,
          );
    }
    return {
      repositoryId: pr.base.repo.id,
      prNumber: pr.number,
      url: pr.html_url,
      authorId: pr.user.id,
      branch: pr.base.ref,
      headSha: pr.head.sha,
      mergeSha: pr.merged ? pr.merge_commit_sha : null,
      merged: pr.merged,
      mergedById: pr.merged_by?.id ?? null,
      mergedAt: pr.merged_at,
      mergeParents: commit?.parents.map((p: { sha: string }) => p.sha) ?? [],
      checks: checks.map((c) => ({
        id: c.id,
        name: c.name,
        appId: c.app.id,
        headSha: c.head_sha,
        status: c.status,
        conclusion: c.conclusion,
        suiteId: c.check_suite.id,
      })),
      runs: runs.map((r) => ({
        id: r.id,
        headSha: r.head_sha,
        path: r.path,
        suiteId: r.check_suite_id,
        prNumbers: (r.pull_requests ?? []).map(
          (p: { number: number }) => p.number,
        ),
        conclusion: r.conclusion,
      })),
      protectedFiles,
      observedAt: new Date().toISOString(),
    };
  }
}

/** Explicit fixture adapter: never selected in live GitHub or sandbox payment mode. */
export function fixtureEvidence(t: Task): PrEvidence {
  const sha = "a".repeat(40);
  const passing = ["ready", "merged", "tampered"].includes(t.fixture);
  return {
    repositoryId: t.policy.repositoryId,
    prNumber: t.prNumber!,
    url: `https://github.com/${t.policy.repository}/pull/${t.prNumber}`,
    authorId: t.policy.developerId,
    branch: t.policy.branch,
    headSha: sha,
    merged: t.fixture === "merged",
    mergeSha: t.fixture === "merged" ? "b".repeat(40) : null,
    mergedAt: t.fixture === "merged" ? new Date().toISOString() : null,
    mergedById: t.policy.mergerIds[0]!,
    mergeParents: ["c".repeat(40)],
    checks: t.policy.checks.map((c, i) => ({
      ...c,
      id: i + 1,
      headSha: sha,
      status: "completed",
      conclusion: passing ? "success" : "failure",
      suiteId: 1,
    })),
    runs: [
      {
        id: 1,
        headSha: sha,
        path: t.policy.workflowPath,
        suiteId: 1,
        prNumbers: [t.prNumber!],
        conclusion: passing ? "success" : "failure",
      },
    ],
    protectedFiles: t.policy.protectedFiles.map((f) => ({
      ...f,
      blobSha: t.fixture === "tampered" ? "d".repeat(40) : f.blobSha,
    })),
    observedAt: new Date().toISOString(),
  };
}
