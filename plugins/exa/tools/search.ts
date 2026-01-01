/**
 * Exa Search Tools - Core web search capabilities
 *
 * Tools:
 *   - web_search: Real-time web searches
 *   - web_search_deep: Natural language web search with synthesis
 *   - web_search_code_context: Code search for libraries, docs, examples
 *   - web_search_crawl: Extract content from specific URLs
 */

import type { CustomAgentTool, CustomToolFactory, ToolAPI } from '@mariozechner/pi-coding-agent'
import type { TSchema } from '@sinclair/typebox'
import { callExaTool, createToolWrapper, fetchExaTools, findApiKey } from './shared'

// MCP tool names for this feature
const TOOL_NAMES = ['web_search_exa', 'deep_search_exa', 'get_code_context_exa', 'crawling_exa']

// Tool name mapping: MCP name -> exposed name
const NAME_MAP: Record<string, string> = {
   web_search_exa: 'web_search',
   deep_search_exa: 'web_search_deep',
   get_code_context_exa: 'web_search_code_context',
   crawling_exa: 'web_search_crawl',
}

const factory: CustomToolFactory = async (_toolApi: ToolAPI): Promise<CustomAgentTool<TSchema, unknown>[] | null> => {
   const apiKey = findApiKey()
   if (!apiKey) return null

   const mcpTools = await fetchExaTools(apiKey, TOOL_NAMES)
   if (mcpTools.length === 0) return null

   const callFn = (toolName: string, args: Record<string, unknown>) => callExaTool(apiKey, TOOL_NAMES, toolName, args)

   return mcpTools.map(tool => createToolWrapper(tool, NAME_MAP[tool.name] ?? tool.name, callFn))
}

export default factory
