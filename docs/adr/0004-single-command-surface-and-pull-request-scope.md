# One slash command per client, and pull-request scope

Status: Accepted

## Command surface

The server and each client part all registered `/review-loop`, so the slash menu showed duplicate rows that behaved differently: the client row used the approval dialog and progress toasts, the server row produced only a passive transcript message and had a different cancellation interaction. Each client part now registers the command and the server exposes only the RPC they call. The name and description live in one module shared by both clients and the Desktop bundle build.

Trade-off: a host with neither client part has no slash command. The Desktop GUI API is experimental, so a host change could remove the command without an error. The plugin therefore logs a warning when the host offers no RPC, and the README gives a check. An opt-in server fallback was rejected as configuration nobody currently needs. Revisit if a headless client appears.

## Pull-request scope

Recorded with the implementation below; this section is completed when that work lands.
