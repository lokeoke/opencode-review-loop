# Separate inspection, disclosure and edit authorization

Status: Accepted

Supersedes the blanket symlink-read rejection and review-content fail-closed policy in [ADR 0002](0002-trust-boundary-and-checkpoints.md), and the untracked-size/file-count startup rejections in [ADR 0004](0004-single-command-surface-and-pull-request-scope.md). Their permission, integrity, Git ownership and client-command decisions remain in force.

## Context and decision

Intentional committed symlinks and `.env.local.example` prevented otherwise useful reviews. Filename/type vetoes conflated model-content disclosure with automatic-edit safety. We instead review leaf symlink target metadata without following the link, and permit Git-tracked text regardless of filename. Disclosure provenance includes the initial index (including newly staged files) and historical base/HEAD entries for deletion diffs. Historical membership never authorizes an untracked replacement's contents, and staging previously withheld sensitive-looking content during a run cannot grant access. Git metadata and symlink-ancestor traversal remain prohibited. Automatic-edit protections are not relaxed, including for deleted/replaced symlink entries.

Unavailable content becomes a controller-owned omission while the reviewer investigates available files. The full selected scope remains recorded, omissions never count as inspected, and partial findings survive in status/history and the final report. Any coverage gap ends as INCOMPLETE, without automatic fixes or PASS. If nothing is inspectable, approved checks may complete but no reviewer session is started. Complete integrity remains mandatory: authorization, source/index/check-definition changes, failed checks, unknown operational failures and exhausted fingerprint budgets still stop execution.

## Consequences

- Committed/staged examples and intentional links need no exclusion flags or repository changes. Git/native metadata and the existing completion contract suffice; no dependency or configuration system is added.
- Tracked status is deliberate disclosure authorization, **not secret detection**. Current modifications and deleted diff content may contain real credentials and reach the provider, sessions or findings. Untracked sensitive-looking content is withheld; ignored untracked files stay outside scope.
- Expected content omissions are distinct from operational errors. Reports bound displayed omission details while retaining the complete controller-side list. Withheld files do not consume useful inspection capacity.
- Raw bytes are retained for integrity. Symlink metadata is escaped; non-UTF-8 diff lines use labelled hex. Binary/submodule content and oversized untracked text remain unverified rather than being silently accepted.
- Filesystem checks still do not provide an OS sandbox or defeat hostile concurrent replacement. Submodule Git-entry integrity does not certify nested worktrees. Git filters/index flags retain their native semantics.

## Alternatives rejected

Keeping blanket filename/type failures sacrifices useful review without proving secrets are absent. Following symlinks breaks containment. Silently skipping files and allowing PASS misrepresents coverage. Per-path approval/configuration would add policy machinery where the chosen fixed distinction—tracked disclosure versus strict edit safety—already expresses the user's intent.
