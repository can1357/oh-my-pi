---
title: Extensions
description: Extend omp with TypeScript modules that add tools, slash commands, event handlers, and custom rendering.
coverage: B
---

An extension is a TypeScript or JavaScript module that omp loads at startup. From a single file you can register tools the model can call, slash commands you can type, event handlers that intercept the session lifecycle, keyboard shortcuts, CLI flags, and custom renderers. Extensions are omp's most capable extension point — a strict superset of [hooks](/oh-my-pi/extending/hooks/) and [custom tools](/oh-my-pi/extending/custom-tools/).

## A minimal extension

An extension module exports a default factory that receives the `ExtensionAPI` (conventionally named `pi`):

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("My extension loaded!", "info");
  });
}
```

That is a complete, working extension. Save it as `~/.omp/agent/extensions/hello.ts` and restart omp to see the notification.

## Where extensions live

omp discovers extension modules from these sources, in order:

1. **Project directory** — `<cwd>/.omp/extensions/`
2. **User directory** — `~/.omp/agent/extensions/` (under `omp --profile <name>` this becomes `~/.omp/profiles/<name>/agent/extensions/`)
3. **Settings lists** — `extensions` entries in `<cwd>/.omp/settings.json` and `~/.omp/agent/settings.json`
4. **Installed plugins** — extension entries from plugin `package.json` manifests (`omp.extensions` or legacy `pi.extensions`); see [Plugins](/oh-my-pi/extending/plugins/)
5. **Explicit paths** — CLI flags and the `extensions` setting (below)

When omp scans an `extensions/` directory it loads direct `*.ts`/`*.js` files and one level of subdirectories (each with an `index.ts`, `index.js`, or a `package.json` manifest). It does not recurse deeper.

## Loading order and precedence

All sources are merged into one ordered list: auto-discovered modules first, then JS/TS hook factories, then installed plugin entries, then explicitly configured paths. De-duplication is by absolute path — **the first occurrence of a path wins** and later duplicates are ignored. So a module that is both auto-discovered and explicitly configured loads once, at its auto-discovered position.

When a configured path points at a directory, the entry point resolves in this order:

1. `package.json` with an `omp.extensions` (or legacy `pi.extensions`) field — declared entries are resolved relative to that directory
2. `index.ts`
3. `index.js`

In an `index.ts`/`index.js` pair, TypeScript is preferred.

A module that fails to load (missing file, non-function export, factory that throws) produces a per-path error and does not stop the other extensions from loading.

## Configuring extensions

Add explicit paths with the CLI or the `extensions` setting:

```bash
omp --extension ./my-ext.ts
omp -e ./my-ext.ts        # short form; --hook is treated as an alias
```

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/my-exts/safety.ts
  - ./local/ext-pack
```

Configured paths expand `~`; relative paths resolve against the current working directory.

To turn off all extension loading:

```bash
omp --no-extensions
```

:::caution
`--no-extensions` also drops explicitly passed `-e`/`--extension`/`--hook` paths — they are not forwarded in that mode.
:::

To disable one module without deleting it, add its derived name to `disabledExtensions`:

```yaml
# ~/.omp/agent/config.yml
disabledExtensions:
  - extension-module:my-ext
```

The derived name is the filename stem, or the directory name for `index.ts`-style entries: `/path/to/my-ext.ts` → `my-ext`, `/path/to/audit/index.ts` → `audit`.

## Registering tools, commands, and handlers

A fuller example that registers a session handler, an LLM-callable tool, and a slash command:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.setLabel("Safety + Utilities");

  // Event handler: runs when the session starts
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Session ready in ${ctx.cwd}`, "info");
  });

  // Event handler: block dangerous bash commands (fail-closed policy)
  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      return { block: true, reason: "Blocked by extension policy" };
    }
  });

  // LLM-callable tool: /word_count is invoked by the model
  pi.registerTool({
    name: "word_count",
    label: "Word Count",
    description: "Count the words in a string",
    parameters: z.object({
      text: z.string().describe("Text to count"),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const count = params.text.split(/\s+/).filter(Boolean).length;
      return {
        content: [{ type: "text", text: String(count) }],
        details: { count },
      };
    },
  });

  // Slash command: /greet
  pi.registerCommand("greet", {
    description: "Send a greeting into the conversation",
    handler: async (args, ctx) => {
      const name = args.trim() || "world";
      ctx.ui.notify(`Greeted ${name}`, "info");
    },
  });
}
```

Tool parameter schemas use [Zod](https://zod.dev), available at `pi.zod` (a zod/v4 module injected by the host — do not import your own copy). `pi.typebox` exists as a compatibility shim for legacy TypeBox-style schemas.

Command handlers receive an `ExtensionCommandContext` with session-control methods that event handlers do not get:

| Method | Effect |
| --- | --- |
| `waitForIdle()` | Wait for the agent to finish streaming |
| `newSession(opts?)` | Open a fresh session |
| `switchSession(path)` | Switch to an existing session file |
| `branch(entryId)` | Fork from a specific history entry |
| `navigateTree(id, opts?)` | Jump to a different point in the session tree |
| `reload()` | Reload the session runtime |
| `compact(opts?)` | Compact the current context |

## Sending messages from an extension

`pi.sendMessage(message, options)` injects a message into the session. The `deliverAs` option controls routing:

| `deliverAs` | Behavior |
| --- | --- |
| `"steer"` (default) | Interrupts the current run |
| `"followUp"` | Queued to run after the current run finishes |
| `"nextTurn"` | Stored and injected on the next user prompt |

Add `triggerTurn: true` to start a turn when the agent is idle. `pi.sendUserMessage(content, { deliverAs })` always goes through the normal prompt flow: with no `deliverAs` it starts a normal prompt when idle and queues as a steer while streaming.

## Events

Handlers subscribe with `pi.on(event, handler)`. The main groups:

- **Session lifecycle** — `session_start`, `session_before_switch` / `session_switch`, `session_before_branch` / `session_branch`, `session_before_compact` / `session_compact`, `session_before_tree` / `session_tree`, `session_shutdown`. The `before_*` events are cancelable by returning `{ cancel: true }`.
- **Prompt and turn lifecycle** — `input`, `before_agent_start`, `agent_start` / `agent_end`, `turn_start` / `turn_end`, `message_start` / `message_update` / `message_end`, `session_stop`.
- **Tool lifecycle** — `tool_call` (pre-execution; may block the call or revise its input), `tool_result` (post-execution; may patch content, details, or the error flag — handlers run in extension order and each sees prior modifications), plus `tool_execution_start` / `tool_execution_update` / `tool_execution_end` and `tool_approval_requested` / `tool_approval_resolved` for observability.
- **MCP notifications** — `mcp_notification` fires for every JSON-RPC notification from a connected MCP server, with payload `{ server, method, params }`. See [MCP](/oh-my-pi/extending/mcp/).

For the intercept-style hook events (`PreToolUse`, `PostToolUse`, and friends), see [Hooks](/oh-my-pi/extending/hooks/).

## Sharp edges

:::caution
**Do not call runtime actions during load.** Methods like `pi.sendMessage()` throw `ExtensionRuntimeNotInitializedError` if called synchronously while the module evaluates. Register handlers, tools, and commands during load; perform runtime actions only from inside them.
:::

- **`tool_call` errors are fail-closed.** If a `tool_call` handler throws, the tool call is blocked.
- **Raw timers can take down the session.** Extensions run in-process with no isolation: a raw `setInterval`/`setTimeout` or detached-promise callback that throws escapes handler error handling and crashes the whole session. Use `ctx.setInterval` / `ctx.setTimeout` for background work — they contain callback errors, are cleared automatically on `session_shutdown`, and can be cancelled with `ctx.clearTimer(handle)`.
- **Command names must not clash with built-ins.** Conflicting commands are skipped with a diagnostic log.
- **Reserved shortcuts are ignored**: `ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+k`, `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+g`, `ctrl+q`, `alt+m`, `shift+tab`, `shift+ctrl+p`, `alt+enter`, `escape`, `enter`.
- **UI support varies by mode.** Interactive mode supports dialogs, editor integration, widgets, and theming; RPC mode round-trips dialogs but treats much of the UI surface as no-ops; in headless and subagent contexts `ctx.hasUI` is `false` and UI methods are no-ops.

## Debugging

omp writes structured logs to a rotating file under `~/.omp/logs/` (nothing goes to the console, which would corrupt the TUI). Failed extension loads are logged with their path and error:

```bash
tail -f ~/.omp/logs/omp.$(date +%F).log
```

Extensions can emit their own log lines via `pi.logger`.
