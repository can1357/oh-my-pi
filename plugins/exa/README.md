# Exa Plugin

Exa AI web search and websets tools for pi.

## Installation

```bash
omp install oh-my-pi/plugins/exa
```

## Setup

Set your Exa API key in one of these locations (checked in order):

1. Environment variable: `EXA_API_KEY`
2. `.env` file in current directory
3. `~/.env` file

Get your API key from: https://dashboard.exa.ai/api-keys

## Tools

This plugin dynamically exposes all tools from both Exa MCP servers:

### Search Tools (from mcp.exa.ai)

| Tool | Description |
|------|-------------|
| `web_search_exa` | Real-time web searches with content extraction |
| `get_code_context_exa` | Search code snippets, docs, and examples from GitHub, StackOverflow, etc. |
| `deep_search_exa` | Natural language web search with synthesized results |
| `crawling_exa` | Extract content from specific URLs |
| `company_research_exa` | Comprehensive company research |
| `linkedin_search_exa` | Search LinkedIn profiles and companies |
| `deep_researcher_start` | Start comprehensive AI-powered research task |
| `deep_researcher_check` | Check research task status and get results |

### Websets Tools (from websetsmcp.exa.ai)

| Tool | Description |
|------|-------------|
| `create_webset` | Create entity collections with search and enrichments |
| `list_websets` | List all websets in your account |
| `get_webset` | Get detailed webset information |
| `update_webset` | Update webset metadata |
| `list_webset_items` | List items in a webset |
| `get_item` | Get item details |
| `create_search` | Add search to find entities for a webset |
| `get_search` | Check search status |
| `cancel_search` | Cancel running search |
| `create_enrichment` | Extract custom data from webset items |
| `get_enrichment` | Get enrichment details |
| `delete_enrichment` | Delete enrichment |
| `cancel_enrichment` | Cancel running enrichment |
| `create_monitor` | Auto-update webset on schedule |

## Usage Examples

### Code Search
```
Find examples of how to use React hooks with TypeScript
```

### Web Search
```
Search for the latest news about AI regulation in the EU
```

### Company Research
```
Research the company OpenAI and find information about their products
```

### Deep Research
```
Start a deep research project on the impact of large language models on software development
```

### Websets
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
