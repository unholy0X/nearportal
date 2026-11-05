import test from "node:test";
import assert from "node:assert/strict";
import { newMarket, transition, marketTerms, type Market } from "../server/portal/market.ts";
import { bountyModeCapabilities } from "../server/portal/market-rollout.ts";
import { bountyStatus, MARKET_PHASES } from "../src/workspace/workspace-model.mjs";

const HOUR = 3_600_000, t0 = Date.UTC(2026, 10, 4);
const policyHash = "a".repeat(64);
const person = { userId: 200, login: "developer", payoutVersion: "v1", repositoryAccess: true };
function auctionMarket() {
  const terms = marketTerms({ kind: "auction", deliveryHours: 72, biddingHours: 48, confirmationHours: 24 }, 10000);
  let m = newMarket("NP-ABCDEF0123", 300, policyHash, terms);
  m = transition(m, { type: "fund", confirmedCents: 10000 }, t0);
  const bidding = m;
  m = transition(m, { type: "bid", person, acceptedPolicyHash: policyHash, bidId: "bid-00000001", amountCents: 8000 }, t0 + HOUR);
  m = transition(m, { type: "select", checkedBidders: [{ userId: 200, eligible: true, payoutVersion: "v1" }] }, t0 + 49 * HOUR);
  return { terms, bidding, offered: m };
}
const bounty = (terms: Market["terms"], market: Market) => ({
  id: "b1", ownerId: 300, title: "Sealed bid", repository: "client/repository", status: "Open", amountCents: 10000,
  marketTerms: terms, market: { phase: market.phase },
  task: { funded: true, jobId: 1, prNumber: null, disputed: false, verdict: null, policy: {}, payment: { state: "NotRequested" } },
});

test("model status follows the real market engine phases", () => {
  const { terms, bidding, offered } = auctionMarket();
  assert.equal(bidding.phase, "bidding");
  assert.equal(offered.phase, "offered");
  const enabled = { capabilities: { sealedBid: true } };
  assert.equal(bountyStatus(bounty(terms, bidding), enabled).key, "bidding");
  assert.equal(bountyStatus(bounty(terms, offered), enabled).key, "awaitingConfirmation");
  assert.equal(bountyStatus(bounty(terms, offered), enabled).label, "Awaiting confirmation");
});

test("with the shipped capability gates no auction phase is shown and none is Available", () => {
  assert.equal(bountyModeCapabilities.sealedBid, false);
  assert.equal(bountyModeCapabilities.fixedDeadline, false);
  const { terms, bidding, offered } = auctionMarket();
  for (const m of [bidding, offered]) {
    const s = bountyStatus(bounty(terms, m), { capabilities: bountyModeCapabilities });
    assert.notEqual(s.key, "available");
    assert.ok(!["bidding", "awaitingConfirmation"].includes(s.key));
  }
});

test("every phase the model maps exists in the engine", () => {
  const engine: Market["phase"][] = ["unfunded", "available", "bidding", "offered", "in-progress", "in-review", "payment-processing", "paid", "paused"];
  for (const phase of Object.keys(MARKET_PHASES)) assert.ok((engine as string[]).includes(phase), phase);
});

test("verified USDC escrows await deposit without a bank job ID and stay unfunded until confirmation", () => {
  const b = { id: "b1", ownerId: 300, title: "USDC", repository: "owner/test", status: "AwaitingFunding", amountCents: 1,
    paymentRail: "base-usdc" as const,
    task: { funded: false, jobId: null, fundingPolicyHash: "agreement", crypto: { address: "0x" + "1".repeat(40), verifiedFundingHash: "" } } };
  assert.equal(bountyStatus(b).detail, "Preparing escrow");
  b.task.crypto.verifiedFundingHash = "agreement";
  assert.equal(bountyStatus(b).detail, "Awaiting deposit");
  assert.equal(bountyStatus(b).key, "toFund");
  b.task.crypto.verifiedFundingHash = "old-agreement";
  assert.equal(bountyStatus(b).detail, "Preparing escrow");
  assert.equal(bountyStatus({ ...b, paymentRail: undefined, task: { funded: false, jobId: 0 } }).detail, "Awaiting deposit");
});
