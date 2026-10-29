# One slash command per client, and pull-request scope

Status: Accepted

## Command surface

The server and each client part all registered `/review-loop`, so the slash menu showed duplicate rows that behaved differently: the client row used the approval dialog and progress toasts, the server row produced only a passive transcript message and had a different cancellation interaction. Each client part now registers the command and the server exposes only the RPC they call. The name and description live in one module shared by both clients and the Desktop bundle build.

Trade-off: a host with neither client part has no slash command. The Desktop GUI API is experimental, so a host change could remove the command without an error. The plugin therefore logs a warning when the host offers no RPC, and the README gives a check. An opt-in server fallback was rejected as configuration nobody currently needs. Revisit if a headless client appears.

## Pull-request scope

`/review-loop start <PR URL|number>` reviews a GitHub pull request.

- **Resolution:** `gh pr view` supplies head, base and state. URLs are matched strictly; a bare number needs one unambiguous GitHub remote. Nothing is posted to GitHub.
- **No checkout switching:** the working tree must already be at the pull request head. Otherwise the run is refused and `gh pr checkout N` is printed. Switching branches under a user's edits was rejected as too risky. Only the missing base commit is fetched, narrowly.
- **Uncommitted edits** are refused unless `--include-uncommitted`, so unrelated local work is never silently reviewed.
- **Untracked file size:** an untracked file over 512 KiB is rejected at snapshot time (and re-checked while reading) rather than paged, so a review can always read every changed file to its end.
- **Untrusted text:** title and body go to the reviewer as data, neither is stored in status (the title is still shown in the approval preview), and are described as intent evidence only.
- **Approval** re-resolves the pull request and voids on any head, base or state change. Merged pull requests are refused; closed and fork pull requests warn.
- **Large changes:** a diff over the embed budget is read per file through the source tool's `diff` operation. The controller refuses a complete review until every changed file's diff was read to its end, and fails closed above 300 files. This proves access, not understanding. Binary changes still stop the run.
