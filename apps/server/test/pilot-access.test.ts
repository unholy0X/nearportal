import test from "node:test";
import assert from "node:assert/strict";
import { agentWorld } from "./agent-world.ts";
import { Auth } from "../server/portal/auth.ts";
import { portalUserAllowed } from "../server/ops/pilot-access.ts";

test("pilot restriction applies to existing browser sessions, existing MCP tokens and new logins", async () => {
  const previous = process.env.PORTAL_ALLOWED_GITHUB_IDS;
  delete process.env.PORTAL_ALLOWED_GITHUB_IDS;
  const w = await agentWorld();
  try {
    const owner = await w.login("owner"), developer = await w.login("ada");
    const auth = new Auth(w.portalStore);
    const ownerRequest = { headers: { cookie: w.sessions.owner!.cookie } } as any;
    const devRequest = { headers: { cookie: w.sessions.ada!.cookie } } as any;
    const ownerUser = auth.session(ownerRequest)!.user, devUser = auth.session(devRequest)!.user;
    process.env.PORTAL_ALLOWED_GITHUB_IDS = String(ownerUser.id);
    assert.ok(auth.session(ownerRequest));
    assert.equal(auth.session(devRequest), null);
    assert.throws(() => auth.login({} as any, devUser), /restricted/);
    assert.equal((await w.call("GET", "/api/agent/v1/account", { bearer: owner })).status, 200);
    const denied = await w.call("GET", "/api/agent/v1/account", { bearer: developer });
    assert.equal(denied.body.error.code, "capability_disabled");
    process.env.PORTAL_ALLOWED_GITHUB_IDS = `${ownerUser.id},${devUser.id}`;
    assert.ok(auth.session(devRequest));
    assert.equal((await w.call("GET", "/api/agent/v1/account", { bearer: developer })).status, 200);
    process.env.PORTAL_ALLOWED_GITHUB_IDS = "";
    assert.throws(() => portalUserAllowed(ownerUser.id), /numeric GitHub/);
  } finally {
    if (previous === undefined) delete process.env.PORTAL_ALLOWED_GITHUB_IDS; else process.env.PORTAL_ALLOWED_GITHUB_IDS = previous;
    await w.close();
  }
});

test("explicit public testnet access admits other GitHub identities without bypassing authentication or MCP scopes", async () => {
  const previous = process.env.PORTAL_ALLOWED_GITHUB_IDS;
  process.env.PORTAL_ALLOWED_GITHUB_IDS = "*";
  const w = await agentWorld();
  try {
    const reader = await w.login("bo", ["read"]);
    const auth = new Auth(w.portalStore);
    assert.equal(auth.session({ headers: { cookie: w.sessions.bo!.cookie } } as any)!.user.login, "dev-bo");
    const account = await w.call("GET", "/api/agent/v1/account", { bearer: reader });
    assert.equal(account.status, 200);
    assert.equal(account.data.account.login, "dev-bo");
    assert.equal((await w.call("GET", "/api/agent/v1/account")).status, 401);
    const denied = await w.call("POST", "/api/agent/v1/prepare", { bearer: reader, body: { items: [w.item(1)] } });
    assert.equal(denied.error?.code, "insufficient_scope");
    assert.equal(portalUserAllowed(0), false);
    for (const invalid of ["", "*,1001", " * ", "everyone"])
      assert.throws(() => portalUserAllowed(2003, invalid), /numeric GitHub/);
    process.env.PORTAL_ALLOWED_GITHUB_IDS = "1001";
    assert.equal(auth.session({ headers: { cookie: w.sessions.bo!.cookie } } as any), null);
    assert.equal((await w.call("GET", "/api/agent/v1/account", { bearer: reader })).error?.code, "capability_disabled");
  } finally {
    if (previous === undefined) delete process.env.PORTAL_ALLOWED_GITHUB_IDS; else process.env.PORTAL_ALLOWED_GITHUB_IDS = previous;
    await w.close();
  }
});
