# PR #1 review dispositions

Coverage: five inline comments in review 5696684512 plus the user's ten-item pasted review, deduplicated. These are implementation outcomes, not external re-approval. No thread is automatically marked resolved.

| Concern | Outcome and evidence |
| --- | --- |
| Protected/symlink bypass | Fixed: reject existing symlink components, dangling aliases and ancestors of new paths. Git tests cover protected and external targets. Hostile concurrent replacement remains outside the application sandbox guarantee. |
| Stale claims | Explicit safe recovery added; no automatic stealing. Nonce/run/host checks, dead-owner check, serialized recovery, archived claim and stopped state. Storage tests cover refused live recovery and successful explicit dead recovery. Children need human verification. |
| Backslashes | Fixed double-quoted escape handling; exact check-command regression test. |
| Full repeated hashing | Git binary working diff fingerprints tracked changes; JS hashes only untracked bytes. Unchanged tracked assets no longer consume the 64 MiB budget. Submission checks the round's file set without another snapshot. Explicit Git-output budgets remain. |
| Detached HEAD/status | Detached state is null and pinned; status works without a named branch. Git fixture exercises detached opening/snapshot. |
| Release/save races | Release closes synchronously and returns a shared promise; late saves rejected. Concurrent-release regression coverage. |
| Reverted-file blockers | Finding locations include previously flagged paths, independent of current diff membership; resolution remains explicit. |
| Status/stop cancelling | Not reproduced in the former synthetic path. Client controls now use RPC directly, never session.prompt; synthetic messages are documented as excluded from prompt hooks. Unrelated ordinary input still cancels. |
| Recovered tool errors | Typed validation/invalid-input errors followed by successful same-tool execution may recover. A native nonexistent-tool-name error can recover through a later valid submission, because no action executed. Unknown/infrastructure/authorization/unrecovered errors remain fatal. Regression and live smoke cover the tool-name case. |
| Signalling callback throw | Failures reject with cleanup-unconfirmed metadata and retain the claim. Check test injects EPERM without an uncaught exception. |
| Start after disposal | Recheck after asynchronous lease acquisition and release before rejecting. Integration test disposes during model discovery. |
| Reviewer creation cancellation | Combined cancellation/deadline passed to creation; returned late session is interrupted before scheduling work. Integration test covers stalled creation cancellation. The host must honor cancellation; unknown side effects stay fail-closed. |
| Search on unrelated symlink | Entry type is checked before containment/read; search skips symlinks, direct reads reject them. Git fixture covers external aliases. |
| Missing permission API | Native assert or V2 session.permission.create, accepting only explicit allow. No unconditional fallback. Compatibility test covers allow/ask/deny/missing. |
| Invisible output | Immediate RPC responses; TUI/Desktop dialogs and progress toasts. Durable progress through status. Native-adapter tests cover visible results without model turns; actual visual/client-version verification is separate. |

The live runner also no longer invokes a differently versioned CLI: it pins the existing local service's authenticated registration and refuses identity changes, preventing smoke-test discovery from replacing the hosting service.

## Follow-up review of 41b812a

| Finding | Disposition |
| --- | --- |
| 1. Stored process-group reuse | Fixed: stop never re-signals recorded numeric process IDs after unconfirmed cleanup. It retains the claim and reports manual investigation/recovery. Regression injects cleanup failure and verifies no subsequent signal. |
| 2. Slash path drops approval token | Fixed: native slash output includes the exact `/review-loop start --confirm …` command. RPC clients still receive the structured confirmation field. Plugin regression covers both paths. |
| 3. Unchanged-file regressions rejected | Fixed with a scope boundary: unchanged source is allowed with `introduced_by` evidence pointing into the current diff, and the target must pass normal source-access validation. Unrelated pre-existing defects remain out of scope. Integration regression covers rejection without causality and acceptance with it. |
| 4. Approval covers names, not launch definitions | Fixed for known local controls: preview shows script bodies and pre/post hooks; manifests/launch controls are protected from automatic edits and fingerprinted before each check. Modified controls stop before execution. Arbitrary transitive shell-command code is not frozen; host-authority limitations remain explicit. |
| 5. Encoded binary diff exceeds buffer | Fixed diagnostics: Git numstat rejects tracked binary changes before encoding/buffering; other max-buffer errors become actionable budget failures. A 7 MiB random binary regression avoids generic overflow errors. No truncation or partial PASS. |
| 6. Progress growth/duplicate final feedback | Addressed: 64-event ring, bounded text, dropped-event count, and one terminal delivery channel. Per-event persistence is retained intentionally for crash visibility. Regression verifies the cap and single terminal notification. |
| 7. Literal review limit | Fixed: progress derives the denominator from run.state.maxReviews, the same state used by enforcement. |
| 8. Repeated ancestor lstat | Retained deliberately. A cached safety result can become stale between file opens; each file still gets ancestor verification. No measured bottleneck justified weakening that protection. Search/read budgets remain bounded; optimization needs profiling plus a safe filesystem strategy. |
| 9. Confirmation repeats discovery | Fixed: confirmation uses scope inspection and raw control-file integrity only. A now-malformed manifest causes an explicit scope-change refusal, not a discovery parser error. The existing approval regression covers this case. |

The updated deterministic suite has 48 passing tests. These dispositions do not automatically resolve external review threads or substitute for reviewer verification.
