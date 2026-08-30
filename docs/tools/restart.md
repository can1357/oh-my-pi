# restart

> Cooperatively recycle the current session to pick up host-staged changes a live `refresh` cannot reach — an SDK-embedder opt-in, not a stock CLI feature.

## Availability

`restart` is **not** part of a default `omp` CLI session. It appears only when the SDK embedder that started the session supplies an `onRestartRequested` lifecycle callback (`CreateAgentSessionOptions.onRestartRequested`). The SDK binds `ToolSession.requestRestart` **only** when that callback is present, and `RestartTool.createIf()` returns `null` when the binding is absent — so an unconfigured session is never shown a tool that always errors, and `main.ts` (the CLI host) deliberately does not wire the callback.

The restart lifecycle — quiesce, flush, dispose, re-attach — is owned by the embedder. OMP disposes the old session and then hands the embedder the data it needs to reopen; the embedder is responsible for reconstructing the replacement session (see [Reconstruction contract](#reconstruction-contract)).

## Source
- Entry: `packages/coding-agent/src/tools/restart.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/restart.md`
- Key collaborators:
  - `packages/coding-agent/src/session/agent-session.ts` — `AgentSession.requestRestart()` / `#doRequestRestart()` implement the latch → quiesce → flush → dispose → callback sequence and the `RequestRestartResult` contract.
  - `packages/coding-agent/src/sdk.ts` — `CreateAgentSessionOptions.onRestartRequested` (the opt-in), and the `requestRestart` binding that gates tool creation.
  - `packages/coding-agent/src/tools/index.ts` — registers `restart` via `RestartTool.createIf` (conditional on the binding).

## Registration / Visibility
- Tool metadata: `approval = "exec"`, `strict = true`, `loadMode = "discoverable"`. Same tier and reasoning as `refresh`: it recycles the session, so it must not auto-run in `always-ask`/`write` modes and auto-runs only in `yolo`.
- Registration requires a bound `ToolSession.requestRestart`, which the SDK binds only when `onRestartRequested` is configured. No callback ⇒ no tool.
- In an ordinary `tools.xdev` session, discoverable built-ins may be presented as `xd://restart`; an explicitly requested tool remains top-level.

## Inputs

The tool takes no parameters (`{}`).

## Outputs
On a bound session, `execute()` returns immediately with an acknowledgement plus structured details:

- text body: `Restart scheduled. It runs once this turn settles; the conversation resumes in the recycled session.`
- `details`:
  - `scheduled: true`

On an unbound session (only reachable by constructing the tool directly outside the `createIf` gate), `execute()` returns an error result (`isError: true`, `details.scheduled = false`) with the text `Restart is unavailable in this session.`

The acknowledgement is intentionally decoupled from the outcome: the actual recycle fires from an untracked continuation after the turn settles (see [Flow](#flow)). A pre-dispose refusal is surfaced back to the transcript so the model learns the restart did not happen; see [Failure reporting](#failure-reporting).

## Flow
1. `RestartTool.createIf()` constructs the tool only when `session.requestRestart` is bound.
2. `execute()` returns the acknowledgement synchronously and fires `requestRestart()` from an **untracked** continuation — never inline (its `waitForIdle()` cannot resolve while the tool blocks the turn) and never via a tracked post-prompt task (`requestRestart()`'s own `waitForIdle()`/`dispose()` await that set → self-deadlock).
3. `AgentSession.requestRestart()` performs pre-latch refusals (`unavailable` / `no-session-file` / `busy`) without latching, then commits: latch out new turns (`#restarting`), quiesce the running turn (`waitForIdle()`), re-check quiescence, flush the transcript (`flush()` + `ensureOnDisk()`), re-check, dispose the session, then invoke the host `onRestartRequested({ sessionId, sessionFile })`.
4. The host reopens the manager from `sessionFile` and reconstructs the replacement session (see [Reconstruction contract](#reconstruction-contract)).

## Reconstruction contract
When `onRestartRequested({ sessionId, sessionFile })` fires the old session is already disposed. The embedder MUST:

1. `await SessionManager.open(sessionFile)` to reopen the durable transcript, and
2. recreate the session through the **same configured factory / options it used originally** (cwd, agentDir, event bus, injected settings, and the `onRestartRequested` callback itself), substituting the reopened manager.

A bare `createAgentSession({ sessionManager })` drops every host option — the recycled session would restart once and then never again, and silently lose host configuration.

The whole point of restart is to re-read surfaces frozen at session start, so the embedder MUST let those surfaces be **rediscovered** rather than carried across the boundary:

- **Do NOT re-pass `preloadedExtensions`** across the restart boundary. Those `Extension` instances close over the disposed session's `ExtensionAPI` (cwd, eventBus, runtime); reusing them routes tools/handlers/commands back through the dead session. Omit them (or forward only source paths via `preloadedExtensionPaths`) so the replacement session binds fresh extensions to its own runtime.
- **Do NOT re-pass `contextFiles`, `skills`, `promptTemplates`, or `slashCommands`** with the values captured at first launch. Each of these bypasses disk discovery when supplied, so re-passing the stale value defeats the reload — restart would silently keep the old `AGENTS.md`, skills, templates, and commands. Omit them so `createAgentSession` re-runs discovery and picks up the on-disk changes restart promises.

Preserve everything that is genuine host configuration (model, provider registry, auth, agent id, cwd, event bus); invalidate only the discovery-backed preload fields above. `refresh` handles skills/rules/settings/MCP live; restart is for the rest.

## Failure reporting
The result splits on dispose ordering:

- **Pre-dispose refusal** (`RequestRestartResult` with `ok: false`, reason `unavailable` / `no-session-file` / `busy`): the session is still alive and untouched. The tool surfaces a `restart-refused` custom message to the still-open transcript via `queueDeferredMessage`, so the model learns the restart did not happen and can retry once the session is quiet.
- **Pre-dispose throw** (`flush()`/`ensureOnDisk()` rejected before dispose began): the session is still alive and unlatched. The tool surfaces a phase-aware failure to the transcript (the restart did not happen) and logs; the session remains usable.
- **Post-dispose throw** (the host `onRestartRequested` callback threw after the old session was already disposed): there is no awaiting caller and the transcript is closed, so the tool logs and relies on recovery through the durable session file. It is never left unhandled and never silently swallowed.

## Notes
- Restart recycles ONLY this session (same loaded engine code). Picking up a new engine *binary* is a host-process operation, never this per-agent tool.
- `refresh` re-reads skills, rules, settings, and MCP live without recycling. `restart` covers the surfaces `refresh` cannot: extensions, project context (`AGENTS.md`), slash commands, prompt templates, the tool roster, and the model/provider registry — all frozen at session start.
- The durable session file is the recovery handle throughout: on any post-dispose failure the transcript is intact on disk for the embedder to reopen.
