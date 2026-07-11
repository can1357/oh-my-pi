/**
 * Append-only evidence ledger for orchestration planning.
 *
 * Every material claim produced during a job or planning session must be recorded
 * here, tied to criterion IDs, so the root completion gate can traverse from
 * criterion to concrete evidence. Progress prose alone is not evidence.
 */

export const EVIDENCE_RECORD_VERSION = "ompk.evidence-record/v1" as const;

export type EvidenceKind = "command" | "test" | "source" | "artifact" | "runtime" | "review" | "cleanup";
export type EvidenceStatus = "supports" | "contradicts" | "partial" | "blocked";
export type RedactionStatus = "clean" | "redacted" | "blocked";

export interface EvidenceRecordV1 {
	readonly version: typeof EVIDENCE_RECORD_VERSION;
	readonly id: string;
	readonly taskContractId: string;
	readonly reasoningPlanId?: string;
	readonly moduleInstanceId?: string;
	readonly criterionIds: readonly string[];
	readonly claim: string;
	readonly kind: EvidenceKind;
	readonly locator: string;
	readonly digest?: string;
	readonly exitCode?: number;
	readonly timestamp: string;
	readonly status: EvidenceStatus;
	readonly redactionStatus: RedactionStatus;
}

const VALID_KINDS = new Set<EvidenceKind>(["command", "test", "source", "artifact", "runtime", "review", "cleanup"]);
const VALID_STATUSES = new Set<EvidenceStatus>(["supports", "contradicts", "partial", "blocked"]);
const VALID_REDACTIONS = new Set<RedactionStatus>(["clean", "redacted", "blocked"]);

export type EvidenceLedgerDiagnostic = { readonly code: string; readonly message: string };

export type AppendEvidenceResult =
	| { ok: true; record: EvidenceRecordV1 }
	| { ok: false; diagnostics: readonly EvidenceLedgerDiagnostic[] };

export interface EvidenceLedgerSnapshot {
	readonly records: readonly EvidenceRecordV1[];
	readonly taskContractId: string;
	readonly createdAt: string;
	readonly snapshotAt: string;
	readonly count: number;
}

/** Input for appending an evidence record; id and timestamp are generated. */
export type AppendEvidenceInput = Omit<EvidenceRecordV1, "id" | "timestamp" | "version">;

let _idCounter = 0;
function generateId(prefix: string): string {
	_idCounter += 1;
	return `${prefix}-${Date.now()}-${_idCounter}`;
}

function validateAppendInput(input: AppendEvidenceInput): readonly EvidenceLedgerDiagnostic[] {
	const diagnostics: EvidenceLedgerDiagnostic[] = [];
	if (!input.taskContractId?.trim())
		diagnostics.push({ code: "missing_field", message: "taskContractId is required" });
	if (!input.claim?.trim()) diagnostics.push({ code: "missing_field", message: "claim is required" });
	if (!input.locator?.trim()) diagnostics.push({ code: "missing_field", message: "locator is required" });
	if (!VALID_KINDS.has(input.kind))
		diagnostics.push({ code: "invalid_field", message: `kind "${input.kind}" is not valid` });
	if (!VALID_STATUSES.has(input.status))
		diagnostics.push({ code: "invalid_field", message: `status "${input.status}" is not valid` });
	if (!VALID_REDACTIONS.has(input.redactionStatus))
		diagnostics.push({
			code: "invalid_field",
			message: `redactionStatus "${input.redactionStatus}" is not valid`,
		});
	if (!Array.isArray(input.criterionIds) || input.criterionIds.some(id => typeof id !== "string")) {
		diagnostics.push({ code: "invalid_field", message: "criterionIds must be a string array" });
	}
	return diagnostics;
}

/**
 * Append-only evidence ledger for a single task contract.
 *
 * Records are immutable once appended. The ledger is keyed by `taskContractId`
 * and provides criterion-aware queries used by the root completion gate.
 */
export class EvidenceLedger {
	readonly #taskContractId: string;
	readonly #records: EvidenceRecordV1[] = [];
	readonly #createdAt: string;

	constructor(taskContractId: string) {
		this.#taskContractId = taskContractId;
		this.#createdAt = new Date().toISOString();
	}

	get taskContractId(): string {
		return this.#taskContractId;
	}

	get size(): number {
		return this.#records.length;
	}

	append(input: AppendEvidenceInput): AppendEvidenceResult {
		const diagnostics = validateAppendInput(input);
		if (diagnostics.length > 0) return { ok: false, diagnostics };
		if (input.taskContractId !== this.#taskContractId) {
			return {
				ok: false,
				diagnostics: [
					{
						code: "contract_mismatch",
						message: `Record taskContractId "${input.taskContractId}" does not match ledger "${this.#taskContractId}"`,
					},
				],
			};
		}
		const record: EvidenceRecordV1 = Object.freeze({
			version: EVIDENCE_RECORD_VERSION,
			id: generateId("ev"),
			timestamp: new Date().toISOString(),
			taskContractId: input.taskContractId,
			reasoningPlanId: input.reasoningPlanId,
			moduleInstanceId: input.moduleInstanceId,
			criterionIds: Object.freeze([...input.criterionIds]),
			claim: input.claim.trim(),
			kind: input.kind,
			locator: input.locator.trim(),
			digest: input.digest?.trim() || undefined,
			exitCode: input.exitCode,
			status: input.status,
			redactionStatus: input.redactionStatus,
		});
		this.#records.push(record);
		return { ok: true, record };
	}

	/** All records for a specific criterion ID. */
	forCriterion(criterionId: string): readonly EvidenceRecordV1[] {
		return this.#records.filter(r => r.criterionIds.includes(criterionId));
	}

	/** All supporting records for a criterion (status "supports" or "partial"). */
	supportingForCriterion(criterionId: string): readonly EvidenceRecordV1[] {
		return this.forCriterion(criterionId).filter(r => r.status === "supports" || r.status === "partial");
	}

	/** All contradicting records for a criterion. */
	contradictingForCriterion(criterionId: string): readonly EvidenceRecordV1[] {
		return this.forCriterion(criterionId).filter(r => r.status === "contradicts");
	}

	/**
	 * Evaluate coverage for a set of criterion IDs.
	 *
	 * Returns a map from criterion ID to evidence status:
	 * - "pass": at least one supporting/partial record, no contradicting records
	 * - "fail": at least one contradicting record
	 * - "unproven": no supporting/partial records, no contradicting records
	 * - "contradicted": supporting evidence exists but is contradicted
	 */
	evaluateCriterionCoverage(
		criterionIds: readonly string[],
	): Readonly<Record<string, "pass" | "fail" | "unproven" | "contradicted">> {
		const coverage: Record<string, "pass" | "fail" | "unproven" | "contradicted"> = {};
		for (const id of criterionIds) {
			const supporting = this.supportingForCriterion(id);
			const contradicting = this.contradictingForCriterion(id);
			if (contradicting.length > 0 && supporting.length > 0) {
				coverage[id] = "contradicted";
			} else if (contradicting.length > 0) {
				coverage[id] = "fail";
			} else if (supporting.length > 0) {
				coverage[id] = "pass";
			} else {
				coverage[id] = "unproven";
			}
		}
		return Object.freeze(coverage);
	}

	/** Records filtered by kind. */
	byKind(kind: EvidenceKind): readonly EvidenceRecordV1[] {
		return this.#records.filter(r => r.kind === kind);
	}

	/** Records filtered by moduleInstanceId. */
	byModule(moduleInstanceId: string): readonly EvidenceRecordV1[] {
		return this.#records.filter(r => r.moduleInstanceId === moduleInstanceId);
	}

	/** All records in append order. */
	all(): readonly EvidenceRecordV1[] {
		return Object.freeze([...this.#records]);
	}

	/** Immutable snapshot of the ledger state for serialization or handoff. */
	snapshot(): EvidenceLedgerSnapshot {
		return Object.freeze({
			records: Object.freeze([...this.#records]),
			taskContractId: this.#taskContractId,
			createdAt: this.#createdAt,
			snapshotAt: new Date().toISOString(),
			count: this.#records.length,
		});
	}
}
