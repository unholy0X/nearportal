import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { OAuthTokens, oauthExpiry } from "../server/portal/oauth-tokens.ts";
import { PortalStore, identity, type User } from "../server/portal/store.ts";
import { GitHub } from "../server/tasks/github.ts";

function world(t: test.TestContext) {
  const saved = { ...process.env };
  process.env.GITHUB_OAUTH_CLIENT_ID = "test-app";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "fixture-secret";
  const dir = mkdtempSync(join(tmpdir(), "np-oauth-"));
  const db = new DatabaseSync(":memory:");
  const store = new PortalStore(db, dir, randomBytes(32));
  const now = 1_000_000;
  const user: User = { id: 7, name: "Test", login: "test", avatar: "", token: "old-token", createdAt: "", oauth: { clientId: "test-app", expiresAt: now, refreshToken: "old-refresh", refreshExpiresAt: now + 500_000 } };
  store.saveUser(user);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); process.env = saved; });
  return { store, now, user };
}
const rotated = { access_token: "new-token", refresh_token: "new-refresh", expires_in: 28_800, refresh_token_expires_in: 15_897_600 };

test("OAuth renewal: concurrent reads rotate once, preserve profile updates and encrypt both tokens", async (t) => {
  const { store, now, user } = world(t);
  let calls = 0;
  const request = (async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, "https://github.com/login/oauth/access_token");
    const body = JSON.parse(String(init.body));
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.refresh_token, "old-refresh");
    assert.equal(body.scope, undefined);
    assert.equal(store.user(user.id)!.oauth!.refreshUncertain, true);
    await Promise.resolve();
    store.saveUser({ ...store.user(user.id)!, payout: { country: "FR" } });
    return Response.json(rotated);
  }) as typeof fetch;
  const manager = new OAuthTokens(store, request, () => now);
  assert.deepEqual(await Promise.all(Array.from({ length: 10 }, () => manager.token(user.id))), Array(10).fill("new-token"));
  assert.equal(calls, 1);
  assert.equal(await manager.token(user.id), "new-token");
  const saved = store.user(user.id)!;
  assert.equal(saved.payout!.country, "FR");
  assert.equal(saved.oauth!.refreshToken, "new-refresh");
  assert.equal(saved.oauth!.refreshUncertain, undefined);
  const raw = JSON.stringify(store.db.prepare("SELECT * FROM portal_users").all());
  assert.ok(!raw.includes("new-token") && !raw.includes("new-refresh"));
  assert.ok(!JSON.stringify(identity(saved)).includes("token"));
  assert.equal((identity(saved) as any).oauth, undefined);
});

test("OAuth renewal: an uncertain response is never retried, including after restart", async (t) => {
  const { store, now, user } = world(t);
  let calls = 0;
  const request = (async () => { calls++; throw new Error("network timeout"); }) as typeof fetch;
  const manager = new OAuthTokens(store, request, () => now);
  await assert.rejects(manager.token(user.id), /Reconnect GitHub/);
  await assert.rejects(manager.token(user.id), /Reconnect GitHub/);
  await assert.rejects(new OAuthTokens(store, request, () => now).token(user.id), /Reconnect GitHub/);
  assert.equal(calls, 1);
});

test("OAuth renewal: a concurrent sign-in wins over an old refresh response", async (t) => {
  const { store, now, user } = world(t);
  const request = (async () => {
    store.saveUser({ ...user, token: "reconnected", oauth: oauthExpiry({ ...rotated, refresh_token: "reconnected-refresh" }, now) });
    return Response.json(rotated);
  }) as typeof fetch;
  assert.equal(await new OAuthTokens(store, request, () => now).token(user.id), "reconnected");
  assert.equal(store.user(user.id)!.oauth!.refreshToken, "reconnected-refresh");
});

test("OAuth renewal: expired refresh tokens/app mismatch fail closed; legacy tokens remain supported", async (t) => {
  const { store, now, user } = world(t);
  const manager = new OAuthTokens(store, (async () => { assert.fail("No network request expected"); }) as typeof fetch, () => now);
  store.saveUser({ ...user, oauth: { ...user.oauth!, refreshExpiresAt: now - 1 } });
  await assert.rejects(manager.token(user.id), /Reconnect GitHub/);
  store.saveUser({ ...user, oauth: { ...user.oauth!, clientId: "another-app", expiresAt: now + 90_000 } });
  await assert.rejects(manager.token(user.id), /Reconnect GitHub/);
  store.saveUser({ ...user, oauth: undefined });
  assert.equal(await manager.token(user.id), "old-token");
  assert.equal(oauthExpiry({ access_token: "legacy" }, now), undefined);
  assert.throws(() => oauthExpiry({ access_token: "bad", expires_in: 50 }, now), /incomplete/);
});

test("GitHub dynamic credentials refresh before cache lookup and writes", async () => {
  let value = "before";
  const authorizations: string[] = [];
  const request = (async (_url: string, init: RequestInit) => {
    const token = new Headers(init.headers).get("Authorization")!;
    authorizations.push(token);
    return Response.json({ token }, { headers: { ETag: token } });
  }) as typeof fetch;
  const gh = new GitHub({ token: value, getToken: async () => value }, request);
  const path = "/repos/acme/widgets/commits/" + "a".repeat(40);
  assert.deepEqual(await gh.get(path), { token: "Bearer before" });
  value = "after";
  assert.deepEqual(await gh.get(path), { token: "Bearer after" });
  value = "write";
  assert.deepEqual(await gh.write("/repos/acme/widgets/issues", "POST", {}), { token: "Bearer write" });
  assert.deepEqual(authorizations, ["Bearer before", "Bearer after", "Bearer write"]);
});
