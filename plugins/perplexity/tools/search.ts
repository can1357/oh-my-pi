/**
 * Perplexity Search Tools - Web search with Sonar models
 *
 * Tools:
 *   - perplexity_search: Fast web search with Sonar (quick answers)
 *   - perplexity_search_pro: Advanced search with Sonar Pro (deeper research)
 */

import type { CustomAgentTool, CustomToolFactory, ToolAPI } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { type TSchema, Type } from '@sinclair/typebox'
import { callPerplexity, findApiKey, formatResponse, type PerplexityRequest, type SearchResult } from './shared'

// Tree rendering constants
const TREE_MID = '├─'
const TREE_END = '└─'
const TREE_PIPE = '│'
const TREE_SPACE = ' '

/**
 * Truncate text to max length with ellipsis
 */
function truncate(text: string, maxLen: number): string {
   if (text.length <= maxLen) return text
   return `${text.slice(0, maxLen - 1)}…`
}

/**
 * Extract domain from URL
 */
function getDomain(url: string): string {
   try {
      const u = new URL(url)
      return u.hostname.replace(/^www\./, '')
   } catch {
      return url
   }
}

/**
 * Get first N lines of text as preview
 */
function getPreviewLines(text: string, maxLines: number, maxLineLen: number): string[] {
   const lines = text.split('\n').filter(l => l.trim())
   return lines.slice(0, maxLines).map(l => truncate(l.trim(), maxLineLen))
}

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

      renderResult(result, { expanded }, theme) {
         const { details } = result

         // Handle error case
         if (details && typeof details === 'object' && 'error' in details) {
            const errDetails = details as { error: string }
            return new Text(theme.fg('error', `Error: ${errDetails.error}`), 0, 0)
         }

         // Type for the details object
         interface PerplexityDetails {
            model: string
            usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
            citations?: string[]
            search_results?: SearchResult[]
            related_questions?: string[]
         }

         const data = details as PerplexityDetails | undefined
         const answer = result.content[0]?.type === 'text' ? result.content[0].text : ''

         // Build header with metadata
         const meta: string[] = []
         if (data?.model) meta.push(data.model)
         if (data?.usage?.total_tokens) meta.push(`${data.usage.total_tokens} tokens`)

         const citationCount = data?.citations?.length ?? 0
         const icon = citationCount > 0 ? theme.fg('success', '●') : theme.fg('warning', '●')
         const expandHint = expanded ? '' : theme.fg('dim', ' (Ctrl+O to expand)')
         let text = `${icon} ${theme.fg('toolTitle', 'Perplexity Search')} ${theme.fg('dim', meta.join(' · '))}${expandHint}`

         if (!answer) {
            text += `\n ${theme.fg('dim', TREE_END)} ${theme.fg('muted', 'No answer returned')}`
            return new Text(text, 0, 0)
         }

         if (expanded) {
            // Full answer
            const answerLines = answer.split('\n')
            for (const line of answerLines) {
               text += `\n ${theme.fg('dim', TREE_PIPE)}  ${line}`
            }

            // Citations tree
            if (data?.citations && data.citations.length > 0) {
               text += `\n ${theme.fg('dim', TREE_MID)} ${theme.fg('accent', 'Citations')}`
               for (let i = 0; i < data.citations.length; i++) {
                  const citation = data.citations[i]
                  const isLast = i === data.citations.length - 1 && !data.related_questions?.length
                  const branch = isLast ? TREE_END : TREE_MID
                  const domain = getDomain(citation)

                  // Find matching search result for title
                  const searchResult = data.search_results?.find(r => r.url === citation)
                  const title = searchResult?.title ? truncate(searchResult.title, 60) : domain

                  text += `\n ${theme.fg('dim', TREE_PIPE)} ${theme.fg('dim', branch)} ${theme.fg('accent', title)}`
                  text += theme.fg('dim', ` (${domain})`)
               }
            }

            // Related questions tree
            if (data?.related_questions && data.related_questions.length > 0) {
               text += `\n ${theme.fg('dim', TREE_END)} ${theme.fg('accent', 'Related Questions')}`
               for (let i = 0; i < data.related_questions.length; i++) {
                  const question = data.related_questions[i]
                  const isLast = i === data.related_questions.length - 1
                  const branch = isLast ? TREE_END : TREE_MID
                  text += `\n ${theme.fg('dim', TREE_SPACE)} ${theme.fg('dim', branch)} ${theme.fg('muted', question)}`
               }
            }
         } else {
            // Collapsed: preview lines
            const preview = getPreviewLines(answer, 3, 100)
            for (const line of preview) {
               text += `\n ${theme.fg('dim', TREE_PIPE)}  ${theme.fg('dim', line)}`
            }

            const totalLines = answer.split('\n').filter(l => l.trim()).length
            if (totalLines > 3) {
               text += `\n ${theme.fg('dim', TREE_PIPE)}  ${theme.fg('muted', `… ${totalLines - 3} more lines`)}`
            }

            // Citation count summary
            if (citationCount > 0) {
               text += `\n ${theme.fg('dim', TREE_END)} ${theme.fg('muted', `${citationCount} citation${citationCount !== 1 ? 's' : ''}`)}`
            }
         }

         return new Text(text, 0, 0)
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
