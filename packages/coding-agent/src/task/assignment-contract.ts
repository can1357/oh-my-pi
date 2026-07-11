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
export const ASSIGNMENT_CONTRACT_V2_VERSION = "assignment-contract/v2" as const;
export const ASSIGNMENT_RESULT_VERSION = "assignment-result/v1" as const;
export const ASSIGNMENT_RESULT_V2_VERSION = "assignment-result/v2" as const;

export type AssignmentContractVersion = typeof ASSIGNMENT_CONTRACT_VERSION | typeof ASSIGNMENT_CONTRACT_V2_VERSION;
export type AssignmentResultVersion = typeof ASSIGNMENT_RESULT_VERSION | typeof ASSIGNMENT_RESULT_V2_VERSION;

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
	readonly version: typeof ASSIGNMENT_CONTRACT_VERSION;
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

export interface FailureMode {
	readonly id: string;
	readonly description: string;
}

export interface BlockedRoute {
	readonly family: string;
	readonly mechanism: string;
	readonly blocker: string;
	readonly blockerFingerprint?: string;
}

export interface EvidencePolicy {
	readonly requireArtifactRefs?: boolean;
	readonly requireCommandOutput?: boolean;
}

export interface ResultRequirements {
	readonly claimsRequired: boolean;
	readonly counterevidenceRequired: boolean;
	readonly unresolvedGapsRequired: boolean;
}

export interface AssignmentContractV2 extends Omit<AssignmentContractV1, "version" | "reporting"> {
	readonly version: typeof ASSIGNMENT_CONTRACT_V2_VERSION;
	readonly nonSolutions?: readonly string[];
	readonly failureModes?: readonly FailureMode[];
	readonly evidencePolicy?: EvidencePolicy;
	readonly strategyFamily?: string;
	readonly independenceGroup?: string;
	readonly priorBlockedRoutes?: readonly BlockedRoute[];
	readonly resultRequirements?: ResultRequirements;
	readonly reporting: typeof ASSIGNMENT_RESULT_V2_VERSION;
}

export type AssignmentContract = AssignmentContractV1 | AssignmentContractV2;

export type AssignmentResultStatus = "success" | "failed" | "blocked" | "partial" | "falsified";

export type EvidenceRefType =
	| "test"
	| "trace"
	| "artifact"
	| "source"
	| "measurement"
	| "counterexample"
	| "direct-observation";

export type SourceAuthority = "direct" | "primary" | "authoritative" | "secondary" | "untrusted";

export interface EvidenceRef {
	readonly id: string;
	readonly type: EvidenceRefType;
	readonly locator: string;
	readonly digest?: string;
	readonly producedBy: string;
	readonly independentlyReproducedBy?: readonly string[];
	readonly sourceAuthority: SourceAuthority;
	readonly environment?: string;
	readonly freshnessDate?: string;
}

export type ClaimKind = "observation" | "inference" | "proposal" | "assumption";

export type ClaimVerificationStatus = "unverified" | "locally-verified" | "independently-reproduced" | "contradicted";

export interface Claim {
	readonly id: string;
	readonly statement: string;
	readonly supported: boolean;
	readonly kind?: ClaimKind;
	readonly evidenceRefs?: readonly string[];
	readonly counterEvidenceRefs?: readonly string[];
	readonly dependsOnClaims?: readonly string[];
	readonly satisfiesCriteria?: readonly string[];
	readonly verificationStatus?: ClaimVerificationStatus;
	readonly residualAssumptions?: readonly string[];
}

export interface CounterEvidence {
	readonly summary: string;
	readonly artifactRefs?: readonly string[];
	readonly claimIds?: readonly string[];
	readonly criterionIds?: readonly string[];
}

export interface UnresolvedGap {
	readonly id: string;
	readonly description: string;
}

export interface AcceptanceEvidence {
	readonly criterionId: string;
	readonly passed: boolean;
	readonly summary: string;
	readonly details?: Readonly<Record<string, unknown>>;
	readonly artifactRefs?: readonly string[];
}

export interface AssignmentResultV1 {
	readonly version: typeof ASSIGNMENT_RESULT_VERSION;
	readonly contractId: string;
	readonly revision: number;
	readonly digest: string;
	readonly status: Exclude<AssignmentResultStatus, "falsified">;
	readonly changedFiles: readonly string[];
	readonly evidence: readonly AcceptanceEvidence[];
	readonly blockers?: readonly string[];
	readonly summary?: string;
}

export interface AssignmentResultV2 extends Omit<AssignmentResultV1, "version" | "status"> {
	readonly version: typeof ASSIGNMENT_RESULT_V2_VERSION;
	readonly status: AssignmentResultStatus;
	readonly claims?: readonly Claim[];
	readonly counterevidence?: readonly CounterEvidence[];
	readonly unresolvedGaps?: readonly UnresolvedGap[];
	readonly recommendedNextAction?: string;
	readonly evidenceRefs?: readonly EvidenceRef[];
}

export type AssignmentResult = AssignmentResultV1 | AssignmentResultV2;

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
	readonly nonSolutions?: readonly string[];
	readonly failureModes?: readonly FailureMode[];
	readonly evidencePolicy?: EvidencePolicy;
	readonly strategyFamily?: string;
	readonly independenceGroup?: string;
	readonly priorBlockedRoutes?: readonly BlockedRoute[];
	readonly resultRequirements?: ResultRequirements;
}

export type ParseAssignmentContractResult =
	| { ok: true; contract: AssignmentContract }
	| { ok: false; diagnostics: AssignmentDiagnostic[] };

export type ParseAssignmentResultResult =
	| { ok: true; result: AssignmentResult }
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
const RESULT_STATUSES_V1 = new Set<Exclude<AssignmentResultStatus, "falsified">>([
	"success",
	"failed",
	"blocked",
	"partial",
]);
const RESULT_STATUSES_V2 = new Set<AssignmentResultStatus>(["success", "failed", "blocked", "partial", "falsified"]);
const EVIDENCE_REF_TYPES = new Set<EvidenceRefType>([
	"test",
	"trace",
	"artifact",
	"source",
	"measurement",
	"counterexample",
	"direct-observation",
]);
const SOURCE_AUTHORITIES = new Set<SourceAuthority>(["direct", "primary", "authoritative", "secondary", "untrusted"]);
const CLAIM_KINDS = new Set<ClaimKind>(["observation", "inference", "proposal", "assumption"]);
const CLAIM_VERIFICATION_STATUSES = new Set<ClaimVerificationStatus>([
	"unverified",
	"locally-verified",
	"independently-reproduced",
	"contradicted",
]);

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
	const payload: Record<string, unknown> = {
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
	if (input.version === ASSIGNMENT_CONTRACT_V2_VERSION) {
		payload.nonSolutions = input.nonSolutions ?? [];
		payload.failureModes = input.failureModes ?? [];
		payload.evidencePolicy = input.evidencePolicy ?? {};
		payload.strategyFamily = input.strategyFamily ?? "";
		payload.independenceGroup = input.independenceGroup ?? "";
		payload.priorBlockedRoutes = input.priorBlockedRoutes ?? [];
		payload.resultRequirements = input.resultRequirements ?? null;
	}
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

export function withAssignmentContractV2Digest(
	input: Omit<AssignmentContractV2, "digest"> & { digest?: string },
): AssignmentContractV2 {
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
		nonSolutions: input.nonSolutions,
		failureModes: input.failureModes,
		evidencePolicy: input.evidencePolicy,
		strategyFamily: input.strategyFamily,
		independenceGroup: input.independenceGroup,
		priorBlockedRoutes: input.priorBlockedRoutes,
		resultRequirements: input.resultRequirements,
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
		nonSolutions: input.nonSolutions ? Object.freeze([...input.nonSolutions]) : undefined,
		failureModes: input.failureModes
			? Object.freeze(input.failureModes.map(mode => Object.freeze({ ...mode })))
			: undefined,
		evidencePolicy: input.evidencePolicy ? Object.freeze({ ...input.evidencePolicy }) : undefined,
		priorBlockedRoutes: input.priorBlockedRoutes
			? Object.freeze(input.priorBlockedRoutes.map(route => Object.freeze({ ...route })))
			: undefined,
		resultRequirements: input.resultRequirements ? Object.freeze({ ...input.resultRequirements }) : undefined,
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

function parseFailureModes(value: unknown, diagnostics: AssignmentDiagnostic[]): readonly FailureMode[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		push(diagnostics, "invalid_field", "failureModes must be an array", "failureModes");
		return undefined;
	}
	const modes: FailureMode[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		const path = `failureModes[${i}]`;
		if (!isPlainObject(item)) continue;
		const id = requireNonEmptyString(diagnostics, item.id, `${path}.id`);
		const description = requireNonEmptyString(diagnostics, item.description, `${path}.description`);
		if (!id || !description) continue;
		if (seen.has(id)) {
			push(diagnostics, "duplicate_criterion", `Duplicate failure mode id "${id}"`, `${path}.id`);
			continue;
		}
		seen.add(id);
		modes.push({ id, description });
	}
	return modes;
}

function parseEvidencePolicy(value: unknown, diagnostics: AssignmentDiagnostic[]): EvidencePolicy | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		push(diagnostics, "invalid_field", "evidencePolicy must be an object", "evidencePolicy");
		return undefined;
	}
	for (const key of Object.keys(value)) {
		if (key !== "requireArtifactRefs" && key !== "requireCommandOutput") {
			push(diagnostics, "invalid_field", `Unknown evidencePolicy field "${key}"`, `evidencePolicy.${key}`);
		}
	}
	let requireArtifactRefs: boolean | undefined;
	let requireCommandOutput: boolean | undefined;
	if (value.requireArtifactRefs !== undefined) {
		if (typeof value.requireArtifactRefs !== "boolean") {
			push(
				diagnostics,
				"invalid_field",
				"evidencePolicy.requireArtifactRefs must be boolean",
				"evidencePolicy.requireArtifactRefs",
			);
		} else {
			requireArtifactRefs = value.requireArtifactRefs;
		}
	}
	if (value.requireCommandOutput !== undefined) {
		if (typeof value.requireCommandOutput !== "boolean") {
			push(
				diagnostics,
				"invalid_field",
				"evidencePolicy.requireCommandOutput must be boolean",
				"evidencePolicy.requireCommandOutput",
			);
		} else {
			requireCommandOutput = value.requireCommandOutput;
		}
	}
	return {
		...(requireArtifactRefs === undefined ? {} : { requireArtifactRefs }),
		...(requireCommandOutput === undefined ? {} : { requireCommandOutput }),
	};
}

function parsePriorBlockedRoutes(
	value: unknown,
	diagnostics: AssignmentDiagnostic[],
): readonly BlockedRoute[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		push(diagnostics, "invalid_field", "priorBlockedRoutes must be an array", "priorBlockedRoutes");
		return undefined;
	}
	const routes: BlockedRoute[] = [];
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		const path = `priorBlockedRoutes[${i}]`;
		if (!isPlainObject(item)) {
			push(diagnostics, "invalid_field", "priorBlockedRoute must be an object", path);
			continue;
		}
		for (const key of Object.keys(item)) {
			if (key !== "family" && key !== "mechanism" && key !== "blocker" && key !== "blockerFingerprint") {
				push(diagnostics, "invalid_field", `Unknown priorBlockedRoute field "${key}"`, `${path}.${key}`);
			}
		}
		const family = requireNonEmptyString(diagnostics, item.family, `${path}.family`);
		const mechanism = requireNonEmptyString(diagnostics, item.mechanism, `${path}.mechanism`);
		const blocker = requireNonEmptyString(diagnostics, item.blocker, `${path}.blocker`);
		let blockerFingerprint: string | undefined;
		if (item.blockerFingerprint !== undefined) {
			blockerFingerprint = requireNonEmptyString(diagnostics, item.blockerFingerprint, `${path}.blockerFingerprint`);
		}
		if (!family || !mechanism || !blocker || (item.blockerFingerprint !== undefined && !blockerFingerprint)) continue;
		routes.push({
			family,
			mechanism,
			blocker,
			...(blockerFingerprint === undefined ? {} : { blockerFingerprint }),
		});
	}
	return routes;
}

function parseResultRequirements(value: unknown, diagnostics: AssignmentDiagnostic[]): ResultRequirements | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		push(diagnostics, "invalid_field", "resultRequirements must be an object", "resultRequirements");
		return undefined;
	}
	for (const key of Object.keys(value)) {
		if (key !== "claimsRequired" && key !== "counterevidenceRequired" && key !== "unresolvedGapsRequired") {
			push(diagnostics, "invalid_field", `Unknown resultRequirements field "${key}"`, `resultRequirements.${key}`);
		}
	}
	const claimsRequired = value.claimsRequired;
	const counterevidenceRequired = value.counterevidenceRequired;
	const unresolvedGapsRequired = value.unresolvedGapsRequired;
	if (typeof claimsRequired !== "boolean") {
		push(
			diagnostics,
			"invalid_field",
			"resultRequirements.claimsRequired must be boolean",
			"resultRequirements.claimsRequired",
		);
	}
	if (typeof counterevidenceRequired !== "boolean") {
		push(
			diagnostics,
			"invalid_field",
			"resultRequirements.counterevidenceRequired must be boolean",
			"resultRequirements.counterevidenceRequired",
		);
	}
	if (typeof unresolvedGapsRequired !== "boolean") {
		push(
			diagnostics,
			"invalid_field",
			"resultRequirements.unresolvedGapsRequired must be boolean",
			"resultRequirements.unresolvedGapsRequired",
		);
	}
	if (
		typeof claimsRequired !== "boolean" ||
		typeof counterevidenceRequired !== "boolean" ||
		typeof unresolvedGapsRequired !== "boolean"
	) {
		return undefined;
	}
	return { claimsRequired, counterevidenceRequired, unresolvedGapsRequired };
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
	const isV2 = input.version === ASSIGNMENT_CONTRACT_V2_VERSION;
	if (input.version !== ASSIGNMENT_CONTRACT_VERSION && !isV2) {
		push(
			diagnostics,
			"invalid_version",
			`Expected version ${ASSIGNMENT_CONTRACT_VERSION} or ${ASSIGNMENT_CONTRACT_V2_VERSION}`,
			"version",
		);
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
	const expectedReporting = isV2 ? ASSIGNMENT_RESULT_V2_VERSION : ASSIGNMENT_RESULT_VERSION;
	if (input.reporting !== expectedReporting) {
		push(diagnostics, "invalid_version", `Expected reporting ${expectedReporting}`, "reporting");
	}

	let nonSolutions: readonly string[] | undefined;
	let failureModes: readonly FailureMode[] | undefined;
	let evidencePolicy: EvidencePolicy | undefined;
	let strategyFamily: string | undefined;
	let independenceGroup: string | undefined;
	let priorBlockedRoutes: readonly BlockedRoute[] | undefined;
	let resultRequirements: ResultRequirements | undefined;
	if (isV2) {
		if (input.nonSolutions !== undefined) {
			if (!isStringArray(input.nonSolutions)) {
				push(diagnostics, "invalid_field", "nonSolutions must be a string array", "nonSolutions");
			} else {
				nonSolutions = input.nonSolutions;
			}
		}
		failureModes = parseFailureModes(input.failureModes, diagnostics);
		evidencePolicy = parseEvidencePolicy(input.evidencePolicy, diagnostics);
		if (input.strategyFamily !== undefined) {
			strategyFamily = requireNonEmptyString(diagnostics, input.strategyFamily, "strategyFamily");
		}
		if (input.independenceGroup !== undefined) {
			independenceGroup = requireNonEmptyString(diagnostics, input.independenceGroup, "independenceGroup");
		}
		priorBlockedRoutes = parsePriorBlockedRoutes(input.priorBlockedRoutes, diagnostics);
		resultRequirements = parseResultRequirements(input.resultRequirements, diagnostics);
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

	const digestInput: AssignmentContractDigestInput = {
		version: isV2 ? ASSIGNMENT_CONTRACT_V2_VERSION : ASSIGNMENT_CONTRACT_VERSION,
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
		reporting: expectedReporting,
		nonSolutions,
		failureModes,
		evidencePolicy,
		strategyFamily,
		independenceGroup,
		priorBlockedRoutes,
		resultRequirements,
	};
	const computedDigest = computeAssignmentContractDigest(digestInput);

	if (computedDigest !== digest) {
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

	if (isV2) {
		const contractV2: AssignmentContractV2 = Object.freeze({
			version: ASSIGNMENT_CONTRACT_V2_VERSION,
			id,
			revision: input.revision,
			digest: computedDigest,
			role,
			workClass: input.workClass as WorkClass,
			autonomy: input.autonomy as AgentAutonomy,
			objective,
			deliverables: Object.freeze([...input.deliverables]),
			scope: Object.freeze({
				allowedPaths: Object.freeze([...scope.allowedPaths]),
				deniedPaths: scope.deniedPaths ? Object.freeze([...scope.deniedPaths]) : undefined,
			}),
			procedures: procedures
				? Object.freeze(procedures.map(procedure => Object.freeze({ ...procedure })))
				: undefined,
			acceptance: Object.freeze(
				acceptance.map(criterion =>
					Object.freeze({
						...criterion,
						params: criterion.params ? Object.freeze({ ...criterion.params }) : undefined,
					}),
				),
			),
			reporting: ASSIGNMENT_RESULT_V2_VERSION,
			nonSolutions: nonSolutions ? Object.freeze([...nonSolutions]) : undefined,
			failureModes: failureModes ? Object.freeze(failureModes.map(f => Object.freeze({ ...f }))) : undefined,
			evidencePolicy: evidencePolicy ? Object.freeze({ ...evidencePolicy }) : undefined,
			strategyFamily,
			independenceGroup,
			priorBlockedRoutes: priorBlockedRoutes
				? Object.freeze(priorBlockedRoutes.map(route => Object.freeze({ ...route })))
				: undefined,
			resultRequirements: resultRequirements ? Object.freeze({ ...resultRequirements }) : undefined,
		});
		return { ok: true, contract: contractV2 };
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

	return { ok: true, contract };
}

function parseOptionalStringArray(
	value: unknown,
	diagnostics: AssignmentDiagnostic[],
	path: string,
): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!isStringArray(value)) {
		push(diagnostics, "invalid_field", `${path} must be a string array`, path);
		return undefined;
	}
	return value;
}

function parseOptionalString(value: unknown, diagnostics: AssignmentDiagnostic[], path: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		push(diagnostics, "invalid_field", `${path} must be a string`, path);
		return undefined;
	}
	return value;
}

function freezeClaim(claim: Claim): Claim {
	return Object.freeze({
		...claim,
		...(claim.evidenceRefs === undefined ? {} : { evidenceRefs: Object.freeze([...claim.evidenceRefs]) }),
		...(claim.counterEvidenceRefs === undefined
			? {}
			: { counterEvidenceRefs: Object.freeze([...claim.counterEvidenceRefs]) }),
		...(claim.dependsOnClaims === undefined ? {} : { dependsOnClaims: Object.freeze([...claim.dependsOnClaims]) }),
		...(claim.satisfiesCriteria === undefined
			? {}
			: { satisfiesCriteria: Object.freeze([...claim.satisfiesCriteria]) }),
		...(claim.residualAssumptions === undefined
			? {}
			: { residualAssumptions: Object.freeze([...claim.residualAssumptions]) }),
	});
}

function freezeCounterEvidence(counterEvidence: CounterEvidence): CounterEvidence {
	return Object.freeze({
		...counterEvidence,
		...(counterEvidence.artifactRefs === undefined
			? {}
			: { artifactRefs: Object.freeze([...counterEvidence.artifactRefs]) }),
		...(counterEvidence.claimIds === undefined ? {} : { claimIds: Object.freeze([...counterEvidence.claimIds]) }),
		...(counterEvidence.criterionIds === undefined
			? {}
			: { criterionIds: Object.freeze([...counterEvidence.criterionIds]) }),
	});
}

function freezeEvidenceRef(evidenceRef: EvidenceRef): EvidenceRef {
	return Object.freeze({
		...evidenceRef,
		...(evidenceRef.independentlyReproducedBy === undefined
			? {}
			: { independentlyReproducedBy: Object.freeze([...evidenceRef.independentlyReproducedBy]) }),
	});
}

export function parseAssignmentResult(input: unknown): ParseAssignmentResultResult {
	const diagnostics: AssignmentDiagnostic[] = [];
	if (!isPlainObject(input)) {
		return {
			ok: false,
			diagnostics: [{ code: "invalid_type", message: "Assignment result must be an object" }],
		};
	}
	const isV2 = input.version === ASSIGNMENT_RESULT_V2_VERSION;
	if (input.version !== ASSIGNMENT_RESULT_VERSION && !isV2) {
		push(
			diagnostics,
			"invalid_version",
			`Expected version ${ASSIGNMENT_RESULT_VERSION} or ${ASSIGNMENT_RESULT_V2_VERSION}`,
			"version",
		);
	}
	const contractId = requireNonEmptyString(diagnostics, input.contractId, "contractId");
	if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 0) {
		push(diagnostics, "invalid_field", "revision must be a non-negative integer", "revision");
	}
	const digest = requireNonEmptyString(diagnostics, input.digest, "digest");
	const statusSet = isV2 ? RESULT_STATUSES_V2 : RESULT_STATUSES_V1;
	if (typeof input.status !== "string" || !statusSet.has(input.status as AssignmentResultStatus)) {
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

	// V2-only: traceable claims, counterevidence, and unresolved gaps.
	const evidenceRefs: EvidenceRef[] = [];
	const claims: Claim[] = [];
	const counterevidence: CounterEvidence[] = [];
	const unresolvedGaps: UnresolvedGap[] = [];
	const evidenceRefsSupplied = input.evidenceRefs !== undefined;
	const claimsSupplied = input.claims !== undefined;
	if (isV2) {
		if (input.evidenceRefs !== undefined) {
			if (!Array.isArray(input.evidenceRefs)) {
				push(diagnostics, "invalid_field", "evidenceRefs must be an array", "evidenceRefs");
			} else {
				const seenEvidenceRefIds = new Set<string>();
				for (let i = 0; i < input.evidenceRefs.length; i++) {
					const item = input.evidenceRefs[i];
					const path = `evidenceRefs[${i}]`;
					if (!isPlainObject(item)) {
						push(diagnostics, "invalid_field", "evidenceRef must be an object", path);
						continue;
					}
					const id = requireNonEmptyString(diagnostics, item.id, `${path}.id`);
					if (id && seenEvidenceRefIds.has(id)) {
						push(diagnostics, "duplicate_criterion", `Duplicate evidenceRef id "${id}"`, `${path}.id`);
						continue;
					}
					if (id) seenEvidenceRefIds.add(id);
					const type = item.type;
					const typeIsValid = typeof type === "string" && EVIDENCE_REF_TYPES.has(type as EvidenceRefType);
					if (!typeIsValid) {
						push(
							diagnostics,
							"invalid_field",
							"evidenceRef.type must be a known EvidenceRefType",
							`${path}.type`,
						);
					}
					const locator = requireNonEmptyString(diagnostics, item.locator, `${path}.locator`);
					const producedBy = requireNonEmptyString(diagnostics, item.producedBy, `${path}.producedBy`);
					const sourceAuthority = item.sourceAuthority;
					const sourceAuthorityIsValid =
						typeof sourceAuthority === "string" && SOURCE_AUTHORITIES.has(sourceAuthority as SourceAuthority);
					if (!sourceAuthorityIsValid) {
						push(
							diagnostics,
							"invalid_field",
							"evidenceRef.sourceAuthority must be a known SourceAuthority",
							`${path}.sourceAuthority`,
						);
					}
					const evidenceDigest = parseOptionalString(item.digest, diagnostics, `${path}.digest`);
					const independentlyReproducedBy = parseOptionalStringArray(
						item.independentlyReproducedBy,
						diagnostics,
						`${path}.independentlyReproducedBy`,
					);
					const environment = parseOptionalString(item.environment, diagnostics, `${path}.environment`);
					const freshnessDate = parseOptionalString(item.freshnessDate, diagnostics, `${path}.freshnessDate`);
					if (!id || !typeIsValid || !locator || !producedBy || !sourceAuthorityIsValid) continue;
					evidenceRefs.push({
						id,
						type: type as EvidenceRefType,
						locator,
						producedBy,
						sourceAuthority: sourceAuthority as SourceAuthority,
						...(evidenceDigest === undefined ? {} : { digest: evidenceDigest }),
						...(independentlyReproducedBy === undefined ? {} : { independentlyReproducedBy }),
						...(environment === undefined ? {} : { environment }),
						...(freshnessDate === undefined ? {} : { freshnessDate }),
					});
				}
			}
		}

		if (input.claims !== undefined) {
			if (!Array.isArray(input.claims)) {
				push(diagnostics, "invalid_field", "claims must be an array", "claims");
			} else {
				const seenClaimIds = new Set<string>();
				for (let i = 0; i < input.claims.length; i++) {
					const item = input.claims[i];
					const path = `claims[${i}]`;
					if (!isPlainObject(item)) {
						push(diagnostics, "invalid_field", "claim must be an object", path);
						continue;
					}
					const id = requireNonEmptyString(diagnostics, item.id, `${path}.id`);
					if (id && seenClaimIds.has(id)) {
						push(diagnostics, "duplicate_criterion", `Duplicate claim id "${id}"`, `${path}.id`);
						continue;
					}
					if (id) seenClaimIds.add(id);
					const statement = requireNonEmptyString(diagnostics, item.statement, `${path}.statement`);
					const supported = item.supported;
					if (typeof supported !== "boolean") {
						push(diagnostics, "invalid_field", "claim.supported must be boolean", `${path}.supported`);
					}
					let kind: ClaimKind | undefined;
					let verificationStatus: ClaimVerificationStatus | undefined;
					let fieldsValid = true;
					if (item.kind !== undefined) {
						if (typeof item.kind !== "string" || !CLAIM_KINDS.has(item.kind as ClaimKind)) {
							push(diagnostics, "invalid_field", "claim.kind must be a known ClaimKind", `${path}.kind`);
							fieldsValid = false;
						} else {
							kind = item.kind as ClaimKind;
						}
					}
					if (item.verificationStatus !== undefined) {
						if (
							typeof item.verificationStatus !== "string" ||
							!CLAIM_VERIFICATION_STATUSES.has(item.verificationStatus as ClaimVerificationStatus)
						) {
							push(
								diagnostics,
								"invalid_field",
								"claim.verificationStatus must be a known ClaimVerificationStatus",
								`${path}.verificationStatus`,
							);
							fieldsValid = false;
						} else {
							verificationStatus = item.verificationStatus as ClaimVerificationStatus;
						}
					}
					const claimEvidenceRefs = parseOptionalStringArray(
						item.evidenceRefs,
						diagnostics,
						`${path}.evidenceRefs`,
					);
					const counterEvidenceRefs = parseOptionalStringArray(
						item.counterEvidenceRefs,
						diagnostics,
						`${path}.counterEvidenceRefs`,
					);
					const dependsOnClaims = parseOptionalStringArray(
						item.dependsOnClaims,
						diagnostics,
						`${path}.dependsOnClaims`,
					);
					const satisfiesCriteria = parseOptionalStringArray(
						item.satisfiesCriteria,
						diagnostics,
						`${path}.satisfiesCriteria`,
					);
					const residualAssumptions = parseOptionalStringArray(
						item.residualAssumptions,
						diagnostics,
						`${path}.residualAssumptions`,
					);
					if (
						(item.evidenceRefs !== undefined && claimEvidenceRefs === undefined) ||
						(item.counterEvidenceRefs !== undefined && counterEvidenceRefs === undefined) ||
						(item.dependsOnClaims !== undefined && dependsOnClaims === undefined) ||
						(item.satisfiesCriteria !== undefined && satisfiesCriteria === undefined) ||
						(item.residualAssumptions !== undefined && residualAssumptions === undefined)
					) {
						fieldsValid = false;
					}
					if (satisfiesCriteria?.some(criterionId => criterionId.trim().length === 0)) {
						push(
							diagnostics,
							"empty_value",
							"claim.satisfiesCriteria entries must be non-empty strings",
							`${path}.satisfiesCriteria`,
						);
						fieldsValid = false;
					}
					if (!id || !statement || typeof supported !== "boolean" || !fieldsValid) continue;
					claims.push({
						id,
						statement,
						supported,
						...(kind === undefined ? {} : { kind }),
						...(claimEvidenceRefs === undefined ? {} : { evidenceRefs: claimEvidenceRefs }),
						...(counterEvidenceRefs === undefined ? {} : { counterEvidenceRefs }),
						...(dependsOnClaims === undefined ? {} : { dependsOnClaims }),
						...(satisfiesCriteria === undefined ? {} : { satisfiesCriteria }),
						...(verificationStatus === undefined ? {} : { verificationStatus }),
						...(residualAssumptions === undefined ? {} : { residualAssumptions }),
					});
				}
			}
		}

		if (input.counterevidence !== undefined) {
			if (!Array.isArray(input.counterevidence)) {
				push(diagnostics, "invalid_field", "counterevidence must be an array", "counterevidence");
			} else {
				for (let i = 0; i < input.counterevidence.length; i++) {
					const item = input.counterevidence[i];
					const path = `counterevidence[${i}]`;
					if (!isPlainObject(item)) {
						push(diagnostics, "invalid_field", "counterevidence must be an object", path);
						continue;
					}
					const summary = requireNonEmptyString(diagnostics, item.summary, `${path}.summary`);
					const artifactRefs = isStringArray(item.artifactRefs) ? item.artifactRefs : undefined;
					const claimIds = parseOptionalStringArray(item.claimIds, diagnostics, `${path}.claimIds`);
					const criterionIds = parseOptionalStringArray(item.criterionIds, diagnostics, `${path}.criterionIds`);
					if (
						!summary ||
						(item.claimIds !== undefined && claimIds === undefined) ||
						(item.criterionIds !== undefined && criterionIds === undefined)
					) {
						continue;
					}
					counterevidence.push({
						summary,
						...(artifactRefs === undefined ? {} : { artifactRefs }),
						...(claimIds === undefined ? {} : { claimIds }),
						...(criterionIds === undefined ? {} : { criterionIds }),
					});
				}
			}
		}

		if (Array.isArray(input.unresolvedGaps)) {
			for (let i = 0; i < input.unresolvedGaps.length; i++) {
				const item = input.unresolvedGaps[i];
				const p = `unresolvedGaps[${i}]`;
				if (!isPlainObject(item)) {
					push(diagnostics, "invalid_field", "unresolvedGap must be an object", p);
					continue;
				}
				const id = requireNonEmptyString(diagnostics, item.id, `${p}.id`);
				const description = requireNonEmptyString(diagnostics, item.description, `${p}.description`);
				if (id && description) unresolvedGaps.push({ id, description });
			}
		}

		if (evidenceRefsSupplied) {
			const knownEvidenceRefIds = new Set(evidenceRefs.map(evidenceRef => evidenceRef.id));
			for (let i = 0; i < claims.length; i++) {
				const claim = claims[i];
				for (const evidenceRefId of [...(claim.evidenceRefs ?? []), ...(claim.counterEvidenceRefs ?? [])]) {
					if (!knownEvidenceRefIds.has(evidenceRefId)) {
						push(
							diagnostics,
							"invalid_field",
							`claim references unknown evidenceRef "${evidenceRefId}"`,
							`claims[${i}]`,
						);
					}
				}
			}
		}

		const knownClaimIds = new Set(claims.map(claim => claim.id));
		for (let i = 0; i < claims.length; i++) {
			const claim = claims[i];
			for (const dependencyId of claim.dependsOnClaims ?? []) {
				if (dependencyId === claim.id) {
					push(diagnostics, "invalid_field", "claim must not depend on itself", `claims[${i}].dependsOnClaims`);
				} else if (!knownClaimIds.has(dependencyId)) {
					push(
						diagnostics,
						"invalid_field",
						`claim depends on unknown claim "${dependencyId}"`,
						`claims[${i}].dependsOnClaims`,
					);
				}
			}
		}
		if (claimsSupplied) {
			for (let i = 0; i < counterevidence.length; i++) {
				for (const claimId of counterevidence[i].claimIds ?? []) {
					if (!knownClaimIds.has(claimId)) {
						push(
							diagnostics,
							"invalid_field",
							`counterevidence references unknown claim "${claimId}"`,
							`counterevidence[${i}].claimIds`,
						);
					}
				}
			}
		}
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
		result: Object.freeze(
			isV2
				? {
						version: ASSIGNMENT_RESULT_V2_VERSION,
						contractId,
						revision: input.revision,
						digest,
						status: input.status as AssignmentResultStatus,
						changedFiles: Object.freeze([...input.changedFiles]),
						evidence: Object.freeze(evidence.map(item => Object.freeze({ ...item }))),
						blockers: isStringArray(input.blockers) ? Object.freeze([...input.blockers]) : undefined,
						summary: typeof input.summary === "string" ? input.summary : undefined,
						claims: claims.length > 0 ? Object.freeze(claims.map(freezeClaim)) : undefined,
						counterevidence:
							counterevidence.length > 0 ? Object.freeze(counterevidence.map(freezeCounterEvidence)) : undefined,
						unresolvedGaps:
							unresolvedGaps.length > 0
								? Object.freeze(unresolvedGaps.map(g => Object.freeze({ ...g })))
								: undefined,
						recommendedNextAction:
							typeof input.recommendedNextAction === "string" ? input.recommendedNextAction : undefined,
						...(evidenceRefsSupplied ? { evidenceRefs: Object.freeze(evidenceRefs.map(freezeEvidenceRef)) } : {}),
					}
				: {
						version: ASSIGNMENT_RESULT_VERSION,
						contractId,
						revision: input.revision,
						digest,
						status: input.status as Exclude<AssignmentResultStatus, "falsified">,
						changedFiles: Object.freeze([...input.changedFiles]),
						evidence: Object.freeze(evidence.map(item => Object.freeze({ ...item }))),
						blockers: isStringArray(input.blockers) ? Object.freeze([...input.blockers]) : undefined,
						summary: typeof input.summary === "string" ? input.summary : undefined,
					},
		) as AssignmentResult,
	};
}

export function validateAssignmentContract(contract: AssignmentContract): AssignmentDiagnostic[] {
	const parsed = parseAssignmentContract(contract);
	return parsed.ok ? [] : parsed.diagnostics;
}
