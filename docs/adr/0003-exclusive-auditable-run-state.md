# Exclusive, auditable state with explicit recovery

Status: Accepted for this unmerged implementation

Global availability requires cross-project isolation and protection across location-scoped plugin instances. Use canonical-worktree hashes in a user-level state directory, atomic directory creation for claims, and serialized atomic JSON replacement for latest state/per-run archives. A shared in-process registry follows session ownership across locations; cleanup cancels only runs owned by that plugin instance.

Lease release closes synchronously, rejects late saves, and shares one release promise. This prevents save/release/finalizer races from removing a replacement claim or overwriting its latest state. Run/nonce identity is checked before cleanup. Archives and latest state are separate atomic replacements, not a transaction.

Runtime loss never reconstructs executable work. Instead of leaving users with only manual lock deletion, provide an explicit recovery operation: serialize recovery, validate run/nonce/host identity, refuse live or unknown ownership, recheck before archiving the exact claim, and mark the old run stopped. The operator must explicitly confirm all surviving run/check processes stopped. A dead parent PID is insufficient proof; PID reuse conservatively blocks recovery rather than risking duplicate work.

Cancellation applies to reviewer creation as well as running turns/checks. A late returned session must be interrupted before scheduling work. Startup rechecks disposal after asynchronous acquisition. Failed interruption/signalling retains ownership and reports unconfirmed cleanup; it is not success.

Numeric process-group IDs are not durable identities. After check cleanup becomes unconfirmed, stop never re-signals the stored number, because the group may have been reused. The run ends, the fixer session is released, and the claim is retained and re-labelled with the check process's PID so explicit recovery refuses a live process and accepts a dead one. This avoids both a potentially destructive automatic retry and a session that stays locked until the host restarts.

This is deliberately less convenient than automatic lock stealing, but recovery is available without pretending process liveness can be inferred perfectly.
