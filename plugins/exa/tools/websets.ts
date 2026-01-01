/**
 * Exa Websets Tools - Entity collection management
 *
 * Tools:
 *   - webset_create: Create entity collections with search/enrichments
 *   - webset_list: List all websets
 *   - webset_get: Get webset details
 *   - webset_update: Update webset metadata
 *   - webset_delete: Delete a webset
 *   - webset_items_list: List items in a webset
 *   - webset_item_get: Get item details
 *   - webset_search_create: Add search to webset
 *   - webset_search_get: Check search status
 *   - webset_search_cancel: Cancel running search
 *   - webset_enrichment_create: Extract custom data from items
 *   - webset_enrichment_get: Get enrichment details
 *   - webset_enrichment_update: Update enrichment metadata
 *   - webset_enrichment_delete: Delete enrichment
 *   - webset_enrichment_cancel: Cancel running enrichment
 *   - webset_monitor_create: Auto-update webset on schedule
 */

import type { CustomAgentTool, CustomToolFactory, ToolAPI } from '@mariozechner/pi-coding-agent'
import type { TSchema } from '@sinclair/typebox'
import { callWebsetsTool, createToolWrapper, fetchWebsetsTools, findApiKey } from './shared'

// Tool name mapping: MCP name -> exposed name
const NAME_MAP: Record<string, string> = {
   create_webset: 'webset_create',
   list_websets: 'webset_list',
   get_webset: 'webset_get',
   update_webset: 'webset_update',
   delete_webset: 'webset_delete',
   list_webset_items: 'webset_items_list',
   get_item: 'webset_item_get',
   create_search: 'webset_search_create',
   get_search: 'webset_search_get',
   cancel_search: 'webset_search_cancel',
   create_enrichment: 'webset_enrichment_create',
   get_enrichment: 'webset_enrichment_get',
   update_enrichment: 'webset_enrichment_update',
   delete_enrichment: 'webset_enrichment_delete',
   cancel_enrichment: 'webset_enrichment_cancel',
   create_monitor: 'webset_monitor_create',
}

const factory: CustomToolFactory = async (_toolApi: ToolAPI): Promise<CustomAgentTool<TSchema, unknown>[] | null> => {
   const apiKey = findApiKey()
   if (!apiKey) return null

   const mcpTools = await fetchWebsetsTools(apiKey)
   if (mcpTools.length === 0) return null

   const callFn = (toolName: string, args: Record<string, unknown>) => callWebsetsTool(apiKey, toolName, args)

   return mcpTools.map(tool => createToolWrapper(tool, NAME_MAP[tool.name] ?? tool.name, callFn))
}

export default factory
