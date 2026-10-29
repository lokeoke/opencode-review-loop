# Restrict reviewers and preserve user Git ownership

Status: Accepted

Reviewers receive a fresh session with deny-by-default permissions, scoped source-reading tools, and a validated result-submission tool. Session completion, not the submission itself, determines whether a review is usable. This is an application-level boundary, not an OS sandbox; trusted host plugins remain privileged.

Checks are explicit user-supplied commands executed by the controller with real exit codes and deadlines. Their output is not retained, avoiding accidental secret logging. Checks and repository scripts still run with the user's host authority.

Reviewed projects are never automatically staged, committed, pushed, or merged. Durable findings and source fingerprints replace automatic checkpoint commits: this preserves mixed indexes and avoids hooks changing the final reviewed code. The plugin's own development repository uses incremental commits separately.
