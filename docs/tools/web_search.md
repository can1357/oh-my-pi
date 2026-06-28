# web_search

> Run one web query through the first available search provider and return LLM-formatted answer, source URLs, and optional citations.

## Source
- Entry: `packages/coding-agent/src/web/search/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/web-search.md`
- Key collaborators:
  - `packages/coding-agent/src/web/search/provider.ts` — lazy provider registry; availability chain.
  - `packages/coding-agent/src/web/search/types.ts` — unified `SearchResponse` / `SearchProviderError` types.
  - `packages/coding-agent/src/web/search/render.ts` — TUI renderer details type.
  - `packages/coding-agent/src/web/search/providers/base.ts` — provider interface and shared params contract.
  - `packages/coding-agent/src/web/search/providers/utils.ts` — credential lookup; source normalization.
  - `packages/coding-agent/src/web/search/providers/anthropic.ts` — Claude web-search provider.
  - `packages/coding-agent/src/web/search/providers/brave.ts` — Brave Search API adapter.
  - `packages/coding-agent/src/web/search/providers/codex.ts` — OpenAI Codex SSE adapter.
  - `packages/coding-agent/src/web/search/providers/duckduckgo.ts` — DuckDuckGo Instant Answer API adapter.
  - `packages/coding-agent/src/web/search/providers/exa.ts` — Exa API or MCP adapter.
  - `packages/coding-agent/src/web/search/providers/firecrawl.ts` — Firecrawl search adapter.
  - `packages/coding-agent/src/web/search/providers/gemini.ts` — Gemini grounding SSE adapter.
  - `packages/coding-agent/src/web/search/providers/jina.ts` — Jina Reader search adapter.
  - `packages/coding-agent/src/web/search/providers/kagi.ts` — Kagi provider wrapper.
  - `packages/coding-agent/src/web/search/providers/kimi.ts` — Kimi search adapter.
  - `packages/coding-agent/src/web/search/providers/parallel.ts` — Parallel provider wrapper.
  - `packages/coding-agent/src/web/search/providers/perplexity.ts` — Perplexity API / OAuth adapter.
  - `packages/coding-agent/src/web/search/providers/searxng.ts` — self-hosted SearXNG adapter.
  - `packages/coding-agent/src/web/search/providers/synthetic.ts` — Synthetic search adapter.
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
| `query` | `string` | Yes | Search query, passed to providers unchanged. |
| `recency` | `"day" \| "week" \| "month" \| "year"` | No | Time filter. Only providers that implement it use it; code maps it for Brave, Perplexity, Tavily, SearXNG, Kagi, TinyFish, Firecrawl, and xAI. |
| `limit` | `number` | No | Max results to return. Usually becomes the provider request's result-count parameter when `num_search_results` is absent. TinyFish uses it for paginated fetches before slicing; xAI sends it as `search_parameters.max_search_results` when `num_search_results` is absent and also caps parsed sources/citations locally, defaulting to `10` and max `30`. |
| `max_tokens` | `number` | No | Passed through as provider token caps (`maxOutputTokens`, `max_tokens`, or xAI `max_output_tokens`) only by Anthropic, Gemini, xAI, and Perplexity API-key mode. Ignored by the other providers. |
| `temperature` | `number` | No | Passed through only by Anthropic, Gemini, xAI, and Perplexity API-key mode. Ignored by the other providers. |
| `num_search_results` | `number` | No | Requested search breadth or local result cap. Most providers send it upstream. TinyFish clamps to `1..20` with default `10`, sends it as `num_results` per page, and uses paginated fetches before slicing. xAI sends it as `search_parameters.max_search_results` and caps parsed sources/citations locally with default `10` and max `30`. |

## Outputs
The tool returns a single text content block plus structured `details`.

- `content`: `[{ type: "text", text: string }]`
- `details`: `SearchRenderDetails` from `packages/coding-agent/src/web/search/render.ts`
  - `response: SearchResponse`
  - `error?: string`

`text` is produced by `formatForLLM()` in `packages/coding-agent/src/web/search/index.ts`:

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

## Flow
1. `WebSearchTool.execute()` in `packages/coding-agent/src/web/search/index.ts` delegates directly to `executeSearch()`.
2. `executeSearch()` chooses a provider list:
   - if `params.provider` is set and not `"auto"`, it loads that provider with `getSearchProvider()`; if `isExplicitlyAvailable()` returns true, the list is `[that provider]`, otherwise it falls back to `resolveProviderChain(authStorage, "auto")`.
   - otherwise it calls `resolveProviderChain()` with the module-global preferred provider from `packages/coding-agent/src/web/search/provider.ts`.
3. `resolveProviderChain()` lazily loads each provider module on demand and returns only available providers. If a preferred provider is set, it is tried first (gated by `isExplicitlyAvailable()`), then the static `SEARCH_PROVIDER_ORDER` excluding that provider, each gated by `isAvailable()`. Providers in the excluded set (`setExcludedSearchProviders()`) are skipped entirely, including as the preferred candidate.
4. If no providers are available (for example, after excluding DuckDuckGo and lacking configured keyed/OAuth providers), `executeSearch()` returns `Error: No web search provider configured.` with `details.response.provider = "none"`.
5. For each provider in order, `executeSearch()` calls `provider.search()` with:
   - `query`,
   - `limit`, `recency`, `temperature`, `maxOutputTokens`, `numSearchResults`,
   - `systemPrompt` from `packages/coding-agent/src/prompts/system/web-search.md`.
6. A `SearchResponse` with no renderable content (`hasRenderableSearchContent()` returns false) is rejected as a `SearchProviderError` (status `204`) so the loop advances to the next provider. On the first response that has renderable content, `formatForLLM()` renders answer/sources/citations/related/search-queries into one text block and returns it with `details.response`.
7. If a provider throws, `executeSearch()` records the error and tries the next provider. There is no provider-level parallel fan-out; fallback is sequential.
8. After all candidates fail, `formatProviderError()` normalizes each error:
   - Anthropic `404` becomes `Anthropic web search returned 404 (model or endpoint not found).`
   - `401`/`403` become `<Provider> authorization failed ...` except Z.AI, which preserves its raw message.
   - other `SearchProviderError`s surface `error.message`.
9. If more than one provider was attempted, the final message is `All web search providers failed: <provider/error>; ...`; otherwise it is just the normalized last error.

## Modes / Variants
- **Provider selection**
  - **Forced provider**: internal callers may pass `provider`; unavailable forced providers fall back to the auto chain instead of hard-failing (`packages/coding-agent/src/web/search/index.ts`). This field is not in the model-facing schema.
  - **Preferred provider**: `setPreferredSearchProvider()` sets a module-global default used by `resolveProviderChain()`. `packages/coding-agent/src/sdk.ts` and `packages/coding-agent/src/modes/controllers/selector-controller.ts` wire this from settings.
  - **Excluded providers**: `setExcludedSearchProviders()` records providers `resolveProviderChain()` must never return, including as fallbacks. Wired from the `providers.webSearchExclude` setting (`providers.webSearch` drives the preferred provider) in `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, and `packages/coding-agent/src/modes/controllers/selector-controller.ts`.
  - **Auto chain order** (18 providers): `perplexity`, `gemini`, `anthropic`, `codex`, `xai`, `zai`, `exa`, `tinyfish`, `jina`, `kagi`, `tavily`, `firecrawl`, `brave`, `kimi`, `parallel`, `synthetic`, `searxng`, `duckduckgo` (`SEARCH_PROVIDER_ORDER` in `packages/coding-agent/src/web/search/types.ts`).
- **Provider adapters**
  - **Perplexity** — `packages/coding-agent/src/web/search/providers/perplexity.ts`
    - Availability: auth precedence is `PERPLEXITY_COOKIES` -> OAuth token in `agent.db` -> `PERPLEXITY_API_KEY` / `PPLX_API_KEY` -> anonymous ask-endpoint fallback. `isAvailable()` gates the auto chain on credentials, but `isExplicitlyAvailable()` is always true, so explicit selection works unauthenticated.
    - OAuth/cookie/anonymous mode: POSTs to `https://www.perplexity.ai/rest/sse/perplexity_ask`, consumes SSE, merges partial events, extracts answer and source URLs, sets `authMode: "oauth"` (`"anonymous"` for the unauthenticated fallback).
    - API-key mode: POSTs to `https://api.perplexity.ai/chat/completions` with `model: "sonar-pro"`, `search_mode: "web"`, `num_search_results`, optional `search_recency_filter`, `max_tokens`, `temperature`.
    - `num_search_results` controls upstream API breadth only in API-key mode. `limit` is preserved separately as `num_results` and slices returned `sources` after parsing in both auth modes.
    - Output may include `answer`, `sources`, `citations`, `usage`, `model`, `requestId`, `authMode`.
  - **Gemini** — `packages/coding-agent/src/web/search/providers/gemini.ts`
    - Availability: OAuth credentials in `agent.db` for `google-gemini-cli` or `google-antigravity`.
    - Querying: SSE `streamGenerateContent` call with Google Search grounding enabled. Antigravity auth tries two fallback endpoints and retries `401/403/400 invalid auth` once after token refresh; `429/5xx` retry with exponential backoff and server-provided retry delay, capped by a `5 * 60 * 1000` ms rate-limit budget.
    - `max_tokens` and `temperature` pass through as `generationConfig.maxOutputTokens` / `generationConfig.temperature`.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output may include `answer`, `sources`, `citations`, `searchQueries`, `usage`, `model`.
  - **Anthropic** — `packages/coding-agent/src/web/search/providers/anthropic.ts`
    - Availability: `ANTHROPIC_SEARCH_API_KEY` env var, otherwise `authStorage.hasAuth("anthropic")`; search credentials come from `authStorage.getApiKey("anthropic")` when no search-specific key is set.
    - Env overrides specific to search (do not affect chat completions):
      - `ANTHROPIC_SEARCH_API_KEY` — highest-priority search auth; overrides `ANTHROPIC_API_KEY` / OAuth / `ANTHROPIC_FOUNDRY_API_KEY` for the search call only.
      - `ANTHROPIC_SEARCH_BASE_URL` — search-only base URL for either `ANTHROPIC_SEARCH_API_KEY` or fallback Anthropic credentials; overrides `ANTHROPIC_BASE_URL` (and `FOUNDRY_BASE_URL` in Foundry mode); defaults to `https://api.anthropic.com`.
      - `ANTHROPIC_SEARCH_MODEL` — search model; defaults to `claude-haiku-4-5`.
    - Querying: Claude Messages API with web-search tool enabled.
    - `max_tokens` and `temperature` pass through.
    - `limit` and `num_search_results` are collapsed together before dispatch: `num_results = params.numSearchResults ?? params.limit`.
    - Output may include `answer`, `sources`, `citations`, `searchQueries`, `usage.searchRequests`, `model`, `requestId`.
  - **Codex** — `packages/coding-agent/src/web/search/providers/codex.ts`
    - Availability: OAuth credential for `openai-codex` in `agent.db` (`hasOAuth()`; expiry is not checked here — refresh is lazy in `searchCodex`).
    - Querying: SSE POST to `https://chatgpt.com/backend-api/codex/responses` with `tool_choice: { type: "web_search" }` and `search_context_size: "high"` by default.
    - Ignores `recency`, `max_tokens`, and `temperature` in this tool path.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output may include `answer`, `sources`, `usage`, `model`, `requestId`. If the streamed response has no `url_citation` annotations, the adapter falls back to scraping markdown links and bare URLs from the answer text.
  - **xAI** — `packages/coding-agent/src/web/search/providers/xai.ts`
    - Availability: `XAI_API_KEY` or `agent.db` credential for `xai`.
    - Querying: POST `https://api.x.ai/v1/responses` with model `grok-4.3` and `tools: [{ type: "web_search" }]` using the `/v1/responses` Agent Tools API.
    - `max_tokens` and `temperature` pass through. `recency` is sent as `search_parameters.from_date`/`to_date`; `num_search_results` (or `limit` when absent) is sent as `search_parameters.max_search_results`. Because xAI citations may include every encountered URL, the adapter also locally caps returned `sources` and `citations` after parsing. The local cap uses `num_search_results` before `limit`, defaults to `10` when omitted/invalid/zero, and is capped at `30`.
    - Output may include `answer`, `sources`, `citations`, `usage`, `model`, `requestId`, `authMode: "api_key"`.
  - **Z.AI** — `packages/coding-agent/src/web/search/providers/zai.ts`
    - Availability: env or `agent.db` credential for `zai`.
    - Querying: JSON-RPC `tools/call` against `https://api.z.ai/api/mcp/web_search_prime/mcp` for remote MCP tool `web_search_prime`.
    - Fallback chain inside the provider: tries `{query,count}`, then `{search_query,count}`, then `{search_query, search_engine:"search-prime", count}` when earlier attempts fail with argument-shape errors.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output may include parsed free-text `answer`, `sources`, `requestId`.
  - **Exa** — `packages/coding-agent/src/web/search/providers/exa.ts`
    - Availability: env or `agent.db` credential for `exa` admits Exa to the auto chain; settings must not explicitly disable `exa.enabled` or `exa.enableSearch`. Explicit selection (`providers.webSearch: exa`) reaches Exa even without a credential and falls back to public MCP.
    - Querying: POST `https://api.exa.ai/search` with the resolved Exa API key, otherwise JSON-RPC `tools/call` against `https://mcp.exa.ai/mcp` for remote MCP tool `web_search_exa`.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output: synthesized `answer` from up to 3 result summaries, `sources`, `requestId`.
  - **TinyFish** — `packages/coding-agent/src/web/search/providers/tinyfish.ts`
    - Availability: `TINYFISH_API_KEY` or `agent.db` credential for `tinyfish`.
    - Querying: GET `https://api.search.tinyfish.ai` with `X-API-Key` and `query`; `recency` maps to `recency_minutes`.
    - `limit` / `num_search_results`: collapsed as `params.numSearchResults ?? params.limit`, clamped to `1..20`, default `10`. TinyFish has no count parameter and returns at most 10 results per page; for counts above the first page, the adapter fetches documented `page` values (`0`, then `1` when needed) before slicing locally. Output `sources`, `authMode: "api_key"`.
  - **Jina** — `packages/coding-agent/src/web/search/providers/jina.ts`
    - Availability: `JINA_API_KEY` only.
    - Querying: GET-like fetch to `https://s.jina.ai/<encoded query>` with bearer auth.
    - Ignores `recency`, `max_tokens`, and `temperature`.
    - `limit` / `num_search_results`: adapter slices sources to `params.numSearchResults ?? params.limit` when provided; otherwise returns all payload items.
    - Output: `sources` only.
  - **Kagi** — `packages/coding-agent/src/web/search/providers/kagi.ts`, `packages/coding-agent/src/web/kagi.ts`
    - Availability: env or `agent.db` credential for `kagi`.
    - Querying: POST `https://kagi.com/api/v1/search` with `Authorization: Bearer <key>` and JSON body `{ query, workflow: "search", limit, filters?: { after } }`. `recency` maps to `filters.after` as a UTC `YYYY-MM-DD` string (`day`/`week`/`month`/`year`).
    - `limit` and `num_search_results` are collapsed together before dispatch, clamped to `1..40`, default `10`.
    - Output: `sources` (concatenated `data.search` + `data.video` + `data.news` + `data.infobox`, with video/news/infobox results tagged in the title), `relatedQuestions` (`data.adjacent_question` + `data.related_search` `props.question`), `answer` (`data.direct_answer[0].snippet ?? title`), `requestId` (`meta.trace`).
  - **Tavily** — `packages/coding-agent/src/web/search/providers/tavily.ts`
    - Availability: API key from env or `agent.db` via `findCredential()`.
    - Querying: POST `https://api.tavily.com/search`.
    - `recency` maps to Tavily `time_range`; code explicitly keeps `topic` at default general scope instead of narrowing to news.
    - `limit` / `num_search_results`: adapter uses `params.numSearchResults ?? params.limit`, clamped to `5..20` with default `5`.
    - Output: `answer`, `sources`, `requestId`, `authMode: "api_key"`.
  - **Firecrawl** — `packages/coding-agent/src/web/search/providers/firecrawl.ts`
    - Availability: `FIRECRAWL_API_KEY` or `agent.db` credential for `firecrawl`.
    - Querying: POST `https://api.firecrawl.dev/v2/search` with `sources: [{ type: "web" }]`; `recency` maps to Google-style `tbs`.
    - `limit` / `num_search_results`: collapsed and clamped to `1..100`, default `10`; output `sources`, `requestId`, `authMode: "api_key"`.
  - **Brave** — `packages/coding-agent/src/web/search/providers/brave.ts`
    - Availability: `BRAVE_API_KEY` only.
    - Querying: GET `https://api.search.brave.com/res/v1/web/search` with `count`, `extra_snippets=true`, and `freshness=pd|pw|pm|py` for `recency`.
    - `limit` / `num_search_results`: `params.numSearchResults ?? params.limit`, clamped to `1..20`, default `10`.
    - Output: `sources`, `requestId`.
  - **Kimi** — `packages/coding-agent/src/web/search/providers/kimi.ts`
    - Availability: `MOONSHOT_SEARCH_API_KEY`, `KIMI_SEARCH_API_KEY`, `MOONSHOT_API_KEY`, or `agent.db` credentials for `moonshot` / `kimi-code`.
    - Querying: POST to `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` / default `https://api.kimi.com/coding/v1/search` with `text_query`, `limit`, `enable_page_crawling`, `timeout_seconds: 30`.
    - `limit` / `num_search_results`: `params.numSearchResults ?? params.limit`, clamped to `1..20`, default `10`.
    - Output: `sources`, `requestId`.
  - **Parallel** — `packages/coding-agent/src/web/search/providers/parallel.ts`, `packages/coding-agent/src/web/parallel.ts`
    - Availability: env or `agent.db` credential for `parallel`.
    - Querying: POST `https://api.parallel.ai/v1beta/search` with `objective=query`, `search_queries=[query]`, `mode:"fast"`, `max_chars_per_result: 10000`, beta header `search-extract-2025-10-10`.
    - There is no provider fan-out here despite the name; the current adapter always sends a one-element `search_queries` array.
    - `limit` and `num_search_results` are collapsed together before dispatch, clamped to `1..40`, default `10`.
    - Output: `sources`, `requestId`.
  - **Synthetic** — `packages/coding-agent/src/web/search/providers/synthetic.ts`
    - Availability: env or `agent.db` credential for `synthetic`.
    - Querying: POST `https://api.synthetic.new/v2/search` with `{ query }`.
    - Ignores `recency`, `max_tokens`, and `temperature`.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output: `sources` only.
  - **SearXNG** — `packages/coding-agent/src/web/search/providers/searxng.ts`
    - Availability: endpoint from `searxng.endpoint` setting or `SEARXNG_ENDPOINT` env.
    - Querying: GET `<endpoint>/search?format=json&q=...`; optional settings add `categories` and `language`.
    - Auth precedence: Basic auth (`searxng.basicUsername` / `searxng.basicPassword` or env equivalents) over bearer token (`searxng.token` / `SEARXNG_TOKEN`). Basic credentials are validated for RFC 7617 restrictions.
    - `recency` maps to `time_range`; `week` is downgraded to `month` because SearXNG does not support week.
    - `limit` and `num_search_results` are collapsed together before dispatch, clamped to `1..20`, default `10`.
    - Output: `sources`, `relatedQuestions` from `suggestions`.
  - **DuckDuckGo** — `packages/coding-agent/src/web/search/providers/duckduckgo.ts`
    - Availability: always available; no API key.
    - Querying: GET official Instant Answer API `https://api.duckduckgo.com/` with JSON/no-HTML flags; no scraped HTML.
    - `limit` / `num_search_results`: collapsed and clamped to `1..20`, default `10`; output may include `answer` and `sources` from abstracts/results/topics.

## Side Effects
- Network
  - Calls one or more external search providers over HTTPS until one succeeds or all fail.
  - Provider-specific transports include JSON POST, JSON GET, SSE streaming (Perplexity OAuth/API, Gemini, Codex), and JSON-RPC over HTTP (Z.AI).
- Subprocesses / native bindings
  - None.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Uses a module-global provider-instance cache in `packages/coding-agent/src/web/search/provider.ts`.
  - Uses a module-global preferred-provider setting in the same file.
  - `packages/coding-agent/src/tools/index.ts` gates tool availability behind `session.settings.get("web_search.enabled")`.
- Background work / cancellation
  - Many provider adapters accept `AbortSignal`; `WebSearchTool.execute()` passes the tool call signal into `executeSearch()`, which forwards it as `params.signal` to providers and rethrows cancellation during fallback.

## Limits & Caps
- Provider auto-order length: 18 providers (`SEARCH_PROVIDER_ORDER` in `packages/coding-agent/src/web/search/types.ts`).
- `formatForLLM()` truncates source snippets and citation text to 240 chars (`packages/coding-agent/src/web/search/index.ts`).
- `formatForLLM()` emits at most 3 search queries, each truncated to 120 chars (`packages/coding-agent/src/web/search/index.ts`).
- Brave result count: default `10`, max `20` (`DEFAULT_NUM_RESULTS`, `MAX_NUM_RESULTS` in `packages/coding-agent/src/web/search/providers/brave.ts`).
- TinyFish local result count: default `10`, max `20`; the API has no count parameter and returns at most 10 results per page, so the adapter fetches documented pages (`page=0`, then `page=1` when needed) and slices locally (`packages/coding-agent/src/web/search/providers/tinyfish.ts`).
- DuckDuckGo result count: default `10`, max `20` (`packages/coding-agent/src/web/search/providers/duckduckgo.ts`).
- Tavily result count: default `5`, max `20` (`packages/coding-agent/src/web/search/providers/tavily.ts`).
- Firecrawl result count: default `10`, max `100` (`packages/coding-agent/src/web/search/providers/firecrawl.ts`).
- Kimi result count: default `10`, max `20`; request timeout field fixed to `30` seconds (`packages/coding-agent/src/web/search/providers/kimi.ts`).
- Parallel result count: default `10`, max `40`; per-result excerpt cap `10_000` chars (`packages/coding-agent/src/web/search/providers/parallel.ts`, `packages/coding-agent/src/web/parallel.ts`).
- Kagi result count: default `10`, max `40` (`packages/coding-agent/src/web/search/providers/kagi.ts`).
- SearXNG result count: default `10`, max `20` (`packages/coding-agent/src/web/search/providers/searxng.ts`).
- xAI local sources/citations cap and upstream `max_search_results`: `num_search_results` before `limit`, omitted/invalid/zero => local default `10`, max `30` (`packages/coding-agent/src/web/search/providers/xai.ts`).
- Perplexity API-key mode defaults: `max_tokens = 8192`, `temperature = 0.2`, `num_search_results = 20` (`packages/coding-agent/src/web/search/providers/perplexity.ts`).
- Anthropic defaults: model `claude-haiku-4-5`, `DEFAULT_MAX_TOKENS = 4096` when the provider omits `max_tokens` (`packages/coding-agent/src/web/search/providers/anthropic.ts`).
- Gemini retries: up to `3` retries per endpoint, base delay `1000` ms, rate-limit delay budget `5 * 60 * 1000` ms (`packages/coding-agent/src/web/search/providers/gemini.ts`).

## Errors
- Tool-level no-provider case returns a normal tool result with `Error: No web search provider configured.`; it does not throw.
- Tool-level all-failed case also returns a normal tool result with `Error: ...`; the message is either the single normalized provider error or a semicolon-separated summary of all failed providers.
- Provider adapters usually throw `SearchProviderError(provider, message, status)` for HTTP or protocol failures.
- Availability probes intentionally swallow lookup errors and report `false` in many providers via `isApiKeyAvailable()`.
- Per-provider notable failures:
  - Anthropic: missing credentials throw a plain `Error`; a `404` is remapped to a special final message by `formatProviderError()`.
  - Perplexity: missing auth throws a plain `Error`; OAuth stream `error_code` events become `SearchProviderError("perplexity", ...)`.
  - Gemini: auth refresh, endpoint fallback, and retry logic are internal; final exhausted failures surface as `SearchProviderError("gemini", ...)`.
  - Codex and Gemini both fail if the HTTP response has no body after a `200`.
  - Z.AI treats malformed SSE/JSON-RPC payloads as provider errors and retries only argument-shape failures across request variants.
  - SearXNG `findAuth()` can throw configuration errors before any HTTP call if Basic auth fields are incomplete or invalid.

## Notes
- The model-facing schema does not expose `provider`, but internal callers can force one through `SearchQueryParams`.
- `resolveProviderChain()` lazily imports provider modules and caches singleton instances. Just asking for labels via `getSearchProviderLabel()` does not trigger those imports.
- Most providers treat `limit` and `num_search_results` as the same number because adapters pass `params.numSearchResults ?? params.limit`. Perplexity preserves both concepts. TinyFish uses the collapsed value as a local cap, serializes `num_results` per page, and paginates with `page` when more results are needed. xAI sends that collapsed value as `search_parameters.max_search_results` and applies the same precedence locally after parsing to cap returned sources/citations (`10` default, `30` max).
- `recency` is implemented by Brave, Perplexity, Tavily, SearXNG, Kagi, TinyFish, Firecrawl, and xAI. The model-facing prompt does not name specific providers.
- `packages/coding-agent/src/config/settings-schema.ts` uses the shared `SEARCH_PROVIDER_PREFERENCES` / `SEARCH_PROVIDER_OPTIONS` metadata, so the settings selector and setup wizard expose `auto` plus every provider in the auto chain.
- DuckDuckGo is intentionally last in the auto chain because it is always available without credentials.
- Exa uses `authStorage.getApiKey("exa")`, then `EXA_API_KEY`, then unauthenticated `https://mcp.exa.ai/mcp` fallback.
