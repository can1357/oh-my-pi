/**
 * Kiro management discovery: bounded AWS JSON 1.0 client, fail-closed
 * sanitizer (additive unknowns tolerated), and schema-derived ModelSpec map.
 */
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { BoundedJsonReadError, readBoundedJson } from "@oh-my-pi/pi-utils/bounded-json";
import { Effort } from "../effort";
import type { FetchImpl, ModelSpec, ThinkingConfig } from "../types";
import { discoveryFetch } from "../utils";
import {
	KIRO_BOOTSTRAP_REGIONS,
	kiroManagementBaseUrl,
	kiroRuntimeBaseUrl,
	parseKiroEndpoint,
	parseKiroProfileArn,
	validateKiroApiRegion,
} from "../wire/kiro";

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const MANAGEMENT_TIMEOUT_MS = 10_000;
const MAX_MODELS_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROFILES_RESPONSE_BYTES = 128 * 1024;
const MAX_MODELS = 128;
const MAX_PROFILES = 128;
const MAX_SCHEMA_DEPTH = 8;

const ANTHROPIC_EFFORT_ORDER = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] as const;
const GPT_WIRE_EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const ANTHROPIC_EFFORTS = new Set<string>(ANTHROPIC_EFFORT_ORDER);
const GPT_WIRE_EFFORTS = new Set<string>(GPT_WIRE_EFFORT_ORDER);
const OMP_EFFORTS = new Set<string>([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_SCHEMA_PROPERTY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN_PROPERTY_NAME =
	/(authorization|cookie|secret|access_?token|refresh_?token|profile|account|email|user|arn)/i;
const PROTOTYPE_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export type KiroDiscoveryCredential =
	| { type: "api_key"; token: string; apiEndpoint?: string }
	// Builder ID signs in without an organization, so an OAuth bearer may carry no
	// profile ARN; the runtime region then comes from `apiEndpoint`. `loginId`
	// scopes the model cache to one login when the profile is shared or absent.
	| { type: "oauth"; token: string; profileArn?: string; apiEndpoint?: string; loginId?: string };

export interface KiroDiscoveryRoute {
	apiRegion: string;
	profileArn?: string;
	runtimeBaseUrl: string;
	managementBaseUrl: string;
}

export interface KiroApiKeyBootstrapResult {
	route: KiroDiscoveryRoute;
	payload: unknown;
}

export interface SanitizedJsonSchema {
	type?: string;
	properties?: Record<string, SanitizedJsonSchema>;
	required?: string[];
	additionalProperties?: boolean;
	enum?: Array<string | number | boolean | null>;
	default?: string | number | boolean | null;
	minimum?: number;
	maximum?: number;
	items?: SanitizedJsonSchema;
	oneOf?: SanitizedJsonSchema[];
	anyOf?: SanitizedJsonSchema[];
}

export interface SanitizedKiroModel {
	modelId: string;
	modelName: string;
	description?: string;
	supportedInputTypes: Array<"TEXT" | "IMAGE">;
	tokenLimits: { maxInputTokens: number; maxOutputTokens: number };
	additionalModelRequestFieldsSchema?: SanitizedJsonSchema;
	promptCaching?: {
		supportsPromptCaching: boolean;
		maximumCacheCheckpointsPerRequest?: number;
		minimumTokensPerCacheCheckpoint?: number;
	};
	rateMultiplier?: number;
	rateUnit?: string;
}

export interface SanitizedKiroModelCatalog {
	models: SanitizedKiroModel[];
}

export interface KiroManagementRequestOptions {
	apiRegion: string;
	token: string;
	target: "ListAvailableProfiles" | "ListAvailableModels";
	body: unknown;
	fetch?: FetchImpl;
	signal?: AbortSignal;
	maxBytes?: number;
	timeoutMs?: number;
}

export interface FetchKiroModelsOptions {
	credential: KiroDiscoveryCredential;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}

function failSanitize(code: string): never {
	throw new Error(`Unsafe ListAvailableModels response: ${code}`);
}

function record(value: unknown, code: string): Record<string, unknown> {
	if (!isRecord(value)) failSanitize(code);
	return value;
}

function hasControlCharacters(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		if (value.charCodeAt(i) <= 0x1f) return true;
	}
	return false;
}

function boundedString(value: unknown, code: string, maxLength = 256): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength || hasControlCharacters(value)) {
		failSanitize(code);
	}
	return value;
}

function safeId(value: unknown, code: string): string {
	const id = boundedString(value, code, 128);
	if (!SAFE_ID.test(id)) failSanitize(code);
	return id;
}

function safeSchemaProperty(value: unknown, code: string): string {
	const property = boundedString(value, code, 64);
	if (
		!SAFE_SCHEMA_PROPERTY.test(property) ||
		FORBIDDEN_PROPERTY_NAME.test(property) ||
		PROTOTYPE_PROPERTY_NAMES.has(property)
	) {
		failSanitize(code);
	}
	return property;
}

function positiveInteger(value: unknown, code: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) failSanitize(code);
	return value as number;
}

function finiteNonNegative(value: unknown, code: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) failSanitize(code);
	return value;
}

function sanitizeSchemaPrimitive(value: unknown, code: string): string | number | boolean | null {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length <= 128 && !hasControlCharacters(value)) return value;
	return failSanitize(code);
}

/** Compact JSON-schema projection: keep known keywords, ignore additive unknowns. */
function sanitizeJsonSchema(value: unknown, depth = 0): SanitizedJsonSchema {
	if (depth > MAX_SCHEMA_DEPTH) failSanitize("schema.depth");
	const raw = record(value, "schema.object");
	const result: SanitizedJsonSchema = {};

	if (raw.type !== undefined) result.type = boundedString(raw.type, "schema.type", 32);
	if (raw.additionalProperties !== undefined) {
		if (typeof raw.additionalProperties !== "boolean") failSanitize("schema.additionalProperties");
		result.additionalProperties = raw.additionalProperties;
	}
	if (raw.minimum !== undefined) result.minimum = finiteNonNegative(raw.minimum, "schema.minimum");
	if (raw.maximum !== undefined) result.maximum = finiteNonNegative(raw.maximum, "schema.maximum");
	if (result.minimum !== undefined && result.maximum !== undefined && result.minimum > result.maximum) {
		failSanitize("schema.bounds");
	}
	if (raw.default !== undefined) result.default = sanitizeSchemaPrimitive(raw.default, "schema.default");
	if (raw.enum !== undefined) {
		if (!Array.isArray(raw.enum) || raw.enum.length === 0 || raw.enum.length > 32) failSanitize("schema.enum");
		result.enum = raw.enum.map(entry => sanitizeSchemaPrimitive(entry, "schema.enum-value"));
	}
	if (raw.required !== undefined) {
		if (!Array.isArray(raw.required) || raw.required.length > 32) failSanitize("schema.required");
		result.required = raw.required.map(entry => safeSchemaProperty(entry, "schema.required-value"));
	}
	if (raw.properties !== undefined) {
		const properties = record(raw.properties, "schema.properties");
		if (Object.keys(properties).length > 32) failSanitize("schema.properties-count");
		result.properties = Object.create(null) as Record<string, SanitizedJsonSchema>;
		for (const [property, schema] of Object.entries(properties)) {
			const safeProperty = safeSchemaProperty(property, "schema.property-name");
			result.properties[safeProperty] = sanitizeJsonSchema(schema, depth + 1);
		}
	}
	if (raw.items !== undefined) result.items = sanitizeJsonSchema(raw.items, depth + 1);
	for (const unionKey of ["oneOf", "anyOf"] as const) {
		const union = raw[unionKey];
		if (union === undefined) continue;
		if (!Array.isArray(union) || union.length === 0 || union.length > 16) failSanitize(`schema.${unionKey}`);
		result[unionKey] = union.map(entry => sanitizeJsonSchema(entry, depth + 1));
	}
	return result;
}

function sanitizeModel(value: unknown): SanitizedKiroModel {
	const raw = record(value, "model.object");
	const modelId = safeId(raw.modelId, "model.id");
	const modelName = boundedString(raw.modelName, "model.name", 128);

	if (!Array.isArray(raw.supportedInputTypes) || raw.supportedInputTypes.length === 0) {
		failSanitize("model.input-types");
	}
	const supportedInputTypes = raw.supportedInputTypes.map(input => {
		if (input !== "TEXT" && input !== "IMAGE") failSanitize("model.input-type");
		return input;
	});
	if (new Set(supportedInputTypes).size !== supportedInputTypes.length) {
		failSanitize("model.input-duplicate");
	}

	const rawLimits = record(raw.tokenLimits, "model.token-limits");
	const model: SanitizedKiroModel = {
		modelId,
		modelName,
		supportedInputTypes,
		tokenLimits: {
			maxInputTokens: positiveInteger(rawLimits.maxInputTokens, "model.max-input"),
			maxOutputTokens: positiveInteger(rawLimits.maxOutputTokens, "model.max-output"),
		},
	};

	if (raw.description !== undefined) model.description = boundedString(raw.description, "model.description", 512);
	if (raw.additionalModelRequestFieldsSchema !== undefined) {
		model.additionalModelRequestFieldsSchema = sanitizeJsonSchema(raw.additionalModelRequestFieldsSchema);
	}
	if (raw.promptCaching !== undefined) {
		const cache = record(raw.promptCaching, "model.prompt-caching");
		if (typeof cache.supportsPromptCaching !== "boolean") failSanitize("model.prompt-caching.supported");
		model.promptCaching = { supportsPromptCaching: cache.supportsPromptCaching };
		if (cache.maximumCacheCheckpointsPerRequest !== undefined) {
			model.promptCaching.maximumCacheCheckpointsPerRequest = positiveInteger(
				cache.maximumCacheCheckpointsPerRequest,
				"model.prompt-caching.maximum",
			);
		}
		if (cache.minimumTokensPerCacheCheckpoint !== undefined) {
			model.promptCaching.minimumTokensPerCacheCheckpoint = positiveInteger(
				cache.minimumTokensPerCacheCheckpoint,
				"model.prompt-caching.minimum",
			);
		}
	}
	if (raw.rateMultiplier !== undefined) {
		model.rateMultiplier = finiteNonNegative(raw.rateMultiplier, "model.rate-multiplier");
	}
	if (raw.rateUnit !== undefined) model.rateUnit = boundedString(raw.rateUnit, "model.rate-unit", 32);
	return model;
}

/**
 * Fail-closed catalog sanitizer. Unknown additive top-level/model keys are
 * ignored; malformed recognized fields reject the entire response.
 */
export function sanitizeKiroModelCatalog(value: unknown): SanitizedKiroModelCatalog {
	const raw = record(value, "top-level.object");
	if (!Array.isArray(raw.models) || raw.models.length === 0 || raw.models.length > MAX_MODELS) {
		failSanitize("models.count");
	}
	const models = raw.models.map(sanitizeModel);
	const ids = models.map(model => model.modelId);
	if (new Set(ids).size !== ids.length) failSanitize("models.duplicate-id");
	return { models };
}

function schemaError(modelId: string, detail: string): never {
	throw new Error(`Unsupported Kiro request schema for ${modelId}: ${detail}`);
}

function exactSchemaKeywords(
	modelId: string,
	schema: SanitizedJsonSchema | undefined,
	expected: readonly (keyof SanitizedJsonSchema)[],
	detail: string,
): asserts schema is SanitizedJsonSchema {
	if (!schema) schemaError(modelId, detail);
	const actual = (Object.keys(schema) as (keyof SanitizedJsonSchema)[]).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
		schemaError(modelId, detail);
	}
}

function exactRequired(
	modelId: string,
	schema: SanitizedJsonSchema,
	expected: readonly string[],
	detail: string,
): void {
	const actual = [...(schema.required ?? [])].sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
		schemaError(modelId, detail);
	}
}

function exactPropertyNames(
	modelId: string,
	schema: SanitizedJsonSchema | undefined,
	expected: readonly string[],
	detail: string,
): Record<string, SanitizedJsonSchema> {
	if (schema?.type !== "object" || !schema.properties) schemaError(modelId, detail);
	const actual = Object.keys(schema.properties).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
		schemaError(modelId, detail);
	}
	return schema.properties;
}

function stringEnum(
	modelId: string,
	schema: SanitizedJsonSchema | undefined,
	allowed: ReadonlySet<string>,
	detail: string,
): string[] {
	if (schema?.type !== "string" || !schema.enum?.length) schemaError(modelId, detail);
	const values = schema.enum.map(value => {
		if (typeof value !== "string" || !allowed.has(value)) schemaError(modelId, detail);
		return value;
	});
	if (new Set(values).size !== values.length) schemaError(modelId, detail);
	return values;
}

function enumDefault(modelId: string, schema: SanitizedJsonSchema, values: readonly string[], detail: string): string {
	if (typeof schema.default !== "string" || !values.includes(schema.default)) schemaError(modelId, detail);
	return schema.default;
}

function anthropicThinking(model: SanitizedKiroModel): { thinking: ThinkingConfig; maxTokens: number } {
	const modelId = model.modelId;
	const rootSchema = model.additionalModelRequestFieldsSchema;
	exactSchemaKeywords(modelId, rootSchema, ["type", "additionalProperties", "properties"], "anthropic.root");
	if (rootSchema.additionalProperties !== false) schemaError(modelId, "anthropic.additionalProperties");
	const root = exactPropertyNames(modelId, rootSchema, ["thinking", "output_config", "max_tokens"], "anthropic.root");

	// Kiro began sending `additionalProperties: false` on `thinking` (claude-sonnet-5.5).
	// Accept exactly that one optional keyword; any other value or keyword still rejects.
	const thinkingHasClosedShape = root.thinking.additionalProperties === false;
	if (root.thinking.additionalProperties !== undefined && !thinkingHasClosedShape) {
		schemaError(modelId, "anthropic.thinking");
	}
	exactSchemaKeywords(
		modelId,
		root.thinking,
		thinkingHasClosedShape
			? ["type", "properties", "required", "additionalProperties"]
			: ["type", "properties", "required"],
		"anthropic.thinking",
	);
	exactRequired(modelId, root.thinking, ["type"], "anthropic.thinking.required");
	const thinking = exactPropertyNames(modelId, root.thinking, ["type", "display"], "anthropic.thinking");
	exactSchemaKeywords(modelId, thinking.type, ["type", "enum"], "anthropic.type");
	exactSchemaKeywords(modelId, thinking.display, ["type", "enum"], "anthropic.display");
	// Kiro advertises the thinking modes a model actually supports: a model whose
	// thinking cannot be turned off publishes `["adaptive"]` alone. `adaptive` is
	// the mode this mapping emits, so it is the only requirement — also requiring
	// `disabled` dropped the entire catalog once Kiro began advertising
	// adaptive-only models, hiding the provider from the model list instead of
	// degrading a single model.
	// `between_tools` (claude-sonnet-5.5) is an advertised mode this mapping never
	// emits; like `disabled` it is tolerated but not required.
	const thinkingTypes = stringEnum(
		modelId,
		thinking.type,
		new Set(["adaptive", "disabled", "between_tools"]),
		"anthropic.type",
	);
	if (!thinkingTypes.includes("adaptive")) {
		schemaError(modelId, "anthropic.type");
	}
	const display = stringEnum(modelId, thinking.display, new Set(["summarized", "omitted"]), "anthropic.display");
	if (!display.includes("summarized") || !display.includes("omitted")) schemaError(modelId, "anthropic.display");

	exactSchemaKeywords(modelId, root.output_config, ["type", "properties"], "anthropic.output_config");
	const outputConfig = exactPropertyNames(modelId, root.output_config, ["effort"], "anthropic.output_config");
	const effortSchema = outputConfig.effort;
	exactSchemaKeywords(modelId, effortSchema, ["type", "enum", "default"], "anthropic.effort");
	const advertisedEfforts = stringEnum(modelId, effortSchema, ANTHROPIC_EFFORTS, "anthropic.effort");
	const efforts = ANTHROPIC_EFFORT_ORDER.filter(effort => advertisedEfforts.includes(effort));
	const defaultLevel = enumDefault(modelId, effortSchema, advertisedEfforts, "anthropic.default") as Effort;

	const maxTokensSchema = root.max_tokens;
	exactSchemaKeywords(modelId, maxTokensSchema, ["type", "minimum", "maximum"], "anthropic.max_tokens");
	if (
		maxTokensSchema.type !== "integer" ||
		!Number.isSafeInteger(maxTokensSchema.minimum) ||
		(maxTokensSchema.minimum as number) <= 0 ||
		!Number.isSafeInteger(maxTokensSchema.maximum) ||
		(maxTokensSchema.maximum as number) < (maxTokensSchema.minimum as number)
	) {
		schemaError(modelId, "anthropic.max_tokens");
	}

	return {
		thinking: {
			mode: "anthropic-adaptive",
			efforts,
			defaultLevel,
			effortMap: { [Effort.Minimal]: efforts[0]! },
			supportsDisplay: true,
		},
		maxTokens: maxTokensSchema.maximum as number,
	};
}

function gptThinking(model: SanitizedKiroModel): ThinkingConfig {
	const modelId = model.modelId;
	const rootSchema = model.additionalModelRequestFieldsSchema;
	exactSchemaKeywords(modelId, rootSchema, ["type", "additionalProperties", "properties"], "gpt.root");
	if (rootSchema.additionalProperties !== false) schemaError(modelId, "gpt.additionalProperties");
	const root = exactPropertyNames(modelId, rootSchema, ["reasoning"], "gpt.root");
	exactSchemaKeywords(modelId, root.reasoning, ["type", "properties"], "gpt.reasoning");
	const hasLegacyMode = root.reasoning.properties !== undefined && Object.hasOwn(root.reasoning.properties, "mode");
	const reasoning = exactPropertyNames(
		modelId,
		root.reasoning,
		hasLegacyMode ? ["mode", "effort"] : ["effort"],
		"gpt.reasoning",
	);
	if (hasLegacyMode) {
		exactSchemaKeywords(modelId, reasoning.mode, ["type", "enum", "default"], "gpt.mode");
		const modes = stringEnum(modelId, reasoning.mode, new Set(["standard", "pro"]), "gpt.mode");
		if (
			!modes.includes("standard") ||
			enumDefault(modelId, reasoning.mode, modes, "gpt.mode-default") !== "standard"
		) {
			schemaError(modelId, "gpt.mode-default");
		}
	}
	exactSchemaKeywords(modelId, reasoning.effort, ["type", "enum", "default"], "gpt.effort");
	const advertisedWireEfforts = stringEnum(modelId, reasoning.effort, GPT_WIRE_EFFORTS, "gpt.effort");
	const wireEfforts = GPT_WIRE_EFFORT_ORDER.filter(effort => advertisedWireEfforts.includes(effort));
	const efforts = wireEfforts.map(effort => (effort === "none" ? Effort.Minimal : (effort as Effort)));
	if (efforts.some(effort => !OMP_EFFORTS.has(effort))) schemaError(modelId, "gpt.effort");
	const wireDefault = enumDefault(modelId, reasoning.effort, wireEfforts, "gpt.default");
	const defaultLevel = (wireDefault === "none" ? Effort.Minimal : wireDefault) as Effort;
	return {
		mode: "effort",
		efforts,
		defaultLevel,
		effortMap: wireEfforts.includes("none") ? { [Effort.Minimal]: "none" } : undefined,
	};
}

function mapRequestSchema(model: SanitizedKiroModel): {
	reasoning: boolean;
	thinking?: ThinkingConfig;
	maxTokens: number;
} {
	const schema = model.additionalModelRequestFieldsSchema;
	if (!schema) return { reasoning: false, maxTokens: model.tokenLimits.maxOutputTokens };
	const rootProperties = schema.properties;
	if (rootProperties?.thinking || rootProperties?.output_config || rootProperties?.max_tokens) {
		const adaptive = anthropicThinking(model);
		return { reasoning: true, ...adaptive };
	}
	if (rootProperties?.reasoning) {
		return {
			reasoning: true,
			thinking: gptThinking(model),
			maxTokens: model.tokenLimits.maxOutputTokens,
		};
	}
	return schemaError(model.modelId, "unknown-family");
}

function premiumMultiplier(model: SanitizedKiroModel): number | undefined {
	if (model.rateMultiplier === undefined && model.rateUnit === undefined) return undefined;
	if (model.rateMultiplier === undefined || model.rateUnit !== "Credit") {
		throw new Error(`Unsupported Kiro rate metadata for ${model.modelId}`);
	}
	return model.rateMultiplier;
}

/** Map one sanitized model into a canonical `ModelSpec<"kiro-api">`. */
export function mapKiroModel(model: SanitizedKiroModel, runtimeBaseUrl: string): ModelSpec<"kiro-api"> {
	const requestMetadata = mapRequestSchema(model);
	const multiplier = premiumMultiplier(model);
	return {
		id: model.modelId,
		name: model.modelName,
		api: "kiro-api",
		provider: "kiro",
		baseUrl: runtimeBaseUrl,
		reasoning: requestMetadata.reasoning,
		...(requestMetadata.thinking ? { thinking: requestMetadata.thinking } : {}),
		input: model.supportedInputTypes.map(input => (input === "IMAGE" ? "image" : "text")),
		cost: { ...ZERO_COST },
		...(multiplier !== undefined ? { premiumMultiplier: multiplier } : {}),
		contextWindow: model.tokenLimits.maxInputTokens,
		maxTokens: requestMetadata.maxTokens,
	};
}

/**
 * Convert an authoritative sanitized catalog, isolating failures per model.
 *
 * The request-fields schema only describes optional request parameters
 * (thinking/effort/max_tokens), so a model whose schema is unrecognised is
 * still usable for plain chat. Such a model is exposed with conservative
 * no-thinking defaults and a warning rather than throwing, so one new or odd
 * Kiro model can never drop the whole provider from the model list. A model is
 * skipped only if even the conservative fallback cannot be built (e.g. invalid
 * rate metadata). If every model is skipped the result is empty and an error is
 * logged; callers treat that as a failed refresh.
 */
export function mapKiroModelCatalog(
	catalog: SanitizedKiroModelCatalog,
	runtimeBaseUrl: string,
): ModelSpec<"kiro-api">[] {
	const mapped: ModelSpec<"kiro-api">[] = [];
	for (const model of catalog.models) {
		try {
			mapped.push(mapKiroModel(model, runtimeBaseUrl));
			continue;
		} catch (error) {
			logger.warn("Kiro model request schema unrecognised; exposing without thinking controls", {
				modelId: model.modelId,
				reason: errorMessage(error),
			});
		}
		try {
			mapped.push(mapKiroModelWithoutThinking(model, runtimeBaseUrl));
		} catch (error) {
			logger.warn("Kiro model skipped: cannot be represented safely", {
				modelId: model.modelId,
				reason: errorMessage(error),
			});
		}
	}
	if (catalog.models.length > 0 && mapped.length === 0) {
		logger.error("Kiro model catalog yielded no usable models", { modelCount: catalog.models.length });
	}
	return mapped;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function mapKiroModelWithoutThinking(model: SanitizedKiroModel, runtimeBaseUrl: string): ModelSpec<"kiro-api"> {
	const multiplier = premiumMultiplier(model);
	return {
		id: model.modelId,
		name: model.modelName,
		api: "kiro-api",
		provider: "kiro",
		baseUrl: runtimeBaseUrl,
		reasoning: false,
		input: model.supportedInputTypes.map(input => (input === "IMAGE" ? "image" : "text")),
		cost: { ...ZERO_COST },
		...(multiplier !== undefined ? { premiumMultiplier: multiplier } : {}),
		contextWindow: model.tokenLimits.maxInputTokens,
		maxTokens: model.tokenLimits.maxOutputTokens,
	};
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
	return signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
}

/** Bounded AWS JSON 1.0 POST against a validated Kiro management endpoint. */
export async function kiroManagementRequest(options: KiroManagementRequestOptions): Promise<unknown> {
	const apiRegion = validateKiroApiRegion(options.apiRegion);
	if (!apiRegion) throw new Error("Invalid Kiro API region");
	if (typeof options.token !== "string" || options.token.length === 0) {
		throw new Error(`${options.target}: missing token`);
	}

	const fetchImpl = discoveryFetch(options.fetch);
	const timeoutMs = options.timeoutMs ?? MANAGEMENT_TIMEOUT_MS;
	const maxBytes =
		options.maxBytes ??
		(options.target === "ListAvailableModels" ? MAX_MODELS_RESPONSE_BYTES : MAX_PROFILES_RESPONSE_BYTES);
	const timeout = new AbortController();
	const timer = setTimeout(
		() => timeout.abort(new DOMException("The operation timed out.", "TimeoutError")),
		timeoutMs,
	);
	const signal = options.signal ? combineSignals([options.signal, timeout.signal]) : timeout.signal;

	try {
		const response = await fetchImpl(kiroManagementBaseUrl(apiRegion), {
			method: "POST",
			headers: {
				"Content-Type": "application/x-amz-json-1.0",
				Authorization: `Bearer ${options.token}`,
				"X-Amz-Target": `AmazonCodeWhispererService.${options.target}`,
			},
			body: JSON.stringify(options.body),
			signal,
		});
		if (!response.ok) throw new Error(`${options.target}: HTTP ${response.status}`);
		try {
			return await readBoundedJson(response, maxBytes);
		} catch (cause) {
			if (!(cause instanceof BoundedJsonReadError)) throw cause;
			const detail =
				cause.kind === "size" || cause.kind === "empty-body"
					? "invalid response size"
					: cause.kind === "missing-body"
						? "missing response body"
						: "invalid JSON";
			throw new Error(`${options.target}: ${detail}`, { cause });
		}
	} finally {
		clearTimeout(timer);
	}
}

export interface KiroProfileSummary {
	arn: string;
	profileName?: string;
}

/** ListAvailableProfiles against one validated management region. */
export async function listKiroAvailableProfiles(options: {
	apiRegion: string;
	token: string;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}): Promise<KiroProfileSummary[]> {
	const value = await kiroManagementRequest({
		apiRegion: options.apiRegion,
		token: options.token,
		target: "ListAvailableProfiles",
		body: {},
		fetch: options.fetch,
		signal: options.signal,
		maxBytes: MAX_PROFILES_RESPONSE_BYTES,
	});
	if (!isRecord(value) || !Array.isArray(value.profiles) || value.profiles.length > MAX_PROFILES) {
		throw new Error("ListAvailableProfiles: invalid response");
	}
	return value.profiles.map(entry => {
		if (!isRecord(entry)) throw new Error("ListAvailableProfiles: invalid profile");
		const parsed = parseKiroProfileArn(typeof entry.arn === "string" ? entry.arn : undefined);
		if (!parsed) throw new Error("ListAvailableProfiles: invalid profile ARN");
		const profile: KiroProfileSummary = { arn: parsed.profileArn };
		if (entry.profileName !== undefined) profile.profileName = boundedString(entry.profileName, "profile.name", 128);
		return profile;
	});
}

function routeForApiRegion(apiRegion: string, profileArn?: string): KiroDiscoveryRoute {
	return {
		apiRegion,
		...(profileArn ? { profileArn } : {}),
		runtimeBaseUrl: kiroRuntimeBaseUrl(apiRegion),
		managementBaseUrl: kiroManagementBaseUrl(apiRegion),
	};
}

/**
 * Resolve management/runtime routing from an already-selected discovery credential.
 * API keys without an endpoint require bootstrap probing in `fetchKiroModels`.
 */
export function resolveKiroDiscoveryRoute(credential: KiroDiscoveryCredential): KiroDiscoveryRoute | null {
	if (credential.type === "oauth") {
		if (credential.profileArn !== undefined) {
			const parsed = parseKiroProfileArn(credential.profileArn);
			if (!parsed) return null;
			return routeForApiRegion(parsed.apiRegion, parsed.profileArn);
		}
		// Builder ID: no profile ARN, so the endpoint carries the region. The
		// service infers the profile from the bearer, matching the Kiro CLI.
		if (!credential.apiEndpoint) return null;
		const builderEndpoint = parseKiroEndpoint(credential.apiEndpoint);
		if (!builderEndpoint) return null;
		return routeForApiRegion(builderEndpoint.apiRegion);
	}

	if (!credential.apiEndpoint) return null;
	const endpoint = parseKiroEndpoint(credential.apiEndpoint);
	if (!endpoint) return null;
	return routeForApiRegion(endpoint.apiRegion);
}

/**
 * Probe bounded bootstrap management hosts with read-only ListAvailableModels.
 * Returns the exclusive successful region's payload, or `null` when zero/ambiguous.
 */
export async function probeKiroApiKeyBootstrap(options: {
	token: string;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}): Promise<KiroApiKeyBootstrapResult | null> {
	const successes: Array<{ apiRegion: string; payload: unknown }> = [];
	for (const apiRegion of KIRO_BOOTSTRAP_REGIONS) {
		try {
			const payload = await kiroManagementRequest({
				apiRegion,
				token: options.token,
				target: "ListAvailableModels",
				body: { origin: "KIRO_CLI" },
				fetch: options.fetch,
				signal: options.signal,
			});
			successes.push({ apiRegion, payload });
		} catch (cause) {
			if (options.signal?.aborted) throw cause;
			// Probe next bootstrap region.
		}
	}
	if (successes.length !== 1) return null;
	const hit = successes[0]!;
	return { route: routeForApiRegion(hit.apiRegion), payload: hit.payload };
}

/**
 * Fetch, sanitize, and map the authoritative Kiro catalog. Returns `null` on
 * auth/route/validation/transport failure so callers retain the last safe cache.
 */
export async function fetchKiroModels(options: FetchKiroModelsOptions): Promise<ModelSpec<"kiro-api">[] | null> {
	try {
		const { credential } = options;
		let route: KiroDiscoveryRoute | null;
		let payload: unknown;

		if (credential.type === "api_key" && !credential.apiEndpoint) {
			const probed = await probeKiroApiKeyBootstrap({
				token: credential.token,
				fetch: options.fetch,
				signal: options.signal,
			});
			if (!probed) {
				logger.debug("Kiro model discovery skipped: bootstrap region probe did not resolve a single route");
				return null;
			}
			route = probed.route;
			payload = probed.payload;
		} else {
			route = resolveKiroDiscoveryRoute(credential);
			if (!route) {
				logger.debug("Kiro model discovery skipped: route unresolved");
				return null;
			}
			const body =
				credential.type === "oauth" ? { origin: "KIRO_CLI", profileArn: route.profileArn } : { origin: "KIRO_CLI" };
			payload = await kiroManagementRequest({
				apiRegion: route.apiRegion,
				token: credential.token,
				target: "ListAvailableModels",
				body,
				fetch: options.fetch,
				signal: options.signal,
			});
		}

		const catalog = sanitizeKiroModelCatalog(payload);
		const models = mapKiroModelCatalog(catalog, route.runtimeBaseUrl);
		// An empty roster is a failed refresh: keep the last safe cache.
		return models.length > 0 ? models : null;
	} catch (error) {
		if (options.signal?.aborted) {
			logger.debug("Kiro model discovery aborted", { error: errorMessage(error) });
		} else {
			logger.warn("Kiro model discovery failed", { error: errorMessage(error) });
		}
		return null;
	}
}
