// Local credential storage for the NearPortal MCP client.
// Preference: OS keychain (macOS `security -i`, secret on stdin; Linux Secret Service `secret-tool`,
// secret on stdin). Fallback: a 0600 file in a 0700 directory outside any Git work tree.
// The bearer token is never printed, logged, or returned through MCP.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface Account {
  login: string;
  userId: number;
  scopes: string[];
  expiresAt: string;
  tokenId: string;
  backend: Backend;
  allowHttpLoopback?: boolean;
}
interface Config {
  defaultOrigin?: string;
  accounts: Record<string, Account>;
}
export type Backend = "keychain" | "secret-service" | "file";
const SERVICE = "nearportal-mcp";
const TOKEN = /^npa_[A-Za-z0-9_-]{43}$/;

export function configDir() {
  const base = process.env.NEARPORTAL_MCP_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "nearportal-mcp");
  return resolve(base);
}
/** Refuse a config directory inside a Git work tree: credentials must never be committed. */
function insideGitRepo(dir: string) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git")) && d !== homedir()) return d;
    if (dirname(d) === d) return null;
  }
}
function ensureDir() {
  // Resolve existing ancestors as well as the final directory: an XDG/config symlink must not
  // hide a Git checkout from the credential guard, even before the config directory exists.
  const configured = configDir();
  let ancestor = configured;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const dir = join(realpathSync(ancestor), ...missing);
  const repo = insideGitRepo(dir);
  if (repo && process.env.NEARPORTAL_MCP_ALLOW_REPO_CONFIG !== "1")
    throw new Error(`Refusing to store NearPortal credentials inside the Git work tree ${repo}. Set NEARPORTAL_MCP_HOME to a private directory outside any repository.`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
function readPrivate(path: string) {
  if (!existsSync(path)) return null;
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 "${path}"`);
  return readFileSync(path, "utf8");
}
function writePrivate(path: string, content: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
function loadConfig(): Config {
  const dir = ensureDir();
  const raw = readPrivate(join(dir, "config.json"));
  if (!raw) return { accounts: {} };
  const parsed = JSON.parse(raw) as Config;
  return { defaultOrigin: parsed.defaultOrigin, accounts: parsed.accounts ?? {} };
}
function saveConfig(c: Config) {
  writePrivate(join(ensureDir(), "config.json"), JSON.stringify(c, null, 2));
}
const has = (cmd: string) => spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { stdio: ["ignore", "pipe", "ignore"] }).status === 0;
export function chooseBackend(): Backend {
  const forced = process.env.NEARPORTAL_CREDENTIAL_STORE;
  if (forced === "file" || forced === "keychain" || forced === "secret-service") return forced;
  if (process.platform === "darwin" && existsSync("/usr/bin/security")) return "keychain";
  if (process.platform === "linux" && has("secret-tool")) return "secret-service";
  return "file";
}
function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { input, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8", timeout: 15_000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}
function setSecret(backend: Backend, origin: string, token: string) {
  if (!TOKEN.test(token)) throw new Error("Unexpected credential format");
  if (backend === "keychain") {
    // `security -i` reads the command from stdin, so the token never appears in a process argument list.
    const r = run("/usr/bin/security", ["-i"], `add-generic-password -U -s ${SERVICE} -a "${origin}" -w "${token}"\n`);
    if (!r.ok) throw new Error("Could not write to the macOS Keychain. Set NEARPORTAL_CREDENTIAL_STORE=file to use a private file instead.");
    return;
  }
  if (backend === "secret-service") {
    const r = run("secret-tool", ["store", "--label=NearPortal MCP", "service", SERVICE, "origin", origin], token);
    if (!r.ok) throw new Error("Could not write to the Secret Service. Set NEARPORTAL_CREDENTIAL_STORE=file to use a private file instead.");
    return;
  }
  const path = join(ensureDir(), "credentials.json");
  const current = JSON.parse(readPrivate(path) ?? "{}") as Record<string, string>;
  current[origin] = token;
  writePrivate(path, JSON.stringify(current));
}
function getSecret(backend: Backend, origin: string): string | null {
  let value: string | null = null;
  if (backend === "keychain") {
    const r = run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", origin, "-w"]);
    value = r.ok ? r.out : null;
  } else if (backend === "secret-service") {
    const r = run("secret-tool", ["lookup", "service", SERVICE, "origin", origin]);
    value = r.ok ? r.out : null;
  } else {
    const current = JSON.parse(readPrivate(join(ensureDir(), "credentials.json")) ?? "{}") as Record<string, string>;
    value = current[origin] ?? null;
  }
  return value && TOKEN.test(value) ? value : null;
}
function deleteSecret(backend: Backend, origin: string) {
  if (backend === "keychain") run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", origin]);
  else if (backend === "secret-service") run("secret-tool", ["clear", "service", SERVICE, "origin", origin]);
  else {
    const path = join(ensureDir(), "credentials.json");
    const current = JSON.parse(readPrivate(path) ?? "{}") as Record<string, string>;
    delete current[origin];
    if (Object.keys(current).length) writePrivate(path, JSON.stringify(current));
    else rmSync(path, { force: true });
  }
}

export const credentials = {
  defaultOrigin: () => loadConfig().defaultOrigin ?? null,
  account: (origin: string) => loadConfig().accounts[origin] ?? null,
  token(origin: string) {
    const a = loadConfig().accounts[origin];
    return a ? getSecret(a.backend, origin) : null;
  },
  save(origin: string, token: string, account: Omit<Account, "backend">) {
    const backend = chooseBackend();
    setSecret(backend, origin, token);
    const c = loadConfig();
    c.accounts[origin] = { ...account, backend };
    c.defaultOrigin = origin;
    saveConfig(c);
    return backend;
  },
  remove(origin: string) {
    const c = loadConfig();
    const a = c.accounts[origin];
    if (a) deleteSecret(a.backend, origin);
    delete c.accounts[origin];
    if (c.defaultOrigin === origin) delete c.defaultOrigin;
    saveConfig(c);
    return Boolean(a);
  },
  allowsHttpLoopback: (origin: string) => Boolean(loadConfig().accounts[origin]?.allowHttpLoopback),
};
