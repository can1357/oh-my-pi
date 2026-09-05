/** Cheap, deterministic task routing for OMP Ultra. No model calls, I/O, or provider assumptions. */

export const TASK_COMPLEXITIES = ["SIMPLE", "NORMAL", "COMPLEX", "VERY_COMPLEX"] as const;
export type TaskComplexity = (typeof TASK_COMPLEXITIES)[number];
export type TaskReasoningDepth = "minimal" | "low" | "medium" | "high" | "maximum";
export type TaskVerificationDepth = "basic" | "standard" | "deep" | "final";

export interface TaskWorkflowPolicy {
	inspect: boolean;
	plan: boolean;
	explore: boolean;
	architecture: boolean;
	specialistResearch: boolean;
	verification: TaskVerificationDepth;
	reviewPasses: 0 | 1 | 2;
	maxEscalations: 1 | 2 | 3;
	reasoningDepth: TaskReasoningDepth;
}

export interface TaskRepositorySignals {
	repositorySize?: "small" | "medium" | "large";
	projectType?: string;
	framework?: string;
	hasTests?: boolean;
	relevantFileCount?: number;
	subsystemCount?: number;
	crossesSubsystems?: boolean;
	knownUncertainty?: boolean;
}

export interface TaskClassifierSignals {
	requestedOutcomes: number;
	likelyFiles: number;
	bugFix: boolean;
	debugging: boolean;
	architecture: boolean;
	newFeature: boolean;
	refactor: boolean;
	migration: boolean;
	explicitTests: boolean;
	externalResearch: boolean;
	crossSubsystem: boolean;
	uncertain: boolean;
}

export interface TaskClassification {
	complexity: TaskComplexity;
	confidence: number;
	score: number;
	reasons: string[];
	signals: TaskClassifierSignals;
	workflow: TaskWorkflowPolicy;
}

export interface TaskEscalation {
	from: TaskComplexity;
	to: TaskComplexity;
	reason: string;
	trigger: TaskEscalationTrigger;
	timestamp: number;
}

export type TaskEscalationTrigger =
	| "unexpected_dependency"
	| "test_failure"
	| "verification_failure"
	| "repair_failure"
	| "cross_subsystem_discovered";

export interface TaskRoutingTelemetry {
	initialComplexity: TaskComplexity;
	initialConfidence: number;
	selectedWorkflow: TaskWorkflowPolicy;
	escalations: TaskEscalation[];
	finalComplexity: TaskComplexity;
	finalWorkflow: TaskWorkflowPolicy;
}

export interface TaskRoutingBenchmarkRecord {
	taskComplexity: TaskComplexity;
	initialConfidence: number;
	finalComplexity: TaskComplexity;
	escalationCount: number;
	tokens?: number;
	modelCalls?: number;
	toolCalls?: number;
	retries?: number;
	latencyMs?: number;
	taskSuccess?: boolean;
}

const TEST = /\btests?|test suite|coverage|specs?\b/i;
const BUG = /\bbug\b|\bbroken\b|\bcrash(?:es)?\b|\bfix\b/i;
const DEBUG = /\bdebug(?:ging)?\b|\binvestigate\b|\breproduce\b|\brepro\b|\broot cause\b/i;
const ARCH = /\barchitect(?:ure|ural)\b|\bredesign\b|\brework\b|\breplace\s+(?:the\s+)?(?:architecture|persistence|data layer|authentication system)\b/i;
const FEATURE = /\b(add|implement|create|introduce|build)\b|\bnew (?:feature|page|endpoint|command)\b/i;
const REFACTOR = /\brefactor\b|\brestructure\b|\bcleanup\b|\bextract\b/i;
const MIGRATION = /\bmigrat(?:e|ion|ing)\b|\bupgrade\s+(?:the\s+)?schema\b/i;
const RESEARCH = /\bresearch\b|\bcompare\b|\binvestigate\s+(?:options|alternatives)\b|\blook\s+up\b|\bexternal\b/i;
const CROSS = /\b(across|between|spanning|throughout)\b|\bmultiple\s+(?:services|subsystems|packages|apps|repositories|repos)\b|\bfull[- ]stack\b|\b(?:frontend|backend|api|database|worker|service|cli)\b.*\b(?:frontend|backend|api|database|worker|service|cli)\b/i;
const SIMPLE = /\brename\b|\b(?:fix|correct)\s+(?:the\s+)?(?:typo|spelling|grammar)\b|\b(?:change|update|replace)\s+(?:the\s+)?(?:button|label|text|string)\b|\b(?:update|change|set)\s+(?:the\s+)?(?:constant|literal)\b|\bformat\b/i;
const ACTION = /\b(rename|change|update|add|remove|delete|fix|implement|create|refactor|migrate|redesign|replace|upgrade)\b/gi;
const JOIN = /\b(and|then|also|plus|as well as)\b/gi;

const workflowFor = (complexity: TaskComplexity): TaskWorkflowPolicy => {
	switch (complexity) {
		case "SIMPLE": return { inspect: true, plan: false, explore: false, architecture: false, specialistResearch: false, verification: "basic", reviewPasses: 0, maxEscalations: 1, reasoningDepth: "minimal" };
		case "NORMAL": return { inspect: true, plan: true, explore: false, architecture: false, specialistResearch: false, verification: "standard", reviewPasses: 1, maxEscalations: 2, reasoningDepth: "low" };
		case "COMPLEX": return { inspect: true, plan: true, explore: true, architecture: true, specialistResearch: false, verification: "deep", reviewPasses: 1, maxEscalations: 2, reasoningDepth: "high" };
		case "VERY_COMPLEX": return { inspect: true, plan: true, explore: true, architecture: true, specialistResearch: true, verification: "final", reviewPasses: 2, maxEscalations: 3, reasoningDepth: "maximum" };
	}
};

function count(re: RegExp, text: string): number {
	return (text.match(re) ?? []).length;
}

function estimateOutcomes(text: string): number {
	return Math.max(1, Math.min(6, Math.max(count(ACTION, text), 1) + count(JOIN, text)));
}

function estimateFiles(text: string, repo?: TaskRepositorySignals): number {
	if (repo?.relevantFileCount !== undefined) return Math.max(1, repo.relevantFileCount);
	const paths = text.match(/(?:^|\s)(?:[\w.-]+\/)+[\w./-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|rb|php|sql|css|scss|md|json|yaml|yml)\b/gi);
	if (paths?.length) return Math.min(12, paths.length);
	return /\bmultiple\b|\bseveral\b|\bacross\b/i.test(text) ? 4 : 1;
}

function scoreFor(s: TaskClassifierSignals, repo?: TaskRepositorySignals): number {
	let score = Math.max(0, s.requestedOutcomes - 1) * 0.8 + Math.max(0, s.likelyFiles - 1) * 0.55;
	if (s.bugFix) score += 0.9;
	if (s.debugging) score += 1.4;
	if (s.architecture) score += 2.7;
	if (s.newFeature) score += 1.1;
	if (s.refactor) score += 1.8;
	if (s.migration) score += 2.4;
	if (s.explicitTests) score += 0.5;
	if (s.externalResearch) score += 1;
	if (s.crossSubsystem) score += 2.1;
	if (s.uncertain) score += 0.9;
	if (repo?.repositorySize === "large") score += 0.5;
	if (repo?.subsystemCount) score += Math.min(1.5, Math.max(0, repo.subsystemCount - 1) * 0.3);
	if (repo?.crossesSubsystems) score += 1;
	return score;
}

function fromScore(score: number, s: TaskClassifierSignals): TaskComplexity {
	if ((s.architecture && s.migration && s.crossSubsystem) || (s.architecture && s.crossSubsystem && s.requestedOutcomes >= 2) || (s.migration && s.crossSubsystem && s.likelyFiles >= 4) || score >= 9.5) return "VERY_COMPLEX";
	if (score >= 5.4) return "COMPLEX";
	if (score >= 1) return "NORMAL";
	return "SIMPLE";
}

function confidence(score: number, s: TaskClassifierSignals, c: TaskComplexity): number {
	let value = 0.72;
	if (s.uncertain) value -= 0.16;
	if (s.requestedOutcomes >= 3 || s.likelyFiles >= 4 || s.architecture || s.migration || s.crossSubsystem) value += 0.04;
	if (c === "SIMPLE" && (s.debugging || s.bugFix)) value -= 0.1;
	if (score >= 9.5 || score <= 0.7) value += 0.04;
	return Math.max(0.35, Math.min(0.97, value));
}

export function classifyTask(text: string, repository?: TaskRepositorySignals): TaskClassification {
	const value = text.replace(/\s+/g, " ").trim();
	const s: TaskClassifierSignals = {
		requestedOutcomes: estimateOutcomes(value),
		likelyFiles: estimateFiles(value, repository),
		bugFix: BUG.test(value),
		debugging: DEBUG.test(value),
		architecture: ARCH.test(value),
		newFeature: FEATURE.test(value),
		refactor: REFACTOR.test(value),
		migration: MIGRATION.test(value),
		explicitTests: TEST.test(value),
		externalResearch: RESEARCH.test(value),
		crossSubsystem: CROSS.test(value) || repository?.crossesSubsystems === true,
		uncertain: repository?.knownUncertainty === true || /\b(maybe|unclear|not sure|figure out|mystery)\b/i.test(value),
	};
	const simple = SIMPLE.test(value);
	const score = scoreFor(s, repository) - (simple ? 1.6 : 0);
	let complexity = fromScore(score, s);
	if (simple && s.requestedOutcomes === 1 && !s.debugging && !s.refactor && !s.migration && !s.crossSubsystem && !s.architecture) complexity = "SIMPLE";
	const rawConfidence = confidence(score, s, complexity);
	if (rawConfidence < 0.58 && complexity === "SIMPLE") complexity = "NORMAL";
	if (rawConfidence < 0.48 && complexity === "NORMAL" && (s.debugging || s.crossSubsystem)) complexity = "COMPLEX";
	return {
		complexity,
		confidence: complexity === "SIMPLE" ? Math.max(0.61, rawConfidence) : rawConfidence,
		score,
		reasons: [
			...(s.requestedOutcomes > 1 ? [`${s.requestedOutcomes} requested outcomes`] : []),
			...(s.likelyFiles > 1 ? [`likely touches ~${s.likelyFiles} files`] : []),
			...(s.bugFix ? ["bug/fix request"] : []),
			...(s.debugging ? ["debugging or reproduction required"] : []),
			...(s.architecture ? ["architecture decision/rework"] : []),
			...(s.newFeature ? ["new feature/change"] : []),
			...(s.refactor ? ["refactor/restructure"] : []),
			...(s.migration ? ["migration/schema work"] : []),
			...(s.explicitTests ? ["tests explicitly requested"] : []),
			...(s.externalResearch ? ["external research signal"] : []),
			...(s.crossSubsystem ? ["cross-subsystem scope"] : []),
			...(s.uncertain ? ["uncertainty signal"] : []),
		].slice(0, 8),
		signals: s,
		workflow: workflowFor(complexity),
	};
}

const next = (c: TaskComplexity): TaskComplexity => TASK_COMPLEXITIES[Math.min(TASK_COMPLEXITIES.length - 1, TASK_COMPLEXITIES.indexOf(c) + 1)];

export class TaskRouteTracker {
	readonly initial: TaskClassification;
	#current: TaskClassification;
	readonly #escalations: TaskEscalation[] = [];
	readonly #counts = new Map<TaskEscalationTrigger, number>();

	constructor(initial: TaskClassification) { this.initial = initial; this.#current = initial; }
	get current(): TaskClassification { return this.#current; }
	get telemetry(): TaskRoutingTelemetry {
		return { initialComplexity: this.initial.complexity, initialConfidence: this.initial.confidence, selectedWorkflow: this.initial.workflow, escalations: [...this.#escalations], finalComplexity: this.#current.complexity, finalWorkflow: this.#current.workflow };
	}
	observe(trigger: TaskEscalationTrigger, reason: string): TaskEscalation | undefined {
		const seen = (this.#counts.get(trigger) ?? 0) + 1;
		this.#counts.set(trigger, seen);
		if (["test_failure", "verification_failure", "repair_failure"].includes(trigger) && seen < 2) return undefined;
		if (this.#escalations.length >= this.initial.workflow.maxEscalations || this.#current.complexity === "VERY_COMPLEX") return undefined;
		const from = this.#current.complexity;
		const to = next(from);
		const escalation: TaskEscalation = { from, to, reason, trigger, timestamp: Date.now() };
		this.#escalations.push(escalation);
		this.#current = { ...this.#current, complexity: to, confidence: Math.max(this.#current.confidence, 0.75), workflow: workflowFor(to), reasons: [...this.#current.reasons, `escalated: ${reason}`].slice(-8) };
		return escalation;
	}
}

export function createTaskRoutingBenchmarkRecord(telemetry: TaskRoutingTelemetry, metrics: Omit<TaskRoutingBenchmarkRecord, "taskComplexity" | "initialConfidence" | "finalComplexity" | "escalationCount"> = {}): TaskRoutingBenchmarkRecord {
	return { taskComplexity: telemetry.initialComplexity, initialConfidence: telemetry.initialConfidence, finalComplexity: telemetry.finalComplexity, escalationCount: telemetry.escalations.length, ...metrics };
}

export function isTaskFailureMessage(text: string): boolean {
	return /\b(test|verification|build|lint|typecheck|compile)\b.*\b(fail|failed|failure|error|broken)\b/i.test(text);
}

export function inferEscalationTrigger(text: string): TaskEscalationTrigger | undefined {
	if (/\b(unexpected dependency|new dependency|hidden dependency|unanticipated dependency)\b/i.test(text)) return "unexpected_dependency";
	if (/\b(test|tests|test suite)\b.*\b(fail|failed|failure|error)\b/i.test(text)) return "test_failure";
	if (/\b(verify|verification|build|lint|typecheck|compile)\b.*\b(fail|failed|failure|error)\b/i.test(text)) return "verification_failure";
	if (/\b(repair|fix attempt|retry)\b.*\b(fail|failed|failure)\b/i.test(text)) return "repair_failure";
	if (/\b(cross[- ]subsystem|another subsystem|another service|different package)\b/i.test(text)) return "cross_subsystem_discovered";
	return undefined;
}
