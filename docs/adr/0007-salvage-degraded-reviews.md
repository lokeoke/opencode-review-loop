# Salvage a submitted review when its turn later fails

Status: Accepted

Narrows the rule that a structured submission is provisional until its turn succeeds (see [ADR 0003](0003-exclusive-auditable-run-state.md) and the README "Verified completion"). Authorization, checks, cancellation and Git-ownership decisions remain in force.

## Context and decision

A reviewer submitted four major findings, then one failed read-only `review_loop_source` call made the turn "unrecovered". The whole review was discarded, the fixer never ran, and `status` showed raw JSON. Discarding complete, structured findings because the turn ended badly made the loop fragile and useless.

A reviewer turn that fails **after** a valid submission is now accepted as a **degraded** review:

- Qualifying causes: phase timeout (`timeout`), provider/model failure (`model-error`, including `session.outcome` other than succeeded and message errors) and truncated or filtered responses (`length`). `outcome: 'failed'` does not say whether the failure was model-side or infrastructure-side; both are `model-error`.
- Never salvaged: stop, the overall deadline, plugin unload, new user input (all detected through the run's abort signal), unrecovered non-source tool errors, session agent/model drift, and a turn with no stored submission.
- Findings are accepted and drive fix, checks and re-review as usual. The round counts against `--max-reviews`.
- A degraded review cannot clear earlier blockers. If earlier blockers exist and it no longer reports them, the run ends INCOMPLETE ("cannot verify").
- A degraded review with no blockers ends INCOMPLETE, never PASSED. A later non-degraded review can PASS.
- State records `history[n].degraded = { cause }`; `status` and the terminal report label the round.
- A failed read-only source call is tolerated when a submission completes after it.

## Consequences

- One flaky tool call or truncated closing message no longer wastes a full review and its cost.
- PASS still requires a complete, non-degraded, successful review of the final code.
- The reviewer's findings from a degraded turn are less trustworthy than those from a clean turn; labelling keeps that visible.

## Alternatives rejected

Never salvaging: it throws away complete findings and cost. Salvaging fully: a clean degraded review could PASS on an unconfirmed turn. Re-prompting the reviewer to re-confirm: adds a turn that may fail the same way, and the same-code re-review would hit the no-progress rule.
