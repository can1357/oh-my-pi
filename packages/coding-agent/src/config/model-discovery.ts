/**
 * HTTP discovery protocols for configured and implicit providers — ollama,
 * llama.cpp, lm-studio, openai-models-list, and new-api/one-api-style proxies.
 * `ModelRegistry` owns the orchestration (status, state, caching) and calls
 * `discoverModelsByProviderType` with a `DiscoveryContext`; built-in provider
 * discovery lives in pi-catalog's provider-models.
 */
import { type ApiKey, type FetchImpl, withAuth } from "@pk-nerdsaver-ai/pi-ai";
import type { Api, Model, RemoteCompactionConfig } from "@pk-nerdsaver-ai/pi-ai/types";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import {
	getBundledModelReferenceIndex,
	resolveModelReference,
	stripBracketedModelIdAffixes,
} from "@pk-nerdsaver-ai/pi-catalog/identity";
import {
	fetchLiteLLMRichModels,
	fetchLmStudioNativeModelMetadata,
	OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW,
	OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS,
} from "@pk-nerdsaver-ai/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@pk-nerdsaver-ai/pi-catalog/types";
import { isRecord } from "@pk-nerdsaver-ai/pi-utils";
import type { ProviderDiscovery } from "./models-config-schema";

// Default cap on `max_tokens` for auto-discovered models that do not advertise
// their own output limit (OpenAI-models-list, Ollama, llama.cpp, new-api/
// one-api proxies). 32K matches the upper end of what mainstream
// OpenAI-compatible providers (DeepSeek, MiMo, OpenRouter, etc.) actually
// accept and keeps `min(contextWindow, …)` honoring smaller local windows.
// Conservative caps below this caused providers to drop the connection
// mid-stream when models hit the cap on legitimate large tool calls (see
// issue #1528: `write` payloads >~5KB on deepseek-v4-pro surfaced as
// "socket connection was closed unexpectedly").
export const DISCOVERY_DEFAULT_CONTEXT_WINDOW = OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW;
export const DISCOVERY_DEFAULT_MAX_TOKENS = OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS;

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_HOST_DEFAULT_PORT = "11434";

function normalizeOllamaHostEnv(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const candidate = trimmed.includes("://")
		? trimmed
		: trimmed.startsWith("//")
			? `http:${trimmed}`
			: trimmed.startsWith(":")
				? `http://127.0.0.1${trimmed}`
				: `http://${trimmed}`;
	try {
		const parsed = new URL(candidate);
		if (!parsed.hostname || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
			return undefined;
		}
		if (!parsed.port && parsed.protocol === "http:") {
			parsed.port = OLLAMA_HOST_DEFAULT_PORT;
		}
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return undefined;
	}
}

export function getImplicitOllamaBaseUrl(): string {
	const baseUrl = Bun.env.OLLAMA_BASE_URL?.trim();
	return baseUrl || normalizeOllamaHostEnv(Bun.env.OLLAMA_HOST) || DEFAULT_OLLAMA_BASE_URL;
}

export function getOllamaContextLengthOverride(): number | undefined {
	const value = Bun.env.OLLAMA_CONTEXT_LENGTH?.trim();
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// Anthropic-safe variant of the discovery cap. The Anthropic stream converter
// in `packages/ai/src/providers/anthropic.ts` derives the request limit as
// `(model.maxTokens / 3) | 0`, so the 32K default would surface as 10,922
// requested output tokens — above the 8,192 hard cap on classic Claude 3.x
// Sonnet/Haiku/Opus endpoints. Discovered models routed through
// `anthropic-messages` (proxy `supported_endpoint_types: ["anthropic"]` or a
// custom provider with `api: anthropic-messages` + openai-models-list
// discovery) fall back to this conservative value.
const DISCOVERY_DEFAULT_MAX_TOKENS_ANTHROPIC = 8_192;

/** Routes discovered-model `maxTokens` defaults around Anthropic's 3× output divisor. */
export function discoveryDefaultMaxTokens(api: Api | undefined): number {
	return api === "anthropic-messages" ? DISCOVERY_DEFAULT_MAX_TOKENS_ANTHROPIC : DISCOVERY_DEFAULT_MAX_TOKENS;
}

export interface DiscoveryProviderConfig {
	provider: string;
	api: Api;
	baseUrl?: string;
	headers?: Record<string, string>;
	compat?: ModelSpec<Api>["compat"];
	remoteCompaction?: RemoteCompactionConfig<Api>;
	discovery: ProviderDiscovery;
	optional?: boolean;
}

/** Registry-provided capabilities the protocol probes need; never the registry itself. */
export interface DiscoveryContext {
	/** Injected fetch implementation (tests stub this). */
	fetch: FetchImpl;
	/**
	 * Resolve a provider's bearer credential for `Authorization: Bearer …`.
	 * Returns undefined when no key is stored or it is a local/no-auth
	 * sentinel; otherwise an {@link ApiKey} whose resolver participates in the
	 * central force-refresh/rotate auth-retry policy on 401/usage-limit.
	 */
	getBearerApiKeyResolver(provider: string): Promise<ApiKey | undefined>;
}

type OllamaDiscoveredModelMetadata = {
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow?: number;
};

type LlamaCppDiscoveredServerMetadata = {
	contextWindow?: number;
	input?: ("text" | "image")[];
};

type LlamaCppModelListEntry = {
	id: string;
	contextWindow?: number;
};

function toPositiveNumberOrUndefined(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
}

function extractOllamaContextWindow(payload: Record<string, unknown>): number | undefined {
	const modelInfo = payload.model_info;
	if (isRecord(modelInfo)) {
		for (const [key, value] of Object.entries(modelInfo)) {
			if (key === "context_length" || key.endsWith(".context_length")) {
				const contextWindow = toPositiveNumberOrUndefined(value);
				if (contextWindow !== undefined) {
					return contextWindow;
				}
			}
		}
	}

	const parameters = payload.parameters;
	if (typeof parameters !== "string") {
		return undefined;
	}
	const match = parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:$|\n)/m);
	return match ? toPositiveNumberOrUndefined(match[1]) : undefined;
}

function extractLlamaCppContextWindow(payload: Record<string, unknown>): number | undefined {
	const generationSettings = payload.default_generation_settings;
	if (isRecord(generationSettings)) {
		const contextWindow = toPositiveNumberOrUndefined(generationSettings.n_ctx);
		if (contextWindow !== undefined) {
			return contextWindow;
		}
	}
	return toPositiveNumberOrUndefined(payload.n_ctx);
}

function extractLlamaCppModelContextWindow(item: Record<string, unknown>): number | undefined {
	const meta = item.meta;
	if (!isRecord(meta)) {
		return undefined;
	}
	return toPositiveNumberOrUndefined(meta.n_ctx) ?? toPositiveNumberOrUndefined(meta.n_ctx_train);
}

function parseLlamaCppModelList(payload: unknown): LlamaCppModelListEntry[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		return [];
	}
	return payload.data.flatMap(item => {
		if (!isRecord(item) || typeof item.id !== "string" || !item.id) {
			return [];
		}
		return [{ id: item.id, contextWindow: extractLlamaCppModelContextWindow(item) }];
	});
}

function extractLlamaCppInputCapabilities(payload: Record<string, unknown>): ("text" | "image")[] | undefined {
	const modalities = payload.modalities;
	if (!isRecord(modalities)) {
		return undefined;
	}
	return modalities.vision === true ? ["text", "image"] : ["text"];
}

export function discoverModelsByProviderType(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	switch (providerConfig.discovery.type) {
		case "ollama":
			return discoverOllamaModels(providerConfig, ctx);
		case "llama.cpp":
			return discoverLlamaCppModels(providerConfig, ctx);
		case "lm-studio":
		case "openai-models-list":
			return discoverOpenAIModelsList(providerConfig, ctx);
		case "proxy":
			return discoverProxyModels(providerConfig, ctx);
		case "litellm":
			return discoverLiteLLMModels(providerConfig, ctx);
	}
}

async function discoverOllamaModelMetadata(
	ctx: DiscoveryContext,
	endpoint: string,
	modelId: string,
	headers: Record<string, string> | undefined,
): Promise<OllamaDiscoveredModelMetadata | null> {
	const showUrl = `${endpoint}/api/show`;
	try {
		const response = await ctx.fetch(showUrl, {
			method: "POST",
			headers: { ...(headers ?? {}), "Content-Type": "application/json" },
			body: JSON.stringify({ model: modelId }),
			signal: AbortSignal.timeout(150),
		});
		if (!response.ok) {
			return null;
		}
		const payload = (await response.json()) as unknown;
		if (!isRecord(payload)) {
			return null;
		}
		const contextWindow = extractOllamaContextWindow(payload);
		const capabilities = payload.capabilities;
		if (Array.isArray(capabilities)) {
			const normalized = new Set(
				capabilities.flatMap(capability => (typeof capability === "string" ? [capability.toLowerCase()] : [])),
			);
			const supportsVision = normalized.has("vision") || normalized.has("image");
			return {
				reasoning: normalized.has("thinking"),
				input: supportsVision ? ["text", "image"] : ["text"],
				contextWindow,
			};
		}
		if (!isRecord(capabilities)) {
			return {
				reasoning: false,
				input: ["text"],
				contextWindow,
			};
		}
		const supportsVision = capabilities.vision === true || capabilities.image === true;
		return {
			reasoning: capabilities.thinking === true,
			input: supportsVision ? ["text", "image"] : ["text"],
			contextWindow,
		};
	} catch {
		return null;
	}
}

export async function discoverOllamaModels(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const endpoint = normalizeOllamaBaseUrl(providerConfig.baseUrl);
	const tagsUrl = `${endpoint}/api/tags`;
	const headers = { ...(providerConfig.headers ?? {}) };
	const response = await ctx.fetch(tagsUrl, {
		headers,
		signal: AbortSignal.timeout(250),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} from ${tagsUrl}`);
	}
	const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
	const entries = (payload.models ?? []).flatMap(item => {
		const id = item.model || item.name;
		return id ? [{ id, name: item.name || id }] : [];
	});
	const metadataById = new Map(
		await Promise.all(
			entries.map(
				async entry => [entry.id, await discoverOllamaModelMetadata(ctx, endpoint, entry.id, headers)] as const,
			),
		),
	);
	return entries.map(entry => {
		const metadata = metadataById.get(entry.id);
		return buildModel({
			id: entry.id,
			name: entry.name,
			api: providerConfig.api,
			provider: providerConfig.provider,
			baseUrl: `${endpoint}/v1`,
			reasoning: metadata?.reasoning ?? false,
			input: metadata?.input ?? ["text"],
			imageInputDecoder: "stb",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: metadata?.contextWindow ?? DISCOVERY_DEFAULT_CONTEXT_WINDOW,
			maxTokens: Math.min(metadata?.contextWindow ?? Number.POSITIVE_INFINITY, DISCOVERY_DEFAULT_MAX_TOKENS),
			headers: providerConfig.headers,
		} as ModelSpec<Api>);
	});
}

async function discoverLlamaCppServerMetadata(
	ctx: DiscoveryContext,
	baseUrl: string,
	headers: Record<string, string> | undefined,
): Promise<LlamaCppDiscoveredServerMetadata | null> {
	const propsUrl = `${toLlamaCppNativeBaseUrl(baseUrl)}/props`;
	try {
		const response = await ctx.fetch(propsUrl, {
			headers,
			signal: AbortSignal.timeout(150),
		});
		if (!response.ok) {
			return null;
		}
		const payload = (await response.json()) as unknown;
		if (!isRecord(payload)) {
			return null;
		}
		return {
			contextWindow: extractLlamaCppContextWindow(payload),
			input: extractLlamaCppInputCapabilities(payload),
		};
	} catch {
		return null;
	}
}

export async function discoverLlamaCppModels(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeLlamaCppBaseUrl(providerConfig.baseUrl);
	const modelsUrl = `${baseUrl}/models`;

	const baseHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
	let headers = baseHeaders;
	const attempt = async (h: Record<string, string>) => {
		const [response, metadata] = await Promise.all([
			ctx.fetch(modelsUrl, {
				headers: h,
				signal: AbortSignal.timeout(250),
			}),
			discoverLlamaCppServerMetadata(ctx, baseUrl, h),
		]);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from ${modelsUrl}`);
		}
		headers = h;
		return [response, metadata] as const;
	};
	const apiKey = await ctx.getBearerApiKeyResolver(providerConfig.provider);
	const [response, serverMetadata] = apiKey
		? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
		: await attempt(baseHeaders);
	const payload = (await response.json()) as unknown;
	const models = parseLlamaCppModelList(payload);
	const discovered: Model<Api>[] = [];
	for (const item of models) {
		const { id } = item;
		if (!id) continue;
		const contextWindow = item.contextWindow ?? serverMetadata?.contextWindow ?? DISCOVERY_DEFAULT_CONTEXT_WINDOW;
		discovered.push(
			buildModel({
				id,
				name: id,
				api: providerConfig.api,
				provider: providerConfig.provider,
				baseUrl,
				reasoning: false,
				input: serverMetadata?.input ?? ["text"],
				imageInputDecoder: "stb",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow,
				maxTokens: Math.min(contextWindow, DISCOVERY_DEFAULT_MAX_TOKENS),
				headers,
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
				},
			} as ModelSpec<Api>),
		);
	}
	return discovered;
}

export async function discoverLlamaCppModelContextWindow(
	model: Pick<Model<Api>, "provider" | "id" | "baseUrl" | "headers">,
	ctx: DiscoveryContext,
): Promise<number | undefined> {
	const baseUrl = normalizeLlamaCppBaseUrl(model.baseUrl);
	const modelsUrl = `${baseUrl}/models`;
	const baseHeaders: Record<string, string> = { ...(model.headers ?? {}) };
	const attempt = async (headers: Record<string, string>) => {
		const response = await ctx.fetch(modelsUrl, {
			headers,
			signal: AbortSignal.timeout(250),
		});
		if (!response.ok) {
			return undefined;
		}
		const entries = parseLlamaCppModelList(await response.json());
		return entries.find(entry => entry.id === model.id)?.contextWindow;
	};
	try {
		const apiKey = await ctx.getBearerApiKeyResolver(model.provider);
		return apiKey
			? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
			: await attempt(baseHeaders);
	} catch {
		return undefined;
	}
}

export async function discoverOpenAIModelsList(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeOpenAIModelsListBaseUrl(providerConfig.baseUrl);
	const modelsUrl = `${baseUrl}/models`;

	const baseHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
	let headers = baseHeaders;
	const attempt = async (h: Record<string, string>) => {
		const nativeMetadataPromise =
			providerConfig.discovery.type === "lm-studio"
				? fetchLmStudioNativeModelMetadata(baseUrl, ctx.fetch, { headers: h })
				: Promise.resolve(null);
		const [res, nativeMetadata] = await Promise.all([
			ctx.fetch(modelsUrl, {
				headers: h,
				signal: AbortSignal.timeout(10_000),
			}),
			nativeMetadataPromise,
		]);
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} from ${modelsUrl}`);
		}
		headers = h;
		return [res, nativeMetadata] as const;
	};
	const apiKey = await ctx.getBearerApiKeyResolver(providerConfig.provider);
	const [response, nativeMetadata] = apiKey
		? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
		: await attempt(baseHeaders);
	const payload = (await response.json()) as {
		data?: Array<{ id?: string; max_model_len?: unknown; context_length?: unknown }>;
	};
	const models = payload.data ?? [];
	const discovered: Model<Api>[] = [];
	for (const item of models) {
		const id = item.id;
		if (!id) continue;
		const nativeMetadataForModel = nativeMetadata?.get(id);
		const contextWindow =
			toPositiveNumberOrUndefined(item.max_model_len) ??
			toPositiveNumberOrUndefined(item.context_length) ??
			nativeMetadataForModel?.contextWindow ??
			DISCOVERY_DEFAULT_CONTEXT_WINDOW;
		discovered.push(
			buildModel({
				id,
				name: id,
				api: providerConfig.api,
				provider: providerConfig.provider,
				baseUrl,
				reasoning: false,
				input: nativeMetadataForModel?.input ?? ["text"],
				...(providerConfig.discovery.type === "lm-studio" ? { imageInputDecoder: "stb" as const } : {}),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow,
				maxTokens: Math.min(contextWindow, discoveryDefaultMaxTokens(providerConfig.api)),
				headers,
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
				},
			} as ModelSpec<Api>),
		);
	}
	return discovered;
}

export async function discoverLiteLLMModels(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeLiteLLMDiscoveryBaseUrl(providerConfig.baseUrl);
	const references = getBundledModelReferenceIndex();
	const resolveReference = (id: string) => resolveModelReference(id, references) as ModelSpec<Api> | undefined;
	const baseHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
	let headers = baseHeaders;
	const attempt = async (h: Record<string, string>) => {
		headers = h;
		let authError: (Error & { status: number }) | undefined;
		const authAwareFetch: FetchImpl = async (input, init) => {
			const response = await ctx.fetch(input, init);
			if (response.status === 401) {
				authError = new Error(`HTTP ${response.status} from ${String(input)}`) as Error & { status: number };
				authError.status = response.status;
			}
			return response;
		};
		const models = await fetchLiteLLMRichModels({
			api: providerConfig.api,
			provider: providerConfig.provider,
			baseUrl,
			headers: h,
			fetch: authAwareFetch,
			referenceResolver: resolveReference,
			signal: AbortSignal.timeout(10_000),
		});
		if (authError && models === null) {
			throw authError;
		}
		return models;
	};
	const apiKey = await ctx.getBearerApiKeyResolver(providerConfig.provider);
	let richModels: ModelSpec<Api>[] | null;
	try {
		richModels = apiKey
			? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
			: await attempt(baseHeaders);
	} catch (error) {
		const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
		if (status !== 401) {
			throw error;
		}
		richModels = null;
	}
	if (!richModels || richModels.length === 0) {
		return discoverOpenAIModelsList({ ...providerConfig, baseUrl }, ctx);
	}
	return richModels.map(spec => buildModel({ ...spec, headers }));
}

/**
 * Discover models from an Anthropic+OpenAI-compatible reseller proxy that
 * exposes both `/v1/messages` and `/v1/chat/completions`, advertising each
 * model's wire capabilities through `supported_endpoint_types` on
 * `GET /v1/models` (new-api / one-api-style proxies).
 *
 * Routing per model:
 *   supported_endpoint_types: ["anthropic", ...] -> api: "anthropic-messages"
 *   supported_endpoint_types: ["openai"]         -> api: "openai-completions"
 *   missing / neither                            -> provider-level api fallback
 *
 * Anthropic models share the same baseUrl; the Anthropic SDK strips a
 * trailing `/v1` itself before appending `/v1/messages`, so the discovery
 * URL (which ends in `/v1`) round-trips correctly.
 */
export async function discoverProxyModels(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeOpenAIModelsListBaseUrl(providerConfig.baseUrl);
	const modelsUrl = `${baseUrl}/models`;

	const baseHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
	let headers = baseHeaders;
	const attempt = async (h: Record<string, string>) => {
		const res = await ctx.fetch(modelsUrl, {
			headers: h,
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} from ${modelsUrl}`);
		}
		headers = h;
		return res;
	};
	const apiKey = await ctx.getBearerApiKeyResolver(providerConfig.provider);
	const response = apiKey
		? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
		: await attempt(baseHeaders);
	const payload = (await response.json()) as {
		data?: Array<{ id?: string; name?: string; supported_endpoint_types?: string[]; context_length?: number }>;
	};
	const items = payload.data ?? [];
	const discovered: Model<Api>[] = [];
	for (const item of items) {
		const id = item.id;
		if (!id) continue;
		const endpoints = item.supported_endpoint_types ?? [];
		const api: Api | undefined = endpoints.includes("anthropic")
			? "anthropic-messages"
			: endpoints.includes("openai")
				? "openai-completions"
				: providerConfig.api;
		if (!api) continue;
		const isAnthropic = api === "anthropic-messages";
		const reference = resolveModelReference(id, getBundledModelReferenceIndex());
		const discoveryName = typeof item.name === "string" ? item.name.trim() : "";
		const displayName =
			reference?.name ??
			(discoveryName && discoveryName !== id ? discoveryName : undefined) ??
			stripBracketedModelIdAffixes(id) ??
			id;
		discovered.push(
			buildModel({
				id,
				name: displayName,
				api,
				provider: providerConfig.provider,
				baseUrl,
				reasoning: reference?.reasoning ?? false,
				thinking: reference?.thinking,
				input: reference?.input ?? ["text"],
				// Proxy pricing is provider-specific and usually does not match
				// upstream bundled catalogs, so keep costs local-unknown even when
				// we successfully recover the upstream model identity.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				// Prefer the context_length the API reports for this model; fall
				// back to the bundled reference, then a sane default.
				contextWindow:
					toPositiveNumberOrUndefined(item.context_length) ??
					reference?.contextWindow ??
					DISCOVERY_DEFAULT_CONTEXT_WINDOW,
				maxTokens: reference?.maxTokens ?? discoveryDefaultMaxTokens(api),
				headers,
				// OpenAI-compat fields are no-ops on anthropic models; the
				// Anthropic SDK ignores them. Provider-level disableStrictTools
				// flows in via #applyProviderCompat for the third-party-Anthropic
				// path. Cross-wire bundled compat is intentionally not copied:
				// request-shaping fields are provider-wire specific.
				compat: isAnthropic
					? undefined
					: {
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
						},
			} as ModelSpec<Api>),
		);
	}
	return discovered;
}

function normalizeLlamaCppBaseUrl(baseUrl?: string): string {
	const defaultBaseUrl = "http://127.0.0.1:8080";
	const raw = baseUrl || defaultBaseUrl;
	try {
		const parsed = new URL(raw);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		return `${parsed.protocol}//${parsed.host}${trimmedPath}`;
	} catch {
		return raw;
	}
}

function toLlamaCppNativeBaseUrl(baseUrl: string): string {
	try {
		const parsed = new URL(baseUrl);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath.slice(0, -3) || "/" : trimmedPath || "/";
		const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
		return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	} catch {
		return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
	}
}

export function normalizeLiteLLMDiscoveryBaseUrl(baseUrl?: string): string {
	return normalizeOpenAIModelsListBaseUrl(baseUrl ?? "http://localhost:4000/v1");
}

export function normalizeOpenAIModelsListBaseUrl(baseUrl?: string): string {
	const defaultBaseUrl = "http://127.0.0.1:1234/v1";
	const raw = baseUrl || defaultBaseUrl;
	try {
		const parsed = new URL(raw);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath || "/v1" : `${trimmedPath}/v1`;
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return raw;
	}
}

function normalizeOllamaBaseUrl(baseUrl?: string): string {
	const raw = baseUrl || DEFAULT_OLLAMA_BASE_URL;
	try {
		const parsed = new URL(raw);
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return DEFAULT_OLLAMA_BASE_URL;
	}
}
