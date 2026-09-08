import { type } from "@oh-my-pi/omptype";
import { collapseVariants, type VariantCollapseTable } from "../compat/collapse";
import type { ModelSpec } from "../types";
import { discoveryFetch, toPositiveNumber } from "../utils";
import { ensureAntigravityVersion, getAntigravityUserAgent } from "../wire/gemini-headers";

export const ANTIGRAVITY_PRIMARY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const DEFAULT_ANTIGRAVITY_DISCOVERY_ENDPOINTS = [ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT] as const;
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const ANTIGRAVITY_DISCOVERY_DENYLIST = new Set(["chat_20706", "chat_23310", "gemini-2.5-pro"]);

/**
 * Raw model metadata returned by Antigravity's `fetchAvailableModels` endpoint.
 */
export interface AntigravityDiscoveryApiModel {
	displayName?: string;
	supportsImages?: boolean;
	supportsThinking?: boolean;
	thinkingBudget?: number;
	recommended?: boolean;
	maxTokens?: number;
	maxOutputTokens?: number;
	model?: string;
	apiProvider?: string;
	modelProvider?: string;
	isInternal?: boolean;
	supportsVideo?: boolean;
}

/**
 * Grouping metadata used by Antigravity to surface recommended model ids.
 */
export interface AntigravityDiscoveryAgentModelGroup {
	modelIds?: string[];
}

/**
 * Sort/group metadata used by Antigravity to surface recommended model ids.
 */
export interface AntigravityDiscoveryAgentModelSort {
	groups?: AntigravityDiscoveryAgentModelGroup[];
}

/**
 * Response payload returned by Antigravity's `fetchAvailableModels` endpoint.
 */
export interface AntigravityDiscoveryApiResponse {
	models?: Record<string, AntigravityDiscoveryApiModel>;
	agentModelSorts?: AntigravityDiscoveryAgentModelSort[];
}
const AntigravityDiscoveryApiModelSchema = type({
	"displayName?": type("unknown").pipe(value => (typeof value === "string" ? value : undefined)),
	"supportsImages?": type("unknown").pipe(value => (typeof value === "boolean" ? value : undefined)),
	"supportsThinking?": type("unknown").pipe(value => (typeof value === "boolean" ? value : undefined)),
	"thinkingBudget?": type("unknown").pipe(value =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined,
	),
	"recommended?": type("unknown").pipe(value => (typeof value === "boolean" ? value : undefined)),
	"maxTokens?": type("unknown").pipe(value =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined,
	),
	"maxOutputTokens?": type("unknown").pipe(value =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined,
	),
	"model?": type("unknown").pipe(value => (typeof value === "string" ? value : undefined)),
	"apiProvider?": type("unknown").pipe(value => (typeof value === "string" ? value : undefined)),
	"modelProvider?": type("unknown").pipe(value => (typeof value === "string" ? value : undefined)),
	"isInternal?": type("unknown").pipe(value => (typeof value === "boolean" ? value : undefined)),
	"supportsVideo?": type("unknown").pipe(value => (typeof value === "boolean" ? value : undefined)),
});

const AntigravityDiscoveryAgentModelGroupSchema = type({
	"modelIds?": type("unknown").pipe(value =>
		Array.isArray(value) ? value.filter((modelId): modelId is string => typeof modelId === "string") : undefined,
	),
});

const AntigravityDiscoveryAgentModelSortSchema = type({
	"groups?": type("unknown").pipe(value => {
		if (!Array.isArray(value)) return undefined;
		const result: AntigravityDiscoveryAgentModelGroup[] = [];
		for (const group of value) {
			const parsedGroup = AntigravityDiscoveryAgentModelGroupSchema(group);
			if (!(parsedGroup instanceof type.errors)) {
				result.push(parsedGroup);
			}
		}
		return result;
	}),
});

const AntigravityDiscoveryApiResponseSchema = type({
	"models?": type("unknown").pipe(value => {
		if (typeof value !== "object" || value === null) {
			return undefined;
		}
		const normalized: Record<string, AntigravityDiscoveryApiModel> = {};
		for (const [modelId, modelValue] of Object.entries(value)) {
			if (typeof modelValue !== "object" || modelValue === null) {
				continue;
			}
			const parsedModel = AntigravityDiscoveryApiModelSchema(modelValue);
			if (!(parsedModel instanceof type.errors)) {
				normalized[modelId] = parsedModel;
			}
		}
		return normalized;
	}),
	"agentModelSorts?": type("unknown").pipe(value => {
		if (!Array.isArray(value)) {
			return undefined;
		}
		const result: AntigravityDiscoveryAgentModelSort[] = [];
		for (const sort of value) {
			const parsedSort = AntigravityDiscoveryAgentModelSortSchema(sort);
			if (!(parsedSort instanceof type.errors)) {
				result.push(parsedSort);
			}
		}
		return result;
	}),
});
/**
 * Options for fetching Antigravity discovery models.
 */
export interface FetchAntigravityDiscoveryModelsOptions {
	/** OAuth access token used as `Authorization: Bearer <token>`. */
	token: string;
	/** Optional endpoint override. Defaults to Antigravity fallback endpoints. */
	endpoint?: string;
	/** Deprecated and ignored for antigravity discovery parity. */
	project?: string;
	/** Optional user agent override. */
	userAgent?: string;
	/** Optional abort signal for request cancellation. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for tests. */
	fetcher?: typeof fetch;
	/**
	 * Hand collapse table to apply to the discovered list. Defaults to the
	 * Antigravity (budget-transport) table; `googleGeminiCli` passes the
	 * level-transport table so cloudcode-pa keeps `thinkingLevel`.
	 */
	collapseTable?: VariantCollapseTable;
}

/**
 * Fetches discoverable Antigravity models and normalizes them into canonical model entries.
 *
 * Returns `null` on network/payload/auth failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchAntigravityDiscoveryModels(
	options: FetchAntigravityDiscoveryModelsOptions,
): Promise<ModelSpec<"google-gemini-cli">[] | null> {
	if (options.userAgent === undefined) {
		await ensureAntigravityVersion(options.fetcher ?? fetch, options.signal);
	}

	const fetcher = discoveryFetch(options.fetcher);
	const endpoints = options.endpoint
		? [trimTrailingSlashes(options.endpoint)]
		: DEFAULT_ANTIGRAVITY_DISCOVERY_ENDPOINTS.map(trimTrailingSlashes);

	for (const endpoint of endpoints) {
		let response: Response;
		try {
			response = await fetcher(`${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.token}`,
					"Content-Type": "application/json",
					"User-Agent": options.userAgent ?? getAntigravityUserAgent(),
				},
				body: JSON.stringify({}),
				signal: options.signal,
			});
		} catch {
			continue;
		}

		if (!response.ok) {
			continue;
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			continue;
		}

		const parsed = parseAntigravityDiscoveryResponse(payload);
		if (!parsed) {
			continue;
		}

		const models: ModelSpec<"google-gemini-cli">[] = [];

		for (const [modelId, model] of Object.entries(parsed.models ?? {})) {
			if (ANTIGRAVITY_DISCOVERY_DENYLIST.has(modelId)) {
				continue;
			}
			if (model.isInternal === true) {
				continue;
			}

			const supportsImages = model.supportsImages === true;
			models.push({
				id: modelId,
				name: model.displayName || modelId,
				api: "google-gemini-cli",
				provider: "google-antigravity",
				baseUrl: endpoint,
				reasoning: model.supportsThinking === true,
				input: supportsImages ? ["text", "image"] : ["text"],
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: toPositiveNumber(model.maxTokens, DEFAULT_CONTEXT_WINDOW),
				maxTokens: toPositiveNumber(model.maxOutputTokens, DEFAULT_MAX_TOKENS),
			});
		}

		// Collapse effort-tier variants at the source so runtime discovery,
		// the gemini-cli re-provision, and the catalog generator all see
		// logical ids only.
		const collapsed = collapseVariants(
			models,
			options.collapseTable === undefined ? undefined : { table: options.collapseTable },
		);
		collapsed.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
		return collapsed;
	}

	return null;
}

function parseAntigravityDiscoveryResponse(value: unknown): AntigravityDiscoveryApiResponse | null {
	const parsed = AntigravityDiscoveryApiResponseSchema(value);
	if (parsed instanceof type.errors) {
		return null;
	}
	return parsed;
}

function trimTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}
