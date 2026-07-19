# pi-desktop-tag

Oh My Pi extension that captures desktop context and delegates a request to an agent.

## Use

```bash
# Standalone gateway and overlay
bun --cwd=packages/desktop-tag src/cli.ts

# omp extension
omp --extension packages/desktop-tag/src/extension.ts
/tag
```

`/tag [screen|window|browser] [request]` immediately captures context and sends it to the current agent; `/tag` defaults to a screen description. Region syntax is `/tag region <x> <y> <width> <height> [request]`. The standalone command prints the loopback overlay URL. Region coordinates use physical pixels: `x` and `y` are finite signed values; `width` and `height` are finite positive values.

Inside OMP, press `Ctrl+Alt+T` to capture the screen and prompt for a task.

## Security and lifecycle

The gateway binds only to loopback (`127.0.0.1`, `localhost`, or `::1`) and rejects non-loopback `Host` values. Browser HTTP and WebSocket requests must use the gateway's exact loopback origin and port. An absent `Origin` remains supported for local native clients; it does not permit a non-loopback host.

Task execution is asynchronous. A task completes only when the agent emits `agent_end`; dispatch failures emit `task.failed`. Cancellation is idempotent, rejects pending approvals, and disposes the agent session. `TagGatewayServer.stop()` is async and must be awaited so active tasks and sockets are closed before shutdown.

## Components

- `context.ts` — capture and validate desktop context.
- `router.ts` — select an executor and constrained tools.
- `events.ts` — stream overlay-facing task events.
- `worker.ts` — adapt local `AgentSession` execution.
- `gateway.ts` — serve the loopback-only HTTP and WebSocket API.
- `extension.ts` / `cli.ts` — extension and standalone entrypoints.

Phase 1 ships screenshot, region, selection, and browser-context capture with local `pi` AgentSession execution. IX Bridge DOM snapshots, native desktop actions, and remote hubs are future work.

## Capture-to-agent workflow

`src/capture/` adds an asynchronous capture workflow on top of the same gateway: capture tasks are validated, persisted (SQLite under `~/.omp/agent/capture`), executed in new or resumed oh-my-pk sessions through the `AgentSessionGateway`, and mirrored to a shared Telegram chat where replies continue the same session. Endpoints live under `/api/capture/`; see `docs/capture-to-agent.md` for architecture, configuration (`.env.capture.example`), Telegram bot setup, the security model, and troubleshooting.
