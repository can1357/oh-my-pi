# @oh-my-pi/anthropic-websearch

Claude web search tool for [pi](https://github.com/badlogic/pi-mono).

Uses Anthropic's built-in `web_search_20250305` tool to search the web and synthesize answers with citations.

## Installation

```bash
omp install @oh-my-pi/anthropic-websearch
```

## Authentication

The plugin checks for credentials in this order:

1. **Explicit override**: `ANTHROPIC_SEARCH_API_KEY` / `ANTHROPIC_SEARCH_BASE_URL`
2. **models.json**: Provider with `api: "anthropic-messages"` in `~/.pi/agent/models.json`
3. **OAuth**: Anthropic OAuth credentials in `~/.pi/agent/auth.json` (Claude Code tokens supported)
4. **Fallback**: `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`

This ordering prevents accidentally charging your console account if you have a proxy or OAuth set up.

### Using Claude Code OAuth tokens

If you're logged into Claude Code (`pi login`), the plugin will automatically use your OAuth token from `~/.pi/agent/auth.json`. OAuth tokens (`sk-ant-oat01-...`) are fully supported with proper Claude Code identity headers.

### Using a proxy

If your `~/.pi/agent/models.json` has a provider with `api: "anthropic-messages"`:

```json
{
  "providers": {
    "my-proxy": {
      "baseUrl": "http://localhost:4000",
      "apiKey": "none",
      "api": "anthropic-messages",
      "models": [...]
    }
  }
}
```

The plugin will automatically use `http://localhost:4000`.

### Direct API key

```bash
export ANTHROPIC_SEARCH_API_KEY=sk-ant-api03-xxx
```

## Tools

### `anthropic_web_search`

Search the web using Claude's built-in web search capability.

**Parameters:**

- `query` (required): The search query or question
- `system_prompt`: Guide the response style and focus
- `max_tokens`: Maximum tokens in response (default: 4096)

**Response includes:**

- Synthesized answer with inline citations
- List of sources with titles, URLs, and page ages
- Search queries Claude generated

## Configuration

| Variable  | Env                         | Description                                          |
| --------- | --------------------------- | ---------------------------------------------------- |
| `apiKey`  | `ANTHROPIC_SEARCH_API_KEY`  | API key (optional if using proxy/oauth)              |
| `baseUrl` | `ANTHROPIC_SEARCH_BASE_URL` | Base URL override                                    |
| `model`   | `ANTHROPIC_SEARCH_MODEL`    | Model to use (default: `claude-sonnet-4-5-20250514`) |

Configure via `omp config`:

```bash
# Set a different model
omp config @oh-my-pi/anthropic-websearch model claude-opus-4-20250514

# View current config
omp config @oh-my-pi/anthropic-websearch
```

Or via environment variables:

```bash
export ANTHROPIC_SEARCH_MODEL=claude-opus-4-20250514
```

## License

MIT
