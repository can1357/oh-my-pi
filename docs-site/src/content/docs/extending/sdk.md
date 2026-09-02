---
title: SDK
description: Embed omp in your own Bun or Node process — drive an AgentSession directly, subscribe to its events, and call into the model.
coverage: A
---

The **SDK** runs omp inside your own Bun or Node process so you can drive an `AgentSession` directly, subscribe to its events, and call into the model. It is the in-process embedding surface of `@oh-my-pi/pi-coding-agent`. If you need cross-language/process isolation, use [RPC mode](/oh-my-pi/extending/rpc/) instead.

## Install

```bash
bun add @oh-my-pi/pi-coding-agent
```

Requires Bun 1.3.14 or newer. Before the first model-backed prompt, configure credentials for a provider or run a keyless local provider; see [Providers](/oh-my-pi/models/providers/). Session construction can succeed without an available model, but prompting cannot.

## Quick start

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";

const { session, modelFallbackMessage } = await createAgentSession();

if (modelFallbackMessage) {
  process.stderr.write(`${modelFallbackMessage}\n`);
}

const unsubscribe = session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Summarize this repository in 3 bullets.");
unsubscribe();
await session.dispose();
```

`createAgentSession()` with no arguments discovers everything from the working directory and `~/.omp/agent`: cwd, agent dir, auth storage, model registry, settings, a file-backed session manager, skills, rules, context files, prompt templates, slash commands, extensions, built-in tools, MCP tools, and LSP. A minimal session needs no arguments.

## Entry points

The package root, `@oh-my-pi/pi-coding-agent`, is the complete embedding surface:

- `createAgentSession`
- `SessionManager`
- `Settings`
- `AuthStorage`
- `ModelRegistry`
- `discoverAuthStorage`
- Discovery helpers — `discoverExtensions`, `discoverSkills`, `discoverContextFiles`, `discoverPromptTemplates`, `discoverSlashCommands`, `discoverCustomTSCommands`, `discoverMCPServers`
- Tool factory surface — `createTools`, `BUILTIN_TOOLS`, tool classes

The narrower `@oh-my-pi/pi-coding-agent/sdk` subpath exports `createAgentSession`, its option/result types, `Settings`, `AgentRegistry`, discovery and system-prompt helpers, workspace-tree helpers, selected extension/MCP/tool types, and selected tool classes/factories. It does **not** export `SessionManager`, `AuthStorage`, or `ModelRegistry` — import those three from the package root.

Deep subpaths (`@oh-my-pi/pi-coding-agent/session/*`, `/config/*`, `/tools`, `/extensibility/*`, `/mcp`, `/lsp`, `/modes/rpc`, `/task`, `/secrets`, `/memory-backend`, …) expose the internal modules for tree-shaking and focused imports; everything there is also reachable through the root barrel.

## What `createAgentSession()` discovers

`createAgentSession()` follows "provide to override, omit to discover". With no overrides it resolves:

- `cwd` — `getProjectDir()`
- `agentDir` — `~/.omp/agent` (via `getAgentDir()`)
- `authStorage` — `discoverAuthStorage(agentDir)`
- `modelRegistry` — `new ModelRegistry(authStorage)` plus background `refreshInBackground()` when not supplied
- `settings` — `await Settings.init({ cwd, agentDir })`
- `sessionManager` — `SessionManager.create(cwd)` (file-backed)
- Skills, context files, prompt templates, slash commands, extensions, and custom TS commands
- Built-in tools via `createTools(...)`
- MCP tools (enabled by default; Exa MCP servers are folded into native Exa integration, and browser-automation MCP servers are filtered when the built-in browser tool is enabled)
- LSP integration (enabled by default)
- `eventBus` — a new `EventBus` unless supplied

Embedders usually pass `sessionManager`, `authStorage` + `modelRegistry`, `model` or `modelPattern`, and `settings` when they need deterministic control. When both `authStorage` and `modelRegistry` are supplied, `modelRegistry.authStorage` MUST be the same instance — creation rejects divergent stores.

## `createAgentSession()` options

All options are optional. The tables group them by concern; defaults are what `createAgentSession` applies when the field is omitted.

### Discovery & context

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `cwd` | `string` | `getProjectDir()` | Working directory for project-local discovery. |
| `additionalDirectories` | `string[]` | settings | Additional workspace directories (multi-root), absolute or `cwd`-relative. |
| `agentDir` | `string` | `~/.omp/agent` | Global config directory. |
| `settings` / `settingsManager` | `Settings` | `Settings.init({ cwd, agentDir })` | Settings instance (`settingsManager` is the legacy alias). |
| `sessionManager` | `SessionManager` | file-backed | Session journal; the session's cwd/id/file/branch all come from it. |
| `workspaceTree` | `WorkspaceTree` | scanned on demand | Pre-built workspace tree (parents pass it to subagents). |
| `contextFiles` | `Array<{ path; content; depth? }>` | discovered | Context files (`AGENTS.md` content). |
| `skills` | `Skill[]` | discovered | Skills. |
| `rules` | `Rule[]` | discovered | Rules (TTSR / always-apply / rulebook). |
| `promptTemplates` | `PromptTemplate[]` | discovered | File-based prompt templates. |
| `slashCommands` | `FileSlashCommand[]` | discovered | File-based slash commands. |
| `eventBus` | `EventBus` | new | Shared bus for tool/extension communication. |
| `spawns` | `string` | `"*"` | Spawn policy (`"*"` unrestricted; a comma list's first entry is the default subagent). |

### Auth & model

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `authStorage` | `AuthStorage` | `discoverAuthStorage(agentDir)` | Credential storage. |
| `modelRegistry` | `ModelRegistry` | constructed | Model catalog + API-key resolution. |
| `getApiKey` | `(model) => …` | registry resolver | Request-level credential resolver seam. |
| `model` | `Model` | settings default, else first available | Explicit model. |
| `modelPattern` | `string \| string[]` | — | Model pattern(s) resolved after extensions load. |
| `modelPatternAuthFallback` | `string` | — | Authenticated fallback selector. |
| `modelPatternFallbackRole` | `string` | — | Role used to install retry fallbacks. |
| `modelPatternDefaultFallbackChain` | `string[]` | — | Default retry chain for a deferred singleton pattern. |
| `thinkingLevel` | `"off" \| "minimal" \| … \| "max" \| "auto"` | settings, else model default | Thinking selector; `auto` resolves per turn. |
| `thinkingLevelCeiling` | `Effort` | — | Hard ceiling on thinking effort. |
| `openAIServiceTier` | `ServiceTier \| null` | settings | OpenAI service-tier override (`null` omits it). |
| `scopedModels` | `Array<{ model; thinkingLevel? }>` | — | Models available for cycling (Ctrl+P). |
| `prewalk` | `Prewalk` | — | Switch to a fast/cheap target at the first edit/write once the todo list exists. |
| `planYolo` | `PlanYolo` | — | Start in read-only plan mode, auto-approve, then switch to a target model. |

### Prompt / system prompt

| Option | Type | Description |
| --- | --- | --- |
| `systemPrompt` | `string \| string[] \| (default) => …` | Provider-facing system prompt override. |
| `customSystemPrompt` | `string` | Custom prompt text through the bundled template. |
| `appendSystemPrompt` | `string` | Text appended through the bundled templates. |
| `titleSystemPrompt` | `string` | Title-generation prompt override. |
| `providerSessionId` | `string` | Provider-facing session id for prompt caches and sticky auth. |
| `providerPromptCacheKey` | `string` | Provider-facing prompt cache key. |
| `providerPromptCacheKeySource` | `"explicit" \| "fork"` | Caller-pinned vs fork-inherited cache key. |
| `deadline` | `number` | Absolute wall-clock deadline (epoch ms). |

### Tools

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `toolNames` | `string[]` | full default set | Requested tool names; enables disabled-by-default tools. Not an allowlist by itself. |
| `restrictToolNames` | `boolean` | `false` | Limit the session to exactly `toolNames`. Restricted sessions disable ambient MCP, extensions, custom commands, and LSP. |
| `allowRestrictedCustomTools` | `boolean` | `false` | Permit SDK `customTools` in a restricted session (must still be named in `toolNames`). |
| `customTools` | `(CustomTool \| ToolDefinition)[]` | — | Custom tools registered in addition to built-ins. |
| `requireYieldTool` | `boolean` | `false` | Force the hidden `yield` tool into the active set. |
| `enableMCP` | `boolean` | `true` | `false` skips MCP discovery and ignores `mcpManager`. |
| `mcpManager` | `MCPManager` | discovered | Reuse an existing manager. |
| `enableLsp` | `boolean` | `true` | LSP integration (tool, formatting, diagnostics, warmup). |
| `lspReadOnly` | `boolean` | `restrictToolNames` | Restrict LSP to navigation and diagnostics. |
| `enableIrc` | `boolean` | enabled unless restricted | Expose IRC. |
| `skipPythonPreflight` | `boolean` | `false` | Skip kernel availability checks and prelude warmup. |

### Extensions

| Option | Type | Description |
| --- | --- | --- |
| `extensions` | `ExtensionFactory[]` | Inline extensions (merged with discovery). |
| `additionalExtensionPaths` | `string[]` | Extra extension files to load. |
| `disableExtensionDiscovery` | `boolean` | Disable ambient scanning; explicit paths and inline factories still load. |
| `preloadedExtensions` | `LoadExtensionsResult` | Reuse extensions loaded early by the same process. **Never pass loaded instances across session boundaries** — forward `preloadedExtensionPaths` to subagents so each session gets its own `ExtensionAPI` binding. |
| `preloadedExtensionPaths` | `string[]` | Pre-discovered extension paths (skips the FS scan, still re-binds per session). |
| `preloadedCustomToolPaths` | `ToolPathWithSource[]` | Pre-discovered custom-tool paths (same re-bind semantics). |

### Subagents & multi-session

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `outputSchema` | `unknown` | — | Structured-output expectation for subagent sessions. |
| `outputSchemaMode` | `"permissive" \| "strict"` | `"permissive"` | Structured-output enforcement policy. |
| `taskDepth` | `number` | `0` | Task recursion depth (marks the session as a subagent). |
| `parentTaskPrefix` | `string` | — | Artifact naming prefix (also the default registry id). |
| `parentAgentId` | `string` | — | Registry id of the spawning agent. |
| `agentId` / `agentDisplayName` | `string` | `"Main"` / `"main"` | Registry identity for IRC routing. |
| `agentRegistry` | `AgentRegistry` | `AgentRegistry.global()` | Shared registry; pass a private instance per concurrent top-level session. |
| `expectedAgentRef` | `AgentRef \| null` | undefined | Authorized registry generation (parked revival). |
| `parentHindsightSessionState` / `parentMnemopiSessionState` | state | — | Parent memory state aliased for subagent memory tools. |
| `parentEvalSessionId` | `string` | — | Shared eval executor session id. |
| `localProtocolOptions` | `LocalProtocolOptions` | session defaults | `local://` protocol root. |

### UI, behavior, observability

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `hasUI` | `boolean` | `false` | UI available (enables interactive tools like `ask`; gates LSP warmup). |
| `autoApprove` | `boolean` | `false` | Auto-approve all tool calls. |
| `deferUsageReserveConfirmation` | `boolean` | `false` | Defer reserve-policy confirmation until prompt-time UI is configured (ACP). |
| `telemetry` | `AgentTelemetryConfig` | — | Opt-in OpenTelemetry instrumentation; `{}` enables GenAI-semantic-convention spans. |
| `onFirstChatDispatch` | `() => void` | — | Fired once when the first request hits the provider transport (subagent launch latency). |

## Return value

```ts
type CreateAgentSessionResult = {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
  mcpManager?: MCPManager;
  modelFallbackMessage?: string;
  lspServers?: Array<{ name: string; status: "connecting" | "ready" | "error" | "available"; fileTypes: string[]; error?: string }>;
  eventBus: EventBus;
};
```

Use `setToolUIContext(...)` only when your embedder provides UI capabilities that tools and extensions should call into. `modelFallbackMessage` explains when the session was restored with a different model than saved.

## `AgentSession`

`AgentSession` is the session facade shared by every run mode (interactive, print, RPC, ACP). It owns the agent loop, event emission with automatic session persistence, model/thinking management, compaction, retries, bash/eval execution, and session switching/branching.

### Prompting

| Method | Description |
| --- | --- |
| `prompt(text, options?)` | Primary entry point. Expands `/` commands and prompt templates; while streaming, queues per `streamingBehavior: "steer" \| "followUp"` (required); when idle, validates model + API key and starts a turn. Returns `false` when a command was fully handled locally, `true` when forwarded. |
| `steer(text, images?)` | Queue a steering message to interrupt the agent mid-run. |
| `followUp(text, images?, options?)` | Queue a follow-up processed after the agent would otherwise stop. |
| `sendUserMessage(content, { deliverAs? })` | User message through the prompt flow (idle starts a turn; streaming queues as steer unless `deliverAs` is set). |
| `sendCustomMessage(message, { triggerTurn?, deliverAs?, queueChipText? })` | Send a custom message; creates a transcript entry. `deliverAs: "nextTurn"` keeps it hidden from the pending-message UI. Returns `true` iff a turn was synchronously started. |
| `abort(options?)` | Abort the current operation and wait for idle. |
| `clearQueue()`, `getQueuedMessages()`, `popLastQueuedMessage()`, `queuedMessageCount` | Queued-message inspection/restore. |

### Session state

`session.state` exposes the underlying `AgentState`; convenience getters include `model`, `thinkingLevel`/`configuredThinkingLevel()`, `serviceTierByFamily`, `isStreaming`, `isCompacting`, `sessionFile`, `sessionId`, `sessionName`, `messages`, `systemPrompt`, `steeringMode`/`followUpMode`/`interruptMode`, `scopedModels`, `promptTemplates`, `customCommands`, and `extensionRunner`.

### Lifecycle & sessions

| Method | Description |
| --- | --- |
| `dispose(options?)` | Remove listeners, flush pending writes, disconnect from the agent. **Idempotent** — repeated/concurrent calls share one teardown promise. |
| `beginDispose()` | Synchronous admission barrier for wrappers that await their own teardown before `dispose()`; call before your first `await`. Also idempotent. |
| `waitForIdle()` | Wait until streaming, persistence, and recovery work are settled. |
| `newSession()` / `fork()` / `switchSession(path)` / `branch(entryId)` / `navigateTree(targetId, options?)` / `reload()` / `moveSession(newCwd)` | Session switching and branching (hooks can cancel via `session_before_*` events). |
| `resetSessionContext()` | In-place `/clear` (keeps id/title/cwd/model/settings/transcript). |
| `abort()` | Abort current operation and wait for idle. |

### Model & thinking

`setModel(model, role?, options?)`, `setModelTemporary(...)`, `cycleModel()`, `getAvailableModels()`, `setThinkingLevel(level, persist?)`, `cycleThinkingLevel()`, `setFastMode(enabled)` / `toggleFastMode()`, `setServiceTierFamily(family, tier)`, `resolveRoleModel(role)`.

### Runtime tool set

`getActiveToolNames()`, `getAllToolNames()`, `setActiveToolsByName(names)`, `refreshMCPTools(mcpTools)` — the system prompt is rebuilt to reflect active-tool changes. Also `getToolByName(name)`, `hasEditTool`, `setComputerToolEnabled(enabled)`, `setInspectImageMode(mode)`, `getSelectedMCPToolNames()`.

### Compaction, retries, handoff

`compact(customInstructions?, options?)`, `abortCompaction()`, `setAutoCompactionEnabled(enabled)`, `retry()`, `abortRetry()`, `setAutoRetryEnabled(enabled)`, `shake(mode)`, `dropImages()`, `handoff(customInstructions?)` (`{ document, savedPath? }`).

### Bash & eval

`executeBash(command, onChunk?, options?)`, `abortBash()`, `isBashRunning`, `executePython(code, onChunk?, options?)`, `abortEval()`, `isEvalRunning`, `getEvalSessionId()`.

### Memory, todos, titles

`applyMemoryBackend()`, `refreshBaseSystemPrompt()`, `getTodoPhases()` / `setTodoPhases(phases)`, `generateTitle(firstMessage)`, `setTitleSystemPrompt(prompt)`.

### Stats & usage

`getSessionStats()`, `getContextUsage()`, `getContextBreakdown()`, `fetchUsageReports(signal?)`, `listCurrentProviderOAuthAccounts()`, `pinCurrentProviderOAuthAccount(credentialId)`.

### Export

`exportToHtml(outputPath?, useUserThemes?)`, `getLastAssistantText()`, `formatSessionAsText()`, `dumpLlmRequestToTmpDir()`.

## Events

Subscribe with `session.subscribe(listener)`; it returns an unsubscribe function. `AgentSessionEvent` covers the core `AgentEvent` types plus session-level events. `agent_end` carries `isTerminal?: boolean` — when `false`, maintenance or async delivery will resume the session before its true final settle; treat an absent field as terminal for compatibility.

Core events: `agent_start` / `agent_end` (with `messages`, optional `telemetry` + `coverage`), `turn_start` / `turn_end`, `message_start` / `message_update` / `message_end`, `tool_execution_start` / `tool_execution_update` / `tool_execution_end`.

Session-level events:

| Event | Payload |
| --- | --- |
| `auto_compaction_start` / `auto_compaction_end` | reason/action + result, `aborted`, `willRetry` |
| `auto_retry_start` / `auto_retry_end` | attempt, `maxAttempts`, `delayMs`, `errorMessage` |
| `retry_fallback_applied` / `retry_fallback_succeeded` | `{ from, to, role }` / `{ model, role }` |
| `model_changed` | — |
| `thinking_level_changed` | `{ thinkingLevel, configured?, resolved? }` |
| `ttsr_triggered` | `{ rules }` |
| `todo_reminder` / `todo_auto_clear` | `{ todos, attempt, maxAttempts }` / — |
| `irc_message` | `{ message }` |
| `notice` | `{ level, message, source? }` |
| `goal_updated` | `{ goal, state? }` |

```ts
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "tool_execution_start":
      break;
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
  }
});
```

## Session managers

`AgentSession` always uses a `SessionManager`. Two factories are available:

```ts
// File-backed (default): persists to <cwd>/...jsonl
const { session } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});
console.log(session.sessionFile); // absolute .jsonl path

// In-memory: no filesystem persistence — useful for tests and ephemeral workers
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});
console.log(session.sessionFile); // undefined
```

Resume / open / list helpers:

```ts
const recent = await SessionManager.continueRecent(process.cwd());
const listed = await SessionManager.list(process.cwd());
const opened = listed[0] ? await SessionManager.open(listed[0].path) : null;
```

Other factories: `open(filePath)`, `forkFrom(sourcePath, cwd)`, `createEmptySessionFile(cwd)`, `listAll()`. Storage is pluggable via the `SessionStorage` contract — `FileSessionStorage` (default), `MemorySessionStorage`, `IndexedSessionStorage`, `SqlSessionStorage` (`bun:sql`), and `RedisSessionStorage` are all exported from `@oh-my-pi/pi-coding-agent/session/*`.

## Models & auth

### Model selection

When `model` is omitted, the SDK picks in this order:

1. Restore the model from an existing session (if restorable and the API key is available).
2. The settings default model role (`default`).
3. The first available model with valid auth.

If restore fails, `modelFallbackMessage` explains the fallback.

### Auth priority

`AuthStorage.getApiKey(...)` resolves in this order:

1. Runtime override (`setRuntimeApiKey`, used by `omp --api-key`).
2. Config-sourced API key override (`models.yml` provider `apiKey`).
3. Stored OAuth credential, including refresh when needed.
4. API key persisted by a successful `/login`.
5. Provider environment variables.
6. Other stored API-key credentials in `agent.db` / broker-backed storage.
7. Custom-provider resolver fallback.

`ModelRegistry` exposes `getAll()` / `getAvailable()` (models with auth configured), `find(provider, modelId)`, `getApiKey(model, sessionId?)`, `resolver(...)`, and `registerProvider(name, config)` for runtime providers. `discoverAuthStorage(agentDir?)` returns a local SQLite store (`<agentDir>/agent.db`) or a remote auth-broker-backed store when `OMP_AUTH_BROKER_URL` is set (refresh tokens never leave the broker).

## Tools

Built-in tools come from `createTools(...)` and `BUILTIN_TOOLS` (29 built-ins: `read`, `bash`, `edit`, `ast_grep`, `ast_edit`, `ask`, `debug`, `eval`, `github`, `glob`, `grep`, `lsp`, `inspect_image`, `browser`, `computer`, `checkpoint`, `rewind`, `security_scan`, `task`, `hub`, `todo`, `web_search`, `write`, `memory_edit`, `retain`, `recall`, `reflect`, `learn`, `manage_skill`; hidden: `yield`, `goal`). See [Built-in Tools](/oh-my-pi/features/tools/) for behavior.

- `toolNames` requests named tools and enables disabled-by-default tools; by itself it is not an allowlist.
- `restrictToolNames: true` limits the session to exactly those names and disables ambient MCP, extensions, custom commands, and LSP.
- Hidden tools (e.g. `yield`) are opt-in unless required by options.

```ts
const { session } = await createAgentSession({
  toolNames: ["read", "grep", "glob", "write"],
  restrictToolNames: true,
  requireYieldTool: true,
});
```

Custom tools are loaded from `.omp/tools/`, `.claude/tools/`, and plugins via `loadCustomTools`/`discoverCustomToolPaths`, or passed inline through `customTools`. A `CustomTool` is a `{ name, label, description, parameters, execute(...) }` object wrapped into an `AgentTool` for the agent; `CustomToolFactory = (pi: CustomToolAPI) => CustomTool | CustomTool[]`. See [Custom Tools](/oh-my-pi/extending/custom-tools/).

Runtime tool-set updates: `getActiveToolNames()`, `getAllToolNames()`, `setActiveToolsByName(names)`, `refreshMCPTools(mcpTools)`.

## Extensions

Extensions are TypeScript modules (or inline `ExtensionFactory[]`) that subscribe to lifecycle events (`pi.on(...)` — 43 event names from session/agent/turn/message/tool lifecycle through `input`, `user_bash`, `user_python`, `mcp_notification`, `tool_approval_requested`), register tools/commands/shortcuts/flags, render messages, and interact via UI primitives. See [Extensions](/oh-my-pi/extending/extensions/) for the full API.

Extension options on `createAgentSession`:

- `extensions` — inline `ExtensionFactory[]`
- `additionalExtensionPaths` — load extra extension files
- `disableExtensionDiscovery` — disable automatic scanning; explicit paths and inline factories still load
- `preloadedExtensions` — reuse an extension set loaded early by the same session-owning process. Never pass loaded extension instances from a parent to another session; use `preloadedExtensionPaths` so each session gets its own `ExtensionAPI` binding.

The result's `extensionsResult` (a `LoadExtensionsResult`) exposes `extensions`, `errors`, and the shared `runtime`.

## MCP & LSP

MCP is enabled by default. `createAgentSession` accepts `enableMCP` and `mcpManager` (reuse an existing manager); the result returns `mcpManager` for server lifecycle management. Discovery reads `.mcp.json` files; Exa MCP servers are folded into native Exa integration and browser-automation servers are filtered when the built-in browser tool is enabled. See [MCP Servers](/oh-my-pi/extending/mcp/).

LSP is enabled by default (`enableLsp`, `lspReadOnly`). Language servers are lazy by default (`lsp.lazy: true`): no server launches at startup; each cold-starts on first use. The result's `lspServers` lists detected servers (`{ name, status, fileTypes, error? }`). See [Code Intelligence](/oh-my-pi/features/code-intelligence/).

## Subagents & multi-session

Subagent-oriented options (`outputSchema`, `outputSchemaMode`, `requireYieldTool`, `taskDepth`, `parentTaskPrefix`, `parentAgentId`, `agentId`, `agentDisplayName`, `agentRegistry`, `expectedAgentRef`, `parentEvalSessionId`) let you build orchestrators that spawn nested sessions with structured outputs. See [Subagents](/oh-my-pi/features/subagents/) and [Multi-Agent Workflows](/oh-my-pi/guides/multi-agent/).

For multiple concurrent top-level sessions in one process, pass a private `AgentRegistry` to each session — the default process-global registry admits only one `"Main"` identity per generation:

```ts
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";

const a = await createAgentSession({
  agentRegistry: new AgentRegistry(),
  sessionManager: SessionManager.inMemory(),
});
const b = await createAgentSession({
  agentRegistry: new AgentRegistry(),
  sessionManager: SessionManager.inMemory(),
});
```

## Telemetry

Pass `telemetry: AgentTelemetryConfig` (or `{}`) to enable OpenTelemetry spans (`invoke_agent`, `chat`, `execute_tool`, `handoff`) with GenAI semantic conventions. Safe without an OTEL SDK registered — `@opentelemetry/api` returns a no-op tracer. `agent_end` events carry `telemetry` (run summaries: chats, tools, usage, cost, errors) and `coverage` (tools available/invoked/unused, models, providers).

## Subsystems at a glance

| Subsystem | Key SDK surface | Docs |
| --- | --- | --- |
| Session | `AgentSession`, `SessionManager` | [Sessions](/oh-my-pi/features/sessions/) |
| Configuration | `Settings`, `ModelRegistry` | [Settings](/oh-my-pi/configuration/settings/) |
| Models & auth | `AuthStorage`, `discoverAuthStorage` | [Providers](/oh-my-pi/models/providers/) |
| Tools | `createTools`, `BUILTIN_TOOLS`, `CustomTool` | [Built-in Tools](/oh-my-pi/features/tools/) |
| Extensibility | `ExtensionAPI`, `Skill`, `CustomCommand` | [Extensions](/oh-my-pi/extending/extensions/), [Skills](/oh-my-pi/extending/skills/) |
| MCP | `MCPManager`, `MCPServerConfig` | [MCP Servers](/oh-my-pi/extending/mcp/) |
| LSP | `getOrCreateClient`, `LspStartupServerInfo` | [Code Intelligence](/oh-my-pi/features/code-intelligence/) |
| Eval kernels | `executePython`, `getEvalSessionId` | [Code Execution](/oh-my-pi/features/code-execution/) |
| Memory | `MemoryBackend`, `resolveMemoryBackend` | [Memory](/oh-my-pi/features/memory/) |
| Multi-agent | `TaskTool`, `AgentRegistry` | [Subagents](/oh-my-pi/features/subagents/) |
| Security | `SecretObfuscator`, `loadSecrets` | [Security](/oh-my-pi/features/security/) |
| Utilities | `EventBus`, `AsyncJobManager`, `buildWorkspaceTree` | [Internal URLs](/oh-my-pi/guides/internal-urls/) |

## RPC mode

For out-of-process embedding, `omp --mode rpc` runs the agent as a newline-delimited JSON protocol over stdio, with a ready-frame handshake, paged message history, host-owned tools and URI schemes, and bundled TypeScript (`RpcClient`) and Python (`omp-rpc`) client libraries. For a side-by-side comparison of the two embedding surfaces see [RPC vs SDK](/oh-my-pi/extending/rpc-vs-sdk/); for the protocol reference see [RPC](/oh-my-pi/extending/rpc/) and [Automation & Headless](/oh-my-pi/guides/automation-headless/).

## Sharp edges

:::caution
**The SDK runs an in-process agent.** Long-running sessions hold MCP and LSP processes open — always call `session.dispose()` before tearing down your host.
:::

- **Restricted sessions are truly restricted.** `restrictToolNames: true` disables ambient MCP, extensions, custom commands, and LSP; the active set is never widened.
- **`preloadedExtensions` never crosses session boundaries.** Forward `preloadedExtensionPaths`/`preloadedCustomToolPaths` to subagents instead.
- **`agent_end.isTerminal`.** When `false`, the session will resume before its true final settle; wait for `isTerminal !== false` before treating a run as complete.
- **`prompt()` returns `false` for local-only commands** (no `agent_end` will follow); `true` means the prompt was forwarded or queued.
- **In-memory `SessionManager` is non-persistent.** `session.sessionFile` is `undefined`, so resume/fork paths that depend on files do not apply.
- **Model/auth wiring identity.** When both `authStorage` and `modelRegistry` are passed, they must reference the same `AuthStorage` instance.
- **Disposal is async.** Use `beginDispose()` before your own teardown awaits, then `dispose()` to finish.
