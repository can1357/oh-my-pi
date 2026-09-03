/**
 * Live Grok Bot model discovery via `aiserver.v1.AiService/AvailableModels`.
 *
 * Uses sand client headers + minted JWT (not Cursor CLI `GetUsableModels`).
 * Returns parameterized catalog rows; always unions sand router slugs that are
 * absent from the live list (`sand-default`, `sand-cua`, `sand-automation`).
 */
import { Effort, THINKING_EFFORTS } from "../effort";
import { GROKBOT_API, GROKBOT_BACKEND } from "../provider-models/grokbot";
import type { FetchImpl, ModelSpec, ThinkingConfig } from "../types";
import { discoveryFetch } from "../utils";
import {
	clearGrokbotTokenCache,
	createGrokbotChecksum,
	grokbotClientHeaders,
	loadGrokbotConfig,
	mergeGrokbotHeaders,
	mintGrokbotAccessToken,
} from "./grokbot-auth";
import {
	decodeGrokbotAvailableModelsResponse,
	encodeGrokbotAvailableModelsRequest,
	GROKBOT_AVAILABLE_MODELS_PATH,
	type GrokbotAvailableModel,
	type GrokbotAvailableModelVariant,
} from "./grokbot-available-models";

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** Sand router slugs — not in AvailableModels; always unioned into the catalog. */
export const GROKBOT_SAND_ROUTER_IDS = ["sand-default", "sand-cua", "sand-automation"] as const;

export interface GrokbotModelDiscoveryOptions {
	/** Renewal credential (registry passes `GROKBOT_RENEWAL_CREDENTIAL`). */
	apiKey?: string;
	baseUrl?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	/** Caller/model headers (e.g. reverse-proxy API key) for mint + AvailableModels. */
	headers?: Record<string, string>;
}

/**
 * Fetches Grok Bot models through AvailableModels (Connect JSON unary, sand client).
 *
 * Returns `null` on request/decode failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models
 * (routers are still unioned, so a successful empty live list still yields routers).
 */
export async function fetchGrokbotAvailableModels(
	options: GrokbotModelDiscoveryOptions = {},
): Promise<ModelSpec<"grokbot-sand">[] | null> {
	const timeoutMs = options.timeoutMs ?? 8_000;
	const resolvedBaseUrl = (options.baseUrl ?? GROKBOT_BACKEND).replace(/\/+$/, "");
	const requestUrl = `${resolvedBaseUrl}${GROKBOT_AVAILABLE_MODELS_PATH}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

	try {
		const cfg = await loadGrokbotConfig(options.apiKey);
		if (!cfg.renewal || !cfg.machineId) {
			return null;
		}
		const fetchImpl = discoveryFetch(options.fetch);
		const accessToken = await mintGrokbotAccessToken(cfg, fetchImpl, resolvedBaseUrl, signal, options.headers);
		const response = await fetchImpl(requestUrl, {
			method: "POST",
			headers: mergeGrokbotHeaders(options.headers, grokbotClientHeaders(cfg), {
				authorization: `Bearer ${accessToken}`,
				"x-cursor-checksum": createGrokbotChecksum(cfg.machineId),
				"x-ghost-mode": "true",
				"content-type": "application/json",
				accept: "application/json",
				"connect-protocol-version": "1",
			}),
			body: encodeGrokbotAvailableModelsRequest({
				useModelParameters: true,
				includeLongContextModels: true,
			}),
			signal,
		});
		if (!response.ok) {
			if (response.status === 401) clearGrokbotTokenCache();
			return null;
		}
		const decoded = decodeGrokbotAvailableModelsResponse(await response.json());
		// Invalid envelopes (missing/non-array `models`) must not become a
		// cached routers-only catalog — only a real `models: []` is empty-ok.
		if (decoded === null) return null;
		return normalizeGrokbotAvailableModels(decoded, resolvedBaseUrl);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Normalize AvailableModels rows + union sand routers. Exported for fixture tests. */
export function normalizeGrokbotAvailableModels(
	models: readonly GrokbotAvailableModel[],
	baseUrl = GROKBOT_BACKEND,
): ModelSpec<"grokbot-sand">[] {
	const byId = new Map<string, ModelSpec<"grokbot-sand">>();

	for (const row of models) {
		if (row.isHidden === true) continue;
		const id = row.name?.trim();
		if (!id) continue;
		for (const spec of toGrokbotModelSpecs(row, baseUrl, id)) {
			if (!byId.has(spec.id)) {
				byId.set(spec.id, spec);
			}
		}
	}

	for (const routerId of GROKBOT_SAND_ROUTER_IDS) {
		if (byId.has(routerId)) continue;
		byId.set(routerId, buildSandRouterSpec(routerId, baseUrl));
	}

	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function buildSandRouterSpec(id: (typeof GROKBOT_SAND_ROUTER_IDS)[number], baseUrl: string): ModelSpec<"grokbot-sand"> {
	return {
		id,
		name: `${id} (routed)`,
		api: GROKBOT_API,
		provider: "grokbot",
		baseUrl,
		reasoning: id === "sand-default",
		input: ["text"],
		cost: COST,
		// Limits come from reviewed KDL floors / offline seeds — do not invent here.
		contextWindow: null,
		maxTokens: null,
		// Tool support is reviewed via KDL (`supports-tools`); do not invent true here.
		sandParameterIds: [],
		sandMaxMode: false,
	};
}

/**
 * Derive whether stream requests must set `requestedModel.maxMode`.
 * Max-only rows (`supportsMaxMode` without `supportsNonMaxMode`) stay in max mode;
 * when both are supported, prefer the default-max variant when that is the only default.
 */
export function resolveGrokbotSandMaxMode(row: GrokbotAvailableModel): boolean {
	if (row.supportsMaxMode !== true) return false;
	// Proto3 omits false booleans — missing supportsNonMaxMode means max-only.
	if (row.supportsNonMaxMode !== true) return true;
	const hasDefaultMax = (row.variants ?? []).some(v => v.isDefaultMaxConfig === true);
	const hasDefaultNonMax = (row.variants ?? []).some(v => v.isDefaultNonMaxConfig === true);
	if (hasDefaultMax && !hasDefaultNonMax) return true;
	return false;
}

function resolveGrokbotContextWindow(row: GrokbotAvailableModel, sandMaxMode: boolean): number | null {
	if (sandMaxMode) {
		if (typeof row.contextTokenLimitForMaxMode === "number" && row.contextTokenLimitForMaxMode > 0) {
			return row.contextTokenLimitForMaxMode;
		}
		if (typeof row.contextTokenLimit === "number" && row.contextTokenLimit > 0) {
			return row.contextTokenLimit;
		}
		return null;
	}
	if (typeof row.contextTokenLimit === "number" && row.contextTokenLimit > 0) {
		return row.contextTokenLimit;
	}
	return null;
}

function toGrokbotModelSpecs(row: GrokbotAvailableModel, baseUrl: string, id: string): ModelSpec<"grokbot-sand">[] {
	const base = toGrokbotModelSpec(row, baseUrl, id);
	const out: ModelSpec<"grokbot-sand">[] = [base];
	for (const variant of row.variants ?? []) {
		const legacySlug = variant.legacySlug?.trim();
		const variantString = variant.variantStringRepresentation?.trim();
		const selector = legacySlug && legacySlug !== id ? legacySlug : variantString && variantString !== id ? variantString : undefined;
		if (!selector) continue;
		const variantParams = collectVariantParameterIds(variant);
		const parameterIds = variantParams.length > 0 ? variantParams : base.sandParameterIds;
		const sandMaxMode =
			variant.isDefaultMaxConfig === true
				? true
				: variant.isDefaultNonMaxConfig === true
					? false
					: base.sandMaxMode;
		out.push({
			...base,
			id: selector,
			name: variant.displayName?.trim() || selector,
			requestModelId: id,
			sandParameterIds: parameterIds,
			sandParameterDefaults: collectVariantSandParameterDefaults(variant) ?? base.sandParameterDefaults,
			sandMaxMode,
			sandVariantStringRepresentation: !legacySlug && Boolean(variantString),
			contextWindow: resolveGrokbotContextWindow(row, sandMaxMode === true),
			aliases: undefined,
		});
	}
	return out;
}

function collectVariantParameterIds(variant: GrokbotAvailableModelVariant): string[] {
	const ids: string[] = [];
	for (const p of variant.parameterValues ?? []) {
		if (p.id?.trim()) ids.push(p.id.trim());
	}
	return uniqueStrings(ids);
}

function collectVariantSandParameterDefaults(
	variant: GrokbotAvailableModelVariant,
): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const p of variant.parameterValues ?? []) {
		const id = p.id?.trim();
		const value = p.value?.trim();
		if (id && value) out[id] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function collectSandParameterDefaults(
	row: GrokbotAvailableModel,
	sandMaxMode: boolean,
): Record<string, string> | undefined {
	const variants = row.variants ?? [];
	const preferred = sandMaxMode
		? (variants.find(v => v.isDefaultMaxConfig === true) ??
			variants.find(v => v.isDefaultNonMaxConfig !== true && (v.parameterValues?.length ?? 0) > 0))
		: (variants.find(v => v.isDefaultNonMaxConfig === true) ??
			variants.find(v => v.isDefaultMaxConfig !== true && (v.parameterValues?.length ?? 0) > 0));
	return preferred ? collectVariantSandParameterDefaults(preferred) : undefined;
}

function toGrokbotModelSpec(row: GrokbotAvailableModel, baseUrl: string, id: string): ModelSpec<"grokbot-sand"> {
	const parameterIds = collectParameterIds(row);
	const { efforts, unrecognizedEffortOnly } = collectEffortValues(row, parameterIds);
	const reasoning = row.supportsThinking === true || efforts.length > 0 || unrecognizedEffortOnly;
	const thinking =
		efforts.length > 0
			? ({ mode: "effort", efforts } satisfies ThinkingConfig)
			: unrecognizedEffortOnly
				? ({ mode: "effort", efforts: [] } satisfies ThinkingConfig)
				: undefined;
	const variantLegacySlugs = (row.variants ?? [])
		.map(v => v.legacySlug?.trim())
		.filter((slug): slug is string => Boolean(slug));
	const aliases = uniqueStrings(
		[...(row.idAliases ?? []), ...(row.legacySlugs ?? []), ...variantLegacySlugs].filter(a => a.trim() !== id),
	);
	const sandMaxMode = resolveGrokbotSandMaxMode(row);
	const sandParameterDefaults = collectSandParameterDefaults(row, sandMaxMode);

	return {
		id,
		name: row.clientDisplayName?.trim() || id,
		api: GROKBOT_API,
		provider: "grokbot",
		baseUrl,
		reasoning,
		...(thinking ? { thinking } : undefined),
		input: row.supportsImages === true ? ["text", "image"] : ["text"],
		cost: COST,
		contextWindow: resolveGrokbotContextWindow(row, sandMaxMode === true),
		// Do not invent an output cap AvailableModels never supplied; reviewed
		// offline seed caps stay on static seeds / optional KDL limits-patch.
		maxTokens: null,
		// Native tool support is reviewed via KDL (`supports-tools`); leave unset
		// so grok-4.5 can be forced off without discovery advertising true.
		...(aliases.length > 0 ? { aliases } : undefined),
		sandParameterIds: parameterIds,
		...(sandParameterDefaults ? { sandParameterDefaults } : undefined),
		sandMaxMode,
	};
}

function collectParameterIds(row: GrokbotAvailableModel): string[] {
	const fromDefs = (row.parameterDefinitions ?? []).map(d => d.id?.trim()).filter((id): id is string => Boolean(id));
	if (fromDefs.length > 0) return uniqueStrings(fromDefs);
	const fromVariants: string[] = [];
	for (const variant of row.variants ?? []) {
		for (const p of variant.parameterValues ?? []) {
			if (p.id?.trim()) fromVariants.push(p.id.trim());
		}
	}
	return uniqueStrings(fromVariants);
}

function collectEffortValues(
	row: GrokbotAvailableModel,
	parameterIds: readonly string[],
): { efforts: Effort[]; unrecognizedEffortOnly: boolean } {
	const effortParam = parameterIds.includes("effort")
		? "effort"
		: parameterIds.includes("reasoning")
			? "reasoning"
			: undefined;
	if (!effortParam) return { efforts: [], unrecognizedEffortOnly: false };

	const values = new Set<string>();
	for (const def of row.parameterDefinitions ?? []) {
		if (def.id !== effortParam) continue;
		for (const v of def.values ?? []) {
			if (typeof v.value === "string" && v.value.trim()) values.add(v.value.trim().toLowerCase());
		}
	}
	for (const variant of row.variants ?? []) {
		for (const p of variant.parameterValues ?? []) {
			if (p.id === effortParam && p.value?.trim()) values.add(p.value.trim().toLowerCase());
		}
	}

	const ordered: Effort[] = [];
	for (const level of THINKING_EFFORTS) {
		if (values.has(level)) ordered.push(level);
	}
	// Common ladder only when the server advertised the param with no values at
	// all. Nonempty unrecognized values (e.g. only `adaptive`) must not invent
	// low/medium/high/xhigh the upstream never offered.
	if (
		ordered.length === 0 &&
		values.size === 0 &&
		(parameterIds.includes("effort") || parameterIds.includes("reasoning"))
	) {
		return {
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			unrecognizedEffortOnly: false,
		};
	}
	return { efforts: ordered, unrecognizedEffortOnly: ordered.length === 0 && values.size > 0 };
}

function uniqueStrings(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}
