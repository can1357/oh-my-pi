---
name: authoring-extensions
description: Use when creating a new omp extension. Covers ExtensionAPI, factory signature, tool/command/event registration, and local-dev testing.
---

# Authoring Extensions

Extensions are the primary way to add capabilities to `omp`. A single extension module can register tools the LLM can call, slash commands users can invoke, and event handlers that run throughout the session lifecycle — all from one TypeScript file. Its default factory may initialize synchronously or return a promise.

## Minimum viable extension

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("My extension loaded!", "info");
	});
}
```

That is a working extension. Drop it into `~/.omp/agent/extensions/hello.ts` and restart omp to see the notification.

## Full example

The following extension registers a slash command, a tool, and a session-start hook:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
	const z = pi.zod;

	// Runs once when the session loads
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify(`Session ready in ${ctx.cwd}`, "info");
	});

	// Slash command: /greet
	pi.registerCommand("greet", {
		description: "Send a greeting into the conversation",
		handler: async (args, ctx) => {
			const name = args.trim() || "world";
			pi.sendMessage(
				{
					customType: "greeting",
					content: `Hello, ${name}!`,
					display: true,
					attribution: "user",
				},
				{ triggerTurn: false },
			);
			ctx.ui.notify(`Greeted ${name}`, "info");
		},
	});

	// LLM-callable tool
	pi.registerTool({
		name: "word_count",
		label: "Word Count",
		description: "Count the words in a string",
		parameters: z.object({
			text: z.string().describe("Text to count"),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const count = params.text.split(/\s+/).filter(Boolean).length;
			return {
				content: [{ type: "text", text: String(count) }],
				details: { count },
			};
		},
	});
}
```

## Discovery paths

omp loads extension modules from these sources:

1. Native `.omp` locations discovered through the capability system:
   - project/ancestor `.omp/extensions/` directories within the discovery boundary
   - `~/.omp/agent/extensions/`
   - legacy extension paths listed in `.omp/settings.json#extensions` or `~/.omp/agent/settings.json#extensions`
2. Discovered JavaScript/TypeScript hook factories (`hooks/pre/` and `hooks/post/`), bound through the extension runner.
3. Enabled installed plugins under `~/.omp/plugins/node_modules` or a project plugin root — including npm, marketplace, and `omp plugin link` installs — via their `omp.extensions`/`pi.extensions` manifests.
4. Explicit configured paths passed by the CLI (`omp --extension ./my-ext.ts`, also `-e`; `--hook` is treated as an alias) and by the `extensions:` setting in config.

The runtime de-duplicates by resolved absolute path — first seen wins.

`--no-extensions` disables ambient discovery but still permits explicit `--extension`/`--hook` paths and their bundled capabilities. For an exact module-file allowlist, repeat `--trusted-extension /absolute/path/to/module.ts`: paths must exist and be files, ambient extension discovery is disabled, and those files are not treated as package roots for sibling capability discovery. It cannot be combined with `--extension`, `-e`, or `--hook`; a trusted-module load error aborts startup. This is discovery control, not a sandbox for extension code.

The user directory is the active profile's agent directory: the default is `~/.omp/agent`, while `omp --profile <name>` uses `~/.omp/profiles/<name>/agent` under the default layout. `PI_CODING_AGENT_DIR` overrides the default profile's agent directory; named profiles derive their own directory instead. Initialized XDG roots can change these locations.

When a path points to a directory, omp resolves the entry point in this order:

1. `package.json` with `omp.extensions` (or legacy `pi.extensions`) field
2. `index.ts`
3. `index.js`

When scanning an `extensions/` directory, omp also loads direct `*.ts`/`*.js` files and one-level subdirectories that have `index.ts`, `index.js`, or a manifest.

Extension packages can also bundle sibling capability directories. When a package is loaded through `extensions:` or `--extension`/`-e`, the `omp-plugins` provider discovers its `skills/`, `hooks/pre|post/`, `tools/`, `commands/`, `rules/`, `prompts/`, and `.mcp.json`.

## package.json manifest

To package an extension as an installable plugin, add an `omp` field to `package.json`:

```json
{
	"name": "my-omp-extension",
	"omp": {
		"extensions": ["./src/main.ts"]
	}
}
```

The legacy `pi` key is also accepted for backwards compatibility:

```json
{
	"pi": {
		"extensions": ["./index.ts"]
	}
}
```

Multiple entry points are supported:

```json
{
	"omp": {
		"extensions": ["./src/safety.ts", "./src/tools.ts"]
	}
}
```

Installed-plugin manifest entries may be `.ts`, `.js`, `.mjs`, or `.cjs`; a manifest entry naming a directory resolves `index.ts`, `index.js`, `index.mjs`, or `index.cjs`. Automatic scanning of native/configured extension directories remains limited to `.ts` and `.js`.

## Registering commands

```ts
pi.registerCommand("my-cmd", {
	description: "What the command does",
	handler: async (args, ctx) => {
		// args: everything the user typed after /my-cmd
		// ctx: ExtensionCommandContext — includes ctx.ui, ctx.cwd, session controls
		ctx.ui.notify("Running!", "info");
		await ctx.waitForIdle();
		await ctx.newSession();
	},
});
```

`ExtensionCommandContext` session-control methods:

| Method                            | Effect                                                                     |
| --------------------------------- | -------------------------------------------------------------------------- |
| `waitForIdle()`                   | Wait for the agent to finish streaming                                     |
| `newSession(opts?)`               | Open a fresh session                                                       |
| `switchSession(path)`             | Switch to an existing session file                                         |
| `branch(entryId)`                 | Fork from a specific history entry                                         |
| `navigateTree(id, opts?)`         | Jump to a different point in the session tree                              |
| `reload()`                        | Reload the session runtime                                                 |
| `compact(instructionsOrOptions?)` | Compact the current context; also available on the base `ExtensionContext` |

Use command contexts for switching, branching, tree navigation, and reload. `compact()` accepts either an instruction string or `CompactOptions`.

## Registering tools

Tools are called by the LLM. Parameter definitions may use the injected
Zod-compatible omptype builder; `pi.arktype` and the legacy-compatible
`pi.typebox` are also available:

```ts
const z = pi.zod;

pi.registerTool({
	name: "search_notes", // snake_case, unique
	label: "Search Notes", // human-readable label for TUI
	description: "Full-text search through project notes",
	parameters: z.object({
		query: z.string().describe("Search query"),
		limit: z.number().default(10).optional().describe("Max results"),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		if (signal?.aborted) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { query: params.query, count: 0 } };
		}
		onUpdate?.({ content: [{ type: "text", text: "Searching..." }], details: { query: params.query, count: 0 } });
		// ... do work ...
		return {
			content: [{ type: "text", text: `Found N results for "${params.query}"` }],
			details: { query: params.query, count: 0 },
		};
	},
});
```

Tool definitions may also set `loadMode: "essential" | "discoverable"` (`"discoverable"` by default), `approval: "read" | "write" | "exec"` (`"exec"` by default), and `strict` for provider structured-output grammar behavior. Set `readsSkillUris: true` only for tools that can read skill instruction URLs; this capability allows the system prompt to expose discovered skills. `hidden` requires explicit tool selection; `defaultInactive` leaves activation to the extension's `setActiveTools()`.

## Subscribing to events

```ts
pi.on("tool_call", async (event, ctx) => {
	// event.toolName, event.input, event.toolCallId
	if (event.toolName !== "bash") return;

	const command = String((event.input as { command?: unknown }).command ?? "");
	if (command.includes("rm -rf /")) {
		return { block: true, reason: "Blocked by safety policy" };
	}
});

pi.on("turn_end", async (_event, ctx) => {
	ctx.ui.setStatus("tokens", `~${ctx.getContextUsage()?.tokens ?? "?"} tokens`);
});

pi.on("session_stop", async event => {
	if (event.stop_hook_active) return;
	return { continue: true, additionalContext: `Review final status after turn ${event.turn_id}.` };
});
```

Full event catalog: see [extension authoring guide](../extensions.md).

## Changing how transcript blocks are drawn

`pi.registerTranscriptPresenter(block => …)` picks `"full"`, `"compact"`, `"hidden"` or `{ compact: { label, rows } }` for each block of the main session's transcript: tool call (`block.type === "toolCall"`, `block.id` its `toolCallId`), message block (`"message"`: advisor, skill, late diagnostics, `!`/`$` runs, background job and supervised process notices; `block.id` is `String(message.timestamp)`) and event notice (`"event"`: TTSR, todo reminder), or `undefined` to leave it to the next presenter. Return `undefined` for block types you do not know; later versions add more. It returns a disposer. Presenters only run while the user turns on `extensionRenderers.transcriptPresenters` (default off).

```ts
const finished = new Set<string>(); // tool calls of runs that have ended
pi.on("agent_end", (event, ctx) => {
	const ids: string[] = [];
	for (const message of event.messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) if (part.type === "toolCall") ids.push(part.id);
	}
	for (const id of ids) finished.add(id);
	ctx.ui.refreshTranscript(ids); // omp asks on its own only when a block's data changes
});
pi.registerTranscriptPresenter(block => {
	if (block.type !== "toolCall") return undefined;
	return block.toolName !== "edit" && finished.has(block.id) ? "hidden" : "compact";
});
```

- omp asks again when a block's data changes and whenever it rebuilds the transcript; call `ctx.ui.refreshTranscript(ids)` after your own state changes. Answer from the block and state keyed by its `id`, never per-run state. Presenters run while the transcript draws: keep them cheap.
- Focused subagents, collab guests and transcript overlays (link browser, rewind, `/copy`) draw stock cards.
- Expanded blocks (`Ctrl+O`, Tern's toggle) always draw in full; display only, the session and model context are untouched. `block.args` and `block.result` are omp's live objects: read them, never mutate them.
- Changing a block that already scrolled into terminal scrollback replays the whole scrollback once; avoid changing old blocks often.

Details: [transcript presenter](../extensions.md#transcript-presenter).

## Extension vs hook — when to use which

| Need                                          | Use                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| Tools + commands + events in one module       | **Extension** (`ExtensionAPI`)                                            |
| Pure event interception (policy, redaction)   | **Extension** or **Hook** (both work; extension is preferred)             |
| Legacy hook module already exists             | **Hook** (`HookAPI` from `@oh-my-pi/pi-coding-agent/extensibility/hooks`) |
| Registering a provider, shortcut, or CLI flag | **Extension only**                                                        |
| Shipping as a marketplace plugin              | **Extension** (use `package.json` manifest)                               |

New authoring should use `ExtensionAPI`. Discovered JS/TS hook factories are loaded through this API in normal sessions; the standalone `HookRunner` remains for legacy SDK consumers. Shared event names do not imply identical result-chaining behavior in both runners.

## Debugging

omp writes structured logs under the active state root's `logs/` directory (by default `~/.omp/logs/`; debug level is always on, and nothing is written to the console because that would corrupt the TUI). Records are written in batches, so a debug line can take up to a second to appear while `warn` and `error` lines are written immediately. Each filename includes the process ID, and a process creates its file only when it first logs. Tail today's default-profile logs to see extension load diagnostics:

```
tail -f ~/.omp/logs/omp.$(date +%F).*.log
```

Failed extension loads are logged with their path and error. Loaded extensions may also emit their own debug logs via `pi.logger`.

To temporarily disable a specific extension module by name without removing the file:

```yaml
# ~/.omp/agent/config.yml
disabledExtensions:
   - extension-module:my-ext
```

The derived name is the filename stem (or directory name for `index.ts`-style entries): `/path/to/my-ext.ts` → `my-ext`.

## Important constraints

- **Do not call runtime actions during load.** Methods like `pi.sendMessage()` throw `ExtensionRuntimeNotInitializedError` if called synchronously during module evaluation (before a session is active). Register handlers/tools/commands during load; perform runtime actions only from event handlers, tools, or commands.
- **`tool_call` errors are fail-closed.** If a `tool_call` handler throws, the tool is blocked.
- **Self-scheduled callbacks run in-process with no isolation.** A raw `setInterval`/`setTimeout`/detached-promise callback that throws escapes the handler-dispatch try/catch and crashes the whole session (`uncaughtException`). Use `ctx.setInterval` / `ctx.setTimeout` for background work — they contain callback throws and auto-clear on `session_shutdown`. With raw timers you must add your own `try/catch` and cleanup.
- **Command names must not clash with built-ins.** Conflicts are skipped with a diagnostic log.
- **Reserved shortcuts are ignored** (`ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+k`, `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+g`, `ctrl+q`, `alt+m`, `shift+tab`, `shift+ctrl+p`, `alt+enter`, `escape`, `enter`). Check a chord with `pi.getShortcutConflict(chord)` from a handler.

## Further reading

- `docs/extensions.md` — runtime internals and full API surface reference
- `docs/extension-loading.md` — detailed path resolution rules
- `docs/hooks.md` — hook subsystem internals
- `docs/skills/examples/hello-extension/` — complete working example
