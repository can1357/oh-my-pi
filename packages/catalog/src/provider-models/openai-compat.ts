import {
	fetchOpenAICompatibleModels,
	type OpenAICompatibleModelMapperContext,
	type OpenAICompatibleModelRecord,
} from "../discovery/openai-compatible";
import { Effort } from "../effort";
import { FIREWORKS_FAST_SUFFIX, toFireworksPublicModelId } from "../fireworks-model-id";
import { isGlmVisionModelId, isGrokReasoningEffortCapable, isReasoningGlmModelId } from "../identity/family";
import type { ModelManagerOptions } from "../model-manager";
import { getBundledModels } from "../models";
import type { Api, FetchImpl, Model, ModelSpec, OpenAICompat, Provider, ThinkingConfig } from "../types";
import { isAnthropicOAuthToken, isRecord, toBoolean, toNumber, toPositiveNumber } from "../utils";
import { coreWeaveProjectHeaders } from "../wire/coreweave";
import {
	COPILOT_API_HEADERS,
	getGitHubCopilotBaseUrl,
	isPersonalGitHubCopilotBaseUrl,
	parseGitHubCopilotApiKey,
} from "../wire/github-copilot";
import { createBundledReferenceMap, createReferenceResolver, toModelSpec } from "./bundled-references";

const MODELS_DEV_URL = "https://models.dev/api.json";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_OAUTH_BETA =
	"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11";

export interface ModelsDevModel {
	id?: string;
	name?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	modalities?: {
		input?: string[];
	};
	status?: string;
	provider?: { npm?: string };
}

function toModelName(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function toInputCapabilities(value: unknown): ("text" | "image")[] {
	if (!Array.isArray(value)) {
		return ["text"];
	}
	const supportsImage = value.some(item => item === "image");
	return supportsImage ? ["text", "image"] : ["text"];
}

async function fetchModelsDevPayload(fetchImpl: FetchImpl = fetch): Promise<unknown> {
	const response = await fetchImpl(MODELS_DEV_URL, {
		method: "GET",
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`models.dev fetch failed: ${response.status}`);
	}
	return response.json();
}

function mapAnthropicModelsDev(payload: unknown, baseUrl: string): ModelSpec<"anthropic-messages">[] {
	if (!isRecord(payload)) {
		return [];
	}
	const anthropicPayload = payload.anthropic;
	if (!isRecord(anthropicPayload)) {
		return [];
	}
	const modelsValue = anthropicPayload.models;
	if (!isRecord(modelsValue)) {
		return [];
	}

	const models: ModelSpec<"anthropic-messages">[] = [];
	for (const [modelId, rawModel] of Object.entries(modelsValue)) {
		if (!isRecord(rawModel)) {
			continue;
		}
		const model = rawModel as ModelsDevModel;
		if (model.tool_call !== true) {
			continue;
		}
		models.push({
			id: modelId,
			name: toModelName(model.name, modelId),
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl,
			reasoning: model.reasoning === true,
			input: toInputCapabilities(model.modalities?.input),
			cost: {
				input: toNumber(model.cost?.input) ?? 0,
				output: toNumber(model.cost?.output) ?? 0,
				cacheRead: toNumber(model.cost?.cache_read) ?? 0,
				cacheWrite: toNumber(model.cost?.cache_write) ?? 0,
			},
			contextWindow: toPositiveNumber(model.limit?.context, null),
			maxTokens: toPositiveNumber(model.limit?.output, null),
		});
	}

	models.sort((left, right) => left.id.localeCompare(right.id));
	return models;
}

function buildAnthropicDiscoveryHeaders(apiKey: string): Record<string, string> {
	const oauthToken = isAnthropicOAuthToken(apiKey);
	const headers: Record<string, string> = {
		"anthropic-version": "2023-06-01",
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-beta": ANTHROPIC_OAUTH_BETA,
	};
	if (oauthToken) {
		headers.Authorization = `Bearer ${apiKey}`;
	} else {
		headers["x-api-key"] = apiKey;
	}
	return headers;
}

function buildAnthropicReferenceMap(
	modelsDevModels: readonly ModelSpec<"anthropic-messages">[],
): Map<string, ModelSpec<"anthropic-messages">> {
	const merged = new Map<string, ModelSpec<"anthropic-messages">>();
	for (const model of modelsDevModels) {
		merged.set(model.id, model);
	}
	// Anthropic /v1/models does not carry token limits, so bundled metadata stays canonical
	// for known models while models.dev only fills gaps for newly discovered ids.
	const bundledModels = getBundledModels("anthropic").filter(
		(model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages",
	);
	for (const model of bundledModels) {
		merged.set(model.id, toModelSpec(model));
	}
	return merged;
}

/**
 * Curated Anthropic models that are live or limited-availability on the
 * first-party `/v1/models` endpoint but that models.dev has not catalogued yet.
 * Seeded into model generation so the bundled catalog is never gated on
 * models.dev's update cadence; deduped behind upstream catalog / models.dev
 * entries once those appear. Token limits and pricing are pinned
 * authoritatively in `applyAnthropicCatalogPolicy`, and `thinking` is re-baked
 * by the generator's policy pass (scripts/generated-policies.ts).
 */
export const ANTHROPIC_CURATED_FALLBACK_MODELS: readonly ModelSpec<"anthropic-messages">[] = [
	{
		id: "claude-fable-5",
		name: "Claude Fable 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-mythos-5",
		name: "Claude Mythos 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
];

function mapWithBundledReference<TApi extends Api>(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<TApi>,
	reference: ModelSpec<TApi> | undefined,
): ModelSpec<TApi> {
	const name = toModelName(entry.name, reference?.name ?? defaults.name);
	if (!reference) {
		return {
			...defaults,
			name,
		};
	}
	return {
		...reference,
		id: defaults.id,
		name,
		api: defaults.api,
		provider: defaults.provider,
		baseUrl: defaults.baseUrl,
		contextWindow: toPositiveNumber(entry.context_length, reference.contextWindow),
		maxTokens: toPositiveNumber(entry.max_completion_tokens, reference.maxTokens),
	};
}

function normalizeAnthropicBaseUrl(baseUrl: string | undefined, fallback: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return fallback;
	}
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toAnthropicDiscoveryBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

function normalizeOllamaBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return "http://127.0.0.1:11434/v1";
	}
	const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function toOllamaNativeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
}

async function fetchOllamaNativeModels(
	baseUrl: string,
	resolveMetadata: (modelId: string) => Promise<OllamaResolvedMetadata>,
	fetchImpl: FetchImpl = fetch,
): Promise<ModelSpec<"openai-responses">[] | null> {
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	let response: Response;
	try {
		response = await fetchImpl(`${nativeBaseUrl}/api/tags`, {
			method: "GET",
			headers: { Accept: "application/json" },
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		return null;
	}
	const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
	const entries = payload.models ?? [];
	const resolved = await Promise.all(
		entries.map(async (entry): Promise<ModelSpec<"openai-responses"> | null> => {
			const id = entry.model ?? entry.name;
			if (!id) return null;
			const metadata = await resolveMetadata(id);
			return {
				id,
				name: entry.name ?? id,
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				reasoning: metadata.reasoning ?? false,
				thinking: metadata.thinking,
				input: metadata.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: metadata.contextWindow,
				maxTokens: metadata.maxTokens,
			};
		}),
	);
	const models: ModelSpec<"openai-responses">[] = resolved.filter(
		(m): m is ModelSpec<"openai-responses"> => m !== null,
	);
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Fallback context window for Ollama models when `/api/show` is unavailable
 * or omits a `model_info.<arch>.context_length` field. Matches the size
 * Ollama's cloud catalog reports for stock models.
 */
const OLLAMA_FALLBACK_CONTEXT_WINDOW = 128_000;
/** Cap max output tokens at a value that matches OMP's other openai-responses defaults. */
const OLLAMA_DEFAULT_MAX_TOKENS = 8192;

interface OllamaResolvedMetadata {
	contextWindow: number;
	maxTokens: number;
	capabilities?: string[];
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
}

interface OllamaShowMetadata {
	contextWindow?: number;
	maxTokens?: number;
	capabilities?: string[];
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
}

function getOllamaContextWindow(modelInfo: Record<string, unknown> | undefined): number | undefined {
	if (!modelInfo) {
		return undefined;
	}
	for (const [key, value] of Object.entries(modelInfo)) {
		if (typeof value !== "number" || value <= 0) {
			continue;
		}
		if (key.endsWith(".context_length") || key.endsWith(".num_ctx") || key.endsWith(".context_window")) {
			return value;
		}
	}
}

function getOllamaCapabilities(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter((item): item is string => typeof item === "string");
}

function getOllamaThinkingConfig(capabilities: string[] | undefined): ThinkingConfig | undefined {
	if (!capabilities?.includes("thinking")) {
		return undefined;
	}
	return { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] };
}

/**
 * Query Ollama's `/api/show` endpoint for a single model and pull native
 * context and capability metadata from the response. Returns `undefined` when
 * the endpoint is unavailable so callers can layer their own fallback.
 */
async function fetchOllamaShowMetadata(
	nativeBaseUrl: string,
	modelId: string,
	fetchImpl: FetchImpl = fetch,
): Promise<OllamaShowMetadata | undefined> {
	try {
		const response = await fetchImpl(`${nativeBaseUrl}/api/show`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ model: modelId }),
		});
		if (!response.ok) {
			return undefined;
		}
		const payload = (await response.json()) as { capabilities?: unknown; model_info?: Record<string, unknown> };
		const capabilities = getOllamaCapabilities(payload.capabilities);
		const contextWindow = getOllamaContextWindow(payload.model_info);
		return {
			contextWindow,
			maxTokens: contextWindow ? OLLAMA_DEFAULT_MAX_TOKENS : undefined,
			capabilities,
			reasoning: capabilities ? capabilities.includes("thinking") : undefined,
			thinking: getOllamaThinkingConfig(capabilities),
			input: capabilities
				? capabilities.includes("vision")
					? (["text", "image"] as Array<"text" | "image">)
					: (["text"] as Array<"text">)
				: undefined,
		};
	} catch {
		// fall through; caller decides on the fallback
	}
	return undefined;
}

/**
 * Build a resolver that fetches `/api/show` metadata per model id and caches
 * the result in-memory for the lifetime of the manager. Successful lookups are
 * cached so repeated `fetchDynamicModels` calls do not refetch; failed
 * lookups stay uncached so a later refresh can recover.
 */
function createOllamaMetadataResolver(
	nativeBaseUrl: string,
	fetchImpl?: FetchImpl,
): (modelId: string) => Promise<OllamaResolvedMetadata> {
	const cache = new Map<string, Promise<OllamaResolvedMetadata>>();
	return modelId => {
		const cached = cache.get(modelId);
		if (cached) return cached;
		const pending = (async () => {
			const metadata = await fetchOllamaShowMetadata(nativeBaseUrl, modelId, fetchImpl);
			if (!metadata) {
				cache.delete(modelId);
				return { contextWindow: OLLAMA_FALLBACK_CONTEXT_WINDOW, maxTokens: OLLAMA_DEFAULT_MAX_TOKENS };
			}
			return {
				...metadata,
				contextWindow: metadata.contextWindow ?? OLLAMA_FALLBACK_CONTEXT_WINDOW,
				maxTokens: metadata.maxTokens ?? OLLAMA_DEFAULT_MAX_TOKENS,
			};
		})();
		cache.set(modelId, pending);
		void pending.catch(() => cache.delete(modelId));
		return pending;
	};
}

const OPENAI_NON_RESPONSES_PREFIXES = [
	"text-embedding",
	"whisper-",
	"tts-",
	"omni-moderation",
	"omni-transcribe",
	"omni-speech",
	"gpt-image-",
	"gpt-realtime",
] as const;

function isLikelyOpenAIResponsesModelId(id: string, references: Map<string, ModelSpec<"openai-responses">>): boolean {
	const trimmed = id.trim();
	if (!trimmed) {
		return false;
	}
	if (references.has(trimmed)) {
		return true;
	}
	const normalized = trimmed.toLowerCase();
	if (OPENAI_NON_RESPONSES_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
		return false;
	}
	if (normalized.includes("embedding")) {
		return false;
	}
	return (
		normalized.startsWith("gpt-") ||
		normalized.startsWith("o1") ||
		normalized.startsWith("o3") ||
		normalized.startsWith("o4") ||
		normalized.startsWith("chatgpt")
	);
}

const NANO_GPT_NON_TEXT_MODEL_TOKENS = [
	"embedding",
	"image",
	"vision",
	"audio",
	"speech",
	"transcribe",
	"moderation",
	"realtime",
	"whisper",
	"tts",
] as const;

/** Regex matching NanoGPT `:thinking` suffixed model IDs (with or without a level). */
const NANO_GPT_THINKING_SUFFIX_RE = /:thinking(:[^:]+)?$/;

function isLikelyNanoGptTextModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	if (NANO_GPT_THINKING_SUFFIX_RE.test(normalized)) {
		return false;
	}
	return !NANO_GPT_NON_TEXT_MODEL_TOKENS.some(token => normalized.includes(token));
}

type SimpleProviderDiscoveryHeaders = Record<string, string> | (() => Record<string, string> | undefined);
type SimpleProviderConfig = {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	headers?: SimpleProviderDiscoveryHeaders;
};

function resolveSimpleProviderHeaders(
	headers: SimpleProviderDiscoveryHeaders | undefined,
): Record<string, string> | undefined {
	return typeof headers === "function" ? headers() : headers;
}

export function createSimpleOpenAICompletionsOptions(
	providerId: Parameters<typeof getBundledModels>[0],
	defaultBaseUrl: string,
	config?: SimpleProviderConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? defaultBaseUrl;
	const references = createBundledReferenceMap<"openai-completions">(providerId);
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: providerId,
					baseUrl,
					apiKey,
					headers: resolveSimpleProviderHeaders(config?.headers),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						return mapWithBundledReference(entry, defaults, reference);
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

function createSimpleOpenAIResponsesOptions(
	providerId: Parameters<typeof getBundledModels>[0],
	defaultBaseUrl: string,
	config?: SimpleProviderConfig,
): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? defaultBaseUrl;
	const references = createBundledReferenceMap<"openai-responses">(providerId);
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-responses",
					provider: providerId,
					baseUrl,
					apiKey,
					headers: resolveSimpleProviderHeaders(config?.headers),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						return mapWithBundledReference(entry, defaults, reference);
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

function createSimpleAnthropicProviderOptions(
	providerId: Parameters<typeof getBundledModels>[0],
	defaultBaseUrlFallback: string,
	config?: SimpleProviderConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeAnthropicBaseUrl(config?.baseUrl, defaultBaseUrlFallback);
	const discoveryBaseUrl = toAnthropicDiscoveryBaseUrl(baseUrl);
	const references = createBundledReferenceMap<"anthropic-messages">(providerId);
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "anthropic-messages",
					provider: providerId,
					baseUrl: discoveryBaseUrl,
					headers: buildAnthropicDiscoveryHeaders(apiKey),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const model = mapWithBundledReference(entry, defaults, reference);
						return {
							...model,
							name: toModelName(entry.display_name, model.name),
							baseUrl,
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// Umans AI Coding Plan
// ---------------------------------------------------------------------------

const UMANS_BASE_URL = "https://api.code.umans.ai";
const UMANS_MODELS_INFO_PATH = "/models/info";
const UMANS_REASONING_EFFORT_BY_LEVEL: Record<string, Effort> = {
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.XHigh,
};
const UMANS_MAX_REASONING_EFFORT_MAP = { [Effort.XHigh]: "max" } as const;
const UMANS_DEFAULT_REASONING_EFFORTS = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] as const;
const UMANS_VIA_HANDOFF_MODEL_IDS = ["umans-glm-5.1", "umans-glm-5.2"] as const;

export interface UmansModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

interface UmansModelInfo {
	name?: unknown;
	display_name?: unknown;
	capabilities?: unknown;
}

function normalizeUmansBaseUrl(baseUrl: string | undefined): string {
	const normalized = normalizeAnthropicBaseUrl(baseUrl, UMANS_BASE_URL);
	return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

/**
 * Umans `models/info` reports `supports_vision: true` for natively
 * vision-capable models and a non-empty string sentinel (e.g.
 * `"via-handoff"`) for models that route image inputs through a vision
 * handoff pre-analysis step instead of accepting raw image blocks. Only
 * `true` means the model accepts image content directly; sentinel values
 * MUST map to text-only so the agent's vision-handoff path runs instead
 * of triggering an upstream HTTP 400 (`This model does not support image
 * inputs`).
 */
function umansSupportsVision(value: unknown): boolean {
	return value === true;
}

function umansReasoningSupported(value: unknown): boolean {
	return isRecord(value) ? value.supported === true : value === true;
}

function mapUmansReasoningEfforts(value: unknown): readonly Effort[] {
	if (!isRecord(value) || !Array.isArray(value.levels)) {
		return UMANS_DEFAULT_REASONING_EFFORTS;
	}
	const efforts: Effort[] = [];
	for (const level of value.levels) {
		if (typeof level !== "string") continue;
		const effort = UMANS_REASONING_EFFORT_BY_LEVEL[level];
		if (effort !== undefined && !efforts.includes(effort)) {
			efforts.push(effort);
		}
	}
	return efforts.length > 0 ? efforts : UMANS_DEFAULT_REASONING_EFFORTS;
}

function umansHasMaxReasoningLevel(value: unknown): boolean {
	return isRecord(value) && Array.isArray(value.levels) && value.levels.includes("max");
}

function mapUmansThinkingConfig(value: unknown): ThinkingConfig | undefined {
	if (!umansReasoningSupported(value)) return undefined;
	const efforts = mapUmansReasoningEfforts(value);
	const thinking: ThinkingConfig = {
		mode: umansHasMaxReasoningLevel(value) ? "anthropic-budget-effort" : "budget",
		efforts,
	};
	if (thinking.mode === "anthropic-budget-effort") {
		thinking.effortMap = UMANS_MAX_REASONING_EFFORT_MAP;
	}
	if (isRecord(value)) {
		if (value.can_disable === false) {
			thinking.requiresEffort = true;
		}
		if (typeof value.default_level === "string") {
			const defaultLevel = UMANS_REASONING_EFFORT_BY_LEVEL[value.default_level];
			if (defaultLevel !== undefined && efforts.includes(defaultLevel)) {
				thinking.defaultLevel = defaultLevel;
			}
		}
	}
	return thinking;
}

function mapUmansModelInfo(
	modelId: string,
	raw: UmansModelInfo,
	baseUrl: string,
	reference: ModelSpec<"anthropic-messages"> | undefined,
): ModelSpec<"anthropic-messages"> | null {
	if (!modelId) return null;
	const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
	const supportsTools = capabilities.supports_tools;
	const thinking = mapUmansThinkingConfig(capabilities.reasoning);
	return {
		...reference,
		id: modelId,
		name: toModelName(raw.display_name, toModelName(raw.name, modelId)),
		api: "anthropic-messages",
		provider: "umans",
		baseUrl,
		compat: { ...reference?.compat, escapeBuiltinToolNames: true },
		reasoning: thinking !== undefined,
		...(thinking ? { thinking } : {}),
		input: umansSupportsVision(capabilities.supports_vision) ? ["text", "image"] : ["text"],
		...(supportsTools === false ? { supportsTools: false } : {}),
		cost: reference?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: toPositiveNumber(capabilities.context_window, reference?.contextWindow ?? null),
		maxTokens: toPositiveNumber(
			capabilities.recommended_max_tokens,
			toPositiveNumber(capabilities.max_completion_tokens, reference?.maxTokens ?? null),
		),
	};
}

async function fetchUmansModelsInfo(options: {
	baseUrl: string;
	apiKey?: string;
	fetch?: FetchImpl;
	references: Map<string, ModelSpec<"anthropic-messages">>;
}): Promise<ModelSpec<"anthropic-messages">[] | null> {
	const discoveryBaseUrl = toAnthropicDiscoveryBaseUrl(options.baseUrl);
	const requestHeaders: Record<string, string> = { Accept: "application/json" };
	if (options.apiKey) {
		requestHeaders["x-api-key"] = options.apiKey;
	}
	const fetchImpl = options.fetch ?? fetch;
	let payload: unknown;
	try {
		const response = await fetchImpl(`${discoveryBaseUrl}${UMANS_MODELS_INFO_PATH}`, {
			method: "GET",
			headers: requestHeaders,
		});
		if (!response.ok) {
			return null;
		}
		payload = await response.json();
	} catch (error) {
		throw new Error("Failed to fetch Umans models info", { cause: error });
	}
	if (!isRecord(payload)) {
		return null;
	}
	const models: ModelSpec<"anthropic-messages">[] = [];
	for (const [modelId, value] of Object.entries(payload)) {
		if (!isRecord(value)) continue;
		const mapped = mapUmansModelInfo(modelId, value, options.baseUrl, options.references.get(modelId));
		if (mapped) {
			models.push(mapped);
		}
	}
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

export function umansModelManagerOptions(config?: UmansModelManagerConfig): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeUmansBaseUrl(config?.baseUrl);
	const references = createBundledReferenceMap<"anthropic-messages">("umans");
	return {
		providerId: "umans",
		dynamicModelsAuthoritative: true,
		dropCachedModelIdsOnStaticMismatch: UMANS_VIA_HANDOFF_MODEL_IDS,
		fetchDynamicModels: () => fetchUmansModelsInfo({ baseUrl, apiKey, fetch: config?.fetch, references }),
	};
}
// ---------------------------------------------------------------------------
// 1. OpenAI
// ---------------------------------------------------------------------------

export interface OpenAIModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function openaiModelManagerOptions(config?: OpenAIModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.openai.com/v1";
	const references = createBundledReferenceMap<"openai-responses">("openai");
	return {
		providerId: "openai",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-responses",
					provider: "openai",
					baseUrl,
					apiKey,
					filterModel: (_entry, model) => isLikelyOpenAIResponsesModelId(model.id, references),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						return mapWithBundledReference(entry, defaults, reference);
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 2. Groq
// ---------------------------------------------------------------------------

export interface GroqModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function groqModelManagerOptions(config?: GroqModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("groq", "https://api.groq.com/openai/v1", config);
}

// ---------------------------------------------------------------------------
// 3. Cerebras
// ---------------------------------------------------------------------------

export interface CerebrasModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function cerebrasModelManagerOptions(
	config?: CerebrasModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("cerebras", "https://api.cerebras.ai/v1", config);
}

// ---------------------------------------------------------------------------
// 4. Hugging Face
// ---------------------------------------------------------------------------

export interface HuggingfaceModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function huggingfaceModelManagerOptions(
	config?: HuggingfaceModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("huggingface", "https://router.huggingface.co/v1", config);
}

// ---------------------------------------------------------------------------
// 5. NVIDIA
// ---------------------------------------------------------------------------

export interface NvidiaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function nvidiaModelManagerOptions(
	config?: NvidiaModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("nvidia", "https://integrate.api.nvidia.com/v1", config);
}

// ---------------------------------------------------------------------------
// 6. xAI
// ---------------------------------------------------------------------------

export interface XaiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function xaiModelManagerOptions(config?: XaiModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("xai", "https://api.x.ai/v1", config);
}

export interface XaiOAuthModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

interface XAICuratedModel {
	id: string;
	contextWindow: number;
	name?: string;
	/** Whether the model reasons natively. Defaults to true for Grok-4.x family. */
	reasoning?: boolean;
	/**
	 * Whether xAI accepts the `reasoning.effort` wire param for this model.
	 * Default true. When false: the picker hides the effort dial (via
	 * getSupportedEfforts in model-thinking.ts) AND the wire omits the param —
	 * both derive from `isGrokReasoningEffortCapable` (identity/family.ts), the
	 * single allowlist shared by this curated layer and the compat builder.
	 */
	supportsReasoningEffort?: boolean;
	/**
	 * Input modalities this model accepts. Defaults to `["text"]` when absent.
	 * Vision-capable Grok models MUST list `"image"` here so the curated layer
	 * overrides `fetchOpenAICompatibleModels`' default of `["text"]` (which
	 * otherwise strips image capability on every online refresh).
	 */
	input?: ("text" | "image")[];
}

// Source of truth for the xai-oauth chat picker. Top of list = headline.
// Context windows from hermes-agent/agent/model_metadata.py:205-220
// ("Values sourced from models.dev (2026-04)"). grok-build is xAI's
// coding-fine-tuned chat model; 512K context per user spec (2026-05-17).
//
// supportsReasoningEffort=false entries reason natively but reject the wire
// `reasoning.effort` param (api.x.ai returns HTTP 400). The corresponding
// omit/include/history replay defaults live in catalog compat so every
// OpenAI-family endpoint consumes the same constraint.
export const XAI_OAUTH_CURATED_MODELS: readonly XAICuratedModel[] = [
	{
		id: "grok-build",
		contextWindow: 512_000,
		name: "Grok Build",
		supportsReasoningEffort: false,
		input: ["text", "image"],
	},
	{
		id: "grok-build-0.1",
		contextWindow: 256_000,
		name: "Grok Build 0.1",
		supportsReasoningEffort: false,
		input: ["text", "image"],
	},
	{ id: "grok-4.3", contextWindow: 1_000_000, name: "Grok 4.3", input: ["text", "image"] },
	// grok-4.20-multi-agent-0309 is text-only per the bundled catalog; omit `input` for the default.
	{ id: "grok-4.20-multi-agent-0309", contextWindow: 2_000_000, name: "Grok 4.20 (Multi-Agent)" },
	{
		id: "grok-4.20-0309-reasoning",
		contextWindow: 2_000_000,
		name: "Grok 4.20 (Reasoning)",
		supportsReasoningEffort: false,
		input: ["text", "image"],
	},
	{
		id: "grok-4.20-0309-non-reasoning",
		contextWindow: 2_000_000,
		name: "Grok 4.20 (Non-Reasoning)",
		reasoning: false,
		input: ["text", "image"],
	},
	// Cursor's "Composer 2.5 Fast" exposed via SuperGrok: non-reasoning,
	// text-only, 200K context (mirrors Cursor's composer-* catalog entries).
	// Off the Grok effort-capable allowlist; reasoning:false also hides the effort dial.
	{
		id: "grok-composer-2.5-fast",
		contextWindow: 200_000,
		name: "Grok Composer 2.5 Fast",
		reasoning: false,
		input: ["text"],
	},
] as const;

// xAI /v1/models returns chat, image, voice, and STT entries. Tool surfaces
// route through dedicated tools (generate_image, tts) with their own model
// strings; the chat picker MUST exclude these prefixes or selecting them 400s.
const XAI_NON_CHAT_PREFIXES = ["grok-imagine-", "grok-stt-", "grok-voice-"] as const;

function withXaiOAuthCompatDefaults(model: ModelSpec<"openai-responses">): ModelSpec<"openai-responses"> {
	const compat = {
		...(model.compat ?? {}),
		includeEncryptedReasoning: model.compat?.includeEncryptedReasoning ?? false,
		filterReasoningHistory: model.compat?.filterReasoningHistory ?? true,
		omitReasoningEffort: model.compat?.omitReasoningEffort ?? !isGrokReasoningEffortCapable(model.id),
	};
	return { ...model, compat };
}

// Hermes-agent parity: only the `minimal -> low` clamp is applied (see
// hermes-agent/agent/transports/codex.py:92 `_effort_clamp = {"minimal":
// "low"}`). Hermes sends `xhigh` to xAI verbatim and we match that contract
// — let xAI decide if the level is valid for the specific Grok model.
// `resolveModelThinking` folds this into `model.thinking.effortMap`, downstream
// of the omitReasoningEffort gate in pi-ai's stream.ts.
const XAI_REASONING_EFFORT_MAP = { minimal: "low" } as const;

// xai-oauth's /v1/models exposes no per-request output limit on the OAuth
// (Grok Build / SuperGrok) surface, so the curated catalog owns `maxTokens`
// like it owns `contextWindow`: each entry mirrors its context window. The
// openai-responses wire clamps the actual request to
// min(requested, model.maxTokens, OPENAI_MAX_OUTPUT_TOKENS=64000), so this is
// just "no model-specific sub-cap below 64k", not an unbounded output budget.

// Single source of truth for curated → Model fan-in. Used by the static-seed
// and the dynamic overlay/inject paths (applyXAIOAuthCuration) so curated
// reasoning/effort flags survive an online refresh (xAI's /v1/models lacks
// reasoning metadata and fetchOpenAICompatibleModels defaults reasoning to
// false). Caller supplies a `base` Model (either a freshly synthesised seed
// or a dynamic-fetched entry); the helper layers curated fields on top.
// The `minimal -> low` effort clamp (XAI_REASONING_EFFORT_MAP) is always
// merged in so dynamic-fetched models — which arrive without curated
// compat keys — still get the clamp applyResponsesReasoningParams expects.
function mergeCuratedIntoModel(
	base: ModelSpec<"openai-responses">,
	curated: XAICuratedModel,
): ModelSpec<"openai-responses"> {
	const effort = curated.supportsReasoningEffort;
	const compat = {
		...(base.compat ?? {}),
		reasoningEffortMap: { ...XAI_REASONING_EFFORT_MAP, ...(base.compat?.reasoningEffortMap ?? {}) },
		includeEncryptedReasoning: base.compat?.includeEncryptedReasoning ?? false,
		filterReasoningHistory: base.compat?.filterReasoningHistory ?? true,
		omitReasoningEffort: base.compat?.omitReasoningEffort ?? !isGrokReasoningEffortCapable(base.id),
		...(effort === undefined ? {} : { supportsReasoningEffort: effort }),
	};
	return {
		...base,
		contextWindow: curated.contextWindow,
		maxTokens: curated.contextWindow,
		name: curated.name ?? base.name,
		reasoning: curated.reasoning ?? true,
		input: curated.input ?? base.input,
		compat,
	};
}

/**
 * Overlay/inject curated xai-oauth metadata onto dynamic-fetch results so
 * a successful `online refresh` doesn't regress vision capability, context
 * window, reasoning flags, or the effort-dial allowlist.
 *
 * Three passes:
 *   1. Filter `XAI_NON_CHAT_PREFIXES` (picker pollution defense for tool
 *      surfaces routed through dedicated tools — generate_image, tts).
 *   2. Overlay curated metadata onto dynamic-fetch matches. xAI's /v1/models
 *      does not return context_window or reasoning metadata, so without
 *      this overlay the runtime falls back to the bundled-reference default
 *      (effectively 128k context) and `reasoning: false` (suppressing the
 *      effort dial and stripping thinking metadata downstream).
 *   3. Inject curated entries missing from the dynamic fetch. Clones the
 *      first surviving entry as a template so required Model fields (api,
 *      provider, baseUrl, cost, etc.) inherit sane defaults. If `filtered`
 *      is empty (offline / no auth) injection is skipped — the descriptor's
 *      defaultModel covers the fallback.
 *
 * Order: curated models first in declaration order; then dynamic remainder
 * in original order.
 */
function applyXAIOAuthCuration(dynamic: readonly ModelSpec<"openai-responses">[]): ModelSpec<"openai-responses">[] {
	const filtered = dynamic.filter(e => !XAI_NON_CHAT_PREFIXES.some(p => e.id.startsWith(p)));

	const byId = new Map<string, ModelSpec<"openai-responses">>(filtered.map(e => [e.id, e]));
	for (const curated of XAI_OAUTH_CURATED_MODELS) {
		const existing = byId.get(curated.id);
		if (existing) {
			byId.set(curated.id, mergeCuratedIntoModel(existing, curated));
		}
	}

	const template = filtered[0];
	if (template) {
		for (const curated of XAI_OAUTH_CURATED_MODELS) {
			if (!byId.has(curated.id)) {
				// Reset id/name on the template before merging so the helper's
				// `curated.name ?? base.name` clause falls back to curated.id
				// (the inject contract), not to the unrelated template's label.
				const base: ModelSpec<"openai-responses"> = { ...template, id: curated.id, name: curated.id };
				byId.set(curated.id, mergeCuratedIntoModel(base, curated));
			}
		}
	}

	const curatedIds = new Set(XAI_OAUTH_CURATED_MODELS.map(c => c.id));
	const curatedFirst = XAI_OAUTH_CURATED_MODELS.map(c => byId.get(c.id)).filter(
		(e): e is ModelSpec<"openai-responses"> => e !== undefined,
	);
	const rest = filtered.filter(e => !curatedIds.has(e.id)).map(withXaiOAuthCompatDefaults);
	return [...curatedFirst, ...rest];
}

/**
 * Render `XAI_OAUTH_CURATED_MODELS` as full `ModelSpec<"openai-responses">` entries.
 *
 * Single source of truth for the curated to Model fan-in, consumed by both
 * - {@link xaiOAuthModelManagerOptions} (runtime static seed handed to the model
 *   manager so the picker is populated on a fresh login), and
 * - \`packages/catalog/scripts/generate-models.ts\` (bundles the same entries into
 *   `models.json`, so the synchronous `ModelRegistry.#loadModels()` boot path
 *   sees `xai-oauth` without waiting for a refresh — fixes the boot-time
 *   default-model reset when `modelRoles.default = "xai-oauth/<id>"`).
 *
 * `reasoning` defaults to `true` for the Grok-4.x family; the explicit
 * `grok-4.20-0309-non-reasoning` entry opts out via `XAICuratedModel.reasoning`.
 * `maxTokens` mirrors each model's `contextWindow` (the OAuth surface reports
 * no per-request output limit); the openai-responses wire still clamps the
 * actual request to OPENAI_MAX_OUTPUT_TOKENS. Mirrors
 * `hermes-agent/hermes_cli/models.py:_XAI_STATIC_FALLBACK`.
 */
export function buildXaiOAuthStaticSeed(baseUrl?: string): ModelSpec<"openai-responses">[] {
	const resolvedBaseUrl = baseUrl ?? "https://api.x.ai/v1";
	return XAI_OAUTH_CURATED_MODELS.map(curated => {
		// Synthesise a bare base then layer curated metadata via the same helper
		// the dynamic overlay/inject paths use. `name: curated.id` is a sentinel
		// the helper rewrites to `curated.name ?? base.name`, so curated.name
		// wins when set.
		const base: ModelSpec<"openai-responses"> = {
			id: curated.id,
			name: curated.id,
			api: "openai-responses",
			provider: "xai-oauth",
			baseUrl: resolvedBaseUrl,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: curated.contextWindow,
			maxTokens: curated.contextWindow,
			compat: { reasoningEffortMap: XAI_REASONING_EFFORT_MAP },
		};
		return mergeCuratedIntoModel(base, curated);
	});
}

export function xaiOAuthModelManagerOptions(
	config?: XaiOAuthModelManagerConfig,
): ModelManagerOptions<"openai-responses"> {
	const defaultBaseUrl = "https://api.x.ai/v1";
	const resolvedBaseUrl = config?.baseUrl ?? defaultBaseUrl;
	const base = createSimpleOpenAIResponsesOptions(
		"xai-oauth" as Parameters<typeof getBundledModels>[0],
		defaultBaseUrl,
		config,
	);
	// Static seed handed to the runtime model manager so the picker populates on
	// a fresh login even before `fetchDynamicModels` fires (it is gated on
	// `config.apiKey` at construction time, and OAuth tokens resolve later via
	// AuthStorage). \`generate-models.ts\` calls the same builder so \`models.json\`
	// carries these entries too — making the synchronous `#loadModels()` boot
	// path honor `modelRoles.default = "xai-oauth/<id>"` without `await refresh()`.
	const staticModels = buildXaiOAuthStaticSeed(resolvedBaseUrl);
	if (!base.fetchDynamicModels) {
		return { ...base, staticModels };
	}
	// Wrap fetchDynamicModels so an `online refresh` against xAI's /v1/models
	// runs through applyXAIOAuthCuration — preserves curated context windows,
	// vision modality, reasoning flags, and filters tool-only model ids
	// (grok-imagine-*, grok-stt-*, grok-voice-*) from the chat picker.
	const inner = base.fetchDynamicModels;
	return {
		...base,
		staticModels,
		fetchDynamicModels: async () => {
			const dynamic = await inner();
			return dynamic == null ? dynamic : applyXAIOAuthCuration(dynamic);
		},
	};
}

// ---------------------------------------------------------------------------
// 6.4 AIML API
// ---------------------------------------------------------------------------

const AIML_API_NON_CHAT_MODEL_ID_PATTERN =
	/(?:^|[/:._-])(?:audio|embed|embedding|embeddings|i2i|i2v|image|speech|t2i|t2v|tts|video)(?:$|[/:._-])/i;

const AIML_API_NON_CHAT_MODEL_ID_SUBSTRINGS = ["dall-e", "dalle", "flux", "imagen", "sora", "veo", "whisper"] as const;

export function isLikelyAimlApiChatModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!normalized) return false;
	return (
		!AIML_API_NON_CHAT_MODEL_ID_PATTERN.test(normalized) &&
		!AIML_API_NON_CHAT_MODEL_ID_SUBSTRINGS.some(token => normalized.includes(token))
	);
}

export interface AimlApiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function aimlApiModelManagerOptions(
	config?: AimlApiModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.aimlapi.com/v1";
	const references = createBundledReferenceMap<"openai-completions">("aimlapi");
	return {
		providerId: "aimlapi",
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "aimlapi",
					baseUrl,
					apiKey,
					filterModel: (_entry, model) => isLikelyAimlApiChatModelId(model.id),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						return mapWithBundledReference(entry, defaults, reference);
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 6.5 DeepSeek
// ---------------------------------------------------------------------------

export interface DeepSeekModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function deepseekModelManagerOptions(
	config?: DeepSeekModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("deepseek", "https://api.deepseek.com", config);
}
// ---------------------------------------------------------------------------
// 6.7 Zhipu Coding Plan
// ---------------------------------------------------------------------------

export interface ZhipuCodingPlanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function zhipuCodingPlanModelManagerOptions(
	config?: ZhipuCodingPlanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://open.bigmodel.cn/api/coding/paas/v4";
	return {
		providerId: "zhipu-coding-plan",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "zhipu-coding-plan",
					baseUrl,
					apiKey,
					mapModel: (
						_entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): ModelSpec<"openai-completions"> => {
						const id = defaults.id;
						return {
							...defaults,
							reasoning: isReasoningGlmModelId(id) || id.includes("thinking"),
							input: isGlmVisionModelId(id) ? (["text", "image"] as const) : ["text"],
							compat: {
								thinkingFormat: "zai",
								reasoningContentField: "reasoning_content",
								supportsDeveloperRole: false,
							},
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 7.5 Fireworks
// ---------------------------------------------------------------------------

/**
 * Fireworks-published cap for the Kimi K2 family. Fireworks' `/v1/models`
 * envelope generically reports `max_completion_tokens: 65536` for every Kimi
 * deployment, but Kimi K2 (instruct / thinking / turbo) on Fireworks is
 * documented to ship long reasoning traces that should be bounded — capping
 * at 32,768 prevents handing callers a budget the router cannot honor.
 * See https://github.com/can1357/oh-my-pi/issues/1849.
 */
export const FIREWORKS_KIMI_MAX_TOKENS = 32_768;

/**
 * Returns true for any Kimi K2.x public model id served by Fireworks-backed
 * providers (`fireworks` direct, `firepass` router). Matches both the public
 * catalog id (`kimi-k2.5`, `kimi-k2.6`, `kimi-k2.6-turbo`) and the canonical
 * Fireworks wire id (`accounts/fireworks/{models,routers}/kimi-k2…`).
 */
export function isFireworksKimiK2ModelId(modelId: string): boolean {
	const trimmed = modelId.toLowerCase();
	if (trimmed.startsWith("kimi-k2")) return true;
	return /\/kimi-k2(?:p\d+)?(?:[._-]|$)/.test(trimmed);
}

/**
 * Clamp the Kimi K2 family's `maxTokens` to {@link FIREWORKS_KIMI_MAX_TOKENS}
 * on Fireworks-backed providers, leaving every other model untouched.
 */
export function clampFireworksKimiMaxTokens(modelId: string, candidate: number): number;
export function clampFireworksKimiMaxTokens(modelId: string, candidate: number | null): number | null;
export function clampFireworksKimiMaxTokens(modelId: string, candidate: number | null): number | null {
	if (candidate === null) return null;
	return isFireworksKimiK2ModelId(modelId) ? Math.min(candidate, FIREWORKS_KIMI_MAX_TOKENS) : candidate;
}

/**
 * Kimi K2.7 Code's documented recommended output budget. Some provider
 * discovery rows report the context-sized `max_completion_tokens` instead.
 */
export const KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS = 32_768;

export function isKimiK27CodeModelId(modelId: string): boolean {
	return /(?:^|\/)kimi[-._]?k2(?:[._-]?|p)7[-._]?code$/i.test(modelId);
}

export function clampKimiK27CodeMaxTokens(modelId: string, candidate: number): number;
export function clampKimiK27CodeMaxTokens(modelId: string, candidate: number | null): number | null;
export function clampKimiK27CodeMaxTokens(modelId: string, candidate: number | null): number | null {
	if (candidate === null) return null;
	return isKimiK27CodeModelId(modelId) ? Math.min(candidate, KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS) : candidate;
}

/**
 * Fireworks Fast variants we surface. Each inherits the base model's
 * limits/modalities/thinking and overrides only the cost with the Standard-column
 * Fast prices from the Serverless pricing table; `cacheWrite` stays 0 (Fireworks
 * bills no cache-write). Derived from the bundled base entries so metadata stays
 * in lockstep, and the runtime auto-falls back to the base id on a failed fast
 * request. See https://docs.fireworks.ai/serverless/pricing.
 */
const FIREWORKS_FAST_VARIANT_SPECS: ReadonlyArray<{
	base: string;
	name: string;
	cost: { input: number; output: number; cacheRead: number };
}> = [
	{ base: "kimi-k2.7-code", name: "Kimi K2.7 Code Fast", cost: { input: 1.9, output: 8, cacheRead: 0.38 } },
	{ base: "kimi-k2.6", name: "Kimi K2.6 Fast", cost: { input: 2, output: 8, cacheRead: 0.3 } },
	{ base: "glm-5.1", name: "GLM-5.1 Fast", cost: { input: 2.8, output: 8.8, cacheRead: 0.52 } },
];

/**
 * Build the Fireworks Fast seed by projecting each base bundled spec into a
 * `<id>-fast` variant. Pushed into the generated catalog (Fast routers never
 * appear in the serverless control-plane list, so discovery cannot surface
 * them) and deduped behind any identical previous-snapshot entry.
 */
export function buildFireworksFastSeed(): ModelSpec<"openai-completions">[] {
	const bundled = createBundledReferenceMap<"openai-completions">("fireworks");
	const seeds: ModelSpec<"openai-completions">[] = [];
	for (const variant of FIREWORKS_FAST_VARIANT_SPECS) {
		const base = bundled.get(variant.base);
		if (!base) continue;
		seeds.push({
			...base,
			id: `${variant.base}${FIREWORKS_FAST_SUFFIX}`,
			name: variant.name,
			cost: {
				input: variant.cost.input,
				output: variant.cost.output,
				cacheRead: variant.cost.cacheRead,
				cacheWrite: 0,
			},
		});
	}
	return seeds;
}

/**
 * Fireworks DeepSeek V4 accepts effort via `reasoning_effort` but rejects the
 * DeepSeek-native binary `thinking` toggle when both are present.
 */
export function stripFireworksDeepSeekThinkingToggle(
	model: ModelSpec<"openai-completions">,
	publicModelId: string,
): ModelSpec<"openai-completions"> {
	if (!publicModelId.startsWith("deepseek-v4")) return model;
	const compat = model.compat;
	if (!compat?.extraBody || !("thinking" in compat.extraBody)) return model;

	const extraBody = { ...compat.extraBody };
	delete extraBody.thinking;
	if (Object.keys(extraBody).length > 0) {
		return { ...model, compat: { ...compat, extraBody } };
	}

	const nextCompat = { ...compat };
	delete nextCompat.extraBody;
	return { ...model, compat: nextCompat };
}

export interface FireworksModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

const FIREWORKS_CONTROL_PLANE_ACCOUNT = "fireworks";
const FIREWORKS_SERVERLESS_FILTER = "supports_serverless=true";
const FIREWORKS_CONTROL_PLANE_PAGE_SIZE = 200;
const FIREWORKS_CONTROL_PLANE_MAX_PAGES = 25;

/**
 * One record from the Fireworks control-plane catalog
 * (`GET /v1/accounts/{account}/models`). This is distinct from the
 * OpenAI-compatible `/v1/models` inference envelope: the control plane
 * enumerates the full serverless catalog with camelCase capability metadata,
 * including on-demand models (e.g. `kimi-k2p7-code`) that never surface in
 * `/v1/models`. Discovering here is what keeps new serverless models appearing
 * without catalog edits — see the Fireworks docs `List Models` API.
 */
interface FireworksControlPlaneModel {
	/** Resource name, e.g. `accounts/fireworks/models/kimi-k2p7-code`. */
	name?: unknown;
	displayName?: unknown;
	contextLength?: unknown;
	supportsImageInput?: unknown;
	supportsTools?: unknown;
	supportsServerless?: unknown;
	state?: unknown;
}

/**
 * Derive the control-plane list endpoint from the inference base URL. The
 * inference API lives under `/inference/v1` while the control plane is
 * `/v1/accounts/<account>/models` on the same origin, so we route off origin.
 * Returns null for unparseable overrides (custom gateways) so discovery falls
 * back to the cached/bundled catalog.
 */
function toFireworksControlPlaneModelsUrl(baseUrl: string, account: string): string | null {
	try {
		return `${new URL(baseUrl).origin}/v1/accounts/${account}/models`;
	} catch {
		return null;
	}
}

function mapFireworksControlPlaneModel(
	record: FireworksControlPlaneModel,
	publicModelId: string,
	reference: ModelSpec<"openai-completions"> | undefined,
	baseUrl: string,
): ModelSpec<"openai-completions"> {
	const name = toModelName(record.displayName, reference?.name ?? publicModelId);
	const supportsImage = toBoolean(record.supportsImageInput) === true;
	const supportsTools = toBoolean(record.supportsTools);
	const contextWindow = toPositiveNumber(record.contextLength, reference?.contextWindow ?? null);
	// The control plane reports no max-output budget; default the Kimi family to
	// its published cap, everyone else to the discovery fallback, then clamp.
	const fallbackMaxTokens = isFireworksKimiK2ModelId(publicModelId) ? FIREWORKS_KIMI_MAX_TOKENS : null;
	const maxTokens = clampFireworksKimiMaxTokens(publicModelId, reference?.maxTokens ?? fallbackMaxTokens);
	const base: ModelSpec<"openai-completions"> = reference ?? {
		id: publicModelId,
		name,
		api: "openai-completions",
		provider: "fireworks",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
	const model: ModelSpec<"openai-completions"> = {
		...base,
		id: publicModelId,
		api: "openai-completions",
		provider: "fireworks",
		baseUrl,
		name,
		// The control plane exposes capability flags but no reasoning bit. Every
		// serverless chat LLM Fireworks ships reasons, and `buildModel` derives
		// the Fireworks effort map from the id at build time — so default
		// unbundled models to reasoning while bundled references keep their value.
		reasoning: reference?.reasoning ?? true,
		input: supportsImage ? ["text", "image"] : (reference?.input ?? ["text"]),
		contextWindow,
		maxTokens,
		...(supportsTools === false ? { supportsTools: false } : {}),
	};
	return stripFireworksDeepSeekThinkingToggle(model, publicModelId);
}

/**
 * Discover Fireworks serverless models via the control-plane `List Models`
 * API (`supports_serverless=true`), paginating the full catalog. Returns null
 * on any transport/protocol failure so the model manager keeps the cached or
 * bundled catalog rather than caching a truncated list as authoritative.
 */
async function fetchFireworksServerlessModels(options: {
	baseUrl: string;
	apiKey: string;
	resolveReference: (publicModelId: string) => ModelSpec<"openai-completions"> | undefined;
	fetch?: FetchImpl;
}): Promise<ModelSpec<"openai-completions">[] | null> {
	const listUrl = toFireworksControlPlaneModelsUrl(options.baseUrl, FIREWORKS_CONTROL_PLANE_ACCOUNT);
	if (!listUrl) return null;
	const fetchImpl = options.fetch ?? fetch;
	const collected = new Map<string, ModelSpec<"openai-completions">>();
	let pageToken = "";
	for (let page = 0; page < FIREWORKS_CONTROL_PLANE_MAX_PAGES; page++) {
		const url = new URL(listUrl);
		url.searchParams.set("filter", FIREWORKS_SERVERLESS_FILTER);
		url.searchParams.set("pageSize", String(FIREWORKS_CONTROL_PLANE_PAGE_SIZE));
		if (pageToken) url.searchParams.set("pageToken", pageToken);
		let response: Response;
		try {
			response = await fetchImpl(url.toString(), {
				method: "GET",
				headers: { Accept: "application/json", Authorization: `Bearer ${options.apiKey}` },
			});
		} catch {
			return null;
		}
		if (!response.ok) return null;
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return null;
		}
		if (!isRecord(payload)) return null;
		const models = Array.isArray(payload.models) ? payload.models : [];
		for (const entry of models) {
			if (!isRecord(entry)) continue;
			const record = entry as FireworksControlPlaneModel;
			if (toBoolean(record.supportsServerless) !== true) continue;
			if (typeof record.state === "string" && record.state !== "READY") continue;
			const wireName = typeof record.name === "string" ? record.name : "";
			if (!wireName) continue;
			const publicModelId = toFireworksPublicModelId(wireName);
			if (!publicModelId) continue;
			collected.set(
				publicModelId,
				mapFireworksControlPlaneModel(
					record,
					publicModelId,
					options.resolveReference(publicModelId),
					options.baseUrl,
				),
			);
		}
		const next = typeof payload.nextPageToken === "string" ? payload.nextPageToken : "";
		if (!next) break;
		pageToken = next;
	}
	return Array.from(collected.values());
}

function createModelsDevReferenceMap<TApi extends Api>(
	models: readonly ModelSpec<Api>[],
): Map<string, ModelSpec<TApi>> {
	const references = new Map<string, ModelSpec<TApi>>();
	for (const model of models) {
		const candidate = model as ModelSpec<TApi>;
		const existing = references.get(candidate.id);
		if (!existing) {
			references.set(candidate.id, candidate);
			continue;
		}
		if ((candidate.contextWindow ?? 0) > (existing.contextWindow ?? 0)) {
			references.set(candidate.id, candidate);
			continue;
		}
		if (
			candidate.contextWindow === existing.contextWindow &&
			(candidate.maxTokens ?? 0) > (existing.maxTokens ?? 0)
		) {
			references.set(candidate.id, candidate);
		}
	}
	return references;
}

async function loadModelsDevReferences<TApi extends Api>(fetchImpl?: FetchImpl): Promise<Map<string, ModelSpec<TApi>>> {
	try {
		const payload = await fetchModelsDevPayload(fetchImpl);
		return createModelsDevReferenceMap<TApi>(
			mapModelsDevToModels(payload as Record<string, unknown>, MODELS_DEV_PROVIDER_DESCRIPTORS),
		);
	} catch {
		return new Map<string, ModelSpec<TApi>>();
	}
}
export function fireworksModelManagerOptions(
	config?: FireworksModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.fireworks.ai/inference/v1";
	const bundledReferences = createReferenceResolver(createBundledReferenceMap<"openai-completions">("fireworks"));
	return {
		providerId: "fireworks",
		...(apiKey && {
			fetchDynamicModels: async () => {
				const modelsDevReferences = await loadModelsDevReferences<"openai-completions">(config?.fetch);
				return fetchFireworksServerlessModels({
					baseUrl,
					apiKey,
					resolveReference: publicModelId =>
						modelsDevReferences.get(publicModelId) ?? bundledReferences(publicModelId),
					fetch: config?.fetch,
				});
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// 7.6 Fire Pass (Fireworks Kimi K2.6 Turbo subscription)
// ---------------------------------------------------------------------------

export interface FirepassModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

/**
 * Fire Pass is a Fireworks subscription product that exposes a single router
 * model (Kimi K2.6 Turbo) under `accounts/fireworks/routers/kimi-k2p6-turbo`.
 * The dedicated `fpk_…` keys do not authorize `/v1/models`, so this manager
 * never performs dynamic discovery — the bundled catalog entry is canonical.
 * See https://docs.fireworks.ai/firepass.
 */
export function firepassModelManagerOptions(
	_config?: FirepassModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return {
		providerId: "firepass",
	};
}

// ---------------------------------------------------------------------------
// 7.7 Wafer Serverless
// ---------------------------------------------------------------------------

export interface WaferModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

const WAFER_DEFAULT_BASE_URL = "https://pass.wafer.ai/v1";
const WAFER_MAX_TOKENS_CAP = 65536;

/**
 * Mapper for Wafer Serverless `/v1/models` records.
 *
 * Wafer wraps each entry with a `wafer` envelope describing capabilities and
 * pricing. The mapper folds that metadata into the canonical
 * `ModelSpec<"openai-completions">` shape and applies upstream-specific thinking
 * compat when the entry advertises reasoning support. Wafer pricing is exposed
 * through internal wholesale units; the public Serverless rate equals
 * `cents × 125 / 10000`.
 */
interface WaferRecord {
	context_length?: unknown;
	tier?: unknown;
	provider?: unknown;
	capabilities?: { vision?: unknown; reasoning?: unknown; tools?: unknown };
	pricing?: {
		input_cents_per_million?: unknown;
		output_cents_per_million?: unknown;
		cache_read_cents_per_million?: unknown;
	};
	display_name?: unknown;
}

function readWaferRecord(entry: OpenAICompatibleModelRecord): WaferRecord | undefined {
	const raw = (entry as { wafer?: unknown }).wafer;
	return raw && typeof raw === "object" ? (raw as WaferRecord) : undefined;
}

function mapWaferModel(
	providerId: "wafer-serverless",
	baseUrl: string,
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
): ModelSpec<"openai-completions"> {
	const wafer = readWaferRecord(entry);
	const capabilities = wafer?.capabilities ?? {};
	const reasoning = capabilities.reasoning === true;
	const vision = capabilities.vision === true;
	const supportsTools = toBoolean(capabilities.tools) === false ? false : undefined;
	const contextWindow = toPositiveNumber(
		wafer?.context_length,
		toPositiveNumber((entry as { max_model_len?: unknown }).max_model_len, defaults.contextWindow),
	);
	const maxTokens = contextWindow !== null ? Math.min(contextWindow, WAFER_MAX_TOKENS_CAP) : null;
	const pricing = wafer?.pricing ?? {};
	const cost = {
		input: (toPositiveNumber(pricing.input_cents_per_million, 0) * 125) / 10000,
		output: (toPositiveNumber(pricing.output_cents_per_million, 0) * 125) / 10000,
		cacheRead: (toPositiveNumber(pricing.cache_read_cents_per_million, 0) * 125) / 10000,
		cacheWrite: 0,
	};
	const name = toModelName(wafer?.display_name, defaults.name);
	const base: ModelSpec<"openai-completions"> = {
		...defaults,
		id: defaults.id,
		name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		reasoning,
		input: vision ? (["text", "image"] as const) : ["text"],
		cost,
		contextWindow,
		maxTokens,
		...(supportsTools === false ? { supportsTools } : {}),
	};
	if (reasoning) {
		// Wafer's `wafer.provider` envelope tells us which upstream backend serves
		// the model. Each upstream accepts a different thinking-control parameter
		// on the wire — Wafer passes the body through, so we must mirror the
		// upstream's native shape:
		//   - zai (GLM) and moonshotai (Kimi) → `thinking: { type: "enabled" | "disabled" }`
		//   - qwen (Alibaba) → top-level `enable_thinking: boolean`
		//   - deepseek → `reasoning_effort` (DeepSeek effort map; the model always
		//     reasons when invoked, replay of `reasoning_content` is required on
		//     tool-call turns — both handled by `detectOpenAICompat` from the id).
		// For unknown upstreams we omit `thinkingFormat` and let the per-id
		// detection in `detectOpenAICompat` pick a safe default.
		const upstream = typeof wafer?.provider === "string" ? wafer.provider : undefined;
		const thinkingFormat: "zai" | "qwen" | undefined =
			upstream === "zai" || upstream === "moonshotai" ? "zai" : upstream === "qwen" ? "qwen" : undefined;
		return {
			...base,
			compat: {
				...(thinkingFormat ? { thinkingFormat } : {}),
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			},
		};
	}
	return {
		...base,
		compat: { supportsDeveloperRole: false },
	};
}

export function waferServerlessModelManagerOptions(
	config?: WaferModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? WAFER_DEFAULT_BASE_URL;
	const providerId = "wafer-serverless" as const;
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: providerId,
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => mapWaferModel(providerId, baseUrl, entry, defaults),
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 7. Mistral
// ---------------------------------------------------------------------------

export interface MistralModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function mistralModelManagerOptions(
	config?: MistralModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("mistral", "https://api.mistral.ai/v1", config);
}

// ---------------------------------------------------------------------------
// 8. OpenCode
// ---------------------------------------------------------------------------

export interface OpenCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function normalizeOpenCodeBasePath(baseUrl: string | undefined, fallbackBasePath: string): string {
	const value = normalizeAnthropicBaseUrl(baseUrl, fallbackBasePath);
	return value.endsWith("/v1") ? value.slice(0, -3) : value;
}

function openCodeBaseUrlForApi(api: Api, basePath: string): string {
	return api === "anthropic-messages" ? basePath : `${basePath}/v1`;
}

function openCodeModelManagerOptions(
	providerId: "opencode-go" | "opencode-zen",
	defaultBasePath: string,
	config?: OpenCodeModelManagerConfig,
): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const basePath = normalizeOpenCodeBasePath(config?.baseUrl, defaultBasePath);
	const discoveryBaseUrl = openCodeBaseUrlForApi("openai-completions", basePath);
	const references = createBundledReferenceMap<Api>(providerId);
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: providerId,
					baseUrl: discoveryBaseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const name = toModelName(entry.name, reference?.name ?? defaults.name);
						if (!reference) {
							return {
								...defaults,
								name,
							};
						}
						return {
							...reference,
							id: defaults.id,
							name,
							baseUrl: openCodeBaseUrlForApi(reference.api, basePath),
							contextWindow: toPositiveNumber(entry.context_length, reference.contextWindow),
							maxTokens: toPositiveNumber(entry.max_completion_tokens, reference.maxTokens),
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export function opencodeZenModelManagerOptions(config?: OpenCodeModelManagerConfig): ModelManagerOptions<Api> {
	return openCodeModelManagerOptions("opencode-zen", "https://opencode.ai/zen", config);
}

export function opencodeGoModelManagerOptions(config?: OpenCodeModelManagerConfig): ModelManagerOptions<Api> {
	return openCodeModelManagerOptions("opencode-go", "https://opencode.ai/zen/go", config);
}

// ---------------------------------------------------------------------------
// 9. Ollama
// ---------------------------------------------------------------------------

export interface OllamaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function ollamaModelManagerOptions(config?: OllamaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeOllamaBaseUrl(config?.baseUrl);
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	const references = createBundledReferenceMap<"openai-responses">("ollama" as Parameters<typeof getBundledModels>[0]);
	const resolveMetadata = createOllamaMetadataResolver(nativeBaseUrl, config?.fetch);
	return {
		providerId: "ollama",
		fetchDynamicModels: async () => {
			const openAiCompatible = await fetchOpenAICompatibleModels({
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					if (!reference) {
						return {
							...defaults,
							name: toModelName(entry.name, defaults.name),
							contextWindow: OLLAMA_FALLBACK_CONTEXT_WINDOW,
							maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
						};
					}
					return mapWithBundledReference(entry, defaults, reference);
				},
				fetch: config?.fetch,
			});
			if (openAiCompatible && openAiCompatible.length > 0) {
				await Promise.all(
					openAiCompatible.map(async model => {
						const metadata = await resolveMetadata(model.id);
						model.contextWindow = metadata.contextWindow;
						if (metadata.reasoning !== undefined) {
							model.reasoning = metadata.reasoning;
							model.thinking = metadata.thinking;
						}
						if (metadata.input) {
							model.input = metadata.input;
						}
					}),
				);
				return openAiCompatible;
			}
			const nativeFallback = await fetchOllamaNativeModels(baseUrl, resolveMetadata, config?.fetch);
			if (nativeFallback && nativeFallback.length > 0) {
				return nativeFallback;
			}
			return openAiCompatible;
		},
	};
}

// ---------------------------------------------------------------------------
// 10. OpenRouter
// ---------------------------------------------------------------------------

export interface OpenRouterModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function openrouterModelManagerOptions(
	config?: OpenRouterModelManagerConfig,
): ModelManagerOptions<"openrouter"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://openrouter.ai/api/v1";
	const references = createBundledReferenceMap<"openrouter">("openrouter");
	return {
		providerId: "openrouter",
		// Older builds cached OpenRouter discovery rows as `api: "openai-completions"`.
		// Namespace the refreshed pseudo-API cache separately so those rows cannot
		// override bundled `api: "openrouter"` models during online-if-uncached startup.
		cacheProviderId: "openrouter:pseudo-api",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openrouter",
				provider: "openrouter",
				baseUrl,
				apiKey,
				filterModel: (entry: OpenAICompatibleModelRecord) => {
					const params = entry.supported_parameters;
					return Array.isArray(params) && params.includes("tools");
				},
				mapModel: (
					entry: OpenAICompatibleModelRecord,
					defaults: ModelSpec<"openrouter">,
					_context: OpenAICompatibleModelMapperContext<"openrouter">,
				): ModelSpec<"openrouter"> => {
					const reference = references.get(defaults.id);
					const baseModel = mapWithBundledReference(entry, defaults, reference);
					const pricing = entry.pricing as Record<string, unknown> | undefined;
					const params = Array.isArray(entry.supported_parameters) ? (entry.supported_parameters as string[]) : [];
					const modality = String((entry.architecture as Record<string, unknown> | undefined)?.modality ?? "");
					const topProvider = entry.top_provider as Record<string, unknown> | undefined;

					const supportsToolChoice = params.includes("tool_choice");

					return {
						...baseModel,
						reasoning: params.includes("reasoning"),
						input: modality.includes("image") ? ["text", "image"] : ["text"],
						cost: {
							input: parseFloat(String(pricing?.prompt ?? "0")) * 1_000_000,
							output: parseFloat(String(pricing?.completion ?? "0")) * 1_000_000,
							cacheRead: parseFloat(String(pricing?.input_cache_read ?? "0")) * 1_000_000,
							cacheWrite: parseFloat(String(pricing?.input_cache_write ?? "0")) * 1_000_000,
						},
						contextWindow:
							typeof entry.context_length === "number" ? entry.context_length : baseModel.contextWindow,
						maxTokens:
							typeof topProvider?.max_completion_tokens === "number"
								? topProvider.max_completion_tokens
								: baseModel.maxTokens,
						...(!supportsToolChoice && {
							compat: { ...(baseModel.compat ?? {}), supportsToolChoice: false },
						}),
					};
				},
				fetch: config?.fetch,
			}),
	};
}

const ZENMUX_OPENAI_BASE_URL = "https://zenmux.ai/api/v1";
const ZENMUX_ANTHROPIC_BASE_URL = "https://zenmux.ai/api/anthropic";

function normalizeZenMuxOpenAiBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return ZENMUX_OPENAI_BASE_URL;
	}
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toZenMuxAnthropicBaseUrl(openAiBaseUrl: string): string {
	try {
		const parsed = new URL(openAiBaseUrl);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = trimmedPath.endsWith("/api/v1")
			? `${trimmedPath.slice(0, -"/api/v1".length)}/api/anthropic`
			: "/api/anthropic";
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return ZENMUX_ANTHROPIC_BASE_URL;
	}
}

function isZenMuxAnthropicModel(entry: OpenAICompatibleModelRecord, modelId: string): boolean {
	if (typeof entry.owned_by === "string" && entry.owned_by.toLowerCase() === "anthropic") {
		return true;
	}
	return modelId.toLowerCase().startsWith("anthropic/");
}

function getZenMuxPricingValue(pricings: Record<string, unknown> | undefined, key: string): number {
	const bucket = pricings?.[key];
	if (!Array.isArray(bucket)) {
		return 0;
	}
	for (const item of bucket) {
		if (!isRecord(item)) {
			continue;
		}
		const value = toNumber(item.value);
		if (value !== undefined) {
			return value;
		}
	}
	return 0;
}

function getZenMuxCacheWritePrice(pricings: Record<string, unknown> | undefined): number {
	const oneHour = getZenMuxPricingValue(pricings, "input_cache_write_1_h");
	if (oneHour > 0) {
		return oneHour;
	}
	const fiveMinute = getZenMuxPricingValue(pricings, "input_cache_write_5_min");
	if (fiveMinute > 0) {
		return fiveMinute;
	}
	return getZenMuxPricingValue(pricings, "input_cache_write");
}

// ---------------------------------------------------------------------------
// 10.5 ZenMux
// ---------------------------------------------------------------------------

export interface ZenMuxModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function zenmuxModelManagerOptions(config?: ZenMuxModelManagerConfig): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const openAiBaseUrl = normalizeZenMuxOpenAiBaseUrl(config?.baseUrl);
	const anthropicBaseUrl = toZenMuxAnthropicBaseUrl(openAiBaseUrl);
	return {
		providerId: "zenmux",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: "zenmux",
					baseUrl: openAiBaseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const pricings = isRecord(entry.pricings) ? entry.pricings : undefined;
						const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
						const isAnthropicModel = isZenMuxAnthropicModel(entry, defaults.id);
						return {
							...defaults,
							name: toModelName(entry.display_name, defaults.name),
							api: isAnthropicModel ? "anthropic-messages" : "openai-completions",
							baseUrl: isAnthropicModel ? anthropicBaseUrl : openAiBaseUrl,
							reasoning: capabilities?.reasoning === true || defaults.reasoning,
							input: toInputCapabilities(entry.input_modalities),
							cost: {
								input: getZenMuxPricingValue(pricings, "prompt"),
								output: getZenMuxPricingValue(pricings, "completion"),
								cacheRead: getZenMuxPricingValue(pricings, "input_cache_read"),
								cacheWrite: getZenMuxCacheWritePrice(pricings),
							},
							contextWindow: toPositiveNumber(entry.context_length, defaults.contextWindow),
							maxTokens: toPositiveNumber(entry.max_completion_tokens, defaults.maxTokens),
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 10.6 Kilo Gateway
// ---------------------------------------------------------------------------

export interface KiloModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function kiloModelManagerOptions(config?: KiloModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.kilo.ai/api/gateway";
	return {
		providerId: "kilo",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "kilo",
				baseUrl,
				apiKey,
				fetch: config?.fetch,
			}),
	};
}

// ---------------------------------------------------------------------------
// Alibaba Coding Plan
// ---------------------------------------------------------------------------

export interface AlibabaCodingPlanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function alibabaCodingPlanModelManagerOptions(
	config?: AlibabaCodingPlanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://coding-intl.dashscope.aliyuncs.com/v1";
	const references = createBundledReferenceMap<"openai-completions">("alibaba-coding-plan");
	return {
		providerId: "alibaba-coding-plan",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "alibaba-coding-plan",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					return mapWithBundledReference(entry, defaults, reference);
				},
				fetch: config?.fetch,
			}),
	};
}

// ---------------------------------------------------------------------------
// 11. Vercel AI Gateway
// ---------------------------------------------------------------------------

export interface VercelAiGatewayModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function normalizeVercelAiGatewayBaseUrls(rawBaseUrl: string | undefined): { baseUrl: string; catalogBaseUrl: string } {
	const baseUrl = (rawBaseUrl === undefined ? "https://ai-gateway.vercel.sh" : rawBaseUrl.trim()).replace(/\/+$/, "");
	const catalogBaseUrl = baseUrl === "" || baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

	return {
		baseUrl: baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl,
		catalogBaseUrl,
	};
}

export function vercelAiGatewayModelManagerOptions(
	config?: VercelAiGatewayModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const { baseUrl, catalogBaseUrl } = normalizeVercelAiGatewayBaseUrls(config?.baseUrl);
	return {
		providerId: "vercel-ai-gateway",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "anthropic-messages",
				provider: "vercel-ai-gateway",
				baseUrl: catalogBaseUrl,
				apiKey,
				filterModel: (entry: OpenAICompatibleModelRecord) => {
					const tags = entry.tags;
					return Array.isArray(tags) && tags.includes("tool-use");
				},
				mapModel: (
					entry: OpenAICompatibleModelRecord,
					defaults: ModelSpec<"anthropic-messages">,
					_context: OpenAICompatibleModelMapperContext<"anthropic-messages">,
				): ModelSpec<"anthropic-messages"> => {
					const pricing = entry.pricing as Record<string, unknown> | undefined;
					const tags = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];

					return {
						...defaults,
						baseUrl,
						reasoning: tags.includes("reasoning"),
						input: tags.includes("vision") ? ["text", "image"] : ["text"],
						cost: {
							input: (toNumber(pricing?.input) ?? 0) * 1_000_000,
							output: (toNumber(pricing?.output) ?? 0) * 1_000_000,
							cacheRead: (toNumber(pricing?.input_cache_read) ?? 0) * 1_000_000,
							cacheWrite: (toNumber(pricing?.input_cache_write) ?? 0) * 1_000_000,
						},
						contextWindow:
							typeof entry.context_window === "number" ? entry.context_window : defaults.contextWindow,
						maxTokens: typeof entry.max_tokens === "number" ? entry.max_tokens : defaults.maxTokens,
					};
				},
				fetch: config?.fetch,
			}),
	};
}

// ---------------------------------------------------------------------------
// 12. Kimi Code
// ---------------------------------------------------------------------------

export interface KimiCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function kimiCodeModelManagerOptions(
	config?: KimiCodeModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.kimi.com/coding/v1";
	return {
		providerId: "kimi-code",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "kimi-code",
					baseUrl,
					apiKey,
					headers: {
						"User-Agent": "KimiCLI/1.0",
						"X-Msh-Platform": "kimi_cli",
					},
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): ModelSpec<"openai-completions"> => {
						const id = defaults.id;
						return {
							...defaults,
							name: typeof entry.display_name === "string" ? entry.display_name : defaults.name,
							reasoning: entry.supports_reasoning === true || id.includes("thinking"),
							input: entry.supports_image_in === true || id.includes("k2.5") ? ["text", "image"] : ["text"],
							contextWindow: typeof entry.context_length === "number" ? entry.context_length : 262144,
							maxTokens: 32000,
							compat: {
								thinkingFormat: "zai",
								reasoningContentField: "reasoning_content",
								supportsDeveloperRole: false,
							},
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 12.5. LM Studio
// ---------------------------------------------------------------------------

/** Native LM Studio metadata keyed by model id from `/api/v0/models`. */
export interface LmStudioNativeModelMetadata {
	input: ("text" | "image")[];
	contextWindow?: number;
}

/** Options for LM Studio's optional native metadata probe. */
export interface LmStudioNativeModelMetadataOptions {
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

const LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS = 250;

function toLmStudioNativeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	const normalized = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
	return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

function getLmStudioCapabilityNames(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap(item => (typeof item === "string" ? [item.toLowerCase()] : []));
}

function getLmStudioNativeInput(entry: Record<string, unknown>): ("text" | "image")[] {
	const modelType = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
	const capabilities = getLmStudioCapabilityNames(entry.capabilities);
	const supportsImage = modelType === "vlm" || capabilities.includes("vision") || capabilities.includes("image");
	return supportsImage ? ["text", "image"] : ["text"];
}

function getLmStudioNativeContextWindow(entry: Record<string, unknown>): number | undefined {
	return (
		toPositiveNumber(entry.max_context_length, null) ??
		toPositiveNumber(entry.context_length, null) ??
		toPositiveNumber(entry.max_model_len, null) ??
		undefined
	);
}

/** Fetches LM Studio native model metadata used to mark VLM models as image-capable. */
export async function fetchLmStudioNativeModelMetadata(
	baseUrl: string,
	fetchImpl: FetchImpl = fetch,
	options?: LmStudioNativeModelMetadataOptions,
): Promise<Map<string, LmStudioNativeModelMetadata> | null> {
	const nativeBaseUrl = toLmStudioNativeBaseUrl(baseUrl);
	try {
		const response = await fetchImpl(`${nativeBaseUrl}/api/v0/models`, {
			method: "GET",
			headers: { Accept: "application/json", ...(options?.headers ?? {}) },
			signal: options?.signal ?? AbortSignal.timeout(LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS),
		});
		if (!response.ok) {
			return null;
		}
		const payload = await response.json();
		if (!isRecord(payload) || !Array.isArray(payload.data)) {
			return null;
		}
		const metadata = new Map<string, LmStudioNativeModelMetadata>();
		for (const entry of payload.data) {
			if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
				continue;
			}
			const contextWindow = getLmStudioNativeContextWindow(entry);
			metadata.set(entry.id, {
				input: getLmStudioNativeInput(entry),
				...(contextWindow === undefined ? {} : { contextWindow }),
			});
		}
		return metadata;
	} catch {
		return null;
	}
}

export interface LmStudioModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function lmStudioModelManagerOptions(
	config?: LmStudioModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? Bun.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
	const references = createBundledReferenceMap<"openai-completions">("lm-studio" as any);
	return {
		providerId: "lm-studio",
		fetchDynamicModels: async () => {
			const nativeMetadataPromise = fetchLmStudioNativeModelMetadata(baseUrl, config?.fetch, {
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			});
			const models = await fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "lm-studio",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					return mapWithBundledReference(entry, defaults, reference);
				},
				fetch: config?.fetch,
			});
			if (!models) {
				return models;
			}
			const nativeMetadata = await nativeMetadataPromise;
			if (!nativeMetadata) {
				return models;
			}
			return models.map(model => {
				const metadata = nativeMetadata.get(model.id);
				if (!metadata) {
					return model;
				}
				return {
					...model,
					input: metadata.input,
					contextWindow: metadata.contextWindow ?? model.contextWindow,
				};
			});
		},
	};
}

// ---------------------------------------------------------------------------
// 13. Synthetic
// ---------------------------------------------------------------------------

export interface SyntheticModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function syntheticModelManagerOptions(
	config?: SyntheticModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.synthetic.new/openai/v1";
	const references = new Map(
		(getBundledModels("synthetic") as Model<"openai-completions">[]).map(model => [model.id, toModelSpec(model)]),
	);
	return {
		providerId: "synthetic",
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "synthetic",
					baseUrl,
					apiKey,
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): ModelSpec<"openai-completions"> => {
						const reference = references.get(defaults.id);
						const referenceSupportsImage = reference?.input.includes("image") ?? false;
						return {
							...(reference ? { ...reference, id: defaults.id, baseUrl } : defaults),
							name: toModelName(entry.name, reference?.name ?? defaults.name),
							reasoning: entry.supports_reasoning === true || (reference?.reasoning ?? false),
							input: entry.supports_vision === true || referenceSupportsImage ? ["text", "image"] : ["text"],
							contextWindow: toPositiveNumber(
								entry.context_length,
								reference?.contextWindow ?? defaults.contextWindow,
							),
							maxTokens: toPositiveNumber(entry.max_tokens, reference?.maxTokens ?? 8192),
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 14. Venice
// ---------------------------------------------------------------------------

export interface VeniceModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function veniceModelManagerOptions(
	config?: VeniceModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.venice.ai/api/v1";
	const references = createBundledReferenceMap<"openai-completions">("venice");
	return {
		providerId: "venice",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "venice",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					const model = mapWithBundledReference(entry, defaults, reference);
					return {
						...model,
						maxTokens: clampKimiK27CodeMaxTokens(defaults.id, model.maxTokens),
						compat: { ...model.compat, supportsUsageInStreaming: false },
					};
				},
				fetch: config?.fetch,
			}),
	};
}

// ---------------------------------------------------------------------------
// 15. Together
// ---------------------------------------------------------------------------

export interface TogetherModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function togetherModelManagerOptions(
	config?: TogetherModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("together", "https://api.together.xyz/v1", config);
}

// ---------------------------------------------------------------------------
// 15.5 CoreWeave Serverless Inference
// ---------------------------------------------------------------------------

export interface CoreWeaveModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function coreWeaveModelManagerOptions(
	config?: CoreWeaveModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("coreweave", "https://api.inference.wandb.ai/v1", {
		...config,
		headers: () => coreWeaveProjectHeaders(Bun.env),
	});
}

// ---------------------------------------------------------------------------
// 16. Moonshot
// ---------------------------------------------------------------------------

export interface MoonshotModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function moonshotModelManagerOptions(
	config?: MoonshotModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	// `MOONSHOT_BASE_URL` redirects discovery (and the streaming request that
	// inherits this baseUrl) at the Kimi China platform `api.moonshot.cn`; an
	// explicit `config.baseUrl` still wins. Mirrors LITELLM_BASE_URL/LM_STUDIO_BASE_URL. (#2883)
	const baseUrl = config?.baseUrl ?? Bun.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1";
	const references = createBundledReferenceMap<"openai-completions">("moonshot");
	return {
		providerId: "moonshot",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "moonshot",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const model = mapWithBundledReference(entry, defaults, reference);
						const id = model.id.toLowerCase();
						// Moonshot's K2.x family (K2.5, K2.6, kimi-k2-thinking, …) is reasoning-capable
						// and vision-capable on the native API. Without these flags the openai-completions
						// path skips the z.ai-format `thinking` block, and Moonshot K2.6 stalls on first
						// turn because its endpoint expects an explicit `thinking: {type}` (#2113). Match
						// the bundled K2.5 metadata for every K2.x id we discover.
						const isKimiK2Reasoning = id.includes("thinking") || /(^|\/)kimi-k2(?:\.\d+)?(?:[-:]|$)/.test(id);
						const isVision =
							id.includes("vision") || id.includes("vl") || /(^|\/)kimi-k2(?:\.\d+)?(?:[-:]|$)/.test(id);
						return {
							...model,
							reasoning: isKimiK2Reasoning || model.reasoning,
							input: isVision ? ["text", "image"] : model.input,
							thinking:
								model.thinking ??
								(isKimiK2Reasoning
									? { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] }
									: undefined),
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 16.5 Sakana AI
// ---------------------------------------------------------------------------

const SAKANA_DEFAULT_BASE_URL = "https://api.sakana.ai/v1";
const SAKANA_FREE_ROUTER_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const SAKANA_FUGU_ULTRA_COST = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } as const;
const SAKANA_FUGU_ULTRA_CONTEXT_WINDOW = 1_000_000;
const SAKANA_FUGU_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.High, Effort.XHigh],
	effortMap: { [Effort.XHigh]: "max" },
};
const SAKANA_RESPONSES_COMPAT: ModelSpec<"openai-responses">["compat"] = {
	includeEncryptedReasoning: false,
	streamIdleTimeoutMs: 0,
};

function normalizeSakanaBaseUrl(baseUrl: string | undefined): string {
	const value = baseUrl?.trim() || SAKANA_DEFAULT_BASE_URL;
	const normalized = value.replace(/\/+$/, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function isSakanaFuguModelId(modelId: string): boolean {
	return /^fugu(?:$|-)/i.test(modelId);
}

function createSakanaFuguStaticModel(
	id: string,
	name: string,
	cost: ModelSpec<"openai-responses">["cost"],
	contextWindow: number | null,
): ModelSpec<"openai-responses"> {
	return {
		id,
		name,
		api: "openai-responses",
		provider: "sakana",
		baseUrl: SAKANA_DEFAULT_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { ...cost },
		contextWindow,
		maxTokens: null,
		thinking: { ...SAKANA_FUGU_THINKING },
		compat: { ...SAKANA_RESPONSES_COMPAT },
	};
}

export const SAKANA_FUGU_STATIC_MODELS: readonly ModelSpec<"openai-responses">[] = [
	createSakanaFuguStaticModel("fugu", "Fugu", SAKANA_FREE_ROUTER_COST, SAKANA_FUGU_ULTRA_CONTEXT_WINDOW),
	createSakanaFuguStaticModel("fugu-ultra", "Fugu Ultra", SAKANA_FUGU_ULTRA_COST, SAKANA_FUGU_ULTRA_CONTEXT_WINDOW),
	createSakanaFuguStaticModel(
		"fugu-ultra-20260615",
		"Fugu Ultra 20260615",
		SAKANA_FUGU_ULTRA_COST,
		SAKANA_FUGU_ULTRA_CONTEXT_WINDOW,
	),
];

const SAKANA_FUGU_STATIC_MODEL_BY_ID = new Map(SAKANA_FUGU_STATIC_MODELS.map(model => [model.id, model] as const));
const SAKANA_FUGU_STATIC_MODEL_IDS = SAKANA_FUGU_STATIC_MODELS.map(model => model.id);

export interface SakanaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function sakanaModelManagerOptions(config?: SakanaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeSakanaBaseUrl(config?.baseUrl ?? Bun.env.SAKANA_BASE_URL ?? Bun.env.FUGU_BASE_URL);
	const references = createBundledReferenceMap<"openai-responses">("sakana");
	return {
		providerId: "sakana",
		dynamicModelsAuthoritative: true,
		dropCachedModelIdsOnStaticMismatch: SAKANA_FUGU_STATIC_MODEL_IDS,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-responses",
					provider: "sakana",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id) ?? SAKANA_FUGU_STATIC_MODEL_BY_ID.get(defaults.id);
						const model = mapWithBundledReference(entry, defaults, reference);
						if (!reference && isSakanaFuguModelId(model.id)) {
							return {
								...model,
								reasoning: true,
								thinking: { ...SAKANA_FUGU_THINKING },
								compat: { ...SAKANA_RESPONSES_COMPAT },
							};
						}
						return model;
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 17. Qwen Portal
// ---------------------------------------------------------------------------

export interface QwenPortalModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function qwenPortalModelManagerOptions(
	config?: QwenPortalModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("qwen-portal", "https://portal.qwen.ai/v1", config);
}

// ---------------------------------------------------------------------------
// 18. Qianfan
// ---------------------------------------------------------------------------

export interface QianfanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function qianfanModelManagerOptions(
	config?: QianfanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("qianfan", "https://qianfan.baidubce.com/v2", config);
}

// ---------------------------------------------------------------------------
// 19. Cloudflare AI Gateway
// ---------------------------------------------------------------------------

export interface CloudflareAiGatewayModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function cloudflareAiGatewayModelManagerOptions(
	config?: CloudflareAiGatewayModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	return createSimpleAnthropicProviderOptions(
		"cloudflare-ai-gateway",
		"https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic",
		config,
	);
}

// ---------------------------------------------------------------------------
// 20. Xiaomi
// ---------------------------------------------------------------------------

/** Region codes for Xiaomi Token Plan clusters exposed as separate login providers. */
export type XiaomiTokenPlanRegion = "sgp" | "ams" | "cn";

/** Configures Xiaomi standard or regional Token Plan OpenAI-compatible model discovery. */
export interface XiaomiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	providerId?: Provider;
	tokenPlanRegion?: XiaomiTokenPlanRegion;
}

const XIAOMI_TOKEN_PLAN_BASE_URLS: Record<XiaomiTokenPlanRegion, string> = {
	sgp: "https://token-plan-sgp.xiaomimimo.com/v1",
	ams: "https://token-plan-ams.xiaomimimo.com/v1",
	cn: "https://token-plan-cn.xiaomimimo.com/v1",
};

const XIAOMI_TOKEN_PLAN_FALLBACK_BASE_URLS = [
	XIAOMI_TOKEN_PLAN_BASE_URLS.sgp,
	XIAOMI_TOKEN_PLAN_BASE_URLS.ams,
	XIAOMI_TOKEN_PLAN_BASE_URLS.cn,
];

/** Builds a Xiaomi model manager, preserving Token Plan region provider ids during discovery. */
export function xiaomiModelManagerOptions(
	config?: XiaomiModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const providerId = config?.providerId ?? "xiaomi";
	const tokenPlanBaseUrls = config?.tokenPlanRegion
		? [XIAOMI_TOKEN_PLAN_BASE_URLS[config.tokenPlanRegion]]
		: XIAOMI_TOKEN_PLAN_FALLBACK_BASE_URLS;
	const XIAOMI_STANDARD_BASE_URL = "https://api.xiaomimimo.com/v1";
	const isTokenPlanProvider = config?.tokenPlanRegion !== undefined || providerId.startsWith("xiaomi-token-plan-");
	const isTokenPlanKey = isTokenPlanProvider || apiKey?.startsWith("tp-");
	// Token-plan keys always use a TP cluster; config?.baseUrl (from catalog)
	// would incorrectly pin to the standard endpoint (api.xiaomimimo.com).
	const baseUrl = isTokenPlanKey ? tokenPlanBaseUrls[0] : (config?.baseUrl ?? XIAOMI_STANDARD_BASE_URL);
	const references = createBundledReferenceMap<"openai-completions">("xiaomi");
	const fetchModels = (url: string) =>
		fetchOpenAICompatibleModels({
			api: "openai-completions",
			provider: providerId,
			baseUrl: url,
			apiKey,
			filterModel: (_entry, model) => !model.id.includes("-tts") && !model.id.includes("-asr"),
			mapModel: (entry, defaults) => {
				const reference = references.get(defaults.id);
				const model = mapWithBundledReference(entry, defaults, reference);
				return {
					...model,
					api: "openai-completions",
					provider: providerId,
					baseUrl: defaults.baseUrl,
					name: toModelName(entry.display_name, model.name),
				};
			},
			fetch: config?.fetch,
		});
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: async () => {
				if (!isTokenPlanKey) {
					return fetchModels(baseUrl);
				}
				for (const url of tokenPlanBaseUrls) {
					const result = await fetchModels(url);
					if (result) return result;
				}
				return null;
			},
		}),
	};
}
// ---------------------------------------------------------------------------
// 21. LiteLLM
// ---------------------------------------------------------------------------

export interface LiteLLMModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export interface FetchLiteLLMRichModelsOptions<TApi extends Api> {
	api: TApi;
	provider: Provider;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	fetch?: FetchImpl;
	signal?: AbortSignal;
	referenceResolver?: (modelId: string) => ModelSpec<TApi> | undefined;
}

type LiteLLMRichModelEntry = Record<string, unknown>;

const LITELLM_RICH_ENDPOINTS = ["/model_group/info", "/v2/model/info", "/model/info", "/v1/model/info"] as const;
export const OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW = 128_000;
export const OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS = 32_768;
const UNKNOWN_PROXY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export function normalizeLiteLLMManagementBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/g, "");
	if (!trimmed) {
		return "";
	}
	try {
		const parsed = new URL(trimmed);
		const path = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = path.endsWith("/v1") ? path.slice(0, -3) || "/" : path || "/";
		const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
		return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	} catch {
		return trimmed.replace(/\/v1$/, "");
	}
}

function normalizeLiteLLMRuntimeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function toNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function extractLiteLLMRichEntries(payload: unknown): LiteLLMRichModelEntry[] | null {
	if (Array.isArray(payload)) {
		return payload.flatMap(entry => (isRecord(entry) ? [entry] : []));
	}
	if (!isRecord(payload)) {
		return null;
	}
	for (const candidate of [payload.data, payload.models, payload.result, payload.items]) {
		if (candidate === undefined) {
			continue;
		}
		const entries = extractLiteLLMRichEntries(candidate);
		if (entries !== null) {
			return entries;
		}
	}
	return null;
}

function getLiteLLMModelInfo(entry: LiteLLMRichModelEntry): LiteLLMRichModelEntry | undefined {
	return isRecord(entry.model_info) ? entry.model_info : undefined;
}

function getLiteLLMParams(entry: LiteLLMRichModelEntry): LiteLLMRichModelEntry | undefined {
	return isRecord(entry.litellm_params) ? entry.litellm_params : undefined;
}

function getLiteLLMMetadataValue(entry: LiteLLMRichModelEntry, key: string): unknown {
	return entry[key] ?? getLiteLLMModelInfo(entry)?.[key];
}

function getLiteLLMRichModelId(entry: LiteLLMRichModelEntry): string | undefined {
	return (
		toNonEmptyString(entry.model_group) ??
		toNonEmptyString(entry.model_name) ??
		toNonEmptyString(entry.id) ??
		toNonEmptyString(getLiteLLMParams(entry)?.model)
	);
}

function getSupportedOpenAIParams(entry: LiteLLMRichModelEntry): string[] | undefined {
	const value = getLiteLLMMetadataValue(entry, "supported_openai_params");
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.flatMap(item => (typeof item === "string" ? [item] : []));
}

function mapLiteLLMRichEntry<TApi extends Api>(
	entry: LiteLLMRichModelEntry,
	options: FetchLiteLLMRichModelsOptions<TApi>,
	runtimeBaseUrl: string,
): ModelSpec<TApi> | null {
	const id = getLiteLLMRichModelId(entry);
	if (!id) {
		return null;
	}
	const reference = options.referenceResolver?.(id);
	const modelName = toNonEmptyString(entry.model_name);
	const contextWindow = toPositiveNumber(
		getLiteLLMMetadataValue(entry, "max_input_tokens"),
		reference?.contextWindow ?? OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW,
	);
	const maxTokens = toPositiveNumber(
		getLiteLLMMetadataValue(entry, "max_output_tokens"),
		reference?.maxTokens ?? Math.min(contextWindow, OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS),
	);
	const supportsVision = getLiteLLMMetadataValue(entry, "supports_vision");
	const supportsReasoning = getLiteLLMMetadataValue(entry, "supports_reasoning");
	const supportedOpenAIParams = getSupportedOpenAIParams(entry);
	const supportsFunctionCalling = getLiteLLMMetadataValue(entry, "supports_function_calling");
	const supportsTools =
		supportsFunctionCalling === true
			? true
			: supportsFunctionCalling === false
				? false
				: supportedOpenAIParams !== undefined
					? supportedOpenAIParams.some(param =>
							["tools", "tool_choice", "functions", "function_call"].includes(param),
						)
					: reference?.supportsTools;
	const compat: OpenAICompat = {
		...(reference?.compat ?? {}),
		supportsStore: false,
		supportsDeveloperRole: false,
		...(supportedOpenAIParams !== undefined
			? { supportsReasoningEffort: supportedOpenAIParams.includes("reasoning_effort") }
			: {}),
	};
	return {
		id,
		name: modelName && modelName !== id ? modelName : (reference?.name ?? id),
		api: options.api,
		provider: options.provider,
		baseUrl: runtimeBaseUrl,
		contextWindow,
		maxTokens,
		input:
			supportsVision === true
				? ["text", "image"]
				: supportsVision === false
					? ["text"]
					: (reference?.input ?? ["text"]),
		reasoning: typeof supportsReasoning === "boolean" ? supportsReasoning : (reference?.reasoning ?? false),
		thinking: reference?.thinking,
		cost: reference?.cost ?? UNKNOWN_PROXY_COST,
		...(supportsTools !== undefined ? { supportsTools } : {}),
		compat: compat as ModelSpec<TApi>["compat"],
	};
}

async function fetchLiteLLMRichEndpoint<TApi extends Api>(
	endpoint: string,
	options: FetchLiteLLMRichModelsOptions<TApi>,
	managementBaseUrl: string,
	runtimeBaseUrl: string,
): Promise<ModelSpec<TApi>[] | null> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const requestHeaders: Record<string, string> = {
		Accept: "application/json",
		...options.headers,
	};
	if (options.apiKey) {
		requestHeaders.Authorization = `Bearer ${options.apiKey}`;
	}
	let response: Response;
	try {
		response = await fetchImpl(`${managementBaseUrl}${endpoint}`, {
			method: "GET",
			headers: requestHeaders,
			signal: options.signal,
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		return null;
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return null;
	}
	const entries = extractLiteLLMRichEntries(payload);
	if (!entries || entries.length === 0) {
		return null;
	}
	const deduped = new Map<string, ModelSpec<TApi>>();
	for (const entry of entries) {
		const model = mapLiteLLMRichEntry(entry, options, runtimeBaseUrl);
		if (model) {
			deduped.set(model.id, model);
		}
	}
	if (deduped.size === 0) {
		return null;
	}
	return Array.from(deduped.values()).sort((left, right) => left.id.localeCompare(right.id));
}

export async function fetchLiteLLMRichModels<TApi extends Api>(
	options: FetchLiteLLMRichModelsOptions<TApi>,
): Promise<ModelSpec<TApi>[] | null> {
	const managementBaseUrl = normalizeLiteLLMManagementBaseUrl(options.baseUrl);
	const runtimeBaseUrl = normalizeLiteLLMRuntimeBaseUrl(options.baseUrl);
	if (!managementBaseUrl || !runtimeBaseUrl) {
		return null;
	}
	for (const endpoint of LITELLM_RICH_ENDPOINTS) {
		const models = await fetchLiteLLMRichEndpoint(endpoint, options, managementBaseUrl, runtimeBaseUrl);
		if (models) {
			return models;
		}
	}
	return null;
}

export function litellmModelManagerOptions(
	config?: LiteLLMModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? Bun.env.LITELLM_BASE_URL ?? "http://localhost:4000/v1";
	return {
		providerId: "litellm",
		cacheProviderId: `litellm:rich-v1:${Bun.hash(baseUrl).toString(36)}`,
		// litellm is a local-only proxy and is never bundled in models.json (that
		// would leak the machine's localhost catalog). Prefer the proxy's richer
		// management metadata, then fall back to /v1/models and enrich bare ids
		// against models.dev like the gateway providers (fireworks et al.) do.
		fetchDynamicModels: async () => {
			const modelsDevReferences = await loadModelsDevReferences<"openai-completions">(config?.fetch);
			const resolveReference = (id: string) => modelsDevReferences.get(id);
			const richModels = await fetchLiteLLMRichModels({
				api: "openai-completions",
				provider: "litellm",
				baseUrl,
				apiKey,
				fetch: config?.fetch,
				referenceResolver: resolveReference,
				signal: AbortSignal.timeout(10_000),
			});
			if (richModels && richModels.length > 0) {
				return richModels;
			}
			return fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "litellm",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => mapWithBundledReference(entry, defaults, resolveReference(defaults.id)),
				fetch: config?.fetch,
			});
		},
	};
}

// ---------------------------------------------------------------------------
// 22. vLLM
// ---------------------------------------------------------------------------

const VLLM_DISCOVERY_TIMEOUT_MS = 10_000;

export interface VllmModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function vllmModelManagerOptions(config?: VllmModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "http://127.0.0.1:8000/v1";
	const references = createBundledReferenceMap<"openai-completions">("vllm" as Parameters<typeof getBundledModels>[0]);
	return {
		providerId: "vllm",
		cacheProviderId: `vllm:${Bun.hash(baseUrl).toString(36)}`,
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "vllm",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const model = mapWithBundledReference(entry, defaults, references.get(defaults.id));
					return {
						...model,
						contextWindow: toPositiveNumber(entry.max_model_len, model.contextWindow),
					};
				},
				fetch: config?.fetch,
				signal: AbortSignal.timeout(VLLM_DISCOVERY_TIMEOUT_MS),
			}),
	};
}

// ---------------------------------------------------------------------------
// 23. NanoGPT
// ---------------------------------------------------------------------------

export interface NanoGptModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function nanoGptModelManagerOptions(
	config?: NanoGptModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://nano-gpt.com/api/v1";
	const resolveReference = createReferenceResolver(
		createBundledReferenceMap<"openai-completions">("nanogpt" as Parameters<typeof getBundledModels>[0]),
	);
	return {
		providerId: "nanogpt",
		...(apiKey && {
			fetchDynamicModels: async () => {
				// Track base IDs that have :thinking variants so we can mark them reasoning-capable.
				const thinkingBaseIds = new Set<string>();
				const models = await fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "nanogpt",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = resolveReference(defaults.id);
						const mapped = mapWithBundledReference(entry, defaults, reference);
						return { ...mapped, api: "openai-completions", provider: "nanogpt" };
					},
					filterModel: (_entry, model) => {
						const match = NANO_GPT_THINKING_SUFFIX_RE.exec(model.id);
						if (match) {
							thinkingBaseIds.add(model.id.slice(0, match.index));
							return false;
						}
						return isLikelyNanoGptTextModelId(model.id);
					},
					fetch: config?.fetch,
				});
				if (!models) return null;
				// Mark base models as reasoning-capable when a :thinking variant existed.
				for (const model of models) {
					if (!model.reasoning && thinkingBaseIds.has(model.id)) {
						(model as { reasoning: boolean }).reasoning = true;
					}
				}
				return models;
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// 24. GitHub Copilot
// ---------------------------------------------------------------------------

export interface GithubCopilotModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

const COPILOT_ANTHROPIC_MODEL_PATTERN = /^claude-(haiku|sonnet|opus|fable|mythos)-\d/;
const isCopilotResponsesModelId = (modelId: string): boolean =>
	modelId.startsWith("gpt-5") || modelId.startsWith("oswe");

function inferCopilotApi(modelId: string): Api {
	if (COPILOT_ANTHROPIC_MODEL_PATTERN.test(modelId)) {
		return "anthropic-messages";
	}
	if (isCopilotResponsesModelId(modelId)) {
		return "openai-responses";
	}
	return "openai-completions";
}

function extractCopilotLimits(entry: OpenAICompatibleModelRecord): {
	maxPromptTokens?: number;
	maxContextWindowTokens?: number;
	maxOutputTokens?: number;
	maxNonStreamingOutputTokens?: number;
} {
	if (!isRecord(entry.capabilities)) {
		return {};
	}
	const limitsValue = entry.capabilities.limits;
	if (!isRecord(limitsValue)) {
		return {};
	}
	return {
		maxPromptTokens: toNumber(limitsValue.max_prompt_tokens),
		maxContextWindowTokens: toNumber(limitsValue.max_context_window_tokens),
		maxOutputTokens: toNumber(limitsValue.max_output_tokens),
		maxNonStreamingOutputTokens: toNumber(limitsValue.max_non_streaming_output_tokens),
	};
}

/** Local id/name suffixes for synthesized Copilot long-context variants. */
export const COPILOT_LONG_CONTEXT_ID_SUFFIX = "-1m";
const COPILOT_LONG_CONTEXT_NAME_SUFFIX = " (1M)";

/** One tier of Copilot token pricing (`billing.token_prices.{default,long_context}`). Prices are hundredths of a dollar per 1M tokens. */
interface CopilotTokenPriceTier {
	contextMax?: number;
	inputPrice?: number;
	outputPrice?: number;
	cachePrice?: number;
}

function parseCopilotTokenPriceTier(value: unknown): CopilotTokenPriceTier | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return {
		contextMax: toNumber(value.context_max),
		inputPrice: toNumber(value.input_price),
		outputPrice: toNumber(value.output_price),
		cachePrice: toNumber(value.cache_price),
	};
}

/**
 * Tiered context boundaries/prices from `billing.token_prices`. Served only
 * when discovery requests `X-GitHub-Api-Version` ≥ 2026-06-01; absent on the
 * legacy response shape (where `capabilities.limits` is already tier-capped).
 */
function extractCopilotTokenPrices(entry: OpenAICompatibleModelRecord): {
	defaultTier?: CopilotTokenPriceTier;
	longContext?: CopilotTokenPriceTier;
} {
	if (!isRecord(entry.billing)) {
		return {};
	}
	const tokenPrices = entry.billing.token_prices;
	if (!isRecord(tokenPrices)) {
		return {};
	}
	return {
		defaultTier: parseCopilotTokenPriceTier(tokenPrices.default),
		longContext: parseCopilotTokenPriceTier(tokenPrices.long_context),
	};
}

function extractCopilotSupportsVision(entry: OpenAICompatibleModelRecord): boolean | undefined {
	if (!isRecord(entry.capabilities)) {
		return undefined;
	}
	const supports = entry.capabilities.supports;
	if (!isRecord(supports)) {
		return undefined;
	}
	return toBoolean(supports.vision);
}

/** Copilot's `/models` mixes chat and embedding models; only `type: "chat"` entries are usable here. */
function isCopilotChatModel(entry: OpenAICompatibleModelRecord): boolean {
	if (!isRecord(entry.capabilities)) {
		return true;
	}
	const type = entry.capabilities.type;
	return typeof type !== "string" || type === "chat";
}

function copilotTierCost(
	tier: CopilotTokenPriceTier | undefined,
): Omit<ModelSpec<Api>["cost"], "cacheWrite"> | undefined {
	if (tier?.inputPrice === undefined || tier.outputPrice === undefined) {
		return undefined;
	}
	return {
		input: tier.inputPrice / 100,
		output: tier.outputPrice / 100,
		cacheRead: (tier.cachePrice ?? 0) / 100,
	};
}

/**
 * Synthesize the opt-in long-context sibling for a Copilot model that reports
 * a `billing.token_prices.long_context` tier (e.g. Claude Opus 200k → 1M, as
 * selectable in copilot-cli). The variant is a local catalog entry: it keeps
 * the upstream model id on the wire via `requestModelId` — the tier is purely
 * a client-side context budget with its own pricing, not a served model id.
 * The base entry stays on the default tier so nobody silently pays
 * long-context rates.
 */
function createCopilotLongContextVariant(
	base: ModelSpec<Api>,
	fullContextWindow: number | null,
	maxTokens: number | null,
	longContext: CopilotTokenPriceTier | undefined,
): ModelSpec<Api> | undefined {
	const longContextMax = longContext?.contextMax;
	if (longContextMax === undefined || longContextMax <= 0 || fullContextWindow === null || maxTokens === null) {
		return undefined;
	}
	const variantWindow = Math.min(fullContextWindow, longContextMax + maxTokens);
	if (base.contextWindow === null || variantWindow <= base.contextWindow) {
		return undefined;
	}
	const longCost = copilotTierCost(longContext);
	return {
		...base,
		id: `${base.id}${COPILOT_LONG_CONTEXT_ID_SUFFIX}`,
		requestModelId: base.id,
		name: `${base.name}${COPILOT_LONG_CONTEXT_NAME_SUFFIX}`,
		contextWindow: variantWindow,
		// Long-context tier has its own token prices (Gemini/GPT bill ~2x above
		// the default boundary). cacheWrite is not reported per tier; inherit.
		...(longCost && { cost: { ...longCost, cacheWrite: base.cost.cacheWrite } }),
		contextPromotionTarget: undefined,
	};
}

export function githubCopilotModelManagerOptions(config?: GithubCopilotModelManagerConfig): ModelManagerOptions<Api> {
	const rawApiKey = config?.apiKey;
	const configuredBaseUrl = config?.baseUrl ?? "https://api.githubcopilot.com";
	const parsedApiKey = rawApiKey ? parseGitHubCopilotApiKey(rawApiKey) : undefined;
	const apiKey = parsedApiKey?.accessToken;
	const baseUrl =
		parsedApiKey?.apiEndpoint && configuredBaseUrl.includes("githubcopilot.com")
			? parsedApiKey.apiEndpoint
			: parsedApiKey?.enterpriseUrl && configuredBaseUrl.includes("githubcopilot.com")
				? getGitHubCopilotBaseUrl(parsedApiKey.enterpriseUrl)
				: configuredBaseUrl;
	const providerRefs = createBundledReferenceMap<Api>("github-copilot");
	const resolveReference = createReferenceResolver(providerRefs);
	return {
		providerId: "github-copilot",
		...(apiKey && {
			fetchDynamicModels: async () => {
				const longContextVariants: ModelSpec<Api>[] = [];
				const models = await fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: "github-copilot",
					baseUrl,
					apiKey,
					headers: COPILOT_API_HEADERS,
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<Api>,
						_context: OpenAICompatibleModelMapperContext<Api>,
					): ModelSpec<Api> | null => {
						if (!isCopilotChatModel(entry)) {
							return null;
						}
						const reference = resolveReference(defaults.id);
						const copilotLimits = extractCopilotLimits(entry);
						// Copilot exposes token limits under capabilities.limits.*.
						// max_context_window_tokens is the model's total usable window;
						// max_prompt_tokens is Copilot's prompt/summarization budget and
						// must only be a fallback when total-window fields are absent.
						const contextWindow = toPositiveNumber(
							copilotLimits.maxContextWindowTokens,
							toPositiveNumber(
								entry.context_length,
								toPositiveNumber(
									copilotLimits.maxPromptTokens,
									reference?.contextWindow ?? defaults.contextWindow,
								),
							),
						);
						const maxTokens = toPositiveNumber(
							copilotLimits.maxOutputTokens,
							toPositiveNumber(
								entry.max_completion_tokens,
								toPositiveNumber(
									copilotLimits.maxNonStreamingOutputTokens,
									reference?.maxTokens ?? defaults.maxTokens,
								),
							),
						);
						const name =
							typeof entry.name === "string" && entry.name.trim().length > 0
								? entry.name
								: (reference?.name ?? defaults.name);
						const api = inferCopilotApi(defaults.id);
						// `supports.vision` reports the model's intrinsic capability, but
						// the business/enterprise endpoints respond `400 vision is not
						// supported` on image inputs. Only honour the flag for the
						// canonical personal-Copilot host.
						const supportsVision = extractCopilotSupportsVision(entry);
						const input: ModelSpec<Api>["input"] = isPersonalGitHubCopilotBaseUrl(baseUrl)
							? supportsVision
								? ["text", "image"]
								: (reference?.input ?? defaults.input)
							: ["text"];
						// With COPILOT_API_HEADERS the served window is the long-context
						// ceiling; the default tier ends at token_prices.default.context_max
						// prompt tokens. Cap the base entry to the default tier — the long
						// tier is the opt-in `-1m` sibling below.
						const tokenPrices = extractCopilotTokenPrices(entry);
						const defaultContextMax = tokenPrices.defaultTier?.contextMax;
						const defaultTierWindow =
							defaultContextMax !== undefined &&
							defaultContextMax > 0 &&
							contextWindow !== null &&
							maxTokens !== null
								? Math.min(contextWindow, defaultContextMax + maxTokens)
								: contextWindow;
						const base: ModelSpec<Api> = reference
							? {
									...reference,
									api,
									provider: "github-copilot",
									baseUrl,
									name,
									input,
									contextWindow: defaultTierWindow,
									maxTokens,
									headers: { ...COPILOT_API_HEADERS, ...(providerRefs.get(defaults.id)?.headers ?? {}) },
									...(api === "openai-completions"
										? {
												compat: {
													supportsStore: false,
													supportsDeveloperRole: false,
													supportsReasoningEffort: false,
												},
											}
										: {}),
								}
							: {
									...defaults,
									api,
									baseUrl,
									name,
									input,
									contextWindow: defaultTierWindow,
									maxTokens,
									headers: { ...COPILOT_API_HEADERS },
									...(api === "openai-completions"
										? {
												compat: {
													supportsStore: false,
													supportsDeveloperRole: false,
													supportsReasoningEffort: false,
												},
											}
										: {}),
								};
						const variant = createCopilotLongContextVariant(
							base,
							contextWindow,
							maxTokens,
							tokenPrices.longContext,
						);
						if (variant) {
							longContextVariants.push(variant);
							// Overflowing the default tier promotes into the 1M sibling
							// unless the reference already pins a target.
							base.contextPromotionTarget ??= `github-copilot/${variant.id}`;
						}
						return base;
					},
					fetch: config?.fetch,
				});
				if (models === null) {
					return null;
				}
				// Append synthesized tiers; a real upstream id always wins over a
				// local variant with the same id.
				const takenIds = new Set(models.map(model => model.id));
				for (const variant of longContextVariants) {
					if (takenIds.has(variant.id)) {
						continue;
					}
					takenIds.add(variant.id);
					models.push(variant);
				}
				return models.sort((left, right) => left.id.localeCompare(right.id));
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// 24. Anthropic
// ---------------------------------------------------------------------------

export interface AnthropicModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function anthropicModelManagerOptions(
	config?: AnthropicModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? ANTHROPIC_BASE_URL;
	return {
		providerId: "anthropic",
		modelsDev: {
			fetch: () => fetchModelsDevPayload(config?.fetch),
			map: payload => mapAnthropicModelsDev(payload, baseUrl),
		},
		...(apiKey && {
			fetchDynamicModels: async () => {
				const modelsDevModels = await fetchModelsDevPayload(config?.fetch)
					.then(payload => mapAnthropicModelsDev(payload, baseUrl))
					.catch(() => []);
				const references = buildAnthropicReferenceMap(modelsDevModels);
				return (
					fetchOpenAICompatibleModels({
						api: "anthropic-messages",
						provider: "anthropic",
						baseUrl,
						headers: buildAnthropicDiscoveryHeaders(apiKey),
						mapModel: (
							entry: OpenAICompatibleModelRecord,
							defaults: ModelSpec<"anthropic-messages">,
							_context: OpenAICompatibleModelMapperContext<"anthropic-messages">,
						): ModelSpec<"anthropic-messages"> => {
							const discoveredName = typeof entry.display_name === "string" ? entry.display_name : defaults.name;
							const reference = references.get(defaults.id);
							if (!reference) {
								return {
									...defaults,
									name: discoveredName,
								};
							}
							return {
								...reference,
								id: defaults.id,
								name: discoveredName,
								api: "anthropic-messages",
								provider: "anthropic",
								baseUrl,
							};
						},
						fetch: config?.fetch,
					}) ?? null
				);
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// Models.dev provider descriptors for generate-models.ts
// ---------------------------------------------------------------------------

/** Describes how to map models.dev API data for a single provider. */
export interface ModelsDevProviderDescriptor {
	/** Key in the models.dev API response JSON (e.g., "anthropic", "amazon-bedrock") */
	modelsDevKey: string;
	/** Provider ID in our system */
	providerId: string;
	/** Default API type for this provider's models */
	api: Api;
	/** Default base URL */
	baseUrl: string;
	/** Default context window fallback (default: UNKNNOWN_CONTEXT_WINDOW) */
	defaultContextWindow?: number;
	/** Default max tokens fallback (default: UNKNNOWN_MAX_TOKENS) */
	defaultMaxTokens?: number;
	/** Optional compat overrides applied to every model from this provider */
	compat?: ModelSpec<Api>["compat"];
	/** Optional static headers applied to every model */
	headers?: Record<string, string>;
	/**
	 * Optional filter: return false to skip a model.
	 * Called with (modelId, rawModel). Default: skip if tool_call !== true.
	 */
	filterModel?: (modelId: string, model: ModelsDevModel) => boolean;
	/**
	 * Optional transform: modify the mapped model before it's added.
	 * Can return null to skip the model, or an array to emit multiple models.
	 */
	transformModel?: (
		model: ModelSpec<Api>,
		modelId: string,
		raw: ModelsDevModel,
	) => ModelSpec<Api> | ModelSpec<Api>[] | null;
	/**
	 * Optional: override the API type per-model.
	 * Called with (modelId, raw). Return the API type to use.
	 * If not provided, uses the `api` field.
	 */
	resolveApi?: (modelId: string, raw: ModelsDevModel) => { api: Api; baseUrl: string } | null;
}

/** Generic mapper that converts models.dev data using provider descriptors. */
export function mapModelsDevToModels(
	data: Record<string, unknown>,
	descriptors: readonly ModelsDevProviderDescriptor[],
): ModelSpec<Api>[] {
	const models: ModelSpec<Api>[] = [];
	for (const desc of descriptors) {
		const providerData = (data as Record<string, Record<string, unknown>>)[desc.modelsDevKey];
		if (!isRecord(providerData) || !isRecord(providerData.models)) continue;

		for (const [modelId, rawModel] of Object.entries(providerData.models)) {
			if (!isRecord(rawModel)) continue;
			const m = rawModel as ModelsDevModel;

			// Default filter: tool_call must be true
			if (desc.filterModel) {
				if (!desc.filterModel(modelId, m)) continue;
			} else {
				if (m.tool_call !== true) continue;
			}

			// Resolve API and baseUrl (may be per-model for providers like OpenCode)
			const resolved = desc.resolveApi?.(modelId, m) ?? { api: desc.api, baseUrl: desc.baseUrl };
			if (!resolved) continue;

			const mapped: ModelSpec<Api> = {
				id: modelId,
				name: toModelName(m.name, modelId),
				api: resolved.api,
				provider: desc.providerId as ModelSpec<Api>["provider"],
				baseUrl: resolved.baseUrl,
				reasoning: m.reasoning === true,
				input: toInputCapabilities(m.modalities?.input),
				cost: {
					input: toNumber(m.cost?.input) ?? 0,
					output: toNumber(m.cost?.output) ?? 0,
					cacheRead: toNumber(m.cost?.cache_read) ?? 0,
					cacheWrite: toNumber(m.cost?.cache_write) ?? 0,
				},
				contextWindow: toPositiveNumber(m.limit?.context, desc.defaultContextWindow ?? null),
				maxTokens: toPositiveNumber(m.limit?.output, desc.defaultMaxTokens ?? null),
				...(m.tool_call === false ? { supportsTools: false } : {}),
				...(desc.compat && { compat: desc.compat }),
				...(desc.headers && { headers: { ...desc.headers } }),
			};

			// Apply per-model transform
			if (desc.transformModel) {
				const result = desc.transformModel(mapped, modelId, m);
				if (result === null) continue;
				if (Array.isArray(result)) {
					models.push(...result);
				} else {
					models.push(result);
				}
			} else {
				models.push(mapped);
			}
		}
	}
	return models;
}

// Bedrock cross-region prefix helpers
const BEDROCK_GLOBAL_PREFIXES = [
	"anthropic.claude-fable-5",
	"anthropic.claude-mythos-5",
	"anthropic.claude-haiku-4-5",
	"anthropic.claude-sonnet-4",
	"anthropic.claude-opus-4-5",
	"amazon.nova-2-lite",
	"cohere.embed-v4",
	"twelvelabs.pegasus-1-2",
];

const BEDROCK_US_PREFIXES = [
	"amazon.nova-lite",
	"amazon.nova-micro",
	"amazon.nova-premier",
	"amazon.nova-pro",
	"anthropic.claude-3-7-sonnet",
	"anthropic.claude-opus-4-1",
	"anthropic.claude-opus-4-20250514",
	"deepseek.r1",
	"meta.llama3-2",
	"meta.llama3-3",
	"meta.llama4",
];

function bedrockCrossRegionId(id: string): string {
	if (BEDROCK_GLOBAL_PREFIXES.some(p => id.startsWith(p))) return `global.${id}`;
	if (BEDROCK_US_PREFIXES.some(p => id.startsWith(p))) return `us.${id}`;
	return id;
}

interface ApiResolutionRule {
	matches: (modelId: string, raw: ModelsDevModel) => boolean;
	resolved: { api: Api; baseUrl: string };
}

function resolveApiByRules(
	modelId: string,
	raw: ModelsDevModel,
	rules: readonly ApiResolutionRule[],
	fallback: { api: Api; baseUrl: string },
): { api: Api; baseUrl: string } {
	for (const rule of rules) {
		if (rule.matches(modelId, raw)) return rule.resolved;
	}
	return fallback;
}

function createOpenCodeApiResolution(
	basePath: string,
	idOverrides: Readonly<Record<string, Api>> = {},
): {
	defaultResolution: { api: Api; baseUrl: string };
	rules: ApiResolutionRule[];
} {
	const completionsBaseUrl = `${basePath}/v1`;
	// Per-API base URLs on the OpenCode-style endpoint:
	// - openai-completions / openai-responses / google-generative-ai → /v1
	// - anthropic-messages → bare basePath (the Anthropic client appends /v1/messages)
	const baseUrlForApi = (api: Api): string => (api === "anthropic-messages" ? basePath : completionsBaseUrl);
	const overrideRules: ApiResolutionRule[] = Object.entries(idOverrides).map(([id, api]) => ({
		matches: modelId => modelId === id,
		resolved: { api, baseUrl: baseUrlForApi(api) },
	}));
	return {
		defaultResolution: { api: "openai-completions", baseUrl: completionsBaseUrl },
		rules: [
			// Per-id overrides take precedence over npm-based heuristics so we can
			// correct upstream metadata mismatches (see OPENCODE_GO_API_RESOLUTION).
			...overrideRules,
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/openai",
				resolved: { api: "openai-responses", baseUrl: completionsBaseUrl },
			},
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/anthropic",
				resolved: { api: "anthropic-messages", baseUrl: basePath },
			},
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/google",
				resolved: { api: "google-generative-ai", baseUrl: completionsBaseUrl },
			},
		],
	};
}

// OpenCode Zen: models.dev declares minimax-m3-free (and forward-compat
// minimax-m3) with `provider.npm = "@ai-sdk/anthropic"`, but the Zen gateway
// only serves them at https://opencode.ai/zen/v1/chat/completions (verified
// against the live /v1/models response — minimax-m3-free is listed there, and
// the gateway has no /v1/messages route for it). Without this override the
// resolver POSTs anthropic-shaped requests to /v1/messages and the UI surfaces
// raw <invoke>/<|minimax|>/<tool_call> markup (#1617).
const OPENCODE_ZEN_API_RESOLUTION = createOpenCodeApiResolution("https://opencode.ai/zen", {
	"minimax-m3": "openai-completions",
	"minimax-m3-free": "openai-completions",
});
// OpenCode Go: models.dev declares minimax-m2.7 / qwen3.5-plus / qwen3.6-plus
// (and now also minimax-m3) with `provider.npm = "@ai-sdk/anthropic"`, but
// the OpenCode Go gateway only serves them at
// `https://opencode.ai/zen/go/v1/chat/completions` (verified against
// https://opencode.ai/zen/go/v1/models and the upstream endpoint table at
// https://opencode.ai/docs/go/#endpoints — minimax-m2.5 works the same way
// and lacks an `npm` field on models.dev so it already falls through to the
// openai-completions default). Without this override the resolver would POST
// anthropic-style requests to /v1/messages and the gateway would return its
// `Page Not Found` HTML (issue #887 for the qwen/m2.7 entries; minimax-m3
// and minimax-m3-free added under #1617 for the same root cause).
const OPENCODE_GO_API_RESOLUTION = createOpenCodeApiResolution("https://opencode.ai/zen/go", {
	"minimax-m2.7": "openai-completions",
	"minimax-m3": "openai-completions",
	"minimax-m3-free": "openai-completions",
	"qwen3.5-plus": "openai-completions",
	"qwen3.6-plus": "openai-completions",
});

const COPILOT_BASE_URL = "https://api.githubcopilot.com";

const COPILOT_DEFAULT_RESOLUTION = {
	api: "openai-completions",
	baseUrl: COPILOT_BASE_URL,
} as const satisfies { api: Api; baseUrl: string };

const COPILOT_API_RESOLUTION_RULES: readonly ApiResolutionRule[] = [
	{
		matches: modelId => COPILOT_ANTHROPIC_MODEL_PATTERN.test(modelId),
		resolved: { api: "anthropic-messages", baseUrl: COPILOT_BASE_URL },
	},
	{
		matches: isCopilotResponsesModelId,
		resolved: { api: "openai-responses", baseUrl: COPILOT_BASE_URL },
	},
];

function simpleModelsDevDescriptor(
	modelsDevKey: string,
	providerId: string,
	api: Api,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return {
		modelsDevKey,
		providerId,
		api,
		baseUrl,
		...options,
	};
}

function openAiCompletionsDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "openai-completions", baseUrl, options);
}

function anthropicMessagesDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "anthropic-messages", baseUrl, options);
}

const GOOGLE_VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
const GOOGLE_VERTEX_OPENAI_BASE_URL =
	"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi";
const GOOGLE_VERTEX_ANTHROPIC_BASE_URL =
	"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:streamRawPredict";

function resolveGoogleVertexApi(modelId: string, raw: ModelsDevModel): { api: Api; baseUrl: string } {
	if (raw.provider?.npm === "@ai-sdk/google-vertex/anthropic") {
		return {
			api: "anthropic-messages",
			baseUrl: GOOGLE_VERTEX_ANTHROPIC_BASE_URL.replace("{model}", modelId),
		};
	}
	if (modelId.includes("/") || raw.provider?.npm === "@ai-sdk/openai-compatible") {
		return { api: "openai-completions", baseUrl: GOOGLE_VERTEX_OPENAI_BASE_URL };
	}
	return { api: "google-vertex", baseUrl: GOOGLE_VERTEX_BASE_URL };
}

const MODELS_DEV_PROVIDER_DESCRIPTORS_BEDROCK: readonly ModelsDevProviderDescriptor[] = [
	// --- Amazon Bedrock ---
	{
		modelsDevKey: "amazon-bedrock",
		providerId: "amazon-bedrock",
		api: "bedrock-converse-stream",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		filterModel: (id, m) => {
			if (m.tool_call !== true) return false;
			if (id.startsWith("ai21.jamba")) return false;
			if (id.startsWith("amazon.titan-text-express") || id.startsWith("mistral.mistral-7b-instruct-v0"))
				return false;
			return true;
		},
		transformModel: (model, modelId, m) => {
			const crossRegionId = bedrockCrossRegionId(modelId);
			const bedrockModel: ModelSpec<Api> = {
				...model,
				id: crossRegionId,
				name: toModelName(m.name, crossRegionId),
			};
			// Also emit EU variants for Claude models
			if (modelId.startsWith("anthropic.claude-")) {
				return [
					bedrockModel,
					{
						...bedrockModel,
						id: `eu.${modelId}`,
						name: `${toModelName(m.name, modelId)} (EU)`,
					},
				];
			}
			return bedrockModel;
		},
	},
];

const MODELS_DEV_PROVIDER_DESCRIPTORS_CORE: readonly ModelsDevProviderDescriptor[] = [
	// --- Anthropic ---
	anthropicMessagesDescriptor("anthropic", "anthropic", "https://api.anthropic.com", {
		filterModel: (id, m) => {
			if (m.tool_call !== true) return false;
			if (
				id.startsWith("claude-3-5-haiku") ||
				id.startsWith("claude-3-7-sonnet") ||
				id === "claude-3-opus-20240229" ||
				id === "claude-3-sonnet-20240229"
			)
				return false;
			return true;
		},
	}),
	// --- Google ---
	simpleModelsDevDescriptor(
		"google",
		"google",
		"google-generative-ai",
		"https://generativelanguage.googleapis.com/v1beta",
	),
	// --- OpenAI ---
	simpleModelsDevDescriptor("openai", "openai", "openai-responses", "https://api.openai.com/v1"),
	// --- Groq ---
	openAiCompletionsDescriptor("groq", "groq", "https://api.groq.com/openai/v1"),
	// --- Cerebras ---
	openAiCompletionsDescriptor("cerebras", "cerebras", "https://api.cerebras.ai/v1"),
	// --- Together ---
	openAiCompletionsDescriptor("togetherai", "together", "https://api.together.xyz/v1"),
	// --- CoreWeave Serverless Inference ---
	openAiCompletionsDescriptor("wandb", "coreweave", "https://api.inference.wandb.ai/v1", {
		transformModel: model => {
			if (!model.id.startsWith("openai/gpt-oss-")) {
				return model;
			}
			return {
				...model,
				reasoning: true,
				thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
			};
		},
	}),
	// --- NVIDIA ---
	openAiCompletionsDescriptor("nvidia", "nvidia", "https://integrate.api.nvidia.com/v1", {
		defaultContextWindow: 131072,
	}),
	// --- xAI ---
	openAiCompletionsDescriptor("xai", "xai", "https://api.x.ai/v1"),
	// --- DeepSeek ---
	openAiCompletionsDescriptor("deepseek", "deepseek", "https://api.deepseek.com", {
		// Only ship the v4 family as built-ins; older deepseek-chat / deepseek-reasoner
		// ids are kept off the catalog until the issue thread asks for them.
		filterModel: (id, m) => m.tool_call === true && id.startsWith("deepseek-v4"),
		compat: {
			// DeepSeek V4 effort remapping is derived in model-thinking metadata; this
			// descriptor keeps only transport-shape compat.
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			// DeepSeek V4 thinking mode rejects the `tool_choice` control parameter.
			// Tool calls still work without it; the API defaults to auto when tools exist.
			supportsToolChoice: false,
			// DeepSeek V4's OpenAI format docs enable thinking with both the toggle and
			// reasoning_effort. Keep the toggle explicit for built-in models.
			extraBody: { thinking: { type: "enabled" } },
			// DeepSeek emits chain-of-thought via `reasoning_content` and requires it
			// to round-trip on assistant tool-call messages so the model can resume
			// from prior thinking (interleaved.field=reasoning_content on models.dev,
			// matches the kimi/openrouter handling already in detectCompat).
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
			requiresAssistantContentForToolCalls: true,
		},
	}),
];

const MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS: readonly ModelsDevProviderDescriptor[] = [
	// --- zAI ---
	anthropicMessagesDescriptor("zai-coding-plan", "zai", "https://api.z.ai/api/anthropic"),
	// --- Umans AI Coding Plan ---
	anthropicMessagesDescriptor("umans-ai-coding-plan", "umans", UMANS_BASE_URL),
	// --- Xiaomi ---
	openAiCompletionsDescriptor("xiaomi", "xiaomi", "https://api.xiaomimimo.com/v1", {
		defaultContextWindow: 262144,
		defaultMaxTokens: 8192,
		compat: {
			supportsStore: false,
			thinkingFormat: "zai",
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
			allowsSyntheticReasoningContentForToolCalls: false,
		},
	}),
	// --- MiniMax Coding Plan ---
	openAiCompletionsDescriptor("minimax-coding-plan", "minimax-code", "https://api.minimax.io/v1", {
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		},
	}),
	openAiCompletionsDescriptor("minimax-cn-coding-plan", "minimax-code-cn", "https://api.minimaxi.com/v1", {
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		},
	}),
	// --- Alibaba Coding Plan ---
	openAiCompletionsDescriptor(
		"alibaba-coding-plan",
		"alibaba-coding-plan",
		"https://coding-intl.dashscope.aliyuncs.com/v1",
		{
			compat: {
				supportsDeveloperRole: false,
			},
		},
	),
	// --- Zhipu Coding Plan ---
	openAiCompletionsDescriptor(
		"zhipuai-coding-plan",
		"zhipu-coding-plan",
		"https://open.bigmodel.cn/api/coding/paas/v4",
		{
			compat: {
				thinkingFormat: "zai",
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			},
		},
	),
];

const filterActiveToolCallModels = (_id: string, m: ModelsDevModel): boolean => {
	if (m.tool_call !== true) return false;
	if (m.status === "deprecated") return false;
	return true;
};

const MODELS_DEV_PROVIDER_DESCRIPTORS_GOOGLE_VERTEX: readonly ModelsDevProviderDescriptor[] = [
	simpleModelsDevDescriptor("google-vertex", "google-vertex", "google-vertex", GOOGLE_VERTEX_BASE_URL, {
		filterModel: filterActiveToolCallModels,
		resolveApi: resolveGoogleVertexApi,
	}),
];

const MODELS_DEV_PROVIDER_DESCRIPTORS_SPECIALIZED: readonly ModelsDevProviderDescriptor[] = [
	// --- Azure OpenAI ---
	// OpenAI-family models hosted on Azure, served via the Responses API. baseUrl
	// is empty: the deployment host is per-resource and resolved at runtime from
	// AZURE_OPENAI_BASE_URL / AZURE_OPENAI_RESOURCE_NAME (see resolveAzureConfig).
	simpleModelsDevDescriptor("azure", "azure", "azure-openai-responses", "", {
		filterModel: (modelId, m) => {
			if (m.tool_call !== true) return false;
			// OpenAI-family only (not Foundry/DeepSeek/Claude/Llama/Mistral/Phi, which
			// Azure serves via non-Responses APIs under a per-model provider override).
			return /^(gpt-|o1|o3|o4|codex|chatgpt)/.test(modelId);
		},
	}),
	// --- Cloudflare AI Gateway ---
	anthropicMessagesDescriptor(
		"cloudflare-ai-gateway",
		"cloudflare-ai-gateway",
		"https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic",
	),
	// --- Mistral ---
	openAiCompletionsDescriptor("mistral", "mistral", "https://api.mistral.ai/v1"),
	// --- OpenCode Zen ---
	openAiCompletionsDescriptor("opencode", "opencode-zen", "https://opencode.ai/zen/v1", {
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(
				modelId,
				raw,
				OPENCODE_ZEN_API_RESOLUTION.rules,
				OPENCODE_ZEN_API_RESOLUTION.defaultResolution,
			),
	}),
	// --- OpenCode Go ---
	openAiCompletionsDescriptor("opencode-go", "opencode-go", "https://opencode.ai/zen/go/v1", {
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(
				modelId,
				raw,
				OPENCODE_GO_API_RESOLUTION.rules,
				OPENCODE_GO_API_RESOLUTION.defaultResolution,
			),
	}),
	// --- GitHub Copilot ---
	openAiCompletionsDescriptor("github-copilot", "github-copilot", COPILOT_BASE_URL, {
		defaultContextWindow: 128000,
		defaultMaxTokens: 8192,
		headers: { ...COPILOT_API_HEADERS },
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(modelId, raw, COPILOT_API_RESOLUTION_RULES, COPILOT_DEFAULT_RESOLUTION),
		transformModel: model => {
			// compat only applies to openai-completions models
			if (model.api === "openai-completions") {
				return {
					...model,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
				};
			}
			return model;
		},
	}),
	// --- MiniMax (Anthropic) ---
	anthropicMessagesDescriptor("minimax", "minimax", "https://api.minimax.io/anthropic"),
	anthropicMessagesDescriptor("minimax-cn", "minimax-cn", "https://api.minimaxi.com/anthropic"),
	// --- Hugging Face ---
	openAiCompletionsDescriptor("huggingface", "huggingface", "https://router.huggingface.co/v1"),
	// --- Kilo Gateway ---
	openAiCompletionsDescriptor("kilo", "kilo", "https://api.kilo.ai/api/gateway"),
	// --- Moonshot AI ---
	openAiCompletionsDescriptor("moonshotai", "moonshot", "https://api.moonshot.ai/v1"),
	// --- NanoGPT ---
	openAiCompletionsDescriptor("nano-gpt", "nanogpt", "https://nano-gpt.com/api/v1"),
	// --- Synthetic ---
	openAiCompletionsDescriptor("synthetic", "synthetic", "https://api.synthetic.new/openai/v1"),
	// --- Venice AI ---
	openAiCompletionsDescriptor("venice", "venice", "https://api.venice.ai/api/v1", {
		transformModel: model => {
			const maxTokens = clampKimiK27CodeMaxTokens(model.id, model.maxTokens);
			return maxTokens === model.maxTokens ? model : { ...model, maxTokens };
		},
	}),
	// --- Ollama Cloud ---
	simpleModelsDevDescriptor("ollama-cloud", "ollama-cloud", "ollama-chat", "https://ollama.com"),
	// --- Xiaomi Token Plan ---
	openAiCompletionsDescriptor(
		"xiaomi-token-plan-ams",
		"xiaomi-token-plan-ams",
		"https://token-plan-ams.xiaomimimo.com/v1",
	),
	openAiCompletionsDescriptor(
		"xiaomi-token-plan-cn",
		"xiaomi-token-plan-cn",
		"https://token-plan-cn.xiaomimimo.com/v1",
	),
	openAiCompletionsDescriptor(
		"xiaomi-token-plan-sgp",
		"xiaomi-token-plan-sgp",
		"https://token-plan-sgp.xiaomimimo.com/v1",
	),
	// --- Qwen Portal ---
	openAiCompletionsDescriptor("qwen-portal", "qwen-portal", "https://portal.qwen.ai/v1", {
		defaultContextWindow: 128000,
		defaultMaxTokens: 8192,
	}),

	// --- ZenMux ---
	openAiCompletionsDescriptor("zenmux", "zenmux", ZENMUX_OPENAI_BASE_URL, {
		filterModel: filterActiveToolCallModels,
		resolveApi: modelId => {
			if (modelId.startsWith("anthropic/")) {
				return { api: "anthropic-messages" as const, baseUrl: ZENMUX_ANTHROPIC_BASE_URL };
			}
			return { api: "openai-completions" as const, baseUrl: ZENMUX_OPENAI_BASE_URL };
		},
	}),
];
/** All provider descriptors for models.dev data mapping in generate-models.ts. */
export const MODELS_DEV_PROVIDER_DESCRIPTORS: readonly ModelsDevProviderDescriptor[] = [
	...MODELS_DEV_PROVIDER_DESCRIPTORS_BEDROCK,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_GOOGLE_VERTEX,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_CORE,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_SPECIALIZED,
];
