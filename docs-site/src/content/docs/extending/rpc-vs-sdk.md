---
title: RPC vs SDK
description: Choose between embedding omp in your process (SDK) and driving it from another process (RPC) — process model, capabilities, isolation, and when to use which.
coverage: B
---

Both the [SDK](/oh-my-pi/extending/sdk/) and [RPC](/oh-my-pi/extending/rpc/) drive the same `AgentSession` engine — the RPC server is a thin command layer over the session, so prompting, steering, event streams, compaction, retries, model/thinking control, and session switching behave identically. The difference is where the session lives and what crosses the boundary.

| Dimension | SDK (`createAgentSession()`) | RPC (`omp --mode rpc`) |
| --- | --- | --- |
| Process model | In-process: session objects live in your Bun/Node process | Out-of-process: a separate `omp` process speaking newline-delimited JSON over stdio |
| Language | TypeScript / JavaScript (Bun or Node) | Any language; bundled TypeScript `RpcClient` and Python `omp-rpc` |
| Sessions | Multiple concurrent sessions via `AgentRegistry` + `SessionManager` | One session per process; stdin close drains accepted commands and exits `0` |
| Typed surface | Direct, type-safe method calls on `AgentSession` | 42 wire commands, wrapped by the typed client libraries |
| Events | `session.subscribe(...)` | `AgentSessionEvent` frames on stdout; `onEvent` / `onSessionEvent` listeners |
| Message history | Direct access to session messages | `get_messages`; paged `get_messages_page` with cursors for large histories |
| Tools | Register tools in-process (custom tools, extensions, MCP) | `set_host_tools`: the host implements execution, the server calls back via `host_tool_call` |
| URL schemes | Internal URL schemes (`local://`, `artifact://`, …) resolve in-process | `set_host_uri_schemes` / `host_uri_request` / `host_uri_result` — the host serves its own schemes |
| Interactive UI | Your own UI code handles extension UI events | `extension_ui_request` / `extension_ui_response` frames, or a headless UI queue in the clients |
| Auth & login | `AuthStorage` / `discoverAuthStorage` | `get_login_providers` / `login` commands |
| Subagents | Direct orchestration (`AgentRegistry`, `TaskTool`, structured outputs) | `set_subagent_subscription` + `subagent_*` frames |
| Isolation | None — same crash domain as your host | Full: separate process, crash containment, external supervision |
| Overhead | No spawn, no serialization | Process spawn + per-frame JSON |

**SDK-only.** The session engine exposes capabilities with no RPC command: `fork()` / `moveSession()`, `resetSessionContext()`, `executePython()` / `abortEval()`, `retry()`, `toggleFastMode()`, service-tier selection, vibe tools, plan/goal mode state, and `reload()`. Use the SDK when you need any of these, or any future internal surface.

**RPC-only.** Host-owned tools and URI schemes, the headless extension-UI queue, paged message cursors, the login flow, and subagent event subscription are wire-level features — the SDK needs none of them because it talks to the session directly. Use RPC when the driver must implement tool behavior or UI itself, or when the host is not TypeScript.

## When to use which

- **SDK** — same-language embedding; direct object access; multiple concurrent sessions; shared managers (`MCPManager`, `AgentRegistry`, `SessionManager`); OpenTelemetry telemetry; structured subagent orchestration with output schemas; any SDK-only capability above.
- **RPC** — cross-language drivers (Python, editors, scripts); process isolation and crash containment; long-lived daemons supervised externally; host-owned tools and URI schemes; headless UI hosting; driver-side login.

## See also

- [SDK](/oh-my-pi/extending/sdk/) — in-process embedding: `createAgentSession()`, `AgentSession`, session managers
- [RPC](/oh-my-pi/extending/rpc/) — protocol reference: ready-frame handshake, framing, v2 chunking, every command and frame type
- [Automation & Headless](/oh-my-pi/guides/automation-headless/) — scripted one-shot usage from CI and scripts
- [Choosing Extension Points](/oh-my-pi/guides/choosing-extension-points/) — how the embedding surfaces compare with the other extension mechanisms
