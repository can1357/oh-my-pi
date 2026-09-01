import { type } from "@oh-my-pi/omptype";
import { compareRevision, parseRevision } from "../compat/revision";
import { classifyModel } from "../compat/taxonomy";
import { getBundledModels } from "../models";
import type { FetchImpl, ModelSpec } from "../types";
import { discoveryFetch } from "../utils";
import { CODEX_BASE_URL, CODEX_CLIENT_VERSION, OPENAI_HEADER_VALUES, OPENAI_HEADERS } from "../wire/codex";

const DEFAULT_MODEL_LIST_PATHS = ["/codex/models", "/models"] as const;
const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_TOKENS = 128_000;
/**
 * Fallback for GPT-5.6-family SKUs when upstream omits `context_window`: the
 * generic {@link DEFAULT_CONTEXT_WINDOW} (272000) understates the registry's
 * former 372000 hard capacity (#5705).
 */
const GPT_5_6_CONTEXT_WINDOW = 372_000;
/**
 * OpenAI enabled a 1M-token window for subscription Codex on GPT-5.6
 * luna/sol/terra (2026-08-16), but the Codex model registry still reports the
 * stale 272000 — so the reported value must be floored, not just defaulted
 * (openai/codex#38917; Codex CLI override `model_context_window = 1000000`).
 */
const GPT_5_6_1M_CONTEXT_WINDOW = 1_000_000;
const CODEX_GPT_5_6_1M_SLUGS: ReadonlySet<string> = new Set(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
/**
 * Codex advertises worker-mode SKUs under a `-wm` suffix (`gpt-5.6-luna-wm`).
 *
 * Those rows route through the same Codex backend as their plain SKU, but an
 * authoritative discovery list that only advertises the `-wm` slug prunes the
 * bundled plain model, leaving a configured `openai-codex/gpt-5.6-luna`
 * unresolvable except via fuzzy fallback onto the `-wm` row — which this user's
 * ChatGPT account rejects. The compatibility rule, scoped to Codex discovery:
 * a `-wm` slug whose plain counterpart exists in the bundled Codex catalog is
 * ALSO registered under its plain id. Both listings derive their base-model
 * metadata (1M-window floor, daybreak pricing, context fallback) from the
 * canonical plain slug — the suffix is a routing variant, not a different
 * model, so the `-wm` row no longer keeps stale backend-parsed capability
 * values while its plain listing is enriched.
 *
 * Deliberate boundary: the "safe" gate is the bundled Codex catalog. A `-wm`
 * slug whose plain counterpart is only a user-local models.yml entry (not
 * bundled) stays verbatim — authoritative discovery for genuinely distinct
 * `-wm` SKUs is preserved, and a hidden plain backend entry can be re-surfaced
 * through its advertised `-wm` row because the configured plain slug must
 * resolve.
 */
const CODEX_WORKER_SUFFIX = "-wm";
const CODEX_REMOTE_COMPACTION = {
	enabled: true,
	api: "openai-codex-responses",
	v2StreamingEnabled: true,
} as const;

const codexReasoningPresetSchema = type({
	"effort?": "unknown",
});

const codexModelEntrySchema = type({
	"slug?": "unknown",
	"id?": "unknown",
	"display_name?": "unknown",
	"context_window?": "unknown",
	"default_reasoning_level?": "unknown",
	"supported_reasoning_levels?": "unknown",
	"input_modalities?": "unknown",
	"visibility?": "unknown",
	"priority?": "unknown",
	"prefer_websockets?": "unknown",
	"use_responses_lite?": "unknown",
	"tool_mode?": "unknown",
});

const codexModelsResponseSchema = type({
	"models?": "unknown[]",
	"data?": "unknown[]",
});

type CodexModelEntry = typeof codexModelEntrySchema.infer;
interface NormalizedCodexModel {
	model: ModelSpec<"openai-codex-responses">;
	priority: number;
}

/**
 * Fetch options for OpenAI Codex model discovery.
 */
export interface CodexModelDiscoveryOptions {
	/** OAuth access token used for `Authorization: Bearer ...`. */
	accessToken: string;
	/** ChatGPT account id value used for `chatgpt-account-id` header. */
	accountId?: string;
	/** Base URL for Codex backend. Defaults to `https://chatgpt.com/backend-api`. */
	baseUrl?: string;
	/** Optional client version attached as `client_version` query parameter. */
	clientVersion?: string;
	/** Optional endpoint path candidates. Defaults to `/codex/models`, then `/models`. */
	paths?: readonly string[];
	/** Additional headers merged on top of required Codex headers. */
	headers?: Record<string, string>;
	/** Abort signal for network request cancellation. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for tests. */
	fetchFn?: FetchImpl;
}

/**
 * Normalized Codex discovery response.
 */
export interface CodexModelDiscoveryResult {
	models: ModelSpec<"openai-codex-responses">[];
	etag?: string;
}

/**
 * Fetches model metadata from Codex backend and normalizes it for pi model management.
 *
 * Returns `null` when no supported model-list route can be fetched/parsed.
 * Returns `{ models: [] }` when a route succeeds but yields no usable models.
 */
export async function fetchCodexModels(options: CodexModelDiscoveryOptions): Promise<CodexModelDiscoveryResult | null> {
	const fetchFn = discoveryFetch(options.fetchFn);
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const paths = normalizePaths(options.paths);
	const clientVersion = normalizeClientVersion(options.clientVersion) ?? CODEX_CLIENT_VERSION;
	const headers = buildCodexHeaders(options, clientVersion);

	let sawSuccessfulResponse = false;
	for (const path of paths) {
		const requestUrl = buildModelsUrl(baseUrl, path, clientVersion);
		let response: Response;
		try {
			response = await fetchFn(requestUrl, {
				method: "GET",
				headers,
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

		const models = normalizeCodexModels(payload, baseUrl);
		if (models === null) {
			continue;
		}
		sawSuccessfulResponse = true;
		const etag = getResponseEtag(response.headers);
		return etag ? { models, etag } : { models };
	}
	return sawSuccessfulResponse ? { models: [] } : null;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
	const raw = (baseUrl ?? CODEX_BASE_URL).trim();
	if (!raw) {
		return CODEX_BASE_URL;
	}
	return raw.replace(/\/+$/, "");
}

function normalizePaths(paths: readonly string[] | undefined): string[] {
	if (!paths || paths.length === 0) {
		return [...DEFAULT_MODEL_LIST_PATHS];
	}
	const normalized = paths
		.map(path => path.trim())
		.filter(path => path.length > 0)
		.map(path => (path.startsWith("/") ? path : `/${path}`));
	return normalized.length > 0 ? normalized : [...DEFAULT_MODEL_LIST_PATHS];
}

function buildModelsUrl(baseUrl: string, path: string, clientVersion: string | undefined): string {
	const url = new URL(`${baseUrl}${path}`);
	if (clientVersion && clientVersion.trim().length > 0) {
		url.searchParams.set("client_version", clientVersion.trim());
	}
	return url.toString();
}

function buildCodexHeaders(options: CodexModelDiscoveryOptions, clientVersion: string): Headers {
	const headers = new Headers(options.headers);
	headers.set("Authorization", `Bearer ${options.accessToken}`);
	if (options.accountId && options.accountId.trim().length > 0) {
		headers.set(OPENAI_HEADERS.ACCOUNT_ID, options.accountId);
	}
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set(OPENAI_HEADERS.VERSION, clientVersion);
	headers.set("accept", "application/json");
	return headers;
}

function normalizeClientVersion(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	if (!/^\d+\.\d+\.\d+$/.test(trimmed)) {
		return undefined;
	}
	return trimmed;
}

function normalizeCodexModels(payload: unknown, baseUrl: string): ModelSpec<"openai-codex-responses">[] | null {
	const parsedResponse = codexModelsResponseSchema(payload);
	if (parsedResponse instanceof type.errors) {
		return null;
	}

	const entries = parsedResponse.models ?? parsedResponse.data ?? [];
	const parsedEntries: ParsedCodexModelEntry[] = [];
	for (const entry of entries) {
		const parsed = parseCodexModelEntry(entry);
		if (parsed) {
			parsedEntries.push(parsed);
		}
	}

	// A worker `-wm` slug gets an extra plain-id route only when the bundled
	// catalog ships the plain SKU (the "safe" precondition); the backend's own
	// plain slug wins over any synthesized clone, and unknown `-wm` SKUs stay
	// verbatim. Both listings of a safe `-wm` model carry the same base-model
	// metadata (context-window floor, daybreak pricing) derived from the
	// canonical plain slug — the suffix is a routing variant, not a different
	// model.
	const advertisedSlugs = new Set(parsedEntries.map(parsed => parsed.slug));
	const bundledCodexModelIds = getBundledCodexModelIds();
	const normalized: NormalizedCodexModel[] = [];
	for (const parsed of parsedEntries) {
		const canonicalSlug = plainCounterpartForWorkerSlug(parsed.slug, bundledCodexModelIds) ?? parsed.slug;
		normalized.push(buildNormalizedCodexModel(parsed, parsed.slug, canonicalSlug, baseUrl));
		const plainSlug = canonicalSlug !== parsed.slug ? canonicalSlug : null;
		if (plainSlug && !advertisedSlugs.has(plainSlug)) {
			normalized.push(buildNormalizedCodexModel(parsed, plainSlug, canonicalSlug, baseUrl));
		}
	}

	normalized.sort((left, right) => {
		if (left.priority !== right.priority) {
			return left.priority - right.priority;
		}
		return left.model.id.localeCompare(right.model.id);
	});

	return normalized.map(item => item.model);
}

/** Ids of the bundled Codex catalog, consulted once per discovery run. */
function getBundledCodexModelIds(): ReadonlySet<string> {
	const ids = new Set(getBundledModels("openai-codex").map(model => model.id));
	return ids;
}

/**
 * Map a Codex worker `-wm` slug to its plain counterpart when the bundled
 * catalog registers that plain SKU. Returns `null` for non-worker slugs and
 * for `-wm` slugs without a safe plain counterpart.
 */
function plainCounterpartForWorkerSlug(slug: string, bundledCodexModelIds: ReadonlySet<string>): string | null {
	if (!slug.endsWith(CODEX_WORKER_SUFFIX)) {
		return null;
	}
	const plain = slug.slice(0, -CODEX_WORKER_SUFFIX.length);
	return plain.length > 0 && bundledCodexModelIds.has(plain) ? plain : null;
}

interface ParsedCodexModelEntry {
	slug: string;
	name: string;
	contextWindow: number | null;
	reasoning: boolean;
	input: ("text" | "image")[];
	preferWebsockets: boolean;
	useResponsesLite: boolean;
	toolMode: boolean;
	priority: number;
}

function parseCodexModelEntry(entry: unknown): ParsedCodexModelEntry | null {
	const parsedEntry = codexModelEntrySchema(entry);
	if (parsedEntry instanceof type.errors) {
		return null;
	}

	const payload: CodexModelEntry = parsedEntry;
	const slug = toNonEmptyString(payload.slug) ?? toNonEmptyString(payload.id);
	if (!slug) {
		return null;
	}

	const visibility = toNonEmptyString(payload.visibility)?.toLowerCase();
	if (visibility === "hide" || visibility === "hidden") {
		return null;
	}

	return {
		slug,
		name: toNonEmptyString(payload.display_name) ?? slug,
		contextWindow: toPositiveInt(payload.context_window),
		reasoning: supportsReasoning(payload.default_reasoning_level, payload.supported_reasoning_levels),
		input: normalizeInputModalities(payload.input_modalities),
		preferWebsockets: toBoolean(payload.prefer_websockets) === true,
		useResponsesLite: toBoolean(payload.use_responses_lite) === true,
		toolMode: payload.tool_mode === "code_mode_only",
		priority: toFiniteNumber(payload.priority) ?? Number.MAX_SAFE_INTEGER,
	};
}

/**
 * Build a normalized Codex model spec. `slug` is the registered id (either the
 * advertised slug or a synthesized plain counterpart); `canonicalSlug` names
 * the model's bundled SKU (`slug` itself for plain/unknown rows, the plain
 * counterpart for a safe `-wm` row) and owns the base-model metadata derivation
 * so both listings of a model report the same context window and pricing.
 */
function buildNormalizedCodexModel(
	parsed: ParsedCodexModelEntry,
	slug: string,
	canonicalSlug: string,
	baseUrl: string,
): NormalizedCodexModel {
	// Codex discovery historically omitted `context_window` for GPT-5.6-family
	// SKUs (#5705); luna/sol/terra additionally floor the reported value because
	// the registry still declares the pre-1M 272000 window. Keyed on the
	// canonical slug so a safe `gpt-5.6-luna-wm` row gets the same floor as its
	// plain listing.
	const identity = classifyModel("openai-codex", canonicalSlug, { lenient: true });
	const revision = identity.revision === undefined ? undefined : parseRevision(identity.revision);
	const gpt56 = parseRevision("5.6");
	const fallbackContextWindow =
		identity.class === "openai" &&
		revision !== undefined &&
		gpt56 !== undefined &&
		compareRevision(revision, gpt56) === 0
			? GPT_5_6_CONTEXT_WINDOW
			: DEFAULT_CONTEXT_WINDOW;
	const reportedContextWindow = parsed.contextWindow ?? fallbackContextWindow;
	const contextWindow = CODEX_GPT_5_6_1M_SLUGS.has(canonicalSlug)
		? Math.max(reportedContextWindow, GPT_5_6_1M_CONTEXT_WINDOW)
		: reportedContextWindow;
	const maxTokens = Math.min(DEFAULT_MAX_TOKENS, contextWindow);
	return {
		priority: parsed.priority,
		model: {
			id: slug,
			name: parsed.name,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl,
			reasoning: parsed.reasoning,
			input: parsed.input,
			// Daybreak standard API pricing is rule-owned (`providers/openai-codex.kdl`
			// cost-patch) and corrected at build time.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			remoteCompaction: CODEX_REMOTE_COMPACTION,
			contextWindow,
			maxTokens,
			...(parsed.preferWebsockets ? { preferWebsockets: true } : {}),
			...(parsed.useResponsesLite ? { useResponsesLite: true } : {}),
			...(parsed.toolMode ? { toolMode: "code_mode_only" as const } : {}),
			...(parsed.priority !== Number.MAX_SAFE_INTEGER ? { priority: parsed.priority } : {}),
		},
	};
}

function supportsReasoning(defaultReasoningLevel: unknown, supportedReasoningLevels: unknown): boolean {
	const defaultLevel = toNonEmptyString(defaultReasoningLevel)?.toLowerCase();
	if (defaultLevel && defaultLevel !== "none") {
		return true;
	}

	if (!Array.isArray(supportedReasoningLevels)) {
		return false;
	}

	for (const level of supportedReasoningLevels) {
		const parsedLevel = codexReasoningPresetSchema(level);
		if (parsedLevel instanceof type.errors) {
			continue;
		}
		const effort = toNonEmptyString(parsedLevel.effort)?.toLowerCase();
		if (effort && effort !== "none") {
			return true;
		}
	}

	return false;
}

function normalizeInputModalities(inputModalities: unknown): ("text" | "image")[] {
	if (!Array.isArray(inputModalities)) {
		return ["text", "image"];
	}

	const set = new Set<"text" | "image">();
	for (const modality of inputModalities) {
		const normalized = toNonEmptyString(modality)?.toLowerCase();
		if (normalized === "text" || normalized === "image") {
			set.add(normalized);
		}
	}

	if (set.size === 0) {
		return ["text", "image"];
	}

	const canonical: ("text" | "image")[] = ["text", "image"];
	return canonical.filter(modality => set.has(modality));
}

function getResponseEtag(headers: Headers): string | undefined {
	const etag = headers.get("etag");
	if (!etag) {
		return undefined;
	}
	const trimmed = etag.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function toNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function toPositiveInt(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	if (value <= 0) {
		return null;
	}
	return Math.trunc(value);
}

function toFiniteNumber(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return value;
}

function toBoolean(value: unknown): boolean | null {
	if (typeof value !== "boolean") {
		return null;
	}
	return value;
}
