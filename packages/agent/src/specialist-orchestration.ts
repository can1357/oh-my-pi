import type { OrchestrationState } from "./orchestration";
import type { TaskComplexity } from "./task-router";

export const SPECIALIST_ROLES = ["EXPLORER", "ARCHITECT", "DEBUGGER", "TEST_ENGINEER", "REVIEWER", "SECURITY_REVIEWER", "RESEARCHER"] as const;
export type SpecialistRole = (typeof SPECIALIST_ROLES)[number];
export type DelegationAction = "DELEGATE" | "PARALLEL_DELEGATE" | "SKIP_DELEGATION";

export interface SpecialistContextRequest {
	task: string;
	relevantFiles: string[];
	activeFiles: string[];
	activeSymbols: string[];
	failure?: { category?: string; check?: string; summary?: string; attempts: number };
	hypothesis?: string;
	constraints: string[];
	question: string;
}

export interface SpecialistRoleContract {
	role: SpecialistRole;
	defaultReadOnly: true;
	primaryQuestion: string;
	outputFields: readonly string[];
}

export const SPECIALIST_CONTRACTS: Record<SpecialistRole, SpecialistRoleContract> = {
	EXPLORER: { role: "EXPLORER", defaultReadOnly: true, primaryQuestion: "What repository structure or dependency facts matter?", outputFields: ["findings", "relevantFiles", "dependencies", "unknowns"] },
	ARCHITECT: { role: "ARCHITECT", defaultReadOnly: true, primaryQuestion: "What architecture choice best satisfies the constraints?", outputFields: ["problem", "currentArchitecture", "options", "recommendation", "tradeoffs", "risks"] },
	DEBUGGER: { role: "DEBUGGER", defaultReadOnly: true, primaryQuestion: "What is the most evidence-backed root cause?", outputFields: ["failure", "evidence", "rootCauseHypothesis", "confidence", "recommendedFix"] },
	TEST_ENGINEER: { role: "TEST_ENGINEER", defaultReadOnly: true, primaryQuestion: "What test surface is missing or most valuable?", outputFields: ["testSurface", "missingCoverage", "targetTests", "risks"] },
	REVIEWER: { role: "REVIEWER", defaultReadOnly: true, primaryQuestion: "Is the implemented scope correct and regression-safe?", outputFields: ["correctness", "regressions", "scope", "risks", "recommendation"] },
	SECURITY_REVIEWER: { role: "SECURITY_REVIEWER", defaultReadOnly: true, primaryQuestion: "What concrete security findings exist in the changed surface?", outputFields: ["findings", "severity", "affectedLocations", "recommendation"] },
	RESEARCHER: { role: "RESEARCHER", defaultReadOnly: true, primaryQuestion: "What external fact is genuinely required to resolve the task?", outputFields: ["question", "findings", "sources", "uncertainties", "recommendation"] },
};

export interface DelegationPolicyInput {
	task: string;
	complexity: TaskComplexity;
	confidence: number;
	repositorySize?: "small" | "medium" | "large";
	uncertainty?: boolean;
	crossSubsystem?: boolean;
	failureCount: number;
	architectureAmbiguity?: boolean;
	independentVerification?: boolean;
	externalResearchRequired?: boolean;
	securitySensitive?: boolean;
	hasExistingRelevantEvidence?: boolean;
	availableBudgetTokens: number;
	allowParallel: boolean;
	maxConcurrent: number;
	alreadyDelegatedRoles?: SpecialistRole[];
}

export interface DelegationDecision {
	action: DelegationAction;
	role?: SpecialistRole;
	roles: SpecialistRole[];
	reason: string;
	expectedBenefit: "none" | "low" | "medium" | "high";
	estimatedTokenCost: number;
	estimatedLatencyMs: number;
	contextRequired: string[];
	parallelGroup?: string;
	readOnly: true;
}

const ROLE_COST: Record<SpecialistRole, number> = {
	EXPLORER: 900,
	ARCHITECT: 1300,
	DEBUGGER: 1100,
	TEST_ENGINEER: 900,
	REVIEWER: 1100,
	SECURITY_REVIEWER: 1200,
	RESEARCHER: 1300,
};

function unavailableBudget(input: DelegationPolicyInput, roles: SpecialistRole[]): boolean {
	const reserve = roles.reduce((sum, role) => sum + ROLE_COST[role], 0);
	return input.availableBudgetTokens <= reserve + 400;
}

function selectedRoles(input: DelegationPolicyInput): SpecialistRole[] {
	const already = new Set(input.alreadyDelegatedRoles ?? []);
	const roles: SpecialistRole[] = [];
	if (input.securitySensitive) roles.push("SECURITY_REVIEWER");
	if (input.failureCount >= 2) roles.push("DEBUGGER");
	if (input.architectureAmbiguity && input.complexity !== "SIMPLE") roles.push("ARCHITECT");
	if (input.externalResearchRequired) roles.push("RESEARCHER");
	if (input.independentVerification && input.complexity !== "SIMPLE") roles.push("REVIEWER");
	if (input.complexity === "VERY_COMPLEX" && input.repositorySize === "large" && input.uncertainty) roles.push("EXPLORER");
	if (input.failureCount > 0 && input.complexity !== "SIMPLE") roles.push("TEST_ENGINEER");
	return [...new Set(roles)].filter(role => !already.has(role));
}

export function decideDelegation(input: DelegationPolicyInput): DelegationDecision {
	if (input.complexity === "SIMPLE") return { action: "SKIP_DELEGATION", roles: [], reason: "simple task; another agent adds coordination cost without material benefit", expectedBenefit: "none", estimatedTokenCost: 0, estimatedLatencyMs: 0, contextRequired: [], readOnly: true };
	if (input.hasExistingRelevantEvidence && !input.uncertainty && input.failureCount === 0 && !input.securitySensitive && !input.architectureAmbiguity && !input.externalResearchRequired) return { action: "SKIP_DELEGATION", roles: [], reason: "current evidence is already sufficient", expectedBenefit: "none", estimatedTokenCost: 0, estimatedLatencyMs: 0, contextRequired: [], readOnly: true };
	const roles = selectedRoles(input);
	if (roles.length === 0) return { action: "SKIP_DELEGATION", roles: [], reason: "no specialist role has enough expected value for the current evidence", expectedBenefit: "none", estimatedTokenCost: 0, estimatedLatencyMs: 0, contextRequired: [], readOnly: true };
	if (unavailableBudget(input, roles)) return { action: "SKIP_DELEGATION", roles: [], reason: "specialist reserve would exceed the remaining task budget", expectedBenefit: "low", estimatedTokenCost: roles.reduce((s, r) => s + ROLE_COST[r], 0), estimatedLatencyMs: 0, contextRequired: [], readOnly: true };
	const independent = roles.filter(role => ["EXPLORER", "ARCHITECT", "SECURITY_REVIEWER"].includes(role));
	if (input.allowParallel && input.maxConcurrent > 1 && independent.length >= 2 && !input.failureCount) {
		const selected = independent.slice(0, Math.max(1, Math.min(input.maxConcurrent, 3)));
		return { action: "PARALLEL_DELEGATE", roles: selected, reason: "independent specialist perspectives can run concurrently without competing writes", expectedBenefit: "high", estimatedTokenCost: selected.reduce((s, r) => s + ROLE_COST[r], 0), estimatedLatencyMs: 20_000, contextRequired: ["task", "relevant repository facts", "specific specialist question"], parallelGroup: `specialists:${input.task.slice(0, 40)}`, readOnly: true };
	}
	const role = roles[0]!;
	const contextRequired = role === "DEBUGGER" ? ["failure evidence", "previous attempts", "affected files", "relevant diagnostics"] : role === "REVIEWER" ? ["task requirements", "git diff", "changed files", "verification evidence"] : role === "ARCHITECT" ? ["requirements", "current architecture", "affected subsystem", "constraints"] : role === "SECURITY_REVIEWER" ? ["changed files", "auth/input/network surface", "verification evidence"] : role === "RESEARCHER" ? ["specific external question", "existing repository facts"] : ["task", "relevant files", "repository facts", "specific question"];
	return { action: "DELEGATE", role, roles: [role], reason: role === "DEBUGGER" ? "repeated verification failures justify an independent diagnosis" : role === "ARCHITECT" ? "architecture ambiguity materially affects the implementation choice" : role === "SECURITY_REVIEWER" ? "security-sensitive scope warrants independent review" : role === "RESEARCHER" ? "external information is genuinely required" : "independent perspective has higher expected value than its bounded cost", expectedBenefit: "medium", estimatedTokenCost: ROLE_COST[role], estimatedLatencyMs: 15_000, contextRequired, readOnly: true };
}

export function buildSpecialistContext(input: SpecialistContextRequest, maxChars = 7000): string {
	const failure = input.failure ? `${input.failure.category ?? "failure"}: ${input.failure.summary ?? ""} (attempts=${input.failure.attempts})` : "none";
	return [`TASK\n${input.task}`, `RELEVANT FILES\n${input.relevantFiles.slice(0, 12).join("\n") || "none"}`, `ACTIVE FILES\n${input.activeFiles.slice(0, 12).join("\n") || "none"}`, `ACTIVE SYMBOLS\n${input.activeSymbols.slice(0, 12).join("\n") || "none"}`, `CURRENT FAILURE\n${failure}`, `CURRENT HYPOTHESIS\n${input.hypothesis ?? "none"}`, `CONSTRAINTS\n${input.constraints.slice(0, 8).join("\n") || "none"}`, `SPECIFIC QUESTION\n${input.question}`].join("\n\n").slice(0, maxChars);
}

export interface SpecialistFinding { role: SpecialistRole; summary: string; evidence: string[]; confidence: number; }
export interface SpecialistAggregation { consensus: SpecialistFinding[]; conflicts: Array<{ topic: string; findings: SpecialistFinding[] }>; unresolvedQuestions: string[]; recommendedNextAction?: string; }
function normalizedSummary(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

export function aggregateSpecialistFindings(findings: SpecialistFinding[]): SpecialistAggregation {
	if (findings.length === 0) return { consensus: [], conflicts: [], unresolvedQuestions: [] };
	const groups = new Map<string, SpecialistFinding[]>();
	for (const finding of findings) {
		const key = normalizedSummary(finding.summary);
		groups.set(key, [...(groups.get(key) ?? []), finding]);
	}
	const consensus: SpecialistFinding[] = [];
	for (const list of groups.values()) if (list.length > 1) consensus.push(list.reduce((best, item) => item.confidence > best.confidence ? item : best));
	const distinct = [...groups.values()];
	const conflicts = distinct.length > 1 ? [{ topic: "independent specialist hypotheses", findings }] : [];
	if (consensus.length === 0 && distinct.length === 1) consensus.push(distinct[0]![0]!);
	return { consensus, conflicts, unresolvedQuestions: conflicts.map(conflict => `Resolve evidence for: ${conflict.topic}`), recommendedNextAction: conflicts.length > 0 ? "compare conflicting hypotheses against repository and verification evidence" : consensus.length > 0 ? "use the evidence-backed finding and verify it" : undefined };
}

export function specialistModelBudget(input: DelegationPolicyInput, role: SpecialistRole): number {
	const base = ROLE_COST[role];
	const complexityMultiplier = input.complexity === "VERY_COMPLEX" ? 1.35 : input.complexity === "COMPLEX" ? 1.15 : 0.85;
	return Math.max(100, Math.min(base * complexityMultiplier, input.availableBudgetTokens * 0.2));
}

export function strategyFingerprintForDelegation(decision: DelegationDecision): string {
	return [decision.action, decision.roles.join(","), decision.reason, decision.parallelGroup ?? "none"].join("|");
}
