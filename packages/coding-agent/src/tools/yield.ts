/**
 * Submit result tool for structured subagent output.
 *
 * Subagents must call this tool to finish and return structured JSON output.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@pk-nerdsaver-ai/pi-agent-core";
import type { TSchema } from "@pk-nerdsaver-ai/pi-ai/types";
import {
	dereferenceJsonSchema,
	isValidJsonSchema,
	type JsonSchemaValidationResult,
	sanitizeSchemaForStrictMode,
	tryEnforceStrictSchema,
} from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import type { CompletionGateInput } from "../orchestration/completion-gate";
import type { ActiveTaskContractSnapshot } from "../orchestration/task-contract";
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { ToolSession } from ".";
import { buildOutputValidator, formatAllValidationIssues } from "./output-schema-validator";

export interface YieldDetails {
	data: unknown;
	status: "success" | "aborted";
	error?: string;
	/**
	 * Set when the yield tool exhausted its in-tool schema-retry budget
	 * (MAX_SCHEMA_RETRIES) and accepted the data anyway. Surfaced so the
	 * executor's post-mortem finalizer can honor the override instead of
	 * re-rejecting the same payload with `schema_violation` — keeping the
	 * subagent's acceptance and the parent's view of the result in lockstep.
	 */
	schemaOverridden?: boolean;
	/** Set when recoverable completion-gate reminders are exhausted and yield escalates. */
	gateOverridden?: boolean;
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

function wrapYieldParameters(dataSchema: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		description: "submit data or error",
		properties: {
			result: {
				anyOf: [
					{
						type: "object",
						additionalProperties: false,
						description: "task succeeded",
						properties: { data: dataSchema },
						required: ["data"],
					},
					{
						type: "object",
						additionalProperties: false,
						properties: {
							error: { type: "string", description: "error message" },
						},
						required: ["error"],
					},
				],
			},
		},
		required: ["result"],
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

/** Recoverable completion-gate reminders before escalating the child result to its parent. */
const MAX_GATE_REMINDERS = 2;

/**
 * Build a CompletionGateInput from yield data and the active contract snapshot.
 *
 * Attempts to extract structured evidence from data that looks like an AssignmentResult
 * (has `evidence` array, `blockers` array, `status` field). Fields absent from the data
 * receive conservative defaults that do not trigger false positives.
 */
export function buildCompletionGateInputFromYield(
	contract: ActiveTaskContractSnapshot,
	data: unknown,
): CompletionGateInput {
	const record =
		data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};

	// Extract criteria evidence from evidence[] items if present
	const criteriaEvidence: Record<string, boolean | "pass" | "fail" | "unproven"> = {};
	const rawEvidence = record.evidence;
	if (Array.isArray(rawEvidence)) {
		for (const item of rawEvidence) {
			if (item !== null && typeof item === "object" && !Array.isArray(item)) {
				const ev = item as Record<string, unknown>;
				const criterionId = typeof ev.criterionId === "string" ? ev.criterionId : undefined;
				const passed = ev.passed;
				const artifactRefs = ev.artifactRefs;
				const hasArtifactRefs = Array.isArray(artifactRefs) && artifactRefs.length > 0;
				const details = ev.details;
				const hasDetails = details !== null && typeof details === "object" && !Array.isArray(details);
				if (criterionId && typeof passed === "boolean") {
					criteriaEvidence[criterionId] =
						passed === false ? "fail" : hasArtifactRefs || hasDetails ? "pass" : "unproven";
				}
			}
		}
	}

	// Blockers from blockers[] field
	const rawBlockers = record.blockers;
	const unresolvedBlockers = Array.isArray(rawBlockers)
		? rawBlockers.filter((b): b is string => typeof b === "string")
		: [];

	// Non-solutions triggered when status is "falsified"
	const status = typeof record.status === "string" ? record.status : undefined;
	const triggeredNonSolutions = status === "falsified" ? ["falsified"] : [];

	// Scope validity: blocked/falsified means scope issue
	const scopeValid = status !== "blocked" || unresolvedBlockers.length === 0;

	const rawDeliverables = record.deliverables;
	const deliverablesPresent =
		Array.isArray(rawDeliverables) &&
		rawDeliverables.every((deliverable): deliverable is string => typeof deliverable === "string")
			? rawDeliverables
			: [];

	return {
		contract,
		deliverablesPresent,
		criteriaEvidence,
		triggeredNonSolutions,
		requiredEvidencePresent:
			contract.completionCriteria.length === 0 ||
			contract.completionCriteria.every(criterion => Object.hasOwn(criteriaEvidence, criterion.id)),
		unresolvedBlockers,
		scopeValid,
	};
}

export class YieldTool implements AgentTool<TSchema, YieldDetails> {
	readonly name = "yield";
	readonly approval = "read" as const;
	readonly label = "Submit Result";
	readonly description =
		"Finish the task with structured JSON output. Call exactly once at the end of the task.\n\n" +
		'Pass `result: { data: <your output> }` for success, or `result: { error: "message" }` for failure.\n' +
		"The `data`/`error` wrapper is required — do not put your output directly in `result`.";
	readonly parameters: TSchema;
	strict = true;
	readonly intent = "omit" as const;
	lenientArgValidation = true;

	readonly #validate?: (value: unknown) => JsonSchemaValidationResult;
	readonly #assignmentContractActive: boolean;
	readonly #evaluateGate?: ToolSession["evaluateRootCompletionGate"];
	readonly #getContract?: ToolSession["getActiveTaskContract"];
	#schemaValidationFailures = 0;
	#gateRejectionCount = 0;
	#lastGateContract?: ActiveTaskContractSnapshot;

	constructor(session: ToolSession) {
		this.#assignmentContractActive = session.assignmentContractActive === true;
		this.#evaluateGate = session.evaluateRootCompletionGate;
		this.#getContract = session.getActiveTaskContract;
		let validate: ((value: unknown) => JsonSchemaValidationResult) | undefined;
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
					this.strict = false;
				}
			} else if (!schemaError && normalized === true) {
				sanitizedSchema = {};
				this.strict = false;
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
				dataSchema = resolved;
			} else {
				this.strict = false;
				dataSchema = looseRecordSchema(
					schemaError ? schemaDescription : "Structured JSON output (no schema specified)",
				);
			}
			parameters = wrapYieldParameters(dataSchema);
			JSON.stringify(parameters);
			if (!isValidJsonSchema(parameters)) throw new Error("yield parameters schema is invalid");
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			parameters = wrapYieldParameters(
				looseRecordSchema(`Structured JSON output (schema processing failed: ${errorMsg})`),
			);
			validate = undefined;
			this.strict = false;
		}

		this.#validate = validate;
		this.parameters = parameters;
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<YieldDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<YieldDetails>> {
		const raw = params as Record<string, unknown>;
		const rawResult = raw.result;
		if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
			throw new Error("result must be an object containing either data or error");
		}

		const resultRecord = rawResult as Record<string, unknown>;
		const errorMessage = typeof resultRecord.error === "string" ? resultRecord.error : undefined;
		const data = resultRecord.data;

		if (errorMessage !== undefined && data !== undefined) {
			throw new Error("result cannot contain both data and error");
		}
		if (errorMessage === undefined && data === undefined) {
			throw new Error(
				'result must contain either `data` or `error`. Use `{result: {data: <your output>}}` for success or `{result: {error: "message"}}` for failure.',
			);
		}

		const status = errorMessage !== undefined ? "aborted" : "success";
		let schemaValidationOverridden = false;
		let gateOverridden = false;
		if (status === "success") {
			if (data === undefined || data === null) {
				throw new Error("data is required when yield indicates success");
			}
			if (this.#validate) {
				const parsed = this.#validate(data);
				if (!parsed.success) {
					this.#schemaValidationFailures++;
					if (this.#assignmentContractActive) {
						throw new Error(
							`Output does not match schema: ${formatAllValidationIssues(parsed.issues)}. Call yield again with the corrected shape — the assignment contract remains enforced.`,
						);
					}
					if (this.#schemaValidationFailures <= MAX_SCHEMA_RETRIES) {
						const remaining = MAX_SCHEMA_RETRIES - this.#schemaValidationFailures;
						const retryHint =
							remaining > 0
								? ` Call yield again with the corrected shape — ${remaining} retry attempt(s) remain before the schema constraint is dropped.`
								: " Call yield again with the corrected shape — this is the final retry before the schema constraint is dropped.";
						throw new Error(
							`Output does not match schema: ${formatAllValidationIssues(parsed.issues)}.${retryHint}`,
						);
					}
					schemaValidationOverridden = true;
				}
			}
		}

		// Completion gate enforcement: when an assignment contract is active and we have
		// a gate evaluator, check structured criteria evidence from the yield data before
		// accepting a success yield. Recoverable → inject a reminder and reject the yield.
		if (status === "success" && this.#evaluateGate && this.#getContract) {
			const contract = this.#getContract();
			if (contract) {
				const gateInput = buildCompletionGateInputFromYield(contract, data);
				if (contract !== this.#lastGateContract) {
					this.#lastGateContract = contract;
					this.#gateRejectionCount = 0;
				}
				const evaluation = this.#evaluateGate(gateInput);
				if (evaluation.outcome === "recoverable" && evaluation.reminder) {
					if (this.#gateRejectionCount < MAX_GATE_REMINDERS) {
						this.#gateRejectionCount++;
						throw new Error(
							`Completion gate: ${evaluation.reminder} — address these before calling yield again.`,
						);
					}
					gateOverridden = true;
				}
			}
		}

		const responseText =
			status === "aborted"
				? `Task aborted: ${errorMessage}`
				: schemaValidationOverridden
					? `Result submitted (schema validation overridden after ${this.#schemaValidationFailures} failed attempt(s)).`
					: gateOverridden
						? `Result submitted (completion gate overridden after ${MAX_GATE_REMINDERS} reminder(s)).`
						: "Result submitted.";
		return {
			content: [{ type: "text", text: responseText }],
			details: {
				data,
				status,
				error: errorMessage,
				schemaOverridden: schemaValidationOverridden || undefined,
				gateOverridden: gateOverridden || undefined,
			},
		};
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
			schemaOverridden: record.schemaOverridden === true ? true : undefined,
			gateOverridden: record.gateOverridden === true ? true : undefined,
		};
	},
	shouldTerminate: event => !event.isError,
});
