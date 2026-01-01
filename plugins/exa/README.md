# Exa Plugin

Exa AI web search and websets tools for pi.

## Installation

```bash
# Install with default features (search only)
omp install @oh-my-pi/exa

# Install with all features
omp install @oh-my-pi/exa[*]

# Install with specific features
omp install @oh-my-pi/exa[search,linkedin,websets]
```

## Features

| Feature      | Default | Description                         | Tools    |
| ------------ | ------- | ----------------------------------- | -------- |
| `search`     | ✓       | Core web search capabilities        | 4 tools  |
| `linkedin`   |         | LinkedIn profile and company search | 1 tool   |
| `company`    |         | Comprehensive company research      | 1 tool   |
| `researcher` |         | Long-running AI research tasks      | 2 tools  |
| `websets`    |         | Entity collection management        | 14 tools |

Manage features after install:

```bash
omp features @oh-my-pi/exa                    # Interactive UI or list features
omp features @oh-my-pi/exa --enable websets   # Enable websets
omp features @oh-my-pi/exa --disable search   # Disable search
omp features @oh-my-pi/exa --set search,linkedin,websets  # Set exact features
```

Feature state is stored in the plugin's `runtime.json` in node_modules and managed by omp.

## Setup

Set your Exa API key:

```bash
# Option 1: Use omp config
omp config @oh-my-pi/exa apiKey YOUR_API_KEY

# Option 2: Environment variable
export EXA_API_KEY=YOUR_API_KEY

# Option 3: .env file in current directory or ~/.env
echo "EXA_API_KEY=YOUR_API_KEY" >> ~/.env
```

Get your API key from: https://dashboard.exa.ai/api-keys

## Tools

### search (default)

| Tool                      | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `web_search`              | Real-time web searches with content extraction       |
| `web_search_deep`         | Natural language web search with synthesized results |
| `web_search_code_context` | Search code snippets, docs, and examples             |
| `web_search_crawl`        | Extract content from specific URLs                   |

### linkedin

| Tool                  | Description                            |
| --------------------- | -------------------------------------- |
| `web_search_linkedin` | Search LinkedIn profiles and companies |

### company

| Tool                 | Description                    |
| -------------------- | ------------------------------ |
| `web_search_company` | Comprehensive company research |

### researcher

| Tool                          | Description                                  |
| ----------------------------- | -------------------------------------------- |
| `web_search_researcher_start` | Start comprehensive AI-powered research task |
| `web_search_researcher_poll`  | Check research task status and get results   |

### websets

| Tool                       | Description                                           |
| -------------------------- | ----------------------------------------------------- |
| `webset_create`            | Create entity collections with search and enrichments |
| `webset_list`              | List all websets in your account                      |
| `webset_get`               | Get detailed webset information                       |
| `webset_update`            | Update webset metadata                                |
| `webset_delete`            | Delete a webset                                       |
| `webset_items_list`        | List items in a webset                                |
| `webset_item_get`          | Get item details                                      |
| `webset_search_create`     | Add search to find entities for a webset              |
| `webset_search_get`        | Check search status                                   |
| `webset_search_cancel`     | Cancel running search                                 |
| `webset_enrichment_create` | Extract custom data from webset items                 |
| `webset_enrichment_get`    | Get enrichment details                                |
| `webset_enrichment_update` | Update enrichment metadata                            |
| `webset_enrichment_delete` | Delete enrichment                                     |
| `webset_enrichment_cancel` | Cancel running enrichment                             |
| `webset_monitor_create`    | Auto-update webset on schedule                        |

## Usage Examples

### Code Search

```
Find examples of how to use React hooks with TypeScript
```

### Web Search

```
Search for the latest news about AI regulation in the EU
```

### Company Research (requires company feature)

```
Research the company OpenAI and find information about their products
```

### Deep Research (requires researcher feature)

```
Start a deep research project on the impact of large language models on software development
```

### Websets (requires websets feature)

```
Create a webset of AI startups in San Francisco founded after 2020,
find 10 companies and enrich with CEO name and funding amount
```

## How It Works

The plugin connects to Exa's hosted MCP (Model Context Protocol) servers:

- `https://mcp.exa.ai/mcp` - Search tools
- `https://websetsmcp.exa.ai/mcp` - Websets tools

Tools are dynamically fetched from these servers, so you always get the latest available tools.

## Resources

- [Exa Dashboard](https://dashboard.exa.ai/)
- [Exa MCP Documentation](https://docs.exa.ai/reference/exa-mcp)
- [Websets MCP Documentation](https://docs.exa.ai/reference/websets-mcp)
- [Exa API Documentation](https://docs.exa.ai/)
