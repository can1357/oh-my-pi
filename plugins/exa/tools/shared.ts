/**
 * Shared utilities for Exa MCP tools
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CustomAgentTool } from '@mariozechner/pi-coding-agent'
import type { TSchema } from '@sinclair/typebox'

// MCP endpoints
export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
export const WEBSETS_MCP_URL = 'https://websetsmcp.exa.ai/mcp'

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
      console.error(`Failed to fetch Exa tools:`, error)
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
      console.error(`Failed to fetch Websets tools:`, error)
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

/**
 * Create a tool wrapper for an MCP tool
 */
export function createToolWrapper(
   mcpTool: MCPTool,
   renamedName: string,
   callFn: (toolName: string, args: Record<string, unknown>) => Promise<unknown>
): CustomAgentTool<TSchema, unknown> {
   return {
      name: renamedName,
      label: renamedName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      description: mcpTool.description,
      parameters: normalizeInputSchema(mcpTool.inputSchema) as TSchema,
      async execute(_toolCallId, params) {
         try {
            const result = await callFn(mcpTool.name, (params ?? {}) as Record<string, unknown>)
            const text = typeof result === 'string' ? result : result == null ? 'null' : (JSON.stringify(result, null, 2) ?? String(result))
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
   }
}
