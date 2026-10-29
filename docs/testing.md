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
- Passive synthetic messages use `resume: false`. They can remain in the inbox and must not be used as a high-frequency polling transport while the fixer is active. The status script reads the public state store without touching model context.
- Custom source/submission tools are exposed directly (`codemode: false`), so the reviewer does not require the general Code Mode execution tool.
- Location-scoped plugin instances share in-process session ownership. Unloading one location cancels only runs it owns; guards can still recognize sessions that move to another location.

The connected service used for live validation reported OpenCode 2.2.0. CLI and service versions can differ; inspect the connected service rather than inferring compatibility solely from the CLI executable.
