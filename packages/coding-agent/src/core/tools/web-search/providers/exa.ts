/**
 * Exa Web Search Provider
 *
 * High-quality neural search via Exa MCP.
 * Returns structured search results with optional content extraction.
 */

import * as os from "node:os";
import type { WebSearchResponse, WebSearchSource } from "../types";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

export interface ExaSearchParams {
	query: string;
	num_results?: number;
	type?: "neural" | "keyword" | "auto";
	include_domains?: string[];
	exclude_domains?: string[];
	start_published_date?: string;
	end_published_date?: string;
}

/** Parse a .env file and return key-value pairs */
async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	try {
		const file = Bun.file(filePath);
		if (!(await file.exists())) return result;

		const content = await file.text();
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;

			const key = trimmed.slice(0, eqIndex).trim();
			let value = trimmed.slice(eqIndex + 1).trim();

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

/** Find EXA_API_KEY from environment or .env files */
export async function findApiKey(): Promise<string | null> {
	// 1. Check environment variable
	if (process.env.EXA_API_KEY) {
		return process.env.EXA_API_KEY;
	}

	// 2. Check .env in current directory
	const localEnv = await parseEnvFile(`${process.cwd()}/.env`);
	if (localEnv.EXA_API_KEY) {
		return localEnv.EXA_API_KEY;
	}

	// 3. Check ~/.env
	const homeEnv = await parseEnvFile(`${os.homedir()}/.env`);
	if (homeEnv.EXA_API_KEY) {
		return homeEnv.EXA_API_KEY;
	}

	return null;
}

/** Parse SSE response format */
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

interface MCPCallResponse {
	result?: {
		content?: Array<{ type: string; text?: string }>;
	};
	error?: {
		code: number;
		message: string;
	};
}

interface ExaSearchResult {
	title?: string;
	url?: string;
	author?: string;
	publishedDate?: string;
	text?: string;
	highlights?: string[];
}

interface ExaSearchResponse {
	results?: ExaSearchResult[];
	costDollars?: { total: number };
	searchTime?: number;
}

/** Call Exa MCP API */
async function callExaMCP(apiKey: string, toolName: string, args: Record<string, unknown>): Promise<MCPCallResponse> {
	const url = `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(apiKey)}&tools=${encodeURIComponent(toolName)}`;

	const body = {
		jsonrpc: "2.0",
		id: Math.random().toString(36).slice(2),
		method: "tools/call",
		params: {
			name: toolName,
			arguments: args,
		},
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
		const errorText = await response.text();
		throw new Error(`Exa MCP error (${response.status}): ${errorText}`);
	}

	const text = await response.text();
	const result = parseSSE(text);

	if (!result) {
		throw new Error("Failed to parse Exa MCP response");
	}

	return result as MCPCallResponse;
}

/** Parse MCP response content into ExaSearchResponse */
function parseMCPContent(content: Array<{ type: string; text?: string }>): ExaSearchResponse | null {
	for (const block of content) {
		if (block.type === "text" && block.text) {
			// Try to parse as JSON first
			try {
				return JSON.parse(block.text) as ExaSearchResponse;
			} catch {
				// Parse markdown format
				return parseExaMarkdown(block.text);
			}
		}
	}
	return null;
}

/** Parse Exa markdown format into ExaSearchResponse */
function parseExaMarkdown(text: string): ExaSearchResponse | null {
	const results: ExaSearchResult[] = [];
	const lines = text.split("\n");
	let currentResult: Partial<ExaSearchResult> | null = null;

	for (const line of lines) {
		const trimmed = line.trim();

		// Match result header: ## Title
		if (trimmed.startsWith("## ")) {
			if (currentResult?.title) {
				results.push(currentResult as ExaSearchResult);
			}
			currentResult = { title: trimmed.slice(3).trim() };
			continue;
		}

		if (!currentResult) continue;

		// Match URL: **URL:** ...
		if (trimmed.startsWith("**URL:**")) {
			currentResult.url = trimmed.slice(8).trim();
			continue;
		}

		// Match Author: **Author:** ...
		if (trimmed.startsWith("**Author:**")) {
			currentResult.author = trimmed.slice(11).trim();
			continue;
		}

		// Match Published Date: **Published Date:** ...
		if (trimmed.startsWith("**Published Date:**")) {
			currentResult.publishedDate = trimmed.slice(19).trim();
			continue;
		}

		// Match Text: **Text:** ...
		if (trimmed.startsWith("**Text:**")) {
			currentResult.text = trimmed.slice(9).trim();
		}
	}

	// Add last result
	if (currentResult?.title) {
		results.push(currentResult as ExaSearchResult);
	}

	if (results.length === 0) return null;

	return { results };
}

/** Calculate age in seconds from ISO date string */
function dateToAgeSeconds(dateStr: string | undefined): number | undefined {
	if (!dateStr) return undefined;
	try {
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) return undefined;
		return Math.floor((Date.now() - date.getTime()) / 1000);
	} catch {
		return undefined;
	}
}

/** Execute Exa web search */
export async function searchExa(params: ExaSearchParams): Promise<WebSearchResponse> {
	const apiKey = await findApiKey();
	if (!apiKey) {
		throw new Error("EXA_API_KEY not found. Set it in environment or .env file.");
	}

	const args: Record<string, unknown> = {
		query: params.query,
		numResults: params.num_results ?? 10,
		type: params.type ?? "auto",
	};

	if (params.include_domains?.length) {
		args.include_domains = params.include_domains;
	}
	if (params.exclude_domains?.length) {
		args.exclude_domains = params.exclude_domains;
	}
	if (params.start_published_date) {
		args.start_published_date = params.start_published_date;
	}
	if (params.end_published_date) {
		args.end_published_date = params.end_published_date;
	}

	const response = await callExaMCP(apiKey, "web_search_exa", args);

	if (response.error) {
		throw new Error(`Exa MCP error: ${response.error.message}`);
	}

	const exaResponse = response.result?.content ? parseMCPContent(response.result.content) : null;

	// Convert to unified WebSearchResponse
	const sources: WebSearchSource[] = [];

	if (exaResponse?.results) {
		for (const result of exaResponse.results) {
			if (!result.url) continue;
			sources.push({
				title: result.title ?? result.url,
				url: result.url,
				snippet: result.text ?? result.highlights?.join(" "),
				publishedDate: result.publishedDate,
				ageSeconds: dateToAgeSeconds(result.publishedDate),
				author: result.author,
			});
		}
	}

	// Apply num_results limit if specified
	const limitedSources = params.num_results ? sources.slice(0, params.num_results) : sources;

	return {
		provider: "exa",
		sources: limitedSources,
	};
}
