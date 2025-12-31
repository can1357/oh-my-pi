/**
 * Exa Tools - Web search and websets via Exa MCP servers
 *
 * Exposes tools from:
 *   - https://mcp.exa.ai/mcp (Exa Search MCP)
 *   - https://websetsmcp.exa.ai/mcp (Websets MCP)
 *
 * Looks for EXA_API_KEY in:
 *   1. Environment variable
 *   2. .env in current directory
 *   3. ~/.env
 *
 * Tools exposed (all prefixed with web_search_ to indicate web searching capability):
 *   Exa Search:
 *     - web_search_general: Real-time web searches
 *     - web_search_code_context: Code search for libraries, docs, examples
 *     - web_search_deep: Natural language web search
 *     - web_search_crawl_url: Extract content from specific URLs
 *     - web_search_company_research: Research companies
 *     - web_search_linkedin: Search LinkedIn profiles/companies
 *     - web_search_researcher_start: Start comprehensive AI research
 *     - web_search_researcher_check: Check research task status
 *
 *   Websets (web-based entity collections):
 *     - webset_create: Create entity collections with search/enrichments
 *     - webset_list: List all websets
 *     - webset_get: Get webset details
 *     - webset_update: Update webset metadata
 *     - webset_delete: Delete a webset
 *     - webset_items_list: List items in a webset
 *     - webset_item_get: Get item details
 *     - webset_search_create: Add search to webset
 *     - webset_search_get: Check search status
 *     - webset_search_cancel: Cancel running search
 *     - webset_enrichment_create: Extract custom data from items
 *     - webset_enrichment_get: Get enrichment details
 *     - webset_enrichment_update: Update enrichment metadata
 *     - webset_enrichment_delete: Delete enrichment
 *     - webset_enrichment_cancel: Cancel running enrichment
 *     - webset_monitor_create: Auto-update webset on schedule
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type TSchema } from "@sinclair/typebox";
import type { CustomAgentTool, CustomToolFactory, ToolAPI } from "@mariozechner/pi-coding-agent";

// MCP endpoints
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const WEBSETS_MCP_URL = "https://websetsmcp.exa.ai/mcp";

// All available Exa tools
const EXA_TOOLS = [
   "web_search_exa",
   "deep_search_exa",
   "get_code_context_exa",
   "crawling_exa",
   "company_research_exa",
   "linkedin_search_exa",
   "deep_researcher_start",
   "deep_researcher_check",
];

// Tool name mapping: original MCP name -> new web_search prefixed name
const TOOL_NAME_MAP: Record<string, string> = {
   // Exa Search tools
   "web_search_exa": "web_search_general",
   "deep_search_exa": "web_search_deep",
   "get_code_context_exa": "web_search_code_context",
   "crawling_exa": "web_search_crawl_url",
   "company_research_exa": "web_search_company_research",
   "linkedin_search_exa": "web_search_linkedin",
   "deep_researcher_start": "web_search_researcher_start",
   "deep_researcher_check": "web_search_researcher_check",
   // Websets tools
   "create_webset": "webset_create",
   "list_websets": "webset_list",
   "get_webset": "webset_get",
   "update_webset": "webset_update",
   "delete_webset": "webset_delete",
   "list_webset_items": "webset_items_list",
   "get_item": "webset_item_get",
   "create_search": "webset_search_create",
   "get_search": "webset_search_get",
   "cancel_search": "webset_search_cancel",
   "create_enrichment": "webset_enrichment_create",
   "get_enrichment": "webset_enrichment_get",
   "update_enrichment": "webset_enrichment_update",
   "delete_enrichment": "webset_enrichment_delete",
   "cancel_enrichment": "webset_enrichment_cancel",
   "create_monitor": "webset_monitor_create",
};

interface MCPTool {
   name: string;
   description: string;
   inputSchema: TSchema;
}

interface MCPToolsResponse {
   result?: {
      tools: MCPTool[];
   };
   error?: {
      code: number;
      message: string;
   };
}

/**
 * Parse a .env file and return key-value pairs
 */
function parseEnvFile(filePath: string): Record<string, string> {
   const result: Record<string, string> = {};
   if (!fs.existsSync(filePath)) return result;

   try {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const line of content.split("\n")) {
         const trimmed = line.trim();
         if (!trimmed || trimmed.startsWith("#")) continue;

         const eqIndex = trimmed.indexOf("=");
         if (eqIndex === -1) continue;

         const key = trimmed.slice(0, eqIndex).trim();
         let value = trimmed.slice(eqIndex + 1).trim();

         // Remove surrounding quotes
         if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
         }

         result[key] = value;
      }
   } catch {
      // Ignore read errors
   }

   return result;
}

/**
 * Find EXA_API_KEY from environment or .env files
 */
function findApiKey(): string | null {
   // 1. Check environment variable
   if (process.env.EXA_API_KEY) {
      return process.env.EXA_API_KEY;
   }

   // 2. Check .env in current directory
   const localEnv = parseEnvFile(path.join(process.cwd(), ".env"));
   if (localEnv.EXA_API_KEY) {
      return localEnv.EXA_API_KEY;
   }

   // 3. Check ~/.env
   const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"));
   if (homeEnv.EXA_API_KEY) {
      return homeEnv.EXA_API_KEY;
   }

   return null;
}

/**
 * Call an MCP server endpoint
 */
async function callMCP(url: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
   const body = {
      jsonrpc: "2.0",
      method,
      params: params ?? {},
      id: 1,
   };

   const response = await fetch(url, {
      method: "POST",
      headers: {
         "Content-Type": "application/json",
         Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
   });

   const text = await response.text();

   // Parse SSE response format
   let jsonData: string | null = null;
   for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
         jsonData = line.slice(6);
         break;
      }
   }

   if (!jsonData) {
      // Try parsing as plain JSON
      try {
         return JSON.parse(text);
      } catch {
         throw new Error(`Failed to parse MCP response: ${text.slice(0, 500)}`);
      }
   }

   return JSON.parse(jsonData);
}

/**
 * Fetch available tools from an MCP server
 */
async function fetchMCPTools(baseUrl: string, apiKey: string): Promise<MCPTool[]> {
   // Build URL with API key and all tools enabled
   let url: string;
   if (baseUrl === EXA_MCP_URL) {
      url = `${baseUrl}?exaApiKey=${apiKey}&tools=${EXA_TOOLS.join(",")}`;
   } else {
      url = `${baseUrl}?exaApiKey=${apiKey}`;
   }

   try {
      const response = (await callMCP(url, "tools/list")) as MCPToolsResponse;
      if (response.error) {
         throw new Error(response.error.message);
      }
      return response.result?.tools ?? [];
   } catch (error) {
      console.error(`Failed to fetch tools from ${baseUrl}:`, error);
      return [];
   }
}

/**
 * Call a tool on an MCP server
 */
async function callMCPTool(baseUrl: string, apiKey: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
   let url: string;
   if (baseUrl === EXA_MCP_URL) {
      url = `${baseUrl}?exaApiKey=${apiKey}&tools=${EXA_TOOLS.join(",")}`;
   } else {
      url = `${baseUrl}?exaApiKey=${apiKey}`;
   }

   const response = (await callMCP(url, "tools/call", {
      name: toolName,
      arguments: args,
   })) as { result?: { content?: Array<{ text?: string }> }; error?: { message: string } };

   if (response.error) {
      throw new Error(response.error.message);
   }

   // Extract text content from MCP response
   const content = response.result?.content;
   if (Array.isArray(content)) {
      const texts = content.filter((c) => c.text).map((c) => c.text);
      if (texts.length === 1) {
         // Try to parse as JSON
         try {
            return JSON.parse(texts[0]!);
         } catch {
            return texts[0];
         }
      }
      return texts.join("\n\n");
   }

   return response.result;
}

/**
 * Create a tool wrapper for an MCP tool with renamed tool name
 */
function createToolWrapper(
   mcpTool: MCPTool,
   baseUrl: string,
   apiKey: string
): CustomAgentTool<TSchema, unknown> {
   // Use the mapped name if available, otherwise keep original
   const renamedName = TOOL_NAME_MAP[mcpTool.name] ?? mcpTool.name;
   
   return {
      name: renamedName,
      description: mcpTool.description,
      parameters: mcpTool.inputSchema,
      async execute(args) {
         // Call the MCP server with the ORIGINAL tool name
         return callMCPTool(baseUrl, apiKey, mcpTool.name, args as Record<string, unknown>);
      },
   };
}

/**
 * Build the tool description with all available tools listed
 */
function buildDescription(exaTools: MCPTool[], websetsTools: MCPTool[]): string {
   const lines = [
      "Exa AI tools for web search, code context, and websets management.",
      "",
      "This tool provides access to Exa's AI-powered search and data collection capabilities.",
      "",
   ];

   if (exaTools.length > 0) {
      lines.push("**Search Tools:**");
      for (const tool of exaTools) {
         lines.push(`- \`${tool.name}\`: ${tool.description.split(".")[0]}`);
      }
      lines.push("");
   }

   if (websetsTools.length > 0) {
      lines.push("**Websets Tools:**");
      for (const tool of websetsTools) {
         lines.push(`- \`${tool.name}\`: ${tool.description.split(".")[0]}`);
      }
      lines.push("");
   }

   lines.push("Use the `tool` parameter to specify which tool to invoke, then provide the tool-specific arguments.");

   return lines.join("\n");
}

// Cache for MCP tools
let cachedExaTools: MCPTool[] | null = null;
let cachedWebsetsTools: MCPTool[] | null = null;
let cachedApiKey: string | null = null;

/**
 * Factory function that creates the Exa tools
 */
const factory: CustomToolFactory = async (_toolApi: ToolAPI): Promise<CustomAgentTool<TSchema, unknown>[] | null> => {
   const apiKey = findApiKey();
   if (!apiKey) {
      // No API key found, don't register tools
      return null;
   }

   // Fetch tools from both MCP servers (with caching)
   if (cachedApiKey !== apiKey || !cachedExaTools || !cachedWebsetsTools) {
      const [exaTools, websetsTools] = await Promise.all([
         fetchMCPTools(EXA_MCP_URL, apiKey),
         fetchMCPTools(WEBSETS_MCP_URL, apiKey),
      ]);
      cachedExaTools = exaTools;
      cachedWebsetsTools = websetsTools;
      cachedApiKey = apiKey;
   }

   const allTools: CustomAgentTool<TSchema, unknown>[] = [];

   // Create wrapper tools for Exa MCP
   for (const mcpTool of cachedExaTools) {
      allTools.push(createToolWrapper(mcpTool, EXA_MCP_URL, apiKey));
   }

   // Create wrapper tools for Websets MCP
   for (const mcpTool of cachedWebsetsTools) {
      allTools.push(createToolWrapper(mcpTool, WEBSETS_MCP_URL, apiKey));
   }

   // If no tools were fetched, return null
   if (allTools.length === 0) {
      return null;
   }

   return allTools;
};

export default factory;
