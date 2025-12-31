# @oh-my-pi/perplexity

Perplexity AI search tools for [pi](https://github.com/badlogic/pi-mono).

## Installation

```bash
omp install @oh-my-pi/perplexity
```

## Configuration

Set your Perplexity API key:

```bash
# Option 1: Environment variable
export PERPLEXITY_API_KEY=pplx-xxx

# Option 2: Add to ~/.env
echo "PERPLEXITY_API_KEY=pplx-xxx" >> ~/.env
```

Get your API key from [Perplexity API Settings](https://www.perplexity.ai/settings/api).

## Tools

### `perplexity_search`

Fast web search using Perplexity Sonar. Returns real-time answers with citations.

**Best for:** Quick facts, current events, straightforward questions

**Parameters:**

- `query` (required): The search query or question
- `search_recency_filter`: Filter by recency (`day`, `week`, `month`, `year`)
- `search_domain_filter`: Limit to specific domains (e.g., `["nature.com", "arxiv.org"]`)
- `search_context_size`: Amount of search context (`low`, `medium`, `high`)
- `return_related_questions`: Include follow-up question suggestions

### `perplexity_search_pro`

Advanced web search using Perplexity Sonar Pro. Returns comprehensive answers with 2x more sources.

**Best for:** Complex research, multi-step analysis, detailed comparisons

**Additional parameters:**

- `system_prompt`: Guide the response style and focus

## Pricing

| Model     | Input       | Output       | Per 1K Requests |
| --------- | ----------- | ------------ | --------------- |
| Sonar     | $1/M tokens | $1/M tokens  | $5-12           |
| Sonar Pro | $3/M tokens | $15/M tokens | $6-14           |

Request cost varies by `search_context_size` (low/medium/high).

## License

MIT
