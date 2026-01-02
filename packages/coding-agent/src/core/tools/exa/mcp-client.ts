/**
 * Exa MCP Client
 *
 * Client for interacting with Exa MCP servers via JSON-RPC 2.0 over HTTPS.
 */

import type { TSchema } from "@sinclair/typebox";
import type { CustomTool } from "../../custom-tools/types.js";
import { logExaError } from "./logger.js";
import type {
	ExaRenderDetails,
	ExaSearchResponse,
	ExaSearchResult,
	MCPCallResponse,
	MCPTool,
	MCPToolsResponse,
	MCPToolWrapperConfig,
} from "./types.js";

/** Find EXA_API_KEY from process.env or .env files */
export async function findApiKey(): Promise<string | null> {
	// Check process.env first
	if (process.env.EXA_API_KEY) {
		return process.env.EXA_API_KEY;
	}

	// Try loading from .env files in cwd and home
	const cwd = process.cwd();
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";

	for (const dir of [cwd, home]) {
		const envPath = `${dir}/.env`;
		try {
			const file = Bun.file(envPath);
			if (await file.exists()) {
				const content = await file.text();
				const match = content.match(/^EXA_API_KEY=(.+)$/m);
				if (match?.[1]) {
					return match[1].trim().replace(/^["']|["']$/g, "");
				}
			}
		} catch {
			// Ignore read errors
		}
	}

	return null;
}

/** Parse SSE response format (lines starting with "data: ") */
function parseSSE(text: string): unknown {
	const lines = text.split("\n");
	for (const line of lines) {
		if (line.startsWith("data: ")) {
			const data = line.slice(6).trim();
			if (data === "[DONE]") continue;
			try {
				return JSON.parse(data);
			} catch {
				// Try next line
			}
		}
	}
	// Fallback: try parsing entire response as JSON
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Call MCP server with JSON-RPC 2.0 */
export async function callMCP(url: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
	const body = {
		jsonrpc: "2.0",
		id: Math.random().toString(36).slice(2),
		method,
		params: params ?? {},
	};

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorMsg = `MCP request failed: ${response.status} ${response.statusText}`;
		logExaError(errorMsg, { url, method, params });
		throw new Error(errorMsg);
	}

	const text = await response.text();
	const result = parseSSE(text);

	if (!result) {
		logExaError("Failed to parse MCP response", { url, method, responseText: text.slice(0, 500) });
		throw new Error("Failed to parse MCP response");
	}

	return result;
}

/** Fetch available tools from Exa MCP */
export async function fetchExaTools(apiKey: string, toolNames: string[]): Promise<MCPTool[]> {
	const url = `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(apiKey)}&toolNames=${encodeURIComponent(toolNames.join(","))}`;
	const response = (await callMCP(url, "tools/list")) as MCPToolsResponse;

	if (response.error) {
		logExaError("MCP tools/list error", { toolNames, error: response.error });
		throw new Error(`MCP error: ${response.error.message}`);
	}

	return response.result?.tools ?? [];
}

/** Fetch available tools from Websets MCP */
export async function fetchWebsetsTools(apiKey: string): Promise<MCPTool[]> {
	const url = `https://websetsmcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(apiKey)}`;
	const response = (await callMCP(url, "tools/list")) as MCPToolsResponse;

	if (response.error) {
		logExaError("Websets MCP tools/list error", { error: response.error });
		throw new Error(`MCP error: ${response.error.message}`);
	}

	return response.result?.tools ?? [];
}

/** Call a tool on Exa MCP (simplified: toolName as first arg for easier use) */
export async function callExaTool(toolName: string, args: Record<string, unknown>, apiKey: string): Promise<unknown> {
	const url = `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(apiKey)}&tools=${encodeURIComponent(toolName)}`;
	const response = (await callMCP(url, "tools/call", {
		name: toolName,
		arguments: args,
	})) as MCPCallResponse;

	if (response.error) {
		logExaError("MCP tools/call error", { toolName, args, error: response.error });
		throw new Error(`MCP error: ${response.error.message}`);
	}

	return response.result;
}

/** Call a tool on Websets MCP */
export async function callWebsetsTool(
	apiKey: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const url = `https://websetsmcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(apiKey)}`;
	const response = (await callMCP(url, "tools/call", {
		name: toolName,
		arguments: args,
	})) as MCPCallResponse;

	if (response.error) {
		logExaError("Websets MCP tools/call error", { toolName, args, error: response.error });
		throw new Error(`MCP error: ${response.error.message}`);
	}

	return response.result;
}

/** Parse Exa markdown format into SearchResponse */
export function parseExaMarkdown(text: string): ExaSearchResponse | null {
	const results: ExaSearchResult[] = [];
	const lines = text.split("\n");
	let currentResult: Partial<ExaSearchResult> | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// Match result header: ## Title
		if (line.startsWith("## ")) {
			if (currentResult?.title) {
				results.push(currentResult as ExaSearchResult);
			}
			currentResult = { title: line.slice(3).trim() };
			continue;
		}

		if (!currentResult) continue;

		// Match URL: **URL:** ...
		if (line.startsWith("**URL:**")) {
			currentResult.url = line.slice(8).trim();
			continue;
		}

		// Match Author: **Author:** ...
		if (line.startsWith("**Author:**")) {
			currentResult.author = line.slice(11).trim();
			continue;
		}

		// Match Published Date: **Published Date:** ...
		if (line.startsWith("**Published Date:**")) {
			currentResult.publishedDate = line.slice(19).trim();
			continue;
		}

		// Match Text: **Text:** ...
		if (line.startsWith("**Text:**")) {
			currentResult.text = line.slice(9).trim();
			continue;
		}

		// Accumulate text content
		if (currentResult.text && line && !line.startsWith("**")) {
			currentResult.text += ` ${line}`;
		}
	}

	// Add last result
	if (currentResult?.title) {
		results.push(currentResult as ExaSearchResult);
	}

	if (results.length === 0) return null;

	return {
		results,
		statuses: results.map((r, i) => ({ id: r.id ?? `result-${i}`, status: "success" })),
	};
}

/** Format search results for LLM */
export function formatSearchResults(data: ExaSearchResponse): string {
	const results = data.results ?? [];
	if (results.length === 0) return "No results found.";

	let output = "";
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		output += `\n## ${r.title ?? "Untitled"}`;
		if (r.url) output += `\n**URL:** ${r.url}`;
		if (r.author) output += `\n**Author:** ${r.author}`;
		if (r.publishedDate) output += `\n**Published Date:** ${r.publishedDate}`;
		if (r.text) output += `\n**Text:** ${r.text}`;
		if (r.highlights?.length) {
			output += `\n**Highlights:**`;
			for (const h of r.highlights) {
				output += `\n- ${h}`;
			}
		}
		output += "\n";
	}

	if (data.costDollars) {
		output += `\n**Cost:** $${data.costDollars.total.toFixed(4)}`;
	}
	if (data.searchTime) {
		output += `\n**Search Time:** ${data.searchTime.toFixed(2)}s`;
	}

	return output.trim();
}

/** Check if result is a search response */
export function isSearchResponse(data: unknown): data is ExaSearchResponse {
	return (
		typeof data === "object" &&
		data !== null &&
		("results" in data || "statuses" in data || "costDollars" in data || "searchTime" in data)
	);
}

/** Cache for MCP tool schemas (keyed by MCP tool name) */
const mcpSchemaCache = new Map<string, MCPTool>();

/** Fetch and cache MCP tool schema */
export async function fetchMCPToolSchema(
	apiKey: string,
	mcpToolName: string,
	isWebsetsTool = false,
): Promise<MCPTool | null> {
	const cacheKey = `${isWebsetsTool ? "websets" : "exa"}:${mcpToolName}`;
	if (mcpSchemaCache.has(cacheKey)) {
		return mcpSchemaCache.get(cacheKey)!;
	}

	try {
		const tools = isWebsetsTool ? await fetchWebsetsTools(apiKey) : await fetchExaTools(apiKey, [mcpToolName]);
		const tool = tools.find((t) => t.name === mcpToolName);
		if (tool) {
			mcpSchemaCache.set(cacheKey, tool);
			return tool;
		}
	} catch {
		// Fall through to return null
	}
	return null;
}

/**
 * Create a CustomTool dynamically from MCP tool metadata.
 *
 * This allows tools to be generated from MCP server schemas without hardcoding,
 * reducing drift when MCP servers add new parameters.
 */
export function createMCPWrappedTool(
	config: MCPToolWrapperConfig,
	schema: TSchema,
	description: string,
): CustomTool<TSchema, ExaRenderDetails> {
	return {
		name: config.name,
		label: config.label,
		description,
		parameters: schema,
		async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
			try {
				const apiKey = await findApiKey();
				if (!apiKey) {
					return {
						content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found" }],
						details: { error: "EXA_API_KEY not found", toolName: config.name },
					};
				}

				const response = config.isWebsetsTool
					? await callWebsetsTool(apiKey, config.mcpToolName, params as Record<string, unknown>)
					: await callExaTool(config.mcpToolName, params as Record<string, unknown>, apiKey);

				if (isSearchResponse(response)) {
					const formatted = formatSearchResults(response);
					return {
						content: [{ type: "text" as const, text: formatted }],
						details: { response, toolName: config.name },
					};
				}

				return {
					content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
					details: { raw: response, toolName: config.name },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
					details: { error: message, toolName: config.name },
				};
			}
		},
	};
}

/**
 * Create a CustomTool by fetching schema from MCP server.
 *
 * Falls back to provided fallback schema if MCP fetch fails.
 */
export async function createMCPToolFromServer(
	apiKey: string,
	config: MCPToolWrapperConfig,
	fallbackSchema: TSchema,
	fallbackDescription: string,
): Promise<CustomTool<TSchema, ExaRenderDetails>> {
	const mcpTool = await fetchMCPToolSchema(apiKey, config.mcpToolName, config.isWebsetsTool);
	const schema = mcpTool?.inputSchema ?? fallbackSchema;
	const description = mcpTool?.description ?? fallbackDescription;
	return createMCPWrappedTool(config, schema, description);
}
