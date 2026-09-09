import { type FetchImpl, getEnvApiKey } from "@oh-my-pi/pi-ai";
import type { AgentStorage } from "../session/agent-storage";
import { findCredential, withHardTimeout } from "./search/providers/utils";

const PARALLEL_API_URL = "https://api.parallel.ai";
export const PARALLEL_SEARCH_URL = `${PARALLEL_API_URL}/v1beta/search`;
const PARALLEL_EXTRACT_URL = `${PARALLEL_API_URL}/v1beta/extract`;
export const PARALLEL_BETA_HEADER = "search-extract-2025-10-10";

export interface ParallelUsageItem {
	name?: string;
	count?: number;
}

export interface ParallelSearchSource {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
	excerpts: string[];
}

export interface ParallelSearchResult {
	requestId: string;
	sources: ParallelSearchSource[];
	warnings: string[];
	usage: ParallelUsageItem[];
}

export interface ParallelExtractDocument {
	url: string;
	title?: string;
	publishedDate?: string;
	excerpts: string[];
	fullContent?: string;
}

export interface ParallelExtractErrorEntry {
	url: string;
	errorType?: string;
	httpStatusCode?: number;
	content?: string;
}

export interface ParallelExtractResult {
	requestId: string;
	results: ParallelExtractDocument[];
	errors: ParallelExtractErrorEntry[];
	warnings: string[];
	usage: ParallelUsageItem[];
}

export interface ParallelSearchOptions {
	mode?: "fast" | "research";
	maxCharsPerResult?: number;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

export interface ParallelExtractOptions {
	objective?: string;
	searchQueries?: string[];
	excerpts?: boolean;
	fullContent?: boolean;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

export class ParallelApiError extends Error {
	readonly statusCode?: number;

	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = "ParallelApiError";
		this.statusCode = statusCode;
	}
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function getOwnValue(value: object, key: string): unknown {
	return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function getString(value: object, key: string): string | undefined {
	const candidate = getOwnValue(value, key);
	return typeof candidate === "string" ? candidate : undefined;
}

function getNumber(value: object, key: string): number | undefined {
	const candidate = getOwnValue(value, key);
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function getObjectArray(value: object, key: string): object[] {
	const candidate = getOwnValue(value, key);
	if (!Array.isArray(candidate)) return [];
	return candidate.filter(isObject);
}

function getStringArray(value: object, key: string): string[] {
	const candidate = getOwnValue(value, key);
	if (!Array.isArray(candidate)) return [];
	return candidate.filter(item => typeof item === "string");
}

function extractParallelErrorMessage(payload: unknown): string | null {
	if (!isObject(payload)) return null;

	const directMessage = getString(payload, "message") ?? getString(payload, "detail") ?? getString(payload, "error");
	if (directMessage && directMessage.trim().length > 0) {
		return directMessage.trim();
	}

	const errorObject = getOwnValue(payload, "error");
	if (isObject(errorObject)) {
		const nestedMessage = getString(errorObject, "message") ?? getString(errorObject, "detail");
		if (nestedMessage && nestedMessage.trim().length > 0) {
			return nestedMessage.trim();
		}
	}

	return null;
}

function createParallelApiError(statusCode: number, detail?: string): ParallelApiError {
	return new ParallelApiError(
		detail ? `Parallel API error (${statusCode}): ${detail}` : `Parallel API error (${statusCode})`,
		statusCode,
	);
}

export function parseParallelErrorResponse(statusCode: number, responseText: string): ParallelApiError {
	const trimmedResponseText = responseText.trim();
	if (trimmedResponseText.length === 0) {
		return createParallelApiError(statusCode);
	}

	try {
		const payload: unknown = JSON.parse(trimmedResponseText);
		return createParallelApiError(statusCode, extractParallelErrorMessage(payload) ?? trimmedResponseText);
	} catch {
		return createParallelApiError(statusCode, trimmedResponseText);
	}
}

export async function parseParallelJsonResponse(response: Response, operation: "search" | "extract"): Promise<unknown> {
	try {
		return await response.json();
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new ParallelApiError(`Parallel ${operation} returned invalid JSON: ${detail}`);
	}
}

function getAuthHeaders(apiKey: string): {
	Accept: string;
	"Content-Type": string;
	"x-api-key": string;
	"parallel-beta": string;
} {
	return {
		Accept: "application/json",
		"Content-Type": "application/json",
		"x-api-key": apiKey,
		"parallel-beta": PARALLEL_BETA_HEADER,
	};
}

function parseWarnings(payload: unknown): string[] {
	if (!Array.isArray(payload)) return [];

	const warnings: string[] = [];
	for (const item of payload) {
		if (typeof item === "string") {
			warnings.push(item);
			continue;
		}
		if (!isObject(item)) continue;
		const message = getString(item, "message") ?? getString(item, "warning");
		if (message) {
			warnings.push(message);
		}
	}
	return warnings;
}

function parseUsageItems(payload: unknown): ParallelUsageItem[] {
	if (!Array.isArray(payload)) return [];

	const usageItems: ParallelUsageItem[] = [];
	for (const item of payload) {
		if (!isObject(item)) continue;
		usageItems.push({
			name: getString(item, "name"),
			count: getNumber(item, "count"),
		});
	}
	return usageItems;
}

export function parseParallelSearchPayload(
	payload: unknown,
	options?: { parseMetadata?: boolean },
): ParallelSearchResult {
	if (!isObject(payload)) {
		throw new ParallelApiError("Parallel search returned an invalid response payload.");
	}

	const requestId = getString(payload, "search_id") ?? "";
	const rawResults = getObjectArray(payload, "results");
	const sources: ParallelSearchSource[] = [];

	for (const item of rawResults) {
		const url = getString(item, "url");
		if (!url) continue;

		const excerpts = getStringArray(item, "excerpts");
		const snippet = excerpts.length > 0 ? excerpts.join("\n\n") : undefined;
		sources.push({
			title: getString(item, "title") ?? url,
			url,
			snippet,
			publishedDate: getString(item, "publish_date"),
			excerpts,
		});
	}

	const parseMetadata = options?.parseMetadata ?? true;

	return {
		requestId,
		sources,
		warnings: parseMetadata ? parseWarnings(getOwnValue(payload, "warnings")) : [],
		usage: parseMetadata ? parseUsageItems(getOwnValue(payload, "usage")) : [],
	};
}

export function findParallelApiKey(storage: AgentStorage | null | undefined): string | null {
	return findCredential(storage, getEnvApiKey("parallel"), "parallel");
}

export function getParallelExtractContent(document: ParallelExtractDocument): string {
	const excerptContent = document.excerpts
		.filter(excerpt => excerpt.trim().length > 0)
		.join("\n\n")
		.trim();
	if (excerptContent.length > 0) {
		return excerptContent;
	}

	return document.fullContent?.trim() ?? "";
}

function parseExtractPayload(payload: unknown): ParallelExtractResult {
	if (!isObject(payload)) {
		throw new ParallelApiError("Parallel extract returned an invalid response payload.");
	}

	const requestId = getString(payload, "extract_id") ?? "";
	const resultItems: ParallelExtractDocument[] = [];
	for (const item of getObjectArray(payload, "results")) {
		const url = getString(item, "url");
		if (!url) continue;
		resultItems.push({
			url,
			title: getString(item, "title"),
			publishedDate: getString(item, "publish_date"),
			excerpts: getStringArray(item, "excerpts"),
			fullContent: getString(item, "full_content"),
		});
	}

	const errors: ParallelExtractErrorEntry[] = [];
	for (const item of getObjectArray(payload, "errors")) {
		const url = getString(item, "url");
		if (!url) continue;
		errors.push({
			url,
			errorType: getString(item, "error_type"),
			httpStatusCode: getNumber(item, "http_status_code"),
			content: getString(item, "content"),
		});
	}

	return {
		requestId,
		results: resultItems,
		errors,
		warnings: parseWarnings(getOwnValue(payload, "warnings")),
		usage: parseUsageItems(getOwnValue(payload, "usage")),
	};
}

export async function searchWithParallel(
	objective: string,
	queries: string[],
	options: ParallelSearchOptions,
	storage: AgentStorage | null | undefined,
): Promise<ParallelSearchResult> {
	const apiKey = findParallelApiKey(storage);
	if (!apiKey) {
		throw new ParallelApiError(
			"Parallel credentials not found. Set PARALLEL_API_KEY or login with 'omp /login parallel'.",
		);
	}

	const fetchImpl = options.fetch ?? fetch;
	const response = await fetchImpl(PARALLEL_SEARCH_URL, {
		method: "POST",
		headers: getAuthHeaders(apiKey),
		body: JSON.stringify({
			objective,
			search_queries: queries,
			mode: options.mode === "research" ? "one-shot" : "fast",
			excerpts: {
				max_chars_per_result: options.maxCharsPerResult ?? 10_000,
			},
		}),
		signal: withHardTimeout(options.signal),
	});
	if (!response.ok) {
		throw parseParallelErrorResponse(response.status, await response.text());
	}

	const payload = await parseParallelJsonResponse(response, "search");
	return parseParallelSearchPayload(payload);
}

export async function extractWithParallel(
	urls: string[],
	options: ParallelExtractOptions,
	storage: AgentStorage | null | undefined,
): Promise<ParallelExtractResult> {
	const apiKey = findParallelApiKey(storage);
	if (!apiKey) {
		throw new ParallelApiError(
			"Parallel credentials not found. Set PARALLEL_API_KEY or login with 'omp /login parallel'.",
		);
	}

	const fetchImpl = options.fetch ?? fetch;
	const response = await fetchImpl(PARALLEL_EXTRACT_URL, {
		method: "POST",
		headers: getAuthHeaders(apiKey),
		body: JSON.stringify({
			urls,
			objective: options.objective,
			search_queries: options.searchQueries,
			excerpts: options.excerpts ?? true,
			full_content: options.fullContent ?? false,
		}),
		signal: withHardTimeout(options.signal),
	});
	if (!response.ok) {
		throw parseParallelErrorResponse(response.status, await response.text());
	}

	const payload = await parseParallelJsonResponse(response, "extract");
	return parseExtractPayload(payload);
}
