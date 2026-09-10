import * as http2 from "node:http2";
import { type } from "@oh-my-pi/omptype";
import { pricingPeerFor } from "../compat/behavior";
import { collapseVariants, type EffortVariantFamily } from "../compat/collapse";
import { compareRevision, parseRevision } from "../compat/revision";
import { classifyModel } from "../compat/taxonomy";
import { Effort, THINKING_EFFORTS } from "../effort";
import { buildModelReferenceIndex, resolveModelReference, type ModelReferenceIndex } from "../identity/reference";
import { getBundledModels, type GeneratedProvider } from "../models";
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
const CURSOR_PRICING_URL = "https://cursor.com/docs/models-and-pricing.md";
const CURSOR_PRICING_MAX_LENGTH = 256 * 1024;
const CURSOR_PRICING_TIMEOUT_MS = 2_000;

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
	/** Optional first-party pricing document URL override. */
	pricingUrl?: string;
}

/**
 * Joins Cursor's account-scoped model RPCs:
 * - `AvailableModels` supplies rich base models, parameter axes, variants,
 *   capabilities, aliases, and cost-multiplier metadata.
 * - `GetUsableModels` supplies the exact legacy wire slugs the account can run.
 * - `GetDefaultModelForCli` identifies the account's current default.
 * - Cursor's first-party pricing document supplies current per-token rates.
 *
 * Returns `null` only when every RPC fails. A successful empty catalog returns
 * `[]`, preserving model-manager retry and fallback semantics.
 */
export async function fetchCursorUsableModels(
	options: CursorModelDiscoveryOptions,
): Promise<ModelSpec<"cursor-agent">[] | null> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const baseUrl = (options.baseUrl ?? CURSOR_DEFAULT_BASE_URL).replace(/\/+$/, "");
	const pricingUrl = options.pricingUrl ?? (baseUrl === CURSOR_DEFAULT_BASE_URL ? CURSOR_PRICING_URL : undefined);
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

	const [usablePayload, availablePayload, defaultPayload, pricing] = await Promise.all([
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
		pricingUrl === undefined
			? Promise.resolve<CursorPricingCatalog | undefined>(undefined)
			: fetchCursorPricingCatalog(pricingUrl, Math.min(timeoutMs, CURSOR_PRICING_TIMEOUT_MS)),
	]);
	if (usablePayload === null && availablePayload === null && defaultPayload === null) return null;

	const usable = decodeUnary(GetUsableModelsResponseSchema, usablePayload);
	const available = decodeUnary(AvailableModelsResponseSchema, availablePayload);
	const defaultModel = decodeUnary(GetDefaultModelForCliResponseSchema, defaultPayload)?.model;
	const parsedUsable = CursorDecodedResponseSchema(usable);
	const references = createCursorReferenceMap();
	const legacyModels =
		parsedUsable instanceof type.errors
			? []
			: normalizeCursorModels(parsedUsable.models, options.baseUrl, references, pricing);
	const usableModelIds = usable === null ? undefined : new Set(legacyModels.map(model => model.id));
	if (!available || available.models.length === 0) return legacyModels;
	const richModels = normalizeRichCursorModels(
		available.models,
		usableModelIds,
		options.baseUrl,
		references,
		pricing,
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

async function fetchCursorUnary(
	baseUrl: string,
	path: string,
	body: Uint8Array,
	options: CursorModelDiscoveryOptions,
	timeoutMs: number,
): Promise<Uint8Array | null> {
	try {
		const response = await fetch(new URL(path, baseUrl), {
			method: "POST",
			headers: {
				...cursorClientHeaders(options.apiKey, { clientVersion: options.clientVersion }),
				"connect-protocol-version": "1",
				"x-request-id": crypto.randomUUID(),
			},
			body,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (response.ok) return new Uint8Array(await response.arrayBuffer());
	} catch {
		// Older/custom Cursor endpoints may accept only an HTTP/2 Connect request.
	}
	return fetchViaHttp2(baseUrl, path, body, options, timeoutMs);
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

type CursorPricingCatalog = ReadonlyMap<string, TokenCost>;

interface CursorPricingFlags {
	fast?: boolean;
	longContext?: boolean;
}
interface CursorPricingColumns {
	model: number;
	input: number;
	cacheWrite: number;
	cacheRead: number;
	output: number;
}

const CURSOR_NON_PRICING_VARIANT_TOKENS = new Set([
	"high",
	"low",
	"max",
	"medium",
	"minimal",
	"standard",
	"thinking",
	"xhigh",
]);

let cursorPricingReferenceIndex: ModelReferenceIndex | null | undefined;

async function fetchCursorPricingCatalog(url: string, timeoutMs: number): Promise<CursorPricingCatalog | undefined> {
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return undefined;
		const declaredLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(declaredLength) && declaredLength > CURSOR_PRICING_MAX_LENGTH) return undefined;
		const markdown = await response.text();
		if (markdown.length > CURSOR_PRICING_MAX_LENGTH) return undefined;
		return parseCursorPricingCatalog(markdown);
	} catch {
		return undefined;
	}
}

function parseCursorPricingCatalog(markdown: string): CursorPricingCatalog | undefined {
	const costs = new Map<string, TokenCost>();
	const ambiguousKeys = new Set<string>();
	const lines = markdown.split("\n");
	let lineIndex = 0;
	while (lineIndex < lines.length - 1) {
		const header = parseMarkdownTableRow(lines[lineIndex]);
		const separator = parseMarkdownTableRow(lines[lineIndex + 1]);
		const columns = header ? cursorPricingColumns(header) : undefined;
		if (!columns || !separator || !isMarkdownTableDivider(separator, header?.length ?? 0)) {
			lineIndex++;
			continue;
		}

		lineIndex += 2;
		while (lineIndex < lines.length) {
			const cells = parseMarkdownTableRow(lines[lineIndex]);
			if (!cells || isMarkdownTableDivider(cells, cells.length) || cursorPricingColumns(cells)) break;
			lineIndex++;

			const input = parseCursorPrice(cells[columns.input]);
			const cacheWrite = parseCursorPrice(cells[columns.cacheWrite]);
			const cacheRead = parseCursorPrice(cells[columns.cacheRead]);
			const output = parseCursorPrice(cells[columns.output]);
			if (input === undefined || cacheWrite === undefined || cacheRead === undefined || output === undefined)
				continue;
			const key = cursorPricingLookupKey(cells[columns.model] ?? "");
			if (!key || ambiguousKeys.has(key)) continue;
			const cost = { input, output, cacheRead, cacheWrite };
			const existing = costs.get(key);
			if (existing && !equalTokenCost(existing, cost)) {
				costs.delete(key);
				ambiguousKeys.add(key);
			} else {
				costs.set(key, cost);
			}
		}
	}
	return costs.size > 0 ? costs : undefined;
}

function parseMarkdownTableRow(line: string | undefined): string[] | undefined {
	const trimmed = line?.trim();
	if (!trimmed?.startsWith("|") || !trimmed.endsWith("|")) return undefined;
	return trimmed
		.slice(1, -1)
		.split("|")
		.map(cell => cell.trim());
}

function cursorPricingColumns(header: readonly string[]): CursorPricingColumns | undefined {
	const normalized = header.map(cell =>
		cell
			.replace(/\*\*/g, "")
			.toLowerCase()
			.replace(/[^a-z]+/g, " ")
			.trim(),
	);
	const columns = {
		model: normalized.indexOf("model"),
		input: normalized.indexOf("input"),
		cacheWrite: normalized.indexOf("cache write"),
		cacheRead: normalized.indexOf("cache read"),
		output: normalized.indexOf("output"),
	};
	return Object.values(columns).every(index => index >= 0) ? columns : undefined;
}

function isMarkdownTableDivider(cells: readonly string[], expectedLength: number): boolean {
	return cells.length === expectedLength && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function parseCursorPrice(value: string | undefined): number | undefined {
	const normalized = value?.trim();
	if (!normalized) return undefined;
	if (normalized === "-" || normalized === "—") return 0;
	const match = /^\$?(\d+(?:\.\d+)?)$/.exec(normalized.replace(/,/g, ""));
	if (!match?.[1]) return undefined;
	const price = Number(match[1]);
	return Number.isFinite(price) ? price : undefined;
}

function cursorPricingLookupKey(label: string, flags: CursorPricingFlags = {}): string | undefined {
	const link = /^\[([^\]]+)\]\([^)]+\)$/.exec(label.trim());
	const normalized = (link?.[1] ?? label)
		.replace(/\u200b/g, "")
		.replace(/\(\s*fast(?:\s+mode)?\s*\)/gi, " fast ")
		.replace(/\*\*/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	if (!normalized) return undefined;
	const rawTokens = normalized.split(/\s+/);
	const fast = flags.fast ?? rawTokens.includes("fast");
	const longContext = flags.longContext ?? rawTokens.includes("1m");
	const tokens = rawTokens.filter(
		(token, index) =>
			!(index === 0 && token === "cursor") &&
			token !== "fast" &&
			token !== "1m" &&
			!(longContext && token === "context") &&
			!CURSOR_NON_PRICING_VARIANT_TOKENS.has(token),
	);
	if (tokens.length === 0) return undefined;
	return `${tokens.sort().join("-")}\u0000fast=${fast}\u0000long=${longContext}`;
}

function equalTokenCost(left: TokenCost, right: TokenCost): boolean {
	return (
		left.input === right.input &&
		left.output === right.output &&
		left.cacheRead === right.cacheRead &&
		left.cacheWrite === right.cacheWrite
	);
}

function copyTokenCost(cost: TokenCost): TokenCost {
	return {
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead,
		cacheWrite: cost.cacheWrite,
	};
}

function hasBillableCursorCost(cost: TokenCost): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

function getCursorPricingReferenceIndex(): ModelReferenceIndex | undefined {
	if (cursorPricingReferenceIndex !== undefined) return cursorPricingReferenceIndex ?? undefined;
	const peer = pricingPeerFor("cursor", "");
	if (!peer) {
		cursorPricingReferenceIndex = null;
		return undefined;
	}
	cursorPricingReferenceIndex = buildModelReferenceIndex(
		peer.peers.flatMap(provider => getBundledModels(provider as GeneratedProvider)),
	);
	return cursorPricingReferenceIndex;
}

function resolveCursorPeerCost(candidates: readonly string[]): TokenCost | undefined {
	const index = getCursorPricingReferenceIndex();
	if (!index) return undefined;
	for (const candidate of candidates) {
		const reference = resolveModelReference(candidate, index);
		if (reference && hasBillableCursorCost(reference.cost)) return copyTokenCost(reference.cost);
	}
	return undefined;
}

function resolveCursorDocumentCost(
	pricing: CursorPricingCatalog | undefined,
	candidates: readonly string[],
	flags: CursorPricingFlags = {},
): TokenCost | undefined {
	if (!pricing) return undefined;
	for (const candidate of candidates) {
		const key = cursorPricingLookupKey(candidate, flags);
		const cost = key ? pricing.get(key) : undefined;
		if (cost) return copyTokenCost(cost);
	}
	return undefined;
}

function decodeUnary<TMessage extends ProtoMessage>(
	schema: MessageCodec<TMessage>,
	payload: Uint8Array | null,
): TMessage | null {
	if (!payload || payload.length === 0) return null;
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

function cursorRichPricingCandidates(details: AvailableModelsResponse_ModelDetails): string[] {
	return [
		details.name,
		details.clientDisplayName,
		details.serverModelName,
		details.inputboxShortModelName,
		...details.legacySlugs,
		...details.idAliases,
	].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
}

function cursorPricingFlags(parameters: readonly { id: string; value: string }[]): CursorPricingFlags {
	const fastValue = parameters.find(parameter => parameter.id === "fast")?.value.toLowerCase();
	const contextValue = parameters.find(parameter => parameter.id === "context")?.value;
	const contextWindow = parseCursorContextWindow(contextValue);
	return {
		...(fastValue === undefined ? undefined : { fast: fastValue === "true" }),
		...(contextWindow === undefined ? undefined : { longContext: contextWindow >= CURSOR_1M_CONTEXT_WINDOW }),
	};
}

function cursorVariantCostMultiplier(
	details: AvailableModelsResponse_ModelDetails,
	entry: NormalizedRichVariant,
): number {
	let multiplier = 1;
	for (const parameter of entry.parameters) {
		const definition = details.parameterDefinitions.find(candidate => candidate.id === parameter.id);
		if (!definition) continue;
		const booleanValue = definition.parameterType?.booleanParameter?.values.find(
			candidate => candidate.value === parameter.value,
		);
		const enumValue = definition.parameterType?.enumParameter?.values.find(
			candidate => candidate.value === parameter.value,
		);
		const selectedValue = booleanValue ?? enumValue;
		if (selectedValue?.increasesModelCost !== true) continue;
		for (const description of [enumValue?.markdownTooltip, definition.markdownTooltip]) {
			const match = description ? /\b(\d+(?:\.\d+)?)\s*[x×]\b/i.exec(description) : undefined;
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

function resolveRichCursorCost(
	pricing: CursorPricingCatalog | undefined,
	details: AvailableModelsResponse_ModelDetails,
	entry: NormalizedRichVariant,
): TokenCost | undefined {
	const candidates = cursorRichPricingCandidates(details);
	const flags = cursorPricingFlags(entry.parameters);
	const exact = resolveCursorDocumentCost(pricing, candidates, flags);
	if (exact) return exact;
	if (flags.fast === true && flags.longContext === true) {
		const fast = resolveCursorDocumentCost(pricing, candidates, { fast: true, longContext: false });
		if (fast) return fast;
	}
	const base =
		resolveCursorDocumentCost(pricing, candidates, { fast: false, longContext: flags.longContext }) ??
		resolveCursorDocumentCost(pricing, candidates, { fast: false, longContext: false }) ??
		resolveCursorPeerCost(candidates);
	if (!base) return undefined;
	const multiplier = cursorVariantCostMultiplier(details, entry);
	if (multiplier === 1) return base;
	return {
		input: base.input * multiplier,
		output: base.output * multiplier,
		cacheRead: base.cacheRead * multiplier,
		cacheWrite: base.cacheWrite * multiplier,
	};
}

function resolveLegacyCursorCost(
	pricing: CursorPricingCatalog | undefined,
	details: CursorModelDetailsValue,
	id: string,
): TokenCost | undefined {
	const candidates = [
		id,
		details.displayName,
		details.displayNameShort,
		details.displayModelId,
		...details.aliases,
	].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
	return resolveCursorDocumentCost(pricing, candidates) ?? resolveCursorPeerCost(candidates);
}

function normalizeRichCursorModels(
	models: readonly AvailableModelsResponse_ModelDetails[],
	usableModelIds: ReadonlySet<string> | undefined,
	baseUrlOverride: string | undefined,
	references: Map<string, ModelSpec<"cursor-agent">>,
	pricing: CursorPricingCatalog | undefined,
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
		const parameterDefaults = new Map<string, string>();
		for (const entry of variants) {
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
			const laneId = cursorLaneId(
				baseId,
				dimensions,
				parameterDefaults,
				first.variant?.isMaxMode === true,
				claimedLaneIds,
			);
			const laneName = cursorLaneName(details, laneId, baseId);
			normalized.push(
				...buildRichCursorLane(
					details,
					entries,
					laneId,
					laneName,
					baseUrlOverride,
					references,
					pricing,
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
		if (!id || !value || parameter.value === defaults.get(parameter.id) || parameter.value === "false") continue;
		if (parameter.value === "true") {
			suffixes.push(id);
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
	pricing: CursorPricingCatalog | undefined,
	defaultModelId: string | undefined,
	defaultMaxMode: boolean | undefined,
): ModelSpec<"cursor-agent">[] {
	const selectedByEffort = new Map<CursorRouteEffort | "fixed", NormalizedRichVariant>();
	for (const entry of entries) {
		const slot = entry.effort ?? "fixed";
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
				: entry.effort !== undefined
					? true
					: (details.supportsThinking ?? reference?.reasoning ?? false);
		const cost = resolveRichCursorCost(pricing, details, entry) ?? {
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
				variant?.tooltipData?.markdownContent ??
				variant?.tagline ??
				details.tooltipData?.markdownContent ??
				details.tagline ??
				reference?.description,
		});
		if (entry.effort !== undefined) routing[entry.effort] = routeKey;
		if (isProviderDefault) defaultMember = routeKey;
	}
	if (members.length === 0) return [];

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
						...(defaultMember === undefined
							? undefined
							: {
									defaultLevel: efforts.find(effort => routing[effort] === defaultMember),
								}),
					},
				}),
	};
	return collapseVariants(members, { table: { families: [family] } });
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
	pricing: CursorPricingCatalog | undefined,
): ModelSpec<"cursor-agent">[] {
	if (!models || models.length === 0) {
		return [];
	}

	const byId = new Map<string, ModelSpec<"cursor-agent">>();
	for (const model of models) {
		const normalized = normalizeCursorModel(model, baseUrlOverride, references, pricing);
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
	pricing: CursorPricingCatalog | undefined,
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
	const cost = resolveLegacyCursorCost(pricing, details, id) ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};

	if (reference) {
		return {
			...reference,
			id,
			name,
			baseUrl: baseUrlOverride ?? reference.baseUrl,
			reasoning,
			input: resolveCursorInput(id, reference.input),
			cost,
			contextWindow: resolveCursorContextWindow(details, id, reference.contextWindow),
			cursorMaxMode: details.maxMode,
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
		cost,
		contextWindow: resolveCursorContextWindow(details, id, DEFAULT_CONTEXT_WINDOW),
		maxTokens: DEFAULT_MAX_TOKENS,
		cursorMaxMode: details.maxMode,
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
