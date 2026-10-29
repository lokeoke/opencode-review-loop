# Claim worktrees atomically and fail closed across runtime loss

Status: Accepted

Global availability requires cross-project isolation and protection against concurrent plugin instances. Use a canonical-worktree hash in a user-level state directory, atomic directory creation for the exclusive claim, and serialized atomic JSON replacement for latest state and per-run archives. This avoids assuming transactional guarantees from plugin storage and preserves past reviews without adding a database dependency.

A run is never reconstructed as executable work after reload or process loss. Stale or unconfirmed-interruption claims require human inspection rather than automatic lock stealing. This trades convenience after a crash for protection against duplicate work or a still-running reviewer/check. Archive and latest files are separate replacements, not a transaction; archives are written first and incomplete state cannot authorize continuation.
