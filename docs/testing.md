# Agreed behavioral test boundaries

Tests observe public commands, controller behavior, OpenCode API interactions, real disposable Git worktrees/check processes, installation, and public state access. OpenCode model/session APIs are faked at the external boundary in deterministic tests; internal collaborators are not mocked. No real model calls occur during `npm test`.

Implementation started with failing tests for plugin registration and each new behavior slice. Tests and the minimal implementation were developed together, rather than writing a speculative complete suite first.

## Gates

- `npm run check`: syntax-check all JavaScript source, scripts, and tests.
- `npm test`: controller gates/resolutions, scope/index preservation, source restrictions, check failures/cancellation, global install/uninstall/collision protection, worktree exclusivity/archiving, and native session orchestration.
- `node scripts/smoke.mjs --live`: an explicitly usage-consuming, end-to-end Copilot run in a standalone temporary Git repository with no project-local OpenCode files and no npm requirement in the fixture.

## Live integration findings

- OpenCode's model list carries a location/data envelope; session operations return their native domain objects.
- Omitted model variants may normalize to `default`; equality must account for this without treating genuinely different variants as equal.
- Structured submission is provisional: session success and unchanged source are checked before accepting it.
- Passive synthetic messages use `resume: false` and are only a transcript fallback. Actual client controls use RPC dialogs/progress events. TUI/Desktop adapter tests cover visible results without model turns; actual visual verification in each client is a separate gate.
- Custom source/submission tools are exposed directly (`codemode: false`), so the reviewer does not require the general Code Mode execution tool.
- Location-scoped plugin instances share in-process session ownership. Unloading one location cancels only runs it owns; guards can still recognize sessions that move to another location.

The connected service used for live validation reported OpenCode 2.2.0. An installed 2.0.25 CLI was discovered replacing that service during API discovery, interrupting smoke runs. The runner now connects to the already-running authenticated local service and refuses identity changes; it never starts/replaces the service or logs its credentials.

Regression coverage now includes permission API allow/ask/deny/missing behavior, command quoting, bare-start preview/approval invalidation, symlink aliases/dangling targets, detached HEAD, concurrent release/late saves, live/dead-owner recovery, disposal during startup, cancelled reviewer creation, process signalling failures and harmless unknown-tool-name recovery. See [review dispositions](review-feedback.md).

## Latest proof

- 48 deterministic tests passed, including native-adapter output, script-definition approval, launch-definition mutation guards, unchanged-file causal findings, cached-process signalling refusal, bounded progress and large-binary diagnostics.
- Syntax checks and whitespace checks passed.
- Goal-free live smoke passed in two reviews on the existing authenticated 2.2.0 service: the reviewer found anonymous deletion, the original GPT fixer repaired it, checks passed, and the same Claude reviewer cleared it.
- The service advertises the installed `review-loop` package's server, TUI and GUI parts as active. This proves discovery, not visual rendering in every client/version; no screenshot-based visual claim is made.
