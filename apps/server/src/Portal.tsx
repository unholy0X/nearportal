import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { PortalService } from "../server/portal/service.ts";
import type { Identity } from "../server/portal/store.ts";
import "./portal.css";
import "./workspace-fonts.css";
import "./workspace/workspace.css";
import "./workspace-pages.css";
import { mountShell, iconPath, poll, type ShellController } from "./workspace/workspace-shell.mjs";
import { STATUSES, bountyStatus, nextAction, scopeBounties, filterBounties, summary, type Role, type StatusKey } from "./workspace/workspace-model.mjs";
import { JudgeDemo } from "./JudgeDemo.tsx";

type Bounty = ReturnType<PortalService["public"]>;
interface Me {
  openBountyReady?: boolean;
  cryptoPaymentsReady?: boolean;
  demoTreasuryAvailable?: boolean;
  bountyModeCapabilities?: { fixedDeadline?: boolean; sealedBid?: boolean };
  user: Identity | null;
  csrf: string | null;
  oauthConfigured: boolean;
  localPreview: boolean;
  mode: string;
  bankConnected: boolean;
  payout: {
    name: string;
    iban: string;
    country: string;
    version?: string;
  } | null;
}
interface Repo {
  id: number;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  language: string | null;
  defaultBranch: string;
  canWrite: boolean;
  url: string;
}
let csrf = "";
const money = (c: number, rail?: string) => rail === "base-usdc" ? `${(c/100).toFixed(2)} USDC` :
  new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: c % 100 ? 2 : 0,
  }).format(c / 100);
const ago = (s: string) => {
  const days = Math.floor((Date.now() - Date.parse(s)) / 86400_000);
  return days ? `${days}d ago` : "Today";
};
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    path.startsWith("/auth/") ? path : `/api/portal${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? {}
          : { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  if (r.status === 204) return {} as T;
  const data = await r.json();
  if (!r.ok)
    throw new Error(data.error ?? "Something went wrong. Please try again.");
  return data as T;
}
const paths = {
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  briefcase: "M3 7h18v14H3zM8 7V3h8v4M3 12h18M10 12v3h4v-3",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18",
  repo: "M5 3h14v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 14h14M7 6h7",
  gear: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  up: "M5 19 19 5M5 5h14v14",
  check: "m5 12 4 4L19 6",
  lock: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4",
  search: "M21 21l-6-6M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14",
  plus: "M12 4v16M4 12h16",
  git: "M12 3a9 9 0 0 0-3 17.5v-3c-3 .7-3-1.5-4-2m10 5v-4c0-1-.3-1.6-.8-2 2.8-.3 4.8-1.3 4.8-5a4 4 0 0 0-1-2.7c.1-.9.1-1.8-.3-2.8-1 0-2 .5-2.8 1a10 10 0 0 0-6 0c-.8-.5-1.8-1-2.8-1-.4 1-.4 1.9-.3 2.8a4 4 0 0 0-1 2.7c0 3.7 2 4.7 4.8 5-.5.4-.8 1-.8 2v4",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2",
  shield: "m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Zm-4 10 3 3 5-6",
  wallet: "M3 6h16v15H3zM3 6V3h14v3m-1 6h5v5h-5z",
  branch:
    "M6 3v12a4 4 0 0 0 8 0V8M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm8 1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  logout: "M9 3H3v18h6m5-15 6 6-6 6m-7-6h13",
  chevron: "m9 5 7 7-7 7",
  copy: "M8 8h13v13H8zM16 8V3H3v13h5",
  globe:
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c-5 5-5 13 0 18 5-5 5-13 0-18ZM3 12h18",
};
type IconName = keyof typeof paths;
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
function Logo({ light = false }: { light?: boolean }) {
  return (
    <a className={`np-logo ${light ? "np-logo-light" : ""}`} href="/">
      <img className="np-aurora-logo" src="/brand/symbol.png" alt="" />
      <span>nearportal</span>
    </a>
  );
}
function Button({
  href,
  children,
  secondary = false,
  ...rest
}: {
  href?: string;
  children: ReactNode;
  secondary?: boolean;
  [key: string]: unknown;
}) {
  return href ? (
    <a className={`np-button ${secondary ? "np-secondary" : ""}`} href={href}>
      {children}
    </a>
  ) : (
    <button
      className={`np-button ${secondary ? "np-secondary" : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}
function Status({ b }: { b: Bounty }) {
  const s = b.status;
  return (
    <span className={`np-status np-state-${s}`}>
      <span />
      {(
        {
          AwaitingFunding: "Awaiting funding",
          InReview: "In review",
          NeedsAttention: "Needs attention",
          Releasing: "Paying out",
        } as Record<string, string>
      )[s] ?? s}
    </span>
  );
}
function Funded({ b }: { b: Bounty }) {
  return b.task?.funded ? (
    <span className="np-funded">
      <Icon name="shield" size={13} />
      {b.status === "Paid" ? "Payment verified" : "Escrow funded"}
    </span>
  ) : null;
}

function Empty({
  icon = "briefcase",
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="np-empty">
      <span className="np-empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

function Landing({ me }: { me: Me | null }) {
  return (
    <div className="np-landing">
      <nav className="np-public-nav">
        <Logo />
        <div>
          <a href="#how-it-works">How it works</a>
          <a href="/bounties">Explore bounties</a>
          <a href="#the-proof">The proof</a>
          <a href="/demo">Try the demo</a>
        </div>
        <Button href={me?.user ? "/app" : "/login"}>
          {me?.user ? "Your workspace" : "Connect GitHub"}
          <Icon name={me?.user ? "arrow" : "git"} size={17} />
        </Button>
      </nav>
      <section className="np-hero">
        <div className="np-hero-copy">
          <span className="np-eyebrow">
            <span className="np-pulse" />
            Good work. Funded reward.
          </span>
          <h1>
            You ship the code.
            <br />
            The money
            <br />
            <em>follows.</em>
            <span className="np-hero-star">✳</span>
          </h1>
          <p>
            Turn GitHub issues into funded opportunities. Set the outcome, lock
            the reward, and let a qualifying merge take care of payday.
          </p>
          <div className="np-hero-ctas">
            <Button href={me?.user ? "/app/new" : "/login"}>
              Fund your first bounty
              <Icon name="arrow" size={18} />
            </Button>
            <a className="np-text-link" href="/bounties">
              Find work worth shipping <Icon name="up" size={16} />
            </a>
          </div>
          <span className="np-hero-note">
            <Icon name="git" size={15} /> Built around your repositories. No
            wallet required for developers.
          </span>
        </div>
        <div
          className="np-hero-scene"
          aria-label="Illustration of a funded task becoming a paid contribution"
        >
          <div className="np-orbit np-orbit-one" />
          <div className="np-orbit np-orbit-two" />
          <span className="np-scene-label">THE MERGE-TO-MONEY LOOP</span>
          <div className="np-visual-task">
            <div className="np-visual-task-top">
              <span>
                <Icon name="repo" size={15} />
                your-repository <span>/</span> issue #42
              </span>
              <span className="np-visual-tag">Funded</span>
            </div>
            <div className="np-visual-task-body">
              <span className="np-mini-code">NP-A7B42C</span>
              <h3>
                Build something
                <br />
                that matters.
              </h3>
              <p>
                Clear criteria. A committed client.
                <br />
                Your next meaningful contribution.
              </p>
              <div className="np-visual-reward">
                <span>Reward locked in escrow</span>
                <strong>
                  €500<span>.00</span>
                </strong>
              </div>
            </div>
            <div className="np-visual-task-bottom">
              <Icon name="shield" size={16} /> Secured by NEAR Chain Signatures
            </div>
          </div>
          <div className="np-visual-code">
            <span>
              <i />
              <i />
              <i />
            </span>
            <code>
              <b>✓</b> acceptance tests passed
              <br />
              <b>✓</b> client merged PR
              <br />
              <b>→</b> release reward automatically
            </code>
          </div>
          <div className="np-visual-paid">
            <span>
              <Icon name="check" size={21} />
            </span>
            <div>
              <strong>Good work. Paid.</strong>
              <small>From merged PR to your account.</small>
            </div>
            <Icon name="up" size={18} />
          </div>
          <span className="np-scene-footnote">
            Illustrative reward · Live app currently uses sandbox funds
          </span>
        </div>
      </section>
      <section className="np-trust">
        <span>
          YOUR WORKFLOW.
          <br />
          <b>A STRONGER PROMISE.</b>
        </span>
        <div>
          <Icon name="git" size={23} />
          GitHub
        </div>
        <div>
          <span className="np-near-symbol">N</span>NEAR
        </div>
        <div>
          <span className="np-monerium-symbol">€</span>Monerium
        </div>
        <p>
          Code stays in GitHub.
          <br />
          Trust lives in the escrow.
        </p>
      </section>
      <section className="np-how" id="how-it-works">
        <div className="np-section-heading">
          <div>
            <span className="np-eyebrow">A BETTER WAY TO BUILD TOGETHER</span>
            <h2>
              A clear agreement.
              <br />
              An automatic follow-through.
            </h2>
          </div>
          <p>
            No chasing invoices. No guessing whether
            <br />a reward exists. Just a verifiable path
            <br />
            from a good brief to a paid contribution.
          </p>
        </div>
        <div className="np-how-grid">
          {[
            {
              n: "01",
              icon: "repo" as const,
              t: "Define the outcome",
              p: "Choose a repository, describe the task, and select the acceptance checks that prove it’s done.",
            },
            {
              n: "02",
              icon: "lock" as const,
              t: "Make the reward real",
              p: "Fund the dedicated escrow before work starts. Developers can verify the reward is secured.",
            },
            {
              n: "03",
              icon: "branch" as const,
              t: "Merge. Money moves.",
              p: "A developer submits a tracked PR. When checks pass and the client merges, payout follows automatically.",
            },
          ].map((c) => (
            <article key={c.n}>
              <div>
                <Icon name={c.icon} size={26} />
                <span>{c.n}</span>
              </div>
              <h3>{c.t}</h3>
              <p>{c.p}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="np-proof" id="the-proof">
        <div>
          <span className="np-eyebrow">
            <span className="np-pulse" />
            BUILT. TESTED. RECEIVED.
          </span>
          <h2>
            More than
            <br />a green check.
          </h2>
          <p>
            Our end-to-end rehearsal went all the way: a funded task, a verified
            GitHub contribution, an automatic payout, and a confirmed receipt in
            the developer’s separate account.
          </p>
          <a className="np-text-link" href="/bounties">
            Explore the workflow <Icon name="arrow" size={17} />
          </a>
        </div>
        <div className="np-proof-receipt">
          <div className="np-receipt-check">
            <Icon name="check" size={27} />
          </div>
          <span>SUCCESSFUL SANDBOX REHEARSAL</span>
          <strong>€1.00</strong>
          <p>Received by the developer</p>
          <dl>
            <div>
              <dt>GitHub submission</dt>
              <dd>PR #3 · squash merged</dd>
            </div>
            <div>
              <dt>Escrow</dt>
              <dd>NEAR testnet · job #2</dd>
            </div>
            <div>
              <dt>Monerium payout</dt>
              <dd>
                <span className="np-paid-dot" />
                Processed
              </dd>
            </div>
          </dl>
          <small>Test funds · 3 November 2026 · Not a mainnet payment</small>
        </div>
      </section>
      <section className="np-last-call">
        <span className="np-eyebrow">SHIP WITH SOMETHING TO SHOW FOR IT</span>
        <h2>
          The next great contribution
          <br />
          starts with <em>a funded promise.</em>
        </h2>
        <Button href={me?.user ? "/app" : "/login"}>
          Let’s build something
          <Icon name="arrow" size={18} />
        </Button>
      </section>
      <footer className="np-public-footer">
        <Logo />
        <p>Work, with follow-through.</p>
        <span>© 2026 NearPortal</span>
        <a href="/bounties">Explore</a>
        <a href="/app/settings">Account</a>
        <a href="/mcp">MCP guide</a>
        <span className="np-sandbox-label">Testnet / sandbox</span>
      </footer>
    </div>
  );
}







function NewBounty() {
  const [step, setStep] = useState(0),
    [repos, setRepos] = useState<Repo[]>([]),
    [workflows, setWorkflows] = useState<{ name: string; path: string }[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const selected = new URLSearchParams(location.search).get("repository") ?? "";
  const draftId = new URLSearchParams(location.search).get("draft");
  const [draft, setDraft] = useState({
    repository: selected,
    title: "",
    description: "",
    criteria: "",
    amount: "100",
    branch: "main",
    checkName: "acceptance",
    checkAppId: "15368",
    workflowPath: ".github/workflows/acceptance.yml",
    protectedPaths: "",
  });
  const set = (k: keyof typeof draft, v: string) =>
    setDraft((d) => ({ ...d, [k]: v }));
  useEffect(() => {
    if (draftId)
      api<{ bounty: Bounty }>(`/bounties/${draftId}`)
        .then(({ bounty: b }) =>
          setDraft({
            repository: b.repository,
            title: b.title,
            description: b.description,
            criteria: b.criteria.join("\n"),
            amount: String(b.amountCents / 100),
            branch: b.branch,
            checkName: b.checkName,
            checkAppId: String(b.checkAppId),
            workflowPath: b.workflowPath,
            protectedPaths: b.protectedPaths,
          }),
        )
        .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    api<{ repositories: Repo[] }>("/repositories")
      .then((r) => setRepos(r.repositories.filter((r) => r.canWrite)))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!draft.repository) return;
    setError("");
    api<{
      defaultBranch: string;
      squashEnabled: boolean;
      workflows: { name: string; path: string }[];
    }>(`/repository-setup?repository=${encodeURIComponent(draft.repository)}`)
      .then((r) => {
        if (!draftId) set("branch", r.defaultBranch);
        setWorkflows(r.workflows);
      })
      .catch((e) => setError(e.message));
  }, [draft.repository]);
  const field = (
    key: keyof typeof draft,
    label: string,
    placeholder?: string,
    area = false,
  ) => (
    <label className="np-field">
      {label}
      {area ? (
        <textarea
          value={draft[key]}
          placeholder={placeholder}
          rows={key === "description" ? 6 : 4}
          onChange={(e) => set(key, e.target.value)}
          required
        />
      ) : (
        <input
          value={draft[key]}
          placeholder={placeholder}
          onChange={(e) => set(key, e.target.value)}
          required
        />
      )}
    </label>
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (step < 2) {
      setStep(step + 1);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { bounty } = await api<{ bounty: Bounty }>(
        draftId ? `/bounties/${draftId}/edit` : "/bounties",
        {
          ...draft,
          amountCents: Math.round(Number(draft.amount) * 100),
          checkAppId: Number(draft.checkAppId),
        },
      );
      location.assign(`/bounties/${bounty.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <>
      <a className="np-back" href="/app/bounties">
        ← Your bounties
      </a>
      <div className="np-page-heading">
        <div>
          <span className="np-eyebrow">A GOOD BRIEF IS A GOOD BEGINNING</span>
          <h1>Let’s make something happen.</h1>
          <p>
            Give contributors a clear outcome and a reward they can count on.
          </p>
        </div>
        <span className="np-draft-label">New bounty draft</span>
      </div>
      <div className="np-create-layout">
        <form className="np-create-form" onSubmit={submit}>
          <div className="np-form-steps">
            {["The brief", "The proof", "The reward"].map((label, i) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  if (i < step) setStep(i);
                }}
                className={i <= step ? "active" : ""}
              >
                <span>
                  {i < step ? <Icon name="check" size={13} /> : i + 1}
                </span>
                {label}
              </button>
            ))}
          </div>
          {error && <div className="np-alert">{error}</div>}
          {step === 0 ? (
            <>
              <div className="np-form-intro">
                <span className="np-form-icon">
                  <Icon name="repo" size={24} />
                </span>
                <h2>What would you like to ship?</h2>
                <p>
                  Be specific. The best contributions start with a shared
                  understanding.
                </p>
              </div>
              <label className="np-field">
                GitHub repository
                <select
                  value={draft.repository}
                  onChange={(e) => set("repository", e.target.value)}
                  required
                >
                  <option value="">Choose a repository</option>
                  {selected && !repos.some((r) => r.fullName === selected) && (
                    <option value={selected}>{selected}</option>
                  )}
                  {repos.map((r) => (
                    <option key={r.id} value={r.fullName}>
                      {r.fullName}
                    </option>
                  ))}
                </select>
                <small>
                  Need another repository?{" "}
                  <a href="/app/repositories">Browse your repositories</a>.
                </small>
              </label>
              {field(
                "title",
                "Bounty title",
                "e.g. Add CSV export to the analytics dashboard",
              )}
              {field(
                "description",
                "The brief",
                "Describe the problem, the expected behavior, and any context a contributor needs.",
                true,
              )}
              {field(
                "criteria",
                "Acceptance criteria · one per line",
                "Export all filtered records\nHandle commas, quotes and newlines\nPass the agreed acceptance suite",
                true,
              )}
            </>
          ) : step === 1 ? (
            <>
              <div className="np-form-intro">
                <span className="np-form-icon">
                  <Icon name="code" size={24} />
                </span>
                <h2>What proves the work is done?</h2>
                <p>
                  Choose an existing GitHub Actions check that tests your
                  criteria.
                </p>
              </div>
              <div className="np-info">
                <Icon name="shield" size={19} />
                <p>
                  NearPortal verifies objective CI results. Written criteria
                  must be covered by the tests you select; prose alone doesn’t
                  prove completion.
                </p>
              </div>
              {field("branch", "Target branch", "main")}
              <label className="np-field">
                Acceptance workflow
                <select
                  value={draft.workflowPath}
                  onChange={(e) => set("workflowPath", e.target.value)}
                >
                  <option value=".github/workflows/acceptance.yml">
                    .github/workflows/acceptance.yml
                  </option>
                  {workflows
                    .filter(
                      (w) => w.path !== ".github/workflows/acceptance.yml",
                    )
                    .map((w) => (
                      <option key={w.path} value={w.path}>
                        {w.name} · {w.path}
                      </option>
                    ))}
                </select>
              </label>
              {field("checkName", "Required check name", "acceptance")}
              {field(
                "protectedPaths",
                "Protected test and configuration files · one per line",
                "test/acceptance.test.mjs\npackage.json",
                true,
              )}
              <small className="np-form-hint">
                The workflow and these files are pinned when you publish.
                Changing them in the submitted PR blocks payment.
              </small>
              <details className="np-advanced">
                <summary>Advanced verification settings</summary>
                {field("checkAppId", "Check source GitHub App ID", "15368")}
              </details>
              <div className="np-info">
                <Icon name="branch" size={18} />
                <p>
                  Only a{" "}
                  <strong>merge by your client GitHub identity</strong>{" "}
                  can trigger payment. A contributor’s own merge cannot.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="np-form-intro">
                <span className="np-form-icon">
                  <Icon name="wallet" size={24} />
                </span>
                <h2>Put a reward behind the work.</h2>
                <p>
                  Save your draft, then publish and fund its dedicated escrow.
                </p>
              </div>
              <label className="np-field">
                Reward in EUR
                <div className="np-amount-field">
                  <span>€</span>
                  <input
                    aria-label="Reward amount"
                    type="number"
                    min="0.01"
                    max="1000"
                    step="0.01"
                    required
                    value={draft.amount}
                    onChange={(e) => set("amount", e.target.value)}
                  />
                  <span>EUR</span>
                </div>
                <small>
                  Sandbox limit: €1,000. Use €1 for an end-to-end rehearsal.
                </small>
              </label>
              <div className="np-reward-breakdown">
                <div>
                  <span>Contributor reward</span>
                  <strong>
                    {money(Math.round(Number(draft.amount || 0) * 100))}
                  </strong>
                </div>
                <div>
                  <span>Platform fee in this demo</span>
                  <strong>€0</strong>
                </div>
                <div>
                  <span>Total to fund</span>
                  <strong>
                    {money(Math.round(Number(draft.amount || 0) * 100))}
                  </strong>
                </div>
              </div>
              <div className="np-info">
                <Icon name="lock" size={19} />
                <p>
                  Publish when you’re ready. Your issue becomes available after
                  the escrow confirms the deposit. A developer can then claim it
                  while you’re offline. The funded brief and reward status are
                  public, including for private repositories. Repository code
                  stays private.
                </p>
              </div>
              <label className="np-consent">
                <input type="checkbox" required />
                <span>
                  I understand this is a sandbox task. On publishing, I
                  authorize the designated verifier to bind the first eligible
                  developer’s payout destination and release the fixed reward
                  after the agreed checks and my qualifying merge.
                </span>
              </label>
            </>
          )}
          <div className="np-form-actions">
            {step > 0 ? (
              <button
                className="np-link-button"
                type="button"
                onClick={() => setStep(step - 1)}
              >
                ← Back
              </button>
            ) : (
              <span />
            )}
            <Button disabled={busy}>
              {busy
                ? "Saving your bounty…"
                : step === 2
                  ? "Save bounty draft"
                  : "Continue"}
              <Icon name="arrow" size={17} />
            </Button>
          </div>
        </form>
        <aside className="np-create-guide">
          <span className="np-eyebrow">YOUR BOUNTY, AT A GLANCE</span>
          <div className="np-guide-repo">
            <Icon name="repo" size={18} />
            {draft.repository || "Select a repository"}
          </div>
          <h2>{draft.title || "Something worth building."}</h2>
          <strong className="np-guide-amount">
            {money(Math.round(Number(draft.amount || 0) * 100))}
            <span>contributor reward</span>
          </strong>
          <div className="np-rule" />
          <h3>A promise with a paper trail.</h3>
          <ul>
            <li>
              <Icon name="check" size={16} />
              Criteria pinned before work starts
            </li>
            <li>
              <Icon name="check" size={16} />
              Reward held in a dedicated escrow
            </li>
            <li>
              <Icon name="check" size={16} />
              PR tracked by a unique task code
            </li>
            <li>
              <Icon name="check" size={16} />
              Automatic payout after your merge
            </li>
          </ul>
          <div className="np-guide-note">
            <Icon name="shield" size={23} />
            <p>
              You can step away.
              <br />
              <strong>The commitment stays.</strong>
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}


function BountyPage({ id, me }: { id: string; me: Me | null }) {
  const [b, setB] = useState<Bounty | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [deposit, setDeposit] = useState<{
      iban: string | null;
      reference: string;
    } | null>(null),
    [pr, setPr] = useState(""),
    [preparedUrl, setPreparedUrl] = useState(""),
    [forkNotice, setForkNotice] = useState(""),
    [copied, setCopied] = useState(false),
    [consent, setConsent] = useState(false);
  const load = () =>
    api<{ bounty: Bounty }>(`/bounties/${id}`).then((r) => setB(r.bounty));
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api<{ bounty: Bounty }>(`/bounties/${id}`)
        .then((r) => {
          if (alive) setB(r.bounty);
          return true;
        })
        .catch((e) => {
          if (alive) setError(e.message);
          return false;
        });
    void refresh();
    const poller = poll(refresh, { interval: 10000 });
    return () => {
      alive = false;
      poller.stop();
    };
  }, [id]);
  useEffect(() => {
    if (!deposit || deposit.iban) return;
    let alive = true;
    const refresh = () =>
      api<{ iban: string | null; reference: string }>(`/bounties/${id}/deposit`)
        .then((d) => {
          if (alive) setDeposit(d);
          return true;
        })
        .catch(() => false);
    const poller = poll(refresh, { interval: 15000 });
    return () => {
      alive = false;
      poller.stop();
    };
  }, [id, deposit?.iban, deposit?.reference]);
  async function action(name: string, body: unknown = {}) {
    setBusy(name);
    setError("");
    try {
      await api(`/bounties/${id}/${name}`, body);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  if (!b)
    return (
      <div className="np-panel">
        {error ? (
          <Empty title="This bounty isn’t available">
            {error}
            <br />
            <a href="/login">Sign in to check repository access</a>
          </Empty>
        ) : (
          <div className="np-loading">
            <span className="np-spinner" />
            Opening the bounty…
          </div>
        )}
      </div>
    );
  const t = b.task,
    client = b.role === "client",
    developer = b.role === "developer",
    paid = b.status === "Paid",
    marker = `NearPortal-Task: ${b.code}`,
    stage = paid
      ? 4
      : t?.payment.state !== "NotRequested" && t
        ? 3
        : t?.prNumber
          ? 2
          : t?.funded
            ? 1
            : 0;
  return (
    <>
      <a
        className="np-back"
        href={client ? "/app/bounties" : developer ? "/app/work" : "/bounties"}
      >
        ←{" "}
        {client
          ? "Your bounties"
          : developer
            ? "Your contributions"
            : "Explore bounties"}
      </a>
      <div className="np-detail-heading">
        <div>
          <div className="np-detail-context">
            <Icon name="repo" size={15} />
            <a
              href={`https://github.com/${b.repository}`}
              target="_blank"
              rel="noreferrer"
            >
              {b.repository}
            </a>
            <span>/</span>
            <code>{b.code}</code>
            {b.private && <Icon name="lock" size={13} />}
          </div>
          <h1>{b.title}</h1>
          <div className="np-detail-tags">
            <Status b={b} />
            <Funded b={b} />
            {b.private && (
              <span className="np-invite-badge">
                <Icon name="lock" size={12} /> Private repo · Invite only
              </span>
            )}
            <span>
              Created {ago(b.createdAt)} by @{b.owner}
            </span>
          </div>
        </div>
        <div className="np-detail-reward">
          <small>FIXED CONTRIBUTOR REWARD</small>
          <strong>{money(b.amountCents,b.paymentRail)}</strong>
          <span>EUR · sandbox funds</span>
        </div>
      </div>
      {error && (
        <div className="np-alert" role="alert">
          {error}
        </div>
      )}
      {b.error && client && (
        <div className="np-alert">
          <strong>Background job needs attention</strong>
          <p>{b.error}</p>
          <small>
            Saved work is retained. The worker retries automatically.
          </small>
        </div>
      )}
      <ol className="np-progress">
        {["Agreement", "Funded", "PR review", "Auto release", "Paid"].map(
          (name, i) => (
            <li className={i <= stage ? "active" : ""} key={name}>
              <span>
                {i < stage ? (
                  <Icon name="check" size={13} />
                ) : (
                  String(i + 1).padStart(2, "0")
                )}
              </span>
              {name}
            </li>
          ),
        )}
      </ol>
      <div className="np-detail-layout">
        <div className="np-detail-main">
          <section className="np-panel np-detail-section">
            <span className="np-eyebrow">THE BRIEF</span>
            <h2>Task brief</h2>
            <p className="np-prose">{b.description}</p>
            <div className="np-rule" />
            <h3>Acceptance criteria</h3>
            <ul className="np-criteria-list">
              {b.criteria.map((c, i) => (
                <li key={i}>
                  <span>
                    <Icon name="check" size={14} />
                  </span>
                  {c}
                </li>
              ))}
            </ul>
            <div className="np-detail-info">
              <div>
                <Icon name="code" size={17} />
                <span>
                  Required check<strong>{b.checkName}</strong>
                </span>
              </div>
              <div>
                <Icon name="branch" size={17} />
                <span>
                  Target branch<strong>{b.branch}</strong>
                </span>
              </div>
              <div>
                <Icon name="git" size={17} />
                <span>
                  Client merger<strong>@{b.owner} · {t?.policy.mergeMethod === "squash" && !t?.mergeMethodAmendment ? "squash only" : "any merge method"}</strong>
                </span>
              </div>
            </div>
            {b.issueUrl && (
              <a
                className="np-text-link"
                href={b.issueUrl}
                target="_blank"
                rel="noreferrer"
              >
                View GitHub issue #{b.issueNumber}
                <Icon name="up" size={16} />
              </a>
            )}
          </section>
          <section className="np-panel np-detail-section">
            <div className="np-section-title">
              <div>
                <span className="np-eyebrow">THE CONTRIBUTION</span>
                <h2>
                  {t?.prNumber
                    ? `Pull request #${t.prNumber}`
                    : "Pull request"}
                </h2>
              </div>
              <span className="np-round-icon">
                <Icon name="branch" size={23} />
              </span>
            </div>
            {t?.prNumber ? (
              <>
                <div className="np-verification-list">
                  <div>
                    <span>
                      <Icon
                        name={t.evidence?.merged ? "check" : "clock"}
                        size={17}
                      />
                    </span>
                    <p>
                      Client merge
                      <strong>
                        {t.evidence?.merged
                          ? "Merged · checked against the agreed policy"
                          : "Waiting for the client to merge"}
                      </strong>
                    </p>
                    <span className="np-subtle">
                      {t.evidence?.merged ? "Recorded" : "Pending"}
                    </span>
                  </div>
                  {t.policy.checks.map((c) => {
                    const check = t.evidence?.checks.find(
                      (x) => x.name === c.name && x.appId === c.appId,
                    );
                    return (
                      <div key={c.name}>
                        <span>
                          <Icon
                            name={
                              check?.conclusion === "success"
                                ? "check"
                                : "clock"
                            }
                            size={17}
                          />
                        </span>
                        <p>
                          {c.name}
                          <strong>
                            {check?.conclusion === "success"
                              ? "Passed on the submitted commit"
                              : (check?.conclusion ??
                                "Waiting for GitHub evidence")}
                          </strong>
                        </p>
                        <span className="np-subtle">
                          {check?.conclusion ?? "Pending"}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {t.verdict?.reasons.map((reason) => (
                  <div
                    className={
                      t.verdict?.status === "blocked" ? "np-alert" : "np-info"
                    }
                    key={reason}
                  >
                    {reason}
                  </div>
                ))}
                <div className="np-action-row">
                  <Button
                    href={`https://github.com/${b.repository}/pull/${t.prNumber}`}
                    secondary
                  >
                    Review on GitHub
                    <Icon name="up" size={16} />
                  </Button>
                  {(client || developer) && !paid && (
                    <button
                      className="np-link-button"
                      disabled={Boolean(busy)}
                      onClick={() => action("refresh")}
                    >
                      Refresh checks
                      <Icon name="clock" size={15} />
                    </button>
                  )}
                </div>
                {client && !t.evidence?.merged && (
                  <div className="np-info">
                    <Icon name="git" size={18} />
                    <p>
                      Sign in to GitHub as <strong>{b.owner}</strong> and choose{" "}
                      <strong>{t.policy.mergeMethod === "squash" && !t.mergeMethodAmendment ? "Squash and merge" : "any merge method"}</strong>. The developer must not
                      merge their own PR.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="np-muted">
                  {t?.policy.developerId
                    ? `@${t.policy.developerLogin} is working on this bounty. NearPortal will pick up their PR when it includes the identifier below.`
                    : "A developer claims the funded bounty and includes this identifier in the pull request description. We’ll track it automatically."}
                </p>
                <div className="np-code-copy">
                  <code>{marker}</code>
                  <button
                    aria-label="Copy pull request identifier"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(marker);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      } catch {
                        setError(
                          "Copy the identifier shown above into your PR body.",
                        );
                      }
                    }}
                  >
                    <Icon name={copied ? "check" : "copy"} size={17} />
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <small className="np-form-hint">
                  Put this exact line on its own in the PR body. Discovery runs
                  in the background, even when you close this page.
                </small>
                {developer && b.preparedPrUrl && (
                  <div className="np-info">
                    <div>
                      <p>
                        This walkthrough includes a prepared change. Prepare a
                        public fork under @{t?.policy.developerLogin}; we reuse
                        an existing matching fork and add the exact prepared
                        branch. No repository invitation is needed.
                      </p>
                      {preparedUrl ? (
                        <Button href={preparedUrl}>
                          Submit prepared PR on GitHub{" "}
                          <Icon name="up" size={16} />
                        </Button>
                      ) : (
                        <Button
                          disabled={Boolean(busy)}
                          onClick={async () => {
                            setBusy("prepare-judge-pr");
                            setError("");
                            try {
                              const result = await api<{
                                url?: string;
                                message?: string;
                              }>(`/bounties/${id}/prepare-judge-pr`, {});
                              if (result.url) {
                                setPreparedUrl(result.url);
                                setForkNotice(
                                  "Your fork is ready. Submit the prefilled PR as your connected GitHub account.",
                                );
                              } else
                                setForkNotice(
                                  result.message ??
                                    "GitHub is preparing your fork. Check again shortly.",
                                );
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              setBusy("");
                            }
                          }}
                        >
                          {forkNotice
                            ? "Check prepared fork"
                            : "Prepare my GitHub fork"}
                        </Button>
                      )}
                      {forkNotice && <p role="status">{forkNotice}</p>}
                      {b.judgeAutoMerge && (
                        <p>
                          The demo client will squash-merge this exact prepared
                          commit after the agreed checks pass. Payment then
                          follows automatically.
                        </p>
                      )}
                    </div>
                  </div>
                )}
                {developer && (
                  <>
                    <div className="np-rule" />
                    <h3>Already opened your PR?</h3>
                    <div className="np-inline-form">
                      <input
                        type="number"
                        min="1"
                        aria-label="Pull request number"
                        placeholder="PR number"
                        value={pr}
                        onChange={(e) => setPr(e.target.value)}
                      />
                      <Button
                        secondary
                        disabled={Boolean(busy) || !pr}
                        onClick={() => action("pr", { number: Number(pr) })}
                      >
                        Find submission
                        <Icon name="arrow" size={15} />
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </section>
          <section className="np-panel np-detail-section">
            <span className="np-eyebrow">THE VERIFIABLE AGREEMENT</span>
            <h2>Release conditions</h2>
            <p className="np-muted">
              The reward, criteria, workflow, and protected test files are fixed
              before funding. Claiming binds one GitHub contributor and their
              payout destination.
            </p>
            <details className="np-policy">
              <summary>
                View policy & verification evidence
                <Icon name="code" size={16} />
              </summary>
              <dl>
                <div>
                  <dt>Funding mandate</dt>
                  <dd>
                    {t?.fundingPolicyHash ??
                      t?.policyHash ??
                      "Created when you publish"}
                  </dd>
                </div>
                <div>
                  <dt>Current assignment</dt>
                  <dd>{t?.policyHash ?? "Not assigned"}</dd>
                </div>
                <div>
                  <dt>Verifier</dt>
                  <dd>{t?.policy.verifier ?? "Assigned on publishing"}</dd>
                </div>
                <div>
                  <dt>Escrow job</dt>
                  <dd>
                    {t?.jobId === null || t?.jobId === undefined
                      ? "Not yet provisioned"
                      : `NEAR testnet · #${t.jobId}`}
                  </dd>
                </div>
                <div>
                  <dt>Protected files</dt>
                  <dd>
                    {[b.workflowPath, ...b.protectedPaths.split("\n")].join(
                      "\n",
                    )}
                  </dd>
                </div>
                {t?.verdict && (
                  <div>
                    <dt>Evidence hash</dt>
                    <dd>{t.verdict.evidenceHash}</dd>
                  </div>
                )}
              </dl>
            </details>
          </section>
        </div>
        <aside className="np-detail-aside">
          {client && b.private && (
            <section className="np-panel np-detail-section">
              <span className="np-eyebrow">REPOSITORY ACCESS</span>
              <h3>Repository access</h3>
              <p className="np-muted">
                Your bounty is public. Requests use verified GitHub identities,
                so developers don’t need to share an email address. Inviting
                grants Write access to {b.repository}; the developer must accept
                on GitHub.
              </p>
              {!b.accessRequests.length && (
                <p className="np-muted">No access requests yet.</p>
              )}
              {b.accessRequests.map((request) => (
                <div className="np-access-request" key={request.userId}>
                  <strong>@{request.login}</strong>
                  {request.status === "accepted" ? (
                    <small>Access unlocked · verified on GitHub</small>
                  ) : request.status === "invited" ? (
                    <small>Invitation sent · awaiting GitHub acceptance</small>
                  ) : (
                    <Button
                      secondary
                      disabled={Boolean(busy)}
                      onClick={() =>
                        action("invite", {
                          userId: request.userId,
                          permission: "push",
                        })
                      }
                    >
                      Invite with Write access
                    </Button>
                  )}
                </div>
              ))}
            </section>
          )}
          <section className={`np-reward-card ${paid ? "np-reward-paid" : ""}`}>
            <span className="np-eyebrow">
              <Icon
                name={paid ? "check" : t?.funded ? "shield" : "wallet"}
                size={16}
              />
              {paid
                ? "PAYMENT COMPLETE"
                : t?.funded
                  ? "THE REWARD IS SECURED"
                  : "FUND THE PROMISE"}
            </span>
            <strong>{money(b.amountCents,b.paymentRail)}</strong>
            <p>
              {paid
                ? "Monerium confirmed the sandbox payout. Good work, followed through."
                : t?.payment.state !== "NotRequested" && t
                  ? "The agreed conditions passed. Following the payment through NEAR and Monerium."
                  : t?.funded
                    ? "Locked for this task. It releases after the agreed checks and the client’s qualifying merge."
                    : "Contributors see a funded badge only once the escrow confirms your deposit."}
            </p>
            {client && b.status === "Draft" && (
              <>
                <label className="np-consent">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  <span>
                    I authorize this open bounty’s public brief, fixed criteria,
                    first eligible developer assignment, and automatic payout
                    after my qualifying merge.
                  </span>
                </label>
                <Button
                  disabled={
                    Boolean(busy) || !consent || (b.paymentRail === "base-usdc" ? me?.cryptoPaymentsReady : me?.openBountyReady) === false
                  }
                  onClick={() => action("publish", { revision: b.revision })}
                >
                  {busy ? "Submitting…" : "Publish & set up escrow"}
                  <Icon name="arrow" size={17} />
                </Button>
                <small>
                  A background job provisions escrow. No synchronous payment
                  request.
                </small>
                {(b.paymentRail === "base-usdc" ? me?.cryptoPaymentsReady : me?.openBountyReady) === false && (
                  <div className="np-info">
                    The tested open-bounty extension is awaiting deployment
                    approval. Your draft is saved; no funding has started.
                  </div>
                )}
                <a
                  className="np-text-link"
                  href={`/app/new?draft=${b.id}`}
                  style={{ marginTop: 18, fontSize: 11 }}
                >
                  Edit this draft
                  <Icon name="code" size={14} />
                </a>
              </>
            )}
            {client && t && !t.funded && (
              <>
                {me?.mode === "simulation" ? (
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() => action("simulate-fund")}
                  >
                    Fund simulated escrow
                  </Button>
                ) : (
                  <>
                    <Button
                      disabled={Boolean(busy)}
                      onClick={async () => {
                        setBusy("deposit");
                        try {
                          setDeposit(await api(`/bounties/${id}/deposit`));
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy("");
                        }
                      }}
                    >
                      Show funding instructions
                      <Icon name="arrow" size={16} />
                    </Button>
                    {deposit && (
                      <div className="np-deposit">
                        <span>CLIENT DEPOSIT IBAN</span>
                        <code>
                          {deposit.iban ?? "Linking your escrow address…"}
                        </code>
                        <p>
                          Reference: <strong>{deposit.reference}</strong>
                        </p>
                        {deposit.iban ? (
                          <small>
                            In your client’s Monerium sandbox Receive page,
                            confirm this IBAN and simulate exactly{" "}
                            {money(b.amountCents,b.paymentRail)}.
                          </small>
                        ) : (
                          <small>
                            We refresh these instructions automatically. Wait
                            before funding.
                          </small>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
            {b.status === "Preparing" && (
              <div className="np-provisioning">
                <span className="np-spinner" />
                Preparing your dedicated escrow…
              </div>
            )}
            {b.canClaim &&
              (me?.payout ? (
                <>
                  <label className="np-consent">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <span>
                      I accept the fixed criteria and payout to {me.payout.iban}
                      . My GitHub PR must pass the checks and be merged
                      by @{b.owner}.
                    </span>
                  </label>
                  <Button
                    disabled={Boolean(busy) || !consent}
                    onClick={() =>
                      action("claim", {
                        policyHash: t?.policyHash,
                        payoutVersion: me?.payout?.version,
                      })
                    }
                  >
                    Claim this bounty
                    <Icon name="arrow" size={17} />
                  </Button>
                </>
              ) : (
                <Button href="/app/settings?payout=1">
                  Add payout details to claim
                  <Icon name="arrow" size={17} />
                </Button>
              ))}
            {!me?.user && t?.funded && !t.policy.developerId && (
              <Button href="/login">
                {b.private
                  ? "Connect GitHub to request access"
                  : "Connect GitHub to claim"}
                <Icon name="git" size={17} />
              </Button>
            )}
            {me?.user &&
              b.role === "visitor" &&
              t?.funded &&
              !t.policy.developerId &&
              !b.repositoryAccess && (
                <div className="np-access-gate">
                  <h3>
                    <Icon name="lock" size={18} /> Private repository · Invite
                    only
                  </h3>
                  <p>
                    The {money(b.amountCents,b.paymentRail)} reward is secured. Repository
                    access unlocks claiming and working on this task.
                  </p>
                  {!b.accessRequest ? (
                    <>
                      <p>
                        Send @{b.owner} a request using your signed-in GitHub
                        username, @{me.user.login}. No email needed.
                      </p>
                      <Button
                        secondary
                        disabled={Boolean(busy)}
                        onClick={() => action("request-access")}
                      >
                        Request repository access
                      </Button>
                    </>
                  ) : (
                    <>
                      <strong>
                        {b.accessRequest.status === "invited"
                          ? "GitHub invitation sent"
                          : "Access request sent"}
                      </strong>
                      <p>
                        {b.accessRequest.status === "invited"
                          ? "Accept the invitation on GitHub, then check access here to unlock this bounty."
                          : `Waiting for @${b.owner} to invite @${me.user.login}. If an invitation arrives, accept it on GitHub.`}
                      </p>
                      <Button
                        href={`https://github.com/${b.repository}/invitations`}
                        secondary
                      >
                        Open GitHub invitations
                      </Button>
                    </>
                  )}
                  <Button
                    secondary
                    disabled={Boolean(busy)}
                    onClick={() => action("check-access")}
                  >
                    I accepted · Check access
                  </Button>
                </div>
              )}
            {t?.policy.developerId !== 0 &&
              t?.policy.developerId !== undefined && (
                <div className="np-assigned">
                  <span>CONTRIBUTOR</span>
                  <strong>@{t.policy.developerLogin}</strong>
                  <small>{t.policy.recipient}</small>
                </div>
              )}
            {paid && (
              <div className="np-deposit">
                <span>PAYMENT RECEIPT</span>
                <code>{t?.payment.reference}</code>
                <small>Processed by Monerium · recorded on NEAR</small>
              </div>
            )}
            {client && t?.overpayment && t.overpayment.recordedCents > 0 && (
              <div className="np-surplus-receipt">
                <strong>Surplus refund</strong>
                {t.overpayment.refunds.length ? t.overpayment.refunds.map(refund => (
                  <div key={refund.reference}>
                    <p>{money(refund.amountCents)} · {refund.state === "Processed" ? "Returned to your refund account" : refund.state === "NeedsAttention" || refund.state === "SignFailed" ? "Needs attention" : "Refund processing"}</p>
                    <small>{refund.reference}</small>
                  </div>
                )) : <p>Existing excess deposit awaiting reconciliation.</p>}
              </div>
            )}
          </section>
          {(client || developer) &&
            t?.funded &&
            t.payment.state === "NotRequested" &&
            !t.disputed && (
              <button
                className="np-dispute-button"
                disabled={Boolean(busy)}
                onClick={() => {
                  if (
                    confirm(
                      "Pause automatic release and open a dispute for mediator review?",
                    )
                  )
                    void action("dispute");
                }}
              >
                Report an issue & pause release
              </button>
            )}
          {t?.disputed && (
            <div className="np-alert">
              A dispute blocks automatic payment. Mediator review is required.
            </div>
          )}
          <section className="np-panel np-activity">
            <span className="np-eyebrow">THE PAPER TRAIL</span>
            <h3>Activity</h3>
            <ol>
              {[
                ...(t?.timeline ?? [
                  { at: b.createdAt, message: "Bounty draft created." },
                ]),
              ]
                .reverse()
                .map((event, i) => (
                  <li key={`${event.at}-${i}`}>
                    <span className={i === 0 ? "latest" : ""} />
                    <div>
                      <p>{event.message}</p>
                      <time>
                        {new Date(event.at).toLocaleString(undefined, {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                  </li>
                ))}
            </ol>
          </section>
        </aside>
      </div>
    </>
  );
}
// ---- Shared workspace system (canonical source: apps/site; synced into ./workspace) ----
function UIcon({ name }: { name: string }) {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: iconPath(name) }}
    />
  );
}
function WorkspaceHeader({ me, path, role }: { me: Me | null; path: string; role?: string }) {
  const host = useRef<HTMLElement>(null),
    shell = useRef<ShellController | null>(null);
  useEffect(() => {
    if (!host.current) return;
    shell.current = mountShell(host.current, { path, role, brandSrc: "/brand/guide.png" });
    return () => shell.current?.destroy();
  }, [path]);
  useEffect(() => shell.current?.setMe(me), [me]);
  useEffect(() => shell.current?.setActive(path, role), [path, role]);
  return <header ref={host} />;
}
function Workspace({
  me,
  path,
  role,
  narrow = false,
  children,
}: {
  me: Me | null;
  path: string;
  role?: string;
  narrow?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="ui-app">
      <a className="ui-skip" href="#workspace-main">
        Skip to content
      </a>
      <WorkspaceHeader me={me} path={path} role={role} />
      <main className={`ui-page${narrow ? " ui-page-narrow" : ""}`} id="workspace-main">
        {children}
      </main>
    </div>
  );
}
function PageHead({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className="ui-page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="ui-page-sub">{sub}</p>}
      </div>
      {action && <div className="ui-page-actions">{action}</div>}
    </div>
  );
}
function UIStatus({ b, me }: { b: Bounty; me: Me | null }) {
  const s = bountyStatus(b, { capabilities: me?.bountyModeCapabilities });
  return (
    <span className={`ui-status ui-status-${s.tone}`}>
      <UIcon name={s.icon} />
      {s.label}
    </span>
  );
}
function NextAction({ b, role, me }: { b: Bounty; role: Role; me: Me | null }) {
  const a = nextAction(b, role, { capabilities: me?.bountyModeCapabilities });
  return (
    <a
      className="ui-link"
      href={a.href}
      aria-label={`${a.label}: ${b.title}${a.external ? " (opens GitHub)" : ""}`}
      {...(a.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {a.label}
      <UIcon name={a.external ? "external" : "arrow"} />
    </a>
  );
}
function Notice({ kind = "notice", icon, children }: { kind?: "notice" | "alert" | "success"; icon?: string; children: ReactNode }) {
  return (
    <div className={`ui-${kind}`} role={kind === "alert" ? "alert" : kind === "success" ? "status" : undefined}>
      <UIcon name={icon ?? (kind === "alert" ? "alert" : kind === "success" ? "check" : "info")} />
      <div>{children}</div>
    </div>
  );
}
function UIEmpty({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="ui-empty">
      <p>{text}</p>
      {action}
    </div>
  );
}
function Loading({ label }: { label: string }) {
  return (
    <div className="ui-loading-row" aria-label={label} role="status">
      <div className="ui-skeleton" />
      <div className="ui-skeleton" />
      <div className="ui-skeleton" />
      <div className="ui-skeleton" />
    </div>
  );
}
function WorkTable({ items, role, me, caption }: { items: Bounty[]; role: Role; me: Me | null; caption: string }) {
  return (
    <div className="ui-table-wrap">
      <table className="ui-table">
        <caption className="ui-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Bounty</th>
            <th scope="col">Reward</th>
            <th scope="col">Status</th>
            <th scope="col">Next step</th>
          </tr>
        </thead>
        <tbody>
          {items.map((b) => {
            const s = bountyStatus(b, { capabilities: me?.bountyModeCapabilities });
            return (
              <tr key={b.id}>
                <td>
                  <a className="ui-table-title" href={`/bounties/${b.id}`}>
                    {b.title}
                  </a>
                  <span className="ui-table-sub">
                    {[b.repository, b.private ? "Private" : "", s.detail].filter(Boolean).join(" · ")}
                  </span>
                  <span className="ui-table-mobile">
                    <span className="ui-amount">{money(b.amountCents,b.paymentRail)}</span>
                    <UIStatus b={b} me={me} />
                  </span>
                </td>
                <td>
                  <span className="ui-amount">{money(b.amountCents,b.paymentRail)}</span>
                </td>
                <td>
                  <UIStatus b={b} me={me} />
                </td>
                <td>
                  <NextAction b={b} role={role} me={me} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function Summary({ items, role, me }: { items: Bounty[]; role: Role; me: Me | null }) {
  const parts = summary(items, role, { capabilities: me?.bountyModeCapabilities });
  return parts.length ? (
    <ul className="ui-summary" aria-label="Summary">
      {parts.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  ) : null;
}

/** /app overview, and the React fallback for /app/bounties and /app/work (the landing serves the board). */
function Overview({ me, items, loading, path }: { me: Me; items: Bounty[]; loading: boolean; path: string }) {
  const mine = scopeBounties(items, me.user, "client"),
    work = scopeBounties(items, me.user, "developer");
  const only = path === "/app/bounties" ? "client" : path === "/app/work" ? "developer" : null;
  const sections = (
    [
      { role: "client" as const, title: "My bounties", href: "/app/bounties", list: filterBounties(mine), empty: "No bounties yet.", action: ["New bounty", "/app/new", "plus"] },
      { role: "developer" as const, title: "Contributions", href: "/app/work", list: filterBounties(work), empty: "No contributions yet.", action: ["Find a bounty", "/bounties", "search"] },
    ] as const
  ).filter((s) => !only || s.role === only);
  const pageTitle = only === "client" ? "My bounties" : only === "developer" ? "Contributions" : "Overview";
  const primary = only === "developer" ? (["Find a bounty", "/bounties", "search"] as const) : (["New bounty", "/app/new", "plus"] as const);
  return (
    <>
      <PageHead
        title={pageTitle}
        action={
          <a className="ui-button" href={primary[1]}>
            <UIcon name={primary[2]} />
            {primary[0]}
          </a>
        }
      />
      {loading ? (
        <Loading label="Loading bounties" />
      ) : (
        sections.map((s) => (
          <section key={s.role} className="overview-section" aria-labelledby={`overview-${s.role}`}>
            {!only && (
              <div className="ui-panel-head">
                <h2 id={`overview-${s.role}`}>{s.title}</h2>
                {s.list.length > 0 && (
                  <a className="ui-link" href={s.href}>
                    Open {s.title.toLowerCase()}
                    <UIcon name="arrow" />
                  </a>
                )}
              </div>
            )}
            {only && <h2 id={`overview-${s.role}`} className="ui-visually-hidden">{s.title}</h2>}
            <Summary items={s.list} role={s.role} me={me} />
            {s.list.length ? (
              <WorkTable items={only ? s.list : s.list.slice(0, 5)} role={s.role} me={me} caption={s.title} />
            ) : (
              <UIEmpty
                text={s.empty}
                action={
                  <a className="ui-button ui-button-secondary" href={s.action[1]}>
                    <UIcon name={s.action[2]} />
                    {s.action[0]}
                  </a>
                }
              />
            )}
          </section>
        ))
      )}
      <p className="ui-footer">
        <span>Sandbox · NEAR testnet · Monerium sandbox · no real funds</span>
      </p>
    </>
  );
}

function Repositories() {
  const [repos, setRepos] = useState<Repo[]>([]),
    [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [page, setPage] = useState<number | null>(1);
  async function load(n = 1) {
    setLoading(true);
    try {
      const r = await api<{ repositories: Repo[]; nextPage: number | null }>(`/repositories?page=${n}`);
      setRepos((old) => (n === 1 ? r.repositories : [...old, ...r.repositories]));
      setPage(r.nextPage);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const shown = repos.filter((r) => `${r.fullName} ${r.description}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <PageHead title="Repositories" sub="Repositories your GitHub connection can access." />
      {repos.length > 0 && (
        <div className="ui-toolbar">
          <div className="ui-search">
            <UIcon name="search" />
            <label className="ui-visually-hidden" htmlFor="repo-search">
              Find a repository
            </label>
            <input id="repo-search" type="search" placeholder="Find a repository" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="ui-tag">
            {repos.length}
            {page ? "+" : ""} repositories
          </span>
        </div>
      )}
      {error && <Notice kind="alert">{error}</Notice>}
      <div className="ui-cards-grid">
        {shown.map((r) => (
          <article className="ui-card" key={r.id}>
            <div className="ui-card-repo">
              <UIcon name="github" />
              <span>{r.fullName.split("/")[0]}</span>
              {r.private && (
                <span className="ui-private">
                  <UIcon name="lock" />
                  Private
                </span>
              )}
            </div>
            <h2 className="ui-card-title">{r.name}</h2>
            {r.description && <p className="ui-card-desc">{r.description}</p>}
            <p className="ui-card-meta">{[r.language, r.defaultBranch].filter(Boolean).join(" · ")}</p>
            {r.canWrite ? (
              <a className="ui-link ui-card-action" href={`/app/new?repository=${encodeURIComponent(r.fullName)}`}>
                New bounty
                <UIcon name="plus" />
              </a>
            ) : (
              <a className="ui-link ui-card-action" href={r.url} target="_blank" rel="noreferrer" aria-label={`View ${r.fullName} on GitHub (read access only)`}>
                View on GitHub · read access
                <UIcon name="external" />
              </a>
            )}
          </article>
        ))}
      </div>
      {loading && <Loading label="Loading repositories" />}
      {!loading && page && (
        <p className="ui-center">
          <button className="ui-button ui-button-secondary" type="button" onClick={() => load(page)}>
            Load more repositories
          </button>
        </p>
      )}
      {!loading && !shown.length && !error && (
        <UIEmpty text={repos.length ? "No repositories found." : "No repositories connected."} />
      )}
    </>
  );
}

// Explore filters are statuses from the shared model; sealed-bid filters exist only when the backend enables them.
const EXPLORE_KEYS: StatusKey[] = ["available", "inProgress", "inReview", "paymentProcessing", "paid", "attention"];
const SEALED_BID_KEYS: StatusKey[] = ["bidding", "awaitingConfirmation"];
type ExplorePage = { bounties: Bounty[]; page?: number; pages?: number; total?: number; counts?: Record<StatusKey, number> };
/** Explore is filtered, searched and paginated on the server; it refreshes in the background. */
function Explore({ me }: { me: Me | null }) {
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState<StatusKey | "all">("all"),
    [page, setPage] = useState(1),
    [data, setData] = useState<ExplorePage | null>(null),
    [error, setError] = useState("");
  const options = { capabilities: me?.bountyModeCapabilities };
  const keys = me?.bountyModeCapabilities?.sealedBid === true ? [EXPLORE_KEYS[0]!, ...SEALED_BID_KEYS, ...EXPLORE_KEYS.slice(1)] : EXPLORE_KEYS;
  const active = filter === "all" || keys.includes(filter) ? filter : "all";
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(query.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ scope: "explore", limit: "48", page: String(page) });
    if (active !== "all") params.set("status", active);
    if (search) params.set("q", search);
    const load = () =>
      api<ExplorePage>(`/bounties?${params}`)
        .then((r) => { if (alive) { setData(r); setError(""); } return true; })
        .catch((e) => { if (alive) setError(e.message); return false; });
    void load();
    const poller = poll(load, { interval: 30000 });
    return () => { alive = false; poller.stop(); };
  }, [active, search, page]);
  const loading = !data && !error;
  // Older servers ignore the query and return every visible bounty without counts: filter locally.
  const legacy = Boolean(data && !data.counts);
  const base = !data ? [] : legacy ? filterBounties(data.bounties).filter((b) => b.published && `${b.title} ${b.repository} ${b.code}`.toLowerCase().includes(search.toLowerCase())) : filterBounties(data.bounties);
  const shown = legacy ? base.filter((b) => active === "all" || bountyStatus(b, options).key === active) : base;
  const local = (key: StatusKey) => base.filter((b) => bountyStatus(b, options).key === key).length;
  const count = (key: StatusKey | "all") => (!data ? 0 : key === "all" ? keys.reduce((n, k) => n + (data.counts?.[k] ?? local(k)), 0) : data.counts?.[key] ?? local(key));
  return (
    <>
      <PageHead title="Explore bounties" sub="Published bounties. “Funds secured” appears only after the escrow deposit is confirmed." />
      <div className="ui-toolbar">
        <div className="ui-segmented explore-filters" role="group" aria-label="Filter by status">
          {(["all", ...keys] as const).map((key) => (
            <button type="button" aria-pressed={active === key} onClick={() => setFilter(key)} key={key}>
              {key === "all" ? "All" : STATUSES[key].label}
              <span className="ui-count" aria-label={`${count(key)} bounties`}>{count(key)}</span>
            </button>
          ))}
        </div>
        <div className="ui-search">
          <UIcon name="search" />
          <label className="ui-visually-hidden" htmlFor="explore-search">
            Search bounties
          </label>
          <input id="explore-search" type="search" placeholder="Search by title or repository" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      {error && <Notice kind="alert">{error}</Notice>}
      {loading ? (
        <Loading label="Loading bounties" />
      ) : shown.length ? (
        <div className="ui-cards-grid">
          {shown.map((b) => {
            const s = bountyStatus(b, options);
            return (
              <article className="ui-card" key={b.id}>
                <div className="ui-card-top">
                  <UIStatus b={b} me={me} />
                  {b.private && (
                    <span className="ui-private" title="Private repository · invite required">
                      <UIcon name="lock" />
                      Private
                    </span>
                  )}
                </div>
                <div className="ui-card-repo">
                  <UIcon name="github" />
                  <span>{b.repository}</span>
                </div>
                <h2 className="ui-card-title" title={b.title}>
                  <a href={`/bounties/${b.id}`}>{b.title}</a>
                </h2>
                {s.detail && s.key !== "toFund" && <p className="ui-card-meta">{s.detail}</p>}
                <div className="ui-card-foot">
                  <span className="ui-amount">{money(b.amountCents,b.paymentRail)}</span>
                  <a className="ui-link ui-card-action" href={`/bounties/${b.id}`} aria-label={`View bounty: ${b.title}`}>
                    View bounty
                    <UIcon name="arrow" />
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <UIEmpty
          text="No bounties found."
          action={
            query || active !== "all" ? (
              <button className="ui-button ui-button-secondary" type="button" onClick={() => { setQuery(""); setFilter("all"); setPage(1); }}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      )}
      {data?.pages && data.page && data.pages > 1 && (
        <nav className="ui-toolbar explore-pages" aria-label="Pages">
          <button className="ui-button ui-button-secondary" type="button" disabled={data.page <= 1} onClick={() => setPage(data.page! - 1)}>Previous</button>
          <span className="ui-page-sub" aria-live="polite">Page {data.page} of {data.pages} · {data.total} bounties</span>
          <button className="ui-button ui-button-secondary" type="button" disabled={data.page >= data.pages} onClick={() => setPage(data.page! + 1)}>Next</button>
        </nav>
      )}
      <p className="ui-footer">
        <span>Sandbox · NEAR testnet · Monerium sandbox · no real funds</span>
      </p>
    </>
  );
}

function Login({ me, reload }: { me: Me | null; reload: () => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="login-panel">
      <div className="ui-panel">
        <h1 className="login-title">Sign in to NearPortal</h1>
        <p className="ui-page-sub">One GitHub account to fund bounties and contribute.</p>
        {error && <Notice kind="alert">{error}</Notice>}
        {me?.oauthConfigured ? (
          <a className="ui-button login-cta" href="/auth/github">
            <UIcon name="github" />
            Continue with GitHub
          </a>
        ) : (
          <Notice>GitHub sign-in is not configured on this server.</Notice>
        )}
        <ul className="login-list">
          <li>
            <UIcon name="repo" />
            Lists the repositories your GitHub connection can access.
          </li>
          <li>
            <UIcon name="code" />
            Creates the GitHub issue when you publish a funded bounty.
          </li>
          <li>
            <UIcon name="person" />
            Uses your own GitHub identity, never a shared account.
          </li>
        </ul>
        {me?.localPreview && (
          <details className="login-preview">
            <summary>Local development preview</summary>
            <p>Uses the GitHub account already connected to this computer. Available only on localhost.</p>
            <button
              className="ui-button ui-button-secondary"
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("/local-login", {});
                  reload();
                  location.assign("/app");
                } catch (e) {
                  setError((e as Error).message);
                  setBusy(false);
                }
              }}
            >
              {busy ? "Connecting…" : "Use connected local GitHub"}
            </button>
          </details>
        )}
        <p className="login-note">Sandbox payments only. OAuth credentials stay on the server. You can sign out at any time.</p>
      </div>
    </div>
  );
}

const SETTINGS_SECTIONS = [
  { name: "Profile", icon: "github" },
  { name: "Payout details", icon: "wallet" },
  { name: "Funding connection", icon: "lock" },
] as const;
function Settings({ me, reload }: { me: Me; reload: () => void }) {
  const [section, setSection] = useState(new URLSearchParams(location.search).has("payout") ? "Payout details" : "Profile"),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [busy, setBusy] = useState(false),
    [payout, setPayout] = useState({ firstName: "", lastName: "", iban: "", country: "" }),
    [bank, setBank] = useState({ clientId: "", clientSecret: "" });
  async function save(e: FormEvent, kind: string, value: unknown) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api(kind, value);
      setSuccess(
        kind === "/payout"
          ? "Bank details saved. Published bounties keep their agreed payout and refund destinations."
          : "Monerium sandbox connection verified and saved.",
      );
      setBank({ clientId: "", clientSecret: "" });
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const u = me.user!;
  return (
    <>
      <PageHead title="Settings" />
      <div className="ui-segmented settings-tabs" role="tablist" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map((s) => (
          <button
            type="button"
            role="tab"
            id={`tab-${s.icon}`}
            aria-selected={section === s.name}
            aria-controls="settings-panel"
            key={s.name}
            onClick={() => {
              setSection(s.name);
              setSuccess("");
              setError("");
            }}
          >
            <UIcon name={s.icon} />
            {s.name}
          </button>
        ))}
      </div>
      <section className="ui-panel" id="settings-panel" role="tabpanel" aria-labelledby={`tab-${SETTINGS_SECTIONS.find((s) => s.name === section)!.icon}`}>
        {error && <Notice kind="alert">{error}</Notice>}
        {success && (
          <Notice kind="success">
            {success}
            {new URLSearchParams(location.search).get("returnTo") === "/demo" && (
              <>
                {" "}
                <a className="ui-link" href="/demo">
                  Continue judge walkthrough
                </a>
              </>
            )}
          </Notice>
        )}
        {section === "Profile" ? (
          <>
            <div className="ui-panel-head">
              <div>
                <h2>GitHub account</h2>
                <p>One account funds work and contributes to other projects.</p>
              </div>
            </div>
            <div className="settings-profile">
              <img className="settings-avatar" src={u.avatar} alt="" width={48} height={48} />
              <div>
                <strong>{u.name || u.login}</strong>
                <span className="ui-tag">@{u.login}</span>
              </div>
              <span className="ui-status ui-status-secured">
                <UIcon name="check" />
                {u.local ? "Local CLI preview" : "Connected with GitHub OAuth"}
              </span>
            </div>
            <Notice icon="github">
              Repository permissions come from GitHub. A client account reviews and merges; a separate contributor account claims and submits.
            </Notice>
            <hr className="ui-divider" />
            <h3 className="ui-section-title">Switch accounts</h3>
            <p className="settings-copy">Sign out, then connect the other GitHub account. A client session is never used to act as a contributor.</p>
            <button
              className="ui-button ui-button-secondary"
              type="button"
              onClick={async () => {
                try {
                  await api("/auth/logout", {});
                  location.assign("/login");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <UIcon name="logout" />
              Sign out
            </button>
          </>
        ) : section === "Payout details" ? (
          <form onSubmit={(e) => save(e, "/payout", payout)}>
            <div className="ui-panel-head">
              <div>
                <h2>Payout details</h2>
                <p>Account holder and SEPA IBAN for bank rewards and creator refunds. Bank contributors do not need Monerium API keys.</p>
              </div>
            </div>
            {me.payout && (
              <Notice kind="success">
                Current destination: <strong>{me.payout.name} · {me.payout.iban}</strong>
              </Notice>
            )}
            <div className="ui-form-grid">
              {(
                [
                  ["firstName", "Account holder’s first name"],
                  ["lastName", "Account holder’s last name"],
                  ["iban", "Payout IBAN"],
                  ["country", "Account holder’s country code"],
                ] as const
              ).map(([key, label]) => (
                <label className="ui-field" key={key}>
                  {label}
                  <input
                    value={payout[key]}
                    maxLength={key === "country" ? 2 : key === "iban" ? 42 : 100}
                    placeholder={key === "country" ? "e.g. FR" : key === "iban" ? "Your sandbox recipient IBAN" : ""}
                    autoComplete={key === "iban" ? "off" : undefined}
                    onChange={(e) => setPayout((p) => ({ ...p, [key]: e.target.value }))}
                    required
                  />
                </label>
              ))}
            </div>
            <Notice icon="shield">
              These details receive your contributor rewards and refunds for bank bounties you create. Full bank details stay on the server; agreements show a masked IBAN. Published bounties keep their original destinations. Format checks do not verify account ownership.
            </Notice>
            <button className="ui-button" disabled={busy}>
              {busy ? "Saving…" : "Save payout details"}
            </button>
          </form>
        ) : (
          <form onSubmit={(e) => save(e, "/bank", bank)}>
            <div className="ui-panel-head">
              <div>
                <h2>Funding connection</h2>
                <p>For clients: a Monerium sandbox Private application provisions deposit instructions and tracks payments.</p>
              </div>
            </div>
            {me.bankConnected && (
              <Notice kind="success">
                Monerium sandbox connected · credentials kept server-side
              </Notice>
            )}
            <Notice icon="wallet">
              Deposits are confirmed asynchronously. This demo uses NEAR testnet and Monerium sandbox; no real euros move. Mainnet onboarding is a separate go-live step.
            </Notice>
            <label className="ui-field">
              Monerium sandbox Client ID
              <input value={bank.clientId} autoComplete="off" onChange={(e) => setBank({ ...bank, clientId: e.target.value })} required />
            </label>
            <label className="ui-field">
              Monerium sandbox Client secret
              <input type="password" autoComplete="new-password" value={bank.clientSecret} onChange={(e) => setBank({ ...bank, clientSecret: e.target.value })} required />
              <small>
                Create a Private application in{" "}
                <a className="ui-link" href="https://sandbox.monerium.dev/developers" target="_blank" rel="noreferrer">
                  Monerium sandbox → Developers
                </a>
                . Secrets are encrypted at rest and never returned to the browser.
              </small>
            </label>
            <button className="ui-button" disabled={busy}>
              {busy ? "Checking connection…" : "Verify and save connection"}
            </button>
          </form>
        )}
      </section>
    </>
  );
}

export function PortalApp() {
  const [me, setMe] = useState<Me | null>(null),
    [items, setItems] = useState<Bounty[]>([]),
    [loading, setLoading] = useState(true),
    [fatal, setFatal] = useState("");
  const path = location.pathname.replace(/\/$/, "") || "/";
  const refreshMe = () =>
    api<Me>("/me").then((m) => {
      csrf = m.csrf ?? "";
      setMe(m);
    });
  useEffect(() => {
    void refreshMe().catch((e) => setFatal(e.message));
    // Only the overview needs the user's list; Explore, Settings and Repositories load their own data.
    if (!/^\/app(?:\/(?:bounties|work))?$/.test(path)) {
      setLoading(false);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const [mine, work] = await Promise.all(["mine", "work"].map((scope) => api<{ bounties: Bounty[] }>(`/bounties?scope=${scope}&limit=100`)));
        if (active) { setItems([...mine!.bounties, ...work!.bounties]); setLoading(false); }
        return true;
      } catch (e) {
        if (active) { setFatal((e as Error).message); setLoading(false); }
        return false;
      }
    };
    void load();
    const poller = poll(load, { interval: 20000 });
    return () => {
      active = false;
      poller.stop();
    };
  }, []);
  if (path === "/")
    return (
      <div className="np-root">
        <Landing me={me} />
      </div>
    );
  if (path === "/login")
    return (
      <Workspace me={me} path={path} narrow>
        <Login me={me} reload={() => void refreshMe()} />
      </Workspace>
    );
  if (!me)
    return (
      <Workspace me={null} path={path}>
        {fatal ? <Notice kind="alert">{fatal}</Notice> : <Loading label="Loading workspace" />}
      </Workspace>
    );
  const bounty = /^\/bounties\/([a-f0-9-]+|NP-[A-F0-9]{10})$/.exec(path);
  // Legacy React views (the landing frontend serves /bounties/:id and /app/new); kept under the shared header.
  const legacy = bounty ? (
    <BountyPage id={bounty[1]!} me={me} />
  ) : path === "/demo" ? (
    <JudgeDemo
      user={me.user}
      hasPayout={Boolean(me.payout)}
      setupPayout={async () => {
        await api("/judge-payout", {});
        await refreshMe();
      }}
    />
  ) : me.user && path === "/app/new" ? (
    <NewBounty />
  ) : null;
  if (legacy)
    return (
      <div className="ui-app">
        <WorkspaceHeader me={me} path={path} />
        <div className="np-root np-legacy">
          <div className="np-app-body">
            {fatal && <div className="np-alert">{fatal}</div>}
            {legacy}
          </div>
        </div>
      </div>
    );
  const content =
    path === "/bounties" ? (
      <Explore me={me} />
    ) : !me.user ? (
      <Login me={me} reload={() => void refreshMe()} />
    ) : path === "/app/repositories" ? (
      <Repositories />
    ) : path === "/app/settings" ? (
      <Settings me={me} reload={() => void refreshMe()} />
    ) : (
      <Overview me={me} items={items} loading={loading} path={path} />
    );
  return (
    <Workspace me={me} path={path} narrow={path === "/app/settings" || (!me.user && path !== "/bounties")}>
      {fatal && <Notice kind="alert">{fatal}</Notice>}
      {content}
    </Workspace>
  );
}
