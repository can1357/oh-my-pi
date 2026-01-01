/**
 * Exa Deep Researcher Tools
 *
 * Tools:
 *   - web_search_researcher_start: Start comprehensive AI research tasks
 *   - web_search_researcher_check: Check research task status
 */

import type { CustomAgentTool, CustomToolFactory, ToolAPI } from '@mariozechner/pi-coding-agent'
import type { TSchema } from '@sinclair/typebox'
import { callExaTool, createToolWrapper, fetchExaTools, findApiKey } from './shared'

// MCP tool names for this feature
const TOOL_NAMES = ['deep_researcher_start', 'deep_researcher_check']

// Tool name mapping: MCP name -> exposed name
const NAME_MAP: Record<string, string> = {
   deep_researcher_start: 'web_search_researcher_start',
   deep_researcher_check: 'web_search_researcher_check',
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
