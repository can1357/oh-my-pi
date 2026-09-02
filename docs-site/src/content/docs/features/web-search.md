---
title: Web Search & Reading
description: One query fanned across a 25-provider fallback chain — from the agent or `omp search` / `omp q`.
coverage: B
---

The agent can search the web through a built-in tool that fans out across a 25-provider fallback chain until one returns an answer. You can drive the same providers yourself from the command line with `omp search` (alias `omp q`).

## Run a query from the shell

```bash
omp search "how does mcp stdio work"
omp q "anthropic claude 4 release notes" -l 5
```

The positional accepts multiple words. Flags:

| Flag | Effect |
| --- | --- |
| `--provider <name>` | Pick a specific provider; `auto` (the default) walks the configured chain |
| `--recency <window>` | Time filter: `day`, `week`, `month`, or `year` |
| `-l, --limit <n>` | Max results to return |
| `--compact` | Render condensed output |

The full set of `--provider` values is `auto` plus every entry in the auto chain (see below).

## What the agent's `web_search` tool does

The agent passes a `query` to the tool unchanged and may also pass a `recency` window. For each call the tool walks the configured provider chain in order: the first provider to return renderable content wins, the rest are skipped. If every provider fails, the tool returns a single text result starting with `Error: ` instead of throwing.

Returned text is one block structured for the model:

- an `answer` line when the provider supplies one,
- a `## Sources` section with `[n] <title> (<age or date>)` plus a URL line per source and an optional 240-char snippet (the section is suppressed when no answer was produced),
- an optional `## Citations` section with URL/title plus cited text,
- an optional `## Related` bullet list of related questions,
- a `## Search queries: <n>` line capped to the first 3 queries and 120 chars each.

`recency` is implemented by Brave, Perplexity, Tavily, SearXNG, Kagi, TinyFish, Firecrawl, xAI, DuckDuckGo, Bing, Yahoo, Startpage, Google, and Mojeek; Ecosia ignores it. SearXNG downgrades `week` to `month` because SearXNG does not support week; Yahoo drops `year`.

## Provider chain

Default order (first provider tried → last):

`perplexity`, `gemini`, `anthropic`, `codex`, `xai`, `zai`, `exa`, `tinyfish`, `jina`, `kagi`, `tavily`, `firecrawl`, `brave`, `kimi`, `parallel`, `synthetic`, `searxng`, `duckduckgo`, `bing`, `yahoo`, `startpage`, `google`, `ecosia`, `mojeek`, `public`.

`public` is explicit-only — it is listed but the auto chain never fans out to it implicitly. Pick it with `--provider public` to fan out across every credential-free engine in parallel (deadline race: 5s soft with at least one success, 30s hard cap).

### Credentials per provider

Add credentials through `/login <provider>` (e.g. `/login exa`) or by exporting the env var below. The auto chain includes credential-free scrapers at the end (DuckDuckGo, Bing, Yahoo, Startpage, Google, Ecosia, Mojeek) so you can search with no setup, falling back to those when keyed providers are unavailable.

| Provider | Credentials |
| --- | --- |
| Anthropic | `ANTHROPIC_SEARCH_API_KEY` (search-only key; overrides `ANTHROPIC_API_KEY` / OAuth for search). Search model and base URL can be overridden by `ANTHROPIC_SEARCH_MODEL` (default `claude-haiku-4-5`) and `ANTHROPIC_SEARCH_BASE_URL` (default `https://api.anthropic.com`). |
| Perplexity | `PERPLEXITY_COOKIES`, OAuth in `agent.db`, or `PERPLEXITY_API_KEY` / `PPLX_API_KEY`. Falls back to an anonymous ask-endpoint if none are set. |
| Gemini | OAuth in `agent.db` for `google-gemini-cli` / `google-antigravity`, or a Google Developer API key. Model via `providers.webSearchGeminiModel` or `GEMINI_SEARCH_MODEL` (default `gemini-2.5-flash`). |
| Codex | OAuth in `agent.db` for `openai-codex`. |
| xAI | `XAI_API_KEY` or `agent.db` credential. |
| Z.AI | Env or `agent.db` credential for `zai`. |
| Exa | `EXA_API_KEY` or `agent.db` credential (add through `/login exa`); falls back to `https://mcp.exa.ai/mcp` when no key. |
| TinyFish | `TINYFISH_API_KEY` or `agent.db` credential. |
| Jina | `JINA_API_KEY`. |
| Kagi | Env or `agent.db` credential for `kagi`. |
| Tavily | API key from env or `agent.db` via `findCredential()`. |
| Firecrawl | `FIRECRAWL_API_KEY` or `agent.db` credential. |
| Brave | `BRAVE_API_KEY`. |
| Kimi | `MOONSHOT_SEARCH_API_KEY`, `KIMI_SEARCH_API_KEY`, `MOONSHOT_API_KEY`, or `agent.db` credentials for `moonshot` / `kimi-code`. |
| Parallel | Env or `agent.db` credential. |
| Synthetic | Env or `agent.db` credential. |
| SearXNG | `searxng.endpoint` (or `SEARXNG_ENDPOINT`). Optional Basic auth (`searxng.basicUsername` / `searxng.basicPassword`) or bearer token (`searxng.token` / `SEARXNG_TOKEN`). |
| DuckDuckGo / Bing / Yahoo / Startpage / Google / Ecosia / Mojeek | None — credential-free. Google, Ecosia, and Mojeek escalate to a headless browser under the hood. |

:::caution
Some engines serve bot-detection pages when throttled. DuckDuckGo, Bing, Yahoo, Startpage, Google, Ecosia, and Mojeek detect their own challenge pages and surface a tagged `SearchProviderError` so the orchestrator can fall through to the next provider.
:::

## Settings

`omp config set <key> <value>` configures the search layer; see [Settings](/oh-my-pi/configuration/settings/) for scopes and precedence.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `providers.webSearchOrder` | string list | empty (built-in order) | Providers listed here are tried first, in the order given. Unlisted providers follow in the built-in order. |
| `providers.webSearchExclude` | string list | empty | Providers to skip entirely, including as fallbacks. |
| `providers.webSearchGeminiModel` | string | `gemini-2.5-flash` | Gemini grounding model for the search call. Overridden by `GEMINI_SEARCH_MODEL`. |
| `searxng.endpoint` | string | empty | SearXNG JSON endpoint (e.g. `https://search.example.com`). |
| `searxng.basicUsername` / `searxng.basicPassword` | string | empty | SearXNG Basic auth (RFC 7617–restricted). |
| `searxng.token` | string | empty | SearXNG bearer token. |

The `web_search` tool is gated by `web_search.enabled`; flip it off in `/settings` (Tools tab) to drop the tool from the agent.
