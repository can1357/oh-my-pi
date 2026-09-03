# Hooks

This document describes the **current hook subsystem code** in `packages/coding-agent/src/extensibility/hooks/*`.

## Current status in runtime

The default CLI runtime initializes the **extension runner** path. In current startup flow:

- `--hook` is treated as an alias for `--extension` (CLI paths are merged into `additionalExtensionPaths`)
- JS/TS hook factories discovered through `hookCapability` (for example `.omp/hooks/pre/*.ts`) are loaded as extension modules so their `pi.on(...)` handlers bind to the runtime event bus
- tools are wrapped by `ExtensionToolWrapper`, not `HookToolWrapper`
- context transforms and lifecycle emissions go through `ExtensionRunner`

So this file documents the legacy hook subsystem implementation itself (types/loader/runner/wrapper), plus the factory shape still accepted when a discovered hook path is loaded by the extension runner.

## Key files

- `packages/coding-agent/src/extensibility/hooks/types.ts` — hook context, event types, and result contracts
- `packages/coding-agent/src/extensibility/hooks/loader.ts` — module loading and hook discovery bridge
- `packages/coding-agent/src/extensibility/hooks/runner.ts` — event dispatch, command lookup, error signaling
- `packages/coding-agent/src/extensibility/hooks/tool-wrapper.ts` — pre/post tool interception wrapper
- `packages/coding-agent/src/extensibility/hooks/index.ts` — exports/re-exports

## What a hook module is

A hook module must default-export a factory:

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function hook(pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (
      event.toolName === "bash" &&
      String(event.input.command ?? "").includes("rm -rf")
    ) {
      return { block: true, reason: "blocked by policy" };
    }
  });
}
```

The factory can:

- register event handlers with `pi.on(...)`
- send persistent custom messages with `pi.sendMessage(...)`
- persist non-LLM state with `pi.appendEntry(...)`
- register slash commands via `pi.registerCommand(...)`
- register custom message renderers via `pi.registerMessageRenderer(...)`
- run shell commands via `pi.exec(...)` and log through `pi.logger`
- use the injected Zod-compatible builder `pi.zod`, native omptype builder `pi.arktype`, legacy `pi.typebox`, and package exports via `pi.pi`

## Discovery and loading

Default sessions load JS/TS hook factories discovered by `hookCapability` through the extension runner. `discoverExtensionPaths(configuredPaths, cwd)` does:

1. Load native extension modules from the capability registry
2. Load importable `.ts`/`.js` hook factories from the hook capability registry
3. Append plugin extension entry points
4. Append explicitly configured paths

The legacy `discoverAndLoadHooks(configuredPaths, cwd)` helper still exists and does:

1. Load discovered hooks from capability registry (`loadCapability("hooks")`)
2. Append explicitly configured paths (deduped by absolute path)
3. Call `loadHooks(allPaths, cwd)`

`loadHooks` then imports each path and expects a `default` function.

### Path resolution

`loader.ts` resolves hook paths as:

- absolute path: used as-is
- `~` path: expanded
- relative path: resolved against `cwd`

## Event surfaces

Hook events are strongly typed in `types.ts`.

### Session events

- `session_start`
- `session_before_switch` → can return `{ cancel?: boolean }`
- `session_switch`
- `session_before_branch` → can return `{ cancel?: boolean; skipConversationRestore?: boolean }`
- `session_branch`
- `session_before_compact` → can return `{ cancel?: boolean; compaction?: CompactionResult }`
- `session.compacting` → can return `{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }`
- `session_compact`
- `session_before_tree` → can return `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }`
- `session_tree`
- `session_shutdown`

### Agent/context events

- `context` → can return `{ messages?: Message[] }`
- `before_agent_start` → can return `{ message?: { customType; content; display; details; attribution } }`
- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `auto_compaction_start`
- `auto_compaction_end`
- `auto_retry_start`
- `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`

### Tool events (pre/post model)

- `tool_call` (pre-execution) → can return `{ block?: boolean; reason?: string; input?: Record<string, unknown> }`. A non-blocking handler that returns `input` replaces the arguments the tool executes with (the raw execution input, not the normalized `event.input` view); ignored when `block` is true, and not applied to `computer` tool calls.
- `tool_result` (post-execution) → can return `{ content?; details?; isError? }`

This is the hook subsystem’s core pre/post interception model.

```text
Hook tool interception flow

tool_call handlers
   │
   ├─ any { block: true }? ── yes ──> throw (tool blocked)
   │
   └─ no
      │
      ▼
   execute underlying tool
      │
      ├─ success ──> tool_result handlers can override { content, details }
      │
      └─ error   ──> emit tool_result(isError=true) then rethrow original error
```

## Execution model and mutation semantics

### 1) Pre-execution: `tool_call`

`HookToolWrapper.execute()` emits `tool_call` before tool execution.

- if any handler returns `{ block: true }`, execution stops
- if handler throws, wrapper fails closed and blocks execution
- returned `reason` becomes the thrown error text

### 2) Tool execution

Underlying tool executes normally if not blocked.

### 3) Post-execution: `tool_result`

After success, wrapper emits `tool_result` with:

- `toolName`, `toolCallId`, `input`
- `content`
- `details`
- `isError: false`

If handler returns overrides:

- `content` can replace result content
- `details` can replace result details

On tool failure, wrapper emits `tool_result` with `isError: true` and error text content, then rethrows original error.

### What hooks can mutate

- LLM context for a single call via `context` (`messages` replacement chain)
- raw tool execution arguments by returning `input` from `tool_call` (except `computer` calls)
- tool output content/details on successful tool calls (`tool_result` path)
- pre-agent injected message via `before_agent_start`
- cancellation/custom compaction/tree behavior via `session_before_*` and `session.compacting`

### What hooks cannot mutate in this implementation

- a `computer` tool call's raw parameters
- execution continuation after thrown tool errors (error path rethrows)
- final success/error status in wrapper behavior (returned `isError` is typed but not applied by `HookToolWrapper`)

## Ordering and conflict behavior

### Discovery-level ordering

Capability providers are priority-sorted (higher first). Dedupe is by capability key, first wins.

For `hooks`, capability key is `${type}:${tool}:${name}`. Shadowed duplicates from lower-priority providers are marked and excluded from effective discovered list.

### Load order

`discoverAndLoadHooks` builds a flat `allPaths` list, deduped by resolved absolute path, then `loadHooks` iterates in that order.
File order within each discovered directory depends on `readdir` output; the hook loader does not perform an additional sort.

### Runtime handler order

Inside `HookRunner`, order is deterministic by registration sequence:

1. hooks array order
2. handler registration order per hook/event

Conflict behavior by event type:

- `tool_call`: last returned result wins unless a handler blocks; first block short-circuits. A returned `input` (execution-argument override) follows the same last-wins rule; handlers do not observe each other's revisions
- `tool_result`: last returned override wins (no short-circuit)
- `context`: chained; each handler receives prior handler’s message output
- `before_agent_start`: first returned message is kept; later messages ignored
- `session_before_*`: latest returned result is tracked; `cancel: true` short-circuits immediately
- `session.compacting`: latest returned result wins

Command/renderer conflicts:

- `getCommand(name)` returns first match across hooks (first loaded wins)
- `getMessageRenderer(customType)` returns first match
- `getRegisteredCommands()` returns all commands (no dedupe)

## UI interactions (`HookContext.ui`)

`HookUIContext` includes:

- `select`, `confirm`, `input`, `editor`
- `notify`
- `setStatus`
- `custom`
- `setEditorText`, `getEditorText`
- `theme` getter

`ctx` includes `hasUI`, `cwd`, `sessionManager`, `modelRegistry`, current `model`, `isIdle()`, `abort()`, and `hasQueuedMessages()`.

When running with no UI, the default no-op context behavior is:

- `select/input/editor` return `undefined`
- `confirm` returns `false`
- `notify`, `setStatus`, `setEditorText` are no-ops
- `getEditorText` returns `""`

### Status line behavior

Hook status text set via `ctx.ui.setStatus(key, text)` is:

- stored per key
- sorted by key name
- sanitized (ANSI/VT escape sequences stripped; control characters mapped to spaces; repeated spaces collapsed; trimmed)
- joined and width-truncated for display

## Error propagation and fallback

### Load-time

- invalid module or missing default export → captured in `LoadHooksResult.errors`
- loading continues for other hooks

### Event-time

`HookRunner.emit(...)` catches handler errors for most events and emits `HookError` to listeners (`hookPath`, `event`, `error`), then continues.

`emitToolCall(...)` is stricter: handler errors are not swallowed there; they propagate to caller. In `HookToolWrapper`, this blocks the tool call (fail-safe).

## Realistic API examples

### Block unsafe bash commands

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const cmd = String(event.input.command ?? "");
    if (!cmd.includes("rm -rf")) return;

    if (!ctx.hasUI) return { block: true, reason: "rm -rf blocked (no UI)" };
    const ok = await ctx.ui.confirm("Dangerous command", `Allow: ${cmd}`);
    if (!ok) return { block: true, reason: "user denied command" };
  });
}
```

### Redact tool output on post-execution

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read" || event.isError) return;

    const redacted = event.content.map((chunk) => {
      if (chunk.type !== "text") return chunk;
      return {
        ...chunk,
        text: chunk.text.replaceAll(/API_KEY=\S+/g, "API_KEY=[REDACTED]"),
      };
    });

    return { content: redacted };
  });
}
```

### Modify model context per LLM call

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("context", async (event) => {
    const filtered = event.messages.filter(
      (msg) => !(msg.role === "custom" && msg.customType === "debug-only"),
    );
    return { messages: filtered };
  });
}
```

### Register slash command with command-safe context methods

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.registerCommand("handoff", {
    description: "Create a new session with setup message",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (sm) => {
          sm.appendMessage({
            role: "user",
            content: [
              { type: "text", text: "Continue from prior session summary." },
            ],
            timestamp: Date.now(),
          });
        },
      });
    },
  });
}
```

## Export surface

`packages/coding-agent/src/extensibility/hooks/index.ts` and the package subpath `@oh-my-pi/pi-coding-agent/extensibility/hooks` export:

- loading APIs (`discoverAndLoadHooks`, `loadHooks`)
- runner and wrapper (`HookRunner`, `HookToolWrapper`)
- all hook types
- `execCommand` re-export

The package root (`@oh-my-pi/pi-coding-agent`) does not re-export `HookAPI`; import legacy hook types from the hooks subpath.
