# Contributing

Use Node.js 24 and Docker. From the repository root, run `make install check test build`
and `make contracts`. The application tests use temporary storage, fixture credentials
and loopback-only providers. They must not require private environment files or wallets.

For the browser/MCP demo, install the pinned Chromium binary with
`cd apps/server && npx playwright install chromium`, return to the root, and run
`make demo`. A successful simulation is not evidence of a real testnet payment.

Include regression coverage for payment, permission, idempotence or concurrency changes.
Explain changes to contract methods and JSON types in `docs/CONTRACT-ABI-CHANGES.md`.
Do not change the locked Aurora Portal design assets without a product decision.

Keep environment files, credential files, runtime databases and generated audit output
out of commits. Scan staged changes for secrets before committing. Use conventional
commit messages and actual commit dates. Deployment, package publication and movement
of test assets are separate operational actions; local test commands perform none.
