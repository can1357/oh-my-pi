# Custom Tools

Custom tools are model-callable functions that plug into the same tool execution pipeline as built-in tools.

A custom tool is a TypeScript/JavaScript module that exports a factory. The factory receives a host API (`CustomToolAPI`) and returns one tool or an array of tools.

## What this is (and is not)

- **Custom tool**: callable by the model during a turn (`execute` + parameter schema).
- **Extension**: lifecycle/event framework that can register tools and intercept/modify events.
- **Hook**: legacy event-driven interceptor API loaded through the extension runner.
- **Skill**: static guidance/context package, not executable tool code.

If you need the model to call code directly, use a custom tool.

## Integration paths in current code

There are two active integration styles:

1. **SDK-provided custom tools** (`options.customTools`)
   - In unrestricted SDK bootstrap, converted to extension tool definitions, registered through a generated extension, and always included in the initial active tool set.
   - In a restricted session (`restrictToolNames: true`), SDK-provided custom tools are excluded unless `allowRestrictedCustomTools: true`; opted-in tools are active only when their names also appear in `toolNames`.

2. **Filesystem-discovered modules via loader API** (`discoverAndLoadCustomTools` / `loadCustomTools`)
   - Exposed as library APIs in `packages/coding-agent/src/extensibility/custom-tools/loader.ts`.
   - Host code can call these to discover and load tool modules from config/provider/plugin paths.

```text
Model tool call flow

LLM tool call
   │
   ▼
Tool registry (built-ins + registered custom definitions)
   │
   ▼
CustomTool.execute(toolCallId, params, onUpdate, ctx, signal)
   │
   ├─ onUpdate(...)  -> streamed partial result
   └─ return result  -> final tool content/details
```

## Discovery locations (loader API)

`discoverAndLoadCustomTools(configuredPaths, cwd, builtInToolNames)` merges:

1. Capability providers (`toolCapability`), including:
   - Native OMP config (`~/.omp/agent/tools`, `.omp/tools`)
   - Claude config (`~/.claude/tools`, `.claude/tools`)
   - Codex config (`~/.codex/tools`, `.codex/tools`)
   - Claude marketplace plugin cache provider
2. Installed plugin manifests (`~/.omp/plugins/node_modules/*` via plugin loader)
3. Explicit configured paths passed to the loader

### Important behavior

- Duplicate resolved paths are deduplicated.
- Tool name conflicts are rejected against built-ins and already-loaded custom tools.
- `.md` and `.json` files are discovered as tool metadata by some providers, but the executable module loader rejects them as runnable tools.
- Relative configured paths are resolved from `cwd`; `~` is expanded.

## Module contract

A custom tool module must export a function (default export preferred):

```ts
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const factory: CustomToolFactory = (pi) => ({
  name: "repo_stats",
  label: "Repo Stats",
  description: "Counts tracked TypeScript files",
  parameters: pi.zod.object({
    glob: pi.zod.string().optional(),
  }),

  async execute(toolCallId, params, onUpdate, ctx, signal) {
    onUpdate?.({
      content: [{ type: "text", text: "Scanning files..." }],
      details: { phase: "scan" },
    });

    const result = await pi.exec(
      "git",
      ["ls-files", params.glob ?? "**/*.ts"],
      { signal, cwd: pi.cwd },
    );
    if (result.killed) {
      throw new Error("Scan was cancelled");
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || "git ls-files failed");
    }

    const files = result.stdout.split("\n").filter(Boolean);
    return {
      content: [{ type: "text", text: `Found ${files.length} files` }],
      details: { count: files.length, sample: files.slice(0, 10) },
    };
  },

  onSession(event) {
    if (event.reason === "shutdown") {
      // cleanup resources if needed
    }
  },
});

export default factory;
```

Parameter schemas may use the Zod-compatible omptype builder (`pi.zod`), native omptype builder (`pi.arktype`), or legacy-compatible TypeBox shim (`pi.typebox`) and flow through the shared validation/wire pipeline.

Factory return type:

- `CustomTool`
- `CustomTool[]`
- `Promise<CustomTool | CustomTool[]>`

## API surface passed to factories (`CustomToolAPI`)

From `types.ts` and `loader.ts`:

- `cwd`: host working directory
- `exec(command, args, options?)`: process execution helper
- `ui`: UI context (can be no-op in headless modes)
- `hasUI`: `false` in non-interactive flows
- `logger`: shared file logger
- `arktype`: injected omptype `type(...)` builder
- `typebox`: compatibility shim for legacy TypeBox-style schemas
- `pi`: injected `@oh-my-pi/pi-coding-agent` exports
- `pushPendingAction(action)`: stage a preview action that is finalized by writing a plain-text reason to `xd://resolve` or `xd://reject`

The loader starts with a no-op UI context and requires host code to call `setUIContext(...)` when real UI is ready. If the runtime did not provide a pending-action store, calling `pushPendingAction` throws `Pending action store unavailable for custom tools in this runtime.`

## Execution contract and typing

`CustomTool.execute` signature:

```ts
execute(toolCallId, params, onUpdate, ctx, signal);
```

- `params` is statically typed from its omptype or TypeBox schema via `Static<TParams>`.
- Runtime argument validation happens before execution in the agent loop.
- `onUpdate` emits partial results for UI streaming.
- `ctx` includes `sessionManager`, `modelRegistry`, current `model`, `isIdle()`, `hasQueuedMessages()`, `abort()`, and optional `settings`, `fetch`, `localProtocolOptions`, `autoApprove`, and `metadataForProvider(provider)`.
- Which optional fields arrive depends on how the tool was registered. SDK-provided and discovered tools get a context rebuilt by the extension bridge, which carries `metadataForProvider` and `localProtocolOptions` but drops `settings` and `autoApprove`. MCP-adapted tools get the agent loop's own context, which carries those two as well. Nothing in the CLI sets `fetch`; it is there for library consumers that build a context themselves.
- `metadataForProvider(provider)` returns the session's per-provider request metadata (`metadata.user_id`); pass it to any side model request the tool makes so the call is attributed to the same provider session and OAuth account as the conversation. Call it per request — after the credential is selected. Every session path supplies it; it is absent only when the host built an extension runner with no session agent behind it, such as the `omp models` CLI.
- `signal` carries cancellation and may be `undefined`.

The session bootstrap bridge converts custom tools to extension `ToolDefinition`s and forwards calls in the correct argument order. `CustomToolAdapter` remains available to library consumers that directly adapt a custom tool to the agent tool interface.

Tool definitions may also declare `strict`, `hidden`, `loadMode`, `deferrable`, `mcpServerName`, `mcpToolName`, and `approval`. When `loadMode` is omitted, custom tool names default to `"discoverable"` except for the canonical essential built-in names (`read`, `write`, `bash`, `edit`, `glob`, `computer`, `eval`, `task`, `hub`, `learn`, and `manage_skill`), which default to `"essential"` so wrappers or re-registrations do not demote them. An explicit `loadMode` always wins; use `"essential"` to keep any other tool top-level. Although the public `CustomTool` type also declares `formatApprovalDetails`, the SDK/discovery bridge does not propagate that callback into the registered tool definition, so it cannot customize approval details on the normal integration paths.

## How tools are exposed to the model

- Session bootstrap wraps included SDK-provided and discovered custom tools as extension tool definitions; library consumers may instead use `CustomToolAdapter` directly.
- They are inserted into the session tool registry by name.
- In unrestricted SDK bootstrap, custom and extension-registered tools are force-included in the initial active set. Restricted sessions exclude SDK-provided custom tools unless `allowRestrictedCustomTools: true`, and expose an opted-in custom tool only when its name appears in `toolNames`.
- CLI `--tools` currently validates only built-in tool names; custom tool inclusion is handled through discovery/registration paths and SDK options.

## Rendering hooks

Optional rendering hooks:

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme)`

The normal SDK and filesystem-discovery paths wrap custom tools as extensions. On those paths, `renderResult` receives only the three arguments above; the bridge does not forward the original tool arguments. The public `CustomTool` type retains an optional fourth `args` parameter for direct `CustomToolAdapter` consumers.

Runtime behavior in TUI:

- If hooks exist, tool output is rendered inside a `Box` container.
- `renderResult` receives `{ expanded, isPartial, spinnerFrame? }` as its `options` argument.
- Renderer errors are caught and logged; UI falls back to default text rendering.

## Session/state handling

Optional `onSession(event, ctx)` receives session lifecycle events, including:

- `start`, `switch`, `branch`, `tree`, `shutdown`
- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `ttsr_triggered`, `todo_reminder`

Use `ctx.sessionManager` to reconstruct state from history when branch/session context changes.

## Failures and cancellation semantics

### Synchronous/async failures

- Throwing (or rejected promises) in `execute` is treated as tool failure.
- Agent runtime converts failures into tool result messages with `isError: true` and error text content.
- With extension wrappers, `tool_result` handlers can further rewrite content/details and even override error status.

### Cancellation

- Agent abort propagates through `AbortSignal` to `execute`.
- Forward `signal` to subprocess work (`pi.exec(..., { signal })`) for cooperative cancellation.
- `ctx.abort()` lets a tool request abort of the current agent operation.

### onSession errors

- `onSession` errors are caught and logged as warnings; they do not crash the session.

## Real constraints to design for

- Tool names must be globally unique in the active registry.
- Prefer deterministic, schema-shaped outputs in `details` for renderer/state reconstruction.
- Guard UI usage with `pi.hasUI`.
- Treat `.md`/`.json` in tool directories as metadata, not executable modules.
