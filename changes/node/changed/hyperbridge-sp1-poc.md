#bridge #experimental
# Replace the custom SP1 bridge with Hyperbridge integration

Remove the Avail-style custom guest, receiver and prover. Add a Hyperbridge
profile using the pinned, unmodified upstream guest ELF and consensus contract,
our stateful exact-leaf receiver, and a relayer with real Groth16 proof generation.
Retain the original direct-signature Snowbridge profile.

PR: pending
