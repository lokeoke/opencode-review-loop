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
/review-loop            # same as /review-loop start: preview, then approve
/review-loop 64         # a pull request URL or number; flags also imply start
/review-loop status
/review-loop stop
```

`start` is the default: a bare `/review-loop`, or any first argument other than `status` or `stop`, previews a start and asks for approval. Nothing runs until you approve. `/review-loop start …` still works.

**No goal required.** Bare `start` previews uncommitted changes against a pinned HEAD, including staged and non-ignored new files. It proposes existing npm test/lint scripts and asks you to approve the scope and checks. No commands or models run during the preview. Approval is one-use, session-bound, expires after ten minutes, and is invalidated by source/index changes. If no scripts are found, supply a check explicitly.

Approval shows the selected script bodies and their pre/post hooks, not just command names. Known launch-control files (package manifests, Makefiles, pytest/tox/pyproject/setup, conftest, Jest/Vitest/ESLint/Babel/Playwright/TypeScript configs, pom.xml, build.gradle, go.mod) are fingerprinted from the check directory up to the worktree root; changes stop execution before the next check and require a fresh approval. Automatic edits cannot change these control files. Confirmation revalidates integrity without re-running script discovery.

Explicit checks authorize execution without the discovery confirmation dialog:

```text
/review-loop start --check "npm test" --check "npm run lint"
/review-loop start --base main --check "python -m unittest"
```

`--base main` reviews the complete branch/worktree change against its pinned merge base. Without it, the baseline is the current HEAD. `--goal` is optional extra context, not a required task description. Reviewers inspect the diff, surrounding source and repository conventions for concrete correctness, security, regression and test-quality problems; they must not invent acceptance criteria. The fixer transcript is not copied into reviewer context.

### Reviewing a pull request

`/review-loop start https://github.com/owner/repo/pull/64` (or just `64`) reviews that pull request's changes against its merge base. Requirements: the GitHub CLI (`gh`) signed in, and the checkout already at the pull request head (`gh pr checkout 64`; the plugin never switches branches). Uncommitted local edits are refused unless you pass `--include-uncommitted`. Merged pull requests are refused; closed and fork pull requests show a warning. Nothing is posted to GitHub. Pull request title and body are treated as untrusted data. Diffs too large to embed are read file by file to their end. Every review, of a pull request or not, must inspect each changed file through the source tool before it can be complete; see **Inspected coverage** below. This proves access, not understanding. Binary changes and more than 300 files stop the run.

## Transparency

The TUI/Desktop parts render command results in native dialogs, and progress transitions as native toasts. RPC returns results directly without starting a model turn just to show text. Progress includes scope/base/files, reviewer model, reasoning variant and session, check execution, review/fix phases, findings and terminal reasons. Status includes durable progress history, check results, and any policy denials (resource and reason). A denied edit says which path was refused and why, for example a directory resource, a protected control file, or an ignored path. The terminal report is also written to the transcript as a passive, non-resuming message. It names the reviewer session and quotes the reviewer's closing text (bounded, shown as unverified model text), so a caveat written after a structured submission is visible; status keeps the same text as `reviewerNote`.

`/review-loop` is registered once by each client part (TUI and Desktop), never by the server, so the slash menu shows a single entry. The server only exposes the RPC those clients call. A host with neither client part has no slash command; the plugin logs a warning at load, and the RPC endpoint below still works. If `/review-loop` is missing, check that the plugin reports its `tui` or `gui` feature as active, then `/reload`. Windows opened before an upgrade can show the old command until reloaded.

Progress retains at most 64 events, with bounded message text and a dropped-event count; full findings/check results remain in their structured state fields. The terminal report is always written to the session transcript (non-resuming) and also sent as an RPC notification, so clients without a TUI/Desktop part still see the result. Each channel receives it once. State is still persisted per event for crash visibility.

Use the owning fixer session for control. Ordinary new user prompts cancel automation; status/stop client commands go through RPC, not `session.prompt`, and do not trigger prompt cancellation.

For immediate terminal status without touching model context:

```sh
# From the plugin clone:
npm run status -- /path/to/project
```

Custom clients can call authenticated `POST /api/rpc/review-loop/command` with `{"input":{"sessionID":"…","text":"status"}}`. Bare-start responses may contain a `confirmation` command; execute it only after the user approves the displayed scope/checks.

## Controls

- **Bounded:** at most four reviews / three fix passes; ten minutes per model phase, five minutes per check, 45 minutes overall.
- **Independent:** fresh linked reviewer session, reused for subsequent reviews. Only Copilot is used for review. Preferred models, strongest first, are Claude Opus 5.5, GPT-6.1 Sol, Claude Sonnet 5.5 and Gemini 4 Argon, filtered against the current catalog and the fixer's lineage. The reviewer runs at the model's `high` reasoning variant when offered; `--reviewer-variant NAME` selects another listed variant. Deeper review uses more Copilot usage and time.
- **Explicit selection:** override with `--reviewer github-copilot/MODEL`. GPT/Codex variants count as one lineage; Sonnet/Opus/Haiku as another. Unknown or same-lineage selection needs `--allow-same-family`. No silent paid-provider fallback.
- **Read-only reviewer:** deny-by-default permissions; only bounded source inspection and structured submission. No shell, edits, MCP tools or delegation. Permission compatibility is checked before starting; only explicit permission allow is accepted.
- **Controlled fixes:** the existing fixer verifies blocker/major findings, adds relevant tests and reports disputes for human takeover. Minor observations do not prolong the loop. Automatic fix turns cannot execute shell/delegate; the controller owns checks.
- **Inspected coverage:** a complete review must open every changed file with the source tool (`read`, or its `diff` paged to the end; oversized diffs need the `diff`). The reviewer is told to trace callers and tests before submitting, and to submit last. It must list `limitations` it could not verify; any limitation makes the review incomplete, which stops the run instead of passing.
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

The same control files are protected from automatic edits repo-wide, and the fixer prompt says so, so it reports a disputed finding instead of attempting a denied edit. This pins launch definitions, not every transitive implementation read by an arbitrary shell command. Source/tests are intentionally editable; explicit commands and trusted repository code retain host authority. Source inspection rechecks ancestor components for each file rather than caching stale symlink-safety decisions across opens.

This is **not an OS sandbox**. Approved checks and evolving repository scripts execute with your host authority and may have side effects. Existing trusted plugins remain privileged. Concurrent hostile filesystem replacement is not eliminated by path checks. Only run checks in trusted repositories.

Git worktrees on macOS/Linux are supported, including detached HEAD. Submodules/non-file entries, changed symlinks, binary or oversized changes need manual review. Review input is capped at 192 KiB; Git command output at 8 MiB. Tracked integrity uses Git's binary working diff against pinned HEAD instead of rereading all unchanged assets into JavaScript. Untracked fingerprint bytes/search scans are capped at 64 MiB; source reads at 512 KiB per file with pagination. A new (untracked) file above 512 KiB is rejected with a message naming it, including one the fixer creates mid-run, which ends that run; commit, ignore or split such files. Git filters/index flags retain their native semantics: this is not forensic whole-filesystem integrity. Sensitive-filename checks are not a general secret scanner.

## State and recovery

State stays outside repositories under `~/.local/state/opencode-review-loop` (or `$XDG_STATE_HOME/opencode-review-loop`). New directories use `0700`; state files use `0600`. Worktrees have latest-state files, per-run archives and exclusive claims. Release closes the lease synchronously, rejects late saves and shares one cleanup promise. Archives/latest are separate serialized atomic replacements, not a multi-file transaction.

Archives retain local paths, model/session identities, optional context, findings, fix summaries, approved check commands/results, progress and fingerprints—not full diffs or check output. OpenCode's own sessions retain model prompts and tool results. Retention is manual; inspect before sharing. Provider usage/data policies still apply.

Crashes/reloads never resume execution automatically. A recorded stop includes the phase where it stopped; older records may not have it. Findings and partial edits from a stopped run are not verified: inspect status and changes before starting a new run with the normal scope and check authorization. An unload report does not establish what triggered the unload. A crash may leave only stale state and a claim rather than a terminal report. Failed interruption or process cleanup retains the claim. Retry stop from the owning session when possible. For a dead runtime, first inspect the owner and verify **all** old run/check processes stopped, then:

```sh
node scripts/recover.mjs /path/to/project RUN_ID --confirm-processes-stopped
```

Recovery serializes competing requests, validates run/nonce/host identity, refuses a live or unknown owner, archives the exact stale claim and marks its state stopped. The flag is your assertion about surviving children: a dead parent PID alone cannot prove their absence. PID reuse may conservatively block recovery. Never remove a live claim to force another run.

After unconfirmed check-process cleanup, the run ends and the fixer session is released immediately; nothing re-signals a recorded process-group number, which may have been reused. The worktree claim is retained and re-labelled with the check process's PID, so `scripts/recover.mjs` succeeds once that process is gone and refuses while it is alive. No OpenCode restart is needed. Session interruption can still be retried through OpenCode's session API; numeric process IDs are not treated as durable process identities.

## Development

```sh
npm run build
npm run check
npm test
# Explicit opt-in; spends Copilot usage and retains a temporary fixture/session:
node scripts/smoke.mjs --live
```

The smoke introduces an anonymous-access defect missed by baseline tests and runs goal-free review → fix → checks → re-review. It connects to the existing authenticated local service and refuses service-identity changes; it never invokes CLI discovery that could replace a differently versioned service. Before running, confirm that service uses the candidate build and that a reload will not interrupt another run. A no-execution preview checks for this version's cancellation warning, but that marker alone cannot prove the exact build identity. The smoke checks the reviewer transcript for completed source and submission calls; if either is missing, it reports an inconclusive compatibility result rather than a pass.

See [ADRs](docs/adr/README.md), [testing](docs/testing.md), and [review dispositions](docs/review-feedback.md). No license has been selected yet.

## Uninstall

```sh
npm run uninstall:global
```

Only managed loader files are removed. Your configuration, clone, archives and sessions remain. Inspect active-run cleanup before starting replacements.
