/**
 * Result submission tool for subagent output.
 *
 * Subagents can call this tool incrementally or terminally depending on `type`.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai/types";
import {
	dereferenceJsonSchema,
	isValidJsonSchema,
	type JsonSchemaValidationResult,
	sanitizeSchemaForStrictMode,
	tryEnforceStrictSchema,
} from "@oh-my-pi/pi-ai/utils/schema";
import { prompt } from "@oh-my-pi/pi-utils";
import yieldDescription from "../prompts/tools/yield.md" with { type: "text" };
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { WorkPoolYieldItem } from "../task/workpool-yield";
import type { ToolSession } from ".";
import { buildOutputValidator, formatAllValidationIssues } from "./output-schema-validator";

const YIELD_FORMAT_HINT = 'Submit success as {"data":<your output>} or failure as {"error":"message"}.';

export interface YieldDetails {
	/** Successful result payload, or omitted when `useLastTurn` requests last-turn extraction. */
	data?: unknown;
	status: "success" | "aborted";
	error?: string;
	/** Optional result section/classification supplied by the yield caller. */
	type?: string | string[];
	/** True when the caller intentionally omitted success data so the executor uses the last assistant turn. */
	useLastTurn?: boolean;
	/** True when this incremental workpool yield completed every item in the active batch. */
	complete?: boolean;
	/**
	 * Set when the yield tool exhausted its in-tool schema-retry budget
	 * (MAX_SCHEMA_RETRIES) and accepted the data anyway. Surfaced so the
	 * executor's post-mortem finalizer can honor the override instead of
	 * re-rejecting the same payload with `schema_violation` — keeping the
	 * subagent's acceptance and the parent's view of the result in lockstep.
	 */
	schemaOverridden?: boolean;
}

function formatSchema(schema: unknown): string {
	if (schema === undefined) return "No schema provided.";
	if (typeof schema === "string") return schema;
	try {
		return JSON.stringify(schema, null, 2);
	} catch {
		return "[unserializable schema]";
	}
}

function looseRecordSchema(description: string): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: true,
		description,
	};
}

function hasUnresolvedRefs(schema: unknown): boolean {
	if (schema == null) return false;
	if (Array.isArray(schema)) {
		for (const item of schema) {
			if (hasUnresolvedRefs(item)) return true;
		}
		return false;
	}
	if (typeof schema !== "object") return false;
	const record = schema as Record<string, unknown>;
	if (typeof record.$ref === "string") return true;
	for (const key in record) {
		if (key === "const" || key === "default" || key === "enum" || key === "examples") continue;
		if (hasUnresolvedRefs(record[key])) return true;
	}
	return false;
}

const yieldTypeSchema: Record<string, unknown> = {
	anyOf: [
		{ type: "string" },
		{
			type: "array",
			minItems: 1,
			items: { type: "string" },
		},
	],
	description: "Optional result type. A non-empty string array is incremental; a string is terminal.",
};

function isYieldType(value: unknown): value is string | string[] {
	return (
		typeof value === "string" ||
		(Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string"))
	);
}

function parseYieldType(value: unknown): string | string[] | undefined {
	// Strict-mode providers (OpenAI/Codex) make the optional `type` property
	// required+nullable, so an untyped final yield arrives as `type: null`.
	if (value === undefined || value === null) return undefined;
	if (isYieldType(value)) return value;
	throw new Error("type must be a string or non-empty array of strings");
}
/** Parse a `{`/`[`-leading JSON string; undefined on non-container or parse failure. */
function parseJsonContainerString(value: string): unknown {
	const trimmed = value.trim();
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the optional `error` argument. Strict-mode providers (OpenAI/Codex) send
 * omitted optionals as `null`, so null and undefined both mean "no error".
 */
function parseYieldError(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	throw new Error("error must be a string");
}

/**
 * Render an incremental yield's `type: [...]` labels as a quoted, comma-separated list for
 * model-facing retry messages — keeps the failed section labelled even when the yield carried
 * multiple labels at once.
 */
function formatYieldLabels(labels: readonly string[]): string {
	if (labels.length === 0) return '""';
	return labels.map(label => `"${label}"`).join(", ");
}

/**
 * Expand a plain-object `data` schema into a strict union that ALSO accepts each
 * top-level section value (and array element) on its own. Agents that yield
 * incrementally (`type: ["findings"]`, `type: ["confidence"]`, …) submit one
 * section per call, so `data` is a single finding object or a lone verdict value
 * — never the full output object. Without this, strict-mode providers constrain
 * `data` to the whole schema and reject/—under constrained decoding—forbid the
 * partial. Every branch is a typed sub-schema, so strict representability holds;
 * the full-output object stays the first (terminal) branch. The assembled whole
 * is still validated against the full schema at finalization. Non-object / loose
 * schemas are returned unchanged.
 */
function withSectionVariants(dataSchema: Record<string, unknown>): Record<string, unknown> {
	if (dataSchema.type !== "object") return dataSchema;
	const props = dataSchema.properties;
	if (props === null || typeof props !== "object") return dataSchema;
	const propRecord = props as Record<string, unknown>;
	const { description, ...fullWithoutDescription } = dataSchema;
	const branches: unknown[] = [];
	const seen = new Set<string>();
	const add = (schema: unknown): void => {
		if (schema === null || typeof schema !== "object") return;
		const key = JSON.stringify(schema);
		if (seen.has(key)) return;
		seen.add(key);
		branches.push(schema);
	};
	add(fullWithoutDescription);
	for (const name in propRecord) {
		const prop = propRecord[name];
		add(prop);
		if (prop !== null && typeof prop === "object") {
			const propObj = prop as Record<string, unknown>;
			if (propObj.type === "array") add(propObj.items);
		}
	}
	if (branches.length <= 1) return dataSchema;
	return description !== undefined ? { description, anyOf: branches } : { anyOf: branches };
}

function wrapWorkPoolYieldParameters(items: readonly WorkPoolYieldItem[]): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		description: "submit one workpool item outcome",
		properties: {
			key: {
				enum: items.map(item => item.index),
				description: "1-based workpool item number",
			},
			data: { description: "Self-contained outcome and evidence for this item" },
			error: { type: "string", description: "Failure reason for this item" },
		},
		required: ["key"],
	};
}

function resolveWorkPoolYieldItem(items: readonly WorkPoolYieldItem[], value: unknown): WorkPoolYieldItem {
	const item =
		typeof value === "number" && Number.isInteger(value)
			? items.find(candidate => candidate.index === value)
			: undefined;
	if (item) return item;
	throw new Error(`key must be one of: ${items.map(candidate => candidate.index).join(", ")}`);
}

function buildYieldParameters(dataSchema: Record<string, unknown>): Record<string, unknown> {
	// `data` xor `error`, and "omitted data requires a `type`", are enforced in
	// `execute()` at runtime, NOT in this schema: a top-level combinator
	// (`allOf`/`anyOf`/`oneOf`/...) makes OpenAI/Codex Responses reject the whole
	// tool with `invalid_function_parameters`, so the parameters stay a plain
	// object with optional properties (strict enforcement makes them nullable).
	return {
		type: "object",
		additionalProperties: false,
		description: "submit data or error",
		properties: {
			type: yieldTypeSchema,
			data: dataSchema,
			error: { type: "string", description: "Failure reason; mutually exclusive with data" },
		},
		required: [],
	};
}

/**
 * Max consecutive schema-validation failures before the yield tool overrides validation
 * and lets non-conforming data through. The override is a safety net for schemas the
 * JTD→JSON-Schema converter cannot fully express; it should not be reached during normal
 * model retries. Three matches the existing "3 reminders" pattern elsewhere in the agent
 * runtime.
 */
const MAX_SCHEMA_RETRIES = 3;

/**
 * Max consecutive untyped empty-result submissions before the yield tool fails
 * the child explicitly. Some weak tool callers can acknowledge the required
 * shape in prose while repeatedly sending `{}`; without a hard stop the parent
 * waits forever.
 */
const MAX_EMPTY_RESULT_RETRIES = 3;

export class YieldTool implements AgentTool<TSchema, YieldDetails> {
	readonly name = "yield";
	readonly approval = "read" as const;
	readonly label = "Submit Result";
	readonly intent = "omit" as const;
	lenientArgValidation = true;

	readonly #validate?: (value: unknown) => JsonSchemaValidationResult;
	readonly #validateSection?: ReadonlyMap<string, (value: unknown) => JsonSchemaValidationResult>;
	#rejectUnknownSections = false;
	#knownSectionLabels: readonly string[] = [];
	#isKnownSection?: (label: string) => boolean;
	#schemaStrict = true;
	#schemaValidationFailures = 0;
	#emptyResultFailures = 0;
	#hasIncrementalSections = false;
	readonly #session: ToolSession;
	readonly #parameters: TSchema;
	#workPoolBatchKey = "";
	readonly #submittedWorkPoolItems = new Set<string>();

	get strict(): boolean {
		return this.#workPoolItems().length === 0 && this.#schemaStrict;
	}

	get description(): string {
		return prompt.render(yieldDescription, {
			hasOutputSchema: this.#validate !== undefined,
			workPoolItems: this.#workPoolItems().length > 0,
		});
	}

	get parameters(): TSchema {
		const items = this.#workPoolItems();
		return items.length > 0 ? wrapWorkPoolYieldParameters(items) : this.#parameters;
	}

	constructor(session: ToolSession) {
		let validate: ((value: unknown) => JsonSchemaValidationResult) | undefined;
		let validateSection: ReadonlyMap<string, (value: unknown) => JsonSchemaValidationResult> | undefined;
		let rejectUnknownSections = false;
		let knownSectionLabels: readonly string[] = [];
		let isKnownSection: ((label: string) => boolean) | undefined;
		let parameters: TSchema;

		try {
			const {
				validator,
				jsonSchema: normalizedSchema,
				normalized,
				error: schemaError,
			} = buildOutputValidator(session.outputSchema);
			if (validator) {
				validate = value => validator.validate(value);
				validateSection = validator.validateSection;
				rejectUnknownSections = validator.rejectUnknownSections;
				knownSectionLabels = validator.knownSectionLabels;
				isKnownSection = label => validator.isKnownSection(label);
			}

			const schemaHint = formatSchema(normalizedSchema ?? session.outputSchema);
			const schemaDescription = schemaError
				? `Structured JSON output (output schema invalid; accepting unconstrained object): ${schemaError}`
				: `Structured output matching the schema:\n${schemaHint}`;
			let sanitizedSchema: Record<string, unknown> | undefined;
			if (!schemaError && normalizedSchema !== undefined) {
				const strictProbe = tryEnforceStrictSchema(normalizedSchema);
				if (strictProbe.strict) {
					sanitizedSchema = sanitizeSchemaForStrictMode(normalizedSchema);
				} else {
					sanitizedSchema = normalizedSchema;
					this.#schemaStrict = false;
				}
			} else if (!schemaError && normalized === true) {
				sanitizedSchema = {};
				this.#schemaStrict = false;
			}

			let dataSchema: Record<string, unknown>;
			if (sanitizedSchema !== undefined) {
				const resolved = dereferenceJsonSchema({
					...sanitizedSchema,
					description: schemaDescription,
				}) as Record<string, unknown>;
				if (hasUnresolvedRefs(resolved)) {
					throw new Error("schema contains unresolved $ref after dereferencing");
				}
				dataSchema = withSectionVariants(resolved);
			} else {
				this.#schemaStrict = false;
				dataSchema = looseRecordSchema(
					schemaError ? schemaDescription : "Structured JSON output (no schema specified)",
				);
			}
			parameters = buildYieldParameters(dataSchema);
			JSON.stringify(parameters);
			if (!isValidJsonSchema(parameters)) throw new Error("yield parameters schema is invalid");
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			parameters = buildYieldParameters(
				looseRecordSchema(`Structured JSON output (schema processing failed: ${errorMsg})`),
			);
			validate = undefined;
			this.#schemaStrict = false;
		}

		this.#session = session;
		this.#validate = validate;
		this.#validateSection = validateSection;
		this.#rejectUnknownSections = rejectUnknownSections;
		this.#knownSectionLabels = knownSectionLabels;
		this.#isKnownSection = isKnownSection;
		this.#parameters = parameters;
	}

	#workPoolItems(): readonly WorkPoolYieldItem[] {
		const items = this.#session.getWorkPoolYieldItems?.() ?? [];
		const key = items.map(item => `${item.index}:${item.id}`).join("\0");
		if (key !== this.#workPoolBatchKey) {
			this.#workPoolBatchKey = key;
			this.#submittedWorkPoolItems.clear();
		}
		return items;
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<YieldDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<YieldDetails>> {
		if (!isPlainRecord(params)) throw new Error("yield arguments must be an object");
		const raw = params;
		const workPoolItems = this.#workPoolItems();
		let workPoolItemId: string | undefined;
		let yieldType: string | string[] | undefined;
		// Strict-mode providers send omitted optionals as `null`; treat it as absent.
		let data: unknown = raw.data === null ? undefined : raw.data;
		const errorMessage = parseYieldError(raw.error);
		if (workPoolItems.length > 0) {
			const item = resolveWorkPoolYieldItem(workPoolItems, raw.key);
			workPoolItemId = item.id;
			if (this.#submittedWorkPoolItems.has(item.id)) {
				throw new Error(`workpool item ${item.index} was already submitted`);
			}
			if ((data === undefined) === (errorMessage === undefined)) {
				throw new Error("workpool yield requires exactly one of data or error");
			}
			yieldType = [item.id];
		} else {
			yieldType = parseYieldType(raw.type);
		}
		const useLastTurn = errorMessage === undefined && data === undefined && yieldType !== undefined;
		// Incremental array-typed sections carry partial data (one finding, one
		// field) that cannot satisfy the full output schema; the assembled result
		// is validated as a whole at finalization (executor finalizeSubprocessOutput).
		const isIncremental = Array.isArray(yieldType) && yieldType.length > 0;

		if (errorMessage !== undefined && data !== undefined) {
			throw new Error("yield cannot contain both data and error");
		}
		if (errorMessage === undefined && data === undefined && yieldType === undefined) {
			this.#emptyResultFailures++;
			if (this.#emptyResultFailures > MAX_EMPTY_RESULT_RETRIES) {
				const attemptCount = this.#emptyResultFailures;
				this.#emptyResultFailures = 0;
				const error = `yield result stayed empty after ${attemptCount} consecutive attempt(s); aborting child instead of retrying forever. ${YIELD_FORMAT_HINT}`;
				return {
					content: [{ type: "text", text: `Task aborted: ${error}` }],
					details: {
						data: undefined,
						status: "aborted",
						error,
						type: yieldType,
					},
				};
			}
			const remaining = MAX_EMPTY_RESULT_RETRIES - this.#emptyResultFailures;
			throw new Error(
				`yield must contain either \`data\` or \`error\`. ${YIELD_FORMAT_HINT} Empty untyped result retries remaining before abort: ${remaining}.`,
			);
		}

		const status = errorMessage !== undefined ? "aborted" : "success";
		let schemaValidationOverridden = false;
		// Unknown incremental labels are a hard contract mismatch with the closed caller
		// schema. Reject before the last-turn short-circuit too: `type: ["findings"], result: {}`
		// would otherwise be accepted as a typed last-turn incremental yield, then a sibling
		// section's MAX_SCHEMA_RETRIES override flips schemaOverridden in finalization and the
		// stale section rides along untouched.
		if (status === "success" && isIncremental && workPoolItemId === undefined) {
			const unknownLabels = this.#unknownIncrementalLabels(yieldType as string[]);
			if (unknownLabels.length > 0) {
				const validLabels =
					this.#knownSectionLabels.length > 0 ? formatYieldLabels(this.#knownSectionLabels) : "none";
				throw new Error(
					`Section ${formatYieldLabels(yieldType as string[])} uses unknown incremental yield label(s): ${formatYieldLabels(unknownLabels)}. Resubmit with one of the schema's labels: ${validLabels}.`,
				);
			}
		}
		// A schema-bound terminal last-turn yield with no accumulated sections can
		// only assemble raw prose, which finalization then rejects post-mortem as a
		// fatal schema_violation the child can no longer correct. Catch it here as
		// a retryable error instead. With sections present, a data-less finalize
		// legitimately closes the incremental flow (assembly keeps the sections).
		if (status === "success" && useLastTurn && !isIncremental && this.#validate && !this.#hasIncrementalSections) {
			throw new Error(
				"This task requires structured output matching the declared schema; a last-turn result cannot satisfy it. " +
					`Submit the full object: {"data":<object matching the schema>}.`,
			);
		}
		if (status === "success" && !useLastTurn) {
			const validateData = (value: unknown): JsonSchemaValidationResult | undefined =>
				workPoolItemId !== undefined
					? undefined
					: isIncremental
						? this.#validateIncrementalSection(yieldType as string[], value)
						: this.#validate
							? this.#validate(value)
							: undefined;
			let sectionFailure = validateData(data);
			if (sectionFailure && !sectionFailure.success && typeof data === "string") {
				// Lossless recovery: a JSON-encoded payload string parses to exactly
				// the intended value (executor finalization already parses terminal
				// yields the same way). Never the reverse — stringifying objects to
				// fit string-typed fields is silent corruption.
				const parsed = parseJsonContainerString(data);
				if (parsed !== undefined) {
					const revalidated = validateData(parsed);
					if (revalidated === undefined || revalidated.success) {
						data = parsed;
						sectionFailure = revalidated;
					}
				}
			}
			if (sectionFailure && !sectionFailure.success) {
				this.#schemaValidationFailures++;
				if (this.#schemaValidationFailures <= MAX_SCHEMA_RETRIES) {
					const remaining = MAX_SCHEMA_RETRIES - this.#schemaValidationFailures;
					const retryHint =
						remaining > 0
							? ` Call yield again with the corrected shape — ${remaining} retry attempt(s) remain before the schema constraint is dropped.`
							: " Call yield again with the corrected shape — this is the final retry before the schema constraint is dropped.";
					const scope = isIncremental ? `Section ${formatYieldLabels(yieldType as string[])}` : "Output";
					throw new Error(
						`${scope} does not match schema: ${formatAllValidationIssues(sectionFailure.issues)}.${retryHint}`,
					);
				}
				schemaValidationOverridden = true;
			}
		}

		this.#emptyResultFailures = 0;
		if (status === "success" && isIncremental) this.#hasIncrementalSections = true;
		let workPoolComplete = false;
		let completedWorkPoolItem: WorkPoolYieldItem | undefined;
		let remainingWorkPoolItems: readonly WorkPoolYieldItem[] = [];
		if (status === "success" && workPoolItemId !== undefined) {
			completedWorkPoolItem = workPoolItems.find(item => item.id === workPoolItemId);
			this.#submittedWorkPoolItems.add(workPoolItemId);
			remainingWorkPoolItems = workPoolItems.filter(item => !this.#submittedWorkPoolItems.has(item.id));
			workPoolComplete = remainingWorkPoolItems.length === 0;
		}
		const responseText =
			status === "aborted"
				? `Task aborted: ${errorMessage}`
				: completedWorkPoolItem !== undefined
					? workPoolComplete
						? `Item ${completedWorkPoolItem.index} submitted. All workpool items are complete; ending this turn.`
						: `Item ${completedWorkPoolItem.index} submitted. Remaining item(s): ${remainingWorkPoolItems.map(item => item.index).join(", ")}.`
					: schemaValidationOverridden
						? `Result submitted (schema validation overridden after ${this.#schemaValidationFailures} failed attempt(s)).`
						: "Result submitted.";
		return {
			content: [{ type: "text", text: responseText }],
			details: {
				data,
				status,
				error: errorMessage,
				type: yieldType,
				useLastTurn: useLastTurn || undefined,
				complete: workPoolComplete || undefined,
				schemaOverridden: schemaValidationOverridden || undefined,
			},
		};
	}

	/**
	 * Return incremental yield labels the closed caller schema does not accept. Closure covers the
	 * root, `allOf` conjuncts, and `oneOf`/`anyOf` unions whose every variant is closed (e.g. JTD
	 * discriminators). Open schemas accept any label.
	 */
	#unknownIncrementalLabels(labels: string[]): string[] {
		if (!this.#rejectUnknownSections) return [];
		const isKnown = this.#isKnownSection;
		if (!isKnown) return [];
		return labels.filter(label => !isKnown(label));
	}

	/**
	 * Validate the `data` payload of an incremental yield (`type: ["<label>", …]`) against
	 * the matching property's sub-validator. Returns the first failure across all known labels,
	 * or `undefined` when no label is recognised (user-defined section labels stay loose) or
	 * when all known labels accept the value. Lets the model see the same retry feedback that
	 * the terminal-yield path already produces, instead of leaking the mismatch through to
	 * the parent's post-mortem `schema_violation`. Unknown labels under a closed schema are
	 * handled separately by `#unknownIncrementalLabels` and never reach this validator.
	 */
	#validateIncrementalSection(labels: string[], data: unknown): JsonSchemaValidationResult | undefined {
		const subValidators = this.#validateSection;
		if (!subValidators || subValidators.size === 0) return undefined;
		for (const label of labels) {
			const sub = subValidators.get(label);
			if (!sub) continue;
			const parsed = sub(data);
			if (!parsed.success) return parsed;
		}
		return undefined;
	}
}

// Register subprocess tool handler for extraction + termination.
subprocessToolRegistry.register<YieldDetails>("yield", {
	extractData: event => {
		const details = event.result?.details;
		if (!details || typeof details !== "object") return undefined;
		const record = details as Record<string, unknown>;
		const status = record.status;
		if (status !== "success" && status !== "aborted") return undefined;
		return {
			data: record.data,
			status,
			error: typeof record.error === "string" ? record.error : undefined,
			type: isYieldType(record.type) ? record.type : undefined,
			useLastTurn: record.useLastTurn === true ? true : undefined,
			complete: record.complete === true ? true : undefined,
			schemaOverridden: record.schemaOverridden === true ? true : undefined,
		};
	},
	shouldTerminate: event => {
		if (event.isError) return false;
		const details = event.result?.details;
		if (!details || typeof details !== "object") return true;
		const record = details as Record<string, unknown>;
		if (record.complete === true) return true;
		return !(
			record.status === "success" &&
			Array.isArray(record.type) &&
			record.type.length > 0 &&
			record.type.every(item => typeof item === "string")
		);
	},
});
