/**
 * ReasoningPlanV1 — versioned plan linking a TaskContractV1 to a selected set of
 * bounded reasoning modules, a DAG of dependencies, and an execution policy.
 *
 * Plans are emitted by the self-discovery compiler and audited before execution.
 * The contract digest binds each plan to its parent contract; a changed contract
 * invalidates any plan whose digest no longer matches.
 */

import { createHash } from "node:crypto";
import type { TaskContractV1 } from "./task-contract";

export const REASONING_PLAN_VERSION = "ompk.reasoning-plan/v1" as const;
export type ReasoningPlanVersion = typeof REASONING_PLAN_VERSION;

export type WorkerMode = "explore" | "analyze" | "implement" | "falsify" | "audit" | "synthesize";
export type ContextPolicyKind = "shared" | "blind" | "staged";
export type SchedulingPolicy = "critical_path" | "judgment";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type EstimatedMagnitude = "low" | "medium" | "high";

export interface SelectedReasoningModule {
	readonly instanceId: string;
	readonly moduleId: string;
	readonly version: string;
	readonly purpose: string;
	readonly reasonSelected: string;
	readonly workerMode: WorkerMode;
	readonly strategyFamily?: string;
	readonly contextPolicy: ContextPolicyKind;
	readonly inputs: readonly string[];
	readonly expectedOutputs: readonly string[];
	readonly criteriaSupported: readonly string[];
	readonly evidenceRequired: readonly string[];
	readonly dependencies: readonly string[];
	readonly stopConditions: readonly string[];
	readonly recommendedProfile?: string;
	readonly recommendedModelRole?: string;
	readonly recommendedReasoningEffort?: ReasoningEffort;
	readonly estimatedCost: EstimatedMagnitude;
	readonly estimatedValue: EstimatedMagnitude;
}

export interface DependencyEdge {
	readonly fromModuleInstanceId: string;
	readonly toModuleInstanceId: string;
	readonly kind: "requires" | "blocks" | "informs";
}

export interface ExecutionPolicy {
	readonly orchestrationMode:
		| "direct"
		| "single_specialist"
		| "parallel_slices"
		| "independent_exploration"
		| "implement_then_audit";
	readonly schedulingPolicy: SchedulingPolicy;
	readonly maxConcurrentWorkers: number;
	readonly maxRounds: number;
	readonly maxSameBlockerRetries: number;
}

export interface PlanVerificationSpec {
	readonly criterionIds: readonly string[];
	readonly requiredAudits: readonly string[];
	readonly requireFreshContextVerifier: boolean;
}

export interface PlanStopCondition {
	readonly type:
		| "criteria_satisfied"
		| "budget_exhausted"
		| "blocked"
		| "duplicate_blocker"
		| "insufficient_information"
		| "approval_required";
	readonly description: string;
}

export interface TaskProfile {
	readonly taskClass: string;
	readonly complexity: "simple" | "moderate" | "complex" | "open_ended";
	readonly uncertainty: number;
	readonly consequence: "low" | "medium" | "high";
	readonly expectedHorizon: "single_step" | "multi_step" | "long_horizon";
}

export interface ReasoningPlanV1 {
	readonly id: string;
	readonly version: ReasoningPlanVersion;
	readonly taskContractId: string;
	readonly taskContractDigest: string;
	readonly taskProfile: TaskProfile;
	readonly selectedModules: readonly SelectedReasoningModule[];
	readonly dependencyEdges: readonly DependencyEdge[];
	readonly executionPolicy: ExecutionPolicy;
	readonly verificationPlan: PlanVerificationSpec;
	readonly stopConditions: readonly PlanStopCondition[];
	readonly digest: string;
}

export type PlanAuditSeverity = "blocking" | "warning";

export interface PlanAuditFinding {
	readonly severity: PlanAuditSeverity;
	readonly code: string;
	readonly message: string;
	readonly moduleInstanceId?: string;
}

export type ReasoningPlanDiagnostic = {
	readonly code: string;
	readonly message: string;
	readonly path?: string;
};

export type ParseReasoningPlanResult =
	| { ok: true; plan: ReasoningPlanV1 }
	| { ok: false; diagnostics: readonly ReasoningPlanDiagnostic[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(v => typeof v === "string");
}

const VALID_WORKER_MODES = new Set<WorkerMode>(["explore", "analyze", "implement", "falsify", "audit", "synthesize"]);
const VALID_CONTEXT_POLICIES = new Set<ContextPolicyKind>(["shared", "blind", "staged"]);
const VALID_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh", "max"]);
const VALID_MAGNITUDES = new Set<EstimatedMagnitude>(["low", "medium", "high"]);
const VALID_DEP_KINDS = new Set(["requires", "blocks", "informs"]);
const VALID_ORCHESTRATION_MODES = new Set([
	"direct",
	"single_specialist",
	"parallel_slices",
	"independent_exploration",
	"implement_then_audit",
]);
const VALID_COMPLEXITY = new Set(["simple", "moderate", "complex", "open_ended"]);
const VALID_CONSEQUENCE = new Set(["low", "medium", "high"]);
const VALID_HORIZON = new Set(["single_step", "multi_step", "long_horizon"]);
const VALID_STOP_TYPES = new Set([
	"criteria_satisfied",
	"budget_exhausted",
	"blocked",
	"duplicate_blocker",
	"insufficient_information",
	"approval_required",
]);

function parseModule(
	raw: unknown,
	index: number,
	diagnostics: ReasoningPlanDiagnostic[],
): SelectedReasoningModule | null {
	const path = `selectedModules[${index}]`;
	if (!isPlainObject(raw)) {
		diagnostics.push({ code: "invalid_type", message: `${path} must be an object` });
		return null;
	}
	const instanceId = typeof raw.instanceId === "string" ? raw.instanceId.trim() : "";
	const moduleId = typeof raw.moduleId === "string" ? raw.moduleId.trim() : "";
	const version = typeof raw.version === "string" ? raw.version.trim() : "";
	const purpose = typeof raw.purpose === "string" ? raw.purpose.trim() : "";
	const reasonSelected = typeof raw.reasonSelected === "string" ? raw.reasonSelected.trim() : "";
	if (!instanceId || !moduleId || !version || !purpose || !reasonSelected) {
		diagnostics.push({
			code: "missing_field",
			message: `${path} requires instanceId, moduleId, version, purpose, reasonSelected`,
			path,
		});
		return null;
	}
	const workerMode = raw.workerMode as WorkerMode;
	if (!VALID_WORKER_MODES.has(workerMode)) {
		diagnostics.push({ code: "invalid_field", message: `${path}.workerMode "${workerMode}" is not valid`, path });
		return null;
	}
	const contextPolicy = raw.contextPolicy as ContextPolicyKind;
	if (!VALID_CONTEXT_POLICIES.has(contextPolicy)) {
		diagnostics.push({
			code: "invalid_field",
			message: `${path}.contextPolicy "${contextPolicy}" is not valid`,
			path,
		});
		return null;
	}
	const estimatedCost = raw.estimatedCost as EstimatedMagnitude;
	const estimatedValue = raw.estimatedValue as EstimatedMagnitude;
	if (!VALID_MAGNITUDES.has(estimatedCost) || !VALID_MAGNITUDES.has(estimatedValue)) {
		diagnostics.push({
			code: "invalid_field",
			message: `${path} estimatedCost and estimatedValue must be low/medium/high`,
			path,
		});
		return null;
	}
	const recommendedReasoningEffort =
		raw.recommendedReasoningEffort === undefined
			? undefined
			: VALID_EFFORTS.has(raw.recommendedReasoningEffort as ReasoningEffort)
				? (raw.recommendedReasoningEffort as ReasoningEffort)
				: undefined;

	return Object.freeze({
		instanceId,
		moduleId,
		version,
		purpose,
		reasonSelected,
		workerMode,
		strategyFamily: typeof raw.strategyFamily === "string" ? raw.strategyFamily.trim() || undefined : undefined,
		contextPolicy,
		inputs: Object.freeze(isStringArray(raw.inputs) ? [...raw.inputs] : []),
		expectedOutputs: Object.freeze(isStringArray(raw.expectedOutputs) ? [...raw.expectedOutputs] : []),
		criteriaSupported: Object.freeze(isStringArray(raw.criteriaSupported) ? [...raw.criteriaSupported] : []),
		evidenceRequired: Object.freeze(isStringArray(raw.evidenceRequired) ? [...raw.evidenceRequired] : []),
		dependencies: Object.freeze(isStringArray(raw.dependencies) ? [...raw.dependencies] : []),
		stopConditions: Object.freeze(isStringArray(raw.stopConditions) ? [...raw.stopConditions] : []),
		recommendedProfile:
			typeof raw.recommendedProfile === "string" ? raw.recommendedProfile.trim() || undefined : undefined,
		recommendedModelRole:
			typeof raw.recommendedModelRole === "string" ? raw.recommendedModelRole.trim() || undefined : undefined,
		recommendedReasoningEffort,
		estimatedCost,
		estimatedValue,
	});
}

function parseDependencyEdge(
	raw: unknown,
	index: number,
	diagnostics: ReasoningPlanDiagnostic[],
): DependencyEdge | null {
	const path = `dependencyEdges[${index}]`;
	if (!isPlainObject(raw)) {
		diagnostics.push({ code: "invalid_type", message: `${path} must be an object` });
		return null;
	}
	const from = typeof raw.fromModuleInstanceId === "string" ? raw.fromModuleInstanceId.trim() : "";
	const to = typeof raw.toModuleInstanceId === "string" ? raw.toModuleInstanceId.trim() : "";
	const kind = raw.kind;
	if (!from || !to || !VALID_DEP_KINDS.has(kind as string)) {
		diagnostics.push({
			code: "missing_field",
			message: `${path} requires fromModuleInstanceId, toModuleInstanceId, kind (requires|blocks|informs)`,
			path,
		});
		return null;
	}
	return Object.freeze({ fromModuleInstanceId: from, toModuleInstanceId: to, kind: kind as DependencyEdge["kind"] });
}

function parseExecutionPolicy(raw: unknown, diagnostics: ReasoningPlanDiagnostic[]): ExecutionPolicy | null {
	if (!isPlainObject(raw)) {
		diagnostics.push({ code: "missing_field", message: "executionPolicy is required", path: "executionPolicy" });
		return null;
	}
	const mode = raw.orchestrationMode;
	if (!VALID_ORCHESTRATION_MODES.has(mode as string)) {
		diagnostics.push({
			code: "invalid_field",
			message: `executionPolicy.orchestrationMode "${mode}" is not valid`,
			path: "executionPolicy.orchestrationMode",
		});
		return null;
	}
	const schedulingPolicy: SchedulingPolicy =
		raw.schedulingPolicy === "judgment" ? "judgment" : "critical_path";
	return Object.freeze({
		orchestrationMode: mode as ExecutionPolicy["orchestrationMode"],
		schedulingPolicy,
		maxConcurrentWorkers: typeof raw.maxConcurrentWorkers === "number" ? Math.max(1, raw.maxConcurrentWorkers) : 4,
		maxRounds: typeof raw.maxRounds === "number" ? Math.max(1, raw.maxRounds) : 4,
		maxSameBlockerRetries:
			typeof raw.maxSameBlockerRetries === "number" ? Math.max(0, raw.maxSameBlockerRetries) : 1,
	});
}

function parseVerificationSpec(raw: unknown): PlanVerificationSpec {
	if (!isPlainObject(raw))
		return Object.freeze({ criterionIds: [], requiredAudits: [], requireFreshContextVerifier: false });
	return Object.freeze({
		criterionIds: Object.freeze(isStringArray(raw.criterionIds) ? [...raw.criterionIds] : []),
		requiredAudits: Object.freeze(isStringArray(raw.requiredAudits) ? [...raw.requiredAudits] : []),
		requireFreshContextVerifier: raw.requireFreshContextVerifier === true,
	});
}

function parseStopConditions(raw: unknown, diagnostics: ReasoningPlanDiagnostic[]): PlanStopCondition[] {
	if (!Array.isArray(raw)) {
		diagnostics.push({ code: "missing_field", message: "stopConditions must be an array", path: "stopConditions" });
		return [];
	}
	const out: PlanStopCondition[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!isPlainObject(item)) continue;
		const type = item.type;
		const description = typeof item.description === "string" ? item.description.trim() : "";
		if (!VALID_STOP_TYPES.has(type as string) || !description) continue;
		out.push(Object.freeze({ type: type as PlanStopCondition["type"], description }));
	}
	return out;
}

function parseTaskProfile(raw: unknown, diagnostics: ReasoningPlanDiagnostic[]): TaskProfile | null {
	if (!isPlainObject(raw)) {
		diagnostics.push({ code: "missing_field", message: "taskProfile is required", path: "taskProfile" });
		return null;
	}
	const taskClass = typeof raw.taskClass === "string" ? raw.taskClass.trim() : "";
	if (!taskClass) {
		diagnostics.push({ code: "missing_field", message: "taskProfile.taskClass is required", path: "taskProfile.taskClass" });
		return null;
	}
	const complexity = VALID_COMPLEXITY.has(raw.complexity as string)
		? (raw.complexity as TaskProfile["complexity"])
		: "moderate";
	const uncertainty = typeof raw.uncertainty === "number" ? Math.min(1, Math.max(0, raw.uncertainty)) : 0.5;
	const consequence = VALID_CONSEQUENCE.has(raw.consequence as string)
		? (raw.consequence as TaskProfile["consequence"])
		: "medium";
	const expectedHorizon = VALID_HORIZON.has(raw.expectedHorizon as string)
		? (raw.expectedHorizon as TaskProfile["expectedHorizon"])
		: "multi_step";
	return Object.freeze({ taskClass, complexity, uncertainty, consequence, expectedHorizon });
}

/** Compute a stable SHA-256 digest over the plan's canonical fields (excludes the digest itself). */
export function computeReasoningPlanDigest(plan: Omit<ReasoningPlanV1, "digest">): string {
	const payload = JSON.stringify({
		id: plan.id,
		version: plan.version,
		taskContractId: plan.taskContractId,
		taskContractDigest: plan.taskContractDigest,
		selectedModules: plan.selectedModules,
		dependencyEdges: plan.dependencyEdges,
		executionPolicy: plan.executionPolicy,
	});
	return createHash("sha256").update(payload).digest("hex");
}

export function computeTaskContractDigest(contract: TaskContractV1): string {
	const payload = JSON.stringify({
		version: contract.version,
		objective: contract.objective,
		deliverables: contract.deliverables,
		completionCriteria: contract.completionCriteria,
		nonSolutions: contract.nonSolutions,
		knownFailureModes: contract.knownFailureModes,
		constraints: contract.constraints,
	});
	return createHash("sha256").update(payload).digest("hex");
}

export function parseReasoningPlan(input: unknown): ParseReasoningPlanResult {
	const diagnostics: ReasoningPlanDiagnostic[] = [];
	if (!isPlainObject(input)) {
		return { ok: false, diagnostics: [{ code: "invalid_type", message: "Reasoning plan must be an object" }] };
	}
	if (input.version !== REASONING_PLAN_VERSION) {
		diagnostics.push({
			code: "invalid_version",
			message: `Expected version ${REASONING_PLAN_VERSION}`,
			path: "version",
		});
	}
	const id = typeof input.id === "string" ? input.id.trim() : "";
	if (!id) diagnostics.push({ code: "missing_field", message: "id is required", path: "id" });

	const taskContractId = typeof input.taskContractId === "string" ? input.taskContractId.trim() : "";
	if (!taskContractId)
		diagnostics.push({ code: "missing_field", message: "taskContractId is required", path: "taskContractId" });

	const taskContractDigest = typeof input.taskContractDigest === "string" ? input.taskContractDigest.trim() : "";
	if (!taskContractDigest)
		diagnostics.push({
			code: "missing_field",
			message: "taskContractDigest is required",
			path: "taskContractDigest",
		});

	const taskProfile = parseTaskProfile(input.taskProfile, diagnostics);
	const executionPolicy = parseExecutionPolicy(input.executionPolicy, diagnostics);

	const selectedModules: SelectedReasoningModule[] = [];
	if (Array.isArray(input.selectedModules)) {
		for (let i = 0; i < input.selectedModules.length; i++) {
			const m = parseModule(input.selectedModules[i], i, diagnostics);
			if (m) selectedModules.push(m);
		}
	} else {
		diagnostics.push({
			code: "missing_field",
			message: "selectedModules must be an array",
			path: "selectedModules",
		});
	}
	if (selectedModules.length === 0 && !diagnostics.some(d => d.path === "selectedModules")) {
		diagnostics.push({
			code: "empty_value",
			message: "selectedModules must include at least one module",
			path: "selectedModules",
		});
	}

	const dependencyEdges: DependencyEdge[] = [];
	if (Array.isArray(input.dependencyEdges)) {
		for (let i = 0; i < input.dependencyEdges.length; i++) {
			const e = parseDependencyEdge(input.dependencyEdges[i], i, diagnostics);
			if (e) dependencyEdges.push(e);
		}
	}

	const stopConditions = parseStopConditions(input.stopConditions, diagnostics);
	const verificationPlan = parseVerificationSpec(input.verificationPlan);

	if (diagnostics.length > 0 || !id || !taskContractId || !taskContractDigest || !taskProfile || !executionPolicy) {
		return { ok: false, diagnostics };
	}

	const planWithoutDigest: Omit<ReasoningPlanV1, "digest"> = {
		id,
		version: REASONING_PLAN_VERSION,
		taskContractId,
		taskContractDigest,
		taskProfile,
		selectedModules: Object.freeze(selectedModules),
		dependencyEdges: Object.freeze(dependencyEdges),
		executionPolicy,
		verificationPlan,
		stopConditions: Object.freeze(stopConditions),
	};

	const computedDigest = computeReasoningPlanDigest(planWithoutDigest);
	const suppliedDigest = typeof input.digest === "string" ? input.digest.trim() : "";
	if (suppliedDigest && suppliedDigest !== computedDigest) {
		return {
			ok: false,
			diagnostics: [
				{
					code: "digest_mismatch",
					message: `Plan digest mismatch: supplied ${suppliedDigest}, computed ${computedDigest}`,
					path: "digest",
				},
			],
		};
	}

	return {
		ok: true,
		plan: Object.freeze({ ...planWithoutDigest, digest: computedDigest }),
	};
}

/** Check whether a plan's taskContractDigest still matches the current contract. */
export function isPlanCurrentForContract(plan: ReasoningPlanV1, contract: TaskContractV1): boolean {
	return plan.taskContractDigest === computeTaskContractDigest(contract);
}

/** Audit a parsed plan for structural defects. Returns blocking and warning findings. */
export function auditReasoningPlan(plan: ReasoningPlanV1): readonly PlanAuditFinding[] {
	const findings: PlanAuditFinding[] = [];
	const instanceIds = new Set(plan.selectedModules.map(m => m.instanceId));

	for (const edge of plan.dependencyEdges) {
		if (!instanceIds.has(edge.fromModuleInstanceId)) {
			findings.push({
				severity: "blocking",
				code: "unknown_dependency_source",
				message: `Dependency edge references unknown fromModuleInstanceId "${edge.fromModuleInstanceId}"`,
			});
		}
		if (!instanceIds.has(edge.toModuleInstanceId)) {
			findings.push({
				severity: "blocking",
				code: "unknown_dependency_target",
				message: `Dependency edge references unknown toModuleInstanceId "${edge.toModuleInstanceId}"`,
			});
		}
	}

	const cycle = detectDagCycle(plan.selectedModules, plan.dependencyEdges);
	if (cycle) {
		findings.push({
			severity: "blocking",
			code: "dag_cycle",
			message: `Dependency DAG contains a cycle: ${cycle.join(" → ")}`,
		});
	}

	const hasFalsifier = plan.selectedModules.some(m => m.workerMode === "falsify");
	const hasAuditor = plan.selectedModules.some(m => m.workerMode === "audit");
	const isComplex =
		plan.taskProfile.complexity === "complex" || plan.taskProfile.complexity === "open_ended";
	if (isComplex && !hasFalsifier && !hasAuditor) {
		findings.push({
			severity: "warning",
			code: "no_independent_verification",
			message: "Complex/open-ended plan has no falsifier or auditor module",
		});
	}

	if (
		plan.executionPolicy.maxConcurrentWorkers > 1 &&
		plan.executionPolicy.orchestrationMode === "direct"
	) {
		findings.push({
			severity: "warning",
			code: "concurrent_workers_with_direct_mode",
			message: "direct orchestration mode with maxConcurrentWorkers > 1 is unusual",
		});
	}

	const seenInstances = new Set<string>();
	for (const m of plan.selectedModules) {
		if (seenInstances.has(m.instanceId)) {
			findings.push({
				severity: "blocking",
				code: "duplicate_instance_id",
				message: `Duplicate module instanceId "${m.instanceId}"`,
				moduleInstanceId: m.instanceId,
			});
		}
		seenInstances.add(m.instanceId);
	}

	return Object.freeze(findings);
}

function detectDagCycle(
	modules: readonly SelectedReasoningModule[],
	edges: readonly DependencyEdge[],
): readonly string[] | null {
	const adj = new Map<string, string[]>();
	for (const m of modules) adj.set(m.instanceId, []);
	for (const e of edges) {
		if (e.kind === "requires" || e.kind === "blocks") {
			adj.get(e.fromModuleInstanceId)?.push(e.toModuleInstanceId);
		}
	}
	const WHITE = 0, GRAY = 1, BLACK = 2;
	const color = new Map<string, number>();
	const parent = new Map<string, string>();
	for (const id of adj.keys()) color.set(id, WHITE);

	function dfs(u: string): string[] | null {
		color.set(u, GRAY);
		for (const v of adj.get(u) ?? []) {
			if (color.get(v) === GRAY) {
				const cycle: string[] = [v];
				let cur: string | undefined = u;
				while (cur && cur !== v) {
					cycle.unshift(cur);
					cur = parent.get(cur);
				}
				cycle.unshift(v);
				return cycle;
			}
			if (color.get(v) === WHITE) {
				parent.set(v, u);
				const result = dfs(v);
				if (result) return result;
			}
		}
		color.set(u, BLACK);
		return null;
	}

	for (const id of adj.keys()) {
		if (color.get(id) === WHITE) {
			const cycle = dfs(id);
			if (cycle) return cycle;
		}
	}
	return null;
}
