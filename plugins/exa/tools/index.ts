/**
 * Exa Tools - Dynamic loader for feature modules
 *
 * Reads runtime.json to determine which features are enabled,
 * then loads and initializes those feature modules.
 *
 * Available features:
 *   - search: Core web search (general, deep, code context, URL crawling)
 *   - linkedin: LinkedIn profile and company search
 *   - company: Comprehensive company research
 *   - researcher: Long-running AI research tasks
 *   - websets: Entity collection management
 */

import type { CustomAgentTool, CustomToolFactory, ToolAPI } from '@mariozechner/pi-coding-agent'
import type { TSchema } from '@sinclair/typebox'
import runtime from './runtime.json'

// Map feature names to their module imports
const FEATURE_LOADERS: Record<string, () => Promise<{ default: CustomToolFactory }>> = {
   search: () => import('./search'),
   linkedin: () => import('./linkedin'),
   company: () => import('./company'),
   researcher: () => import('./researcher'),
   websets: () => import('./websets'),
}

/**
 * Factory function that loads enabled features from runtime.json
 */
const factory: CustomToolFactory = async (toolApi: ToolAPI): Promise<CustomAgentTool<TSchema, unknown>[] | null> => {
   const allTools: CustomAgentTool<TSchema, unknown>[] = []
   const enabledFeatures = runtime.features ?? []

   for (const feature of enabledFeatures) {
      const loader = FEATURE_LOADERS[feature]
      if (!loader) {
         console.error(`Unknown exa feature: "${feature}"`)
         continue
      }

      try {
         const module = await loader()
         const featureFactory = module.default

         if (typeof featureFactory === 'function') {
            const result = await featureFactory(toolApi)
            // Handle both single tool and array of tools
            if (result) {
               const tools = Array.isArray(result) ? result : [result]
               for (const tool of tools) {
                  if (tool && typeof tool === 'object' && 'name' in tool) {
                     allTools.push(tool)
                  }
               }
            }
         }
      } catch (error) {
         console.error(`Failed to load exa feature "${feature}":`, error)
      }
   }

   return allTools.length > 0 ? allTools : null
}

export default factory
