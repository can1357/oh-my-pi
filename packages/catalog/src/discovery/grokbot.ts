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
} from "./grokbot-available-models";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
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
		const spec = toGrokbotModelSpec(row, baseUrl);
		if (!byId.has(spec.id)) {
			byId.set(spec.id, spec);
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
		input: ["text", "image"],
		cost: COST,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsTools: true,
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
	if (row.supportsNonMaxMode === false) return true;
	const hasDefaultMax = (row.variants ?? []).some(v => v.isDefaultMaxConfig === true);
	const hasDefaultNonMax = (row.variants ?? []).some(v => v.isDefaultNonMaxConfig === true);
	if (hasDefaultMax && !hasDefaultNonMax) return true;
	return false;
}

function resolveGrokbotContextWindow(row: GrokbotAvailableModel, sandMaxMode: boolean): number {
	if (sandMaxMode) {
		return positiveOr(row.contextTokenLimitForMaxMode, positiveOr(row.contextTokenLimit, DEFAULT_CONTEXT_WINDOW));
	}
	return positiveOr(row.contextTokenLimit, DEFAULT_CONTEXT_WINDOW);
}

function toGrokbotModelSpec(row: GrokbotAvailableModel, baseUrl: string): ModelSpec<"grokbot-sand"> {
	const parameterIds = collectParameterIds(row);
	const efforts = collectEffortValues(row, parameterIds);
	const reasoning = row.supportsThinking === true || efforts.length > 0;
	const thinking = efforts.length > 0 ? ({ mode: "effort", efforts } satisfies ThinkingConfig) : undefined;
	const aliases = uniqueStrings([...(row.idAliases ?? []), ...(row.legacySlugs ?? [])].filter(a => a !== row.name));
	const sandMaxMode = resolveGrokbotSandMaxMode(row);

	return {
		id: row.name,
		name: row.clientDisplayName?.trim() || row.name,
		api: GROKBOT_API,
		provider: "grokbot",
		baseUrl,
		reasoning,
		...(thinking ? { thinking } : undefined),
		input: row.supportsImages === false ? ["text"] : ["text", "image"],
		cost: COST,
		contextWindow: resolveGrokbotContextWindow(row, sandMaxMode),
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsTools: true,
		...(aliases.length > 0 ? { aliases } : undefined),
		sandParameterIds: parameterIds,
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

function collectEffortValues(row: GrokbotAvailableModel, parameterIds: readonly string[]): Effort[] {
	const effortParam = parameterIds.includes("effort")
		? "effort"
		: parameterIds.includes("reasoning")
			? "reasoning"
			: undefined;
	if (!effortParam) return [];

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
	// Live grok lists low|medium|high|xhigh; if variants were empty but param exists, expose the common ladder.
	if (ordered.length === 0 && (parameterIds.includes("effort") || parameterIds.includes("reasoning"))) {
		return [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];
	}
	return ordered;
}

function positiveOr(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
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
