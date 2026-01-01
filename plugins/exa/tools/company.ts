/**
 * Exa Company Research Tool
 *
 * Tools:
 *   - web_search_company: Comprehensive company research
 */

import type { CustomAgentTool, CustomToolFactory, ToolAPI } from '@mariozechner/pi-coding-agent'
import type { TSchema } from '@sinclair/typebox'
import { callExaTool, createToolWrapper, fetchExaTools, findApiKey } from './shared'

// MCP tool names for this feature
const TOOL_NAMES = ['company_research_exa']

// Tool name mapping: MCP name -> exposed name
const NAME_MAP: Record<string, string> = {
   company_research_exa: 'web_search_company',
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
