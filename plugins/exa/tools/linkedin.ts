/**
 * Exa LinkedIn Search Tool
 *
 * Tools:
 *   - web_search_linkedin: Search LinkedIn profiles and companies
 */

import type { CustomAgentTool, CustomToolFactory, ToolAPI } from '@mariozechner/pi-coding-agent'
import type { TSchema } from '@sinclair/typebox'
import { callExaTool, createToolWrapper, fetchExaTools, findApiKey } from './shared'

// MCP tool names for this feature
const TOOL_NAMES = ['linkedin_search_exa']

// Tool name mapping: MCP name -> exposed name
const NAME_MAP: Record<string, string> = {
   linkedin_search_exa: 'web_search_linkedin',
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
