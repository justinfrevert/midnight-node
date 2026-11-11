# Hyperbridge SP1 integration

The `hyperbridge-poc` profile replaces the custom Avail-style SP1 guest, receiver
and prover. Hyperbridge's published ELF, Rust guest, `SP1Beefy.sol`, codecs and
types remain unmodified. `upstream.json` pins their revisions and hashes;
`prepare.py --check-only` rejects dirty or different checkouts. The published
program key is `0x007d1720c695842ed647a1a72e981751f9b5e26fc5ca038523b23430a1292f08`.

This requires changes to our integration. The old Gateway authenticated historical
message leaves against an SP1-proven MMR root. Hyperbridge's contract requires
the commitment's exact tip leaf and its guest does not publish that MMR root.
The [upstream BEEFY specification](https://docs.hyperbridge.network/protocol/consensus/beefy/)
explains why accepting an older leaf would hold back authority-set updates.
The new Midnight profile retains a cumulative tree of up to 64 outbound message
hashes, including retries. Empty blocks preserve its root. The unchanged guest
authenticates a later tip whose extra field commits to that tree, with an empty
parachain-header list. `MidnightHyperbridgeClient` calls the unchanged consensus
contract, stores its returned authority state and records the authenticated leaf
hash. The existing Gateway verifies message inclusion, route, nonce and custody.

The direct-signature Snowbridge build keeps its existing per-block commitments.
Use fresh genesis and fresh contracts for Hyperbridge. No existing custody or
runtime migration is implemented. The bounded history is a disposable development
profile; lifetime capacity and multi-validator rotation require further work.

## Validated live round trip — 2026-11-11

The [saved acceptance report](evidence/live-validation.json) records
`completeBridgeE2E: true`, `hyperbridgeFinalityProved: true` and
`hyperbridgeUpstreamUnmodified: true` for `ethereum-pos/run-pg8n7ysv`.
Ethereum deposit 100, Compact consumer/retirement, a failed release, authenticated
retry, and successful return of 40 all passed. Final readback after redemption
completion confirmed Compact consumer 60 / sealed escrow 40 and Ethereum custody
60 / recipient 40. Both actual Groth16 proof submissions finalized: BEEFY blocks
253 and 437, using 388,061 and 331,209 Ethereum gas respectively.

The local raw evidence is under `artifacts/snowbridge/ethereum-pos/run-pg8n7ysv`.
The report preserves its file hashes, source/program identities, receipts and
post-completion state snapshot. Both dev stacks were stopped after validation.

## Build and run

Start with the Snowbridge prerequisites in [its runbook](../snowbridge/README.md).
Use Node 22+, Rust 1.98.1, Go 1.25.3, Docker and a Wasm-capable LLVM toolchain.
On the validated Apple Silicon host, prepend Homebrew LLVM and Node 24 to `PATH`.

```bash
unset SKIP_WASM_BUILD
export CFLAGS_wasm32v1_none="-Wno-error=implicit-function-declaration"
export CFLAGS_wasm32_unknown_unknown="-Wno-error=implicit-function-declaration"
bash tests/hyperbridge/prepare.sh
SNOWBRIDGE_BUILD_DIR="$PWD/artifacts/hyperbridge/node" python3 tests/snowbridge/prepare-node.py
CARGO_TARGET_DIR="$PWD/target" cargo build --release \
  --manifest-path artifacts/hyperbridge/node/Cargo.toml -p midnight-node --features hyperbridge-poc
bash tests/hyperbridge/run.sh
```

The live test starts fresh Geth/Lodestar Ethereum PoS and a release Midnight node,
then runs deposit 100 → native issuance → Compact consumer → retirement 40 →
Hyperbridge proof → intentionally failed release → authenticated failure → retry
→ release 40 → authenticated completion. It checks final Compact consumer 60,
sealed retirement 40, Ethereum custody 60 and recipient 40. Each proof job records
the exact ELF/key, proof bytes, public values, receipts and deployed bytecode hashes.
`pos-report.py` checks finalized receipts and generates the run's `validation.json`.
An attempted run is not success evidence without that report.
After the redemption is `Completed`, `final-state.mjs` reads both Compact contracts
again at a finalized Midnight block and checks Ethereum balances at a finalized
Ethereum block. The raw Compact states and `post-redemption-state.json` are retained.

## Compatibility regression

`fixtures/midnight-live.json` contains a consensus-generated Midnight commitment
and both its tip and older message-leaf witnesses from the previous validated
single-authority run. Its provenance records the original evidence hashes.

```bash
PATH="$PWD/artifacts/snowbridge/tools/go/bin:$PATH" \
  artifacts/snowbridge/sp1-target/release/midnight-hyperbridge-probe prove \
  tests/hyperbridge/fixtures/midnight-live.json \
  artifacts/hyperbridge/sp1-beefy/elf/sp1-beefy-program \
  "$PWD/artifacts/hyperbridge/compatibility-proof"
HYPERBRIDGE_PROOF_DIR="$PWD/artifacts/hyperbridge/compatibility-proof" \
  artifacts/snowbridge/tools/foundry/forge test --root tests/hyperbridge/contracts -vv
```

The guest verifies both legitimate witnesses. Contract tests require the real
Succinct Groth16 verifier: the tip is accepted, the older leaf reverts with
`StaleMmrLeaf`, rewriting its height invalidates the proof, and altered proof/key
inputs are rejected. Adapter tests check exact-leaf storage and replay rejection.
These compatibility checks alone do not establish a complete token round trip.

The generated real proof bytes are also saved in `fixtures/compatibility`.
Omit `HYPERBRIDGE_PROOF_DIR` to run the contract regression against those fixtures
without installing a prover. The eight compatibility and adapter tests pass.

## Audit scope

Unmodified source reuse is checked mechanically. It does not certify our adapter,
runtime commitment scheme, bootstrap or the composition. The upstream audit
reports bundled with Hyperbridge cover identified older revisions; audit coverage
of the pinned SP1 guest/ELF and current consensus contract has not been established
by this experiment. The bridge retains the source BEEFY quorum trust assumption.
