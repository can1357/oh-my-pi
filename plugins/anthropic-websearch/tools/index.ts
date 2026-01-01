/**
 * Anthropic Web Search Tool
 *
 * Uses Claude's built-in web_search_20250305 tool to search the web.
 *
 * Auth resolution order:
 *   1. ANTHROPIC_SEARCH_API_KEY / ANTHROPIC_SEARCH_BASE_URL env vars
 *   2. Provider with api="anthropic-messages" in ~/.pi/agent/models.json
 *   3. OAuth credentials in ~/.pi/agent/auth.json
 *   4. ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL as final fallback
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CustomAgentTool, CustomToolFactory, ToolAPI } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { type TSchema, Type } from '@sinclair/typebox'
import runtime from './runtime.json'

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250514'

interface RuntimeConfig {
   options?: {
      model?: string
      apiKey?: string
      baseUrl?: string
   }
}

interface AuthConfig {
   apiKey: string
   baseUrl: string
   isOAuth: boolean
}

interface ModelsJson {
   providers?: Record<
      string,
      {
         baseUrl?: string
         apiKey?: string
         api?: string
      }
   >
}

interface AuthJson {
   anthropic?: {
      type: 'oauth'
      access: string
      refresh?: string
      expires: number
   }
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
 * Get env var from process.env or .env files
 */
function getEnv(key: string): string | undefined {
   if (process.env[key]) return process.env[key]

   const localEnv = parseEnvFile(path.join(process.cwd(), '.env'))
   if (localEnv[key]) return localEnv[key]

   const homeEnv = parseEnvFile(path.join(os.homedir(), '.env'))
   if (homeEnv[key]) return homeEnv[key]

   return undefined
}

/**
 * Read JSON file safely
 */
function readJson<T>(filePath: string): T | null {
   try {
      if (!fs.existsSync(filePath)) return null
      const content = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(content) as T
   } catch {
      return null
   }
}

/**
 * Check if a token is an OAuth token
 */
function isOAuthToken(apiKey: string): boolean {
   return apiKey.includes('sk-ant-oat')
}

/**
 * Get runtime config value, falling back to env var
 */
function getConfig(key: 'model' | 'apiKey' | 'baseUrl'): string | undefined {
   const cfg = (runtime as RuntimeConfig).options ?? {}
   if (cfg[key]) return cfg[key]

   const envMap = {
      model: 'ANTHROPIC_SEARCH_MODEL',
      apiKey: 'ANTHROPIC_SEARCH_API_KEY',
      baseUrl: 'ANTHROPIC_SEARCH_BASE_URL',
   }
   return getEnv(envMap[key])
}

/**
 * Find auth config using priority order:
 * 1. Runtime config / ANTHROPIC_SEARCH_API_KEY / ANTHROPIC_SEARCH_BASE_URL
 * 2. Provider with api="anthropic-messages" in models.json
 * 3. OAuth in auth.json
 * 4. ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL fallback
 */
function findAuthConfig(): AuthConfig | null {
   const piAgentDir = path.join(os.homedir(), '.pi', 'agent')

   // 1. Explicit config or env vars
   const searchApiKey = getConfig('apiKey')
   const searchBaseUrl = getConfig('baseUrl')
   if (searchApiKey) {
      return {
         apiKey: searchApiKey,
         baseUrl: searchBaseUrl ?? DEFAULT_BASE_URL,
         isOAuth: isOAuthToken(searchApiKey),
      }
   }

   // 2. Provider with api="anthropic-messages" in models.json
   const modelsJson = readJson<ModelsJson>(path.join(piAgentDir, 'models.json'))
   if (modelsJson?.providers) {
      for (const [_name, provider] of Object.entries(modelsJson.providers)) {
         if (provider.api === 'anthropic-messages' && provider.apiKey && provider.apiKey !== 'none') {
            return {
               apiKey: provider.apiKey,
               baseUrl: provider.baseUrl ?? DEFAULT_BASE_URL,
               isOAuth: isOAuthToken(provider.apiKey),
            }
         }
      }
      // Also check for providers with baseUrl but apiKey="none" (proxy)
      for (const [_name, provider] of Object.entries(modelsJson.providers)) {
         if (provider.api === 'anthropic-messages' && provider.baseUrl) {
            return {
               apiKey: provider.apiKey ?? '',
               baseUrl: provider.baseUrl,
               isOAuth: false,
            }
         }
      }
   }

   // 3. OAuth credentials in auth.json
   const authJson = readJson<AuthJson>(path.join(piAgentDir, 'auth.json'))
   if (authJson?.anthropic?.type === 'oauth' && authJson.anthropic.access) {
      // Check if not expired (with 5 min buffer)
      if (authJson.anthropic.expires > Date.now() + 5 * 60 * 1000) {
         return {
            apiKey: authJson.anthropic.access,
            baseUrl: DEFAULT_BASE_URL,
            isOAuth: true,
         }
      }
   }

   // 4. Generic ANTHROPIC_API_KEY fallback
   const apiKey = getEnv('ANTHROPIC_API_KEY')
   const baseUrl = getEnv('ANTHROPIC_BASE_URL')
   if (apiKey) {
      return {
         apiKey,
         baseUrl: baseUrl ?? DEFAULT_BASE_URL,
         isOAuth: isOAuthToken(apiKey),
      }
   }

   return null
}

/**
 * Build headers for Anthropic API request
 */
function buildHeaders(auth: AuthConfig): Record<string, string> {
   const betas = ['web-search-2025-03-05']

   if (auth.isOAuth) {
      // OAuth requires additional beta headers and stainless telemetry
      betas.push('oauth-2025-04-20', 'claude-code-20250219', 'prompt-caching-2024-07-31')

      return {
         'anthropic-version': '2023-06-01',
         authorization: `Bearer ${auth.apiKey}`,
         accept: 'application/json',
         'content-type': 'application/json',
         'anthropic-dangerous-direct-browser-access': 'true',
         'anthropic-beta': betas.join(','),
         'user-agent': 'claude-cli/2.0.46 (external, cli)',
         'x-app': 'cli',
         // Stainless SDK telemetry headers (required for OAuth)
         'x-stainless-arch': 'x64',
         'x-stainless-lang': 'js',
         'x-stainless-os': 'Linux',
         'x-stainless-package-version': '0.60.0',
         'x-stainless-retry-count': '1',
         'x-stainless-runtime': 'node',
         'x-stainless-runtime-version': 'v24.3.0',
      }
   } else {
      // Standard API key auth
      return {
         'anthropic-version': '2023-06-01',
         'x-api-key': auth.apiKey,
         accept: 'application/json',
         'content-type': 'application/json',
         'anthropic-beta': betas.join(','),
      }
   }
}

/**
 * Build API URL (OAuth requires ?beta=true)
 */
function buildUrl(auth: AuthConfig): string {
   const base = `${auth.baseUrl}/v1/messages`
   return auth.isOAuth ? `${base}?beta=true` : base
}

// Response types
interface WebSearchResult {
   type: 'web_search_result'
   title: string
   url: string
   encrypted_content: string
   page_age: string | null
}

interface Citation {
   type: 'web_search_result_location'
   url: string
   title: string
   cited_text: string
   encrypted_index: string
}

interface ContentBlock {
   type: string
   text?: string
   citations?: Citation[]
   name?: string
   input?: { query: string }
   content?: WebSearchResult[]
}

interface ApiResponse {
   id: string
   model: string
   content: ContentBlock[]
   usage: {
      input_tokens: number
      output_tokens: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      server_tool_use?: { web_search_requests: number }
   }
}

/**
 * Call Anthropic API with web search
 */
async function callWebSearch(
   auth: AuthConfig,
   model: string,
   query: string,
   systemPrompt?: string,
   maxTokens?: number
): Promise<ApiResponse> {
   const url = buildUrl(auth)
   const headers = buildHeaders(auth)

   // Build system blocks
   const systemBlocks: Array<{ type: string; text: string; cache_control?: { type: string } }> = []

   if (auth.isOAuth) {
      // OAuth requires Claude Code identity with cache_control
      systemBlocks.push({
         type: 'text',
         text: "You are Claude Code, Anthropic's official CLI for Claude.",
         cache_control: { type: 'ephemeral' },
      })
   }

   if (systemPrompt) {
      systemBlocks.push({
         type: 'text',
         text: systemPrompt,
         ...(auth.isOAuth ? { cache_control: { type: 'ephemeral' } } : {}),
      })
   }

   const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens ?? 4096,
      messages: [{ role: 'user', content: query }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
   }

   if (systemBlocks.length > 0) {
      body.system = systemBlocks
   }

   const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
   })

   if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`)
   }

   return response.json() as Promise<ApiResponse>
}

/**
 * Format response for display
 */
function formatResponse(response: ApiResponse): { text: string; details: unknown } {
   const parts: string[] = []
   const searchQueries: string[] = []
   const sources: Array<{ title: string; url: string; age: string | null }> = []
   const citations: Citation[] = []

   for (const block of response.content) {
      if (block.type === 'server_tool_use' && block.name === 'web_search') {
         searchQueries.push(block.input?.query ?? '')
      } else if (block.type === 'web_search_tool_result' && block.content) {
         for (const result of block.content) {
            if (result.type === 'web_search_result') {
               sources.push({
                  title: result.title,
                  url: result.url,
                  age: result.page_age,
               })
            }
         }
      } else if (block.type === 'text' && block.text) {
         parts.push(block.text)
         if (block.citations) {
            citations.push(...block.citations)
         }
      }
   }

   let text = parts.join('\n\n')

   // Add sources
   if (sources.length > 0) {
      text += '\n\n## Sources'
      for (const [i, src] of sources.entries()) {
         const age = src.age ? ` (${src.age})` : ''
         text += `\n[${i + 1}] ${src.title}${age}\n    ${src.url}`
      }
   }

   return {
      text,
      details: {
         model: response.model,
         usage: response.usage,
         searchQueries,
         sources,
         citations: citations.map(c => ({
            url: c.url,
            title: c.title,
            citedText: c.cited_text,
         })),
      },
   }
}

// Tool schema
const SearchSchema = Type.Object({
   query: Type.String({
      description: 'The search query or question to answer using web search',
   }),
   system_prompt: Type.Optional(
      Type.String({
         description: 'System prompt to guide the response style and focus',
      })
   ),
   max_tokens: Type.Optional(
      Type.Number({
         description: 'Maximum tokens in response (default: 4096)',
         minimum: 1,
         maximum: 16384,
      })
   ),
})

type SearchParams = {
   query: string
   system_prompt?: string
   max_tokens?: number
}

// Tree formatting helpers
const TREE_MID = '├─'
const TREE_END = '└─'
const TREE_PIPE = '│'
const TREE_SPACE = ' '
const TREE_HOOK = '⎿'

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
 * Format age string (e.g. "2 days ago", "3 weeks ago")
 */
function formatAge(ageSeconds: number | null | undefined): string {
   if (!ageSeconds) return ''
   const mins = Math.floor(ageSeconds / 60)
   const hours = Math.floor(mins / 60)
   const days = Math.floor(hours / 24)
   const weeks = Math.floor(days / 7)
   const months = Math.floor(days / 30)

   if (months > 0) return `${months}mo ago`
   if (weeks > 0) return `${weeks}w ago`
   if (days > 0) return `${days}d ago`
   if (hours > 0) return `${hours}h ago`
   if (mins > 0) return `${mins}m ago`
   return 'just now'
}

/**
 * Get first N lines of text as preview
 */
function getPreviewLines(text: string, maxLines: number, maxLineLen: number): string[] {
   const lines = text.split('\n').filter(l => l.trim())
   return lines.slice(0, maxLines).map(l => truncate(l.trim(), maxLineLen))
}

interface RenderDetails {
   model?: string
   usage?: { input_tokens: number; output_tokens: number }
   sources?: Array<{ title: string; url: string; age?: string | null; age_seconds?: number }>
   error?: string
}

const factory: CustomToolFactory = async (_toolApi: ToolAPI): Promise<CustomAgentTool<TSchema, unknown>[] | null> => {
   const auth = findAuthConfig()
   if (!auth) {
      console.error('anthropic-websearch: No auth config found. Set ANTHROPIC_SEARCH_API_KEY or configure models.json/auth.json')
      return null
   }

   const model = getConfig('model') ?? DEFAULT_MODEL

   const tool: CustomAgentTool<typeof SearchSchema, unknown> = {
      name: 'anthropic_web_search',
      label: 'Anthropic Web Search',
      description: `Web search powered by Claude (${model}). Uses Claude's built-in web search capability to find current information and synthesize answers with citations. Best for questions requiring up-to-date information from the web.`,
      parameters: SearchSchema,
      async execute(_toolCallId, params) {
         try {
            const p = (params ?? {}) as SearchParams
            const response = await callWebSearch(auth, model, p.query, p.system_prompt, p.max_tokens)
            const { text, details } = formatResponse(response)
            return {
               content: [{ type: 'text' as const, text }],
               details,
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
         const details = result.details as RenderDetails | undefined

         // Handle error case
         if (details?.error) {
            return new Text(theme.fg('error', `Error: ${details.error}`), 0, 0)
         }

         const sources = details?.sources ?? []
         const sourceCount = sources.length
         const modelName = details?.model ?? model

         // Build header: ● Web Search (model) · N sources
         const icon = sourceCount > 0 ? theme.fg('success', '●') : theme.fg('warning', '●')
         const expandHint = expanded ? '' : theme.fg('dim', ' (Ctrl+O to expand)')
         let text = `${icon} ${theme.fg('toolTitle', 'Web Search')} ${theme.fg('dim', `(${modelName})`)} · ${theme.fg('dim', `${sourceCount} source${sourceCount !== 1 ? 's' : ''}`)}${expandHint}`

         // Get answer text from content
         const contentText = result.content[0]?.type === 'text' ? result.content[0].text : ''

         if (!expanded) {
            // Collapsed view: show 2-3 preview lines of answer
            const previewLines = getPreviewLines(contentText, 3, 100)
            for (const line of previewLines) {
               text += `\n ${theme.fg('dim', TREE_PIPE)}  ${theme.fg('dim', line)}`
            }
            const totalLines = contentText.split('\n').filter(l => l.trim()).length
            if (totalLines > 3) {
               text += `\n ${theme.fg('dim', TREE_PIPE)}  ${theme.fg('muted', `… ${totalLines - 3} more lines`)}`
            }

            // Show source count summary
            if (sourceCount > 0) {
               text += `\n ${theme.fg('dim', TREE_END)} ${theme.fg('muted', `${sourceCount} source${sourceCount !== 1 ? 's' : ''}`)}`
            }
         } else {
            // Expanded view: full answer + source tree
            const answerLines = contentText.split('\n')
            for (const line of answerLines) {
               text += `\n ${theme.fg('dim', TREE_PIPE)}  ${line}`
            }

            // Render sources as tree
            if (sourceCount > 0) {
               text += `\n ${theme.fg('dim', TREE_PIPE)}`
               text += `\n ${theme.fg('dim', TREE_END)} ${theme.fg('accent', 'Sources')}`

               for (let i = 0; i < sources.length; i++) {
                  const src = sources[i]
                  const isLast = i === sources.length - 1
                  const branch = isLast ? TREE_END : TREE_MID
                  const cont = isLast ? TREE_SPACE : TREE_PIPE

                  // Title + domain + age
                  const title = truncate(src.title, 60)
                  const domain = getDomain(src.url)
                  const ageStr = src.age ?? (src.age_seconds ? formatAge(src.age_seconds) : '')
                  const agePart = ageStr ? theme.fg('muted', ` · ${ageStr}`) : ''

                  text += `\n    ${theme.fg('dim', branch)} ${theme.fg('accent', title)} ${theme.fg('dim', `(${domain})`)}${agePart}`
                  text += `\n    ${theme.fg('dim', `${cont}  ${TREE_HOOK} `)}${theme.fg('link', src.url)}`
               }
            }
         }

         return new Text(text, 0, 0)
      },
   }

   return [tool]
}

export default factory
