import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { TaskStore } from "../server/tasks/store.ts";
import { TaskService, validateFundingPolicy } from "../server/tasks/service.ts";
import { SimulatedPayments } from "../server/tasks/payments.ts";
import { GitHub, fixtureEvidence } from "../server/tasks/github.ts";
import { PortalStore, type User } from "../server/portal/store.ts";
import { PortalService } from "../server/portal/service.ts";
import { Auth } from "../server/portal/auth.ts";
import { hash } from "../server/tasks/domain.ts";

const owner: User = {
  id: 300,
  login: "client",
  name: "Client",
  avatar: "https://avatars.githubusercontent.com/u/300",
  token: "owner-secret-token",
  createdAt: "2026-11-03T00:00:00Z",
};
const developer: User = {
  id: 200,
  login: "developer",
  name: "Developer",
  avatar: "https://avatars.githubusercontent.com/u/200",
  token: "developer-secret-token",
  createdAt: "2026-11-03T00:00:00Z",
};
const bank = {
  firstName: "Demo",
  lastName: "Developer",
  iban: "FR1420041010050500013M02606",
  country: "FR",
};
const draft = {
  repository: "client/repository",
  title: "Ship CSV",
  description: "Export filtered data with correct escaping.",
  criteria: "Escape values\nPreserve zero and false",
  amountCents: 100,
  protectedPaths: "test/acceptance.mjs\npackage.json",
};
function setup() {
  const tasks = new TaskStore(":memory:");
  const store = new PortalStore(tasks.db, "", randomBytes(32));
  store.saveUser({ ...owner });
  store.saveUser({ ...developer });
  const service = new TaskService(
    tasks,
    new GitHub({}),
    new SimulatedPayments(tasks),
    {
      mode: "simulation",
      githubMode: "fixture",
      verifier: "verifier",
      recipient: "placeholder",
    },
  );
  let issues: any[] = [];
  let prs: any[] = [];
  let writes = 0;
  let uncertain = false;
  let pullsStatus = 200;
  const github = new GitHub({ token: "test" }, async (url) => {
    const path = String(url);
    let data: unknown;
    if (path.includes("/pulls?") && pullsStatus !== 200)
      return new Response("{}", { status: pullsStatus });
    if (path.includes("/issues?")) data = issues;
    else if (path.includes("/pulls?")) data = prs;
    else if (path.includes("/repos/client/repository"))
      data = {
        id: 100,
        full_name: "client/repository",
        private: false,
        permissions: { push: true },
        allow_squash_merge: true,
        default_branch: "main",
      };
    else throw new Error("Unexpected GitHub test call");
    return new Response(JSON.stringify(data));
  });
  const write = async <T>(
    _u: User,
    _path: string,
    _method: string,
    body: any,
  ): Promise<T> => {
    writes++;
    const issue = {
      number: 42,
      html_url: "https://github.com/client/repository/issues/42",
      body: body.body,
    };
    issues.push(issue);
    if (uncertain)
      throw new Error("Network interrupted after GitHub accepted issue");
    return issue as T;
  };
  const portal = new PortalService(store, service, () => github, write);
  return {
    tasks,
    store,
    service,
    portal,
    setPrs: (p: any[]) => {
      prs = p;
    },
    setUncertain: () => {
      uncertain = true;
    },
    setPullsStatus: (status: number) => {
      pullsStatus = status;
    },
    writes: () => writes,
  };
}

test("user credentials are authenticated-encrypted at rest and fail closed on tampering", () => {
  const { store, tasks } = setup();
  const raw = (
    tasks.db
      .prepare("SELECT body FROM portal_users WHERE id=?")
      .get(owner.id) as { body: string }
  ).body;
  assert.equal(raw.includes(owner.token), false);
  assert.equal(store.user(owner.id)!.token, owner.token);
  const data = Buffer.from(raw, "base64");
  data[35] ^= 1;
  assert.throws(() => store.open(data.toString("base64")));
  tasks.close();
});

test("open bounty funds before a developer exists, locks the economics, then pays after qualifying merge", async () => {
  const { portal, service, store, tasks, setPrs, writes } = setup();
  const created = await portal.create(owner, draft);
  let b = store.bounty(created.id);
  assert.equal(b.status, "Draft");
  portal.publish(owner, b);
  await portal.tick();
  b = store.bounty(b.id);
  let t = tasks.get(b.taskId!);
  assert.equal(t.openBounty, true);
  assert.equal(t.policy.description, draft.description);
  assert.equal(t.policy.submissionCode, b.code);
  assert.equal(t.policy.developerId, 0);
  assert.equal(t.clientAccepted, true);
  assert.equal(t.developerAccepted, false);
  const initialHash = t.policyHash;
  assert.equal(t.fundingPolicyHash, initialHash);
  assert.equal(hash(t.fundingPolicy), initialHash);
  service.fund(t);
  await service.tick();
  await portal.tick();
  await portal.tick();
  b = store.bounty(b.id);
  assert.equal(b.published, true);
  assert.equal(b.issueNumber, 42);
  assert.equal(writes(), 1);
  const user = store.user(developer.id)!;
  portal.savePayout(user, bank);
  await portal.claim(store.user(developer.id)!, b, {
    policyHash: initialHash,
    payoutVersion: store.user(developer.id)!.payout!.version,
  });
  t = tasks.get(t.id);
  assert.equal(t.policy.developerId, developer.id);
  assert.notEqual(t.policyHash, initialHash);
  assert.equal(t.fundingPolicyHash, initialHash);
  validateFundingPolicy(t);
  assert.throws(
    () => service.claim(t, { id: 999, login: "other" }, bank, t.policyHash),
    /not available/,
  );
  assert.equal(
    JSON.stringify(portal.public(b, developer)).includes(bank.iban),
    false,
  );
  setPrs([
    {
      number: 9,
      user: { id: developer.id },
      base: { ref: "main" },
      body: `Closes #42\n\nNearPortal-Task: ${b.code}`,
      created_at: new Date().toISOString(),
    },
  ]);
  await portal.tick();
  t = tasks.get(t.id);
  assert.equal(t.prNumber, 9);
  service.simulate(t, "ready", "developer");
  await service.tick();
  assert.equal(tasks.get(t.id).verdict?.status, "pending");
  service.simulate(tasks.get(t.id), "merged", "client");
  await service.tick();
  assert.equal(tasks.get(t.id).payment.state, "Processed");
  assert.equal(portal.public(store.bounty(b.id), owner).status, "Paid");
  assert.equal(
    (
      tasks.db.prepare("SELECT COUNT(*) AS n FROM releases").get() as {
        n: number;
      }
    ).n,
    1,
  );
  tasks.close();
});

test("a client cannot claim their own funded bounty or change funded criteria", async () => {
  const { portal, service, store, tasks } = setup();
  const c = await portal.create(owner, draft);
  let b = store.bounty(c.id);
  portal.publish(owner, b);
  await portal.tick();
  b = store.bounty(b.id);
  const t = tasks.get(b.taskId!);
  service.fund(t);
  assert.throws(
    () => service.claim(tasks.get(t.id), owner, bank, t.policyHash),
    /cannot claim/,
  );
  const corrupt = tasks.get(t.id);
  corrupt.policy.amountCents++;
  corrupt.policyHash = hash(corrupt.policy);
  assert.throws(() => validateFundingPolicy(corrupt), /economics changed/);
  tasks.close();
});

test("uncertain issue creation reconciles its exact identifier without posting twice", async () => {
  const { portal, service, store, tasks, setUncertain, writes } = setup();
  const c = await portal.create(owner, draft);
  let b = store.bounty(c.id);
  portal.publish(owner, b);
  await portal.tick();
  b = store.bounty(b.id);
  service.fund(tasks.get(b.taskId!));
  await portal.tick();
  setUncertain();
  await portal.tick();
  assert.equal(writes(), 1);
  assert.equal(store.bounty(b.id).issueNumber, null);
  tasks.db.prepare("UPDATE portal_jobs SET next_at=0").run();
  await portal.tick();
  assert.equal(store.bounty(b.id).issueNumber, 42);
  assert.equal(writes(), 1);
  tasks.close();
});

test("worker restart recovers a prepared task without creating another escrow task", async () => {
  const { portal, store, tasks } = setup();
  const c = await portal.create(owner, draft);
  let b = store.bounty(c.id);
  portal.publish(owner, b);
  await portal.tick();
  b = store.bounty(b.id);
  const taskId = b.taskId;
  b.taskId = null;
  store.save(b);
  store.enqueue(b, "prepare");
  await portal.tick();
  assert.equal(store.bounty(b.id).taskId, taskId);
  assert.equal(tasks.all().length, 1);
  tasks.close();
});

test("drafts stay private and published briefs are public even for private repositories", async () => {
  const { portal, store, tasks } = setup();
  const c = await portal.create(owner, draft);
  const b = store.bounty(c.id);
  b.private = true;
  store.save(b);
  assert.throws(() => portal.public(b, developer), /not found/);
  assert.throws(() => portal.public(b), /not found/);
  assert.equal(portal.public(b, owner).role, "client");
  assert.throws(() => portal.publish(developer, b), /Only the client/);
  b.published = true;
  store.save(b);
  assert.equal(portal.public(b).title, draft.title);
  assert.equal(portal.public(b, developer).role, "visitor");
  assert.equal(portal.public(b, developer).repositoryAccess, false);
  assert.equal(portal.public(b, developer).canClaim, false);
  tasks.close();
});

test("sessions are opaque, expire, and require CSRF for mutations", () => {
  const { store, tasks } = setup();
  const auth = new Auth(store);
  let header = "";
  auth.login(
    {
      setHeader: (name: string, value: string) => {
        if (name === "Set-Cookie") header = value;
      },
    } as any,
    owner,
  );
  assert.match(header, /HttpOnly; SameSite=Lax/);
  const req = {
    headers: { cookie: header.split(";")[0], origin: auth.origin },
  } as any;
  const session = auth.session(req)!;
  assert.equal(session.user.id, owner.id);
  assert.throws(() => auth.require(req, true), /Request token/);
  req.headers["x-csrf-token"] = session.csrf;
  assert.equal(auth.require(req, true).id, owner.id);
  req.headers.origin = "https://attacker.invalid";
  assert.throws(() => auth.require(req, true), /Cross-origin/);
  tasks.db.prepare("UPDATE portal_sessions SET expires=0").run();
  assert.equal(auth.session(req), null);
  tasks.close();
});

test("judge worker sends a conditional squash merge as the client only for an eligible prepared sandbox PR", async () => {
  const { portal, service, store, tasks } = setup();
  const created = await portal.create(owner, draft);
  let b = store.bounty(created.id);
  portal.publish(owner, b);
  await portal.tick();
  b = store.bounty(b.id);
  service.fund(tasks.get(b.taskId!));
  portal.savePayout(store.user(developer.id)!, bank);
  await portal.claim(store.user(developer.id)!, b, {
    policyHash: tasks.get(b.taskId!).policyHash,
    payoutVersion: store.user(developer.id)!.payout!.version,
  });
  const t = tasks.get(b.taskId!);
  Object.assign(t, {
    mode: "sandbox",
    githubMode: "live",
    prNumber: 9,
    fixture: "ready",
  });
  tasks.save(t);
  const branch = "codex/nearportal-task/judge-1",
    sha = "a".repeat(40);
  const github = new GitHub(
    { token: "test" },
    async () =>
      new Response(
        JSON.stringify({
          number: 9,
          state: "open",
          draft: false,
          merged: false,
          created_at: new Date().toISOString(),
          body: `NearPortal-Task: ${b.code}`,
          user: { id: developer.id },
          head: { sha, ref: branch, repo: { id: 100 } },
          base: { ref: "main", repo: { id: 100, private: false } },
        }),
      ),
  );
  github.evidence = async () => fixtureEvidence(tasks.get(t.id));
  const merges: {
    owner: number;
    path: string;
    method: string;
    body: unknown;
  }[] = [];
  const worker = new PortalService(
    store,
    service,
    () => github,
    async <T>(u, path, method, body) => {
      merges.push({ owner: u.id, path, method, body });
      return { merged: true } as T;
    },
  );
  Object.assign(worker.judge, {
    enabled: true,
    autoMerge: true,
    repository: draft.repository,
    tasks: { [b.id]: { branch, headSha: sha } },
  });
  // Re-read before writing: the store refuses saves from stale copies.
  store.update(b.id, (fresh) => {
    fresh.published = true;
  });
  await worker.tick();
  assert.equal(merges.length, 1);
  assert.equal(merges[0]!.owner, owner.id);
  assert.equal(merges[0]!.path, "/repos/client/repository/pulls/9/merge");
  assert.deepEqual(merges[0]!.body, { sha, merge_method: "squash" });
  await worker.tick();
  assert.equal(merges.length, 1);
  tasks.close();
});

test("PR discovery ignores the wrong author and ambiguous identifiers", async () => {
  const { portal, service, store, tasks, setPrs } = setup();
  const c = await portal.create(owner, draft);
  let b = store.bounty(c.id);
  portal.publish(owner, b);
  await portal.tick();
  b = store.bounty(b.id);
  let t = tasks.get(b.taskId!);
  service.fund(t);
  portal.savePayout(store.user(developer.id)!, bank);
  await portal.claim(store.user(developer.id)!, b, {
    policyHash: t.policyHash,
    payoutVersion: store.user(developer.id)!.payout!.version,
  });
  const pr = {
    number: 9,
    user: { id: 999 },
    base: { ref: "main" },
    body: `NearPortal-Task: ${b.code}`,
    created_at: new Date().toISOString(),
  };
  setPrs([pr]);
  await portal.tick();
  assert.equal(tasks.get(t.id).prNumber, null);
  store.meta(`scan:${b.id}`, "0");
  setPrs([
    { ...pr, user: { id: developer.id } },
    { ...pr, number: 10, user: { id: developer.id } },
  ]);
  await portal.tick();
  assert.equal(tasks.get(t.id).prNumber, null);
  assert.match(store.bounty(b.id).error!, /Multiple PRs/);
  store.meta(`scan:${b.id}`, "0");
  setPrs([
    {
      ...pr,
      user: { id: developer.id },
      body: `Closes #42\r\n\r\nNearPortal-Task: ${b.code}\r\n`,
    },
  ]);
  await portal.tick();
  assert.equal(tasks.get(t.id).prNumber, 9);
  tasks.close();
});

test("OAuth uses PKCE and a one-use state cookie, then creates an encrypted real-identity session", async () => {
  const { store, tasks } = setup();
  const prior = {
    id: process.env.GITHUB_OAUTH_CLIENT_ID,
    secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
  };
  process.env.GITHUB_OAUTH_CLIENT_ID = "test-client";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "test-client-secret";
  let exchanged = false;
  const auth = new Auth(store, async (url, options) => {
    if (String(url).includes("access_token")) {
      const body = JSON.parse(String(options?.body));
      assert.equal(body.client_secret, "test-client-secret");
      assert.ok(body.code_verifier.length >= 43);
      exchanged = true;
      return new Response(JSON.stringify({ access_token: "real-oauth-token" }));
    }
    assert.equal(String(url), "https://api.github.com/user");
    assert.equal(
      new Headers(options?.headers).get("Authorization"),
      "Bearer real-oauth-token",
    );
    return new Response(
      JSON.stringify({
        id: 123,
        login: "oauth-user",
        name: "OAuth User",
        avatar_url: "https://avatars.githubusercontent.com/u/123",
      }),
    );
  });
  let headers: Record<string, string> = {};
  let status = 0;
  const res = {
    setHeader: (key: string, value: string) => {
      headers[key] = value;
    },
    writeHead: (s: number, h: Record<string, string>) => {
      status = s;
      Object.assign(headers, h);
    },
    end: () => {},
  } as any;
  try {
    await auth.route(
      { method: "GET", headers: {} } as any,
      res,
      new URL(auth.origin + "/auth/github?returnTo=%2Fdemo"),
    );
    assert.equal(status, 302);
    const target = new URL(headers.Location!);
    assert.equal(target.hostname, "github.com");
    assert.equal(target.searchParams.get("code_challenge_method"), "S256");
    assert.equal(target.searchParams.get("scope"), "read:user repo");
    const state = target.searchParams.get("state")!;
    const flowCookie = headers["Set-Cookie"]!.split(";")[0]!;
    await assert.rejects(
      () =>
        auth.route(
          { method: "GET", headers: { cookie: flowCookie } } as any,
          res,
          new URL(auth.origin + "/auth/github/callback?state=forged&code=x"),
        ),
      /expired/,
    );
    assert.equal(exchanged, false);
    await auth.route(
      { method: "GET", headers: { cookie: flowCookie } } as any,
      res,
      new URL(auth.origin + `/auth/github/callback?state=${state}&code=valid`),
    );
    assert.equal(exchanged, true);
    assert.equal(headers.Location, "/demo");
    assert.equal(store.user(123)!.login, "oauth-user");
    assert.equal(store.user(123)!.local, false);
    const raw = (
      tasks.db.prepare("SELECT body FROM portal_users WHERE id=123").get() as {
        body: string;
      }
    ).body;
    assert.equal(raw.includes("real-oauth-token"), false);
    await assert.rejects(
      () =>
        auth.route(
          { method: "GET", headers: { cookie: flowCookie } } as any,
          res,
          new URL(
            auth.origin + `/auth/github/callback?state=${state}&code=valid`,
          ),
        ),
      /expired/,
    );
  } finally {
    if (prior.id === undefined) delete process.env.GITHUB_OAUTH_CLIENT_ID;
    else process.env.GITHUB_OAUTH_CLIENT_ID = prior.id;
    if (prior.secret === undefined)
      delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    else process.env.GITHUB_OAUTH_CLIENT_SECRET = prior.secret;
    tasks.close();
  }
});

test("HTTP portal exposes published briefs publicly while protecting drafts, claims and bank details", async () => {
  const { createServer } = await import("node:http");
  const previous = {
    cli: process.env.GITHUB_USE_CLI,
    key: process.env.PORTAL_ENCRYPTION_KEY,
  };
  process.env.GITHUB_USE_CLI = "0";
  process.env.PORTAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const { portalRuntime } = await import("../server/portal/http.ts");
  const { tasks, service } = setup();
  let accessGranted = false;
  let accessFailure = 404;
  let privateRepo = true,
    forkReady = false,
    branchReady = false;
  const invitations: { path: string; body: unknown }[] = [];
  const mock = (u: User) =>
    new GitHub({ token: "test" }, async (url) => {
      if (u.id === 999 && !accessGranted)
        return new Response("{}", { status: accessFailure });
      const path = String(url);
      if (path.includes("/repos/developer/repository")) {
        if (!forkReady || (path.includes("/git/ref/") && !branchReady))
          return new Response("{}", { status: 404 });
        return new Response(
          JSON.stringify(
            path.includes("/git/ref/")
              ? { object: { sha: "a".repeat(40) } }
              : {
                  fork: true,
                  owner: { id: developer.id },
                  parent: { id: 100 },
                },
          ),
        );
      }
      if (path.includes("/user/repos"))
        return new Response(
          JSON.stringify([
            {
              id: 100,
              name: "repository",
              full_name: "client/repository",
              description: "demo",
              private: true,
              default_branch: "main",
              permissions: { push: true },
              html_url: "https://github.com/client/repository",
            },
          ]),
        );
      return new Response(
        JSON.stringify({
          id: 100,
          full_name: "client/repository",
          private: privateRepo,
          allow_squash_merge: true,
          default_branch: "main",
          permissions: { push: true },
        }),
      );
    });
  const runtime = await portalRuntime(service, {
    githubFor: mock,
    write: async <T>(
      _u: User,
      path: string,
      _method: string,
      body: unknown,
    ) => {
      invitations.push({ path, body });
      if (path.endsWith("/forks")) forkReady = true;
      if (path.endsWith("/git/refs")) {
        branchReady = true;
        return { object: { sha: "a".repeat(40) } } as T;
      }
      return {} as T;
    },
  });
  runtime.store.meta("operator", String(owner.id));
  runtime.store.saveUser(owner);
  runtime.store.saveUser(developer);
  runtime.store.saveUser({ ...developer, id: 999, login: "stranger" });
  const credentials = (user: User) => {
    let header = "";
    runtime.auth.login(
      {
        setHeader: (k: string, v: string) => {
          if (k === "Set-Cookie") header = v;
        },
      } as any,
      user,
    );
    const cookie = header.split(";")[0]!;
    const session = runtime.auth.session({ headers: { cookie } } as any)!;
    return { cookie, csrf: session.csrf };
  };
  const client = credentials(owner),
    contributor = credentials(developer),
    stranger = credentials({ ...developer, id: 999, login: "stranger" });
  const server = createServer((req, res) => void runtime.handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/portal`;
  const call = async (
    path: string,
    auth?: { cookie: string; csrf: string },
    payload?: unknown,
    forged = false,
  ) => {
    const r = await fetch(base + path, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        ...(auth
          ? {
              Cookie: auth.cookie,
              "X-CSRF-Token": forged ? "forged" : auth.csrf,
            }
          : {}),
        Origin: runtime.auth.origin,
        "Content-Type": "application/json",
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: r.status, data: (await r.json()) as any };
  };
  try {
    assert.equal((await call("/repositories")).status, 401);
    assert.equal((await call("/health")).data.status, "ok");
    assert.equal((await call("/judge-demo")).data.enabled, false);
    assert.deepEqual((await call("/judge-demo")).data.bounties, []);
    assert.equal((await call("/judge-payout", contributor, {})).status, 403);
    assert.equal(
      (await call("/repositories", client)).data.repositories[0].fullName,
      "client/repository",
    );
    assert.equal((await call("/bounties", client, draft, true)).status, 403);
    const created = await call("/bounties", client, draft);
    assert.equal(created.status, 201);
    const b = created.data.bounty;
    assert.equal((await call(`/bounties/${b.id}`)).status, 404);
    assert.equal((await call(`/bounties/${b.id}`, stranger)).status, 404);
    assert.equal(
      (await call(`/bounties/${b.id}/publish`, contributor, {})).status,
      404,
    );
    assert.equal(
      (
        await call(`/bounties/${b.id}/edit`, client, {
          ...draft,
          title: "Updated draft",
        })
      ).status,
      200,
    );
    assert.equal(
      (await call(`/bounties/${b.id}`, client)).data.bounty.title,
      "Updated draft",
    );
    assert.equal(
      (
        await call(`/bounties/${b.id}/publish`, client, {
          revision: (await call(`/bounties/${b.id}`, client)).data.bounty
            .revision,
        })
      ).status,
      200,
    );
    await runtime.portal.tick();
    const task = tasks.get(runtime.store.bounty(b.id).taskId!);
    assert.equal(task.openBounty, true);
    assert.equal(task.clientAccepted, true);
    assert.equal(
      (await call(`/bounties/${b.id}/simulate-fund`, client, {})).status,
      200,
    );
    const published = runtime.store.bounty(b.id);
    published.published = true;
    runtime.store.save(published);
    assert.equal((await call(`/bounties/${b.id}/accept-work`, undefined, {confirm:"ACCEPT MERGED WORK"})).status,401);
    assert.equal((await call(`/bounties/${b.id}/accept-work`, client, {confirm:"ACCEPT MERGED WORK"},true)).status,403);
    assert.equal((await call(`/bounties/${b.id}/accept-work`, {...client,csrf:""}, {confirm:"ACCEPT MERGED WORK"})).status,403);
    assert.equal((await call(`/bounties/${b.id}/accept-work`, contributor, {confirm:"ACCEPT MERGED WORK"})).status,403);
    tasks.db.prepare("INSERT INTO releases VALUES(?,?,?)").run(task.id,"pinned",new Date().toISOString());
    const duplicate=await call(`/bounties/${b.id}/accept-work`,client,{confirm:"ACCEPT MERGED WORK"});
    assert.equal(duplicate.status,400);assert.match(duplicate.data.error,/CI cannot be waived/);
    tasks.db.prepare("DELETE FROM releases WHERE task_id=?").run(task.id);
    const anonymous = await call(`/bounties/${b.id}`);
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.data.bounty.task.funded, true);
    assert.equal(anonymous.data.bounty.status, "Open");
    assert.equal((await call("/bounties")).data.bounties.length, 1);
    const publicVisitor = await call(`/bounties/${b.id}`, stranger);
    assert.equal(publicVisitor.status, 200);
    assert.equal(publicVisitor.data.bounty.repositoryAccess, false);
    assert.equal(publicVisitor.data.bounty.canClaim, false);
    assert.equal((await call(`/bounties/${b.id}/deposit`)).status, 401);
    assert.equal(
      (await call(`/bounties/${b.id}/deposit`, stranger)).status,
      403,
    );
    assert.equal((await call("/payout", stranger, bank)).status, 200);
    assert.notEqual(
      (
        await call(`/bounties/${b.id}/claim`, stranger, {
          policyHash: task.policyHash,
          payoutVersion: runtime.store.user(999)!.payout!.version,
        })
      ).status,
      200,
    );
    assert.equal(tasks.get(task.id).policy.developerId, 0);
    assert.equal(
      (await call(`/bounties/${b.id}/request-access`, undefined, {})).status,
      401,
    );
    assert.equal(
      (await call(`/bounties/${b.id}/request-access`, stranger, {}, true))
        .status,
      403,
    );
    assert.equal(
      (
        await call(`/bounties/${b.id}/request-access`, stranger, {
          login: "forged-user",
        })
      ).status,
      200,
    );
    await call(`/bounties/${b.id}/request-access`, stranger, {});
    assert.equal(runtime.store.accessRequests(b.id).length, 1);
    assert.equal(runtime.store.accessRequests(b.id)[0]!.login, "stranger");
    assert.equal(
      (await call(`/bounties/${b.id}`, client)).data.bounty.accessRequests
        .length,
      1,
    );
    assert.deepEqual(
      (await call(`/bounties/${b.id}`)).data.bounty.accessRequests,
      [],
    );
    assert.equal(
      (await call(`/bounties/${b.id}`)).data.bounty.accessRequest,
      null,
    );
    assert.equal(
      (
        await call(`/bounties/${b.id}/invite`, stranger, {
          userId: 999,
          permission: "push",
        })
      ).status,
      403,
    );
    assert.equal(
      (await call(`/bounties/${b.id}/invite`, client, { userId: 999 })).status,
      400,
    );
    assert.equal(
      (
        await call(`/bounties/${b.id}/invite`, client, {
          userId: 999,
          permission: "push",
        })
      ).status,
      200,
    );
    await call(`/bounties/${b.id}/invite`, client, {
      userId: 999,
      permission: "push",
    });
    assert.equal(invitations.length, 1);
    assert.equal(
      invitations[0]!.path,
      "/repos/client/repository/collaborators/stranger",
    );
    assert.deepEqual(invitations[0]!.body, { permission: "push" });
    assert.equal(
      (await call(`/bounties/${b.id}`, stranger)).data.bounty.accessRequest
        .status,
      "invited",
    );
    assert.equal(
      (await call(`/bounties/${b.id}`, stranger)).data.bounty.canClaim,
      false,
    );
    assert.equal((await call(`/bounties/${b.id}`, stranger)).data.bounty.repositoryAccessIssue, "access-required");
    accessFailure = 401;
    await call(`/bounties/${b.id}/check-access`, stranger, {});
    const expiredAccess = (await call(`/bounties/${b.id}`, stranger)).data.bounty;
    assert.equal(expiredAccess.repositoryAccessIssue, "reconnect");
    assert.equal(expiredAccess.canClaim, false);
    accessFailure = 404;
    accessGranted = true;
    const refreshed = runtime.store.user(999)!;
    refreshed.token = 'refreshed-github-token'; runtime.store.saveUser(refreshed);
    // A successful OAuth refresh must invalidate the previous credential's denied membership cache.
    assert.equal((await call(`/bounties/${b.id}`, stranger)).data.bounty.canClaim, true);
    assert.equal(
      (await call(`/bounties/${b.id}/check-access`, stranger, {})).data.bounty
        .canClaim,
      true,
    );
    assert.equal(runtime.store.accessRequests(b.id)[0]!.status, "accepted");
    assert.equal(
      (await call(`/bounties/${b.id}`, stranger)).data.bounty.repositoryAccess,
      true,
    );
    assert.equal((await call("/payout", contributor, bank)).status, 200);
    const visible = await call(`/bounties/${b.id}`, contributor);
    assert.equal(visible.status, 200);
    assert.equal(visible.data.bounty.private, true);
    assert.equal(
      (
        await call(`/bounties/${b.id}/claim`, contributor, {
          policyHash: task.policyHash,
          payoutVersion: runtime.store.user(developer.id)!.payout!.version,
        })
      ).status,
      200,
    );
    const response = await call(`/bounties/${b.id}`, contributor);
    assert.equal(response.data.bounty.role, "developer");
    assert.equal(JSON.stringify(response.data).includes(bank.iban), false);
    assert.equal(JSON.stringify(response.data).includes(owner.token), false);
    const publicClaimed = (await call(`/bounties/${b.id}`)).data.bounty;
    assert.equal(
      publicClaimed.task.policy.recipient,
      "Private payout destination",
    );
    assert.equal(JSON.stringify(publicClaimed).includes(bank.firstName), false);
    // The prepared judge flow forks under the actual claimant, without repository invitations.
    privateRepo = false;
    const judgeBounty = runtime.store.bounty(b.id);
    judgeBounty.private = false;
    runtime.store.save(judgeBounty);
    Object.assign(service.config, { mode: "sandbox" });
    Object.assign(runtime.portal.judge, {
      enabled: true,
      repository: "client/repository",
      tasks: {
        [b.id]: {
          branch: "codex/nearportal-task/judge-1",
          headSha: "a".repeat(40),
        },
      },
    });
    assert.equal(
      (await call(`/bounties/${b.id}/prepare-judge-pr`, stranger, {})).status,
      403,
    );
    assert.equal(
      (await call(`/bounties/${b.id}/prepare-judge-pr`, contributor, {}))
        .status,
      202,
    );
    const prepared = await call(
      `/bounties/${b.id}/prepare-judge-pr`,
      contributor,
      {},
    );
    assert.equal(prepared.status, 200);
    assert.match(
      decodeURIComponent(prepared.data.url),
      /developer:codex\/nearportal-task\/judge-1/,
    );
    assert.equal(
      new URL(prepared.data.url).searchParams
        .get("body")!
        .includes(`NearPortal-Task: ${b.code}`),
      true,
    );
    await call(`/bounties/${b.id}/prepare-judge-pr`, contributor, {});
    assert.equal(
      invitations.filter((i) => i.path.endsWith("/forks")).length,
      1,
    );
    assert.equal(
      invitations.filter((i) => i.path.endsWith("/git/refs")).length,
      1,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    tasks.close();
    if (previous.cli === undefined) delete process.env.GITHUB_USE_CLI;
    else process.env.GITHUB_USE_CLI = previous.cli;
    if (previous.key === undefined) delete process.env.PORTAL_ENCRYPTION_KEY;
    else process.env.PORTAL_ENCRYPTION_KEY = previous.key;
  }
});

test("localhost preview cannot be enabled on a public listener or in production", async () => {
  const { store, tasks } = setup();
  const saved = {
    preview: process.env.PORTAL_LOCAL_PREVIEW,
    host: process.env.HOST,
    node: process.env.NODE_ENV,
    key: process.env.PORTAL_ENCRYPTION_KEY,
  };
  try {
    process.env.PORTAL_LOCAL_PREVIEW = "1";
    process.env.HOST = "0.0.0.0";
    delete process.env.NODE_ENV;
    let auth = new Auth(store);
    assert.equal(auth.preview, false);
    process.env.HOST = "127.0.0.1";
    process.env.NODE_ENV = "production";
    process.env.PORTAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    auth = new Auth(store);
    assert.equal(auth.preview, false);
    delete process.env.NODE_ENV;
    auth = new Auth(store);
    assert.equal(auth.preview, true);
    await assert.rejects(
      () =>
        auth.localLogin(
          {
            headers: { origin: auth.origin },
            socket: { remoteAddress: "203.0.113.12" },
          } as any,
          {} as any,
        ),
      /unavailable/,
    );
  } finally {
    for (const [key, value] of Object.entries({
      PORTAL_LOCAL_PREVIEW: saved.preview,
      HOST: saved.host,
      NODE_ENV: saved.node,
      PORTAL_ENCRYPTION_KEY: saved.key,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    tasks.close();
  }
});

test("publishing requires the reviewed draft revision and cannot race an edit", async () => {
  const { portal, store, service, tasks } = setup();
  const created = await portal.create(owner, draft);
  const stale = store.bounty(created.id);
  await portal.create(
    owner,
    { ...draft, title: "Revised reward brief" },
    store.bounty(created.id),
  );
  assert.throws(
    () => portal.publish(owner, stale, created.revision),
    /draft changed/,
  );
  let resolveRead!: (r: Response) => void;
  let startedRead!: () => void;
  const started = new Promise<void>((r) => {
    startedRead = r;
  });
  const delayed = new GitHub(
    { token: "test" },
    () =>
      new Promise<Response>((r) => {
        resolveRead = r;
        startedRead();
      }),
  );
  const editor = new PortalService(store, service, () => delayed);
  const editing = editor.create(
    owner,
    { ...draft, title: "Too late to change" },
    store.bounty(created.id),
  );
  await started;
  portal.publish(owner, store.bounty(created.id));
  resolveRead(
    new Response(
      JSON.stringify({
        id: 100,
        full_name: "client/repository",
        private: false,
        permissions: { push: true },
        allow_squash_merge: true,
        default_branch: "main",
      }),
    ),
  );
  await assert.rejects(() => editing, /published while you were editing/);
  assert.equal(store.bounty(created.id).title, "Revised reward brief");
  tasks.close();
});

test("a changed payout profile needs renewed contributor consent before claiming", async () => {
  const { portal, service, store, tasks } = setup();
  const created = await portal.create(owner, draft);
  let b = store.bounty(created.id);
  portal.publish(owner, b);
  await portal.tick();
  b = store.bounty(b.id);
  const t = tasks.get(b.taskId!);
  service.fund(t);
  const old = portal.savePayout(store.user(developer.id)!, bank);
  portal.savePayout(store.user(developer.id)!, {
    ...bank,
    lastName: "Updated",
  });
  await assert.rejects(
    () =>
      portal.claim(store.user(developer.id)!, b, {
        policyHash: t.policyHash,
        payoutVersion: old.version,
      }),
    /payout details changed/,
  );
  assert.equal(tasks.get(t.id).policy.developerId, 0);
  assert.equal(tasks.get(t.id).funded, true);
  tasks.close();
});

test("new mode drafts persist validated terms but cannot silently fund through legacy mandates", async () => {
  const {portal,store,tasks}=setup();
  // Closed gate (the shipped sandbox default): drafts are saved, funding never starts.
  const { setFixedDeadlineRails } = await import("../server/portal/market-rollout.ts");
  setFixedDeadlineRails({ bank: false, "base-usdc": false }, "test: closed");
  for (const kind of ["fixed","auction"]) {
    const created=await portal.create(owner,{...draft,marketTerms:{kind,deliveryHours:120,biddingHours:24}});
    const bounty=store.bounty(created.id);
    assert.equal(bounty.marketTerms?.budgetCents,draft.amountCents);
    assert.equal(bounty.marketTerms?.kind,kind);
    assert.throws(()=>portal.publish(owner,bounty),/not enabled/);
    assert.equal(store.bounty(bounty.id).status,"Draft");
    assert.equal(store.jobs().length,0);
    const edited=await portal.create(owner,{...draft,title:"Updated draft"},bounty);
    assert.equal(edited.marketTerms?.kind,kind);
  }
  await assert.rejects(()=>portal.create(owner,{...draft,marketTerms:{kind:"auction",deliveryHours:0,biddingHours:24}}),/delivery/);
  assert.equal(tasks.all().length,0);
  tasks.close();
});

async function claimedBounty() {
  const ctx = setup();
  const { portal, service, store, tasks } = ctx;
  const c = await portal.create(owner, draft);
  let b = store.bounty(c.id);
  portal.publish(owner, b);
  await portal.tick();
  b = store.bounty(b.id);
  const t = tasks.get(b.taskId!);
  service.fund(t);
  portal.savePayout(store.user(developer.id)!, bank);
  await portal.claim(store.user(developer.id)!, b, {
    policyHash: t.policyHash,
    payoutVersion: store.user(developer.id)!.payout!.version,
  });
  await portal.tick(); // let the issue job finish so no background job owns an error
  return { ...ctx, id: b.id, taskId: t.id };
}
const rescan = (store: PortalStore, id: string) => store.meta(`scan:${id}`, "0");

test("a stale PR discovery error clears after a later successful search with no matching PR", async () => {
  const { portal, store, tasks, setPrs, setPullsStatus, id, taskId } = await claimedBounty();
  setPrs([]);
  setPullsStatus(401);
  rescan(store, id);
  await portal.tick();
  assert.match(store.bounty(id).error!, /GitHub read failed \(401\)/);
  setPullsStatus(200);
  rescan(store, id);
  await portal.tick();
  assert.equal(store.bounty(id).error, null);
  assert.equal(tasks.get(taskId).prNumber, null);
  // A current failure is still reported.
  setPullsStatus(401);
  rescan(store, id);
  await portal.tick();
  assert.match(store.bounty(id).error!, /401/);
  tasks.close();
});

test("a successful PR search never clears an error written by another process", async () => {
  const { portal, store, tasks, setPrs, id } = await claimedBounty();
  setPrs([]);
  // A prior discovery error was cleared, then a background job reports its own failure.
  rescan(store, id);
  await portal.tick();
  const b = store.bounty(id);
  b.error = "Escrow provisioning failed";
  store.save(b);
  store.enqueue(b, "prepare");
  store.retry(`prepare:${id}`, b.error, 0); // pending, scheduled later
  rescan(store, id);
  await portal.tick();
  assert.equal(store.bounty(id).error, "Escrow provisioning failed");
  tasks.close();
});

test("discovery errors recorded before ownership tracking clear once no job owns them", async () => {
  const { portal, store, tasks, setPrs, id } = await claimedBounty();
  setPrs([]);
  const b = store.bounty(id);
  b.error = "GitHub read failed (401); check installation permissions and repository access.";
  store.save(b);
  rescan(store, id);
  await portal.tick();
  assert.equal(store.bounty(id).error, null);
  tasks.close();
});

test("USDC draft and funded policy preserve currency and lock the crypto destination at claim",async()=>{
 const {portal,store,tasks,service}=setup();
 const created=await portal.create(owner,{...draft,paymentRail:'base-usdc',refundAddress:'0x'+'c1ea2'.repeat(8)});
 const b=store.bounty(created.id);assert.equal(b.paymentRail,'base-usdc');portal.publish(owner,b);await portal.tick();
 const task=tasks.get(store.bounty(b.id).taskId!);assert.equal(task.policy.currency,'USD');assert.equal(task.policy.paymentRail,'base-usdc');
 service.fund(task);const funded=tasks.get(task.id);const policy=funded.policyHash;
 assert.throws(()=>service.claim(funded,developer,bank,policy),/signed wallet/);
 service.claimCrypto(funded,developer,'0x1111111111111111111111111111111111111111',policy);
 const assigned=tasks.get(task.id);assert.equal(assigned.policy.recipient,'0x1111111111111111111111111111111111111111');validateFundingPolicy(assigned);
 assert.throws(()=>service.claimCrypto(assigned,{id:201,login:'other'},'0x2222222222222222222222222222222222222222',assigned.policyHash));
 assert.equal(assigned.policy.amountCents,draft.amountCents);assert.equal(assigned.payout,undefined);tasks.close();
});
