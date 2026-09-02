---
title: Hooks
description: Run custom logic on agent lifecycle events with pre- and post-tool interception.
coverage: A
---

Hooks are event-driven interceptors that run alongside the agent loop. A hook module registers handlers with `pi.on(event, handler)` and can block tool execution, override tool output, or rewrite the message context before each LLM call. They are best suited for cross-cutting concerns — safety policy, secret redaction, context pruning, audit logging.

> **Relationship to extensions.** The hook subsystem (`HookAPI`) is the legacy API. The extension runner now handles everything hooks can do plus more — `ExtensionAPI` covers every hook event plus extension-only events (`tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `input`, `user_bash`, `user_python`, `mcp_notification`, and others). Use `ExtensionAPI` for new work; use `HookAPI` only if you are maintaining an existing hook module.

## A hook module

A hook module default-exports a factory that receives a `HookAPI`:

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
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

The factory can register event handlers, send persistent custom messages, persist non-LLM state via `appendEntry`, register slash commands, register custom message renderers, run shell commands, and author schemas/helpers with injected `pi.zod`, `pi.typebox`, and package exports via `pi.pi`.

## Where hooks live

Default sessions load JS/TS hook factories through the extension runner:

1. Native extension modules from the capability registry
2. Importable `.ts`/`.js` hook factories from the hook capability registry (for example `.omp/hooks/pre/*.ts`)
3. Plugin extension entry points from `~/.omp/plugins/node_modules/*`
4. Explicitly configured paths

CLI `--hook` is treated as an alias for `--extension` — both flags add paths to `additionalExtensionPaths`. So the same discovery paths apply to hooks and extensions; the only distinction is which `pi.on(...)` event names and which return shapes each API accepts.

Hooks are deduped by resolved absolute path, then loaded in that order. Per-path failures are captured and do not stop the other hooks from loading.

## Event catalog

Events are strongly typed in `src/extensibility/hooks/types.ts`.

### Tool lifecycle

| Event | Fires | Can return |
| --- | --- | --- |
| `tool_call` | Before every tool execution | `{ block?: boolean; reason?: string; input?: Record<string, unknown> }` |
| `tool_result` | After every tool execution | `{ content?; details?; isError?: boolean }` |

A non-blocking `tool_call` handler that returns `input` replaces the arguments the tool executes with (the raw execution input, not the normalized `event.input` view). The override is ignored when `block` is `true`, and is not applied to `computer` tool calls.

### Session lifecycle

| Event | Fires | Can return |
| --- | --- | --- |
| `session_start` | On initial session load | — |
| `session_before_switch` | Before session switch | `{ cancel?: boolean }` |
| `session_switch` | After session switch | — |
| `session_before_branch` | Before session branch | `{ cancel?: boolean; skipConversationRestore?: boolean }` |
| `session_branch` | After session branch | — |
| `session_before_compact` | Before compaction | `{ cancel?: boolean; compaction?: CompactionResult }` |
| `session.compacting` | During compaction (inject context) | `{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }` |
| `session_compact` | After compaction | — |
| `session_before_tree` | Before tree navigation | `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }` |
| `session_tree` | After tree navigation | — |
| `session_shutdown` | On session shutdown | — |

### Agent / turn lifecycle

| Event | Fires | Can return |
| --- | --- | --- |
| `before_agent_start` | Before agent starts a turn | `{ message?: { customType; content; display; details; attribution? } }` |
| `agent_start` | Agent streaming starts | — |
| `agent_end` | Agent streaming ends | — |
| `turn_start` | Start of a user → agent turn | — |
| `turn_end` | End of a user → agent turn | — |
| `context` | Before each LLM API call | `{ messages?: Message[] }` |
| `auto_compaction_start` | Auto-compaction begins | — |
| `auto_compaction_end` | Auto-compaction ends | — |
| `auto_retry_start` | Auto-retry begins | — |
| `auto_retry_end` | Auto-retry ends | — |
| `ttsr_triggered` | TTSR (too-short response) triggered | — |
| `todo_reminder` | Todo reminder fires | — |

Extension-only events (`tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `input`, `user_bash`, `user_python`, `mcp_notification`, and others) require `ExtensionAPI`.

## Blocking tool execution

Return `{ block: true, reason: "..." }` from a `tool_call` handler to prevent the tool from running. The contract is fail-closed:

- If any handler returns `{ block: true }`, execution stops immediately.
- `reason` is returned to the LLM as the tool error text.
- If a handler throws, the tool is also blocked.
- Last non-blocking return wins for non-blocking results; first `block: true` short-circuits.

```ts
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash") {
    const cmd = String(event.input.command ?? "");
    if (/\brm\s+-rf\s+\//.test(cmd)) {
      return { block: true, reason: "Refusing to delete root filesystem" };
    }
  }
});
```

When the session has a UI, gate the block behind a confirmation prompt:

```ts
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return;
  const cmd = String(event.input.command ?? "");
  if (!cmd.includes("rm -rf")) return;

  if (!ctx.hasUI) return { block: true, reason: "rm -rf blocked (no UI)" };
  const ok = await ctx.ui.confirm("Dangerous command", `Allow: ${cmd}`);
  if (!ok) return { block: true, reason: "user denied command" };
});
```

## Overriding tool results

Return `{ content, details, isError }` from a `tool_result` handler to patch what the LLM sees:

- Handlers run in registration order. Each handler receives the original tool result event, and the last returned override wins.
- `content` replaces the full content array for the LLM.
- `details` replaces the structured details object.
- `isError` is typed but `HookToolWrapper` does not propagate it into a successful tool result; on a tool failure, the original error is rethrown after handlers complete and `tool_result` is still emitted with `isError: true`.

```ts
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
```

## Modifying the LLM context

Return `{ messages: [...] }` from a `context` handler to rewrite the message list before each LLM API call:

- `event.messages` is the current accumulated list.
- Handlers run in order; each receives the output of the previous handler.
- Return `undefined` (or nothing) to pass messages through unmodified.

```ts
pi.on("context", async (event) => {
  const MAX_TOOL_OUTPUT_CHARS = 8_000;

  const trimmed = event.messages.map((msg) => {
    if (msg.role !== "toolResult") return msg;
    const content = msg.content.map((chunk) => {
      if (chunk.type !== "text" || chunk.text.length <= MAX_TOOL_OUTPUT_CHARS) return chunk;
      return {
        ...chunk,
        text: chunk.text.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n[... truncated]",
      };
    });
    return { ...msg, content };
  });

  return { messages: trimmed };
});
```

## Ordering and conflict behavior

Hook handlers run in registration order across all loaded hook modules. For the conflict-heavy events:

- `tool_call` — last non-blocking return wins; first `block: true` short-circuits. A returned `input` override follows the same last-wins rule and handlers do not observe each other's revisions.
- `tool_result` — last returned override wins, no short-circuit.
- `context` — chained; each handler receives the previous handler's output.
- `before_agent_start` — first returned message is kept; later messages are ignored.
- `session_before_*` — latest returned result is tracked; `cancel: true` short-circuits immediately.
- `session.compacting` — latest returned result wins.
- Slash commands and message renderers — first loaded wins (lookup), but `getRegisteredCommands()` returns all commands without deduping.

## UI methods in hook context

`ctx.ui` is a `HookUIContext`:

| Method | Description |
| --- | --- |
| `notify(message, type?)` | Show an in-app notification |
| `setStatus(key, text)` | Set footer status text (keyed, sorted by key) |
| `select(title, options)` | Show a selection dialog |
| `confirm(title, message)` | Show a yes/no dialog |
| `input(title, placeholder?)` | Show a text input dialog |
| `editor(title, prefill?, signal?, { promptStyle }?)` | Show a multi-line editor |
| `setEditorText(text)` | Set the input editor content |
| `getEditorText()` | Get current input editor content |
| `custom(factory)` | Render a custom TUI component |
| `theme` | Current theme object |

Pass `{ promptStyle: true }` as the fourth argument when Enter should submit and Shift+Enter should insert a newline. The default hook editor behavior keeps Enter as newline and submits on the `app.message.followUp` chord (`Ctrl+Q` or `Ctrl-Enter`). `ctx.hasUI` is `false` in headless/print/subagent mode — always guard interactive calls.

## Sharp edges

- **Extension-only events need `ExtensionAPI`.** `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `input`, `user_bash`, `user_python`, `mcp_notification` and friends are not on the hook event bus.
- **Hook tool wrappers do not propagate `isError` overrides** on successful tool results — the underlying call's success state still wins; on failure the original error is rethrown after handlers run.
- **`tool_call` `input` overrides are not applied to `computer` tool calls.**
- **Hook status text is sanitized** — ANSI/VT escape sequences are stripped, control characters mapped to spaces, repeated spaces collapsed, and width-truncated for display.
- **No-op UI context** — when running with no UI, `select`/`input`/`editor` return `undefined`, `confirm` returns `false`, and `notify`/`setStatus`/`setEditorText` are no-ops.
