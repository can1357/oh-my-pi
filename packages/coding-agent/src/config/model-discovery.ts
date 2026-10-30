/**
 * HTTP discovery protocols for configured and implicit providers — ollama,
 * llama.cpp, lm-studio, openai-models-list, and new-api/one-api-style proxies.
 * `ModelRegistry` owns the orchestration (status, state, caching) and calls
 * `discoverModelsByProviderType` with a `DiscoveryContext`; built-in provider
 * discovery lives in pi-catalog's provider-models.
 */
import { type ApiKey, withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import { getAppleFoundationModelsAvailability } from "@oh-my-pi/pi-ai/providers/apple-foundation-models";
import type { Api, FetchImpl, Model, RemoteCompactionConfig } from "@oh-my-pi/pi-ai/types";
import { buildDiscoveredModel, buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import {
	getBundledModelReferenceIndex,
	inheritReferenceThinking,
	resolveModelReference,
	stripBracketedModelIdAffixes,
} from "@oh-my-pi/pi-catalog/identity";
import {
	fetchLiteLLMRichModels,
	fetchLmStudioNativeModelMetadata,
	isSelectableLiteLLMModelMode,
	OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW,
	OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS,
	resolveLiteLLMApi,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import {
	type KindApiKind,
	type ModelKind,
	type ModelSpec,
	type OpenAICompat,
	runnerApiKind,
} from "@oh-my-pi/pi-catalog/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { isRecord } from "@oh-my-pi/pi-utils";
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

/**
 * A discovery HTTP failure carrying the response status as a structured field
 * so callers can classify auth rejections (401/403) without parsing messages.
 * The message format is load-bearing: the model hub matches
 * `HTTP <status> from <url>` for its 404 baseUrl hint, and auth-retry
 * classification matches on the same text.
 */
export class DiscoveryHttpError extends Error {
	readonly status: number;

	constructor(status: number, url: string) {
		super(`HTTP ${status} from ${url}`);
		this.name = "DiscoveryHttpError";
		this.status = status;
	}
}

/**
 * True when a discovery failure is an HTTP 401/403 auth rejection — the
 * endpoint answered (so it is reachable) but refused the request's credentials
 * (or lack of them). Callers surface these as an `unauthenticated` provider
 * discovery state instead of a generic `unavailable`, so a credential problem
 * never masquerades as a dead endpoint (issue #12281).
 */
export function isDiscoveryAuthRejection(error: unknown): boolean {
	return error instanceof DiscoveryHttpError && (error.status === 401 || error.status === 403);
}

/**
 * Run `fn` with a hard deadline while also signalling cooperative transports
 * to abort. The independent rejection keeps discovery bounded when a runtime
 * leaves its fetch promise pending after `AbortSignal.abort()` (observed with
 * Windows localhost probes).
 *
 * The backing timer is cleared as soon as `fn` settles, unlike
 * `AbortSignal.timeout()`, whose delayed reason previously crashed Bun's
 * concurrent GC during an unrelated allocation.
 */
async function withTimeoutSignal<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		const error = new DOMException("The operation timed out.", "TimeoutError");
		controller.abort(error);
		timeout.reject(error);
	}, timeoutMs);
	try {
		return await Promise.race([fn(controller.signal), timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

/** Generous discovery budget for a non-loopback (remote / LAN) inference host. */
const REMOTE_DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Pick a discovery-probe timeout for a local-engine base URL.
 *
 * The implicit `127.0.0.1` default probe keeps a tight `loopbackMs` cap so a
 * busy or foreign service on the default port never stalls startup. But that
 * cap is far too short for a host reached over the network: a user who points
 * `LLAMA_CPP_BASE_URL` / `OLLAMA_BASE_URL` / `OLLAMA_HOST` at a remote or LAN
 * machine has real round-trip latency, and a 250ms cap made that server look
 * empty (issue #7087). Anything that is not strictly loopback therefore gets
 * {@link REMOTE_DISCOVERY_TIMEOUT_MS}.
 */
export function discoveryProbeTimeoutMs(baseUrl: string, loopbackMs: number, customTimeoutMs?: number): number {
	if (typeof customTimeoutMs === "number" && customTimeoutMs > 0 && Number.isFinite(customTimeoutMs)) {
		return customTimeoutMs;
	}
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname;
	} catch {
		return loopbackMs;
	}
	hostname = hostname.replace(/^\[/, "").replace(/\]$/, "");
	const isLoopback =
		hostname === "localhost" || hostname === "0.0.0.0" || hostname === "::1" || hostname.startsWith("127.");
	return isLoopback ? loopbackMs : REMOTE_DISCOVERY_TIMEOUT_MS;
}

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
	/**
	 * Extra roots probed in order when `baseUrl` yields no reachable server.
	 * Only the implicit llama.cpp provider sets this, so both its legacy (8080)
	 * and current (9931) default ports are discovered.
	 */
	fallbackBaseUrls?: string[];
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
	 * The bearer authenticates only the discovery request: discovered models
	 * carry just the provider's configured headers, since the model cache
	 * never persists header values and drops rows that had them.
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
	maxTokens?: "contextWindow";
};

type DiscoveredModelRuntimeMetadata = {
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
};

type LlamaCppModelListEntry = {
	id: string;
	input?: ("text" | "image")[];
	runtimeContextWindow?: number;
	/**
	 * `--ctx-size` extracted from the entry's `status.args` (rendered CLI arg
	 * vector) or `status.preset` INI. Populated for llama-server router-mode
	 * presets so unloaded models surface the user's configured window instead
	 * of falling through to the 128K default — the router-level `/props`
	 * reports a dummy `n_ctx: 0` and `meta.n_ctx` is only merged in after a
	 * child instance loads (issue #4190).
	 */
	configuredContextWindow?: number;
	trainingContextWindow?: number;
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

/** Positive safe-integer token count from a discovery payload field, else undefined. */
function toTokenLimitOrUndefined(value: unknown): number | undefined {
	const parsed = toPositiveNumberOrUndefined(value);
	return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isLlamaCppUnlimitedSentinel(value: unknown): boolean {
	if (typeof value === "number") {
		return value === -1;
	}
	if (typeof value === "string" && value.trim()) {
		return Number(value) === -1;
	}
	return false;
}

/**
 * llama.cpp `/props.default_generation_settings.params.{max_tokens,n_predict}`
 * are per-request defaults the server applies when a client omits the field —
 * clients can still raise them per call. Positive values therefore are NOT
 * hard model caps; only the `-1` unlimited sentinel reliably tells us the
 * server bounds generation by the runtime context window. Anything else
 * leaves the discovery default in place.
 */
function extractLlamaCppMaxTokens(payload: Record<string, unknown>): "contextWindow" | undefined {
	const generationSettings = payload.default_generation_settings;
	const params = isRecord(generationSettings) ? generationSettings.params : undefined;
	const candidates = [
		isRecord(params) ? params.max_tokens : undefined,
		isRecord(params) ? params.n_predict : undefined,
		isRecord(generationSettings) ? generationSettings.max_tokens : undefined,
		isRecord(generationSettings) ? generationSettings.n_predict : undefined,
		payload.max_tokens,
		payload.n_predict,
	];
	return candidates.some(isLlamaCppUnlimitedSentinel) ? "contextWindow" : undefined;
}

function resolveLlamaCppMaxTokens(contextWindow: number, maxTokens: "contextWindow" | undefined): number {
	return maxTokens === "contextWindow"
		? contextWindow
		: Math.min(contextWindow, maxTokens ?? DISCOVERY_DEFAULT_MAX_TOKENS);
}

function extractOllamaRuntimeContextWindow(payload: Record<string, unknown>): number | undefined {
	const parameters = payload.parameters;
	if (typeof parameters !== "string") {
		return undefined;
	}
	const match = parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:$|\n)/m);
	return match ? toPositiveNumberOrUndefined(match[1]) : undefined;
}

function extractOllamaContextWindow(payload: Record<string, unknown>): number | undefined {
	const runtimeContextWindow = extractOllamaRuntimeContextWindow(payload);
	if (runtimeContextWindow !== undefined) {
		return runtimeContextWindow;
	}

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

	return undefined;
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

function extractLlamaCppModelContextWindows(
	item: Record<string, unknown>,
): Pick<LlamaCppModelListEntry, "runtimeContextWindow" | "trainingContextWindow"> {
	const meta = item.meta;
	if (!isRecord(meta)) {
		return {};
	}
	return {
		runtimeContextWindow: toPositiveNumberOrUndefined(meta.n_ctx),
		trainingContextWindow: toPositiveNumberOrUndefined(meta.n_ctx_train),
	};
}

function extractLlamaCppModelInputCapabilities(item: Record<string, unknown>): ("text" | "image")[] | undefined {
	const architecture = item.architecture;
	if (!isRecord(architecture) || !Array.isArray(architecture.input_modalities)) {
		return undefined;
	}
	const modalities = new Set<string>();
	for (const modality of architecture.input_modalities) {
		if (typeof modality === "string") {
			modalities.add(modality.toLowerCase());
		}
	}
	return modalities.has("image") ? ["text", "image"] : ["text"];
}

function parseLlamaCppModelList(payload: unknown): LlamaCppModelListEntry[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		return [];
	}
	return payload.data.flatMap(item => {
		if (!isRecord(item) || typeof item.id !== "string" || !item.id) {
			return [];
		}
		return [
			{
				id: item.id,
				input: extractLlamaCppModelInputCapabilities(item),
				...extractLlamaCppModelContextWindows(item),
				configuredContextWindow: extractLlamaCppConfiguredContextWindow(item),
			},
		];
	});
}

// llama-server's `to_args()` renders the long form `--ctx-size` (never `-c`),
// but tolerate the short form and the embedded `--flag=value` shape so a
// hand-rolled forwarder cannot silently downgrade the discovered window.
const LLAMA_CPP_CTX_SIZE_FLAGS = new Set(["--ctx-size", "-c"]);

function extractLlamaCppCtxSizeFromArgs(value: unknown): number | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	for (let i = 0; i < value.length; i++) {
		const raw = value[i];
		if (typeof raw !== "string") continue;
		const eq = raw.indexOf("=");
		const flag = eq >= 0 ? raw.slice(0, eq) : raw;
		if (!LLAMA_CPP_CTX_SIZE_FLAGS.has(flag)) continue;
		const rawValue = eq >= 0 ? raw.slice(eq + 1) : value[i + 1];
		const parsed = toPositiveNumberOrUndefined(rawValue);
		if (parsed !== undefined) return parsed;
	}
	return undefined;
}

// `common_preset::to_ini()` emits one option per line as `<long-arg-without-dashes> = <value>`,
// so `ctx-size = 8192` is the exact wire form (issue #4190).
function extractLlamaCppCtxSizeFromIni(value: unknown): number | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const match = value.match(/(?:^|\n)\s*ctx-size\s*=\s*(-?\d+)\s*(?:$|\n)/);
	return match ? toPositiveNumberOrUndefined(match[1]) : undefined;
}

function extractLlamaCppConfiguredContextWindow(item: Record<string, unknown>): number | undefined {
	const status = item.status;
	if (!isRecord(status)) {
		return undefined;
	}
	const fromArgs = extractLlamaCppCtxSizeFromArgs(status.args);
	if (fromArgs !== undefined) {
		return fromArgs;
	}
	return extractLlamaCppCtxSizeFromIni(status.preset);
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
		case "apple-foundation-models":
			return discoverAppleFoundationModels(providerConfig);
	}
}

/**
 * Offers Apple's on-device model when the in-process bridge reports it usable;
 * an ineligible device, disabled Apple Intelligence, or an omp build without
 * the bridge yields no models.
 */
async function discoverAppleFoundationModels(providerConfig: DiscoveryProviderConfig): Promise<Model<Api>[]> {
	const availability = await getAppleFoundationModelsAvailability();
	if (!availability.available) return [];
	const contextWindow = availability.contextSize ?? DISCOVERY_DEFAULT_CONTEXT_WINDOW;
	return [
		buildModel({
			id: "on-device",
			name: availability.variant ? `Apple ${availability.variant}` : "Apple Foundation Model",
			api: providerConfig.api,
			provider: providerConfig.provider,
			baseUrl: providerConfig.baseUrl ?? "local://apple-foundation-models",
			reasoning: availability.reasoningCapable ?? false,
			input: availability.vision ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens: Math.min(contextWindow, DISCOVERY_DEFAULT_MAX_TOKENS),
			supportsTools: availability.toolCalling ?? true,
		} as ModelSpec<Api>),
	];
}

async function discoverOllamaModelMetadata(
	ctx: DiscoveryContext,
	endpoint: string,
	modelId: string,
	headers: Record<string, string> | undefined,
	customTimeoutMs?: number,
): Promise<OllamaDiscoveredModelMetadata | null> {
	const showUrl = `${endpoint}/api/show`;
	try {
		const payload = await withTimeoutSignal(discoveryProbeTimeoutMs(endpoint, 150, customTimeoutMs), async signal => {
			const response = await ctx.fetch(showUrl, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ model: modelId }),
				signal,
			});
			if (!response.ok) {
				return null;
			}
			return (await response.json()) as unknown;
		});
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
	const headers = { ...providerConfig.headers };
	const customTimeoutMs = providerConfig.discovery.timeoutMs;
	const payload = await withTimeoutSignal(discoveryProbeTimeoutMs(endpoint, 250, customTimeoutMs), async signal => {
		const response = await ctx.fetch(tagsUrl, {
			headers,
			signal,
		});
		if (!response.ok) {
			throw new DiscoveryHttpError(response.status, tagsUrl);
		}
		return (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
	});
	const entries = (payload.models ?? []).flatMap(item => {
		const id = item.model || item.name;
		return id ? [{ id, name: item.name || id }] : [];
	});
	const metadataById = new Map(
		await Promise.all(
			entries.map(
				async entry =>
					[
						entry.id,
						await discoverOllamaModelMetadata(ctx, endpoint, entry.id, headers, customTimeoutMs),
					] as const,
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
	customTimeoutMs?: number,
): Promise<LlamaCppDiscoveredServerMetadata | null> {
	const propsUrl = `${toLlamaCppNativeBaseUrl(baseUrl)}/props`;
	try {
		const payload = await withTimeoutSignal(discoveryProbeTimeoutMs(baseUrl, 150, customTimeoutMs), async signal => {
			const response = await ctx.fetch(propsUrl, {
				headers,
				signal,
			});
			if (!response.ok) {
				return null;
			}
			return (await response.json()) as unknown;
		});
		if (!isRecord(payload)) {
			return null;
		}
		return {
			contextWindow: extractLlamaCppContextWindow(payload),
			maxTokens: extractLlamaCppMaxTokens(payload),
			input: extractLlamaCppInputCapabilities(payload),
		};
	} catch {
		return null;
	}
}

/** Default llama-server roots probed for the implicit provider: legacy first, then the current default. */
export const LLAMA_CPP_DEFAULT_BASE_URLS = ["http://127.0.0.1:8080", "http://127.0.0.1:9931"] as const;

export async function discoverLlamaCppModels(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const fallbacks = providerConfig.fallbackBaseUrls ?? [];
	try {
		return await discoverLlamaCppModelsAt(providerConfig, providerConfig.baseUrl, ctx);
	} catch (primaryError) {
		// Any HTTP status means a server answered; fall back only when nothing
		// does, so a failing preferred server (401, 500, …) is never masked.
		if (primaryError instanceof DiscoveryHttpError) throw primaryError;
		for (const fallbackBaseUrl of fallbacks) {
			try {
				return await discoverLlamaCppModelsAt(providerConfig, fallbackBaseUrl, ctx);
			} catch (fallbackError) {
				// A fallback server that answered owns the outcome: its auth
				// rejection must surface as unauthenticated, not as the primary outage.
				if (fallbackError instanceof DiscoveryHttpError) throw fallbackError;
			}
		}
		throw primaryError;
	}
}

async function discoverLlamaCppModelsAt(
	providerConfig: DiscoveryProviderConfig,
	configuredBaseUrl: string | undefined,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeLlamaCppBaseUrl(configuredBaseUrl);
	const modelsUrl = `${baseUrl}/models`;

	const baseHeaders: Record<string, string> = { ...providerConfig.headers };
	const customTimeoutMs = providerConfig.discovery.timeoutMs;
	const attempt = async (h: Record<string, string>) => {
		const [payload, metadata] = await Promise.all([
			withTimeoutSignal(discoveryProbeTimeoutMs(baseUrl, 250, customTimeoutMs), async signal => {
				const response = await ctx.fetch(modelsUrl, {
					headers: h,
					signal,
				});
				if (!response.ok) {
					throw new DiscoveryHttpError(response.status, modelsUrl);
				}
				return (await response.json()) as unknown;
			}),
			discoverLlamaCppServerMetadata(ctx, baseUrl, h, customTimeoutMs),
		]);
		return [payload, metadata] as const;
	};
	const apiKey = await ctx.getBearerApiKeyResolver(providerConfig.provider);
	const [payload, serverMetadata] = apiKey
		? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
		: await attempt(baseHeaders);
	const models = parseLlamaCppModelList(payload);
	const discovered: Model<Api>[] = [];
	for (const item of models) {
		const { id } = item;
		if (!id) continue;
		const contextWindow =
			item.runtimeContextWindow ??
			item.configuredContextWindow ??
			serverMetadata?.contextWindow ??
			item.trainingContextWindow ??
			DISCOVERY_DEFAULT_CONTEXT_WINDOW;
		discovered.push(
			buildDiscoveredModel(
				{
					id,
					name: id,
					api: providerConfig.api,
					provider: providerConfig.provider,
					baseUrl: ensureLlamaCppV1BaseUrl(baseUrl),
					reasoning: false,
					input: item.input ?? serverMetadata?.input ?? ["text"],
					imageInputDecoder: "stb",
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow,
					maxTokens: resolveLlamaCppMaxTokens(contextWindow, serverMetadata?.maxTokens),
					headers: baseHeaders,
				},
				providerConfig.discovery.type,
			),
		);
	}
	return discovered;
}

export async function discoverLlamaCppModelRuntimeMetadata(
	model: Pick<Model<Api>, "provider" | "id" | "baseUrl" | "headers">,
	ctx: DiscoveryContext,
	customTimeoutMs?: number,
): Promise<DiscoveredModelRuntimeMetadata | undefined> {
	const baseUrl = normalizeLlamaCppBaseUrl(model.baseUrl);
	// Probe the native `/models` endpoint (not the OpenAI-compatible `/v1/models`)
	// so the runtime `meta`, `status.args`, and `architecture.input_modalities`
	// fields survive; a Qwen model routed to chat-completions carries a `/v1`
	// base URL, which would otherwise send this to `/v1/models`.
	const nativeBaseUrl = toLlamaCppNativeBaseUrl(baseUrl);
	const modelsUrl = `${nativeBaseUrl}/models`;
	const baseHeaders: Record<string, string> = { ...model.headers };
	const attempt = async (headers: Record<string, string>) => {
		const [entries, serverMetadata] = await Promise.all([
			withTimeoutSignal(discoveryProbeTimeoutMs(nativeBaseUrl, 250, customTimeoutMs), async signal => {
				const response = await ctx.fetch(modelsUrl, {
					headers,
					signal,
				});
				if (!response.ok) {
					return undefined;
				}
				return parseLlamaCppModelList(await response.json());
			}),
			discoverLlamaCppServerMetadata(ctx, nativeBaseUrl, headers, customTimeoutMs),
		]);
		if (!entries) {
			return undefined;
		}
		const entry = entries.find(entry => entry.id === model.id);
		if (!entry) {
			return undefined;
		}
		const contextWindow =
			entry.runtimeContextWindow ??
			entry.configuredContextWindow ??
			serverMetadata?.contextWindow ??
			entry.trainingContextWindow;
		const input = entry.input ?? serverMetadata?.input;
		if (contextWindow === undefined) {
			return input === undefined ? undefined : { input };
		}
		return {
			contextWindow,
			maxTokens: resolveLlamaCppMaxTokens(contextWindow, serverMetadata?.maxTokens),
			...(input !== undefined ? { input } : {}),
		};
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

/**
 * Re-probe LM Studio's native `/api/v0/models` for a single selected model so
 * its context window tracks the runtime lifecycle rather than the snapshot
 * captured at discovery time.
 *
 * A model discovered while unloaded is registered with `max_context_length`
 * (the architectural ceiling). When LM Studio JIT-loads it on first inference,
 * the running instance may serve a smaller `loaded_context_length` (user load
 * settings or context auto-fit). `getLmStudioNativeContextWindow` — invoked
 * inside `fetchLmStudioNativeModelMetadata` — prefers `loaded_context_length`
 * once `state === "loaded"`, so refreshing after selection swaps the stale
 * ceiling for the window the backend actually accepts (issue #9001). A later
 * unload re-probes back to `max_context_length`. This mirrors the llama.cpp
 * lazy-load refresh from #3310/#3311.
 *
 * `maxTokens` is carried through so the caller can re-cap output at the new
 * (possibly smaller) window; LM Studio native metadata reports no output cap
 * of its own.
 */
export async function discoverLmStudioModelRuntimeMetadata(
	model: Pick<Model<Api>, "provider" | "id" | "baseUrl" | "headers" | "maxTokens">,
	ctx: DiscoveryContext,
	customTimeoutMs?: number,
): Promise<DiscoveredModelRuntimeMetadata | undefined> {
	const baseUrl = normalizeOpenAIModelsListBaseUrl(model.baseUrl);
	// Same loopback budget as the list probe and the llama.cpp sibling: a dead
	// desktop server must not stall model selection for the remote timeout.
	const timeoutMs = discoveryProbeTimeoutMs(baseUrl, 250, customTimeoutMs);
	const baseHeaders: Record<string, string> = { ...model.headers };
	const attempt = async (headers: Record<string, string>) => {
		const metadata = await withTimeoutSignal(timeoutMs, signal =>
			fetchLmStudioNativeModelMetadata(baseUrl, ctx.fetch, { headers, signal }),
		);
		const entry = metadata?.get(model.id);
		if (!entry) {
			return undefined;
		}
		const contextWindow = entry.contextWindow;
		if (contextWindow === undefined) {
			return entry.input === undefined ? undefined : { input: entry.input };
		}
		return {
			contextWindow,
			...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
			...(entry.input !== undefined ? { input: entry.input } : {}),
		};
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

/** Lowercased modality names collected from every shape an OpenAI-compatible row may use. */
function collectModalities(values: readonly unknown[]): Set<string> {
	const modalities = new Set<string>();
	for (const value of values) {
		if (!Array.isArray(value)) continue;
		for (const entry of value) {
			if (typeof entry === "string") modalities.add(entry.toLowerCase());
		}
	}
	return modalities;
}

/**
 * Read image-input support from an OpenAI-compatible `/v1/models` row. Handles
 * direct `input` arrays, Synthetic-style top-level `input_modalities`, and
 * OpenRouter-style `architecture.input_modalities`; returns undefined when none
 * is present so the bundled reference (or the `["text"]` default) can take over.
 */
function extractOpenAIModelsListInputCapabilities(item: {
	input?: unknown;
	input_modalities?: unknown;
	architecture?: unknown;
	metadata?: unknown;
}): ("text" | "image")[] | undefined {
	const architecture = isRecord(item.architecture) ? item.architecture : undefined;
	const metadata = isRecord(item.metadata) ? item.metadata : undefined;
	const modalities = collectModalities([
		item.input,
		item.input_modalities,
		architecture?.input_modalities,
		metadata?.input_modalities,
	]);
	if (modalities.size === 0) return undefined;
	return modalities.has("image") ? ["text", "image"] : ["text"];
}

/**
 * Map an explicit non-chat output modality onto the runner kind and API that
 * serves it. Only endpoint-unambiguous tasks are routed: a row whose sole
 * output is `embeddings` or an image answers through the `/embeddings` and
 * `/images/generations` surfaces of the same OpenAI-compatible root the
 * provider already serves its model list from.
 *
 * Anything else stays chat. Rows that also emit `text` are ordinary (multimodal)
 * chat models, and an `audio` or `video` output alone cannot distinguish a TTS
 * SKU from a music generator, or a chat response from a video-job API — those
 * need explicit task metadata this list shape does not carry.
 */
function extractOpenAIModelsListOutputTask(item: {
	output?: unknown;
	output_modalities?: unknown;
	architecture?: unknown;
}): { kind: KindApiKind; api: Api } | undefined {
	const architecture = isRecord(item.architecture) ? item.architecture : undefined;
	const modalities = collectModalities([item.output, item.output_modalities, architecture?.output_modalities]);
	if (modalities.size !== 1) return undefined;
	const [modality] = modalities;
	switch (modality) {
		case "embedding":
		case "embeddings":
			return { kind: "embedding", api: "openai-embeddings" };
		case "image":
			return { kind: "image", api: "openai-images" };
		default:
			return undefined;
	}
}
/**
 * Reasoning tiers omp can send as `reasoning_effort` on OpenAI-compatible
 * chat routes. `none` is the wire off-switch rather than an effort tier,
 * `minimal` is rejected upstream by the GPT-6 generation, and `ultra` has no
 * omp effort equivalent (it fans out to subagents), so all three are dropped
 * from server-advertised ladders.
 */
const ADVERTISED_REASONING_EFFORTS: readonly Effort[] = [
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

function advertisedReasoningEffort(value: unknown): Effort | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.toLowerCase();
	return (ADVERTISED_REASONING_EFFORTS as readonly string[]).includes(normalized) ? (normalized as Effort) : undefined;
}

function extractReasoningLevels(value: unknown): Effort[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const efforts: Effort[] = [];
	for (const entry of value) {
		const effort = isRecord(entry) ? advertisedReasoningEffort(entry.effort) : advertisedReasoningEffort(entry);
		if (effort !== undefined && !efforts.includes(effort)) efforts.push(effort);
	}
	if (efforts.length === 0) return undefined;
	// Report the canonical least-to-most order regardless of wire order.
	efforts.sort(
		(left, right) => ADVERTISED_REASONING_EFFORTS.indexOf(left) - ADVERTISED_REASONING_EFFORTS.indexOf(right),
	);
	return efforts;
}

/**
 * Discovery reads a `/v1/models` row's own reasoning ladder unless the provider
 * opts out with `discovery.advertisedReasoning: false`. An endpoint that
 * advertises tiers its route does not actually accept would otherwise get a
 * picker the wire rejects; opting out falls back to the bundled reference.
 */
function advertisedReasoningEnabled(providerConfig: DiscoveryProviderConfig): boolean {
	return providerConfig.discovery.advertisedReasoning !== false;
}

/** What a `/v1/models` row says about its own reasoning surface. */
type AdvertisedReasoning =
	/** The row states it does not reason. */
	| { kind: "none" }
	/** The row advertises an effort ladder, and whether it also accepts `none`. */
	| { kind: "ladder"; efforts: Effort[]; acceptsNone: boolean; defaultLevel?: Effort };

/**
 * Read server-advertised reasoning support from an OpenAI-compatible
 * `/v1/models` row. codex-lb nests the Codex registry fields under `metadata`
 * (`supported_reasoning_levels: [{ effort }]`, `default_reasoning_level`);
 * other gateways may advertise the same fields top-level. Returns undefined
 * when the row says nothing usable about reasoning.
 *
 * An explicit non-reasoning declaration is reported as `{ kind: "none" }`
 * rather than `undefined`: the caller must be able to tell "this endpoint says
 * the model does not reason" (which outranks a reasoning-enabled bundled
 * reference) from "the endpoint is silent" (which leaves the reference in
 * charge). A stray ladder beside `reasoning: false` is ignored.
 */
function extractAdvertisedReasoning(item: {
	metadata?: unknown;
	supported_reasoning_levels?: unknown;
	default_reasoning_level?: unknown;
	reasoning?: unknown;
}): AdvertisedReasoning | undefined {
	const metadata = isRecord(item.metadata) ? item.metadata : undefined;
	// codex-lb nests every reasoning field under `metadata`; read the denial from
	// the same place the ladder below comes from, or a nested `reasoning: false`
	// would keep the reference dial alive.
	if ((metadata?.reasoning ?? item.reasoning) === false) return { kind: "none" };
	const raw = metadata?.supported_reasoning_levels ?? item.supported_reasoning_levels;
	const efforts = extractReasoningLevels(raw);
	if (efforts === undefined) return undefined;
	const rawDefault = metadata?.default_reasoning_level ?? item.default_reasoning_level;
	const defaultLevel = advertisedReasoningEffort(rawDefault);
	return {
		kind: "ladder",
		efforts,
		// `none` is the wire off-switch rather than a tier, so it never enters
		// `efforts`; remembering that the endpoint listed it is what lets a
		// thinking-off request send `reasoning_effort: "none"` instead of being
		// clamped to the lowest tier.
		acceptsNone: advisoryEffortEntries(raw).includes("none"),
		...(defaultLevel !== undefined && efforts.includes(defaultLevel) ? { defaultLevel } : {}),
	};
}

/** Raw effort strings a row lists, before the `Effort` vocabulary filters them. */
function advisoryEffortEntries(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(entry => {
		const raw = isRecord(entry) ? entry.effort : entry;
		return typeof raw === "string" ? [raw.toLowerCase()] : [];
	});
}

/**
 * Apply what the endpoint advertises for one of its own rows. The endpoint
 * states what it accepts on the wire, so its declaration outranks the reference
 * guess: a cross-provider reference carries no thinking at all, and a custom
 * provider's generic ladder drops provider-scoped tiers.
 *
 * OpenAI-shaped rows take the ladder in `effort` mode and drop a borrowed
 * `reasoningEffortMap` / `omitReasoningEffort`, since those describe another
 * host's wire (a reference that omits `reasoning_effort` would otherwise
 * suppress the advertised tier). An advertised `none` sets `none-effort` so a
 * thinking-off request sends the off-switch the endpoint listed rather than
 * the lowest tier.
 *
 * Anthropic-shaped rows keep their identity-derived mode — adaptive vs budget
 * is an Anthropic wire choice — and replace only the tiers.
 */
function withAdvertisedEfforts(
	spec: ModelSpec<Api>,
	advertised: AdvertisedReasoning | undefined,
	isAnthropic: boolean,
): ModelSpec<Api> {
	if (advertised === undefined) return spec;
	if (advertised.kind === "none") return withoutReasoning(spec, isAnthropic);
	// `defaultLevel` is not decoration: `pickInitialThinkingLevel` (sdk.ts) and
	// the model switcher read it ahead of the user's `defaultThinkingLevel`
	// setting, so pinning it to the ladder's first tier would start every gateway
	// model at its lowest effort and reset it on each model switch. Keep a
	// default the ladder actually contains — the row's own, else whatever the
	// catalog rule resolved — and only fall back when it falls outside the ladder.
	// `resolveModelPolicy` already folds the catalog rule's default in, so an
	// absent `advertised.defaultLevel` can still honor a rule default — but only
	// when the ladder contains it. The value is always set, because an absent one
	// would let `fillExplicitThinking` backfill the very level the ladder excludes.
	const inheritedDefault = resolveModelPolicy(spec).thinking?.defaultLevel;
	const preferredDefault = advertised.defaultLevel ?? inheritedDefault;
	const defaultLevel =
		preferredDefault !== undefined && advertised.efforts.includes(preferredDefault)
			? preferredDefault
			: advertised.efforts[0];
	const thinking = { mode: "effort" as const, efforts: advertised.efforts, defaultLevel };
	if (isAnthropic) {
		const mode = resolveModelPolicy({ ...spec, reasoning: true }).thinking?.mode ?? "budget";
		return { ...spec, reasoning: true, thinking: { ...thinking, mode } };
	}
	return {
		...spec,
		reasoning: true,
		thinking,
		compat: {
			...stripBorrowedEffortCompat(spec),
			supportsReasoningEffort: true,
			...(advertised.acceptsNone ? { reasoningDisableMode: "none-effort" as const } : {}),
		},
	} as ModelSpec<Api>;
}

/**
 * Drop transport facts a bundled reference lent this row, because they describe
 * another host's wire: its `reasoningEffortMap` would rewrite tiers this
 * endpoint declared, and its `omitReasoningEffort` would suppress the very
 * field an advertised ladder enables.
 */
function stripBorrowedEffortCompat(spec: ModelSpec<Api>): OpenAICompat {
	const { reasoningEffortMap: _map, omitReasoningEffort: _omit, ...compat } = (spec.compat ?? {}) as OpenAICompat;
	return compat;
}

/**
 * Drop the reasoning surface for a row whose endpoint declares it does not
 * reason, overriding a reasoning-enabled bundled reference. The row's identity
 * still comes from the reference, but the dial it implied must not survive:
 * a model the deployment cannot reason with must not receive
 * `reasoning_effort`.
 */
function withoutReasoning(spec: ModelSpec<Api>, isAnthropic: boolean): ModelSpec<Api> {
	if (isAnthropic) return { ...spec, reasoning: false, thinking: undefined };
	return {
		...spec,
		reasoning: false,
		thinking: undefined,
		compat: { ...stripBorrowedEffortCompat(spec), supportsReasoningEffort: false },
	} as ModelSpec<Api>;
}

export async function discoverOpenAIModelsList(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const injectV1 = providerConfig.discovery.injectV1 ?? true;
	// `injectV1: false` resolves `/models` against the configured base URL
	// verbatim — no `/v1` suffix is injected. Gateways that root their
	// OpenAI-compatible surface at a versioned path (e.g.
	// `https://api.opper.ai/v3/compat`) serve a different, often much smaller,
	// model list under a forced `/v1/models`; discovery must match the chat
	// base URL exactly so the full catalog is surfaced.
	const baseUrl = injectV1
		? normalizeOpenAIModelsListBaseUrl(providerConfig.baseUrl)
		: normalizeBareDiscoveryBaseUrl(providerConfig.baseUrl);
	const modelsUrl = appendModelsPath(baseUrl);

	const baseHeaders: Record<string, string> = { ...providerConfig.headers };
	// LM Studio is a desktop server reached over loopback, so an unanswered
	// probe means "not installed / not running", never "slow link": give it the
	// same tight budget the other implicit local engines use instead of the
	// remote one, which made every startup with no LM Studio running wait out
	// the full connect timeout on platforms that do not refuse instantly
	// (issue #12945). Non-loopback hosts and an explicit `timeoutMs` keep the
	// generous budget via {@link discoveryProbeTimeoutMs}.
	const timeoutMs =
		providerConfig.discovery.type === "lm-studio"
			? discoveryProbeTimeoutMs(baseUrl, 250, providerConfig.discovery.timeoutMs)
			: (providerConfig.discovery.timeoutMs ?? REMOTE_DISCOVERY_TIMEOUT_MS);
	const attempt = async (h: Record<string, string>) => {
		const nativeMetadataPromise =
			providerConfig.discovery.type === "lm-studio"
				? withTimeoutSignal(timeoutMs, signal =>
						fetchLmStudioNativeModelMetadata(baseUrl, ctx.fetch, { headers: h, signal }),
					)
				: Promise.resolve(null);
		const [payload, nativeMetadata] = await Promise.all([
			withTimeoutSignal(timeoutMs, async signal => {
				const res = await ctx.fetch(modelsUrl, {
					headers: h,
					signal,
				});
				if (!res.ok) {
					throw new DiscoveryHttpError(res.status, modelsUrl);
				}
				return (await res.json()) as {
					data?: Array<{
						id?: string;
						max_model_len?: unknown;
						context_length?: unknown;
						max_output_tokens?: unknown;
						max_completion_tokens?: unknown;
						max_tokens?: unknown;
						limits?: unknown;
						top_provider?: unknown;
						input?: unknown;
						input_modalities?: unknown;
						output?: unknown;
						output_modalities?: unknown;
						architecture?: unknown;
						mode?: unknown;
						metadata?: unknown;
						supported_reasoning_levels?: unknown;
						default_reasoning_level?: unknown;
						reasoning?: unknown;
					}>;
				};
			}),
			nativeMetadataPromise,
		]);
		return [payload, nativeMetadata] as const;
	};
	const apiKey = await ctx.getBearerApiKeyResolver(providerConfig.provider);
	const [payload, nativeMetadata] = apiKey
		? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
		: await attempt(baseHeaders);
	const models = payload.data ?? [];
	const references = getBundledModelReferenceIndex();
	const specs: ModelSpec<Api>[] = [];
	for (const item of models) {
		const id = item.id;
		if (!id) continue;
		if (providerConfig.discovery.type === "litellm" && !isSelectableLiteLLMModelMode(item.mode)) continue;
		const nativeMetadataForModel = nativeMetadata?.get(id);
		// Thin OpenAI-compatible proxies frequently omit `context_length`/
		// `max_model_len` on `/v1/models`, leaving discovered models pinned at
		// the 128K default even when the underlying model is e.g. a proxied
		// Claude with a 1M window. Resolve the id against the bundled catalog
		// (same pattern as `discoverProxyModels` and `discoverLiteLLMModels`) so
		// intrinsic metadata — context/output limits, display name, modality,
		// reasoning support — flows through when the provider is silent. Local
		// runtime state and provider-reported values still win; proxy-specific
		// headers/baseUrl/cost stay local.
		const reference = resolveModelReference(id, references) as ModelSpec<Api> | undefined;
		const referenceCompat = reference?.compat as OpenAICompat | undefined;
		// codex-lb and similar registries nest the route's identity beside its
		// reasoning ladder: `display_name`, `context_window`, `input_modalities`.
		const metadata = isRecord(item.metadata) ? item.metadata : undefined;
		const advertisedName = typeof metadata?.display_name === "string" ? metadata.display_name.trim() : "";
		const input = nativeMetadataForModel?.input ??
			extractOpenAIModelsListInputCapabilities(item) ??
			reference?.input ?? ["text"];
		const limits = isRecord(item.limits) ? item.limits : undefined;
		const maxInputTokens = toTokenLimitOrUndefined(limits?.max_input_tokens);
		const maxOutputTokens = toTokenLimitOrUndefined(limits?.max_output_tokens);
		const reportedLimitsContextWindow =
			maxInputTokens !== undefined &&
			maxOutputTokens !== undefined &&
			Number.isSafeInteger(maxInputTokens + maxOutputTokens)
				? maxInputTokens + maxOutputTokens
				: undefined;
		// Gateways spell the output cap nested (`limits.max_output_tokens`),
		// flat (`max_output_tokens`, OpenRouter-style `max_completion_tokens`,
		// generic `max_tokens` (#13062)), or under OpenRouter's
		// `top_provider.max_completion_tokens` (ModelRelay and other
		// OpenRouter-shaped catalogs). Each spelling is validated on its own so a
		// malformed one never masks a usable sibling. A `/v1/models` row declares
		// what the endpoint accepts, so `max_tokens` here is a cap — unlike
		// llama.cpp, whose positive `max_tokens` is only a per-request default.
		const topProvider = isRecord(item.top_provider) ? item.top_provider : undefined;
		const reportedMaxTokens =
			maxOutputTokens ??
			toTokenLimitOrUndefined(item.max_output_tokens) ??
			toTokenLimitOrUndefined(item.max_completion_tokens) ??
			toTokenLimitOrUndefined(topProvider?.max_completion_tokens) ??
			toTokenLimitOrUndefined(item.max_tokens);
		const reportedContextWindow =
			toPositiveNumberOrUndefined(item.max_model_len) ??
			toPositiveNumberOrUndefined(item.context_length) ??
			toPositiveNumberOrUndefined(metadata?.context_window) ??
			reportedLimitsContextWindow ??
			nativeMetadataForModel?.contextWindow ??
			reference?.contextWindow ??
			null;
		// A row that advertises a dedicated task answers through that task's
		// runner, not the provider's chat API: leaving it on chat both hides it
		// from its own role and offers the picker a model the chat endpoint
		// cannot serve (issue #13021). LM Studio lists decision models beside chat
		// models on `/v1/models`; only its native listing says they answer on
		// `/v1/decisions`, OpenAI's Decisions API.
		const task: { kind: ModelKind; api: Api } | undefined = nativeMetadataForModel?.decision
			? { kind: "judge", api: "openai-decisions" }
			: extractOpenAIModelsListOutputTask(item);
		if (task) {
			specs.push({
				id,
				name: advertisedName || reference?.name || id,
				api: task.api,
				kind: task.kind,
				provider: providerConfig.provider,
				baseUrl,
				reasoning: false,
				input,
				supportsTools: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				// Embeddings and judges cap their input by context; image jobs
				// carry no token window. None produces output tokens.
				contextWindow: task.kind === "image" ? null : reportedContextWindow,
				maxTokens: null,
				headers: baseHeaders,
			} as ModelSpec<Api>);
			continue;
		}
		const api =
			providerConfig.discovery.type === "litellm"
				? resolveLiteLLMApi(item, id, providerConfig.api)
				: providerConfig.api;
		const contextWindow = reportedContextWindow ?? DISCOVERY_DEFAULT_CONTEXT_WINDOW;
		// A row that advertises its own reasoning ladder (codex-lb `metadata`
		// fields, or the top-level equivalents) is authoritative for its route:
		// ids absent from the bundled catalog would otherwise stay non-reasoning
		// and never send `reasoning_effort`.
		const advertisedReasoning = advertisedReasoningEnabled(providerConfig)
			? extractAdvertisedReasoning(item)
			: undefined;
		const spec = {
			id,
			name: advertisedName || reference?.name || id,
			api,
			kind: runnerApiKind(api),
			provider: providerConfig.provider,
			baseUrl,
			reasoning: reference?.reasoning === true,
			thinking: inheritReferenceThinking(undefined, reference, providerConfig.provider),
			input,
			...(providerConfig.discovery.type === "lm-studio" ? { imageInputDecoder: "stb" as const } : {}),
			// Proxy/gateway pricing is provider-specific and rarely matches
			// upstream bundled catalogs, so keep costs local-unknown even
			// when we successfully recover the upstream model identity.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			// Cap a provider-advertised output limit or the reference's output limit at
			// the discovered context window so a larger limit can never request more
			// tokens than the local runtime advertises.
			maxTokens: Math.min(
				reportedMaxTokens ?? reference?.maxTokens ?? discoveryDefaultMaxTokens(api),
				contextWindow,
			),
			headers: baseHeaders,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: referenceCompat?.supportsReasoningEffort ?? false,
				...(referenceCompat?.reasoningEffortMap ? { reasoningEffortMap: referenceCompat.reasoningEffortMap } : {}),
				...(referenceCompat?.omitReasoningEffort !== undefined
					? { omitReasoningEffort: referenceCompat.omitReasoningEffort }
					: {}),
			},
		} as ModelSpec<Api>;
		specs.push(withAdvertisedEfforts(spec, advertisedReasoning, api === "anthropic-messages"));
	}
	// `discovery.type: "litellm"` keeps LiteLLM provider policy under any alias.
	return providerConfig.discovery.type === "litellm"
		? specs.map(spec => buildDiscoveredModel(spec, "litellm"))
		: specs.map(spec => buildModel(spec));
}

export async function discoverLiteLLMModels(
	providerConfig: DiscoveryProviderConfig,
	ctx: DiscoveryContext,
): Promise<Model<Api>[]> {
	const baseUrl = normalizeLiteLLMDiscoveryBaseUrl(providerConfig.baseUrl);
	const references = getBundledModelReferenceIndex();
	const resolveReference = (id: string) => resolveModelReference(id, references) as ModelSpec<Api> | undefined;
	const baseHeaders: Record<string, string> = { ...providerConfig.headers };
	const timeoutMs = providerConfig.discovery.timeoutMs ?? 10_000;
	const attempt = async (h: Record<string, string>) => {
		let authError: DiscoveryHttpError | undefined;
		const authAwareFetch: FetchImpl = async (input, init) => {
			const response = await ctx.fetch(input, init);
			if (response.status === 401) {
				authError = new DiscoveryHttpError(response.status, String(input));
			}
			return response;
		};
		const models = await withTimeoutSignal(timeoutMs, signal =>
			fetchLiteLLMRichModels<Api>({
				api: providerConfig.api,
				provider: providerConfig.provider,
				baseUrl,
				headers: h,
				fetch: authAwareFetch,
				referenceResolver: resolveReference,
				resolveApi: (entry, id) => resolveLiteLLMApi(entry, id, providerConfig.api),
				signal,
			}),
		);
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
	} catch {
		// The rich-metadata probes failed (auth, timeout, or network). The cheap
		// `/v1/models` fallback runs under its own independent budget and usually
		// still resolves the catalog, so try it rather than aborting discovery and
		// letting the caller cache an empty result (#10964). If the fallback also
		// fails, its error propagates.
		richModels = null;
	}
	if (richModels === null) {
		return discoverOpenAIModelsList({ ...providerConfig, baseUrl }, ctx);
	}
	return richModels.map(spec => buildDiscoveredModel({ ...spec, headers: baseHeaders }, "litellm"));
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

	const baseHeaders: Record<string, string> = { ...providerConfig.headers };
	const timeoutMs = providerConfig.discovery.timeoutMs ?? 10_000;
	const attempt = async (h: Record<string, string>) =>
		withTimeoutSignal(timeoutMs, async signal => {
			const res = await ctx.fetch(modelsUrl, {
				headers: h,
				signal,
			});
			if (!res.ok) {
				throw new DiscoveryHttpError(res.status, modelsUrl);
			}
			return (await res.json()) as {
				data?: Array<{
					id?: string;
					name?: string;
					supported_endpoint_types?: string[];
					context_length?: number;
					metadata?: unknown;
					supported_reasoning_levels?: unknown;
					default_reasoning_level?: unknown;
					reasoning?: unknown;
				}>;
			};
		});
	const apiKey = await ctx.getBearerApiKeyResolver(providerConfig.provider);
	const payload = apiKey
		? await withAuth(apiKey, key => attempt({ ...baseHeaders, Authorization: `Bearer ${key}` }))
		: await attempt(baseHeaders);
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
		// A proxy that dispatches with its own catalog advertises the ladder it
		// accepts for each row. That ladder is authoritative over the reference
		// guess: cross-provider references carry no thinking at all, so rows whose
		// ids are absent from the bundled catalog would otherwise stay
		// non-reasoning and never send `reasoning_effort`.
		const advertised = advertisedReasoningEnabled(providerConfig) ? extractAdvertisedReasoning(item) : undefined;
		const discoveryName = typeof item.name === "string" ? item.name.trim() : "";
		const displayName =
			(discoveryName && discoveryName !== id ? discoveryName : undefined) ??
			reference?.name ??
			stripBracketedModelIdAffixes(id) ??
			id;
		const spec = {
			id,
			name: displayName,
			api,
			provider: providerConfig.provider,
			baseUrl,
			reasoning: reference?.reasoning ?? false,
			thinking: inheritReferenceThinking(undefined, reference, providerConfig.provider),
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
			headers: baseHeaders,
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
		} as ModelSpec<Api>;
		discovered.push(buildModel(withAdvertisedEfforts(spec, advertised, isAnthropic)));
	}
	return discovered;
}

export function normalizeLlamaCppBaseUrl(baseUrl?: string): string {
	const raw = baseUrl || LLAMA_CPP_DEFAULT_BASE_URLS[0];
	try {
		const parsed = new URL(raw);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		return `${parsed.protocol}//${parsed.host}${trimmedPath}`;
	} catch {
		return raw;
	}
}

// ensureLlamaCppV1BaseUrl appends the OpenAI-compatible `/v1` prefix a
// chat-completions request needs; native discovery keeps the bare root, which
// serves `/models` and `/props` but not `/chat/completions`.
export function ensureLlamaCppV1BaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
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

/**
 * Bare-shape discovery root: the configured base URL with trailing slashes
 * trimmed and any query/hash dropped. Unlike
 * {@link normalizeOpenAIModelsListBaseUrl} it never appends `/v1` — the
 * configured URL is the full OpenAI-compatible root (e.g.
 * `https://api.opper.ai/v3/compat`), and injecting `/v1` would point discovery
 * at a different endpoint than chat. Query strings are stripped exactly like
 * the default normalizer does: chat appends `/chat/completions` to the base
 * string, so a retained query would corrupt the inference URL.
 */
export function normalizeBareDiscoveryBaseUrl(baseUrl: string | undefined): string {
	const raw = baseUrl || "http://127.0.0.1:1234";
	try {
		const parsed = new URL(raw);
		parsed.search = "";
		parsed.hash = "";
		return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/g, "")}`;
	} catch {
		return raw.replace(/\/+$/g, "");
	}
}

/**
 * Build the `/models` discovery URL by appending to the parsed pathname so
 * query parameters survive (`https://host/root?token=x` must become
 * `https://host/root/models?token=x`, not `https://host/root?token=x/models`).
 */
function appendModelsPath(baseUrl: string): string {
	try {
		const url = new URL(baseUrl);
		url.pathname = `${url.pathname.replace(/\/+$/g, "")}/models`;
		return url.toString();
	} catch {
		return `${baseUrl}/models`;
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
