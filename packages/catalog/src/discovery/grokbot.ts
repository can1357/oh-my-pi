/**
 * Live Grok Bot model discovery via `aiserver.v1.AiService/AvailableModels`.
 * Uses sand client headers + minted JWT (not Cursor CLI `GetUsableModels`).
 * Returns parameterized catalog rows and unions the KDL-owned routed models
 * whose capabilities are absent from or under-described by the live catalog.
 */
import { Effort, THINKING_EFFORTS } from "../effort";
import { seedModels } from "../compat/providers";
import {
	GROKBOT_API,
	GROKBOT_BACKEND,
	GROKBOT_TOOL_CAPABLE_MODEL_IDS,
	resolveGrokbotBackend,
} from "../provider-models/grokbot";
import type { FetchImpl, ModelSpec, ThinkingConfig } from "../types";
import { discoveryFetch } from "../utils";
import {
	createGrokbotChecksum,
	grokbotClientHeaders,
	loadGrokbotConfig,
	mergeGrokbotProviderHeaders,
	mintGrokbotAccessToken,
} from "./grokbot-auth";
import { cancelGrokbotCatalogResponse, readBoundedGrokbotCatalogJson } from "./grokbot-body";
import {
	decodeGrokbotAvailableModelsResponse,
	encodeGrokbotAvailableModelsRequest,
	GROKBOT_AVAILABLE_MODELS_PATH,
	type GrokbotAvailableModel,
} from "./grokbot-available-models";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

const GROKBOT_SEED_MODELS = seedModels<"grokbot-sand">("grokbot");
const GROKBOT_TOOL_CAPABLE_MODEL_IDENTITIES = new Set(GROKBOT_TOOL_CAPABLE_MODEL_IDS.map(id => id.toLowerCase()));

/**
 * KDL seed rows with an explicit empty requested-model parameter list are fixed
 * routed selections whose complete capabilities must override live omissions.
 */
const GROKBOT_SAND_ROUTER_SEEDS = new Map<string, ModelSpec<"grokbot-sand">>(
	GROKBOT_SEED_MODELS.filter(model => model.sandParameterIds?.length === 0).map(model => [model.id, model]),
);
export const GROKBOT_SAND_ROUTER_IDS: readonly string[] = [...GROKBOT_SAND_ROUTER_SEEDS.keys()];

export interface GrokbotModelDiscoveryOptions {
	/** Renewal credential from the `/login grokbot` OAuth row (structured apiKey). */
	apiKey?: string;
	/** Every credential the gateway may select; all must support every exposed model. */
	apiKeys?: readonly string[];
	baseUrl?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	/** Caller/model headers (e.g. reverse-proxy API key) for mint + AvailableModels. */
	headers?: Record<string, string>;
}

type GrokbotDiscoveryCredential = {
	renewal: string;
	machineId: string;
};

/**
 * Fetches every credential-scoped AvailableModels roster and exposes only their
 * common safe surface. A partial roster is unsafe because gateway rotation can
 * select any stored account for a subsequent stream.
 */
export async function fetchGrokbotAvailableModels(
	options: GrokbotModelDiscoveryOptions = {},
): Promise<ModelSpec<"grokbot-sand">[] | null> {
	const credentials = collectGrokbotDiscoveryCredentials(options);
	if (credentials.length === 0) return null;

	const timeoutMs = options.timeoutMs ?? 8_000;
	const resolvedBaseUrl = resolveGrokbotBackend(options.baseUrl);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
	try {
		const fetchImpl = discoveryFetch(options.fetch);
		const rosterTasks = credentials.map(async credential => {
			try {
				const roster = await fetchGrokbotAvailableModelsForCredential(
					credential,
					fetchImpl,
					resolvedBaseUrl,
					signal,
					options.headers,
				);
				if (roster === null) throw new Error("Grok Bot account roster unavailable");
				return roster;
			} catch (error) {
				controller.abort();
				throw error;
			}
		});
		try {
			const rosters = await Promise.all(rosterTasks);
			return intersectGrokbotAvailableModelRosters(rosters);
		} catch {
			controller.abort();
			await Promise.allSettled(rosterTasks);
			return null;
		}
	} finally {
		controller.abort();
		clearTimeout(timer);
	}
}

function collectGrokbotDiscoveryCredentials(options: GrokbotModelDiscoveryOptions): GrokbotDiscoveryCredential[] {
	const credentials = new Map<string, GrokbotDiscoveryCredential>();
	for (const apiKey of [options.apiKey, ...(options.apiKeys ?? [])]) {
		const credential = parseGrokbotDiscoveryCredential(apiKey);
		if (!credential) continue;
		const identity = JSON.stringify(credential);
		credentials.set(identity, credential);
	}
	return [...credentials.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, credential]) => credential);
}

function parseGrokbotDiscoveryCredential(apiKey: string | undefined): GrokbotDiscoveryCredential | null {
	if (!apiKey?.trim()) return null;
	try {
		const structured = JSON.parse(apiKey) as { renewal?: unknown; machineId?: unknown };
		const renewal = typeof structured.renewal === "string" ? structured.renewal.trim() : "";
		const machineId = typeof structured.machineId === "string" ? structured.machineId.trim() : "";
		return renewal && machineId ? { renewal, machineId } : null;
	} catch {
		return null;
	}
}

async function fetchGrokbotAvailableModelsForCredential(
	credential: GrokbotDiscoveryCredential,
	fetchImpl: FetchImpl,
	baseUrl: string,
	signal: AbortSignal,
	headers: Record<string, string> | undefined,
): Promise<ModelSpec<"grokbot-sand">[] | null> {
	const cfg = { ...loadGrokbotConfig(credential.renewal), machineId: credential.machineId };
	const accessToken = await mintGrokbotAccessToken(cfg, fetchImpl, baseUrl, signal, headers, "session");
	const response = await fetchImpl(`${baseUrl}${GROKBOT_AVAILABLE_MODELS_PATH}`, {
		method: "POST",
		headers: mergeGrokbotProviderHeaders([headers], {
			...grokbotClientHeaders(cfg),
			authorization: `Bearer ${accessToken}`,
			"x-cursor-checksum": createGrokbotChecksum(cfg.machineId),
			"x-ghost-mode": "true",
			"content-type": "application/json",
			accept: "application/json",
		}),
		body: encodeGrokbotAvailableModelsRequest(),
		signal,
	});
	if (!response.ok) {
		await cancelGrokbotCatalogResponse(response);
		return null;
	}
	const decoded = decodeGrokbotAvailableModelsResponse(await readBoundedGrokbotCatalogJson(response, signal));
	// Invalid envelopes (missing/non-array `models`) must not become a cached
	// routers-only catalog — only a real `models: []` is empty-ok.
	return decoded === null ? null : normalizeGrokbotAvailableModels(decoded, baseUrl);
}

function intersectGrokbotAvailableModelRosters(
	rosters: readonly (readonly ModelSpec<"grokbot-sand">[])[],
): ModelSpec<"grokbot-sand">[] {
	const byId = rosters.map(roster => new Map(roster.map(model => [model.id, model])));
	const shared = byId[0];
	if (!shared) return [];
	const models: ModelSpec<"grokbot-sand">[] = [];
	for (const id of shared.keys()) {
		const sameId: ModelSpec<"grokbot-sand">[] = [];
		for (const modelsById of byId) {
			const model = modelsById.get(id);
			if (!model) break;
			sameId.push(model);
		}
		if (sameId.length !== byId.length) continue;
		models.push(mergeGrokbotAvailableModelSpecs(sameId));
	}
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

function mergeGrokbotAvailableModelSpecs(models: readonly ModelSpec<"grokbot-sand">[]): ModelSpec<"grokbot-sand"> {
	const first = models[0]!;
	const aliases = intersectGrokbotModelStrings(models.map(model => model.aliases ?? []));
	const input = intersectGrokbotModelStrings(models.map(model => model.input));
	const sandParameterIds = intersectGrokbotModelStrings(models.map(model => model.sandParameterIds ?? []));
	const hasCommonEffortControl = models.every(model => model.thinking?.mode === "effort");
	const candidateEfforts = hasCommonEffortControl
		? intersectGrokbotModelStrings(
				models.map(model => (model.thinking?.mode === "effort" ? model.thinking.efforts : [])),
			).filter((effort): effort is Effort => THINKING_EFFORTS.includes(effort as Effort))
		: [];
	const sandEffortValues = intersectGrokbotEffortValues(models, candidateEfforts);
	const efforts = candidateEfforts.filter(effort => sandEffortValues[effort] !== undefined);
	const { aliases: _aliases, sandEffortValues: _sandEffortValues, thinking: _thinking, ...base } = first;

	return {
		...base,
		reasoning: models.every(model => model.reasoning === true),
		input: input.filter((modality): modality is "text" | "image" => modality === "text" || modality === "image"),
		supportsTools: models.every(model => model.supportsTools === true),
		contextWindow: minimumFiniteGrokbotLimit(models.map(model => model.contextWindow)),
		maxTokens: minimumFiniteGrokbotLimit(models.map(model => model.maxTokens)),
		sandParameterIds,
		sandMaxMode: models.every(model => model.sandMaxMode === true),
		...(aliases.length > 0 ? { aliases } : undefined),
		...(efforts.length > 0 ? { thinking: { mode: "effort", efforts } satisfies ThinkingConfig } : undefined),
		...(Object.keys(sandEffortValues).length > 0 ? { sandEffortValues } : undefined),
	};
}

function intersectGrokbotEffortValues(
	models: readonly ModelSpec<"grokbot-sand">[],
	efforts: readonly Effort[],
): Partial<Record<Effort, string>> {
	const values: Partial<Record<Effort, string>> = {};
	for (const effort of efforts) {
		const value = models[0]?.sandEffortValues?.[effort];
		if (value !== undefined && models.every(model => model.sandEffortValues?.[effort] === value)) {
			values[effort] = value;
		}
	}
	return values;
}

function intersectGrokbotModelStrings(values: readonly (readonly string[])[]): string[] {
	const [first = [], ...rest] = values;
	const sharedByEveryRoster = rest.map(value => new Set(value));
	return uniqueStrings(first).filter(value => sharedByEveryRoster.every(set => set.has(value)));
}

function minimumFiniteGrokbotLimit(values: readonly (number | null)[]): number | null {
	let minimum: number | undefined;
	for (const value of values) {
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		minimum = minimum === undefined ? value : Math.min(minimum, value);
	}
	return minimum ?? null;
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

	for (const [routerId, routerSeed] of GROKBOT_SAND_ROUTER_SEEDS) {
		// Routed metadata belongs to the KDL seed. Preserve the verified
		// first-party contract if AvailableModels omits or under-describes it.
		byId.set(routerId, { ...routerSeed, baseUrl });
	}

	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
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

function supportsGrokbotTools(row: GrokbotAvailableModel): boolean {
	return [row.name, row.serverModelName, ...(row.idAliases ?? []), ...(row.legacySlugs ?? [])].some(
		identity =>
			typeof identity === "string" && GROKBOT_TOOL_CAPABLE_MODEL_IDENTITIES.has(identity.trim().toLowerCase()),
	);
}

function toGrokbotModelSpec(row: GrokbotAvailableModel, baseUrl: string): ModelSpec<"grokbot-sand"> {
	const parameterIds = collectParameterIds(row);
	const effortMetadata = collectEffortMetadata(row, parameterIds);
	const reasoning = row.supportsThinking === true || effortMetadata.efforts.length > 0;
	const thinking =
		effortMetadata.efforts.length > 0
			? ({ mode: "effort", efforts: effortMetadata.efforts } satisfies ThinkingConfig)
			: undefined;
	const aliases = uniqueStrings([...(row.idAliases ?? []), ...(row.legacySlugs ?? [])].filter(a => a !== row.name));
	const sandMaxMode = resolveGrokbotSandMaxMode(row);

	return {
		id: row.name,
		name: row.clientDisplayName?.trim() || row.name,
		api: GROKBOT_API,
		provider: "grokbot",
		baseUrl,
		reasoning,
		...(thinking ? { thinking, sandEffortValues: effortMetadata.values } : undefined),
		input: row.supportsImages === false ? ["text"] : ["text", "image"],
		cost: COST,
		contextWindow: resolveGrokbotContextWindow(row, sandMaxMode),
		maxTokens: DEFAULT_MAX_TOKENS,
		supportsTools: supportsGrokbotTools(row),
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

function collectEffortMetadata(
	row: GrokbotAvailableModel,
	parameterIds: readonly string[],
): { efforts: Effort[]; values: Partial<Record<Effort, string>> } {
	const effortParam = ["effort", "reasoning", "reasoning_effort"].find(id => parameterIds.includes(id));
	if (!effortParam) return { efforts: [], values: {} };

	const rawValues = new Set<string>();
	for (const def of row.parameterDefinitions ?? []) {
		if (def.id !== effortParam) continue;
		for (const value of [...(def.values ?? []), ...(def.parameterType?.enumParameter?.values ?? [])]) {
			if (typeof value.value === "string" && value.value.trim()) rawValues.add(value.value.trim().toLowerCase());
		}
	}
	for (const variant of row.variants ?? []) {
		for (const parameter of variant.parameterValues ?? []) {
			if (parameter.id === effortParam && parameter.value?.trim()) {
				rawValues.add(parameter.value.trim().toLowerCase());
			}
		}
	}

	const values: Partial<Record<Effort, string>> = {};
	for (const rawValue of rawValues) {
		const effort = normalizeGrokbotEffortValue(rawValue);
		if (effort !== undefined && values[effort] === undefined) values[effort] = rawValue;
	}
	return {
		efforts: THINKING_EFFORTS.filter(effort => values[effort] !== undefined),
		values,
	};
}

function normalizeGrokbotEffortValue(value: string): Effort | undefined {
	if (value === "extra-high" || value === "extra_high") return Effort.XHigh;
	return THINKING_EFFORTS.includes(value as Effort) ? (value as Effort) : undefined;
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
