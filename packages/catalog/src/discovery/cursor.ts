import * as http2 from "node:http2";
import { type } from "@oh-my-pi/omptype";
import { collapseVariants, type EffortVariantFamily, reviewedVariantFamilyId } from "../compat/collapse";
import { compareRevision, parseRevision } from "../compat/revision";
import { resolveCatalogAxes, resolveModelPolicy } from "../compat/resolve";
import { classifyModel } from "../compat/taxonomy";
import { Effort, THINKING_EFFORTS } from "../effort";
import { getBundledModels } from "../models";
import { toModelSpec } from "../provider-models/bundled-references";
import type { CursorModelRoute, Model, ModelSpec, TokenCost } from "../types";
import {
	CURSOR_AVAILABLE_MODELS_PATH,
	CURSOR_DEFAULT_BASE_URL,
	CURSOR_GET_DEFAULT_MODEL_PATH,
	CURSOR_GET_USABLE_MODELS_PATH,
	cursorClientHeaders,
} from "../wire/cursor";
import {
	type AvailableModelsResponse_ModelDetails,
	AvailableModelsRequestSchema,
	AvailableModelsResponseSchema,
	GetDefaultModelForCliRequestSchema,
	GetDefaultModelForCliResponseSchema,
	GetUsableModelsRequestSchema,
	GetUsableModelsResponseSchema,
} from "./cursor-proto";
import { create, fromBinary, toBinary, type MessageCodec, type ProtoMessage } from "./protobuf";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

/**
 * `GetUsableModels` carries no context-window field, so the 1M ceiling is
 * recovered from the signals Cursor does send:
 * - display-name labels ("Opus 5 1M", "GPT-5.5 1M High") across families,
 * - natively 1M families Cursor serves unlabeled (Kimi K3, GLM 5.2+),
 * - the max-mode flag on Claude/Gemini ids, whose max-mode ceiling is 1M.
 */
const CURSOR_1M_CONTEXT_WINDOW = 1_000_000;
// residue: a display-name label is the only signal for these rows; ids carry
// no marker the taxonomy could classify.
const CURSOR_1M_NAME_PATTERN = /\b1m\b/i;

const OptionalDisplayNameSchema = type("unknown").pipe(raw => (typeof raw === "string" ? raw : undefined));
const CursorAliasesSchema = type("unknown").pipe(raw => {
	if (Array.isArray(raw)) {
		return raw.filter((alias: unknown): alias is string => typeof alias === "string");
	}
	return [];
});

const CursorModelDetailsSchema = type({
	modelId: "string",
	displayName: OptionalDisplayNameSchema.default(undefined),
	displayNameShort: OptionalDisplayNameSchema.default(undefined),
	displayModelId: OptionalDisplayNameSchema.default(undefined),
	aliases: CursorAliasesSchema.default(() => []),
	"thinkingDetails?": "unknown",
	maxMode: "boolean = false",
});

const CursorModelsInnerSchema = type("unknown[]");
const ResilientCursorModelsSchema = type("unknown").pipe(raw => {
	const out = CursorModelsInnerSchema(raw);
	return out instanceof type.errors ? [] : out;
});

const CursorDecodedResponseSchema = type({
	models: ResilientCursorModelsSchema.default(() => []),
});

type CursorModelDetailsValue = typeof CursorModelDetailsSchema.infer;

/** Options for authenticated Cursor model discovery. */
export interface CursorModelDiscoveryOptions {
	/** Cursor access token used for bearer authentication. */
	apiKey: string;
	/** Optional Cursor API base URL override. */
	baseUrl?: string;
	/** Optional client version override sent as `x-cursor-client-version`. */
	clientVersion?: string;
	/** Optional request timeout in milliseconds. */
	timeoutMs?: number;
	/** Optional list of custom Cursor model ids to include in request context. */
	customModelIds?: string[];
}

/**
 * Joins Cursor's account-scoped model RPCs:
 * - `AvailableModels` supplies rich base models, parameter axes, variants,
 *   capabilities, aliases, and cost-multiplier metadata.
 * - `GetUsableModels` supplies the exact legacy wire slugs the account can run.
 * - `GetDefaultModelForCli` identifies the account's current default.
 *
 * Per-token rates come from the reviewed `providers/cursor.kdl` rate card and
 * the bundled rows; discovery only scales them by a variant's declared multiplier.
 *
 * Returns `null` unless at least one model-list RPC (`GetUsableModels` or
 * `AvailableModels`) decoded. A successful empty catalog returns `[]`,
 * preserving model-manager retry and fallback semantics.
 */
export async function fetchCursorUsableModels(
	options: CursorModelDiscoveryOptions,
): Promise<ModelSpec<"cursor-agent">[] | null> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const baseUrl = (options.baseUrl ?? CURSOR_DEFAULT_BASE_URL).replace(/\/+$/, "");
	const usableRequest = create(GetUsableModelsRequestSchema, {
		customModelIds: normalizeCustomModelIds(options.customModelIds),
	});
	const availableRequest = create(AvailableModelsRequestSchema, {
		includeLongContextModels: true,
		useModelParameters: true,
		doNotUseMarkdown: true,
		useCloudAgentEffortModes: true,
	});
	const defaultRequest = create(GetDefaultModelForCliRequestSchema, {});

	const [usablePayload, availablePayload, defaultPayload] = await Promise.all([
		fetchCursorUnary(
			baseUrl,
			CURSOR_GET_USABLE_MODELS_PATH,
			toBinary(GetUsableModelsRequestSchema, usableRequest),
			options,
			timeoutMs,
		),
		fetchCursorUnary(
			baseUrl,
			CURSOR_AVAILABLE_MODELS_PATH,
			toBinary(AvailableModelsRequestSchema, availableRequest),
			options,
			Math.min(timeoutMs, 2_000),
		),
		fetchCursorUnary(
			baseUrl,
			CURSOR_GET_DEFAULT_MODEL_PATH,
			toBinary(GetDefaultModelForCliRequestSchema, defaultRequest),
			options,
			timeoutMs,
		),
	]);
	const usable = decodeUnary(GetUsableModelsResponseSchema, usablePayload);
	const available = decodeUnary(AvailableModelsResponseSchema, availablePayload);
	// Only a decoded model list is authoritative: the default-model RPC alone
	// must not publish an empty roster that replaces the cached catalog.
	if (usable === null && available === null) return null;
	const defaultModel = decodeUnary(GetDefaultModelForCliResponseSchema, defaultPayload)?.model;
	const parsedUsable = CursorDecodedResponseSchema(usable);
	const references = createCursorReferenceMap();
	const legacyModels =
		parsedUsable instanceof type.errors
			? []
			: normalizeCursorModels(parsedUsable.models, options.baseUrl, references);
	const usableModelIds = usable === null ? undefined : new Set(legacyModels.map(model => model.id));
	if (!available || available.models.length === 0) return legacyModels;
	const richModels = normalizeRichCursorModels(
		available.models,
		usableModelIds,
		options.baseUrl,
		references,
		defaultModel?.modelId,
		defaultModel?.maxMode,
	);
	const richCatalogIds = collectRichCursorCatalogIds(available.models);

	// Rich variants carry `legacy_slug`; retain an otherwise-unrepresented
	// usable row so schema drift cannot hide a model the run endpoint accepts.
	const representedIds = new Set<string>();
	for (const model of richModels) {
		representedIds.add(model.id);
		representedIds.add(model.requestModelId ?? model.id);
		for (const routeId of Object.keys(model.cursorModelRoutes ?? {})) representedIds.add(routeId);
	}
	for (const model of legacyModels) {
		if (!representedIds.has(model.id) && !richCatalogIds.has(model.id)) richModels.push(model);
	}
	return richModels.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * One unary RPC under a single deadline. HTTP/1.1 fetch goes first; the
 * HTTP/2 Connect retry runs only after a transport-level failure (h2-only
 * endpoints) and only with the remaining budget. An HTTP response of any
 * status, or a deadline abort, is final.
 */
async function fetchCursorUnary(
	baseUrl: string,
	path: string,
	body: Uint8Array<ArrayBuffer>,
	options: CursorModelDiscoveryOptions,
	timeoutMs: number,
): Promise<Uint8Array | null> {
	const deadline = Date.now() + timeoutMs;
	const signal = AbortSignal.timeout(timeoutMs);
	let response: Response;
	try {
		response = await fetch(new URL(path, baseUrl), {
			method: "POST",
			headers: {
				...cursorClientHeaders(options.apiKey, { clientVersion: options.clientVersion }),
				"connect-protocol-version": "1",
				"x-request-id": crypto.randomUUID(),
			},
			body,
			signal,
		});
	} catch {
		const remainingMs = deadline - Date.now();
		if (signal.aborted || remainingMs <= 0) return null;
		// Older/custom Cursor endpoints may accept only an HTTP/2 Connect request.
		return fetchViaHttp2(baseUrl, path, body, options, remainingMs);
	}
	if (!response.ok) return null;
	try {
		return new Uint8Array(await response.arrayBuffer());
	} catch {
		return null;
	}
}

/** HTTP/2 transport used by Cursor's unary protobuf RPCs. */
async function fetchViaHttp2(
	baseUrl: string,
	path: string,
	body: Uint8Array,
	options: CursorModelDiscoveryOptions,
	timeoutMs: number,
): Promise<Uint8Array | null> {
	const { promise, resolve } = Promise.withResolvers<Uint8Array | null>();
	const client = http2.connect(baseUrl);
	let settled = false;
	const finish = (value: Uint8Array | null): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		client.close();
		resolve(value);
	};
	const timer = setTimeout(() => {
		client.destroy();
		finish(null);
	}, timeoutMs);

	client.on("error", () => finish(null));
	const req = client.request({
		":method": "POST",
		":path": path,
		te: "trailers",
		...cursorClientHeaders(options.apiKey, { clientVersion: options.clientVersion }),
		"connect-protocol-version": "1",
		"x-request-id": crypto.randomUUID(),
	});
	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", () => finish(new Uint8Array(Buffer.concat(chunks))));
	req.on("error", () => finish(null));
	req.on("response", headers => {
		const status = Number(headers[":status"] ?? 0);
		if (status < 200 || status >= 300) finish(null);
	});
	req.end(Buffer.from(body));
	return promise;
}

function normalizeCustomModelIds(customModelIds: readonly string[] | undefined): string[] {
	if (!customModelIds) {
		return [];
	}
	const normalized = new Set<string>();
	for (const value of customModelIds) {
		if (typeof value !== "string") {
			continue;
		}
		const trimmed = value.trim();
		if (!trimmed) {
			continue;
		}
		normalized.add(trimmed);
	}
	return [...normalized];
}

function createCursorReferenceMap(): Map<string, ModelSpec<"cursor-agent">> {
	const references = new Map<string, ModelSpec<"cursor-agent">>();
	for (const model of getBundledModels("cursor")) {
		references.set(model.id, toModelSpec(model as Model<"cursor-agent">));
	}
	return references;
}

function decodeUnary<TMessage extends ProtoMessage>(
	schema: MessageCodec<TMessage>,
	payload: Uint8Array | null,
): TMessage | null {
	// An empty 200 body is a valid, fully-defaulted protobuf message.
	if (payload === null) return null;
	const body = decodeConnectUnaryBody(payload) ?? payload;
	try {
		return fromBinary(schema, body);
	} catch {
		return null;
	}
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
	if (payload.length < 5) {
		return null;
	}

	let offset = 0;
	while (offset + 5 <= payload.length) {
		const flags = payload[offset];
		const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
		const messageLength = view.getUint32(1, false);
		const frameEnd = offset + 5 + messageLength;
		if (frameEnd > payload.length) {
			return null;
		}
		const compressionFlagSet = (flags & 0b0000_0001) !== 0;
		if (compressionFlagSet) {
			return null;
		}
		const endStreamFlagSet = (flags & 0b0000_0010) !== 0;
		if (!endStreamFlagSet) {
			return payload.subarray(offset + 5, frameEnd);
		}

		offset = frameEnd;
	}

	return null;
}

function isCursorKimiK3(id: string): boolean {
	const identity = classifyModel("cursor", id, { lenient: true });
	return identity.class === "kimi" && identity.family === "k3";
}
function isCursorVersionedGrok(id: string): boolean {
	const identity = classifyModel("cursor", id, { lenient: true });
	if (identity.class !== "xai" || identity.revision === undefined) return false;
	const revision = parseRevision(identity.revision);
	const floor = parseRevision("4");
	return revision !== undefined && floor !== undefined && compareRevision(revision, floor) >= 0;
}

function isCursorGlm52CodingModel(id: string): boolean {
	const identity = classifyModel("cursor", id, { lenient: true });
	if (identity.class !== "glm" || identity.revision === undefined) return false;
	if (identity.family !== undefined && identity.family !== "air" && identity.family !== "turbo") return false;
	const revision = parseRevision(identity.revision);
	const floor = parseRevision("5.2");
	return revision !== undefined && floor !== undefined && compareRevision(revision, floor) >= 0;
}
type RichCursorVariant = AvailableModelsResponse_ModelDetails["variants"][number];

type CursorRouteEffort = Effort | "off";

interface NormalizedRichVariant {
	id: string;
	parameters: { id: string; value: string }[];
	variant: RichCursorVariant | undefined;
	effort: CursorRouteEffort | undefined;
}

function collectRichCursorCatalogIds(models: readonly AvailableModelsResponse_ModelDetails[]): Set<string> {
	const ids = new Set<string>();
	for (const details of models) {
		const baseId = details.name.trim();
		if (baseId) ids.add(baseId);
		for (const id of [...details.legacySlugs, ...details.idAliases]) {
			if (id.trim()) ids.add(id.trim());
		}
		for (const [index, variant] of details.variants.entries()) {
			const parameters = variant.parameterValues
				.map(parameter => ({ id: parameter.id.trim(), value: parameter.value.trim() }))
				.filter(parameter => parameter.id.length > 0);
			const parameterSuffix = parameters.map(parameter => `${parameter.id}=${parameter.value}`).join(",");
			const id =
				variant.legacySlug?.trim() ||
				variant.variantStringRepresentation?.trim() ||
				(parameterSuffix ? `${baseId}@${parameterSuffix}` : `${baseId}@variant-${index + 1}`);
			if (id) ids.add(id);
		}
	}
	return ids;
}

const CURSOR_REASONING_PARAMETER_IDS = new Set([
	"effort",
	"reasoning",
	"reasoning_effort",
	"thinking",
	"thinking_effort",
]);

/** The declared definition value a variant parameter selects, when Cursor defines one. */
function cursorParameterValue(
	details: AvailableModelsResponse_ModelDetails,
	parameter: { id: string; value: string },
): { increasesModelCost?: boolean; markdownTooltip?: string; definitionTooltip?: string } | undefined {
	const definition = details.parameterDefinitions.find(candidate => candidate.id === parameter.id);
	if (!definition) return undefined;
	const booleanValue = definition.parameterType?.booleanParameter?.values.find(
		candidate => candidate.value === parameter.value,
	);
	const enumValue = definition.parameterType?.enumParameter?.values.find(
		candidate => candidate.value === parameter.value,
	);
	const selected = booleanValue ?? enumValue;
	if (!selected) return undefined;
	return {
		increasesModelCost: selected.increasesModelCost,
		markdownTooltip: enumValue?.markdownTooltip,
		definitionTooltip: definition.markdownTooltip,
	};
}

function cursorVariantCostMultiplier(
	details: AvailableModelsResponse_ModelDetails,
	entry: NormalizedRichVariant,
): number {
	let multiplier = 1;
	for (const parameter of entry.parameters) {
		const selected = cursorParameterValue(details, parameter);
		if (selected?.increasesModelCost !== true) continue;
		for (const description of [selected.markdownTooltip, selected.definitionTooltip]) {
			const match = description ? /\b(\d+(?:\.\d+)?)\s*[x×](?![a-z])/i.exec(description) : undefined;
			if (!match?.[1]) continue;
			const parameterMultiplier = Number(match[1]);
			if (Number.isFinite(parameterMultiplier) && parameterMultiplier > 0) {
				multiplier *= parameterMultiplier;
				break;
			}
		}
	}
	return multiplier;
}

function scaleTokenCost(cost: TokenCost, multiplier: number): TokenCost {
	if (multiplier === 1) return cost;
	return {
		input: cost.input * multiplier,
		output: cost.output * multiplier,
		cacheRead: cost.cacheRead * multiplier,
		cacheWrite: cost.cacheWrite * multiplier,
	};
}

/**
 * Price a rich variant from the reviewed `providers/cursor.kdl` rate card,
 * which keys on Cursor wire slugs (`claude-opus-4-8-high`, `gpt-5.4`). Cursor
 * bills per price class — the values of the model's cost-bearing parameters
 * (`fast`, `context`) — not per effort or thinking toggle, so every slug in
 * the variant's own class shares its price. The lane id leads the own-class
 * slugs: `buildModel` later resolves the same card by lane id, so a lane-keyed
 * `cost-patch` must win here too or the two would disagree. Multiplier rule:
 * - `cost-patch` on an own-class slug is that class's reviewed price and is
 *   final, even for fast classes (`claude-opus-4-7-high-fast` $30/$150);
 * - `cost-fallback` rows, and any base-class slug or the model name, carry the
 *   base card, scaled by the declared multiplier (`cursorVariantCostMultiplier`).
 */
function resolveRichCursorCardCost(
	details: AvailableModelsResponse_ModelDetails,
	entry: NormalizedRichVariant,
	laneId: string,
): TokenCost | undefined {
	const costAxes = details.parameterDefinitions
		.filter(definition =>
			[
				...(definition.parameterType?.booleanParameter?.values ?? []),
				...(definition.parameterType?.enumParameter?.values ?? []),
			].some(value => value.increasesModelCost === true),
		)
		.map(definition => definition.id);
	const priceClass = (parameters: readonly { id: string; value: string }[]): string =>
		costAxes.map(id => parameters.find(parameter => parameter.id === id)?.value ?? "").join("\u0000");
	const entryClass = priceClass(entry.parameters);
	const ownSlugs = [laneId, entry.id];
	const baseSlugs = [details.name.trim()];
	for (const variant of details.variants) {
		const slug = variant.legacySlug?.trim();
		if (!slug) continue;
		const parameters = variant.parameterValues.map(parameter => ({
			id: parameter.id.trim(),
			value: parameter.value.trim(),
		}));
		if (priceClass(parameters) === entryClass) {
			ownSlugs.push(slug);
		} else if (!parameters.some(parameter => cursorParameterValue(details, parameter)?.increasesModelCost === true)) {
			baseSlugs.push(slug);
		}
	}
	let base: TokenCost | undefined;
	for (const slug of ownSlugs) {
		const card = resolveCursorCardAxes(slug);
		if (card.patch) return card.patch;
		base ??= card.fallback;
	}
	for (const slug of baseSlugs) {
		if (base) break;
		const card = resolveCursorCardAxes(slug);
		base = card.patch ?? card.fallback;
	}
	return base && scaleTokenCost(base, cursorVariantCostMultiplier(details, entry));
}

function resolveCursorCardAxes(slug: string): { patch?: TokenCost; fallback?: TokenCost } {
	const axes = resolveCatalogAxes({
		id: slug,
		name: slug,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: CURSOR_DEFAULT_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	});
	const card = (payload: unknown): TokenCost | undefined => {
		if (typeof payload !== "object" || payload === null) return undefined;
		const field = (key: string): number | undefined => {
			const value = Reflect.get(payload, key);
			return typeof value === "number" && Number.isFinite(value) ? value : undefined;
		};
		const input = field("input");
		const output = field("output");
		if (input === undefined || output === undefined) return undefined;
		return { input, output, cacheRead: field("cacheRead") ?? 0, cacheWrite: field("cacheWrite") ?? 0 };
	};
	return { patch: card(axes.costPatch), fallback: card(axes.costFallback) };
}

function normalizeRichCursorModels(
	models: readonly AvailableModelsResponse_ModelDetails[],
	usableModelIds: ReadonlySet<string> | undefined,
	baseUrlOverride: string | undefined,
	references: Map<string, ModelSpec<"cursor-agent">>,
	defaultModelId: string | undefined,
	defaultMaxMode: boolean | undefined,
): ModelSpec<"cursor-agent">[] {
	const normalized: ModelSpec<"cursor-agent">[] = [];
	for (const details of models) {
		const baseId = details.name.trim();
		if (!baseId || details.supportsAgent === false || details.isChatOnly === true) continue;
		// OMP always sends Cursor's zero-data-retention header. Advertising a
		// retention-required model would expose a route every invocation rejects.
		if (details.requiresDataRetention === true) continue;

		const variants = normalizeRichCursorVariants(details, baseId, usableModelIds);
		if (variants.length === 0) continue;
		// The bare lane id belongs to Cursor's flagged default configuration, so
		// seed axis defaults from it before falling back to first-seen values;
		// otherwise lane names would follow the server's variant order.
		const defaultRank = (entry: NormalizedRichVariant): number =>
			entry.variant?.isDefaultNonMaxConfig === true ? 0 : entry.variant?.isDefaultMaxConfig === true ? 1 : 2;
		const parameterDefaults = new Map<string, string>();
		for (const entry of variants.toSorted((left, right) => defaultRank(left) - defaultRank(right))) {
			for (const parameter of cursorLaneParameters(entry.parameters)) {
				if (!parameterDefaults.has(parameter.id)) parameterDefaults.set(parameter.id, parameter.value);
			}
		}

		const lanes = new Map<string, NormalizedRichVariant[]>();
		for (const entry of variants) {
			const dimensions = cursorLaneParameters(entry.parameters);
			const key = JSON.stringify([dimensions, entry.variant?.isMaxMode === true]);
			const lane = lanes.get(key);
			if (lane) {
				lane.push(entry);
			} else {
				lanes.set(key, [entry]);
			}
		}

		const claimedLaneIds = new Set<string>();
		for (const entries of lanes.values()) {
			const first = entries[0];
			if (!first) continue;
			const dimensions = cursorLaneParameters(first.parameters);
			const richLaneId = cursorLaneId(
				baseId,
				dimensions,
				parameterDefaults,
				first.variant?.isMaxMode === true,
				claimedLaneIds,
			);
			const laneName = cursorLaneName(details, richLaneId, baseId);
			const laneId = reviewedCursorLaneId(entries, claimedLaneIds) ?? richLaneId;
			normalized.push(
				...buildRichCursorLane(
					details,
					entries,
					laneId,
					laneName,
					baseUrlOverride,
					references,
					defaultModelId,
					defaultMaxMode,
				),
			);
		}
	}
	return normalized.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeRichCursorVariants(
	details: AvailableModelsResponse_ModelDetails,
	baseId: string,
	usableModelIds: ReadonlySet<string> | undefined,
): NormalizedRichVariant[] {
	if (details.variants.length === 0) {
		const candidates = [baseId, ...details.legacySlugs, ...details.idAliases];
		if (usableModelIds !== undefined && !candidates.some(id => usableModelIds.has(id))) return [];
		return [{ id: baseId, parameters: [], variant: undefined, effort: undefined }];
	}

	const variants: NormalizedRichVariant[] = [];
	const seenRoutes = new Set<string>();
	for (const [index, variant] of details.variants.entries()) {
		if (isRichVariantBlocked(details, variant)) continue;
		const parameters = variant.parameterValues
			.map(parameter => ({ id: parameter.id.trim(), value: parameter.value.trim() }))
			.filter(parameter => parameter.id.length > 0);
		const parameterSuffix = parameters.map(parameter => `${parameter.id}=${parameter.value}`).join(",");
		const id =
			variant.legacySlug?.trim() ||
			variant.variantStringRepresentation?.trim() ||
			(parameterSuffix ? `${baseId}@${parameterSuffix}` : `${baseId}@variant-${index + 1}`);
		const entitlementIds = [variant.legacySlug?.trim(), id, baseId, ...details.idAliases].filter(
			(candidate): candidate is string => Boolean(candidate),
		);
		if (usableModelIds !== undefined && !entitlementIds.some(candidate => usableModelIds.has(candidate))) continue;
		const routeSignature = `${parameterSuffix}\u0000${variant.isMaxMode === true ? "max" : "standard"}`;
		if (seenRoutes.has(routeSignature)) continue;
		seenRoutes.add(routeSignature);
		variants.push({
			id,
			parameters,
			variant,
			effort: cursorVariantEffort(parameters),
		});
	}
	return variants;
}

function cursorVariantEffort(parameters: readonly { id: string; value: string }[]): CursorRouteEffort | undefined {
	const thinking = parameters.find(parameter => parameter.id === "thinking")?.value.toLowerCase();
	if (thinking === "false" || thinking === "off" || thinking === "none") return "off";
	const rawEffort = parameters.find(parameter =>
		["reasoning", "reasoning_effort", "thinking_effort", "effort"].includes(parameter.id),
	)?.value;
	if (rawEffort === undefined) return undefined;
	const normalized = rawEffort.toLowerCase().replace(/[_\s]+/g, "-");
	if (normalized === "none" || normalized === "off" || normalized === "disabled") return "off";
	if (
		normalized === Effort.Minimal ||
		normalized === Effort.Low ||
		normalized === Effort.Medium ||
		normalized === Effort.High ||
		normalized === Effort.XHigh ||
		normalized === Effort.Max
	) {
		return normalized;
	}
	if (normalized === "extra-high") return Effort.XHigh;
	return undefined;
}

function cursorLaneParameters(parameters: readonly { id: string; value: string }[]): { id: string; value: string }[] {
	return parameters.filter(parameter => !CURSOR_REASONING_PARAMETER_IDS.has(parameter.id));
}

function cursorLaneId(
	baseId: string,
	parameters: readonly { id: string; value: string }[],
	defaults: ReadonlyMap<string, string>,
	isMaxMode: boolean,
	claimed: Set<string>,
): string {
	const suffixes: string[] = [];
	for (const parameter of parameters) {
		const id = sanitizeCursorLanePart(parameter.id);
		const value = sanitizeCursorLanePart(parameter.value);
		// Boolean lanes are named by their `true` side regardless of variant
		// order: Cursor lists `composer-2.5`'s Fast variant first, and treating
		// that as the default would hand the bare id to the Fast route.
		if (!id || !value || parameter.value === "false") continue;
		if (parameter.value === "true") {
			suffixes.push(id);
		} else if (parameter.value === defaults.get(parameter.id)) {
			continue;
		} else if (parameter.id === "context") {
			suffixes.push(value);
		} else {
			suffixes.push(`${id}-${value}`);
		}
	}
	const root = [baseId, ...suffixes].join("-");
	let candidate = root;
	if (claimed.has(candidate)) candidate = `${root}-${isMaxMode ? "max-mode" : "standard"}`;
	let duplicate = 2;
	while (claimed.has(candidate)) {
		candidate = `${root}-${duplicate}`;
		duplicate += 1;
	}
	claimed.add(candidate);
	return candidate;
}

/**
 * The reviewed collapse family owning a lane's legacy slugs, when exactly one
 * family claims any of them (slugs no family lists, e.g. a newly added tier,
 * stay in the lane). `AvailableModels` names Grok 4.5/4.6 `grok-4.6` while its
 * slugs are `cursor-grok-4.6-*`; reusing the family id keeps the lane id equal
 * to the `GetUsableModels`-only fallback and the bundled catalog, so a selector
 * survives whichever RPC answered.
 */
function reviewedCursorLaneId(entries: readonly NormalizedRichVariant[], claimed: Set<string>): string | undefined {
	let familyId: string | undefined;
	for (const entry of entries) {
		const slug = entry.variant?.legacySlug?.trim();
		const owner = slug ? reviewedVariantFamilyId("cursor", slug) : undefined;
		if (owner === undefined) continue;
		if (familyId !== undefined && owner !== familyId) return undefined;
		familyId = owner;
	}
	if (familyId === undefined || claimed.has(familyId)) return undefined;
	claimed.add(familyId);
	return familyId;
}

function sanitizeCursorLanePart(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function cursorLaneName(details: AvailableModelsResponse_ModelDetails, laneId: string, baseId: string): string {
	const baseName =
		details.clientDisplayName?.trim() || details.serverModelName?.trim() || details.name.trim() || baseId;
	const suffix = laneId
		.slice(baseId.length)
		.replace(/^-/, "")
		.split("-")
		.filter(Boolean)
		.map(part => (part === "1m" ? "1M" : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(" ");
	return suffix ? `${baseName} ${suffix}` : baseName;
}

function buildRichCursorLane(
	details: AvailableModelsResponse_ModelDetails,
	entries: readonly NormalizedRichVariant[],
	laneId: string,
	laneName: string,
	baseUrlOverride: string | undefined,
	references: Map<string, ModelSpec<"cursor-agent">>,
	defaultModelId: string | undefined,
	defaultMaxMode: boolean | undefined,
): ModelSpec<"cursor-agent">[] {
	// `thinking=true` without an effort axis gets its own slot so the
	// toggle's thinking route survives selection beside the `off` route.
	const isThinkingToggle = (entry: NormalizedRichVariant): boolean =>
		entry.effort === undefined &&
		entry.parameters.some(parameter => parameter.id === "thinking" && parameter.value.toLowerCase() === "true");
	const selectedByEffort = new Map<CursorRouteEffort | "thinking" | "fixed", NormalizedRichVariant>();
	for (const entry of entries) {
		const slot = entry.effort ?? (isThinkingToggle(entry) ? "thinking" : "fixed");
		const current = selectedByEffort.get(slot);
		if (
			current === undefined ||
			cursorVariantPreference(details, entry, defaultModelId, defaultMaxMode) >
				cursorVariantPreference(details, current, defaultModelId, defaultMaxMode)
		) {
			selectedByEffort.set(slot, entry);
		}
	}
	const selected = [...selectedByEffort.values()];
	if (selected.length === 0) return [];

	const routeKeys = new Map<NormalizedRichVariant, string>();
	const usedRouteKeys = new Set<string>();
	const routes: Record<string, CursorModelRoute> = {};
	for (const entry of selected) {
		let routeKey = entry.id;
		if (usedRouteKeys.has(routeKey)) {
			routeKey =
				entry.variant?.variantStringRepresentation?.trim() ||
				`${entry.id}@${entry.parameters.map(parameter => `${parameter.id}=${parameter.value}`).join(",")}`;
		}
		let duplicate = 2;
		const root = routeKey;
		while (usedRouteKeys.has(routeKey)) {
			routeKey = `${root}#${duplicate}`;
			duplicate += 1;
		}
		usedRouteKeys.add(routeKey);
		routeKeys.set(entry, routeKey);
		routes[routeKey] = {
			modelId: details.name.trim(),
			parameters: entry.parameters,
			...(entry.variant?.isMaxMode === undefined ? undefined : { maxMode: entry.variant.isMaxMode }),
		};
	}

	const members: ModelSpec<"cursor-agent">[] = [];
	const routing: Partial<Record<CursorRouteEffort, string>> = {};
	let defaultMember: string | undefined;
	let thinkingToggleMember: ModelSpec<"cursor-agent"> | undefined;
	for (const entry of selected) {
		const routeKey = routeKeys.get(entry);
		if (!routeKey) continue;
		const variant = entry.variant;
		const reference =
			references.get(entry.id) ??
			references.get(details.name.trim()) ??
			details.legacySlugs.map(id => references.get(id)).find(candidate => candidate !== undefined);
		const isMaxMode = variant?.isMaxMode ?? false;
		const contextParameter = entry.parameters.find(parameter => parameter.id === "context")?.value;
		const contextLimit =
			parseCursorContextWindow(contextParameter) ??
			(isMaxMode ? details.contextTokenLimitForMaxMode : details.contextTokenLimit);
		const discoveredContextWindow =
			contextLimit ?? details.autoContextExtendedMaxTokens ?? details.autoContextMaxTokens;
		const fallbackContext = reference?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		const input: ("text" | "image")[] =
			details.supportsImages === undefined
				? resolveCursorInput(entry.id, reference?.input)
				: details.supportsImages
					? ["text", "image"]
					: ["text"];
		const isProviderDefault = isCursorProviderDefault(details, entry, defaultModelId, defaultMaxMode);
		const reasoning =
			entry.effort === "off"
				? false
				: entry.effort !== undefined || isThinkingToggle(entry)
					? true
					: (details.supportsThinking ?? reference?.reasoning ?? false);
		// Price precedence: the reviewed KDL rate card by lane id and wire slug,
		// then the member's own bundled reference (a sibling reference carries
		// the base card, so it takes the declared multiplier); zero only when
		// neither knows the price.
		const referenceCost =
			reference && (reference.cost.input !== 0 || reference.cost.output !== 0)
				? reference === references.get(entry.id)
					? reference.cost
					: scaleTokenCost(reference.cost, cursorVariantCostMultiplier(details, entry))
				: undefined;
		const cost = resolveRichCursorCardCost(details, entry, laneId) ??
			referenceCost ?? {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			};
		members.push({
			...(reference ?? {
				id: routeKey,
				name: laneName,
				api: "cursor-agent" as const,
				provider: "cursor" as const,
				baseUrl: baseUrlOverride ?? CURSOR_DEFAULT_BASE_URL,
				reasoning,
				input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: fallbackContext,
				maxTokens: DEFAULT_MAX_TOKENS,
			}),
			id: routeKey,
			name: laneName,
			baseUrl: baseUrlOverride ?? reference?.baseUrl ?? CURSOR_DEFAULT_BASE_URL,
			reasoning,
			input,
			cost,
			supportsTools: details.supportsAgent ?? reference?.supportsTools,
			contextWindow: discoveredContextWindow ?? fallbackContext,
			cursorMaxMode: isMaxMode,
			cursorModelParameters: entry.parameters,
			cursorModelRoutes: routes,
			cursorPrice: details.price,
			cursorRequiresDataRetention: details.requiresDataRetention,
			cursorSupportsAgent: details.supportsAgent,
			cursorSupportsSandboxing: details.supportsSandboxing,
			isProviderDefault,
			isRecommended: isProviderDefault || details.defaultOn,
			description:
				variant?.tagline ??
				details.tagline ??
				cursorTooltipBlurb(variant?.tooltipData?.markdownContent) ??
				cursorTooltipBlurb(details.tooltipData?.markdownContent) ??
				reference?.description,
		});
		if (entry.effort !== undefined) routing[entry.effort] = routeKey;
		else if (isThinkingToggle(entry)) thinkingToggleMember = members.at(-1);
		if (isProviderDefault) defaultMember = routeKey;
	}
	if (members.length === 0) return [];
	// A `thinking=true` variant without an effort axis is the lane's thinking
	// route for every effort the model supports, mirroring the bare/`-thinking`
	// pair rule (`deriveThinkingPairFamilies`): off → `thinking=false`, each
	// effort → `thinking=true`. Efforts come from the member's baked surface,
	// else the resolved policy (KDL `thinking-efforts`, class defaults).
	const toggleEfforts: Effort[] = [];
	if (thinkingToggleMember) {
		const { compat: _compat, ...policySpec } = thinkingToggleMember;
		const surfaceEfforts = thinkingToggleMember.thinking?.efforts.length
			? thinkingToggleMember.thinking.efforts
			: (resolveModelPolicy({ ...policySpec, reasoning: true, thinking: undefined }).thinking?.efforts ?? []);
		for (const effort of surfaceEfforts) {
			if (routing[effort] !== undefined) continue;
			routing[effort] = thinkingToggleMember.id;
			toggleEfforts.push(effort);
		}
	}

	defaultMember ??= selected
		.filter(entry => entry.variant?.isDefaultNonMaxConfig === true || entry.variant?.isDefaultMaxConfig === true)
		.map(entry => routeKeys.get(entry))
		.find((routeKey): routeKey is string => routeKey !== undefined);
	defaultMember ??= routing.off ?? members[0]?.id;
	const efforts = THINKING_EFFORTS.filter(effort => routing[effort] !== undefined);
	const family: EffortVariantFamily = {
		id: laneId,
		name: laneName,
		members: members.map(member => member.id),
		routing,
		...(defaultMember === undefined ? undefined : { defaultMember }),
		...(efforts.length === 0
			? undefined
			: {
					thinking: {
						mode: "effort",
						efforts,
						...(routing.off === undefined ? { requiresEffort: true } : {}),
						...(defaultMember === undefined || toggleEfforts.length > 0
							? undefined
							: {
									defaultLevel: efforts.find(effort => routing[effort] === defaultMember),
								}),
					},
				}),
	};
	return collapseVariants(members, { table: { families: [family] } });
}

/**
 * The one-line model blurb from Cursor's IDE tooltip. The tooltip is HTML for
 * Cursor's editor (`<br />` separators, a bold title, context/effort lines,
 * styled warning spans); the model's prose sentence is the second segment.
 * Context and effort are already separate model fields, so the rest is dropped.
 */
function cursorTooltipBlurb(markdown: string | undefined): string | undefined {
	if (!markdown) return undefined;
	const segments = markdown
		.split(/<br\s*\/?>/i)
		.map(segment =>
			segment
				.replace(/<[^>]+>/g, "")
				.replace(/[*_`]/g, "")
				.trim(),
		)
		.filter(segment => segment.length > 0);
	return segments[1] ?? segments[0];
}

function cursorVariantPreference(
	details: AvailableModelsResponse_ModelDetails,
	entry: NormalizedRichVariant,
	defaultModelId: string | undefined,
	defaultMaxMode: boolean | undefined,
): number {
	if (isCursorProviderDefault(details, entry, defaultModelId, defaultMaxMode)) return 3;
	if (entry.variant?.isDefaultNonMaxConfig === true || entry.variant?.isDefaultMaxConfig === true) return 2;
	return 1;
}

function isCursorProviderDefault(
	details: AvailableModelsResponse_ModelDetails,
	entry: NormalizedRichVariant,
	defaultModelId: string | undefined,
	defaultMaxMode: boolean | undefined,
): boolean {
	const variant = entry.variant;
	if (defaultModelId !== undefined) {
		if (defaultModelId === entry.id) {
			return defaultMaxMode === undefined || defaultMaxMode === (variant?.isMaxMode ?? false);
		}
		if (
			defaultModelId !== details.name &&
			!details.legacySlugs.includes(defaultModelId) &&
			!details.idAliases.includes(defaultModelId)
		) {
			return false;
		}
		if (variant === undefined) return true;
		return defaultMaxMode === true ? variant.isDefaultMaxConfig === true : variant.isDefaultNonMaxConfig === true;
	}
	if (!details.defaultOn) return false;
	return variant === undefined || variant.isDefaultNonMaxConfig === true || variant.isDefaultMaxConfig === true;
}

function parseCursorContextWindow(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(value.trim());
	if (!match?.[1]) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const unit = match[2]?.toLowerCase();
	return Math.round(amount * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1));
}

function isRichVariantBlocked(details: AvailableModelsResponse_ModelDetails, variant: RichCursorVariant): boolean {
	for (const parameter of variant.parameterValues) {
		const definition = details.parameterDefinitions.find(candidate => candidate.id === parameter.id);
		const values = [
			...(definition?.parameterType?.booleanParameter?.values ?? []),
			...(definition?.parameterType?.enumParameter?.values ?? []),
		];
		const value = values.find(candidate => candidate.value === parameter.value);
		if (value?.blockedByAdminAllowlist === true) return true;
	}
	return false;
}

function normalizeCursorModels(
	models: readonly unknown[] | undefined,
	baseUrlOverride: string | undefined,
	references: Map<string, ModelSpec<"cursor-agent">>,
): ModelSpec<"cursor-agent">[] {
	if (!models || models.length === 0) {
		return [];
	}

	const byId = new Map<string, ModelSpec<"cursor-agent">>();
	for (const model of models) {
		const normalized = normalizeCursorModel(model, baseUrlOverride, references);
		if (!normalized) {
			continue;
		}
		byId.set(normalized.id, normalized);
	}

	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeCursorModel(
	model: unknown,
	baseUrlOverride: string | undefined,
	references: Map<string, ModelSpec<"cursor-agent">>,
): ModelSpec<"cursor-agent"> | null {
	const parsedModel = CursorModelDetailsSchema(model);
	if (parsedModel instanceof type.errors) {
		return null;
	}

	const details = parsedModel;
	const id = details.modelId.trim();
	if (!id) {
		return null;
	}

	const name = pickModelDisplayName(details, id);
	const reference = references.get(id);
	// Roster-echoed auto sentinel: record the verbatim roster id so the
	// provider echoes it instead of the synthetic "default" wire id.
	const rosterAutoRequestModelId = id === "auto" ? { requestModelId: id } : {};
	// Versioned Cursor Grok ids (`cursor-grok-4.5`, `cursor-grok-4.6-high`)
	// are reasoning models whose effort rides the per-tier sibling id;
	// `GetUsableModels` ships no `thinkingDetails` for them and the bundled
	// references read `reasoning: false`. The `grok-code-fast-*` family
	// classifies below the 4.x floor and stays out.
	const reasoning =
		isCursorKimiK3(id) ||
		isCursorVersionedGrok(id) ||
		Boolean(details.thinkingDetails) ||
		reference?.reasoning === true;

	if (reference) {
		return {
			...reference,
			id,
			name,
			baseUrl: baseUrlOverride ?? reference.baseUrl,
			reasoning,
			input: resolveCursorInput(id, reference.input),
			contextWindow: resolveCursorContextWindow(details, id, reference.contextWindow),
			cursorMaxMode: details.maxMode,
			...rosterAutoRequestModelId,
		};
	}
	return {
		id,
		name,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: baseUrlOverride ?? CURSOR_DEFAULT_BASE_URL,
		reasoning,
		input: resolveCursorInput(id),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: resolveCursorContextWindow(details, id, DEFAULT_CONTEXT_WINDOW),
		maxTokens: DEFAULT_MAX_TOKENS,
		cursorMaxMode: details.maxMode,
		...rosterAutoRequestModelId,
	};
}

/**
 * Context window for a discovered Cursor model: the 1M ceiling when any 1M
 * signal fires (never below a larger bundled reference), else the fallback.
 */
function resolveCursorContextWindow(
	model: CursorModelDetailsValue,
	id: string,
	fallback: number | null,
): number | null {
	const labeled1M =
		CURSOR_1M_NAME_PATTERN.test(id) ||
		[model.displayName, model.displayNameShort, model.displayModelId, ...model.aliases].some(
			candidate => typeof candidate === "string" && CURSOR_1M_NAME_PATTERN.test(candidate),
		);
	const identity = classifyModel("cursor", id, { lenient: true });
	const maxMode1M = model.maxMode && (identity.class === "anthropic" || identity.class === "gemini");
	if (labeled1M || isCursorNative1MModelId(id) || maxMode1M) {
		return Math.max(fallback ?? 0, CURSOR_1M_CONTEXT_WINDOW);
	}
	return fallback;
}

/**
 * Natively 1M-context families Cursor serves without a "1M" label: GLM 5.2+
 * base/air/turbo coding SKUs (structured family and revision gates exclude
 * vision and sub-1M variants). K3 — including Cursor's bare `k3` alias — is
 * rule-owned via `context-window-floor` in `providers/cursor.kdl`.
 */
function isCursorNative1MModelId(id: string): boolean {
	return isCursorGlm52CodingModel(id);
}

function pickModelDisplayName(model: CursorModelDetailsValue, fallbackId: string): string {
	const candidates = [model.displayName, model.displayNameShort, model.displayModelId, ...model.aliases, fallbackId];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") {
			continue;
		}
		const trimmed = candidate.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return fallbackId;
}

/**
 * Resolves input modalities from a bundled reference when available. The
 * Cursor-verified families (K3, grok-4, composer-2.5) are rule-owned via
 * `input-modalities` in `providers/cursor.kdl` and corrected at build time.
 * Without a reference, families whose native catalogs are multimodal
 * (anthropic, gemini, openai) fall back to id classification.
 */
export function resolveCursorInput(id: string, referenceInput?: ("text" | "image")[]): ("text" | "image")[] {
	if (referenceInput) {
		return referenceInput;
	}
	const identity = classifyModel("cursor", id, { lenient: true });
	if (identity.class === "anthropic" || identity.class === "gemini" || identity.class === "openai") {
		return ["text", "image"];
	}
	return ["text"];
}
