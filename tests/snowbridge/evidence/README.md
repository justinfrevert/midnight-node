# Saved local validation evidence

These small reports preserve historical local PoC results for public review.
They do not claim a new live run or attest the exact source of a future commit.
The recorded baseline was node revision
`5b9e6724ad0abc1570d43b66b7d568ee4511faf6` plus the then-uncommitted bridge work.

| Report | Scope |
| --- | --- |
| [26 October](run-mjrg6180.validation.json) | Full two-way token flow with real SP1 proofs and runtime committee witnesses; 197 raw evidence hashes. |
| [25 October](run-oiulvrxd.validation.json) | Full SP1 token flow before committee-witness protection; 145 raw evidence hashes. |
| [23 October](run-fllxkhdn.validation.json) | Full direct-signature token flow before SP1 integration; 65 raw evidence hashes. |
| [Committee boundary](committee-boundary-validation.json) | Real Groth16/EVM regression for deferring block 176 and verifying blocks 184 and 256; not a full token-flow run. |
| [Native compatibility](native-compatibility.json) | Earlier native BEEFY format experiment; no SP1 proof generation or EVM acceptance. |

The three full-flow reports and committee-boundary report are byte-for-byte
copies. The native experiment's `sourceRun` field was changed from a personal
absolute path to a repository-relative path. [manifest.json](manifest.json)
records original and published SHA-256 hashes and the sanitization performed.
All 407 raw files referenced by the three full-flow reports, plus the boundary
report's raw evidence, were checked against their hashes when preparing this snapshot.

Raw logs, database snapshots, proving inputs, dependency checkouts and node
binaries remain under ignored `artifacts/snowbridge/`. They are not bundled here.
Within each full-flow report, `sha256` paths are relative to that run's original
directory, identified by `rawEvidenceBase` in the manifest. The boundary report's
paths are relative to `artifacts/snowbridge/`. Retain a separate raw artifact
archive if those historical runs must be audited or recovered in full. A hash
manifest alone is not an independent attestation or a substitute for raw evidence.

## Recheck the public proof

The saved custom-guest Groth16 fixture and checkpoint remain historical evidence
for commit `b59e728cc`. Their receiver and executable test have been removed.
For the replacement's reproducible proof and contract checks, see the
[Hyperbridge runbook](../../hyperbridge/README.md).
