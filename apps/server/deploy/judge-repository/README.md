# NearPortal judge task repository

This minimal CSV task is a sandbox walkthrough for NearPortal. It has no credentials,
deployments, package installation, or real-money transactions. The default implementation
is deliberately incomplete; acceptance tests are fixed before any bounty is funded.

The operator prepares five independent tasks. On branch `codex/nearportal-task/judge-1`,
replace only `src/csv-1.mjs` with `solution/csv.mjs`. For judge-2 through judge-5, replace only
the corresponding numbered source file. Never modify the shared tests/workflow after funding.
Each prepared branch has its own commit SHA. The acceptance suite chooses only that task's
source from the strictly validated PR branch name. Tasks touch different files, so five judges
can merge independently without competing patches or making another prepared task obsolete.
Judges claim a funded task in
NearPortal, prepare a fork under their actual GitHub identity, and submit the prefilled PR.
The `acceptance` job tests the exact submitted commit. A qualifying client squash merge
triggers the separately deployed NearPortal escrow's sandbox payout.

Operator settings: enable squash merges, allow fork PR workflows, keep this repository public,
and create no secrets or privileged workflows here. Protect `.github/workflows/acceptance.yml`,
`test/acceptance.test.mjs` and `package.json` in each NearPortal bounty policy.

See the NearPortal application README for the hosted demo configuration and trust boundaries.
