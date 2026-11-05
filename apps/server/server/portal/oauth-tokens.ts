import type { PortalStore, User } from "./store.ts";

export interface OAuthResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

/** Stored inside the existing encrypted user record, never returned by identity/me. */
export function oauthExpiry(result: OAuthResponse, now = Date.now()): User["oauth"] {
  if (result.expires_in === undefined) return undefined; // Older, non-expiring OAuth apps.
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  if (!valid(result.expires_in) || !result.refresh_token || !valid(result.refresh_token_expires_in))
    throw new Error("GitHub returned incomplete expiring credentials. Sign in again.");
  return { clientId: process.env.GITHUB_OAUTH_CLIENT_ID ?? "", expiresAt: now + result.expires_in * 1000, refreshToken: result.refresh_token, refreshExpiresAt: now + result.refresh_token_expires_in * 1000 };
}

/** One refresh per account in this single-instance app. A durable intent is written first:
 * a timeout/crash may have consumed the refresh token, so recovery requires sign-in, not replay.
 */
export class OAuthTokens {
  private readonly inflight = new Map<number, Promise<string>>();
  constructor(private readonly store: PortalStore, private readonly request: typeof fetch = fetch, private readonly now = () => Date.now()) {}

  token(userId: number): Promise<string> {
    const running = this.inflight.get(userId);
    if (running) return running;
    const pending = this.resolve(userId);
    this.inflight.set(userId, pending);
    void pending.then(() => this.inflight.delete(userId), () => this.inflight.delete(userId));
    return pending;
  }

  private async resolve(userId: number): Promise<string> {
    const user = this.store.user(userId);
    const reconnect = () => new Error("GitHub sign-in expired or renewal was interrupted. Reconnect GitHub on this site.");
    if (!user || user.local || !user.token) throw reconnect();
    const oauth = user.oauth;
    if (!oauth) return user.token;
    if (oauth.clientId !== process.env.GITHUB_OAUTH_CLIENT_ID || oauth.refreshUncertain) throw reconnect();
    if (oauth.expiresAt > this.now() + 60_000) return user.token;
    if (oauth.refreshExpiresAt <= this.now() || !process.env.GITHUB_OAUTH_CLIENT_SECRET) throw reconnect();
    this.store.saveUser({ ...user, oauth: { ...oauth, refreshUncertain: true } });
    let result: OAuthResponse;
    try {
      const response = await this.request("https://github.com/login/oauth/access_token", {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: oauth.clientId, client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: oauth.refreshToken }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw reconnect();
      result = await response.json() as OAuthResponse;
      if (!result.access_token || !result.refresh_token || result.expires_in === undefined) throw reconnect();
    } catch { throw reconnect(); }
    const renewed = oauthExpiry(result, this.now());
    // A concurrent OAuth sign-in or profile update must not be overwritten by this response.
    const current = this.store.user(userId);
    if (!current || current.local) throw reconnect();
    if (current.token !== user.token || current.oauth?.refreshToken !== oauth.refreshToken) return current.token;
    this.store.saveUser({ ...current, token: result.access_token!, oauth: renewed });
    return result.access_token!;
  }
}
