# Changelog

## [Unreleased]

### Added

- Added recoverable native custom-scheme OAuth callbacks on macOS, Linux desktops, and Windows, with manual fallback for unavailable or remote sessions.

### Fixed

- Fixed race condition causing duplicate manual code prompts during OAuth flows
- Fixed Gemini tool continuations through custom Anthropic Messages proxies and OpenAI Responses relays, ensuring tool calls and results remain correctly associated across multi-turn requests.

## [18.1.8] - 2026-09-03

### Added

- Added GPT-6 Astra support for preserving prompt caching when changing the thinking level during a conversation across the OpenAI and OpenAI Codex providers.

### Changed

- Updated OpenAI Codex requests to improve routing by communicating the selected model and service tier across Responses, WebSocket, and remote-compaction requests.

## [18.1.7] - 2026-09-03

### Fixed

- Fixed DeepSeek-family Responses replay (e.g. opencode-go) rejecting a resumed thinking-mode turn with `400 The reasoning_text in the thinking mode must be passed back to the API` when compaction dropped the turn's reasoning; a non-empty placeholder is now synthesized instead of an empty `reasoning_text` ([#10690](https://github.com/can1357/oh-my-pi/issues/10690)).

## [18.1.6] - 2026-09-03

### Breaking Changes

- Renamed `claudeCodeSessionId` to `sessionId` in `AnthropicClientOptionsArgs`.
- Renamed `openAISessionId` to `sessionId` in `OpenAIRequestSetupOptions`.

### Added

- Added Amazon Bedrock `requestMetadata` support for cost and usage attribution in AWS invocation logs.

### Changed

- Codex GPT-5.6 requests now use full Responses by default, enabling independent tool calls to run in parallel; provider-native compaction continues to use catalog-selected Responses Lite.
- Inference requests now identify as omp by default while preserving explicit provider and OAuth User-Agent fingerprints. Amazon Bedrock requests use an `omp/<version>` User-Agent by default and honor configured `User-Agent` overrides.

### Fixed

- Fixed Antigravity usage reporting to match the official client's five-hour and weekly quota buckets.
- Anthropic and OpenRouter credit-exhaustion errors now automatically switch to a sibling account instead of stopping the turn with a retry hint.
- Fixed OpenCode Go and Zen requests by including the required stable per-conversation session identification.
- Improved Anthropic prompt caching so explicit cache breakpoints preserve reusable tools and system prompts when the message tail changes.

## [18.1.5] - 2026-09-03

### Added

- Added `/login abliteration` with API key validation against `/v1/models`, supporting the `ABLITERATION_API_KEY` and `ABLIT_KEY` environment variables.

### Changed

- Modernized provider authentication and token refresh across the catalog, with shared support for API-key, authorization-code, and device-code sign-in flows and clearer sign-in progress messages for OpenRouter, Kimi, and xAI.

### Fixed

- GitHub Copilot now uses the official Copilot CLI identity and OAuth application for requests and new sign-ins, restoring access to client-gated models while preserving existing credentials.
- GitHub Copilot now reports `model_not_supported` responses immediately instead of repeatedly retrying unsupported models.
- Improved account recovery after Google rate limits are lifted earlier than the reported reset time.
- Fixed unmetered autocomplete models being reported as exhausted when quota is limited.
- Fixed Gemini 3 cross-model sessions in Cloud Code Assist when replaying tool calls without a thought signature.
- Fixed Cursor models behind an authentication gateway incorrectly retrying valid client-declared tool calls.
- Fixed reasoning from models that prefill `<think>` (including DeepSeek-R1 and hosted Qwen3-Thinking) being shown in the response instead of as a separate thinking block.

## [18.1.3] - 2026-09-02

### Fixed

- Fixed Gemini 3 sessions on Antigravity/Cloud Code Assist and Vertex AI getting permanently stuck on `400 INVALID_ARGUMENT` after a turn with parallel tool calls ([#9638](https://github.com/can1357/oh-my-pi/issues/9638)).
- Preserved Anthropic thinking now survives side requests, tool-description drift, turn-scoped reminders, and recoverable prefix mismatches without corrupting the conversation prefix.
- Fixed Anthropic-compatible endpoints backed by Amazon Bedrock permanently rejecting a session once an unsigned thinking block entered its history. The transport now recognizes Bedrock's `ValidationException … thinking.signature: Field required` as the same unsigned-thinking rejection it already heals for other signing proxies, so it demotes the unsigned block to text, retries once, and remembers the endpoint for the rest of the session instead of failing every turn and walking the model fallback chain.
- Fixed the DeepSeek DSML markup healer leaking orphan `</｜DSML｜parameter>`/`</｜DSML｜invoke>` close tags into visible text, which poisoned long-session history and reinforced the model's XML-protocol mimicry until tool calls stopped dispatching ([#10556](https://github.com/can1357/oh-my-pi/issues/10556)).
- Fixed repeated parallel tool-call batches bypassing the configured loop guard.
- Fixed Cursor tool-schema composition failures by projecting unsupported keywords only for confirmed Fable models; Grok and other Cursor models retain canonical schemas.
- Fixed API-key account rotation to honor provider-reported quota reset windows, including overlapping exhausted windows ([#10325](https://github.com/can1357/oh-my-pi/pull/10325) by [@usr-bin-roygbiv](https://github.com/usr-bin-roygbiv)).

## [18.1.2] - 2026-09-01

### Added

- Added thinking controls for Amazon Bedrock models.
- Added dynamic mid-conversation updates for Anthropic system prompts, tools, and reasoning effort.
- Added deferred tool loading and prompt caching for Anthropic models.
- Added configurable handling for invalid Anthropic thinking blocks through `anthropicPrefixMismatchBehavior`.

### Fixed

- Fixed compatibility issues with Anthropic thinking and prompt-cache breakpoints across deployments, preserving valid reasoning context while preventing invalid-signature errors.
- Fixed incorrect operating-system information reported in request headers on non-Linux systems.
- Fixed Google Antigravity quota handling so requests rotate to another account with available usage instead of unnecessarily switching models.
- Fixed Anthropic authentication for newer models by updating the Claude Code request fingerprint.

## [18.1.0] - 2026-09-01

### Added

- Added an optional `completeSimple` callback that observes every result, including results from internal thinking-loop retries.
- Added compatibility options for Anthropic-compatible proxies that reject `context_management` and OpenAI Responses proxies that provide incomplete reasoning-summary streams.
- Added ClinePass API-key authentication via the official `CLINE_API_KEY` environment variable, with account validation, actionable subscription and quota errors, support for eligible ClinePass model rosters, and rolling quota-window reporting in `omp usage`.
- Added Devin router-model support, including assignment of the concrete model before each request, routed-model metadata, credit usage reporting, and plan, quota-window, and account details through `omp usage`.

### Changed

- Provider behavior is now driven by each model's resolved compatibility, identity, thinking, and behavior policies rather than model-name matching, improving support for model-specific request formatting, vision, reasoning, routing, pricing, and quota handling.
- Devin integrations now use the current released CLI identity and support parallel tool calls when the model declares that capability.

### Fixed

- Fixed OpenAI remote-compaction replay for persisted sessions, allowing sessions with previously stored compaction items to resume successfully.
- Fixed Cursor Fable requests failing when advertised tools used JSON Schema composition keywords.
- Fixed Z.AI (GLM Coding Plan) browser sign-in by using the registered CLI callback address.
- Fixed OpenAI Codex/Responses tool results being lost when composite call identifiers could not be paired with the corresponding assistant call.
- Fixed native OpenAI Responses history replay becoming stuck on malformed or truncated function-call arguments; invalid history items are now discarded so the session can recover.

## [18.0.11] - 2026-08-29

### Fixed

- Fixed automatic session retries for Anthropic-compatible streams that end prematurely without a completion signal.
- Fixed Gemini 3.x tool-call continuations through OpenAI-compatible endpoints.
- Fixed credential fallback for HTTP 402 payment-required and deactivated-workspace responses, preventing them from being misclassified as quota exhaustion.
- Fixed Perplexity email sign-in for accounts protected by authenticator-based two-factor authentication.
- Fixed Qianfan API-key login validation for keys that cannot access the validation model.
- Fixed Z.AI browser sign-in to report an occupied callback port before opening the browser.

## [18.0.9] - 2026-08-28

### Fixed

- Improved OAuth sign-in flows, including a fallback message when the browser cannot automatically close the OAuth success tab.
- Fixed Cloudflare AI Gateway onboarding and routing so gateway account and endpoint configuration is preserved correctly while gateway credentials are not sent as upstream OpenAI authorization headers.
- Fixed Codex OAuth quota handling so chat and Spark usage remain independent, legacy shared quota limits continue to work, and incomplete usage reports are not incorrectly treated as unlimited.

## [18.0.8] - 2026-08-27

### Added

- Added Z.AI GLM Coding Plan usage tracking: credit-based `CREDIT_LIMIT` windows (5h + weekly) now surface in `omp usage` and the status line with the plan tier (`plan: lite/pro/max`).

### Fixed

- Fixed Amazon Bedrock requests to OpenAI-schema models (the `gpt-5.x` SKUs) failing with HTTP 400 `unknown_parameter: 'thinking'` when reasoning was enabled, by sending `reasoning.effort` instead of Anthropic's `thinking` budget block for models the catalog marks as effort-controlled.
- Fixed Cursor replay rejecting sessions with orphaned tool results while preserving their output as assistant context.

## [18.0.7] - 2026-08-26

### Added

- Added application-level usage attribution for billing and usage reporting, with per-application aggregation and automatic client identification. Applications can set their label with `OMP_APP_NAME` (default: `omp`); update the broker before clients to support the new usage reports.

### Fixed

- Fixed Anthropic Claude subscription OAuth requests being rejected by the upstream service ([#9801](https://github.com/can1357/oh-my-pi/pull/9801)).
- Fixed OpenAI-compatible streaming errors being reported as empty successful completions, enabling retries and model fallback when queue admission fails.
- Fixed multimodal tool results in OpenAI Responses requests so inline, remote, and OpenAI file-backed images are preserved correctly.
- Fixed resumed and forked Cursor sessions failing when their history came from a Responses-based provider such as Codex ([#9754](https://github.com/can1357/oh-my-pi/issues/9754)).
- Fixed Cursor `composer-2.5` selections using the Fast variant instead of the Standard tier ([#9012](https://github.com/can1357/oh-my-pi/issues/9012)).

## [18.0.6] - 2026-08-26

### Added

- Added the `backgroundIdleMs` option to customize how long background auth-broker activity remains active before automatically parking.

### Fixed

- Fixed auth-broker background activity keeping processes alive unnecessarily, so unused broker-backed auth storage now parks automatically and no longer prevents CLI exit.

## [18.0.5] - 2026-08-25

### Breaking Changes

- Renamed the exported stream-retry helper from `withEmptyCompletionRetry` to `withReplaySafeStreamRetry` and added retry policy options for empty completions and provider errors. Consumers using the old helper must migrate.

### Added

- Added browser-based Sign in with OpenRouter using OAuth PKCE, while retaining support for pasted OpenRouter API keys and redirect URLs for remote sessions.
- Added `/login` API-key authentication for DeepInfra and Yolo-Auto, including validation against each provider before the credentials are accepted.

### Fixed

- Fixed DeepSeek vision models from losing image input while keeping image parts stripped for text-only DeepSeek endpoints.
- Fixed OpenAI-compatible gateways that report uppercase completion reasons such as `STOP` or `MAX_TOKENS`; these are now classified correctly, including mapping `MAX_TOKENS` to a length limit.
- Fixed provider message-count limit errors being treated as unrecoverable payload errors instead of recoverable context overflows.
- Improved Codex WebSocket continuations so rate limits, throttling, and compatible mode changes preserve valid response continuations instead of unnecessarily replaying the full context.
- Fixed Codex WebSocket cleanup failures caused by already-closed sockets.
- Added safe retries for transient mid-stream socket closures across OpenAI Responses, Chat Completions, Azure OpenAI Responses, and Codex SSE when no replay-unsafe output has been emitted.
- Fixed usage and cost reporting for OpenAI-compatible gateways backed by Vertex AI or Gemini by recognizing cached prompt tokens reported through `cachedContentTokenCount`.

## [18.0.4] - 2026-08-24

### Fixed

- Fixed Cursor tool calls through OpenAI-compatible authentication gateways losing arguments when complete argument maps are sent without streaming deltas ([#9479](https://github.com/can1357/oh-my-pi/issues/9479)).
- Fixed Cursor plan entitlement refusals repeatedly selecting ineligible accounts by scoping credential blocks to the requested model during rotation ([#9488](https://github.com/can1357/oh-my-pi/issues/9488)).
- Improved HTTP 413 error classification to accurately distinguish between payload/media size limits and token context window overflows, preventing inappropriate token compaction attempts and routing to correct recovery/fallback strategies ([#9235](https://github.com/can1357/oh-my-pi/issues/9235)).
- Fixed Cursor conversation rotation after aborts or mid-turn restarts to properly replay the last user message on a fresh conversation.

## [18.0.3] - 2026-08-23

### Fixed

- Fixed a Fireworks-hosted model aborting mid-generation with an HTTP 400 `Floating point NaN (not-a-number) is detected in generation` killing the turn instead of retrying; this model-side numerical fault is now classified transient and retried, matching the existing treatment of Copilot fleet-skew 400s ([#9458](https://github.com/can1357/oh-my-pi/issues/9458)).

## [18.0.2] - 2026-08-23

### Fixed

- Fixed OpenAI-compatible completions hosts that stream content then terminate with the `[DONE]` sentinel while omitting (or `null`ing) `finish_reason` failing every turn with `OpenAI completions stream closed before a finish_reason was received`; a `[DONE]`-terminated stream now finalizes as a clean stop and only a genuine transport EOF (no `[DONE]`, no finish reason) surfaces the incomplete-stream error ([#9433](https://github.com/can1357/oh-my-pi/issues/9433)).

## [18.0.1] - 2026-08-23

### Changed

- Broker-backed startup no longer blocks on a broker round trip when the encrypted snapshot cache is fresh: the credential store starts from the cached snapshot and the background snapshot stream revalidates immediately (stale-while-revalidate). First launches and expired caches still fail fast with the actionable broker error.

### Fixed

- Captured bounded Devin Connect trailer details and request-shape evidence for diagnosing intermittent `invalid_argument` stream rejections ([#4218](https://github.com/can1357/oh-my-pi/issues/4218)).
- Fixed abandoned `auth-broker-snapshot.enc.*.tmp` files accumulating in the cache directory when a process exited mid-write; stale temp files are now swept on each cache write.
- Fixed Cursor GPT effort models failing with `not_found` on accounts that require the discovered effort-specific model id ([#9287](https://github.com/can1357/oh-my-pi/issues/9287)).
- Fixed thinking-loop detection going silent after the first streamed tool call, so Grok/xAI reasoning loops that continue after a tool call starts still abort and retry instead of spinning until you press Esc.
- Fixed Codex continuations, retries, and compaction replacing or dropping the turn-scoped sticky-routing token ([#9277](https://github.com/can1357/oh-my-pi/issues/9277)).
- Fixed Codex Responses append chains falling back to full-context replay when replay-sanitized assistant items differ only by output-only IDs or lifecycle status.
- Fixed Cursor usage reporting “no usage data” for plans without a numeric legacy request cap.
- Fixed DeepSeek models rejecting requests with HTTP 400 `unknown variant \`image_url\`, expected \`text\``when screenshots or image-producing tool results are present in conversation history or when`model.input`claims vision capability;`convertMessages`in`openai-completions`now strips`image_url` content parts and injects non-vision image placeholders for all DeepSeek endpoints.
- Fixed `PI_PROXY` covering only provider streams: OAuth token refresh and login, usage probes, and model discovery went out through the bare global `fetch` and ignored it, so a region-blocked token endpoint answered `403 Request not allowed` (Anthropic `/v1/oauth/token`) and disabled the credential while the proxied stream itself worked. `installGlobalProxyFetch()` now routes the process-wide `fetch` through `PI_PROXY`; a per-request proxy such as `PI_PROXY_<PROVIDER>` still wins, and loopback / private-range / `NO_PROXY` targets stay direct.
- Fixed Anthropic inference ignoring every proxy setting. `coworkFetch` runs on `node:https`, whose Bun shim discards both `agent.createConnection` and `options.createConnection`: the CONNECT tunnel to `PI_PROXY` was built, TLS-negotiated, then abandoned, and the request dialed `api.anthropic.com` on the default route (measured at the proxy: 581 bytes of handshake, zero request bytes). On a region-blocked egress that returned `403 {"type":"forbidden","message":"Request not allowed"}` with the proxy apparently configured. Proxied requests now go through Bun's own `fetch`, which honors `init.proxy`, trading the Cowork TLS/header profile for a proxy that actually carries the traffic; the dead tunnel plumbing is gone from the transport. `node:http2` (Cursor) does honor `createConnection` and is unaffected.
- Fixed `cowork-fetch` capturing `globalThis.fetch` at module load, so a proxy wrapper installed later in startup was ignored on its fallback path.
- Cursor Connect end-stream failures now surface bounded server trailer details instead of opaque generic errors ([#9137](https://github.com/can1357/oh-my-pi/pull/9137) by [@Mustaqeem66](https://github.com/Mustaqeem66))
- Fixed Cursor sessions aborting on the next turn or during compaction after MCP tools returned numeric-looking string arguments ([#9394](https://github.com/can1357/oh-my-pi/issues/9394)).
- Fixed glyph tokenization crashing with `entries is not a function` when `Context.systemPrompt` arrived as a bare string (e.g. from legacy earendil-works extensions); it is now normalized to an array before iterating, matching every provider path ([#9384](https://github.com/can1357/oh-my-pi/issues/9384)).

### Added

- Added Amazon Bedrock Converse guardrail configuration with provider-scoped identifier, version, and trace settings.

## [18.0.0] - 2026-08-22

### Added

- Added reversible private-use glyph tokenization for Claude-compatible provider requests, including prompt notices, streamed response decoding, and safe handling of unresolved model-authored glyph tokens.

## [17.4.3] - 2026-08-21

### Fixed

- Fixed completed Anthropic turns remaining busy when the provider sent `message_stop` but kept the SSE connection open, which stranded tool execution and queued steering until timeout.

## [17.4.2] - 2026-08-21

### Added

- Image content blocks accept an optional `url` mirror: providers whose APIs fetch remote images (Anthropic url sources, OpenAI/xAI Responses and Chat Completions `image_url`, Google `fileData`) send the URL instead of the inline base64 payload.

### Fixed

- Fixed Cursor thinking-effort selection being cosmetic: collapsed effort-routed families (GPT-5.6 Luna/Sol/Terra, Grok 4.5/4.6) now send the effort-routed wire model id instead of always pinning the `-none` off tier ([#9246](https://github.com/can1357/oh-my-pi/issues/9246)).
- Fixed OAuth preflight refresh stranding a peer-rotated credential: when a concurrent process rotated a rotating-refresh-token grant (e.g. Anthropic) during preflight, the resolve pass skipped the freshly reloaded row and failed the request with no credentials for single-account setups ([#9194](https://github.com/can1357/oh-my-pi/issues/9194)).
- Fixed Cursor reasoning-sibling models (e.g. `gpt-5.4-mini-low`, `gpt-5.6-sol-xhigh`) failing with `resource_exhausted` (errorId 528384): the per-effort GPT slug is now split into its base model id plus a `{ id: "reasoning", value: <effort> }` request parameter, matching the official `cursor-agent` wire shape, instead of sending the sibling slug as the wire model id with no parameters ([#9164](https://github.com/can1357/oh-my-pi/issues/9164)).

## [17.4.1] - 2026-08-21

### Added

- Added Codex Responses support for Code Mode, preserving tool modes and passing tool namespace metadata during sessions.

### Fixed

- Fixed OpenAI Codex requests failing with HTTP 401 data residency errors on enterprise ChatGPT workspaces when connecting from a different region via VPN or proxy.
- Fixed concurrent xAI OAuth token refreshes revoking shared credentials across multiple processes.
- Fixed Amazon Bedrock Converse multi-turn conversations failing on models like Amazon Nova due to unsigned reasoning content in replayed turns.
- Fixed Antigravity OAuth login handling for project discovery and free-tier onboarding against Cloud Code Assist endpoints.
- Fixed provider-detected OAuth access token expiration terminating active turns instead of automatically refreshing credentials and replaying the request.
- Fixed compatibility issues with OpenAI-compatible servers (such as NInfer and vLLM) rejecting `reasoning_effort` inside `chat_template_kwargs`.
- Fixed Google Cloud Code Assist and Antigravity rejecting MCP tool schemas with unsupported annotations (`x-mcp-header`, `deprecated`, `readOnly`, `writeOnly`, `$comment`).
- Fixed Cursor provider issues with native file edit streaming (`editToolCall`) and ensuring always-apply system rules are properly preserved.
- Fixed Cursor HTTP/2 requests ignoring standard proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`).

## [17.4.0] - 2026-08-20

### Added

- Added model metadata fields (`context_length`, `max_output_tokens`, `input_modalities`, etc.) to auth gateway model listing responses

### Fixed

- Fixed tool-argument repair applying lossy transformations (such as stringifying objects or stripping unrecognized keys) when validating union schemas (`anyOf`/`oneOf`), preventing corrupted tool call and subagent payloads
- Fixed 400 errors when communicating with local OpenAI-compatible inference servers that reject `chat_template_kwargs.reasoning_effort` by improving reasoning effort parameter fallback and compatibility handling
- Fixed DeepSeek-family models on hosts like Fireworks losing reasoning whenever tools were offered: a redundant `tool_choice: "auto"` is now omitted so the provider keeps thinking enabled; forced and `"none"` selectors still take priority ([#1207](https://github.com/can1357/oh-my-pi/issues/1207))

## [17.3.8] - 2026-08-19

### Changed

- Fixed Gemini thought summaries occasionally leaking a raw ` ```thinking ` / ` ``````thinking ` fence delimiter into the reasoning block, so it no longer shows up as fence spam in the thinking display or persisted transcripts ([#8719](https://github.com/can1357/oh-my-pi/issues/8719)).
- Fixed the OpenCode Go login prompting for an "OpenCode Zen API key": the shared login flow now names the provider you selected, so connecting OpenCode Go asks for an OpenCode Go key (the `opencode.ai/auth` console is still shared, as documented upstream) ([#8738](https://github.com/can1357/oh-my-pi/issues/8738)).
- Fixed Anthropic-compatible endpoints with strict prompt validation (e.g. Z.AI GLM `api.z.ai/api/anthropic`, which rejects the whole request with `400 code 1213 "The prompt parameter was not received normally"`) failing sessions once a tool returned empty output on a vision-capable model: empty successful `tool_result` blocks now encode as `content: ""` instead of `content: []`, which both the official API and strict compatible endpoints accept.
- Fixed `retry.usageReservePct` (Reserve Margin) ignoring Claude Fable/Mythos weekly tier usage until it hit 100%, so a Fable model kept serving turns past the configured reserve; reserve health now honors the mapped tier row while credential-wide hard blocks still require confirmed exhaustion ([#8773](https://github.com/can1357/oh-my-pi/issues/8773)).
- Fixed `cursor-agent` streams stalling with "Provider stream stalled while waiting for the next event" when Cursor asked the client to approve a hosted WebFetch / web search (reproduced on `cursor-grok-4.6-xhigh` after "I'll fetch the page…"). Those `interaction_query` frames — including the newer WebFetch field 9 this proto did not name — were dropped, so the server waited forever and the idle watchdog aborted a live connection. Permission queries are now answered; hosted search/fetch is approved, unnamed permission fields get an `approved` reply on the same field number, and prompts this client cannot serve are rejected so the turn can continue.

### Fixed

- Fixed thinking effort selections being ignored for local Qwen 3.8+ models on llama.cpp and vLLM: the Qwen chat-completions dialects only toggled `enable_thinking`, so the chat template always reasoned at its `xhigh` default no matter which level was selected. The encoder now routes the requested effort onto the template's `reasoning_effort` kwarg (`chat_template_kwargs` for both Qwen dialects, plus the top-level field newer llama.cpp builds map natively).
- Fixed OpenAI Completions, Amazon Bedrock, and Cursor providers ignoring `onPayload` replacement payloads. The hook now transforms the actual request body sent upstream on these providers, matching the Anthropic/Gemini/OpenAI Responses replacement contract. `devin-agent` still does not fire the hook (its payload is a protobuf object).
- Fixed Codex requests failing outright when the signed-in ChatGPT account is not entitled to the requested model; the exact model denial is now classified as an account-policy error so credential rotation can reach an entitled sibling account
- Fixed Perplexity email-OTP login after its verification response renamed the encrypted session token from `token` to `challenge_token`.
- Cloud Code Assist Gemini 3.6/3.7 Flash requests at `minimal` now send `thinkingLevel: LOW` on the aliased `-low` SKU instead of `MINIMAL`, which the API rejects with HTTP 400.
- Answer Cursor `interaction_query` permission gates (hosted web search, Exa, unnamed field-9 WebFetch) so the Run RPC continues instead of sitting silent until the 300s idle watchdog.
- Fixed provider tool calls arriving with flattened array argument paths (e.g. Gemini's `questions[0].id`) being stripped and rejected by argument validation; well-formed flattened paths are now rebuilt into the nested arrays the tool schema expects ([#8886](https://github.com/can1357/oh-my-pi/issues/8886)).
- Fixed opencode-go (Console Go) rejecting Responses turns with `400 No tool output found for tool call …` (naming a random call of the batch on each retry) when a model streamed a trailing text/thinking block after its tool calls: `buildResponsesInput` emitted that block as an assistant `message` item wedged between the `function_call` batch and its `function_call_output` items. Such interleaved messages are now hoisted ahead of their call batch (canonical `message(s) → calls → outputs`), which the strict gateway validator accepts; content is unchanged ([#8789](https://github.com/can1357/oh-my-pi/issues/8789)).
- Fixed the OpenAI-wire transport sleeping on a LiteLLM concurrency-admission 429 (`rate_limit_type: max_parallel_requests`, `Retry-After: 60`) and retrying it up to 6 times (~300s) before session recovery saw the error. Because a 60s hint equals the transport's `maxDelayMs` cap, `fetchWithRetry` kept sleeping and retrying; the request now surfaces on the first attempt so `TurnRecovery`'s concurrency backoff/model fallback runs promptly. Genuine RPM/quota 429s (no such marker) still honor `Retry-After` ([#8854](https://github.com/can1357/oh-my-pi/issues/8854)).
- Fixed OAuth login (Codex `localhost:1455`, and any `localhost` callback flow) failing on hosts with IPv6 disabled at the kernel (`ipv6.disable=1`). The `::1` companion listener added in #8081 fails there with Bun's generic "Is port X in use?" message (oven-sh/bun#7187), which the in-use check misread as a real collision — tearing down the healthy IPv4 listener and surfacing a bogus "port 1455 is in use" error. The dual-bind path now detects the missing IPv6 loopback up front and serves IPv4 alone ([#8814](https://github.com/can1357/oh-my-pi/issues/8814)).

## [17.3.7] - 2026-08-17

### Changed

- Send the `omp/<version>` User-Agent on xAI chat (`xai` and `xai-oauth`) unless the request already set its own.

## [17.3.5] - 2026-08-16

### Added

- Added retryable oneshot completion support (`retryTransientCompletion`) so non-agent LLM calls correctly retry on transient provider failures (Anthropic overload/rate-limit errors, HTTP 429/500/502/503/529), honoring provider-supplied retry-after timing before giving up.

### Fixed

- Fixed xAI availability detection so paid-key-only setups correctly default to `xai/grok-4.5` instead of the free SuperGrok catalog; explicit `xai-oauth/…` selectors still work as before.
- Fixed xAI Responses requests sending unsupported parameters (reasoning summary, presence/frequency penalties) that some models rejected.
- Fixed Umans usage reporting incorrectly marking quota as exhausted based on raw request counts instead of actual weighted usage, and improved the usage display to show both a soft-cap warning and a hard exhaustion limit with an accurate countdown to reset.
- Fixed `omp usage invalidate` to fully clear stale usage data and force a fresh refresh, so upgraded subscriptions no longer show outdated quota information.
- Improved session recovery to correctly treat certain Cursor HTTP/2 connection errors as transient instead of ending the session.
- Fixed OpenAI-compatible streams (e.g. DeepSeek) that are cut off mid-generation being silently treated as a completed response instead of being retried.
- Fixed DeepSeek resource-exhaustion interruptions not being automatically retried.
- Fixed tool-call IDs being lost during same-model replay, which could break correlation with custom gateways.
- Fixed Kimi Code multi-account routing to prefer accounts with more available quota, respect usage-limit cooldowns, and keep consistent usage history across token refreshes.
- Fixed Anthropic custom signing-proxy conversations losing tool-search results and thinking content during replay.
- Fixed rare runaway response loops across model providers so they now fail gracefully instead of repeating indefinitely.
- Fixed xAI rejecting entire turns due to certain MCP tool schema shapes, restoring compatibility while isolating any remaining incompatible tools rather than failing the whole request.
- Fixed Alibaba DashScope/Bailian transient per-minute rate limits being misclassified as full quota exhaustion, causing unnecessary long backoffs instead of quick retries.
- Fixed Anthropic-compatible streams dropping thinking content, which broke replay of prior reasoning.
- Updated the Alibaba Coding Plan China login flow to point to the current Bailian API-key management console.

## [17.3.4] - 2026-08-14

### Fixed

- Fixed `omp usage invalidate` to discard stale OAuth and API-key usage snapshots, then force a cache-bypassing, per-provider serialized refresh with a broker request budget sized for the full unfiltered account batch, so upgraded subscriptions do not silently retain pre-change quota data.
- Fixed quota reporting and Cookie capture guidance for China (Beijing) Alibaba Token Plan credentials ([#8509](https://github.com/can1357/oh-my-pi/issues/8509)).

## [17.3.3] - 2026-08-14

### Fixed

- Distinguished Gemini thought-only `STOP` responses from empty transports, avoiding repeated identical reasoning requests and duplicate Antigravity endpoint streams while surfacing the missing final output for session-level recovery.

## [17.3.2] - 2026-08-13

### Fixed

- Dropped unsigned thinking blocks from Antigravity Claude requests instead of sending them without a signature, preventing HTTP 400 responses when resuming sessions or switching models.
- Classified Antigravity HTTP 429 responses from structured `google.rpc.ErrorInfo` reasons (`QUOTA_EXHAUSTED`, `RATE_LIMIT_EXCEEDED`, and `INSUFFICIENT_G1_CREDITS_BALANCE`), using retry delays of five minutes or longer to distinguish rotatable quota windows from transient throttling instead of relying only on message regexes.

### Removed

- Removed the Antigravity identity-prompt injection (`ANTIGRAVITY_SYSTEM_INSTRUCTION` and `shouldInjectAntigravitySystemInstruction`): Cloud Code Assist accepts arbitrary system instructions on gemini-3.x and Claude routes (verified live), and the injected stub never matched the real client's system prompt anyway. User system prompts are now sent unmodified (still tagged `role: "user"`).
- Fixed Antigravity `auto` mode not failing over to the sandbox endpoint when the daily endpoint returned a thinking-only `STOP`, which caused Advisor turns to be falsely recorded as empty-response failures ([#8480](https://github.com/can1357/oh-my-pi/issues/8480)).

## [17.3.0] - 2026-08-13

### Breaking Changes

- Renamed `withGeminiThinkingLoopGuard` to `withThinkingLoopGuard`; the guard applies to Gemini, DeepSeek, and Grok model-id families.

### Changed

- Updated OpenCode Go integration to use the official usage endpoint, removing hardcoded caps, enabling real-time credential validation, and routing multi-key pools based on rolling and weekly headroom.
- Optimized Anthropic prompt caching with rolling 5-minute breakpoints and idle refreshes to keep the prompt prefix warm.

### Fixed

- Fixed Ollama chat adapter to correctly forward sampling parameters like temperature and topP to the provider.
- Fixed OpenAI agent turns ending prematurely after a web search with no visible answer, ensuring the agent continues processing the search results.
- Fixed a resource leak where completed model streams retained provider concurrency permits longer than necessary.
- Fixed image input support for qwen3.8-max and newer models when using DashScope compatible-mode.
- Fixed xAI usage reporting falling back to a stale cache when a new weekly cycle starts with 0% consumed credits.
- Fixed Together AI login validation failures by querying the authenticated models list instead of a hardcoded model.
- Fixed credential-health probes and usage fetches failing when using reference-stored API keys (such as environment variables or commands) by ensuring secrets are correctly resolved.
- Fixed Perplexity email-OTP login by preserving the session cookies required for verification.
- Fixed thinking configuration for OpenAI and Daybreak models to correctly send reasoning.effort: "none" when thinking is disabled.
- Fixed Grok runaway thinking streams bypassing the thinking-loop guard.

### Removed

- Removed legacy local request-cost estimation machinery and database schemas previously used for OpenCode Go estimates.

## [17.2.15] - 2026-08-12

### Fixed

- Fixed an issue where AWS_BEDROCK_SKIP_AUTH failed to expose Amazon Bedrock models when AWS credential files were unavailable.
- Fixed an issue where forceReasoningOff was ignored by Anthropic and Google transports, which allowed native thinking alongside a caller-supplied external scratchpad.

## [17.2.14] - 2026-08-11

### Added

- Added `forceReasoningOff` and `disableReasoning` options to disable reasoning in OpenAI and Azure OpenAI models

## [17.2.13] - 2026-08-11

### Changed

- Standardized first-party outbound User-Agent headers on `omp/<version>` via the shared `USER_AGENT` utility.

### Fixed

- Fixed the Amazon Bedrock and Cursor transports ignoring `StreamOptions.headers`; both built their request headers from scratch, so caller-supplied tracing or attribution headers were silently dropped while working on every other provider ([#8107](https://github.com/can1357/oh-my-pi/pull/8107) by [@svperfecta](https://github.com/svperfecta)).
- Fixed Antigravity Flash turns hanging after successful response headers when the endpoint never emitted an SSE event; the provider now cancels the stalled body and fails over after 60 seconds while retaining the longer allowance for Pro reasoning starts.
- Fixed Cursor exec-bridge bash/grep calls failing ArkType validation when the server omitted optional frame fields: synthesized and executed tool args now drop `undefined` keys (`cwd`, `case`, `skip`, `timeout`) instead of writing `optional: value || undefined`.
- Fixed Cursor sessions double-executing settled tools when `tools.format` is an owned dialect (e.g. `gemini`): `wrapInbandToolStream` rebuilt toolCall blocks without copying `kCursorExecResolved`, so agent-loop re-ran bash/grep/todo and appended a second result for the same call id.
- Fixed Codex Responses Lite requests for opaque model codenames such as Daybreak omitting the required `reasoning.context: "all_turns"` value and failing with HTTP 400.
- Fixed Cursor personal usage reporting for current Pro / Pro+ / Ultra `/api/usage-summary` payloads that expose `individualUsage.plan` (and optional `onDemand`) instead of the older `individualUsage.overall` bucket ([#7998](https://github.com/can1357/oh-my-pi/pull/7998) by [@dnth](https://github.com/dnth)).
- Allowed passive Google callers to accept empty or thinking-only `STOP` responses as successful silence instead of exhausting the provider's empty-response retry budget. ([#8223](https://github.com/can1357/oh-my-pi/issues/8223))
- Fixed the AWS credential resolver ignoring `role_arn` profiles: shared-config role chaining (`source_profile` recursion, `web_identity_token_file`, `credential_source`) now resolves via STS `AssumeRole`/`AssumeRoleWithWebIdentity`, honoring `role_session_name`/`duration_seconds`/`external_id`, so Bedrock is detected on EKS/IRSA and multi-account setups instead of reporting "No models available" ([#8209](https://github.com/can1357/oh-my-pi/issues/8209)).
- Fixed Bedrock availability being under-detected on Nitro/EKS hosts: the EC2 metadata probe now recognizes Nitro DMI markers (`board_asset_tag` instance ids, `Amazon EC2` vendor fields) in addition to the Xen `ec2` UUID prefix ([#8209](https://github.com/can1357/oh-my-pi/issues/8209)).
- Fixed DeepSeek Responses targets (opencode-go) rejecting a thinking-mode continuation with `400 The reasoning_text in the thinking mode must be passed back to the API` after a prewalk hand-off plus mid-run compaction: the Responses input builder re-encoded replayed assistant turns without a reasoning item, so the request enabled reasoning but shipped no `reasoning_text`. The encoder now synthesizes a `reasoning_text` reasoning item for every replayed assistant turn when the target requires reasoning replay in thinking mode (`requiresReasoningContentForAllAssistantTurns` / `requiresReasoningContentForToolCalls`), mirroring the chat-completions `reasoning_content` safety net ([#8248](https://github.com/can1357/oh-my-pi/issues/8248)).

## [17.2.12] - 2026-08-08

### Fixed

- Fixed account-scoped Codex cyber-policy denials bypassing sibling credential rotation; replay-safe requests now try every configured account before surfacing the error.

## [17.2.11] - 2026-08-07

### Breaking Changes

- Fixed handling of GitHub Copilot's model_not_available_for_integrator error to prevent unnecessary retries, preserving the actionable available models list.

### Added

- Added support for reporting Cursor personal monthly USD quotas and remaining balances, labeled by verified profile email accounts.

### Fixed

- Fixed an issue where ANTHROPIC_BASE_URL was ignored for Anthropic chat requests, ensuring requests are routed to the configured host and forwarding ANTHROPIC_CUSTOM_HEADERS to non-official gateways.
- Fixed an issue where a legacy pre-organization login credential could persist and cause a permanent error row in omp usage even after a successful organization-scoped re-login.
- Fixed an issue where lazy provider streams (including Amazon Bedrock, Google, Cursor, Devin, and Ollama) ignored model-specific idle timeouts, which previously caused healthy but slow reasoning turns to prematurely time out.
- Improved error classification for Simplified Chinese quota-exhaustion and rate-limit messages, ensuring affected credentials are correctly rotated or backed off instead of being treated as unknown errors.
- Classified subscription and plan-cap 429 responses as rotatable usage limits rather than transient rate-limit throttles, enabling smoother credential rotation.

## [17.2.10] - 2026-08-06

### Breaking Changes

- Removed the `zod` dependency and `z`/`ZodType` re-exports. Tool schemas now use `omptype` `type()` schemas, with Zod-style authoring still available via `@oh-my-pi/omptype/zod`.

## [17.2.9] - 2026-08-05

### Fixed

- Fixed GitHub Copilot requests failing with a raw `HTTP 400 model_not_available_for_integrator` on roughly half of all turns for recently rolled-out models. Copilot's fleet is not uniform — part of it rejects models that `/models` advertises on the same host — and the transient classifier matched only the older `model_not_supported` code at a fixed envelope depth, so these rejections surfaced as terminal errors instead of entering the existing retry path. Model-availability 400s are now recognized at any envelope depth and rerolled on a flat delay with a dedicated 8-attempt budget on the OpenAI transports; every other retryable failure keeps its previous backoff and attempt count.
- Fixed Cursor reads with inline OMP range selectors reporting the returned slice length as the source file's `totalLines`, which made sequential reads of an unchanged file appear inconsistent ([#7590](https://github.com/can1357/oh-my-pi/issues/7590)).
- Made model-scoped usage health ignore Codex accounts that cannot use the requested plan-gated model while retaining conservative unknown-state handling and independent usage-window resets.
- Fixed OpenAI Codex usage telemetry blocking explicitly allowed ChatGPT Team credentials when a weekly `used_percent` rounded to 100, which could route multi-account sessions to an actually exhausted sibling instead ([#7617](https://github.com/can1357/oh-my-pi/issues/7617)).
- Fixed OpenAI Codex GPT-5.x requests sending optional `reasoning.summary`, `reasoning.context`, and `text.verbosity` controls by default, reducing Codex `server_error` disconnects from unsupported request shapes. ([#4949](https://github.com/can1357/oh-my-pi/issues/4949))
- Classified concurrent-request caps separately from quota exhaustion so they use a short retry backoff without burning a credential, and rotate credentials for account-scoped 403 caps such as Devin's overall message limit.

## [17.2.7] - 2026-08-03

### Changed

- Replaced `arktype` with `@oh-my-pi/omptype` for schema validation, delivering up to 100x faster schema construction and 60-100x faster validation while maintaining full compatibility with existing `type`/`Type` exports and the `isArkSchema` contract.

### Fixed

- Fixed OpenAI-Codex (ChatGPT OAuth) requests failing with an `Unsupported service_tier: auto` error on default or legacy sessions by omitting the implicit `auto` service tier on the wire.
- Fixed an issue where Cursor `kimi-k3` sessions would break permanently when a same-model assistant turn was persisted without thinking blocks, replacing hard errors with graceful warnings.

## [17.2.6] - 2026-08-03

### Added

- Added profile-aware Bedrock Mantle region selection, authenticated model discovery, bearer-token or SigV4 authentication, and credential refresh handling for OpenAI Responses models.

### Fixed

- Fixed an issue where Ollama requests without a user-role message would fail to generate output or silently fail with a misleading error.

## [17.2.5] - 2026-08-03

### Changed

- Standardized tool-call examples in `renderToolExamples` and `renderToolInventory` to use Python keyword-argument syntax (`name(key="value")`) across all models, removing the model-specific dialect parameter and the `DialectRenderOptions.example` flag.
- Updated `renderToolInventory` to render the tool catalog as a unified OpenAI-Harmony-style `## functions` block using TypeScript type declarations and comments, replacing the previous per-tool Markdown sections.
- Added a `style: "harmony"` option to `jsonSchemaToTypeScript` for generating compact, comma-delimited TypeScript definitions.

### Fixed

- Fixed a session-blocking issue where unescaped Harmony control tokens in replayed assistant responses and tool inputs caused subsequent requests to be rejected with `invalid_prompt` errors.
- Fixed an issue where Codex Responses dropped native image-generation results from assistant content and replays due to stale `generating` statuses.
- Fixed Anthropic stream truncation handling where unexpected connection closures were incorrectly treated as clean stops, causing the agent loop to halt silently mid-sentence.
- Optimized Anthropic prompt caching to prevent unnecessary cache invalidation of the entire system prefix when volatile project footer details (such as current working directory, date, or workspace tree) change.

## [17.2.4] - 2026-08-01

### Fixed

- Fixed Codex WebSocket tool-result turns replaying full history when the preceding tool-call ID required Responses API normalization ([#7279](https://github.com/can1357/oh-my-pi/issues/7279)).
- Fixed direct Anthropic provider streams ignoring `model.compat.streamIdleTimeoutMs`. Requests dispatched through `streamAnthropic` can now widen the inter-event idle watchdog or set it to `0` to disable that watchdog; caller options and environment overrides retain precedence. Setting the compat value to `0` disables only the inter-event watchdog and leaves the first-event watchdog enabled; wider idle values continue to floor the first-event budget under the existing timeout contract.
- Fixed OpenRouter DeepSeek models failing structured subagents when the upstream returns an opaque HTTP 400 for a strict yield schema, retrying once without strict tools and remembering the fallback for the provider session ([#7264](https://github.com/can1357/oh-my-pi/issues/7264)).
- Fixed provider-native Codex compaction streams bypassing WebSocket-first transport selection and SSE transport fallback ([#7198](https://github.com/can1357/oh-my-pi/issues/7198)).
- Fixed `SqliteAuthCredentialStore.open()` running the `auth_credential_refresh_leases` DDL (`CREATE TABLE`/`CREATE INDEX`) with Bun's default `busy_timeout=0`, before the constructor's `#initializeSchema()` installed the busy handler. Under a concurrent write lock (e.g. WAL recovery on parallel omp startups) the lock-taking DDL failed immediately and, since the error wasn't BUSY-classified, bypassed `open()`'s bounded retry loop. The busy handler is now installed on the connection immediately after it opens, before any lock-taking statement, honoring the issue-#2421 invariant on every entry path. ([#7298](https://github.com/can1357/oh-my-pi/issues/7298))
- Fixed a corrupt credential store (`agent.db`) silently disabling every persisted rate-limit block. `AuthStorage` caught unrecoverable SQLite errors (`SQLITE_CORRUPT` family / `SQLITE_NOTADB`) from the persisted block read/write paths at `debug` level with no latch, so the broken store was re-queried on every credential evaluation while blocks quietly stopped applying. The first unrecoverable error is now reported once at `error` level with the store location and repair guidance, and every later persisted-block read/write short-circuits for the process lifetime; in-memory backoff still preserves availability ([#7296](https://github.com/can1357/oh-my-pi/issues/7296)).

## [17.2.3] - 2026-08-01

### Added

- Added the ai& (`aiand`) provider registry entry with API-key paste login validated against `https://api.aiand.com/v1/models`.

### Fixed

- Fixed Anthropic OAuth (Claude Pro/Max subscription) requests hard-429ing (`Usage credits are required for long context requests`) on every beta-gated 1M model — e.g. `claude-sonnet-4-6`, which the default `task`/`smol`/`scout` subagent roles resolve to — regardless of prompt size, breaking all subagents. The 17.2.1 cowork request profile reintroduced the `context-1m-2025-08-07` beta for any model with a 1M catalog window, but subscription credentials have no long-context credit balance so Anthropic rejects the request outright. The beta is no longer advertised on OAuth requests; subscription accounts transparently get the standard 200k window. ([#7238](https://github.com/can1357/oh-my-pi/issues/7238))
- Fixed OpenAI Codex Responses ignoring disabled cache retention when deriving `prompt_cache_key`, while preserving transport session identity ([#7219](https://github.com/can1357/oh-my-pi/issues/7219)).

## [17.2.2] - 2026-07-31

### Added

- Added support for the `gmi-cloud` provider registry, including API-key paste login validation and integration with `@oh-my-pi/pi-catalog`.

### Changed

- Updated `AuthStorage.redeemResetCredit` to prioritize spending the soonest-expiring available saved reset credit, and improved error handling to distinguish between transport failures (`credit_list_failed`) and a genuine lack of credits.
- Exported `SENSITIVE_TOKEN_RE` from `providers/transform-messages` to allow hosts to route credential shapes through reversible obfuscation instead of irreversible redaction.

### Fixed

- Fixed an issue where Cursor conversation checkpoints were incorrectly recorded as billable output tokens, ensuring accurate usage totals.
- Fixed an issue in `AuthStorage.refreshStoredOAuthCredential` where expired OAuth credentials were returned without being refreshed when a credential mismatch occurred, which previously resulted in misleading "No API key found" errors.
- Fixed Cursor history replay issues by preserving structured message order for assistant tool calls/results, retaining Kimi K3 thinking blocks, and preventing unsafe mid-session switches to K3.

## [17.2.1] - 2026-07-30

### Added

- Added exact OAuth credential-row resolution by durable credential id. The targeted path refreshes only that row and never ranks, rotates, or falls back to sibling accounts.

### Changed

- Anthropic OAuth requests now reproduce Cowork's current `claude-desktop` request profile, including client/runtime metadata, beta selection, system and billing attestation, the 64K output cap, and stable HTTP/1.1 header ordering.

## [17.2.0] - 2026-07-30

### Added

- Added first-class parentTurnId support for nested Codex requests, allowing stream options and metadata helpers to accept and safely propagate the initiating turn's ID.
- Added preservation of the Codex `encrypted_function_args` plaintext-collaboration marker on replayed function calls, keeping server-marked plaintext tool arguments from being reinterpreted as encrypted on subsequent turns.
- Added interactive Exa API-key login through `/login exa`, opening the official API-key dashboard and saving pasted keys to the credential store ([#1798](https://github.com/can1357/oh-my-pi/issues/1798)).
- Cursor's modern exec wire protocol is now handled end to end. `agent.proto` models the frames current Cursor CLI builds emit — the seven Pi tools (`ExecServerMessage` 45-51), hooks, subagents, allowlist prechecks, MCP state, smart-mode classification, canvas diagnostics, conversation search, agent-store conflicts and git diff — and every one of them gets a typed answer. The Pi frames run their local equivalents (`read`/`bash`/`edit`/`write`/`grep`/`glob`); the rest answer with the error, not-found or empty-but-valid variant that is actually true of this client. Frames this build cannot name at all now raise `ExecClientControlMessage.throw` with `unknown_exec_variant`, and recognised frames with no truthful answer (`git_diff_request`, whose `GetDiffResponse` has no error variant) raise `exec_variant_unsupported`, instead of a silent ack that leaves the server waiting.
- `lsp` is advertised in the MCP tool catalog again. It was filtered out as a Cursor-native tool, but the native `diagnostics` frame covers one of roughly ten LSP actions, so the other nine were unreachable.
- Added `pinSessionOAuthAccount` support for backdating the sticky's last-use timestamp (`options.lastUsedAtMs`), so pins restored from persisted sessions keep the provider's warm-window semantics: resumes inside the prompt-cache TTL reuse the account, stale resumes still re-rank.

### Changed

- Codex turn metadata now reserves the codex-rs `code_mode_tool_names` key, preventing caller-supplied client metadata extras from colliding with the core-owned field.
- Codex SSE requests to the official endpoint now use zstd-compressed bodies by default to match the official client, which can be disabled with PI_CODEX_ZSTD=0.
- API-key validation now preserves provider HTTP status and retry headers, allowing authentication, rate-limit, and server failures to retain their original error classifications.
- The Cursor Pi arg translation (`piReadPath`, `piJoinPath`, `piLsPath`, `piEscapeRegexLiteral`, `piLimit`) moved to `providers/cursor-pi-args`, re-exported from `providers/cursor/exec-modern` so existing imports are unaffected. The legacy pi shim shares these helpers and is compiled into the bundled virtual module registry, where a nested `providers/<dir>/<mod>` specifier is unresolvable under bunfs — and importing them from the exec module would drag the whole protobuf graph in for two string functions.

### Fixed

- Fixed Novita login rejecting valid API keys belonging to Developer and Basic team members by validating against the chat completions endpoint instead of the billing balance endpoint.
- Fixed Cursor resource_exhausted errors being incorrectly classified as QUOTA_EXHAUSTED (which caused 30-minute credential blocks), mapping them to MODEL_CAPACITY_EXHAUSTED with a shorter backoff instead.
- Fixed a crash in Amazon Bedrock and Devin providers when Context.systemPrompt is passed as a bare string.
- Fixed aborted usage-limit recovery incorrectly blocking credentials or waiting on local usage fetches after the session had already changed.
- Fixed Codex WebSocket sessions echoing stale or missing turn states by capturing x-codex-turn-state refreshes from response metadata event headers.
- Fixed Harmony-dialect models (e.g., gpt-5.x, openai-codex) failing with invalid_prompt or "Request blocked" errors by escaping reserved control tokens in untrusted user and tool-result text.
- Fixed named forced tool_choice not being enforced on string-only OpenAI-compatible hosts (such as llama.cpp and LM Studio) by narrowing the advertised tools to the forced tool.
- Fixed direct Anthropic Claude Opus requests failing with HTTP 400 when the endpoint rejects strict tool fields.
- Fixed usage-based credential ranking for Anthropic accounts where a missing long-window (7-day) metric was incorrectly treated as a short-window metric.
- Fixed legacy Codex usage blocks continuing to gate all models after per-meter backoff was introduced, splitting the old shared scope into independent chat and spark blocks while maintaining backward compatibility with older clients and database schemas.
- Fixed Anthropic retry loops ignoring `maxRetryDelayMs` for long server `retry-after` hints, so over-budget delays surface immediately without losing response details or abort cleanup ([#7003](https://github.com/can1357/oh-my-pi/issues/7003)).
- Added interactive xAI API-key login with key validation through the xAI models endpoint.
- Fixed Google Gemini and Vertex tool declarations carrying numeric, boolean, object-valued, or mixed `enum` arrays that the Google Schema wire type cannot represent. Unsupported enums are omitted while valid string enums remain constrained.
- Umans usage provider: fetches `GET /v1/usage` and surfaces the rolling 5h request window + concurrency limits in `/usage`, `omp usage`, and the TUI status bar.
- Fixed ranged legacy Cursor reads reporting the returned window byte length as the full file size.
- Updated the Cursor client build advertisement to activate the modern exec-frame protocol handled by this provider.
- Fixed a windowed Cursor `read` reporting the window's line count as the file's. `total_lines` and `file_size` were derived from the payload, which is the whole file only for an unranged read — a 20-line page of a 100-line file answered `total_lines: 20`, which a paginating server reads as the end of the file. The count now comes from the read's own record of the file (`details.meta.truncation.totalLines`), falling back to counting the payload when the read returned the file whole.
- Fixed a `pi_grep` that hit the native backend's internal match ceiling answering as an unqualified success. `GrepTool` folds that cap into the flat `details.truncated` alone, setting neither `details.truncation` nor `perFileLimitReached` — the two fields the Pi result was built from — so the one truncation a caller can neither detect nor page around was the one it was never told about. The flat flag is now translated into a `PiTruncation`, and only when no specific cap already reported itself.
- Fixed a `pi_grep` frame's `context` and `limit` vanishing from the transcript. The bridge honors both by building a scoped `grep`, but neither is expressible in the model-facing schema, so the synthesized block recorded a plain pattern/path search — replaying a context-widened or capped search as an ordinary grep sitting beside output no ordinary grep produces. Both are now recorded on the block.
- Fixed a Cursor MCP resource listing shrinking to a count in the transcript. The full URI/name/mime catalog goes out on the wire, but the paired local result recorded `Listed N MCP resource(s)` — and rebuilt history is serialized from that result, so one reload later the model knew it had seen N resources and could name none of them. The paired result now lists what the answer carried.
- Fixed the `pi_read` range translation padding the slice it asks for. `piReadPath` composed a plain `:N+K` selector, which the local `read` tool expands by one leading and three trailing context line — so a frame naming offset 5/limit 20 received lines 4-27. Ranged Pi reads now compose `:raw:N+K`; the wire result is an opaque output string, so the line-number gutter `raw` also drops carries nothing the contract needs.
- Fixed four Cursor exec frames answering with a result whose oneof was never set. In proto3 that is not an empty result — the server reads it as "the tool ran and produced nothing", indistinguishable from real success. `listMcpResourcesExecResult`, `readMcpResourceExecResult`, `recordScreenResult` and `computerUseResult` now send `ListMcpResourcesSuccess{resources: []}`, `ReadMcpResourceNotFound{uri}`, `RecordScreenFailure` and `ComputerUseError` respectively.
- The MCP resource frames now answer from the host instead of a fixed verdict. `CursorExecHandlers` gained `listMcpResources`/`readMcpResource`, so a host holding live MCP connections advertises them; the empty catalog and `not_found` above remain the answer when no handler is supplied. A handler that throws surfaces as `ListMcpResourcesError`/`ReadMcpResourceError` rather than collapsing into "none exist", which the model cannot retry. A read carrying `download_path` forwards it and answers with `ReadMcpResourceSuccess.download_path` and no content, which is what that mode means.
- Fixed Cursor `connect_scm` calls losing their repository and settling on a fabricated verdict. The target rides in the `ConnectScmArgs.target` oneof, so reading a flat `github` property always saw `undefined`; and the authoritative `success`/`error`/`rejected` result only arrives on the completion frame, so answering at the announcement persisted a fixed failure for every call — including the ones the server went on to accept. The block now opens on the start frame and settles from the completion's decoded result.
- Fixed interleaved Cursor tool calls corrupting each other. The stream decoder tracked a single "current" block and settled it on any `toolCallCompleted`, ignoring the envelope's `call_id`: a completion for one call closed whichever block happened to be open and paired it with the wrong result, and `start A, start B` orphaned A entirely so its own completion settled B while A was never paired — which strips the whole interaction from every rebuilt transcript. Open blocks are now retained per envelope `call_id`, and end-of-stream closes all of them rather than only the last.
- Fixed a Cursor `search_conversations` call leaving no transcript block. The frame is answered from a fixed verdict, so nothing downstream pairs a result for it, and an unpaired call takes its whole interaction out of every rebuilt transcript.
- Fixed a Cursor `read_mcp_resource` call leaving no transcript block. The frame runs locally — and in download mode writes a workspace file — but synthesized no tool call and paired no result, so the read was invisible in the UI and absent from every rebuilt history; a resource download could mutate the workspace with nothing on record. The frame now synthesizes a `read_mcp_resource` block (not `read`: it is a remote MCP operation, and the name drives rendering and prune semantics) and pairs a result on success, not-found and error alike. Frames answered without a handler still synthesize nothing, since nothing ran.
- Fixed a Cursor `list_mcp_resources` call leaving no transcript block. The model consumed the catalog, but the frame synthesized no tool call and paired no result — its streamed `ListMcpResourcesToolCall` announcement was equally unrecognized — so the listing was invisible in the UI and absent from every rebuilt history. Frames a handler answered now synthesize a `list_mcp_resources` block and pair a result derived from the same answer that went on the wire; frames answered from the fixed no-handler catalog still synthesize nothing, since nothing ran.
- Fixed an unavailable `pi_edit`/`pi_write` answering with the error variant. Both results model refusal and failure as separate oneof cases, and a denial reported as `error` reads as "the tool ran and broke" — inviting a retry of an operation that was never permitted. A frame whose tool is not granted, or whose handler produced nothing, now answers with `PiEditExecRejected`/`PiWriteExecRejected`; execution failures keep the error variant.
- Fixed a Cursor MCP approval probe actually running the tool. A modern `mcpArgs` frame carrying `smart_mode_approval_only` asks only whether a call would be permitted, not for the call itself. The decoder dropped the flag, so the frame ran a side-effecting MCP tool the user had not been asked about, then ran it again when the real call followed. The flag is now carried through and the probe is answered from the host's policy without executing: approved only for a definite allow, refused for a deny, for a mode that demands a prompt the frame cannot raise, and for a tool the session does not have. No transcript block is synthesized either, since nothing ran.
- Fixed the Cursor stream's end-of-transport cleanup erasing the arguments of every block still open. Blocks whose args arrive whole (todo, connect-SCM, MCP) never feed the streamed partial-JSON buffer, and reparsing an absent buffer yields `{}`, so a truncated or disconnected turn rebuilt those calls with no arguments at all. Only blocks that actually streamed their args are reparsed now.
- Fixed a Cursor stream dying mid-turn stranding the call it left open. `connect_scm` and native todo blocks are stamped resolved the moment they open, so the agent loop synthesizes no placeholder and only their completion frame pairs a result — a transport that closed first left the card animating and the call unpaired, which takes the whole interaction out of every rebuilt transcript. The terminal-error path now closes open blocks and pairs those server-owned calls with an interrupted result; the flush ran only on clean completion before, which is not the path a dying stream takes. Exec-settled MCP blocks are left alone, since the dispatch that ran them owns their result.
- Fixed the Pi exec frames displaying a different operation than the one they run. The provider synthesized its transcript block from a second, hand-rolled translation of the frame args, so `pi_read`'s `offset`/`limit` were shown as a whole-file read, `pi_grep`'s `literal` pattern as an unescaped regex, and `pi_find`'s path/glob join differed from the executed one. Both sides now share a single translation.
- Fixed the streamed `pi_*_tool_call` announcements that modern builds send alongside each exec frame being unrecognized. The exec channel already synthesizes those blocks when it runs the tool; the duplicate was avoided only because the decoder recognized none of the variants, which would have started double-rendering as soon as any one was added.
- Fixed `pi_bash` results reaching Cursor clipped with no truncation notice. Two truncation records exist locally: `read`/`grep` set `details.truncation`, which carries an explicit `truncated` flag, while `bash` sets `details.meta.truncation`, whose record has no such flag — its presence is the signal. `piTruncation` read only the first shape and required the flag, so every real Bash truncation was dropped and the server was told the clipped output was complete. Both shapes now translate, and an explicit `truncated: false` still suppresses the field.

## [17.1.8] - 2026-07-28

### Fixed

- Fixed an HTTP 400 error when resuming or replaying OpenAI history after an interrupted native Computer Use turn.
- Fixed connection 404 errors when using Google Vertex AI in multi-region locations (eu and us) by correctly resolving regional endpoint (REP) hosts.
- Fixed a resource leak in SqliteAuthCredentialStore.close() where unclosed prepared statements kept the SQLite connection alive, preventing database file cleanup (especially on Windows where files remained locked).

## [17.1.7] - 2026-07-27

### Changed

- Upstream `403 Forbidden` responses (e.g. Anthropic `permission_error` plan/model denials, Copilot model-policy rejections) now rotate through sibling credentials like usage limits do, instead of failing the session on the first denied account. The denied credential is soft-blocked for 60s and re-validated — never removed — and the original 403 surfaces only once every sibling has been tried.
- Usage report filtering in the auth-broker remote store is memoized per (reports, snapshot) with a precomputed per-provider OAuth credential map, replacing an O(reports × credentials) scan on every credential-selection and status refresh
- Cursor and Devin Connect-frame readers no longer copy every stream chunk through `Buffer.concat` when the pending buffer is empty

## [17.1.6] - 2026-07-27

### Added

- Added `getProxyForUrl()` for transports that need provider-specific and standard proxy environment resolution with `NO_PROXY` support ([#6770](https://github.com/can1357/oh-my-pi/issues/6770)).
- Added SiliconFlow and SiliconFlow (China) to the built-in API-key login provider catalog so `omp login siliconflow` / `omp login siliconflow-cn` stores a reusable credential validated against each region's `/v1/models` endpoint.

## [17.1.5] - 2026-07-27

### Fixed

- Fixed OpenAI Responses replay treating a tool output as paired with a matching call that appeared later in the input, or a tool call as paired with an earlier output. Pair repair now respects wire order before preserving or synthesizing each side.
- Fixed adaptive-thinking Anthropic models omitting the interleaved-thinking beta on signature-enforcing proxies, which caused persisted interleaved assistant turns to fail on replay ([#6717](https://github.com/can1357/oh-my-pi/issues/6717)).
- Kimi Code now sends its session-stable prompt cache key on both supported transports: `prompt_cache_key` for OpenAI-compatible requests and `metadata.user_id` for Anthropic-compatible requests. Explicit keys survive side-channel session IDs, while `cacheRetention: "none"` still disables automatic affinity ([#6049](https://github.com/can1357/oh-my-pi/issues/6049)).
- Fresh encrypted auth-broker snapshot caches are revalidated within a short startup budget, so one-shot clients see newly imported or revoked credentials immediately when the broker is reachable while retaining cache fallback for transport and server failures.
- Fixed custom `anthropic-messages` endpoints dropping native web-search call/result blocks in the leaked-thinking wrapper, preserving signed continuation history in source order without carrying a preceding text signature onto later unsigned blocks ([#6703](https://github.com/can1357/oh-my-pi/issues/6703)).

## [17.1.4] - 2026-07-26

### Added

- MiniMax Token Plan accounts now report quota in `omp usage`. `GET /v1/token_plan/remains` returns one bucket per plan quota, each carrying a rolling interval window and a weekly window, so `minimax-code` surfaces real remaining percentages instead of an empty report. A model the plan does not include comes back looking like an untouched quota; those buckets are dropped from the report and named in its metadata. The mainland id `minimax-code-cn` is untouched.
- OAuth logins now stamp `authorizedAt` (epoch ms of the interactive login) on the stored credential, and every refresh-persist path preserves it. Anthropic expires the whole OAuth grant family ~30 days after authorization regardless of refresh-token rotation (observed as `invalid_grant: "Refresh token expired"` on the latest rotated token, exactly 30 days after login, across four production accounts), so the login anchor is what makes re-login deadlines computable. Exported `ANTHROPIC_OAUTH_GRANT_TTL_MS` alongside the anthropic OAuth flow.
- Added `GET /v1/credentials/disabled` to the auth broker and `AuthBrokerClient.listDisabledCredentials`: disabled-credential tombstones (`DisabledCredentialSummary` — identity, verbatim disable cause, disable timestamp; never token material) so auto-disabled accounts stay visible to clients instead of silently vanishing from the snapshot. `AuthStorage.listDisabledCredentials` serves the same data locally from SQLite; clients of brokers predating the endpoint get an empty list (404 mapped, no error).
- Added `AuthStorage.revalidateCredentials()` and the optional `AuthCredentialStore.refreshSnapshot` hook: remote broker stores re-fetch `GET /v1/snapshot` on demand so callers pairing live per-credential data with stored identities (`omp usage`) never render against the up-to-an-hour-stale disk-cached snapshot; local SQLite stores are always current and only reload.
- Added an optional per-request `codexSseMaxAttempts` stream option to bound Codex SSE pre-response retries while preserving the six-attempt default when omitted.
- Fixed Cursor requests failing with `Connect error internal: Unable to parse image: ...` whenever the session history contained an image: `rootPromptMessagesJson` image parts now embed a `data:<mime>;base64,` URI instead of bare base64, matching the convention used by the OpenAI-completions provider ([#6564](https://github.com/can1357/oh-my-pi/pull/6564)).

### Fixed

- Fixed OpenAI Responses native history replay sending output-only `status` fields back as input, preventing `input[N].status` failures in long-running sessions. ([#6513](https://github.com/can1357/oh-my-pi/pull/6513) by [@Ant39140](https://github.com/Ant39140))
- Cursor no longer discards a local tool result when the transport fails mid-execution. The provider waits for in-flight exec dispatches before pushing `done`, but the error path skipped that wait, so a handler decoded from the last chunk landed its result after the Agent had already finalized the call from the terminal error and cleared its buffer — losing the real outcome of a tool that may already have run side effects. Both exits now drain the same barrier.
- Cursor exec handlers returning the bare-result form no longer record a failed call as successful. When an SDK handler returns only a protocol result (no paired `toolResult`), the synthesized transcript entry was always `"Tool produced no transcript result"` with `isError: false`, even for a `rejected` or `error` result — so Cursor saw a failure while the rebuilt transcript showed success. The synthesized entry now derives its state and message from the result's own oneof variant — including MCP, where an application-level tool failure rides inside the `success` variant as `is_error` rather than as a separate variant.
- Fixed Cursor models silently failing to maintain the todo list. Cursor resolves its native `update_todos`/`read_todos` tools server-side, but the bridge looked for them under flattened `updateTodosToolCall`/`readTodosToolCall` properties, which a decoded `agent.v1.ToolCall` never has — the variant only arrives through the `tool` oneof — so no native todo call was ever recognized. The synthesized `todo` tool call was also emitted as locally runnable with a `{todos}` payload the local tool's schema rejects, so any update that did surface ended as a validation error and local todo state never followed Cursor's. Todo calls are now read from the oneof, both native todo blocks are marked as already-resolved, and local state is mirrored from the server's confirmed success snapshot (leaving state untouched on `UpdateTodosError`). `TODO_STATUS_CANCELLED` now maps to `abandoned` instead of reverting the task to `pending`.
- Hardened Cursor todo mirroring against partial `read_todos` responses: a read narrowed by `status_filter`/`id_filter`, or one returning fewer rows than the server's own `total_count`, is a subset rather than the list, and is no longer treated as authoritative. Previously such a response would have deleted every task it omitted.
- Fixed an empty `update_todos` response whose `total_count` is nonzero being mirrored as an authoritative clear, deleting every local task at once. The count-mismatch guard skipped empty responses entirely; only a matching zero count is a genuine clear now. An empty `read_todos` stays refused outright, since proto3 decodes an unset `total_count` as `0` and it cannot be told apart from a filtered read that matched nothing.
- Fixed a Cursor todo call being left unpaired when the completion frame carried no `tool_call` at all. `ToolCallCompletedUpdate.tool_call` is optional, but the block was already marked as server-resolved by the started frame, so nothing emitted a placeholder for it and every transcript rebuild stripped the interaction. It now settles as "nothing to mirror", the same as a refused snapshot.
- Fixed local Cursor exec calls (`read`/`write`/`grep`/`delete`/`bash`/`lsp`/MCP) vanishing from rebuilt transcripts when the tool produced no result. The assistant block is synthesized and marked server-resolved before the handler runs, so the three result-less paths — no handler installed, a handler returning nothing, and a thrown handler — left the call unpaired. Each now pairs a result carrying the same text the server receives.
- Fixed Cursor MCP tool calls being unrecognized on the wire. `ToolCall.tool` is a protobuf oneof, so a decoded message exposes the variant as `{ case, value }` and never as a flat `mcpToolCall` property — the same trap that made native todo calls invisible while hand-shaped fixtures kept passing. Both the streamed start and the completion arg merge now go through a shared selector.
- Fixed a streamed Cursor MCP block being named from `name` while its paired result used `toolName`, so the two disagreed whenever the server sent different values. Both now prefer `toolName`.
- Fixed the Cursor stream emitting `done` while a tool handler decoded from the final chunk was still running. Server messages are dispatched fire-and-forget so the socket keeps draining, but nothing waited for them: when an exec request, `turnEnded` and the stream close arrived in one chunk, the turn finished before the handler produced its result, and the result missed the buffer drain that pairs it with its call. In-flight dispatches are now awaited after the transport completes.
- Fixed a server-resolved Cursor todo call leaving its transcript block stuck pending: the synthetic completion was emitted under a freshly generated id instead of the streamed call id the interactive transcript filed the block under, so the card animated indefinitely. The settled call id is now handed to the sync handler.
- Fixed server-resolved Cursor todo blocks disappearing from rebuilt transcripts: nothing produced a `toolResult` for them, and `buildSessionContext` strips any `toolCall` left unpaired, so the interaction vanished on reload, branch switch, or transcript rebuild. The result the host builds is now persisted verbatim — it carries the `details.phases` the todo renderer rebuilds the list from, which a summary-only result would have replayed as `0 tasks`.
- Fixed a refused or failed Cursor todo call leaving its card animating forever. Only a successful snapshot settled the block, so a `read_todos` narrowed by a filter and a server `UpdateTodosError` both went unanswered — no `tool_execution_end`, and no `toolResult` to keep the block from being stripped on rebuild. Every completed native todo call now settles. A server error is carried through as a failed result rather than collapsed into the benign "nothing to mirror" case, which would have replayed the failure as a success.
- Hardened Cursor todo mirroring against snapshots whose rows collide on content. Cursor's wire model identifies todos by `id` and can represent two rows sharing the same text; the local list is keyed by content alone and the `todo` tool rejects a duplicate outright, so importing such a pair would leave every task-targeted `done`/`drop`/`rm` resolving to the first row and the second unreachable. The snapshot is now refused like any other that cannot be represented locally — local state is left untouched and the call still settles as a no-op.
- Hardened Cursor todo mirroring against ambiguous empty `read_todos` responses. `total_count` is a proto3 scalar, so an unset field decodes as `0` and is indistinguishable from a genuinely empty list; accepting `todos=[]` + `total_count=0` would clear every local task. Empty and mismatched reads are now refused — `update_todos` remains the authoritative clear path.
- Fixed refused Cursor todo results claiming `"No todo changes"`. A server-accepted `update_todos` can still be declined locally (content collision, etc.), so the persisted fallback now reads `"Todo snapshot not mirrored"` instead of implying the remote call changed nothing.
- Hardened Cursor todo mirroring against snapshots carrying unresolved `TodoItem.dependencies`. The wire model blocks a row behind other rows by `id`; the local list has no ids and no edges, so an imported dependent row files as plain `pending` and `nextActionableTask` then offers work the server considers blocked. Snapshots with an edge pointing at a row that is not yet `completed`/`abandoned` are now refused like any other that cannot be represented locally. Edges whose blockers already finished constrain nothing and still mirror.
- Extended the Cursor todo `total_count` mismatch guard to `update_todos`. A partial or size-limited merge response is as incomplete as a filtered read, but the check only applied to reads, so an update returning fewer rows than its own count was mirrored as the full list and deleted every task it omitted. An empty update still syncs — it remains the authoritative clear path, unlike an ambiguous empty read.
- Hardened Cursor todo mirroring against rows with empty `content`. `content` is a proto3 string, so a missing or default value arrives as `""`; the local list is keyed by content and rejects a falsy one before lookup, leaving the imported row unreachable to every task-targeted `done`/`drop`/`rm`. Such snapshots are now refused like any other that cannot be represented locally.
- Fixed a deterministic circular-import TDZ that crashed `packages/catalog`'s test process with `ReferenceError: Cannot access 'claudeCodeVersion' before initialization`: `registry/oauth/anthropic.ts` imported `claudeCodeVersion` from `providers/anthropic.ts`, which transitively pulls the registry back in (`providers/anthropic` → `stream` → `registry` → `registry/oauth/anthropic`), so the module-level `claude-code/${claudeCodeVersion}` bootstrap user-agent const read the binding while `providers/anthropic.ts` was still mid-initialization. `claudeCodeVersion` now lives in a zero-import leaf module (`providers/claude-code-fingerprint.ts`) that `providers/anthropic.ts`, `registry/oauth/anthropic.ts`, and `usage/claude.ts` all import from, removing the cycle at the source rather than deferring the read.
- Fixed a circular initialization between the Anthropic provider and OAuth registry that could throw before `claudeCodeVersion` was initialized when package tests or consumers loaded modules in parallel ([#6628](https://github.com/can1357/oh-my-pi/pull/6628) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Stopped the account-level Codex `rate_limit.limit_reached` flag from being applied to individual chat windows. Codex reports one shared flag for the whole account, so a window with real headroom was marked `exhausted` because a different window (or a separate metered feature) was at its limit, which over-blocked sibling accounts during credential selection. Each window's status now reflects only its own usage
- Scoped Codex reactive backoff per meter: a `usage_limit_reached` from a Spark request no longer persists a block that ordinary chat requests honour, and the reverse. Blocks written before scoping used a shared scope meaning "block everything", so requests still honour it and reconciliation still heals it
- Implemented `scopeLimits` for the Codex ranking strategy so a request gates only on the windows it actually consumes: `-spark` models spend the Spark meter and every other model spends the 5h/weekly chat windows, instead of OR-ing every window and meter into one provider-wide block
- Fixed native Anthropic adaptive-only models (Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5) keeping thinking ON when reasoning was meant to be off. `mapOptionsForApi` never consulted `disableReasoning` on the Anthropic branch, so a caller-side disable left adaptive thinking at full effort; and `disableThinkingIfToolChoiceForced` deleted `output_config.effort` alongside `thinking`, which for adaptive-only models silently re-enabled adaptive thinking (a bare omission defaults to adaptive-ON). Both paths now omit `thinking` and pin the lowest adaptive effort, so `disableReasoning` and forced `tool_choice` turns (e.g. the delivery reviewer's `report_delivery`) actually suppress reasoning instead of returning a thinking block with `end_turn` ([#6589](https://github.com/can1357/oh-my-pi/issues/6589)).
- Fixed Bedrock Converse dropping captured Claude thinking signatures when replaying application-inference-profile ARN models, restoring adaptive-thinking multi-turn conversations ([#6610](https://github.com/can1357/oh-my-pi/issues/6610)).
- Fixed the `alibaba-token-plan` login only supporting the international Singapore endpoint, which rejected China (Beijing) Token Plan `sk-sp-` keys with `401 invalid_api_key`. Login now selects a region (International / China (Beijing) / Custom), validates the key against that region's `/models` endpoint, and stores the chosen base URL in the credential so inference and discovery both target it ([#6682](https://github.com/can1357/oh-my-pi/issues/6682)).
- Fixed statusless provider capacity errors such as `no_capacity` and high-demand responses being treated as terminal instead of retryable. ([#6503](https://github.com/can1357/oh-my-pi/issues/6503))
- Fixed QwenCloud Token Plan quota reporting to call the current console usage RPC and document how to capture its optional Cookie during login.
- Fixed Cursor exec-channel MCP calls such as `web_search` omitting `toolCall` blocks when no interaction block arrives, which rendered their tool cards below the final assistant answer or dropped them on transcript replay. ([#6501](https://github.com/can1357/oh-my-pi/issues/6501))
- Fixed Claude scoped weekly limits (e.g. `Claude 7 Day (Fable)`) with `is_active: false` being dropped by the `/usage` parser, rendering as `not reported` in `omp usage` despite carrying real utilization. Live payloads mark only the currently binding limit active — an account pinned at a 100% Fable cap reports its 77% shared weekly row as inactive too — so `is_active` signals severity ranking, not bucket existence, and is now ignored. Exhaustion gating is unchanged: tier rows still hard-block only at confirmed 100% with a future reset.
- Fixed a TDZ crash (`Cannot access 'claudeCodeVersion' before initialization`) when `providers/anthropic` was the first module loaded: `providers/anthropic` → `stream` → `registry` → `registry/oauth/anthropic` circled back into the still-initializing provider module. The Claude Code fingerprint constants now live in the leaf module `providers/claude-code-fingerprint` (star re-exported from `providers/anthropic`, so import paths are unchanged).

## [17.1.3] - 2026-07-24

### Fixed

- Fixed Cursor sessions exposing `ast_edit` (and other staged-preview `xd://` devices) without a reachable resolver: the built-in `write` tool — which carries the `xd://resolve` / `xd://reject` transport that finalizes a staged preview — was filtered out of Cursor's forwarded catalog, so previews could never be resolved and the session aborted after three forced `write` turns. `write` is now re-included in the forwarded catalog whenever pi-agent devices are advertised ([#6536](https://github.com/can1357/oh-my-pi/issues/6536)).
- Fixed OpenAI Responses and chat-completions streams honoring per-model first-event watchdog policy, allowing local llama.cpp-style backends to process arbitrarily large prompts without a premature client cancellation ([#6524](https://github.com/can1357/oh-my-pi/issues/6524)).

## [17.1.2] - 2026-07-24

### Added

- Added `GET /v1/usage/history` to the auth broker (recorded usage-limit snapshots with `sinceMs`/`provider` filters) and `AuthBrokerClient.fetchUsageHistory` — in broker deployments the broker host performs every upstream usage fetch, so its durable history is the only complete utilization record
- Added per-client burn tracking to the auth broker: clients batch observed request usage per (provider, model) and flush it to `POST /v1/usage/observed` every 10 seconds (install id as client key, hostname as display name); the broker persists 5-minute buckets in `client_usage`/`clients` and serves aggregates from `GET /v1/usage/clients`. Brokers without the endpoint disable reporting for the process lifetime

### Changed

- Renamed the Z.AI feature quota row to `ZAI Zread Quota` (tier/id slug `zread`), replacing the 74-char `ZAI Web Search / Reader / Zread Quota (web-search-reader-zread)` title that wrapped `omp usage` rows

### Fixed

- Fixed every Claude (`anthropic-messages`) model on the `opencode-zen` provider failing with `401 Missing API key`: the gateway requires `x-api-key`, so `opencode-zen` now uses X-Api-Key auth like `opencode-go`/`umans` instead of bearer-only, and no longer sends the `context_management` field its Anthropic proxy rejects on thinking requests ([#6510](https://github.com/can1357/oh-my-pi/issues/6510)).
- Fixed Anthropic native server-tool blocks being dropped from persisted assistant turns, preserving signed web-search continuations in their original response order ([#6495](https://github.com/can1357/oh-my-pi/issues/6495))

## [17.1.1] - 2026-07-24

### Added

- Added `setCodexAttestationProvider` API for injecting `x-oai-attestation` headers in ChatGPT-OAuth Codex requests
- Added OAuth account session pinning and active status tracking in storage
- Added OpenAI Responses native computer-use transport, including batched actions and exact `computer_call`/`computer_call_output` replay with pending/acknowledged safety checks and `image_url`/`file_id` output references. Models without native support receive the same action surface as a regular function tool; provider-specific tool-choice forcing is used where supported.
- Added `PI_CODEX_RESPONSES_LITE` to override the catalog-selected Codex Responses transport for diagnostics (`1`/`true` forces Lite; `0`/`false` forces the standard body).
- Added caller-owned `cachedContent` on `google-generative-ai` and `google-vertex` GenerateContent options: pass an opaque cache resource name through the shared builder (blank values rejected); no create/refresh/delete lifecycle and no guessed model/project/location validation; existing `cachedContentTokenCount` → `Usage.cacheRead` normalization is unchanged.
- Added Anthropic extra-usage reporting across `omp usage`, interactive `/usage`, and ACP `/usage`: the OAuth usage endpoint's authoritative `spend` payload (or legacy `extra_usage` fallback when absent) is normalized into a `Claude Extra Usage` USD row; capped accounts show limit/remaining/fractions and status, while uncapped spend exposes only its absolute used amount—rendered as `$… used` in CLI/TUI and `123.45 usd used` in ACP—without a fabricated cap, percentage, or status. ([#5575](https://github.com/can1357/oh-my-pi/issues/5575))
- Added process-scoped OAuth account pools for trusted auth-broker clients via `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE`, consistently filtering snapshots, streaming updates, refreshes, and usage reports to selected OAuth identities while leaving API-key credentials and the shared encrypted snapshot cache unrestricted.
- Added opt-in Vercel AI Gateway automatic prompt caching for OpenAI Chat Completions while preserving `only` and `order` routing preferences.
- Added Vercel AI Gateway Responses cache anchors and cache lifetimes, emitted only with automatic caching.
- Added opt-in OpenAI GPT-5.6 explicit prompt-cache controls for Responses and Chat Completions. Existing requests remain implicit; the policy marks at most one existing stable-history block and is rejected locally on unsupported explicit routes.
- Forwarded `statefulResponses` through `streamSimple`, so diagnostic callers can explicitly disable OpenAI Responses `previous_response_id` chaining.
- Added native QwenCloud Token Plan API-key login, model discovery, and an optional interactive console-Cookie prompt for 5-hour and 7-day quota reporting ([#6151](https://github.com/can1357/oh-my-pi/issues/6151)).
- Added model-scoped usage health and same-provider reselection for native coding-plan credential pools, preserving OAuth/login-pool precedence, scoped broker blocks, sibling rotation state, and conservative unknown-account handling while excluding ordinary configured API keys ([#5018](https://github.com/can1357/oh-my-pi/issues/5018)).

### Fixed

- Fixed stateful OpenAI Responses explicit cache breakpoints being restored onto edited historical messages, ensuring full replays recompute the latest stable cache boundary.
- Fixed ChatGPT Codex standard and Lite transports rejecting or hiding native computer-use payloads by unrolling the tool definition, forced choice, `computer_call`, and `computer_call_output` into ordinary function-tool forms.

## [17.1.0] - 2026-07-24

### Added

- Added support for caller-owned `cachedContent` on Google Generative AI and Google Vertex AI `GenerateContent` options, allowing passing of opaque cache resource names.
- Added Anthropic extra-usage reporting across CLI, interactive, and ACP usage endpoints, normalizing the authoritative `spend` payload into a 'Claude Extra Usage' USD row with accurate limit, remaining, and status details.
- Added process-scoped OAuth account pools for trusted auth-broker clients via `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` to filter snapshots, updates, refreshes, and usage reports to selected OAuth identities.
- Added opt-in Vercel AI Gateway automatic prompt caching for OpenAI Chat Completions, including support for cache anchors and cache lifetimes.
- Added opt-in explicit prompt-cache controls for OpenAI GPT-5.6+ Responses and Chat Completions, supporting stable boundary selection, stateful Responses markers, and future GPT-5.x/6.x models.
- Added support for forwarding `statefulResponses` through `streamSimple` to allow diagnostic callers to explicitly disable OpenAI Responses `previous_response_id` chaining.
- Added native QwenCloud Token Plan support, including API-key login, model discovery, and an optional interactive console-Cookie prompt for quota reporting.
- Added interactive Meta Model API key login and support for `MODEL_API_KEY` and `META_API_KEY` environment variables.
- Added model-scoped usage health tracking and same-provider reselection for native coding-plan credential pools.

### Fixed

- Fixed AWS Bedrock cache checkpoints to use resolved model compatibility, falling back to the provider-default 5-minute cache for unsupported 1-hour retentions, emitting AWS-recommended explicit checkpoints for Nova models (Lite, Micro, Pro, Premier, Nova 2 Lite), and honoring configured checkpoint maxima.
- Fixed Pi-native and compatibility-wrapper requests dropping cache controls required by `omp bench --cache` to preserve explicit prompt-cache affinity and allow disabling OpenAI Responses chaining.
- Fixed outbound credential-pattern redaction running unconditionally; it is now opt-in via `configureCredentialRedaction` and disabled by default.
- Fixed SuperGrok (`xai-oauth`) `/usage` reporting for unified-billing accounts by falling back to the default monthly limit and usage payload when credit usage percentages are absent.
- Fixed sessions wedging with a `400 Invalid signature in thinking block` error when switching Anthropic-compatible providers by stripping signatures whose issuing provider differs from the target.
- Fixed OAuth callback servers aborting login on premature invalid callbacks, and restricted `localhost` callback listeners to the IPv4 loopback interface.
- Fixed Google Gemini CLI and Antigravity OAuth login hanging indefinitely during Cloud Code Assist project provisioning by introducing request timeouts, cancellation checks, and bounded polling.

## [17.0.9] - 2026-07-23

### Added

- Added Synthetic (synthetic.new) usage provider: `/usage` now reports the rolling 5-hour request limit and weekly credit quota via `GET /v2/quotas`, including per-tick regeneration rates in the window labels.
- Added optional `UsageWindow.resetLabel` so rolling windows can render their countdown with an accurate verb (e.g. "tick in 12m" / "regen in 51m" instead of "resets in") — both quota windows on Synthetic regenerate incrementally rather than hard-resetting.

### Fixed

- Fixed GitHub Copilot OpenAI-compatible requests being rejected when the session's native OpenAI service tier was set to `priority` ([#5160](https://github.com/can1357/oh-my-pi/pull/5160) by [@audreyt](https://github.com/audreyt)).
- Fixed OpenAI Responses token-cap truncations suppressing fully streamed function and custom tool calls whose inputs are complete.
- Added SuperGrok (`xai-oauth`) usage tracking for weekly credits, product limits, and positive on-demand caps.

## [17.0.8] - 2026-07-22

### Fixed

- Fixed Gemini Flash Cloud Code Assist empty-response retries when responses contain only intercepted planning-leak JSON.
- Fixed Antigravity auto-routing to correctly fail over to the sandbox endpoint when the daily endpoint exhausts its retries.
- Fixed OpenAI-compatible providers configured with auth: none incorrectly sending an Authorization: Bearer N/A header, which broke custom endpoints using alternative authentication headers.
- Fixed auth-gateway model listings exposing duplicate or ambiguous model IDs by ensuring only provider-qualified routing IDs are advertised.
- Improved connection error handling by classifying generic connection failures as transient, allowing them to be retried, while keeping explicit authentication rejections non-retryable.
- Fixed custom Anthropic base URLs losing native thinking signatures during continuation requests.
- Fixed Alibaba Coding Plan Custom login rejecting valid API keys on endpoints that do not serve the default validation model by validating against the model catalog instead.

## [17.0.6] - 2026-07-20

### Fixed

- Fixed OpenAI Codex credentials limited to one ChatGPT workspace per email: a personal Plus/Pro plan and a Team/Enterprise seat under the same email now coexist in the auth store — with separate rotation and usage pools — instead of the second login silently replacing the first. The workspace (`chatgpt_account_id`) is captured as the credential's org at login with the plan type as its display label, and two members of one workspace keep separate rows ([#2966](https://github.com/can1357/oh-my-pi/issues/2966)).
- Fixed Devin total-token usage omitting cache reads and cache writes.
- Fixed model switches to Devin rejecting foreign provider response IDs, reasoning signatures, and empty interrupted turns as invalid Cascade history.
- Classified zero-output Devin `invalid_argument` trailers as context overflow when the serialized message history is already large, routing cumulative tool-output payload failures through context maintenance—including artifact-backed shake rescue—instead of retrying the same rejected history.

## [17.0.5] - 2026-07-18

### Changed

- Changed Anthropic API-key requests to default to a 1-hour prompt-cache retention (using the extended-cache-ttl-2025-04-11 beta) to prevent cold-misses during idle sessions, with support for PI_CACHE_RETENTION values "short" and "none" to override this behavior.

### Fixed

- Fixed transient OpenAI stream truncations by retrying once before output becomes replay-unsafe, preventing recoverable transport errors from failing the turn.
- Fixed native Kimi Code K3 thinking being disabled during named function selection by utilizing generic required tool choice.
- Fixed /login moonshot validating China-platform API keys against the international host instead of honoring MOONSHOT_BASE_URL.
- Fixed Anthropic session stickiness suppressing usage-based re-ranking indefinitely by gating stickiness on a 1-hour cache warmth window (configurable via ANTHROPIC_SESSION_STICKY_CACHE_WARM_MS) to restore proactive multi-account load balancing after long idle periods.
- Fixed credential ranking where clockless Anthropic usage windows incorrectly outranked clocked sibling credentials.
- Fixed tool request failures (HTTP 400) on local grammar-constrained OpenAI-compatible backends (such as llama.cpp, LM Studio, and vLLM) by widening bare boolean subschemas into a value-accepting primitive union.
- Fixed custom OAuth Anthropic-compatible endpoints receiving generated Claude Code fingerprint headers even when explicit header overrides were provided.
- Fixed active sessions for plan-gated OpenAI Codex models (Sol/Luna) silently re-routing to sibling OAuth accounts when usage headroom changed, ensuring session stickiness is preserved as long as the preferred credential remains usable and eligible.

## [17.0.4] - 2026-07-18

### Fixed

- Fixed Kimi Code usage reports dropping the 5h window reset time (`omp usage` showed no "resets in …" for the 5h limit): the API returns `resetTime` on the limit `detail`, not on `window`, so the parsed row-level reset is now carried onto the window when the window itself has none.
- Made Kimi device-id persistence best-effort: a missing or unwritable `~/.omp/agent` directory no longer throws during Kimi header construction, which silently nulled every `kimi-code` usage probe on fresh installs.
- Coerced boolean tool-schema subschemas to MFJS object forms for native Moonshot/Kimi endpoints, preventing the task tool's `outputSchema` field from causing HTTP 400 responses ([#5952](https://github.com/can1357/oh-my-pi/issues/5952)).

## [17.0.3] - 2026-07-17

### Fixed

- Replaced the opaque `h2 is not supported` failure on the Cursor run transport with an actionable error naming the ALPN-stripping proxy as the cause and pointing at the `providers.cursor.baseUrl` HTTP/2 bridge workaround. The run RPC is HTTP/2-only, so behind a TLS-intercepting proxy that strips ALPN (e.g. Zscaler) bun cannot negotiate `h2` and the completion cannot proceed ([#5828](https://github.com/can1357/oh-my-pi/issues/5828)).
- Restored the `createAssistantMessageEventStream()` root export used by legacy provider extensions ([#5879](https://github.com/can1357/oh-my-pi/issues/5879)).
- Fixed parallel Responses tool-result images interleaving synthetic user messages before all pending outputs, preventing strict OpenRouter/Moonshot backends from rejecting follow-up requests. ([#5850](https://github.com/can1357/oh-my-pi/issues/5850))
- Fixed Kimi Code K3 requests to send native named efforts (`low`, `high`, `max`) and use adaptive effort rather than generic token budgets on explicit Anthropic transport overrides ([#5893](https://github.com/can1357/oh-my-pi/issues/5893)).
- Automatically invalidate and rotate OAuth credentials when an "invalidated oauth token" error occurs
- Fixed Anthropic usage reports treating the organization response header as the account identity, which caused the 5h/7d status-line segment to disappear for OAuth credentials without stored organization metadata. ([#5698](https://github.com/can1357/oh-my-pi/issues/5698))

## [17.0.2] - 2026-07-17

### Fixed

- Automatically invalidate and rotate OAuth credentials when an "invalidated oauth token" error occurs.
- Fixed auth-broker snapshot validation rejecting API keys stored via the `/login` flow, restoring support for gateway/broker setups serving login-sourced keys on custom hosts.
- Fixed an issue where literal reasoning tags (e.g., `<think>`) inside Markdown code blocks or inline code were incorrectly treated as reasoning boundaries, which corrupted the rendered Markdown.
- Classified HTTP 402 and "balance exhausted" quota responses as persistent usage limits, enabling automatic rotation of multi-account requests to a sibling credential.
- Fixed `kimi-code` Anthropic-format requests ignoring custom provider base URLs.
- Fixed an issue where GPT-5.6 Codex Responses-Lite requests failed with an HTTP 400 error due to invalid `tool_choice` parameters after tools were rewritten, by automatically downgrading forced hosted choices to `tool_choice: "auto"` while preserving explicit tool-use constraints.
- Fixed Cursor streams prematurely reporting success before late CONNECT or gRPC terminal failures were observed, and resolved issues rejecting transport ends without a `turnEnded` signal.

## [17.0.1] - 2026-07-16

### Fixed

- Fixed OpenRouter cost reporting to use the provider's authoritative account charge instead of catalog token-price estimates on both Responses and Chat Completions streams.
- Fixed OpenAI Responses and Chat Completions requests forwarding unsupported sampling parameters such as `temperature` to o-series and GPT-5+ models, preventing 400 errors for mnemopi memory calls through GitHub Copilot GPT-5.6 Luna. ([#5606](https://github.com/can1357/oh-my-pi/issues/5606))
- Fixed boolean JSON Schema subschemas (`true`/`false`) in MCP tool inputs triggering `400 INVALID_ARGUMENT` on the Google/Cloud Code Assist (Antigravity) transport by coercing them to their object equivalents (`true` → `{}`, `false` → `{ not: {} }`) before sending ([#5604](https://github.com/can1357/oh-my-pi/issues/5604)).
- Fixed thinking-enabled Claude requests routed to `google-vertex` sending the `effort-2025-11-24` beta as an `anthropic-beta` HTTP header, which Vertex rawPredict rejects with a 400. The effort beta and the `output_config.effort` field are now gated off the Vertex path the same way `context-management-2025-06-27` already is ([#5614](https://github.com/can1357/oh-my-pi/issues/5614)).
- Fixed custom and Foundry-routed Anthropic endpoints receiving first-party eager/legacy tool-streaming controls ([#5572](https://github.com/can1357/oh-my-pi/issues/5572)).
- Parsed Ollama NDJSON response bytes directly instead of decoding and buffering every network chunk as text. ([#5542](https://github.com/can1357/oh-my-pi/issues/5542))
- Fixed Amazon Bedrock stream error handling for non-`Error` values that `JSON.stringify` cannot serialize ([#5539](https://github.com/can1357/oh-my-pi/issues/5539)).
- Fixed concurrent provider OAuth refreshes by serializing rotating-token updates across processes, fencing stale writes, and preventing background usage probes from disabling otherwise usable credentials ([#5396](https://github.com/can1357/oh-my-pi/issues/5396)).
- Fixed OpenAI Codex WebSocket connections ignoring `PI_PROXY`, provider-specific proxy settings, and standard HTTPS/ALL proxy variables ([#5384](https://github.com/can1357/oh-my-pi/issues/5384)).
- Fixed Anthropic account quota exhaustion (`This request would exceed your account's monthly spend limit`) hanging until the local deadline instead of surfacing the error: the `rate_limit_error` "spend limit" wording is now classified as a persistent usage limit, so it fails fast and rotates to a sibling credential rather than looping in the provider retry backoff. ([#4787](https://github.com/can1357/oh-my-pi/issues/4787))
- Fixed OpenRouter daily free-model allowance errors (`free-models-per-day`) being treated as transient rate limits, so requests rotate from an exhausted API key to a healthy sibling credential. ([#4832](https://github.com/can1357/oh-my-pi/issues/4832))

## [17.0.0] - 2026-07-15

### Changed

- Improved Ollama streaming performance by parsing NDJSON response bytes directly instead of decoding and buffering network chunks as text.

### Fixed

- Fixed Cursor TLS connection resets causing process-fatal uncaught exceptions, allowing the active turn to fail or retry gracefully without terminating the session.
- Fixed Amazon Bedrock stream error handling to correctly handle non-Error values that cannot be serialized by JSON.stringify.

## [16.5.2] - 2026-07-14

### Added

- Added OpenAI Codex rate-limit response-header ingestion to proactively refresh account usage snapshots and rotate credentials before hitting 429 errors.

### Changed

- Optimized multi-account credential ranking to maximize quota utilization and prevent mid-session blocks by prioritizing expiring quota and demoting heavily used accounts.
- Improved responsiveness of credential blocking by bypassing the usage-ingestion throttle immediately when an account is detected as exhausted.

### Fixed

- Fixed empty provider responses (such as from Cloud Code Assist API) being treated as non-retryable, allowing session retries and model-fallback chains to engage.
- Fixed OpenAI Codex watchdog timeouts bypassing transport and session retries by ensuring each request attempt has an independent timeout signal.

## [16.5.1] - 2026-07-14

### Added

- Added Cursor OAuth and access-token usage reporting to `omp usage` via Cursor's account usage endpoint.

### Fixed

- Fixed OpenAI Responses `content_filter` terminal events being auto-retried as provider finish errors, ensuring content-filtered turns remain hard failures without triggering a retry loop.
- Improved credential rotation on usage and account-quota failures to cycle through all eligible credentials instead of stopping early, while maintaining rate-limit backoffs and safety guards.
- Fixed GLM tool call parsing to correctly handle and recover from missing or mistyped argument closers, preventing subsequent arguments from being swallowed.
- Fixed Anthropic credential management and usage routing for users with multiple organizations under a single email. Credentials, OAuth refreshes, usage reports, and active sessions are now correctly partitioned and isolated by organization, preventing subscriptions from overwriting or merging with each other.
- Fixed OpenAI and Codex response finalization to preserve streamed text when receiving empty content on completion. ([#5146])
- Fixed OpenAI Chat Completions request parsing to correctly accept assistant tool-call replay messages with null content. ([#5121])
- Fixed session-sticky OAuth credential mappings remaining active after credential changes, ensuring sessions correctly reselect accounts after login or logout. ([#4982])
- Fixed concurrent reasoning summaries to ignore legacy streaming events under cutoff contracts.
- Fixed Codex saved-reset redemption to apply to the selected OpenAI account in multi-account configurations. ([#5054])
- Updated the OAuth completion page to instruct users to close the tab manually when the browser blocks automatic window closing. ([#4855])
- Fixed Cursor `max_mode` requests to correctly send max-mode metadata on both model payload fields. ([#4797])
- Fixed configuration discovery to support both nested and flat YAML formats for `auth.broker.url` and `auth.broker.token` keys. ([#4734])

## [16.5.0] - 2026-07-13

### Added

- Added diagnostic response headers to auth-gateway inference endpoints, including request IDs (x-request-id/request-id), LiteLLM model metadata (x-litellm-model-id/x-litellm-model-api-base), and performance/cost metrics (x-litellm-response-cost, x-litellm-response-duration-ms, openai-processing-ms) on non-streaming responses.

### Changed

- Updated Google and Google Vertex providers to always use streamGenerateContent requests.

### Fixed

- Fixed empty provider responses (such as from Cloud Code Assist API) being classified as non-retryable, allowing session retries and model-fallback chains to engage instead of failing the turn.

### Removed

- Removed automatic /interactions chaining for follow-up turns in Google provider calls, along with the useInteractionsApi, storeInteraction, and previousInteractionId stream options.

## [16.4.6] - 2026-07-12

### Added

- Added asynchronous `invalidateUsageCache` method to clear cached usage reports
- Added support for cross-service usage cache invalidation between AuthStorage and AuthBroker

### Fixed

- Fixed OAuth credential resolution returning "No API key found" when every plan-eligible OpenAI Codex account was rate-limit blocked and the only unblocked account failed the model's plan gate: resolution now runs a last-resort ladder that first yields a plan-fitting account regardless of usage blocks (so callers get real usage-limit retry semantics), then tries every account with the plan filter dropped before reporting no credential

## [16.4.5] - 2026-07-11

### Fixed

- Fixed an issue in GLM tool calling where missing or malformed argument closers (such as `<arg_value>` mistyped as `</arg_key>`) caused subsequent arguments to be swallowed or merged into a single field, affecting both in-band and native tool calling.

## [16.4.3] - 2026-07-11

### Fixed

- Fixed auth database upgrades from schema v5 by creating the OAuth credential refresh-lease table before lease statements are prepared.
- Fixed an issue in the Responses API where empty tool results were incorrectly serialized with a "(see attached image)" placeholder, causing models to look for non-existent attachments.
- Fixed OpenAI Responses server non-streaming envelopes to always include the required "incomplete_details" field, using null for completed responses.
- Preserved Cloud Code Assist tool schemas when mixed-type unions carry branch-local validation descriptions.

## [16.4.2] - 2026-07-10

### Fixed

- Fixed compatibility with xAI by automatically downgrading OpenAI-specific tool calls and image detail settings during message history replays.
- Fixed a race condition in shared SQLite OAuth token refreshes by implementing durable credential ownership and compare-and-set persistence to prevent stale refresh failures.
- Fixed OpenAI Codex requests to include the required version header for newly gated models.

## [16.4.1] - 2026-07-10

### Changed

- Enforced `all_turns` reasoning context for all Responses Lite requests

## [16.4.0] - 2026-07-10

### Added

- Added "max" as a first-class reasoning effort option across providers (including Anthropic, Google, Bedrock, and OpenAI), supporting a maximum reasoning budget of 32,768 tokens.
- Added and standardized the "Responses Lite" wire contract and transport, enabling automatic activation via model-level catalog flags, moving tools and instructions into developer input items, disabling parallel tool calls, and stripping image detail instead of falling back to the full transport.
- Added support for concurrent reasoning summaries on Codex Responses using the sequential-cutoff streaming contract.
- Added Novita API-key login with authenticated key validation and automatic NOVITA_API_KEY environment variable discovery.

### Changed

- Recognized Pro Lite as a paid plan tier for OpenAI Codex models.

### Fixed

- Fixed xAI SuperGrok multi-account rotation to correctly treat HTTP 403 credit exhaustion and spending limit errors as usage limits, triggering a credential rotation to a sibling account.
- Fixed error classification for AWS credential-resolution failures (AwsCredentialsError) to correctly map them as authentication failures.
- Fixed OpenAI-compatible chat-completions streams to preserve vLLM-style trailing cached-token usage chunks, ensuring accurate cacheRead and billable input session statistics.
- Fixed xai-oauth/grok-4.5 Responses requests to omit the unsupported reasoning.summary field while preserving the reasoning.effort payload.
- Fixed Codex OAuth credential selection to re-check blocked accounts during ranking and clear stale usage-limit blocks once live usage indicates recovery.
- Fixed sequential-cutoff reasoning summaries duplicating section headers across Codex reasoning items by tracking the cumulative summary response-globally, so replayed sections and replay-only items no longer re-emit text earlier thinking blocks already streamed.

## [16.3.15] - 2026-07-09

### Breaking Changes

- Renamed `OpenAIResponsesCacheOptions`, `normalizeOpenAIResponsesPromptCacheKey`, and `getOpenAIResponsesPromptCacheKey` to the endpoint-neutral `OpenAICacheOptions`, `normalizeOpenAIPromptCacheKey`, and `getOpenAIPromptCacheKey`.

### Added

- Added automatic prompt-cache affinity header injection for OpenAI-family chat completions
- Added support for explicit prompt-cache affinity headers in OpenAI-family chat completions
- Added OpenAI pro reasoning mode support: models carrying the catalog `reasoningMode: "pro"` marker (GPT-5.6 Pro aliases) send `reasoning: { mode: "pro" }` on OpenAI Responses and Codex Responses requests, alongside the configured effort. The Codex request body now honors `requestModelId` so catalog aliases request the base upstream model id.

### Changed

- Updated xAI OAuth to use a dedicated device-code flow instead of redirect/loopback server

### Fixed

- Improved account routing for GPT-5.6 models to better respect paid tier requirements
- Refined account selection logic to correctly identify plan types from account metadata
- Fixed OpenAI Codex multi-account routing for GPT-5.6: Sol and Luna requests now prefer Plus-or-higher accounts while Terra remains available to Free/Go accounts; local pro-mode aliases inherit their base model's Codex plan eligibility.
- Fixed xAI Grok OAuth login to use xAI's device authorization flow: `/login` now opens the verification URL, displays the device code, and polls for approval instead of asking for a pasted redirect or linking to Hermes Agent documentation.

## [16.3.14] - 2026-07-09

### Changed

- Updated Codex reasoning effort mapping to support shifted wire tiers for newer models

### Fixed

- Fixed the Codex Responses request transformer bypassing catalog/compat reasoning effort maps: the clamped user effort is now remapped to the provider wire tier (GPT-5.6's shifted five-tier scale sends `max` for user `xhigh` and `xhigh` for `high`), failing loudly if a map produces a value outside the Codex wire vocabulary.

## [16.3.13] - 2026-07-09

### Changed

- Changed the xAI Grok OAuth (`xai-oauth`) provider to use manual code-paste login by default. `/login` now accepts a pasted authorization code or full `http://127.0.0.1:56121/callback?code=...` redirect URL without starting a local callback listener ([#3277](https://github.com/can1357/oh-my-pi/pull/3277) by [@Jaaneek](https://github.com/Jaaneek)).
- Renamed the xAI Grok OAuth provider in login and credential prompts to "xAI Grok OAuth (SuperGrok or X Premium+)" ([#3277](https://github.com/can1357/oh-my-pi/pull/3277) by [@Jaaneek](https://github.com/Jaaneek)).

### Fixed

- Fixed the generic lazy-stream idle watchdog aborting healthy `cursor-agent` streams with "Provider stream stalled while waiting for the next event" while a Cursor exec-channel local tool (shell/read/grep/write/MCP/…) legitimately ran longer than the idle budget. Provider streams now advertise consumer-side local work in flight and the watchdog slides its deadline instead of aborting; genuinely silent streams still time out. ([#4593](https://github.com/can1357/oh-my-pi/issues/4593))
- Fixed OpenAI Codex/Responses reasoning streams so streamed thinking content is preserved when the final `output_item.done` reconstructs to an empty summary ([#4918](https://github.com/can1357/oh-my-pi/issues/4918)).
- Fixed Anthropic streams hanging forever when generation wedges mid-stream (notably long `write` tool calls on Opus 4.8 high/xhigh) while the server keeps sending `ping` keepalives: pings now extend the idle watchdog only within a bounded window (3x the idle timeout) since the last real stream event, so a stalled tool-call stream times out and recovers instead of hanging with no retry path ([#4900](https://github.com/can1357/oh-my-pi/issues/4900)).

## [16.3.12] - 2026-07-08

### Added

- Added `AssistantMessage.toolCallAbortMessages` for per-tool placeholder labels on aborted assistant turns ([#2783](https://github.com/can1357/oh-my-pi/issues/2783)).

### Fixed

- Fixed Anthropic replay 400s (`tool_use ids were found without tool_result blocks immediately after`) when a persisted assistant turn carries content after a completed tool call — such as a mid-turn `server-side-fallback` handoff (fallback block plus continued text/tool calls after the primary model's `tool_use`) or trailing text from cross-provider replays — by stable-partitioning assistant content so all `tool_use` blocks trail the non-`tool_use` chain. ([#4781](https://github.com/can1357/oh-my-pi/issues/4781), [#544](https://github.com/can1357/oh-my-pi/issues/544))
- Fixed access-token-only OAuth credentials attempting token refresh with an empty refresh token after expiry.
- Fixed gateway usage-limit retries falling through to cross-provider model fallback before trying a sibling credential from the same provider.
- Fixed Codex usage-limit rotation treating Plus and K-12 accounts as separate quota groups for shared 5-hour/7-day windows.
- Fixed OpenAI Responses streams that end with `response.done` being misclassified as premature stream closures.
- Fixed OpenCode Go `/login` credentials being shadowed by an existing `OPENCODE_API_KEY` env fallback after switching accounts. ([#4688](https://github.com/can1357/oh-my-pi/issues/4688))
- Fixed OpenAI Codex WebSocket continuations to treat proxy stale-anchor codes such as `codex_previous_response_stale` as an expired `previous_response_id` chain — same recovery class as the OpenAI-standard `previous_response_not_found` — so the turn is retried with full context instead of surfacing the error to the user ([#4624](https://github.com/can1357/oh-my-pi/issues/4624)).
- Fixed Azure Foundry Anthropic utility requests to omit the structured-output beta whenever strict tools are disabled, preventing `structured_outputs not supported in your workspace` failures for Sonnet 5 compaction ([#4679](https://github.com/can1357/oh-my-pi/issues/4679)).
- Fixed OAuth `launchUrl` advertisement for flows whose redirect never returns to the local callback server: custom-scheme redirects (e.g. GitLab Duo's `vscode://` URI, which `new URL` parses without complaint) and fixed non-loopback hosts no longer receive a `http://localhost:<port>/launch` copy target that misrepresents the callback endpoint and resolves nowhere for remote users.
- Codex load balancing: clear stale persisted and in-memory usage-limit blocks for an `openai-codex` account when a fresh live usage report shows it is allowed and below all limits, including broker-backed gateway snapshots, so traffic returns to recovered accounts instead of funneling to one sibling.

## [16.3.11] - 2026-07-06

### Fixed

- Fixed `openai-codex-responses` fresh plan execution requests that contained only system/developer guidance by mirroring the final instruction as user input so Codex accepts the first turn. ([#4714](https://github.com/can1357/oh-my-pi/issues/4714))
- Fixed Codex WebSocket compact/resume delta diagnostics to record request shape and raw-vs-displayed usage buckets, so persistent server-reported uncached suffixes without `orchestration_*` fields are visible in debug stats. ([#4707](https://github.com/can1357/oh-my-pi/issues/4707))

## [16.3.10] - 2026-07-06

### Fixed

- Fixed Ollama/Ollama Cloud EOS-only completions to retry empty stops with a single output token before the agent loop can halt silently. ([#4659](https://github.com/can1357/oh-my-pi/issues/4659))
- Fixed Claude Sonnet 5 failing every request on feature-gated gateways (Azure Foundry, OpenAI-compatible relays) that reject strict tools with "structured_outputs not supported" — the rejection is now classified as a strict-tool rejection, so the request retries without strict tools and the session remembers the downgrade.

## [16.3.7] - 2026-07-05

### Fixed

- Fixed formatting of demoted reasoning blocks to prevent accidental concatenation with prose
- Fixed terminal whitespace issues in assistant messages that caused rejections by Anthropic API
- Fixed Cursor provider handling of empty-pattern grep arguments to return a clear, actionable error instead of a generic error and a broken TUI rendering.
- Fixed Google Cloud Code Assist API (Antigravity) and Gemini CLI to immediately bubble up underlying API errors (such as safety or recitation blocks) instead of incorrectly retrying and hiding them behind a generic empty-response message.
- Fixed GitHub Copilot OpenAI Responses replay to prevent empty reasoning-only assistant turns from being persisted in history and poisoning subsequent requests.
- Fixed classification of provider gateway quota-insufficient errors so they are correctly identified as usage-limit errors rather than generic 403 failures.
- Fixed OpenAI-compatible Responses models (such as DeepSeek endpoints) to preserve user-configured tool strictness settings unless strict mode is explicitly unsupported.
- Fixed custom openai-codex-responses providers failing when no ChatGPT account ID claim is present by omitting the header when it cannot be derived.
- Fixed token accounting for OpenAI Responses and Codex providers to correctly include provider-side orchestration tokens in billing totals without misclassifying them as uncached prompt input.
- Fixed Google Gemini and Cloud Code Assist providers to preserve the requested reasoning tier when sending requests with hidden thinking summaries.
- Fixed parallel OpenAI-compatible tool-call streaming to prevent argument data from bleeding across concurrent commands when identifiers are missing.
- Fixed Anthropic Claude reasoning and thinking replay handling. Same-model replays now drop unsigned prior reasoning blocks to prevent reasoning-extraction refusals, while cross-model replays (including Bedrock cross-region profiles) correctly demote reasoning without emitting raw thinking tags or causing text-flattening formatting issues.
- Fixed custom OpenAI-compatible relays serving standard OpenAI model IDs to be correctly classified as OpenAI-family targets for fast mode.

## [16.3.6] - 2026-07-04

### Added

- Persisted credential rate-limit blocks across processes: `auth_credential_blocks` (auth schema v5) stores per-credential blocks keyed by row id + provider key + block scope with MAX-upsert semantics, `AuthStorage` merges persisted and in-memory blocks on read, and auth-broker snapshots/SSE carry per-entry blocks with `POST /v1/credential/:id/block` and `DELETE /v1/credential/:id/blocks` endpoints so gateway and sibling omp processes stop re-discovering exhausted accounts by burning a 429 each.

### Fixed

- Fixed Anthropic credential selection sampling Fable/Mythos-exhausted accounts on every new session: a Fable/Mythos weekly cap now proactively hard-blocks the credential when confirmed exhausted (server `exhausted` status or used fraction >= 1) with a live `resetsAt`, and a live Fable 429 extends the reactive block to the confirmed tier reset instead of the 60s default. Unconfirmed rows (missing/expired reset, below cap) remain ranking hints only, preserving the false-100% guard.
- Fixed Ollama/Ollama Cloud tool requests failing with HTTP 400 by rewriting boolean subschemas (`true`/`false`) into a value-widening `anyOf` union of primitive types, stripping boolean `additionalProperties`/`unevaluatedProperties`, and flattening nullable `type` arrays before serializing tool parameters, so unconstrained fields still advertise "any JSON value" to grammar-constrained samplers (llama.cpp) instead of collapsing to an empty object. ([#4488](https://github.com/can1357/oh-my-pi/issues/4488))

## [16.3.5] - 2026-07-04

### Added

- `OAuthCallbackFlow` now serves a `GET /launch` route on its loopback callback server that 302-redirects to the pending authorization URL, and exposes that short URL as `OAuthAuthInfo.launchUrl`. UIs can advertise it as a truncation-safe copy target (~30 chars) instead of the full authorize URL, so terminals narrower than the composed row cannot silently drop OAuth query parameters like `code_challenge_method=S256` ([#4418](https://github.com/can1357/oh-my-pi/issues/4418)).
- Preserved explicit `tool.strict === false` on OpenAI-family function tool payloads (openai-responses, openai-codex-responses, openai-completions) so backends that distinguish `strict: false` from an omitted flag stop over-filling optional arguments ([#4336](https://github.com/can1357/oh-my-pi/issues/4336)).

### Fixed

- Fixed tool-call validation to strip stray trailing line terminators on schema-matching enum values and on well-known identifier fields (`path`, `paths`, `file`, `file_path`, `url`, `uri`, `title`, `label`) before dispatch, keeping ordinary trailing spaces and content-carrying fields (`content`, `input`, `code`, `command`, etc.) intact ([#4461](https://github.com/can1357/oh-my-pi/issues/4461)).

## [16.3.4] - 2026-07-03

### Added

- Added support for Baseten as an AI provider

### Changed

- Improved Claude usage reliability by removing proactive hard-blocking for Fable and Mythos tiers

### Fixed

- Fixed Anthropic OAuth account rotation to exclude unreliable model-scoped Fable/Mythos weekly caps from proactive hard-blocking, ensuring they act only as ranking priority hints while still allowing reactive 429-fallback to rotate and reach serviceable siblings.

## [16.3.3] - 2026-07-02

### Added

- Added comprehensive tracking and credential-ranking support for Anthropic per-tier and weekly usage limits, including Claude Fable weekly caps. This prevents a single exhausted model-scoped cap from blocking the entire OAuth credential and improves credential selection based on drain-rate pressure.

### Changed

- Updated Claude Fable reasoning replay to use bare text instead of wrapped thinking tags

### Fixed

- Improved robustness of single-argument tool calls by automatically remapping mislabeled string arguments.
- Fixed Anthropic OAuth usage reporting to stop retrying on 429 rate-limit errors.
- Fixed usage cache to correctly persist null values during cold-start failure backoff windows.
- Fixed cursor-agent persisted transcripts losing tool-call structure for native execution tools, ensuring replayed tool results are correctly paired with their corresponding calls.
- Fixed OpenAI-compatible streaming usage parsing to prefer non-zero nested cached token counts when the root cached_tokens value is zero.
- Added automatic detection and remediation for custom proxies returning signature errors on Anthropic thinking blocks, allowing the client to automatically retry with unsigned blocks and prompt the user to adjust their configuration.
- Fixed potential hangs in GitLab Duo Workflow setup by adding proper timeout and abort signal handling to REST fetches.
- Fixed Cursor proxy tunnel setup hanging indefinitely by adding abort and timeout handling.
- Fixed Devin Connect streaming reader vulnerability to corrupt frame lengths by capping payloads at 16 MiB and throwing an envelope error immediately.

## [16.3.1] - 2026-07-02

### Changed

- Removed automated injection of reasoning suppression prompts in OpenAI responses

## [16.3.0] - 2026-07-02

### Added

- Added opt-in support for Anthropic's server-side fallback beta (server-side-fallback-2026-06-01) on the anthropic-messages provider, including support for AnthropicOptions.fallbacks and automatic filtering of fallback blocks during cross-provider message transformations.

### Changed

- Improved stream healing for official first-party endpoints (Anthropic, OpenAI, and OpenAI Codex) by skipping leaked-thinking healing, preventing misfires on legitimate code blocks while maintaining healing for third-party gateways and custom base URLs.
- Updated CoreWeave Serverless Inference login instructions to clarify persisting COREWEAVE_PROJECT in shell startup files.

### Fixed

- Fixed an issue where same-model Anthropic message replays incorrectly demoted unsigned thinking into textual content during API calls
- Fixed a performance issue where broker usage fetch failures were not cached, causing redundant network requests when the broker is offline.
- Fixed Xiaomi MiMo API key validation to use the supported mimo-v2.5 model.
- Fixed certificate verification errors for custom gateways behind private CA bundles by ensuring NODE_EXTRA_CA_CERTS is respected across all provider fetches.
- Fixed Claude Fable demoted-thinking replay to use markdown-italic assistant prose instead of <thinking> tags, preventing context issues after model switches.
- Fixed OpenAI Responses replay errors (400 Bad Request) caused by missing reasoning items during history replay.

## [16.2.13] - 2026-07-01

### Fixed

- Fixed pre-5.4 OpenAI Codex models (`gpt-5.1-codex`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`) rejecting requests with `Unsupported parameter: 'reasoning.summary' is not supported with this model` by gating `reasoning.summary` behind the same gpt-5.4 wire floor as `reasoning.context: "all_turns"`.

## [16.2.12] - 2026-07-01

### Changed

- Improved streaming performance for Cursor and Devin providers by optimizing mid-stream tool-call argument parsing to prevent UI stalls when handling large payloads.

### Fixed

- Fixed issues with tool call streaming where tool call IDs, partial JSON payloads, or late-arriving IDs could be lost, filtered, or incorrectly initialized.
- Fixed an issue where stream healing for leaked thinking blocks could replace live tool-call blocks with empty-id placeholders, breaking streamed tool arguments on Anthropic-compatible streams.
- Fixed an issue where stalled auth-gateway SSE responses could hang indefinitely in pi-native streams by ensuring first-event and idle timeout watchdogs are properly honored.
- Fixed cross-turn tool-call loops going undetected by adding a guard for consecutive identical tool calls. (#3971)

## [16.2.11] - 2026-07-01

### Fixed

- Fixed streaming UI glitches and resolved an issue where invalid empty tool call IDs were persisted in the chat history.

## [16.2.10] - 2026-06-30

### Added

- Added streaming support for keyed parameter argument deltas in XML-family in-band tool call scanners (Anthropic, DeepSeek, XML, Minimax)

### Changed

- Improved native tool-call passthrough in `wrapInbandToolStream` to accurately mirror live streaming IDs, arguments, and partial JSON states from the underlying provider

### Fixed

- Fixed a bug where tool calls with empty or missing IDs were not detected as malformed, causing API validation failures (e.g., 400 errors with Anthropic) on subsequent requests
- Raised Gemini header runaway threshold to prevent premature interruption of complex reasoning loops
- Fixed leaked ` ```thinking ` fences with nested language-tagged Markdown code blocks so inner fences remain inside structured thinking instead of leaking as visible reply text.

## [16.2.9] - 2026-06-30

### Added

- Added `OAuthCallbackFlowOptions.allowPortFallback` to allow disabling random-port fallback, enabling strict port enforcement and early configuration errors for OAuth flows with static redirect URIs.

### Changed

- Improved `OAuthCallbackFlow` port conflict error messages to include the busy port, configured redirect URI, and actionable remediation steps.

### Fixed

- Fixed an issue where malformed tool-call JSON from local Ollama or llama.cpp models was incorrectly retried as generic 500 errors, now surfacing a clear recovery message.
- Fixed a race condition in OAuth callback flows where abort signals triggered before the callback listener was registered were ignored.

## [16.2.7] - 2026-06-30

### Added

- Added service tier support for Google Gemini and Vertex AI, including model-specific service tier configurations via ServiceTierByFamily.
- Added Google Vertex AI Interactions API support for Gemini 3+ models by default, with automatic fallback to :streamGenerateContent and a useInteractionsApi: false option to force standard generation.
- Added support for explicit Vertex bearer access tokens via GOOGLE_CLOUD_ACCESS_TOKEN or CLOUDSDK_AUTH_ACCESS_TOKEN environment variables.

### Changed

- Updated service tier logic to use per-provider configurations instead of global scopes.
- Refactored priority request billing and accounting to better align with specific provider capabilities.
- Updated API key resolution precedence so explicit environment variables (e.g., GEMINI_API_KEY) override stored or broker-migrated static API keys, while deliberate OAuth logins still take highest precedence.

### Fixed

- Improved Vertex AI reliability by automatically falling back to global endpoints on 404 errors.
- Fixed safety setting application for Google Vertex AI models.
- Fixed Kimi Code's Anthropic-compatible request path to keep thinking enabled and downgrade forced tool choice for Kimi K2.7 Code title generation.
- Fixed leaked reasoning fences (such as ```thinking or <think>) across all providers by splitting them into structured thinking blocks during streaming.
- Fixed Codex requests failing with unsupported all_turns errors on older models (gpt-5.1 and gpt-5.3) by gating the reasoning.context: "all_turns" default to gpt-5.4+ models.

## [16.2.6] - 2026-06-29

### Fixed

- Fixed Antigravity usage reporting to correctly infer daily and weekly quota windows from unlabeled reset-only rows, preventing Cloud Code Assist payloads from collapsing these counters into the default category.

## [16.2.5] - 2026-06-28

### Fixed

- Fixed Google and Cloud Code Assist streams that end without a finish reason (dropped connections or truncated responses) being treated as fatal; they are now classified as transient so the coding agent automatically retries.

## [16.2.4] - 2026-06-28

### Added

- Enabled freeform tool patch support for Azure OpenAI and Codex models

### Fixed

- Fixed usage reporting for Antigravity and Z.AI to correctly surface and preserve distinct quota windows (daily, weekly, monthly) instead of collapsing or duplicating them
- Fixed an issue where `/usage show` returned "No usage data available" when using a custom proxy base URL for Codex
- Fixed OpenAI stream read errors being incorrectly classified as non-transient, enabling the coding agent to automatically retry after recoverable stream failures

## [16.2.3] - 2026-06-28

### Changed

- Enabled automatic removal of leaked reasoning tags for all models
- Prevented reasoning text duplication when models emit both structured and inline thinking
- Defaulted reasoning context to all turns for all Codex requests.

### Fixed

- Enabled freeform tool patch support for Azure OpenAI and Codex models.
- Fixed an issue where the `/usage show` command returned "No usage data available" when using a custom proxy base URL for Codex.

## [16.2.2] - 2026-06-27

### Added

- Added a comprehensive, public-facing error module exported via the "./error" path, featuring structured error classification, provider-specific HTTP error classes (e.g., Anthropic, OpenAI, Gemini), OAuth/Auth-specific errors, rate-limit utilities, and retryability predicates.

### Changed

- Updated OpenAI Codex defaults to increase default text verbosity to medium, enable detailed reasoning summaries by default, and include all turns in the reasoning context by default.
- Updated the OpenAI Codex WebSocket transport to resolve its configuration (via PI_CODEX_WEBSOCKET_* environment variables) once at startup rather than re-parsing on every request.
- Enhanced cross-model reasoning recovery and preservation to render demoted reasoning in the target model's canonical inline thinking dialect (such as Gemini's thinking fence or standard think tags) to prevent leaking inert context or control tokens into history.
- Broadened the leaked-thinking stream healer to recover reasoning emitted in any dialect's canonical idiom (including Gemini, Gemma, Harmony, and scratchpads) and route them to thinking events instead of raw markup.
- Implemented automatic retry logic for detected thinking-loop stalls to improve response reliability.
- Hardened stateful delta chaining to ignore transient streaming bookkeeping symbols during structural equality checks, preventing unnecessary full-transcript replays.

### Fixed

- Fixed preservation of OpenAI Responses assistant message phase values across auth-gateway parsing, streaming, and history replay, ensuring GPT-5.4/GPT-5.5 intermediate updates and final answers retain their original phase labels.

### Removed

- Removed Pi dialect support and related serialization/parsing logic.

## [16.2.0] - 2026-06-27

### Breaking Changes

- Removed the `@oh-my-pi/pi-ai/utils/json-parse` module. The JSON repair and parsing helpers (`repairJson`, `parseJsonWithRepair`, `parseStreamingJson`, `parseStreamingJsonThrottled`) have been moved to `@oh-my-pi/pi-utils` to be shared across utilities.

### Added

- Added the GitLab Duo Agent provider (`gitlab-duo-agent`) and built-in implementation, renaming the existing AI Gateway proxy provider to "GitLab Duo Non-Agentic" (`gitlab-duo`).
- Added GitLab Duo Workflow provider support, featuring OAuth login via the official VS Code OAuth application, automatic project discovery, and automatic session-time namespace Duo settings enablement.
- Added runaway detection for Gemini models to interrupt streams stuck in excessive planning steps.
- Added a per-provider in-flight request limiter for LLM streams, shared across local OMP processes and configurable via `maxInFlightRequests`.
- Added a `credits` field to `UsageResetCredits` to display when banked rate-limit resets expire, with support for OpenAI Codex usage details.

### Changed

- Optimized GitLab Duo Agent and Workflow providers to use an inline custom "ambient" flow with MCP-only agent privileges, registering MCP tools under their bare names.
- Improved GitLab Duo Agent context management and auto-compaction by lowering the soft overflow threshold to 1 MB and stripping redundant bytes (such as tool-call UUIDs and escaped JSON) from the goal transcript.
- Enhanced GitLab Duo Agent prompt engineering to render replayed tool calls as past-tense records, reducing model confusion and preventing the model from mimicking historical markers.
- Added caching for discovered GitLab Duo Agent root namespaces per account to avoid redundant discovery requests.

### Fixed

- Fixed various GitLab Duo Agent and Workflow stability issues, including infinite tool-call loops, connection hangs on half-open WebSockets, and unhandled step-limit or generic server-side failures.
- Improved GitLab Duo Workflow routing, namespace resolution, and project-path handling, ensuring correct numeric ID resolution and support for self-managed GitLab relative install base paths.
- Fixed GitLab Duo Workflow checkpoint streaming to correctly map reasoning entries to thinking blocks, preserve tool boundaries, and accurately report token usage.
- Fixed `AuthStorage.login` to only synthesize manual-code paste prompts for paste-code providers, preventing terminal-blocking races on loopback OAuth flows.
- Fixed llama.cpp compatibility by downgrading named forced `tool_choice` objects to the string `"required"` in the chat-completions encoder.
- Fixed `omp usage` omitting Ollama and Ollama Cloud accounts by registering placeholder usage providers.
- Fixed Gemini reasoning-runaway detection to expose a dedicated thought-summary header guard to interrupt streams stuck in planning loops.

### Removed

- Removed legacy GitLab Duo Workflow `chat` and `software_development` flow paths and the non-MCP action bridge in favor of the inline custom `ambient` flow.

## [16.1.23] - 2026-06-26

### Added

- Added a third streaming thinking-loop detection heuristic to catch "progress-lexicon stalls" where models endlessly reshuffle motivational filler without introducing new vocabulary or concrete technical references
- Added branded wordmark and logo animation to authentication flow
- Added a third streaming thinking-loop detection shape — a _progress-lexicon stall_ — alongside verbatim tail repetition and near-duplicate (trigram) segments. It catches reasoning-summarizer loops that reshuffle the same motivational filler ("just doing it, pushing ahead, maintaining momentum") into fresh word order every paragraph: word-trigrams never cluster, but a run of substantial segments that recycle the recent vocabulary and introduce no _new_ concrete reference (path / identifier / code-span) trips the guard. Summarizer title/heading lines (`**Bold Title**`, `## Heading`) are stripped before analysis so their ever-changing wording cannot mask the stall by inflating novelty. Calibrated against 537k real non-Gemini reasoning blocks (zero false positives at novelty floor 0.2 / run length 8; the real loop sustains runs of 10+).
- Added CoreWeave Serverless Inference provider login support via `COREWEAVE_API_KEY` and `WANDB_API_KEY` fallback.

### Changed

- Redesigned the OAuth callback page (`oauth.html`) to match the oh-my-pi web brand language: OKLCH purple-tinted dark neutrals, magenta→iris→cyan brand gradient on the wordmark, frosted-glass card over an ascii grid backdrop, and a colored status halo around the success/error icon. All assets are inlined; the `__OAUTH_STATE__` injection contract and success/error JS logic are unchanged.

### Fixed

- Fixed local llama.cpp (and any local OpenAI-compatible server rendering the Qwen3.6+ chat template) re-processing the full prompt every new user message even with `replayReasoningContent` enabled (#3541 follow-up to #3528). Sending `reasoning_content` alone wasn't enough: Qwen3's chat template strips `<think>...</think>` from any assistant turn whose index is `<= last_query_index`, so the moment a new user message (the user's next prompt, or the auto-learn capture-at-stop nudge) lands, every prior assistant turn becomes "older" and is re-rendered without the `<think>` block — diverging from the generation tokens still in the slot's KV cache. The chat-completions encoder now emits `preserve_thinking: true` for Qwen thinking dialects on local servers, route-split the same way the existing `enable_thinking` emission is: the `qwen` dialect rides the top-level field (llama.cpp's `--jinja` hook and Alibaba Cloud Model Studio's compatible-mode), the `qwen-chat-template` dialect (NVIDIA NIM, vLLM/SGLang's chat-template-kwargs path) rides only `chat_template_kwargs.preserve_thinking` because NIM's request schema is `additionalProperties: false` and rejects unknown top-level fields (#2299). The emission is hoisted above the `reasoning.enabled` gate so it fires for THREE cases the original gating missed: (1) runtime-discovered local Qwen models that ship with `reasoning: false` because the upstream `/v1/models` doesn't advertise the capability (same gotcha #3532 fixed for `replayReasoningContent`), (2) caller-disabled reasoning (`/think off`) — the kwarg is a history-rendering knob, not a per-turn thinking switch, and the slot still holds `<think>` tokens from earlier turns, and (3) forced-tool-choice / DeepSeek-style auto-disable. Qwen3.6+ then renders `<think>...</think>` for every assistant turn regardless of position, and the next-turn render matches the cached generation tokens. ([#3541](https://github.com/can1357/oh-my-pi/issues/3541))

## [16.1.22] - 2026-06-26

### Fixed

- Fixed llama.cpp / LM Studio / vLLM (and any local OpenAI-compatible server on a loopback or RFC1918 baseUrl) re-processing the full prompt on every assistant continuation when the prior turn produced `reasoning_content`: the `openai-completions` encoder dropped the preserved `thinking` block on re-serialization for compat profiles without `requiresReasoningContentForToolCalls` / `thinkingFormat: "zai"`, so the chat template re-rendered the assistant turn without `<think>…</think>` and the rendered tokens diverged from the slot's KV cache state. The auto-learn capture-at-stop nudge made it reproduce on every turn. The encoder now replays preserved thinking as `reasoning_content` (honoring the streamed signature when it identifies a recognized wire field — `reasoning_content` / `reasoning` / `reasoning_text` — and falling back to the configured `reasoningContentField` for opaque signatures) whenever the new `compat.replayReasoningContent` flag is set, and the cross-API `transformMessages` predicate (`openAICompletionsReplaysUnsignedThinking`) honors the same flag ahead of the `model.reasoning` gate so a switch into a discovered local target (where the spec carries `reasoning: false` because the upstream `/models` endpoints don't advertise the capability) still preserves the prior turn's thinking block as signature-stripped reasoning instead of demoting it to conversation text. The chat-template-rendered prefix stays byte-stable across turns and llama.cpp's prefix KV cache survives. ([#3528](https://github.com/can1357/oh-my-pi/issues/3528))

## [16.1.21] - 2026-06-26

### Fixed

- Restored the `pollOAuthDeviceCodeFlow` export from `@oh-my-pi/pi-ai/oauth` so legacy provider extensions can reuse the host OAuth device-code poller. ([#3508](https://github.com/can1357/oh-my-pi/issues/3508))

## [16.1.20] - 2026-06-25

### Fixed

- Fixed Ollama/Ollama Cloud native chat responses that finish with `done_reason: "length"` and no assistant content surfacing as a normal empty stop; they now become a context-window error instead of entering empty-stop retry recovery. ([#3464](https://github.com/can1357/oh-my-pi/issues/3464))
- Fixed direct Anthropic Claude Sonnet/Haiku 4.5 requests serializing `output_config.effort`. The catalog classification (`packages/catalog/src/model-thinking.ts`) drove the `anthropic-budget-effort` branch in `buildParams`, which Anthropic's first-party Messages API rejects on Sonnet/Haiku 4.5 with HTTP 400 `This model does not support the effort parameter.` Sonnet/Haiku 4.5 now use plain `thinking.budget_tokens`; Opus 4.5 still emits `output_config.effort` because Anthropic supports it there. ([#3497](https://github.com/can1357/oh-my-pi/issues/3497))

## [16.1.19] - 2026-06-25

### Fixed

- Fixed Ollama/llama.cpp chat payloads serializing user-attributed mid-conversation developer messages (auto-learn capture nudge, advisor cards, file-mention companions) as `system` turns; they now serialize as `user` so llama.cpp can reuse the warm prompt prefix instead of forcing full re-processing. Agent-owned developer reminders (`attribution: "agent"` — empty/unexpected-stop retries, checkpoint rewind warning, todo reminders) keep their `system` priority. ([#3456](https://github.com/can1357/oh-my-pi/issues/3456))
- Fixed prior-turn reasoning being lost on cross-API provider switches: when a session moved from an Anthropic-compatible 3p endpoint to an OpenAI-compatible one (Z.AI Anthropic → Z.AI OpenAI, Kimi Anthropic → Kimi OpenAI, DeepSeek, OpenCode-hosted reasoning models, or any custom `models.yaml` switch that crosses API types), the cross-API path of `transformMessages` text-demoted every prior `thinking` block, so the next request shipped the reasoning chain as plain conversation `content` instead of structured `reasoning_content` — losing it as reasoning context and re-billing it. `convertMessages` now threads the request-time resolved compat into `transformMessages`, which preserves the prior reasoning as a native, signature-stripped `thinking` block whenever that resolved target accepts `reasoning_content` as a continuation hint (`requiresReasoningContentForToolCalls` — including the `whenThinking` policy OpenCode reactivates for thinking-on requests, #1071/#1484 — or `thinkingFormat: "zai"`); the `openai-completions` encoder surfaces those blocks via `reasoningContentField`, with a new branch for Z.AI-format hosts (Z.AI, Zhipu, Moonshot Kimi, Xiaomi MiMo) that accept but don't require the field. Targets that can't replay unsigned reasoning (encrypted reasoning blobs, signed thought parts, non-reasoning models, thinking-disabled OpenCode) still text-demote so the reasoning survives as conversation context. ([#3437](https://github.com/can1357/oh-my-pi/pull/3437), [#3439](https://github.com/can1357/oh-my-pi/pull/3439) by [@roboomp](https://github.com/roboomp); [#3433](https://github.com/can1357/oh-my-pi/issues/3433), [#3434](https://github.com/can1357/oh-my-pi/issues/3434))
- Fixed Bedrock cross-region inference profiles routing to `us-east-1` regardless of their geo prefix: a profile such as `eu.anthropic.claude-…` (or `apac.`/`au.`/`jp.`) sent to the hardcoded `us-east-1` endpoint returned HTTP 400 `The provided model identifier is invalid`. `streamBedrock` now derives the runtime region from the profile's geo prefix — honoring an ambient `AWS_REGION`/`AWS_DEFAULT_REGION` only when it can serve that geo and falling back to the geo's default region otherwise — while explicit per-request and ARN-embedded regions still win and region-agnostic `global.` profiles stay unchanged.
- Fixed malformed tool calls (empty `name`) wedging entire sessions in HTTP 400 loops: when a model occasionally emits `{ "name": "", "arguments": "{}" }` (observed: GLM-5.2 + thinking on long turns), the agent rejected the call at execution time with `Tool  not found`, but the malformed block plus its error `toolResult` stayed in conversation history and every subsequent request 400'd on `tool_use.name`/`tool_calls[i].function.name` validation until the user ran `/clear`. `transformMessages` — the canonical sanitize boundary every provider passes through — now drops `toolCall` blocks with empty/whitespace `name`, pairs them with their `toolResult` messages only inside the same assistant→tool-result window (per-id FIFO queue cleared at non-result boundaries, so stale malformed calls without a result cannot consume later valid duplicate-id outputs), and drops the assistant turn when it has no replayable content left. Defensive (provider-agnostic, fires regardless of model), idempotent (no-op on a clean history), and self-healing (one round-trip after the fix lands sanitizes an already-poisoned session). ([#3458](https://github.com/can1357/oh-my-pi/issues/3458))

## [16.1.18] - 2026-06-25

### Added

- Added `listOAuthAccounts` for retrieving a read-only list of stored OAuth account identities
- Added `getOAuthAccessAt` to resolve an OAuth token exclusively for a specific account position

### Changed

- Refactored OAuth token persistence and disable logic to use stable credential IDs instead of positional indices to prevent race conditions during concurrent updates
- Updated OAuth failure classification to treat 403 status codes, rate limits, and network errors as transient, preventing unnecessary credential invalidation

### Fixed

- Fixed Codex Responses Lite staying enabled for image prompts, which caused GPT/Codex image turns to be rejected as `Invalid value: 'input_image'`; image-bearing Codex requests now fall back to the full Responses transport. ([#3421](https://github.com/can1357/oh-my-pi/issues/3421))
- Fixed the auth-broker background refresher disabling OAuth credentials unconditionally (`disableCredentialById`) on a definitive refresh failure, so a credential another process or a fresh login rotated mid-refresh could be torn down even though the stored row already held a valid token. The definitive-failure teardown now happens inside `AuthStorage.refreshCredentialById` via the same compare-and-set the in-stream and usage-probe paths use — it disables only when the persisted row still matches the credential the refresh actually attempted, and reloads on a CAS loss; the refresher now only logs.
- Fixed OAuth refresh persisting the rotated token by a positional index captured before the refresh `await`. A concurrent disable could reorder or shrink a provider's credential array while the refresh was in flight, landing the new token on the wrong row (or silently dropping it) and leaving accounts with a stale refresh token that failed — and was then disabled — on the next cycle. Refresh persistence, selection-index resync, and CAS-disable now address the row by id across `forceRefreshCredentialById`, candidate preflight, and in-stream selection (`#replaceCredentialById` / `#disableCredentialByIdIfMatches`).
- Fixed `isDefinitiveOAuthFailure` treating a bare HTTP 403 (and generic `unauthorized` / access-token-expired wording) as a definitive credential failure, which permanently disabled healthy OAuth accounts on WAF, egress rate-limit, permission, and account-verification responses. Bare 403, rate limits (429), gateway/5xx, and more network errors (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, …) are now classified transient; only explicit dead-grant errors (`invalid_grant`, `invalid_token`, `unauthorized_client`, revoked, `refresh token … expired`) or a bare 401 tear the credential down.

## [16.1.17] - 2026-06-24

### Added

- Added provider-level `notes?: string[]` field to `UsageReport` for disclaimers that apply to every limit (e.g. "OMP-observed spend only"). The field is declared in both the `usage.ts` schema and the auth-broker wire schema copy so it survives the `"+": "reject"` deserialization gate. ([#3268](https://github.com/can1357/oh-my-pi/issues/3268))

### Fixed

- Moved the OpenCode Go "OMP-observed spend only" disclaimer from per-limit `notes` to provider-level `notes`, so it renders once per provider instead of duplicating across every account × window. ([#3268](https://github.com/can1357/oh-my-pi/issues/3268))
- Fixed Anthropic rate-limit header usage cache entries retaining legacy missing account metadata after refresh.
- Fixed Anthropic-compatible budget-effort models dropping the selected effort before request serialization, so `output_config.effort` is emitted alongside `thinking.budget_tokens` when model metadata declares `mode: "anthropic-budget-effort"`.
- Fixed `anthropic-messages` silently dropping caller-supplied `Authorization` / `X-Api-Key` from `model.headers` and `ANTHROPIC_CUSTOM_HEADERS`, blocking custom proxy auth schemes. Non-OAuth requests now honor the caller's value (matching `openai-responses`); the lower-level client also suppresses its `X-Api-Key` add when a custom `Authorization` is supplied for a non-official endpoint so the proxy receives a single credential. OAuth bearer + Cloudflare AI Gateway keep their pre-existing enforced auth headers. ([#3391](https://github.com/can1357/oh-my-pi/issues/3391))
- Fixed Ollama Cloud `num_predict` ignoring the provider's 65536 output-token cap so stale `models.db` rows (or custom `modelOverrides` re-enabling output caps) that carried `maxTokens: 1048576` from a pre-omitMaxOutputTokens catalog 400'd every request with `max_tokens (1048576) exceeds model's maximum output tokens (65536) for model deepseek-v4-pro`. The Ollama provider now clamps `num_predict` for any `ollama-cloud` request at the documented 65536 cap before sending, independent of the cached spec's `maxTokens` and on top of the existing `omitMaxOutputTokens` policy — so the request stays valid even when the load-time policy never normalized the spec. Self-hosted `ollama` traffic is unaffected. ([#3392](https://github.com/can1357/oh-my-pi/issues/3392))
- Fixed OpenRouter Anthropic models on the Responses path omitting `cache_control`, so prompt caching engages without forcing Chat Completions. ([#3397](https://github.com/can1357/oh-my-pi/issues/3397))
- Fixed OpenRouter Anthropic Responses follow-up requests replaying prior reasoning items with stale signatures, which caused HTTP 400 `Invalid signature in thinking block` errors after a thinking turn. ([#3399](https://github.com/can1357/oh-my-pi/issues/3399))
- Fixed OpenRouter Anthropic models on the Responses path omitting `cache_control`, so prompt caching engages without forcing Chat Completions. `cacheRetention: "long"` now upgrades the breakpoint to `ttl: "1h"`. ([#3397](https://github.com/can1357/oh-my-pi/issues/3397))

## [16.1.16] - 2026-06-23

### Fixed

- Fixed Anthropic-compatible thinking requests sending replayed thinking blocks without `context_management.keep: "all"`, preserving multi-turn reasoning context for API-key providers. API-key requests now also advertise the required `context-management-2025-06-27` beta header so the field is honored instead of rejected. Injected SDK clients, GitHub Copilot's Anthropic proxy, and Vertex rawPredict are excluded because this code path cannot add the beta to caller-owned clients, Copilot strips Anthropic betas and demotes thinking blocks to text upstream, and Vertex expects betas in the JSON body rather than the Anthropic HTTP beta header. ([#3288](https://github.com/can1357/oh-my-pi/issues/3288))
- Fixed OpenRouter Responses native history replay leaking Gemini reasoning item `format` metadata back into follow-up requests, which caused HTTP 400 rejections while preserving encrypted reasoning replay.

## [16.1.15] - 2026-06-22

### Fixed

- Fixed API-key `/login` providers replacing sibling credentials instead of appending new keys for the same provider. ([#3265](https://github.com/can1357/oh-my-pi/issues/3265))
- Fixed OpenAI Codex OAuth account rotation for quota failures that surface as bare HTTP 429 or `insufficient_quota`, so pre-content failures temporarily block only the exhausted credential and retry a healthy sibling. The 429 status-only fallback applies only to absent/opaque bodies; informative transient bodies (`Too many requests`, `Service overloaded 529`, `Please retry in 5s`, …) defer to `parseRateLimitReason` and stay in the provider's own backoff layer instead of burning sibling credentials. ([#3231](https://github.com/can1357/oh-my-pi/issues/3231))

## [16.1.14] - 2026-06-22

### Added

- Added proxy support for model providers via `PI_PROXY` and `PI_PROXY_<PROVIDER>` variables
- Added `NO_PROXY` environment variable support for bypassing proxy configuration
- Added support for Sakana AI provider
- Added Sakana AI login and request base URL support for `SAKANA_*` / `FUGU_*` environment variables

### Changed

- Consolidated API key authentication logic across registry providers
- Disabled parallel tool calls for Devin provider requests

### Fixed

- Improved proxy bypass logic to correctly handle private IP ranges and local metadata services
- Enhanced memoization for proxy environment variable lookups to improve performance

## [16.1.13] - 2026-06-22

### Added

- Added support for Devin as a provider

### Changed

- Updated tool call arguments to use `Record<string, unknown>` and `unknown` for tool results

### Fixed

- Fixed OpenAI Responses native history replay dropping failed/incomplete image generation calls instead of resending their transient `ig_...` item IDs, preventing follow-up requests from failing with `404 Item with id ... not found`. ([#3225](https://github.com/can1357/oh-my-pi/issues/3225))
- Fixed `/login fireworks` rejecting valid `fw_…` keys with `Fireworks API key validation failed (500): Error listing deployed models`. The validator pinged `/inference/v1/models`, which Fireworks serves from the per-account deployment registry and 500s for accounts without active deployments. Login now hits the static control-plane `List Models` catalog (`GET /v1/accounts/fireworks/models?filter=supports_serverless=true&pageSize=1`) — the same endpoint discovery already uses — so authentication no longer depends on the caller's deployment state. ([#3219](https://github.com/can1357/oh-my-pi/issues/3219))

## [16.1.11] - 2026-06-21

### Fixed

- Fixed OpenAI Responses native history replay leaking image generation provider-only fields into the next request, which made OpenAI-compatible proxies reject `pi` tool-calling sessions with `Unknown parameter: input[1].action`. ([#3201](https://github.com/can1357/oh-my-pi/issues/3201))
- Fixed a stream thought-leakage issue for `gemini-3.5-flash` where the model's internal reasoning JSON could leak into the visible text stream. The stream parser now uses a brace-balanced counting algorithm to accurately slice and discard the leading thought JSON block, with a robust fallback for unescaped double quotes, dynamic tool-name derivation, and preservation of subsequent text deltas without triggering empty-response retries.

## [16.1.10] - 2026-06-21

### Changed

- Improved JSON robustness by replacing external dependency with a custom, high-performance parser
- Strengthened streaming JSON parsing to prevent non-finite numbers from surfacing as `undefined/NaN`
- Configured JSON parser to reject JS-specific `NaN` and `Infinity` values for tool arguments
- Replaced the JSON repair/parse helpers (`parseJsonWithRepair`, `parseStreamingJson`) with a single from-scratch tolerant parser (`RelaxedJson`) that accepts single-quoted strings, unquoted object keys, trailing/stray commas, `//` and `/* */` comments, Python `True`/`False`/`None`, raw control characters, invalid escapes, and unescaped apostrophes (`'it's'`). Final parsing still throws on truncated/garbage input (so a malformed tool call is skipped rather than executed with half-formed args) and rejects JS-only `NaN`/`Infinity`; streaming parsing stays non-throwing and rolls back incomplete trailing tokens instead of surfacing `undefined`/`NaN`. The Cursor provider's ad-hoc regex + JSON5 tool-argument parser now routes through the shared parser.

### Fixed

- Fixed tool call ID normalization for Anthropic-compatible models
- Fixed Anthropic Messages replay sanitizing malformed tool-call IDs, including aborted native tool calls with empty IDs, so retries no longer send invalid `tool_use.id` / `tool_result.tool_use_id` pairs.
- Fixed the Codex Responses WebSocket transport attributing a prior turn's output to the current one on a reused connection: a trailing/duplicate frame from a cleanly-completed previous response that slipped past the queue drain could be consumed as this request's terminal (ending the turn with empty output) or as a stale tool call. Frames are now keyed by `response.id` — a frame carrying the previous response's id is dropped, and one carrying a third id (or a regressed `sequence_number`) fails closed so the turn retries instead of mixing two responses' streams. Idless frames (deltas, the rate-limit/metadata preamble, `response.created`-less streams) still pass through, matching upstream codex-rs.
- Fixed `transformMessages` pulling an earlier, orphaned tool result onto a later tool call that reused the same id (left behind when compaction folded the originating `tool_use` into a summary). The pending-call flush now pairs each call with a result positioned _after_ its assistant turn, so a reused id surfaces its own output rather than a prior turn's.
- Fixed DashScope 429 rate-limit messages that mention authorization being classified as credential failures, preventing valid API keys from being invalidated after throttling. ([#3172](https://github.com/can1357/oh-my-pi/issues/3172))
- Fixed OpenCode Go `401 Insufficient balance` quota errors being treated as unknown failures instead of usage-limit errors, restoring credential rotation and fallback chains. ([#3169](https://github.com/can1357/oh-my-pi/issues/3169))

### Removed

- Removed the `partial-json` dependency; streaming JSON parsing now uses the in-house `RelaxedJson` parser.

## [16.1.9] - 2026-06-21

### Added

- Added `llama.cpp` to the interactive `/login` provider list, accepting an optional API key while defaulting to local no-auth mode.

### Changed

- Optimized generated AI tool schemas by collapsing verbose `anyOf` unions into standard `enum` types

### Fixed

- Fixed tool-call argument validation dropping nested keys that were accidentally double-encoded
- Fixed the `moonshot` provider being locked to the international Kimi host (`api.moonshot.ai`): OpenAI-completions requests now honor a `MOONSHOT_BASE_URL` override so users can reach the Kimi China platform (`api.moonshot.cn`), which rejects keys issued for the international endpoint. ([#2883](https://github.com/can1357/oh-my-pi/issues/2883))
- Fixed tool-call argument validation dropping fields whose object keys were accidentally JSON-encoded a second time (e.g. `{ "\"op\"": "done" }`), which surfaced as spurious missing-required errors. A schema-agnostic pre-validation pass now recursively unwraps such double-encoded keys — through arrays and nested objects, and again after a JSON-string container is parsed — before the unrecognized-key repair can delete them.

### Removed

- Removed the `setNextRequestDebugPath`, `clearNextRequestDebugPath`, and `getNextRequestDebugPath` utility functions for request debugging, as request/response recording now relies exclusively on the `PI_REQ_DEBUG` environment variable.
- Removed Wafer Pass (`wafer-pass`) login support; Wafer Serverless remains available as `wafer-serverless`.

## [16.1.8] - 2026-06-20

### Changed

- Changed OpenAI Responses and Codex Responses custom grammar tool requests to leave `parallel_tool_calls` unset instead of forcing serial tool calls; Codex `responsesLite` still disables parallel tool calls when tools are present.

### Fixed

- Fixed Bedrock `/btw` and other no-tool ephemeral turns failing after prior tool calls by sending the required sentinel `toolConfig` whenever replayed history contains `toolUse`/`toolResult` blocks. ([#3124](https://github.com/can1357/oh-my-pi/issues/3124))
- Fixed Anthropic Messages pre-content TLS `bad record MAC` server transport errors surfacing before the provider retry loop exhausts its budget. ([#3134](https://github.com/can1357/oh-my-pi/issues/3134))
- Fixed API-key login flows replacing existing stored keys for the same provider, so providers such as NVIDIA NIM can keep multiple active keys available for session-level rotation. ([#2923](https://github.com/can1357/oh-my-pi/issues/2923))
- Fixed `openai-codex-responses` forwarding sampling controls (`temperature`, `top_p`, `top_k`, `min_p`, `presence_penalty`, `repetition_penalty`) into the Codex request body — the ChatGPT-subscription Codex backend rejects each of them with a 400 `{"detail":"Unsupported parameter: temperature"}`, so any caller setting non-default `StreamOptions` saw every turn fail. The provider now drops the full sampling set (matching codex-rs), and the auth-gateway's defensive strip on both `buildStreamOptions` and the pi-native path was widened from `{temperature, topP}` to the same set plus `stopSequences`/`frequencyPenalty`. ([#3117](https://github.com/can1357/oh-my-pi/issues/3117))
- Fixed Anthropic Messages retry classification for transient TLS/server-error failures such as `tls: bad record MAC (type=server_error)`. These pre-content transport blips are now retried inside the provider loop before the session sees an error banner.

## [16.1.4] - 2026-06-19

### Added

- Added bounded auto-retry for empty assistant completions specifically to the OpenAI Responses provider
- Added bounded auto-retry for empty assistant completions across the OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages providers. A benign terminal stop that streamed no content and billed no output tokens — the signature of a flaky OpenAI-/Anthropic-compatible gateway that intermittently 200s with an empty body — is now retried up to twice with exponential backoff (honoring `providerRetryWait`) before being surfaced, instead of silently stalling the agent loop. Retries fire only before any content streams, so live streaming (including thinking) is never delayed, retried, or duplicated.

### Fixed

- Fixed the Antigravity (`google-antigravity`) request builder dropping `labels.model_enum` when the wire profile does not declare one. Required for Claude 4.6 ids whose `AntigravityModelWireProfile` carries only `maxOutputTokens` (no captured `model_enum`); the label is now emitted only when the catalog defines it. ([#3067](https://github.com/can1357/oh-my-pi/issues/3067))

## [16.1.3] - 2026-06-19

### Added

- Added regression test pinning that `openai-completions` emits a `thinking` block for `reasoning_content` deltas even when `delta.content` is explicitly JSON `null` (the DeepSeek-format dual-key pattern used by custom GLM/Qwen reasoning providers). See [#2996](https://github.com/can1357/oh-my-pi/issues/2996).

### Changed

- Improved the thinking loop guard to treat assistant text loops as retryable errors
- Refined text normalization logic to reduce false positives in the thinking loop detector

### Fixed

- Fixed Ollama chat requests sending image payloads to text-only models. Image blocks are now omitted and replaced with the standard non-vision placeholder for models without vision support, while vision-capable Ollama models continue to receive images. ([#3009](https://github.com/can1357/oh-my-pi/pull/3009) by [@serverinspector](https://github.com/serverinspector))
- Fixed `SqliteAuthCredentialStore.close()` leaking one-off prepared statements created by inline `this.#db.prepare()` calls in `#authCredentialsTableExists`, `#readAuthSchemaVersion`, `#inferAuthSchemaVersion`, `#migrateAuthSchemaV0ToV1`, `#backfillCredentialIdentityKeys`, and `updateAuthCredential`. Each statement is now wrapped in `try/finally` with `stmt.finalize()`, and the `close()` method finalizes `#insertUsageCostStmt` and `#listUsageCostsStmt` which were previously missed. This caused EBUSY on Windows when tests tried to delete temp dirs containing open SQLite handles.

## [16.1.2] - 2026-06-19

### Added

- Added improved JSON repair capabilities for Anthropic tool arguments
- Added authentication broker discovery to sync credentials between local SQLite and remote state

### Fixed

- Improved error feedback and transparency for malformed Anthropic tool call arguments
- Added automatic fallback for unsupported OpenAI reasoning effort levels
- Improved reliability when handling invalid reasoning parameter errors across OpenAI-compatible APIs
- Fixed OpenAI-compatible Chat Completions, Responses, and Azure Responses requests to retry once with the nearest provider-supported reasoning effort when an endpoint rejects `xhigh`/`minimal`-style effort values.

## [16.1.0] - 2026-06-19

### Added

- Added utility functions to strip schema descriptions for optimized LLM context usage

## [16.0.10] - 2026-06-18

### Added

- Replaced the old legacy XML-ish `pi` owned tool-calling dialect with the new sigil-delimited format (`§` call header with inline `key=value` scalars, `«…»` verbatim body fence for the dominant string argument, `¤` reasoning, `‡‡` tool result) using single-token markers that never occur in source code. Verbatim fences escalate Markdown-style (`««…»»`) so re-rendered history never collides with payload content, and the scanner gates a bare `§` on an exact known-tool name to avoid swallowing prose. Round-trips and streams through the existing scanner contract at ~46% fewer tokens than the legacy format on typical calls; selectable via `tools.format` or `PI_DIALECT=pi`.

### Changed

- Updated `pi` dialect formatting to use a token-frugal, sigil-delimited format (`§`, `¤`, `‡‡`)
- Updated `pi` dialect body fences to automatically escalate when content contains fence markers
- Changed `pi` dialect tool results response format to `‡‡` blocks

### Fixed

- Fixed Bedrock application inference profile ARNs to route requests to the ARN's region instead of the default Bedrock runtime region. ([#3004](https://github.com/can1357/oh-my-pi/issues/3004))

## [16.0.9] - 2026-06-18

### Fixed

- Fixed OAuth login replacing all other active accounts for the same provider, allowing multiple OAuth accounts to coexist concurrently.
- Fixed legacy `api_key` credentials not being replaced/disabled atomically upon upgrading to OAuth login.
- Fixed a logic issue where AuthStorage lost session-to-credential stickiness upon CLI restarts, causing cold-starts for server-side prompt cache (KV cache) and wasting tokens.
- Fixed GitHub Copilot Responses requests rejecting image inputs that carry the `detail: "original"` hint with an HTTP 400 by degrading the hint to `"auto"` for hosts that do not support it; other hosts still preserve native-resolution frames (snapcompact). ([#2822](https://github.com/can1357/oh-my-pi/issues/2822))

## [16.0.8] - 2026-06-18

### Fixed

- Improved reliability of auth-broker snapshot loading by implementing a robust manual schema check
- Fixed MCP tool argument validation to drop optional empty-string parameters before schema validation, matching the existing optional null handling and avoiding pattern/type failures for omitted model-filled fields. ([#2981](https://github.com/can1357/oh-my-pi/issues/2981))
- Fixed API-key credential replacement to hard-delete superseded disabled `api_key` rows so `auth_credentials` does not grow indefinitely after key rotation. ([#2941](https://github.com/can1357/oh-my-pi/issues/2941))
- Fixed Cursor provider streaming to close text blocks before tool calls so post-tool text opens a new content block and TUI transcript cards render inline instead of grouped near the bottom. ([#2924](https://github.com/can1357/oh-my-pi/issues/2924))

## [16.0.7] - 2026-06-18

### Changed

- Switched Google OAuth callback hostname from `localhost` to `127.0.0.1` to prevent IPv6 loopback fallback delays and proxy routing interception.

### Fixed

- Fixed OpenCode Go usage reporting to synthesize `/usage` limits from OMP-observed request costs for the 5h, weekly, and monthly provider caps. ([#2942](https://github.com/can1357/oh-my-pi/issues/2942))
- Fixed MiniMax Anthropic-compatible requests to serialize adaptive thinking without an invalid Anthropic `output_config.effort` tier ([#2928](https://github.com/can1357/oh-my-pi/issues/2928)).

## [16.0.6] - 2026-06-18

### Added

- Added support for ArkType schemas as tool parameters alongside existing Zod schemas
- Added `getOpenRouterHeaders` utility to export standard OpenRouter integration headers

### Changed

- Expanded thinking loop detection guard to also cover DeepSeek models (family, provider, or id matches).
- Extended loop guard to monitor assistant response prose (via `text_delta` events) in addition to thinking logs, customizable via request options.
- Modified loop guard error reporting to emit a non-retryable partial content block containing the accumulated streamed text if a loop is detected after response prose has started streaming, preventing unsafe agent session rollbacks.
- Migrated internal wire-schema validation (auth-broker, Anthropic Messages request, OpenAI Chat/Responses requests, and /v1/usage shapes) from Zod to ArkType
- Replaced the dedicated `xai-responses` provider with a unified `openai-responses` path that handles xAI-specific reasoning effort stripping dynamically
- Updated OpenAI Responses stream handling to throw a clearer error message when a stream closes without a terminal response event
- Consolidated shared OpenAI-compatible routing and strict-tool fallback helpers across Chat Completions and Responses providers.
- Consolidated the OpenAI-family provider stack: merged `openai-responses-shared` into `openai-shared` and removed the now-dead `openai-responses-shared` re-export shim; folded the three duplicated `service_tier` request blocks and the per-provider wire model-id transform into shared `applyOpenAIServiceTier`/`applyWireModelIdTransform` helpers; moved residual provider-name wire-quirk checks (DeepSeek special-token strip, cumulative reasoning deltas, Ollama empty-length context error, OpenAI tool-call-id cap, Fireworks thinking drop, OpenRouter/OpenAI Responses request fields) into resolved compat fields; shared the Responses stream per-block accumulation helpers plus the terminal pending-tool-call finalization (`finalizePendingResponsesToolCalls`) and toolUse/pause stop-reason promotion (`promoteResponsesToolUseStopReason`) between `processResponsesStream` and the Codex stream handler; and removed the redundant `getOpenAIResponsesCacheSessionId` alias in favor of `getOpenAIResponsesPromptCacheKey`.
- Centralized OpenAI-family request-param policy into shared `resolveOpenAIOutputTokenParam` (output-token field selection, OpenRouter default-cap omission, `alwaysSendMaxTokens` defaulting, model/provider clamp), `applyOpenAIGatewayRouting` (OpenRouter `provider` + Vercel AI Gateway `providerOptions`), and `applyOpenAIExtraBody` (extra-body merge + Fireworks thinking drop) helpers used by both Chat Completions and Responses `buildParams`, and moved the Chat Completions reasoning/thinking dialect dispatch (`applyChatCompletionsReasoningParams` + `disableChatCompletionsReasoningForDialect`) plus the `OpenAICompletionsParams` request type into `openai-shared` alongside `applyResponsesReasoningParams`. As a consistency consequence, direct `streamOpenAIResponses` calls (bypassing `streamSimple`) now emit `max_output_tokens` for `alwaysSendMaxTokens` (Kimi-family) models even without a caller cap — matching Chat Completions and the value `streamSimple` already supplied.
- Centralized OpenAI-family reasoning compat resolution behind a shared `resolveOpenAICompatPolicy` consumed by both Chat Completions and Responses request builders. Shared policy now drives tool-choice reasoning suppression, dialect-specific disable encoding, reasoning-history replay filters, encrypted-reasoning inclusion, Mistral/OpenAI tool-call-id modes, stream healing/DeepSeek token stripping, and xAI/OpenRouter cache-affinity wiring instead of endpoint-local provider/model checks.

### Fixed

- Fixed OpenAI Responses cost accounting to apply standard service-tier pricing multipliers (flex 0.5×, priority 2×) to the calculated cost based on the served (or requested) service tier for provider `"openai"` models.
- Fixed OpenAI Chat Completions to consume the dedicated `requiresReasoningContentForAllAssistantTurns` compatibility flag, preventing unnecessary reasoning replay on non-tool-call turns for OpenRouter DeepSeek and OpenCode models.
- Fixed the Kimi Code and Synthetic dual-surface shim (`streamOpenAIAnthropicShim`) to correctly forward caller-supplied `toolChoice`, `serviceTier`, and `disableReasoning` options.
- Fixed the OpenAI Responses tool-choice compatibility helper to drop `tool_choice` when `supportsToolChoice` is false, and downgrade forced choices to `"auto"` when `supportsForcedToolChoice` is false.
- Fixed Azure Responses to avoid emitting `tool_choice: "none"` when `context.tools` is empty.
- Fixed Kimi via OpenRouter forced-tool requests to omit the OpenRouter `reasoning` object instead of sending `reasoning: { enabled: false }`, preserving the generic OpenRouter explicit-disable behavior while avoiding Kimi's forced-tool reasoning conflict.
- Fixed Google Gemini CLI credential parsing schema to gracefully handle empty or unexpected non-string shapes without throwing unhandled exceptions
- Fixed Google Gemini CLI credential parsing to correctly prioritize `projectId` over `project_id` even when empty, and drop non-string values gracefully
- Fixed OpenRouter Responses requests to omit default max token fields unless an explicit caller cap is provided, preventing upstream filtering issues
- Fixed Chat Completions reasoning suppression (`disableReasoningOnToolChoice` / `disableReasoningOnForcedToolChoice`) to turn thinking off symmetrically across every dialect via a shared `disableChatCompletionsReasoningForDialect` helper. Previously the conflict path only deleted `reasoning_effort`/`reasoning` (and set Z.AI `thinking: { type: "disabled" }` on the forced branch alone), leaving Qwen `enable_thinking`, Qwen chat-template `chat_template_kwargs.enable_thinking`, and OpenRouter nested `reasoning` enabled — so those hosts could keep thinking on under forced/required tool choice and re-trip the incompatibility the policy guards against. OpenRouter is now set to `{ reasoning: { enabled: false } }` (not deleted, which OpenRouter treats as default-on).
- Fixed OpenRouter Responses requests to send `session_id` from `sessionId` in the request body for sticky provider routing and observability grouping.
- Fixed OpenRouter Responses request shaping to preserve provider routing, variant suffixes, caller header overrides, and strict-tool fallback behavior while omitting only unsafe default max-token caps.
- Fixed OpenAI Responses stateful chaining so a non-ZDR stale `previous_response_id` retry keeps `store: true`: the full-context retry stays chainable on the next turn and the consecutive stale-failure circuit breaker trips after the configured limit instead of alternating cold turns. Zero Data Retention rejections still disable chaining on the first strike.
- Fixed Anthropic Messages tool schema normalization demoting root `anyOf`/`allOf` and all `oneOf` constraints into descriptions instead of forwarding provider-rejected keywords in MCP tool `input_schema`.
- Fixed Ollama Cloud GLM-5.2 reasoning efforts to map `xhigh` to native think `"max"` ([#2911](https://github.com/can1357/oh-my-pi/pull/2911) by [@serverinspector](https://github.com/serverinspector))
- Fixed OpenRouter Responses requests tagging the streamed assistant message with a hardcoded `openai-responses` API instead of the runtime `model.api`, which silently disabled native-history replay (`buildResponsesInput`) and cross-model tool-call item-id stripping on subsequent OpenRouter turns. The message now carries `model.api` (matching the Chat Completions path).
- Fixed OpenAI-family streaming leaking a pre-retry `errorMessage` onto a successful turn: the OpenRouter Anthropic compiled-grammar strict-tool fallback set `errorMessage` before retrying with strict tools disabled and never cleared it on success, and the Chat Completions success path could carry an `errorMessage` from an internally-retried attempt — both made a successful turn read as errored in agent state and telemetry. The Responses fallback no longer assigns `errorMessage`, and the Completions success path clears it before emitting the terminal `done` event.
- Fixed Codex stream-error `.code` resolution to use the same nested-first precedence (`error.code` → `error.type` → top-level `code`) as `isRetryableCodexFailureEvent` and the formatted message. Previously the error factory resolved top-level-first, so a failure event carrying both a top-level and a differing nested error code surfaced a `.code` that could disagree with its own `retryable` flag and message text.

## [16.0.5] - 2026-06-17

### Added

- Added `antigravityEndpointMode` stream option with `auto`, `production`, and `sandbox` values to control Antigravity endpoint routing
- Added `seedApiKeyResolver` for reusing a pre-resolved request key while preserving resolver-driven auth retry and credential rotation
- Added optional `contextSnapshot` property to `AssistantMessage` with token usage metadata via new `ContextSnapshot` interface (`promptTokens`, `nonMessageTokens`, and optional `lastMessageTimestamp`)
- Added `LITELLM_BASE_URL` guidance to the LiteLLM login prompt so non-default proxy endpoints are discoverable. ([#2726](https://github.com/can1357/oh-my-pi/issues/2726))
- Added a Gemini thinking-loop guard that watches streamed `thinking` deltas for degenerate reasoning loops — verbatim tail repetition and near-duplicate paragraph cycling — and terminates the stream with a retryable, empty-content `error` message (worded as a transient stream stall) so the turn is discarded and re-sampled instead of committing a runaway transcript. Gated to Gemini models across every transport (OpenRouter, direct Google, Vertex) and disarmed once visible answer text or a tool call starts; disable with `PI_NO_THINKING_LOOP_GUARD=1`.

### Changed

- Changed the Antigravity (`google-antigravity`) request builder to mirror the captured `antigravity/hub` client: gemini-3.x send `thinkingConfig.thinkingBudget` per tier, a fixed per-model `maxOutputTokens`, a default `functionCallingConfig.mode: "VALIDATED"` tool mode (auto/unset tool choice only), a `role: "user"` system instruction, a structured `requestId` (`agent/<id>/<ts>/<trajectoryId>/<step>`), and `labels` (`model_enum`, `trajectory_id`, `last_step_index`, `last_execution_id`, `used_claude*`) tracked across the conversation via provider session state.

### Fixed

- Fixed Gemini usage-tier mapping so `gemini-3.5-flash` is treated as `Flash` and `gemini-3.1-pro` plus `gemini-pro-agent` are treated as `Pro` in usage accounting
- Fixed Antigravity stream state handling so a request’s `last_execution_id` is committed only after a successful completion and cleared between retry attempts
- Fixed `streamSimple()` Gemini streams to run through the thinking-loop guard for custom API and pi-native transports, so degenerate `thinking` loops now abort with the same retryable empty-content error path as other Gemini stream paths
- Fixed Antigravity model streaming and usage fetch paths to retry on transient `429`/`5xx` errors by failing over to the alternate endpoint before surfacing an error
- Fixed Antigravity endpoint tracking to prefer a previously successful endpoint in `auto` mode for subsequent requests
- Fixed Antigravity and Gemini CLI model requests failing with an opaque error when Google requires account verification. Cloud Code Assist `403 VALIDATION_REQUIRED` responses now surface the `validation_url` and the signed-in account email when available, so users see an actionable account-verification message instead of the raw API error body.
- Fixed MiniMax M3 in-band tool calls by adding a MiniMax dialect that parses `<minimax:tool_call>` wrappers instead of falling back to generic XML. ([#2759](https://github.com/can1357/oh-my-pi/issues/2759))
- Fixed GitHub Copilot OAuth for Business seats by storing the login-discovered API endpoint and routing model enablement plus chat requests to that endpoint. ([#2876](https://github.com/can1357/oh-my-pi/issues/2876))

## [16.0.4] - 2026-06-17

### Fixed

- Fixed tool argument coercion to parse double-encoded JSON strings, including quoted values like `"300"`, when schema expects a number
- Fixed object-array coercion to parse JSON object and array strings into proper array arguments instead of wrapping raw strings
- Fixed handling of malformed JSON container strings for array schema fields so validation now surfaces a top-level `expected array, received string` error rather than nested element errors
- Fixed ChatGPT/Codex browser login missing connector OAuth scopes and rendering object-shaped token endpoint errors as `[object Object]`. ([#2825](https://github.com/can1357/oh-my-pi/issues/2825))
- Fixed Zhipu/BigModel GLM-5.2 chat-completions requests so internal `xhigh` effort serializes as provider-native `reasoning_effort: "max"` and tool calls opt into `tool_stream`. ([#2833](https://github.com/can1357/oh-my-pi/issues/2833))
- Fixed Google Gemini CLI and Antigravity tool calls with `toolChoice: "auto"` serializing an explicit `toolConfig` AUTO mode, which can cause Gemini-3 models to leak raw planning JSON instead of executing tools. ([#2830](https://github.com/can1357/oh-my-pi/issues/2830))

## [16.0.3] - 2026-06-16

### Added

- Exported `renderDelimitedThinking` from the `@oh-my-pi/pi-ai/dialect` barrel so consumers can reuse the dialect's `<thinking>` envelope unwrap-and-rewrap logic (the only `./dialect/rendering` primitive re-exported; the rest stay dialect-internal).

### Fixed

- Fixed OpenAI Responses/Codex tool schema normalization stripping provider-rejected regex lookaround patterns from MCP tool parameter schemas. ([#2784](https://github.com/can1357/oh-my-pi/issues/2784))
- Fixed OpenAI Responses parallel tool-call routing so late keyed argument deltas for a closed call are dropped instead of being appended to another open call.

## [16.0.2] - 2026-06-16

### Added

- Added `UMANS_WEBSEARCH_PROVIDER=native|exa` support for routing Umans gateway-owned web search requests.

### Fixed

- A single MCP tool whose input schema can't be emitted as a valid strict tool schema for the active provider no longer fails the whole turn with HTTP 400. `convertTools` (openai-responses) now validates each tool's emitted parameter schema for `enum`/`const`-vs-`type` contradictions that pass structural JSON-Schema validation but the provider rejects — e.g. a non-null `enum` on a `type: "null"` node, or an `enum` on an `array` node — and quarantines just the offending tool with a `logger.warn` naming the tool and schema path, keeping every other tool usable. Adds `findStrictToolSchemaViolation` to `@oh-my-pi/pi-ai/utils/schema` ([#2652](https://github.com/can1357/oh-my-pi/issues/2652))
- Fixed OpenAI Responses-compatible streams from Ollama/local hosts dropping arguments for parallel tool calls whose deltas use `fc_<call_id>` item ids, which left earlier `ast_grep` calls with `{}` and failed validation. ([#2715](https://github.com/can1357/oh-my-pi/issues/2715))
- Fixed dialect transcript rendering so literal thinking envelopes are unwrapped before adding the dialect's own thinking tags, preventing nested `<thinking>` output in advisor raw dumps ([#2700](https://github.com/can1357/oh-my-pi/issues/2700)).
- Fixed Anthropic-compatible Umans requests escaping client tool names and forwarding gateway web search headers so Kimi answers normally instead of returning raw gateway search results.
- Fixed Google Gemini tool calls with `toolChoice: "auto"` serializing an explicit `toolConfig` AUTO mode, which can cause Gemini-3 models to leak raw planning JSON instead of executing tools. ([#2776](https://github.com/can1357/oh-my-pi/issues/2776))
- Fixed OpenAI-compatible Ollama completions that return empty `finish_reason:length` after filling `num_ctx` so they surface an actionable context-window error instead of an empty length stop. ([#2774](https://github.com/can1357/oh-my-pi/issues/2774))
- Fixed Codex browser login issuing credentials for the `opencode` OAuth originator while OMP requests identify as `pi`, which could make the first authenticated Codex request return 401 ([#2696](https://github.com/can1357/oh-my-pi/issues/2696)).

## [16.0.1] - 2026-06-15

### Added

- Added Umans AI Coding Plan API-key login support and `UMANS_AI_CODING_PLAN_API_KEY` environment fallback ([#2636](https://github.com/can1357/oh-my-pi/pull/2636) by [@oldschoola](https://github.com/oldschoola)).

### Fixed

- Fixed OpenAI Responses, Azure OpenAI Responses, and Codex Responses providers ignoring async `onPayload` replacement bodies. Provider payload hooks can now transform the actual request body sent upstream, matching the Anthropic/Gemini replacement contract.
- Fixed OpenAI-compatible chat-completions streams that send object-shaped tool arguments in fragments by deep-merging nested objects and task arrays instead of replacing earlier chunks. ([#2617](https://github.com/can1357/oh-my-pi/issues/2617))
- Fixed OpenAI Responses strict-mode tool schema normalization for nullable enum MCP parameters so enum constraints are distributed to matching `anyOf` branches instead of being copied onto the `null` branch. ([#1835](https://github.com/can1357/oh-my-pi/issues/1835))
- Fixed Cursor provider formatting tool errors with the same `[Tool Result]` prefix as successful results, causing Composer models to misinterpret error messages (e.g. "Pattern must not be empty") as directives over long conversations. Errors now use a `[Tool Error]` prefix so the model can distinguish failures from successes in the prompt history. ([#1853](https://github.com/can1357/oh-my-pi/pull/1853))
- Fixed `validateToolArguments` silently accepting JSON-encoded array strings (e.g. `'["a","b"]'`) against `union(string, array<string>)` schemas — providers that double-serialize tool-call arguments (Z.AI / GLM) caused tools like `search` to receive the literal `["a","b"]` as a single path, producing zero matches (single element) or glob parse errors (multi-element). A new pre-validation pass parses JSON-array-shaped strings when the schema explicitly accepts both shapes. ([#1788](https://github.com/can1357/oh-my-pi/issues/1788))
- Fixed Anthropic thinking summaries that arrive wrapped in literal `<thinking>` tags so advisor/raw transcript dumps do not render nested thinking tags ([#2695](https://github.com/can1357/oh-my-pi/issues/2695)).

## [16.0.0] - 2026-06-15

### Breaking Changes

- Renamed the public dialect entrypoint from `@oh-my-pi/pi-ai/grammar` to `@oh-my-pi/pi-ai/dialect`.
- Renamed grammar dialect identifiers from `ToolCallSyntax` to `Dialect`, renamed the `Grammar` interface to `DialectDefinition`, and renamed `Grammar.syntax` to `DialectDefinition.dialect`.
- Added `DialectDefinition.renderThinking` and `DialectDefinition.renderTranscript` so dialect implementations serialize complete native chat transcripts, not just tool call/result blocks.

### Added

- Added `renderTranscript` method to dialect definitions for serializing complete native chat transcripts
- Added `renderThinking` method to dialect definitions for rendering thinking/reasoning blocks
- Added support for 11 dialect implementations: Anthropic, DeepSeek, Gemini, Gemma, GLM, Harmony, Hermes, Kimi, Pi-native, Qwen3, and XML
- Added `createInbandScanner` factory function to instantiate dialect-specific scanners
- Added `getDialectDefinition` function to retrieve dialect implementations by name
- Added `renderToolCatalog` and `renderInbandToolPrompt` functions for tool catalog rendering
- Added `renderToolInventory` function to generate human-readable per-tool documentation with examples
- Added `renderToolExamples` function to render tool usage examples in the model's native dialect
- Added `encodeInbandToolHistory` function to encode tool call history in dialect-specific format
- Added `wrapInbandToolStream` function to process streaming responses with in-band tool call parsing
- Added `ThinkingInbandScanner` for parsing thinking/reasoning blocks across dialects
- Added `OwnedStream` class for managing dialect-aware streaming with tool call events
- Added in-band thinking channels to every dialect that was missing one: `gemini` (a ` ```thinking ` fence mirroring ` ```tool_code `), `gemma` (its native `<|channel>thought…<channel|>` reasoning channel), `kimi` (`<think>…</think>`), and `pi` (`<thinking>…</thinking>`). Each scanner now parses reasoning into thinking events instead of leaking chain-of-thought into the visible reply, and every dialect's `renderThinking` is a real channel that round-trips back through its scanner (no passthrough renderers).

### Changed

- Moved public dialect entrypoint from `@oh-my-pi/pi-ai/grammar` to `@oh-my-pi/pi-ai/dialect` in package exports
- Updated internal imports in `stream-markup-healing.ts` to use new dialect module path
- Changed `renderToolInventory` to demote a tool description's own markdown headers by one level when it contains a top-level `# ` header, so they nest under the wrapping `# Tool: <name>` heading instead of reading as sibling sections. Descriptions that already start at `##` and headers inside fenced code blocks are left untouched.

### Fixed

- Fixed Gemini, Gemma, Kimi, and Pi in-band scanners to respect `parseThinking: false`, leaving private reasoning markers in visible text when parsing is disabled
- Fixed thinking-channel parsing for streaming Gemini, Gemma, Kimi, and Pi outputs so split or partial `<thinking>` blocks no longer leak into visible replies
- Fixed in-band thinking finalization and Kimi stream-healing interactions so leaked `<think>` blocks are preserved when structured tool calls are present, not duplicated when explicit reasoning is present, and closed on stream flush.

### Removed

- Removed `src/grammar/factory.ts` (replaced by `src/dialect/factory.ts`)
- Removed `src/grammar/rendering.ts` (functionality moved to `src/dialect/rendering.ts`)
- Removed `src/grammar/xml.ts` (replaced by `src/dialect/xml.ts`)

## [15.13.3] - 2026-06-15

### Added

- Added the `gemini` in-band tool-call syntax with Python-style `tool_code` blocks and `default_api` invocations
- Added the `gemma` token-delimited in-band tool-call syntax using `<|tool_call>` and `<|tool_response>` blocks
- Added `gemini` and `gemma` to owned stream tool-result token detection so their tool responses are recognized
- Fixed truncated Gemini and Gemma tool blocks from being emitted as plain text during streaming
- Added the Azure OpenAI provider definition (`azure`) to the registry; `AZURE_OPENAI_API_KEY` resolves as its env-var API key via the catalog provider table.

### Changed

- Gemini tool-call examples now render without the `default_api.` namespace prefix, keeping `<example>` blocks concise. The live wire format still uses `default_api.` per the Gemini grammar.

### Fixed

- Fixed duplicate tool call projections by deduplicating provider-native `toolCall` events against in-band `tool_code` calls and keeping only the first real channel
- Dropped nameless native `toolCall` events so they no longer appear as surfaced tool calls in owned-mode streams
- Fixed truncated Gemini and Gemma tool blocks from being emitted as plain text during streaming
- Fixed Gemini/Gemma in-band tool-call parsing around Python comments, raw/unicode string literals, and Gemma close-token text inside string values.

## [15.13.2] - 2026-06-15

### Added

- Added `jsonSchemaToTypeScript` to `@oh-my-pi/pi-ai/utils/schema` to render JSON Schema argument shapes as compact, human-readable TypeScript-style signatures
- Added the generic `ToolExample` type (`ToolCallExample`/`ToolCompareExample`/`ToolNoteExample`, parameterized over a tool's argument shape) and an `examples` property on the `Tool` interface for defining tool-call examples once as data.
- Added `renderToolExamples` (via `@oh-my-pi/pi-ai/grammar`) to render a tool's examples into an `<examples>` block in the model's native tool-call syntax, with an optional `_i` intent-field placeholder injected when intent tracing is active.
- Added per-grammar `renderToolCall` rendering of a single tool-call invocation (the inner element only, without the parallel-call block envelope), distinct from `renderAssistantToolCalls` which renders a complete block of one or more parallel calls.
- Added a `GrammarRenderOptions.example` flag to `renderToolCall`: when set, the invocation renders as the bare payload — Harmony emits just the JSON arguments, dropping the verbose `<|start|>…<|message|>…<|call|>` envelope — so `renderToolExamples` keeps `<examples>` blocks legible.
- Added an `abortOnFabrication` parameter to `wrapInbandToolStream` (default `true`): when `false`, a fabricated in-band tool-result continuation is discarded without aborting the provider request instead of cutting the turn short.
- Added `@oh-my-pi/pi-ai/utils/harmony-leak` export with helpers to detect, audit, and recover GPT-5 Harmony tool-call header leaks
- Added the `@oh-my-pi/pi-ai/grammar` public entrypoint for grammar factories, prompt/call rendering, in-band scanning, history encoding, and related typed utilities
- Added a unified in-band tool-call grammar engine with syntax-owned scanners, prompts, history rendering, tool-result rendering, and stream adaptation for GLM, Hermes/Qwen, Kimi, XML/Anthropic, DeepSeek, Harmony, and pi-native formats.

### Changed

- Changed Harmony in-band tool-call rendering to omit the `<|constrain|>json` marker before the payload in `commentary` channel calls
- Changed tool inventory rendering to present each tool’s `Parameters` section as a simplified TypeScript-style signature derived from its wire schema
- Added raw in-band tool-call block capture to parsed owned tool calls so debugging can inspect the exact model-emitted call syntax.
- Moved the canonical `ToolCallSyntax` union to `@oh-my-pi/pi-catalog/identity` and re-exported it from `@oh-my-pi/pi-ai/grammar` so the catalog can own the syntax vocabulary without an `@oh-my-pi/pi-ai` runtime import; all existing import paths are unchanged.
- Made tool-call argument validation more lenient for schema-directed scalar coercions, including object/array stringification and 0/1 boolean coercion.
- Changed `renderToolInventory` (the verbose system-prompt inventory and `/dump`) to render each tool as a `# Tool: <name>` markdown section instead of a `<tool name="…">…</tool>` wrapper.

### Fixed

- Fixed Harmony leak handling support by adding `recoverHarmonyToolCall` plus leak-detection workflows for contaminated assistant messages so recoverable tool-call arguments can be safely truncated and retried
- Fixed false-positive gating in Harmony leak heuristics using signal-based checks so unrelated text containing `to=functions...` is not treated as leaked tool-call markup
- Routed Kimi, DeepSeek DSML, and plain thinking markup healing through the shared in-band scanners so provider leak repair and owned tool calling parse the same wire formats.
- Fixed Cursor provider (`cursor-agent` API) streaming dropping large MCP tool-call arguments — most visibly the built-in `task` tool's `tasks` array on multi-subagent dispatches, which failed downstream schema validation with `tasks: Invalid input: expected array, received undefined`. Two upstream behaviors were fighting the stream handler in `packages/ai/src/providers/cursor.ts`: (1) `args_text_delta` carries the _cumulative_ args text so far per `agent.proto`, but the handler concatenated each snapshot onto the buffer, garbling the JSON; (2) `tool_call_completed` carries an `McpArgs` map that omits oversized parameters entirely and downgrades unparsable values to their raw string fallback, but the handler unconditionally overwrote the streamed args with that map. The handler now strips the already-buffered prefix from each `args_text_delta` snapshot (falling back to append when the snapshot doesn't extend the buffer) and merges the decoded `McpArgs` map into the streamed args — preserving streamed keys the completion frame omits and the structured value when the completion frame downgrades to a string. ([#2615](https://github.com/can1357/oh-my-pi/issues/2615))
- Fixed Codex Responses stream mis-routing interleaved `function_call_arguments.delta` events when more than one tool call was open concurrently. The runtime tracked a singleton `currentItem`/`currentBlock`, so every delta — regardless of `item_id` — was appended to whichever item was most recently added, and `output_item.done` for the earlier call then overwrote a sibling's stored arguments (visible as `tasks: Invalid input: expected array, received undefined` on the `task` tool). Open items are now keyed by `item_id` with `output_index` fallback; deltas/done events route to the matching block, late deltas whose item already closed are dropped instead of corrupting a sibling, and `toolcall_*` stream events emit the right `contentIndex` per call ([#2619](https://github.com/can1357/oh-my-pi/issues/2619)).

## [15.13.1] - 2026-06-15

### Fixed

- Fixed the auth-broker (`OMP_AUTH_BROKER_URL`) rejecting OAuth credentials that carry provider-specific extension fields (e.g. an MCP server's `tokenUrl`/`clientId`/`clientSecret`/`resource` embedded for self-contained token refresh): the OAuth credential wire schema was `.strict()`, so `POST /v1/credential` failed with `400 unrecognized_keys` and a broker-backed MCP reauth reported success while the reloaded credential lacked its refresh material and could no longer refresh. The OAuth wire schema now uses `.loose()` to preserve unknown fields — matching the field-preserving local SQLite store — so extra OAuth fields round-trip through broker set->get (envelope and API-key schemas stay strict).

## [15.13.0] - 2026-06-14

### Fixed

- Fixed OpenAI Responses/Realtime SSE stream handler crashing with "Error Code undefined: undefined" when parsing error events with nested error details by falling back to the nested error object fields.
- Fixed OpenAI-compatible providers that reject forced `tool_choice` on thinking-required models by downgrading unsupported forced choices to `auto` while keeping tools available ([#2546](https://github.com/can1357/oh-my-pi/issues/2546)).
- Fixed GitHub Copilot Anthropic transport (`api.githubcopilot.com/v1/messages`) returning `400 tools.0.custom.eager_input_streaming: Extra inputs are not permitted` on every tool-bearing turn by stopping the emission of the per-tool `eager_input_streaming` flag and the `fine-grained-tool-streaming-2025-05-14` beta header on the Copilot transport — the proxy whitelists neither ([#2558](https://github.com/can1357/oh-my-pi/issues/2558)).
- Disabled Bun's native ~300s pre-response `fetch` timeout in every streaming provider (OpenAI completions/responses, Azure responses, Anthropic, Codex SSE, Bedrock, Gemini CLI, Ollama). The configurable first-event/idle/SDK watchdogs (`PI_STREAM_FIRST_EVENT_TIMEOUT_MS`, `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`, `compat.streamIdleTimeoutMs`) were silently capped by Bun's hidden ceiling, so cold large-context streams (e.g. self-hosted vLLM at multi-hundred-K prompts) died at exactly 300s with `TimeoutError: The operation timed out.` Direct callers of `./providers/{amazon-bedrock,google-gemini-cli,ollama,openai-codex-responses}` (which bypass `register-builtins`' iterator-level watchdog) now install a pre-response `AbortSignal.timeout(firstEventTimeoutMs)` alongside the disable, so a stalled upstream still fails within the configured budget instead of hanging forever ([#2422](https://github.com/can1357/oh-my-pi/issues/2422))
- Fixed Gemini / Antigravity streams (Google Cloud Code Assist API) creating a trailing empty text block and emitting redundant `text_start`/`text_delta`/`text_end` events at the end of the turn when the final SSE chunk contains an empty text part (`text: ""`). The parser now ignores empty text parts, preserving the active transcript block state and ensuring proper nesting and rendering of subsequent background jobs or new turns.
- Preserved terminal Google `thoughtSignature`s by still extracting and applying the signature on the active block even when the text part is empty or undefined.
- Stopped Gemini Antigravity sessions (`gemini-3*` / Claude under Cloud Code Assist) from leaking system rule reminders and personality preambles into the final response, by appending an explicit 'do not output rule checks' instruction to the injected system parts.
- Fixed Gemini / Antigravity streams (Google Cloud Code Assist API) letting a `functionCall` part's own `thoughtSignature` clobber the preceding text or thinking block's signature on `think → tool` and `text → tool` turns. A signed function-call part has `text: undefined`, so it fell into the terminal-signature branch while the prior block was still active; that branch now skips function-call parts, leaving the tool call's signature on the tool call where it belongs and preventing corrupted signatures on same-model replay.
- Fixed MiniMax-M3 OpenAI-compatible streams rendering reasoning twice when the same chunk carried both `<think>…</think>` content and structured `reasoning_content`; structured reasoning now wins and cumulative MiniMax reasoning snapshots are collapsed to deltas using a per-signature snapshot tracker that survives the `</think>`-to-text block transition (so post-answer cumulative snapshots don't reinstate a duplicate thinking block). ([#2433](https://github.com/can1357/oh-my-pi/issues/2433))

## [15.12.6] - 2026-06-14

### Changed

- Bumped Z.AI (GLM Coding Plan) API key validation probe to glm-5.2.

### Fixed

- Fixed tool schema conversion for non-Cloud Code Assist Google Gemini models by normalizing parameters with `normalizeSchemaForGoogle` to prevent un-normalized schema properties (such as `additionalProperties: false` or type arrays) from causing Gemini API errors.
- Fixed OpenAI-family request builders dropping forced named `tool_choice` directives when the named tool is absent from the serialized `tools` array, preventing spec-strict providers from rejecting self-inconsistent requests. ([#1701](https://github.com/can1357/oh-my-pi/issues/1701))

## [15.12.4] - 2026-06-13

### Added

- Added `GITLAB_CLIENT_ID` and `GITLAB_REDIRECT_URI` env-var overrides for the GitLab Duo OAuth login flow so users running with their own GitLab OAuth application can replace the bundled credentials when GitLab rejects the bundled `client_id`'s redirect URI. Setting `GITLAB_REDIRECT_URI` also disables the random-port fallback (strict OAuth providers reject mismatched URIs anyway). ([#2424](https://github.com/can1357/oh-my-pi/issues/2424))
- Added `AuthStorage.listStoredCredentials()` and `AuthStorage.removeCredential()` for per-account credential management.

### Changed

- Replaced the OpenAI SDK client usage in `openai-completions`, `openai-responses`, `azure-openai-responses`, and `openai-codex-responses` with the new internal `postOpenAIStream` OpenAI-wire JSON/SSE transport

### Fixed

- Fixed streaming providers to cancel upstream model requests when the client closes the response body, so interrupted SSE sessions stop instead of continuing in the background
- Fixed: provider request builders treat unknown `model.maxTokens` (`null`) as "no model cap" instead of coercing to `0` via `Math.min`; Anthropic falls back to the 64k Claude-Code cap for its required `max_tokens`.
- Fixed transient stream failures on OpenAI-compatible providers by retrying HTTP 408/429/5xx responses and transient network errors with Retry-After/quota-hint aware backoff
- Fixed SSE stream handling for OpenAI-compatible responses by parsing wire-level JSON frames directly and honoring `[DONE]` termination
- Fixed stream error handling for OpenAI-compatible providers by preserving structured HTTP status/headers and response body details from failed requests for retry and strict-tool fallback logic
- Fixed OpenAI-compat streams ending with a bare `finish_reason: "error"` (gateways like OpenRouter reporting upstream failures, e.g. Gemini `MALFORMED_FUNCTION_CALL`) surfacing as a non-retryable `Provider finish_reason: error`. The reason is now mapped to `Provider returned error finish_reason`, which the session retry classifier recognizes as transient, so the turn auto-retries instead of stopping with a pinned error banner.
- Fixed `SqliteAuthCredentialStore.open()` crashing with `SQLITE_BUSY_RECOVERY` (errno 261) when several `omp --session` panes restore concurrently after an unclean shutdown: `PRAGMA busy_timeout = 5000` now runs as a standalone statement BEFORE `PRAGMA journal_mode=WAL` (the first lock-taking statement during WAL recovery), and `open()` retries the BUSY family — `SQLITE_BUSY`, `SQLITE_BUSY_RECOVERY`, `SQLITE_BUSY_SNAPSHOT`, `SQLITE_BUSY_TIMEOUT` — with bounded exponential backoff. The exhausted-retry error message includes the DB path. Exported `isSqliteBusyError(err)` for callers that need the same classifier ([#2421](https://github.com/can1357/oh-my-pi/issues/2421)).
- Fixed MiniMax-M3 OpenAI-compatible streams rendering reasoning twice when the same chunk carried both `<think>…</think>` content and structured `reasoning_content`; structured reasoning now wins and cumulative MiniMax reasoning snapshots are collapsed to deltas. ([#2433](https://github.com/can1357/oh-my-pi/issues/2433))
- Fixed Gemini turns silently halting the agent when the model returned `finishReason: STOP` with only an empty (or whitespace-only) text part and no tool call — the well-known "empty response" failure. All Google surfaces (public Generative Language `streamGoogle`, Vertex `streamGoogleVertex`, and Cloud Code Assist `google-gemini-cli`/`google-antigravity`) now classify such a turn as empty via the shared `hasMeaningfulGoogleContent` check and retry it up to `MAX_EMPTY_STREAM_RETRIES` times before surfacing an error. The Cloud Code Assist path previously had an empty-stream retry that never fired for this case (its `hasContent` flag counted an empty-string text part as content), and the public/Vertex path had no retry at all; the retry now emits a single `start` event so no duplicate partial message leaks downstream.

## [15.12.1] - 2026-06-12

### Added

- Added the optional `ToolResultMessage.useless` flag: tools can declare a finished result contextually useless (zero matches, elapsed wait) so compaction passes may elide it once consumed. Never serialized to provider wire formats and never set together with `isError`.

## [15.12.0] - 2026-06-12

### Fixed

- Fixed Anthropic requests bypassing lone-surrogate sanitization after payload hooks or Anthropic-origin tool-call replay: the model itself can emit unpaired surrogate escapes in its own tool-argument JSON (streamed out fine, then rejected with `400 The request body is not valid JSON` on every subsequent request, bricking the session). The final Anthropic payload is now deep-sanitized with `toWellFormed()` immediately before SDK serialization; the pass is identity-preserving, so well-formed arguments stay byte-identical and prompt-cache prefixes are unaffected.

## [15.11.8] - 2026-06-12

### Breaking Changes

- Removed the Codex SSE stateful transport path, so SSE turns no longer send `previous_response_id` with delta input and now always send the full transcript

### Changed

- Scoped `x-codex-turn-state` handling to within-turn continuations so only tool-loop follow-ups include the turn-state header and new user turns start without it

### Removed

- Removed the `statefulResponses` option from `OpenAICodexResponsesOptions`, and SSE stateful mode is no longer controlled by the `PI_CODEX_STATEFUL`-style flag

### Fixed

- Fixed the platform OpenAI Responses and Codex websocket stale-chain classifiers missing the "Unsupported parameter: previous_response_id" rejection phrasing (FastAPI-style `detail` body with no `error.code`), so a chained turn now falls back to a full-transcript replay instead of surfacing the 400
- Fixed the HTTP-400 raw-request dump for Codex SSE to record the body actually sent on the wire instead of the pre-transport request body, which made chained-request failures look like the rejected parameter was never sent

## [15.11.7] - 2026-06-12

### Added

- Added `requestModelId` and `thinking.suppress` options to `google-gemini-cli` so collapsed effort-tier variants serialize their per-effort upstream wire id, and thinking-off requests on models with `thinking.suppressWhenOff` send an explicit `thinkingConfig` (`includeThoughts: false` with `thinkingLevel: "MINIMAL"` or `thinkingBudget: 0`) — Cloud Code Assist re-applies the per-id baked server default when the config is omitted, silently thinking and billing the tokens
- Added mandatory-reasoning clamping: models baked with `thinking.requiresEffort` floor omitted or disabled reasoning to the lowest supported effort in every api mapping, and `disableReasoning` no longer emits OpenRouter `reasoning: { enabled: false }` for them — fixes `omp bench` and utility requests 400ing with "Reasoning is mandatory for this endpoint and cannot be disabled" on OpenRouter Gemini 3.x

### Changed

- Changed `google-gemini-cli` request mapping to route per-request wire ids via `resolveWireModelId`: the session effort picks the backing variant id (collapsed `gemini-3.5-flash` at high → `gemini-3.5-flash-low`; claude pairs route off → bare id, efforts → `-thinking`) while `AssistantMessage.model` and usage attribution stay on the logical id. A thinking budget clamped to zero now falls through to the thinking-off path (off routing plus suppression) instead of only disabling thinking
- Changed `openai-completions` and `anthropic-messages` to serialize per-request wire ids via `resolveWireModelId`, so collapsed `X`/`X-thinking` pairs on aggregators and custom providers switch to the thinking SKU when reasoning is enabled (previously only `google-gemini-cli` routed effort-tier variants)

### Fixed

- Fixed `google-gemini-cli` ignoring `Model.requestModelId` when serializing the request model id

## [15.11.5] - 2026-06-12

### Added

- Added `AuthStorage.listUsageHistory` to retrieve historical usage snapshots with optional `provider` and `sinceMs` filtering
- Added durable usage-history persistence in the sqlite auth store so successful usage reports are recorded as time-series snapshots of limit utilization for later trend inspection
- Added `AuthStorage.redeemResetCredit` to redeem stored OpenAI Codex saved rate-limit reset credits for a target account by `credentialId`, `accountId`, or `email`
- Added `listCodexResetCredits` and `consumeCodexResetCredit` exports for OpenAI Codex saved reset-credit listing and redemption
- Added `resetCredits` with `availableCount` to `UsageReport` so OpenAI Codex usage data now exposes redeemable rate-limit resets
- Added `openai-codex-reset` exports via package barrel for out-of-band tooling usage
- Added a one-shot request-debug target that writes the next provider HTTP request JSON to an explicit path.

### Changed

- Changed `AuthStorage.redeemResetCredit` to invalidate cached usage data after a successful redemption so the next usage report reflects the reset immediately

### Fixed

- Fixed temporary credential block state so redeemed reset credits immediately make the affected account selectable again after `redeemResetCredit` succeeds
- Fixed one-shot request-debug path handling so an explicit request log target is consumed after the next request and no longer affects subsequent calls
- Fixed explicit request-debug path mode to create missing parent directories before writing request logs
- Fixed explicit request-debug mode to overwrite existing `.res.log` files for the requested path instead of failing when they already exist
- Fixed OpenAI Responses `previous_response_id` chaining on Zero Data Retention orgs: the in-provider retry classifier missed the ZDR-specific 400 ("Previous response cannot be used for this organization due to Zero Data Retention"), so chained turns kept failing every other request after a brief recovery — the chain was reset but not disabled, so the next successful full-replay turn re-armed it. The ZDR phrasing is now classified categorically: one strike disables chaining for the session (skipping the three-strike circuit breaker) and the in-call retry drops `store: true`/`previous_response_id` and replays the full transcript instead ([#2341](https://github.com/can1357/oh-my-pi/issues/2341)).

## [15.11.4] - 2026-06-12

### Added

- Codex/Responses providers now map `end_turn: false` on the terminal stream event (Codex backend signal for "response ended, turn didn't" — commentary-only progress updates) to `stopDetails: { type: "pause_turn" }` with stopReason `"stop"`, so the agent loop can re-sample instead of ending the turn. Wired in `openai-codex-responses` and `processResponsesStream` (`openai-responses`/`azure-openai-responses`); inert for backends that never send the field.
- Added Codex upstream protocol features to `openai-codex-responses` (tracking codex-rs as of June 2026): `onModerationMetadata` callback surfacing `response.metadata` → `openai_chatgpt_moderation_metadata` on both transports; `reasoningContext` option emitting `reasoning.context` (`auto`/`current_turn`/`all_turns`); `clientMetadata` option emitting `client_metadata` in the request body (canonical `x-codex-turn-metadata` envelope) without breaking the websocket append fast-path; and an opt-in `responsesLite` mode mirroring codex-rs — lite header on HTTP requests and the websocket upgrade, `ws_request_header_*` marker in `response.create` client metadata, lite-keyed socket pooling, image-detail stripping, forced serial tool calls, and `reasoning.context: all_turns` default. Dormant until OpenAI flips `use_responses_lite` in the model catalog.
- Added `withOAuthAccess` — the `withAuth` counterpart for OAuth-access consumers: runs an operation through the central a/b/c auth-retry policy (resolve → force-refresh same account → rotate to a sibling) while handing the attempt the full `OAuthAccess` (bearer plus `accountId`/`projectId`/`enterpriseUrl` identity metadata). Use it instead of hand-rolled `getOAuthAccess` + fetch flows so 401s and usage-limits rotate credentials instead of failing the call.
- Added `ProviderHttpError` — a typed HTTP error carrying `status`, `headers`, and `code` — replacing the ad-hoc `as Error & { status?... }` / `Object.assign` hacks at provider throw sites, with per-provider subclasses `CodexApiError`, `AuthGatewayError`, `GoogleApiError`, `GeminiCliApiError`, `OllamaApiError`, and `BedrockApiError`; `AnthropicApiError` now extends it. Google, Gemini CLI, Ollama, and Bedrock HTTP errors now also carry response headers, so server-suggested `retry-after` delays are visible to retry classification on those paths. The internal `withHttpStatus` helper was removed.
- Added stateful SSE turn chaining for OpenAI Codex (on by default; disable with `PI_CODEX_STATEFUL=0` or `statefulResponses: false`): SSE requests now reuse `previous_response_id` with delta-only input instead of replaying the full transcript, mirroring the websocket fast-path via a shared transport-aware builder. Any history mutation or option change falls back to a full replay; a server-side `previous_response_not_found` (HTTP or in-stream) resets the chain and retries the turn with full context, and three consecutive stale failures disable chaining for the session.
- Added stateful `previous_response_id` chaining to the platform OpenAI Responses provider (`openai-responses`): on by default against the official api.openai.com endpoint (forces `store: true`, which chaining requires), off for other Responses endpoints; override with `statefulResponses` or `PI_OPENAI_STATEFUL`. Chain detection compares the wire form of the conversation arguments alone — per-turn trailing scaffolding such as the GPT-5 "Juice: 0" developer item is excluded from the append-baseline prefix check and re-appended to the delta — and a rejected/stale previous response falls back to a one-shot full replay with the same circuit breaker.
- Added `AuthStorage.getOAuthAccountIdentity()` and the `OAuthAccountIdentity` type — a read-only lookup returning the `accountId`/`email`/`projectId` of the OAuth credential a session is currently routed to, for display and metadata paths.

### Changed

- The GPT-5 "Juice: 0" no-reasoning developer item in `applyResponsesReasoningParams` is now gated on the resolved `compat.requiresJuiceZeroHack` flag (auto-detected from GPT-5-family model names by `@oh-my-pi/pi-catalog`, overridable per model) instead of an inline model-name check.

### Fixed

- Fixed websocket append fast-path to remain usable when only `client_metadata` changes between turns
- Fixed `onModerationMetadata` handling so exceptions thrown by callback observers no longer terminate the response stream
- Fixed local SQLite OAuth credential caches returning a stale Anthropic access token after another `omp` process refreshed and persisted the same row. `AuthStorage` now syncs the selected row from storage before returning or force-refreshing OAuth credentials, so concurrent sessions pick up peer-rotated tokens instead of surfacing a one-turn `401 Invalid authentication credentials`.
- Fixed forced OAuth preflight refresh failures being swallowed silently in credential selection; they now emit a debug log (`OAuth preflight refresh failed`) so stale-refresh-token replays from concurrent sessions are diagnosable.

## [15.11.3] - 2026-06-11

### Fixed

- Fixed GitHub Copilot long-context model requests to use the upstream `requestModelId` when calling Anthropic, OpenAI Responses, and OpenAI Completions APIs
- Fixed GitHub Copilot model enablement to deduplicate catalog variants by upstream model ID when enabling all models

## [15.11.2] - 2026-06-11

### Fixed

- Fixed Anthropic encoding of error tool results with whitespace-only content so requests no longer 400 with `tool_result: content cannot be empty if is_error is true`

## [15.11.1] - 2026-06-11

### Changed

- Exported `resolveAnthropicMetadataUserId` so non-streaming Anthropic Messages consumers (e.g. the coding-agent web search provider) can produce the same Claude-Code-shaped `metadata.user_id` as the main streaming path.

### Fixed

- Preserved Anthropic `stop_details` on assistant messages so refusal and sensitive classifier stops remain structurally visible to callers. ([#2290](https://github.com/can1357/oh-my-pi/issues/2290))
- Fixed OpenAI Responses, Azure OpenAI Responses, and OpenAI Completions streams hanging until the 120s idle watchdog errored the turn when a provider delivers the terminal frame but never sends `[DONE]` nor closes the connection. `processResponsesStream` now breaks out of the event loop on `response.completed`/`response.incomplete` (mirroring the Codex websocket/SSE terminal break), and the completions consumer breaks once `finish_reason` plus a usage payload arrived — or, for hosts that never send usage, ends the stream cleanly via a short post-finish grace window (`iterateWithTerminalGrace`) that aborts the transport to release the socket.

## [15.11.0] - 2026-06-10

### Added

- Added optional `ImageContent.detail` (`"auto" | "low" | "high" | "original"`): an OpenAI resolution hint forwarded by the `openai-responses` serializers (default stays `auto`) and by `openai-completions` for the values Chat Completions supports. `"original"` preserves native resolution — required for snapcompact frames, whose pixel-font glyphs do not survive the default downscale. Providers without a detail knob ignore the field.

### Fixed

- Fixed OpenRouter DeepSeek V4 strict tool schemas nesting `anyOf` inside the nullable wrapper for optional unions, which produced a branch without `type` and triggered OpenRouter's `Invalid tool parameters schema : field anyOf: missing field type` 400. ([#2270](https://github.com/can1357/oh-my-pi/issues/2270))
- Hardened strict tool-schema handling beyond the optional-union case: `enforceStrictSchema` now splices natively nested pure unions into the parent `anyOf` (only when the inner node carries no constraining siblings, since sibling keywords are conjunctive with `anyOf`), so source schemas with nested unions no longer produce type-less `anyOf` branches that strict upstream validators reject. ([#2270](https://github.com/can1357/oh-my-pi/issues/2270))
- Made the openai-completions non-strict retry reachable for `"mixed"` strict mode (previously gated to `all_strict`, i.e. Cerebras only) and taught it to recognize upstream tool-schema validation 400s (`Invalid tool parameters schema …`, `Invalid schema for function …`). A matching rejection now retries the request with base (non-strict) schemas and persists `strictToolsDisabled` on the provider session, so later requests skip the doomed strict attempt instead of paying a 400 + retry round-trip each turn. ([#2270](https://github.com/can1357/oh-my-pi/issues/2270))
- Cross-model `anthropic-messages → anthropic-messages` continuations now preserve prior assistant turns' reasoning chains end-to-end: every prior `thinking`/`redactedThinking` block survives (not just the latest surviving assistant), and third-party ↔ third-party replays keep their signatures intact so the reasoning chain stays signed for the next turn. Signatures are stripped (and any `redacted_thinking` sibling without a native landing spot is dropped) only when an official Anthropic endpoint is on either end of the replay — official Anthropic cryptographically binds reasoning signatures to its key+session+model, while compatible reasoning endpoints (Z.AI, DeepSeek, custom anthropic-messages providers configured via `models.yaml`) treat them as opaque continuation hints. Source-side official detection uses the canonical catalog provider id `"anthropic"` (assistant messages carry no `baseUrl`); target-side detection reuses the baked `compat.officialEndpoint` flag. Latest-turn byte-for-byte behavior (Anthropic's "thinking blocks in the latest assistant message cannot be modified" rule) and existing aborted/errored last-block sanitization are unchanged. ([#2257](https://github.com/can1357/oh-my-pi/issues/2257), [#2265](https://github.com/can1357/oh-my-pi/issues/2265))

## [15.10.12] - 2026-06-10

### Added

- Added `antigravityRankingStrategy` and registered it for `google-antigravity` in `DEFAULT_RANKING_STRATEGIES`, so new sessions are routed to OAuth credentials with quota headroom for the requested model backend (lowest relevant `remainingFraction` counter as the sole ranked window, 24h `windowDefaults` matching `daily-cloudcode-pa.googleapis.com` resets). Without it, the existing `antigravityUsageProvider` data never reached credential selection. ([#2198](https://github.com/can1357/oh-my-pi/issues/2198))

### Changed

- Updated MiniMax and MiniMax Token Plan defaults to `MiniMax-M3` and refreshed Token Plan login copy/links ([#1725](https://github.com/can1357/oh-my-pi/issues/1725)).

### Fixed

- Fixed OpenAI Responses and Azure OpenAI Responses streams silently surfacing incomplete output as successful when a custom/proxy provider drops the connection without sending a terminal `response.completed`/`response.incomplete` event. Both providers now detect premature stream closure and throw with `stopReason: "error"` ([#2184](https://github.com/can1357/oh-my-pi/pull/2184))
- Fixed `isUsageLimitError` missing Antigravity / Cloud Code Assist's `Individual quota reached` 429 phrasing. The `USAGE_LIMIT_PATTERN` only knew `quota.?exceeded` / `limit_reached`, so `auth-retry` and `AuthStorage.markUsageLimitReached` treated the response as a terminal provider error and pinned sessions to the exhausted OAuth account instead of rotating to a sibling credential. The pattern now also matches `quota.?reached`. ([#2198](https://github.com/can1357/oh-my-pi/issues/2198))
- Scoped Antigravity usage blocking and ranking by model family (`gemini-*`/`gemma-*` → Google, `claude-*` → Anthropic, `gpt-*`/`openai/*` → OpenAI), so an exhausted Gemini counter no longer makes a healthy Claude/OpenAI Antigravity credential unavailable until reset. ([#2198](https://github.com/can1357/oh-my-pi/issues/2198))
- Fixed no-model Antigravity credential lookups (e.g. image-provider discovery) inheriting provider-wide exhaustion: `scopeLimits` now returns no limits without a concrete backend counter, and `blockScope` always returns a counter scope so missing model context can never fall through to AuthStorage's provider-wide block bucket. ([#2198](https://github.com/can1357/oh-my-pi/issues/2198))

Older entries are archived in [packages/ai/CHANGELOG.md@8a9097246135](https://github.com/can1357/oh-my-pi/blob/8a9097246135bd572ff96fb552121fe1194d2906/packages/ai/CHANGELOG.md).
