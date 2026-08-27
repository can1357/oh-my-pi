# Changelog

## [Unreleased]

## [18.0.7] - 2026-08-26

### Fixed

- Fixed Codex remote compaction to preserve images returned by image-reading tools, preventing them from being replayed as incorrect synthetic user messages.

## [18.0.5] - 2026-08-25

### Fixed

- Corrected remote compaction summaries so they accurately report the number of input tokens processed.

## [18.0.4] - 2026-08-24

### Changed

- Improved performance in append-only context mode by memoizing message serialization, keeping per-call sync overhead flat as conversations grow.

### Fixed

- Fixed an issue where `onTurnEnd` was skipped for turns ended by a terminal tool result (such as a subagent's final `yield`).

## [18.0.0] - 2026-08-22

### Fixed

- Fixed Anthropic Claude tool calls containing provider-visible private-use icon glyphs by reversibly tokenizing glyphs at the wire boundary and rejecting model-invented or unresolved glyph tokens before execution.
- Fixed agent identity confusion after session handoffs by clarifying context framing and ensuring successor instances seamlessly resume existing execution plans.

## [17.4.1] - 2026-08-21

### Fixed

- Fixed Codex remote compaction requests failing for region-pinned enterprise ChatGPT workspaces when requests egress from a different region.

## [17.4.0] - 2026-08-20

### Breaking Changes

- Replaced global token counting functions (`countTokens`, `countTokensConservatively`, `setTokenizerModel`, and `estimateTokens`) with model-scoped, immutable `Tokenizer` instances (`agent.tokenizer`). Use `tokenizer.countTokens(text, mode?)`, `tokenizer.countMessage(message)`, or `tokenizer.countMessages(messages)`.
- Updated context management functions (`findCutPoint`, `prepareBranchEntries`, `collectShakeRegions`, `pruneToolOutputs`, `pruneSupersededToolResults`, and `trimRemoteCompactionInputToContextWindow`) to require an explicit `Tokenizer` instance.

### Added

- Added `Tokenizer.checkTokenBudget(text, budget)` to efficiently verify if text fits within a token limit using fast byte-bound checks before falling back to full tokenization.
- Added provider-anchored transcript token estimation (`findTranscriptUsageAnchor`, `isTranscriptUsageAnchor`, `estimateTranscriptTokens`) to calculate transcript token counts incrementally from the latest reported assistant turn usage.
- Added `remotePreserveReusable()` to check whether a previous remote compaction payload remains reusable with the active model.

### Changed

- Expanded native tokenizer support across catalog models, adding exact embedded token counting for Claude, Qwen 3.5+, DeepSeek V3/V4/R1, Kimi K2/K3, and GLM-5+ models. `Tokenizer` now constructs from a resolved catalog `Model`.
- `createCompactionSummaryMessage` takes an options object after `(summary, tokensBefore, timestamp)`; `CompactionSummaryMessage` gained optional `method` and `tokensAfter` display metadata.

## [17.3.8] - 2026-08-19

### Fixed

- Fixed `/compact` (and automatic compaction) resurrecting pre-`/clear` conversation turns: `prepareCompaction` now honors the latest `reset_boundary`, so a compaction after an in-place `/clear` only summarizes messages created after the reset ([#8718](https://github.com/can1357/oh-my-pi/issues/8718)).
- Hardened compaction summarization against prompt injection: conversation history and previous summaries are now treated as untrusted, and embedded `<conversation>`/`<previous-summary>` boundary tags are neutralized before prompt assembly ([#8727](https://github.com/can1357/oh-my-pi/pull/8727) by [@koopmannleon19977-cmyk](https://github.com/koopmannleon19977-cmyk)).
- Compaction summarization input is now bounded to the summary model's context (windowed fold for oversized spans) and deterministic context-overflow 400s are no longer retried up to the full retry budget; artifact ids containing `503` no longer misclassify hard 400s as transient.
- Fixed remote compaction mirroring the #8789 Responses shape: `buildOpenAiNativeHistory` now hoists an assistant `message` wedged between a tool-call batch and its outputs ahead of the batch, so compaction requests to strict opencode-go gateways match the canonical `message(s) → calls → outputs` order ([#8789](https://github.com/can1357/oh-my-pi/issues/8789)).

## [17.3.5] - 2026-08-16

### Added

- Added automatic retry support for transient provider failures during one-shot completions, allowing callers such as compaction to opt in to resilient request handling.

### Fixed

- Fixed /handoff, branch summarization, and manual /compact failing outright on transient provider errors (e.g. Anthropic overloaded/429/529 responses); these operations now retry automatically instead of leaving the user's context full.

## [17.3.4] - 2026-08-14

### Fixed

- Fixed Codex-compatible V2 remote compaction with an explicit `v2Endpoint` by sending the required feature-negotiation header ([#8524](https://github.com/can1357/oh-my-pi/issues/8524)).

## [17.3.0] - 2026-08-13

### Fixed

- Improved the manual `/shake` command to retain a small history of recent tool results, preventing the agent from losing its active working context.

## [17.2.13] - 2026-08-11

### Fixed

- Fixed Cursor sessions re-executing settled tools when an owned dialect projector rebuilds toolCall blocks: `snapshotAssistantContentBlock` now copies `kCursorExecResolved` explicitly so agent-loop still skips already-settled calls.

## [17.2.10] - 2026-08-06

### Fixed

- Fixed an issue in remote OpenAI response compaction replay where output-only `status` fields were incorrectly sent back as input, affecting persisted native and V1/V2 replacement history.

## [17.2.9] - 2026-08-05

### Fixed

- Preserved queued steering and follow-up messages when a continuation is cancelled before or during pre-dequeue hooks, and propagated the caller's cancellation signal through every continuation model-call loop.

## [17.2.6] - 2026-08-03

### Fixed

- Fixed an issue where peer-IRC interrupts (such as subagent messages) incorrectly skipped non-interruptible tool calls queued in the same batch.
- Improved interruption messaging to clearly distinguish between parent-agent steering and system-advisory interruptions.

## [17.2.5] - 2026-08-03

### Breaking Changes

- Tool examples embedded in tool descriptions now always render in Python call syntax, and the `exampleDialect` option has been removed from `AppendOnlyContextManager` build options.
- Updated `normalizeTools` to accept a `NormalizeToolsOptions` configuration object (`{ injectIntent, pruneDescriptions }`) instead of positional booleans.

### Fixed

- Fixed an issue where runs would fail with an error if an Anthropic stream was truncated after complete tool calls were streamed; the agent now recovers and executes those tool calls.
- Fixed an issue where artifact recovery reads could be incorrectly elided during compaction.

## [17.2.4] - 2026-08-01

### Fixed

- Fixed Codex V2 remote compaction bypassing the provider's live WebSocket transport before trying SSE ([#7198](https://github.com/can1357/oh-my-pi/issues/7198)).
- Tool calls skipped mid-batch to service queued steering/peer input now distinguish calls that never entered `tool.execute` (`SyntheticToolResultDetails`, `executed: false`) from in-flight calls that may have performed partial work (`execution: "started"`), allowing UI/telemetry consumers to render normal steering control flow without misreporting execution state ([#7199](https://github.com/can1357/oh-my-pi/issues/7199)).

## [17.2.2] - 2026-07-31

### Fixed

- Fixed an issue where response-only usage records were incorrectly treated as authoritative context anchors, while ensuring prompt and total-only provider telemetry remains preserved.
- Fixed context compaction summaries growing excessively with large context windows by capping the summary output budget to 16,384 tokens, ensuring conversations are properly compressed rather than duplicated.

## [17.2.0] - 2026-07-30

### Fixed

- Provider-native compaction failures now surface their transport error instead of silently switching to generic summarization; streaming V2 still falls back to native V1 when available.

## [17.1.7] - 2026-07-27

### Changed

- `beforeToolCall` now runs during arg-prep in a pre-dispatch prepare phase — on the streamed path before the assistant message's `message_start`/`message_end` are emitted, and always ahead of concurrency resolution, `tool_execution_start`, telemetry span start, and `tool.execute` — instead of inside the already-scheduled execution slot. It receives the resolved `tool` in its context and may return `args` to replace the call's arguments; a replacement is revalidated against the tool schema, written back to the assistant message's tool-call block, and re-resolves argument-dependent interruptibility, making it the single source of truth for history, persistence, provider replay, scheduling, execution events, and `tool.execute`. Argument validation moved into the same prepare phase, so functional `concurrency` resolvers now see validated (and possibly revised) arguments rather than raw pre-validation ones. The hook now receives the run's request abort signal rather than the per-tool signal.

## [17.1.6] - 2026-07-27

### Added

- Added a pre-model-call gate: `AgentLoopConfig.beforeModelCall` receives the finalized provider context and run abort signal, and may return `{ stop: true, reason? }` to end the run before the provider is called, so a host can refuse a request it has decided not to pay for (prompt no longer fits, budget boundary crossed, session should hand off). `Agent.setBeforeModelCall` installs the host callback; `Agent.addBeforeModelCall` registers an additional one without displacing it and returns a disposer. A gate-stopped run retains pending soft tool reminders/escalations and an unserved hard tool choice for the next admitted request; deferred choices are revalidated against active tools and cleared with queued session state ([#6543](https://github.com/can1357/oh-my-pi/pull/6543) by [@paralin](https://github.com/paralin)).

### Changed

- Input message events (prompt, steering, soft reminders) are now emitted once provider-context preparation succeeds, so a pre-model gate can veto the request before any turn opens; gate-stopped and failed runs still commit their accepted inputs ([#6543](https://github.com/can1357/oh-my-pi/pull/6543) by [@paralin](https://github.com/paralin)).

## [17.1.5] - 2026-07-27

### Fixed

- Fixed proxy-stream clients dropping finalized provider-only content blocks, including Anthropic native web-search history, by allowing `done` and `error` events to carry terminal assistant content while retaining delta-reconstructed content from older proxy servers that omit it ([#6703](https://github.com/can1357/oh-my-pi/issues/6703)).

## [17.1.4] - 2026-07-26

### Changed

- Steering is now woken by an event instead of polled on a fixed interval while a tool batch runs. `AgentLoopConfig.waitForSteeringMessages` resolves when a steer is enqueued, so an interruption is observed as soon as it arrives rather than at the next tick, and idle batches stop burning wakeups. The interval timer remains for the IRC interrupt queue, which has no wake callback, and checks only IRC while the event watcher owns steering. Waits are raced against local abort, so a callback that does not observe its signal cannot hang batch teardown.

### Fixed

- Fixed a Cursor tool result being lost when a custom `cursorOnToolResult` transformer was still pending as the turn closed. The provider dispatches decoded messages without awaiting them, so a `message_end` from the same chunk could drain the buffer before the transformer resolved, dropping the result and leaving its `toolCall` block to be stripped as dangling on replay. The entry is now reserved synchronously and patched in place once the transformer resolves, preserving buffer order.
- Fixed an async `cursorOnToolResult` transformer's rewrite being silently discarded when it resolved after the buffer drain. The reservation kept the call from dangling but the late patch mutated a detached entry, so the already-persisted message kept the pre-transform payload. The drain now awaits any transformer still in flight before persisting, matching the awaited exec-channel paths. A rejecting transformer is swallowed and the reserved payload stands in, so a failing hook cannot take the turn down or cost the result.
- Fixed Cursor tool results being dropped for hosts that pass neither `cursorExecHandlers` nor `cursorOnToolResult`. Both are optional, but the Cursor provider resolves native todo calls server-side and synthesizes exec blocks regardless, marking both as resolved so no placeholder result is emitted for them. The result buffer callback was only installed when one of the options was present, so a bare SDK host discarded the provider's paired result and every rebuilt transcript stripped the interaction. It is now installed unconditionally.
- Fixed an async `cursorOnToolResult` rewrite being lost when the provider errored mid-transform. The normal drain waits for a pending transformer, but the error path snapshotted the buffer without that await, so a transform still in flight patched an entry the catch path had already detached and the pre-transform payload was persisted. A provider error is exactly when a transform is most likely to be mid-flight.
- Reduced oversized OpenAI native compaction requests by replacing only trailing tool-output bodies that exceed the model context window, while preserving calls, assistant history, and reasoning.

## [17.1.2] - 2026-07-24

### Added

- Added `resolveFallbackTool` option to allow routing unadvertised tool calls to host-side transports (e.g., device mounts)

## [17.1.1] - 2026-07-24

### Added

- Added the provider-neutral native computer-call lifecycle, preserving observation outputs and input actions across pending and acknowledged tool results.

### Changed

- Queued steering no longer hard-aborts non-interruptible tools (e.g. `bash`): it aborts interruptible waits only and raises a cooperative steering signal (`ToolCallContext.steeringSignal`) that long-running tools may observe to finish early or background themselves. The mid-batch steering/IRC watch now runs for every tool batch instead of only batches containing an interruptible tool.

## [17.1.0] - 2026-07-24

### Added

- Added support for tracking Cloudflare AI Gateway cache status (hit, miss, bypass, unknown) on chat spans.

### Changed

- Improved tool execution steering behavior: queued steering now cooperatively signals long-running, non-interruptible tools (via ToolCallContext.steeringSignal) to allow graceful early termination or backgrounding, rather than hard-aborting them.

### Fixed

- Fixed an out-of-memory (OOM) crash caused by an infinite loop when a steer or follow-up message was queued on an agent session with an empty transcript.
- Fixed an issue where switching providers or models on a session could lose compacted history; the agent now correctly falls back to a portable local summary if the new model cannot replay the prior provider's remote-compaction payload.
- Fixed a compaction failure with Anthropic models where serializing prior assistant reasoning inside <thinking> tags triggered reasoning_extraction refusals.

## [17.0.8] - 2026-07-22

### Fixed

- Improved resilience against transient stream JSON parse failures by recovering completed tool calls while safely preventing incomplete, unknown, refused, or sensitive calls from executing.

## [17.0.5] - 2026-07-18

### Added

- Added a per-message token estimation cache to optimize performance by reusing token counts for settled message history, with automatic cache invalidation on message mutation.

### Changed

- Improved tool execution control by making tool interruptibility resolvable per call, allowing side-effecting operations to complete while passive waits can yield to queued steering.

## [17.0.2] - 2026-07-17

### Fixed

- Improved error visibility in interactive clients by surfacing provider stream failures through the assistant message lifecycle, preventing silent loading spinners.
- Fixed an issue where Cursor provider contexts omitted host-supplied MCP tools from main and side-channel requests.

## [17.0.0] - 2026-07-15

### Breaking Changes

- Replaced the irc, job, and launch tools with a unified hub tool.
- Removed the tool discovery system (including the search-tool-bm25 tool) and its associated configuration settings (tools.discoveryMode, tools.essentialOverride, mcp.discoveryMode, and mcp.discoveryDefaultServers).
- Removed the resolve tool; plan approval and preview actions now use writes to the xd://propose virtual device path.

### Added

- Introduced the xd:// virtual device protocol for mounting tools as URLs readable/writable via read/write tools, configurable via the new tools.xdev setting (defaults to true).
- Added the hub tool, consolidating agent peer messaging, background job control, and supervised long-running processes.
- Added the edit.enforceSeenLines configuration setting (defaults to false) to optionally reject edits on lines that have not been fully displayed.
- Added the ToolLoadMode type and an optional satisfies predicate to SoftToolRequirement to support compliance checks against specific invocation shapes (such as writing to a virtual device path).

## [16.5.2] - 2026-07-14

### Fixed

- Improved session deadline abort signals to carry structured cancellation reasons, enabling timeout-aware tools to correctly classify deadline cancellations.
- Fixed an issue where completed tool executions were incorrectly marked as skipped (clobbering their actual results) if a user message was queued while the tool was in flight.

## [16.5.1] - 2026-07-14

### Fixed

- Fixed compatibility with Copilot gpt-5.6 models by correcting token escaping in compaction summaries.

## [16.5.0] - 2026-07-13

### Added

- Added an automated image-dropping rescue tier to compaction dead-end recovery.
- Added visual warnings and detailed recovery instructions to the session timeline when compaction fails to free sufficient space.

## [16.4.5] - 2026-07-11

### Added

- Added a process-global pause gate (`agentPauseGate`) to safely pause agent loops before model calls or tool executions, allowing them to be resumed later or aborted cleanly.

## [16.4.3] - 2026-07-11

### Fixed

- Fixed an issue where skipped sibling tool results incorrectly reported that a queued user message caused the skip.

## [16.4.2] - 2026-07-10

### Fixed

- Fixed serialization of BigInt tool arguments to prevent data loss during remote compaction.

## [16.4.1] - 2026-07-10

### Fixed

- Enabled reasoning encryption content for all Responses Lite compaction requests

## [16.4.0] - 2026-07-10

### Added

- Added the `ThinkingLevel.Max` ("max") configuration option, mapping to the `Effort.Max` tier for supported models.

### Fixed

- Fixed remote compaction behavior for Codex Responses Lite (GPT-5.6 family) models across both V1 and V2 endpoints to ensure correct formatting and routing.
- Fixed an issue where aborted tool-result hooks could trigger subsequent provider calls before the abort signal fully settled.

## [16.3.12] - 2026-07-08

### Added

- Added per-tool abort metadata so stream-wide aborts can label matching tool-call placeholders separately from unaffected sibling calls ([#2783](https://github.com/can1357/oh-my-pi/issues/2783)).

### Fixed

- Fixed handoff generation retrying with `toolChoice: "auto"` when custom OpenAI-compatible providers reject `toolChoice: "none"` with an auto-only 400. ([#4715](https://github.com/can1357/oh-my-pi/issues/4715))
- Fixed generic remote compaction against OpenAI-compatible `/chat/completions` endpoints (for example llama.cpp `openai-completions`) by sending chat messages instead of the custom `{ systemPrompt, prompt }` summarizer payload. ([#4630](https://github.com/can1357/oh-my-pi/issues/4630))

## [16.3.7] - 2026-07-05

### Fixed

- Fixed an issue where provider orchestration tokens were incorrectly included in context token calculations, which could trigger premature context auto-compaction and promotion.

## [16.3.3] - 2026-07-02

### Changed

- Enabled dynamic model resolution to support seamless mid-run model switching.

### Fixed

- Fixed an issue in the Cursor agent where assistant messages containing native tool calls could duplicate text blocks on replay.
- Fixed a bug where Cursor agent exec-channel tools (such as bash, write, and delete) were executed a second time after server-side execution.
- Improved error handling for tool calls interrupted by upstream provider stream errors, distinguishing transport/provider failures from local tool execution failures in the CLI, events, and messages.

## [16.3.0] - 2026-07-02

### Added

- Added support for Anthropic fallback content blocks in agent-loop assistant messages, ensuring they are preserved across session persistence and event fanout.

### Fixed

- Fixed an issue where legacy steering messages were prematurely consumed and dropped during in-flight tool execution polls.
- Fixed an issue where skipped tool results in queued messages were incorrectly treated as completed, preventing necessary retries.
- Improved branch summaries to preserve informative tool results from abandoned branches while filtering out redundant output.
- Fixed interruptible tool waits to properly abort on host-provided IRC interrupts in addition to user steering.
- Fixed schema validation errors for closed union tools by correctly injecting intent tracing into each variant.
- Fixed token compaction reserve-budget logic to honor explicit reserveTokens values equal to the built-in default, and clamped the fallback reserve to at least one token for very small context windows.

## [16.2.4] - 2026-06-28

### Changed

- Improved the reliability of remote compaction by introducing transient error retries, configurable timeouts, and immediate termination upon user-initiated aborts.

### Fixed

- Fixed an issue where assistant responses and encrypted reasoning could be lost during local history trimming prior to remote compaction.
- Fixed type compatibility for hosts with title audit entries by adding support for `title_change` session metadata.
- Fixed an issue where transient stream read failures after a completed tool call were treated as terminal errors, allowing the agent to successfully execute the tool and continue the turn.

## [16.2.3] - 2026-06-28

### Changed

- Enabled V2 streaming remote compaction by default for compatible AI and OpenAI-compatible models, which forwards full conversation history to the provider and supports session routing, prompt caching, provider-native tool history replay, transient error retries, and configurable timeouts.

### Fixed

- Fixed an issue where assistant responses and encrypted reasoning could be lost during local history trimming.
- Added `title_change` session metadata to the compaction entry type union to maintain type compatibility for hosts with title audit entries.

## [16.2.2] - 2026-06-27

### Added

- Added optional AgentTool.matcherPaths(args) and AgentTool.matcherEntries(args) hooks to allow tools to surface target file paths and isolate file evaluations for path-scoped stream matchers (e.g., when handling multi-file payloads or embedded paths in streamed arguments).

### Removed

- Removed support for Pi dialect integration.

## [16.2.0] - 2026-06-27

### Added

- Added an optional `cwdResolver` to `Agent` and `getCwd` to `AgentLoopConfig` to dynamically resolve the working directory per LLM call, allowing workspace-scoped provider discovery (such as GitLab Duo Agent) to follow live directory changes without reconstructing the agent.

### Fixed

- Fixed an issue where API-level provider refusals were replayed as assistant dialogue on subsequent requests, preventing repeated refusals after a single blocked turn.
- Fixed a bug where internal streaming state (`partialJson`) could leak onto the final `AssistantMessage` if a stream ended without a `toolcall_end` event.
- Fixed `Agent` to correctly forward the working directory (`cwd`) into provider stream options, enabling providers like GitLab Duo Agent to scope local tool execution to the workspace.
- Enabled custom OpenAI-compatible providers to use native remote compaction instead of falling back to local summarization.

## [16.1.23] - 2026-06-26

### Changed

- Changed `AgentLoopConfig.onTurnEnd` and `Agent.setOnTurnEnd` callbacks to receive whether the loop will continue with another provider request.

### Fixed

- Fixed stale snapcompact archive frames leaking into context-full compaction after `compaction.strategy` was switched from `snapcompact` to `context-full`. Switching strategy left the latest compaction entry's `preserveData.snapcompact` in place, so context-full kept rebuilding context with old image frames attached — inflating context/token usage and making sessions appear to compact early (around ~60% apparent window use). The first context-full compaction after the switch now folds the prior archive's plaintext into the LLM summary input and strips `preserveData.snapcompact` from the new entry; legacy frame-only archives (no plaintext to migrate) are stripped outright. ([#3561](https://github.com/can1357/oh-my-pi/pull/3561) by [@serverinspector](https://github.com/serverinspector))

## [16.1.18] - 2026-06-25

### Fixed

- Fixed `AppendOnlyContextManager.syncMessages` clearing the entire log on any in-place rewrite of an already-synced message. Per-turn tool-output pruning, image stripping, or any `transformContext` re-render that touched a single message used to drop every prior turn out of the append-only log and re-send the conversation from scratch, forcing local backends (llama.cpp / Ollama / LM Studio) to re-prefill tens of thousands of tokens every few turns. `syncMessages` now finds the longest byte-stable prefix between the previously-synced messages and the new ones, truncates the log to that prefix, and only re-appends the diverged tail — so the provider's KV cache stays warm up to the divergence point. ([#3406](https://github.com/can1357/oh-my-pi/issues/3406))

## [16.1.17] - 2026-06-24

### Fixed

- Hardened the agent-loop cooperative yield against backward wall-clock jumps. A stale future timestamp left in the shared yield gate (NTP step, or a fake-timer test mocking `Date.now`) could make `yieldIfDue()` gate forever and stop yielding to the event loop; the gate now treats a backward clock delta as due and re-anchors. The gate is exposed as an injectable `YieldGate` (with `yieldIfDue()` retained as the shared singleton) so it can be exercised without mocking process-global timers.

## [16.1.16] - 2026-06-23

### Added

- Added `generateHandoffFromContext(context, model, options)` to `@oh-my-pi/pi-agent-core/compaction`: runs the handoff oneshot against a fully-built provider `Context` (system prompt, normalized tools, transformed history, trailing handoff prompt) with `streamOptions` mirroring the live turn's cache routing, so a host that owns the transform pipeline can make the handoff request share the prompt cache the main turn populated. `generateHandoff(messages, …)` is unchanged and now delegates to it.
- Added an optional `systemPrompt` argument to `Agent.buildSideRequestContext(llmMessages, systemPrompt?)`, defaulting to the live agent prompt; callers can pin a different prompt (e.g. handoff generation, which uses the base prompt rather than a per-turn `before_agent_start` hook override).

### Changed

- Updated `buildSideRequestContext` to allow pinning custom system prompts

## [16.1.10] - 2026-06-21

### Fixed

- Fixed labeled user interrupts retaining incomplete streamed tool calls before `toolcall_end`, which could persist malformed tool-call IDs into replay.

## [16.1.8] - 2026-06-20

### Breaking Changes

- Changed `transformProviderContext` and `buildSideRequestContext` to return a Promise

### Added

- Added `buildSideRequestContext` to the `Agent` class to build prompt-cache-friendly provider Contexts for side-channels or ephemeral requests.
- Added `compactionContextTokens(providerContextTokens, storedConversationEstimate)`: floors the provider-reported context tokens by a local estimate of the stored conversation for the compaction decision, so a `before_provider_request` payload transform (a compression extension, obfuscator, or inline snapcompact) that shrinks the request can no longer deflate provider usage below the true history size and suppress auto-compaction.

### Changed

- Exported helper functions `normalizeMessagesForProvider` and `resolveOwnedDialectFromEnv` from `packages/agent/src/agent-loop.ts`.

## [16.1.5] - 2026-06-19

### Fixed

- Wire-encoded `normalizeTools` parameters unconditionally so tools whose `intent` resolves to `"omit"` (function intent or `intent: "omit"`, e.g. builtin `eval` / `resolve`) no longer leak raw arktype/zod schema objects in `parameters` ([#3074](https://github.com/can1357/oh-my-pi/issues/3074))

## [16.1.2] - 2026-06-19

### Fixed

- Prevented sensitive raw JSON payloads from leaking into agent events during tool validation
- Ensured tool validation errors are handled correctly for malformed JSON parse inputs
- Ensure deep-cloning of tool-call arguments respects own enumerable properties
- Prevent direct object references between agent message snapshots and streaming events

## [16.1.0] - 2026-06-19

### Added

- Added `SoftToolRequirement` support to `getToolChoice`: a host can require a tool by returning a soft requirement instead of a hard `ToolChoice`. The loop injects the supplied reminder once (leaving `tool_choice` on auto), and escalates to a one-turn forced choice — skipping any detour tool batch — only if the model fails to call the required tool, avoiding the provider message-cache invalidation of forcing every turn.
- Added `pruneToolDescriptions` option to reduce token usage by stripping tool descriptions from provider-bound specs

### Fixed

- Improved token estimation accuracy for compaction summaries containing multi-block content

## [16.0.11] - 2026-06-19

### Changed

- Updated the display format for truncated file operation summaries

## [16.0.8] - 2026-06-18

### Fixed

- Stopped the compaction `<files>` summary from tracking `scheme://` URLs — internal URIs (`conflict://`, `artifact://`, `local://`, `history://`, …) and web URLs are no longer recorded as files, and legacy entries rehydrated from older compaction summaries are dropped.

## [16.0.6] - 2026-06-18

### Added

- Added `transformAssistantMessage` hook to `AgentOptions` and `Agent` to allow mutating the finalized assistant message before UI emission, context appending, or tool dispatch

## [16.0.5] - 2026-06-17

### Breaking Changes

- Changed `AgentOptions.getApiKey` and `AgentLoopConfig.getApiKey` to receive the active `Model` and return an API key or `ApiKeyResolver`, so credential routing stays model-scoped and retry context is no longer exposed through the agent-core API

### Added

- Added agent-loop deadline support for graceful wall-clock session stops.

### Changed

- Changed Gemini repetition-loop detection to live in the pi-ai stream layer instead of the agent loop. The agent no longer runs its own Gemini-gated verbatim repetition check (`detectRepetition`/`truncateRepetition`); loops now surface as a retryable transient stream error that the standard auto-retry path discards and re-samples, rather than a committed contentful error message.

### Fixed

- Fixed `PI_DIALECT=minimax` being ignored by the owned tool-calling env selector. ([#2759](https://github.com/can1357/oh-my-pi/issues/2759))

## [16.0.1] - 2026-06-15

### Fixed

- Fixed transient provider errors after streamed tool-call arguments so incomplete tool calls are marked as interrupted output instead of eligible for automatic retry ([#2683](https://github.com/can1357/oh-my-pi/issues/2683)).
- Fixed `@oh-my-pi/pi-agent-core` telemetry content capture crashing every chat turn with `TypeError: systemPrompt.map is not a function` when `captureMessageContent` is enabled (`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`). `ChatRequestSnapshot.systemPrompt` now accepts `string | readonly string[]` and the telemetry serializers normalize a bare string to a single-element array — previously the full-system serializer called `.map` on a string (the `.length` guard passed, so it threw) and the request-message serializer iterated the string into one `system` message per character.

## [16.0.0] - 2026-06-15

### Breaking Changes

- Renamed owned tool-calling options from `toolCallSyntax`/`exampleSyntax` to `dialect`/`exampleDialect`.
- Changed compaction conversation serialization to use the target model's native dialect turn, thinking, tool-call, and tool-result envelopes when a dialect is selected.
- Renamed the owned dialect environment variable from `PI_OWNED_TOOLS` to `PI_DIALECT`.

### Added

- Added `onTurnEnd` hook support (`setOnTurnEnd`/`onTurnEnd`) to run awaited per-turn bookkeeping with current messages before the next model request and skip callback execution for aborted or error turns

### Changed

- Renamed `toolCallSyntax` option to `dialect` in AgentOptions and AgentLoopConfig
- Updated conversation serialization to use dialect's native transcript rendering when a dialect is selected
- Changed internal references from `ToolCallSyntax` type to `Dialect` type across agent loop and compaction modules

## [15.13.3] - 2026-06-15

### Added

- Added the `interruptible` tool field: when set, the agent loop may abort the tool mid-execution to deliver a queued steering message (honored only in `immediate` interrupt mode).
- Added support for `gemini` and `gemma` as valid owned tool syntax values in environment configuration

### Fixed

- Fixed `pruneToolOutputs` blanking tiny tool results during overflow pruning: results below `50` tokens (`MIN_PRUNE_TOKENS`) are no longer replaced with the `[Output truncated - N tokens]` placeholder, which cost more tokens than the result itself and churned the prompt cache for zero savings.

## [15.13.2] - 2026-06-15

### Breaking Changes

- Removed `harmony-leak` exports from the `@oh-my-pi/pi-agent-core` package entrypoint
- Replaced the experimental `promptToolCalls` agent/loop option with `toolCallSyntax`, selecting an explicit in-band tool-call grammar instead of a boolean GLM-only mode.

### Added

- Added support for selecting owned in-band tool-call syntax via `PI_OWNED_TOOLS=<syntax>` (for example `hermes` or `qwen3`) while preserving legacy `PI_OWNED_TOOLS=1/true` as GLM mode
- Added owned in-band tool calling for multiple syntaxes (`glm`, `hermes`, `kimi`, `xml`, `anthropic`, `deepseek`, `harmony`, `pi-native`, `qwen3`). Owned mode sends no native provider tools, appends a syntax-specific prompt/catalog, re-encodes prior tool calls/results as grammar-owned text, and parses streamed model output back into canonical tool calls.
- Added tool-example folding to `normalizeTools`: when given a model's affinity syntax (resolved via `preferredToolSyntax`), it renders each tool's `examples` into an `<examples>` block in that native syntax and appends it to the wire description. Wired through both context paths (fresh build and append-only `takeSnapshot`/`build` via a new `exampleSyntax` build option), with the `_i` intent-field placeholder added to examples when intent tracing injects it.
- Added the `abortOnFabricatedToolResult` option to `AgentOptions`/`AgentLoopConfig` (default `true`): when owned tool calling is active and the model fabricates a tool result mid-turn, `true` aborts the provider request immediately while `false` lets it finish and discards the fabricated continuation.

### Changed

- Added owned in-band syntax support to `Agent` loop configuration resolution by selecting syntax from `toolCallSyntax` or `PI_OWNED_TOOLS` when present

### Fixed

- Fixed append-only context cache fingerprinting to account for `exampleSyntax`, so switching tool-call syntax rebuilds cached prompts with the correct injected tool examples
- Fixed owned in-band tool-calling requests to omit `toolChoice` after stripping native tools, preventing invalid tool-choice requests
- Fixed owned tool calling letting the model fabricate tool results by treating grammar-owned tool-result markers in assistant text as a hard turn boundary: calls before the fabrication are kept, fabricated results and dependent calls are dropped, and the real result is fed back on the next turn.

## [15.13.1] - 2026-06-15

### Added

- Added repetition-loop detection to the streaming agent loop for Gemini-family providers. A runaway run of a repeated text or thinking unit is detected mid-stream from a bounded rolling tail (O(1) per delta), the provider request is aborted, the repeated tail is collapsed to a single representative copy, and the turn ends gracefully with an `error` stop reason. Legitimate all-numeric/whitespace/punctuation runs (hexdumps, zero-fills, numeric tables) are not misclassified as loops ([#2549](https://github.com/can1357/oh-my-pi/pull/2549) by [@usr-bin-roygbiv](https://github.com/usr-bin-roygbiv)).

### Fixed

- Fixed repetition loop handling to collapse repeated `thinking` blocks to a single representative copy when a loop is detected
- Fixed repetition-loop detection to ignore repeats that contain only digits, whitespace, or punctuation so legitimate numeric outputs no longer stop with a repetition-loop error
- Fixed false-positive repetition-loop checks across `text` and `thinking` stream boundaries by tracking loop detection per block type

## [15.12.6] - 2026-06-14

### Fixed

- Fixed dynamic forced tool choices from queue hooks being filtered against the active per-turn tool set before provider dispatch. ([#1701](https://github.com/can1357/oh-my-pi/issues/1701))

## [15.12.4] - 2026-06-13

### Fixed

- Fixed remote compaction input trimming to use unlimited context when `model.contextWindow` is unset

## [15.12.1] - 2026-06-12

### Breaking Changes

- Changed `pruneSupersededToolResults` to allow `supersedeKey` to be omitted so useless-result pruning can run without read-style supersede grouping

### Added

- Added `pruneUseless` controls to `PruneConfig` and `SupersedePruneConfig` so callers can toggle compaction of `toolResult` entries marked `useless`
- Added the ability to disable useless-result pruning by setting `pruneUseless` to false
- Tools can flag a result contextually useless (`AgentToolResult.useless`; overridable via `AfterToolCallResult.useless`): the agent loop copies the flag onto the persisted `ToolResultMessage` (errors always win), and compaction consumes it — the cache-aware supersede pass and the threshold prune blank flagged results to the exact `USELESS_NOTICE` placeholder (bypassing the protect window, skipping results smaller than the notice), shake collects them inside the protect-recent window, and `serializeConversation` drops the whole tool call/result pair from summarizer input

### Changed

- Changed `pruneSupersededToolResults` to allow omitted `supersedeKey` when `pruneUseless` is enabled, so useless-result pruning can run without read-style supersede grouping

## [15.11.4] - 2026-06-12

### Added

- Added `hasSteeringMessages` to `AgentLoopConfig` (wired by `Agent` to its steering queue): a peek used by the immediate-interrupt poll during tool execution, so the loop can detect queued steering without dequeuing and the queue keeps owning its messages until the injection boundary
- The agent loop now re-samples after a non-terminal stop (`stopReason: "stop"` with `stopDetails: { type: "pause_turn" }`, emitted by the Codex providers for `end_turn: false` commentary-only responses): the assistant message is committed to history and the model is called again without ending the turn. Consecutive pause continuations without an intervening tool call are capped at 8 to bound a backend that never stops pausing.

### Changed

- Changed steering handling so queued steering messages are now dequeued only at injection boundaries, with immediate mid-batch interrupt polling using `hasSteeringMessages`. Consumers constructing `AgentLoopConfig` directly with only `getSteeringMessages` no longer get mid-batch interrupts — steering degrades to boundary-only delivery until they also supply `hasSteeringMessages`
- Compaction, handoff, short-summary, and branch-summarization helpers now accept an `ApiKey` (static string or resolver) instead of a pre-resolved string, so a 401 mid-compaction force-refreshes and rotates the credential through the central auth-retry policy before any model-level fallback. The remote OpenAI compaction request is wrapped in `withAuth` and its HTTP failures now carry `.status`, so the retry classifier actually fires on remote-compaction 401s.
- `transformProviderContext` now receives the dispatch model as a second argument (`(context, model) => Context`), so per-request transforms can gate on model capabilities (vision input, provider, API family). Existing single-argument implementations keep working unchanged.
- Remote-compaction and summarization failures now throw pi-ai's typed `ProviderHttpError` instead of mutating plain `Error`s with a `.status` property; the generic `requestRemoteCompaction` error now carries `.status` (and response headers) too.

### Fixed

- Fixed a regression where steering messages could be injected into history during an aborted in-flight tool batch, leaving them hidden from queue consumers for post-abort continue

## [15.11.2] - 2026-06-11

### Added

- `AgentTool.concurrency` now also accepts a per-call resolver function `(args) => "shared" | "exclusive"`, letting tools pick the scheduling mode from the call's arguments (a throwing resolver falls back to `"exclusive"`)

### Fixed

- Fixed whitespace-only error tool results so Anthropic requests no longer 400 with `tool_result: content cannot be empty if is_error is true` and wedge the session on every subsequent turn

## [15.11.0] - 2026-06-10

### Breaking Changes

- Removed `compaction/index.ts` re-export of snapcompact helpers, so snapcompact utilities are no longer available from the agent compaction barrel and should be imported from `@oh-my-pi/snapcompact`
- Removed the `convertToLlm` alias export from `compaction/messages` — it duplicated `defaultConvertToLlm` under a second name. Import `defaultConvertToLlm` (array form) or the new `convertMessageToLlm` (single-message form) instead

### Added

- Added `convertMessageToLlm()`: the single-message core transformer behind `defaultConvertToLlm()`. Embedders with app-specific message roles should handle their own roles and delegate every core role (`user`/`developer`/`assistant`/`toolResult`/`custom`/`hookMessage`/`branchSummary`/`compactionSummary`) to it instead of duplicating the conversion — a duplicated `compactionSummary` case is how snapcompact frames once silently dropped off provider requests
- Added `pruneSupersededToolResults()` and the opt-in `PruneConfig.supersedeKey` hook so harnesses can prune stale tool results superseded by a newer read of the same file; superseded results are pruned ahead of age-based victims during overflow pruning and replaced with a `[Superseded by a newer read of this file]` placeholder. Without the new config, `pruneToolOutputs()` behavior is unchanged.
- Added `readToolSupersedeKey()` implementing the read-tool path/selector grammar (selector-free reads supersede range reads of the same file; URL-scheme paths exempt). Pruning honors prompt-cache economics: per-turn prunes only fire when the post-candidate suffix is small or the cache is cold (idle gap).
- Added the `snapcompact` compaction strategy via `@oh-my-pi/snapcompact`: instead of an LLM summary, discarded history is printed onto dense bitmap frames and re-attached to the compaction summary message as image blocks. `CompactionSummaryMessage` gains an optional `images` field, `estimateTokens()` charges per attached frame, and frames persist under `preserveData.snapcompact` with an 8-frame middle-out eviction budget.
- Snapcompact frames are now rendered in a provider-aware shape (`SNAPCOMPACT_SHAPES` + `resolveSnapcompactShape(api)`), following the snapcompact 200k-token monolithic evals: Anthropic-family and unknown APIs get `8x8r-bw` (unscii-8 square cells, black ink, every line printed twice with the copy on a pale highlight band — read at F1 parity with raw text at ~2x lower cost and the most refusal-robust), Google gets `8x8r-sent` (sentence-hue ink, ~2.9x cheaper), and OpenAI gets `6x6u-sent` (unscii Lanczos-stretched to 6x6 cells — OpenAI bills a flat ~2.9k tokens per image, so frame count is the only cost lever) with `detail: "original"` on the frame images. `snapcompactCompact()` accepts `model`/`shape` options, frames persist their shape metadata, mixed-shape archives (provider switches, legacy 5x8 frames) are flagged in the reading instructions, and `snapcompactGeometry()`/`renderSnapcompactFrame()` now take a shape

### Changed

- Compaction and branch-summary file lists are now a single `<files>` tag instead of `<read-files>`/`<modified-files>`: paths render as the grouped, prefix-folded directory tree the find/search tools emit (`# dir/` headers, bare basenames), each annotated `(Read)`, `(Write)`, or `(RW)` — modified files that were also read get `(RW)`. Legacy tags in summaries written by earlier versions are still stripped and self-heal on the next compaction

### Fixed

- Fixed queued steering messages being drained into an externally aborted run: interrupting mid-tool execution (e.g. Enter with a pending steer) dequeued the steer into the dying run — it landed in history without a response and the post-abort resume saw an empty queue, so the agent stopped instead of continuing. Steering/follow-up/aside queue polls are now skipped once the run's abort signal fires, leaving the queue intact for `Agent.continue()`.
- Fixed `<read-files>` compaction lists recording the same file once per line-range/raw selector (`src/foo.ts:50-200`, `:raw`, `:1-50:raw`, …): read-tool selectors are now stripped before tracking, so reads dedupe to the base path and match their write/edit path when splitting read-only vs modified lists. Selector-polluted lists stored by earlier compactions self-heal on the next compaction. `readToolSupersedeKey()` now shares the same splitter (`splitReadSelector()`), gaining the `..` range alias and `L`-prefix forms it previously missed.
- Fixed `estimateTokens()` undercounting thinking-heavy assistant messages on replay: `thinkingSignature` payloads (OpenAI Responses encrypted reasoning items, Anthropic signed thinking blocks, etc.) and `redactedThinking.data` are now charged alongside the visible thinking text, so the local estimate tracks provider-reported usage instead of straddling the threshold on every turn ([#2275](https://github.com/can1357/oh-my-pi/issues/2275)).

## [15.10.12] - 2026-06-10

### Added

- Added `AgentLoopConfig.getDisableReasoning` so callers can override `disableReasoning` per LLM call, mirroring `getReasoning`.
- Added `transformProviderContext` to `AgentOptions`/`AgentLoopConfig`: an optional hook applied to the assembled provider context after conversion, normalization, and append-only handling, but before telemetry capture and provider send.

### Fixed

- Fixed `Agent` runs so explicit reasoning disablement is forwarded to provider stream options and re-resolved per continuation, keeping mid-run thinking-off changes in sync with the next provider request.

## [15.10.11] - 2026-06-10

### Changed

- Editorial pass over the compaction prompts: fixed garbled grammar and missing articles, RFC-keyed prohibitions, deduped restated instructions; parsed markers (`<read-files>`/`<modified-files>`/`<previous-summary>`) and all output-format headings left byte-identical
- Catalog imports moved to the new `@oh-my-pi/pi-catalog` package: subpath imports (`calculateCost`, Codex wire constants) plus catalog values previously taken from the `@oh-my-pi/pi-ai` root (`getBundledModel`, `clampThinkingLevelForModel`), which pi-ai no longer re-exports; type-only `Model`/`Api`/`Effort` imports from pi-ai are unchanged

## [15.10.8] - 2026-06-09

### Added

- Added optional `fetch` overrides to `SummaryOptions` and `compact`/`generateSummary` so remote compaction can use custom HTTP clients
- Added optional `fetch` option to `ProxyStreamOptions` to control the HTTP request used by `streamProxy`
- Added optional `fetch` overrides to `requestOpenAiRemoteCompaction` and `requestRemoteCompaction` for injectable HTTP transport
- Added the upstream provider that served a request (`AssistantMessage.upstreamProvider`, e.g. OpenRouter's routed provider) as a `pi.gen_ai.response.upstream_provider` chat-span telemetry attribute, alongside the existing response id and time-to-first-chunk.

## [15.10.5] - 2026-06-08

### Removed

- Removed the `maxToolCallsPerTurn` option from `AgentOptions` and `AgentLoopConfig`, so assistant turns are no longer capped after a configured number of completed tool calls

### Fixed

- Fixed stalled aborted assistant responses so the run now stops without waiting for provider iterator cleanup and returns the aborted message promptly
- Fixed `afterToolCall` handling so it now runs for completed tool executions even after a run is aborted so tool post-processing still applies
- Fixed `agentLoopDetailed().detailed()` so run telemetry and coverage are captured before `stream.result()` resolves.
- Fixed agent-loop stream invariants so `agentLoopContinue` no longer mutates the caller's message array, emitted assistant events snapshot mutable provider content, terminal provider events win over late abort signals, transformed tool arguments are reflected consistently in hooks/events, and successful run-end telemetry fires from the same finalization path as failures.
- Fixed tool result parsing to mark assistant tool outputs with unsupported content block shapes as errors and include a diagnostic text block
- Fixed GPT-5 Harmony leakage handling by recovering valid leaked tool calls when possible and discarding leaked partial assistant output before retrying
- Fixed tool-call cancellation handling so aborted tools are marked aborted with an explicit reason and do not report generic errors
- Fixed tool-call completion so assistant messages on abort keep only completed tool-call blocks and continue processing tool calls when a length stop still included results
- Fixed deliberate aborts (TTSR rule matches, user-interrupt labels) so a mid-stream tool-call block that never reached `toolcall_end` is retained on the aborted assistant message and paired with a placeholder result labeled by the abort reason, instead of being dropped; anonymous aborts (bare `abort()`) still drop incomplete tool calls whose partial arguments are unsafe to replay
- Fixed runs that stopped with reason `length` after returning tool results so execution continues to handle additional tool calls

## [15.10.3] - 2026-06-08

### Added

- Added a non-interrupting "aside" message channel to the agent loop (`AgentLoopConfig.getAsideMessages` / `Agent.setAsideMessageProvider`). Asides are drained at each step boundary (after a tool batch, before the next model call) and at the yield check, so passive notifications (e.g. background-job completions, late LSP diagnostics) reach the model *between requests* without waiting for the agent to stop and without aborting in-flight tools the way steering does.

### Changed

- Changed core custom and hook messages to convert to `developer` messages for provider context.

### Fixed

- Fixed the compaction spinner freezing (only repainting on a terminal resize) when compacting very large codex/OpenAI contexts. `buildOpenAiNativeHistory` re-collected the full known/custom tool-call id sets on every history-bearing message, rescanning the entire growing native history each time — O(N²) in history items — which blocked the event loop for seconds and starved the loader's animation timer and render scheduler. The sets are now maintained incrementally (linear), so building the compaction request no longer monopolizes the main thread.

### Removed

- Removed the now-dead `<turn-aborted>` marker from the OpenAI compaction output user-message filter, since `transformMessages` no longer emits that note.
- Removed stale synthetic user-message tag filters from OpenAI remote compaction output preservation; developer messages are now dropped by role instead.
- Tool executions now receive the active turn `AbortSignal` unconditionally.

## [15.10.2] - 2026-06-08

### Fixed

- Fixed proxy stream silently returning a zero-token success response when the server disconnects without sending a `done` or `error` terminal SSE event. The stream now throws an error, surfacing the disconnect as an `error` event with `stopReason: "error"` and resolving `finalResultPromise`, instead of defaulting to `stopReason: "stop"` with empty content and leaving `stream.result()` callers hanging indefinitely.

## [15.10.1] - 2026-06-07

### Added

- Added optional `promptCacheKey` support to `AgentOptions` and `Agent` via a new `promptCacheKey` property so providers can receive a caller-provided prompt cache key
- Added optional `ApiKeyResolveContext` parameter to `getApiKey` in `AgentOptions` and `AgentLoopConfig` so key resolvers can receive retry context

### Changed

- Enabled streaming API calls to re-resolve credentials through the `getApiKey` callback when retries occur after authentication-related errors
- `Agent.abort(reason?)` now forwards `reason` to the underlying `AbortController`, and the synthesized aborted assistant message carries that reason on `errorMessage` (string or non-`AbortError` `Error` message) instead of always defaulting to `"Request was aborted"`. Bare `abort()` is unchanged.

### Fixed

- Fixed handling of short-lived API keys so that expired tokens are retried with a refreshed value during 401/usage-limit failures
- Ensured fallback API key resolution uses the initially configured static `apiKey` when `getApiKey` is present
- Wrapped oneshot LLM completions (`instrumentedCompleteSimple`: handoff, compaction/branch summaries) in an `EventLoopKeepalive`. These run outside the agent `#runLoop`, so without the keepalive Bun's event loop stopped servicing timers while parked on the completion promise — freezing host spinners (e.g. the `/handoff` loader) until an unrelated terminal resize poked the loop into rendering again.

## [15.9.5] - 2026-06-05

### Fixed

- Surfaced Anthropic stream failures whose message starts with `Output blocked by conten` as normal assistant error lifecycle events, so interactive clients render content-filter blocks instead of silently dropping the streaming bubble at `agent_end`.

## [15.8.3] - 2026-06-03

### Added

- Added `getReadToolPath(context)` to `@oh-my-pi/pi-agent-core/compaction/tool-protection` to extract a paired `read` tool call's `path` for embedders building read-targeted protection matchers
- Added `getReadToolPath(context)` to `@oh-my-pi/pi-agent-core/compaction/tool-protection`: the shared primitive that extracts a paired `read` tool call's `path` argument, so embedders can build their own read-targeted compaction protection matchers (e.g. plan-file reads) the same way `isSkillReadToolResult` does.

## [15.8.2] - 2026-06-03

### Added

- Added optional `AgentTool.matcherDigest(args)` hook: tools whose streamed arguments encode content in a wire grammar (patch formats, escaped strings) can expose the real content they introduce, so stream-content matchers (e.g. TTSR rules) run against plain source text instead of the wire format.

### Fixed

- Fixed the agent loop wedging the model when a `write`/`edit` tool call is truncated by `stop_reason: length` (e.g. an OpenCode Zen / Claude-3.5-Haiku turn that emits >~1000 lines of code, blowing past the 8K `max_tokens` output cap). The skipped tool result now surfaces an actionable hint — naming `stop_reason: length` and telling the model to split the payload into multiple smaller calls — instead of the generic "Tool call was not executed because the assistant ended its turn" placeholder, which left the auto-continue loop re-emitting the same oversized payload until the user gave up. Tools are still NOT executed when the arguments are truncated. ([#1785](https://github.com/can1357/oh-my-pi/issues/1785))

## [15.8.0] - 2026-06-02

### Fixed

- Engaged GPT-5 Harmony leak detection on the committed assistant message (openai-codex only). `detectHarmonyLeakInAssistantMessage` now runs on the streamed `done`/`error` result and the trailing fallback, so a leaked final response is aborted-and-retried by the existing mitigation instead of being committed as-is. Tool-argument (`tool_arg`) scanning is gated on the trailing-garbage `T` co-signal and only fires when a caller supplies a parse boundary via `detectHarmonyLeakInAssistantMessage`'s new optional `toolArgParseEnd` resolver. The agent loop passes none — it cannot bound a streamed tool DSL — so that surface stays inert and a legitimate codex tool call whose content legitimately carries `to=functions.*` next to a channel word or non-Latin script (e.g. editing the harmony fixtures) is never hard-aborted.

## [15.7.4] - 2026-05-31

### Removed

- Removed the local-model `summarizeShakeRegions` compressor and related shake-summary prompt/types; shake now only provides mechanical artifact-backed elision primitives.

## [15.7.3] - 2026-05-31

### Added

- Added `shake` compaction primitives (`collectShakeRegions`, `applyShakeRegion`, `applyShakeRegions`, `summarizeShakeRegions`, `DEFAULT_SHAKE_CONFIG`, `AGGRESSIVE_SHAKE_CONFIG`, plus the `ShakeRegion`/`ShakeConfig`/`ShakeSummaryItem`/`ShakeSummaryComplete`/`ProtectedToolMatcher` types) under `@oh-my-pi/pi-agent-core/compaction`. These detect heavy context regions — whole tool-call results plus large fenced/XML blocks — and either elide them with placeholders or extractively compress them through an injected completion backend (no LLM summary cut-point). The compressor is provider-agnostic: callers wire it to a local on-device model. Pure detection/mutation; no I/O.

### Fixed

- Fixed tool-output pruning and shake protection for `read`: ordinary file/URL reads are now eligible for compaction, while `read` calls whose `path` starts with `skill://` remain protected like native `skill` results.

## [15.5.15] - 2026-05-30

### Added

- Added `maxToolCallsPerTurn` to `AgentLoopConfig`/`AgentOptions`, allowing callers to cut a streamed assistant turn after a completed tool-call batch and execute the runnable partial turn instead of waiting for the provider to yield.

### Fixed

- Normalized `maxToolCallsPerTurn` to accept only positive integer limits, with non-finite or non-positive values treated as disabled

## [15.5.14] - 2026-05-29

### Fixed

- Fixed the agent loop abandoning tool calls that Anthropic adaptive/interleaved-thinking models (e.g. Opus) emit under `stop_reason: "end_turn"`. The previous gate only ran tools when `stopReason === "toolUse"`, so an `end_turn`+tool_use turn produced "Tool call was not executed because the assistant ended its turn" placeholders, made no progress, and could trap the model in a re-emit/abandon loop. `stop_reason` is never replayed on the wire and (verified against the live Anthropic Messages API) does not gate continuation validity, so `stop`/`end_turn` turns carrying tool_use blocks are now executed and the loop continues — exactly like `toolUse`. Only `length` (max_tokens truncation) still abandons, since the trailing tool call may have incomplete arguments. The continuation stays valid because `transformMessages` strips the now-untrustworthy thinking signature and the encoder downgrades the block to text.

## [15.5.10] - 2026-05-28

### Fixed

- Fixed compaction summarizer throws losing the provider's HTTP status. `generateSummary`, `generateHandoff`, `generateShortSummary`, and `generateTurnPrefixSummary` now route their `stopReason === "error"` throws through a `createSummarizationError` helper that copies `AssistantMessage.errorStatus` onto the thrown `Error` as `.status`, letting downstream consumers (e.g. `AgentSession.#isCompactionAuthFailure` in `@oh-my-pi/pi-coding-agent`) branch on real provider 401/403s without regex-scraping the message body.

## [15.5.0] - 2026-05-26

### Added

- Added `approval` support to `AgentTool` declarations with the new `ToolTier` and `ToolApproval` APIs, allowing tools to declare capability tiers (`read`, `write`, or `exec`) and optional override/reason metadata for approval gating
- Added `formatApprovalDetails` on `AgentTool` to append custom detail text or lines to approval prompts
- Added exported `ToolTier` and `ToolApproval` type aliases for tool approval declarations

### Fixed

- Fixed chat-request telemetry storing the raw scoped `serviceTier` value (`"openai-only"`/`"claude-only"`) in `OpenAIAttr.RequestServiceTier` instead of the resolved wire value (`"priority"`). Dashboards and alerts filtering on the concrete tier name (`service_tier == "priority"`) were broken by the scoped placeholder; `buildChatRequestAttributes` now runs the tier through `resolveServiceTier(serviceTier, provider)` before recording, keeping the `shouldSendServiceTier` gate intact so non-OpenAI providers continue to omit the attribute entirely.

## [15.3.0] - 2026-05-25

### Fixed

- Fixed `transformContext` receiving the loop config object as the `signal` argument instead of the actual `AbortSignal`, so hooks that check `signal.aborted` or call `signal.addEventListener` now work correctly under abort/timeout conditions
- Fixed `appendOnlyContext` not being re-evaluated after `setModel()` — the mode was decided once at session construction based on the initial model's provider, so switching from/to DeepSeek (or changing `provider.appendOnlyContext`) mid-session produced incorrect mode behavior

## [15.2.3] - 2026-05-22

### Added

- Added `onBeforeYield` hook support so user code can run right before the agent loop checks for follow-up messages

## [15.1.3] - 2026-05-17

### Added

- Added optional `telemetry` support to `generateSummary`, `generateHandoff`, `generateBranchSummary`, and `compact` options so compaction, handoff, and branch summary one-shot LLM calls can emit OpenTelemetry chat telemetry when enabled
- Added shared oneshot telemetry instrumentation for compaction, handoff, and branch summary calls, tagging spans with `pi.gen_ai.oneshot.kind` values such as `compaction_summary`, `compaction_short_summary`, `compaction_turn_prefix`, `handoff`, and `branch_summary`

## [15.1.2] - 2026-05-15

### Added

- Added `responseHeaders` to `ChatUsageEvent` and `ManualChatTelemetryOptions` so telemetry hooks receive captured lowercase upstream response headers for each chat span
- Added automatic gateway/proxy detection from response headers (`litellm`, `helicone`, `portkey`, `openrouter`) and stamped `pi.gen_ai.gateway.*` span attributes for detected routing metadata
- Added exported `detectGatewayFromHeaders` API for header-based gateway detection

## [15.1.0] - 2026-05-15

### Breaking Changes

- Removed the `@oh-my-pi/pi-agent-core/compaction/handoff` exports from the package surface, including `extractHandoffDocument`, `createHandoffContext`, and `createHandoffFileName`
- Removed legacy telemetry constants from the public enum surface (including `AGGREGATE_ATTR`, `GenAIAttr.System`, and old `gen_ai.*` extension keys such as `gen_ai.request.service_tier`/cost/tool status/handoff fields) and replaced them with `OpenAIAttr`, `PiGenAIAttr`, and `PiGenAIAggregateAttr`

### Added

- Added `generateHandoff(messages, model, apiKey, options)` to `@oh-my-pi/pi-agent-core/compaction` to generate a handoff document by calling the model directly, using live system/tool context and optional metadata
- Added generation filtering so the returned handoff document now includes only text content blocks from the model output
- Added support for defining `AgentTool` schemas with Zod, with legacy TypeBox schemas still supported when generating tool schemas for model calls
- Added `OpenAIAttr`, `PiGenAIAttr`, and `PiGenAIAggregateAttr` exports so consumers can reference the new `openai.*` and `pi.gen_ai.*` telemetry attribute keys directly
- Added `onChatUsage` to `AgentTelemetryConfig`, an always-fired hook receiving a `ChatUsageEvent` for every chat step that produced usage. The event carries the chat `span`, `agent`, `conversationId`, `stepNumber`, `model`, `provider`, `serviceTier`, `usage`, optional `cost`, and resolved dynamic `attributes` — independent of whether a `costEstimator` is configured.
- Added `agentLoopDetailed(...)` and `agentLoopContinueDetailed(...)` helpers that return the same event stream plus a `detailed()` result with run `telemetry` and `coverage`
- Added `onRunEnd` to `AgentTelemetryConfig` to receive `AgentRunSummary` and `AgentRunCoverage` at the end of each invocation
- Added run-level telemetry and coverage types/helpers (for example `AgentRunSummary`, `AgentRunCoverage`, `aggregateAgentRunSummaries`, and `aggregateAgentRunCoverage`) to package exports
- Added generic telemetry extension hooks for dynamic span attributes, provider/agent-name normalization, per-step cost deltas, warning callbacks, bounded summary content capture, and manual chat telemetry for non-loop model calls.
- Added opt-in OpenTelemetry instrumentation on the agent loop. Pass `telemetry: {}` (or a richer `AgentTelemetryConfig`) on `AgentLoopConfig` / `AgentOptions` / `createAgentSession({ telemetry })` to emit GenAI-semantic-convention spans plus `pi.gen_ai.*` extension attributes:
- `invoke_agent {agent.name}` wraps each `agentLoop` invocation with `gen_ai.operation.name=invoke_agent`, agent identity, conversation id, and `pi.gen_ai.agent.step.count`.
- `chat {model}` per provider call, parented under `invoke_agent`, with OTEL request/response/usage attributes (`gen_ai.request.{model,stream,temperature,top_p,top_k,max_tokens,presence_penalty,stop_sequences}`, `gen_ai.response.{model,id,finish_reasons,time_to_first_chunk}`, `gen_ai.usage.{input_tokens,output_tokens,cache_read.input_tokens,cache_creation.input_tokens,reasoning.output_tokens}`) and project extensions for reasoning effort, tool choice, available tools, usage totals, and cost.
- `execute_tool {tool.name}` per tool call, parented under `invoke_agent`, with `gen_ai.tool.{name,call.id,description,type}` plus the active context so user/MCP/provider spans created inside `tool.execute()` attach as children.
- One-shot `handoff` span available via the public `recordHandoff(...)` helper for agent-to-agent transitions.
- Added `AgentTelemetryConfig` hooks (`onSpanStart`, `onSpanEnd`, `costEstimator`), `agent` identity, `attributes` envelope merged onto every span, `captureMessageContent` toggle (defaults to the `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` env var) emitting OTEL-shaped `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions` / `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result`, and tracer/tracerName override surfaces.
- Added `Agent#setTelemetry(config)` so consumers can swap or disable instrumentation between invocations.
- Added `@opentelemetry/api` as a runtime dependency; SDK setup (exporters, samplers, processors) remains the host's responsibility per standard OTEL conventions. When no SDK is registered, helpers fall through to no-op spans with zero overhead.
- Added compaction APIs under `@oh-my-pi/pi-agent-core/compaction`, including context compaction, branch summarization, handoff prompt/context helpers, pruning, token budgeting, prompt templates, and OpenAI `/responses/compact` helpers.

### Changed

- Changed handoff document generation to force `toolChoice: "none"` when calling the model so tool invocation is disabled during generation
- Changed `chat` spans to emit normalized provider identifiers in `gen_ai.provider.name` via OTEL-style values (for example `google` to `gcp.gemini`) instead of the legacy `gen_ai.system` label
- Changed service-tier telemetry to emit `openai.request.service_tier`/`openai.response.service_tier` only when supported by provider via `shouldSendServiceTier`, rather than always using `gen_ai.request.service_tier`
- Changed captured message payloads so full capture now records OTEL-structured message parts with `pi.gen_ai.request.messages`, `pi.gen_ai.system_instructions`, and `gen_ai.output.messages` including assistant `finish_reason`
- Changed the `agent_end` event payload to include optional `telemetry` and `coverage` fields when telemetry is enabled, while keeping the legacy payload shape when disabled
- Changed `invoke_agent` spans to include aggregate `pi.gen_ai.agent.*` attributes for chat/tool counts, latency, usage, cost, errors, and tool coverage

### Fixed

- Fixed intent-field injection for tool schemas defined with Zod by converting them to wire schema before mutation
- Fixed token accounting in `ChatUsageEvent` and usage summaries so `inputTokens` and `totalTokens` now include cached read/write input tokens
- Fixed `execute_tool` span attributes so `pi.gen_ai.tool.status` and `error.type` now reflect run-level tool outcomes (`ok`, `error`, `skipped`, `blocked`, `timeout`, `aborted`) instead of mapping all non-ok cases the same way
- Fixed `onRunEnd` callbacks to be safe and idempotent by invoking them once per run and swallowing thrown callback errors so they cannot fail or duplicate successful runs
- Fixed run telemetry to count interrupted, blocked, or otherwise skipped tool calls so run coverage and tool counters now include those paths
- Fixed chat failure handling so failed chat steps are still represented in run summaries when provider streaming throws before yielding an assistant message
- Fixed double-counting of interrupted tool calls in run summaries: the `runTool` early-return on a queued steering interrupt now defers to the post-batch tail sweep so each call is recorded exactly once
- Fixed `coverage.toolsInvoked` and run-summary tool counters under-reporting tool calls embedded in an aborted/errored assistant message — those calls now record a collector orphan with status `aborted` or `error`
- Fixed `AgentRunSummary.usage.inputTokens` so it now includes `cache_read` and `cache_write` input tokens, matching `ChatUsageEvent.inputTokens`
- Fixed span lifecycle hooks (`onSpanStart`, `onSpanEnd`) so a thrown user callback is caught and surfaced via `onTelemetryWarning` (`on_span_start_failed` / `on_span_end_failed`) instead of leaking and aborting the surrounding span
- Fixed unbounded recursion in summary content capture when a captured value contains a cyclic or deeply nested array — array recursion now respects the same depth cap as plain-object recursion and replaces back-references with `"[Circular]"`

## [15.0.1] - 2026-05-14

### Breaking Changes

- Raised the minimum required Bun version from >=1.3.7 to >=1.3.14

## [14.9.5] - 2026-05-12

### Added

- Added an `isError?: boolean` field on `AgentToolResult` so tools can flag a non-throwing failure (e.g. an aggregator that catches per-entry errors). `coerceToolResult` preserves the flag and the agent loop surfaces it as a tool error on the wire.

## [14.9.3] - 2026-05-10

### Added

- Added `onHarmonyLeak` option on `Agent`/loop config to receive GPT-5 Harmony leak audit callbacks
- Added harmony-leak detection and audit exports to the package index for programmatic leak detection and recovery hooks

### Changed

- Changed OpenAI Codex model runs to detect GPT-5 Harmony protocol leakage during streaming and automatically retry or recover tool calls instead of sending contaminated arguments downstream

### Security

- Hardened tool-call handling against leaked `to=functions.*` protocol tails by truncating or retrying before execution
- Hardened failure handling so repeated GPT-5 Harmony leak mitigation is retried only up to two times before escalating to an explicit error

## [14.9.0] - 2026-05-10

### Added

- Added `Agent#metadata` field forwarded to every API request; callers can set arbitrary provider metadata (e.g. `metadata.user_id`) once and have it applied to all subsequent stream calls without modifying per-call options
- Added `Agent#setMetadataResolver(fn)` for installing a function that resolves request metadata at call time. The `metadata` getter dispatches through the resolver on every read (including the snapshot taken per `prompt()`), so callers reflect mutable external state (e.g. live OAuth account UUID after a token refresh) without manual re-syncs. Plain `agent.metadata = …` continues to set a static value and clears any installed resolver.
- Added an `onSseEvent` agent option and loop config forwarding path for raw provider SSE diagnostics.

## [14.7.6] - 2026-05-07

### Added

- Added `hideThinkingSummary` option/getter/setter on `Agent` and `AgentLoopConfig`. Forwarded to the underlying stream call so providers can omit reasoning/thinking summaries on demand.

## [14.7.2] - 2026-05-06

### Added

- Added `loadMode` option to `AgentTool` to mark built-in tools as `essential` for initial loading or `discoverable` for search activation
- Added optional `summary` field to `AgentTool` definitions for one-line text used in tool discovery indexes

## [14.7.0] - 2026-05-04

### Breaking Changes

- Changed `Agent` API types so `systemPrompt` is now a list of prompt strings, requiring callers to pass and update system prompts via string arrays

### Changed

- Removed automatic project-context injection into each model call from loop logic

### Removed

- Removed the `projectPrompt` field from agent state/context and the `setProjectPrompt` mutator

## [14.6.2] - 2026-05-03

### Fixed

- Fixed unhandled promise rejection when `getApiKey` or any other async error occurs during `streamAssistantResponse`: agent loop IIFEs now catch and route errors through `EventStream.fail()`, which terminates the `for await` loop and lets `Agent#runLoop`'s catch block create a proper error assistant message instead of crashing

## [14.6.0] - 2026-05-02

### Fixed

- Fixed request cancellation before provider events by emitting an aborted assistant message and ending the stream with `stopReason: "aborted"`

## [14.5.10] - 2026-04-30

### Added

- Added an `onResponse` stream option for observing provider response metadata after response headers arrive.

## [14.2.0] - 2026-04-23

### Changed

- Changed tool dispatch to match model-returned tool calls by either internal tool name or custom wire name, enabling custom OpenAI tool names such as `apply_patch`.

## [14.0.1] - 2026-04-08

### Added

- Added `onAssistantMessageEvent` callback option to inspect assistant streaming events before they are emitted, enabling abort decisions before buffered events continue flowing
- Added `setAssistantMessageEventInterceptor()` method to dynamically set or update the assistant message event interceptor

## [13.13.0] - 2026-03-18

### Added

- Added `startup.checkUpdate` setting, set to `true` by default, can be disabled to skip the update check on agent initialization

## [13.12.7] - 2026-03-16

### Added

- Added overload for `prompt()` method accepting a string input with optional options parameter

### Fixed

- Fixed stale forced toolChoice being passed to provider after tools are refreshed mid-turn

## [13.9.16] - 2026-03-10

### Added

- Added `onPayload` option to `AgentOptions` to inspect or replace provider payloads before they are sent

## [13.9.3] - 2026-03-07

### Added

- Exported `ThinkingLevel` selector constants and types for configuring agent reasoning behavior
- Added `inherit` thinking level option to defer reasoning configuration to higher-level selectors
- Added `serviceTier` option to configure service tier for agent requests

### Changed

- Changed `thinkingLevel` from required string to optional `Effort` type, allowing undefined state
- Updated `setThinkingLevel()` method to accept `Effort | undefined` instead of `ThinkingLevel` string

## [13.4.0] - 2026-03-01

### Added

- Added `getToolChoice` option to dynamically override tool choice per LLM call

## [13.3.8] - 2026-02-28

### Changed

- Changed intent field name from `agent__intent` to `_i` in tool schemas

### Fixed

- Fixed synthetic tool result text formatting so aborted/error tool results no longer emit `Tool execution was aborted.: Request was aborted` style punctuation.

## [13.3.7] - 2026-02-27

### Added

- Added `lenientArgValidation` option to tools to allow graceful handling of argument validation errors by passing raw arguments to execute() instead of returning an error to the LLM

## [13.3.1] - 2026-02-26

### Added

- Added `topP`, `topK`, `minP`, `presencePenalty`, and `repetitionPenalty` options to `AgentOptions` for fine-grained sampling control
- Added getter and setter properties for sampling parameters on the `Agent` class to allow runtime configuration

## [13.1.0] - 2026-02-23

### Changed

- Removed per-tool `agent__intent` field description from injected schema to reduce token usage; intent format is now documented once in the system prompt instead of repeated in every tool definition

## [12.19.0] - 2026-02-22

### Changed

- Updated tool result messages to include error details when tool execution fails

## [12.14.0] - 2026-02-19

### Added

- Added `intentTracing` option to enable intent goal extraction from tool calls, allowing models to specify high-level goals via a required `_intent` field that is automatically injected into tool schemas and stripped from arguments before execution

## [12.11.0] - 2026-02-19

### Added

- Exported `AgentBusyError` exception class for handling concurrent agent operations

### Changed

- Agent now throws `AgentBusyError` instead of generic `Error` when attempting concurrent operations

## [12.8.0] - 2026-02-16

### Added

- Added `transformToolCallArguments` option to `AgentOptions` and `AgentLoopConfig` for transforming tool call arguments before execution (e.g. secret deobfuscation)

## [12.2.0] - 2026-02-13

### Added

- Added `providerSessionState` option to share provider state map for session-scoped transport and session caches
- Added `preferWebsockets` option to hint that websocket transport should be preferred when supported by the provider implementation

## [11.10.0] - 2026-02-10

### Added

- Added `temperature` option to `AgentOptions` to control LLM sampling temperature
- Added `temperature` getter and setter to `Agent` class for runtime configuration

## [11.6.0] - 2026-02-07

### Added

- Added `hasQueuedMessages()` method to check for pending steering/follow-up messages
- Resume queued steering and follow-up messages from `continue()` after auto-compaction

### Changed

- Extracted `dequeueSteeringMessages()` and `dequeueFollowUpMessages()` from inline config callbacks
- Added `skipInitialSteeringPoll` option to `_runLoop()` for correct queue resume ordering

## [11.3.0] - 2026-02-06

### Added

- Added `maxRetryDelayMs` option to AgentOptions to cap server-requested retry delays, allowing higher-level retry logic to handle long waits with user visibility

### Changed

- Updated ThinkingLevel documentation to include support for gpt-5.3 and gpt-5.3-codex models with 'xhigh' thinking level

## [11.2.0] - 2026-02-05

### Fixed

- Fixed handling of aborted requests to properly throw abort errors when stream terminates without a terminal event

## [10.5.0] - 2026-02-04

### Added

- Added `concurrency` option to `AgentTool` to control tool scheduling: "shared" (default, runs in parallel) or "exclusive" (runs alone)
- Implemented parallel execution of shared tools within a single agent turn for improved performance

### Changed

- Refactored tool execution to support concurrent scheduling with proper interrupt handling and steering message checks

## [9.2.2] - 2026-01-31

### Added

- Added toolChoice option to AgentPromptOptions for controlling tool selection

## [8.2.0] - 2026-01-24

### Changed

- Updated TypeScript configuration for better publish-time configuration handling with tsconfig.publish.json

## [8.0.0] - 2026-01-23

### Added

- Added `nonAbortable` option to tools to ignore abort signals during execution

## [6.8.0] - 2026-01-20

### Changed

- Updated proxy stream processing to use utility function for reading lines

## [6.2.0] - 2026-01-19

### Added

- Enhanced getToolContext to receive tool call batch information including batchId, index, total count, and tool call details

## [5.6.7] - 2026-01-18

### Fixed

- Added proper tool result messages for tool calls that are aborted or error out
- Ensured tool_use/tool_result pairing is maintained when tool execution fails

## [4.6.0] - 2026-01-12

### Changed

- Modified assistant message handling to split messages around tool results for improved readability when using Cursor tools

### Fixed

- Fixed tool result ordering in Cursor mode by buffering results and emitting them at the correct position within assistant messages

## [4.3.0] - 2026-01-11

### Added

- Added `cursorExecHandlers` and `cursorOnToolResult` options for local tool execution with cursor-based streaming
- Added `emitExternalEvent` method to allow external event injection into the agent state

## [4.0.0] - 2026-01-10

### Added

- Added `popLastSteer()` and `popLastFollowUp()` methods to remove and return the last queued message (LIFO) for dequeue operations
- `thinkingBudgets` option on `Agent` and `AgentOptions` to customize token budgets per thinking level
- `sessionId` option on `Agent` to forward session identifiers to LLM providers for session-based caching

### Fixed

- `minimal` thinking level now maps to `minimal` reasoning effort instead of being treated as `low`

## [3.33.0] - 2026-01-08

### Fixed

- Ensured aborted assistant responses always include an error message for callers.
- Filtered thinking blocks from Cerebras request context to keep multi-turn prompts compatible.

## [3.21.0] - 2026-01-06

### Changed

- Switched from local `@oh-my-pi/pi-ai` to upstream `@mariozechner/pi-ai` package

### Added

- Added `sessionId` option for provider caching (e.g., OpenAI Codex session-based prompt caching)
- Added `sessionId` getter/setter on Agent class for runtime session switching

## [3.20.0] - 2026-01-06

### Breaking Changes

- Replaced `queueMessage`/`queueMode` with steering + follow-up queues: use `steer`, `setSteeringMode`, and `getSteeringMode` for mid-run interruptions, and `followUp`, `setFollowUpMode`, and `getFollowUpMode` for post-turn messages
- Agent loop callbacks now use `getSteeringMessages` and `getFollowUpMessages` instead of `getQueuedMessages`

### Added

- Added follow-up message queue support so new user messages can continue a run after the agent would otherwise stop
- Added `RenderResultOptions.spinnerFrame` for animated tool-result rendering

### Changed

- `prompt()` and `continue()` now throw when the agent is already streaming; use steering or follow-up queues instead

## [3.4.1337] - 2026-01-03

### Added

- Added `popMessage()` method to Agent class for removing and retrieving the last message
- Added abort signal checks during response streaming for faster interruption handling

### Fixed

- Fixed abort handling to properly return aborted message state when stream is interrupted mid-response

## [1.341.0] - 2026-01-03

### Added

- Added `interruptMode` option to control when queued messages interrupt tool execution.
- Implemented "immediate" mode (default) to check queue after each tool and interrupt remaining tools.
- Implemented "wait" mode to defer queue processing until the entire turn completes.
- Added getter and setter methods for `interruptMode` on Agent class.

## [1.337.1] - 2026-01-02

### Changed

- Forked to @oh-my-pi scope with unified versioning across all packages

## [1.337.0] - 2026-01-02

Initial release under @oh-my-pi scope. See previous releases at [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

## [0.38.0] - 2026-01-08

### Added

- `thinkingBudgets` option on `Agent` and `AgentOptions` to customize token budgets per thinking level ([#529](https://github.com/badlogic/pi-mono/pull/529) by [@melihmucuk](https://github.com/melihmucuk))

## [0.37.3] - 2026-01-06

### Added

- `sessionId` option on `Agent` to forward session identifiers to LLM providers for session-based caching.

## [0.37.0] - 2026-01-05

### Fixed

- `minimal` thinking level now maps to `minimal` reasoning effort instead of being treated as `low`.

## [0.32.0] - 2026-01-03

### Breaking Changes

- **Queue API replaced with steer/followUp**: The `queueMessage()` method has been split into two methods with different delivery semantics ([#403](https://github.com/badlogic/pi-mono/issues/403)):
  - `steer(msg)`: Interrupts the agent mid-run. Delivered after current tool execution, skips remaining tools.
  - `followUp(msg)`: Waits until the agent finishes. Delivered only when there are no more tool calls or steering messages.
- **Queue mode renamed**: `queueMode` option renamed to `steeringMode`. Added new `followUpMode` option. Both control whether messages are delivered one-at-a-time or all at once.
- **AgentLoopConfig callbacks renamed**: `getQueuedMessages` split into `getSteeringMessages` and `getFollowUpMessages`.
- **Agent methods renamed**:
  - `queueMessage()` → `steer()` and `followUp()`
  - `clearMessageQueue()` → `clearSteeringQueue()`, `clearFollowUpQueue()`, `clearAllQueues()`
  - `setQueueMode()`/`getQueueMode()` → `setSteeringMode()`/`getSteeringMode()` and `setFollowUpMode()`/`getFollowUpMode()`

### Fixed

- `prompt()` and `continue()` now throw if called while the agent is already streaming, preventing race conditions and corrupted state. Use `steer()` or `followUp()` to queue messages during streaming, or `await` the previous call.

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Transport abstraction removed**: `ProviderTransport`, `AppTransport`, and `AgentTransport` interface have been removed. Use the `streamFn` option directly for custom streaming implementations.
- **Agent options renamed**:
  - `transport` → removed (use `streamFn` instead)
  - `messageTransformer` → `convertToLlm`
  - `preprocessor` → `transformContext`
- **`AppMessage` renamed to `AgentMessage`**: All references to `AppMessage` have been renamed to `AgentMessage` for consistency.
- **`CustomMessages` renamed to `CustomAgentMessages`**: The declaration merging interface has been renamed.
- **`UserMessageWithAttachments` and `Attachment` types removed**: Attachment handling is now the responsibility of the `convertToLlm` function.
- **Agent loop moved from `@oh-my-pi/pi-ai`**: The `agentLoop`, `agentLoopContinue`, and related types have moved to this package. Import from `@oh-my-pi/pi-agent` instead.

### Added

- `streamFn` option on `Agent` for custom stream implementations. Default uses `streamSimple` from pi-ai.
- `streamProxy()` utility function for browser apps that need to proxy LLM calls through a backend server. Replaces the removed `AppTransport`.
- `getApiKey` option for dynamic API key resolution (useful for expiring OAuth tokens like GitHub Copilot).
- `agentLoop()` and `agentLoopContinue()` low-level functions for running the agent loop without the `Agent` class wrapper.
- New exported types: `AgentLoopConfig`, `AgentContext`, `AgentTool`, `AgentToolResult`, `AgentToolUpdateCallback`, `StreamFn`.

### Changed

- `Agent` constructor now has all options optional (empty options use defaults).
- `queueMessage()` is now synchronous (no longer returns a Promise).
