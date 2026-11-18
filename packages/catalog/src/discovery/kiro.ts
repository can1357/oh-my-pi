/**
 * Kiro management client (AWS JSON 1.0) and `ListAvailableModels` →
 * `ModelSpec<"kiro-api">` mapping. Server fields are read leniently: a model
 * missing its id or token limits is skipped, an unrecognised request schema
 * leaves the model without thinking controls.
 */
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { readBoundedJson } from "@oh-my-pi/pi-utils/bounded-json";
import { Effort } from "../effort";
import type { FetchImpl, ModelSpec, ThinkingConfig } from "../types";
import { discoveryFetch } from "../utils";
import {
	KIRO_BOOTSTRAP_REGIONS,
	type KiroCredential,
	kiroManagementBaseUrl,
	kiroProfileRegion,
	kiroRequestBaseUrl,
	kiroRuntimeBaseUrl,
} from "../wire/kiro";
import { kiroCliServiceHeaders } from "../wire/kiro-cli";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const ANTHROPIC_EFFORTS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] as const;
/** GPT wire efforts in order; wire `none` is omp's `minimal`. */
const GPT_EFFORTS: ReadonlyArray<readonly [string, Effort]> = [
	["none", Effort.Minimal],
	["low", Effort.Low],
	["medium", Effort.Medium],
	["high", Effort.High],
	["xhigh", Effort.XHigh],
	["max", Effort.Max],
];

type KiroManagementTarget = "ListAvailableProfiles" | "ListAvailableModels" | "GetUsageLimits";

interface ManagementOptions {
	region: string;
	token: string;
	fetch?: FetchImpl;
	signal?: AbortSignal;
	/** Identity Center tokens are accepted by Amazon Q, not `management.*.kiro.dev`. */
	service?: "q";
}

/** A non-2xx Kiro management response; `status` tells auth loss from transient failure. */
export class KiroManagementHttpError extends Error {
	constructor(
		target: KiroManagementTarget,
		readonly status: number,
	) {
		super(`${target}: HTTP ${status}`);
		this.name = "KiroManagementHttpError";
	}
}

/** One AWS JSON 1.0 POST to the region's management host; returns the bounded JSON body. */
export async function kiroManagementRequest(
	options: ManagementOptions & { target: KiroManagementTarget; body: unknown },
): Promise<unknown> {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const response = await discoveryFetch(options.fetch)(kiroManagementBaseUrl(options.region, options.service), {
		method: "POST",
		headers: kiroCliServiceHeaders(options.target, options.token, { attempt: 1, maxAttempts: 1 }),
		body: JSON.stringify(options.body),
		signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
	});
	if (!response.ok) throw new KiroManagementHttpError(options.target, response.status);
	return readBoundedJson(response, MAX_RESPONSE_BYTES);
}

/** Pages of a `nextToken`-paged listing; a missing or repeated token ends it. `first` reuses a fetched page. */
async function* listPages(
	options: ManagementOptions & { target: KiroManagementTarget; body: Record<string, unknown>; first?: unknown },
): AsyncGenerator<Record<string, unknown>> {
	const seen = new Set<string>();
	let page = options.first;
	let nextToken: string | undefined;
	while (true) {
		page ??= await kiroManagementRequest({
			...options,
			body: { ...options.body, ...(nextToken ? { nextToken } : {}) },
		});
		if (!isRecord(page)) throw new Error(`${options.target}: invalid response`);
		yield page;
		const token = page.nextToken;
		if (typeof token !== "string" || token.length === 0 || seen.has(token)) return;
		seen.add(token);
		nextToken = token;
		page = undefined;
	}
}

export interface KiroProfile {
	arn: string;
	name?: string;
}

/** Every profile visible in `region`; entries without a valid profile ARN are skipped. */
export async function listKiroProfiles(options: ManagementOptions): Promise<KiroProfile[]> {
	const profiles: KiroProfile[] = [];
	for await (const page of listPages({ ...options, target: "ListAvailableProfiles", body: {} })) {
		for (const entry of Array.isArray(page.profiles) ? page.profiles : []) {
			if (!isRecord(entry) || kiroProfileRegion(entry.arn) === undefined) continue;
			const name = typeof entry.profileName === "string" && entry.profileName ? entry.profileName : undefined;
			profiles.push({ arn: entry.arn as string, ...(name ? { name } : {}) });
		}
	}
	return profiles;
}

/** The single bootstrap region whose `ListAvailableModels` succeeds, with its first page; zero or several → null. */
async function probeApiKeyRegion(
	options: Omit<ManagementOptions, "region">,
): Promise<{ region: string; page: unknown } | null> {
	const results = await Promise.allSettled(
		KIRO_BOOTSTRAP_REGIONS.map(async region => ({
			region,
			page: await kiroManagementRequest({
				...options,
				region,
				target: "ListAvailableModels",
				body: { origin: "KIRO_CLI" },
			}),
		})),
	);
	options.signal?.throwIfAborted();
	const hits = results.flatMap(result => (result.status === "fulfilled" ? [result.value] : []));
	return hits.length === 1 ? hits[0]! : null;
}

/** The region an API key without a pinned region belongs to, or null when no single bootstrap region accepts it. */
export async function resolveKiroApiKeyRegion(options: Omit<ManagementOptions, "region">): Promise<string | null> {
	return (await probeApiKeyRegion(options))?.region ?? null;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

/** `schema.properties[k0].properties[k1]…`, or undefined when any step is missing. */
function schemaAt(schema: unknown, ...keys: string[]): Record<string, unknown> | undefined {
	let node = schema;
	for (const key of keys) {
		node = isRecord(node) && isRecord(node.properties) ? node.properties[key] : undefined;
	}
	return isRecord(node) ? node : undefined;
}

function stringEnum(schema: Record<string, unknown> | undefined): string[] {
	return Array.isArray(schema?.enum) ? schema.enum.filter(value => typeof value === "string") : [];
}

/** Thinking controls advertised by `additionalModelRequestFieldsSchema`, or undefined for an unknown shape. */
function mapThinking(schema: unknown): { thinking: ThinkingConfig; maxTokens?: number } | undefined {
	const anthropicEffort = schemaAt(schema, "output_config", "effort");
	if (stringEnum(schemaAt(schema, "thinking", "type")).includes("adaptive") && anthropicEffort) {
		const advertised = stringEnum(anthropicEffort);
		const efforts = ANTHROPIC_EFFORTS.filter(effort => advertised.includes(effort));
		if (efforts.length === 0) return undefined;
		const defaultLevel = efforts.find(effort => effort === anthropicEffort.default);
		const maxTokens = schemaAt(schema, "max_tokens")?.maximum;
		return {
			thinking: {
				mode: "anthropic-adaptive",
				efforts,
				...(defaultLevel ? { defaultLevel } : {}),
				effortMap: { [Effort.Minimal]: efforts[0] },
				supportsDisplay: true,
			},
			...(isPositiveInteger(maxTokens) ? { maxTokens } : {}),
		};
	}

	const gptEffort = schemaAt(schema, "reasoning", "effort");
	if (!gptEffort) return undefined;
	const advertised = stringEnum(gptEffort);
	const levels = GPT_EFFORTS.filter(([wire]) => advertised.includes(wire));
	if (levels.length === 0) return undefined;
	const defaultLevel = levels.find(([wire]) => wire === gptEffort.default)?.[1];
	return {
		thinking: {
			mode: "effort",
			efforts: levels.map(([, effort]) => effort),
			...(defaultLevel ? { defaultLevel } : {}),
			...(advertised.includes("none") ? { effortMap: { [Effort.Minimal]: "none" } } : {}),
		},
	};
}

function mapModel(raw: unknown, baseUrl: string): ModelSpec<"kiro-api"> | undefined {
	const modelId = isRecord(raw) ? raw.modelId : undefined;
	const limits = isRecord(raw) ? raw.tokenLimits : undefined;
	if (
		!isRecord(raw) ||
		typeof modelId !== "string" ||
		modelId.length === 0 ||
		!isRecord(limits) ||
		!isPositiveInteger(limits.maxInputTokens) ||
		!isPositiveInteger(limits.maxOutputTokens)
	) {
		logger.warn("Kiro model skipped: missing id or token limits", { modelId });
		return undefined;
	}
	const schema = raw.additionalModelRequestFieldsSchema;
	const mapped = mapThinking(schema);
	if (!mapped && schema !== undefined) {
		logger.warn("Kiro model request schema unrecognised; listing without thinking controls", { modelId });
	}
	const premium =
		raw.rateUnit === "Credit" && typeof raw.rateMultiplier === "number" && raw.rateMultiplier >= 0
			? raw.rateMultiplier
			: undefined;
	return {
		id: modelId,
		name: typeof raw.modelName === "string" && raw.modelName ? raw.modelName : modelId,
		api: "kiro-api",
		provider: "kiro",
		baseUrl,
		reasoning: mapped !== undefined,
		...(mapped ? { thinking: mapped.thinking } : {}),
		input:
			Array.isArray(raw.supportedInputTypes) && raw.supportedInputTypes.includes("IMAGE")
				? ["text", "image"]
				: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(premium !== undefined && Number.isFinite(premium) ? { premiumMultiplier: premium } : {}),
		contextWindow: limits.maxInputTokens,
		maxTokens: mapped?.maxTokens ?? limits.maxOutputTokens,
	};
}

/**
 * The credential's model roster from `ListAvailableModels`, following
 * `nextToken`. Returns null on failure or an empty roster so callers keep
 * their last cache. An unpinned API key first probes the bootstrap regions.
 */
export async function fetchKiroModels(options: {
	credential: KiroCredential;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}): Promise<ModelSpec<"kiro-api">[] | null> {
	const { credential, fetch, signal } = options;
	try {
		let region = credential.region;
		let first: unknown;
		if (!region) {
			const probed = await probeApiKeyRegion({ token: credential.token, fetch, signal });
			if (!probed) {
				logger.debug("Kiro model discovery skipped: no single bootstrap region accepts the API key");
				return null;
			}
			({ region, page: first } = probed);
		}
		const service = credential.kind === "oauth" ? credential.service : undefined;
		const baseUrl = kiroRequestBaseUrl(credential) ?? kiroRuntimeBaseUrl(region);
		const profileArn = credential.kind === "oauth" ? credential.profileArn : undefined;
		const models = new Map<string, ModelSpec<"kiro-api">>();
		for await (const page of listPages({
			region,
			token: credential.token,
			fetch,
			signal,
			service,
			target: "ListAvailableModels",
			body: { origin: "KIRO_CLI", ...(profileArn ? { profileArn } : {}) },
			first,
		})) {
			for (const raw of Array.isArray(page.models) ? page.models : []) {
				const model = mapModel(raw, baseUrl);
				if (model && !models.has(model.id)) models.set(model.id, model);
			}
		}
		if (models.size === 0) logger.warn("Kiro model discovery returned no usable models");
		return models.size > 0 ? [...models.values()] : null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (signal?.aborted) logger.debug("Kiro model discovery aborted", { error: message });
		else logger.warn("Kiro model discovery failed", { error: message });
		return null;
	}
}
