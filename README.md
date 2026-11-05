# NearPortal

Good work. Funded rewards.

NearPortal connects GitHub bounties to NEAR-controlled escrow addresses. A contributor
claims one assignment, submits a PR, passes the agreed checks, and receives the reward
after the creator merges. Terminal agents use the same application through a local
stdio MCP server. **This release is a testnet hackathon demo: no real USDC.**

- `contracts/`: shared rules, bank escrow (Monerium sandbox), Base Sepolia USDC escrow.
- `apps/server/`: GitHub authentication, scoped MCP API, assignment and payment workers.
- `apps/server/mcp/`: standalone terminal client; its Apache-2.0 license is retained.
- `apps/site/`: Aurora Portal website and MCP guide.
- `services/relayer/`: deposit and payout reconciliation for the bank rail.

Use Node.js 24 and Docker. Install dependencies and run the isolated application checks:

```sh
make install check test build
make contracts
(cd apps/server && npx playwright install chromium)
make demo
```

The simulated demo runs local services and a Playwright browser with mock GitHub and
escrow providers. It does not validate a real GitHub login or a testnet payout. It writes browser screenshots and a redacted transcript under
`apps/server/output/demo-simulated/`; the terminal should report all checks passing.

Read the [MCP guide](apps/server/mcp/README.md), [payment rules and trust assumptions](docs/CONTRACTS.md),
and [fresh deployment procedure](docs/DEPLOYMENT.md). The new interface requires fresh
accounts, wallets and storage. The source's MCP package is version 0.2.0; publication
and live deployment must be verified separately before using its npm install command.

Developer payment always requires checks and creator merge, including after a dispute.
The owner can resume verification or refund the creator; there is no payout override.
Neither an opened PR nor a merge by itself proves payment. A receipt is shown only after
confirmation. Never send mainnet assets to demo deposit addresses.

The repository uses MIT except where a component carries its own license, including
the Apache-2.0 MCP client. Keep these notices when redistributing those components.

Built during NEAR HACKATHON 2026. The application uses NEAR testnet for escrow
and Chain Signatures, and Base Sepolia (chain 84532) for test USDC transfers.
The redesigned contracts and callers in this branch are **tested in simulation**;
the existing hosted deployment is an earlier version. Fresh deployment and payout
receipts are still required before claiming this version is tested on testnet.

Claude Code and OpenAI Codex assisted with implementation, review, tests and docs.
See [NOTICE](NOTICE.md) for third-party components, [SECURITY](SECURITY.md) for
reporting issues and [CONTRIBUTING](CONTRIBUTING.md) for the local workflow.
