/**
 * Google Gemini Web Search Provider
 *
 * Uses Gemini's Google Search grounding via Cloud Code Assist API.
 * Auth is resolved through `AuthStorage.getOAuthAccess(...)` for both
 * `google-gemini-cli` (stable prod) and `google-antigravity` (daily sandbox)
 * — the broker is the sole refresh authority, so this module never opens a
 * sibling SQLite store and never POSTs the broker sentinel to a Google token
 * endpoint.
 */
import { type AuthStorage, type FetchImpl, type OAuthAccess, withOAuthAccess } from "@pk-nerdsaver-ai/pi-ai";
import {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	getAntigravityUserAgent,
	getGeminiCliHeaders,
} from "@pk-nerdsaver-ai/pi-catalog/wire/gemini-headers";
import { APP_NAME, fetchWithRetry } from "@pk-nerdsaver-ai/pi-utils";

import type { SearchCitation, SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINT_FALLBACKS = [ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT] as const;
const DEFAULT_MODEL = "gemini-3.7-flash";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;

const GEMINI_PROVIDERS = ["google-gemini-cli", "google-antigravity"] as const;
type GeminiProviderId = (typeof GEMINI_PROVIDERS)[number];

interface GeminiToolParams {
	google_search?: Record<string, unknown>;
	code_execution?: Record<string, unknown>;
	url_context?: Record<string, unknown>;
}

export interface GeminiSearchParams extends GeminiToolParams {
	query: string;
	system_prompt?: string;
	num_results?: number;
	/** Maximum output tokens. */
	max_output_tokens?: number;
	/** Sampling temperature (0–1). Lower = more focused/factual. */
	temperature?: number;
	signal?: AbortSignal;
	authStorage: AuthStorage;
	sessionId?: string;
	fetch?: FetchImpl;
	antigravityEndpointMode?: "auto" | "production" | "sandbox";
}

export function buildGeminiRequestTools(params: GeminiToolParams): Array<Record<string, Record<string, unknown>>> {
	const tools: Array<Record<string, Record<string, unknown>>> = [{ googleSearch: params.google_search ?? {} }];
	if (params.code_execution !== undefined) {
		tools.push({ codeExecution: params.code_execution });
	}
	if (params.url_context !== undefined) {
		tools.push({ urlContext: params.url_context });
	}
	return tools;
}

/** Resolved auth for a Gemini API request. */
interface GeminiAuth {
	accessToken: string;
	projectId: string;
	isAntigravity: boolean;
}

/** First configured Gemini OAuth provider plus its pre-resolved access. */
interface GeminiAuthSeed {
	provider: GeminiProviderId;
	access: OAuthAccess;
	projectId: string;
}

/**
 * Walks the configured Gemini OAuth providers in deterministic order and
 * returns the first one that yields a usable access token + projectId via
 * {@link AuthStorage.getOAuthAccess}. AuthStorage handles refresh + broker
 * routing internally; this helper never touches refresh tokens directly.
 * The resolved access seeds `withOAuthAccess` so the happy path resolves once.
 */
export async function findGeminiAuth(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<GeminiAuthSeed | null> {
	for (const provider of GEMINI_PROVIDERS) {
		const access = await authStorage.getOAuthAccess(provider, sessionId, { signal });
		if (!access?.accessToken || !access.projectId) continue;
		return { provider, access, projectId: access.projectId };
	}
	return null;
}

function hasGeminiOAuth(authStorage: AuthStorage): boolean {
	return GEMINI_PROVIDERS.some((provider: GeminiProviderId) => authStorage.hasOAuth(provider));
}

/** Cloud Code Assist API response types */
interface GeminiGroundingChunk {
	web?: {
		uri?: string;
		title?: string;
	};
}

interface GeminiGroundingSupport {
	segment?: {
		startIndex?: number;
		endIndex?: number;
		text?: string;
	};
	groundingChunkIndices?: number[];
	confidenceScores?: number[];
}

interface GeminiGroundingMetadata {
	groundingChunks?: GeminiGroundingChunk[];
	groundingSupports?: GeminiGroundingSupport[];
	webSearchQueries?: string[];
}

interface CloudCodeResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{ text?: string }>;
			};
			finishReason?: string;
			groundingMetadata?: GeminiGroundingMetadata;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			totalTokenCount?: number;
		};
		modelVersion?: string;
	};
}

/**
 * Calls the Cloud Code Assist API with Google Search grounding enabled.
 *
 * If a request returns a refreshable auth failure (401/403/auth-flavoured 400),
 * we ask AuthStorage to invalidate + refresh the credential and retry once.
 * Provider-direct refresh helpers are intentionally not used: AuthStorage owns
 * the single-flight refresh and broker round-trip.
 */
async function callGeminiSearch(
	auth: GeminiAuth,
	query: string,
	systemPrompt: string | undefined,
	maxOutputTokens: number | undefined,
	temperature: number | undefined,
	toolParams: GeminiToolParams,
	fetchImpl: FetchImpl | undefined,
	signal: AbortSignal | undefined,
	mode?: "auto" | "production" | "sandbox",
): Promise<{
	answer: string;
	sources: SearchSource[];
	citations: SearchCitation[];
	searchQueries: string[];
	model: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
	let endpoints: string[];
	if (auth.isAntigravity) {
		const m = mode ?? "auto";
		if (m === "sandbox") {
			endpoints = [ANTIGRAVITY_SANDBOX_ENDPOINT];
		} else if (m === "production") {
			endpoints = [ANTIGRAVITY_DAILY_ENDPOINT];
		} else {
			endpoints = [...ANTIGRAVITY_ENDPOINT_FALLBACKS];
		}
	} else {
		endpoints = [DEFAULT_ENDPOINT];
	}
	const headers = auth.isAntigravity ? { "User-Agent": getAntigravityUserAgent() } : getGeminiCliHeaders();

	const requestMetadata = auth.isAntigravity
		? {
				requestType: "agent",
				userAgent: "antigravity",
				requestId: `agent-${crypto.randomUUID()}`,
			}
		: {
				userAgent: "pi-coding-agent",
				requestId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
			};

	const normalizedSystemPrompt = systemPrompt?.toWellFormed();
	const systemInstructionParts: Array<{ text: string }> = [
		...(auth.isAntigravity ? [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }] : []),
		...(normalizedSystemPrompt ? [{ text: normalizedSystemPrompt }] : []),
	];

	const requestBody: Record<string, unknown> = {
		project: auth.projectId,
		model: DEFAULT_MODEL,
		request: {
			contents: [
				{
					role: "user",
					parts: [{ text: query }],
				},
			],
			tools: buildGeminiRequestTools(toolParams),
			...(systemInstructionParts.length > 0 && {
				systemInstruction: {
					...(auth.isAntigravity ? { role: "user" } : {}),
					parts: systemInstructionParts,
				},
			}),
		},
		...requestMetadata,
	};

	if (maxOutputTokens !== undefined || temperature !== undefined) {
		const generationConfig: Record<string, number> = {};
		if (maxOutputTokens !== undefined) {
			generationConfig.maxOutputTokens = maxOutputTokens;
		}
		if (temperature !== undefined) {
			generationConfig.temperature = temperature;
		}
		(requestBody.request as Record<string, unknown>).generationConfig = generationConfig;
	}
	const buildInit = (): RequestInit => ({
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth.accessToken}`,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			...headers,
		},
		body: JSON.stringify(requestBody),
		signal: withHardTimeout(signal),
	});

	let response: Response | undefined;

	for (let i = 0; i < endpoints.length; i++) {
		const endpoint = endpoints[i];
		const isLastEndpoint = i === endpoints.length - 1;
		try {
			response = await fetchWithRetry(() => `${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
				...buildInit(),
				fetch: fetchImpl,
				maxAttempts: isLastEndpoint ? MAX_RETRIES + 1 : 1,
				defaultDelayMs: attempt => BASE_DELAY_MS * 2 ** attempt,
				maxDelayMs: RATE_LIMIT_BUDGET_MS,
			});

			if (response.ok) {
				break;
			}

			if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
				if (!isLastEndpoint) {
					continue;
				}
			}
			break;
		} catch (error) {
			if (isLastEndpoint) {
				throw error;
			}
		}
	}

	if (!response?.ok) {
		const errorText = response ? await response.text() : "Network error";
		const status = response?.status ?? 502;
		const classified = classifyProviderHttpError("gemini", status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("gemini", `Gemini Cloud Code API error (${status}): ${errorText}`, status);
	}

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("gemini", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"gemini",
			`Gemini Cloud Code API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	if (!response.body) {
		throw new SearchProviderError("gemini", "Gemini API returned no response body", 500);
	}

	// Parse SSE stream
	const answerParts: string[] = [];
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const searchQueries: string[] = [];
	const seenUrls = new Set<string>();
	let model = DEFAULT_MODEL;
	let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.startsWith("data:")) continue;

				const jsonStr = line.slice(5).trim();
				if (!jsonStr) continue;

				let chunk: CloudCodeResponseChunk;
				try {
					chunk = JSON.parse(jsonStr) as CloudCodeResponseChunk;
				} catch {
					continue;
				}

				const responseData = chunk.response;
				if (!responseData) continue;

				const candidate = responseData.candidates?.[0];

				// Extract text content
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text) {
							answerParts.push(part.text);
						}
					}
				}

				// Extract grounding metadata
				const groundingMetadata = candidate?.groundingMetadata;
				if (groundingMetadata) {
					// Extract sources from grounding chunks
					if (groundingMetadata.groundingChunks) {
						for (const grChunk of groundingMetadata.groundingChunks) {
							if (grChunk.web?.uri) {
								const sourceUrl = grChunk.web.uri;
								if (!seenUrls.has(sourceUrl)) {
									seenUrls.add(sourceUrl);
									sources.push({
										title: grChunk.web.title ?? sourceUrl,
										url: sourceUrl,
									});
								}
							}
						}
					}

					// Extract citations from grounding supports
					if (groundingMetadata.groundingSupports && groundingMetadata.groundingChunks) {
						for (const support of groundingMetadata.groundingSupports) {
							const citedText = support.segment?.text;
							const chunkIndices = support.groundingChunkIndices ?? [];

							for (const idx of chunkIndices) {
								const grChunk = groundingMetadata.groundingChunks[idx];
								if (grChunk?.web?.uri) {
									citations.push({
										url: grChunk.web.uri,
										title: grChunk.web.title ?? grChunk.web.uri,
										citedText,
									});
								}
							}
						}
					}

					// Extract search queries
					if (groundingMetadata.webSearchQueries) {
						for (const q of groundingMetadata.webSearchQueries) {
							if (!searchQueries.includes(q)) {
								searchQueries.push(q);
							}
						}
					}
				}

				// Extract usage metadata
				if (responseData.usageMetadata) {
					usage = {
						inputTokens: responseData.usageMetadata.promptTokenCount ?? 0,
						outputTokens: responseData.usageMetadata.candidatesTokenCount ?? 0,
						totalTokens: responseData.usageMetadata.totalTokenCount ?? 0,
					};
				}

				// Extract model version
				if (responseData.modelVersion) {
					model = responseData.modelVersion;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	return {
		answer: answerParts.join(""),
		sources,
		citations,
		searchQueries,
		model,
		usage,
	};
}

/**
 * Executes a web search using Google Gemini with Google Search grounding.
 */
export async function searchGemini(params: GeminiSearchParams): Promise<SearchResponse> {
	const seed = await findGeminiAuth(params.authStorage, params.sessionId, params.signal);
	if (!seed) {
		throw new Error(
			`No Gemini OAuth credentials found. Login with '${APP_NAME} /login google-gemini-cli' or '${APP_NAME} /login google-antigravity' to enable Gemini web search.`,
		);
	}

	const isAntigravity = seed.provider === "google-antigravity";
	const result = await withOAuthAccess(
		params.authStorage,
		seed.provider,
		access =>
			// Derive bearer + projectId from the access this attempt received; a
			// re-resolved access may omit projectId, in which case the seed's
			// project is still the right tenant for the credential. The
			// `fetchWithRetry` transport backoff stays INSIDE this attempt — auth
			callGeminiSearch(
				{
					accessToken: access.accessToken,
					projectId: access.projectId ?? seed.projectId,
					isAntigravity,
				},
				params.query,
				params.system_prompt,
				params.max_output_tokens,
				params.temperature,
				{
					google_search: params.google_search,
					code_execution: params.code_execution,
					url_context: params.url_context,
				},
				params.fetch,
				params.signal,
				params.antigravityEndpointMode,
			),
		{ sessionId: params.sessionId, signal: params.signal, seed: seed.access },
	);

	let sources = result.sources;

	if (params.num_results && sources.length > params.num_results) {
		sources = sources.slice(0, params.num_results);
	}

	return {
		provider: "gemini",
		answer: result.answer || undefined,
		sources,
		citations: result.citations.length > 0 ? result.citations : undefined,
		searchQueries: result.searchQueries.length > 0 ? result.searchQueries : undefined,
		usage: result.usage,
		model: result.model,
	};
}

/** Search provider for Google Gemini web search. */
export class GeminiProvider extends SearchProvider {
	readonly id = "gemini";
	readonly label = "Gemini";

	isAvailable(authStorage: AuthStorage): boolean {
		// Cheap, in-memory check — avoids driving the refresh pipeline during
		// the provider-chain probe. `searchGemini` calls `getOAuthAccess` which
		// will refresh lazily on the actual request.
		return hasGeminiOAuth(authStorage);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchGemini({
			query: params.query,
			system_prompt: params.systemPrompt,
			num_results: params.numSearchResults ?? params.limit,
			max_output_tokens: params.maxOutputTokens,
			temperature: params.temperature,
			google_search: params.googleSearch,
			code_execution: params.codeExecution,
			url_context: params.urlContext,
			signal: params.signal,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: params.fetch,
		});
	}
}
