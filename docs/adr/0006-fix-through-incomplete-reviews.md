# Keep the review-fix loop running through incomplete reviews

Status: Accepted

Supersedes the "no automatic fixes on any coverage gap" rule in [ADR 0005](0005-inspection-disclosure-and-incomplete-reviews.md). Its disclosure, omission and edit-protection decisions remain in force.

## Context and decision

A run reviewed 14 files, reported two major findings, and ended INCOMPLETE because one new 512 KiB+ file was an omission. The fixer never ran, so the loop's purpose, `review -> fix -> checks -> re-review`, was defeated by a coverage gap unrelated to the findings.

Coverage and actionability are now separate:

- Omissions no longer block the fix phase. Blocker/major findings from the inspected files go through fix, checks and re-review, with explicit resolutions for every earlier blocker.
- Omissions still forbid PASS. With no blockers left and omissions present, the run ends INCOMPLETE; at the review cap it ends STOPPED. A fix in an omitted file cannot be verified.
- `complete` means every available file was inspected; the controller reports omissions separately.
- A review that is `complete=false` with no controller omissions (the reviewer skipped files) is retried once in the same round. Omissions from size, protection or binary content never retry.
- A disputed blocker/major goes to the reviewer: the fixer's rationale is in the next review, which withdraws or keeps the finding. A kept finding gets one more fix pass; disputing it again stops for a human.
- `--max-reviews N` sets the review cap (default 4, ceiling 10). A review that only judges a dispute on unchanged code does not count against it. The 45-minute deadline and phase timeouts are unchanged and may bind first.
- New text files up to 4 MiB are read through the existing per-file diff paging instead of being omitted. The existing fingerprint budget bounds total bytes read.

## Consequences

- The loop converges on available code even when some files cannot be read; reports state what was never verified.
- More content can reach the provider (up to 4 MiB per new file). Tracked-versus-untracked disclosure rules are unchanged.
- Paging a large file costs reviewer time and usage; an unfinished read becomes an incomplete review, not a pass.
- Run state gains `pendingDisputes` and `disputedIds`; older archives omit them and remain loadable.
- Deeper runs spend more Copilot usage.

## Alternatives rejected

Retrying incomplete reviews generally: size omissions are deterministic, so retries only burn usage. Keeping stop-on-incomplete: it hides actionable blockers behind unrelated gaps. Allowing PASS over omissions: it misrepresents coverage. A dedicated dispute-judge phase: it adds a phase, tool and persisted state where the next review prompt carries the same information.
