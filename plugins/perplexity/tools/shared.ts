/**
 * Shared utilities for Perplexity API
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions'

export interface PerplexityMessage {
   role: 'system' | 'user' | 'assistant'
   content: string
}

export interface PerplexityRequest {
   model: string
   messages: PerplexityMessage[]
   temperature?: number
   max_tokens?: number
   search_domain_filter?: string[]
   search_recency_filter?: 'day' | 'week' | 'month' | 'year'
   return_images?: boolean
   return_related_questions?: boolean
   search_context_size?: 'low' | 'medium' | 'high'
}

export interface SearchResult {
   title: string
   url: string
   date?: string
   snippet?: string
}

export interface PerplexityResponse {
   id: string
   model: string
   created: number
   usage: {
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
      search_context_size?: string
   }
   citations?: string[]
   search_results?: SearchResult[]
   related_questions?: string[]
   choices: Array<{
      index: number
      finish_reason: string
      message: {
         role: string
         content: string
      }
   }>
}

/**
 * Parse a .env file and return key-value pairs
 */
function parseEnvFile(filePath: string): Record<string, string> {
   const result: Record<string, string> = {}
   if (!fs.existsSync(filePath)) return result

   try {
      const content = fs.readFileSync(filePath, 'utf-8')
      for (const line of content.split('\n')) {
         const trimmed = line.trim()
         if (!trimmed || trimmed.startsWith('#')) continue

         const eqIndex = trimmed.indexOf('=')
         if (eqIndex === -1) continue

         const key = trimmed.slice(0, eqIndex).trim()
         let value = trimmed.slice(eqIndex + 1).trim()

         // Remove surrounding quotes
         if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
         }

         result[key] = value
      }
   } catch {
      // Ignore read errors
   }

   return result
}

/**
 * Find PERPLEXITY_API_KEY from environment or .env files
 */
export function findApiKey(): string | null {
   // 1. Check environment variable
   if (process.env.PERPLEXITY_API_KEY) {
      return process.env.PERPLEXITY_API_KEY
   }

   // 2. Check .env in current directory
   const localEnv = parseEnvFile(path.join(process.cwd(), '.env'))
   if (localEnv.PERPLEXITY_API_KEY) {
      return localEnv.PERPLEXITY_API_KEY
   }

   // 3. Check ~/.env
   const homeEnv = parseEnvFile(path.join(os.homedir(), '.env'))
   if (homeEnv.PERPLEXITY_API_KEY) {
      return homeEnv.PERPLEXITY_API_KEY
   }

   return null
}

/**
 * Call Perplexity API
 */
export async function callPerplexity(apiKey: string, request: PerplexityRequest): Promise<PerplexityResponse> {
   const response = await fetch(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: {
         Authorization: `Bearer ${apiKey}`,
         'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
   })

   if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Perplexity API error (${response.status}): ${errorText}`)
   }

   return response.json() as Promise<PerplexityResponse>
}

/**
 * Format Perplexity response for display
 */
export function formatResponse(response: PerplexityResponse): string {
   const content = response.choices[0]?.message?.content ?? ''
   const parts: string[] = [content]

   // Add citations if available
   if (response.citations && response.citations.length > 0) {
      parts.push('\n\n## Sources')
      for (const [i, url] of response.citations.entries()) {
         parts.push(`[${i + 1}] ${url}`)
      }
   }

   // Add related questions if available
   if (response.related_questions && response.related_questions.length > 0) {
      parts.push('\n\n## Related Questions')
      for (const question of response.related_questions) {
         parts.push(`- ${question}`)
      }
   }

   return parts.join('\n')
}
