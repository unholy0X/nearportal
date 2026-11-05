import { useEffect, useState } from "react";
import type { PortalService } from "../server/portal/service.ts";
import type { Identity } from "../server/portal/store.ts";
type Bounty = ReturnType<PortalService["public"]>;
interface Demo {
  enabled: boolean;
  autoMerge: boolean;
  bounties: Bounty[];
  proof: Bounty | null;
  demoRecipient: string | null;
}
export function JudgeDemo({
  user,
  hasPayout,
  setupPayout,
}: {
  user: Identity | null;
  hasPayout: boolean;
  setupPayout: () => Promise<void>;
}) {
  const [demo, setDemo] = useState<Demo | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const poll = () =>
      fetch("/api/portal/judge-demo")
        .then(async (r) => {
          if (!r.ok) throw Error("Demo status is temporarily unavailable");
          return r.json() as Promise<Demo>;
        })
        .then((d) => {
          if (active) {
            setDemo(d);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const mine = demo?.bounties.find(
    (b) =>
      user && b.task?.policy.developerId === user.id && b.status !== "Paid",
  );
  const paid = demo?.bounties.find(
    (b) =>
      user && b.task?.policy.developerId === user.id && b.status === "Paid",
  );
  const available =
    demo?.bounties.filter(
      (b) =>
        b.status === "Open" &&
        b.task?.funded &&
        !b.task.policy.developerId &&
        b.ownerId !== user?.id,
    ) ?? [];
  return (
    <div className="np-judge-demo">
      <div className="np-page-heading">
        <div>
          <span className="np-eyebrow">
            JUDGE QUICKSTART · NEAR TESTNET + MONERIUM SANDBOX
          </span>
          <h1>
            Try the promise.
            <br />
            Follow the payment.
          </h1>
          <p>
            Start with a funded task. Claim it, submit a prepared GitHub change,
            and watch verification turn a qualifying merge into a payout.
          </p>
        </div>
      </div>
      <div className="np-info">
        <p>
          <strong>No real money or personal bank account needed.</strong> This
          walkthrough uses test funds and a prepared code change. It exercises
          real GitHub, NEAR testnet, Chain Signatures and Monerium sandbox—not
          simulated success screens.
        </p>
      </div>
      {error && <div className="np-alert">{error}</div>}
      <div className="np-judge-grid">
        <section className="np-panel np-detail-section">
          <span className="np-eyebrow">01 · CONNECT</span>
          <h2>Your GitHub. Your contribution.</h2>
          <p>
            Use your own GitHub account. Each participant claims a separate
            funded task; no shared password or private repository invitation is
            required.
          </p>
          {user ? (
            <strong className="np-invite-badge">
              Connected as @{user.login}
            </strong>
          ) : (
            <a className="np-button" href="/auth/github?returnTo=%2Fdemo">
              Connect GitHub
            </a>
          )}
        </section>
        <section className="np-panel np-detail-section">
          <span className="np-eyebrow">02 · CHOOSE A RECEIVER</span>
          <h2>A sandbox destination.</h2>
          <p>
            Test funds can go to the supplied demo receiving account. Your bank
            details are optional, and an existing payout profile is preserved.
          </p>
          {hasPayout ? (
            <strong className="np-invite-badge">Payout profile ready</strong>
          ) : demo?.enabled && demo.demoRecipient ? (
            <>
              <small>
                Test reward destination: {demo.demoRecipient}. Funds go to this
                demo account.
              </small>
              <button
                className="np-button"
                disabled={!user || busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await setupPayout();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Saving…" : "Use sandbox demo recipient"}
              </button>
            </>
          ) : (
            <a
              className="np-button np-secondary"
              href="/app/settings?payout=1&returnTo=%2Fdemo"
            >
              Add payout details
            </a>
          )}
        </section>
        <section className="np-panel np-detail-section">
          <span className="np-eyebrow">03 · CLAIM & SUBMIT</span>
          <h2>Code is ready to review.</h2>
          <p>
            Claim a funded task, accept its fixed criteria, prepare your public
            GitHub fork, then use its “Submit prepared PR” button. GitHub opens
            with the correct branch and task identifier filled in. Submit as
            your connected account.
          </p>
          {mine ? (
            <a className="np-button" href={`/bounties/${mine.id}`}>
              Continue your claimed task
            </a>
          ) : paid ? (
            <a className="np-button" href={`/bounties/${paid.id}`}>
              Your payment receipt
            </a>
          ) : (
            <a className="np-button np-secondary" href="#judge-tasks">
              Choose a funded task below
            </a>
          )}
        </section>
      </div>
      <section className="np-panel np-detail-section">
        <span className="np-eyebrow">04 · VERIFY → MERGE → PAY</span>
        <h2>The result has a receipt.</h2>
        <p>
          {demo?.autoMerge
            ? "The demo client automatically squash-merges only the exact prepared commit after all agreed checks pass. This permission is limited to the configured public sandbox tasks."
            : "The client reviews and merges after the acceptance checks pass. Automatic payment follows that qualifying merge."}{" "}
          The background worker continues after you close the page. GitHub CI
          and payment-provider processing can take several minutes.
        </p>
      </section>
      <section id="judge-tasks">
        <div className="np-section-heading">
          <div>
            <h2>Funded judge tasks</h2>
            <p>
              Rewards appear here only after escrow funding is confirmed. Each
              task can be claimed once.
            </p>
          </div>
        </div>
        {!demo ? (
          <div className="np-loading">Checking the task pool…</div>
        ) : !demo.enabled ? (
          <div className="np-panel np-detail-section">
            <h3>The live judge pool is being prepared.</h3>
            <p>
              The verified completed rehearsal is available below. Public judge
              tasks will appear here after the operator provisions and funds
              them.
            </p>
          </div>
        ) : !available.length && !mine ? (
          <div className="np-panel np-detail-section">
            <h3>All funded tasks are currently claimed.</h3>
            <p>
              Open the completed receipt below while the operator replenishes
              the pool. No unfunded task is presented as ready.
            </p>
          </div>
        ) : (
          <div className="np-judge-grid">
            {available.map((b) => (
              <a
                className="np-panel np-detail-section"
                href={`/bounties/${b.id}`}
                key={b.id}
              >
                <span className="np-invite-badge">
                  Escrow funded · €{(b.amountCents / 100).toFixed(2)}
                </span>
                <h3>{b.title}</h3>
                <p>{b.repository} · Public demo repository</p>
                <strong>Open task and claim →</strong>
              </a>
            ))}
            {mine && (
              <a
                className="np-panel np-detail-section"
                href={`/bounties/${mine.id}`}
              >
                <h3>Your task is {mine.status.toLowerCase()}</h3>
                <strong>Follow your contribution →</strong>
              </a>
            )}
          </div>
        )}
      </section>
      {demo?.proof && (
        <section className="np-panel np-detail-section">
          <span className="np-eyebrow">COMPLETED LIVE REHEARSAL</span>
          <h2>Funded before claim. Paid after merge.</h2>
          <p>
            A separate GitHub contributor claimed this funded task and submitted
            its PR. The client merged, verification passed, and Monerium
            confirmed the sandbox payout. The escrow closed on NEAR.
          </p>
          <a className="np-button" href={`/bounties/${demo.proof.id}`}>
            Inspect the €{(demo.proof.amountCents / 100).toFixed(2)} paid
            receipt
          </a>
        </section>
      )}
    </div>
  );
}
