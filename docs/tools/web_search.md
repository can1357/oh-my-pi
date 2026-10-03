# web_search

> Run one web query through the configured search chain and return the first usable answer/sources, with optional citations.

## Source
- Entry: `packages/coding-agent/src/web/search/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/web-search.md`
- Key collaborators:
  - `packages/coding-agent/src/web/search/provider.ts` — lazy provider registry; availability chain.
  - `packages/coding-agent/src/web/search/types.ts` — unified `SearchResponse` / `SearchProviderError` types.
  - `packages/tui/src/tools/web-search.ts` / `web-search-types.ts` — transcript rendering and shared response/provider types.
  - `packages/coding-agent/src/web/search/providers/base.ts` — provider interface and shared params contract.
  - `packages/coding-agent/src/web/search/providers/utils.ts` — credential lookup; source normalization.
  - `packages/coding-agent/src/web/search/providers/browser-headers.ts` — shared Chromium navigation headers for scrape providers.
  - `packages/coding-agent/src/web/search/query.ts` — Google-style query parsing, provider syntax formatting, and lenient result filtering.
  - `packages/coding-agent/src/web/search/providers/browser-page.ts` — shared fetch/headless-browser page loader for scrape providers.
  - `packages/coding-agent/src/web/search/providers/anthropic.ts` — Claude web-search provider.
  - `packages/coding-agent/src/web/search/providers/brave.ts` — Brave Search API adapter.
  - `packages/coding-agent/src/web/search/providers/codex.ts` — OpenAI Codex SSE adapter.
  - `packages/coding-agent/src/web/search/providers/openai.ts` — billed OpenAI API Responses adapter, separate from Codex OAuth.
  - `packages/coding-agent/src/web/search/providers/openrouter.ts` — chat-completions grounding through OpenRouter's web plugin.
  - `packages/coding-agent/src/web/search/providers/duckduckgo.ts` — DuckDuckGo HTML frontend scraper.
  - `packages/coding-agent/src/web/search/providers/ecosia.ts` — Ecosia browser-backed scraper.
  - `packages/coding-agent/src/web/search/providers/exa.ts` — Exa API or MCP adapter.
  - `packages/coding-agent/src/web/search/providers/firecrawl.ts` — Firecrawl search adapter.
  - `packages/coding-agent/src/web/search/providers/gemini.ts` — Gemini grounding SSE adapter.
  - `packages/coding-agent/src/web/search/providers/google.ts` — Google browser-backed SERP scraper.
  - `packages/coding-agent/src/web/search/providers/jina.ts` — Jina Reader search adapter.
  - `packages/coding-agent/src/web/search/providers/kagi.ts` — Kagi provider wrapper.
  - `packages/coding-agent/src/web/search/providers/kimi.ts` — Kimi search adapter.
  - `packages/coding-agent/src/web/search/providers/mojeek.ts` — Mojeek browser-backed scraper (independent index).
  - `packages/coding-agent/src/web/search/providers/parallel.ts` — Parallel provider wrapper.
  - `packages/coding-agent/src/web/search/providers/perplexity.ts` — Perplexity API / OAuth adapter.
  - `packages/coding-agent/src/web/search/providers/public.ts` — Public Web aggregate over all credential-free engines.
  - `packages/coding-agent/src/web/search/providers/serper.ts` — Serper Google Search API adapter.
  - `packages/coding-agent/src/web/search/providers/searxng.ts` — self-hosted SearXNG adapter.
  - `packages/coding-agent/src/web/search/providers/startpage.ts` — Startpage (Google-proxied) form-flow scraper.
  - `packages/coding-agent/src/web/search/providers/synthetic.ts` — Synthetic search adapter.
  - `packages/coding-agent/src/web/search/providers/ollama.ts` — Ollama web search adapter.
  - `packages/coding-agent/src/web/search/providers/tavily.ts` — Tavily search adapter.
  - `packages/coding-agent/src/web/search/providers/tinyfish.ts` — TinyFish search adapter.
  - `packages/coding-agent/src/web/search/providers/xai.ts` — xAI Responses web-search adapter.
  - `packages/coding-agent/src/web/search/providers/zai.ts` — Z.AI remote MCP adapter.
  - `packages/coding-agent/src/web/parallel.ts` — Parallel search/extract HTTP client.
  - `packages/coding-agent/src/web/kagi.ts` — Kagi HTTP client.
  - `packages/coding-agent/src/tools/index.ts` — built-in tool registration and enable flag.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Raw query. The parser recognizes `site:`/`-site:`, `after:`/`before:`, `inurl:`, `intitle:`, `intext:`, `filetype:`, `lang:`/`language:`, quoted phrases, exclusions, `OR`, and directive aliases. Providers map these to native filters or supported syntax; body/language directives are not central source filters. |
| `recency` | `"day" \| "week" \| "month" \| "year"` | No | Relative time filter. Implemented by Serper, Brave, Perplexity, Parallel, Tavily, SearXNG, Kagi, TinyFish, Firecrawl, DuckDuckGo, Startpage, Google, and Mojeek. Public Web forwards it to its engines; other adapters ignore it. |
| `limit` | `number` | No | Max results to return. Usually becomes the provider request's result-count parameter when `num_search_results` is absent. TinyFish uses it for paginated fetches before slicing. xAI uses the collapsed value only as a local cap on parsed sources/citations, defaulting to `10` and max `30`. |
| `max_tokens` | `number` | No | Token cap passed through by Anthropic, Gemini, OpenAI Responses, xAI, and Perplexity API-key mode. Ignored by the other providers. |
| `temperature` | `number` | No | Passed through only by Anthropic models that support sampling parameters, Gemini, xAI, and Perplexity API-key mode. Ignored or omitted by the other provider/model paths. |
| `num_search_results` | `number` | No | Provider-native search breadth or local result cap, usually taking precedence over `limit`. Perplexity API and OpenRouter use it upstream; Anthropic, Gemini, Codex, OpenAI Responses, and xAI cap parsed sources locally. TinyFish sends a per-page count and paginates. See adapter limits below. |

The schema does not impose integer, positivity, or range constraints on numeric fields; provider adapters apply their own caps. The built-in tool is read-approved, strict-schema, and discoverable.
## Outputs
The tool returns a single text content block plus structured `details`.

- `content`: `[{ type: "text", text: string }]`
- `details`: `SearchResultDetails` from `packages/coding-agent/src/web/search/types.ts`
  - `response: SearchResponse`
  - `error?: string`

`text` is produced by `formatForLLM()` in `packages/coding-agent/src/web/search/index.ts`. Notes about relaxed query constraints are emitted first:

- If `response.answer` exists, it is emitted first.
- If sources exist, one entry per source follows (the `## Sources` header with a source count is emitted only when an answer was also produced):
  - `[n] <title> (<formatted age or published date>)`
  - `    <url>`
  - optional snippet line truncated to 240 chars.
- If citations exist, a `## Citations` section follows with URL/title plus optional cited text truncated to 240 chars.
- If related questions exist, a `## Related` bullet list follows.
- If search queries exist, a `Search queries: <n>` section follows, capped to the first 3 queries and 120 chars each.

Failure output is not thrown at the tool boundary when providers are unavailable or provider attempts fail. Instead the tool returns:

- `content[0].text = "Error: ..."`
- `details.response.provider = <last attempted provider> | "none"`
- `details.error = ...`

Streaming: none. `WebSearchTool.execute()` forwards its `AbortSignal` into `executeSearch()`, and `executeSearch()` passes it to providers. If the signal is aborted during fallback handling, `throwIfAborted(signal)` rethrows the cancellation instead of returning an `"Error: ..."` text result.

Each provider search transport receives a hard timeout from `providers.webSearchTimeoutSeconds` (default `60`, maximum `300`). When that transport exceeds the ceiling, the automatic chain records the provider failure and advances to the next candidate. The setting is not a whole-chain deadline, and providers may impose shorter upstream, retry, or aggregate limits. Set a positive number of seconds, for example `omp config set providers.webSearchTimeoutSeconds 180` for slower model-backed search.

## Flow
1. `WebSearchTool.execute()` in `packages/coding-agent/src/web/search/index.ts` delegates directly to `executeSearch()`.
2. `executeSearch()` builds the candidate pool with `roleCandidatePool("web", …)`: available models the `web` role accepts, i.e. `web/*` search-engine catalog models (kind `search`) and chat models that declare a `webSearch` grounding. It then orders candidates:
   - if `params.model` is set (not in the model-facing schema; `omp q --model <selector>` sets it), that selector resolves to at most one candidate, marked explicit;
   - otherwise `resolveRoleChain("web", …)` (`packages/coding-agent/src/config/model-resolver.ts`) yields the `web` role chain described under [Provider selection](#modes--variants).
3. `web/hosted` expands to the active model's same-provider `webSearchModel` swap when available, then the active model itself, retaining only models with grounding. A failed swap falls through to the active model. An unexpandable placeholder is skipped automatically or fails explicitly. Each remaining candidate lazily loads its search engine or grounding backend (`gemini`, `anthropic`, `codex`, `openai`, `xai`, `openrouter`). Explicit candidates use `isExplicitlyAvailable()`, automatic ones use `isAvailable()`; unavailable explicit candidates record a failure while automatic ones are skipped.
4. If no candidate was available and none failed, `executeSearch()` returns `Error: No web search model configured.` (or `No web search model matches selector "<model>".` when `params.model` was given) with `details.response.provider = "none"`.
5. For each provider in order, `executeSearch()` calls `provider.search()` with:
   - `query`,
   - `limit`, `recency`, `temperature`, `maxOutputTokens`, `numSearchResults`,
   - `timeoutMs`, derived from `providers.webSearchTimeoutSeconds`,
   - `systemPrompt` from `packages/coding-agent/src/prompts/system/web-search.md`,
   - the parsed structured query, including recognized directives and date/domain/title/URL/filetype constraints.
6. After a provider responds, `applyQueryConstraints()` leniently post-filters its sources for constraints not guaranteed upstream. It applies each filterable dimension in turn; any dimension that would eliminate every remaining result is relaxed and a leading `Note: no results matched ...` is emitted. Answer/citation text is not rewritten.
7. Grounded chat responses must contain sources or citations; answer-only completions are rejected with status `204`. Any response with no renderable content is also rejected. The first acceptable response is formatted into one text block.
8. If a provider throws, `executeSearch()` records the error and tries the next provider. There is no provider-level parallel fan-out; fallback is sequential.
9. After all candidates fail, `formatSearchProviderFailure()` normalizes each error:
   - Anthropic `404` becomes `Anthropic web search returned 404 (model or endpoint not found).`
   - `401`/`403` become `<Provider> authorization failed ...` except Z.AI, which preserves its raw message.
   - other `SearchProviderError`s surface `error.message`.
10. If more than one provider failed, the final message is `All web search providers failed: <provider/error>; ...`; otherwise it is just the normalized last error.

## Modes / Variants
- **Provider selection**
  - Provider choice is the `web` model role. A candidate is a catalog model: `web/<engine>` for a search engine (for example `web/brave`, `web/duckduckgo`), or a chat model whose catalog entry declares a `webSearch` grounding (for example `anthropic/claude-haiku-4-5`, bundled `openai/gpt-6-luna`, or `openai/gpt-5.6-luna`), in which case that model runs the grounded search.
  - **Primary**: `modelRoles.web`. If it is set, its first selector pattern that matches an available model becomes the first candidate and is explicit. If it is unset, the role resolves through the built-in `web` priority list.
  - **Fallbacks**: `retry.fallbackChains.web`. If it is set (even as an empty list), exactly those selectors follow the primary and are explicit. If it is unset, every entry of the built-in `web` priority list that matches an available model follows as a non-explicit candidate. Duplicate models are dropped, and a model listed by any explicit selector stays explicit.
  - **Explicit vs automatic**: explicit candidates use `isExplicitlyAvailable()`, so Perplexity and Public Web can run their unauthenticated paths when you select them. Parallel, Exa, and Firecrawl run their keyless paths in either mode. Automatic candidates use `isAvailable()` and are skipped when their credentials are missing.
  - **Per-request selector**: `SearchQueryParams.model` (`omp q --model web/duckduckgo "…"`) replaces the whole chain with that single explicit candidate.
  - **Default chain** (`packages/coding-agent/src/priority.json`): `web/parallel`, `web/hosted`, `web/exa`, `web/firecrawl`, `web/searxng`, `web/startpage`, `web/duckduckgo`, `web/ecosia`, `web/google`, `web/mojeek`, `web/public`. Parallel/Exa/Firecrawl offer keyless paths but use configured credentials when available; hosted search uses the session provider's credential. The chain is not a guarantee of zero billing. Other paid engines/chat providers require explicit role/fallback configuration. Public Web is explicit-only and never runs automatically.
  - **Legacy settings**: on load, `packages/coding-agent/src/config/settings.ts` migrates `providers.webSearch`, `providers.webSearchOrder`, `providers.webSearchExclude`, and `providers.webSearchGeminiModel` into `modelRoles.web` plus `retry.fallbackChains.web`, then deletes the old keys. The migration never overwrites a role or chain that is already set. The migrated chain is the listed providers followed by the default chain, with excluded providers removed; `providers.webSearchGeminiModel` only shapes a listed `gemini` entry.
- **Provider timeout**: `providers.webSearchTimeoutSeconds` supplies the hard ceiling for each provider's search transport before the automatic chain advances. It defaults to `60`; invalid non-positive values fall back to that default and values above `300` are capped, while provider-specific upstream or aggregate limits may still be shorter.
- **Provider adapters**
  - **Serper** — `packages/coding-agent/src/web/search/providers/serper.ts`
    - Availability: `SERPER_API_KEY` or a stored credential added through `/login serper`.
    - Querying: POST `https://google.serper.dev/search` with `X-API-KEY`; Google-style directives stay in `q`, while `recency` maps to `tbs=qdr:d|w|m|y`.
    - `limit` / `num_search_results`: collapsed and clamped to `1..100`, default `10`.
    - Output: direct `answer` text from Serper answer boxes, deduplicated knowledge graph and organic `sources`, `relatedQuestions` from People Also Ask and related searches, `requestId`, and `authMode: "api_key"`.
  - **Perplexity** — `packages/coding-agent/src/web/search/providers/perplexity.ts`
    - Availability: tries cookies, stored OAuth, then direct API credentials. Anonymous search is admitted only when no credential method resolves and the candidate is explicit; failed authenticated methods do not append an anonymous attempt. Automatic admission requires direct Perplexity auth. OpenRouter keys are never borrowed; select an `openrouter/perplexity/…` model for OpenRouter grounding.
    - Browser SSO: run `/login perplexity` (or select Perplexity in the setup wizard), then press Enter or enter `sso`. Complete sign-in in the dedicated browser window, choosing **Single sign-on (SSO)** for your organization. omp captures and validates the session automatically; no extension, DevTools, cookie copying, or logout from your normal browser is needed.
    - Browser login requires a graphical session on the machine running omp. It uses an isolated Chromium profile and incognito context, preserves sandbox and TLS checks, and closes the browser when login finishes, is cancelled, or reaches the five-minute timeout. Press Escape in omp to cancel. Profile cleanup uses the existing retry-and-warn behavior if the operating system keeps files locked.
    - The saved session uses the existing Perplexity subscription, including an Enterprise seat; browser SSO does not switch to separately billed API credentials. Sign in again if Perplexity expires or revokes the session. Enter `email` to use the existing email-code and authenticator-code flow instead.
    - Legacy `ai.perplexity.mac` sessions may still be borrowed before the login prompt. Start omp with `PI_AUTH_NO_BORROW=1` to skip borrowing. Newer Mac app sessions in the restricted Keychain are not borrowed.
    - SDK hosts can provide `OAuthController.onBrowserSession` to return the first non-empty cookie value matching `request.cookieNames`, checked in preference order. The callback returns the value privately; pi-ai validates it without importing browser automation. Hosts without that callback retain the email-code flow. RPC login does not launch a browser.
    - OAuth/cookie/anonymous mode: POSTs to `https://www.perplexity.ai/rest/sse/perplexity_ask`, consumes SSE, merges partial events, extracts answer and source URLs, sets `authMode: "oauth"` (`"anonymous"` for the unauthenticated fallback).
    - API-key mode: streams `https://api.perplexity.ai/chat/completions` with model default `sonar-pro` (`PI_PERPLEXITY_API_MODEL` can override it), `search_mode: "web"`, search breadth, and token/sampling controls. Native domain/date/language filters are derived from the query; absolute dates take precedence over recency.
    - `num_search_results` controls upstream API breadth only in API-key mode. `limit` is preserved separately as `num_results` and slices returned `sources` after parsing in both auth modes.
    - Output may include `answer`, `sources`, `citations`, `usage`, `model`, `requestId`, `authMode`.
  - **Gemini** — `packages/coding-agent/src/web/search/providers/gemini.ts`
    - Availability: OAuth credentials in `agent.db` for `google-gemini-cli` / `google-antigravity`, or a Google Developer API key.
    - Querying: SSE `streamGenerateContent` with Google Search grounding at the selected model's endpoint. Cloud Code Assist auth uses `withOAuthAccess`; developer API auth uses the model-registry resolver. HTTP retries use up to four attempts with exponential/server-provided delays capped at five minutes, bounded by the transport signal.
    - Model: the selected `web` candidate (`google/…`, `google-antigravity/…`, or `google-gemini-cli/…` chat model).
    - `max_tokens` and `temperature` pass through as `generationConfig.maxOutputTokens` / `generationConfig.temperature`.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output may include `answer`, `sources`, `citations`, `searchQueries`, `usage`, `model`.
  - **Anthropic** — `packages/coding-agent/src/web/search/providers/anthropic.ts`
    - Availability: credentials for the selected model provider, or `ANTHROPIC_SEARCH_API_KEY` when that provider is `anthropic`. The search-specific key is tried first, with registry credentials available for auth retry. Endpoint and configured headers come from the selected model; there is no `ANTHROPIC_SEARCH_BASE_URL` override.
    - Model: the selected `web` candidate.
    - Querying: Claude Messages API with web-search tool enabled.
    - `max_tokens` passes through. `temperature` passes through only for models that support sampling parameters; it is omitted for Opus 4.7+, Sonnet 5+, and Fable/Mythos 5+ because those APIs reject sampling parameters.
    - `num_search_results ?? limit` caps parsed sources locally; no upstream result-count field is sent.
    - Output may include `answer`, `sources`, `citations`, `searchQueries`, `usage.searchRequests`, `model`, `requestId`.
  - **Codex** — `packages/coding-agent/src/web/search/providers/codex.ts`
    - Availability: OAuth credential for `openai-codex` in `agent.db`; refresh is lazy during search. This uses ChatGPT/Codex OAuth, not OpenAI API billing. Custom model-registry endpoints may instead use a configured API-key/command credential, but official OAuth/env credentials are refused for custom endpoints.
    - Querying: streams the Codex Responses endpoint with hosted `web_search` and `search_context_size: "high"`. Google-style directives are re-emitted in the query.
    - Model: the selected `web` candidate. A completion without a `web_search_call` is rejected rather than presented as searched content.
    - Ignores `recency`, `max_tokens`, and `temperature`. `num_search_results ?? limit` slices parsed sources locally.
    - Output may include `answer`, `sources`, `usage`, `model`, `requestId`. If the stream has no `url_citation` annotations, the adapter falls back to markdown links and bare URLs from the answer.
  - **OpenAI API** — `packages/coding-agent/src/web/search/providers/openai.ts`
    - Availability: non-OAuth credentials for the selected model provider. It uses the model-registry resolver and explicitly rejects OAuth; it does not borrow `openai-codex` credentials.
    - Querying: sends a non-streaming JSON POST to the selected model's Responses endpoint (`<model.baseUrl>/responses`; the standard OpenAI base URL is `https://api.openai.com/v1`) with hosted `web_search`.
    - Model: catalog `openai`-class GPT-5+ models on the `openai-responses` API declare this grounding, including compatible proxy hosts. Models without catalog grounding are not `web` candidates.
    - A generated answer is rejected unless the response includes an actual `web_search_call`. `usage.searchRequests` counts `search` actions, not `open_page` or `find_in_page`, and is omitted when there are none.
    - `site:` hosts map to `filters.allowed_domains`; other directives are re-emitted in the query. `max_tokens` passes through as `max_output_tokens`. Ignores `recency` and `temperature`.
    - `num_search_results ?? limit` hard-caps parsed sources/citations locally (default `10`, max `100`); answer-cited URLs are collected first, so they survive the cap ahead of merely consulted sources. HTTP failures report OpenAI's structured `type`/`code`/`param`, never the free-form error message (which can echo a masked key).
    - Output may include `answer`, `sources`, `citations`, `searchQueries`, `usage`, `model`, `requestId`, `authMode: "api_key"`.
  - **OpenRouter** — `packages/coding-agent/src/web/search/providers/openrouter.ts`
    - Availability: credentials for the selected model provider.
    - Querying: POST `<model.baseUrl>/chat/completions` with `plugins: [{ id: "web", max_results }]`. `num_search_results` sets `max_results` (default `5`); `limit`, `recency`, `max_tokens`, and `temperature` are not used.
    - Parses answer and URL-citation annotations into sources/citations. Grounded responses without sources/citations are rejected by the orchestrator.
  - **xAI** — `packages/coding-agent/src/web/search/providers/xai.ts`
    - Availability: credentials for the selected model's provider (`xai`, `xai-oauth`, or a compatible host). The role candidate chooses the provider; this adapter does not independently prefer OAuth over API-key models.
    - Querying: POSTs the Responses API with the selected `web` candidate's model id, `tools: [{ type: "web_search", ... }]`, and reasoning effort `low`. A custom model-registry endpoint is supported, but official xAI OAuth credentials are refused for custom endpoints.
    - Up to five `site:` or `-site:` hosts map to mutually exclusive `allowed_domains` / `excluded_domains` filters (allow-list wins); path restrictions remain for central filtering. Absolute dates stay as query hints because the current Responses `web_search` tool has no date fields.
    - The request carries no `search_parameters` (the deprecated Live Search field now returns 410), so `recency` is ignored beyond natural-language date hints in the query text.
    - `max_tokens` and `temperature` pass through. `num_search_results` (or `limit`) only caps parsed sources/citations locally via `clampNumResults(...)`, default `10`, max `30`; it is not sent as an upstream search-count parameter.
    - Output may include `answer`, `sources`, `citations`, `usage`, `model`, `requestId`, `authMode: "api_key" | "oauth"`.
  - **Z.AI** — `packages/coding-agent/src/web/search/providers/zai.ts`
    - Availability: env or `agent.db` credential for `zai`.
    - Querying: JSON-RPC `tools/call` against `https://api.z.ai/api/mcp/web_search_prime/mcp` for remote MCP tool `web_search_prime`.
    - Fallback chain inside the provider: tries `{query,count}`, then `{search_query,count}`, then `{search_query, search_engine:"search-prime", count}` when earlier attempts fail with argument-shape errors.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output may include parsed free-text `answer`, `sources`, `requestId`.
  - **Exa** — `packages/coding-agent/src/web/search/providers/exa.ts`
    - Availability: available unless `exa.enabled=false`. `EXA_API_KEY` or a stored credential for `exa` selects the API; otherwise search uses the public MCP.
    - Querying: POST `https://api.exa.ai/search` with the resolved Exa API key, otherwise JSON-RPC `tools/call` against `https://mcp.exa.ai/mcp` for remote MCP tool `web_search_exa`.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output: synthesized `answer` from up to 3 result summaries, `sources`, `requestId`.
  - **TinyFish** — `packages/coding-agent/src/web/search/providers/tinyfish.ts`
    - Availability: `TINYFISH_API_KEY` or `agent.db` credential for `tinyfish`.
    - Querying: GET `https://api.search.tinyfish.ai` with `X-API-Key` and `query`; `recency` maps to `recency_minutes`.
    - `limit` / `num_search_results`: collapsed, clamped to `1..20`, default `10`; sends `num_results=min(count,10)` per page and paginates from `page=0` through at most `page=10`, stopping on a short page or enough unique URLs, then slices locally. `lang:it-it` maps to `language=it`, `location=IT`. Output `sources`, `authMode: "api_key"`.
  - **Jina** — `packages/coding-agent/src/web/search/providers/jina.ts`
    - Availability: `JINA_API_KEY` or a configured/stored `jina` credential.
    - Querying: GET `https://s.jina.ai/<encoded query>?count=<count>` with bearer auth and JSON/no-content headers. A single `site:` host maps to `X-Site`; multiple sites remain inline.
    - Ignores `recency`, `max_tokens`, and `temperature`.
    - `num_search_results ?? limit` is clamped to `1..20`, default `5`, and caps parsed sources.
    - Output: `sources` only.
  - **Kagi** — `packages/coding-agent/src/web/search/providers/kagi.ts`, `packages/coding-agent/src/web/kagi.ts`
    - Availability: env or `agent.db` credential for `kagi`.
    - Querying: POST `https://kagi.com/api/v1/search` with `Authorization: Bearer <key>` and JSON body `{ query, workflow: "search", limit, filters?: { after } }`. `recency` maps to `filters.after` as a UTC `YYYY-MM-DD` string (`day`/`week`/`month`/`year`).
    - `limit` and `num_search_results` are collapsed together before dispatch, clamped to `1..40`, default `10`.
    - Output: `sources` (concatenated `data.search` + `data.video` + `data.news` + `data.infobox`, with video/news/infobox results tagged in the title), `relatedQuestions` (`data.adjacent_question` + `data.related_search` `props.question`), `answer` (`data.direct_answer[0].snippet ?? title`), `requestId` (`meta.trace`).
  - **Tavily** — `packages/coding-agent/src/web/search/providers/tavily.ts`
    - Availability: `TAVILY_API_KEY` or a configured/stored `tavily` credential through AuthStorage.
    - Querying: POST `https://api.tavily.com/search`.
    - `recency` maps to `time_range` without narrowing to news. Query domain/date filters map to native fields; absolute dates override recency. Empty time-filtered responses retry once without time filters.
    - `num_search_results ?? limit` is clamped to `1..20`, default `5`.
    - Output: `answer`, `sources`, `requestId`, `authMode: "api_key"`.
  - **Firecrawl** — `packages/coding-agent/src/web/search/providers/firecrawl.ts`
    - Availability: always available; uses keyless mode when no credential or self-hosted endpoint resolves.
    - Querying: POST `https://api.firecrawl.dev/v2/search` with `sources: [{ type: "web" }]`. The endpoint is built by the shared resolver in `packages/coding-agent/src/web/firecrawl.ts`, which applies the `FIRECRAWL_BASE_URL` (alias `FIRECRAWL_API_URL`) self-hosting override. Google-style operators are formatted into the query; `recency` and parsed absolute dates map to `tbs`.
    - `limit` / `num_search_results`: collapsed and clamped to `1..100`, default `10`; output `sources`, `requestId`, and `authMode: "api_key" | "keyless"`.
    - The shared client also exposes `/scrape` as a `providers.fetch` reader backend, requiring a Firecrawl credential. API reference: [docs.firecrawl.dev](https://docs.firecrawl.dev).
  - **Brave** — `packages/coding-agent/src/web/search/providers/brave.ts`
    - Availability: `BRAVE_API_KEY` or a configured/stored `brave` credential.
    - Querying: GET `https://api.search.brave.com/res/v1/web/search` with `count`, `extra_snippets=true`, and recency `freshness=pd|pw|pm|py`. Absolute date bounds override recency; safe search defaults to `moderate`. The public tool path does not map `lang:` to Brave's optional language/country fields.
    - `limit` / `num_search_results`: `params.numSearchResults ?? params.limit`, clamped to `1..20`, default `10`.
    - Output: `sources`, `requestId`.
  - **Kimi** — `packages/coding-agent/src/web/search/providers/kimi.ts`
    - Availability: `MOONSHOT_SEARCH_API_KEY`, `KIMI_SEARCH_API_KEY`, or an `agent.db` credential for `kimi-code`. `MOONSHOT_API_KEY` and stored `moonshot` credentials are intentionally rejected because the Open Platform key does not authenticate the Kimi Code search service.
    - Querying: POST to `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` / default `https://api.kimi.com/coding/v1/search` with `text_query`, `limit`, `enable_page_crawling`, `timeout_seconds: 30`.
    - `limit` / `num_search_results`: `params.numSearchResults ?? params.limit`, clamped to `1..20`, default `10`.
    - Output: `sources`, `requestId`.
  - **Parallel** — `packages/coding-agent/src/web/search/providers/parallel.ts`, `packages/coding-agent/src/web/parallel.ts`
    - Availability: always available and first in the automatic chain, using authenticated search when configured and the credential-free MCP otherwise.
    - Querying: authenticated requests POST `https://api.parallel.ai/v1beta/search` with `objective`, one search query, `mode:"fast"`, `excerpts.max_chars_per_result:10000`, and beta header `search-extract-2025-10-10`. Domain filters and `after:`/recency map to `source_policy`; explicit `after:` wins. Keyless requests call `web_search` at `https://search.parallel.ai/mcp`, retaining query operators and a recency-derived date hint. They include session id and the selected search candidate's model id when at most 100 characters, and identify the client as `omp/<version>`.
    - There is no provider fan-out here despite the name; the current adapter always sends a one-element `search_queries` array.
    - `limit` and `num_search_results` are collapsed together before dispatch, clamped to `1..40`, default `10`.
    - Output: `sources`, `requestId`.
  - **Synthetic** — `packages/coding-agent/src/web/search/providers/synthetic.ts`
    - Availability: env or `agent.db` credential for `synthetic`.
    - Querying: POST `https://api.synthetic.new/v2/search` with `{ query }`.
    - Ignores `recency`, `max_tokens`, and `temperature`.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output: `sources` only.
  - **Ollama** — `packages/coding-agent/src/web/search/providers/ollama.ts`
    - Availability: `OLLAMA_CLOUD_API_KEY` env or `agent.db` credential for `ollama-cloud`.
    - Querying: POST `https://ollama.com/api/web_search` with `{ query, max_results }`, `Authorization: Bearer <key>`.
    - Ignores `recency`, `max_tokens`, and `temperature`.
    - `limit` and `num_search_results` are collapsed together before dispatch, clamped to `1..10`, default `5`.
    - Output: `sources` only.
  - **SearXNG** — `packages/coding-agent/src/web/search/providers/searxng.ts`
    - Availability: endpoint from `searxng.endpoint` setting or `SEARXNG_ENDPOINT` env.
    - Querying: GET `<endpoint>/search?format=json&q=...`; settings can select categories, language, engines, and safe search (`0`, `1`, `2`). Engine shortcuts resolve through `/config`; `lang:` overrides the configured language and external bangs are stripped before dispatch.
    - Auth precedence: Basic auth (`searxng.basicUsername` / `searxng.basicPassword` or env equivalents) over bearer token (`searxng.token` / `SEARXNG_TOKEN`). Basic credentials are validated for RFC 7617 restrictions.
    - `recency` maps to `time_range`; `week` is downgraded to `month` because SearXNG does not support week.
    - `limit` and `num_search_results` are collapsed together before dispatch, clamped to `1..20`, default `10`.
    - Output: `sources`, optional `answer` from the instance's answer records, and `relatedQuestions` from `suggestions`. Empty source lists with upstream-engine failures raise a provider error.
  - **DuckDuckGo** — `packages/coding-agent/src/web/search/providers/duckduckgo.ts`
    - Availability: always available; no API key.
    - Querying: POST the no-JS HTML frontend `https://html.duckduckgo.com/html/` with `q`, locale `kl` (default `us-en`; recognized `lang:` locales override it), and optional recency `df=d|w|m|y`; unwraps DuckDuckGo redirect URLs. This path does not escalate to Chromium.
    - `recency` maps to `df`; values outside `day|week|month|year` are ignored.
    - `limit` / `num_search_results`: collapsed and clamped to `1..20`, default `10`; output exposes `sources` only (DuckDuckGo's HTML page does not return a standalone abstract).
    - DuckDuckGo serves a bot-detection challenge (HTTP 200/202 with an `anomaly-modal` body) when it throttles datacenter or shared-egress IPs. The adapter detects this and raises a `SearchProviderError` so the orchestrator can fall through to the next configured provider with a clear cause.
  - **Startpage** — `packages/coding-agent/src/web/search/providers/startpage.ts`
    - Availability: always available; no API key. It proxies Google's index, GETs the homepage to obtain the `sc` anti-bot form token, then POSTs `/sp/search` (with a tokenless GET fallback). `recency` maps to `with_date=d|w|m|y`.
    - Bot/challenge or consent pages raise a provider-tagged `SearchProviderError` (429) so the chain advances.
  - **Google / Ecosia / Mojeek** — `providers/google.ts`, `providers/ecosia.ts`, `providers/mojeek.ts`
    - Availability: always available; no API key. `browserFetch` (`providers/browser-page.ts`) tries a browser-profiled plain fetch first and escalates fetch failures, non-2xx statuses, and challenge bodies to the shared stealth headless browser (`acquireBrowser`); an injected `params.fetch` (tests) never escalates.
    - Google: seeds cookies via the homepage, then loads the rendered SERP; `recency` maps to `tbs=qdr:*`. Ecosia sits behind Cloudflare (hence the browser); its organic results are Google-backed; `recency` is a server-side no-op and silently ignored. Mojeek fronts an ALTCHA proof-of-work wall that the browser path auto-solves; `recency` maps to `since=day|week|month|year`.
    - Challenge pages (Google `unusual traffic`, Ecosia Firewall, Mojeek ALTCHA/robot 403) raise provider-tagged `SearchProviderError`s (429).
  - **Public Web** — `packages/coding-agent/src/web/search/providers/public.ts`
    - Availability: explicit selection only (`isAvailable()` is `false`; `isExplicitlyAvailable()` is `true`).
    - Querying: fans out to the five credential-free engines (`startpage`, `google`, `duckduckgo`, `ecosia`, `mojeek`), then consolidates. URLs are deduplicated on a canonical key (host without `www.`, normalized trailing slash, query preserved, fragment removed), ranked by cross-engine consensus, then best per-engine rank; the longest snippet wins.
    - Deadline race: returns at the earliest of all engines settled, 5s soft deadline with at least one success, or 30s hard cap; stragglers are aborted. Individual engine failures are tolerated; it fails only when every engine fails.

## Side Effects
- Network
  - Calls one or more external search providers over HTTPS until one succeeds or all fail.
  - Provider-specific transports include JSON POST (including OpenAI Responses), JSON GET, SSE streaming (Perplexity OAuth/API, Gemini, Codex), and JSON-RPC over HTTP (Z.AI).
- Subprocesses / native bindings
  - Most HTTP/API adapters spawn nothing. Google, Ecosia, and Mojeek first try a plain fetch, but failed, non-2xx, or challenged production responses can acquire the project-shared broker-owned headless Chromium. Hosts without a CLI worker entry (such as an embedded SDK host) instead launch process-local Chromium.
  - This fallback can start a Chromium process and create its browser-profile lifecycle. On first browser use it can also download Chromium into the omp Puppeteer cache unless a system Chromium or `PUPPETEER_EXECUTABLE_PATH` is available. The search adapter itself uses no native binding.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Uses a module-global provider-instance cache in `packages/coding-agent/src/web/search/provider.ts`.
  - `packages/coding-agent/src/tools/index.ts` gates tool availability behind `cfgWebSearchEnabled.get(session.settings)` (`web_search.enabled`, defined in `packages/coding-agent/src/tools/settings.ts`).
- Background work / cancellation
  - Many provider adapters accept `AbortSignal`; `WebSearchTool.execute()` passes the tool call signal into `executeSearch()`, which forwards it as `params.signal` to providers and rethrows cancellation during fallback.

## Limits & Caps
- Default chain length: 11 selectors (the `web` list in `packages/coding-agent/src/priority.json`).
- `formatForLLM()` truncates source snippets and citation text to 240 chars (`packages/coding-agent/src/web/search/index.ts`).
- `formatForLLM()` emits at most 3 search queries, each truncated to 120 chars (`packages/coding-agent/src/web/search/index.ts`).
- Serper result count: default `10`, max `100` (`DEFAULT_NUM_RESULTS`, `MAX_NUM_RESULTS` in `packages/coding-agent/src/web/search/providers/serper.ts`).
- Brave result count: default `10`, max `20` (`DEFAULT_NUM_RESULTS`, `MAX_NUM_RESULTS` in `packages/coding-agent/src/web/search/providers/brave.ts`).
- TinyFish count: default `10`, max `20`; sends at most `10` results per page, fetching pages `0..10` until enough unique sources or a short page.
- Jina count: default `5`, max `20`; OpenRouter plugin breadth: default `5`.
- DuckDuckGo result count: default `10`, max `20` (`packages/coding-agent/src/web/search/providers/duckduckgo.ts`).
- Startpage / Google / Ecosia / Mojeek result count: default `10`, max `20` (their `providers/*.ts` modules).
- Public Web result count: default `15`, max `30`; fan-out soft deadline `5s`, hard cap `30s` (`packages/coding-agent/src/web/search/providers/public.ts`).
- Tavily result count: default `5`, max `20` (`packages/coding-agent/src/web/search/providers/tavily.ts`).
- Firecrawl result count: default `10`, max `100` (`packages/coding-agent/src/web/search/providers/firecrawl.ts`).
- Kimi result count: default `10`, max `20`; request timeout field fixed to `30` seconds (`packages/coding-agent/src/web/search/providers/kimi.ts`).
- Parallel result count: default `10`, max `40`; per-result excerpt cap `10_000` chars (`packages/coding-agent/src/web/search/providers/parallel.ts`, `packages/coding-agent/src/web/parallel.ts`).
- Kagi result count: default `10`, max `40` (`packages/coding-agent/src/web/search/providers/kagi.ts`).
- SearXNG result count: default `10`, max `20` (`packages/coding-agent/src/web/search/providers/searxng.ts`).
- OpenAI API local sources/citations cap: `num_search_results` before `limit`, default `10`, max `100`; the count is not sent upstream (`packages/coding-agent/src/web/search/providers/openai.ts`).
- xAI local sources/citations cap: `num_search_results` before `limit`, omitted/invalid/zero => default `10`, max `30`; the count is not sent upstream (`packages/coding-agent/src/web/search/providers/xai.ts`).
- Perplexity API-key mode defaults: `max_tokens = 8192`, `temperature = 0.2`, `num_search_results = 20` (`packages/coding-agent/src/web/search/providers/perplexity.ts`).
- Anthropic defaults: `DEFAULT_MAX_TOKENS = 4096` when the provider omits `max_tokens` (`packages/coding-agent/src/web/search/providers/anthropic.ts`).
- Gemini HTTP retries: up to `3` retries, exponential base delay `1000` ms, each retry delay capped at `5 * 60 * 1000` ms; the transport abort signal bounds attempts and delays.

## Errors
- Tool-level no-candidate case returns a normal tool result with `Error: No web search model configured.` (or `No web search model matches selector "<model>".`); it does not throw.
- Tool-level all-failed case also returns a normal tool result with `Error: ...`; the message is either the single normalized provider error or a semicolon-separated summary of all failed providers.
- Provider adapters usually throw `SearchProviderError(provider, message, status)` for HTTP or protocol failures.
- Availability is provider-specific: most credentialed adapters inspect AuthStorage, while keyless engines and explicitly selected Perplexity/Public Web have separate admission rules.
- Per-provider notable failures:
  - Anthropic: missing credentials throw a plain `Error`; a `404` is remapped to a special final message by `formatSearchProviderFailure()`.
  - Perplexity: no admitted auth method raises `SearchProviderError("perplexity", ..., 401)`; ask-stream `error_code` events also become provider errors.
  - Gemini: auth refresh and HTTP retries are internal; exhausted failures surface through the shared provider failure handling.
  - Codex and Gemini both fail if the HTTP response has no body after a `200`.
  - Z.AI treats malformed SSE/JSON-RPC payloads as provider errors and retries only argument-shape failures across request variants.
  - SearXNG `findAuth()` can throw configuration errors before any HTTP call if Basic auth fields are incomplete or invalid.

## Notes
- The model-facing schema does not expose a provider or model; CLI/internal callers can pin one through `SearchQueryParams.model`.
- `executeSearch()` loads provider modules lazily as the chain reaches them. Provider instances are cached per id (`packages/coding-agent/src/web/search/provider.ts`), and asking for labels via `getSearchProviderLabel()` does not trigger imports.
- Most providers treat `limit` and `num_search_results` as the same number because adapters pass `params.numSearchResults ?? params.limit`. Perplexity preserves both concepts. TinyFish uses the collapsed value as a local cap, serializes `num_results` per page, and paginates when more results are needed. xAI uses it only to cap parsed sources/citations (`10` default, `30` max).
- `recency` has native or engine-query mappings in Serper, Brave, Perplexity, Parallel, Tavily, SearXNG, Kagi, TinyFish, Firecrawl, DuckDuckGo, Startpage, Google, and Mojeek. xAI retains absolute query dates as hints but ignores the separate recency field; Ecosia ignores it. Public Web forwards the request to its engines.
- `SEARCH_PROVIDER_LABELS` in `packages/tui/src/tools/web-search-types.ts` is the id→label registry for every search implementation (engines and groundings); provider ids, `SearchResponse`, and the transcript renderer all derive from it. Selection itself lives only in the `web` model role.
- The credential-free scrapers close the auto chain: Startpage and DuckDuckGo precede the browser-backed Ecosia, Google, and Mojeek paths; `public` is listed last and never auto-selected.
- `/login exa` stores the pasted key in AuthStorage; Exa resolves stored or environment credentials before the unauthenticated `https://mcp.exa.ai/mcp` fallback.
