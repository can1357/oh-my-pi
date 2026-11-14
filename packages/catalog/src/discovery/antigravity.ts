import { type } from "@oh-my-pi/omptype";
import type { FetchImpl } from "@oh-my-pi/pi-utils";
import { pricingPeerFor } from "../compat/behavior";
import { collapseVariants, reviewedVariantFamilyId, type VariantCollapseTable } from "../compat/collapse";
import { getBundledModel } from "../models";
import { createBundledReferenceMap, createReferenceResolver } from "../provider-models/bundled-references";
import type { AntigravityModelWireProfile, ModelCost, ModelSpec } from "../types";
import { discoveryFetch, toPositiveNumber } from "../utils";
import { ensureAntigravityVersion, getAntigravityHeaders } from "../wire/gemini-headers";

export const ANTIGRAVITY_PRIMARY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const DEFAULT_ANTIGRAVITY_DISCOVERY_ENDPOINTS = [ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT] as const;
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const ANTIGRAVITY_DISCOVERY_DENYLIST = new Set(["chat_20706", "chat_23310", "gemini-2.5-pro"]);

/** `fetchAvailableModels` `thinkingLevel` → wire `thinkingConfig.thinkingLevel` (verified against the native client). */
const ANTIGRAVITY_THINKING_LEVELS: Readonly<Record<number, AntigravityModelWireProfile["thinkingLevel"]>> = {
	1: "LOW",
	2: "MEDIUM",
	3: "HIGH",
	// Gemini 4 Hydrogen's `-xhigh` SKU; Google documents this level in lowercase.
	100: "xhigh",
};

/**
 * What a roster row leaves out, keyed by the logical (collapsed) model id:
 * capability flags for an absent `supportsThinking`/`supportsImages`, and a
 * price for the row the roster never prices.
 */
export interface AntigravityRowReference {
	reasoning?: boolean;
	input?: readonly ("text" | "image")[];
	cost?: ModelCost;
}

const resolveBundledReference = createReferenceResolver<"google-gemini-cli">(() =>
	createBundledReferenceMap("google-antigravity"),
);

/**
 * Price an Antigravity id through the `pricing-peer provider="google-antigravity"`
 * rule the generator and stats also use: the alias `peer-id` first, then the id
 * itself, across the peers in declared order.
 */
function pricingPeerCost(modelId: string): ModelCost | undefined {
	const peer = pricingPeerFor("google-antigravity", modelId);
	if (!peer) return undefined;
	for (const candidateId of peer.peerId !== modelId ? [peer.peerId, modelId] : [modelId]) {
		for (const provider of peer.peers) {
			const cost = getBundledModel(provider, candidateId)?.cost;
			if (cost && (cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0)) {
				return cost;
			}
		}
	}
	return undefined;
}

/**
 * Default {@link AntigravityRowReference} for `google-antigravity` discovery.
 * Antigravity's roster omits capability metadata for some SKUs entirely (Gemini
 * 3.5 Flash-Lite arrives with no `supportsThinking` at all), and prices nothing.
 * Capabilities come from the bundled row for the logical id (or the bare-id
 * reference); `thinking` itself is never inherited, the provider rules own it.
 * The price comes from the pricing-peer rule.
 */
export function antigravityRowReference(logicalId: string): AntigravityRowReference | undefined {
	const bundled = resolveBundledReference(logicalId);
	const cost = pricingPeerCost(logicalId);
	if (!bundled && !cost) return undefined;
	return { reasoning: bundled?.reasoning, input: bundled?.input, cost };
}

/**
 * Raw model metadata returned by Antigravity's `fetchAvailableModels` endpoint.
 */
export interface AntigravityDiscoveryApiModel {
	displayName?: string;
	supportsImages?: boolean;
	supportsThinking?: boolean;
	thinkingBudget?: number;
	/** SKU thinking level: 1 low, 2 medium, 3 high, 100 xhigh. */
	thinkingLevel?: number;
	recommended?: boolean;
	maxTokens?: number;
	maxOutputTokens?: number;
	model?: string;
	apiProvider?: string;
	modelProvider?: string;
	isInternal?: boolean;
	/**
	 * Set for roster rows the backend lists but refuses to serve on this
	 * account (e.g. `gemini-4-argon-disabled`, `tagTitle: "Unavailable"`,
	 * `model: MODEL_PLACEHOLDER_M421`); a request against such an id answers
	 * `Cloud Code Assist API error (404): Requested entity was not found.`
	 */
	disabled?: boolean;
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
	imageGenerationModelIds?: string[];
}
const AntigravityDiscoveryApiModelSchema = type({
	"displayName?": type("unknown").pipe(value => (typeof value === "string" ? value : undefined)),
	"supportsImages?": type("unknown").pipe(value => (typeof value === "boolean" ? value : undefined)),
	"supportsThinking?": type("unknown").pipe(value => (typeof value === "boolean" ? value : undefined)),
	"thinkingBudget?": type("unknown").pipe(value =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined,
	),
	"thinkingLevel?": type("unknown").pipe(value =>
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
	"disabled?": type("unknown").pipe(value => (typeof value === "boolean" ? value : undefined)),
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
	"imageGenerationModelIds?": type("unknown").pipe(value =>
		Array.isArray(value) ? value.filter((modelId): modelId is string => typeof modelId === "string") : undefined,
	),
});
/**
 * Options for fetching Antigravity discovery models.
 */
export interface FetchAntigravityDiscoveryModelsOptions {
	/** OAuth access token used as `Authorization: Bearer <token>`. */
	token: string;
	/** Optional endpoint override. Defaults to Antigravity fallback endpoints. */
	endpoint?: string;
	/**
	 * Cloud Code Assist project the account is onboarded to. Sent as the body's
	 * `project` field like the native client; the body is `{}` when absent.
	 */
	projectId?: string;
	/** Optional user agent override. */
	userAgent?: string;
	/** Optional abort signal for request cancellation. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for tests. */
	fetcher?: FetchImpl;
	/**
	 * Hand collapse table to apply to the discovered list. Defaults to the
	 * Antigravity (budget-transport) table; `googleGeminiCli` passes the
	 * level-transport table so cloudcode-pa keeps `thinkingLevel`.
	 */
	collapseTable?: VariantCollapseTable;
	/**
	 * Fills what the roster omits, keyed by the logical (collapsed) id: an
	 * absent capability flag reads as unknown and takes the reference's value
	 * (an explicit roster value always wins), and a zero-cost row takes the
	 * reference's price. Only `google-antigravity` sets it; without it, an
	 * absent flag is `false` and rows stay $0.
	 */
	resolveReference?: (logicalId: string) => AntigravityRowReference | undefined;
}

/**
 * A complete account roster, or a definitive 401/403 credential rejection.
 * `null` from {@link fetchAntigravityDiscoveryModels} instead means a transient
 * failure or invalid response, which must not replace an authoritative catalog.
 */
export interface AntigravityModelDiscoveryResult {
	models: ModelSpec<"google-gemini-cli">[];
	rejectedStatus?: 401 | 403;
}

/**
 * Fetches discoverable Antigravity models and normalizes them into canonical model entries.
 *
 * Returns `null` on network, server, or payload failures; a 401/403 is reported
 * separately so multi-account discovery can skip a rejected credential.
 * A successful empty roster has `models: []` without `rejectedStatus`.
 */
export async function fetchAntigravityDiscoveryModels(
	options: FetchAntigravityDiscoveryModelsOptions,
): Promise<AntigravityModelDiscoveryResult | null> {
	const discovered = await fetchAntigravityDiscoveryResponse(options);
	if (!discovered) return null;
	if ("rejectedStatus" in discovered) return { models: [], rejectedStatus: discovered.rejectedStatus };

	const models: ModelSpec<"google-gemini-cli">[] = [];
	const apiModels = discovered.payload.models;
	if (apiModels) {
		for (const modelId in apiModels) {
			const model = apiModels[modelId];
			if (ANTIGRAVITY_DISCOVERY_DENYLIST.has(modelId)) {
				continue;
			}
			if (model.isInternal === true) {
				continue;
			}
			// Rows the backend marks unavailable are listed but 404 on inference;
			// discovery is authoritative, so drop them instead of offering a dead id.
			if (model.disabled === true) {
				continue;
			}

			// Tier SKUs (`claude-opus-5-5-low`) share their family's reference.
			const reference = options.resolveReference?.(
				reviewedVariantFamilyId("google-antigravity", modelId) ?? modelId,
			);
			const supportsImages = model.supportsImages ?? reference?.input?.includes("image") ?? false;
			const wireProfile = antigravityWireProfileOf(model);
			models.push({
				id: modelId,
				name: model.displayName || modelId,
				api: "google-gemini-cli",
				provider: "google-antigravity",
				baseUrl: discovered.endpoint,
				reasoning: model.supportsThinking ?? reference?.reasoning ?? false,
				input: supportsImages ? ["text", "image"] : ["text"],
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: toPositiveNumber(model.maxTokens, DEFAULT_CONTEXT_WINDOW),
				maxTokens: toPositiveNumber(model.maxOutputTokens, DEFAULT_MAX_TOKENS),
				...(wireProfile === undefined ? {} : { antigravityWireProfiles: { [modelId]: wireProfile } }),
			});
		}
	}

	// Collapse effort-tier variants at the source so runtime discovery,
	// the gemini-cli re-provision, and the catalog generator all see
	// logical ids only.
	const collapsed = collapseVariants(
		models,
		options.collapseTable === undefined ? undefined : { table: options.collapseTable },
	);
	// The roster never prices anything, so every row arrives at $0. Price after
	// collapsing, keyed by the logical id, so a tiered family takes its rate
	// too; a zeroed row would read as a free lane in cost accounting and model
	// choice.
	const resolveReference = options.resolveReference;
	const priced =
		resolveReference === undefined
			? collapsed
			: collapsed.map(model => {
					const cost = resolveReference(model.id)?.cost;
					return cost ? { ...model, cost: { ...cost } } : model;
				});
	priced.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	return { models: priced };
}

/**
 * Request constants the native client derives from one roster row: the
 * `model_enum` label, the fixed output cap, and the SKU's thinking setting.
 * Returns `undefined` when the row carries none of them.
 */
function antigravityWireProfileOf(model: AntigravityDiscoveryApiModel): AntigravityModelWireProfile | undefined {
	const profile: AntigravityModelWireProfile = {};
	if (model.model) profile.modelEnum = model.model;
	if (model.maxOutputTokens !== undefined && model.maxOutputTokens > 0) {
		profile.maxOutputTokens = model.maxOutputTokens;
	}
	const thinkingLevel =
		model.thinkingLevel === undefined ? undefined : ANTIGRAVITY_THINKING_LEVELS[model.thinkingLevel];
	if (thinkingLevel !== undefined) profile.thinkingLevel = thinkingLevel;
	if (model.thinkingBudget !== undefined) profile.thinkingBudget = model.thinkingBudget;
	return Object.keys(profile).length > 0 ? profile : undefined;
}

/** Advertised image model and serving endpoint for one Antigravity account. */
export interface AntigravityImageModel {
	id: string;
	endpoint: string;
}

/** Resolves the first image-generation model advertised by an Antigravity account. */
export async function fetchAntigravityImageModel(
	options: FetchAntigravityDiscoveryModelsOptions,
): Promise<AntigravityImageModel | null> {
	const discovered = await fetchAntigravityDiscoveryResponse(options);
	if (!discovered || "rejectedStatus" in discovered) return null;
	const id = discovered.payload.imageGenerationModelIds?.find(modelId => modelId.length > 0);
	return id ? { id, endpoint: discovered.endpoint } : null;
}

type AntigravityDiscoveryResponse =
	| { payload: AntigravityDiscoveryApiResponse; endpoint: string }
	| { rejectedStatus: 401 | 403 };

async function fetchAntigravityDiscoveryResponse(
	options: FetchAntigravityDiscoveryModelsOptions,
): Promise<AntigravityDiscoveryResponse | null> {
	if (options.userAgent === undefined) {
		await ensureAntigravityVersion(options.fetcher ?? fetch, options.signal);
	}

	const fetcher = discoveryFetch(options.fetcher);
	const endpoints = options.endpoint
		? [trimTrailingSlashes(options.endpoint)]
		: DEFAULT_ANTIGRAVITY_DISCOVERY_ENDPOINTS.map(trimTrailingSlashes);

	let rejectedStatus: 401 | 403 | undefined;
	let transientFailure = false;
	for (const endpoint of endpoints) {
		let response: Response;
		try {
			response = await fetcher(`${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.token}`,
					"Content-Type": "application/json",
					...getAntigravityHeaders(options.userAgent),
				},
				body: JSON.stringify(options.projectId ? { project: options.projectId } : {}),
				signal: options.signal,
			});
		} catch {
			transientFailure = true;
			continue;
		}

		if (!response.ok) {
			if (response.status === 401) rejectedStatus = 401;
			else if (response.status === 403) rejectedStatus = 403;
			else transientFailure = true;
			continue;
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			transientFailure = true;
			continue;
		}

		const parsed = parseAntigravityDiscoveryResponse(payload);
		if (parsed) return { payload: parsed, endpoint };
		transientFailure = true;
	}

	return rejectedStatus !== undefined && !transientFailure ? { rejectedStatus } : null;
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
