# x_search

> Search X (Twitter) posts, profiles, and threads through xAI's Responses `x_search` server tool. Read-only discovery: current discussion, reactions, and claims on public X — not the open web (use `web_search`), and not posting or account actions.

## Source

- Entry: `packages/coding-agent/src/web/search/xsearch.ts`
- Provider adapter: `packages/coding-agent/src/web/search/providers/xai.ts` (`params.xSearch` branch)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/x-search.md`
- System prompt sent to the backing Grok model: `packages/coding-agent/src/prompts/system/x-search.md`

## Model selection

Any model can call `x_search`; the search itself runs on the `xsearch` role, not the caller's chat model.

- **Default chain**: `xai/grok-4.6`, then `xai-oauth/grok-4.6` (`packages/coding-agent/src/priority.json`) — the providers' own default model.
- **Eligibility**: a candidate must carry `webSearch: "xai"` grounding (the `web-search "xai"` axis on the `xai`/`xai-oauth` KDL providers). Non-xAI selections fail closed.
- **Credentials**: identical to `web_search` on xAI — `XAI_OAUTH_TOKEN` or a stored `xai-oauth` credential is preferred, otherwise `XAI_API_KEY` or a stored `xai` credential. Official OAuth credentials are refused for custom endpoints. API-key requests are billed per fetched post; SuperGrok subscription usage applies to OAuth.

## Inputs

| Field                          | Type                                   | Required | Description                                                                                                                                                          |
| ------------------------------ | -------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`                        | `string`                               | Yes      | What to look up on X. `after:`/`before:` YYYY-MM-DD directives map to `from_date`/`to_date`; other Google-style directives degrade to plain terms.                   |
| `allowed_x_handles`            | `string[]`                             | No       | Include only these handles (max 20, `@` optional). Mutually exclusive with `excluded_x_handles`.                                                                     |
| `excluded_x_handles`           | `string[]`                             | No       | Exclude these handles (max 20).                                                                                                                                      |
| `from_date` / `to_date`        | `string`                               | No       | Inclusive ISO `YYYY-MM-DD` window; strict validation (xAI silently accepts malformed dates and falls back to model knowledge). `from_date` may not be in the future. |
| `recency`                      | `'day' \| 'week' \| 'month' \| 'year'` | No       | Shorthand for `from_date = now - N`. Explicit `from_date` wins.                                                                                                      |
| `enable_image_understanding`   | `boolean`                              | No       | Analyze images attached to matching posts.                                                                                                                           |
| `enable_video_understanding`   | `boolean`                              | No       | Analyze videos attached to matching posts.                                                                                                                           |
| `num_search_results` / `limit` | `number`                               | No       | Local cap on parsed sources/citations (default 10, max 30); not sent upstream.                                                                                       |
| `max_tokens`, `temperature`    | `number`                               | No       | Passed through to the Responses request.                                                                                                                             |

## Outputs

Same `SearchResponse` shape as `web_search` (`answer`, `sources`, `citations`, `usage`, `model`, `requestId`, `authMode`), rendered by the shared search result card.

- **Degraded detection**: when narrowing filters are active and the response carries no citations or post sources, `details.response.degraded` is set and the tool output leads with a `Note:` warning that the answer may be model knowledge rather than live posts.
- Requests send `store: false` and `reasoning: { effort: "low" }`; non-streaming `POST <baseUrl>/responses` with `tools: [{ type: "x_search", ... }]`.

## Configuration

- `x_search.enabled` gates the built-in tool: `auto` (default) enables it only when an xAI credential (SuperGrok OAuth or `XAI_API_KEY`) resolves, `on` always enables, `off` disables.
- `providers.webSearchTimeoutSeconds` supplies the per-request transport timeout, shared with `web_search`.
