/**
 * openzoo — a local proxy that pays for inference per call over x402
 * (on-chain micropayments from a local burner wallet). `npx openzoo` listens
 * at `http://localhost:8402/v1` and speaks OpenAI Chat Completions; there is
 * no account and no API key. `GET /v1/models` is free and returns
 * OpenRouter-shaped rows carrying per-token `pricing` and the model's real
 * attention window, so the live endpoint is the whole catalog: nothing is
 * bundled, and a successful discovery is authoritative.
 */
import { classifyModel } from "../compat/taxonomy";
import { fetchOpenAICompatibleModels, type OpenAICompatibleModelRecord } from "../discovery/openai-compatible";
import { getBundledModelReferenceIndex } from "../identity/bundled";
import type { ModelReferenceIndex } from "../identity/reference";
import { resolveModelReference } from "../identity/reference";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, ModelSpec, TokenCost } from "../types";
import { isRecord, toPositiveNumber } from "../utils";
import { getDefaultModelDiscoveryBaseUrl, resolveModelCacheProviderId } from "./cache-provider-id";

export const OPENZOO_DEFAULT_BASE_URL = "http://localhost:8402/v1";

/**
 * The router model. The shim mints no auto row of its own, but the backend
 * catalog publishes it under all three alias spellings, they pass through
 * `/v1/models`, and the gateway routes them on the wire (contract pinned
 * upstream at staccDOTsol/openzoo@211f6cf; measured on 0.50.84). OMP exposes
 * the bare id so the selector reads `openzoo/auto`, not `openzoo/openzoo/auto`.
 */
export const OPENZOO_AUTO_MODEL_ID = "auto";
const OPENZOO_AUTO_ALIASES: ReadonlySet<string> = new Set(["openzoo/auto", "openzoo-auto", "auto"]);

export interface OpenzooModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

/**
 * Explicit config wins, then `OPENZOO_BASE_URL` (the proxy port is
 * user-configurable via `OPENZOO_PORT`, and a public tunnel URL is possible),
 * else the proxy default. Mirrors `LM_STUDIO_BASE_URL` / `LITELLM_BASE_URL`.
 */
export function resolveOpenzooBaseUrl(baseUrl?: string): string {
	// One normalization for every source. The resolved string is also the
	// cache-namespace key, so a trailing slash on OPENZOO_BASE_URL must not
	// spell a different endpoint than the same URL passed explicitly.
	const raw = baseUrl?.trim() || getDefaultModelDiscoveryBaseUrl("openzoo") || OPENZOO_DEFAULT_BASE_URL;
	return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function isOpenzooAutoAlias(id: string): boolean {
	return OPENZOO_AUTO_ALIASES.has(id.trim().toLowerCase());
}

/**
 * Besides the real catalog, the local proxy publishes twins so editors that
 * hard-code bland ids (`gpt-4o`, `claude-sonnet-4-0`, `gpt-5.6-auto`, …) still
 * resolve: they are tagged `owned_by: "openzoo-alias"` (with `served_by`
 * naming the real row) or `owned_by: "openzoo"` (router aliases). OMP users
 * pick real ids, so the twins are dropped to keep the picker free of
 * duplicates.
 */
function isOpenzooHarnessTwin(entry: OpenAICompatibleModelRecord): boolean {
	return entry.owned_by === "openzoo-alias" || entry.owned_by === "openzoo" || typeof entry.served_by === "string";
}

/** `pricing.prompt` / `pricing.completion` are USD per token; OMP costs are USD per million. */
function perTokenUsdToPerMillion(value: unknown): number {
	const usd = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
	return Number.isFinite(usd) && usd > 0 ? usd * 1_000_000 : 0;
}

function mapOpenzooCost(pricing: unknown): TokenCost {
	const record = isRecord(pricing) ? pricing : {};
	return {
		input: perTokenUsdToPerMillion(record.prompt),
		output: perTokenUsdToPerMillion(record.completion),
		cacheRead: perTokenUsdToPerMillion(record.input_cache_read),
		cacheWrite: perTokenUsdToPerMillion(record.input_cache_write),
	};
}

function toDisplayName(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function listIncludes(value: unknown, token: string): boolean {
	return Array.isArray(value) && value.includes(token);
}

/**
 * Reasoning the live row actually advertises. A matching bundled id from
 * another provider is not a signal — that host may expose a different
 * control surface than this OpenAI-completions proxy.
 */
function liveOpenzooReasoning(entry: OpenAICompatibleModelRecord): boolean {
	if (entry.supports_reasoning === true || entry.reasoning === true) {
		return true;
	}
	if (isRecord(entry.reasoning)) {
		return true;
	}
	return (
		listIncludes(entry.supported_parameters, "reasoning") ||
		listIncludes(entry.supported_parameters, "reasoning_effort")
	);
}

/**
 * Input modalities the live row actually advertises. `undefined` means the
 * roster omitted them — leave the discovery default and let KDL
 * `input-modalities` correct at `buildModel` time.
 */
function liveOpenzooInput(entry: OpenAICompatibleModelRecord): ("text" | "image")[] | undefined {
	if (entry.supports_vision === true || entry.supports_image === true || entry.supports_image_in === true) {
		return ["text", "image"];
	}
	if (isRecord(entry.architecture)) {
		if (Array.isArray(entry.architecture.input_modalities)) {
			return listIncludes(entry.architecture.input_modalities, "image") ? ["text", "image"] : ["text"];
		}
		const modality = entry.architecture.modality;
		if (typeof modality === "string" && modality.length > 0) {
			return modality.includes("image") ? ["text", "image"] : ["text"];
		}
	}
	if (Array.isArray(entry.input_modalities)) {
		return listIncludes(entry.input_modalities, "image") ? ["text", "image"] : ["text"];
	}
	return undefined;
}

/**
 * Map one proxy row. Limits come from the row where it carries the model's
 * real numbers, with the bundled upstream reference (matched by the
 * OpenRouter-style id) only filling a missing window or display name.
 * Reasoning and image-input stay on the discovery defaults unless the row
 * reports them — a matching id from another provider is not a capability
 * signal. Reviewed corrections are rule-owned (`providers/openzoo.kdl`)
 * and applied at `buildModel` time. Pricing is always the proxy's: it is
 * what the wallet pays.
 *
 * `context_length` is deliberately ignored: the proxy reports the ceiling its
 * bind/retrieval layer accepts (128M tokens), not the transformer's window,
 * which it publishes as `max_model_len`.
 */
export function mapOpenzooModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
	references: ModelReferenceIndex,
): ModelSpec<"openai-completions"> | null {
	if (isOpenzooAutoAlias(defaults.id)) {
		return {
			...defaults,
			id: OPENZOO_AUTO_MODEL_ID,
			name: "Auto",
			cost: mapOpenzooCost(entry.pricing),
			contextWindow: toPositiveNumber(entry.max_model_len, null),
			maxTokens: toPositiveNumber(entry.max_output_tokens, null),
		};
	}
	if (isOpenzooHarnessTwin(entry)) {
		return null;
	}
	const canonical = resolveModelReference(defaults.id, references);
	const contextWindow = toPositiveNumber(entry.max_model_len, canonical?.contextWindow ?? null);
	const topProvider = isRecord(entry.top_provider) ? entry.top_provider : undefined;
	const reportedMaxTokens = toPositiveNumber(
		entry.max_output_tokens,
		toPositiveNumber(topProvider?.max_completion_tokens, canonical?.maxTokens ?? null),
	);
	const maxTokens =
		reportedMaxTokens != null && contextWindow != null
			? Math.min(reportedMaxTokens, contextWindow)
			: reportedMaxTokens;
	const identity = classifyModel("openzoo", defaults.id, { lenient: true });
	return {
		...defaults,
		name: canonical?.name ?? toDisplayName(entry.display_name, defaults.name),
		reasoning: liveOpenzooReasoning(entry) || identity.thinkingVariant === true,
		input: liveOpenzooInput(entry) ?? defaults.input,
		cost: mapOpenzooCost(entry.pricing),
		contextWindow,
		maxTokens,
	};
}

/**
 * Per-fetch mapper. Discovery dedupes by mapped id (last row wins), and the
 * backend publishes the router under several alias spellings, so router rows
 * fold into one `auto` entry. The fold is FIELD-BY-FIELD: each cost component
 * and each limit keeps the first nonzero/non-null value seen, so an alias row
 * that supplies only the number an earlier row omitted still contributes it.
 */
export function createOpenzooModelMapper(
	references: ModelReferenceIndex,
): (
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
) => ModelSpec<"openai-completions"> | null {
	let auto: ModelSpec<"openai-completions"> | undefined;
	return (entry, defaults) => {
		const row = mapOpenzooModel(entry, defaults, references);
		if (row === null || !isOpenzooAutoAlias(defaults.id)) {
			return row;
		}
		auto = auto
			? {
					...auto,
					cost: {
						input: auto.cost.input > 0 ? auto.cost.input : row.cost.input,
						output: auto.cost.output > 0 ? auto.cost.output : row.cost.output,
						cacheRead: auto.cost.cacheRead > 0 ? auto.cost.cacheRead : row.cost.cacheRead,
						cacheWrite: auto.cost.cacheWrite > 0 ? auto.cost.cacheWrite : row.cost.cacheWrite,
					},
					contextWindow: auto.contextWindow ?? row.contextWindow,
					maxTokens: auto.maxTokens ?? row.maxTokens,
				}
			: row;
		return auto;
	};
}

export function openzooModelManagerOptions(
	config?: OpenzooModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = resolveOpenzooBaseUrl(config?.baseUrl);
	return {
		providerId: "openzoo",
		cacheProviderId: resolveModelCacheProviderId("openzoo", { baseUrl }),
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: () => {
			// Resolved here, not at options construction: walking the bundled
			// reference index is only worth paying for when discovery actually runs.
			const mapModel = createOpenzooModelMapper(getBundledModelReferenceIndex());
			return fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "openzoo",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => mapModel(entry, defaults),
				fetch: config?.fetch,
			});
		},
	};
}
