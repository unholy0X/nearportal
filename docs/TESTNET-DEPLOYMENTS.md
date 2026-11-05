# NearPortal v2 testnet contracts — 2026-11-05

Both binaries were built from source `d535deb9e3f75ae52ec677f1b85e6ca0e066c29e`.
Application integration fixes can advance independently without replacing these contracts;
the contract sources are unchanged through the live application commit `2c91c87`.
These are testnet deployments, not mainnet. One bank and one USDC payout have completed on them;
see [E2E-EVIDENCE.md](E2E-EVIDENCE.md) for the receipts and how to re-check them.

| Rail | Contract account and deployment transaction signer | Root account that created/funded its account tree |
| --- | --- | --- |
| USDC / Base Sepolia | `escrow.np-20261105-dea8f2.testnet` | `np-20261105-dea8f2.testnet` |
| Bank / Monerium sandbox | `escrow.np-20261105-3a9524.testnet` | `np-20261105-3a9524.testnet` |

USDC deployment transaction: `ChPddDM8KFd4hZ4qk7VyQ8F5NczWQ4vPZWYrDreTWHxU`.
Bank deployment transaction: `EbAYoDu12HSjKMx9kJadTfZsozaFf9q9SKGoE9gmiscw`.

| Rail | NEAR deployed code hash | WASM SHA-256 |
| --- | --- | --- |
| USDC | `BqDseHbspkq8Q2aY8CiBZTLsocSaAdjRu53KEPhS5aeP` | `a0ef4dc71ce739a4d265e509b3c7a602185b38557b21c96883d4db8662fe124c` |
| Bank | `FoevKUc52uC1Kk7b3EcHCvSbmdZbpfVkMruJxXvVZW1P` | `dbf735ac36cc700b99da47722d33bf30dd5cd17a7ebff4ddd616c78bebe8140a` |

Each tree has separate `client.`, `verifier.` and `relayer.` accounts under its root.
Only these worker keys are on the VPS. Root and contract deployment keys remain offline;
the retained deployment key can upgrade code, so these are administratively controlled escrows.
They request signatures from the shared NEAR testnet service `v1.signer-prod.testnet`,
which was not deployed by NearPortal. Escrow EVM addresses are derived per bounty; the NEAR
contract account is not an address to which USDC or euros should be sent.

## Planning 100 tests

Unit tests and the 100-lifecycle simulation use no faucet funds. A real-provider rehearsal
requires NEAR test tokens, test rewards, and (for USDC) Base Sepolia gas. At 0.01 per bounty,
100 USDC bounties need 1 test USDC; 100 bank bounties need 1 simulated EUR in Monerium.
A 50/50 split needs 0.50 of each. Deposits must use each bounty's displayed instructions.

NEAR creation attaches 0.15 test NEAR per bank bounty or 0.10 per USDC bounty. Unused storage
deposit is refunded, so 15/10 NEAR for 100 creations are conservative gross advances, not
measured net costs; transaction gas and later storage growth are separate. Workers have
separate balances and finite key allowances, which must be checked during long runs.

The USDC sponsor allocates 0.00001 test ETH per escrow, plus its own transaction fees:
100 allocations total 0.001 test ETH before sponsor fees. The current built-in limit is
10 allocations per UTC day. Do not promise 100 same-day payouts without reviewing that
limit, RPC quotas and actual gas costs. The bank sandbox moves one deposit IBAN per profile;
fund and confirm pending bounties sequentially for that profile. Public RPCs and provider
timeouts can delay a run even when balances are sufficient.

One small funded payout has completed on each contract ([evidence](E2E-EVIDENCE.md)). Measure its
actual costs before scaling to 100. Old-contract payout receipts do not validate these deployments.
