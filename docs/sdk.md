# SDK

The SDK is the in-process integration surface for `@oh-my-pi/pi-coding-agent`. Use it when you want direct access to agent state, event streaming, tool wiring, and session control from a Bun process.

If you need cross-language/process isolation, use RPC mode instead (see [`docs/rpc.md`](./rpc.md) — published as [RPC](/oh-my-pi/extending/rpc/)).

## Installation

```bash
bun add @oh-my-pi/pi-coding-agent
```

Requires Bun 1.3.14 or newer. Before the first model-backed prompt, configure
credentials for a provider or run a keyless local provider; see
[Providers](./providers.md). Session construction can succeed without an
available model, but prompting cannot.

## What the SDK is

The package composes the full agent runtime around your own process:

- **`createAgentSession()`** — build a fully wired `AgentSession` (model, auth, tools, MCP, LSP, extensions, skills, memory, session journal) in one call. The default argument-less form discovers everything from the working directory and `~/.omp/agent`.
- **`AgentSession`** — the session facade shared by every run mode (interactive, print, RPC, ACP). It owns the agent loop, event emission with automatic session persistence, model/thinking management, compaction, retries, bash/eval execution, and session switching/branching.
- **`SessionManager`** — append-only session journal (`.jsonl` files) with resume/fork/list support.
- **`Settings` / `ModelRegistry` / `AuthStorage`** — configuration, model catalog, and credential resolution.
- **Tools, extensions, MCP, LSP, skills** — the full tool and extension surface, controllable per session.
- **Run modes** — `InteractiveMode`, `runPrintMode`, `runRpcMode` are exported for programmatic embedding; `RpcClient` (TypeScript and Python) drives a session out of process.

High-level groupings of the runtime are listed in [Subsystems](#subsystems).

## Entry points

The package root, `@oh-my-pi/pi-coding-agent`, is the complete embedding surface. It includes `createAgentSession` and the focused `/sdk` exports, plus lower-level session, auth, model, mode, extension, and tool APIs.

Import these core embedding APIs from the package root:

- `createAgentSession`
- `SessionManager`
- `Settings`
- `AuthStorage`
- `ModelRegistry`
- `discoverAuthStorage`
- Discovery helpers (`discoverExtensions`, `discoverSkills`, `discoverContextFiles`, `discoverPromptTemplates`, `discoverSlashCommands`, `discoverCustomTSCommands`, `discoverMCPServers`)
- Tool factory surface (`createTools`, `BUILTIN_TOOLS`, tool classes)
- TUI components for custom tool rendering (`Container`, `Markdown`, `Spacer`, `Text`), `logger`, `getAgentDir`, `VERSION`, the `z` schema builder (`@oh-my-pi/omptype/zod`)

The narrower `@oh-my-pi/pi-coding-agent/sdk` subpath exports `createAgentSession`, its option/result types, `Settings`, `AgentRegistry`, discovery and system-prompt helpers, workspace-tree helpers, selected extension/MCP/tool types, and selected tool classes/factories. It does **not** export `SessionManager`, `AuthStorage`, or `ModelRegistry`; import those three from the package root as the examples below do.

### `/sdk` export list

`@oh-my-pi/pi-coding-agent/sdk` resolves to `src/sdk.ts` and exports exactly:

| Kind | Symbols |
| --- | --- |
| Session factory | `createAgentSession`, `CreateAgentSessionOptions`, `CreateAgentSessionResult` |
| Dialect | `DialectFormat`, `resolveDialect` |
| Config | `Settings`, `SkillsSettings`, `PromptTemplate` |
| Extensibility | `CustomCommand`, `CustomCommandFactory`, `CustomTool`, `CustomToolFactory`, all extension types (`ExtensionFactory`, `ExtensionContext`, `ExtensionAPI`, `ExtensionRunner`, `ExtensionToolWrapper`, `ExtensionUIContext`, `LoadExtensionsResult`, `ToolDefinition`, …), `Skill`, `FileSlashCommand` |
| MCP | `MCPManager`, `MCPServerConfig`, `MCPServerConnection`, `MCPToolsLoadResult` |
| Agent registry | `AgentRef`, `AgentRegistry`, `MAIN_AGENT_ID` |
| Tools | `Tool`, `ToolSession`, `createTools`, `BUILTIN_TOOLS`, `HIDDEN_TOOLS`, `BashTool`, `EditTool`, `EvalTool`, `GlobTool`, `GrepTool`, `ReadTool`, `WebSearchTool`, `WriteTool` |
| Workspace tree | `buildDirectoryTree`, `buildWorkspaceTree`, `DirectoryTree`, `WorkspaceTree` |
| Discovery | `discoverAuthStorage`, `discoverExtensions`, `discoverSessionExtensionPaths`, `loadSessionExtensions`, `loadCliExtensionProviders`, `discoverSkills`, `discoverContextFiles`, `discoverPromptTemplates`, `discoverSlashCommands`, `discoverCustomTSCommands`, `discoverMCPServers` |
| System prompt | `buildSystemPrompt`, `BuildSystemPromptOptions` |
| Helpers | `customToolToDefinition`, `createAutoLearnCaptureRunner`, `AutoLearnCaptureRunnerOptions` |

### Deep subpath entry points

The package exports stable subpaths for the internal modules (`package.json` `exports` map). Everything is also reachable through the root barrel; the subpaths exist for tree-shaking and for imports that should not pull the whole CLI graph:

| Subpath | Surface |
| --- | --- |
| `@oh-my-pi/pi-coding-agent/session/*` | `SessionManager`, storage backends (`FileSessionStorage`, `MemorySessionStorage`, `IndexedSessionStorage`, `SqlSessionStorage`, `RedisSessionStorage`), `SessionStorage` contract, session entries, `SessionInfo`, `convertToLlm`-adjacent message helpers |
| `@oh-my-pi/pi-coding-agent/config/*` | `Settings`, `SETTINGS_SCHEMA`, `SettingPath`, `SettingValue`, `ModelRegistry`, model resolvers, `PromptTemplate`, service tiers, keybindings |
| `@oh-my-pi/pi-coding-agent/tools` | `createTools`, `BUILTIN_TOOLS`, `HIDDEN_TOOLS`, `Tool`, `ToolSession`, tool classes |
| `@oh-my-pi/pi-coding-agent/extensibility/*` | extensions (`./extensibility/extensions`), skills, custom tools (`./extensibility/custom-tools`), custom commands, hooks, plugins/marketplaces |
| `@oh-my-pi/pi-coding-agent/mcp` (+ `./mcp/transports`) | `MCPManager`, config/types, transports |
| `@oh-my-pi/pi-coding-agent/lsp` (+ `./lsp/clients`) | LSP client, startup events, config |
| `@oh-my-pi/pi-coding-agent/modes` (+ `./modes/rpc`, `./modes/acp`, `./modes/components`) | `InteractiveMode`, `RpcClient`, `RpcFrameDecoder`/`RpcFrameEncoder`, RPC protocol types, TUI components |
| `@oh-my-pi/pi-coding-agent/task` | `TaskTool`, task executor, `AgentProgress`, `SingleResult`, spawn policy |
| `@oh-my-pi/pi-coding-agent/async` | `AsyncJobManager` |
| `@oh-my-pi/pi-coding-agent/secrets` | `SecretObfuscator`, `loadSecrets`, placeholder-key helpers |
| `@oh-my-pi/pi-coding-agent/memory-backend`, `./memories`, `./hindsight` | memory backend interface/resolvers, mnemopi/hindsight state |
| `@oh-my-pi/pi-coding-agent/internal-urls` | `InternalUrlRouter`, `LocalProtocolHandler`, `LocalProtocolOptions`, `parseInternalUrl` |
| `@oh-my-pi/pi-coding-agent/capability` | capability registry (`defineCapability`, `loadCapability`, `Rule`, `ruleCapability`, `bucketRules`) |
| `@oh-my-pi/pi-coding-agent/commands/*`, `./cli/*`, `./commit/*`, `./export/html`, `./edit/*`, `./eval`, `./exa`, `./exec`, `./dap`, `./debug`, `./discovery`, `./markit`, `./plan-mode/*`, `./slash-commands/*`, `./ssh/*`, `./stt`, `./tui`, `./utils/*`, `./web/*` | the corresponding internal modules (CLI commands, commit pipeline, export, edit modes, eval kernels, web search/scrapers, …) |
| `@oh-my-pi/pi-coding-agent/prompts/*` | bundled prompt markdown assets |

## Quick start (auto-discovery defaults)

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

## What `createAgentSession()` discovers by default

`createAgentSession()` follows “provide to override, omit to discover”.

If omitted, it resolves:

- `cwd`: `getProjectDir()`
- `agentDir`: `~/.omp/agent` (via `getAgentDir()`)
- `authStorage`: `discoverAuthStorage(agentDir)`
- `modelRegistry`: `new ModelRegistry(authStorage)` + background `refreshInBackground()` when the registry is not provided
- `settings`: `await Settings.init({ cwd, agentDir })`
- `sessionManager`: `SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))` (file-backed)
- skills/rules/context files/prompt templates/slash commands/extensions/custom TS commands
- built-in tools via `createTools(...)`
- MCP tools (enabled by default; Exa MCP servers are folded into native Exa integration, and browser automation MCP servers are filtered when the built-in browser tool is enabled)
- LSP integration (enabled by default)
- `eventBus`: new `EventBus()` unless supplied

### Required vs optional inputs

Typically you must provide only what you want to control:

```ts
function createAgentSession(
  options?: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult>;
```

- **Must provide**: nothing for a minimal session
- **Usually provide explicitly** in embedders:
  - `sessionManager` (if you need in-memory or custom location)
  - `authStorage` + `modelRegistry` (if you own credential/model lifecycle)
  - `model` or `modelPattern` (if deterministic model selection matters)
  - `settings` (if you need isolated/test config)

For multiple concurrent top-level sessions in one process, pass a private
`AgentRegistry` to each session. The default process-global registry admits
only one `"Main"` identity per generation.


## `createAgentSession()` options

Every option is optional. The tables group them by concern; defaults are exactly what `createAgentSessionScoped` applies when the field is omitted.

### Discovery & context

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `cwd` | `string` | `getProjectDir()` | Working directory for project-local discovery (context files, MCP, extensions, skills, rules, slash commands, session manager, workspace tree). |
| `additionalDirectories` | `string[]` | `settings.get("workspace.additionalDirectories")` | Additional workspace directories beyond `cwd` (multi-root), absolute or `cwd`-relative; merged with restored session roots. |
| `agentDir` | `string` | `getAgentDir()` (`~/.omp/agent`) | Global config directory. Feeds auth storage, settings, prompt templates, custom TS commands, secrets, memory, watchdog/advisor discovery. |
| `settings` | `Settings` | `await Settings.init({ cwd, agentDir })` | Settings instance. Every `settings.get(...)` in the session reads from it. |
| `settingsManager` | `Settings \| Promise<Settings>` | — | Legacy alias for `settings` (older Pi extensions pass `SettingsManager.create(...)`); awaited and treated identically. |
| `sessionManager` | `SessionManager` | `SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))` | Session journal; the session's cwd/id/file/branch/context all come from it. |
| `workspaceTree` | `WorkspaceTree` | `buildWorkspaceTree(cwd)` raced against a 5 s deadline when the `includeWorkspaceTree` prompt setting is on; otherwise an empty tree | Pre-built workspace tree; skips re-scanning. Parents pass it to subagents. |
| `contextFiles` | `Array<{ path: string; content: string; depth?: number }>` | `discoverContextFiles(cwd, agentDir)` | Context files (`AGENTS.md` content). Re-discovered on cwd change when omitted. |
| `skills` | `Skill[]` | `discoverSkills(cwd, agentDir, skillsSettings)` | Skills; `skillsReloadable` becomes true only when omitted. |
| `rules` | `Rule[]` | `loadCapability(ruleCapability.id, { cwd })` | Rules; bucketed into TTSR / always-apply / rulebook sets (`bucketRules`). |
| `promptTemplates` | `PromptTemplate[]` | `discoverPromptTemplates(cwd, agentDir)` (`cwd/.omp/prompts/` + `agentDir/prompts/`) | File-based prompt templates for `/name` expansion. |
| `slashCommands` | `FileSlashCommand[]` | `discoverSlashCommands(cwd)` | File-based slash commands from `commands/` directories. |
| `eventBus` | `EventBus` | `new EventBus()` | Shared bus for tool/extension communication; returned in the result. |
| `spawns` | `string` | `"*"` | Spawn policy for the session (`"*"` unrestricted; otherwise a comma list whose first entry is the default agent). |

### Auth & model

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `authStorage` | `AuthStorage` | `discoverAuthStorage(agentDir)` | Credential storage. When both `authStorage` and `modelRegistry` are supplied, `modelRegistry.authStorage` MUST be the same instance or creation rejects. |
| `modelRegistry` | `ModelRegistry` | `new ModelRegistry(authStorage)` | Model catalog + API-key resolution. When internally created, `refreshInBackground()` runs. |
| `getApiKey` | `AgentOptions["getApiKey"]` | `modelRegistry.resolver(requestModel, sessionId)` | Request-level credential resolver seam. Defaults to the registry's normal session-affine resolver. |
| `model` | `Model` | settings default, else first available | Explicit model; skips restore/settings-default/deferred-pattern paths. `model.provider === "cursor"` drops the `edit` tool. |
| `modelPattern` | `string \| string[]` | — | Raw model pattern(s) (e.g. from `--model`) resolved after extensions load, so extension-provided models are registered first. |
| `modelPatternAuthFallback` | `string` | — | Authenticated fallback selector used when the primary resolved pattern has no credentials. |
| `modelPatternFallbackRole` | `string` | — | Role name used to install retry fallbacks after deferred subagent patterns resolve. |
| `modelPatternDefaultFallbackChain` | `string[]` | — | Validated default retry chain installed when a deferred singleton pattern resolves. |
| `thinkingLevel` | `ConfiguredThinkingLevel` | settings `defaultThinkingLevel`, else model default | Thinking selector: `"off"`/`"minimal"`/…/`"max"` or `"auto"` (`AUTO_THINKING` sentinel). `auto` resolves per turn via `resolveProvisionalAutoLevel`. |
| `thinkingLevelCeiling` | `Effort` | — | Hard ceiling on the session's thinking effort (e.g. a task spawn's `task.maxEffort`-capped hint); retry-fallback recovery re-clamps to it. |
| `openAIServiceTier` | `ServiceTier \| null` | from settings `tier.*` | OpenAI service-tier override. `null` omits `service_tier`. |
| `scopedModels` | `Array<{ model: Model; thinkingLevel?: ThinkingLevel }>` | — | Models available for cycling (Ctrl+P in interactive mode). |
| `prewalk` | `Prewalk` | — | Switch one-way from the starting model to a fast/cheap target at the first edit/write once the todo list exists. `{ target: Model; thinkingLevel?: ConfiguredThinkingLevel }`. |
| `planYolo` | `PlanYolo` | — | Start in read-only plan mode, auto-approve on the model's first resolve call, then switch to a target model for implementation. `{ target: Model; thinkingLevel?: ConfiguredThinkingLevel }`. |

### Prompt / system prompt

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `systemPrompt` | `string \| string[] \| ((defaultPrompt: string[]) => string \| string[])` | fully rendered default blocks | Provider-facing system prompt override. Replaces the rendered default blocks. |
| `customSystemPrompt` | `string` | — | Already-loaded custom prompt text rendered through the bundled custom system prompt template. |
| `appendSystemPrompt` | `string` | — | Already-loaded text appended through the bundled system prompt templates (after memory + autolearn + MCP guidance). |
| `titleSystemPrompt` | `string` | bundled default | Title-generation system prompt override; refresh on cwd change via `AgentSession.setTitleSystemPrompt`. |
| `providerSessionId` | `string` | `sessionManager.getSessionId()` | Provider-facing session identifier for prompt caches and sticky auth selection. Keeps persisted session files isolated while reusing provider-side caches. |
| `providerPromptCacheKey` | `string` | inherited from session header only when the fork shape is unchanged | Provider-facing prompt cache key, distinct from request lineage. |
| `providerPromptCacheKeySource` | `"explicit" \| "fork"` | — | Whether `providerPromptCacheKey` is caller-pinned or inherited from a full fork. |
| `deadline` | `number` | — | Absolute wall-clock deadline in Unix epoch milliseconds. |

### Tools

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `toolNames` | `string[]` | full default set | Tool names explicitly requested; enables disabled-by-default tools. By itself **not** an allowlist. |
| `restrictToolNames` | `boolean` | `false` | Limit the session to the names in `toolNames`. Restricted sessions disable ambient MCP, extensions, custom commands, and LSP by default; the active set is never widened. |
| `allowRestrictedCustomTools` | `boolean` | `false` | Permit caller-supplied SDK `customTools` inside a restricted session; they must still be named in `toolNames`. |
| `customTools` | `(CustomTool \| ToolDefinition)[]` | — | Custom tools registered in addition to built-ins (wrapped via `customToolToDefinition`). |
| `requireYieldTool` | `boolean` | `false` | Force the hidden `yield` tool into the active set (subagent completion protocol). |
| `enableMCP` | `boolean` | `true` | Enable MCP capabilities. `false` skips MCP discovery AND ignores `mcpManager`, preventing process-global or inherited MCP access. |
| `mcpManager` | `MCPManager` | discovered | Existing manager to reuse when MCP is enabled (skips discovery, propagates to the tool session). |
| `enableLsp` | `boolean` | `true` (restricted: `false`) | Enable LSP integration (tool, formatting, diagnostics, warmup). |
| `lspReadOnly` | `boolean` | `restrictToolNames` | Restrict LSP to navigation and diagnostics even when enabled. |
| `enableIrc` | `boolean` | enabled unless restricted | Whether this invocation may expose IRC; `false` removes it even for subagents. |
| `skipPythonPreflight` | `boolean` | `false` | Skip subprocess-kernel availability checks and prelude warmup. |

### Extensions

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `extensions` | `ExtensionFactory[]` | — | Inline extensions (merged with discovery; the autoresearch and custom-tools extensions are appended automatically). |
| `additionalExtensionPaths` | `string[]` | — | Extra extension paths to load (merged with discovery). |
| `disableExtensionDiscovery` | `boolean` | `false` | Disable ambient scanning; explicit paths and inline factories still load. Also skips custom-TS-command discovery. |
| `preloadedExtensions` | `LoadExtensionsResult` | — | Reuse an extension set loaded early by the same session-owning process. **Never** pass loaded instances across session boundaries (parent → subagent) — `Extension` instances close over a parent-bound `ExtensionAPI`; forward `preloadedExtensionPaths` instead. |
| `preloadedExtensionPaths` | `string[]` | — | Pre-discovered extension source paths; skips the FS scan but still calls `loadExtensions` so each `Extension` is bound to THIS session's `ExtensionAPI`. Safe parent → subagent pass-through. |
| `preloadedCustomToolPaths` | `ToolPathWithSource[]` | — | Pre-discovered custom-tool source paths; skips the scan, still re-binds tools to each session's own `CustomToolAPI`. Safe parent → subagent pass-through. |

### Subagents & multi-session

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `outputSchema` | `unknown` | — | Structured-output expectation for subagent sessions. |
| `outputSchemaMode` | `StructuredSubagentSchemaMode` | `"permissive"` | `"permissive"` keeps legacy retry-budget overrides; `"strict"` turns invalid final payloads into `schema_violation` failures. |
| `taskDepth` | `number` | `0` | Task recursion depth (`0` = top-level, `1` = first child). `> 0` marks the session as a subagent (`agentKind: "sub"`). |
| `parentTaskPrefix` | `string` | — | Parent task ID prefix for nested artifact naming (e.g. `"Extensions"`); also the default registry id for subagents. |
| `parentAgentId` | `string` | — | Registry id of the spawning agent, recorded as this subagent's parent. |
| `agentId` | `string` | `parentTaskPrefix ?? "Main"` | Pre-allocated agent identity for IRC routing. |
| `agentDisplayName` | `string` | `"main"` / `"sub"` | Display name for the agent in IRC. |
| `agentRegistry` | `AgentRegistry` | `AgentRegistry.global()` | Shared registry for IRC routing across sessions. |
| `expectedAgentRef` | `AgentRef \| null` | undefined (unconditional registration) | Registry generation authorized for this creation; `null` requires the id absent; an `AgentRef` allows a parked revival to reuse only that ref. |
| `parentHindsightSessionState` | `HindsightSessionState` | — | Parent Hindsight state to alias for subagent memory tools. |
| `parentMnemopiSessionState` | `MnemopiSessionState` | — | Parent Mnemopi state to alias for subagent memory tools. |
| `parentEvalSessionId` | `string` | — | Inherited eval executor session id so subagents share parent JS/Python/Ruby/Julia state. |
| `localProtocolOptions` | `LocalProtocolOptions` | the session's own artifacts dir + session id | `local://` protocol root; top-level sessions also install it as the process-global override. |

### UI & behavior

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `hasUI` | `boolean` | `false` | Whether UI is available (enables interactive tools like `ask`; gates LSP warmup and MCP status events). |
| `autoApprove` | `boolean` | `false` | Auto-approve all tool calls (`--auto-approve`). |
| `deferUsageReserveConfirmation` | `boolean` | `false` | Defer `confirm` reserve-policy fallback until prompt-time UI is configured (ACP negotiation). |

### Observability

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `telemetry` | `AgentTelemetryConfig` | — | Opt-in OpenTelemetry instrumentation forwarded to the underlying `Agent`. Passing `{}` enables the loop's GenAI-semantic-convention spans; safe without an OTEL SDK (no-op tracer). |
| `onFirstChatDispatch` | `() => void` | — | Fired once when the agent loop hands its first request to the provider transport — the boundary between “session built” and “model call dispatched”, used to measure subagent launch latency. |

## `createAgentSession()` return value

```ts
type CreateAgentSessionResult = {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
  mcpManager?: MCPManager;
  modelFallbackMessage?: string;
  lspServers?: Array<{
    name: string;
    status: "connecting" | "ready" | "error" | "available";
    fileTypes: string[];
    error?: string;
  }>;
  eventBus: EventBus;
};
```

- `session` — the wired `AgentSession`.
- `extensionsResult` — loaded extensions + shared runtime (`LoadExtensionsResult`).
- `setToolUIContext(...)` — update the tool/extension UI context; use only if your embedder provides UI capabilities tools/extensions should call into.
- `mcpManager` — MCP manager for server lifecycle management; `undefined` when MCP is disabled.
- `modelFallbackMessage` — warning when the session was restored with a different model than saved (or no model matched).
- `lspServers` — LSP servers detected for startup; warmup may continue in the background.
- `eventBus` — the shared event bus (new unless supplied).

## Runtime behavior

### Discovery order

`createAgentSessionScoped` wires the session in a fixed order:

1. Defaults: `cwd` → `agentDir` → `eventBus`; postmortem cleanup registrations (SSH connections, eval kernels).
2. `modelRegistry` (or construct with a discovered `authStorage`); divergence validation (**Throw #1**: `options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided`).
3. `authStorage.onCredentialDisabled` subscription (buffered until the extension runner exists, then drained).
4. `settings` (`options.settings ?? options.settingsManager ?? Settings.init(...)`) → `initializeWithSettings`.
5. Background `modelRegistry.refreshInBackground()` (only when internally constructed).
6. Parallel early discovery (fire-and-forget, awaited at consumer sites): workspace tree (5 s deadline race), context files, active repo context, watchdog files, advisor configs, prompt templates, slash commands, skills.
7. `applyProviderGlobalsFromSettings` (web-search exclusion/order, image provider order).
8. `sessionManager` (default file-backed); `additionalDirectories` merge.
9. `providerSessionId` default; fork-shape check → inherited prompt-cache key.
10. Secrets: `secrets.enabled` → `loadSecrets` + env secrets + builtin credential entries; `SecretObfuscator` built; placeholder key created when needed.
11. Session branch recovery: `createInterruptedTurnAbortMessage` appended for non-terminal tails; `deobfuscateSessionContext`.
12. Model selection stage 1 (pre-extension): allowed-models resolution, session restore (`getRestorableSessionModels`), settings-default role fallback, initial thinking level, `preconnectModelHost(model.baseUrl)`.
13. Skills resolution (provided or discovered).
14. TTSR rules: `TtsrManager` from the `ttsr` settings group; rules bucketed.
15. Session-config knobs: restriction flags, LSP, `AsyncJobManager` (top-level singleton), agent registry identity, eval kernel owner.
16. Tool session construction; top-level globals (`setActiveSkills`, `setActiveRules`, `AsyncJobManager.setInstance`, `LocalProtocolHandler.setOverride` for provided options, `AgentOutputManager`).
17. `createTools(toolSession, options.toolNames)` — built-ins, meta-notice wrapped.
18. MCP: deferred-UI discovery (pending placeholders + background connect) or eager `discoverAndLoadMCPTools`; `mcp.notifications` → notifications on; `MCPManager.setInstance` (top-level only).
19. Non-restricted custom-tool acquisition: image-gen tools, TTS tool, web-search tools, `discoverCustomToolPaths` + `loadCustomTools`.
20. Inline extension factories: `options.extensions` + autoresearch + custom-tools extension.
21. Extension load (restricted → none; preloaded → reuse; else discover + load).
22. Extension provider registration → `refreshRuntimeProviders("offline")`, background refresh stashed.
23. Model selection stage 2 (post-extension): retry session-model candidates; deferred `modelPattern` resolution (usage preflight, auth fallback, role/chain overrides); `pickDefaultAvailableModel` fallback; `modelFallbackMessage` variants.
24. Interrupted-turn abort with final model metadata.
25. Custom TS commands load (skipped when `disableExtensionDiscovery` or restricted).
26. `ExtensionRunner` construction; credential-disabled backlog drained.
27. Tool registry assembly: `wrapRegisteredTools` + meta-notice + `deduplicateMCPToolsByName`, goal tool, pending MCP placeholders, `ExtensionToolWrapper` pass over every tool.
28. Cursor bridge: `CursorExecHandlers`, cursor edit tool, `ensureWriteRegistered`.
29. Prompt knobs: inline tool descriptors, eager tasks, intent field, `rebuildSystemPrompt` closure (memory backend, autolearn, MCP xdev guidance, MCP server instructions truncated at 4000 chars, custom/append overrides, ~30 settings inputs).
30. Active tool-set assembly: yield force-include, manage_skill/learn force-activate, checkpoint↔rewind pairing, `defaultInactive` drops, xdev mounting partition, `setActiveToolNames`.
31. Registry pre-registration (before system prompt build so parallel subagents see each other in the IRC peers list) — `register`/`registerIfAvailable` (**Throw #2** on collision).
32. `new Agent({...})` with the full option set (stream fn with provider-concurrency wrap + first-dispatch hook, dialect, append-only context, telemetry).
33. `new AgentSession({...})` with all wiring; `yieldQueue` channel registrations (`mcp-notification`, LSP late diagnostics).
34. Registry attach (`attachSession` + `setStatus("running")`) — **Throw #5** on replacement.
35. Dispose wrapper installed (beginDispose → teardown → `unregisterUnlessParked`).
36. OpenAI Codex transport details + websocket prewarm (fire-and-forget).
37. LSP: `setSharedLspEnabled`; `lspServers` discovery; background `warmupLspServers` when `hasUI`.
38. Memory backend start (`resolveMemoryBackend(settings)` → `backend.start(...)`); `AutoLearnController` when `autolearn.enabled` and top-level.
39. MCP wiring for fresh managers (`setOnToolsChanged` → `session.refreshMCPTools`, prompts → `buildMCPPromptCommands`, resources → debounced notification enqueue).
40. Return `{ session, extensionsResult, setToolUIContext, mcpManager, modelFallbackMessage, lspServers, eventBus }`.

### Thrown errors

| Message | When |
| --- | --- |
| `options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided` | divergent stores |
| `` Agent "<id>" is already owned by another session generation. `` | `registerIfAvailable` CAS failed |
| `` Usage depleted for <provider>/<model>; reserve policy is fail-closed. `` | usage health depleted + `retry.usageReservePolicy: "fail-closed"` |
| `` Usage reserve reached for <provider>/<model>; reserve policy is fail-closed. `` | reserve reached + fail-closed |
| `` Agent "<id>" was replaced during session initialization. `` | registry attach failed |
| `Auto-learn capture identity is incomplete` | capture agent without model/session id |
| `Session unavailable for launch completion delivery` | async delivery with no session |

`modelFallbackMessage` variants (non-throwing): `Could not restore model <x>`, `Model <requested> not found`, `No model available matching enabledModels (<patterns>) with usable credentials…`, `No models available. Use /login or set an API key environment variable…` — with `Using <provider>/<id>` appended when a pick succeeded.

### MCP folding and filtering

- `enableMCP = !restrictToolNames && (options.enableMCP ?? true)`; `false` skips discovery and ignores `mcpManager`.
- Exa MCP servers (`isExaMCPServer`) are filtered out and their API keys folded into native Exa integration (`applyMCPEnvironment` sets `EXA_API_KEY` when unset).
- Browser-automation MCP servers are filtered when the built-in browser tool is enabled (`filterBrowser: settings browser.enabled ?? false`).
- In a restricted session, no MCP at all — not even an inherited/process-global manager.

### LSP warmup conditions

Startup LSP servers are only warmed when **all** of these hold: `enableLsp !== false`, `hasUI === true`, and the `lsp.lazy` setting is disabled (default: enabled). With lazy enabled, each server cold-starts on first use. Tools that need a server still spin one up on demand via `getOrCreateClient()` — only the startup warmup is skipped.

### Model-host preconnect

As soon as the model is resolved, the SDK fires a best-effort `fetch.preconnect(model.baseUrl)` so DNS + TCP + TLS + HTTP/2 to the provider host runs in parallel with extension/skill load, tool registry build, and system-prompt assembly. `preconnectModelHost()` lives in `src/sdk.ts`; if `fetch.preconnect` is unavailable or throws, the optimization is silently skipped.


## `AgentSession`

`AgentSession` is the session facade shared by all run modes (interactive, print, RPC, ACP). It composes the agent loop, event subscription with automatic session persistence, model and thinking-level management, compaction (manual and auto), retries, bash execution, session switching and branching, memory, advisors, and the extension runner. Construct it via `createAgentSession()` (or directly with `AgentSessionConfig` — see `src/session/agent-session.ts`, exported from the package root through `./session/agent-session`).

### Public fields

| Field | Type | Description |
| --- | --- | --- |
| `agent` | `Agent` | The underlying `@oh-my-pi/pi-agent-core` agent (state, prompt/steer, hooks). |
| `sessionManager` | `SessionManager` | The session journal. |
| `settings` | `Settings` | The session's settings instance. |
| `yieldQueue` | `YieldQueue` | Queue for hidden injected messages (async job results, MCP notifications, late diagnostics). |
| `getXdevToolEntries` | `() => Array<{ name: string; summary: string }>` | Entries of tools mounted under `xd://`; empty when virtual devices are unmounted. |
| `fileSnapshotStore` | `InMemorySnapshotStore \| undefined` | Snapshot store of file contents as last shown to the model (hashline anchor recovery). |
| `editClipboard` | `Clipboard \| undefined` | Per-session `CUT`/`PASTE` clipboard register shared across edit calls. |
| `configWarnings` | `string[]` | Mutable; turn-recovery appends warnings. |
| `rawSseDebugBuffer` | `RawSseDebugBuffer` | Every provider response/SSE event recorded by the `onResponse`/`onSseEvent` wrappers. |

### Session state & properties

| Method / getter | Signature / type | Description |
| --- | --- | --- |
| `state` | `AgentState` | Full agent state (`systemPrompt`, `model`, `thinkingLevel`, `tools`, `messages`, `isStreaming`, `pendingToolCalls`, …). |
| `model` | `Model \| undefined` | Current model (may be undefined before selection). |
| `retryFallbackModel` | `string \| undefined` | Resolved selector while retry routing uses a fallback model. |
| `thinkingLevel` | `ThinkingLevel \| undefined` | Effective thinking level applied to the agent (resolved when `auto`). |
| `configuredThinkingLevel()` | `ConfiguredThinkingLevel \| undefined` | The selector the user configured (`auto` when auto mode is active). |
| `isAutoThinking` | `boolean` | True when `auto` thinking mode is active. |
| `autoResolvedThinkingLevel()` | `Effort \| undefined` | The level `auto` resolved to for the current turn. |
| `serviceTierByFamily` | `ServiceTierByFamily` | Live per-family service tiers (OpenAI/Anthropic/Google). |
| `isStreaming` | `boolean` | Whether the agent is currently streaming a response. |
| `isAborting` | `boolean` | True while an abort is in flight. |
| `isCompacting` | `boolean` | Whether auto-compaction is currently running. |
| `isDisposed` | `boolean` | True once `dispose()` has begun. |
| `sessionFile` | `string \| undefined` | Current session file path (`undefined` for in-memory sessions). |
| `sessionId` | `string` | Current session ID (fresh provider session id if rotated, else `sessionManager.getSessionId()`). |
| `sessionName` | `string \| undefined` | Current session display name. |
| `scopedModels` | `ReadonlyArray<{ model; thinkingLevel? }>` | Models for cycling (from `--models`). |
| `messages` | `AgentMessage[]` | All messages including custom types (`BashExecutionMessage`, etc.). |
| `systemPrompt` | `string[]` | Current effective system prompt blocks (includes per-turn extension modifications). |
| `steeringMode` / `followUpMode` / `interruptMode` | `"all" \| "one-at-a-time"` / `"all" \| "one-at-a-time"` / `"immediate" \| "wait"` | Current queue modes (setters also persist to settings: `setSteeringMode`, `setFollowUpMode`, `setInterruptMode`). |
| `providerSessionState` | `Map<string, ProviderSessionState>` | Provider-scoped mutable state store for transport/session caches. |
| `preferWebsockets` | `boolean \| undefined` | Hint forwarded to providers that support websocket transport. |
| `promptTemplates` | `ReadonlyArray<PromptTemplate>` | Loaded prompt templates. |
| `customCommands` | `ReadonlyArray<LoadedCustomCommand>` | TypeScript slash commands + MCP prompt commands. |
| `mcpPromptCommands` | `ReadonlyArray<LoadedCustomCommand>` | MCP prompt commands only. |
| `ttsrManager` | `TtsrManager \| undefined` | Time-traveling stream rules manager. |
| `obfuscator` | `SecretObfuscator \| undefined` | Secret obfuscator, when secrets are configured. |
| `goalRuntime` | `GoalRuntime` | Goal-mode runtime. |
| `clientBridge` / `setClientBridge` | `ClientBridge \| undefined` | Bridge to the connected client (e.g. ACP editor host); tools route fs/terminal/permission requests through it. |
| `extensionRunner` | `ExtensionRunner \| undefined` | Extension runner (set UI context and error handlers). |
| `modelRegistry` | `ModelRegistry` | Model registry for API key resolution and model discovery. |
| `asyncJobManager` | `AsyncJobManager \| undefined` | Async job manager (top-level sessions own one). |

### Prompting

| Method | Description |
| --- | --- |
| `prompt(text, options?: PromptOptions): Promise<boolean>` | Primary entry point. Expands `/` commands (extension → custom TS → file slash commands) and prompt templates; when streaming, queues via `steer`/`followUp` per `streamingBehavior` (required while streaming — throws `AgentBusyError`); when idle, validates model + API key, appends the user message, and starts a turn. Returns `false` when a command was fully handled locally (no LLM), `true` when forwarded (directly or queued). |
| `promptCustomMessage<T>(message, options?): Promise<void>` | Prompt with a `CustomMessage` payload (`customType`, `content`, `display`, `details`, `attribution`); supports `queueOnly` and skill-prompt handling. |
| `steer(text, images?): Promise<void>` | Queue a steering message to interrupt the agent mid-run (delivered after the current tool, skips remaining tools). Rejects `/`-prefixed extension commands. |
| `followUp(text, images?, options?: FollowUpOptions): Promise<void>` | Queue a follow-up processed after the agent would otherwise stop. `options.synthetic` enqueues a hidden developer message (agent-attributed by default). |
| `sendUserMessage(content, { deliverAs? }): Promise<void>` | User message through the prompt flow; omitted `deliverAs` starts a turn when idle and queues as steer while streaming. |
| `sendCustomMessage<T>(message, { triggerTurn?, deliverAs?, queueChipText? }): Promise<boolean>` | Send a custom message; creates a `CustomMessageEntry`. Returns `true` iff the call synchronously started a new turn. `deliverAs: "nextTurn"` keeps the message hidden from the pending-message UI. |
| `queueDeferredMessage(message)` | Queue a hidden message injected at the next agent turn. |
| `queueLaunchCompletion(notification)` | Queue a broker supervised-process completion for the owning session. |
| `clearQueue({ forInterrupt? })` | Clear queued messages; returns user-restorable ones (`{ steering, followUp }` arrays of `{ text, images? }`). |
| `queuedMessageCount` | Number of pending displayable messages. |
| `getQueuedMessages()` | Chip text of user-authored queued messages. |
| `popLastQueuedMessage()` | Pop the last queued message (steering first) for editor restore. |

`PromptOptions`: `{ expandPromptTemplates?: boolean (default true); images?: ImageContent[]; streamingBehavior?: "steer" | "followUp"; toolChoice?: ToolChoice; synthetic?: boolean; userInitiated?: boolean; attribution?: MessageAttribution; skipCompactionCheck?: boolean }`.

`FollowUpOptions`: `{ synthetic?: boolean; expandPromptTemplates?: boolean (default true); attribution?: MessageAttribution }`.

### Lifecycle & disposal

| Method | Description |
| --- | --- |
| `beginDispose(): void` | Synchronous admission barrier: marks the session disposing, rejects new eval work, drops queued asides, detaches the aside provider, cancels memory startup/title/autolearn. Idempotent; `dispose()` runs it first. Wrappers that await their own teardown before `dispose()` MUST call it before their first `await`. |
| `dispose(options?: AgentSessionDisposeOptions): Promise<void>` | Remove listeners, flush pending writes, disconnect from the agent. Idempotent — concurrent or repeated calls share one settled promise. Records the exit diagnostic, emits `session_shutdown` once, aborts retries/compaction/turn, drains post-prompt and auto-learn work (bounded), then tears down session-owned async jobs, eval kernels, browser tabs, computer sessions, MCP connections, advisor state, and memory state concurrently. |
| `waitForIdle(): Promise<void>` | Wait until streaming, event persistence, and deferred recovery work are fully settled. |
| `freshSession(): FreshSessionResult \| undefined` | Rotate provider stream state only (new provider session id, re-sync session id, rekey memory) without clearing the conversation. |
| `resetSessionContext(): Promise<ResetSessionContextResult \| undefined>` | In-place `/clear`: drop every message, queued turn, and pending tool call while keeping session id/title/cwd/model/settings/transcript. Returns `undefined` while streaming or running bash/eval. |
| `newSession(options?): Promise<boolean>` | Start a new session (emits `session_before_switch`/`session_switch`; `false` when cancelled by a hook). |
| `fork(): Promise<boolean>` | Fork into a new session file with the exact same state (messages preserved). |
| `moveSession(newCwd, targetSessionDir?): Promise<void>` | Move the session and artifacts; enforces mode transition invariants. |
| `reload(): Promise<void>` | Re-read the current session file from disk and re-emit session hooks. |
| `switchSession(sessionPath): Promise<boolean>` | Switch to a different session file; aborts current operation, loads messages, restores model/thinking; full rollback on error. |
| `branch(entryId): Promise<{ selectedText; selectedImages; cancelled }>` | Create a branch from a specific entry (user message); emits `session_before_branch`/`session_branch`. |
| `branchFromBtw(...)` | Promote a completed `/btw` answer from the authorized session and leaf. |
| `navigateTree(targetId, options): Promise<…>` | Navigate to a different node in the same file; optional abandoned-branch summarization; two-phase `ask` re-answer protocol. |
| `getUserMessagesForBranching()` | User messages for the branch selector. |
| `abort(options?): Promise<void>` | Abort current operation and wait for idle. `reason: USER_INTERRUPT_LABEL` marks a deliberate user interrupt (suppresses advisor auto-resume, records it in the transcript). |
| `markMovedFromEmptySessionFile(sessionFile)` | Track a `/move`-created empty session for cleanup. |
| `setSessionName(name, source?, trigger?)` | Set the display name (persists; `source: "auto" | "user"`). |

`AgentSessionDisposeOptions`: `{ mnemopiConsolidateTimeoutMs?: number; reason?: postmortem.Reason }`.

### Model & thinking management

| Method | Description |
| --- | --- |
| `setModel(model, role?, options?): Promise<{ switched: boolean }>` | Set the model directly; validates a credential source synchronously; throws if no API key is available. |
| `setModelTemporary(model, thinkingLevel?, { ephemeral? })` | Select without updating persisted model settings. |
| `cycleModel(direction?)` / `getRoleModelCycle(roleOrder)` / `applyRoleModel(entry)` / `cycleRoleModels(roleOrder, direction?)` | Cycle scoped/available models and configured role models. |
| `getAvailableModels()` | Available models after the enabled-model filter. |
| `setThinkingLevel(level, persist?)` / `cycleThinkingLevel()` / `getAvailableThinkingLevels()` | Thinking selector control. |
| `isFastModeEnabled()` / `isFastModeActive()` / `setFastMode(enabled)` / `toggleFastMode()` | Priority-service (fast mode) control. |
| `setServiceTierFamily(family, tier)` | Set or clear one family's live service tier. |
| `resolveRoleModel(role)` / `resolveRoleModelWithThinking(role)` / `resolveTemporaryModelThinkingLevel(model)` | Role → model resolution (with thinking suffix preservation). |
| `setUsageFallbackConfirmer(confirmer)` | Install the interactive decision surface for reserve-triggered model changes. |

### Runtime tool surface

| Method | Description |
| --- | --- |
| `getActiveToolNames()` / `getEnabledToolNames()` / `getMountedXdevToolNames()` / `getAllToolNames()` | Active (top-level), enabled (incl. discoverable), `xd://`-mounted, and every registered tool name. |
| `getAllToolInfos()` | Full metadata for every registered tool with source provenance. |
| `getToolByName(name)` / `hasBuiltInTool(name)` / `hasEditTool` | Registry lookups. |
| `setActiveToolsByName(toolNames)` | Select enabled tools, ignoring names absent from the registry; system prompt is rebuilt to reflect the change. |
| `setActiveToolPresentation(toolNames, mountedToolNames)` | Restore an exact top-level vs `xd://` partition. |
| `refreshMCPTools(mcpTools)` | Replace connected MCP tools and enable them immediately. |
| `refreshRpcHostTools(rpcTools)` | Replace host-owned RPC tools before the next model call. |
| `activateVibeTools(baseToolNames)` / `deactivateVibeTools(nextToolNames)` / `removeVibeToolsPreservingActive()` | Ephemeral vibe-mode tool set management. |
| `setComputerToolEnabled(enabled)` | Session-scoped toggle for the settings-gated `computer` tool. |
| `setInspectImageMode(mode)` / `inspectImageState()` / `getInspectImageModeOverride()` / `applyInspectImageModeChange()` | `/vision` inspect_image mode control. |
| `refreshSkills()` | Rediscover reloadable skills and refresh prompt metadata. |
| `nextToolChoiceDirective()` / `setForcedToolChoice(toolName)` / `toolChoiceQueue` / `peekQueueInvoker()` / `peekPendingInvoker()` / `clearPendingInvokers()` / `peekPlanProposalHandler()` / `setPlanProposalHandler(handler)` | Tool-choice forcing (genuine forces vs non-forcing preview `SoftToolRequirement`s) and plan-proposal dispatch. |

### Compaction & maintenance

| Method | Description |
| --- | --- |
| `compact(customInstructions?, options?): Promise<CompactionResult>` | Compact the active session history (`CompactOptions` supports `mode` overrides: `soft`/`remote`/`snapcompact`). |
| `abortCompaction()` / `runIdleCompaction()` / `setAutoCompactionEnabled(enabled)` / `autoCompactionEnabled` | Compaction control. |
| `shake(mode, opts?)` | Reduce stored context with a shake strategy. |
| `dropImages()` | Strip image content from the current branch and persist the rewrite. |
| `retry()` / `abortRetry()` / `isRetrying` / `autoRetryEnabled` / `setAutoRetryEnabled(enabled)` / `retryAttempt` | Auto-retry control. |
| `handoff(customInstructions?, options?): Promise<HandoffResult \| undefined>` / `abortHandoff()` / `abortBranchSummary()` / `isGeneratingHandoff` | Handoff document generation (`{ document: string; savedPath?: string }`). |

### Bash & eval

| Method | Description |
| --- | --- |
| `executeBash(command, onChunk?, { excludeFromContext?, useUserShell? }): Promise<BashResult>` | Execute a bash command, retaining the session/branch that owned its start. |
| `recordBashResult(command, result, options?)` / `abortBash()` / `isBashRunning` / `hasPendingBashMessages` | Bash bookkeeping and control. |
| `executePython(code, onChunk?, { excludeFromContext? }): Promise<PythonResult>` | Execute Python in the shared kernel (same session as eval's Python backend). |
| `recordPythonResult(...)` / `abortEval()` / `isEvalRunning` / `hasPendingPythonMessages` / `assertEvalExecutionAllowed()` / `trackEvalExecution(execution, abortController)` | Python/eval bookkeeping; `trackEvalExecution` lets disposal await/abort out-of-session eval work. |
| `getEvalSessionId()` / `getEvalKernelOwnerId()` | Shared eval state identity. |

### Skills, todos, titles

| Method | Description |
| --- | --- |
| `skills` / `skillWarnings` / `skillsSettings` | Loaded skills + warnings (empty when `skills: []` was passed). |
| `getTodoPhases()` / `setTodoPhases(phases)` | Todo state. |
| `maybeStartTitleGeneration(firstMessage, onStart?)` / `generateTitle(firstMessage)` / `titleSystemPrompt` / `setTitleSystemPrompt(prompt)` | Automatic session title generation (first-input title + replan refresh). |

### Plan / goal / vibe modes

| Method | Description |
| --- | --- |
| `getPlanModeState()` / `setPlanModeState(state)` / `getPrewalkState()` / `armPrewalk(target, thinkingLevel?)` / `preparePlanForReview(title)` | Plan mode + prewalk. |
| `getGoalModeState()` / `setGoalModeState(state)` | Goal mode. |
| `getVibeModeState()` / `setVibeModeState(state)` | Vibe mode. |
| `sendPlanModeContext(...)` / `sendGoalModeContext(...)` / `sendVibeModeContext({ deliverAs? })` | Inject mode context messages. |
| `markPlanReferenceSent()` / `setPlanReferencePath(path)` / `getPlanReferencePath()` | Plan reference (`local://<title>.md`). |
| `getCheckpointState()` / `setCheckpointState(state)` / `getLastCompletedRewind()` | Checkpoint/rewind state. |

### Stats, usage, OAuth, Codex resets

| Method | Description |
| --- | --- |
| `getSessionStats()` | `SessionStats` (`/session` command data: message counts, tokens, cost, context usage). |
| `getContextUsage({ contextWindow? })` / `getContextBreakdown({ contextWindow?, pendingMessages? })` | Context usage (`{ tokens, contextWindow, percent }`) and token breakdown. |
| `contextUsageRevision` | Monotonic counter for status-line context memoization. |
| `fetchUsageReports(signal?)` | Live provider usage reports. |
| `getUsageReportingModelSelectors(reports)` | Models whose reports map to a quantitative usage scope. |
| `listCurrentProviderOAuthAccounts()` / `pinCurrentProviderOAuthAccount(credentialId)` | OAuth account listing/pinning for the current provider. |
| `redeemResetCredit(target, signal?)` / `listResetCredits(signal?)` | Saved Codex rate-limit resets. |

### Export & formatting

| Method | Description |
| --- | --- |
| `exportToHtml(outputPath?, useUserThemes?)` | Export the session to HTML. |
| `getLastAssistantText()` / `hasCopyCandidateAssistantMessage()` / `getLastVisibleHandoffText()` | Copy helpers. |
| `formatSessionAsText()` | Full session as plain text (system prompt, config, tool inventory, transcript). |
| `dumpLlmRequestToTmpDir()` | Dump the LLM-facing request context as JSON to a temp file (may contain secrets — treat the path accordingly). |

### Advisor

`setAdvisorEnabled(enabled)`, `toggleAdvisorEnabled()`, `applyAdvisorConfigs(advisors, sharedInstructions)`, `setAdvisorContextPrompt(prompt)`, `isAdvisorEnabled()`, `isAdvisorActive()`, `getAdvisorAvailableToolNames()`, `getAdvisorAgent()`, `getAdvisorStatusOverview()`, `getAdvisorCost()`, `getAdvisorStats()`, `formatAdvisorStatus()`, `formatAdvisorHistoryAsText({ compact? })`.

### IRC & side channels

| Method | Description |
| --- | --- |
| `drainPendingIrcInboxMessages(agentId, opts?)` | Consume pending IRC records before automatic injection. |
| `deliverIrcMessage(msg, { expectsReply? })` | Deliver an IRC message into this session (`"injected"` \| `"woken"`). |
| `setIrcWakeTurnObserver(observer)` | Install task-executor monitoring around autonomous IRC wake turns. |
| `emitIrcRelayObservation(record)` | Emit an IRC relay observation for UI rendering without persisting. |
| `runEphemeralTurn({ promptText, onTextDelta?, signal?, dedupeReply? })` | One-shot side-channel turn against the session's model + system prompt + history; does not modify history or state (used by `/btw`, `/omfg`). |
| `getAgentId()` | Registry id for IRC routing. |

### Async work

`getAsyncJobSnapshot({ recentLimit? })`, `hasPendingAsyncWork()`, `settleAsyncWork()` — owner-scoped async job view and settle loops used by the task executor's quiescence barrier.

### Events & subscriptions

| Method | Description |
| --- | --- |
| `subscribe(listener: AgentSessionEventListener): () => void` | Subscribe to `AgentSessionEvent`s. Session persistence is handled internally. Returns the unsubscribe function. Delivery is synchronous except `agent_end`, deferred while in-flight prompts remain. |
| `registerSessionChangeCallback(cb)` | Cleanup that runs when the session adopts a different session ID. |
| `subscribeCommandMetadataChanged(listener)` | Command metadata changes (slash commands, MCP prompts). |
| `emitNotice(level, message, source?)` | Emit a UI-only notice (never reaches the LLM). |
| `hasExtensionHandlers(eventType)` | Whether extensions have handlers for an event type. |
| `runAutolearnCapture(capture)` | Run one abortable auto-learn capture outside the primary loop. |

## Event reference

`AgentSessionEvent` = the core `AgentEvent` union (below) with `agent_end` extended by `isTerminal?: boolean` ("false when an async delivery will resume the session before its true final settle"; absent = terminal for older runtimes), plus session-level events. Subscribers that use `agent_end` as a completion signal MUST wait for `isTerminal !== false`.

Core `AgentEvent` (from `@oh-my-pi/pi-agent-core`, emitted for every run):

```ts
| { type: "agent_start" }
| { type: "agent_end"; messages: AgentMessage[]; telemetry?: AgentRunSummary; coverage?: AgentRunCoverage }
| { type: "turn_start" }
| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
| { type: "message_start"; message: AgentMessage }
| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
| { type: "message_end"; message: AgentMessage }
| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any; intent?: string }
| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError?: boolean }
```

Session-level events:

| Event | Payload |
| --- | --- |
| `auto_compaction_start` | `{ reason: "threshold" \| "overflow" \| "idle" \| "incomplete"; action: "context-full" \| "handoff" \| "shake" \| "snapcompact" }` |
| `auto_compaction_end` | `{ action: …; result: CompactionResult \| undefined; aborted: boolean; willRetry: boolean; errorMessage?: string; skipped?: boolean }` |
| `auto_retry_start` | `{ attempt; maxAttempts; delayMs; errorMessage; errorId? }` |
| `auto_retry_end` | `{ success; attempt; finalError?; recoveredErrors?: RecoveredRetryError[] }` |
| `retry_fallback_applied` | `{ from: string; to: string; role: string }` |
| `retry_fallback_succeeded` | `{ model: string; role: string }` |
| `model_changed` | (no payload) |
| `thinking_level_changed` | `{ thinkingLevel: ThinkingLevel \| undefined; configured?: ConfiguredThinkingLevel; resolved?: Effort }` |
| `ttsr_triggered` | `{ rules: Rule[] }` |
| `todo_reminder` | `{ todos: TodoItem[]; attempt; maxAttempts }` |
| `todo_auto_clear` | (no payload) |
| `irc_message` | `{ message: CustomMessage }` |
| `notice` | `{ level: "info" \| "warning" \| "error"; message: string; source?: string }` |
| `goal_updated` | `{ goal: Goal \| null; state?: GoalModeState }` |

## Prompt lifecycle

`session.prompt(text, options?)` is the primary entry point. Behavior:

1. optional command/template expansion (`/` commands, custom commands, file slash commands, prompt templates)
2. if currently streaming:
   - `streamingBehavior: "steer" | "followUp"` chooses how `prompt()` queues
   - extension `sendUserMessage(content)` defaults to steer when `deliverAs` is omitted
   - queued messages are preserved instead of throwing work away
3. if idle:
   - validates model + API key
   - appends user message
   - starts agent turn

Related APIs:

- `sendUserMessage(content, { deliverAs? })`
- `steer(text, images?)`
- `followUp(text, images?)`
- `sendCustomMessage({ customType, content, ... }, { deliverAs?, triggerTurn? })`
- `abort()`

## `AgentSession` lifecycle and disposal

Call `await session.dispose()` when the embedder is completely done with a session. `dispose()` starts disposal itself and is idempotent: repeated or concurrent calls receive the same teardown promise, so shutdown events and owned resources are not drained twice.

`beginDispose()` is the synchronous admission barrier for wrappers that must await their own teardown before calling `dispose()`. Call it before the wrapper's first `await`; otherwise deferred work can enter the gap. It immediately marks the session disposed, cancels memory startup, title generation, and auto-learn capture, clears queued yield/asides, stops advisor runtime, detaches aside delivery, and rejects new eval executions. Deferred session work checks the disposed state and is dropped or skipped. `beginDispose()` is also idempotent, and the later `dispose()` call remains required to finish asynchronous cleanup.

```ts
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

async function closeEmbeddedSession(
  session: AgentSession,
  closeHostInputAndUi: () => Promise<void>,
): Promise<void> {
  session.beginDispose(); // no new deferred work may enter after this point
  await closeHostInputAndUi();
  await session.dispose();
}
```

During asynchronous disposal, the session records and synchronously flushes its exit diagnostic, emits `session_shutdown` once, stops extension fallback timers, aborts retries, compaction, and the active agent turn, and gives post-prompt and auto-learn work bounded time to settle. It then tears down session-owned async jobs, eval kernels, browser tabs, native computer sessions, MCP connections, advisor state, and memory state concurrently. These subsystem drains are best-effort and bounded where applicable; failures are logged rather than preventing the remaining subsystem cleanup.

Only after work capable of appending session entries has settled does disposal clean up an empty moved session, close the `SessionManager`, close provider session state, disconnect the agent, and remove listeners. A failure from the final persistence cleanup or `SessionManager.close()` rejects the shared disposal promise; individual provider-session close failures are logged.


## Session management

`AgentSession` always uses a `SessionManager`; behavior depends on which factory you use.

### File-backed (default)

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

console.log(session.sessionFile); // absolute .jsonl path
```

- Persists conversation/messages/state deltas to session files.
- Supports resume/open/list/fork workflows.
- `session.sessionFile` is defined.

### In-memory

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

console.log(session.sessionFile); // undefined
```

- No filesystem persistence.
- Useful for tests, ephemeral workers, request-scoped agents.
- Session methods still work, but persistence-specific behaviors (file resume/fork paths) are naturally limited.

### Resume/open/list helpers

```ts
import { SessionManager } from "@oh-my-pi/pi-coding-agent";

const recent = await SessionManager.continueRecent(process.cwd());
const listed = await SessionManager.list(process.cwd());
const opened = listed[0] ? await SessionManager.open(listed[0].path) : null;
```

### `SessionManager` API surface

Static factories and helpers:

| Member | Description |
| --- | --- |
| `getDefaultSessionDir(cwd, agentDir?, storage?)` | Canonical default session directory for a cwd. |
| `create(cwd, sessionDir?, storage?)` | New persisted session (fresh session id; file materialized lazily until the first assistant message or `ensureOnDisk()`). |
| `createEmptySessionFile(cwd, storage?)` | Create a fresh empty session file at the cwd-derived path (header only). |
| `open(filePath, sessionDir?, storage?, options?)` | Open/resume a specific session file; falls back to `initialCwd ?? getProjectDir()` when the recorded cwd is gone. |
| `peekSessionInit(filePath, storage?)` | Lock-free peek for cold subagent revival (cwd + `session_init` contract without taking the single-writer lock). |
| `continueRecent(cwd, sessionDir?, storage?)` | Continue the most recent session (terminal-breadcrumb aware) or create a new one. |
| `forkFrom(sourcePath, cwd, sessionDir?, storage?, options?)` | Fork history from another session file into a fresh one (`parentSession` header + inherited prompt-cache key). |
| `inMemory(cwd?, storage?)` | In-memory manager (`sessionFile` stays `undefined`). |
| `list(cwd, sessionDir?, storage?)` / `listAll(storage?)` | List sessions (newest first) / across all project directories. |

The journal is an append-only JSONL file: a mutable title slot, a session header, then entries forming a tree by `(id, parentId)` with a movable leaf pointer. Instance surface (public members): blob storage (`putBlob`/`putBlobSync`), `captureState`/`restoreState`/`cloneCurrentSession`, `setSessionFile`, `newSession`, `dropSession`, `fork`, `moveTo`, `ensureOnDisk`, `persistCopy`, `appendEntriesAtomically`, `flush`/`flushSync`, `close`, cwd/additional-directories accessors, usage statistics + turn budgets, artifacts (`getArtifactsDir`, `saveArtifact`, `getArtifactPath`, `allocateArtifactPath`), drafts (`saveDraft`/`consumeDraft`), title management (`setSessionName`/`onSessionNameChanged`/`titleSource`), entry append helpers (`appendMessage`, `appendMessageToBranch`, `appendModelChange`, `appendThinkingLevelChange`, `appendServiceTierChange`, `appendCompaction`, `appendCustomEntry`, `appendCustomMessageEntry`, `appendSessionInit`, `appendResetBoundary`, `appendTtsrInjection`, `appendCredentialPin`, `appendLabelChange`, `appendModeChange`), navigation (`getLeafId`, `getLeafEntry`, `getEntry`, `getChildren`, `getLabel`, `getBranch`, `getTree`, `branch`, `branchWithSummary`, `resetLeaf`, `createBranchedSession`), context building (`buildSessionContext`), replication (`ingestReplicatedEntry`, `snapshotForReplication`), and `onEntryAppended`.

`SessionStorage` is the backend contract (sync/async file ops, atomic writes with a `commitGuard`, writers with `append`/`flush`/`close`); implementations: `FileSessionStorage` (real FS, temp-file + rename), `MemorySessionStorage`, `IndexedSessionStorage` (metadata index + queued publishes), `SqlSessionStorage` (`bun:sql`; postgres/mysql/sqlite), `RedisSessionStorage` (STRING keys + sibling HASH, Lua scripts).

Session entries (`SessionEntry`) include: `message`, `thinking_level_change`, `model_change`, `service_tier_change`, `compaction`, `branch_summary`, `custom` (not in LLM context), `custom_message` (in LLM context), `label`, `title_change`, `ttsr_injection`, `session_init`, `mode_change`, `credential_pin`, `reset_boundary`. `SessionHeader` carries `id`, `cwd`, `additionalDirectories`, `parentSession`, `previousSessionFiles`, `providerPromptCacheKey`.

## Configuration

### `Settings`

`Settings` is the layered configuration store: global `config.yml` → project capability settings + `.omp/config.yml` → CLI config overlays → runtime overrides, with 100 ms-debounced atomic persistence and legacy migrations. All paths are typed against the `SETTINGS_SCHEMA` const (`SettingPath`/`SettingValue`).

| Member | Description |
| --- | --- |
| `Settings.init(options)` | Initialize the global singleton (idempotent; `SettingsOptions`: `cwd`, `agentDir`, `inMemory`, `readOnly`, `overrides`, `configFiles`). |
| `Settings.loadReadOnly(options)` | Load effective settings without opening storage or writing migrations. |
| `Settings.loadIsolated(options)` | Persisted instance without touching the singleton. |
| `Settings.isolated(overrides)` | Synchronous in-memory instance for tests. |
| `Settings.instance` | The global singleton (throws before `init`). |
| `get(path)` / `set(path, value)` / `override(path, value)` / `clearOverride(path)` / `isConfigured(path)` | Typed path access; `set` persists to the global layer, `override` is runtime-only. |
| `getGroup(prefix)` | All settings in a group (`compaction`, `retry`, `lsp`, `todo`, `task`, `memory`, `bash`, `ttsr`, `skills`, `commit`, `statusLine`, `thinkingBudgets`, `stt`, …) with full type safety. |
| `getShellConfig()` / `getEditVariantForModel(model)` / `getBashInterceptorRules()` | Typed accessors for complex settings. |
| `flush()` / `cancelPendingSaves()` | Persistence control. |
| `cloneForCwd(cwd)` / `reloadForCwd(cwd)` | Re-scope to a working directory. |
| Model-role methods | `setModelRole`, `getModelRole`, `getGlobalModelRole`, `getProjectModelRole`, `getModelRoleProvenance`, `getModelRoleSource`, `getModelRoles`, `setProjectModelRole`, `clearProjectModelRole`, `overrideModelRoles`, `isProjectModelRoleRuntimeOverrideActive`. |
| `getStorage()` / `getCwd()` / `getAgentDir()` / `getPlansDirectory()` | Accessors. |

Change notification: `onAppendOnlyModeChanged`, `onModelRolesChanged`, `onStatusLineSessionAccentChanged`, `onHindsightScopeChanged` (each returns an unsubscribe). `settings` is the global singleton proxy.

Key schema groups (defaults): `compaction.*` (enabled `true`, strategy `"snapcompact"`, keepRecentTokens 20000, autoContinue `true`, …), `retry.*` (enabled `true`, maxRetries 10, baseDelayMs 500, usageReservePolicy `"confirm"`, …), `lsp.*` (enabled `true`, lazy `true`, shared `true`, formatOnWrite `false`, diagnosticsOnWrite `true`), `todo.*`, `task.*` (isolation.mode, batch `true`, maxConcurrency 32, maxRecursionDepth 2, agentIdleTtlMs 420000, …), `memory.*` (backend `"off"`), `bash.*` (autoBackground, direnv), `ttsr.*`, plus top-level `theme.dark`/`theme.light`, `defaultThinkingLevel` (`"high"`), `steeringMode`/`followUpMode`/`interruptMode`, `tier.*` (openai/anthropic/google, `"none"` default; `tier.subagent` `"inherit"`), `enabledModels`, `disabledProviders`, `modelRoles`, `inlineToolDescriptors` (`"auto"`), `snapcompact.*`, `collab.relayUrl`, `share.*`, `stt.*`, `statusLine.*`.

### `KeybindingsManager`

`KeybindingsManager` (extends the TUI manager) manages `app.*` + TUI bindings; factories `create(agentDir, options?)` (loads `keybindings.yml`, migrates legacy `keybindings.json`) and `inMemory(userBindings)`. `KEYBINDINGS` defines the defaults (`app.interrupt` escape, `app.model.cycleForward` ctrl+p, `app.message.followUp` ctrl+q/ctrl+enter, `app.editor.external` ctrl+g, …). `formatKeyHint(s)`/`formatKeyHints(keys)` render display strings.

## Models & auth

### `ModelRegistry`

`ModelRegistry` loads and manages models (bundled + `models.yml` custom/overrides + runtime extension providers), resolves API keys via `AuthStorage`, and drives the SQLite model cache.

| Member | Description |
| --- | --- |
| `constructor(authStorage, modelsPath?, options?)` | Sync constructor; eagerly loads config, cache metadata, custom models. |
| `refresh(strategy?)` / `refreshInBackground(strategy?)` / `awaitBackgroundRefresh()` | Reload models (+ dynamic discovery). |
| `refreshProvider(providerId, strategy?)` | Scoped refresh for one provider. |
| `refreshSelectedModelMetadata(model)` | Patch dynamic metadata (llama.cpp discoverable providers). |
| `refreshRuntimeProviders(strategy?)` | Discover models for runtime-registered (`fetchDynamicModels`) providers. |
| `getAll()` / `getAvailable()` | All models / only models with auth configured (fast, no OAuth refresh). |
| `find(provider, modelId)` | Model lookup (case-insensitive, alias/dated variants, Bedrock ARNs). |
| `hasProvider(providerId)` / `hasConfiguredAuth(model)` / `hasCommandBackedApiKey(provider)` | Availability checks (side-effect-free; command keys counted by presence). |
| `getDiscoverableProviders()` / `getProviderDiscoveryState(provider)` | Discovery status. |
| `getApiKey(model, sessionId?, options?)` / `getApiKeyForProvider(provider, sessionId?, options?)` / `getApiKeyAndHeaders(model)` | API-key resolution (command-backed keys cached 30 s; keyless → `kNoAuth`). |
| `resolver(providerOrModel, ...)` | `ApiKeyResolver` implementing the central a/b/c auth-retry policy. |
| `isUsingOAuth(model)` | Whether a model uses OAuth credentials. |
| `registerProvider(name, config, sourceId?)` | Dynamically register a provider (from extensions): models replace-all, baseUrl/headers override, `streamSimple` custom API, OAuth provider, `fetchDynamicModels` (hard 15 s timeout). |
| `clearSourceRegistrations(sourceId)` / `syncExtensionSources(activeSourceIds)` | Extension-source registration lifecycle. |
| `suppressSelector(selector, untilMs)` / `isSelectorSuppressed(selector)` / `clearSuppressedSelector(s)` | Rate-limit cooldown suppression. |

Constants: `kNoAuth = "N/A"`, `isAuthenticated(key)` (`Boolean(key) && key !== kNoAuth`).

### `AuthStorage`

`AuthStorage` (from `@oh-my-pi/pi-ai`, re-exported by the package root) manages credentials: API keys and OAuth tokens with round-robin selection, usage-limit tracking, and OAuth refresh. Backed by an `AuthCredentialStore` (`SqliteAuthCredentialStore` default, or a remote broker store).

`AuthStorage.getApiKey(...)` resolves in this order:

1. runtime override (`setRuntimeApiKey`, used by CLI `--api-key`)
2. config-sourced API key override (`models.yml` provider `apiKey`)
3. stored OAuth credential, including refresh when needed
4. API key persisted by a successful `/login`
5. provider environment variables
6. other stored API-key credential in `agent.db` / broker-backed storage
7. custom-provider resolver fallback

Key surface: `create(dbPath, options?)`, `close()`, `reload()`, `get`/`set`/`remove`/`list`/`has`/`hasAuth`/`hasNonEnvCredential`, `setRuntimeApiKey`/`removeRuntimeApiKey`, `setConfigApiKey`/`clearConfigApiKeys`, `setFallbackResolver`, `login(provider, ctrl)`/`logout`, `getApiKey`, `getOAuthAccess`/`getOAuthAccessAt`/`getOAuthAccessByCredentialId`/`getOAuthAccesses`/`listOAuthAccounts`/`pinSessionOAuthAccount`, `refreshStoredOAuthCredential`/`refreshCredentialById`/`forceRefreshCredentialById`, `markUsageLimitReached`/`getModelUsageHealth`/`fetchUsageReports`/`checkCredentials`, `rotateSessionCredential`, `invalidateCredentialMatching`, `resolver(provider, options?)`, `exportSnapshot`, `listDisabledCredentials`, `revalidateCredentials`, `describeCredentialSource`/`getCredentialOrigin`, `onCredentialDisabled`/`onGenerationChanged`, Codex reset credits (`listResetCredits`/`redeemResetCredit`), usage recording (`recordUsageCost`, `recordObservedUsage`, `recordClientUsage`, `listUsageHistory`).

`discoverAuthStorage(agentDir?)` (from the SDK) uses the local SQLite store at `<agentDir>/agent.db`, or broker mode when `OMP_AUTH_BROKER_URL` is set: credentials are pulled from a remote auth-broker over the wire, refresh tokens never leave the broker (the client receives `refresh = "__remote__"` and calls back to re-mint access tokens).

### Model resolution pipeline

`config/model-resolver.ts` layers selector grammar over a single matching engine:

- `parseModelString("provider/id[:level]")` / `formatModelString(model)` / `formatModelSelectorValue(selector, thinkingLevel)` — canonical string round-trips.
- `parseModelPattern(pattern, availableModels, preferences, options?)` — full selector matching: exact → literal id → strip `:level` → fuzzy → `@upstream` routing fallback; returns `{ model, thinkingLevel?, upstream?, warning, explicitThinkingLevel }`.
- `splitUpstreamRouting(pattern)` — trailing `@<provider>` routing selectors.
- `resolveConfiguredModelPatterns(value, settings?)` — role-alias expansion through the priority chain (`MODEL_PRIO`), `smol`/`slow`/`designer` inherit the configured `default` role's patterns.
- `resolveModelRoleValue(roleValue, availableModels, options?)` — role → `ResolvedModelRoleValue`.
- `resolveAllowedModels(modelRegistry, settings?, preferences?)` — `getAvailable()` further restricted by `enabledModels` (empty result = no usable model, never falls back).
- `resolveCliModel(...)` — CLI flags with provider/auth precedence; error strings (`Unknown provider "..."`, `Model "..." not found…`).
- `findInitialModel(...)` — priority: CLI args → scoped models → session restore → settings default → first available with a valid key.
- `pickDefaultAvailableModel(availableModels)` — first provider-default model in availability order (canonical provider priority for shared default ids).
- `getModelMatchPreferences(settings?)` — usage/provider ordering.
- `findSmolModel` / `findSlowModel` — priority-chain lookups for the `smol`/`slow` roles.
- `DEFAULT_PREWALK_TARGET = "@smol"`; `resolveAgentPrewalkPattern(...)` for subagents.

## Discovery helpers

Use these when you want partial control without recreating internal discovery logic:

| Helper | Signature | Semantics |
| --- | --- | --- |
| `discoverAuthStorage` | `(agentDir?) => Promise<AuthStorage>` | Local SQLite or broker-backed store. |
| `discoverExtensions` | `(cwd?) => Promise<LoadExtensionsResult>` | Discover + load extensions from standard locations. |
| `discoverSessionExtensionPaths` | `(options, cwd, settings) => Promise<string[]>` | Path-only FS scan (subagents reuse the parent's paths). |
| `loadSessionExtensions` | `(options, cwd, settings, eventBus) => Promise<LoadExtensionsResult>` | The session's extension load (CLI pre-loads and passes back via `preloadedExtensions`). |
| `loadCliExtensionProviders` | `(modelRegistry, settings, cwd, options?) => Promise<void>` | Load extensions and register their providers into a bare registry (one-shot CLIs). |
| `discoverSkills` | `(cwd?, _agentDir?, settings?) => Promise<{ skills; warnings }>` | Skills from all configured locations. |
| `discoverContextFiles` | `(cwd?, _agentDir?, disabledExtensions?) => Promise<Array<{ path; content; depth? }>>` | `AGENTS.md` content walking up from cwd (farther files first). |
| `discoverPromptTemplates` | `(cwd?, agentDir?) => Promise<PromptTemplate[]>` | `cwd/.omp/prompts/` + `agentDir/prompts/`. |
| `discoverSlashCommands` | `(cwd?) => Promise<FileSlashCommand[]>` | File-based slash commands from `commands/` directories. |
| `discoverCustomTSCommands` | `(cwd?, agentDir?) => Promise<CustomCommandsLoadResult>` | TypeScript slash commands. |
| `discoverMCPServers` | `(cwd?) => Promise<MCPToolsLoadResult>` | MCP tools from `.mcp.json` files (manager + tools + errors). |
| `buildSystemPrompt` | `(options?: BuildSystemPromptOptions) => Promise<BuildSystemPromptResult>` | Default provider-facing system prompt blocks (stable harness prompt + dynamic project context as separate entries). |

`BuildSystemPromptOptions`: `{ tools?: Tool[]; skills?: Skill[]; contextFiles?: Array<{ path; content }>; cwd?: string; customPrompt?: string; appendPrompt?: string; inlineToolDescriptors?: boolean; includeWorkspaceTree?: boolean; securityEnabled?: boolean }`.

`BuildSystemPromptResult`: `{ systemPrompt: string[]; xdevCatalogNames?: readonly string[] }` (see the `system-prompt` section below for the full builder).


## Tools

### Built-ins and filtering

- Built-ins come from `createTools(...)` and `BUILTIN_TOOLS`.
- `toolNames` requests named tools and can enable tools that are disabled by
  default; by itself it is **not** an allowlist.
- Set `restrictToolNames: true` to limit the session to the names in
  `toolNames`. Restricted sessions disable ambient MCP, extensions, custom
  commands, and LSP by default.
- In a restricted session, SDK-supplied `customTools` are excluded unless
  `allowRestrictedCustomTools: true` and their names also appear in
  `toolNames`.
- Hidden tools (for example `yield`) are opt-in unless required by options.

```ts
const { session } = await createAgentSession({
  toolNames: ["read", "grep", "glob", "write"],
  restrictToolNames: true,
  requireYieldTool: true,
});
```

### `BUILTIN_TOOLS` and `HIDDEN_TOOLS`

`BUILTIN_TOOLS` maps every built-in name to a `ToolFactory` (`(session: ToolSession) => Tool | null | Promise<Tool | null>`); external callers may invoke `BUILTIN_TOOLS.read(session)` directly. Exact names (29):

`read`, `bash`, `edit`, `ast_grep`, `ast_edit`, `ask`, `debug`, `eval`, `github`, `glob`, `grep`, `lsp`, `inspect_image`, `browser`, `computer`, `checkpoint`, `rewind`, `security_scan`, `task`, `hub`, `todo`, `web_search`, `write`, `memory_edit`, `retain`, `recall`, `reflect`, `learn`, `manage_skill`.

`HIDDEN_TOOLS` (2): `yield`, `goal` — constructible and `--tools`-addressable but never part of the default active set.

`createTools(session, toolNames?)` constructs the set: normalizes/gates names against settings (`bash.enabled`, `lsp.enabled`, `memory.backend`, `checkpoint.enabled`, `autolearn.enabled`, `task.maxRecursionDepth`, …), auto-includes paired tools (`checkpoint`↔`rewind`, `ast_grep` with `grep`, memory tools per backend, `goal` in goal mode), probes eval-kernel availability, wraps every tool with `wrapToolWithMetaNotice`, populates `session.toolRegistry`, and mounts discoverable tools under `xd://` when `tools.xdev` is enabled.

### `Tool` / `ToolSession`

`Tool` = `AgentTool<TParameters, TDetails, TTheme>` from `@oh-my-pi/pi-agent-core` (extends `Tool` from `@oh-my-pi/pi-ai`): `name`, `label`, `description`, `parameters` (arktype/omptype schema), `strict?`, `hidden?`, `deferrable?`, `loadMode` (`"essential"` | `"discoverable"`), `summary?`, `concurrency?` (`"shared"`/`"exclusive"`/fn), `lenientArgValidation?`, `interruptible?`, `intent?` (`"omit"`/`"optional"`/`"require"`/fn — controls the `i` intent field), `matcher*` stream-matcher hooks, `approval` (`ToolTier` = `"read" | "write" | "exec"`, object form with `reason`/`override`/`policy`, or fn; omitted = `"exec"`), `formatApprovalDetails?`, `execute(toolCallId, params, signal?, onUpdate?, context?)`, `renderCall?`/`renderResult?`.

`ToolSession` is the per-session context handed to tool factories (~96 members): required `cwd`, `getSessionFile`, `getSessionSpawns`, `settings`; plus `hasUI`, `eventBus`, `authStorage`, `modelRegistry`, `mcpManager`, `asyncJobManager`, `agentRegistry`, `skills`/`rules`/`contextFiles`/`workspaceTree`/`promptTemplates`, `extensionPaths`/`customToolPaths`, `outputSchema`/`outputSchemaMode`, `taskDepth`, `restrictToolNames`, `enableLsp`/`lspReadOnly`/`enableMCP`/`enableIrc`, `getEvalSessionId`, `getSessionId`, `getAgentId`, `getActiveModel`, `getActiveModelString`, `getModelString`, `getServiceTierByFamily`, `getClientBridge`, `getTodoPhases`/`setTodoPhases`, `toolRegistry`, `xdev`, `getArtifactsDir`, `allocateOutputArtifact`, `getTelemetry`, `queueDeferredMessage`, `queueDeferredDiagnostics`, `queueLaunchCompletion`, `registerDisposeCallback`, `registerSessionChangeCallback`, `getFileSnapshotStore`-family lazies (`fileSnapshotStore`, `editClipboard`, `conflictHistory`, `diagnosticsLedger`, `noopLoopGuard`), plan/goal/checkpoint accessors, `steer`, tool-choice queue (`getToolChoiceQueue`, `buildToolChoice`, `peekQueueInvoker`, `peekPendingInvoker`, `clearPendingInvokers`, plan-proposal handlers), `getImageAttachments`, and `getClientBridge`.

### Tool classes

Each built-in is a class taking `(session: ToolSession)` (constructors per `src/tools/*`):

| Class | Notes |
| --- | --- |
| `BashTool` | `concurrency` = pty → exclusive else shared; schema picks `bashSchemaWithAsync` when `async.enabled`; reads `bash.autoBackground.*`. |
| `ReadTool` | `approval` = `"exec"` for ssh paths else `"read"`; memory-backend-aware schema; reads `images.autoResize`, `read.defaultLimit` (clamped). |
| `EditTool` | `(session, mode?: EditMode)`; `EditMode = "replace" \| "patch" \| "hashline" \| "apply_patch"` (default `hashline`); pins the edit variant for protocol-bound callers (Cursor `pi_edit`); env `PI_EDIT_FUZZY`/`PI_EDIT_VARIANT`. |
| `WriteTool` | elaborate approval ladder (hashline tags, `xd://` device tiers, ssh → `"exec"`, internal URLs by scheme write hook); LSP writethrough (`lsp.formatOnWrite`, `lsp.diagnosticsOnWrite`). |
| `GrepTool` | `(session, options?: GrepToolOptions)` with `context`/`totalMatchLimit` clamps; `loadMode: "discoverable"`. |
| `GlobTool` | `(session, options?: GlobToolOptions)` with pluggable `GlobOperations` (SSH delegation); `rootPathAlias` remaps `/`-only paths to cwd. |
| `EvalTool` | `(session \| null, options?: EvalToolOptions)` with `EvalProxyExecutor` delegation (wire bridges). |
| `WebSearchTool` | `web_search` (approval `"read"`, `loadMode: "discoverable"`); `webSearchCustomTool` for TUI rendering; `getSearchTools()`. |

### Custom tools

`CustomTool` is the extension-facing definition (loaded from `.omp/tools/`, `.claude/tools/`, plugins): `name`, `label`, `description`, `parameters` (arktype/omptype/typebox/zod), `strict?`, `hidden?`, `loadMode?` (custom tools default `"discoverable"`), `deferrable?`, `mcpServerName?`/`mcpToolName?`, `approval?`, `execute(toolCallId, params, onUpdate, ctx: CustomToolContext, signal?)`, `onSession?(event, ctx)`, `renderCall?`/`renderResult?`.

`CustomToolFactory = (pi: CustomToolAPI) => CustomTool | CustomTool[] | Promise<...>`; `CustomToolAPI` provides `cwd`, `exec(command, args, options?)`, `ui` (select/confirm/input/notify/custom), `hasUI`, `logger`, `typebox`, `arktype`, `zod`, `pi` (the injected `pi-coding-agent` exports), `pushPendingAction(action)` (staged previews resolved via the hidden `resolve` tool).

`CustomToolContext`: `sessionManager` (read-only), `modelRegistry`, `model`, `isIdle()`, `hasQueuedMessages()`, `abort()`, `settings?`, `fetch?`, `localProtocolOptions?`, `autoApprove?`.

`CustomToolSessionEvent` (onSession reasons): `start`/`switch`/`branch`/`tree`/`shutdown` (+ `previousSessionFile`), `auto_compaction_start`/`end`, `auto_retry_start`/`end`, `ttsr_triggered`, `todo_reminder`.

Loading: `discoverCustomToolPaths(configuredPaths, cwd)` → `loadCustomTools(paths, cwd, builtInToolNames, pushPendingAction?)` (wraps via `CustomToolAdapter`); `discoverAndLoadCustomTools` composes both. `preloadedCustomToolPaths` skips the scan for subagents.

### Runtime tool set changes

`AgentSession` supports runtime activation updates:

- `getActiveToolNames()`
- `getAllToolNames()`
- `setActiveToolsByName(names)`
- `refreshMCPTools(mcpTools)`

System prompt is rebuilt to reflect active tool changes.

## Extensions

Extensions are TypeScript modules (or inline factories) that subscribe to lifecycle events, register tools/commands/shortcuts/CLI flags, and interact with the user via UI primitives.

| Type | Description |
| --- | --- |
| `ExtensionFactory` | `(pi: ExtensionAPI) => void \| Promise<void>` — the module's default export factory. |
| `ExtensionAPI` | Runtime API: `logger`, `typebox`, `arktype`, `zod`, `pi`; `on(event, handler)` for 43 event names (see below); `registerTool(tool: ToolDefinition)`; `registerCommand(name, options)`; `registerShortcut(shortcut, options)`; `registerFlag(name, options)`; `setLabel(...)`; `getFlag(name)`; `registerMessageRenderer(customType, renderer)`; `registerAssistantThinkingRenderer(renderer)`; `sendMessage(...)` / `sendUserMessage(...)` / `appendEntry(...)`; `exec(command, args, options?)`; `getActiveTools()` / `getAllTools()` / `setActiveTools(names)`; `getCommands()`; `setModel(model)` / `getThinkingLevel()` / `setThinkingLevel(level)` / `getServiceTiers()` / `setServiceTier(family, tier)`; `getSessionName()` / `setSessionName(name)`; `registerProvider(name, config)`; `events` (shared `EventBus`). |
| `ExtensionContext` | Handler context: `ui` (`ExtensionUIContext`), `getContextUsage()`, `getAsyncJobSnapshot()`, `compact(...)`, `hasUI`, `cwd`, `sessionManager` (read-only), `modelRegistry`, `localProtocolOptions?`, `model`, `models` (list/current/resolve/family query), `isIdle()`, `abort()`, `hasPendingMessages()`, `shutdown()`, `getSystemPrompt()`, `memory?`, `setInterval`/`setTimeout`/`clearTimer` (auto-cleared on shutdown), `invokeTool?(params, options?)` (delegate to the same-name native built-in). |
| `ExtensionCommandContext` | Extends `ExtensionContext` with session control: `waitForIdle()`, `newSession()`, `branch(entryId)`, `navigateTree(targetId)`, `switchSession(path)`, `reload()`, `compact(...)`. |
| `ToolDefinition` | Extension tool definition: `name`, `label`, `description`, `parameters`, `hidden?`, `defaultInactive?`, `loadMode?`, `deferrable?`, `approval?`, `strict?` (`false` is meaningful — preserved on the wire), `mcpServerName?`/`mcpToolName?`, `execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext)`, `onSession?`, `renderCall?`/`renderResult?`. |
| `ExtensionUIContext` | UI surface: `select`, `confirm`, `input`, `askDialog?`, `notify`, `onTerminalInput`, `setStatus`, `setWorkingMessage`, `setWidget`, `setFooter`/`setHeader`, `setTitle`, `custom(factory)`, `setEditorText`/`pasteToEditor`/`getEditorText`, `editor`, `addAutocompleteProvider`, `setEditorComponent`, `theme`, `getAllThemes`/`getTheme`/`setTheme`, `getToolsExpanded`/`setToolsExpanded`. |
| `LoadExtensionsResult` | `{ extensions: Extension[]; errors: Array<{ path; error }>; runtime: ExtensionRuntime }`. |

`ExtensionAPI.on` event names (41): `resources_discover`, `session_start`, `session_before_switch`, `session_switch`, `session_before_branch`, `session_branch`, `session_before_compact`, `session.compacting`, `session_compact`, `session_shutdown`, `session_before_tree`, `session_tree`, `context`, `before_provider_request`, `after_provider_response`, `before_agent_start`, `agent_start`, `agent_end`, `session_stop`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `auto_compaction_start`, `auto_compaction_end`, `auto_retry_start`, `auto_retry_end`, `ttsr_triggered`, `todo_reminder`, `goal_updated`, `credential_disabled`, `input`, `tool_approval_requested`, `tool_approval_resolved`, `tool_call`, `tool_result`, `user_bash`, `user_python`, `mcp_notification`.

Loading: `discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds?, options?)` (native extension capabilities → hook factories → installed plugin tree → configured paths) → `loadExtensions(paths, cwd, eventBus?)` (per-path failures captured, not thrown); `loadExtensionFromFactory(factory, cwd, eventBus, runtime, name?)` for inline factories. `ExtensionRunner` dispatches events with 30 s per-handler timeouts (2 s for `session_shutdown`), runs `tool_call` fail-closed (timeout/throw → `{ block: true }`), merges `tool_result` overrides, and wires `ctx.invokeTool` delegation. `ExtensionToolWrapper` wraps every tool with `tool_call`/`tool_result` interception + the full approval gate (`resolveApproval`, provider safety checks, `tool_approval_requested`/`tool_approval_resolved` events).

Extension options on `createAgentSession`:

- `extensions` — inline `ExtensionFactory[]`
- `additionalExtensionPaths` — load extra extension files
- `disableExtensionDiscovery` — disable automatic scanning; explicit paths and
  inline factories still load
- `preloadedExtensions` — reuse an extension set loaded early by the same
  session-owning process. Never pass loaded extension instances from a parent
  to another session; use `preloadedExtensionPaths` so each session gets its
  own `ExtensionAPI` binding.

## Skills

`Skill`: `{ name, description, filePath, baseDir, source, hide?, _source? }`. `loadSkills(options)` discovers from all configured locations (Claude/Codex/pi/agents user+project dirs, custom directories, managed auto-learn skills last); `setActiveSkills`/`getActiveSkills` maintain the process-global snapshot used by `skill://`; `parseSkillInvocation(text)`/`buildSkillPromptMessage(skill, args, invocation)` implement `/skill:<name>` expansion (`invocation: "user" | "autoload"`).

## Slash commands, custom commands, prompt templates

- `FileSlashCommand`: `{ name, description, content, source, _source? }`; `loadSlashCommands({ cwd? })` loads from capability providers (builtin/user/project) + embedded templates; `expandSlashCommand(text, fileCommands)` expands `/<name>` with `{{args}}`/`{{ARGUMENTS}}` rendering.
- `CustomCommand` (TypeScript commands): `{ name, description, execute(args, ctx) => string \| void }` — return a string to send as a prompt, or void for fire-and-forget. `loadCustomCommands({ cwd?, agentDir? })` loads bundled `green`/`review` plus user/project modules (user/project override bundled same-name commands). `CustomCommandFactory = (api: CustomCommandAPI) => CustomCommand | CustomCommand[] | Promise<...>`.
- `PromptTemplate`: `{ name, description, content, source }`; `loadPromptTemplates({ cwd?, agentDir? })` scans `agentDir/prompts/` + `cwd/.omp/prompts/`; `expandPromptTemplate(text, templates)` expands `/name` with argument rendering and inline-args fallback.

## MCP

MCP is enabled by default (`enableMCP: true`). Discovery reads `.mcp.json` from user and project locations (capability system); Exa servers are folded into native Exa integration and browser-automation servers are filtered when the built-in browser tool is enabled.

| Type | Description |
| --- | --- |
| `MCPManager` | Server manager: `discoverAndConnect(options?)`, `connectServers(configs, sources, onStatus?)` (parallel, 250 ms startup gate), `getTools()`, `getConnection(name)`, `getConnectionStatus(name)`, `waitForConnection(name)`, `prepareConfig(config, { oauth? })`, `disconnectServer(name)`, `disconnectAll()`, `reconnectServer(name, options?)` (crash-burst circuit breaker, `[500, 1000, 2000, 4000]` ms backoff), `refreshServerTools`/`refreshAllTools`, `refreshServerResources`/`ensureServerResources`/`readServerResource`, `refreshServerPrompts`/`executePrompt`, `getServerInstructions()`, `getServerConfig(name)`, `getConnectedServers()`, `getAllServerNames()`, `setAuthStorage`/`setAuthHandler`, `addNotificationListener` (bounded FIFO buffer for pre-listener notifications), `setOnToolsChanged`/`setOnResourcesChanged`/`setOnPromptsChanged`, `setNotificationsEnabled`, `getNotificationState()`. Process-global `instance()`/`setInstance()`; `createMCPManager(cwd, options?)` convenience. |
| `MCPServerConfig` | `MCPStdioServerConfig` (`command`, `args?`, `env?`, `cwd?`, `timeout?` 30000, `auth?`, `oauth?`) \| `MCPHttpServerConfig` (`url`, `headers?`) \| `MCPSseServerConfig` (deprecated, use HTTP). |
| `MCPToolDetails` | Tool-result details: `serverName`, `mcpToolName`, `isError?`, `rawContent?`, `mcpMeta?`, `provider?`, `providerName?`, `meta?`. |
| `MCPTool` / `DeferredMCPTool` | `CustomTool` wrappers over live/deferred connections; `createMCPToolName(serverName, toolName)` mints `mcp__<server>_<tool>` names; `parseMCPToolName(name)` parses them back; `deduplicateMCPToolsByName(tools)` keeps one tool per minted name by stable origin key. |
| `MCPToolsLoadResult` | `{ manager, tools, errors, connectedServers, exaApiKeys }`; `discoverAndLoadMCPTools(cwd, options?)`. |
| `MCPToolCache` | Tool definitions per server in `agent.db` (30-day TTL, config-hash validated) for fast startup. |
| Events | `MCP_CONNECTION_STATUS_EVENT_CHANNEL = "mcp:connection-status"` with `McpConnectionStatusEvent` (`connecting`/`connected`/`failed`); `mcp_notification` extension events for server notifications. |
| Transports | `createHttpTransport(config)` / `createStdioTransport(config)` (+ SSE deep-subpath), `MCPTransport` interface, `MCPRequestOptions`. |

## LSP

`enableLsp: true` by default. The LSP integration provides the `lsp` tool, edit/write format + diagnostics writethrough, and startup warmup.

| Surface | Description |
| --- | --- |
| `getOrCreateClient(config, cwd, initTimeoutMs?, signal?)` | Get/create an LSP client (keyed `${command}:${cwd}`; fail-fast on recent init failure; broker-shared servers when enabled). |
| `setSharedLspEnabled(enabled)` | Broker-shared servers (off by default; the SDK turns it on from the `lsp.shared` setting). |
| `setIdleTimeout(ms)` / `shutdownClient(key)` / `shutdownClientInstance(client)` / `shutdownAll()` | Client lifecycle. |
| `discoverStartupLspServers(cwd, status?)` / `warmupLspServers(cwd, options?)` | Startup detection + warmup (`WARMUP_TIMEOUT_MS` 5 s). |
| `LspStartupServerInfo` | `{ name, status: "connecting" \| "ready" \| "error" \| "available"; fileTypes: string[]; error? }` — the shape of `CreateAgentSessionResult.lspServers`. |
| `LSP_STARTUP_EVENT_CHANNEL = "lsp:startup"` / `LspStartupEvent` | `{ type: "completed"; servers } \| { type: "failed"; error }`. |
| `createLspWritethrough(cwd, options?)` / `flushLspWritethroughBatch(id, cwd, signal?)` | Writethrough callbacks for write operations (format + diagnostics). |
| `getLspStatus()` | Status of active clients. |
| `LspTool` | The `lsp` tool (`approval` = `"read"` for `LSP_READONLY_ACTIONS` — diagnostics/definition/type_definition/implementation/references/hover/symbols/status/capabilities — else `"write"`; `loadMode: "discoverable"`). |

LSP servers are lazy by default (`lsp.lazy: true`): no server launches at startup; each cold-starts on first use. In restricted sessions LSP is off unless `enableLsp` is explicitly set, and `lspReadOnly` defaults to true.


## Agent registry & multi-session embedding

`AgentRegistry` is the process-global registry of agents (the main session plus every subagent), keyed by stable id, tracking status and (when live) the `AgentSession` so peers can be addressed by id (`hub`, `task resume`, `history://`).

- `MAIN_AGENT_ID = "Main"`; `AgentStatus = "running" | "idle" | "parked" | "aborted"`; `AgentKind = "main" | "sub" | "advisor"`.
- `AgentRegistry.global()` is the lazy singleton; `register(input)` defaults `status: "running"`; `registerIfAvailable(input, expected)` is a CAS for revival (`expectedAgentRef`); `setStatus` treats `aborted` as terminal; `attachSession`/`detachSession`/`unregister`; `get(id)`/`list()`/`listVisibleTo(id)`; `onChange(listener)`.
- `AgentRef`: `{ id, displayName, kind, parentId?, status, session, sessionFile, createdAt, lastActivity, activity?, history? }` — `session` is null exactly when parked/aborted.
- `AgentLifecycleManager` owns the idle → parked → revived lifecycle of adopted subagents: `adopt(id, { idleTtlMs, revive? }, expected?)`, `park(id)`, `ensureLive(id)`, `release(id, expected?, { tombstone? })`, `dispose(deadlineAt?)`. A parked ref keeps its `sessionFile` and can be revived on demand; killed agents get a `.tombstone` sidecar so discovery cannot re-adopt them.

Subagent-oriented options on `createAgentSession` (for SDK consumers building orchestrators, similar to the task executor flow):

- `outputSchema`: passes structured output expectation into tool context
- `outputSchemaMode`: selects permissive or strict structured-output enforcement
- `requireYieldTool`: forces `yield` tool inclusion
- `taskDepth`: recursion-depth context for nested task sessions
- `parentTaskPrefix`: artifact naming prefix for nested task outputs
- `parentAgentId` / `agentId` / `agentDisplayName` / `agentRegistry` / `expectedAgentRef`: registry identity and IRC routing
- `parentEvalSessionId`: shared eval state
- `preloadedExtensionPaths` / `preloadedCustomToolPaths`: safe parent → subagent forwarding

These are optional for normal single-agent embedding.

## Event bus & workspace tree

`EventBus` (`src/utils/event-bus.ts`): `on(channel, handler): () => void` (handlers are error-isolated), `emit(channel, data)`, `clear()`. Used for MCP/LSP status channels and extension communication.

Workspace tree (`src/workspace-tree.ts`):

- `buildWorkspaceTree(cwd, { timeoutMs? }): Promise<WorkspaceTree>` — the system-prompt tree: `{ rootPath, rendered, truncated, totalLines, agentsMdFiles }` (fixed defaults maxDepth 3, perDirLimit 12, lineCap 120; `AGENTS_MD_LIMIT` 200).
- `buildDirectoryTree(cwd, options?): Promise<DirectoryTree>` — generic tree for the read tool's directory listing (`{ maxDepth?, perDirLimit?, rootLimit?, lineCap? }`; hidden shown, gitignore ignored, standard non-source dirs pruned).

## Telemetry

Pass `telemetry: AgentTelemetryConfig` to `createAgentSession` (or `{}` to enable the loop's GenAI-semantic-convention spans using the global tracer provider; safe without an OTEL SDK — `@opentelemetry/api` returns a no-op tracer).

`AgentTelemetryConfig` (from `@oh-my-pi/pi-agent-core`): `tracer?`, `tracerName?` (default `"@oh-my-pi/pi-agent-core"`), `captureMessageContent?` (`true`/`"summary"`/`"full"`; env `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`), `attributes?`, `resolveAttributes?(ctx)`, `agent?: AgentIdentity` (`{ id?, name?, description? }`), `conversationId?`, `costEstimator?(input)`, `onCostDelta?(delta)`, `onChatUsage?(event)` (non-fatal), `normalizeProvider?`, `normalizeAgentName?`, `contentSerializer?`, `onSpanStart?`/`onSpanEnd?`, `onRunEnd?(summary, coverage)` (non-fatal), `onTelemetryWarning?`.

The `agent_end` event carries `telemetry?: AgentRunSummary` (chats/tools/usage/cost/errors rollups) and `coverage?: AgentRunCoverage` (available/invoked/unused tools, models, providers). Spans: `invoke_agent`, `chat`, `execute_tool`, `handoff`.

## System prompt building

`buildSystemPrompt` (SDK-level, `src/sdk.ts`) builds the default provider-facing prompt blocks; `src/system-prompt.ts` has the full builder:

- `loadProjectContextFiles({ cwd?, disabledExtensions? })` — capability-discovered `AGENTS.md` files with `@path` includes expanded, sorted by depth (closest last).
- `loadSystemPromptFiles(...)` — project-level `SYSTEM.md` overriding user-level.
- `discoverTitleSystemPromptFile(cwd?)` / `resolvePromptInput(input, description)` — `TITLE_SYSTEM.md` handling.
- `buildSystemPromptToolMetadata` / `projectSystemPromptToolMetadata` — tool descriptor projections (`compact` = label + wireName; `full` = + description/parameters/examples).
- `buildSystemPrompt(options): Promise<BuildSystemPromptResult>` — ~30 inputs: `customPrompt`/`resolvedCustomPrompt`, `appendSystemPrompt`/`resolvedAppendSystemPrompt`, tools/toolNames metadata, `inlineToolDescriptors`, `nativeTools` (default true), `skillsSettings` + skills, rules (rulebook/always-apply), `intentField`, eager tasks, `taskBatch`/`taskMaxConcurrency`/`taskIrcEnabled`, `scoutAvailable`, `secretsEnabled`, `workspaceTree` (value or promise), `memoryRootEnabled`, `securityEnabled`, `model`/`includeModelInPrompt`, `personality`, `includeWorkspaceTree` (default false), `renderMermaid` (default true), `activeRepoContext`, xdev tools/docs, `autoQaEnabled`. Returns `{ systemPrompt: string[]; xdevCatalogNames? }` — stable harness prompt and dynamic project context as separate entries so providers can cache prompt prefixes.

## Subsystems

The SDK composes the whole runtime. High-level groupings:

| Subsystem | Source | Purpose | Key SDK surface | Related docs |
| --- | --- | --- | --- | --- |
| **Session** | `src/session/` | Agent lifecycle facade, append-only `.jsonl` journal, storage backends, message conversion | `AgentSession`, `SessionManager`, `SessionStorage`, `SessionEntry` | [Sessions](/oh-my-pi/features/sessions/) |
| **Configuration** | `src/config/` | Typed settings schema + persistence, model registry/resolvers, prompt templates, service tiers, keybindings | `Settings`, `SETTINGS_SCHEMA`, `ModelRegistry`, `KeybindingsManager` | [Settings](/oh-my-pi/configuration/settings/) |
| **Models & auth** | `packages/ai`, `src/session/auth-broker-config.ts` | Credentials (API keys + OAuth), usage tracking, auth-retry policy | `AuthStorage`, `discoverAuthStorage` | [Providers](/oh-my-pi/models/providers/) |
| **Tools** | `src/tools/`, `src/web/search/`, `src/edit/` | Built-in tool registry, custom tools, tool session context | `createTools`, `BUILTIN_TOOLS`, `Tool`, `ToolSession`, `CustomTool` | [Built-in Tools](/oh-my-pi/features/tools/) |
| **Extensibility** | `src/extensibility/` | Extensions, skills, custom tools, slash/custom commands, hooks, plugins | `ExtensionAPI`, `ExtensionRunner`, `Skill`, `FileSlashCommand`, `CustomCommand` | [Extensions](/oh-my-pi/extending/extensions/), [Skills](/oh-my-pi/extending/skills/), [Custom Tools](/oh-my-pi/extending/custom-tools/), [Hooks](/oh-my-pi/extending/hooks/), [Plugins](/oh-my-pi/extending/plugins/) |
| **MCP** | `src/mcp/` | MCP server management, tool bridging, config, transports | `MCPManager`, `MCPServerConfig`, `MCPTool` | [MCP Servers](/oh-my-pi/extending/mcp/) |
| **LSP** | `src/lsp/` | Language server clients, writethrough, diagnostics, warmup | `getOrCreateClient`, `LspStartupServerInfo` | [Code Intelligence](/oh-my-pi/features/code-intelligence/) |
| **Eval kernels** | `src/eval/` | Python/JS/Ruby/Julia kernel sessions, disposal by owner | `executePython`, `getEvalSessionId`, `disposeAllKernelSessions` | [Code Execution](/oh-my-pi/features/code-execution/) |
| **Memory** | `src/memory-backend/`, `src/mnemopi/`, `src/hindsight/`, `src/autolearn/` | Memory backends (off/local/hindsight/mnemopi), managed skills, auto-learn | `MemoryBackend`, `resolveMemoryBackend`, `MnemopiSessionState`, `HindsightSessionState`, `AutoLearnController` | [Memory](/oh-my-pi/features/memory/) |
| **Multi-agent** | `src/task/`, `src/goals/`, `src/plan-mode/`, `src/registry/` | Subagent spawning/executor, goals, plan mode, registry + lifecycle | `TaskTool`, `AgentRegistry`, `AgentLifecycleManager`, `GoalRuntime` | [Subagents](/oh-my-pi/features/subagents/), [Multi-Agent](/oh-my-pi/guides/multi-agent/) |
| **Modes** | `src/modes/` | Interactive TUI, print, RPC, ACP, queue/loop | `InteractiveMode`, `runPrintMode`, `runRpcMode`, `RpcClient` | [RPC](/oh-my-pi/extending/rpc/), [Editor Integration](/oh-my-pi/features/editor-integration/) |
| **Comms** | `src/ssh/`, `src/irc/`, `src/collab/` | SSH connections/sshfs, IRC routing, collab replication | `closeAllConnections`, `unmountAll`, `AgentSession.deliverIrcMessage` | [SSH](/oh-my-pi/features/ssh/), [Collab](/oh-my-pi/features/collab/) |
| **Security** | `src/secrets/`, `src/security/` | Secret obfuscation/redaction, placeholder keys, security scans | `SecretObfuscator`, `loadSecrets` | [Security](/oh-my-pi/features/security/) |
| **Utilities** | `src/utils/`, `src/async/`, `src/internal-urls/`, `src/capability/`, `src/workspace-tree.ts` | Event bus, async jobs, internal URL router, capability registry, rules, workspace tree | `EventBus`, `AsyncJobManager`, `InternalUrlRouter`, `Rule`, `buildWorkspaceTree` | [Internal URLs](/oh-my-pi/guides/internal-urls/) |
| **Observability** | `src/telemetry-export.ts`, `packages/stats`, OTel | OpenTelemetry spans, run summaries/coverage, local usage stats | `AgentTelemetryConfig`, `AgentRunSummary` | [Usage Statistics](/oh-my-pi/features/stats/) |
| **Background intelligence** | `src/advisor/`, `src/autoresearch/`, `src/autolearn/` | Watchdog advisors, experiment runner, skill capture | `discoverAdvisorConfigs`, `createAutoresearchExtension`, `AutoLearnController` | [The Advisor](/oh-my-pi/features/advisor/), [Auto-research](/oh-my-pi/features/autoresearch/) |

## Embedding patterns

### Minimal controlled embed

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const settings = Settings.isolated({
  "compaction.enabled": true,
  "retry.enabled": true,
});

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  settings,
  sessionManager: SessionManager.inMemory(),
  toolNames: ["read", "grep", "glob", "edit", "write"],
  enableMCP: false,
  enableLsp: true,
});

session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Find all TODO comments in this repo and propose fixes.");
await session.dispose();
```

### Explicit model wiring

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const available = modelRegistry.getAvailable();
if (available.length === 0)
  throw new Error("No authenticated models available");

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  model: available[0],
  thinkingLevel: "medium",
  sessionManager: SessionManager.inMemory(),
});
```

### Subagent orchestrator session

```ts
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  outputSchema: { type: "object", properties: { findings: { type: "array" } } },
  outputSchemaMode: "permissive",
  requireYieldTool: true,
  taskDepth: 1,
  parentTaskPrefix: "Research",
  agentId: "Researcher",
});
```

### Concurrent top-level sessions

Pass a private `AgentRegistry` per session — the default global registry admits only one `"Main"` identity per generation:

```ts
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";

const registryA = new AgentRegistry();
const registryB = new AgentRegistry();

const a = await createAgentSession({ agentRegistry: registryA, sessionManager: SessionManager.inMemory() });
const b = await createAgentSession({ agentRegistry: registryB, sessionManager: SessionManager.inMemory() });
```

### Selection order when `model` is omitted

When no explicit `model`/`modelPattern` is provided:

1. restore model from existing session (if restorable + key available)
2. settings default model role (`default`)
3. an authenticated provider-default model in availability order (falling back to the first authenticated available model when no provider default is present)

If restore fails, `modelFallbackMessage` explains fallback.

## Sharp edges

:::caution
**The SDK runs an in-process agent.** Long-running sessions hold MCP and LSP processes open — always call `session.dispose()` before tearing down your host.
:::

- **Restricted sessions are truly restricted.** `restrictToolNames: true` disables ambient MCP, extensions, custom commands, LSP, image-gen/TTS/search, and auto-learn; the active set is never widened.
- **`preloadedExtensions` never crosses session boundaries.** `Extension` instances close over a parent-bound `ExtensionAPI`; forward `preloadedExtensionPaths`/`preloadedCustomToolPaths` to subagents instead.
- **`agent_end.isTerminal`.** When `false`, maintenance or async delivery will resume the session before its true final settle. Subscribers using `agent_end` as a completion signal MUST wait for `isTerminal !== false` (absent = terminal).
- **`prompt()` returns `false` for local-only commands.** Use the boolean to decide whether an `agent_end` is coming (ACP hosts and turn-lifecycle managers).
- **In-memory `SessionManager` is non-persistent.** `session.sessionFile` is `undefined`, so resume/fork paths that depend on files do not apply.
- **MCP/LSP processes leak if you skip disposal.** The RPC process handles this by closing stdin; SDK embedders must call `dispose()`.
- **The package root vs `/sdk`.** `SessionManager`, `AuthStorage`, and `ModelRegistry` are root-only; `@oh-my-pi/pi-coding-agent/sdk` intentionally omits them.
- **`modelRegistry.authStorage` identity.** When both `authStorage` and `modelRegistry` are passed, they MUST reference the same instance or `createAgentSession` rejects.
