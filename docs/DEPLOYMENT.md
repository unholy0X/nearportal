# Fresh testnet deployment

Run the isolated checks before creating accounts or funding anything:

```sh
make install check test build
make contracts
make demo
```

Contract builds use the pinned cargo-near Docker image in `scripts/contracts.sh`.
Record the resulting WASM code hash and source commit. Create a reviewable plan:

```sh
cd apps/server
npm run testnet:plan -- --wasm=/absolute/path/to/reviewed.wasm --rail=usdc
```

The command prints the fresh account names, code hash, exact role budgets and a plan
digest. It makes no network calls. Repeat with the same `--directory` and
`--prepare-keys` to create private local key files. Create/fund **only that testnet root**
with its printed public key; never disclose private keys. After reviewing the exact
plan, `--apply --confirm=<digest>` creates accounts, deploys and initializes the
contract, and sets the creator allowlist. It does not create or fund bounties.
Retries reconcile account keys, code hash and configuration; a different binary or
plan requires a new directory. No in-place upgrade is supported.

Keep root and contract keys offline. Copy only the creator, verifier and relayer files
to a private VPS directory readable by container uid 1000. Configure a new private
environment file with production OAuth/webhook/encryption credentials, fresh contract
and role IDs, the testnet RPCs, and the approved source's settings. Never reuse old task
storage with new contract IDs. Keep real USDC disabled. The bank rail is disabled by default;
enable it only after deploying and checking its own fresh v2 contract as described below.

Use `deploy/compose.vps.yaml` for an existing shared VPS. It has one app, its own data
volume, and a loopback-only listener. It does not install a proxy or bind ports 80/443.
Do **not** use `apps/server/compose.public.yaml` beside an existing production proxy.

On the VPS, create a private, gitignored `.env.deploy` in the reviewed checkout
(mode `600`) containing these path/project settings. Provider secrets stay in the
separate environment file:

```sh
NEARPORTAL_PROJECT=nearportal-v2
NEARPORTAL_ENV_FILE=/private/path/nearportal-v2.env
NEARPORTAL_KEYS_PATH=/private/path/nearportal-v2-worker-keys
NEARPORTAL_PORT=3211
```

For both testnet payment rails, prepare a second plan with `--rail=bank` in a different private
directory. Never replace the USDC account or reuse its contract storage. Configure the bank's
`ESCROW_CONTRACT_ID`, `CLIENT_ACCOUNT_ID`, `OWNER_ACCOUNT_ID`, `GITHUB_VERIFIER_ACCOUNT_ID`
and `RELAYER_ACCOUNT_ID`; mount its three worker keys alongside the USDC worker keys.
Add both reviewed hashes to `MARKET_VERIFIED_CODE_HASHES`. Set `NEARPORTAL_BANK_ENABLED=1`
in `.env.deploy`, and `TASK_BANK_ENABLED=1`, `NEARPORTAL_USDC_PILOT=0` in the private app
environment. The old USDC-only flag deliberately refuses a bank-enabled configuration.
Keep `TASK_PAYMENT_MODE=sandbox`, `NEAR_NETWORK=testnet`, `MONERIUM_CHAIN=basesepolia`,
and `MONERIUM_API=https://api.monerium.dev`. Supply the sandbox-only Monerium credentials
and legacy `TASK_CLIENT_IBAN` privately; never commit them. The startup probes require each
rail's matching configuration and v2 interface. Run the preflight **without** `--usdc-only`.

Bank creators connect their own Monerium sandbox Private application in Settings and save
their refund bank details under Payout details before publishing. Publication freezes these
details; subsequent settings changes do not redirect an existing refund. Contributors use
a different payout IBAN. One Monerium sandbox profile has one movable deposit IBAN: fund
and confirm each pending bounty before requesting the next funding destination for that
profile. An uncertain bank create requires reconciliation, not blind retry.

Run `make deploy`. Both deployment and backup commands load `.env.deploy`, so
subsequent `git pull` and `make deploy` need no repeated configuration. `make backup`
creates a consistent private snapshot and copies it to the gitignored `backups/`
directory (override with `NEARPORTAL_BACKUP_DIR`). Preserve the encryption key
separately and verify restores before cutover.

`make deploy` tags the image with the source commit, builds it, and waits for only
this project's app to become healthy. It never runs `down`, prunes Docker resources,
or deletes volumes. Keep the existing deployment and its historical receipts intact.
The existing proxy should continue serving it until the new stack passes the E2E.
Changing nearportal.com's upstream is a separate final cutover through the existing
proxy management tool. Future maintenance is `git pull` followed by `make deploy`.

Before cutover, verify scoped keys, role configuration, code hash, testnet token/chain,
GitHub OAuth callback, webhook redelivery, and backup/restore. Run the testnet preflight
against the intended private environment file. Its allowlisted code hash is an
operator assertion after review; it is not proof of an actual payout.

Then create two tiny test bounties through MCP with an explicit creator refund wallet,
review the two funding addresses/amounts, manually fund them, verify a distinct
contributor wallet, claim, submit PRs, verify checks, merge as the creator and confirm
payout receipts. Also test a dispute blocks settlement and `Resume` preserves all
verification requirements. Record source commit, contract hash, accounts, escrow
addresses, NEAR authorizations and Base Sepolia receipts. Only that evidence validates
this deployment. Do not label old deployment receipts as results for the new contract.
