# OpenCode Review Loop

A controlled, globally available review-and-fix loop for OpenCode V2, using a separate GitHub Copilot-backed reviewer.

Keep the current OpenCode session as the fixer. Review in a fresh linked session with a different model lineage, then reuse that reviewer for re-review. A native controller—not a "keep going" prompt—owns rounds, checks, cancellation, and completion.

## Install once, use across projects

Requirements: OpenCode V2, Node.js 22+, Git, macOS or Linux, and an authenticated GitHub Copilot provider with a suitable reviewer model. The live integration is tested against OpenCode service **2.2.0**; other V2 releases must expose the same plugin/session contract. V1 is unsupported.

```sh
git clone https://github.com/lokeoke/opencode-review-loop.git
cd opencode-review-loop
npm test
npm run install:global
```

No package installation or runtime dependencies are needed. The installer writes one managed loader at `$XDG_CONFIG_HOME/opencode/plugins/review-loop.js`, or `~/.config/opencode/plugins/review-loop.js` by default. It leaves existing OpenCode configuration and other plugins untouched. It refuses to overwrite an unfamiliar loader.

**No project-local files or dependencies are required.** Keep this clone at its installed path: the loader imports its source directly. Re-run the installer if you move it. OpenCode watches global plugins; use `/reload` if discovery has not refreshed. Reloading stops active runs rather than continuing them automatically.

## Start a run

In your existing **Build** session, after implementing a feature:

```text
/review-loop start --base main --goal "Only authenticated owners may delete records" --check "npm test" --check "npm run lint"
```

The command is available globally, but **never runs automatically**. Starting explicitly authorizes the listed check commands and bounded automatic fixes for the supplied requirements. Checks can be any trusted project commands—not just npm scripts:

```text
/review-loop start --base main --goal "Reject anonymous deletion" --check "python -m unittest"
/review-loop status
/review-loop stop
```

Use the owning fixer session for status and stop. A new ordinary user prompt cancels the loop before changing the task. Status/report messages are admitted as passive, non-resuming session messages; depending on the client they may remain in its inbox until the next turn. **For immediate status or polling without touching model context**, use the terminal:

```sh
# From this plugin's clone; this does not contact a model.
npm run status -- /path/to/your/project
```

### Model choice

Only the reviewer selection changes; the fixer's existing model and session are preserved.

The controller considers an explicit preference list (`claude-sonnet-5.5`, `gpt-6.1-sol`, `gemini-4-argon`) against the installed Copilot catalog. It requires a different model lineage: GPT and Codex count as OpenAI; Sonnet, Opus, and Haiku count as Anthropic. Different variants are not independent lineages. Unknown lineages require an explicit same-family opt-in.

Override with an exact available model reference:

```text
/review-loop start --base main --goal "Your requirements" --check "npm test" --reviewer github-copilot/claude-sonnet-5.5
```

If no suitable reviewer is available, the run does not start. It never silently switches providers. `--allow-same-family` explicitly permits a same-lineage fallback from the selected candidates; it does not bypass authentication, availability, or tool support.

## What the controller guarantees

| Boundary | Behavior |
| --- | --- |
| Scope | Pin the merge-base SHA, branch, HEAD, and initial Git index. Review the complete branch/worktree change, including non-ignored new files. |
| Verification | Run explicit checks before every review, including the first. Record actual exit codes and reject checks that mutate fingerprinted source or the index. |
| Review | Fresh reviewer context, reused across rounds. Structured tool submission plus successful turn completion are both required. |
| Fixes | Return supported blocker/major findings to the existing fixer session. Stop on disputes; minor observations do not prolong the loop. |
| Re-review | Require explicit evidence for each prior blocking finding's resolution. Omission never proves a fix. |
| Limits | At most 4 reviews / 3 fix passes, 10 minutes per model phase, 5 minutes per check, and 45 minutes overall. |
| Stalls | Stop on unchanged/repeated source fingerprints or the same blocking finding IDs twice. |
| Exclusivity | One run per canonical worktree, enforced with an atomic filesystem claim. Different projects/worktrees remain independent. |
| Git ownership | Never stage, commit, push, merge, stash, reset, or clean reviewed projects. Detect branch/HEAD/index changes and stop. |
| Failure | Missing/incomplete results, tool/model errors, failing checks, cancellation, or exhausted limits never become PASS. |

**PASS** means a completed review has no unresolved blocker/major findings, required checks passed on that same fingerprint, and no source mutation was observed before completion. It is not proof of bug-free software, and it does not certify edits made afterward.

## Trust and scope limits

- **Use a dedicated worktree when other editors or sessions are active.** The controller detects unexpected changes during checking/review, but cannot attribute an edit to a human versus the fixer during a fix phase. Do not mix unrelated work: starting includes the entire current change set.
- Monorepo checks run from the invoking session's directory; review and exclusivity cover the containing Git worktree. Two packages in one worktree cannot run competing loops.
- Reviewers have deny-by-default session permissions and only bounded source-inspection and result-submission tools. No shell, workspace edits, MCP tools, or delegation. The fixer also loses shell/delegation during automatic fix phases; the controller owns checks.
- Automatic fixes cannot edit ignored files, dependencies under `node_modules`, Git control files, or agent/runtime instructions/configuration (`AGENTS.md`, `CLAUDE.md`, `.opencode`, `.claude`, `.cursor`, `.agents`). Changes requiring these paths need human takeover.
- This is **not an OS sandbox**. Approved checks and repository scripts execute with your host authority and may have side effects. Existing trusted OpenCode plugins remain privileged. Only run checks in repositories you trust; inspect scripts, hooks, and configuration first.
- Git-only, named branches, macOS/Linux in v1. Non-Git directories, detached HEADs, submodules/non-file entries, changed symlinks, binary changes, and oversized changes need manual review.
- Review input is capped at 192 KiB; the fingerprinted source budget is 64 MiB. Source reads are limited to 512 KiB per file and bounded/paginated output. Known sensitive filenames (`.env*`, private-key extensions, `.git`) are excluded from reviewer source tools; changing one prevents automatic review. Filename checks are not a general secret scanner.
- Failed baseline checks stop immediately; no unlimited test-repair loop or silent baseline waiver.
- The run is not resumed after reload/crash. A failed interruption retains the worktree claim; retry stop from the owning session. After a hard crash, inspect the lock owner and verify no run/check processes remain before manually archiving that exact stale lock. Never remove a live lock to force another run.

## State and privacy

State lives outside repositories under `$XDG_STATE_HOME/opencode-review-loop`, or `~/.local/state/opencode-review-loop`. New directories use mode `0700`; state files use `0600`. Each worktree has a latest-state file, an exclusive lock while running, and per-run archives. Snapshots are written in order with atomic replacement; a crash between archive/latest updates can leave the latest view behind the archive, so interrupted state is never trusted to resume execution.

Archives retain model/session identities, local paths, findings, fix summaries, check commands/results, and source fingerprints. They do not retain full diffs or check output. OpenCode's own sessions still contain the prompts, diffs, and tool results sent to models. Your provider's usage and data policies still apply. Retention is manual; do not commit or share run state without inspecting it.

## Development and proof

```sh
npm run check
npm test
# Explicit opt-in: creates a disposable repository and spends Copilot usage.
node scripts/smoke.mjs --live
```

The live smoke deliberately introduces an anonymous-access defect missed by baseline tests. It verifies review → existing-session fix → checks → same-session re-review, including the repaired guest-access behavior. Fixtures and sessions are retained locally for inspection. See [architecture decisions](docs/adr/README.md) and [test boundaries](docs/testing.md).

## Uninstall

```sh
npm run uninstall:global
```

This removes only the managed loader. It preserves your configuration, clone, run archives, and OpenCode sessions. Unloading cancels active runs; inspect their final state before starting replacements.
