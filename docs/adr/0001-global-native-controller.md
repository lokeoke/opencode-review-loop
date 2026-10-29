# Global native controller with goal-free review and visible clients

Status: Accepted. Amended by [0004](0004-single-command-surface-and-pull-request-scope.md) (command surface)

The user wants an ordinary diff review, not a workflow that requires restating acceptance criteria. Bare `start` therefore previews uncommitted changes against pinned HEAD; an explicit base selects branch/worktree review. Optional goal text adds context without becoming mandatory. The reviewer gets source/diff evidence, not the fixer's persuasive transcript, and must label inferred intent rather than invent requirements.

A server plugin owns bounded scheduling, session identity, check execution and durable state. The original session remains the fixer; a fresh linked Copilot session uses a different model lineage where available and is reused for re-review. Compared with prompt-only orchestration this has more integration code, but limits and completion are enforced outside the models. Compared with external CLIs it avoids another authentication/session adapter.

Passive synthetic messages proved insufficient for visible feedback. Client parts call a shared JSON-Schema RPC contract, return command results immediately through native dialogs, and render progress events through native toasts. Durable progress is available through status when events are missed. TUI and experimental Desktop entries use host-provided SDKs; no runtime dependency bundle is required. The plugin uses `review-loop`, not the host-reserved `opencode` namespace.

Bare start discovers existing npm test/lint scripts without executing them, previews the scope, and requests explicit approval. Approval is session-bound, one-use and expiring; a changed source/index fingerprint invalidates it. Explicit check arguments are direct authorization. Repositories without discoverable scripts require an explicit command rather than guessed execution.

The preview includes script bodies/pre/post hooks. Confirmation only revalidates scope and pinned control-file bytes, not discovery. RPC progress is a bounded diagnostic history, not an unbounded event stream or a second copy of full findings.

Global installation needs no per-project files. Client-version compatibility and actual visual rendering remain separate integration gates; adapter tests alone do not prove every client displays the UI correctly.
