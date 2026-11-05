# Security

This release is a testnet hackathon demonstration, not an audited payment service.
Use NEAR testnet and Base Sepolia test assets only. Mainnet operation is unsupported.

For a suspected vulnerability, use GitHub's private vulnerability reporting on this
repository when available. Do not put credentials, private keys, user data or an
exploitable payment bypass in a public issue. Do not test against the hosted service
without permission; use the isolated local suites and simulated demo.

The GitHub verifier is trusted to report checks and merge evidence correctly. The
deposit/payout relayer is trusted to report chain receipts. The application holds
encrypted OAuth credentials and scoped NEAR worker keys; compromise of the host
remains a custody risk. Keep owner/deployment keys offline and back up the encryption
key separately from application snapshots. Retained deployment keys can change code.

See [payment rules](docs/CONTRACTS.md) for time limits, dispute authority, immutable
refund destinations and unsupported recovery cases. Never reuse an old deployment's
database with new contracts, and never infer a payout from a merge or a broadcast alone.
