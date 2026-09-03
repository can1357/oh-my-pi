---
name: authoring-hooks
description: Use when creating a new omp hook. Covers HookAPI, event catalog, blocking/overriding tool calls, and context modification.
---

# Authoring Hooks

Hooks are event-driven interceptors that run alongside the agent loop. They are best used for cross-cutting concerns: safety policy, secret redaction, context pruning, audit logging. A hook module registers handlers via `pi.on(event, handler)` and can block tool execution, override tool output, or rewrite the message context before each LLM call.

> **Relationship to extensions:** The hook subsystem (`HookAPI`) is the legacy API. The extension runner now handles everything hooks can do plus more. `ExtensionAPI` supports the hook event model plus extension-only events. Use `ExtensionAPI` for new work; use `HookAPI` only if you are maintaining an existing hook module.

## Factory signature

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function myHook(omp: HookAPI): void {
  omp.on("tool_call", async (event, ctx) => {
    // intercept every tool call
  });
}
```

The default export must be a function (not a class). It receives a `HookAPI` instance and should register handlers during factory execution; the loader awaits a returned promise, so asynchronous initialization is accepted.

Alternatively, using `ExtensionAPI` (preferred):

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => { /* ... */ });
}
```

## Event catalog

### Tool lifecycle

| Event | Fires | Can return |
|---|---|---|
| `tool_call` | Before every tool execution | `{ block?: boolean; reason?: string; input?: Record<string, unknown> }` |
| `tool_result` | After every tool execution | `{ content?; details?; isError?: boolean }` |

### Session lifecycle

| Event | Fires | Can return |
|---|---|---|
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

### Agent/turn lifecycle

| Event | Fires | Can return |
|---|---|---|
| `before_agent_start` | Before agent starts a turn | `{ message?: { customType; content; display; details; attribution? } }` |
| `agent_start` | Agent streaming starts | — |
| `agent_end` | Agent streaming ends | — |
| `turn_start` | Start of a user→agent turn | — |
| `turn_end` | End of a user→agent turn | — |
| `context` | Before each LLM API call | `{ messages?: Message[] }` |
| `auto_compaction_start` | Auto-compaction begins | — |
| `auto_compaction_end` | Auto-compaction ends | — |
| `auto_retry_start` | Auto-retry begins | — |
| `auto_retry_end` | Auto-retry ends | — |
| `ttsr_triggered` | TTSR (too-short response) triggered | — |
| `todo_reminder` | Todo reminder fires | — |

Extension-only events such as `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `input`, `user_bash`, and `user_python` require `ExtensionAPI`.

## Pre-tool blocking contract

Return `{ block: true, reason: "..." }` from a `tool_call` handler to prevent execution:

```ts
omp.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash") {
    const cmd = String(event.input.command ?? "");
    if (/\brm\s+-rf\s+\//.test(cmd)) {
      return { block: true, reason: "Refusing to delete root filesystem" };
    }
  }
});
```

Contract:

- If **any** handler returns `{ block: true }`, execution stops immediately.
- `reason` becomes the tool error text the LLM sees.
- If a handler **throws**, the tool is also blocked (fail-closed).
- Last non-blocking return wins; first `block: true` short-circuits.
- A non-blocking handler can return `input` to replace the raw arguments passed to the tool. Handlers do not see earlier input revisions, and input replacement is ignored for `computer` calls.

## Post-tool override contract

Return `{ content, details, isError }` from a `tool_result` handler to patch what the LLM sees:

```ts
omp.on("tool_result", async (event, ctx) => {
  if (event.toolName === "read" && !event.isError) {
    const redacted = event.content.map(chunk => {
      if (chunk.type !== "text") return chunk;
      return {
        ...chunk,
        text: chunk.text.replace(/(?:sk|pk)-[a-zA-Z0-9]{20,}/g, "[REDACTED_API_KEY]"),
      };
    });
    return { content: redacted };
  }
});
```

Contract:

- Handlers run in registration order. For `HookAPI`, each handler receives the original tool result event, and the last returned override wins.
- `content` replaces the full content array for the LLM.
- `details` replaces the structured details object.
- `isError` exists on the shared result type, but `HookToolWrapper` does not propagate it into a successful tool result; on a tool failure, the original error is rethrown after handlers complete.
- On a tool failure, `tool_result` is still emitted with `isError: true`.

## Context modification contract

Return `{ messages: [...] }` from a `context` handler to rewrite the message list before each LLM API call:

```ts
omp.on("context", async (event, ctx) => {
  // Remove debug-only custom messages from LLM context
  const filtered = event.messages.filter(
    msg => !(msg.role === "custom" && msg.customType === "debug-only")
  );
  return { messages: filtered };
});
```

Contract:

- `event.messages` is the current accumulated list.
- Handlers run in order; each receives the output of the previous handler.
- Return `undefined` (or nothing) to pass messages through unmodified.

## Three complete examples

### 1. rm-rf blocker

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function rmRfBlocker(omp: HookAPI): void {
  omp.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const cmd = String(event.input.command ?? "");
    if (!/\brm\s+-rf\s+\//.test(cmd)) return;

    // Allow if user explicitly confirms (interactive mode only)
    if (ctx.hasUI) {
      const allow = await ctx.ui.confirm(
        "Dangerous command",
        `This command deletes from root:\n${cmd}\n\nProceed?`
      );
      if (allow) return;
    }

    return { block: true, reason: "rm -rf / blocked by safety policy" };
  });
}
```

### 2. API-key redactor

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

// Common API-key shapes. Not exhaustive — providers using bespoke formats
// (Anthropic `sk-ant-…`, JWT-style bearers, gateway-specific prefixes, etc.)
// need their own entries.
const SECRET_PATTERNS = [
  /\b(sk|pk)-[a-zA-Z0-9]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bghp_[a-zA-Z0-9]{36}\b/g,
  // Zhipu / GLM Coding Plan: `<id>.<secret>` (no `sk-` prefix).
  /\b[a-zA-Z0-9]{16,}\.[a-zA-Z0-9]{16,}\b/g,
  /\b[a-zA-Z0-9_-]{20,}\s*=\s*["']?[a-zA-Z0-9._/+=-]{20,}["']?/g,
];

export default function apiKeyRedactor(omp: HookAPI): void {
  omp.on("tool_result", async (event) => {
    if (event.isError) return;

    let changed = false;
    const redacted = event.content.map(chunk => {
      if (chunk.type !== "text") return chunk;
      let text = chunk.text;
      for (const pattern of SECRET_PATTERNS) {
        const next = text.replace(pattern, "[REDACTED]");
        if (next !== text) { changed = true; text = next; }
      }
      return { ...chunk, text };
    });

    if (changed) return { content: redacted };
  });
}
```

### 3. Context filter

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function contextFilter(omp: HookAPI): void {
  omp.on("context", async (event) => {
    const MAX_TOOL_OUTPUT_CHARS = 8_000;

    const trimmed = event.messages.map(msg => {
      // Truncate very large tool results to keep context manageable
      if (msg.role !== "toolResult") return msg;
      const content = msg.content.map(chunk => {
        if (chunk.type !== "text" || chunk.text.length <= MAX_TOOL_OUTPUT_CHARS) return chunk;
        return {
          ...chunk,
          text: chunk.text.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n[... truncated by context-filter hook]",
        };
      });
      return { ...msg, content };
    });

    return { messages: trimmed };
  });
}
```

## UI methods in hook context

`ctx.ui` is a `HookUIContext`. Available methods:

| Method | Description |
|---|---|
| `notify(message, type?)` | Show an in-app notification |
| `setStatus(key, text)` | Set footer status text (keyed, sorted by key) |
| `select(title, options)` | Show a selection dialog |
| `confirm(title, message)` | Show a yes/no dialog |
| `input(title, placeholder?)` | Show a text input dialog |
| `editor(title, prefill?, { signal }?, { promptStyle }?)` | Show a multi-line editor |
| `setEditorText(text)` | Set the input editor content |
| `getEditorText()` | Get current input editor content |
| `custom(factory)` | Render a custom TUI component |
| `theme` | Current theme object |

Pass `{ promptStyle: true }` as the fourth argument when Enter should submit and Shift+Enter should insert a newline. The default hook editor behavior keeps Enter as newline and submits on the `app.message.followUp` chord (`Ctrl+Q` or `Ctrl+Enter`).

`ctx.hasUI` is `false` in headless/print/subagent mode — always guard interactive calls.

## Further reading

- `docs/hooks.md` — hook subsystem internals, ordering rules, error propagation
- `docs/extensions.md` — `ExtensionAPI` (superset of `HookAPI`)
- `docs/skills/examples/safety-hook/` — complete working example
