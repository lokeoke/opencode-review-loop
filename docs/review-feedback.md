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
