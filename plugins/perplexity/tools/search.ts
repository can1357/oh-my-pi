/**
 * Perplexity Search Tools - Web search with Sonar models
 *
 * Tools:
 *   - perplexity_search: Fast web search with Sonar (quick answers)
 *   - perplexity_search_pro: Advanced search with Sonar Pro (deeper research)
 */

import type { CustomAgentTool, CustomToolFactory, ToolAPI } from '@mariozechner/pi-coding-agent'
import { type TSchema, Type } from '@sinclair/typebox'
import { callPerplexity, findApiKey, formatResponse, type PerplexityRequest } from './shared'

const RecencyFilter = Type.Optional(
   Type.Union([Type.Literal('day'), Type.Literal('week'), Type.Literal('month'), Type.Literal('year')], {
      description: 'Filter results by recency',
   })
)

const SearchContextSize = Type.Optional(
   Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')], {
      description: 'Amount of search context to use (affects cost). Default: low',
   })
)

// Schema for fast search
const FastSearchSchema = Type.Object({
   query: Type.String({
      description: 'The search query or question to answer',
   }),
   search_recency_filter: RecencyFilter,
   search_domain_filter: Type.Optional(
      Type.Array(Type.String(), {
         description: "Limit search to specific domains (e.g., ['nature.com', 'arxiv.org']). Prefix with '-' to exclude.",
      })
   ),
   search_context_size: SearchContextSize,
   return_related_questions: Type.Optional(
      Type.Boolean({
         description: 'Include related follow-up questions in response',
      })
   ),
})

// Schema for pro search
const ProSearchSchema = Type.Object({
   query: Type.String({
      description: 'The search query or research question',
   }),
   system_prompt: Type.Optional(
      Type.String({
         description: 'System prompt to guide the response style and focus',
      })
   ),
   search_recency_filter: RecencyFilter,
   search_domain_filter: Type.Optional(
      Type.Array(Type.String(), {
         description: "Limit search to specific domains (e.g., ['nature.com', 'arxiv.org']). Prefix with '-' to exclude.",
      })
   ),
   search_context_size: SearchContextSize,
   return_related_questions: Type.Optional(
      Type.Boolean({
         description: 'Include related follow-up questions in response',
      })
   ),
})

type FastSearchParams = {
   query: string
   search_recency_filter?: 'day' | 'week' | 'month' | 'year'
   search_domain_filter?: string[]
   search_context_size?: 'low' | 'medium' | 'high'
   return_related_questions?: boolean
}

type ProSearchParams = FastSearchParams & {
   system_prompt?: string
}

function createSearchTool(
   apiKey: string,
   name: string,
   description: string,
   model: string,
   schema: TSchema
): CustomAgentTool<TSchema, unknown> {
   return {
      name,
      label: name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      description,
      parameters: schema,
      async execute(_toolCallId, params) {
         try {
            const p = (params ?? {}) as ProSearchParams

            const request: PerplexityRequest = {
               model,
               messages: [],
            }

            // Add system prompt if provided
            if (p.system_prompt) {
               request.messages.push({
                  role: 'system',
                  content: p.system_prompt,
               })
            }

            request.messages.push({
               role: 'user',
               content: p.query,
            })

            // Add optional parameters
            if (p.search_recency_filter) {
               request.search_recency_filter = p.search_recency_filter
            }
            if (p.search_domain_filter && p.search_domain_filter.length > 0) {
               request.search_domain_filter = p.search_domain_filter
            }
            if (p.search_context_size) {
               request.search_context_size = p.search_context_size
            }
            if (p.return_related_questions) {
               request.return_related_questions = p.return_related_questions
            }

            const response = await callPerplexity(apiKey, request)
            const text = formatResponse(response)

            return {
               content: [{ type: 'text' as const, text }],
               details: {
                  model: response.model,
                  usage: response.usage,
                  citations: response.citations,
                  search_results: response.search_results,
                  related_questions: response.related_questions,
               },
            }
         } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return {
               content: [{ type: 'text' as const, text: `Error: ${message}` }],
               details: { error: message },
            }
         }
      },
   }
}

const factory: CustomToolFactory = async (_toolApi: ToolAPI): Promise<CustomAgentTool<TSchema, unknown>[] | null> => {
   const apiKey = findApiKey()
   if (!apiKey) return null

   return [
      createSearchTool(
         apiKey,
         'perplexity_search',
         'Fast web search using Perplexity Sonar. Returns real-time answers with citations. Best for quick facts, current events, and straightforward questions. Cost-effective for high-volume queries.',
         'sonar',
         FastSearchSchema
      ),
      createSearchTool(
         apiKey,
         'perplexity_search_pro',
         'Advanced web search using Perplexity Sonar Pro. Returns comprehensive, well-researched answers with 2x more sources. Best for complex research questions, multi-step analysis, and detailed comparisons. Higher cost but deeper results.',
         'sonar-pro',
         ProSearchSchema
      ),
   ]
}

export default factory
