/** UI capability metadata, derived from verified facts, not a convenience switch.
 *
 * Fixed price + deadline is enabled per payment rail only when:
 * - simulation mode with the simulated escrow chain (no funds, local and tests), or
 * - sandbox mode AND the deployed escrow's code hash is listed in MARKET_VERIFIED_CODE_HASHES.
 *   That list is written by the operator after the extended contract was reviewed, deployed on
 *   testnet and the end-to-end scenario passed on that rail. The presence of a contract method is
 *   NOT sufficient. Sealed-bid auctions stay disabled (out of scope).
 */
export type Rail = "bank" | "base-usdc";
export const bountyModeCapabilities = {
  fixedDeadline: false,
  fixedDeadlineRails: { bank: false, "base-usdc": false } as Record<Rail, boolean>,
  sealedBid: false,
  agreementVersion: 1,
  reason: "Deadline bounties need the extended escrow contract to be deployed and verified on testnet for each payment rail.",
};
export function setFixedDeadlineRails(rails: Record<Rail, boolean>, reason: string) {
  bountyModeCapabilities.fixedDeadlineRails = { ...rails };
  bountyModeCapabilities.fixedDeadline = rails.bank || rails["base-usdc"];
  bountyModeCapabilities.reason = reason;
}
/** Decide a rail's capability from the deployed code hash (sandbox) or simulation. */
export function railVerified(mode: "simulation" | "sandbox", codeHash: string | null | undefined, verified = process.env.MARKET_VERIFIED_CODE_HASHES ?? "") {
  if (mode === "simulation") return true;
  if (!codeHash) return false;
  return verified.split(",").map((s) => s.trim()).filter(Boolean).includes(codeHash);
}
export function requireMarketRollout(kind: "fixed" | "auction" = "auction", rail: Rail = "bank") {
  if (kind === "auction") throw new Error("Sealed-bid auctions are not enabled. Your draft is saved.");
  if (!bountyModeCapabilities.fixedDeadlineRails[rail])
    throw new Error(`Deadline bounties are not enabled for ${rail === "base-usdc" ? "USDC" : "bank"} payments on this deployment yet. Your draft is saved; funding has not started.`);
}
