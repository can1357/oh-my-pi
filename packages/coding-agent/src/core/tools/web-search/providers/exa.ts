/**
 * Exa Web Search Provider
 *
 * High-quality neural search via Exa Search API.
 * Returns structured search results with optional content extraction.
 */

import type { WebSearchResponse, WebSearchSource } from "../types";

const EXA_API_URL = "https://api.exa.ai/search";

type ExaSearchType = "neural" | "fast" | "auto" | "deep";

type ExaSearchParamType = ExaSearchType | "keyword";

export interface ExaSearchParams {
	query: string;
	num_results?: number;
	type?: ExaSearchParamType;
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
			let trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			if (trimmed.startsWith("export ")) {
				trimmed = trimmed.slice("export ".length).trim();
			}

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

function getHomeDir(): string | null {
	return process.env.HOME ?? process.env.USERPROFILE ?? null;
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
	const homeDir = getHomeDir();
	if (homeDir) {
		const homeEnv = await parseEnvFile(`${homeDir}/.env`);
		if (homeEnv.EXA_API_KEY) {
			return homeEnv.EXA_API_KEY;
		}
	}

	return null;
}

interface ExaSearchResult {
	title?: string | null;
	url?: string | null;
	author?: string | null;
	publishedDate?: string | null;
	text?: string | null;
	highlights?: string[] | null;
}

interface ExaSearchResponse {
	requestId?: string;
	resolvedSearchType?: string;
	results?: ExaSearchResult[];
	costDollars?: { total: number };
	searchTime?: number;
}

function normalizeSearchType(type: ExaSearchParamType | undefined): ExaSearchType {
	if (!type) return "auto";
	if (type === "keyword") return "fast";
	return type;
}

/** Call Exa Search API */
async function callExaSearch(apiKey: string, params: ExaSearchParams): Promise<ExaSearchResponse> {
	const body: Record<string, unknown> = {
		query: params.query,
		numResults: params.num_results ?? 10,
		type: normalizeSearchType(params.type),
	};

	if (params.include_domains?.length) {
		body.includeDomains = params.include_domains;
	}
	if (params.exclude_domains?.length) {
		body.excludeDomains = params.exclude_domains;
	}
	if (params.start_published_date) {
		body.startPublishedDate = params.start_published_date;
	}
	if (params.end_published_date) {
		body.endPublishedDate = params.end_published_date;
	}

	const response = await fetch(EXA_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Exa API error (${response.status}): ${errorText}`);
	}

	return response.json() as Promise<ExaSearchResponse>;
}

/** Calculate age in seconds from ISO date string */
function dateToAgeSeconds(dateStr: string | null | undefined): number | undefined {
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

	const response = await callExaSearch(apiKey, params);

	// Convert to unified WebSearchResponse
	const sources: WebSearchSource[] = [];

	if (response.results) {
		for (const result of response.results) {
			if (!result.url) continue;
			sources.push({
				title: result.title ?? result.url,
				url: result.url,
				snippet: result.text ?? result.highlights?.join(" ") ?? undefined,
				publishedDate: result.publishedDate ?? undefined,
				ageSeconds: dateToAgeSeconds(result.publishedDate ?? undefined),
				author: result.author ?? undefined,
			});
		}
	}

	// Apply num_results limit if specified
	const limitedSources = params.num_results ? sources.slice(0, params.num_results) : sources;

	return {
		provider: "exa",
		sources: limitedSources,
		requestId: response.requestId,
	};
}
