/**
 * Transport-neutral assignment contract and result types.
 *
 * Parent authors the immutable contract (including digest). Children may report
 * evidence and changed files but must not alter acceptance, scope, or commands.
 * Lane E owns Yield/task wiring; this module stays pure.
 */

import { createHash } from "node:crypto";
import type { AgentAutonomy, WorkClass } from "../orchestration/agent-execution-profile";

export const ASSIGNMENT_CONTRACT_VERSION = "assignment-contract/v1" as const;
export const ASSIGNMENT_RESULT_VERSION = "assignment-result/v1" as const;

export type AssignmentContractVersion = typeof ASSIGNMENT_CONTRACT_VERSION;
export type AssignmentResultVersion = typeof ASSIGNMENT_RESULT_VERSION;

export type AssignmentDiagnosticCode =
	| "invalid_type"
	| "invalid_version"
	| "missing_field"
	| "invalid_field"
	| "duplicate_criterion"
	| "digest_mismatch"
	| "empty_value";

export interface AssignmentDiagnostic {
	code: AssignmentDiagnosticCode;
	message: string;
	path?: string;
}

export interface AssignmentScope {
	/** Glob/path prefixes the child may modify. Empty means no file changes allowed. */
	readonly allowedPaths: readonly string[];
	/** Optional explicit deny list; deny wins over allow. */
	readonly deniedPaths?: readonly string[];
}

export type AssignmentProcedureKind = "command" | "note";

export interface AssignmentProcedure {
	readonly id: string;
	readonly kind: AssignmentProcedureKind;
	/** Parent-authored command text. Children must not invent or rewrite this. */
	readonly command?: string;
	readonly note?: string;
}

export type AcceptanceCheckKind =
	| "command_exit"
	| "command_timeout"
	| "command_streams"
	| "artifact_exists"
	| "artifact_size"
	| "artifact_hash"
	| "content_match"
	| "json_schema"
	| "changed_file_scope";

export interface AcceptanceCriterion {
	readonly id: string;
	readonly description: string;
	readonly check: AcceptanceCheckKind;
	/** Parent-authored immutable check payload (command, path, schema, …). */
	readonly params?: Readonly<Record<string, unknown>>;
}

export interface AssignmentContractV1 {
	readonly version: AssignmentContractVersion;
	readonly id: string;
	readonly revision: number;
	readonly digest: string;
	readonly role: string;
	readonly workClass: WorkClass;
	readonly autonomy: AgentAutonomy;
	readonly objective: string;
	readonly deliverables: readonly string[];
	readonly scope: AssignmentScope;
	readonly procedures?: readonly AssignmentProcedure[];
	readonly acceptance: readonly AcceptanceCriterion[];
	readonly reporting: AssignmentResultVersion;
}

export type AssignmentResultStatus = "success" | "failed" | "blocked" | "partial";

export interface AcceptanceEvidence {
	readonly criterionId: string;
	readonly passed: boolean;
	readonly summary: string;
	readonly details?: Readonly<Record<string, unknown>>;
	readonly artifactRefs?: readonly string[];
}

export interface AssignmentResultV1 {
	readonly version: AssignmentResultVersion;
	readonly contractId: string;
	readonly revision: number;
	readonly digest: string;
	readonly status: AssignmentResultStatus;
	readonly changedFiles: readonly string[];
	readonly evidence: readonly AcceptanceEvidence[];
	readonly blockers?: readonly string[];
	readonly summary?: string;
}

/** Canonical fields hashed into `digest`. Excludes `digest` itself. */
export interface AssignmentContractDigestInput {
	readonly version: AssignmentContractVersion;
	readonly id: string;
	readonly revision: number;
	readonly role: string;
	readonly workClass: WorkClass;
	readonly autonomy: AgentAutonomy;
	readonly objective: string;
	readonly deliverables: readonly string[];
	readonly scope: AssignmentScope;
	readonly procedures?: readonly AssignmentProcedure[];
	readonly acceptance: readonly AcceptanceCriterion[];
	readonly reporting: AssignmentResultVersion;
}

export type ParseAssignmentContractResult =
	| { ok: true; contract: AssignmentContractV1 }
	| { ok: false; diagnostics: AssignmentDiagnostic[] };

export type ParseAssignmentResultResult =
	| { ok: true; result: AssignmentResultV1 }
	| { ok: false; diagnostics: AssignmentDiagnostic[] };

const WORK_CLASSES = new Set<WorkClass>(["mechanical", "judgment"]);
const AUTONOMIES = new Set<AgentAutonomy>(["bound", "supervised", "independent"]);
const ACCEPTANCE_CHECKS = new Set<AcceptanceCheckKind>([
	"command_exit",
	"command_timeout",
	"command_streams",
	"artifact_exists",
	"artifact_size",
	"artifact_hash",
	"content_match",
	"json_schema",
	"changed_file_scope",
]);
const RESULT_STATUSES = new Set<AssignmentResultStatus>(["success", "failed", "blocked", "partial"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** Deterministic JSON for digesting: sorted object keys, arrays preserve order. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortValue);
	}
	if (isPlainObject(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = sortValue(value[key]);
		}
		return sorted;
	}
	return value;
}

export function computeAssignmentContractDigest(input: AssignmentContractDigestInput): string {
	const payload = {
		version: input.version,
		id: input.id,
		revision: input.revision,
		role: input.role,
		workClass: input.workClass,
		autonomy: input.autonomy,
		objective: input.objective,
		deliverables: input.deliverables,
		scope: input.scope,
		procedures: input.procedures ?? [],
		acceptance: input.acceptance,
		reporting: input.reporting,
	};
	return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function withAssignmentContractDigest(
	input: Omit<AssignmentContractV1, "digest"> & { digest?: string },
): AssignmentContractV1 {
	const digest = computeAssignmentContractDigest({
		version: input.version,
		id: input.id,
		revision: input.revision,
		role: input.role,
		workClass: input.workClass,
		autonomy: input.autonomy,
		objective: input.objective,
		deliverables: input.deliverables,
		scope: input.scope,
		procedures: input.procedures,
		acceptance: input.acceptance,
		reporting: input.reporting,
	});
	return Object.freeze({
		...input,
		deliverables: Object.freeze([...input.deliverables]),
		scope: Object.freeze({
			allowedPaths: Object.freeze([...input.scope.allowedPaths]),
			deniedPaths: input.scope.deniedPaths ? Object.freeze([...input.scope.deniedPaths]) : undefined,
		}),
		procedures: input.procedures
			? Object.freeze(input.procedures.map(procedure => Object.freeze({ ...procedure })))
			: undefined,
		acceptance: Object.freeze(
			input.acceptance.map(criterion =>
				Object.freeze({
					...criterion,
					params: criterion.params ? Object.freeze({ ...criterion.params }) : undefined,
				}),
			),
		),
		digest,
	});
}

function push(
	diagnostics: AssignmentDiagnostic[],
	code: AssignmentDiagnosticCode,
	message: string,
	path?: string,
): void {
	diagnostics.push(path ? { code, message, path } : { code, message });
}

function requireNonEmptyString(diagnostics: AssignmentDiagnostic[], value: unknown, path: string): string | undefined {
	if (typeof value !== "string") {
		push(diagnostics, "invalid_field", `Expected string at ${path}`, path);
		return undefined;
	}
	if (value.trim().length === 0) {
		push(diagnostics, "empty_value", `Expected non-empty string at ${path}`, path);
		return undefined;
	}
	return value;
}

function parseScope(value: unknown, diagnostics: AssignmentDiagnostic[]): AssignmentScope | undefined {
	if (!isPlainObject(value)) {
		push(diagnostics, "invalid_field", "scope must be an object", "scope");
		return undefined;
	}
	if (!isStringArray(value.allowedPaths)) {
		push(diagnostics, "invalid_field", "scope.allowedPaths must be a string array", "scope.allowedPaths");
		return undefined;
	}
	let deniedPaths: readonly string[] | undefined;
	if (value.deniedPaths !== undefined) {
		if (!isStringArray(value.deniedPaths)) {
			push(diagnostics, "invalid_field", "scope.deniedPaths must be a string array", "scope.deniedPaths");
			return undefined;
		}
		deniedPaths = value.deniedPaths;
	}
	return { allowedPaths: value.allowedPaths, deniedPaths };
}

function parseProcedures(
	value: unknown,
	diagnostics: AssignmentDiagnostic[],
): readonly AssignmentProcedure[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		push(diagnostics, "invalid_field", "procedures must be an array", "procedures");
		return undefined;
	}
	const procedures: AssignmentProcedure[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		const path = `procedures[${i}]`;
		if (!isPlainObject(item)) {
			push(diagnostics, "invalid_field", "procedure must be an object", path);
			continue;
		}
		const id = requireNonEmptyString(diagnostics, item.id, `${path}.id`);
		if (!id) continue;
		if (seen.has(id)) {
			push(diagnostics, "duplicate_criterion", `Duplicate procedure id "${id}"`, `${path}.id`);
			continue;
		}
		seen.add(id);
		const kind = item.kind;
		if (kind !== "command" && kind !== "note") {
			push(diagnostics, "invalid_field", 'procedure.kind must be "command" or "note"', `${path}.kind`);
			continue;
		}
		if (kind === "command" && typeof item.command !== "string") {
			push(diagnostics, "missing_field", "command procedures require command text", `${path}.command`);
			continue;
		}
		procedures.push({
			id,
			kind,
			command: typeof item.command === "string" ? item.command : undefined,
			note: typeof item.note === "string" ? item.note : undefined,
		});
	}
	return procedures;
}

function parseAcceptance(
	value: unknown,
	diagnostics: AssignmentDiagnostic[],
): readonly AcceptanceCriterion[] | undefined {
	if (!Array.isArray(value)) {
		push(diagnostics, "invalid_field", "acceptance must be an array", "acceptance");
		return undefined;
	}
	if (value.length === 0) {
		push(diagnostics, "empty_value", "acceptance must include at least one criterion", "acceptance");
		return undefined;
	}
	const criteria: AcceptanceCriterion[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		const path = `acceptance[${i}]`;
		if (!isPlainObject(item)) {
			push(diagnostics, "invalid_field", "acceptance criterion must be an object", path);
			continue;
		}
		const id = requireNonEmptyString(diagnostics, item.id, `${path}.id`);
		const description = requireNonEmptyString(diagnostics, item.description, `${path}.description`);
		const check = item.check;
		if (typeof check !== "string" || !ACCEPTANCE_CHECKS.has(check as AcceptanceCheckKind)) {
			push(diagnostics, "invalid_field", `Unknown acceptance check "${String(check)}"`, `${path}.check`);
			continue;
		}
		if (!id || !description) continue;
		if (seen.has(id)) {
			push(diagnostics, "duplicate_criterion", `Duplicate acceptance id "${id}"`, `${path}.id`);
			continue;
		}
		seen.add(id);
		let params: Readonly<Record<string, unknown>> | undefined;
		if (item.params !== undefined) {
			if (!isPlainObject(item.params)) {
				push(diagnostics, "invalid_field", "acceptance.params must be an object", `${path}.params`);
				continue;
			}
			params = item.params;
		}
		criteria.push({
			id,
			description,
			check: check as AcceptanceCheckKind,
			params,
		});
	}
	return criteria;
}

/**
 * Parse and structurally validate an assignment contract. Digest mismatch is a
 * diagnostic here; semantic verification lives in assignment-verifier.ts.
 */
export function parseAssignmentContract(input: unknown): ParseAssignmentContractResult {
	const diagnostics: AssignmentDiagnostic[] = [];
	if (!isPlainObject(input)) {
		return {
			ok: false,
			diagnostics: [{ code: "invalid_type", message: "Assignment contract must be an object" }],
		};
	}
	if (input.version !== ASSIGNMENT_CONTRACT_VERSION) {
		push(diagnostics, "invalid_version", `Expected version ${ASSIGNMENT_CONTRACT_VERSION}`, "version");
	}
	const id = requireNonEmptyString(diagnostics, input.id, "id");
	if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 0) {
		push(diagnostics, "invalid_field", "revision must be a non-negative integer", "revision");
	}
	const digest = requireNonEmptyString(diagnostics, input.digest, "digest");
	const role = requireNonEmptyString(diagnostics, input.role, "role");
	if (typeof input.workClass !== "string" || !WORK_CLASSES.has(input.workClass as WorkClass)) {
		push(diagnostics, "invalid_field", 'workClass must be "mechanical" or "judgment"', "workClass");
	}
	if (typeof input.autonomy !== "string" || !AUTONOMIES.has(input.autonomy as AgentAutonomy)) {
		push(diagnostics, "invalid_field", 'autonomy must be "bound", "supervised", or "independent"', "autonomy");
	}
	const objective = requireNonEmptyString(diagnostics, input.objective, "objective");
	if (!isStringArray(input.deliverables)) {
		push(diagnostics, "invalid_field", "deliverables must be a string array", "deliverables");
	}
	const scope = parseScope(input.scope, diagnostics);
	const procedures = parseProcedures(input.procedures, diagnostics);
	const acceptance = parseAcceptance(input.acceptance, diagnostics);
	if (input.reporting !== ASSIGNMENT_RESULT_VERSION) {
		push(diagnostics, "invalid_version", `Expected reporting ${ASSIGNMENT_RESULT_VERSION}`, "reporting");
	}

	if (
		diagnostics.length > 0 ||
		!id ||
		digest === undefined ||
		!role ||
		!objective ||
		!scope ||
		!acceptance ||
		typeof input.revision !== "number" ||
		typeof input.workClass !== "string" ||
		typeof input.autonomy !== "string" ||
		!isStringArray(input.deliverables)
	) {
		return { ok: false, diagnostics };
	}

	const contract = withAssignmentContractDigest({
		version: ASSIGNMENT_CONTRACT_VERSION,
		id,
		revision: input.revision,
		role,
		workClass: input.workClass as WorkClass,
		autonomy: input.autonomy as AgentAutonomy,
		objective,
		deliverables: input.deliverables,
		scope,
		procedures,
		acceptance,
		reporting: ASSIGNMENT_RESULT_VERSION,
	});

	if (contract.digest !== digest) {
		return {
			ok: false,
			diagnostics: [
				{
					code: "digest_mismatch",
					message: "Contract digest does not match canonical immutable fields",
					path: "digest",
				},
			],
		};
	}

	return { ok: true, contract };
}

export function parseAssignmentResult(input: unknown): ParseAssignmentResultResult {
	const diagnostics: AssignmentDiagnostic[] = [];
	if (!isPlainObject(input)) {
		return {
			ok: false,
			diagnostics: [{ code: "invalid_type", message: "Assignment result must be an object" }],
		};
	}
	if (input.version !== ASSIGNMENT_RESULT_VERSION) {
		push(diagnostics, "invalid_version", `Expected version ${ASSIGNMENT_RESULT_VERSION}`, "version");
	}
	const contractId = requireNonEmptyString(diagnostics, input.contractId, "contractId");
	if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 0) {
		push(diagnostics, "invalid_field", "revision must be a non-negative integer", "revision");
	}
	const digest = requireNonEmptyString(diagnostics, input.digest, "digest");
	if (typeof input.status !== "string" || !RESULT_STATUSES.has(input.status as AssignmentResultStatus)) {
		push(diagnostics, "invalid_field", "status must be a known AssignmentResultStatus", "status");
	}
	if (!isStringArray(input.changedFiles)) {
		push(diagnostics, "invalid_field", "changedFiles must be a string array", "changedFiles");
	}
	if (!Array.isArray(input.evidence)) {
		push(diagnostics, "invalid_field", "evidence must be an array", "evidence");
	}

	const evidence: AcceptanceEvidence[] = [];
	if (Array.isArray(input.evidence)) {
		const seen = new Set<string>();
		for (let i = 0; i < input.evidence.length; i++) {
			const item = input.evidence[i];
			const path = `evidence[${i}]`;
			if (!isPlainObject(item)) {
				push(diagnostics, "invalid_field", "evidence item must be an object", path);
				continue;
			}
			const criterionId = requireNonEmptyString(diagnostics, item.criterionId, `${path}.criterionId`);
			if (!criterionId) continue;
			if (seen.has(criterionId)) {
				push(
					diagnostics,
					"duplicate_criterion",
					`Duplicate evidence for criterion "${criterionId}"`,
					`${path}.criterionId`,
				);
				continue;
			}
			seen.add(criterionId);
			if (typeof item.passed !== "boolean") {
				push(diagnostics, "invalid_field", "evidence.passed must be boolean", `${path}.passed`);
				continue;
			}
			const summary = requireNonEmptyString(diagnostics, item.summary, `${path}.summary`);
			if (!summary) continue;
			evidence.push({
				criterionId,
				passed: item.passed,
				summary,
				details: isPlainObject(item.details) ? item.details : undefined,
				artifactRefs: isStringArray(item.artifactRefs) ? item.artifactRefs : undefined,
			});
		}
	}

	if (input.blockers !== undefined && !isStringArray(input.blockers)) {
		push(diagnostics, "invalid_field", "blockers must be a string array", "blockers");
	}
	if (input.summary !== undefined && typeof input.summary !== "string") {
		push(diagnostics, "invalid_field", "summary must be a string", "summary");
	}

	if (
		diagnostics.length > 0 ||
		!contractId ||
		digest === undefined ||
		typeof input.revision !== "number" ||
		typeof input.status !== "string" ||
		!isStringArray(input.changedFiles)
	) {
		return { ok: false, diagnostics };
	}

	return {
		ok: true,
		result: Object.freeze({
			version: ASSIGNMENT_RESULT_VERSION,
			contractId,
			revision: input.revision,
			digest,
			status: input.status as AssignmentResultStatus,
			changedFiles: Object.freeze([...input.changedFiles]),
			evidence: Object.freeze(evidence.map(item => Object.freeze({ ...item }))),
			blockers: isStringArray(input.blockers) ? Object.freeze([...input.blockers]) : undefined,
			summary: typeof input.summary === "string" ? input.summary : undefined,
		}),
	};
}

export function validateAssignmentContract(contract: AssignmentContractV1): AssignmentDiagnostic[] {
	const parsed = parseAssignmentContract(contract);
	return parsed.ok ? [] : parsed.diagnostics;
}
