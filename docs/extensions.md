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

1. Extension modules are imported concurrently; their factory functions then run sequentially in path order.
2. During that load phase, registration methods are valid; session action methods are not yet initialized.
3. `ExtensionRunner.initialize(...)` wires live actions/contexts for the active mode.
4. Session/agent/tool lifecycle events are emitted to handlers.
5. Registry tools are wrapped for extension interception (`tool_call` / `tool_result`).

```text
Extension lifecycle (simplified)

load paths
   │
   ▼
import modules + bind factories (no session actions)
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
- `pi.exec()` is directly available during load; provider registration is queued until session setup
- child sessions reuse imported factories but bind fresh APIs and extension registrations; module-level variables remain shared across those sessions

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
    const command = event.input.command;
    if (event.toolName === "bash" && typeof command === "string" && command.includes("rm -rf")) {
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
- `registerProvider`, `unregisterProvider`
- `registerFileWriteFallback`, `registerFileDeleteFallback`
- `events` (shared event bus)

`ExtensionAPI` methods retain their extension binding when destructured or passed as callbacks.

`setLabel(label)` sets the extension's display label. It is not a session-entry
labeling action. `getAllTools()` returns tool schemas and source metadata, while
`getActiveTools()` returns enabled names.

`getServiceTiers()` returns a detached snapshot of the session's live per-family tier map. `setServiceTier(family, tier)` changes one family for subsequent requests; pass `undefined` to clear that session override. OpenAI accepts `auto`, `default`, `flex`, `scale`, `priority`, or `ultrafast`; Anthropic accepts `priority`; Google accepts `flex` or `priority`. Changes made while a response is streaming do not alter that in-flight request.

### Provider registration

Provider `models` entries and rows returned by `fetchDynamicModels` accept the same `api`/`kind` pairs as `models.yml` (see [Models](./models.md)): a runner API such as `openai-images` implies its kind, so the model reaches the `image` role and `generate_image` instead of registering as chat. A static `models` entry whose `kind` its api cannot serve fails `registerProvider`; such a `fetchDynamicModels` row is dropped with a logged warning.

```ts
pi.registerProvider("my-gateway", {
  baseUrl: "https://gateway.example.com/v1",
  apiKey: "GATEWAY_API_KEY",
  models: [{
    id: "gpt-image-2",
    name: "GPT Image 2",
    api: "openai-images", // kind: "image" implied
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }],
});
```

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
      const payload = (await response.json()) as {
        used: number;
        limit: number;
      };
      return {
        provider: "my-provider",
        fetchedAt: Date.now(),
        limits: [
          {
            id: "requests",
            label: "Requests",
            scope: { provider: "my-provider" },
            amount: {
              used: payload.used,
              limit: payload.limit,
              unit: "requests",
            },
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

Cached usage reports live in the shared `agent.db`, keyed by provider name, the
usage provider's `cacheVersion`, normalized base URL, and credential identity. When overriding a built-in provider, set a `cacheVersion`
distinct from the built-in one so processes without the extension (older sessions,
`--no-extensions` runs, SDK scripts) never serve their reports to yours, or yours to them.

Extension-registered providers (`registerProvider`) can supply `fetchDynamicModels` for runtime model discovery; these fetches are hard-bounded to a 15-second timeout (`RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS` in `model-provider-discovery.ts`) so a hung endpoint cannot stall discovery.

A provider's `apiKey` (a literal key or an environment variable name) normally overrides any stored OAuth or `/login` credential for that provider. When the registration also supplies `oauth`, `apiKey` becomes a fallback instead: the key the user saved with `/login` wins, and `apiKey` is used only when no stored login credential exists. This keeps an unset env-var name from being sent as the literal key. Registering a built-in provider id with both `oauth` and a gateway `apiKey` therefore lets a stored upstream credential take precedence over the gateway key.

Provider login callbacks can request masked entry with
`callbacks.onPrompt({ message: "Consumer key", secret: true })`. Native `/login`
and first-run setup preserve the exact submitted value while hiding it in the
input, retained answers, and input diagnostic previews. Login prompts do not
share undo or kill/yank history. Ordinary prompts remain unmasked.

RPC rejects secret prompts instead of forwarding them as ordinary input. SDK
hosts implementing `onPrompt` must honor `secret` or reject the prompt. Masking
does not provide encryption, memory erasure, or general log redaction.

In interactive mode, `input` handlers run before the built-in first-message auto-title check. Extensions that call `await pi.setSessionName(...)` from `input` can set the persisted session name and prevent the default auto-generated title from running for that session.

Also exposed:

- `pi.logger`
- `pi.arktype` (the omptype `type(...)` schema builder)
- `pi.zod` (Zod-compatible builder backed by omptype)
- `pi.typebox` (legacy TypeBox-compatible shim)
- `pi.pi` (package exports)

### Runtime setting overrides

Settings are addressed through typed registry handles (see "Definitions" in [config-usage.md](./config-usage.md#definitions-srcconfigregistryts)); the string-path `settings.get`/`set`/`override` methods were removed in 18.3. Extensions resolve a handle by id with `lookup(id)` (and enumerate them with `all()`) from the `@oh-my-pi/pi-coding-agent/config/registry` subpath, then pass `pi.pi.settings` as the scope:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

export default function (pi: ExtensionAPI) {
  const recap = lookup("recap.enabled");
  // Defer to the user: pin a default only when no env var or settings layer configures it.
  if (recap && !recap.isConfigured(pi.pi.settings)) recap.override(pi.pi.settings, false);
}
```

- `override(scope, value)` writes the in-memory runtime layer; it is never persisted and outranks project, global, and `--config` layers. A setting's environment binding normally takes precedence; definitions using `envFallback` instead defer to configured settings. A value the definition rejects throws, e.g. `Invalid value for recap.enabled: "nope" (expected a boolean)`.
- `clearOverride(scope)` releases the override, restoring the persisted/default value.
- `isConfigured(scope)` / `provenance(scope)` tell a user-configured value from the default (`"env" | "runtime" | "overlay" | "project" | "global" | "default"`).
- `get(scope)` reads the effective value; `listen(scope, cb)` observes changes. Writes go through the settings store, so change listeners and live effects fire.
- `lookup` returns `undefined` for an unknown id.

### Message delivery semantics

`pi.sendMessage(message, options)` supports:

- `deliverAs: "steer"` (default while streaming) — steers the current run
- `deliverAs: "followUp"` — queued behind the current run while streaming
- `deliverAs: "nextTurn"` — kept out of the editable pending-message UI; while streaming it waits for the next turn, and when idle without `triggerTurn` it is appended to context/history without starting a turn
- `deliverAs: "aside"` — injected at the next agent step boundary without interrupting the current tool batch, except that it ends a running interruptible `wait` (the wait returns "Wait interrupted by message." and its job keeps running); when idle it normally starts a turn regardless of `triggerTurn`. Plan mode or user-interrupt auto-resume suppression folds it into context instead
- `triggerTurn: true` — starts a turn when idle (also honored with `deliverAs: "nextTurn"`: idle prompts immediately; while streaming the queued message schedules an internal continuation)

When idle without `triggerTurn`, ordinary `sendMessage` delivery appends the
message without starting a turn. A `display: true` message is rendered
immediately; `"nextTurn"` delivery does not emit that immediate display event.
ACP clients can defer agent-initiated turns, in which case requests that would
start one are retained as hidden next-turn messages.

`pi.sendUserMessage(content, { deliverAs })` submits text/images without slash-command
or prompt-template expansion. Omit `deliverAs` to start a prompt when idle;
while streaming, omission queues a steer. Explicit `"steer"` or `"followUp"`
queues the prompt even when idle instead of starting a turn directly. `"aside"`
injects at the next step boundary while a run is live and starts a turn when
idle. The message is recorded with `attribution: "user"` unless you pass
`attribution: "agent"`; use `"agent"` for text the extension generated or relayed
from another agent.

Payloads passed to `pi.sendMessage` are normalized before delivery
(`normalizeCustomMessagePayload` in `packages/tui/src/chat/messages.ts`,
re-exported by `session/messages.ts`): non-object payloads are coerced to string
content under the default custom type, missing `customType`/`attribution` fields
are defaulted, and invalid content collapses to an empty string.

## 2) Handler context (`ExtensionContext`)

Handlers and tool `execute` receive `ctx` with:

- `ui`
- `mode`: `"tui" | "rpc" | "json" | "print"`; ACP uses `"rpc"`. Check `"tui"` before using terminal-only components
- `hasUI`: whether this runner has a non-no-op UI context, not whether every UI method is supported
- `cwd`
- `sessionManager` (read-only)
- `modelRegistry`, `model`
- `models` (read-only model query — see below)
- `localProtocolOptions` (optional calling-session `local://` root mapping for external tool bridges)
- `getContextUsage()`
- `getAsyncJobSnapshot()` returns the current session's read-only async-job snapshot, or `null` when no session owns the context
- `compact(instructionsOrOptions?)`: accepts summary focus text or `CompactOptions`, including one-off `mode: "soft" | "remote" | "snapcompact"`, `onComplete`, `onError`, and `suppressContinuation`
- `isIdle()`, `hasPendingMessages()`, `abort()`
- `shutdown()`
- `getSystemPrompt()`
- `isProjectTrusted()` — always `true`; OMP does not ask for per-directory trust before loading project inputs
- `agent` — the agent this session runs: `{ kind: "main" | "sub", id, name, depth, parentId? }`. Factories are rebound to every subagent session (task tool, eval `agent()`, `/tan` clones), so a handler can check `ctx.agent.kind === "sub"` or the lowercased agent definition `name` (for example `"explore"`) to act only in subagents. Use `kind`, not `depth`: `depth` counts `task` nesting only, so `/tan` clones are subagents at depth 0 and report `name: "sub"`. An advisor's own tool calls reach the session's `tool_call`/`tool_result` handlers with `{ kind: "sub", id: "advisor", name: "advisor", depth: 0, parentId }`, so `kind === "main"` also excludes advisor activity
- `runEphemeralTurn(...)` (optional; see below)
- `memory` (optional structured memory runtime — status/search/save across the configured backend)
- `annotations`: `/annotate` as an API, for boards and remote clients. `submit({ source, notes, deliver?, review?, focus? })` builds the feedback `/annotate` would and delivers it without any UI; `open({ source, deliver?, focus? })` mounts the annotation overlay on the source and resolves with the operator's notes (`undefined` when dismissed; `mode === "tui"` only). Text sources are `{ kind: "text", text, label? }`, `{ kind: "file", path }` (resolved against the live session cwd), or `{ kind: "last" }`; diff sources are `{ kind: "diff", diff, label? }`, `{ kind: "uncommitted" }`, or `{ kind: "pr", ref }`. `review`/`focus` apply to diff sources only (a type error on text sources). Text notes are `{ note, line?, quote? }` (1-based; whole-source when omitted, and the quoted line is filled in); diff notes are `{ path, note, line?, side?, occurrence?, rawLine? }` (`side` defaults to `"new"`; `rawLine` is the diff row including its `+`/`-`/space prefix). Notes that do not match their source reject rather than being dropped. `text` and `diff` sources are frozen snapshots of what you pass; `file`, `last`, `uncommitted`, and `pr` are re-read at call time and line numbers are matched against the current content, so pass `quote`/`rawLine` to reject a note (naming it) when that content drifted. `deliver` defaults to `"auto"`: pasteable notes go into the composer when the interactive TUI editor is available and are sent otherwise; an LLM review request (`review: true` on a diff) is always sent. Sending uses `pi.sendUserMessage` and queues as a follow-up while the agent is streaming. `"paste"`/`"send"` force a channel and `"none"` only returns `text`. The result is discriminated by `kind`: `"text"` carries `TextReviewAnnotation[]` and, after `open`, `editedText` when the operator replaced the source in the external editor (the feedback then refers to that text); `"diff"` carries `CodeReviewAnnotation[]` and `review` (whether `text` is an LLM review request). Both carry the rendered `text` and the `delivered` channel.
  Explicit paste requires `ctx.ui.supportsEditor === true`: the TUI and non-headless RPC expose composers; ACP and no-op UI contexts do not. Supplied diffs used for LLM review reject above 50,000 characters or 20 reviewable files before delivery, and `open` rejects such a patch before mounting the overlay; split larger patches into smaller requests. Notes-only submissions do not have this review-prompt bound.
- `setInterval(fn, ms, ...args)` / `setTimeout(fn, ms, ...args)` / `clearTimer(timer)` — managed timers (see below)

### Ephemeral side turns (`ctx.runEphemeralTurn`)

Run the same side-turn pipeline as `/btw` using the current model and conversational context. The question and response are not appended to session history, and the request can run while the main turn is active. The snapshot may include in-flight assistant text.

```ts
if (!ctx.runEphemeralTurn) {
  throw new Error("This host does not support ephemeral turns");
}
await requireConsultationConsent(remoteCaller);
await auditConsultationRequest(remoteCaller, remoteQuestion);
const { replyText } = await ctx.runEphemeralTurn({
  promptText: remoteQuestion,
  tools: false,
  maxTokens: 4096,
  maxContextBytes: 1_048_576,
  onTextDelta: delta => sendRemoteChunk(delta),
  signal: requestAbortController.signal,
});
```

For example, a Synadia/NATS bridge can answer another agent's question from the local context and stream the response back without injecting a live user message. **A side turn sends the current conversation snapshot to the configured model provider and returns its answer to the calling extension.** Bridge extensions must obtain user consent where appropriate, authenticate and authorize callers, and audit every remote request before using this API. Agent-to-agent consultation extensions can set `maxTokens` and a serialized, post-transform `maxContextBytes` cap (measured after secret obfuscation) before inference. Transports that omit or overwrite caller output-token limits, including Codex Responses, Cursor, GitLab Duo Workflow, Ollama Cloud discovery models, and Antigravity, reject `maxTokens` before inference instead of silently starting an uncapped request. Antigravity rejects requested caps conservatively across its transport because effort routing can select wire profiles with fixed output limits. A requested cap disables optional budget thinking, since those transports may otherwise raise the wire limit to fit a thinking budget; models that require budget thinking reject the cap. `tools: false` also rejects before inference on Cursor, whose transport exposes native tools independently of the supplied tool catalog. Both caps must be positive safe integers. Omit `maxTokens` only when an uncapped turn is acceptable, or choose an API that supports output limits. The extension owns transport, access controls, request limits, and cancellation (including shutdown); this API adds no network dependency. `onTextDelta` may return a promise: delivery is awaited in order, including the final flush, and a delivery error rejects the side turn and aborts the provider request instead of leaving it streaming.

Hooks may start a side turn, including from delayed callbacks. Only `context`, `before_provider_request`, and `after_provider_response` hooks reached *within* a running side turn reject a nested `runEphemeralTurn` call, which bounds recursion; the caller's `onTextDelta` runs outside that guard. Side turns inherit the active event-handler signal (only while that handler is still running) and, for registered tools, the tool invocation’s abort signal. An explicit `options.signal` is combined with those signals; it does not replace them. `maxContextBytes` is checked before `before_provider_request` hooks run; a hook that replaces the payload is not re-measured.

Tool calls are always discarded rather than executed. Pass `tools: false` to remove tool definitions after context transforms and set `toolChoice: "none"` at the provider boundary. Omitting it preserves `/btw`'s tool catalog for prompt-cache reuse; disabling it may reduce cache hits. Bedrock Converse rejects tool opt-out if the transformed history still contains tool calls or results. Existing context/provider hooks still run. It is not a sandbox or a guarantee that arbitrary extension hooks have no side effects. Model inference consumes the configured provider's resources. `dedupeReply` defaults to `true`, collapses runs of more than three identical lines, and caps the returned reply at 4 KiB. Set it to `false` to disable those transformations; `replyText` is still trimmed. Callers should use `replyText` for the final result.

Use `history` only for detached prior side-turn messages; it is cloned with `structuredClone`, so pass cloneable message data. A `conversationKey` keeps related side turns on one provider lineage. Rotate it after cancellation or failure before retrying. A side turn also rejects with a retryable error if its session or exact model instance changes before dispatch; callers should retry from a new current-context snapshot rather than reuse the old one.

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

`session.compacting` receives `{ sessionId, messages }` and can return
`{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }`
to customize summary context, the summarizer prompt, and stored compaction data.
It is skipped when `session_before_compact` already supplied a replacement
compaction result.

Cancelable pre-events:

- `session_before_switch` → `{ cancel?: boolean }`
- `session_before_branch` → `{ cancel?: boolean; skipConversationRestore?: boolean }`
- `session_before_compact` → `{ cancel?: boolean; compaction?: CompactionResult }`
- `session_before_tree` → `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }`

`session_before_branch` and `session_branch` carry `reason`, which decides what `session_before_branch.entryId` means. For `"branch"` (`branch(entryId)`, `/branch`) it is the user message being rewound: it and everything after it are dropped. For `"fork"` (`AgentSession.fork(entryId)`, RPC `fork` with an `entryId`) and `"btw"` (`/btw` promotion) it is the last entry kept in the new session.

### Prompt and turn lifecycle

- `input`
- `before_agent_start`
- `before_provider_request` — receives `{ payload }`; return the replacement payload itself (not `{ payload }`). Handlers chain. Provider transports must invoke `onPayload`; `devin-agent` does not.
- `after_provider_response` — notification before response-body consumption: `{ status, headers, requestId?, metadata? }`. Provider request/response handlers receive the model used for that request in `ctx.model`.
- `context` — receives conversation messages and may return `{ messages }`; replacements chain without rewriting persisted history
- `agent_start` / `agent_end` — agent loop lifecycle notification; `agent_end` remains notification-only
- `session_stop` — main-session stop hook, awaited before settle. Advisory `{ continue: true, additionalContext }` requests are capped at 8 continuations. Explicit `{ decision: "block", reason }` refusals take precedence over advisory requests, do not consume that allowance, and remain blocking until the hook allows completion or the operator interrupts. A refusal without a reason receives a diagnostic continuation rather than permission to finish. This event never fires for task/subagent sessions and defers until agent-owned background jobs are fully idle (`#hasPendingAsyncWake` in `session/agent-session.ts`).
- `cache_warming_decision` — fired before each prompt-cache warming refresh with the warmer's economics (`warmCost`, `missCost`, `continuationProbability`, `action`). Return `{ action: "warm" | "stop" }` to override; the last handler returning an action wins, handler failures or answers slower than 2 seconds leave the warmer's decision standing, and a `"stop"` override ends warming until the next real request. Only the main agent loop warms; task/subagent sessions never fire this. The refresh itself replays the real request through the same provider path, so `before_provider_request` and `after_provider_response` fire for it too; a replacement payload must stay byte-identical to the real one for the refresh to hit the cache.
- `turn_start` / `turn_end`
- `assistant_message` — awaited once per finalized assistant message before agent context, persistence, `message_end`, or tool dispatch. Return `{ content }` to replace text for history, persistence, `message_end` consumers, and the next provider request; handlers chain. Text already delivered through streaming updates (`message_update`, ACP/RPC chunks) is not retracted, so clients that render from the stream may keep showing the original text. Text blocks must retain their count, order, and positions; only their text may change. All non-text blocks and other block metadata must remain unchanged. Unchanged text retains its original `textSignature` (even if the handler drops or changes it); edited text loses its signature so provider replay state is never reused for different text. Invalid replacements and handler errors are reported and skipped. If aborted while a handler is pending, completed rewrites so far are retained and remaining handlers are skipped.
- `message_start` / `message_update` / `message_end` — lifecycle notifications; `message_end` receives a detached snapshot, so in-place changes cannot rewrite agent or provider context

```ts
pi.on("assistant_message", event => ({
	content: event.message.content.map(block =>
		block.type === "text" ? { ...block, text: block.text.replaceAll("teh", "the") } : block,
	),
}));
```

`before_agent_start` prepares policy for an ordinary prompt and for each steering or follow-up batch containing user work when that batch is actually dequeued. It is not an enqueue notification: a live batch can fire it without another `agent_start`. Queue peeks, provider retries, tool-only iterations, and synthetic-only queued continuations do not fire it. Explicit synthetic prompts retain their ordinary prompt lifecycle.

For queued batches, `prompt` contains the already-transformed text of every selected user message, joined with two newlines between messages; text blocks within a message are concatenated. `images` contains their already-normalized images in delivery order. Hidden agent-attributed companions are excluded from these event inputs but remain in the delivered batch. Input hooks, commands, templates, and original attachment preprocessing are not rerun.

Handlers chain from the current base system prompt. Their final override governs the next provider request and its continuations until another prompt or user-containing batch prepares policy. Overrides remain complete replacements, including strings or arrays unrelated to the base; the host never infers or rebases text patches. Returned custom messages are appended once after the original batch; originals retain their order, identity, attribution, and metadata. Host application of results is cancelled if the turn is aborted or the session or queue ownership changes while handlers are pending.

If a returned override's source base changes during preparation (for example, a handler awaits `pi.setActiveTools()`), the host discards that attempt's returned custom messages and staged memory, then repeats policy preparation from the winning base. At most three attempts run per delivery; repeated base changes raise an error without delivering the original input. Queued originals remain queued, and settling the failed turn does not retry them automatically. A new prompt or queued delivery can reopen draining, including synthetic follow-ups and custom messages from extensions or advisors; the pause is not restricted to a user-only retry. Ordinary text is returned through the dropped-prompt callback. Unchanged base content does not trigger a retry, even if a refresh replaces the array. Preparations without an override still use the winning base without rerunning handlers or recall. Ownership is checked again synchronously before publishing results; a late change declines the delivery without committing memory or context.

Handlers must tolerate re-entry: a source-base retry can call the entire `before_agent_start` chain again for the same submission, and a cancelled delivery may be prepared again when resumed. Only the accepted attempt's returned context and staged memory are published; external side effects performed by handlers cannot be rolled back. Input hooks, commands, templates, and original attachment preprocessing are never replayed by these policy retries.

If a later queue drain fails, earlier originals that have not reached the
transcript are restored ahead of newer enqueues. Generated preparation context
is not requeued, and explicitly cleared or replaced queues are not resurrected.
#### External input interception

`input` runs once at submission ingress, before command interpretation, skill or
prompt-template expansion, and queue insertion:

| Submission | `source` |
|---|---|
| Main-session Enter or Ctrl+Enter | `"interactive"` |
| `prompt`, `steer`, `follow_up`, or `abort_and_prompt` in RPC or RPC UI mode | `"rpc"` |

Handlers run in extension/registration order. Returned `text` and `images`
replacements feed subsequent handlers; omitted fields preserve the current value,
and `images: []` removes attachments. Replacement text is trimmed before dispatch.
`handled: true` stops the remaining handlers and normal dispatch. Empty text with
no remaining images also stops normal dispatch. Work explicitly scheduled by a
handler through `sendUserMessage` or `sendMessage` is not discarded.

This is an ingress event, not a user-role message event. Queue delivery and replay
do not emit it again. Programmatic `sendUserMessage`/`sendMessage` calls and
synthetic continuations do not automatically emit `input`. Main-session Enter's
`.`/`c` continuation shortcuts retain their synthetic path. Focused-subagent
input retains its chat-only routing and does not invoke main-session input hooks.
Print and ACP input are outside this interception contract.

Ctrl+Enter detaches the submitted draft before awaiting native handlers, so
another submission cannot reuse it and ordinary later typing remains a new draft.
Handled/empty input consumes only the detached submission. Dispatch failures
restore its text and attachments alongside any newer draft. This does not make
the established interactive input-handler chain cancellable by Esc.
Builtin submission cleanup also preserves the newer draft, including `/clear`
and `/new`. Commands retain their explicit prefill and session-transition actions.

### Tool lifecycle

- `tool_call` (pre-exec, may block, revise the tool's execution `input`, or return passive `additionalContext`; for model-issued calls it fires at arg-prep time in the agent loop, so a revision is revalidated and seen by concurrency scheduling, execution events, the persisted assistant message, and the approval gate alike; passive context from non-blocking handlers is delivered after the batch's tool results in assistant call order, before the next provider request)
- `tool_result` (post-exec, may patch content/details/isError or return passive `additionalContext`; result context is delivered outside the tool output even when `event.isError` is true, so a failure-specific handler can guide the next model step)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end` (observability)
- `tool_approval_requested` / `tool_approval_resolved` (observability; emitted by `wrapper.ts` only when a tool requires approval and an approval handler is registered)

`tool_result` is middleware-style: handlers run in extension order and each sees prior modifications. Distinct non-blank `additionalContext` from every handler is preserved in registration order (repeats, compared ignoring surrounding whitespace, are dropped) and delivered before that call's `tool_call` context.

### Subagent lifecycle

- `before_subagent_spawn` → `{ model?: string | string[]; block?: boolean; reason?: string; note?: string }`. Fires in the parent session exactly once per spawned child (`task`, eval `agent()`, workpool workers), at dispatch before the child resolves its model — never during a frontend's validation preflight, so stateful routers (round-robin, quota) advance once per child. The event carries `agent`, `invocationKind`, `modelRole` (the pre-expansion role alias, when any), the expanded `patterns` core would use, and an optional stable `spawnKey`. A returned `model` replaces the spawn's attempt-ordered patterns while keeping the role identity, so the remaining entries become the child's retry fallback chain; handlers run in extension order and the last returned `model` wins, along with its `note`, which the task UI shows as the spawn's routing reason on live, async, and settled rows. `block: true` refuses the spawn with `reason`. Cancelling the spawn releases an awaiting handler (its result is discarded and pending `ctx.ui` dialogs close) instead of holding the spawn until the handler timeout.


#### Delegated read-only execution

The spawn event also includes the effective child's optional toolNames. A trusted
parent extension may return readonlyGrant: { parentSessionId, scopeRoot,
authorize(binding) }. This in-process capability is separate from model routing;
conflicting grants block spawning. Never construct it from model arguments or
serialize full-authority credentials into task metadata.

Core binds the actual child session ID and SessionManager cwd, exposes the bound
capability as ctx.readonlySubagent, and calls authorize before/after execution and
every 250 ms while guest processes exist. False, exceptions, or a two-second check
timeout permanently invalidate the child and kill its process namespaces. The
authority callback must check the live parent and its generation, not a cached
boolean. SDK callers must supply parentTaskPrefix and only bash/eval/yield tools.

This mode requires Linux and bubblewrap with user namespaces; unsupported hosts
fail closed. Bash and stateless Python/JavaScript run in read-only mounts with
no inherited environment, shell snapshot, direnv, host tool dispatcher, MCP,
IRC, LSP, custom tools, ambient extension discovery, or isolated worktree creation.
Host annotation APIs are also unavailable in a bound readonly context; they must
not read files, fetch review targets, or deliver chat messages outside the facade.
The requested workspace plus read-only runtime dependencies (/usr, /lib, /lib64;
the native source tree in JS source mode) are readable. Root .git/.omp carriers
are masked. Temporary writes stay in guest /tmp. Network and Unix-socket bridges
are denied by namespace isolation and seccomp. Scope contents are not redacted;
trusted grant issuers must exclude full-authority credentials from the scope.
Memory, process-count, and tmpfs quotas are not provided.

Output is bounded to 1 MiB per stream/cell and execution to 300 seconds. Guest
completion frames are untrusted: each eval starts a fresh process and waits for
actual process exit, not a guest done frame. No state persists between cells;
an earlier cell's deadline/abort cannot affect the next cell. Session disposal
awaits process exit; startup failure also disposes the sandbox. This capability
does not grant claim/release, child delegation, provider approval, or host writes.

### Reliability/runtime signals

- `auto_compaction_start` / `auto_compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `retry_fallback_applied` — `{ from, to, role, reason? }` when auto-retry switches model/provider
- `retry_fallback_succeeded` — `{ model, role }` when a request succeeds on that fallback
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
    attribution: "agent",
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

Prefer registration in the factory, but tools discovered later (for example in
`session_start`) are also mounted into the live registry. Registrations made
inside a dispatched event handler are flushed before that handler completes;
`await pi.setActiveTools(...)` also waits for pending registration. Restricted
children do not admit extension tools, including late registrations. Host-RPC
and SDK custom tools retain precedence over conflicting extension tools.

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

### Adding passive context after a tool call

A `tool_call` handler can return `additionalContext` without changing the tool result:

```ts
pi.on("tool_call", async event => {
  if (event.toolName === "search") {
    return { additionalContext: "Use this result before searching again." };
  }
});
```

`additionalContext` carries trusted handler-authored instructions for the next provider request. The
host emits them after the tool results with developer/system priority where the selected transport
supports it. Repeats (compared ignoring surrounding whitespace) are dropped at two levels: a handler value
identical to an earlier handler's on the same call, and a call's joined context identical to an earlier
call's in the same batch. Raw tool output and other untrusted data must stay in the ordinary tool result.

Distinct non-empty context from every non-blocking handler is preserved in registration order. OMP waits
until the tool batch settles, then emits the context after the corresponding tool results in
assistant tool-call order and before the next provider request. Handler context is delivered only when
the call actually runs and returns a non-error result: if the call is blocked by this or a later
handler, denied at the approval prompt, skipped by an interrupt, or fails, its collected context is
discarded.

Registered tools can add context during execution through
`ctx.addAdditionalContext?.("...")`. Context a tool adds itself is kept even when the tool then
returns an error. Within one call, the tool's own context (including tools reached through nested
`xd://` dispatch) comes before `tool_call` handler context.
Calls Cursor executes on its exec channel deliver context after their buffered results, on the next
provider request.

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
returns its result, including the native tool's own side effects and internal bookkeeping.
By default it inherits the outer call's abort signal, progress callback, and tool/provider
metadata; explicit `signal` / `onUpdate` options override those channels. It is
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

`renderCall`'s `options` argument also answers the `Theme` API, so tool renderers ported from upstream pi — declared `renderCall(args, theme, context)` — style correctly without being rewritten.

`tool_call`/`tool_result` intercept registry tools in `sdk.ts`, including built-ins
and extension/custom tools; an approval-policy denial can short-circuit before
`tool_call`, and blocked/denied calls do not execute or emit a normal post-execution result hook.

Additional `ToolDefinition` fields include:

- `hidden`, `defaultInactive`: opt out of automatic activation unless explicitly requested.
- `loadMode`: `"discoverable"` for new tool names by default; known essential built-in names retain `"essential"` when re-registered without an explicit mode (see `tools/essential-tools.ts`). Explicit modes win.
- `deferrable`, `readsSkillUris`, `strict`.
- `approval`: defaults to `"exec"`; accepts a tier, a decision object, or a function of the arguments.
- `mcpServerName`, `mcpToolName`, `legacyName`, `sourcePath`: discovery, approval, and provenance metadata.
- `shellEnv`: environment values for the interactive user-shell surface.
- `renderCall`, `renderResult`: TUI components.
- `describeCall`, `describeResult`: semantic tool views for TSP terminals.

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
  // req: { dst: string; content: string; cause: unknown; sessionId: string | undefined }
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
returns `false` (or none are registered), the original error is rethrown.
When Bun masked a denied parent `mkdir` as `ENOENT`, the recovered denial is
attached as the original error's `cause` if it has none. Intended for a host
that embeds the agent inside a sandbox denying direct filesystem writes but
exposing a privileged write channel.

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
missing content invites brokering an empty write and _truncating_ the file that was
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
  This is deliberate: a host that registers once in its top-level session still
  expects its subagents' writes brokered, including sessions without inherited
  extension factories. Restricted children retain parent-loaded hooks but do not
  discover ambient extensions. `req.sessionId` names the session that issued the
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

- dialogs: `select`, `confirm`, `input`, `editor`, optional `askDialog`
- input editing: `setEditorText`, `getEditorText`, `pasteToEditor`, `editor`; `supportsEditor` indicates whether paste updates a local or remote composer (absent means unsupported)
- autocomplete stacking: `addAutocompleteProvider(factory)` wraps the built-in editor provider (factories apply in registration order and re-apply on every slash-command refresh)
- terminal title and working message (`setTitle`, `setWorkingMessage`)
- notifications/status/editor text/terminal input/custom overlays
- theme listing/loading by name (`setTheme` supports string names)
- tools expanded toggle

Current no-op methods in this controller:

- `setFooter`
- `setHeader`

`ctx.ui.setEditorComponent(factory)` is wired to the live editor; the factory
must return a `CustomEditor` subclass, not a plain `Editor`/`EditorComponent`.
`setWidget` renders widget components above or below the editor via
`setHookWidget(...)` (`placement: "aboveEditor" | "belowEditor"`; string arrays show
up to 10 content lines plus a truncation notice). Pass `undefined` to remove a
widget. `setEditorText` and `pasteToEditor` request a repaint after mutating the
editor.

#### Launching terminal commands

`ctx.ui.openTerminal(request)` is available only in the interactive TUI. It creates a
multiplexer pane or provider-native group (a tmux window, Zellij/Herdr/Orca tab, or CMUX
workspace—not an OS window) and returns the reported native ID, plus a `warning` when
the provider started the command but could not show it where requested. RPC, ACP,
print, and headless contexts do not provide this optional method. The request type and
supported provider set derive from canonical launch capabilities: tmux, Zellij,
Herdr, CMUX, and Orca are supported; screen and wmux remain recognized by the
multiplexer taxonomy but are currently unsupported.

Provider-specific session detection is centralized in
`@oh-my-pi/pi-tui/terminal-multiplexer`, which registers one module per multiplexer.
`hasTerminalMultiplexerSession(provider, env)` checks explicit session markers, while
`classifyTerminalMultiplexer(env)` names the multiplexer hosting the process: session
markers first, then a `tmux`/`screen` `TERM` fallback, then outer applications such as
Orca, so a multiplexer running inside Orca wins. `isInsideTerminalMultiplexer(env)` is
true only when the classified multiplexer owns the screen grid; Orca keeps the
direct-terminal render path. A classified multiplexer does not prove that a nested
provider session or a native pane ID exists.

The TUI host injects this capability; extensions do not need to import dispatcher
code to use it.

Built-in OMP callers can pass `classifyTerminalMultiplexer(env)` to
`getTerminalLaunchPlacement(...)` for support and presentation metadata or as the
first argument to `createDefaultTerminalLaunchRequest(...)` for a validated
provider-default request. The factory also takes a placement, command argv, cwd, and
optional shell confirmation. Both helpers are exported by
`src/subprocess/terminal-launch.ts`.
Placement lookup returns the provider display name, user-facing group label (such as
`pane`, `tab`, or `workspace`), and any required shell grammar, or an error when no
multiplexer is detected or the provider does not support that placement. The request
factory returns `{ request }` or `{ error }`, validates the constructed request, and
leaves provider-specific target, focus, direction, and execution options unset so the
backend applies its own defaults. For shell-input launches, pass `shellGrammar: "posix"`
only after confirming the destination shell uses POSIX grammar; the factory rejects
a missing assertion. Extensions can continue using `ctx.ui.openTerminal(...)` with
explicit typed requests.

```ts
const result = await ctx.ui.openTerminal?.({
  multiplexer: "tmux",
  placement: "pane",
  command: ["bun", "run", "dev"],
  cwd: ctx.cwd,
  target: process.env.TMUX_PANE!,
  focus: false,
  execution: "direct",
});
```

Targets are provider-native IDs/refs, with different meanings by placement:

- tmux pane placement targets a pane ID and defaults to `TMUX_PANE`; new-window
  targets are session names/IDs and may be omitted inside the current TMUX session.
  An explicit pane or session target can address the CLI when `TMUX` is unset.
- Zellij pane placement may target an existing tab ID (Zellij 0.44.1 or newer).
  New-tab creation has no target option. Both require an active `ZELLIJ` session.
- Herdr pane placement targets a pane ID and defaults to `HERDR_PANE_ID`; tab
  placement targets a workspace ID and defaults to `HERDR_WORKSPACE_ID`. The
  destination must be in an active Herdr pane or workspace.
- Orca pane splits resolve `ORCA_PANE_KEY` to the current terminal handle;
  detection requires both `ORCA_PANE_KEY` and `ORCA_WORKTREE_ID`. Tab creation
  defaults to worktree `id:<ORCA_WORKTREE_ID>`; an application label alone is
  insufficient to detect an Orca session. Targets, titles, and commands are passed
  as `--flag=value`, so a value starting with `--` stays data.
- CMUX pane placement targets a surface ID; workspace placement targets a window
  ID. Both targets may be omitted when the corresponding CMUX context is active.
  An explicit surface target is authoritative and is not combined with the ambient
  workspace. Socket-path and transport markers alone do not establish an active
  local CMUX surface.

Unsupported target combinations fail rather than being ignored. Capability checks
use provider identity markers or a native target, not `TERM` alone. `focus` controls
apply only where a placement supports them: tmux uses `-d` when false, Zellij uses
`--no-focus` (Zellij 0.45.0 or newer), Herdr uses `--focus`/`--no-focus`, and CMUX
passes `--focus true|false` to both split and workspace creation. Orca tab creation
maps `focus: true` to `--focus`; otherwise focus follows Orca's default. Orca pane
splits have no focus option. When Orca cannot show a new tab, it starts the command
in a background terminal, and the result's `warning` says so.

Execution is provider-specific. tmux execs a multi-argument command directly but runs
a single argument through its configured `default-shell -c`, which may be fish, Nushell,
or another non-POSIX shell. For one-argument direct launches the dispatcher prefixes
`/usr/bin/env --`, keeping executables with spaces, leading dashes, or shell
metacharacters as data; a one-argument executable name containing `=` is rejected
because `env` reads it as an assignment. `execution: "shell"` POSIX-quotes the argv
and runs it with `/bin/sh -c`, independent of `default-shell`. tmux format-expands its
start directory, so the dispatcher passes every `#` in `cwd` as `##`. Zellij accepts
direct argv execution. Zellij options that need a newer CLI than the one installed
(tab placement before 0.44.0, `target` before 0.44.1, `focus: false` before 0.45.0) fail before anything is created,
with an error naming the required version; the dispatcher checks `zellij --version`
once per process.

Herdr `pane run`, CMUX `--command`, and Orca `terminal split`/`terminal create`
submit shell command text to the destination's interactive shell rather than
launching argv directly. Their requests therefore require `shellGrammar: "posix"`.
Set it only after confirming that the destination shell accepts POSIX syntax; it
is not inferred from the local OS or `$SHELL`, and the configured shell is not
guessed. Without that assertion, do not request a Herdr, CMUX, or Orca launch.
Once asserted, argv words are quoted with the shared POSIX shell-quoting helpers.
Orca split/create have no `--cwd` flag, so the adapter prepends
`cd <quoted-cwd> &&` before the quoted command in `--command`; CMUX split also
changes directory inside its shell before entering the command. These quotes are
not claimed to work in Nushell, PowerShell, `cmd.exe`, or other shell grammars.
The Orca CLI is resolved in Orca's documented order: `ORCA_CLI_COMMAND` when set,
`orca-dev` in an Orca development checkout (`ORCA_DEV_REPO_ROOT`), `orca-ide` on Linux
outside an Orca terminal, and `orca` otherwise.

Because these commands are submitted as terminal input, shell-input requests
reject C0/C1 control bytes and DEL in command arguments before creating a pane or
workspace; CMUX and Orca also reject them in `cwd`, which is embedded in their
shell command. The restriction is not applied to direct tmux or Zellij argv,
where argument newlines remain data rather than terminal input.

Herdr, Zellij, and Orca `window` placements create tabs; CMUX creates a workspace.
Provider-specific fields include pane direction, Zellij floating panes/names,
Herdr tab labels, and CMUX workspace names. Zellij floating panes cannot specify a
split direction, and Zellij new-tab creation cannot target a tab. tmux returns
required pane (`%...`) or window (`@...`) IDs; Zellij 0.44.0 and newer report the pane ID
as `terminal_<id>` and tab IDs as numeric strings, while older Zellij pane launches report
none, so `result.id` is unavailable; Herdr requires pane/tab IDs in
its JSON response. CMUX reports workspace/pane IDs when present, but its JSON
response may omit an ID, in which case `result.id` is unavailable.
Orca returns a pane handle at `result.split.handle` or a tab handle at
`result.terminal.handle`; the top-level JSON `id` is the RPC request ID, not the
terminal handle.

`cwd` must be an absolute path. A request that is not an object or names an unknown
multiplexer or placement rejects with a `TypeError`. Every other failure, including a
recognized provider or placement without launch support, rejects with a sanitized
`TerminalLaunchError` naming the provider, operation, and exit status when available;
command argv and CLI output are not included. CMUX and Orca reject malformed JSON
responses without retrying creation.

There is no shared environment override: each multiplexer applies its own
environment propagation rules; the dispatcher does not synthesize uniform variable
inheritance. Request argv stays separate for direct backends; only shell-input
backends turn argv into shell text, under the required POSIX grammar assertion.

### RPC mode (`rpc-mode.ts`)

`ctx.ui` is backed by RPC `extension_ui_request` events:

- dialog methods (`select`, `confirm`, `input`, `editor`) round-trip to client responses
- fire-and-forget methods emit requests (`notify`, `setStatus`, `setWidget` for string arrays or removal, and `setEditorText` as `method: "set_editor_text"`); `pasteToEditor` falls back to `setEditorText`
- `setTitle` emits only when `PI_RPC_EMIT_TITLE` is `1`, `true`, `yes`, or `on` (case-insensitive)

Unsupported/no-op in RPC implementation:

- `onTerminalInput`
- `custom`; optional `askDialog` is absent
- `getEditorText` returns `""`
- `setFooter`, `setHeader`, `setEditorComponent`, `addAutocompleteProvider`
- `setWorkingMessage`
- theme switching/loading (`setTheme` returns failure)
- tool expansion controls are inert

### Print/headless/subagent paths

When no UI context is supplied to runner init, `ctx.hasUI` is `false` and methods are no-op/default-returning. Both `--mode rpc --no-ui` and `--mode rpc-ui --no-ui` take this path for extensions; `rpc-ui` tool dialogs remain enabled.

### ACP mode

ACP installs an elicitation-bridged UI context (`createAcpExtensionUiContext` in
`modes/acp/acp-agent.ts`). `ctx.mode` is `"rpc"` and `ctx.hasUI` is `true`.
`select`/`confirm`/`input`/`editor` and optional `askDialog` round-trip as ACP form
elicitations; defaults are returned when the client lacks `elicitation.form`.
The non-elicitation surface (widgets, editor control, theming, terminal input,
autocomplete stacking) is inert; `notify` logs a debug notification.

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

### Session-entry roles (`message.role` is camelCase)

When you iterate `ctx.sessionManager.getBranch()`, each persisted entry has a `type`
(`message`, `custom_message`, `branch_summary`, `compaction`, …; the
[session-entry model](./session.md#entry-taxonomy) is the reference). A `type: "message"`
entry carries an `AgentMessage` under `entry.message`, whose `role` discriminant is
**camelCase** — not the snake_case used by the raw LLM wire format or by the
`tool_call` / `tool_result` **hook** names above:

| Persisted `entry.message.role` | Meaning                                                                    |
| ------------------------------ | -------------------------------------------------------------------------- |
| `user`                         | User / tool-feedback turn.                                                 |
| `developer`                    | Developer-role instruction turn.                                           |
| `assistant`                    | Model turn. Tool calls are `{ type: "toolCall" }` blocks inside `content`. |
| `toolResult`                   | One tool's result — **not** `tool_result`. Has `toolCallId` / `toolName`.  |
| `bashExecution`                | Standalone `!`-bash run.                                                   |
| `pythonExecution`              | Standalone python run.                                                     |
| `hookMessage`                  | Legacy hook-injected message (migration only; use `custom`).               |
| `fileMention`                  | Inlined `@file` mention contents.                                          |

Three roles in reconstructed agent context come from dedicated source entries in
extension-facing branch history; `getBranch()` exposes those source entries instead:

| Persisted `entry.type` | Reconstructed `message.role` | Meaning                               |
| ---------------------- | ---------------------------- | ------------------------------------- |
| `branch_summary`       | `branchSummary`              | Summary of an abandoned branch.       |
| `compaction`           | `compactionSummary`          | Compaction summary turn.              |
| `custom_message`       | `custom`                     | Message sent through `pi.sendMessage` |

`toolCall` is a **content-block type**, not a role: a tool call is a block in the
`assistant` message's `content` array, and the paired result is a separate entry with
`role: "toolResult"`. Match these values **verbatim** — a filter that compares against
snake_case constants, or lowercases `role` first (`"toolResult"` → `"toolresult"`), matches
no branch and **silently drops** the entry with no error or log, so a session capture keyed
off `role` loses every tool result while user/assistant text still flows through.

```ts
for (const entry of ctx.sessionManager.getBranch()) {
  switch (entry.type) {
    case "custom_message":
      // pi.sendMessage payload: entry.customType, entry.content
      break;
    case "branch_summary":
      // reconstructed as role: "branchSummary"
      break;
    case "compaction":
      // reconstructed as role: "compactionSummary"
      break;
    case "message":
      switch (entry.message.role) {
        case "assistant":
          // tool calls: entry.message.content.filter(b => b.type === "toolCall")
          break;
        case "toolResult":
          // entry.message.toolCallId, entry.message.content
          break;
      }
      break;
  }
}
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

Use a package-qualified, non-empty, trimmed `style.id`. Built-in ids (`box`, `band`, `claude`, `pi`, `borderless`, `rule`, `field`, and `rail`) cannot be replaced. For collisions between extensions, the later registration wins. If the extension is unavailable while its id remains configured, the editor falls back to `box`.

### `ComposerStyle` layout metadata

- `filledSurface`: whether the style paints its own row foreground through `surfaceColor`. Omitted values retain filled behavior for extension-owned ids; set `false` to receive the host's themed text color.
- `sideBorders`: whether content rows own side chrome. This controls cursor reserve, IME layout, and scrollbar behavior; it is not merely descriptive.
- `verticalChrome`: exact number of fixed top/bottom chrome rows (`0`, `1`, or `2`) used for editor height budgeting.
- `statusAttachment`: `"top-border"` receives the embedded status gauge, `"top-band"` uses the flush soft-capped status band above the input, `"top-rule-chip"` receives the right status group for docking on a rule, and `"none"` detaches status from the editor chrome.
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

- Session actions are unavailable during extension load; registration methods, `getFlag`, and `exec` are available.
- `tool_call` errors and timeouts block execution (fail-closed). Its budget is `extensionHandlers.toolCallTimeoutMs` (default 30,000 ms), paused during extension UI waits.
- Most dispatched handlers have a 30-second budget; `session_shutdown` handlers run concurrently with a 2-second budget. Timing out stops waiting and cancels handler UI, but cannot undo arbitrary extension side effects.
- Command name conflicts with built-ins are skipped with diagnostics.
- Reserved shortcuts are ignored (`ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+k`, `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+g`, `ctrl+q`, `alt+m`, `shift+tab`, `shift+ctrl+p`, `alt+enter`, `escape`, `enter`).
- Treat `ctx.reload()` as terminal for the current command handler frame.
- Module globals are shared by parent/child bindings. Keep session-specific state in the factory closure or persisted session entries.

## Extensions vs hooks vs custom-tools

Use the right surface:

- **Extensions** (`src/extensibility/extensions/*`): unified system (events + tools + commands + renderers + provider registration).
- **Hooks** (`src/extensibility/hooks/*`): legacy `HookAPI` event API. Hook files load through the extension runner, so they run with extension semantics (see [hooks](./hooks.md)).
- **Custom-tools** (`src/extensibility/custom-tools/*`): tool-focused modules; when loaded alongside extensions they are adapted and still pass through extension interception wrappers.

If you need one package that owns policy, tools, command UX, and rendering together, use extensions.
