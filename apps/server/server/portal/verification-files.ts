import type { GitHub } from "../tasks/github.ts";

export function suggestVerificationFiles(paths: string[]) {
  return paths.filter(path =>
    !/(^|\/)(node_modules|vendor|dist|build|target|fixtures|__snapshots__)\//i.test(path) &&
    (/(?:^|\/)(?:tests?|__tests__|specs?)\/.*\.(?:[cm]?[jt]sx?|rs|py|go|rb|java|kt|sh)$/i.test(path) ||
      /(?:\.test|\.spec|_test|_spec)\.(?:[cm]?[jt]sx?|rs|py|go|rb|java|kt|sh)$/i.test(path) || /(?:^|\/)test_[^/]+\.py$/i.test(path))
  ).sort((a, b) => Number(/acceptance/i.test(b)) - Number(/acceptance/i.test(a)) || a.localeCompare(b)).slice(0, 20);
}

export async function verificationFiles(gh: Pick<GitHub, "get">, repository: string, branch: string) {
  if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(repository) || !branch || branch.length > 200) throw new Error("Invalid repository or branch");
  const tree = await gh.get<{ truncated?: boolean; tree: { path: string; type: string }[] }>(`/repos/${repository}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  return { suggestions: suggestVerificationFiles(tree.tree.filter(item => item.type === "blob").map(item => item.path)), truncated: Boolean(tree.truncated) };
}
