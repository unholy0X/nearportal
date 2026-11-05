import { useEffect, useState, type FormEvent } from "react";
import type { Task } from "../server/tasks/domain.ts";
import { euro } from "./api.ts";
import "./tasks.css";
import type { SetupStatus } from "../server/tasks/setup.ts";

type PublicTask = Omit<Task, "clientTokenHash" | "developerTokenHash" | "payout">;
interface View { task: PublicTask; role: "client" | "developer" }
interface Config { mode: string; githubMode: string; notice: string; adminRequired: boolean }

async function request<T>(path: string, token = "", body?: unknown): Promise<T> {
  const res = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error ?? "The task service did not answer");
  return result as T;
}

export function TasksPage() {
  const id = /^\/tasks\/([a-f0-9-]+)$/.exec(location.pathname)?.[1];
  const [config, setConfig] = useState<Config | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [setupError, setSetupError] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [deposit, setDeposit] = useState<{ iban: string | null; reference: string } | null>(null);
  const [payout, setPayout] = useState({ firstName: "", lastName: "", iban: "", country: "" });
  const [pr, setPr] = useState("1");
  const [admin, setAdmin] = useState("");
  const [draft, setDraft] = useState({ title: "Ship CSV export", amount: "100", criteria: "Export every filtered record to a CSV file.\nEscape commas, quotes and newlines correctly.\nThe agreed acceptance suite passes.", repository: "OWNER/REPOSITORY", branch: "main", developer: "DEVELOPER", maintainer: "OWNER", checkName: "acceptance", checkAppId: "15368", workflowPath: ".github/workflows/acceptance.yml", protectedPaths: "test/acceptance.test.mjs\npackage.json" });
  const [token, setToken] = useState(() => {
    if (!id) return "";
    const fragment = new URLSearchParams(location.hash.slice(1)).get("access");
    if (fragment) { sessionStorage.setItem(`np-task:${id}`, fragment); history.replaceState(null, "", location.pathname); }
    return sessionStorage.getItem(`np-task:${id}`) ?? "";
  });
  const savedLinks = id ? sessionStorage.getItem(`np-links:${id}`) : null;
  const links = savedLinks ? JSON.parse(savedLinks) as { client: string; developer: string } : null;
  function switchRole(event: React.MouseEvent, link: string) {
    event.preventDefault();
    const access = new URLSearchParams(link.split("#")[1]).get("access")!;
    sessionStorage.setItem(`np-task:${id}`, access);
    setToken(access); setView(null); setError("");
  }

  const refresh = async () => {
    if (!id) return;
    const data = await request<View>(`/api/tasks/${id}`, token);
    setView(data);
  };
  useEffect(() => {
    request<Config>("/api/tasks/config").then(setConfig).catch((e) => setError(e.message));
    request<SetupStatus & { simulation?: boolean }>("/api/tasks/setup").then((s) => { if (!s.simulation) setSetup(s); }).catch((e) => setSetupError(e.message));
    if (!id) return;
    let active = true;
    const poll = () => request<View>(`/api/tasks/${id}`, token).then((v) => { if (active) setView(v); }).catch((e) => { if (active) setError(e.message); });
    void poll();
    const interval = setInterval(poll, 2500);
    return () => { active = false; clearInterval(interval); };
  }, [id, token]);

  async function action(name: string, body: unknown = {}) {
    setBusy(name); setError("");
    try { await request(`/api/tasks/${id}/${name}`, token, body); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  }
  async function create(e: FormEvent) {
    e.preventDefault(); setBusy("create"); setError("");
    try {
      const cents = Math.round(Number(draft.amount) * 100);
      const result = await request<{ task: PublicTask; clientToken: string; developerToken: string }>("/api/tasks", admin, { ...draft, amountCents: cents, checkAppId: Number(draft.checkAppId) });
      const path = `/tasks/${result.task.id}`;
      sessionStorage.setItem(`np-links:${result.task.id}`, JSON.stringify({ client: `${path}#access=${result.clientToken}`, developer: `${path}#access=${result.developerToken}` }));
      location.assign(`${path}#access=${result.clientToken}`);
    } catch (e) { setError((e as Error).message); setBusy(""); }
  }
  const field = (name: keyof typeof draft, label: string, hint?: string) => <div className="field"><label htmlFor={name}>{label}</label><input id={name} value={draft[name]} onChange={(e) => setDraft({ ...draft, [name]: e.target.value })} required />{hint && <span className="hint">{hint}</span>}</div>;
  const task = view?.task;
  const accepted = task?.clientAccepted && task.developerAccepted;
  const paid = task?.payment.state === "Processed";
  const currentAccepted = view?.role === "client" ? task?.clientAccepted : task?.developerAccepted;
  const stage = paid ? 4 : task?.payment.state !== "NotRequested" && task ? 3 : task?.funded ? 2 : accepted ? 1 : 0;

  return <main className="app task-app" lang="en">
    <header className="top"><a className="logo" href="/tasks">NearPortal<span className="task-wordmark"> / merge</span></a><a className="task-new" href="/tasks">New task ↗</a></header>
    <div className="task-mode"><span className="task-dot" /><span>{task?.githubMode === "fixture" ? "Local simulation. GitHub events and payments are simulated; no real money moves." : config?.notice ?? "Connecting to the task demo…"}</span></div>
    {error && <div className="error" role="alert">{error}</div>}
    {!id ? <>
      {setup && <section className="card task-setup"><div className="row"><strong>GitHub connected · {setup.account}</strong><span className={`chip ${setup.ready ? "ok" : "warn"}`}>{setup.ready ? "Repository ready" : "Setup pending"}</span></div><p>{setup.repository} · {setup.branch} · client: {setup.client}</p><ul className="task-checks"><li>{setup.clientCanMerge ? "✓" : "○"} Client can merge</li><li>{setup.files.every((f) => f.ready) ? "✓" : "○"} Acceptance workflow and protected tests on main</li></ul><p className="hint">Your account setup is complete when these checks pass. Choose a separate developer to create a live task. The payment mode is shown above.</p></section>}
      {setupError && <div className="error">GitHub connection: {setupError}</div>}
      <section className="task-hero"><span className="eyebrow">A clear brief. A funded promise.</span><h1>Merge the work.<br /><em>Move the money.</em></h1><p className="lead">Agree on success before coding starts. Fund the task. When the right pull request passes its checks and the client merges it, payment happens automatically.</p></section>
      <form onSubmit={create} className="task-create">
        <section className="card"><span className="eyebrow">01 / The task</span>{field("title", "What are we shipping?")}
          <div className="field"><label htmlFor="amount">Reward in EUR</label><input id="amount" type="number" min="0.01" max="1000" step="0.01" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} required /></div>
          <div className="field"><label htmlFor="criteria">Success criteria</label><textarea id="criteria" rows={5} value={draft.criteria} onChange={(e) => setDraft({ ...draft, criteria: e.target.value })} required /><span className="hint">The acceptance tests must cover these criteria. The verifier checks test results; it does not judge arbitrary prose.</span></div>
        </section>
        <section className="card"><span className="eyebrow">02 / The proof</span>{field("repository", "GitHub repository", "owner/repository")}{field("branch", "Target branch")}
          {config?.githubMode === "live" && <>{field("developer", "Developer's GitHub username", "Add an existing developer later. Your client account can stay connected now.")}{field("maintainer", "Client maintainer's GitHub username", "A different person with permission to merge.")}</>}
          <details><summary>Acceptance workflow and protected files</summary><div className="stack task-details">{field("checkName", "Required check name")}{field("checkAppId", "Source GitHub App ID")}{field("workflowPath", "Acceptance workflow file")}
            <div className="field"><label htmlFor="protectedPaths">Protected files · one path per line</label><textarea id="protectedPaths" rows={3} value={draft.protectedPaths} onChange={(e) => setDraft({ ...draft, protectedPaths: e.target.value })} /><span className="hint">Workflow, test and configuration files are pinned when this task is created.</span></div></div></details>
          <p className="hint">Release requires a qualifying merge by the agreed client maintainer. The developer cannot approve their own payment.</p>
          {config?.adminRequired && <div className="field"><label htmlFor="admin">Demo administrator token</label><input id="admin" type="password" value={admin} onChange={(e) => setAdmin(e.target.value)} required /></div>}
          <button className="btn" disabled={Boolean(busy) || !config}>{busy ? "Preparing the policy…" : "Create a funded-work agreement →"}</button>
        </section>
      </form>
    </> : !task ? <div className="card"><h1>Opening your task…</h1><p>Use the client or developer access link created with the task.</p></div> : <>
      <div className="task-heading"><div><span className="eyebrow">{task.policy.repository} / {view.role} view</span><h1>{task.policy.title}</h1></div><div className="task-reward"><span className="hint">{paid ? "Paid automatically" : "Task reward"}</span><strong>{euro(task.policy.amountCents)}</strong></div></div>
      {links && <nav className="task-role" aria-label="Demo role"><span>Demo access links</span><a href={links.client} onClick={(e) => switchRole(e, links.client)}>Client view ↗</a><a href={links.developer} onClick={(e) => switchRole(e, links.developer)}>Developer view ↗</a><span className="hint">These links grant access. Share only with each party.</span></nav>}
      <ol className="task-stages">{["Agree", "Fund", "Verify PR", "Release", "Paid"].map((label, index) => <li className={index <= stage ? "done" : ""} key={label}><span>{index < stage ? "✓" : index + 1}</span>{label}</li>)}</ol>
      <div className="task-columns"><div className="stack">
        <section className="card"><span className="eyebrow">Where the developer gets paid</span>
          {task.policy.payoutCommitment && <p><strong>{task.policy.recipient}</strong></p>}
          {view.role === "developer" && !task.clientAccepted && !task.developerAccepted && task.jobId === null && !task.funded ? <form className="stack" onSubmit={(e) => { e.preventDefault(); void action("payout", payout); }}>
            <p>Save the account holder's name and SEPA IBAN before either party accepts. Payment goes to this account automatically after a qualifying merge.</p>
            {([ ["firstName", "Account holder's first name"], ["lastName", "Account holder's last name"], ["iban", "Payout IBAN"], ["country", "Account holder's country code"] ] as const).map(([key, label]) => <div className="field" key={key}><label htmlFor={`payout-${key}`}>{label}</label><input id={`payout-${key}`} value={payout[key]} autoComplete={key === "firstName" ? "given-name" : key === "lastName" ? "family-name" : "off"} maxLength={key === "country" ? 2 : key === "iban" ? 42 : 100} placeholder={key === "country" ? "FR" : undefined} onChange={(e) => setPayout({ ...payout, [key]: e.target.value })} required /></div>)}
            <span className="hint">Only the masked IBAN appears in the agreement. Details lock after either party accepts. Format validation does not verify account ownership.</span>
            {task.mode === "sandbox" && <><button className="btn ghost" type="button" onClick={() => setPayout({ firstName: "Demo", lastName: "Developer", iban: "FR1420041010050500013M02606", country: "FR" })}>Use sandbox test details</button><span className="hint">Sandbox funds only. Use the test details for this demo.</span></>}
            <button className="btn" disabled={Boolean(busy)}>{task.policy.payoutCommitment ? "Update payout details" : "Save payout details"}</button>
          </form> : <p className="hint">{task.policy.payoutCommitment ? "Payout details are saved. They lock once either party accepts." : "Waiting for the developer to save their payout details using the developer access link."}</p>}
        </section>
        <section className="card"><span className="eyebrow">The agreed outcome</span><ul className="task-criteria">{task.policy.criteria.map((c, i) => <li key={i}><span>✓</span>{c}</li>)}</ul>
          <div className="rule" /><dl className="task-facts"><div><dt>Payment trigger</dt><dd>Checks succeed + client merges into <code>{task.policy.branch}</code></dd></div><div><dt>Assigned developer</dt><dd>{task.policy.developerLogin}</dd></div><div><dt>Recipient</dt><dd>{task.policy.recipient}</dd></div><div><dt>Verifier</dt><dd>{task.policy.verifier}</dd></div></dl>
          <div className="task-acceptances"><span className={`chip ${task.clientAccepted ? "ok" : ""}`}>{task.clientAccepted ? "✓" : "○"} Client accepted</span><span className={`chip ${task.developerAccepted ? "ok" : ""}`}>{task.developerAccepted ? "✓" : "○"} Developer accepted</span></div>
          {!currentAccepted && <><p className="hint">Accepting authorizes the designated verifier to release this fixed reward automatically when the agreed conditions hold. No second payment approval is needed.</p><button className="btn" disabled={Boolean(busy) || !task.policy.payoutCommitment} onClick={() => action("accept", { policyHash: task.policyHash })}>Accept criteria & automatic payment</button></>}
          <details><summary>View the fixed verification policy</summary><pre className="doc task-policy">{JSON.stringify(task.policy, null, 2)}</pre><p className="hint task-hash">Policy SHA-256: {task.policyHash}</p></details>
        </section>
        <section className="card"><div className="row"><span className="eyebrow">Pull request verification</span><span className={`chip ${task.verdict?.status === "eligible" ? "ok" : ""}`}>{task.verdict?.status ?? "Waiting"}</span></div>
          {!task.prNumber ? <><p>Link the developer's PR after both parties accept and the task is funded.</p><div className="field"><label htmlFor="pr">PR number</label><input id="pr" type="number" min="1" value={pr} onChange={(e) => setPr(e.target.value)} /></div><button className="btn ghost" disabled={Boolean(busy) || !task.funded || view.role !== "developer"} onClick={() => action("pr", { number: Number(pr) })}>Link pull request</button></> : <>
            <a className="task-pr" href={task.evidence?.url ?? `https://github.com/${task.policy.repository}/pull/${task.prNumber}`} target="_blank" rel="noreferrer">PR #{task.prNumber} ↗</a>
            <ul className="task-checks"><li>{task.evidence?.merged ? "✓" : "○"} Client merge into {task.policy.branch}</li>{task.policy.checks.map((c) => { const check = task.evidence?.checks.find((x) => x.name === c.name); return <li key={c.name}>{check?.conclusion === "success" ? "✓" : "○"} {c.name} · {check?.conclusion ?? "waiting"}</li>; })}</ul>
            {task.verdict?.reasons.map((r) => <p className="task-reason" key={r}>{r}</p>)}
            {task.evidence && <p className="hint task-hash">Submitted commit: {task.evidence.headSha}<br />Evidence: {task.verdict?.evidenceHash}</p>}
            <button className="btn ghost" disabled={Boolean(busy) || paid} onClick={() => action("verify")}>Refresh GitHub verification</button>
            {task.githubMode === "fixture" && !paid && <div className="task-fixture"><span className="eyebrow">Simulated GitHub controls</span>{view.role === "developer" ? <div className="task-fixture-buttons"><button disabled={Boolean(busy)} onClick={() => action("simulate", { action: "failed" })}>Fail checks</button><button disabled={Boolean(busy)} onClick={() => action("simulate", { action: "tampered" })}>Change protected tests</button><button disabled={Boolean(busy)} onClick={() => action("simulate", { action: "ready" })}>Pass acceptance tests</button></div> : <button className="btn ink" disabled={Boolean(busy) || task.fixture !== "ready"} onClick={() => action("simulate", { action: "merged" })}>Simulate client merge →</button>}<span className="hint">Fixture events only. Live mode reads actual GitHub records.</span></div>}
          </>}
        </section>
      </div><aside className="stack">
        <section className={`card task-money ${paid ? "paid" : ""}`}><span className="eyebrow">{paid ? "✓ Payment complete" : task.funded ? "Reward secured" : "Fund before work starts"}</span><strong>{euro(task.policy.amountCents)}</strong><p>{paid ? task.mode === "simulation" ? "The simulated reward was paid automatically after the qualifying merge." : "Monerium confirmed the sandbox payout." : task.payment.state !== "NotRequested" ? "The accepted conditions authorized payment. Following the transfer to completion." : task.funded ? "Ready for the developer. The verifier releases it when every condition passes." : "The developer can link a PR once the escrow is funded."}</p><span className="chip">{task.payment.state}</span>
          {accepted && !task.funded && view.role === "client" && (task.mode === "simulation" ? <button className="btn" disabled={Boolean(busy)} onClick={() => action("fund")}>Fund simulated escrow</button> : <><button className="btn" onClick={async () => { try { setDeposit(await request(`/api/tasks/${id}/deposit`, token)); } catch (e) { setError((e as Error).message); } }}>Show sandbox bank instructions</button>{deposit && <p className="task-hash">IBAN: {deposit.iban ?? "Waiting for escrow address linking…"}<br />Reference: {deposit.reference}<br />Send exactly {euro(task.policy.amountCents)} through Monerium sandbox.</p>}</>)}
          {task.payment.reference && <code className="task-hash">{task.payment.reference}</code>}
        </section>
        {task.payment.error && <div className="error" role="alert">{task.payment.error}</div>}
        {task.disputed && <div className="error">A dispute blocks automatic release.</div>}
        <section className="card"><span className="eyebrow">Activity & receipts</span><ol className="task-timeline">{[...task.timeline].reverse().map((event, i) => <li key={i}><span>{event.message}</span><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time></li>)}</ol></section>
        {!paid && task.funded && task.payment.state === "NotRequested" && <button className="link-btn" disabled={Boolean(busy) || task.disputed} onClick={() => action("dispute")}>Report a problem & block automatic release</button>}
      </aside></div>
    </>}
    <footer className="task-footer">NearPortal Merge · {config?.mode === "sandbox" ? "Testnet / sandbox" : "Simulation"} · The agreed verifier checks GitHub; the escrow enforces its payment mandate.</footer>
  </main>;
}
