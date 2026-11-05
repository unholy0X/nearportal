import { GitHub } from "../tasks/github.ts";
import type { User } from "./store.ts";
export const git = (u: User, getToken?: () => Promise<string>) => {
  if (u.local && process.env.NODE_ENV === "production")
    throw new Error(
      "The repository owner must reconnect GitHub on this hosted app",
    );
  return new GitHub(u.local ? { useGhCli: true } : { token: u.token, getToken });
};
export async function ghWrite<T>(
  u: User,
  path: string,
  method: string,
  body: unknown,
): Promise<T> {
  if (u.local && process.env.NODE_ENV === "production")
    throw new Error(
      "The repository owner must reconnect GitHub on this hosted app",
    );
  // Same credential gate as reads: budget, Retry-After pause and circuit breaker; never retried.
  return git(u).write<T>(path, method, body);
}
export async function repositories(u: User, page = 1, github = git(u)) {
  const list = await github.get<any[]>(
    `/user/repos?sort=updated&per_page=50&page=${page}`,
  );
  return list.map((r) => ({
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    description: r.description ?? "",
    private: r.private,
    language: r.language,
    defaultBranch: r.default_branch,
    canWrite: Boolean(r.permissions?.push),
    url: r.html_url,
    updatedAt: r.updated_at,
  }));
}
