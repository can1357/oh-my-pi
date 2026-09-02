---
title: Custom Tools
description: Give omp new tools of your own that the model can call.
coverage: A
---

Custom tools are model-callable modules that plug into the same tool execution pipeline as built-in tools. A custom tool is a TypeScript or JavaScript module that exports a factory; the factory receives a `CustomToolAPI` and returns one tool or an array of tools. Schemas are authored with [Zod](https://zod.dev) (available as `pi.zod`) and flow through the shared validation pipeline.

If you need the model to call code directly, use a custom tool. If you need lifecycle and events around that tool, use an [extension](/oh-my-pi/extending/extensions/) instead — extensions register custom tools through `pi.registerTool` and gain full event interception on top. Use [hooks](/oh-my-pi/extending/hooks/) when you only need pre/post-tool interception of any tool. Use [skills](/oh-my-pi/extending/skills/) when you only need context and guidance.

## A minimal custom tool

```ts
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const factory: CustomToolFactory = (pi) => ({
  name: "repo_stats",
  label: "Repo Stats",
  description: "Counts tracked TypeScript files",
  parameters: pi.zod.object({
    glob: pi.zod.string().optional().default("**/*.ts"),
  }),

  async execute(toolCallId, params, onUpdate, ctx, signal) {
    onUpdate?.({
      content: [{ type: "text", text: "Scanning files..." }],
      details: { phase: "scan" },
    });

    const result = await pi.exec("git", ["ls-files", params.glob ?? "**/*.ts"], {
      signal,
      cwd: pi.cwd,
    });
    if (result.killed) throw new Error("Scan was cancelled");
    if (result.code !== 0) throw new Error(result.stderr || "git ls-files failed");

    const files = result.stdout.split("\n").filter(Boolean);
    return {
      content: [{ type: "text", text: `Found ${files.length} files` }],
      details: { count: files.length, sample: files.slice(0, 10) },
    };
  },

  onSession(event) {
    if (event.reason === "shutdown") {
      // release any held resources
    }
  },
});

export default factory;
```

The factory may return a single `CustomTool`, an array, or a promise of either.

## Where custom tools live

`discoverAndLoadCustomTools(configuredPaths, cwd, builtInToolNames)` merges three sources:

1. **Capability providers** (`toolCapability`):
   - Native OMP config — `~/.omp/agent/tools`, `.omp/tools`
   - Claude config — `~/.claude/tools`, `.claude/tools`
   - Codex config — `~/.codex/tools`, `.codex/tools`
   - Claude marketplace plugin cache provider
2. **Installed plugin manifests** under `~/.omp/plugins/node_modules/*` (via the plugin loader)
3. **Explicit configured paths** passed to the loader

`.md` and `.json` files in tool directories are discovered as tool metadata by some providers but the executable module loader rejects them as runnable tools. Duplicate resolved paths are deduplicated, and tool-name conflicts are rejected against built-ins and already-loaded custom tools. Relative configured paths are resolved from `cwd`; `~` is expanded.

## The `CustomToolAPI` surface

The factory receives a host API with:

| Field | Purpose |
| --- | --- |
| `cwd` | Host working directory |
| `exec(command, args, options?)` | Process execution helper — forward `signal` for cooperative cancellation |
| `ui` | UI context — can be no-op in headless modes |
| `hasUI` | `false` in non-interactive flows; always guard UI calls |
| `logger` | Shared file logger |
| `zod` | Injected `zod/v4` module (canonical for new schemas) |
| `typebox` | Zod-backed compatibility shim for legacy TypeBox-style schemas |
| `pi` | Injected `@oh-my-pi/pi-coding-agent` exports |
| `pushPendingAction(action)` | Register a preview action finalized via plain-text writes to `/xdev/resolve` or `/xdev/reject` |

The loader starts with a no-op UI context; host code must call `setUIContext(...)` when a real UI is ready.

## `execute` signature

```ts
execute(toolCallId, params, onUpdate, ctx, signal)
```

- `params` is statically typed from your Zod/TypeBox schema via `Static<TParams>`. Runtime argument validation runs before execution in the agent loop.
- `onUpdate` emits partial results for UI streaming — call it with `{ content, details? }`.
- `ctx` includes `sessionManager`, `modelRegistry`, current `model`, `isIdle()`, `hasQueuedMessages()`, `abort()`, and optional `settings`, `fetch`, and `autoApprove`.
- `signal` carries cancellation — forward it to subprocess work (`pi.exec(..., { signal })`) and to long-running fetches.

Tool definitions may also declare `strict`, `hidden`, `deferrable`, `mcpServerName`, `mcpToolName`, `approval`, and `formatApprovalDetails`.

## Rendering hooks

Optional rendering hooks customize how the tool call and result appear in the TUI:

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme, args?)`

If hooks exist, tool output is rendered inside a `Box` container. `renderResult` receives `{ expanded, isPartial, spinnerFrame? }`. Renderer errors are caught and logged; the UI falls back to default text rendering.

## Session lifecycle (`onSession`)

Optional `onSession(event, ctx)` receives:

| Reason | Fires |
| --- | --- |
| `start` | Session starts |
| `switch` | Session switch |
| `branch` | Session branch |
| `tree` | Tree navigation |
| `shutdown` | Session shutdown |
| `auto_compaction_start` / `auto_compaction_end` | Auto-compaction |
| `auto_retry_start` / `auto_retry_end` | Auto-retry |
| `ttsr_triggered` | TTSR (too-short response) |
| `todo_reminder` | Todo reminder fires |

Use `ctx.sessionManager` to reconstruct state from history when branch or session context changes.

## Failures and cancellation

- **Sync or async throws** in `execute` are treated as tool failure. The agent runtime converts failures into tool result messages with `isError: true` and error text content. With extension wrappers, `tool_result` handlers can rewrite content/details and even override the error status.
- **Cancellation** — agent abort propagates through `AbortSignal` to `execute`. Forward `signal` to subprocess work for cooperative cancellation. `ctx.abort()` lets a tool request abort of the current agent operation.
- **`onSession` errors** are caught and logged as warnings; they do not crash the session.

## Sharp edges

- **Tool names must be globally unique** in the active registry. Conflict rejection is against built-ins *and* already-loaded custom tools.
- **Prefer deterministic, schema-shaped outputs in `details`** so renderers and state-reconstruction code can rely on stable structure.
- **Guard UI usage** with `pi.hasUI` — the loader's initial UI context is a no-op until `setUIContext(...)` is wired.
- **CLI `--tools` only validates built-in names** today; custom-tool inclusion flows through discovery/registration paths and SDK options.
- **Treat `.md`/`.json` in tool directories as metadata**, not executable modules — the loader rejects them as runnable tools.
