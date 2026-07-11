# Provider endpoint constraints

Provider integrations are not interchangeable just because they speak an
OpenAI-shaped HTTP protocol. A request is shaped by four layers at once:

1. endpoint family: `openai-completions`, `openai-responses`,
   `openai-codex-responses`, `anthropic-messages`, etc.
2. gateway/auth surface: OpenRouter, Vercel AI Gateway, Azure OpenAI, Copilot,
   Alibaba Coding Plan, Kimi Code, Fireworks/Firepass, and similar hosts
3. model metadata and `compat` overrides
4. request context: tools, images, reasoning mode, stateful session, service tier

Use this page when adding a provider, adding a compat flag, or moving logic out
of a provider-specific branch. The goal is to encode endpoint constraints once,
at the narrowest layer that actually owns the behavior.

Related references:

- [Providers](./providers.md) — provider availability, credentials, custom providers
- [Model and Provider Configuration](./models.md) — `models.yml`, routing, and compat fields
- [Provider streaming internals](./provider-streaming-internals.md) — stream event normalization
- [Adding a provider](./adding-a-provider.md) — catalog/auth wiring for a new provider

## Baseline rules

- Prefer compat metadata over provider-name branches when behavior is model or
  endpoint configurable.
- Keep transport mechanics transport-local. Codex websocket replay, Responses
  item routing, and Chat Completions SSE decoding are protocol behavior, not
  generic compat flags.
- Scope fallbacks to the failing capability. A strict-tool failure should not
  disable unrelated features. A stale Responses chain should reset chain state,
  not disable Responses entirely.
- Do not emit defaults that alter gateway routing. OpenRouter is the known case
  for default `max_tokens`, but any gateway can treat optional fields as routing
  hints.
- Stop retrying after visible side effects. Once text or a tool call is visible
  to the user/session, retry policy must avoid duplicate output and duplicate
  tool execution.

## 1. Choose the endpoint family first

### OpenAI Chat Completions compatible

Preserve these differences instead of treating every host as stock OpenAI:

- `stream_options.include_usage` is only safe when compat says streaming usage
  is supported.
- `store: false` is accepted only by some hosts.
- max-output caps use either `max_tokens` or `max_completion_tokens`.
- stop sequences and frequency penalty live on this path among the current
  OpenAI-like endpoint set.
- OpenRouter-style reasoning and routing fields are not portable to other
  OpenAI-compatible hosts unless compat says so.

### OpenAI Responses compatible

Responses request shape is its own dialect:

- uses `input`, `instructions`, `store`, `prompt_cache_key`, optional
  `previous_response_id`, and `max_output_tokens`
- can default official OpenAI requests to stateful chaining with
  `previous_response_id` plus `store: true`
- third-party Responses proxies may reject native reasoning history, encrypted
  reasoning replay, or `previous_response_id`
- stream completion is authoritative only after `response.completed` or
  `response.incomplete`; a stream close before either terminal event should fail
  for OpenAI Responses rather than surface partial output as success

### OpenAI Codex Responses

Codex is not plain Responses with a different URL. Keep these as Codex transport
policy:

- Codex account headers and beta headers
- `x-codex-turn-state` and `x-models-etag`
- optional websocket transport plus SSE fallback
- `responsesLite`
- prompt-cache/session ids used as transport state
- websocket-only `previous_response_id` chaining; SSE never chains
- Codex retry/replay rules, including reconnect and SSE replay boundaries
- provider retry only before user-visible content has been emitted
- whitespace-only tool-call argument loop breaker

Codex intentionally does not forward caller max-token caps because the backend
rejects them.

### Anthropic/OpenAI dual-surface providers

Kimi Code and Synthetic can be called as OpenAI-compatible or
Anthropic-compatible. The shim may need to:

- switch `format`
- rebuild an Anthropic model when needed
- map internal reasoning to Anthropic thinking budgets
- delegate back to OpenAI Completions

Do not encode these as one-way provider migrations; they are runtime surface
selection decisions.

## 2. Apply gateway and auth overlays

These constraints sit above the endpoint family. They affect auth, headers,
routing, model ids, or usage accounting.

### Azure OpenAI

- Chat Completions base URL reshapes to
  `/deployments/{deployment}/chat/completions?api-version=...`.
- Deployment names may differ from model ids through
  `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`.

### GitHub Copilot

- The API key is parsed into an access token.
- Dynamic Copilot headers depend on messages/images.
- `premiumRequests` must survive usage population and replacement.
- Base URL may be resolved from the raw key.

### OpenRouter

- Adds attribution/cache headers.
- Supports routing suffixes such as `:nitro` and `:floor`.
- Appends a routing suffix only when the model id has no explicit suffix after
  the last provider path segment.
- Uses nested `reasoning` request fields.
- Routes providers through the OpenRouter `provider` object.
- Has special cache-write usage accounting.
- Has strict-tool fallback for Anthropic grammar-size failures.
- Should omit catalog-default `max_tokens` unless the caller explicitly set a
  cap, so upstream routing is not biased.

### Vercel AI Gateway

- Routing preferences go under `providerOptions.gateway.only` and
  `providerOptions.gateway.order`.
- Do not reuse OpenRouter's `provider` object.

### Alibaba Coding Plan

- API key bytes may be JSON carrying `{ token, enterpriseUrl }`.
- Auth and base URL resolution are provider-specific.

### Kimi Code

- The OpenAI-compatible path needs common Kimi headers.
- It also participates in the OpenAI/Anthropic dual-surface shim.

### Fireworks and Firepass

- Wire model ids need provider-specific mapping.
- Fireworks can conflict when DeepSeek-style `thinking` and OpenAI-style
  `reasoning_effort` are both present after extra body fields are merged.

## 3. Serialize request parameters by dialect

Check these before adding or forwarding a field:

- **Model id.** Some models resolve a wire id from reasoning effort.
  Firepass/Fireworks transform ids. OpenRouter suffix handling is path-segment
  aware.
- **Max output tokens.** Kimi-family models may require a max-token field even
  when the caller did not set one. OpenRouter should omit catalog defaults unless
  explicit. Codex drops caller caps. Responses uses `max_output_tokens`; Chat
  Completions uses `max_tokens` or `max_completion_tokens`.
- **Service tier.** Completions, Responses, and Codex all handle service tiers,
  but allowed values and pricing multipliers differ. Codex has a special
  priority multiplier for `gpt-5.5`.
- **Prompt cache/session.** OpenAI Responses uses `prompt_cache_key`.
  OpenRouter Responses uses `session_id`. Codex uses prompt cache/session ids for
  transport state. Anthropic-style cache control requires `cache_control` on a
  text part.
- **Stateful chaining.** Official OpenAI Responses may chain by default.
  Third-party endpoints generally should not. Codex chains only on websocket
  `response.create`.

## 4. Map reasoning and thinking explicitly

Reasoning fields are not interchangeable.

### OpenAI-style `reasoning_effort`

- Effort values come from compat/model metadata.
- If reasoning is disabled but the host has no real off switch, map to the
  lowest supported effort rather than inventing an unsupported value.

### Responses `reasoning`

- Uses `reasoning: { effort, summary }`.
- Can include `reasoning.encrypted_content` for replay.
- xAI Grok models may require omitting `reasoning.effort`.
- Some compat paths inject the GPT-5 `# Juice: 0 !important` developer scaffold.

### OpenRouter `reasoning`

- Uses nested `reasoning: { effort }`.
- Disabling reasoning must send `reasoning: { enabled: false }`; OpenRouter can
  otherwise default reasoning models into thinking.

### Z.AI / GLM

- Uses `thinking: { type: "enabled" }` or
  `thinking: { type: "disabled" }`.
- GLM 5.2 reasoning-effort models may also receive `reasoning_effort`.
- Tool requests need `tool_stream: true`.

### Qwen

- One dialect uses top-level `enable_thinking`.
- Another uses `chat_template_kwargs.enable_thinking`.

### Anthropic-compatible format

- Reasoning maps to Anthropic thinking enablement and thinking-budget tokens,
  not OpenAI-style fields.

### DeepSeek reasoning history

- DeepSeek-compatible reasoning models may require exact `reasoning_content`
  replay.
- Some variants require replay on every assistant turn, not only tool-call turns.
- Synthetic `"."` placeholders are acceptable for Kimi/OpenRouter-style compat,
  but not DeepSeek V4 exact replay.

### Reasoning plus tool choice

- DeepSeek reasoning models can reject `tool_choice` while thinking is enabled.
- Kimi can reject forced tool choice while thinking is enabled.
- Compat needs both policies: disable reasoning for any tool choice, and disable
  reasoning only for forced tool choice.

### xAI Grok through Responses/SuperGrok

Keep these independent:

- omit `reasoning.effort`
- include or drop encrypted reasoning replay
- filter reasoning-history wrappers

Some models reject only one of those fields; do not collapse them into one
"Grok mode" branch.

## 5. Normalize tools and schemas per endpoint

### Strict tools

Strict schemas are not a universal capability:

- some providers support strict tools
- some reject mixed strict/non-strict tools
- some reject strictified schemas
- OpenRouter Anthropic models can fail with “compiled grammar too large”

Retry-without-strict should be a compat recovery policy scoped to the current
session/provider path.

### Responses and Codex custom tools

Responses and Codex both support freeform custom grammar tools for `apply_patch`.
Custom grammar tools do not force request-level `parallel_tool_calls`; Codex
`responsesLite` separately disables request-level parallel tool calls whenever
tools are present. Responses additionally:

- sanitizes schemas differently
- quarantines invalid enum/const schema contradictions
- repairs orphan tool outputs into assistant notes
- synthesizes placeholder outputs for orphan tool calls

Codex applies its own request transformation before sending.

### Tool choice

Before emitting `tool_choice`:

- confirm the endpoint supports it
- downgrade forced choice to `auto` if forced choice is unsupported
- drop `tool_choice: "none"` when no tools are emitted
- drop forced named tool choice if that named tool was filtered out

### Anthropic through LiteLLM/Bedrock

- If history contains tool calls/results and `context.tools` is undefined, send
  `tools: []` as a sentinel.
- If `context.tools = []`, treat it as explicit opt-out and do not emit the
  sentinel.

### Mistral / Devstral

- Tool-call ids must be exactly 9 alphanumeric characters.
- Some flows need a synthetic assistant bridge after tool results before the next
  user message.

### Custom tool outputs

Responses/Codex must remember whether a call was `custom_tool_call`; the paired
output must then be `custom_tool_call_output`, not `function_call_output`.

### MiniMax-compatible streaming arguments

Tool arguments can stream as objects instead of JSON strings. Deep-merge object
deltas, then emit one final concat-safe JSON delta.

## 6. Convert messages and replay history safely

- **System/developer roles.** Reasoning models may require `developer`. Some
  providers do not support `developer` and must downgrade to `user`. Some reject
  multiple system messages and need coalescing.
- **Responses system prompts.** Responses usually uses top-level `instructions`.
  Reasoning models that support `developer` put system prompts inline as
  developer messages.
- **Assistant content.** Some OpenAI-compatible backends mirror array content
  literally, so assistant content is normalized to a string. Tool-call replay may
  require `content: ""` or `content: "."` instead of `null`.
- **Thinking replay.** Some models want thinking as visible text. Others need a
  provider-specific reasoning field. Some permit synthetic placeholders; others
  need exact replay.
- **Vision.** If the model/provider cannot accept images, convert image input and
  tool-result images to placeholders. Some Qwen/Dashscope-compatible modes are
  text-only even when the high-level model is multimodal.
- **Native Responses history.** Native provider payload replay is model-bound.
  Strip or normalize foreign reasoning signatures. Shared code normalizes
  Responses pipe-separated tool ids, hashes foreign item ids, and can filter
  reasoning history.

## 7. Decode streams by provider behavior, not just schema

- **Generic OpenAI-compatible streams.** Keepalive chunks, role-only deltas, and
  empty `choices: []` are not progress. Idle watchdogs must not sleep forever
  because of them.
- **Mistral Medium 3.5-style content.** `delta.content` can be an array/object of
  text parts, not a string; normalize it to text.
- **DeepSeek via NVIDIA/native/proxies.** Some endpoints leak chat-template
  markers like `<｜...｜>` into visible content. Buffering is required because
  markers can be split across chunks.
- **DeepSeek/template-leak tool calls.** Some providers leak tool-call markup in
  text while also producing structured tool calls. Markup healing belongs in the
  stream decoder policy, not endpoint business logic.
- **MiniMax-M3 cumulative reasoning.** Reasoning deltas may be cumulative
  snapshots. Deduplicate by reasoning field signature.
- **Responses streams.** Route parallel items by `output_index`, `item_id`,
  call-id aliases, and prefixed `fc_` aliases. Tolerate missing
  `content_part.added` or `output_item.added`. Finalize pending tool calls at the
  terminal event.
- **Terminal behavior.** Chat Completions can break after `finish_reason` plus
  usage. Responses breaks on `response.completed` or `response.incomplete`. Tool
  calls with `stop` promote to `toolUse`. Codex/Responses `end_turn:false` maps
  to `pause_turn`.
- **Ollama length failures.** `finish_reason: length` with no visible content is
  treated as context-window failure and mapped to an error.

## 8. Preserve usage and cost semantics

- OpenRouter `prompt_tokens_details.cache_write_tokens` is billed differently:
  subtract it from input tokens and emit it as cache-write usage.
- DeepSeek native `prompt_cache_miss_tokens` is the billed input portion, not a
  separate cache-write charge. Do not double-count it.
- GitHub Copilot `premiumRequests` must survive when usage is populated or
  replaced.
- Responses and Codex both adjust cost by resolved service tier, but Codex uses
  different multipliers.

## 9. Implement recovery at the right boundary

- **Strict tool fallback.** `400`/`422` schema or strict-tool failures should
  disable strict tools for the appropriate session scope and retry non-strict.
- **OpenAI Responses stateful fallback.** Stale, invalid, or unsupported
  `previous_response_id` resets chain state and retries with full context. Zero
  Data Retention disables chaining immediately.
- **Codex websocket fallback.** Websocket connection errors, stale sockets,
  connection limits, retry-budget exhaustion, or unsafe partial output can
  trigger reconnect or SSE replay.
- **Codex whitespace tool-loop breaker.** Codex can stream whitespace-only
  tool-call argument deltas indefinitely. Cap events/chars, drop the degenerate
  partial tool call, and retry only when safe.
- **Codex `previous_response_id` fallback.** Stale or unsupported ids are chain
  breaks and retry with full context, but only for websocket because SSE never
  chains.
- **Provider retry before content.** Codex retries retryable provider stream
  errors only before user-visible content has been emitted.

## 10. Checklist for a new constraint

Before adding a branch or compat field, answer these in order:

1. Is this endpoint-family behavior, gateway behavior, model behavior, or request
   context behavior?
2. Can it be represented by existing `compat` metadata?
3. If not, is a new compat field better than a provider-name branch?
4. Does the field need provider-level defaults, model-level overrides, or both?
5. Does it interact with tools, images, reasoning, stateful Responses chains, or
   service tier?
6. Can retry happen before visible text/tool calls only?
7. Does usage accounting still preserve cache reads/writes, billed input, service
   tier multipliers, and provider-specific counters such as Copilot
   `premiumRequests`?
