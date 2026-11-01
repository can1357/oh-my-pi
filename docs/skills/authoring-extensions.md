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

An installed plugin that ships commands for the agent's shell declares their directory with `bin` instead of adding itself to `PATH`:

```json
{
  "omp": {
    "extensions": ["./dist/main.js"],
    "bin": ["./bin"]
  }
}
```

Before omp imports an extension or tool module that lies under an enabled installed plugin's installed path, whichever route chose it (ambient discovery, a `--no-extensions` session's manifest tools, a module file passed with `--extension` or `--trusted-extension`, or an SDK caller's preload lists), and when it validates a plugin at install, it puts that plugin's `bin` directories at the front of `PATH` under the installed path. Listing modules (`getAllPluginExtensionPaths()`, `getAllPluginToolPaths()`, or discovery that imports nothing) changes nothing. A normal session also adds every enabled plugin's directories when it loads its ambient selection, so a plugin that ships only commands has them. A `--no-extensions` session loads only the tools installed plugins name in their manifest's `tools`, and adds the directories only of those plugins: it does not scan installed plugins' conventional `tools/` directories, so a plugin of yours whose tools live only in `tools/`, or that ships no tool, has none of its tools or commands in such a session. An SDK caller that passes its own preload lists, and so runs no ambient selection, gets the directories only of the plugins whose modules it loads. A `bin` directory whose path holds the `PATH` separator (`:`, or `;` on Windows), in the manifest entry or in the plugins root, cannot be one `PATH` entry: install refuses the plugin and says why, and a session skips that directory with a warning in the log. A shell a session starts after the directories are added has them, even when an earlier session in the same process started its shell before. Entries stay on `PATH` for the life of the process, so in a process that runs several sessions (an SDK host), a later session has the directories an earlier one added, whatever its own selection. Disabling or uninstalling a plugin does not take its directories off `PATH` in a running process: its commands keep working while their files exist, fail once the files are removed, and work again if files reappear at that path.

A module that runs one of these commands with `Bun.spawn()` or `Bun.spawnSync()` passes `env: process.env`: given no `env`, Bun 1.4 starts the child with the environment the process started with, which lacks the directories omp added. `Bun.$` and `node:child_process` use the current `process.env`, and so does the session's own shell.

Because the directories go ahead of everything already on `PATH`, a plugin's command outranks any command of the same name the user has: a plugin's `bin/fmt` runs instead of the user's own `~/bin/fmt`, or of one in a virtualenv activated before omp started. Name plugin commands so they cannot collide. A user who wants their own command to win lists the plugin's installed `bin` path on `PATH` themselves, behind their own directory and with no other path to that directory ahead of it; omp then adds nothing. Any spelling of the installed path counts: absolute, relative to omp's working directory, with a trailing separator, or with `.` segments.

Do not build a `PATH` entry from `import.meta.url` or `__dirname`: a module's location is its realpath, and when a symlinked plugins root (a dotfiles link, a marketplace upgrade) is re-pointed and the old target removed, a running session loses every command on a realpath entry, even with a valid entry later on `PATH`: a shell keeps the path it found for a command it already ran.

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
- **Reserved shortcuts are ignored** (`ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+k`, `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+g`, `ctrl+q`, `alt+m`, `shift+tab`, `shift+ctrl+p`, `alt+enter`, `escape`, `enter`).

## Further reading

- `docs/extensions.md` — runtime internals and full API surface reference
- `docs/extension-loading.md` — detailed path resolution rules
- `docs/hooks.md` — hook subsystem internals
- `docs/skills/examples/hello-extension/` — complete working example
