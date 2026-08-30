# Extensions

Primary guide for authoring runtime extensions in `packages/coding-agent`.

This document covers the current extension runtime in:

- `src/extensibility/extensions/types.ts`
- `src/extensibility/extensions/runner.ts`
- `src/extensibility/extensions/wrapper.ts`
- `src/extensibility/extensions/index.ts`
- `src/modes/controllers/extension-ui-controller.ts`

For discovery paths and filesystem loading rules, see [`extension-loading.md`](./extension-loading.md).

For packaged user-facing extension CLIs/features, see [`user-facing-packages.md`](./user-facing-packages.md).

## What an extension is

An extension is a TS/JS module exporting a default factory. Factories may initialize synchronously or return a promise:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // register handlers/tools/commands/renderers
}
```

Extensions can combine all of the following in one module:

- event handlers (`pi.on(...)`)
- LLM-callable tools (`pi.registerTool(...)`)
- slash commands (`pi.registerCommand(...)`)
- keyboard shortcuts and flags
- custom message rendering
- session/message injection APIs (`sendMessage`, `sendUserMessage`, `appendEntry`)

## Runtime model

1. Extensions are imported and their factory functions run.
2. During that load phase, registration methods are valid; runtime action methods are not yet initialized.
3. `ExtensionRunner.initialize(...)` wires live actions/contexts for the active mode.
4. Session/agent/tool lifecycle events are emitted to handlers.
5. Every tool execution is wrapped with extension interception (`tool_call` / `tool_result`).

```text
Extension lifecycle (simplified)

load paths
   │
   ▼
import module + run factory (registration only)
   │
   ▼
ExtensionRunner.initialize(mode/session/tool registry)
   │
   ├─ emit session/agent events to handlers
   ├─ wrap tool execution (tool_call/tool_result)
   └─ expose runtime actions (sendMessage, setActiveTools, ...)
```

Important constraint from `loader.ts`:

- calling action methods like `pi.sendMessage()` during extension load throws `ExtensionRuntimeNotInitializedError`
- register first; perform runtime behavior from events/commands/tools

## Quick start

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const z = pi.zod;

  pi.setLabel("Safety + Utilities");

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Extension loaded in ${ctx.cwd}`, "info");
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      return { block: true, reason: "Blocked by extension policy" };
    }
  });

  pi.registerTool({
    name: "hello_extension",
    label: "Hello Extension",
    description: "Return a greeting",
    parameters: z.object({ name: z.string() }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}` }],
        details: { greeted: params.name },
      };
    },
  });

  pi.registerCommand("hello-ext", {
    description: "Show queue state",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`pending=${ctx.hasPendingMessages()}`, "info");
    },
  });
}
```

## Extension API surfaces

## 1) Registration and actions (`ExtensionAPI`)

Core methods:

- `on(event, handler)`
- `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`
- `registerMessageRenderer`, `registerAssistantThinkingRenderer`
- `registerComposerShape`
- `setLabel`, `getFlag`
- `sendMessage`, `sendUserMessage`, `appendEntry`, `exec`
- `getActiveTools`, `getAllTools`, `setActiveTools`
- `getCommands`
- `getSessionName`, `setSessionName`
- `setModel`, `getThinkingLevel`, `setThinkingLevel`
- `getServiceTiers`, `setServiceTier`
- `registerProvider`
- `registerFileWriteFallback`, `registerFileDeleteFallback`
- `events` (shared event bus)

`getServiceTiers()` returns a detached snapshot of the session's live per-family tier map. `setServiceTier(family, tier)` changes one family for subsequent requests; pass `undefined` to clear that session override. OpenAI accepts `auto`, `default`, `flex`, `scale`, or `priority`; Anthropic accepts `priority`; Google accepts `flex` or `priority`. Changes made while a response is streaming do not alter that in-flight request.

### Provider registration

`pi.registerProvider(name, config)` can include an optional `usage` field containing a
`UsageProvider` imported from `@oh-my-pi/pi-ai`. Its `fetchUsage` implementation receives the
normalized credential and returns a normalized `UsageReport`; the result is then handled
by the host's AuthStorage cache, history, and usage displays just like built-in provider
usage.

```ts
pi.registerProvider("my-provider", {
  baseUrl: "https://api.example.com/v1",
  api: "openai-completions",
  usage: {
    id: "my-provider",
    async fetchUsage(params, { fetch }) {
      const response = await fetch("https://api.example.com/usage", {
        headers: { Authorization: `Bearer ${params.credential.apiKey}` },
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { used: number; limit: number };
      return {
        provider: "my-provider",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "requests",
            label: "Requests",
            scope: { provider: "my-provider" },
            amount: { used: payload.used, limit: payload.limit, unit: "requests" },
          },
        ],
      };
    },
  },
});
```

An extension usage provider overrides a built-in provider with the same name for as
long as that extension registration is active. `pi.unregisterProvider(name)` (and
extension source cleanup) removes only that runtime override, restoring the built-in
or configured usage resolver.

Extension-registered providers (`registerProvider`) can supply `fetchDynamicModels` for runtime model discovery; these fetches are hard-bounded to a 15-second timeout (`RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS` in `model-provider-discovery.ts`) so a hung endpoint cannot stall discovery.

In interactive mode, `input` handlers run before the built-in first-message auto-title check. Extensions that call `await pi.setSessionName(...)` from `input` can set the persisted session name and prevent the default auto-generated title from running for that session.

Also exposed:

- `pi.logger`
- `pi.arktype` (the omptype `type(...)` schema builder)
- `pi.zod` (Zod-compatible builder backed by omptype)
- `pi.typebox` (legacy TypeBox-compatible shim)
- `pi.pi` (package exports)

### Message delivery semantics

`pi.sendMessage(message, options)` supports:

- `deliverAs: "steer"` (default) — interrupts current run
- `deliverAs: "followUp"` — queued to run after current run
- `deliverAs: "nextTurn"` — stored and injected on the next user prompt
- `triggerTurn: true` — starts a turn when idle (also honored with `deliverAs: "nextTurn"`: idle prompts immediately; while streaming the queued message schedules an internal continuation)

`pi.sendUserMessage(content, { deliverAs })` always goes through prompt flow. Omit `deliverAs` to start a normal prompt when idle; while streaming, omitted `deliverAs` queues the message as a steer. Set `deliverAs: "followUp"` to wait until the current run finishes.

Payloads passed to `pi.sendMessage` are normalized before delivery (`normalizeCustomMessagePayload` in `session/messages.ts`): non-object payloads are coerced to string content under the default custom type, missing `customType`/`attribution` fields are defaulted, and invalid content collapses to an empty string — malformed payloads no longer persist entries that crash later session resumes.

## 2) Handler context (`ExtensionContext`)

Handlers and tool `execute` receive `ctx` with:

- `ui`
- `hasUI`
- `cwd`
- `sessionManager` (read-only)
- `modelRegistry`, `model`
- `models` (read-only model query — see below)
- `localProtocolOptions` (optional calling-session `local://` root mapping for external tool bridges)
- `getContextUsage()`
- `getAsyncJobSnapshot()` returns the current session's read-only async-job snapshot, or `null` when no session owns the context
- `compact(...)`
- `isIdle()`, `hasPendingMessages()`, `abort()`
- `shutdown()`
- `getSystemPrompt()`
- `memory` (optional structured memory runtime — status/search/save across the configured backend)
- `setInterval(fn, ms, ...args)` / `setTimeout(fn, ms, ...args)` / `clearTimer(timer)` — managed timers (see below)

### Background work (`ctx.setInterval` / `ctx.setTimeout`)

Extensions run **in-process with no isolation**. A raw `setInterval`/`setTimeout`/detached-promise callback that throws runs outside the handler-dispatch try/catch, surfaces as a process-level `uncaughtException`, and the global postmortem handler treats it as fatal — **the whole session is torn down**, not just the offending extension.

Use `ctx.setInterval` / `ctx.setTimeout` for any periodic or deferred background work. They mirror the platform signatures but:

- run the callback with the same isolation as handler dispatch — a synchronous throw or a rejected promise is logged and reported through the extension error channel, and the session keeps running;
- return a handle you can pass to `ctx.clearTimer(handle)`;
- are `unref`'d (never keep the process alive on their own) and are cleared automatically on `session_shutdown`.

```ts
pi.on("session_start", async (_event, ctx) => {
  const timer = ctx.setInterval(() => {
    // A throw here is contained — it will not crash the session.
    ctx.ui.notify("tick", "info");
  }, 60_000);
  // Optional: clear it yourself; otherwise it is cleared on shutdown.
  pi.on("session_shutdown", () => ctx.clearTimer(timer));
});
```

If you use raw `setInterval`/`setTimeout` or detached promises instead, you own the isolation: wrap the callback body in your own `try/catch` (an unhandled throw will take down the session) and clear the timer on `session_shutdown`.

### Model selection (`ctx.models`)

`ctx.models` is a read-only facade for picking and comparing models the same way core does:

- `list()` — authenticated models available this session.
- `current()` — the live session model (read lazily, so it reflects `/model` switches).
- `resolve(spec)` — a model string (`provider/id`, bare id) or role alias (`@slow`, a configured role) → `Model`, honoring the same settings-backed aliases and match preferences as `--model`. Returns `undefined` when nothing matches.
- `family(model)` — an opaque lineage token for "same family?" checks (Claude point releases share a token; Claude and GPT differ). Compare it; don't persist it (the vocabulary tracks new releases).

```ts
// Pick a model from a different family than the current one (e.g. a cross-family reviewer).
const current = ctx.models.current();
const contrasting = ctx.models
  .list()
  .find((m) => current && ctx.models.family(m) !== ctx.models.family(current));
```

## 3) Command context (`ExtensionCommandContext`)

Command handlers additionally get:

- `waitForIdle()`
- `newSession(...)`
- `switchSession(...)`
- `branch(entryId)`
- `navigateTree(targetId, { summarize })`
- `reload()`

Use command context for session-control flows; these methods are intentionally separated from general event handlers.

## Event surface (current names and behavior)

Canonical event unions and payload types are in `types.ts`.

### Session lifecycle

- `session_start`
- `session_before_switch` / `session_switch`
- `session_before_branch` / `session_branch`
- `session_before_compact` / `session.compacting` / `session_compact`
- `session_before_tree` / `session_tree`
- `session_shutdown`

Cancelable pre-events:

- `session_before_switch` → `{ cancel?: boolean }`
- `session_before_branch` → `{ cancel?: boolean; skipConversationRestore?: boolean }`
- `session_before_compact` → `{ cancel?: boolean; compaction?: CompactionResult }`
- `session_before_tree` → `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }`

### Prompt and turn lifecycle

- `input`
- `before_agent_start`
- `before_provider_request` (may replace provider request payload — the replacement is applied by every provider that fires the hook, which is all of them except `devin-agent`, which does not fire it)
- `after_provider_response`
- `context`
- `agent_start` / `agent_end` — agent loop lifecycle notification; `agent_end` remains notification-only
- `session_stop` — main-session stop hook, awaited before settle; may continue with `{ continue: true, additionalContext }` or `{ decision: "block", reason }`; capped at 8 consecutive continuations, never fires for task/subagent sessions, and defers until agent-owned background jobs are fully idle (`#hasPendingAsyncWake` in `session/agent-session.ts`)
- `turn_start` / `turn_end`
- `message_start` / `message_update` / `message_end` — lifecycle notifications; `message_end` receives a detached message snapshot, so use `tool_result` or `context` when an extension needs to change provider context

### Tool lifecycle

- `tool_call` (pre-exec, may block, or revise the tool's execution `input`; for model-issued calls it fires at arg-prep time in the agent loop, so a revision is revalidated and seen by concurrency scheduling, execution events, the persisted assistant message, and the approval gate alike)
- `tool_result` (post-exec, may patch content/details/isError)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end` (observability)
- `tool_approval_requested` / `tool_approval_resolved` (observability; emitted by `wrapper.ts` only when a tool requires approval and an approval handler is registered)

`tool_result` is middleware-style: handlers run in extension order and each sees prior modifications.

### Reliability/runtime signals

- `auto_compaction_start` / `auto_compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`
- `goal_updated`
- `credential_disabled`

### MCP notifications

- `mcp_notification` — fired for every JSON-RPC notification received from a connected MCP server, AFTER the manager's own handling of known list/update methods (`notifications/tools/list_changed`, `notifications/resources/list_changed`, `notifications/resources/updated`, `notifications/prompts/list_changed`). Unknown or server-custom methods are also delivered. Payload: `{ server: string; method: string; params: unknown }`. Multiple extensions may subscribe; a handler that throws does not prevent other handlers from firing. Notifications received before any listener attaches are buffered (bounded FIFO, cap 100, drop-oldest) and drained into the first subscriber — so startup-time frames aren't lost even if the extension binds after MCP discovery.

Bridging a push-capable MCP into a session steer:

```ts
pi.on("mcp_notification", (event) => {
  if (event.server !== "peer-bus") return;
  if (event.method !== "notifications/peer_message") return;
  const params = event.params as { from: string; text: string };
  pi.sendUserMessage(`[from ${params.from}] ${params.text}`, {
    deliverAs: "steer",
  });
});
```

The runtime handles the JSON-RPC transport and its own list/update refresh first; the handler runs afterwards and can inject a mid-turn steer via `pi.sendMessage` / `pi.sendUserMessage`.

### User command interception

- `user_bash` (override with `{ result }`)
- `user_python` (override with `{ result }`)

### `resources_discover`

`resources_discover` exists in extension types and `ExtensionRunner`.
Current runtime note: `ExtensionRunner.emitResourcesDiscover(...)` is implemented, but there are no `AgentSession` callsites invoking it in the current codebase.

## Tool authoring details

`registerTool` uses `ToolDefinition` from `types.ts`. Its `parameters` field accepts omptype schemas; the injected TypeBox compatibility shim remains available for legacy extensions.

Current `execute` signature:

```ts
execute(
	toolCallId,
	params,
	signal,
	onUpdate,
	ctx,
): Promise<AgentToolResult>
```

### Delegating to a native built-in (`ctx.invokeTool`)

A tool that re-registers a built-in name (e.g. wrapping `write` to add logging or a policy check) can
run the original instead of reimplementing it. When your registered tool shadows a built-in, the `ctx`
passed to `execute` carries:

```ts
ctx.invokeTool?<TDetails>(
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback },
): Promise<AgentToolResult<TDetails>>
```

It runs the **native** built-in of the same name as your tool (delegation is same-tool only, so it
cannot reach an arbitrary target or escalate past the approval already granted for this call) and
returns its result, including the native tool's own side effects and internal bookkeeping. It is
present only when a native built-in of that name exists — `ctx.invokeTool` is `undefined` for a
net-new tool that shadows no built-in. The native call is not re-gated, since it is the same tool you
are already approved as, and delegation depth is guarded against accidental self-recursion.

Template:

```ts
const z = pi.zod;

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "...",
  parameters: z.object({}),
  hidden: false,
  defaultInactive: false,
  deferrable: false,
  async execute(_id, _params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
    return { content: [{ type: "text", text: "Done" }], details: {} };
  },
  onSession(event, ctx) {
    // reason: start|switch|branch|tree|shutdown
  },
  renderCall(args, options, theme) {
    // optional TUI render
  },
  renderResult(result, options, theme, args) {
    // optional TUI render
  },
});
```

`tool_call`/`tool_result` intercept all tools once the registry is wrapped in `sdk.ts`, including built-ins and extension/custom tools. `ToolDefinition` also supports optional `hidden`, `defaultInactive`, `loadMode` (`"discoverable"` by default, or `"essential"`), `deferrable`, `approval` (`"exec"` by default), `strict`, `mcpServerName`, `mcpToolName`, `renderCall`, and `renderResult` fields.

### File write fallback (`registerFileWriteFallback`)

`write`, `edit` and `apply_patch` perform the real byte-write to an ordinary file
path through one shared primitive
(`file ? file.write(content) : Bun.write(dst, content)`). When that primitive fails
with a permission error (`EPERM`/`EACCES`/`EROFS` — every other error, such as
`EISDIR`, is unaffected), the coding agent consults handlers registered
via `pi.registerFileWriteFallback` before giving up:

```ts
import type { FileWriteFallbackHandler } from "@oh-my-pi/pi-coding-agent";

const writeThroughBroker: FileWriteFallbackHandler = async (req, ctx) => {
  // req: { dst: string; content: string; cause: unknown }
  const ok = await myPrivilegedWriter.write(req.dst, req.content);
  return ok;
};

pi.registerFileWriteFallback(writeThroughBroker);
```

Handlers run in registration order; the first one to resolve `true` counts as the
bytes being durably on disk, and the native tool continues exactly as if its own
write had succeeded — including recording its file snapshot under the real
destination path, so a later hashline `edit` on that path keeps working. A
throwing handler is logged and skipped in favor of the next one — per handler, so a
later handler registered by the same extension still runs; if every handler
returns `false` (or none are registered), the original error is rethrown
unchanged. Intended for a host that embeds the agent inside a sandbox denying
direct filesystem writes but exposing a privileged write channel.

`req.dst` is the **symlink-resolved** destination, not the path the tool was given.
The kernel follows every component above the last, so `ws/link/file` under a
`ws/link -> /elsewhere` link lands outside `ws` while still looking in-workspace, and
a prefix allowlist in your handler would pass on that innocent-looking path. For a
write the final component is followed too, so it is resolved as well; for a delete it
is not, because `unlink` removes a link rather than what it points at (so a delete
`req.dst` may itself name a link). Treat `req.dst` as authoritative and do not
re-derive the target from anything else. When the real destination cannot be
established — a dangling final link, or an ancestor this process may not resolve — no
handler is consulted at all and the original error is rethrown, because there is no
destination to hand a privileged writer.

Two details matter when the destination is outside what the host allows:

- **A missing parent directory.** `Bun.write` creates missing parents itself, and
  when that `mkdir` is the operation being denied it reports the subsequent
  `open()`'s `ENOENT` rather than the denial. The agent redoes the `mkdir`
  explicitly to recover the real errno, so this still reaches a handler — with
  `req.cause` set to the `mkdir` denial. In that case `req.dst`'s parent does not
  exist yet and the handler is responsible for creating it. An `ENOENT` with a
  genuinely creatable or invalid parent is not diverted. (`apply_patch` creates the
  parent as a separate step before writing; that `mkdir` tolerates a denial when a
  fallback is registered, so the write still reaches the handler.)
- **A hashline `MV`.** `edit`'s move writes its destination directly rather than
  through the LSP writethrough. It is routed to the same handlers, and the source
  unlink goes to the delete seam below, so a move out of a directory you cannot
  write completes too.

This is deliberately not an interception of every write the agent can make. A
permission error from these surfaces as it does today, with no handler consulted:

- `write` to an archive member (`foo.zip:entry`) or to a SQLite row. Neither is a
  byte-write to `dst`: an archive rewrite reads the whole archive, replaces one
  entry, writes a temp file and renames over the original, so what lands is a whole
  binary container rather than the string the tool was handed; a SQLite write is a
  row operation inside the database engine with no byte payload at all. Brokering
  either needs a different request shape than "these bytes belong at this path".
- The ACP bridge's `writeTextFile`, which hands the write to a remote client.
- The `lsp` tool's own writes: applying a workspace edit or code action, and the
  Biome formatter, which writes the buffer and then shells out to `biome format
  --write` — a subprocess write no in-process seam can reach.

### File delete fallback (`registerFileDeleteFallback`)

Removing a file is a different primitive from writing one, and it has its own seam:

```ts
pi.registerFileDeleteFallback(async (req, ctx) => {
  // req: { dst; cause; confirmedFile; sessionId } — no `content`.
  return await myPrivilegedWriter.unlink(req.dst);
});
```

It covers `edit`'s `REM`, the source side of a hashline `MV`, and `apply_patch`'s
delete op, and follows the same rules as the write seam: same permission codes, first
`true` wins, a throwing handler is skipped, the original error is rethrown if none
succeed, and nothing happens at all when no handler is registered. Two differences:

- **`ENOENT` is never diverted.** Nothing is created on the way to an unlink, so a
  missing file genuinely is missing — `REM` turns it into a not-found error.
- **A handler must unlink, never remove recursively.** `unlink` on a directory reports
  `EPERM` on macOS, which is indistinguishable from a sandbox denial by error code
  alone, so the seam `lstat`s the target and refuses to divert a directory. But when
  the target's own metadata sits behind the same boundary that denied the unlink —
  the common sandbox case — that check cannot be resolved, and `req.dst` may then be a
  directory. `req.confirmedFile` is `true` only when the seam positively established
  the target is a plain regular file; a symlink reports `false` too, since unlinking a
  link is fine but resolving it acts on something else entirely. A privileged helper
  that recursively removes `req.dst`, or realpaths it first, would act far outside
  what a tool that only ever removes one file asked for.

**Registering for deletes is deliberately separate from registering for writes.** A
write handler brokers `req.content` to `req.dst`; if a delete request reached it, the
missing content invites brokering an empty write and *truncating* the file that was
meant to be removed. A write-only handler therefore never sees a delete.

Two lifecycle constraints, which apply to both seams:

- **Register during extension load** (from the default factory), like other
  `register*` calls. Handlers are installed when `ExtensionRunner.initialize` runs;
  an extension that registered nothing by then is skipped entirely, so a first
  registration made later never takes effect. The `ctx` a handler receives is built
  per invocation, not captured at install time, so `ctx.cwd` and `ctx.hasUI` describe
  the session as it is when the mutation is denied — a workspace change (`/move`) is
  reflected in the next request rather than pinned to load time.
- **The registries are process-wide.** A process can host several sessions (a subagent
  gets its own runner), so a handler may be consulted for a denied write or delete
  from any session in the process — not only the one whose extension registered it.
  This is deliberate: a subagent spawned with restricted tools loads no extensions of
  its own, and a host that registers once in its top-level session still expects its
  subagents' writes brokered. `req.sessionId` names the session that issued the
  mutation (`undefined` when it did not come from a tool call), and
  `ctx.sessionManager.getSessionId()` names the handler's own — compare them to make
  the decision per session. It matters most before prompting: `ctx.ui` belongs to the
  handler's session, not necessarily to the one being asked about. Handlers are
  removed on `session_shutdown`.

With nothing registered none of this engages: the primitive runs exactly as it did
before and performs no extra syscalls.

## UI integration points

`ctx.ui` implements the `ExtensionUIContext` interface. Support differs by mode.

### Interactive mode (`extension-ui-controller.ts`)

Supported:

- dialogs: `select`, `confirm`, `input`, `editor`
- input editing: `setEditorText`, `getEditorText`, `pasteToEditor`, `editor`
- autocomplete stacking: `addAutocompleteProvider(factory)` wraps the built-in editor provider (factories apply in registration order and re-apply on every slash-command refresh)
- terminal title and working message (`setTitle`, `setWorkingMessage`)
- notifications/status/editor text/terminal input/custom overlays
- theme listing/loading by name (`setTheme` supports string names)
- tools expanded toggle

Current no-op methods in this controller:

- `setFooter`
- `setHeader`

`setEditorComponent` is wired to the live editor (`ctx.setEditorComponent(factory)`). `setWidget` renders real widget components above or below the editor via `setHookWidget(...)` (`placement: "aboveEditor" | "belowEditor"`; string-array content capped at 10 lines). `setEditorText` and `pasteToEditor` schedule a repaint after mutating the editor, so prompt changes don't leave stale content on screen.

### RPC mode (`rpc-mode.ts`)

`ctx.ui` is backed by RPC `extension_ui_request` events:

- dialog methods (`select`, `confirm`, `input`, `editor`) round-trip to client responses
- fire-and-forget methods emit requests (`notify`, `setStatus`, `setWidget` for string arrays, `setEditorText`; `setTitle` emits only when `PI_RPC_EMIT_TITLE=1`)

Unsupported/no-op in RPC implementation:

- `onTerminalInput`
- `custom`
- `setFooter`, `setHeader`, `setEditorComponent`, `addAutocompleteProvider`
- `setWorkingMessage`
- theme switching/loading (`setTheme` returns failure)
- tool expansion controls are inert

### Print/headless/subagent paths

When no UI context is supplied to runner init, `ctx.hasUI` is `false` and methods are no-op/default-returning.

### ACP mode

ACP installs an elicitation-bridged UI context (`createAcpExtensionUiContext` in `acp-agent.ts`). `ctx.hasUI` is `true` while `select`/`confirm`/`input`/`editor` round-trip (as ACP elicitations; defaults are returned when the client lacks the `elicitation.form` capability). The non-elicitation surface (widgets, theming, terminal input, autocomplete stacking) is stubbed no-op.

## Session and state patterns

For durable extension state:

1. Persist with `pi.appendEntry("com.example.my-extension.state", data)`. The `customType` namespace is global: use a package- or reverse-domain-qualified value and avoid the core-reserved values in the [`custom` session-entry reference](./session.md#custom).
2. Rebuild state from `ctx.sessionManager.getBranch()` on `session_start`, `session_branch`, `session_tree`.
3. Keep tool result `details` structured when state should be visible/reconstructible from tool result history.

Example reconstruction pattern:

```ts
pi.on("session_start", async (_event, ctx) => {
  let latest;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "custom" &&
      entry.customType === "com.example.my-extension.state"
    ) {
      latest = entry.data;
    }
  }
  // restore from latest
});
```

## Rendering extension points

## Composer shape renderer

`registerComposerShape` adds an extension-owned input-editor layout to **Appearance → Composer Shape**. Register it from the extension factory; the renderer is used by the live editor and its settings preview.

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ComposerStyle } from "@oh-my-pi/pi-tui";

const dockStyle: ComposerStyle = {
  id: "acme-dock",
  sideBorders: false,
  verticalChrome: 1,
  statusAttachment: "none",
  bottomBar: "full",
  bottomBarGap: true,
  defaultPromptGutter: "❯ ",

  defaultPaddingX: () => 0,
  sideChromeWidth: () => 0,
  renderTop: ({ box, width, borderColor }) =>
    borderColor(box.horizontal.repeat(width)),
  renderRow: ({ gutter, text, pad }) => [gutter + text + pad],
  renderBottom: () => undefined,
};

export default function (pi: ExtensionAPI) {
  pi.registerComposerShape({
    label: "Acme Dock",
    description: "Prompt below a single rule",
    style: dockStyle,
  });
}
```

`ComposerShapeDefinition` contains:

- `label`: required selector label.
- `description`: optional selector detail.
- `style`: the complete `ComposerStyle` rendering contract. `style.id` is also the persisted `composer.shape` value.

Use a package-qualified, non-empty, trimmed `style.id`. Built-in ids (`box`, `claude`, `pi`, `borderless`, `rule`, `field`, and `rail`) cannot be replaced. If the extension is unavailable while its id remains configured, the editor falls back to `box`.

### `ComposerStyle` layout metadata

- `sideBorders`: whether content rows own side chrome. This controls cursor reserve, IME layout, and scrollbar behavior; it is not merely descriptive.
- `verticalChrome`: exact number of fixed top/bottom chrome rows (`0`, `1`, or `2`) used for editor height budgeting.
- `statusAttachment`: `"top-border"` receives the embedded status gauge, `"top-rule-chip"` receives the right status group for docking on a rule, and `"none"` detaches status from the editor chrome.
- `bottomBar`: standalone status content below the editor: `"none"`, `"left"`, or `"full"`.
- `bottomBarGap`: whether a blank row separates the editor from a standalone bottom status bar.
- `defaultPromptGutter`: prompt text used when the host supplies no override.
- `defaultPaddingX(themePaddingX)`: horizontal padding selected for this style.
- `sideChromeWidth(paddingX)`: visible cells consumed on **each** side of a content row, including padding and border/rail glyphs.

`renderTop` and `renderBottom` return one styled terminal row or `undefined`. `renderRow` returns one or more styled rows. Every normal rendered row must occupy exactly `ctx.width` visible cells; ANSI escape sequences have zero width. Preserve the supplied `gutter`, `text`, and `pad` instead of reflowing or truncating them.

### Renderer context

All render methods receive `width`, `paddingX`, the theme's `box` glyphs, and three styling functions:

- `borderColor(text)`: ordinary frame/rule color.
- `accentColor(text)`: stable accent for shape-defining rails or caps.
- `surfaceColor(text)`: composer background fill that survives nested SGR resets in decorated input.

`topBorder`, when present, is already-styled status content with its visible `width`. A top renderer owns its placement and must leave the final line at `ctx.width`.

`renderRow` additionally receives:

- `gutter`, `text`, and `pad`: pre-rendered content pieces.
- `isLastRow`: last visible input row.
- `cursorOverflow`: cells consumed from the right chrome by an end-of-line cursor.
- `imeSafeCursorTail`: omit right-side cells after the cursor so terminal-local IME preedit cannot shift the chrome.
- `scrollbarThumb`: this row intersects the editor scrollbar thumb.

The built-in implementations in `packages/tui/src/components/composer/` are the reference for framed, rule, filled-surface, and IME-safe layouts.

## Custom message renderer

```ts
pi.registerMessageRenderer("my-type", (message, { expanded }, theme) => {
  // return pi-tui Component
});
```

Used by interactive rendering when custom messages are displayed.

## Assistant thinking renderer

```ts
import { Container, Text } from "@oh-my-pi/pi-tui";

pi.registerAssistantThinkingRenderer((context, theme) => {
  const container = new Container();
  container.addChild(
    new Text(theme.fg("dim", `thinking chars: ${context.text.length}`), 1, 0),
  );
  return container;
});
```

Used by interactive rendering to add display-only supplemental UI below each visible assistant thinking block. The renderer receives the already-visible thinking text, content/thinking indexes, theme, and a `requestRender()` callback for async renderers. All registered renderers that return a component are appended in registration order. Renderers must not mutate messages; the original thinking block remains the provider/session source of truth.

## Tool call/result renderer

Provide `renderCall` / `renderResult` on `registerTool` definitions for custom tool visualization in TUI.

## Constraints and pitfalls

- Runtime actions are unavailable during extension load.
- `tool_call` errors block execution (fail-closed).
- Command name conflicts with built-ins are skipped with diagnostics.
- Reserved shortcuts are ignored (`ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+k`, `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+g`, `ctrl+q`, `alt+m`, `shift+tab`, `shift+ctrl+p`, `alt+enter`, `escape`, `enter`).
- Treat `ctx.reload()` as terminal for the current command handler frame.

## Extensions vs hooks vs custom-tools

Use the right surface:

- **Extensions** (`src/extensibility/extensions/*`): unified system (events + tools + commands + renderers + provider registration).
- **Hooks** (`src/extensibility/hooks/*`): separate legacy event API.
- **Custom-tools** (`src/extensibility/custom-tools/*`): tool-focused modules; when loaded alongside extensions they are adapted and still pass through extension interception wrappers.

If you need one package that owns policy, tools, command UX, and rendering together, use extensions.
