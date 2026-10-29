# OpenCode Review Loop

Controlled review → fix → checks → re-review, available globally in OpenCode V2. Your existing session remains the fixer; a fresh GitHub Copilot-backed session reviews the diff using a different model lineage where available, then keeps its context for re-review.

## Install globally

Requires Node.js 22+, Git, macOS/Linux, OpenCode V2 and an authenticated Copilot provider with an eligible reviewer model.

```sh
git clone https://github.com/lokeoke/opencode-review-loop.git
cd opencode-review-loop
npm run build
npm test
npm run install:global
```

No runtime dependencies or project-local files are required. The installer writes a managed package under `~/.config/opencode/plugins/review-loop/` (or `$XDG_CONFIG_HOME/opencode/plugins/review-loop/`), containing server/TUI loaders and a prebuilt Desktop bundle. It preserves unrelated configuration and migrates the former managed `review-loop.js` loader. Unfamiliar files are not overwritten.

Keep the clone at its installed path. Reinstall after moving it. OpenCode watches plugins; use `/reload` if discovery has not refreshed. Reload cancels active runs instead of resuming them. Client UI parts require a host supporting the documented TUI or experimental Desktop plugin APIs; unsupported clients can use RPC/status directly. Visual operation in every client/version is not established by adapter tests alone.

## Use

From your existing **Build** session:

```text
/review-loop start
/review-loop status
/review-loop stop
```

**No goal required.** Bare `start` previews uncommitted changes against a pinned HEAD, including staged and non-ignored new files. It proposes existing npm test/lint scripts and asks you to approve the scope and checks. No commands or models run during the preview. Approval is one-use, session-bound, expires after ten minutes, and is invalidated by source/index changes. If no scripts are found, supply a check explicitly.

Approval shows the selected script bodies and their pre/post hooks, not just command names. Known launch-control files in the check directory and its ancestors are fingerprinted; changes stop execution before the next check and require a fresh approval. Automatic edits cannot change these control files. Confirmation revalidates integrity without re-running script discovery. The native server slash fallback also prints the exact one-use approval command.

Explicit checks authorize execution without the discovery confirmation dialog:

```text
/review-loop start --check "npm test" --check "npm run lint"
/review-loop start --base main --check "python -m unittest"
```

`--base main` reviews the complete branch/worktree change against its pinned merge base. Without it, the baseline is the current HEAD. `--goal` is optional extra context, not a required task description. Reviewers inspect the diff, surrounding source and repository conventions for concrete correctness, security, regression and test-quality problems; they must not invent acceptance criteria. The fixer transcript is not copied into reviewer context.

## Transparency

The TUI/Desktop parts render command results in native dialogs, and progress transitions as native toasts. RPC returns results directly without starting a model turn just to show text. Progress includes scope/base/files, reviewer model/session, check execution, review/fix phases, findings and terminal reasons. Status includes durable progress history and check results. Passive synthetic session messages are only a transcript fallback—not the primary UI.

Progress retains at most 64 events, with bounded message text and a dropped-event count; full findings/check results remain in their structured state fields. Final feedback uses one delivery channel: RPC notifications when available, otherwise the non-resuming transcript fallback. State is still persisted per event for crash visibility.

Use the owning fixer session for control. Ordinary new user prompts cancel automation; status/stop client commands go through RPC, not `session.prompt`, and do not trigger prompt cancellation.

For immediate terminal status without touching model context:

```sh
# From the plugin clone:
npm run status -- /path/to/project
```

Custom clients can call authenticated `POST /api/rpc/review-loop/command` with `{"input":{"sessionID":"…","text":"status"}}`. Bare-start responses may contain a `confirmation` command; execute it only after the user approves the displayed scope/checks.

## Controls

- **Bounded:** at most four reviews / three fix passes; ten minutes per model phase, five minutes per check, 45 minutes overall.
- **Independent:** fresh linked reviewer session, reused for subsequent reviews. Only Copilot is used for review. Preferred models are Claude Sonnet 5.5, GPT-6.1 Sol and Gemini 4 Argon, filtered against the current catalog and the fixer's lineage.
- **Explicit selection:** override with `--reviewer github-copilot/MODEL`. GPT/Codex variants count as one lineage; Sonnet/Opus/Haiku as another. Unknown or same-lineage selection needs `--allow-same-family`. No silent paid-provider fallback.
- **Read-only reviewer:** deny-by-default permissions; only bounded source inspection and structured submission. No shell, edits, MCP tools or delegation. Permission compatibility is checked before starting; only explicit permission allow is accepted.
- **Controlled fixes:** the existing fixer verifies blocker/major findings, adds relevant tests and reports disputes for human takeover. Minor observations do not prolong the loop. Automatic fix turns cannot execute shell/delegate; the controller owns checks.
- **Verified completion:** structured submission is provisional until the turn succeeds. Every previous blocker needs explicit resolution evidence; omission never proves a fix. Previously flagged files remain valid finding locations after reverts.
- **Causal scope:** regressions may be located in unchanged repository source when `introduced_by: {file, line, explanation}` explicitly anchors the cause in the current diff. Unrelated pre-existing findings are rejected; prior tracked findings remain re-reviewable.
- **Fail closed:** missing/incomplete output, unknown/infrastructure/authorization errors, failed checks, cancellation and exhausted limits cannot pass. Typed validation/input errors may recover only after successful same-tool execution and successful final completion.
- **No progress:** repeated code fingerprints or the same blocking IDs twice stop for human takeover.
- **Git ownership:** never stage, commit, push, merge, stash, reset or clean reviewed projects. Pin HEAD, branch/detached state and initial index; detect changes and stop.
- **Exclusive:** one atomic claim per canonical worktree, plus shared in-process session ownership across location plugin instances. Different worktrees can run independently.

PASS means no unresolved blocker/major findings after successful review and approved checks on the same recorded fingerprint. It is not proof of bug-free software and does not certify later edits.

## Scope and trust boundaries

Use a dedicated worktree when other editors/sessions are active. The controller detects unexpected changes during checking/review, but cannot distinguish a human edit from a fixer edit during the fix phase. Do not mix unrelated work. Monorepo checks use the invoking package directory, while review/exclusivity cover the containing worktree.

Automatic edits reject every symlink component, including dangling aliases and ancestors of new paths. Protected paths include `.git`, `.env*`, agent/runtime instruction/configuration paths, ignored files and `node_modules`. Fixes needing those paths require human takeover. Read/search tools skip symlinks; direct symlink reads are rejected.

Known check controls (`package.json`, `.npmrc`, Makefiles and common Python launch configuration) are also protected. This pins launch definitions, not every transitive implementation read by an arbitrary shell command. Source/tests are intentionally editable; explicit commands and trusted repository code retain host authority. Source inspection rechecks ancestor components for each file rather than caching stale symlink-safety decisions across opens.

This is **not an OS sandbox**. Approved checks and evolving repository scripts execute with your host authority and may have side effects. Existing trusted plugins remain privileged. Concurrent hostile filesystem replacement is not eliminated by path checks. Only run checks in trusted repositories.

Git worktrees on macOS/Linux are supported, including detached HEAD. Submodules/non-file entries, changed symlinks, binary or oversized changes need manual review. Review input is capped at 192 KiB; Git command output at 8 MiB. Tracked integrity uses Git's binary working diff against pinned HEAD instead of rereading all unchanged assets into JavaScript. Untracked fingerprint bytes/search scans are capped at 64 MiB; source reads at 512 KiB per file with pagination. Git filters/index flags retain their native semantics: this is not forensic whole-filesystem integrity. Sensitive-filename checks are not a general secret scanner.

## State and recovery

State stays outside repositories under `~/.local/state/opencode-review-loop` (or `$XDG_STATE_HOME/opencode-review-loop`). New directories use `0700`; state files use `0600`. Worktrees have latest-state files, per-run archives and exclusive claims. Release closes the lease synchronously, rejects late saves and shares one cleanup promise. Archives/latest are separate serialized atomic replacements, not a multi-file transaction.

Archives retain local paths, model/session identities, optional context, findings, fix summaries, approved check commands/results, progress and fingerprints—not full diffs or check output. OpenCode's own sessions retain model prompts and tool results. Retention is manual; inspect before sharing. Provider usage/data policies still apply.

Crashes/reloads never resume execution automatically. Failed interruption or process cleanup retains the claim. Retry stop from the owning session when possible. For a dead runtime, first inspect the owner and verify **all** old run/check processes stopped, then:

```sh
node scripts/recover.mjs /path/to/project RUN_ID --confirm-processes-stopped
```

Recovery serializes competing requests, validates run/nonce/host identity, refuses a live or unknown owner, archives the exact stale claim and marks its state stopped. The flag is your assertion about surviving children: a dead parent PID alone cannot prove their absence. PID reuse may conservatively block recovery. Never remove a live claim to force another run.

After unconfirmed check-process cleanup, stop does **not** retry signalling a recorded process-group number: it may have been reused. The claim remains held for explicit investigation/recovery. Session interruption can still be retried through OpenCode's session API; numeric process IDs are not treated as durable process identities.

## Development

```sh
npm run build
npm run check
npm test
# Explicit opt-in; spends Copilot usage and retains a temporary fixture/session:
node scripts/smoke.mjs --live
```

The smoke introduces an anonymous-access defect missed by baseline tests and runs goal-free review → fix → checks → re-review. It connects to the existing authenticated local service and refuses service-identity changes; it never invokes CLI discovery that could replace a differently versioned service.

See [ADRs](docs/adr/README.md), [testing](docs/testing.md), and [review dispositions](docs/review-feedback.md). No license has been selected yet.

## Uninstall

```sh
npm run uninstall:global
```

Only managed loader files are removed. Your configuration, clone, archives and sessions remain. Inspect active-run cleanup before starting replacements.
