/**
 * openzoo — a local proxy that pays for inference per call over x402
 * (on-chain micropayments from a local burner wallet). `npx openzoo` listens
 * at `http://localhost:8402/v1` and speaks OpenAI Chat Completions; there is
 * no account and no API key. `GET /v1/models` is free and returns
 * OpenRouter-shaped rows carrying per-token `pricing` and the model's real
 * attention window, so the live endpoint is the whole catalog: nothing is
 * bundled, and a successful discovery is authoritative.
 */
import { type EffortVariantFamily, reviewedCollapseTable } from "../compat/collapse";
import { hasLocalLoopbackBaseUrl } from "../compat/resolve";
import { classifyModel } from "../compat/taxonomy";
import { DiscoveryAuthRejectionError } from "../discovery/auth-rejection";
import { fetchOpenAICompatibleModels, type OpenAICompatibleModelRecord } from "../discovery/openai-compatible";
import { getBundledModelReferenceIndex } from "../identity/bundled";
import type { ModelReferenceIndex } from "../identity/reference";
import { resolveModelReference } from "../identity/reference";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, ModelSpec, OpenAICompat, TokenCost } from "../types";
import { discoveryFetch, isRecord, toPositiveNumber } from "../utils";
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
	// Strip the whole suffix. One slash at a time is not idempotent: the
	// manager normalizes, then the cache id normalizes again, and a second
	// slash left over hashes a different namespace than the restored row.
	return raw.replace(/\/+$/, "");
}

function openzooVariantFamily(id: string): EffortVariantFamily | undefined {
	const normalized = id.trim().toLowerCase();
	return reviewedCollapseTable("openzoo")?.families.find(
		family => family.id === normalized || family.members.includes(normalized),
	);
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

function listIncludesEvery(value: unknown, tokens: readonly string[]): boolean {
	return tokens.every(token => listIncludes(value, token));
}

/**
 * Parameters gated by `supportsSamplingParams` (`temperature`, `top_p`).
 * `top_k` and `min_p` are not part of this group: ordinary rows advertise
 * temperature and top_p without those extensions, and requiring them would
 * drop temperature too. Each extension has its own flag.
 */
const OPENZOO_SAMPLING_PARAMETERS = ["temperature", "top_p"] as const;

/**
 * Parameters gated by `supportsPenaltyAndStopParams`. One flag covers every
 * penalty field and `stop`, so a present list that omits any of them disables
 * the group.
 */
const OPENZOO_PENALTY_AND_STOP_PARAMETERS = [
	"presence_penalty",
	"frequency_penalty",
	"repetition_penalty",
	"stop",
] as const;

/**
 * Reasoning the live row actually advertises. A matching bundled id from
 * another provider is not a signal — that host may expose a different
 * control surface than this OpenAI-completions proxy.
 *
 * `true` when the row says it reasons. `false` when it explicitly declines
 * (`supports_reasoning: false` or `reasoning: false`) and no positive signal
 * exists — a thinking-variant name must not turn that back on. `undefined`
 * when the row omits reasoning metadata, which is the only case where that
 * name is a fallback.
 */
function liveOpenzooReasoning(entry: OpenAICompatibleModelRecord): boolean | undefined {
	if (entry.supports_reasoning === true || entry.reasoning === true) {
		return true;
	}
	if (isRecord(entry.reasoning)) {
		return true;
	}
	if (
		listIncludes(entry.supported_parameters, "reasoning") ||
		listIncludes(entry.supported_parameters, "reasoning_effort")
	) {
		return true;
	}
	if (entry.supports_reasoning === false || entry.reasoning === false) {
		return false;
	}
	return undefined;
}

/**
 * Native tool support the live row actually advertises.
 *
 * `false` when `supported_parameters` is present and omits `tools`: callers
 * treat `undefined` as permission to send native tool definitions, so a
 * roster that listed its parameters and left tools out must say no.
 * `true` when that list includes `tools`. The positive has to be explicit:
 * a refresh merges with `model.supportsTools ?? existing.supportsTools`, so
 * an unset field would keep a cached `false` for the rest of the process.
 * `undefined` when the list is absent — absence stays neutral and does not
 * clear a cached no.
 */
function liveOpenzooSupportsTools(entry: OpenAICompatibleModelRecord): boolean | undefined {
	if (!Array.isArray(entry.supported_parameters)) {
		return undefined;
	}
	return listIncludes(entry.supported_parameters, "tools");
}

type OpenzooSamplingCompat = Pick<
	OpenAICompat,
	"supportsSamplingParams" | "supportsPenaltyAndStopParams" | "supportsTopK" | "supportsMinP"
>;

/**
 * Sampling compatibility the live row actually advertises.
 *
 * `false` for a group when `supported_parameters` is present and omits any
 * control in that group: the completions transport sends the whole group
 * whenever the flag is on, and a route that did not advertise a control
 * rejects it with 400. `true` when the list includes every control in the
 * group, so a cached no does not survive a refresh that now advertises them.
 * `top_k`, `min_p`, and the penalty group are not cleared when temperature
 * or top_p is missing: a list that names one of those controls sets that
 * flag true even while `supportsSamplingParams` is false. `undefined` when
 * the list is absent — absence stays neutral.
 */
function liveOpenzooSamplingCompat(entry: OpenAICompatibleModelRecord): OpenzooSamplingCompat | undefined {
	if (!Array.isArray(entry.supported_parameters)) {
		return undefined;
	}
	return {
		supportsSamplingParams: listIncludesEvery(entry.supported_parameters, OPENZOO_SAMPLING_PARAMETERS),
		supportsPenaltyAndStopParams: listIncludesEvery(entry.supported_parameters, OPENZOO_PENALTY_AND_STOP_PARAMETERS),
		supportsTopK: listIncludes(entry.supported_parameters, "top_k"),
		supportsMinP: listIncludes(entry.supported_parameters, "min_p"),
	};
}

/**
 * OpenRouter spells `architecture.modality` as `input->output`
 * (`text->image`, `text+image->text`). Image on the output side is not
 * image input. A legacy value with no arrow (`text+image`) is entirely input.
 */
function openzooModalityHasImageInput(modality: string): boolean {
	const arrow = modality.indexOf("->");
	const input = (arrow === -1 ? modality : modality.slice(0, arrow)).trim();
	return input.includes("image");
}

/**
 * Input modalities the live row actually advertises. `undefined` means the
 * roster omitted them — leave the discovery default and let KDL
 * `input-modalities` correct at `buildModel` time. An explicit
 * `supports_vision` / `supports_image` / `supports_image_in: false`, with no
 * positive modality signal, is a reported text-only result so that correction
 * does not put image back. When the roster omits `input_modalities` and sets
 * `architecture.modality`, only the input side of `->` counts.
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
			return openzooModalityHasImageInput(modality) ? ["text", "image"] : ["text"];
		}
	}
	if (Array.isArray(entry.input_modalities)) {
		return listIncludes(entry.input_modalities, "image") ? ["text", "image"] : ["text"];
	}
	if (entry.supports_vision === false || entry.supports_image === false || entry.supports_image_in === false) {
		return ["text"];
	}
	return undefined;
}

/**
 * Map one proxy row. Limits come from the row where it carries the model's
 * real numbers; the bundled upstream reference (matched by the
 * OpenRouter-style id) supplies only the display name.
 * Reasoning is the live report when the row gives one. An explicit false
 * stays false; only a row that omits reasoning metadata falls back to a
 * thinking-variant name. Image input stays on the discovery default unless
 * the row reports it, including an explicit false vision flag with no
 * positive modality signal. A matching id from another provider is not a
 * capability signal. A present `supported_parameters` list that omits `tools` marks
 * the model not tool-capable; a list that includes `tools` sets
 * `supportsTools: true` so a cached no does not survive the refresh; a
 * missing list leaves that unset. The same list sets
 * `supportsSamplingParams` / `supportsPenaltyAndStopParams` false when it
 * omits that group's controls, and `supportsTopK` / `supportsMinP` false
 * unless that extension itself was listed. All four stay unset when the
 * list itself is absent. An explicit modality report, including a false
 * vision flag with no positive signal, sets `inputModalitiesReported` so
 * the image correction in `providers/openzoo.kdl` does not overwrite a
 * text-only row; an omitted report stays neutral and the correction fills
 * it at `buildModel` time. Pricing is always the proxy's: it is what the
 * wallet pays.
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
	const family = openzooVariantFamily(defaults.id);
	const supportsTools = liveOpenzooSupportsTools(entry);
	const toolSupport = supportsTools !== undefined ? { supportsTools } : {};
	const sampling = liveOpenzooSamplingCompat(entry);
	const samplingCompat = sampling !== undefined ? { compat: sampling } : {};
	const liveInput = liveOpenzooInput(entry);
	const reportedInput = liveInput !== undefined ? { inputModalitiesReported: true } : {};
	const liveReasoning = liveOpenzooReasoning(entry);
	if (family) {
		// Same live capability fields as an ordinary row. The family return
		// used to keep the generic reasoning:false / input:["text"] defaults,
		// so openzoo/auto hid a roster that advertised them. Omitted reasoning
		// stays off: router ids are not thinking-variant names.
		return {
			...defaults,
			...toolSupport,
			...samplingCompat,
			...reportedInput,
			id: family.id,
			name: family.name,
			reasoning: liveReasoning ?? false,
			input: liveInput ?? defaults.input,
			cost: mapOpenzooCost(entry.pricing),
			contextWindow: toPositiveNumber(entry.max_model_len, null),
			maxTokens: toPositiveNumber(entry.max_output_tokens, null),
		};
	}
	if (isOpenzooHarnessTwin(entry)) {
		return null;
	}
	const canonical = resolveModelReference(defaults.id, references);
	const contextWindow = toPositiveNumber(entry.max_model_len, null);
	const topProvider = isRecord(entry.top_provider) ? entry.top_provider : undefined;
	const reportedMaxTokens = toPositiveNumber(
		entry.max_output_tokens,
		toPositiveNumber(topProvider?.max_completion_tokens, null),
	);
	const maxTokens =
		reportedMaxTokens != null && contextWindow != null
			? Math.min(reportedMaxTokens, contextWindow)
			: reportedMaxTokens;
	const identity = classifyModel("openzoo", defaults.id, { lenient: true });
	return {
		...defaults,
		...toolSupport,
		...samplingCompat,
		...reportedInput,
		name: canonical?.name ?? toDisplayName(entry.display_name, defaults.name),
		reasoning: liveReasoning ?? identity.thinkingVariant === true,
		input: liveInput ?? defaults.input,
		cost: mapOpenzooCost(entry.pricing),
		contextWindow,
		maxTokens,
	};
}

/**
 * An omit sticks for the rest of this roster fold, including over a later
 * alias that advertises the capability. An explicit `true` sticks while no
 * alias omitted it. A missing list is neutral.
 */
function mergeOpenzooAdvertisedBoolean(previous: boolean | undefined, next: boolean | undefined): boolean | undefined {
	if (previous === false || next === false) return false;
	if (previous === true || next === true) return true;
	return undefined;
}

function mergeOpenzooSamplingCompat(
	previous: OpenzooSamplingCompat | undefined,
	next: OpenzooSamplingCompat | undefined,
): OpenzooSamplingCompat | undefined {
	const supportsSamplingParams = mergeOpenzooAdvertisedBoolean(
		previous?.supportsSamplingParams,
		next?.supportsSamplingParams,
	);
	const supportsPenaltyAndStopParams = mergeOpenzooAdvertisedBoolean(
		previous?.supportsPenaltyAndStopParams,
		next?.supportsPenaltyAndStopParams,
	);
	const supportsTopK = mergeOpenzooAdvertisedBoolean(previous?.supportsTopK, next?.supportsTopK);
	const supportsMinP = mergeOpenzooAdvertisedBoolean(previous?.supportsMinP, next?.supportsMinP);
	if (
		supportsSamplingParams === undefined &&
		supportsPenaltyAndStopParams === undefined &&
		supportsTopK === undefined &&
		supportsMinP === undefined
	) {
		return undefined;
	}
	return {
		...(supportsSamplingParams !== undefined ? { supportsSamplingParams } : {}),
		...(supportsPenaltyAndStopParams !== undefined ? { supportsPenaltyAndStopParams } : {}),
		...(supportsTopK !== undefined ? { supportsTopK } : {}),
		...(supportsMinP !== undefined ? { supportsMinP } : {}),
	};
}

/** Image input sticks once any router alias advertises it; a text-only alias does not clear it. */
function mergeOpenzooAdvertisedInput(
	previous: ModelSpec<"openai-completions">["input"],
	next: ModelSpec<"openai-completions">["input"],
): ModelSpec<"openai-completions">["input"] {
	return previous.includes("image") || next.includes("image") ? ["text", "image"] : previous;
}

/**
 * Per-fetch mapper. Discovery dedupes by mapped id (last row wins), and the
 * backend publishes the router under several alias spellings, so router rows
 * fold into one `auto` entry. The fold is FIELD-BY-FIELD: each cost component
 * and each limit keeps the first nonzero/non-null value seen, so an alias row
 * that supplies only the number an earlier row omitted still contributes it.
 * An alias whose parameter list omits `tools` marks the folded model not
 * tool-capable, and a later alias that lists `tools` does not clear that
 * mark. An alias with no list does not clear it either. A tools
 * advertisement is kept when no alias omitted tools. Sampling,
 * penalty/stop, top_k, and min_p flags fold the same way: an omit on any
 * alias sticks, and listing one extension does not turn the other on.
 * Advertised reasoning and image
 * input are a union: a later alias that reports either keeps it, and an
 * alias that omits them does not clear it. An explicit modality report on
 * any alias keeps the folded input from the image correction.
 */
export function createOpenzooModelMapper(
	references: ModelReferenceIndex,
): (
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
) => ModelSpec<"openai-completions"> | null {
	const variants = new Map<string, ModelSpec<"openai-completions">>();
	return (entry, defaults) => {
		const row = mapOpenzooModel(entry, defaults, references);
		if (row === null || !openzooVariantFamily(defaults.id)) {
			return row;
		}
		const previous = variants.get(row.id);
		const supportsTools = previous
			? mergeOpenzooAdvertisedBoolean(previous.supportsTools, row.supportsTools)
			: row.supportsTools;
		const sampling = previous ? mergeOpenzooSamplingCompat(previous.compat, row.compat) : row.compat;
		const inputModalitiesReported =
			previous?.inputModalitiesReported === true || row.inputModalitiesReported === true;
		const merged = previous
			? {
					...previous,
					reasoning: previous.reasoning || row.reasoning,
					input: mergeOpenzooAdvertisedInput(previous.input, row.input),
					cost: {
						input: previous.cost.input > 0 ? previous.cost.input : row.cost.input,
						output: previous.cost.output > 0 ? previous.cost.output : row.cost.output,
						cacheRead: previous.cost.cacheRead > 0 ? previous.cost.cacheRead : row.cost.cacheRead,
						cacheWrite: previous.cost.cacheWrite > 0 ? previous.cost.cacheWrite : row.cost.cacheWrite,
					},
					contextWindow: previous.contextWindow ?? row.contextWindow,
					maxTokens: previous.maxTokens ?? row.maxTokens,
					...(supportsTools !== undefined ? { supportsTools } : {}),
					...(sampling !== undefined ? { compat: sampling } : {}),
					...(inputModalitiesReported ? { inputModalitiesReported: true } : {}),
				}
			: row;
		variants.set(row.id, merged);
		return merged;
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
		fetchDynamicModels: async () => {
			// Resolved here, not at options construction: walking the bundled
			// reference index is only worth paying for when discovery actually runs.
			const mapModel = createOpenzooModelMapper(getBundledModelReferenceIndex());
			// The local proxy is keyless. A public tunnel checks the oz_ bearer
			// and answers 401/403 when it is missing or wrong; that status has to
			// survive as an auth rejection instead of a silent empty catalog.
			const tunnel = !hasLocalLoopbackBaseUrl(baseUrl);
			let authStatus: 401 | 403 | undefined;
			const fetchImpl: FetchImpl = async (input, init) => {
				const response = await discoveryFetch(config?.fetch)(input, init);
				if (tunnel && (response.status === 401 || response.status === 403)) {
					authStatus = response.status;
				}
				return response;
			};
			const models = await fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "openzoo",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => mapModel(entry, defaults),
				fetch: fetchImpl,
			});
			if (models === null && authStatus !== undefined) {
				throw new DiscoveryAuthRejectionError(authStatus, `${baseUrl}/models`);
			}
			return models;
		},
	};
}
