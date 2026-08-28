---
name: authoring-extensions
description: Use when creating a new omp extension. Covers ExtensionAPI, factory signature, tool/command/event registration, and local-dev testing.
---

# Authoring Extensions

Extensions are the primary way to add capabilities to `oh-my-pi`. A single extension module can register tools the LLM can call, slash commands users can invoke, and event handlers that run throughout the session lifecycle — all from one TypeScript file. Its default factory may initialize synchronously or return a promise.

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
        { triggerTurn: false }
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
   - `<cwd>/.omp/extensions/`
   - `~/.omp/agent/extensions/`
   - legacy extension paths listed in `.omp/settings.json#extensions` or `~/.omp/agent/settings.json#extensions`
2. Enabled installed plugins under `~/.omp/plugins/node_modules` or a project plugin root — including npm, marketplace, and `omp plugin link` installs — via their `omp.extensions`/`pi.extensions` manifests.
3. Explicit configured paths passed by the CLI (`omp --extension ./my-ext.ts`, also `-e`; `--hook` is treated as an alias) and by the `extensions:` setting in config.

The runtime de-duplicates by resolved absolute path — first seen wins.

The user directory is the active profile's agent directory: the default is `~/.omp/agent`, while `omp --profile <name>` uses `~/.omp/profiles/<name>/agent` (and `PI_CODING_AGENT_DIR` overrides it).

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

`ExtensionCommandContext` session-control methods (safe to call from commands only):

| Method | Effect |
|---|---|
| `waitForIdle()` | Wait for the agent to finish streaming |
| `newSession(opts?)` | Open a fresh session |
| `switchSession(path)` | Switch to an existing session file |
| `branch(entryId)` | Fork from a specific history entry |
| `navigateTree(id, opts?)` | Jump to a different point in the session tree |
| `reload()` | Reload the session runtime |
| `compact(opts?)` | Compact the current context |

## Registering tools

Tools are called by the LLM. Parameter definitions may use the injected
Zod-compatible omptype builder; `pi.arktype` and the legacy-compatible
`pi.typebox` are also available:

```ts
const z = pi.zod;

pi.registerTool({
  name: "search_notes",           // snake_case, unique
  label: "Search Notes",          // human-readable label for TUI
  description: "Full-text search through project notes",
  parameters: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().default(10).optional().describe("Max results"),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }
    onUpdate?.({ content: [{ type: "text", text: "Searching..." }] });
    // ... do work ...
    return {
      content: [{ type: "text", text: `Found N results for "${params.query}"` }],
      details: { query: params.query, count: 0 },
    };
  },
});
```

Tool definitions may also set `loadMode: "essential" | "discoverable"` (`"discoverable"` by default), `approval: "read" | "write" | "exec"` (`"exec"` by default), and `strict` for provider structured-output grammar behavior.

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

pi.on("session_stop", async (event) => {
  if (event.stop_hook_active) return;
  return { continue: true, additionalContext: `Review final status after turn ${event.turn_id}.` };
});
```

Full event catalog: see [extension authoring guide](../extensions.md).

## Extension vs hook — when to use which

| Need | Use |
|---|---|
| Tools + commands + events in one module | **Extension** (`ExtensionAPI`) |
| Pure event interception (policy, redaction) | **Extension** or **Hook** (both work; extension is preferred) |
| Legacy hook module already exists | **Hook** (`HookAPI` from `@oh-my-pi/pi-coding-agent/extensibility/hooks`) |
| Registering a provider, shortcut, or CLI flag | **Extension only** |
| Shipping as a marketplace plugin | **Extension** (use `package.json` manifest) |

Extensions are a strict superset of hooks. New authoring should use `ExtensionAPI`.

## Debugging

omp writes structured logs under the active state root's `logs/` directory (by default `~/.omp/logs/`; debug level is always on, and nothing is written to the console because that would corrupt the TUI). Each filename includes the process ID. Tail today's default-profile logs to see extension load diagnostics:

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
