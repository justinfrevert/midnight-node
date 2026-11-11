#bridge #experimental
# Retain message history for the Hyperbridge development profile

Add the opt-in hyperbridge-poc runtime profile. Retain a cumulative commitment
to up to 64 outbound message hashes so unchanged Hyperbridge SP1 proofs of a
later BEEFY tip can authenticate older redemptions. Reject history overflow
before accepting another message. Use fresh genesis; no migration is provided.

PR: pending
