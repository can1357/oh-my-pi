/**
 * Deterministic orchestration policy for OMP Ultra.
 *
 * This module owns execution-state decisions only. It never executes tools,
 * calls models, or creates a second agent loop. Existing specialized runtimes
 * remain the owners of execution mechanisms.
 */
import type { ModelCapabilities, StrategyProfile } from "./model-capability";
import type { TaskClassification, TaskComplexity } from "./task-router";

export const ORCHESTRATION_PHASES = ["UNDERSTAND", "PLAN", "IMPLEMENT", "VERIFY", "RECOVER", "REVIEW", "COMPLETE", "BLOCKED"] as const;
export type OrchestrationPhase = (typeof ORCHESTRATION_PHASES)[number];
export const ORCHESTRATION_ACTIONS = ["DISCOVER", "PLAN", "IMPLEMENT", "VERIFY", "DIAGNOSE", "REPAIR", "REVIEW", "COMPACT", "REFRESH_CONTEXT", "REFRESH_REPOSITORY", "ESCALATE", "COMPLETE", "BLOCK"] as const;
export type OrchestrationAction = (typeof ORCHESTRATION_ACTIONS)[number];
export type OrchestrationOutcome = "PENDING" | "VERIFIED" | "UNVERIFIED" | "FAILED" | "BLOCKED";

export interface OrchestrationVerificationEvidence { state?: OrchestrationOutcome; failureCategory?: string; failureCheck?: string; checksSelected?: number; checksPassed?: number; checksFailed?: number; workspaceChanged?: boolean; blocked?: boolean; }
export interface OrchestrationFailureEvidence { present: boolean; category?: string; check?: string; summary?: string; repeatCount: number; }
export interface OrchestrationRepositoryEvidence { available: boolean; fresh?: boolean; changed?: boolean; relevantFileCount?: number; crossesSubsystems?: boolean; }
export interface OrchestrationContextEvidence { available: boolean; pressure?: number; estimatedTokens?: number; budgetTokens?: number; }
export interface OrchestrationMemoryEvidence { retrieved: number; contextTokens: number; degraded: boolean; }
export interface OrchestrationToolEvidence { calls: number; failures: number; lastTools: string[]; parallelSupported: boolean; }
export interface OrchestrationMetrics {
	modelCalls: number; toolCalls: number; toolFailures: number; parallelGroups: number; verificationChecks: number;
	repairAttempts: number; escalations: number; strategyChanges: number; compactions: number; memoryRetrievals: number; repositoryQueries: number;
	modelWaitMs: number; toolWaitMs: number; phaseDurationsMs: Partial<Record<OrchestrationPhase, number>>;
}
export interface OrchestrationState {
	task: string; complexity: TaskComplexity; confidence: number; currentPhase: OrchestrationPhase; currentObjective: string;
	changedFiles: string[]; activeFiles: string[]; activeSymbols: string[]; verification: OrchestrationVerificationEvidence; failure: OrchestrationFailureEvidence;
	repository: OrchestrationRepositoryEvidence; context: OrchestrationContextEvidence; memory: OrchestrationMemoryEvidence; tools: OrchestrationToolEvidence;
	modelCapabilities?: ModelCapabilities; modelStrategy?: StrategyProfile; attemptCount: number; repairCount: number; escalationLevel: number; escalationCount: number;
	reviewRequested: boolean; reviewCompleted: boolean; strategyHistory: string[]; phaseHistory: Array<{ phase: OrchestrationPhase; at: number; reason: string }>;
	lastAction?: OrchestrationAction; lastReason?: string; outcome: OrchestrationOutcome; durationMs?: number; metrics: OrchestrationMetrics;
}
export interface OrchestrationDecision {
	action: OrchestrationAction; reason: string; requiredCapabilities: string[]; contextRequirements: string[];
	verificationRequirement: "none" | "basic" | "standard" | "deep" | "final"; escalationLevel: number; strategyFingerprint: string;
}
export interface OrchestrationTransition { from: OrchestrationPhase; to: OrchestrationPhase; reason: string; at: number; }

const COMPLEXITY_RANK: Record<TaskComplexity, number> = { SIMPLE: 0, NORMAL: 1, COMPLEX: 2, VERY_COMPLEX: 3 };
function maxEscalations(state: OrchestrationState): number { return state.complexity === "VERY_COMPLEX" || state.modelStrategy?.verificationDepth === "deep" ? 3 : state.complexity === "COMPLEX" ? 2 : 1; }
function hasRequiredVerification(state: OrchestrationState): boolean { if (!state.verification.workspaceChanged && state.changedFiles.length === 0) return false; return state.verification.checksSelected !== 0 || state.complexity !== "SIMPLE"; }
function reviewRequired(state: OrchestrationState): boolean { if (state.reviewCompleted) return false; return state.complexity === "VERY_COMPLEX" || state.complexity === "COMPLEX" || (state.complexity === "NORMAL" && (state.verification.checksSelected ?? 0) > 0); }
function contextRequirements(state: OrchestrationState, action: OrchestrationAction): string[] {
	switch (action) {
		case "PLAN": return ["repository architecture", "constraints", ...(state.memory.retrieved > 0 ? ["relevant durable memory"] : [])];
		case "IMPLEMENT": return ["active files", "relevant dependencies"];
		case "DIAGNOSE": case "REPAIR": return ["failure evidence", "affected code", "previous strategy attempts"];
		case "REVIEW": return ["changed files", "verification evidence", "task requirements"];
		case "DISCOVER": return ["repository intelligence", "directly relevant files"];
		case "REFRESH_CONTEXT": return ["latest active files", "latest failures", "changed hypothesis"];
		default: return [];
	}
}
function capabilityRequirements(state: OrchestrationState, action: OrchestrationAction): string[] {
	const requirements: string[] = [];
	if (action === "IMPLEMENT" || action === "REPAIR") requirements.push("tool calling");
	if (action === "REVIEW" && COMPLEXITY_RANK[state.complexity] >= 2) requirements.push("reasoning");
	if (state.modelCapabilities?.structuredOutput === "supported") requirements.push("structured output");
	return [...new Set(requirements)];
}
function strategyFingerprint(state: Pick<OrchestrationState, "currentPhase" | "complexity" | "escalationLevel" | "failure" | "changedFiles" | "tools" | "verification">, action: OrchestrationAction): string {
	return [action, state.currentPhase, state.complexity, String(state.escalationLevel), state.failure.category ?? "none", state.failure.check ?? "none", String(state.failure.repeatCount), state.verification.failureCategory ?? "none", [...state.changedFiles].sort().slice(0, 12).join(","), state.tools.lastTools.slice(-6).join(",")].join("|");
}
function stagnating(state: OrchestrationState, fingerprint: string): boolean { const recent = state.strategyHistory.slice(-3); return recent.length >= 2 && recent.every(item => item === fingerprint); }
function decision(action: OrchestrationAction, reason: string, state: OrchestrationState, verificationRequirement: OrchestrationDecision["verificationRequirement"]): OrchestrationDecision {
	return { action, reason, requiredCapabilities: capabilityRequirements(state, action), contextRequirements: contextRequirements(state, action), verificationRequirement, escalationLevel: state.escalationLevel, strategyFingerprint: strategyFingerprint(state, action) };
}
function decideReviewOrComplete(state: OrchestrationState): OrchestrationDecision {
	if (hasRequiredVerification(state) && state.verification.state !== "VERIFIED") return decision("VERIFY", "completion is gated by verification evidence", state, "standard");
	if (state.verification.state === "BLOCKED" || state.verification.blocked) return decision("BLOCK", "verification is blocked", state, "none");
	if (reviewRequired(state)) return decision("REVIEW", "task complexity warrants a bounded review pass", state, "standard");
	return decision("COMPLETE", "required work and verification evidence are complete", state, "none");
}
export function createInitialOrchestrationState(task: string, classification: TaskClassification): OrchestrationState {
	const firstPhase: OrchestrationPhase = classification.complexity === "SIMPLE" ? "IMPLEMENT" : "UNDERSTAND";
	const fileMatches = task.match(/(?:^|\\s|[`(])((?:[.]{0,2}\\/)?[\\w@.-]+(?:\\/[\\w@.-]+)+\\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|sql|css|scss|md|json|yaml|yml))(?:\\b|[`)]?)/gi) ?? [];
	const symbolMatches = [...task.matchAll(/`([A-Za-z_$][\\w$]*(?:\\([^`]*\\))?)`/g)].map(match => match[1]).filter(Boolean) as string[];
	return {
		task, complexity: classification.complexity, confidence: classification.confidence, currentPhase: firstPhase,
		currentObjective: firstPhase === "IMPLEMENT" ? "Make the smallest correct change." : "Establish the minimum facts needed to execute reliably.",
		changedFiles: [], activeFiles: [...new Set(fileMatches.map(value => value.trim().replace(/^[`(]+/, "")))].slice(0, 16), activeSymbols: [...new Set(symbolMatches)].slice(0, 16),
		verification: { state: "PENDING", workspaceChanged: false }, failure: { present: false, repeatCount: 0 }, repository: { available: false }, context: { available: false }, memory: { retrieved: 0, contextTokens: 0, degraded: false },
		tools: { calls: 0, failures: 0, lastTools: [], parallelSupported: false }, attemptCount: 0, repairCount: 0, escalationLevel: 0, escalationCount: 0, reviewRequested: false, reviewCompleted: false,
		strategyHistory: [], phaseHistory: [{ phase: firstPhase, at: Date.now(), reason: "initial task policy" }], outcome: "PENDING",
		metrics: { modelCalls: 0, toolCalls: 0, toolFailures: 0, parallelGroups: 0, verificationChecks: 0, repairAttempts: 0, escalations: 0, strategyChanges: 0, compactions: 0, memoryRetrievals: 0, repositoryQueries: 0, modelWaitMs: 0, toolWaitMs: 0, phaseDurationsMs: {} },
	};
}
export function decideNextAction(state: OrchestrationState): OrchestrationDecision {
	if (state.outcome === "BLOCKED" || state.verification.state === "BLOCKED" || state.verification.blocked) return decision("BLOCK", "execution is explicitly blocked", state, "none");
	if (state.outcome === "VERIFIED" || state.currentPhase === "COMPLETE") return decision("COMPLETE", "successful evidence already satisfies the completion contract", state, "none");
	if (state.context.pressure !== undefined && state.context.pressure >= 0.9 && state.lastAction !== "COMPACT") return decision("COMPACT", "context pressure is high; preserve task state before continuing", state, "none");
	if (state.repository.changed && state.currentPhase !== "UNDERSTAND" && state.lastAction !== "REFRESH_REPOSITORY") return decision("REFRESH_REPOSITORY", "repository state changed after the last structural observation", state, "none");
	if (state.failure.present) {
		if (state.lastAction === "DIAGNOSE") return decision("REPAIR", "failure is diagnosed; execute the targeted repair strategy", state, "standard");
		if (state.lastAction === "REPAIR") return decision("VERIFY", "repair was attempted; gather fresh verification evidence", state, "standard");
		if (state.lastAction === "VERIFY" && state.verification.state !== "FAILED" && state.verification.state !== "BLOCKED") return decision("VERIFY", "verification is pending after the latest strategy change", state, "standard");
		if (state.lastAction === "REFRESH_CONTEXT") return decision("REPAIR", "fresh context is available; execute a changed recovery strategy", state, "standard");
		if (state.lastAction === "ESCALATE") {
			if (state.repairCount >= maxEscalations(state)) return decision("BLOCK", "bounded recovery is exhausted after escalation", state, "none");
			return decision("REFRESH_CONTEXT", "escalation requires a meaningfully different evidence/context strategy", state, "standard");
		}
		if (state.failure.repeatCount >= 2 || state.repairCount >= maxEscalations(state) || state.escalationLevel >= maxEscalations(state)) return decision("ESCALATE", "the current recovery strategy has reached its bounded limit", state, "deep");
		if (stagnating(state, strategyFingerprint(state, "REPAIR"))) return decision("REFRESH_CONTEXT", "the same repair strategy is repeating without new evidence", state, "standard");
		return decision("DIAGNOSE", "verification/tool evidence identifies a recoverable failure", state, "standard");
	}
	switch (state.currentPhase) {
		case "UNDERSTAND":
			if (state.complexity === "SIMPLE") return decision("IMPLEMENT", "simple task needs no separate plan", state, "none");
			if (!state.repository.available && COMPLEXITY_RANK[state.complexity] >= 2) return decision("DISCOVER", "complex scope benefits from repository intelligence before planning", state, "none");
			return decision("PLAN", "task complexity justifies a structured plan", state, "none");
		case "PLAN": return decision("IMPLEMENT", "planning prerequisites are satisfied; move to execution", state, "none");
		case "IMPLEMENT":
			if (state.verification.workspaceChanged || state.changedFiles.length > 0) return decision("VERIFY", "implementation changed the workspace and must pass the verification gate", state, "basic");
			return decision("IMPLEMENT", "continue the current implementation strategy", state, "none");
		case "VERIFY":
			if (state.verification.state === "FAILED" || state.failure.present) return decision("DIAGNOSE", "verification failed", state, "standard");
			if (state.verification.state === "BLOCKED") return decision("BLOCK", "verification is blocked", state, "none");
			if (state.verification.state === "VERIFIED") return decideReviewOrComplete(state);
			return decision("VERIFY", "verification evidence is pending", state, "standard");
		case "RECOVER": return decision("REPAIR", "continue the bounded recovery path", state, "standard");
		case "REVIEW":
			if (state.verification.state === "FAILED" || state.failure.present) return decision("DIAGNOSE", "review exposed unresolved failure evidence", state, "standard");
			if (!state.reviewCompleted) return decision("REVIEW", "complete the bounded review pass", state, "standard");
			return decision("COMPLETE", "review is complete and verification remains satisfied", state, "none");
		case "BLOCKED": return decision("BLOCK", "blocked state requires explicit external resolution", state, "none");
		case "COMPLETE": return decision("COMPLETE", "completion state reached", state, "none");
	}
}
export function applyDecision(state: OrchestrationState, decisionResult: OrchestrationDecision, at = Date.now()): OrchestrationTransition | undefined {
	const previousPhase = state.currentPhase;
	const previousAction = state.lastAction;
	const phaseMap: Partial<Record<OrchestrationAction, OrchestrationPhase>> = { DISCOVER: "UNDERSTAND", PLAN: "PLAN", IMPLEMENT: "IMPLEMENT", VERIFY: "VERIFY", DIAGNOSE: "RECOVER", REPAIR: "RECOVER", REVIEW: "REVIEW", COMPACT: previousPhase, REFRESH_CONTEXT: previousPhase, REFRESH_REPOSITORY: "UNDERSTAND", ESCALATE: "RECOVER", COMPLETE: "COMPLETE", BLOCK: "BLOCKED" };
	const nextPhase = phaseMap[decisionResult.action] ?? previousPhase;
	state.lastAction = decisionResult.action; state.lastReason = decisionResult.reason;
	if (state.strategyHistory[state.strategyHistory.length - 1] !== decisionResult.strategyFingerprint) state.strategyHistory.push(decisionResult.strategyFingerprint);
	state.strategyHistory = state.strategyHistory.slice(-8);
	if (decisionResult.action === "ESCALATE" && previousAction !== "ESCALATE") { state.escalationCount += 1; state.escalationLevel += 1; state.metrics.escalations = state.escalationCount; state.metrics.strategyChanges += 1; }
	if (decisionResult.action === "REPAIR" && previousAction !== "REPAIR") { state.repairCount += 1; state.attemptCount += 1; state.metrics.repairAttempts = state.repairCount; }
	if (decisionResult.action === "COMPACT" && previousAction !== "COMPACT") state.metrics.compactions += 1;
	if (decisionResult.action === "REFRESH_CONTEXT" && previousAction !== "REFRESH_CONTEXT") state.metrics.strategyChanges += 1;
	if (decisionResult.action === "REFRESH_REPOSITORY" && previousAction !== "REFRESH_REPOSITORY") { state.metrics.strategyChanges += 1; state.repository.changed = false; }
	if (nextPhase !== previousPhase) {
		const previousEntry = state.phaseHistory[state.phaseHistory.length - 1];
		if (previousEntry) state.metrics.phaseDurationsMs[previousEntry.phase] = Math.max(0, at - previousEntry.at);
		state.currentPhase = nextPhase; state.currentObjective = objectiveFor(nextPhase); state.phaseHistory.push({ phase: nextPhase, at, reason: decisionResult.reason });
	}
	if (decisionResult.action === "COMPLETE") state.outcome = "VERIFIED";
	if (decisionResult.action === "BLOCK") state.outcome = "BLOCKED";
	return nextPhase !== previousPhase ? { from: previousPhase, to: nextPhase, reason: decisionResult.reason, at } : undefined;
}
function objectiveFor(phase: OrchestrationPhase): string {
	switch (phase) {
		case "UNDERSTAND": return "Collect only the facts necessary to reduce uncertainty.";
		case "PLAN": return "Choose the smallest reliable implementation strategy.";
		case "IMPLEMENT": return "Execute the selected implementation without unnecessary work.";
		case "VERIFY": return "Gather evidence that the requested outcome is actually satisfied.";
		case "RECOVER": return "Change the strategy using the smallest justified escalation.";
		case "REVIEW": return "Check scope, correctness, and important regressions adaptively.";
		case "COMPLETE": return "Return a completion backed by appropriate evidence.";
		case "BLOCKED": return "Expose the exact external condition preventing reliable completion.";
	}
}
export function orchestrationStateFrom(task: string, classification: TaskClassification, modelStrategy?: StrategyProfile, modelCapabilities?: ModelCapabilities): OrchestrationState { const state = createInitialOrchestrationState(task, classification); state.modelStrategy = modelStrategy; state.modelCapabilities = modelCapabilities; return state; }
