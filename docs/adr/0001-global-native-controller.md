# Use a global OpenCode V2 plugin to own review runs

Status: Accepted

A prompt-only command cannot enforce round limits, result ownership, or cancellation. Use one globally installed V2 server plugin whose controller schedules review and fix turns; the existing session remains the fixer and a fresh linked session is the reviewer. This couples the integration to the V2 plugin contract, but avoids external CLI authentication and output parsing. Project repositories require no installed files.

The controller will not push or merge reviewed projects. Git-only worktrees are the first supported scope. A global installation is availability, not permission to start automatically.
