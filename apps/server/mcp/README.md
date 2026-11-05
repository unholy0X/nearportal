# NearPortal MCP

Use NearPortal from Claude Code, Codex or another local stdio MCP client.
Search GitHub bounties, inspect the agreement, verify a payout wallet, claim an
exclusive assignment, submit a PR, prepare batches and follow payment status.

**Testnet only:** Base Sepolia test USDC and NEAR testnet. No real funds.
The client does not merge PRs, fund escrows, deploy contracts or transfer funds.
NearPortal's server verifies the agreed conditions and processes testnet payouts.

## Quick start

Requires Node.js 22.18 or newer (Node.js 24 recommended), npm, and a GitHub account.
Use macOS, Linux or WSL. Install:

```sh
npm install -g nearportal-mcp@0.2.0
nearportal-mcp login --server https://nearportal.com --scopes read
nearportal-mcp status
```

Sign in with GitHub in the browser and approve only the code from your own terminal.
For contributing, log in with `--scopes read,contribute`; for creating bounties,
use `--scopes read,create`. You can combine them as `read,contribute,create`.
The separate `release` scope lets you give up an assignment, not release money.

Connect Claude Code:

```sh
claude mcp add --transport stdio --scope user nearportal -- nearportal-mcp serve --server https://nearportal.com
```

Connect Codex:

```sh
codex mcp add nearportal -- nearportal-mcp serve --server https://nearportal.com
```

For another stdio client:

```json
{
  "mcpServers": {
    "nearportal": {
      "command": "nearportal-mcp",
      "args": ["serve", "--server", "https://nearportal.com"]
    }
  }
}
```

Restart or reconnect your client if needed. If its process cannot find the command,
use the absolute path returned by `command -v nearportal-mcp`.

## Try it

“Show my NearPortal account and permissions, then find available bounties.
Show the reward, deadline and payment conditions before claiming anything.”

“Show my submitted PRs and confirmed payments.”

With create permission: “Prepare two bounties on owner/repo with my criteria,
selected acceptance job, 0.01 test USDC each and a 48-hour window. Show the
validation results before creating them.”

Wallet proof is required before claiming:

```sh
nearportal-mcp wallet verify 0xYourPublicWalletAddress
```

Sign the verification message yourself in your browser wallet. Never share a
seed phrase or private key. The selected address becomes fixed for the assignment.
Use your own Git/GitHub tools to work and open a PR; then call `submit_work` to
record the exact commit before the deadline. Opening a PR alone is not submission.
The selected job must pass and the creator must merge before payment can qualify.

For a batch, fund each verified deposit address with its own exact test-USDC amount.
Never send the batch total to a single address. Check status after a timeout before
retrying with the same idempotency key.

## Credentials and disconnecting

NearPortal credentials are stored in the OS keychain where available, otherwise
in a private file outside Git checkouts. They expire after 30 days. This client
does not need a GitHub personal access token or server/custody secrets.

```sh
nearportal-mcp logout
```

You can also revoke a connected terminal at https://nearportal.com/agent/connect.
Full guide and troubleshooting: https://nearportal.com/mcp.

## Package scope

This Apache-2.0 package contains only the local MCP client and its source.
It contains no backend, database, private configuration, credentials or custody
keys. Runtime dependencies are the MCP SDK, tsx and Zod, with exact direct versions.

## Creator refund wallet

Version 0.2 requires `refundAddress` in every `prepare_bounties` item: a public
Base Sepolia wallet controlled by the creator. It is fixed in the funding agreement
and must differ from the contributor’s payout wallet. Only an owner-approved
dispute refund can return recorded unspent deposits there. A dispute cannot waive
checks or merge for developer payments. Assignment expiry does not refund funds.

The redesigned contract requires a fresh deployment. This version is not a storage
migration or an upgrade of an already funded contract.
