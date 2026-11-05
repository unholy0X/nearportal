import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GitHub } from "../tasks/github.ts";
import { digest, identity, type PortalStore, type User } from "./store.ts";
import { oauthExpiry, type OAuthResponse } from "./oauth-tokens.ts";
import { portalUserAllowed, requirePortalUser } from "../ops/pilot-access.ts";

const random = () => randomBytes(32).toString("base64url");
/** Agent approval pages are served by this backend; their exact, parameter-checked forms only. */
const AGENT_RETURN = /^\/agent\/(?:connect\?code=[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}|connect|wallet\?request=[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/;
export const loginReturnPath = (value: string | null) =>
  AGENT_RETURN.test(value ?? "") ? value! : value === "/demo" ? "/demo" : /^\/bounties\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value ?? "") ? value! : "/app";
/** Fixed, operator-configured UI origin; never accept a caller-provided redirect origin. */
export function frontendLoginLocation(origin: string, returnTo: string | null, configuredOrigin?: string) {
  const path = loginReturnPath(returnTo);
  if (!configuredOrigin || path.startsWith("/agent/")) return path;
  const backend = new URL(origin), frontend = new URL(configuredOrigin);
  if (frontend.hostname !== backend.hostname || frontend.protocol !== backend.protocol || frontend.username || frontend.password || frontend.pathname !== "/" || frontend.search || frontend.hash)
    throw new Error("Frontend origin must use the backend hostname and protocol, without a path or credentials");
  return new URL(path, frontend.origin).href;
}
const cookie = (req: IncomingMessage, name: string) =>
  String(req.headers.cookie ?? "")
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(name + "="))
    ?.slice(name.length + 1) ?? "";
export class Auth {
  readonly origin: string;
  readonly local: boolean;
  constructor(
    readonly store: PortalStore,
    private readonly request: typeof fetch = fetch,
  ) {
    this.origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:8787";
    const u = new URL(this.origin);
    this.local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (!this.local && u.protocol !== "https:")
      throw new Error("Public portal requires HTTPS APP_ORIGIN");
    if (
      process.env.NODE_ENV === "production" &&
      !process.env.PORTAL_ENCRYPTION_KEY
    )
      throw new Error("Production requires a persistent PORTAL_ENCRYPTION_KEY");
  }
  get configured() {
    return Boolean(
      process.env.GITHUB_OAUTH_CLIENT_ID &&
        process.env.GITHUB_OAUTH_CLIENT_SECRET,
    );
  }
  get preview() {
    return (
      this.local &&
      process.env.NODE_ENV !== "production" &&
      ["127.0.0.1", "localhost", "::1"].includes(
        process.env.HOST ?? "127.0.0.1",
      ) &&
      process.env.PORTAL_LOCAL_PREVIEW === "1"
    );
  }

  session(req: IncomingMessage) {
    const token = cookie(req, "np_session");
    if (!token) return null;
    const row = this.store.db
      .prepare("SELECT user_id,csrf,expires FROM portal_sessions WHERE hash=?")
      .get(digest(token)) as
      | { user_id: number; csrf: string; expires: number }
      | undefined;
    if (!row || row.expires < Date.now()) return null;
    const user = this.store.user(row.user_id);
    return user && portalUserAllowed(user.id) ? { user, csrf: row.csrf } : null;
  }
  require(req: IncomingMessage, mutation = false) {
    const session = this.session(req);
    if (!session) throw new Error("Sign in with GitHub to continue");
    if (mutation) {
      if (req.headers.origin && req.headers.origin !== this.origin)
        throw new Error("Cross-origin request rejected");
      const supplied = String(req.headers["x-csrf-token"] ?? "");
      if (
        supplied.length !== session.csrf.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrf))
      )
        throw new Error("Request token is invalid. Refresh and try again.");
    }
    return session.user;
  }
  setCookie(res: ServerResponse, name: string, value: string, maxAge: number) {
    res.setHeader(
      "Set-Cookie",
      `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.origin.startsWith("https:") ? "; Secure" : ""}`,
    );
  }
  login(res: ServerResponse, user: User) {
    requirePortalUser(user.id);
    this.store.saveUser(user);
    const token = random();
    this.store.db
      .prepare("INSERT INTO portal_sessions VALUES(?,?,?,?)")
      .run(digest(token), user.id, random(), Date.now() + 7 * 86400_000);
    this.setCookie(res, "np_session", token, 7 * 86400);
  }
  redirect(res: ServerResponse, path: string) {
    res.writeHead(302, {
      Location: path,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end();
  }
  async route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (!url.pathname.startsWith("/auth/")) return false;
    if (req.method !== "GET" && url.pathname !== "/auth/logout")
      throw new Error("Method not allowed");
    if (url.pathname === "/auth/github") {
      if (!this.configured) {
        this.redirect(res, "/login?setup=github");
        return true;
      }
      this.store.db
        .prepare("DELETE FROM portal_oauth WHERE expires<?")
        .run(Date.now());
      const state = random(),
        verifier = random();
      this.store.db
        .prepare("INSERT INTO portal_oauth VALUES(?,?,?)")
        .run(
          digest(state),
          this.store.seal({
            verifier,
            returnTo: loginReturnPath(url.searchParams.get("returnTo")),
          }),
          Date.now() + 600_000,
        );
      this.setCookie(res, "np_oauth", state, 600);
      const params = new URLSearchParams({
        client_id: process.env.GITHUB_OAUTH_CLIENT_ID!,
        redirect_uri: `${this.origin}/auth/github/callback`,
        scope: "read:user repo",
        state,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        prompt: "select_account",
      });
      this.redirect(res, `https://github.com/login/oauth/authorize?${params}`);
      return true;
    }
    if (url.pathname === "/auth/github/callback") {
      const state = url.searchParams.get("state") ?? "";
      if (!this.configured || !state || state !== cookie(req, "np_oauth"))
        throw new Error("GitHub sign-in expired. Please try again.");
      const flow = this.store.db
        .prepare("SELECT verifier,expires FROM portal_oauth WHERE hash=?")
        .get(digest(state)) as
        | { verifier: string; expires: number }
        | undefined;
      this.store.db
        .prepare("DELETE FROM portal_oauth WHERE hash=?")
        .run(digest(state));
      if (!flow || flow.expires < Date.now() || !url.searchParams.get("code"))
        throw new Error("GitHub sign-in expired. Please try again.");
      const stored = this.store.open<
        string | { verifier: string; returnTo: string }
      >(flow.verifier);
      const response = await this.request(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
            client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
            code: url.searchParams.get("code"),
            redirect_uri: `${this.origin}/auth/github/callback`,
            code_verifier:
              typeof stored === "string" ? stored : stored.verifier,
          }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      const result = (await response.json()) as OAuthResponse;
      if (!response.ok || !result.access_token)
        throw new Error("GitHub did not authorize sign-in. Please try again.");
      const gh = new GitHub({ token: result.access_token }, this.request);
      const account = await gh.get<any>("/user");
      const old = this.store.user(account.id);
      this.login(res, {
        ...old,
        id: account.id,
        login: account.login,
        name: account.name ?? account.login,
        avatar: account.avatar_url,
        token: result.access_token,
        oauth: oauthExpiry(result),
        local: false,
        createdAt: old?.createdAt ?? new Date().toISOString(),
      });
      this.redirect(
        res,
        frontendLoginLocation(this.origin, typeof stored === "string" ? "/app" : stored.returnTo, process.env.PORTAL_FRONTEND_ORIGIN),
      );
      return true;
    }
    if (url.pathname === "/auth/logout") {
      if (req.method !== "POST") throw new Error("POST required");
      this.require(req, true);
      this.store.db
        .prepare("DELETE FROM portal_sessions WHERE hash=?")
        .run(digest(cookie(req, "np_session")));
      this.setCookie(res, "np_session", "", 0);
      res.writeHead(204);
      res.end();
      return true;
    }
    res.writeHead(404);
    res.end();
    return true;
  }
  async localLogin(req: IncomingMessage, res: ServerResponse) {
    if (
      !this.preview ||
      req.headers.origin !== this.origin ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress ?? "",
      )
    )
      throw new Error("Local preview sign-in is unavailable");
    const account = await new GitHub({ useGhCli: true }).get<any>("/user");
    const old = this.store.user(account.id);
    this.login(res, {
      ...old,
      id: account.id,
      login: account.login,
      name: account.name ?? account.login,
      avatar: account.avatar_url,
      token: "",
      local: true,
      createdAt: old?.createdAt ?? new Date().toISOString(),
    });
    return identity(this.store.user(account.id)!);
  }
}
