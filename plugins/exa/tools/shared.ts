/**
 * Shared utilities for Exa MCP tools
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CustomAgentTool } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import type { TSchema } from '@sinclair/typebox'

// MCP endpoints
export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
export const WEBSETS_MCP_URL = 'https://websetsmcp.exa.ai/mcp'

// Log paths
const EXA_ERROR_LOG = path.join(os.homedir(), '.pi', 'exa_errors.log')
const VIEW_ERROR_LOG = path.join(os.homedir(), '.pi', 'view_errors.log')

function logExaError(msg: string): void {
   fs.appendFileSync(EXA_ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`)
}

function logViewError(msg: string): void {
   fs.appendFileSync(VIEW_ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`)
}

export interface MCPTool {
   name: string
   description: string
   inputSchema: TSchema
}

interface MCPToolsResponse {
   result?: {
      tools: MCPTool[]
   }
   error?: {
      code: number
      message: string
   }
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
   if (!schema || typeof schema !== 'object') {
      return { type: 'object', properties: {}, required: [] }
   }

   const normalized = { ...(schema as Record<string, unknown>) }

   if (!('type' in normalized)) {
      normalized.type = 'object'
   }

   if (!('properties' in normalized)) {
      normalized.properties = {}
   }

   const required = (normalized as { required?: unknown }).required
   if (!Array.isArray(required)) {
      normalized.required = []
   }

   return normalized
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
 * Find EXA_API_KEY from environment or .env files
 */
export function findApiKey(): string | null {
   // 1. Check environment variable
   if (process.env.EXA_API_KEY) {
      return process.env.EXA_API_KEY
   }

   // 2. Check .env in current directory
   const localEnv = parseEnvFile(path.join(process.cwd(), '.env'))
   if (localEnv.EXA_API_KEY) {
      return localEnv.EXA_API_KEY
   }

   // 3. Check ~/.env
   const homeEnv = parseEnvFile(path.join(os.homedir(), '.env'))
   if (homeEnv.EXA_API_KEY) {
      return homeEnv.EXA_API_KEY
   }

   return null
}

/**
 * Call an MCP server endpoint
 */
async function callMCP(url: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
   const body = {
      jsonrpc: '2.0',
      method,
      params: params ?? {},
      id: 1,
   }

   const response = await fetch(url, {
      method: 'POST',
      headers: {
         'Content-Type': 'application/json',
         Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
   })

   const text = await response.text()

   // Parse SSE response format
   let jsonData: string | null = null
   for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
         jsonData = line.slice(6)
         break
      }
   }

   if (!jsonData) {
      // Try parsing as plain JSON
      try {
         return JSON.parse(text)
      } catch {
         throw new Error(`Failed to parse MCP response: ${text.slice(0, 500)}`)
      }
   }

   return JSON.parse(jsonData)
}

/**
 * Fetch available tools from Exa MCP server
 */
export async function fetchExaTools(apiKey: string, toolNames: string[]): Promise<MCPTool[]> {
   const url = `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(apiKey)}&tools=${encodeURIComponent(toolNames.join(','))}`

   try {
      const response = (await callMCP(url, 'tools/list')) as MCPToolsResponse
      if (response.error) {
         throw new Error(response.error.message)
      }
      return response.result?.tools ?? []
   } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logExaError(`Failed to fetch Exa tools: ${msg}`)
      return []
   }
}

/**
 * Fetch available tools from Websets MCP server
 */
export async function fetchWebsetsTools(apiKey: string): Promise<MCPTool[]> {
   const url = `${WEBSETS_MCP_URL}?exaApiKey=${encodeURIComponent(apiKey)}`

   try {
      const response = (await callMCP(url, 'tools/list')) as MCPToolsResponse
      if (response.error) {
         throw new Error(response.error.message)
      }
      return response.result?.tools ?? []
   } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logExaError(`Failed to fetch Websets tools: ${msg}`)
      return []
   }
}

/**
 * Call a tool on Exa MCP server
 */
export async function callExaTool(apiKey: string, toolNames: string[], toolName: string, args: Record<string, unknown>): Promise<unknown> {
   const url = `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(apiKey)}&tools=${encodeURIComponent(toolNames.join(','))}`
   return callMCPTool(url, toolName, args)
}

/**
 * Call a tool on Websets MCP server
 */
export async function callWebsetsTool(apiKey: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
   const url = `${WEBSETS_MCP_URL}?exaApiKey=${encodeURIComponent(apiKey)}`
   return callMCPTool(url, toolName, args)
}

/**
 * Call a tool on an MCP server
 */
async function callMCPTool(url: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
   const response = (await callMCP(url, 'tools/call', {
      name: toolName,
      arguments: args,
   })) as {
      result?: { content?: Array<{ text?: string }> }
      error?: { message: string }
   }

   if (response.error) {
      throw new Error(response.error.message)
   }

   // Extract text content from MCP response
   const content = response.result?.content
   if (Array.isArray(content)) {
      const texts = content.filter(c => c.text).map(c => c.text)
      if (texts.length === 1) {
         // Try to parse as JSON
         try {
            return JSON.parse(texts[0]!)
         } catch {
            return texts[0]
         }
      }
      return texts.join('\n\n')
   }

   return response.result
}

interface SearchResult {
   id?: string
   title?: string
   url?: string
   author?: string
   publishedDate?: string
   text?: string
   image?: string
   favicon?: string
}

interface SearchResponse {
   results?: SearchResult[]
   statuses?: Array<{ id: string; status: string; source?: string }>
   costDollars?: { total: number }
   searchTime?: number
   requestId?: string
}

/**
 * Format search results as readable markdown (for LLM consumption)
 */
function formatSearchResults(data: SearchResponse): string {
   const lines: string[] = []

   if (data.results && data.results.length > 0) {
      for (const result of data.results) {
         // Title with link
         if (result.title && result.url) {
            lines.push(`### [${result.title}](${result.url})`)
         } else if (result.title) {
            lines.push(`### ${result.title}`)
         } else if (result.url) {
            lines.push(`### ${result.url}`)
         }

         // Author if present
         if (result.author) {
            lines.push(`*by ${result.author}*`)
         }

         lines.push('')

         // Content - truncate if very long
         if (result.text) {
            const text = result.text.trim()
            const maxLen = 2000
            if (text.length > maxLen) {
               lines.push(`${text.slice(0, maxLen)}...`)
            } else {
               lines.push(text)
            }
         }

         lines.push('')
         lines.push('---')
         lines.push('')
      }
   }

   // Footer with metadata
   const meta: string[] = []
   if (data.results) meta.push(`${data.results.length} result(s)`)
   if (data.searchTime) meta.push(`${(data.searchTime / 1000).toFixed(2)}s`)
   if (data.costDollars?.total) meta.push(`$${data.costDollars.total.toFixed(4)}`)

   if (meta.length > 0) {
      lines.push(`*${meta.join(' • ')}*`)
   }

   return lines.join('\n')
}

/**
 * Check if result looks like a search response
 */
function isSearchResponse(data: unknown): data is SearchResponse {
   if (!data || typeof data !== 'object') return false
   const obj = data as Record<string, unknown>
   return Array.isArray(obj.results) || 'searchTime' in obj || 'costDollars' in obj
}

/**
 * Parse Exa's markdown text format into a SearchResponse structure
 * Format: Title: ...\nURL: ...\nAuthor: ...\nPublished Date: ...\nText: ...\n\n (repeated)
 */
function parseExaMarkdown(text: string): SearchResponse | null {
   const results: SearchResult[] = []

   // Split by double newlines to separate results, but be careful with Text: blocks
   // Each result starts with "Title:"
   const parts = text.split(/\n(?=Title:)/g)

   for (const part of parts) {
      if (!part.trim()) continue

      const result: SearchResult = {}
      const lines = part.split('\n')

      let currentField: string | null = null
      let textLines: string[] = []

      for (const line of lines) {
         // Check for field prefixes
         if (line.startsWith('Title: ')) {
            result.title = line.slice(7).trim()
            currentField = null
         } else if (line.startsWith('URL: ')) {
            result.url = line.slice(5).trim()
            currentField = null
         } else if (line.startsWith('Author: ')) {
            result.author = line.slice(8).trim()
            currentField = null
         } else if (line.startsWith('Published Date: ')) {
            result.publishedDate = line.slice(16).trim()
            currentField = null
         } else if (line.startsWith('Text: ')) {
            textLines = [line.slice(6)]
            currentField = 'text'
         } else if (currentField === 'text') {
            textLines.push(line)
         }
      }

      if (textLines.length > 0) {
         result.text = textLines.join('\n').trim()
      }

      if (result.title || result.url) {
         results.push(result)
      }
   }

   if (results.length === 0) return null
   return { results }
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
 * Get first N lines of text as preview
 */
function getPreviewLines(text: string, maxLines: number, maxLineLen: number): string[] {
   const lines = text.split('\n').filter(l => l.trim())
   return lines.slice(0, maxLines).map(l => truncate(l.trim(), maxLineLen))
}

/**
 * Create a tool wrapper for an MCP tool
 */
export function createToolWrapper(
   mcpTool: MCPTool,
   renamedName: string,
   callFn: (toolName: string, args: Record<string, unknown>) => Promise<unknown>
): CustomAgentTool<TSchema, SearchResponse | { error: string } | unknown> {
   return {
      name: renamedName,
      label: renamedName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      description: mcpTool.description,
      parameters: normalizeInputSchema(mcpTool.inputSchema) as TSchema,

      async execute(_toolCallId, params) {
         try {
            const result = await callFn(mcpTool.name, (params ?? {}) as Record<string, unknown>)

            let text: string
            if (typeof result === 'string') {
               text = result
            } else if (result == null) {
               text = 'No results'
            } else if (isSearchResponse(result)) {
               text = formatSearchResults(result)
            } else {
               text = JSON.stringify(result, null, 2) ?? String(result)
            }

            return {
               content: [{ type: 'text' as const, text }],
               details: result,
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
         let { details } = result

         // Handle error case
         if (details && typeof details === 'object' && 'error' in details) {
            const errDetails = details as { error: string }
            return new Text(theme.fg('error', `Error: ${errDetails.error}`), 0, 0)
         }

         // If details is a string (Exa markdown format), try to parse it
         if (typeof details === 'string') {
            const parsed = parseExaMarkdown(details)
            if (parsed) {
               details = parsed
            }
         }

         // Handle non-search responses (plain text/JSON)
         if (!isSearchResponse(details)) {
            const text = result.content[0]
            if (text?.type === 'text') {
               // For non-search content, show truncated in collapsed, full in expanded
               if (expanded) {
                  return new Text(text.text, 0, 0)
               }
               const preview = getPreviewLines(text.text, 5, 100)
               const lines = preview.map(l => theme.fg('dim', l)).join('\n')
               return new Text(lines + (text.text.split('\n').length > 5 ? theme.fg('muted', '\n  …') : ''), 0, 0)
            }
            return new Text('', 0, 0)
         }

         // Search response - render as tree
         const data = details as SearchResponse
         const resultCount = data.results?.length ?? 0

         // Build header with metadata
         const meta: string[] = []
         meta.push(`${resultCount} result${resultCount !== 1 ? 's' : ''}`)
         if (data.searchTime) meta.push(`${(data.searchTime / 1000).toFixed(2)}s`)
         if (data.costDollars?.total) meta.push(`$${data.costDollars.total.toFixed(4)}`)

         const icon = resultCount > 0 ? theme.fg('success', '●') : theme.fg('warning', '●')
         const expandHint = expanded ? '' : theme.fg('dim', ' (Ctrl+O to expand)')
         let text = `${icon} ${theme.fg('toolTitle', 'Web Search')} ${theme.fg('dim', meta.join(' • '))}${expandHint}`

         if (!data.results || data.results.length === 0) {
            text += `\n ${theme.fg('dim', TREE_END)} ${theme.fg('muted', 'No results found')}`
            return new Text(text, 0, 0)
         }

         // Render each result
         try {
            for (let i = 0; i < data.results.length; i++) {
               const r = data.results[i]
               const isLast = i === data.results.length - 1
               const branch = isLast ? TREE_END : TREE_MID
               const cont = isLast ? TREE_SPACE : TREE_PIPE

               // Title line
               const title = r.title ? truncate(r.title, 80) : 'Untitled'
               const domain = r.url ? getDomain(r.url) : ''
               text += `\n ${theme.fg('dim', branch)} ${theme.fg('accent', title)}`
               if (domain) {
                  text += theme.fg('dim', ` (${domain})`)
               }

               // URL line (if different from domain)
               if (r.url) {
                  text += `\n ${theme.fg('dim', `${cont}  ${TREE_HOOK} `)}${theme.fg('link', r.url)}`
               }

               // Author/date metadata
               const metaParts: string[] = []
               if (r.author) metaParts.push(`by ${r.author}`)
               if (r.publishedDate) {
                  try {
                     const date = new Date(r.publishedDate)
                     metaParts.push(date.toLocaleDateString())
                  } catch {
                     // ignore invalid dates
                  }
               }
               if (metaParts.length > 0) {
                  text += `\n ${theme.fg('dim', `${cont}     `)}${theme.fg('muted', metaParts.join(' • '))}`
               }

               // Content preview (collapsed) or full content (expanded)
               if (r.text) {
                  if (expanded) {
                     // Show full content with proper indentation
                     const lines = r.text.split('\n')
                     for (const line of lines) {
                        if (line.trim()) {
                           text += `\n ${theme.fg('dim', `${cont}     `)}${theme.fg('dim', line)}`
                        }
                     }
                  } else {
                     // Show preview (first 2 non-empty lines)
                     const preview = getPreviewLines(r.text, 2, 100)
                     for (const line of preview) {
                        text += `\n ${theme.fg('dim', `${cont}     `)}${theme.fg('dim', line)}`
                     }
                     const totalLines = r.text.split('\n').filter(l => l.trim()).length
                     if (totalLines > 2) {
                        text += `\n ${theme.fg('dim', `${cont}     `)}${theme.fg('muted', `… ${totalLines - 2} more lines`)}`
                     }
                  }
               }
            }
         } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            logViewError(`exa renderResult error: ${msg}`)
         }

         return new Text(text, 0, 0)
      },
   }
}
