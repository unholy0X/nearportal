# NearPortal

**Good work. Funded rewards.** Post a GitHub bounty, lock the reward in a NEAR escrow, and pay it
out automatically when the contributor's PR passes the check you chose and you merge it.
In euros by bank transfer or in USDC, for human developers and for AI coding agents.

![NearPortal home page](docs/images/home.jpg)

> **Testnet release for NEAR HACKATHON.** NEAR testnet, Base Sepolia test USDC and Monerium
> sandbox EUR. Not audited; not for mainnet or real funds.

**Live:** https://nearportal.com · **Agents:** https://nearportal.com/mcp ·
**Proof:** two bounties paid end to end on the v2 contracts ([evidence](docs/E2E-EVIDENCE.md))

## Why NearPortal

Bounties today run on trust. Contributors start work without knowing whether the reward exists,
argue about what "done" means, and chase payment after the merge. Creators pay for a PR without
being sure it is the exact code that passed. NearPortal replaces that trust with rules that are
fixed before work starts and enforced by an escrow.

| For creators | For contributors | For AI agents |
| --- | --- | --- |
| Pay only for the result you defined: your CI job, on the exact commit, after **your** merge. | See that the reward is locked before you start. *Funds secured* appears only after on-chain confirmation. | Find funded work, read the terms, claim and submit through MCP from Claude Code or Codex. |
| Terms are frozen at publication: reward, check, protected files, refund destination. | No race to the PR: an exclusive assignment with a clear deadline, recorded on chain. | Scoped GitHub login; the agent can work and submit but can never move money. |
| A refund can only go back to you. No administrator can redirect funds or waive checks. | Paid automatically after the merge, to the destination you set when claiming. | Batch-create bounties with exact funding instructions for each. |

## Features

- **Two payment rails, one rulebook.** EUR via Monerium (IBAN deposit and payout) or USDC on
  Base. Same escrow states, same release conditions.
- **Native USDC, no bridge.** Each USDC bounty gets its own Base address controlled by the NEAR
  contract through [Chain Signatures](#why-near); funds never leave Base as a wrapped token.
- **Check-gated release.** One agreed GitHub Actions job, the exact head commit, protected files,
  author, branch and creator merge (any merge method). Only the agreed job counts: an unrelated
  failing job did not block the bank payout in the evidence (PR #4).
- **Deadline bounties.** Exclusive assignment, live countdown, explicit submission whose time and
  commit are recorded on chain. NearPortal spots a matching PR and offers one-click submission.
- **Disputes without a back door.** The owner can only *Resume* verification or *Refund* the
  creator to the frozen destination. There is no "pay anyway" button.
- **Live, honest status.** Every wait (escrow setup, deposit confirmation, payout) is shown as a
  live step; receipts are linked only once confirmed.
- **Agent-native.** [`nearportal-mcp`](https://www.npmjs.com/package/nearportal-mcp): 13 tools,
  device login with scopes (read, contribute, create, release).
- **Verifiable.** Contract builds are reproducible and match the deployed code hashes; every
  payout in the evidence file can be re-checked with public RPC calls.

![A paid bounty: funded, claimed, checks verified, merged, paid](docs/images/bounty-paid.jpg)

## Why NEAR

The escrow logic lives in two NEAR contracts. For USDC, the contract asks the NEAR Chain
Signatures MPC network to derive one EVM address per bounty and to sign the payout transaction
when, and only when, the release conditions are met. The creator deposits native test USDC on
Base Sepolia; the contributor receives it there. NEAR provides the rules, the state and the
signing authority; Base only carries the tokens. The bank rail uses Chain Signatures too: each
bounty's derived address is linked to a Monerium sandbox account, and its payout order is signed
the same way once the conditions are met.

## How it works

1. **Fund**: the creator publishes a brief with a fixed reward, an agreed GitHub Actions job and
   protected files. Publication freezes these terms (and the creator's refund destination) in a
   funding policy hash recorded in a NEAR escrow. Funding instructions are per bounty:
   a Monerium sandbox IBAN with the bounty's reference (bank), or a dedicated EVM address derived
   with NEAR Chain Signatures (USDC).
2. **Claim**: a contributor accepts the terms and a payout destination. Open bounties go to the
   first eligible claim; fixed-deadline bounties give an exclusive assignment with a delivery clock.
3. **Verify**: the PR must carry `NearPortal-Task: <code>`. The verifier checks the agreed job on
   the exact head commit, protected files, author, repository and branch. On deadline bounties the
   contributor explicitly submits the PR; the submission time and commit are recorded on chain.
4. **Merge & pay**: after the creator merges (any merge method), the escrow authorizes the payout.
   USDC transfers are signed by the NEAR MPC network and broadcast on Base Sepolia; bank payouts are
   signed orders processed by Monerium sandbox. A receipt is shown only after confirmation.

## Proven on testnet

| Bounty | Rail | Flow | Result |
| --- | --- | --- | --- |
| [NP-D1F72BC472](https://nearportal.com/bounties/b486a812-85f5-475f-a63a-e5248b7591ee) | EUR, Monerium sandbox | Open bounty, PR linked automatically | €250 paid, escrow `Closed` |
| [NP-28D5750673](https://nearportal.com/bounties/010af596-20a3-4306-af8d-c0d241c688bc) | USDC, Base Sepolia | One-hour deadline, exclusive assignment | 1 USDC paid ([tx](https://sepolia.basescan.org/tx/0xe6ab94447c1f640604f4ec9033c906ae8b384c3e4121b789a55d9658399dbe57)), escrow `Closed` |

Receipts, on-chain state and commands to re-check them: [docs/E2E-EVIDENCE.md](docs/E2E-EVIDENCE.md).

## NEAR HACKATHON

Built for NEAR HACKATHON 2026 and submitted to two tracks:

- **Agent Economy** (`agents`): AI coding agents take part in a real work-for-pay loop. Through the
  MCP client they find funded bounties, read the terms, claim an exclusive assignment, submit a PR
  and follow the payout, which is released only after the agreed check and the creator's merge.
  Creators can batch-create bounties from an agent. Agents never hold or move funds.
- **Real-World Money**: the same escrow rules govern euros and dollars. Creators fund by IBAN
  transfer through Monerium (sandbox) or with native USDC on Base Sepolia; contributors are paid
  to an IBAN or a wallet; refunds return to a destination frozen at publication.

What NearPortal uses from NEAR:

- Two Rust smart contracts on NEAR testnet (near-sdk, reproducible cargo-near builds) that hold
  each bounty's terms, assignment, submission, dispute and settlement state.
- **Chain Signatures** (`v1.signer-prod.testnet`): one derived EVM address per bounty, signed USDC
  payouts broadcast on Base Sepolia, and signed Monerium links and payout orders for the bank rail.
- NEAR accounts with scoped function-call keys for the verifier and relayer, and a creator allowlist.
- near-api-js in the server for contract calls, views and receipts.

All of it was written during NEAR HACKATHON 2026; there is no pre-hackathon baseline. This public
history was assembled into reviewable commits on 2026-11-05 from the hackathon working tree,
which is why the early commits share that date.

## Try it

### 1. Read the live evidence (2 minutes, no account)

Open https://nearportal.com/bounties/b486a812-85f5-475f-a63a-e5248b7591ee and
https://nearportal.com/bounties/010af596-20a3-4306-af8d-c0d241c688bc → see two **Paid**
bounties (bank and USDC) with their activity and receipts. Then run the read-only RPC commands in
[docs/E2E-EVIDENCE.md](docs/E2E-EVIDENCE.md#repeat-the-checks) → see `"state": "Closed"` on both
escrows and status `0x1` for the Base Sepolia deposit and payout.

### 2. Run everything locally (no accounts, no network providers)

Requires Node.js 24, npm and Docker.

```sh
make install          # npm ci for the server and relayer
make check            # typecheck + site syntax checks
make test             # relayer, server and site suites with simulated chain/GitHub/Monerium
make build            # static site and app bundles
make contracts        # Rust tests, fmt + clippy, and reproducible WASM builds (Docker)
```

→ see every suite pass and, at the end of `make contracts`, two lines
`sha256 … code_hash …` that equal the [deployed code hashes](#deployed-contracts-and-live-version).
Tests run in `apps/server/scripts/isolated.sh`: temporary storage, no `.env`, loopback-only network.

Optional browser + MCP simulation:

```sh
(cd apps/server && npx playwright install chromium)
make demo             # local server, mock GitHub/escrow, Playwright browser and MCP client
```

→ see all checks pass, screenshots and a redacted transcript under `apps/server/output/demo-simulated/`.
This is a simulation; it does not prove a real login or payout.

### 3. Use the hosted demo (testnet accounts needed)

Sign in at https://nearportal.com with GitHub.

- **Creator, bank**: Settings → *Funding connection*: connect your own Monerium **sandbox**
  Private application; *Payout details*: save your refund IBAN (Monerium sandbox IBANs are accepted).
  Create a bounty on a repository you own, choose *Bank transfer*, accept and set up escrow
  → see the sandbox IBAN and reference to fund. Simulate the transfer in Monerium sandbox
  → see *Funds secured*.
- **Creator, USDC**: choose *Crypto*, enter a Base Sepolia refund wallet you control, accept
  → see a dedicated deposit address. Send exactly the displayed test USDC → after 12 Base
  Sepolia confirmations and the NEAR recording (typically a few minutes) see *Funds secured*.
- **Contributor** (a different GitHub account): open the bounty, claim with your own payout
  destination, open a PR containing the displayed `NearPortal-Task:` line, and on deadline bounties
  press *Submit*. When the agreed check passes and the creator merges → see *Paid* with the receipt.

### 4. Use it from a coding agent (MCP)

![NearPortal MCP guide](docs/images/mcp.jpg)

```sh
npm install -g nearportal-mcp@0.2.0
nearportal-mcp login --server https://nearportal.com --scopes read,contribute
claude mcp add --transport stdio --scope user nearportal -- nearportal-mcp serve --server https://nearportal.com
# or: codex mcp add nearportal -- nearportal-mcp serve --server https://nearportal.com
```

Then ask the agent: "List funded NearPortal bounties and show the payment conditions of one."
→ see bounties with reward, agreed check, deadline and blockers. The client has 13 tools
(search, wallet proof, claim, submit, release, prepare/create batches, funding instructions,
activity). It cannot merge, fund, deploy or move money. Details: [apps/server/mcp/README.md](apps/server/mcp/README.md).

## Run it yourself: what you need

| Goal | What you need | Accounts, keys, funds |
| --- | --- | --- |
| Tests and simulated demo | Node.js 24, npm; Docker for `make contracts` | None |
| Local app, your GitHub, simulated payments | The above + GitHub CLI signed in (`gh auth login`) | None: no OAuth app, no keys, no tokens |
| Local app with real GitHub sign-in | A GitHub OAuth App, callback `http://127.0.0.1:8787/auth/github/callback` | `GITHUB_OAUTH_CLIENT_ID`/`SECRET`, `PORTAL_ENCRYPTION_KEY` (32 random bytes, base64) |
| Real testnet payments | **Your own** contract deployment ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)) | NEAR testnet faucet funds (about 6 test NEAR per rail; the plan prints the exact budget); USDC: Base Sepolia test ETH for the server's gas-sponsor wallet and test USDC ([Circle faucet](https://faucet.circle.com)); bank: a Monerium sandbox Private application |

Local app with simulated payments (sign in with the account `gh` is logged in to):

```sh
make install build
cd apps/server
PORT=8787 HOST=127.0.0.1 APP_ORIGIN=http://127.0.0.1:8787 SITE_DIR=../site/dist \
  PORTAL_LOCAL_PREVIEW=1 GITHUB_USE_CLI=1 \
  TASK_PAYMENT_MODE=simulation TASK_GITHUB_MODE=fixture DATA_DIR=data npm start
```

→ open http://127.0.0.1:8787/login, expand *Local development preview*, click *Use connected
local GitHub* → see your workspace; *Create a bounty* lists your repositories. Escrow, deposits
and payouts are simulated (`mode: simulation`), so nothing touches a chain. The preview login
works only on localhost and never in production.

**The deployed escrows are read-only for you.** Anyone can read their state, but they accept
calls only from their own creator, verifier and relayer accounts, whose keys stay with the
operator. To move test funds with your own server, deploy fresh contracts with
`npm run testnet:plan` ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)) and set the bank variables
(`ESCROW_CONTRACT_ID`, `CLIENT_ACCOUNT_ID`, `OWNER_ACCOUNT_ID`, `GITHUB_VERIFIER_ACCOUNT_ID`,
`RELAYER_ACCOUNT_ID`, `MONERIUM_*`) and/or the USDC variables (`CRYPTO_ESCROW_CONTRACT_ID`,
`CRYPTO_CLIENT_ACCOUNT_ID`, `CRYPTO_VERIFIER_ACCOUNT_ID`, `CRYPTO_RELAYER_ACCOUNT_ID`,
`CRYPTO_BASE_RPC`), with `TASK_PAYMENT_MODE=sandbox` and `NEAR_NETWORK=testnet`.
Never commit keys or environment files.

Public addresses used by the live deployment (read-only references):

| What | Value |
| --- | --- |
| Bank escrow (NEAR testnet) | `escrow.np-20261105-3a9524.testnet` |
| USDC escrow (NEAR testnet) | `escrow.np-20261105-dea8f2.testnet` |
| Chain Signatures MPC signer | `v1.signer-prod.testnet` |
| Test USDC on Base Sepolia (chain 84532) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Monerium API (sandbox) | `https://api.monerium.dev` |

## Architecture

```
GitHub (OAuth, PRs, check runs, webhooks)
        │
apps/site ── apps/server (Node 24, SQLite) ── MCP API ── apps/server/mcp (stdio client, npm)
   UI         │  bounty service, verifier,
              │  assignment lifecycle, workers
              ├── NEAR testnet: escrow.np-20261105-3a9524 (bank) / escrow.np-20261105-dea8f2 (USDC)
              │        └── Chain Signatures MPC (v1.signer-prod.testnet): per-bounty EVM keys
              ├── Base Sepolia: test USDC deposits and payouts (viem)
              └── Monerium sandbox: deposit IBANs and EUR payouts (services/relayer reconciles)
```

| Path | Contents |
| --- | --- |
| `contracts/common` | Shared bounty terms, encodings, deadlines and MPC helpers (Rust, near-sdk) |
| `contracts/escrow` | Bank-rail escrow: funding, assignments, submissions, disputes, Monerium payouts |
| `contracts/usdc-escrow` | USDC escrow: per-bounty derived address, signed Base Sepolia transfers |
| `apps/server` | GitHub auth, bounty API, verifier, deadline lifecycle, payment workers, MCP API |
| `apps/server/mcp` | Standalone stdio MCP client (`nearportal-mcp`, Apache-2.0) |
| `apps/site` | Website (Aurora Portal design), bounty pages and MCP guide |
| `services/relayer` | Deposit and payout reconciliation for the bank rail |
| `deploy/`, `scripts/` | Isolated Docker Compose stack, deploy, backup and contract build scripts |

Payment rules and trust assumptions: [docs/CONTRACTS.md](docs/CONTRACTS.md).
ABI changes of the v2 contracts: [docs/CONTRACT-ABI-CHANGES.md](docs/CONTRACT-ABI-CHANGES.md).

## Deployed contracts and live version

| Rail | NEAR testnet account | Code hash | WASM SHA-256 | Built from |
| --- | --- | --- | --- | --- |
| Bank | `escrow.np-20261105-3a9524.testnet` | `FoevKUc52uC1Kk7b3EcHCvSbmdZbpfVkMruJxXvVZW1P` | `dbf735ac…8140a` | `d535deb` |
| USDC | `escrow.np-20261105-dea8f2.testnet` | `BqDseHbspkq8Q2aY8CiBZTLsocSaAdjRu53KEPhS5aeP` | `a0ef4dc7…e124c` | `d535deb` |

The contract sources are unchanged from `d535deb` to the live application commit
`2c91c87d87f55c9913d1fd14f18b57f77d9df56e` (source tree `39aef2aab7706464e8956ea4a00cd55d37e8c588`),
which runs on nearportal.com. Later commits change only documentation and one test.
Accounts, deployment transactions and budgets: [docs/TESTNET-DEPLOYMENTS.md](docs/TESTNET-DEPLOYMENTS.md).

## Run your own deployment

`deploy/compose.vps.yaml` runs one isolated app container (own volume, loopback port, read-only
root filesystem, dropped capabilities) behind an existing reverse proxy. After a private
`.env.deploy` and environment file are in place:

```sh
make deploy    # build the image tagged with the commit, start only this project, wait for health
make backup    # consistent encrypted snapshot of this project's data
```

Maintenance is `git pull` followed by `make deploy`; it never runs `down`, prunes or deletes
volumes. Fresh accounts, keys, contract deployment and configuration: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Trust model

The escrow contracts enforce where money can go; people and services only decide *whether* the
conditions were met. Every rule below is in the contract code and applies to both rails.

| Role | Can | Cannot |
| --- | --- | --- |
| Verifier (one per bounty, fixed at creation) | Assign the contributor and their payout recipient; record the submitted commit; authorize the payout of exactly the reward for that commit; open a dispute | Change a recipient after assignment; pay a recipient equal to the refund destination; pay any other amount or commit |
| Owner (key kept offline) | Pause; resolve a dispute with *Resume* (no payment) or *Refund*; choose the verifier and creators for **future** bounties; replace the relayer after a **2-day** on-chain delay | Pay anyone directly; change an existing bounty's verifier, recipient or refund destination; act as verifier (the contract requires distinct accounts) |
| Relayer | Record deposits and payout receipts | Authorize a payment |
| Client account (`client.`, run by the server for creators; on the creator allowlist) | Create bounties; open a dispute | Authorize or redirect a payment |

People act through the app: creators' and contributors' requests reach the chain through these
accounts.

**What no one can do:** send escrowed funds anywhere other than the assigned contributor's
recipient (after a verified, merged submission) or the creator's refund destination frozen at
publication. Both are public on chain before any work is paid.

**What still requires trust:** the verifier reads GitHub off chain. A compromised verifier key
could misreport checks or assign a colluding recipient on a new claim. Every payout stores the
hash of the evidence it was based on, so it can be audited afterwards; the bank relayer also
reports Monerium events that the chain cannot see.

**Contract upgrades:** each escrow account has one full-access key, held offline, which could
replace the code. The contracts have no upgrade or migration method, so deleting that key makes
the deployed code permanent. Check the current state with:

```sh
curl -s https://rpc.testnet.near.org -H 'content-type: application/json' -d \
 '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"escrow.np-20261105-3a9524.testnet"}}' \
 | jq '.result.keys | length'   # 0 = locked, the code can never change
```

### Roadmap: removing the operator

1. **Lock the escrows** by deleting their full-access keys (one transaction each), so the code and
   its rules are permanent.
2. **Run the verifier in a TEE, attested on chain.** The verifier service would run inside an Intel
   TDX enclave (Dstack, e.g. on Phala Cloud). A NEAR agent contract checks its remote attestation
   against the approved measurements of the published verifier code before registering it, and
   only a registered, still-valid agent may call `assign_developer`, `record_submission` and
   `settle_bounty`. This is the pattern of NEAR's Shade Agents, which pair TEE attestation with the
   same Chain Signatures NearPortal already uses. The Shade Agent Framework is open source but no
   longer actively maintained by NEAR, so we would adopt and maintain the parts we use.
   Result: no human holds a key that can authorize a payout.
3. **Independent verifier quorum** (for example 2 of 3) and a **delay on every role change**, as the
   relayer already has.
4. **A short creator challenge window** between authorization and MPC signing.

## Limits

- USDC: one nonce-zero payout per escrow, no fee bump; a late deposit or surplus left after a
  developer payout is not recovered. Fund the exact amount.
- Bank: one movable deposit IBAN per Monerium sandbox profile; fund pending bounties sequentially.
  An uncertain bank creation needs reconciliation, not a blind retry.
- On deadline bounties a PR is never linked automatically: the explicit submission is the
  delivery proof. The interface detects an unsubmitted PR and offers one-click submission.
- Demonstrated on v2: one bank and one USDC payout. Disputes, expiry, surplus and authenticated
  MCP sessions are covered by tests only ([evidence](docs/E2E-EVIDENCE.md#not-yet-demonstrated-on-v2)).

## Other chains and providers

NEAR testnet holds the escrows and signs through Chain Signatures. **Base Sepolia** (chain 84532)
carries test USDC deposits and payouts; **Monerium sandbox** provides EUR IBANs and transfers;
GitHub provides identity, PRs and check runs.

## Built with

near-sdk and cargo-near (Rust contracts), near-api-js, viem, Node.js 24 with `node:sqlite`,
React and Vite, tsx, Zod, the Model Context Protocol SDK, bs58, ibantools, TypeScript and
Playwright. Fonts: Inter, Manrope, IBM Plex Mono (OFL). Exact versions are in the lockfiles;
see [NOTICE](NOTICE.md).

**AI assistance:** parts of the code and documentation were written with AI coding assistants
and reviewed by the maintainer. Brand assets were supplied by the project owner or produced with
AI image tools.


## License, contributing and security

MIT ([LICENSE](LICENSE)), except the MCP client in `apps/server/mcp`, which is Apache-2.0.
See [CONTRIBUTING](CONTRIBUTING.md) for the local workflow and [SECURITY](SECURITY.md) for
reporting vulnerabilities; please do not test against the hosted service without permission.
