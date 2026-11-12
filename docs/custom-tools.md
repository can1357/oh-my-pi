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
   - Converted to extension tool definitions and adapted into the session registry.
   - Unrestricted sessions auto-enable them unless the effective definition is hidden/default-inactive.
   - In a restricted session (`restrictToolNames: true`), SDK-provided custom tools are excluded unless `allowRestrictedCustomTools: true`; opted-in tools are active only when their names also appear in `toolNames`.

2. **Filesystem-discovered modules** (`discoverCustomToolPaths` / `loadCustomTools`)
   - Unrestricted session bootstrap discovers and loads config/provider/plugin tool modules, then registers them through a generated extension.
   - These functions and the combined `discoverAndLoadCustomTools` helper are also library APIs in `packages/coding-agent/src/extensibility/custom-tools/loader.ts`.
   - Subagents can reuse `preloadedCustomToolPaths` to skip discovery, but factories are rebound to each session's own API.

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

`discoverAndLoadCustomTools(configuredPaths, cwd, builtInToolNames, pushPendingAction?, agentDir?)` merges:

1. Capability providers (`toolCapability`), including:
   - Native OMP config (`<agentDir>/tools`, default `~/.omp/agent/tools`; `.omp/tools`)
   - Claude config (`<Claude config dir>/tools`, default `~/.claude/tools`; `.claude/tools`)
   - Codex config (`~/.codex/tools`, `.codex/tools`)
   - OMP package roots and Claude marketplace plugins
2. Enabled installed plugin manifests (user `~/.omp/plugins` and the active project `.omp/plugins` registry via the plugin loader; project packages shadow same-named user packages)
3. Explicit configured paths passed to the loader

### Important behavior

- Foreign user directories are opt-in via `enabledProviders` (for example `"claude"` or `"codex"`); project directories remain discoverable unless the whole provider is disabled. `CLAUDE_CONFIG_DIR` also opts in the Claude user source.
- Native user discovery follows the active profile and the supplied `agentDir`.
- Duplicate resolved paths are deduplicated by discovery; `loadCustomTools` itself loads the supplied path list.
- Filesystem tool name conflicts are rejected against the supplied built-in names and already-loaded custom tools. Configured paths are appended, not name overrides.
- Invalid factory results are reported per array entry; valid entries from the same factory can still load. Import/factory failures are collected in `errors` without stopping later modules.
- Automatic tool-directory scans discover `.ts` and `.js` modules; native OMP discovery also checks immediate subdirectories for `index.ts`. Executable discovery excludes `.d.ts` and filters out metadata and scripts before tool-name deduplication. Declarative metadata such as `.md` and `.json` remains available to capability consumers but is not loaded as executable tools.
- `.mjs` and `.cjs` modules can be loaded through explicitly configured paths or declared plugin tool entries, but the tool-directory scans above do not discover them automatically. Explicitly configured `.md` or `.json` paths still produce a load error.
- Relative configured paths are resolved from `cwd`; `~` is expanded.

## Module contract

A custom tool module must export a function (default export preferred):

```ts
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const factory: CustomToolFactory = pi => ({
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

		const result = await pi.exec("git", ["ls-files", params.glob ?? "**/*.ts"], { signal, cwd: pi.cwd });
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

Value imports of `@oh-my-pi/*` host packages (and their legacy `@mariozechner/*` / `@earendil-works/*` scopes) resolve to the copy omp itself runs, including in the compiled binary; the tool's other dependencies resolve from its own location. A tool module and its relative imports are evaluated once per process; each session calls the factory again.

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
- `zod`: injected Zod-compatible omptype builder
- `typebox`: compatibility shim for legacy TypeBox-style schemas
- `pi`: injected `@oh-my-pi/pi-coding-agent` exports
- `pushPendingAction(action)`: stage a preview action that is finalized by writing a plain-text reason to `xd://resolve` or `xd://reject`

The loader starts with a no-op UI context and `hasUI: false`. Library hosts can
call the returned `setUIContext(...)` when real UI is ready. Normal SDK
filesystem-tool bootstrap currently does not call that setter, so the factory
API's UI remains no-op even when the session has a TUI. If the runtime did not
provide a pending-action store, calling `pushPendingAction` throws
`Pending action store unavailable for custom tools in this runtime.`

## Execution contract and typing

`CustomTool.execute` signature:

```ts
execute(toolCallId, params, onUpdate, ctx, signal);
```

- `params` is statically typed from its omptype or TypeBox schema via `Static<TParams>`.
- Runtime argument validation happens before execution in the agent loop.
- `onUpdate` emits partial results for UI streaming.
- `ctx` includes `sessionManager`, `modelRegistry`, current `model`, `isIdle()`, `hasQueuedMessages()`, `abort()`, and `localProtocolOptions`. The public context type also permits `settings`, `fetch`, and `autoApprove`, but the normal SDK conversion does not populate those three fields.
- `signal` carries cancellation and may be `undefined`.

The session bootstrap bridge converts custom tools to extension `ToolDefinition`s and forwards calls in the correct argument order. `CustomToolAdapter` remains available to library consumers that directly adapt a custom tool to the agent tool interface.

Tool definitions may also declare `strict`, `hidden`, `loadMode`, `deferrable`, `readsSkillUris`, `mcpServerName`, `mcpToolName`, `legacyName`, and `approval`. When `loadMode` is omitted, custom tool names default to `"discoverable"` except for the canonical essential built-in names (`read`, `write`, `bash`, `edit`, `glob`, `find`, `eval`, `task`, `wait`, `learn`, `manage_skill`, `context_notes`, and `new_context`), which default to `"essential"` so wrappers or re-registrations do not demote them. An explicit `loadMode` always wins; use `"essential"` to keep any other tool top-level.

Although the public `CustomTool` type also declares `formatApprovalDetails`, `describeCall`, and `describeResult`, the SDK/discovery conversion does not propagate those callbacks into the registered definition. Direct `CustomToolAdapter` consumers retain them.

## How tools are exposed to the model

- Session bootstrap wraps included SDK-provided and discovered custom tools as extension tool definitions; library consumers may instead use `CustomToolAdapter` directly.
- They are inserted into the session tool registry by name.
- Unrestricted SDK bootstrap auto-enables custom and extension-registered tools unless the effective registry winner is hidden/default-inactive. Explicit `toolNames` can enable hidden tools. Restricted sessions exclude SDK-provided custom tools unless `allowRestrictedCustomTools: true`, and expose an opted-in custom tool only when its name appears in `toolNames`; ambient filesystem tool discovery is skipped.
- With `tools.xdev` enabled and the `read`/`write` transport available, enabled discoverable tools are mounted under `xd://` rather than advertised as top-level functions. Explicitly requested tools and essential tools stay top-level.
- CLI `--tools` validates against the fully discovered session registry, including registered custom tools. Unknown names and unavailable built-ins produce distinct errors.

## Rendering hooks

Optional rendering hooks:

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme)`

The normal SDK and filesystem-discovery paths wrap custom tools as extensions. On those paths, `renderResult` receives only the three arguments above; the bridge does not forward the original tool arguments. The public `CustomTool` type retains an optional fourth `args` parameter for direct `CustomToolAdapter` consumers.

On extension-adapter paths, `renderCall`'s `options` argument additionally answers the `Theme` API, allowing upstream pi renderers to use their second argument for styling. The third argument remains the theme, not upstream pi's context object.

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

## Reloading tools in a running session

Tool modules are discovered and imported when a session starts. A top-level session (not a subagent) can re-read them while it runs, without restarting:

- `/reload-plugins` (and the ACP and RPC reload commands) calls `AgentSession.refreshCustomTools({ retryFailed: true })`.
- With `hotReload.tools` on (default on; `/settings` → Tools → "Hot Reload Tools", gated by `hotReload.enabled`), the session's `HotReloadCoordinator` polls the `tools/` directories every 2 seconds and reloads custom tools when their files change. `hotReload.skills` (default on; `/settings` → Tasks → "Hot Reload Skills") independently watches the `skills/` directories.
- SDK consumers call `session.refreshCustomTools()` themselves. It resolves to `{ added, replaced, removed, errors }` (tool names, plus failed modules), or `undefined` for a session that does not load custom tools.

A refresh re-runs tool discovery and compares it with what is loaded, by module file and tool name:

| Situation                                                  | Result                                                                                                                                                                            |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New tool file                                              | The tool is registered and its `onSession` receives `start`.                                                                                                                      |
| Tool file edited (mtime or size changed)                   | The module is re-imported (cache bypassed) and its factory re-run. The old tool's `onSession` receives `shutdown` first, then the new tool replaces it and receives `start`.      |
| Tool file deleted, or its factory stopped returning a tool | The old tool's `onSession` receives `shutdown`, and the tool is removed from the registry (a built-in it shadowed is restored).                                                   |
| Untouched tool file                                        | Nothing runs; its tool and state are kept.                                                                                                                                        |
| Module throws on import, or returns an invalid tool        | The failure is reported and the other modules are applied. If the module was already loaded, its previous tool stays in place (a half-saved edit does not remove a working tool). |
| Name collides with a built-in or another module's tool     | Reported as an error, same as at startup.                                                                                                                                         |

The result is announced as a status line, for example `tools reloaded: +2 ~1 -0` (added, replaced, removed), followed by one line per failed module. Nothing is announced when nothing changed. A module that failed is not re-reported on later refreshes until it changes, except by `/reload-plugins`, which retries failed modules.

Constraints:

- Only the tool's entry file is watched and compared. A helper module the tool imports is re-evaluated when the entry file is re-imported, but editing only the helper does not trigger a reload; touch the entry file.
- Module-level state in a replaced tool is lost; keep durable state in the session (see `onSession`) or on disk.
- `hotReload.tools` and `hotReload.skills` apply changes only while the session is idle. A change that lands during a turn is announced as deferred and applied when the turn ends. `/reload-plugins` and `refreshCustomTools()` apply immediately because you asked for it.
- Extension modules have their own hot-reload setting (`hotReload.extensions`).

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

- Normal session integration catches and logs `onSession` errors as warnings; library consumers using their own lifecycle dispatch must supply their own error handling.

## Real constraints to design for

- Tool names must be globally unique in the active registry.
- Prefer deterministic, schema-shaped outputs in `details` for renderer/state reconstruction.
- Guard UI usage with `pi.hasUI`.
- Treat `.md`/`.json` in tool directories as metadata, not executable modules.
