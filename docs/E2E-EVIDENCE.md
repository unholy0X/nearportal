# End-to-end evidence — NearPortal v2 on testnet

Recorded 2026-11-05 against the live deployment at https://nearportal.com (application
commit `2c91c87d87f55c9913d1fd14f18b57f77d9df56e`, contracts built from
`d535deb9e3f75ae52ec677f1b85e6ca0e066c29e`). Everything here is **testnet / sandbox**:
NEAR testnet, Base Sepolia test USDC, and Monerium sandbox EUR. No real money moved.

Each statement is labelled with how it is known:

- **Observed (chain)**: read back from a public chain RPC; anyone can repeat the commands below.
- **Observed (app)**: read from the live application's public API or, read-only, its database.
- **Observed (GitHub)**: read from the public demo repository.
- **Stated**: reported by the person who ran the test; not independently verifiable.
- **Simulated**: automated tests with simulated providers; not evidence of a live payout.

Payout receipts from the earlier (v1) contracts are deliberately excluded: they do not
validate these deployments.

## Summary

| Scenario | Rail | Result | Evidence |
| --- | --- | --- | --- |
| Open bounty: publish → bank deposit → claim → PR (auto-linked by marker) → agreed check → creator merge → payout | Bank (Monerium sandbox) | Paid, escrow closed | Observed (chain, app, GitHub) |
| Fixed-deadline bounty: publish → USDC deposit → exclusive claim → explicit submission before deadline → agreed check → creator merge → payout | USDC (Base Sepolia) | Paid, escrow closed | Observed (chain, app, GitHub) |
| Dispute → Resume / Refund, assignment expiry, surplus refund, private repository access | both | Not exercised on v2 | Simulated only |
| MCP client (device login, claim, submit, batch create) against v2 | both | Not exercised on v2 | Simulated only; live read-only handshake observed |

At recording time the v2 database held exactly two bounties, two tasks and two users, with no
dispute, refund or MCP agent token (Observed, app, read-only count). The tester reports that
"several scenarios" were tried and work (Stated); the two lifecycles above are the ones the
records confirm.

## Scenario 1 — bank bounty `NP-D1F72BC472` (open, €250 sandbox)

- Bounty: https://nearportal.com/bounties/b486a812-85f5-475f-a63a-e5248b7591ee
- Task: "Implement Factorial", repository `hellonearportal-dotcom/nearportal-demo-tasks`.
- Agreed check: `acceptance-factorial` (GitHub Actions, app 15368), frozen in the funding policy.

| Time (UTC) | Event | Source |
| --- | --- | --- |
| 15:20:41 | Monerium sandbox deposit confirmed in escrow; 25,000 cents recorded | Observed (app, chain) |
| 15:47:02 | `NearPortalUser01` claimed; criteria and payout destination accepted | Observed (app, chain `assigned_at_ns`) |
| 15:51:33 | PR #4 merged by the creator `hellonearportal-dotcom` | Observed (GitHub) |
| 15:52:08 | PR #4 linked automatically through its `NearPortal-Task: NP-D1F72BC472` line | Observed (app) |
| 15:52:29 | Head `6ab766fb5863` meets every agreed condition; release authorized | Observed (app, chain) |
| 15:52:54 | Verifier authorized payment on NEAR | Observed (app) |
| 15:54:35 | Monerium confirmed the payout; escrow closed | Observed (app, chain) |

On-chain record of `escrow.np-20261105-3a9524.testnet`, bounty `0`:
`state: Closed`, `deposited_cents: 25000`, assignment head `6ab766fb586309bbbacaf56a840d5c4a7dadf34a`,
`settlement_evidence_hash: d45c6bed…a784` (equal to the application's verdict hash),
payout `0`: `kind: Developer`, `amount_cents: 25000`, `state: Processed`. Bank details are stored on
chain only in masked form. Payout transaction (relayer → escrow, `mark_payout_processed`):
`9bHm2CvxSP7ZSESJRynbwrb55pYoWmiGsFZe4gqD6St7`. The Monerium sandbox order itself is not public.

GitHub: [PR #4](https://github.com/hellonearportal-dotcom/nearportal-demo-tasks/pull/4).
`acceptance-factorial` succeeded on the paid head; the unrelated `acceptance-minmax` job failed on
the same head, which shows that only the agreed check gates payment.

## Scenario 2 — USDC bounty `NP-28D5750673` (fixed deadline, 1 test USDC)

- Bounty: https://nearportal.com/bounties/010af596-20a3-4306-af8d-c0d241c688bc
- Task: "Min/max" (the title says "bank bounty", but it uses the USDC rail), one-hour delivery window.
- Agreed check: `acceptance-minmax`.

| Time (UTC) | Event | Source |
| --- | --- | --- |
| 15:35:09 | 1,000,000 units (1 USDC) sent to the bounty's escrow address | Observed (chain, Base Sepolia) |
| 15:37:13 | Deposit confirmed after 12 confirmations and recorded in the NEAR escrow | Observed (app, chain) |
| 16:04:55 | Exclusive assignment `NP-28D5750673-A1` confirmed on chain; deadline 17:04:32 | Observed (app, chain) |
| 16:08:23 / 16:10:18 | PR #5 opened, then merged by the creator | Observed (GitHub) |
| 16:15:17 | Contributor submitted PR #5, commit `070f36dbaecf`, before the deadline | Observed (app, chain `submitted_at_ns`) |
| 16:15:35 | Submission recorded on the escrow | Observed (app) |
| 16:15:37 | Agreed check passed on the submitted head; release authorized | Observed (app) |
| 16:17:24 | USDC payout confirmed on Base Sepolia | Observed (app, chain) |

Base Sepolia (chain 84532), token `0x036CbD53842c5426634e7929541eC2318f3dCF7e`:

- Deposit `0x965c8e538f7e3c41d9bf60d93be7f4172d704b7dfa7f6b7a1f2f60594fd67c5c`: status 1,
  1,000,000 units from `0x6790…7c89` (also the creator refund address frozen on chain) to the
  bounty escrow address `0xd513d4c075c74531be2afece82c7d5a3c0cf2b07`.
- Payout `0xe6ab94447c1f640604f4ec9033c906ae8b384c3e4121b789a55d9658399dbe57`: status 1,
  1,000,000 units from `0xd513…2b07` to the contributor's verified wallet
  `0xdd523b69bdd1fca9fc0767792e47fbbf00369027`.

On-chain record of `escrow.np-20261105-dea8f2.testnet`, bounty
`e6111115-2300-4c69-a28b-e0d79ba96728`: `state: Closed`, `deposited_units: 1000000`,
`delivery_seconds: 3600`, assignment head `070f36dbaecf3ac0cf2d3e0e9ffe2b0d36b1bb0f`,
MPC-signed Developer payout of 1,000,000 units with `evidence_hash: a04c3e9a…5eb4`
(equal to the application's verdict hash).

GitHub: [PR #5](https://github.com/hellonearportal-dotcom/nearportal-demo-tasks/pull/5).

The PR was merged on GitHub before it was submitted in NearPortal. Deadline bounties never
auto-link a PR, so nothing was paid until the contributor's explicit submission. The interface
now detects such a PR and offers a one-click submission (commit `2c91c87`).

## Contracts

| Rail | Account | Deployment tx (DeployContract + `new`) | NEAR code hash | WASM SHA-256 |
| --- | --- | --- | --- | --- |
| USDC | `escrow.np-20261105-dea8f2.testnet` | `ChPddDM8KFd4hZ4qk7VyQ8F5NczWQ4vPZWYrDreTWHxU` | `BqDseHbspkq8Q2aY8CiBZTLsocSaAdjRu53KEPhS5aeP` | `a0ef4dc71ce739a4d265e509b3c7a602185b38557b21c96883d4db8662fe124c` |
| Bank | `escrow.np-20261105-3a9524.testnet` | `EbAYoDu12HSjKMx9kJadTfZsozaFf9q9SKGoE9gmiscw` | `FoevKUc52uC1Kk7b3EcHCvSbmdZbpfVkMruJxXvVZW1P` | `dbf735ac36cc700b99da47722d33bf30dd5cd17a7ebff4ddd616c78bebe8140a` |

Contract sources are identical between `d535deb` and the application commit `2c91c87`.
`scripts/contracts.sh build`, run on a clean `git archive` of `2c91c87`, reproduces both
SHA-256 values exactly, and the live accounts report those code hashes.

## Repeat the checks

Read-only; no keys needed.

```sh
# Deployed code hash of each escrow
for a in escrow.np-20261105-dea8f2.testnet escrow.np-20261105-3a9524.testnet; do
  curl -s https://rpc.testnet.near.org -H 'content-type: application/json' -d \
  '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"'$a'"}}' \
  | jq -r '.result.code_hash'
done

# On-chain bounty state (args are base64 JSON)
q() { curl -s https://rpc.testnet.near.org -H 'content-type: application/json' -d \
  '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"'$1'","method_name":"'$2'","args_base64":"'$(printf %s "$3" | base64)'"}}' \
  | jq -r '.result.result | implode | fromjson'; }
q escrow.np-20261105-3a9524.testnet get_bounty '{"bounty_id":"0"}' | jq '{state,deposited_cents,settlement_payout_id}'
q escrow.np-20261105-3a9524.testnet get_payout '{"payout_id":"0"}' | jq '{kind,amount_cents,state}'
q escrow.np-20261105-dea8f2.testnet get_bounty '{"bounty_id":"e6111115-2300-4c69-a28b-e0d79ba96728"}' | jq '{state,deposited_units}'

# Base Sepolia receipts (status 0x1 = success)
for h in 0x965c8e538f7e3c41d9bf60d93be7f4172d704b7dfa7f6b7a1f2f60594fd67c5c \
         0xe6ab94447c1f640604f4ec9033c906ae8b384c3e4121b789a55d9658399dbe57; do
  curl -s https://sepolia.base.org -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["'$h'"]}' | jq -r '.result.status'
done

# Rebuild the contracts and compare hashes (Docker)
scripts/contracts.sh build
```

Explorers: [USDC deposit](https://sepolia.basescan.org/tx/0x965c8e538f7e3c41d9bf60d93be7f4172d704b7dfa7f6b7a1f2f60594fd67c5c),
[USDC payout](https://sepolia.basescan.org/tx/0xe6ab94447c1f640604f4ec9033c906ae8b384c3e4121b789a55d9658399dbe57),
[bank payout record](https://testnet.nearblocks.io/txns/9bHm2CvxSP7ZSESJRynbwrb55pYoWmiGsFZe4gqD6St7).
Third-party indexers can lag; the RPC commands above are authoritative.

## Not yet demonstrated on v2

- A dispute, then `Resume` (no payout without checks and merge) or `Refund` to the frozen creator destination.
- Assignment expiry and reassignment; withdrawal; surplus deposit handling; private repository invitations.
- An authenticated MCP session (device approval, claim, submit, batch creation). The published
  `nearportal-mcp@0.2.0` was checked against the live server read-only: stdio handshake, all 13 tools,
  and a correct `not_authenticated` refusal.

These paths are covered by the contract and application test suites with simulated providers
(see the README), which are not a substitute for live receipts.
