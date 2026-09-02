/**
 * openzoo — a local proxy that pays for inference per call over x402
 * (on-chain micropayments from a local burner wallet). `npx openzoo` listens
 * at `http://localhost:8402/v1` and speaks OpenAI Chat Completions; there is
 * no account and no API key. `GET /v1/models` is free and returns
 * OpenRouter-shaped rows carrying per-token `pricing` and the model's real
 * attention window, so the live endpoint is the whole catalog: nothing is
 * bundled, and a successful discovery is authoritative.
 */
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
 * The router model. The proxy publishes it as `openzoo/auto` (plus the
 * `openzoo-auto` / `auto` aliases) and accepts any of them on the wire; OMP
 * exposes the bare id so the selector reads `openzoo/auto` rather than
 * `openzoo/openzoo/auto`.
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
	const explicit = baseUrl?.trim();
	if (explicit) {
		return explicit.endsWith("/") ? explicit.slice(0, -1) : explicit;
	}
	return getDefaultModelDiscoveryBaseUrl("openzoo") ?? OPENZOO_DEFAULT_BASE_URL;
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

function hasPricing(cost: TokenCost): boolean {
	return cost.input > 0 || cost.output > 0;
}

function mapOpenzooAutoRow(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
): ModelSpec<"openai-completions"> {
	return {
		...defaults,
		id: OPENZOO_AUTO_MODEL_ID,
		name: "Auto",
		cost: mapOpenzooCost(entry.pricing),
		contextWindow: toPositiveNumber(entry.max_model_len, null),
		maxTokens: toPositiveNumber(entry.max_output_tokens, null),
	};
}

/**
 * Map one proxy row. Limits come from the row where it carries the model's
 * real numbers, and from the bundled upstream reference (matched by the
 * OpenRouter-style id) for reasoning and input modalities the row does not
 * describe. Pricing is always the proxy's: it is what the wallet pays.
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
		return mapOpenzooAutoRow(entry, defaults);
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
	return {
		...defaults,
		name: canonical?.name ?? toDisplayName(entry.display_name, defaults.name),
		reasoning: canonical?.reasoning ?? defaults.reasoning,
		input: canonical?.input ?? defaults.input,
		cost: mapOpenzooCost(entry.pricing),
		contextWindow,
		maxTokens,
	};
}

/**
 * Per-fetch mapper. Discovery dedupes by mapped id (last row wins), and the
 * proxy publishes the router under several ids, so the router rows are
 * folded into one `auto` entry that keeps the first numbers seen where a
 * later alias row omits them.
 */
export function createOpenzooModelMapper(
	references: ModelReferenceIndex,
): (
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
) => ModelSpec<"openai-completions"> | null {
	let auto: ModelSpec<"openai-completions"> | undefined;
	return (entry, defaults) => {
		if (!isOpenzooAutoAlias(defaults.id)) {
			return mapOpenzooModel(entry, defaults, references);
		}
		const row = mapOpenzooAutoRow(entry, defaults);
		auto = auto
			? {
					...auto,
					cost: hasPricing(auto.cost) ? auto.cost : row.cost,
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
