# Contract and payment rules

This release uses NEAR testnet and Base Sepolia test USDC. It requires fresh
accounts and empty application storage. Existing contract storage is incompatible;
old deployment receipts do not validate these binaries.

Hosted dual-rail deployments use distinct contracts and verifier accounts. Bank publication
captures the creator's refund account from Settings, stores a salted commitment and masked
IBAN in the funding policy, and passes that frozen destination to the relayer. Editing the
creator's settings later cannot redirect a pending refund. Full refund details are excluded
from public task/bounty responses. The encrypted publication snapshot remains private.

Both rails expose `create_bounty`, `get_bounty`, `get_escrow_path`,
`assign_developer`, `record_submission`, `expire_assignment`,
`withdraw_assignment`, `settle_bounty`, `open_dispute`, and `resolve_dispute`.
NEAR `U64` JSON arguments and results are decimal **strings**, not numbers.

Every developer payout requires the current assignment, its immutable recipient,
and its exact recorded head. The off-chain verifier checks the agreed GitHub
workflow/job, protected files, author, repository, target branch and creator merge.
Any GitHub merge method is accepted. The contract cannot independently query GitHub:
correct verification and protection of the scoped verifier key remain trust assumptions.

The owner resolves disputes with `Resume` or `Refund`. `Resume` authorizes no
transaction: it reopens the original verification path. There is no owner CI waiver
and no owner `Payout` outcome. `Refund` sends recorded unspent deposits to the
client destination fixed at creation. USDC includes recorded surplus in this refund;
bank surplus is tracked separately and reconciled by the relayer.

Assignments with a delivery window start at the confirming block. A submission must
be observed by the verifier no later than the deadline and recorded on chain within
15 minutes after it, on **both** rails. An observation after the deadline is invalid.
If a provider outage exceeds that relay grace, the app retains the submission evidence
and blocks payment for manual review. It cannot promise successful late recording.

An administrative pause blocks new bounty creation, deposit recording, assignment,
settlement and dispute resolution. Timely submission recording, expiry, withdrawal,
status reads and reconciliation of already authorized payments remain available.
The delivery clock continues during a financial pause. A dispute separately blocks
settlement and changes to the disputed assignment.

MPC address derivation failures remain unverified and retryable at the same immutable
path. A confirmed different address cancels the bounty. No deposit address should be
shown before matching the funded terms and completing MPC verification.

USDC uses one outgoing transaction per escrow, nonce zero, with bounded fee caps and
an exact token/chain/recipient/amount. Broadcast retries reuse identical signed bytes.
This version does not recover a late deposit or surplus remaining **after developer
payment**, and cannot replace an underpriced authorized transaction. Fund the exact
requested test amount only. This is not a mainnet custody product.

Owner and contract deployment keys stay offline. The verifier and relayer use exact
function-call scopes; the creator has a separate, low-balance account because creation
attaches a storage deposit. A retained contract full-access key can replace its code;
that administrative trust must be disclosed even though dispute resolution cannot
bypass the normal payout rules.
