import { linkOpenAIPromotionTargets } from "../context-promotion";
import {
	DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
	withOpenAICompatibleDiscoveryTimeout,
} from "../discovery/openai-compatible";
import { type Effort, THINKING_EFFORTS } from "../effort";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, ModelSpec } from "../types";
import { discoveryFetch, isRecord, toNumber } from "../utils";
import { resolveModelCacheProviderId } from "./cache-provider-id";

const MERGE_GATEWAY_BASE_URL = "https://api-gateway.merge.dev/v1/openai";
const MERGE_GATEWAY_PAGE_SIZE = 500;

type MergeGatewayRoute = {
	contextWindow: number | null;
	maxTokens: number | null;
	input: readonly unknown[];
	reasoning: boolean;
	effortValues: readonly Effort[];
	requiresEffort: boolean;
	supportsDisable: boolean;
	supportsDisplay: boolean;
	structuredOutputs: boolean;
	streaming: boolean;
	zeroDataRetention: boolean;
	supportsToolChoice: boolean;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
};

export interface MergeGatewayModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export interface FetchMergeGatewayModelsOptions {
	apiKey: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	timeoutMs?: number;
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/g, "");
}

function catalogBaseUrl(completionsBaseUrl: string): string | null {
	const normalized = normalizeBaseUrl(completionsBaseUrl);
	if (!normalized) return null;
	try {
		const url = new URL(normalized);
		if (url.pathname.endsWith("/openai")) url.pathname = url.pathname.slice(0, -"/openai".length);
		return url.toString().replace(/\/+$/g, "");
	} catch {
		return null;
	}
}

function stringArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function positiveNumber(value: unknown): number | null {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value: unknown): number {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed >= 0 ? parsed : 0;
}
function reasoningMetadata(value: unknown): {
	effortValues: readonly Effort[];
	requiresEffort: boolean;
	supportsDisable: boolean;
	supportsDisplay: boolean;
} {
	if (!isRecord(value) || value.configurable !== true || !Array.isArray(value.effort_values)) {
		return { effortValues: [], requiresEffort: false, supportsDisable: false, supportsDisplay: false };
	}
	const advertised = new Set(value.effort_values);
	const outputStyle = typeof value.output_style === "string" ? value.output_style : "";
	return {
		effortValues: THINKING_EFFORTS.filter(effort => advertised.has(effort)),
		requiresEffort: value.disable_supported === false,
		supportsDisable: value.disable_supported === true && advertised.has("none"),
		supportsDisplay: outputStyle.length > 0 && outputStyle !== "hidden",
	};
}

function mapRoute(value: unknown): MergeGatewayRoute | null {
	if (!isRecord(value) || value.availability_status !== "available" || !isRecord(value.capabilities)) return null;
	const capabilities = value.capabilities;
	const input = stringArray(capabilities.input);
	const output = stringArray(capabilities.output);
	if (
		!input.includes("text") ||
		!output.includes("text") ||
		capabilities.supports_tool_calling !== true ||
		capabilities.streaming !== true
	)
		return null;
	if (!stringArray(value.service_tiers).includes("standard")) return null;
	const pricing = isRecord(value.pricing) ? value.pricing : {};
	const reasoning = reasoningMetadata(capabilities.reasoning);
	return {
		contextWindow: positiveNumber(value.context_window),
		maxTokens: positiveNumber(value.max_output_tokens),
		input,
		reasoning: capabilities.supports_reasoning === true,
		effortValues: reasoning.effortValues,
		requiresEffort: reasoning.requiresEffort,
		supportsDisable: reasoning.supportsDisable,
		supportsDisplay: reasoning.supportsDisplay,
		structuredOutputs: capabilities.supports_structured_outputs === true,
		streaming: capabilities.streaming === true,
		zeroDataRetention: value.zero_data_retention === true,
		supportsToolChoice: capabilities.supports_tool_choice === true,
		cost: {
			input: nonNegativeNumber(pricing.input_per_million),
			output: nonNegativeNumber(pricing.output_per_million),
			cacheRead: nonNegativeNumber(pricing.cache_read_per_million),
			cacheWrite: nonNegativeNumber(pricing.cache_write_per_million),
		},
	};
}

function conservativeMinimum(values: readonly (number | null)[]): number | null {
	if (values.length === 0 || values.some(value => value === null)) return null;
	return Math.min(...(values as number[]));
}

function maximum(values: readonly number[]): number {
	return values.length > 0 ? Math.max(...values) : 0;
}
function commonReasoningEfforts(routes: readonly MergeGatewayRoute[]): readonly Effort[] {
	if (routes.some(route => !route.reasoning || route.effortValues.length === 0)) return [];
	return THINKING_EFFORTS.filter(effort => routes.every(route => route.effortValues.includes(effort)));
}

export function mapMergeGatewayModel(value: unknown, baseUrl: string): ModelSpec<"openai-completions"> | null {
	if (
		!isRecord(value) ||
		typeof value.model !== "string" ||
		value.model.length === 0 ||
		value.availability_status !== "available" ||
		!isRecord(value.vendors)
	)
		return null;
	const routes = Object.values(value.vendors).flatMap(route => {
		const mapped = mapRoute(route);
		return mapped ? [mapped] : [];
	});
	if (routes.length === 0) return null;
	const supportsToolChoice = routes.every(route => route.supportsToolChoice);
	const reasoning = routes.every(route => route.reasoning);
	const reasoningEfforts = reasoning ? commonReasoningEfforts(routes) : [];
	const supportsReasoningEffort = reasoningEfforts.length > 0;
	const supportsReasoningDisable = reasoning && routes.every(route => route.supportsDisable);
	return {
		id: value.model,
		name: typeof value.display_name === "string" && value.display_name.length > 0 ? value.display_name : value.model,
		api: "openai-completions",
		provider: "merge-gateway",
		baseUrl,
		reasoning,
		input: routes.every(route => route.input.includes("image")) ? ["text", "image"] : ["text"],
		supportsTools: true,
		declaredCapabilities: {
			nativeToolCalling: true,
			nativeToolChoice: supportsToolChoice,
			nativeStructuredOutputs: routes.every(route => route.structuredOutputs),
			streaming: routes.every(route => route.streaming),
			zeroDataRetention: routes.every(route => route.zeroDataRetention),
		},
		cost: {
			input: maximum(routes.map(route => route.cost.input)),
			output: maximum(routes.map(route => route.cost.output)),
			cacheRead: maximum(routes.map(route => route.cost.cacheRead)),
			cacheWrite: maximum(routes.map(route => route.cost.cacheWrite)),
		},
		contextWindow: conservativeMinimum(routes.map(route => route.contextWindow)),
		maxTokens: conservativeMinimum(routes.map(route => route.maxTokens)),
		...(supportsReasoningEffort && {
			thinking: {
				mode: "effort",
				efforts: reasoningEfforts,
				...(routes.some(route => route.requiresEffort) && { requiresEffort: true }),
				...(routes.every(route => route.supportsDisplay) && { supportsDisplay: true }),
			},
		}),
		compat: {
			supportsReasoningEffort,
			supportsToolChoice,
			supportsForcedToolChoice: supportsToolChoice,
			supportsNamedToolChoice: supportsToolChoice,
			...(supportsReasoningDisable && { reasoningDisableMode: "none-effort" as const }),
		},
	};
}

async function fetchMergeGatewayPage(
	url: URL,
	apiKey: string,
	fetchImpl: FetchImpl,
	signal: AbortSignal,
): Promise<unknown | null> {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
			signal,
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;
	try {
		return await response.json();
	} catch {
		return null;
	}
}

export async function fetchMergeGatewayModels(
	options: FetchMergeGatewayModelsOptions,
): Promise<ModelSpec<"openai-completions">[] | null> {
	const completionsBaseUrl = normalizeBaseUrl(options.baseUrl ?? MERGE_GATEWAY_BASE_URL);
	const catalogBase = catalogBaseUrl(completionsBaseUrl);
	if (!catalogBase) return null;
	const fetchImpl = discoveryFetch(options.fetch);
	return withOpenAICompatibleDiscoveryTimeout(
		options.timeoutMs ?? DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
		async signal => {
			const models = new Map<string, ModelSpec<"openai-completions">>();
			const seenCursors = new Set<string>();
			let cursor: string | undefined;
			for (;;) {
				const url = new URL(`${catalogBase}/models`);
				url.searchParams.set("limit", String(MERGE_GATEWAY_PAGE_SIZE));
				if (cursor) url.searchParams.set("cursor", cursor);
				const payload = await fetchMergeGatewayPage(url, options.apiKey, fetchImpl, signal);
				if (!isRecord(payload) || !Array.isArray(payload.data) || typeof payload.has_more !== "boolean")
					return null;
				for (const entry of payload.data) {
					const model = mapMergeGatewayModel(entry, completionsBaseUrl);
					if (model) models.set(model.id, model);
				}
				if (!payload.has_more) break;
				if (typeof payload.next_cursor !== "string" || !payload.next_cursor || seenCursors.has(payload.next_cursor))
					return null;
				seenCursors.add(payload.next_cursor);
				cursor = payload.next_cursor;
			}
			return Array.from(models.values()).sort((left, right) => left.id.localeCompare(right.id));
		},
	);
}

export function mergeGatewayModelManagerOptions(
	config?: MergeGatewayModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeBaseUrl(config?.baseUrl ?? MERGE_GATEWAY_BASE_URL);
	return {
		providerId: "merge-gateway",
		dynamicModelsAuthoritative: true,
		cacheProviderId: resolveModelCacheProviderId("merge-gateway", { apiKey, baseUrl }),
		dynamicModelsReplaceExisting: true,
		...(apiKey && {
			fetchDynamicModels: async () => {
				const models = await fetchMergeGatewayModels({ apiKey, baseUrl, fetch: config?.fetch });
				if (models) linkOpenAIPromotionTargets(models);
				return models;
			},
		}),
	};
}
