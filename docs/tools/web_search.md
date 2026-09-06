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
  - `packages/coding-agent/src/web/search/providers/browser-headers.ts` — shared Chromium navigation headers for scrape providers.
  - `packages/coding-agent/src/web/search/query.ts` — Google-style query parsing, provider syntax formatting, and lenient result filtering.
  - `packages/coding-agent/src/web/search/providers/browser-page.ts` — shared fetch/headless-browser page loader for scrape providers.
  - `packages/coding-agent/src/web/search/providers/anthropic.ts` — Claude web-search provider.
  - `packages/coding-agent/src/web/search/providers/brave.ts` — Brave Search API adapter.
  - `packages/coding-agent/src/web/search/providers/codex.ts` — OpenAI Codex SSE adapter.
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
  - `packages/coding-agent/src/web/search/providers/searxng.ts` — self-hosted SearXNG adapter.
  - `packages/coding-agent/src/web/search/providers/startpage.ts` — Startpage (Google-proxied) form-flow scraper.
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
| `query` | `string` | Yes | Raw query. The orchestrator parses Google-style directives (`site:`/`-site:`, `after:`/`before:`, `inurl:`, `intitle:`, `filetype:`, quoted phrases, exclusions, and `OR`) so providers can map them to native filters or supported syntax; the original string remains available to adapters. |
| `recency` | `"day" \| "week" \| "month" \| "year"` | No | Relative time filter. Implemented by Brave, Perplexity, Tavily, SearXNG, Kagi, TinyFish, Firecrawl, DuckDuckGo, Startpage, Google, and Mojeek; other adapters ignore it. |
| `limit` | `number` | No | Max results to return. Usually becomes the provider request's result-count parameter when `num_search_results` is absent. TinyFish uses it for paginated fetches before slicing. xAI uses the collapsed value only as a local cap on parsed sources/citations, defaulting to `10` and max `30`. |
| `max_tokens` | `number` | No | Passed through as provider token caps (`maxOutputTokens`, `max_tokens`, or xAI `max_output_tokens`) only by Anthropic, Gemini, xAI, and Perplexity API-key mode. Ignored by the other providers. |
| `temperature` | `number` | No | Passed through only by Anthropic models that support sampling parameters, Gemini, xAI, and Perplexity API-key mode. Ignored or omitted by the other provider/model paths. |
| `num_search_results` | `number` | No | Requested search breadth or local result cap. Most providers send it upstream. TinyFish clamps to `1..20` with default `10`, sends it as `num_results` per page, and paginates before slicing. xAI uses it before `limit` as a local parsed-result cap, defaulting to `10` and max `30`; the current Responses `web_search` tool has no upstream result-count field. |

## Outputs
The tool returns a single text content block plus structured `details`.

- `content`: `[{ type: "text", text: string }]`
- `details`: `SearchRenderDetails` from `packages/coding-agent/src/web/search/render.ts`
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
2. `executeSearch()` parses `query` once with `parseSearchQuery()`, then computes ordered provider candidates without eagerly loading their modules:
   - if internal `params.provider` is set and not `"auto"`, that provider is the only candidate and is treated as explicit;
   - otherwise it uses the configured candidate order. Entries explicitly listed in `providers.webSearchOrder` use `isExplicitlyAvailable()`; ordinary fallback entries use `isAvailable()`.
3. `resolveProviderCandidates()` prioritizes valid first-occurrence IDs from `providers.webSearchOrder`, then appends unlisted providers in `SEARCH_PROVIDER_ORDER`. An empty list preserves built-in order. `providers.webSearchExclude` removes providers from the automatic/configured chain and from Public Web fan-out. Internal per-request forced providers bypass that configured chain.
4. If no candidate is available (for example, settings exclude every credential-free engine and no keyed/OAuth provider is configured), `executeSearch()` returns `Error: No web search provider configured.` with `details.response.provider = "none"`.
5. For each provider in order, `executeSearch()` calls `provider.search()` with:
   - `query`,
   - `limit`, `recency`, `temperature`, `maxOutputTokens`, `numSearchResults`,
   - `timeoutMs`, derived from `providers.webSearchTimeoutSeconds`,
   - `systemPrompt` from `packages/coding-agent/src/prompts/system/web-search.md`,
   - the parsed structured query, including recognized directives and date/domain/title/URL/filetype constraints.
6. After a provider responds, `applyQueryConstraints()` leniently post-filters its sources for constraints not guaranteed upstream. It applies each filterable dimension in turn; any dimension that would eliminate every remaining result is relaxed and a leading `Note: no results matched ...` is emitted. Answer/citation text is not rewritten.
7. A `SearchResponse` with no renderable content (`hasRenderableSearchContent()` returns false) is rejected as a `SearchProviderError` (status `204`) so the loop advances to the next provider. On the first renderable response, `formatForLLM()` renders notes, answer, sources, citations, related questions, and search queries into one text block.
8. If a provider throws, `executeSearch()` records the error and tries the next provider. There is no provider-level parallel fan-out; fallback is sequential.
9. After all candidates fail, `formatSearchProviderFailure()` normalizes each error:
   - Anthropic `404` becomes `Anthropic web search returned 404 (model or endpoint not found).`
   - `401`/`403` become `<Provider> authorization failed ...` except Z.AI, which preserves its raw message.
   - other `SearchProviderError`s surface `error.message`.
10. If more than one provider failed, the final message is `All web search providers failed: <provider/error>; ...`; otherwise it is just the normalized last error.

## Modes / Variants
- **Provider selection**
  - **Forced provider**: internal callers may pass `provider`; a non-`auto` value is the only attempted provider and uses `isExplicitlyAvailable()`, while `auto` (or omitting it) walks the configured chain. This field is not in the model-facing schema.
  - **Configured order**: `setSearchProviderOrder()` prioritizes valid, first-occurrence provider IDs in `providers.webSearchOrder`; omitted providers follow in built-in relative order. Listed providers are explicit selections and resolve through `isExplicitlyAvailable()`, so Perplexity, Exa, and Firecrawl can use their unauthenticated/keyless paths.
  - **Excluded providers**: `setExcludedSearchProviders()` removes providers from the automatic/configured chain and Public Web fan-out. Wired from `providers.webSearchExclude` through `packages/coding-agent/src/config/provider-globals.ts`.
  - **Default auto chain order** (23 providers): `perplexity`, `gemini`, `anthropic`, `codex`, `xai`, `zai`, `exa`, `tinyfish`, `jina`, `kagi`, `tavily`, `firecrawl`, `brave`, `kimi`, `parallel`, `synthetic`, `searxng`, `startpage`, `duckduckgo`, `ecosia`, `google`, `mojeek`, `public` (`SEARCH_PROVIDER_ORDER` in `packages/coding-agent/src/web/search/types.ts`). `public` is explicit-only: its `isAvailable()` returns `false`, so the auto chain never fans out implicitly.
- **Provider timeout**: `providers.webSearchTimeoutSeconds` supplies the hard ceiling for each provider's search transport before the automatic chain advances. It defaults to `60`; invalid non-positive values fall back to that default and values above `300` are capped, while provider-specific upstream or aggregate limits may still be shorter.
- **Provider adapters**
  - **Perplexity** — `packages/coding-agent/src/web/search/providers/perplexity.ts`
    - Availability: auth attempt order is `PERPLEXITY_COOKIES` -> OAuth token in `agent.db` -> direct Perplexity API key -> OpenRouter key -> anonymous ask-endpoint fallback. The automatic chain requires direct Perplexity auth (cookies, OAuth, or a Perplexity credential); explicit selection is always available and can use OpenRouter or anonymous search.
    - OAuth/cookie/anonymous mode: POSTs to `https://www.perplexity.ai/rest/sse/perplexity_ask`, consumes SSE, merges partial events, extracts answer and source URLs, sets `authMode: "oauth"` (`"anonymous"` for the unauthenticated fallback).
    - API-key mode: POSTs to `https://api.perplexity.ai/chat/completions` with `model: "sonar-pro"`, `search_mode: "web"`, `num_search_results`, optional `search_recency_filter`, `max_tokens`, `temperature`.
    - `num_search_results` controls upstream API breadth only in API-key mode. `limit` is preserved separately as `num_results` and slices returned `sources` after parsing in both auth modes.
    - Output may include `answer`, `sources`, `citations`, `usage`, `model`, `requestId`, `authMode`.
  - **Gemini** — `packages/coding-agent/src/web/search/providers/gemini.ts`
    - Availability: OAuth credentials in `agent.db` for `google-gemini-cli` / `google-antigravity`, or a Google Developer API key.
    - Querying: SSE `streamGenerateContent` call with Google Search grounding enabled. Antigravity auth tries two fallback endpoints and retries `401/403/400 invalid auth` once after token refresh; `429/5xx` retry with exponential backoff and server-provided retry delay, capped by a `5 * 60 * 1000` ms rate-limit budget.
    - Model: `providers.webSearchGeminiModel` selects the Gemini grounding model; `GEMINI_SEARCH_MODEL` overrides it. Defaults to `gemini-2.5-flash`.
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
    - `max_tokens` passes through. `temperature` passes through only for models that support sampling parameters; it is omitted for Opus 4.7+, Sonnet 5+, and Fable/Mythos 5+ because those APIs reject sampling parameters.
    - `limit` and `num_search_results` are collapsed together before dispatch: `num_results = params.numSearchResults ?? params.limit`.
    - Output may include `answer`, `sources`, `citations`, `searchQueries`, `usage.searchRequests`, `model`, `requestId`.
  - **Codex** — `packages/coding-agent/src/web/search/providers/codex.ts`
    - Availability: OAuth credential for `openai-codex` in `agent.db`; refresh is lazy during search. Custom model-registry endpoints may instead use a configured API-key/command credential, but official OAuth/env credentials are refused for custom endpoints.
    - Querying: streams the Codex Responses endpoint with hosted `web_search` and `search_context_size: "high"`. Google-style directives are re-emitted in the query.
    - `PI_CODEX_WEB_SEARCH_MODEL` forces one model attempt. Otherwise the adapter tries bundled ChatGPT-account-safe models in preference order (`gpt-5.6-luna`, `terra`, `sol`, `gpt-5.5`, …), advancing only for supported model-retry failures. Responses-Lite models use automatic tool choice; a completion without a `web_search_call` is rejected rather than presented as searched content.
    - Ignores `recency`, `max_tokens`, and `temperature`. `num_search_results ?? limit` slices parsed sources locally.
    - Output may include `answer`, `sources`, `usage`, `model`, `requestId`. If the stream has no `url_citation` annotations, the adapter falls back to markdown links and bare URLs from the answer.
  - **xAI** — `packages/coding-agent/src/web/search/providers/xai.ts`
    - Availability: `shouldPreferXAIOAuth()` prefers the `xai-oauth` credential — true when `XAI_OAUTH_TOKEN` is set or a stored `xai-oauth` credential exists whose origin would not be shadowed by a shared `XAI_API_KEY` env key — otherwise `authStorage.hasAuth("xai")` (`XAI_API_KEY` env or `agent.db` credential for `xai`).
    - Querying: POSTs the Responses API with model `grok-4.5`, `tools: [{ type: "web_search", ... }]`, and reasoning effort `low`. A custom model-registry endpoint is supported, but official xAI OAuth credentials are refused for custom endpoints.
    - Up to five `site:` or `-site:` hosts map to mutually exclusive `allowed_domains` / `excluded_domains` filters (allow-list wins); path restrictions remain for central filtering. Absolute dates stay as query hints because the current Responses `web_search` tool has no date fields.
    - The request carries no `search_parameters` (the deprecated Live Search field now returns 410), so `recency` is ignored beyond natural-language date hints in the query text.
    - `max_tokens` and `temperature` pass through. `num_search_results` (or `limit`) only caps parsed sources/citations locally via `clampNumResults(...)`, default `10`, max `30`; it is not sent as an upstream search-count parameter.
    - Output may include `answer`, `sources`, `citations`, `usage`, `model`, `requestId`, `authMode: "api_key"`.
  - **Z.AI** — `packages/coding-agent/src/web/search/providers/zai.ts`
    - Availability: env or `agent.db` credential for `zai`.
    - Querying: JSON-RPC `tools/call` against `https://api.z.ai/api/mcp/web_search_prime/mcp` for remote MCP tool `web_search_prime`.
    - Fallback chain inside the provider: tries `{query,count}`, then `{search_query,count}`, then `{search_query, search_engine:"search-prime", count}` when earlier attempts fail with argument-shape errors.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output may include parsed free-text `answer`, `sources`, `requestId`.
  - **Exa** — `packages/coding-agent/src/web/search/providers/exa.ts`
    - Availability: `EXA_API_KEY` or a stored credential for `exa` (including one added through `/login exa`) admits Exa to the auto chain; settings must not explicitly disable `exa.enabled` or `exa.enableSearch`. Explicit selection (listing `exa` in `providers.webSearchOrder`, or a forced `provider: exa`) reaches Exa even without a credential and falls back to public MCP.
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
    - Availability: credentials admit it to the automatic chain; explicit/configured selection is always available and uses keyless mode when no credential resolves.
    - Querying: POST `https://api.firecrawl.dev/v2/search` with `sources: [{ type: "web" }]`. Google-style operators are formatted into the query; `recency` and parsed absolute dates map to `tbs`.
    - `limit` / `num_search_results`: collapsed and clamped to `1..100`, default `10`; output `sources`, `requestId`, and `authMode: "api_key" | "keyless"`.
  - **Brave** — `packages/coding-agent/src/web/search/providers/brave.ts`
    - Availability: `BRAVE_API_KEY` only.
    - Querying: GET `https://api.search.brave.com/res/v1/web/search` with `count`, `extra_snippets=true`, and `freshness=pd|pw|pm|py` for `recency`.
    - `limit` / `num_search_results`: `params.numSearchResults ?? params.limit`, clamped to `1..20`, default `10`.
    - Output: `sources`, `requestId`.
  - **Kimi** — `packages/coding-agent/src/web/search/providers/kimi.ts`
    - Availability: `MOONSHOT_SEARCH_API_KEY`, `KIMI_SEARCH_API_KEY`, or an `agent.db` credential for `kimi-code`. `MOONSHOT_API_KEY` and stored `moonshot` credentials are intentionally rejected because the Open Platform key does not authenticate the Kimi Code search service.
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
    - Querying: POST the no-JS HTML frontend `https://html.duckduckgo.com/html/` with `q`, `kl=us-en`, and an optional `df` recency filter (`d`/`w`/`m`/`y`); parses the result list and unwraps `//duckduckgo.com/l/?uddg=…` redirect URLs.
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
    - Querying: fans out to the five credential-free engines (`startpage`, `google`, `duckduckgo`, `ecosia`, `mojeek`, minus excluded ones), then consolidates. URLs are deduplicated on a canonical key (host without `www.`, normalized trailing slash, query preserved, fragment removed), ranked by cross-engine consensus, then best per-engine rank; the longest snippet wins.
    - Deadline race: returns at the earliest of all engines settled, 5s soft deadline with at least one success, or 30s hard cap; stragglers are aborted. Individual engine failures are tolerated; it fails only when every engine fails.

## Side Effects
- Network
  - Calls one or more external search providers over HTTPS until one succeeds or all fail.
  - Provider-specific transports include JSON POST, JSON GET, SSE streaming (Perplexity OAuth/API, Gemini, Codex), and JSON-RPC over HTTP (Z.AI).
- Subprocesses / native bindings
  - Most HTTP/API adapters spawn nothing. Google, Ecosia, and Mojeek first try a plain fetch, but failed, non-2xx, or challenged production responses can acquire the project-shared broker-owned headless Chromium. Hosts without a CLI worker entry (such as an embedded SDK host) instead launch process-local Chromium.
  - This fallback can start a Chromium process and create its browser-profile lifecycle. On first browser use it can also download Chromium into the omp Puppeteer cache unless a system Chromium or `PUPPETEER_EXECUTABLE_PATH` is available. The search adapter itself uses no native binding.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Uses a module-global provider-instance cache in `packages/coding-agent/src/web/search/provider.ts`.
  - Uses a module-global preferred-provider setting in the same file.
  - `packages/coding-agent/src/tools/index.ts` gates tool availability behind `session.settings.get("web_search.enabled")`.
- Background work / cancellation
  - Many provider adapters accept `AbortSignal`; `WebSearchTool.execute()` passes the tool call signal into `executeSearch()`, which forwards it as `params.signal` to providers and rethrows cancellation during fallback.

## Limits & Caps
- Provider auto-order length: 23 providers (`SEARCH_PROVIDER_ORDER` in `packages/coding-agent/src/web/search/types.ts`).
- `formatForLLM()` truncates source snippets and citation text to 240 chars (`packages/coding-agent/src/web/search/index.ts`).
- `formatForLLM()` emits at most 3 search queries, each truncated to 120 chars (`packages/coding-agent/src/web/search/index.ts`).
- Brave result count: default `10`, max `20` (`DEFAULT_NUM_RESULTS`, `MAX_NUM_RESULTS` in `packages/coding-agent/src/web/search/providers/brave.ts`).
- TinyFish local result count: default `10`, max `20`; the API has no count parameter and returns at most 10 results per page, so the adapter fetches documented pages (`page=0`, then `page=1` when needed) and slices locally (`packages/coding-agent/src/web/search/providers/tinyfish.ts`).
- DuckDuckGo result count: default `10`, max `20` (`packages/coding-agent/src/web/search/providers/duckduckgo.ts`).
- Startpage / Google / Ecosia / Mojeek result count: default `10`, max `20` (their `providers/*.ts` modules).
- Public Web result count: default `15`, max `30`; fan-out soft deadline `5s`, hard cap `30s` (`packages/coding-agent/src/web/search/providers/public.ts`).
- Tavily result count: default `5`, max `20` (`packages/coding-agent/src/web/search/providers/tavily.ts`).
- Firecrawl result count: default `10`, max `100` (`packages/coding-agent/src/web/search/providers/firecrawl.ts`).
- Kimi result count: default `10`, max `20`; request timeout field fixed to `30` seconds (`packages/coding-agent/src/web/search/providers/kimi.ts`).
- Parallel result count: default `10`, max `40`; per-result excerpt cap `10_000` chars (`packages/coding-agent/src/web/search/providers/parallel.ts`, `packages/coding-agent/src/web/parallel.ts`).
- Kagi result count: default `10`, max `40` (`packages/coding-agent/src/web/search/providers/kagi.ts`).
- SearXNG result count: default `10`, max `20` (`packages/coding-agent/src/web/search/providers/searxng.ts`).
- xAI local sources/citations cap: `num_search_results` before `limit`, omitted/invalid/zero => default `10`, max `30`; the count is not sent upstream (`packages/coding-agent/src/web/search/providers/xai.ts`).
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
- `executeSearch()` walks `resolveProviderCandidates()` lazily; `resolveProviderChain()` remains a compatibility helper that loads every candidate. Provider instances are cached, and asking for labels via `getSearchProviderLabel()` does not trigger imports.
- Most providers treat `limit` and `num_search_results` as the same number because adapters pass `params.numSearchResults ?? params.limit`. Perplexity preserves both concepts. TinyFish uses the collapsed value as a local cap, serializes `num_results` per page, and paginates when more results are needed. xAI uses it only to cap parsed sources/citations (`10` default, `30` max).
- `recency` has native or engine-query mappings in Brave, Perplexity, Tavily, SearXNG, Kagi, TinyFish, Firecrawl, DuckDuckGo, Startpage, Google, and Mojeek. xAI retains absolute date directives as natural-language query hints because its current Responses tool has no date parameters; Ecosia ignores recency. Public Web passes the request through to its engines.
- `packages/coding-agent/src/config/settings-schema.ts` uses the shared `SEARCH_PROVIDER_PREFERENCES` / `SEARCH_PROVIDER_OPTIONS` metadata, so the settings selector and setup wizard expose `auto` plus every provider in the auto chain.
- The credential-free scrapers close the auto chain: Startpage and DuckDuckGo precede the browser-backed Ecosia, Google, and Mojeek paths; `public` is listed last and never auto-selected.
- `/login exa` stores the pasted key in AuthStorage; Exa resolves stored or environment credentials before the unauthenticated `https://mcp.exa.ai/mcp` fallback.
