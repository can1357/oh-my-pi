---
name: authoring-extensions
description: Use when creating a new omp extension. Covers ExtensionAPI, factory signature, tool/command/event registration, and local-dev testing.
---

# Authoring Extensions

Extensions are the primary way to add capabilities to `oh-my-pi`. A single extension module can register tools the LLM can call, slash commands users can invoke, and event handlers that run throughout the session lifecycle — all from one TypeScript file.

## Minimum viable extension

```ts
import type { ExtensionAPI } from "@pk-nerdsaver-ai/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("My extension loaded!", "info");
  });
}
```

That is a working extension. Drop it into `~/.ompk/agent/extensions/hello.ts` and restart omp to see the notification.

## Full example

The following extension registers a slash command, a tool, and a session-start hook:

```ts
import type { ExtensionAPI } from "@pk-nerdsaver-ai/pi-coding-agent";

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

1. Native `.ompk` locations discovered through the capability system:
   - `<cwd>/.ompk/extensions/`
   - `~/.ompk/agent/extensions/`
   - legacy extension paths listed in `.ompk/settings.json#extensions` or `~/.ompk/agent/settings.json#extensions`
2. Installed plugins under `~/.ompk/plugins/node_modules` (`oh-my-pk plugin install` npm/git specs, or `oh-my-pk plugin link`) via their `omp.extensions`/`pi.extensions` manifests. Marketplace cache installs do not feed extension modules — they surface skills/commands/hooks/tools/MCP only.
3. Explicit configured paths passed by the CLI (`oh-my-pk --extension ./my-ext.ts`, also `-e`; `--hook` is treated as an alias) and by the `extensions:` setting in config.

The runtime de-duplicates by resolved absolute path — first seen wins.

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

Tools are called by the LLM. Parameters use [Zod](https://zod.dev) schemas, available at `pi.zod`:

```ts
const z = pi.zod;

pi.registerTool({
  name: "search_notes",           // snake_case, unique
  label: "Search Notes",          // human-readable label for TUI
  description: "Full-text search through project notes",
  parameters: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().default(10).describe("Max results").optional(),
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
| Legacy hook module already exists | **Hook** (`HookAPI` from `@pk-nerdsaver-ai/pi-coding-agent/extensibility/hooks`) |
| Registering a provider, shortcut, or CLI flag | **Extension only** |
| Shipping as a marketplace plugin | **Extension** (use `package.json` manifest) |

Extensions are a strict superset of hooks. New authoring should use `ExtensionAPI`.

## Debugging

omp writes structured logs to a rotating file under `~/.ompk/logs/` (debug level is always on; nothing is written to the console, which would corrupt the TUI). Tail today's log to see extension load diagnostics:

```
tail -f ~/.ompk/logs/omp.$(date +%F).log
```

Failed extension loads are logged with their path and error. Loaded extensions may also emit their own debug logs via `pi.logger`.

To temporarily disable a specific extension module by name without removing the file:

```yaml
# ~/.ompk/agent/config.yml
disabledExtensions:
  - extension-module:my-ext
```

The derived name is the filename stem (or directory name for `index.ts`-style entries): `/path/to/my-ext.ts` → `my-ext`.

## Important constraints

- **Do not call runtime actions during load.** Methods like `pi.sendMessage()` throw `ExtensionRuntimeNotInitializedError` if called synchronously during module evaluation (before a session is active). Register handlers/tools/commands during load; perform runtime actions only from event handlers, tools, or commands.
- **`tool_call` errors are fail-closed.** If a `tool_call` handler throws, the tool is blocked.
- **Command names must not clash with built-ins.** Conflicts are skipped with a diagnostic log.
- **Reserved shortcuts are ignored** (`ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+k`, `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+g`, `ctrl+q`, `alt+m`, `shift+tab`, `shift+ctrl+p`, `alt+enter`, `escape`, `enter`).

## Further reading

- `docs/extensions.md` — runtime internals and full API surface reference
- `docs/extension-loading.md` — detailed path resolution rules
- `docs/hooks.md` — hook subsystem internals
- `docs/skills/examples/hello-extension/` — complete working example
