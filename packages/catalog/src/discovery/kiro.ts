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
import type { KiroCredential } from "../wire/kiro-credential";

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const MANAGEMENT_TIMEOUT_MS = 10_000;
const MAX_MODELS_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROFILES_RESPONSE_BYTES = 128 * 1024;
const MAX_MODELS = 128;
const MAX_PROFILES = 128;
/** Pages followed per paged listing; a repeating or endless `nextToken` stops here. */
const MAX_PAGES = 16;
const MAX_SCHEMA_DEPTH = 8;

const ANTHROPIC_EFFORT_ORDER = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] as const;
const GPT_WIRE_EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const ANTHROPIC_EFFORTS = new Set<string>(ANTHROPIC_EFFORT_ORDER);
const GPT_WIRE_EFFORTS = new Set<string>(GPT_WIRE_EFFORT_ORDER);
const OMP_EFFORTS = new Set<string>([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_SCHEMA_PROPERTY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const PROTOTYPE_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

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
	supportedInputTypes: Array<"TEXT" | "IMAGE">;
	tokenLimits: { maxInputTokens: number; maxOutputTokens: number };
	additionalModelRequestFieldsSchema?: SanitizedJsonSchema;
	rateMultiplier?: number;
	rateUnit?: string;
}

export interface SanitizedKiroModelCatalog {
	models: SanitizedKiroModel[];
	/** Continuation token of a paged `ListAvailableModels` response. */
	nextToken?: string;
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
	credential: KiroCredential;
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
	if (!SAFE_SCHEMA_PROPERTY.test(property) || PROTOTYPE_PROPERTY_NAMES.has(property)) {
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

/** Run an optional-field sanitizer; an invalid value is dropped instead of rejecting the model. */
function optionalField<T>(modelId: string, field: string, sanitize: () => T): T | undefined {
	try {
		return sanitize();
	} catch (error) {
		logger.debug("Kiro model field dropped: invalid value", { modelId, field, reason: errorMessage(error) });
		return undefined;
	}
}

function sanitizeInputTypes(value: unknown): Array<"TEXT" | "IMAGE"> {
	if (!Array.isArray(value)) failSanitize("model.input-types");
	const inputs = new Set<"TEXT" | "IMAGE">();
	for (const input of value) {
		if (input !== "TEXT" && input !== "IMAGE") failSanitize("model.input-type");
		inputs.add(input);
	}
	if (inputs.size === 0 || inputs.size !== value.length) failSanitize("model.input-types");
	return [...inputs];
}

/**
 * Sanitize one model entry. An invalid core field (`modelId`, token limits)
 * skips the model; an invalid optional field is dropped. A dropped request
 * schema leaves the model without thinking controls; dropped input types fall
 * back to text-only.
 */
function sanitizeModel(value: unknown): SanitizedKiroModel {
	const raw = record(value, "model.object");
	const modelId = safeId(raw.modelId, "model.id");
	const rawLimits = record(raw.tokenLimits, "model.token-limits");
	const model: SanitizedKiroModel = {
		modelId,
		modelName: optionalField(modelId, "modelName", () => boundedString(raw.modelName, "model.name", 128)) ?? modelId,
		supportedInputTypes: optionalField(modelId, "supportedInputTypes", () =>
			sanitizeInputTypes(raw.supportedInputTypes),
		) ?? ["TEXT"],
		tokenLimits: {
			maxInputTokens: positiveInteger(rawLimits.maxInputTokens, "model.max-input"),
			maxOutputTokens: positiveInteger(rawLimits.maxOutputTokens, "model.max-output"),
		},
	};

	if (raw.additionalModelRequestFieldsSchema !== undefined) {
		const schema = optionalField(modelId, "additionalModelRequestFieldsSchema", () =>
			sanitizeJsonSchema(raw.additionalModelRequestFieldsSchema),
		);
		if (schema) model.additionalModelRequestFieldsSchema = schema;
	}
	if (raw.rateMultiplier !== undefined || raw.rateUnit !== undefined) {
		// Kiro bills in credits; any other unit or a malformed multiplier drops
		// the rate rather than guessing a multiplier.
		const rateMultiplier = optionalField(modelId, "rateMultiplier", () =>
			finiteNonNegative(raw.rateMultiplier, "model.rate-multiplier"),
		);
		if (rateMultiplier !== undefined && raw.rateUnit === "Credit") {
			model.rateMultiplier = rateMultiplier;
			model.rateUnit = "Credit";
		}
	}
	return model;
}

/**
 * Sanitize one `ListAvailableModels` page. Only a malformed envelope (not an
 * object, `models` not an array, too many models, or a malformed `nextToken`)
 * rejects the response; an invalid model is skipped and logged so the rest of
 * the roster survives, and a repeated model id keeps its first entry. Unknown
 * additive keys are ignored.
 */
export function sanitizeKiroModelCatalog(value: unknown): SanitizedKiroModelCatalog {
	const raw = record(value, "top-level.object");
	if (!Array.isArray(raw.models) || raw.models.length > MAX_MODELS) failSanitize("models.count");
	const nextToken =
		raw.nextToken === undefined || raw.nextToken === null
			? undefined
			: boundedString(raw.nextToken, "next-token", 4096);
	const models: SanitizedKiroModel[] = [];
	const seen = new Set<string>();
	for (const entry of raw.models) {
		let model: SanitizedKiroModel;
		try {
			model = sanitizeModel(entry);
		} catch (error) {
			logger.warn("Kiro model skipped: invalid ListAvailableModels entry", { reason: errorMessage(error) });
			continue;
		}
		if (seen.has(model.modelId)) {
			logger.warn("Kiro model skipped: duplicate model id", { modelId: model.modelId });
			continue;
		}
		seen.add(model.modelId);
		models.push(model);
	}
	return nextToken ? { models, nextToken } : { models };
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
	return model.rateUnit === "Credit" ? model.rateMultiplier : undefined;
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
 * Kiro model can never drop the whole provider from the model list. An empty
 * result is logged; callers treat it as a failed refresh.
 */
export function mapKiroModelCatalog(
	catalog: SanitizedKiroModelCatalog,
	runtimeBaseUrl: string,
): ModelSpec<"kiro-api">[] {
	const mapped = catalog.models.map(model => {
		try {
			return mapKiroModel(model, runtimeBaseUrl);
		} catch (error) {
			logger.warn("Kiro model request schema unrecognised; exposing without thinking controls", {
				modelId: model.modelId,
				reason: errorMessage(error),
			});
			return mapKiroModelWithoutThinking(model, runtimeBaseUrl);
		}
	});
	if (mapped.length === 0) logger.error("Kiro model catalog yielded no usable models");
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

function pageToken(value: Record<string, unknown>, target: string): string | undefined {
	if (value.nextToken === undefined || value.nextToken === null) return undefined;
	if (typeof value.nextToken !== "string" || value.nextToken.length === 0 || value.nextToken.length > 4096) {
		throw new Error(`${target}: invalid nextToken`);
	}
	return value.nextToken;
}

/**
 * ListAvailableProfiles against one validated management region, following
 * `nextToken` until it is absent, capped at {@link MAX_PROFILES} profiles.
 */
export async function listKiroAvailableProfiles(options: {
	apiRegion: string;
	token: string;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}): Promise<KiroProfileSummary[]> {
	const profiles: KiroProfileSummary[] = [];
	const seenTokens = new Set<string>();
	let nextToken: string | undefined;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const value = await kiroManagementRequest({
			apiRegion: options.apiRegion,
			token: options.token,
			target: "ListAvailableProfiles",
			body: nextToken ? { nextToken } : {},
			fetch: options.fetch,
			signal: options.signal,
			maxBytes: MAX_PROFILES_RESPONSE_BYTES,
		});
		if (!isRecord(value) || !Array.isArray(value.profiles) || value.profiles.length > MAX_PROFILES) {
			throw new Error("ListAvailableProfiles: invalid response");
		}
		for (const entry of value.profiles) {
			if (!isRecord(entry)) throw new Error("ListAvailableProfiles: invalid profile");
			const parsed = parseKiroProfileArn(typeof entry.arn === "string" ? entry.arn : undefined);
			if (!parsed) throw new Error("ListAvailableProfiles: invalid profile ARN");
			const profile: KiroProfileSummary = { arn: parsed.profileArn };
			if (entry.profileName !== undefined)
				profile.profileName = boundedString(entry.profileName, "profile.name", 128);
			if (profiles.length >= MAX_PROFILES) {
				logger.warn("Kiro profile list truncated", { maxProfiles: MAX_PROFILES });
				return profiles;
			}
			profiles.push(profile);
		}
		nextToken = pageToken(value, "ListAvailableProfiles");
		if (!nextToken || seenTokens.has(nextToken)) return profiles;
		seenTokens.add(nextToken);
	}
	logger.warn("Kiro profile list truncated", { maxPages: MAX_PAGES });
	return profiles;
}

/**
 * ListAvailableModels for one route, following `nextToken` until it is absent,
 * capped at {@link MAX_MODELS} models. `firstPage` reuses a page already
 * fetched (the API-key bootstrap probe) instead of requesting it again.
 */
export async function listKiroModels(options: {
	apiRegion: string;
	token: string;
	profileArn?: string;
	fetch?: FetchImpl;
	signal?: AbortSignal;
	firstPage?: unknown;
}): Promise<SanitizedKiroModelCatalog> {
	const models: SanitizedKiroModel[] = [];
	const seenIds = new Set<string>();
	const seenTokens = new Set<string>();
	let nextToken: string | undefined;
	let payload = options.firstPage;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		payload ??= await kiroManagementRequest({
			apiRegion: options.apiRegion,
			token: options.token,
			target: "ListAvailableModels",
			body: {
				origin: "KIRO_CLI",
				...(options.profileArn ? { profileArn: options.profileArn } : {}),
				...(nextToken ? { nextToken } : {}),
			},
			fetch: options.fetch,
			signal: options.signal,
		});
		const catalog = sanitizeKiroModelCatalog(payload);
		for (const model of catalog.models) {
			if (seenIds.has(model.modelId)) continue;
			if (models.length >= MAX_MODELS) {
				logger.warn("Kiro model list truncated", { maxModels: MAX_MODELS });
				return { models };
			}
			seenIds.add(model.modelId);
			models.push(model);
		}
		nextToken = catalog.nextToken;
		if (!nextToken || seenTokens.has(nextToken)) return { models };
		seenTokens.add(nextToken);
		payload = undefined;
	}
	logger.warn("Kiro model list truncated", { maxPages: MAX_PAGES });
	return { models };
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
export function resolveKiroDiscoveryRoute(credential: KiroCredential): KiroDiscoveryRoute | null {
	if (credential.kind === "oauth") {
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
		let firstPage: unknown;
		if (credential.kind === "api_key" && !credential.apiEndpoint) {
			// An env key with no `KIRO_API_REGION` (the codec applies that pin).
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
			firstPage = probed.payload;
		} else {
			route = resolveKiroDiscoveryRoute(credential);
			if (!route) {
				logger.debug("Kiro model discovery skipped: route unresolved");
				return null;
			}
		}

		const catalog = await listKiroModels({
			apiRegion: route.apiRegion,
			token: credential.token,
			...(credential.kind === "oauth" && route.profileArn ? { profileArn: route.profileArn } : {}),
			fetch: options.fetch,
			signal: options.signal,
			firstPage,
		});
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
