# Application migration to bounty contracts

These interfaces require fresh storage and accounts. They are tested in simulation;
receipts from the earlier deployed contracts do not validate this revision.

| Earlier caller | Current interface |
| --- | --- |
| Bank `create_job`, USDC `create_crypto_bounty` | `create_bounty`; bank allocates an ID, USDC uses the application's UUID |
| `get_job`, `get_crypto_bounty`, separate mandate/market views | `get_bounty({bounty_id})`, including assignment and payout fields |
| `configure_bounty_market`, `configure_crypto_market` | `delivery_seconds` fixed at creation |
| `bind_*_submission`, `bind_*_assignment` | `assign_developer` with generation, assignment hash and immutable destination |
| `record_*_submission` | `record_submission` with exact head and verifier observation time |
| `release_*_assignment` and open-bounty release | `settle_bounty`, requiring the recorded assignment/head on both rails |
| `expire_*_assignment`, `withdraw_*_assignment` | `expire_assignment`, `withdraw_assignment` |
| USDC `record_crypto_deposit` | `record_deposit`, with deduplicated chain receipt reference |
| USDC signing retry / confirmation | `retry_payout_signature`, `mark_payout_processed` |
| `set_crypto_operator`, per-task operator views | Owner `set_operator`, `get_config().operators` |
| Optional/mutable creator refund destination | Required immutable `refund_address` or `refund_short_iban` at creation |
| Owner payout override / application CI waiver | Removed; dispute `Resume` authorizes no payout, `Refund` returns funds to the creator |

Bank bounty/payout IDs, cents, USDC units, developer IDs, fees and times represented
by NEAR `U64` are decimal JSON strings. Generations and delivery seconds remain numbers.
All bounty arguments use `bounty_id`; all assignment commitments use `assignment_hash`.

MPC paths use `bounty-<id>` on fresh contract accounts. A failed MPC query leaves
address verification pending and retryable via `retry_address_check`; a confirmed
mismatch cancels the bounty. Both rails enforce the 15-minute submission relay grace.
An administrative pause still permits timely submission recording.

The bank relayer reads `assignment.recipient`, `refund_short_iban`, `reward_cents`
and `deposited_cents`, reports all incoming deposits, and lets the contract allocate
reward and surplus. The USDC worker verifies immutable terms before showing funding
instructions and checks the exact authorized transaction before each broadcast.
Refund status is separate from developer payment status throughout the API and site.

Old in-place upgrade scripts and legacy verifier fallbacks were removed. The new
deployment planner emits a reviewable plan before generating keys or sending transactions.
Bank creation remains non-idempotent at contract level: an ambiguous response must be
reconciled against the saved bounty ID, never blindly retried. The hosted pilot keeps
the bank rail disabled.
