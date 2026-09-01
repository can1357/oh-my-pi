import type { Agent, AgentMessage, OrchestrationState, SpecialistRole } from "@oh-my-pi/pi-agent-core";
import {
	aggregateSpecialistFindings,
	buildSpecialistContext,
	decideDelegation,
	strategyFingerprintForDelegation,
	type DelegationDecision,
	type SpecialistAggregation,
	type SpecialistFinding,
} from "@oh-my-pi/pi-agent-core";

const kPatched = Symbol.for("oh-my-pi-ultra.specialist-orchestration.patched");
const byAgent = new WeakMap<Agent, { removeHook: () => void }>();

interface SpecialistResultTelemetry {
	role: SpecialistRole;
	agent: string;
	tokens?: number;
	latencyMs?: number;
	cancelled: boolean;
	useful: boolean;
}

interface SpecialistRuntimeState {
	lastDecision?: DelegationDecision;
	lastFingerprint?: string;
	invocationsSuggested: number;
	delegationsAvoided: number;
	activeRoles: SpecialistRole[];
	findings: SpecialistFinding[];
	lastAggregation?: SpecialistAggregation;
	earlyAccepted: boolean;
	results: SpecialistResultTelemetry[];
}

interface SpecialistAgentState extends Agent["state"] {
	specialistOrchestration?: SpecialistRuntimeState;
}

function enabled(): boolean { return process.env.PI_SPECIALIST_ORCHESTRATION !== "0"; }
function clampBudget(): number {
	const value = Number.parseInt(process.env.PI_SPECIALIST_BUDGET_TOKENS ?? "2500", 10);
	return Number.isFinite(value) && value > 0 ? value : 2500;
}
function maxConcurrent(): number {
	const value = Number.parseInt(process.env.PI_SPECIALIST_MAX_CONCURRENCY ?? "2", 10);
	return Number.isFinite(value) && value > 0 ? Math.min(4, value) : 2;
}
function securitySensitive(task: string): boolean {
	return /\b(auth|authentication|authorization|credential|password|token|secret|payment|billing|untrusted input|sandbox|deserialize|code execution|permission)\b/i.test(task);
}
function roleToAgent(role: SpecialistRole): string {
	return {
		EXPLORER: "scout",
		ARCHITECT: "scout",
		DEBUGGER: "scout",
		TEST_ENGINEER: "scout",
		REVIEWER: "reviewer",
		SECURITY_REVIEWER: "security-reviewer",
		RESEARCHER: "librarian",
	}[role];
}
function roleQuestion(role: SpecialistRole): string {
	return {
		EXPLORER: "What repository structure/dependency facts materially affect the task?",
		ARCHITECT: "Which architecture path best satisfies the requirements and constraints?",
		DEBUGGER: "What is the most evidence-backed root cause and recommended repair?",
		TEST_ENGINEER: "What test surface is missing or most valuable to validate the change?",
		REVIEWER: "What correctness, scope, or regression risks remain?",
		SECURITY_REVIEWER: "What concrete security risks exist in the changed surface?",
		RESEARCHER: "What external fact is genuinely required and what evidence supports it?",
	}[role];
}
function specialistTask(role: SpecialistRole): string {
	return {
		EXPLORER: "Return FINDINGS, RELEVANT FILES, DEPENDENCIES, and UNKNOWNs. Do not edit files.",
		ARCHITECT: "Return PROBLEM, CURRENT ARCHITECTURE, OPTIONS, RECOMMENDATION, TRADEOFFS, and RISKS. Do not edit files.",
		DEBUGGER: "Return FAILURE, EVIDENCE, ROOT-CAUSE HYPOTHESIS, CONFIDENCE, and RECOMMENDED FIX. Do not edit files.",
		TEST_ENGINEER: "Return TEST SURFACE, MISSING COVERAGE, TARGET TESTS, and RISKS. Do not edit files.",
		REVIEWER: "Return CORRECTNESS, REGRESSIONS, SCOPE, RISKS, and RECOMMENDATION. Do not edit files.",
		SECURITY_REVIEWER: "Return FINDINGS, SEVERITY, AFFECTED LOCATIONS, and RECOMMENDATION. Do not edit files.",
		RESEARCHER: "Return QUESTION, FINDINGS, SOURCES, UNCERTAINTIES, and RECOMMENDATION. Keep external research limited to the named question.",
	}[role];
}
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => block && typeof block === "object" && "text" in block ? String((block as { text?: unknown }).text ?? "") : "").join(" ");
}
function delegationInput(state: OrchestrationState): Parameters<typeof decideDelegation>[0] {
	return {
		task: state.task,
		complexity: state.complexity,
		confidence: state.confidence,
		repositorySize: state.repository.relevantFileCount !== undefined && state.repository.relevantFileCount > 500 ? "large" : state.repository.relevantFileCount !== undefined && state.repository.relevantFileCount > 80 ? "medium" : "small",
		uncertainty: state.confidence < 0.72 || state.repository.crossesSubsystems === true,
		crossSubsystem: state.repository.crossesSubsystems === true,
		failureCount: state.failure.repeatCount,
		architectureAmbiguity: state.complexity === "VERY_COMPLEX" || /\barchitecture|redesign|rework|replace\b/i.test(state.task),
		independentVerification: state.complexity !== "SIMPLE" && state.currentPhase === "REVIEW",
		externalResearchRequired: /\b(research|compare|external|latest|current docs|look up)\b/i.test(state.task),
		securitySensitive: securitySensitive(state.task),
		hasExistingRelevantEvidence: state.repository.available && state.context.available && state.failure.present === false && state.confidence >= 0.85,
		availableBudgetTokens: clampBudget(),
		allowParallel: state.tools.parallelSupported === true,
		maxConcurrent: maxConcurrent(),
	};
}
function buildDirective(state: OrchestrationState, decision: DelegationDecision): string {
	const relevantFiles = [...new Set([...state.activeFiles, ...state.changedFiles])].slice(0, 12);
	const context = buildSpecialistContext({
		task: state.task,
		relevantFiles,
		activeFiles: state.activeFiles,
		activeSymbols: state.activeSymbols,
		failure: state.failure.present ? { category: state.failure.category, check: state.failure.check, summary: state.failure.summary, attempts: state.failure.repeatCount } : undefined,
		constraints: ["do not modify the primary working tree", "return compact evidence-backed findings only"],
		question: decision.role ? roleQuestion(decision.role) : "Provide only the independent findings needed to unblock the primary agent.",
	});
	const assignments = decision.roles.map(role => ({ role, agent: roleToAgent(role), task: specialistTask(role) }));
	if (decision.action === "PARALLEL_DELEGATE") {
		return `[Orchestration specialist delegation]\nReason: ${decision.reason}\nUse the existing task.batch capability when available. The specialists are independent and read-only; do not give them write/isolation/apply controls. Shared context:\n${context}\nAssignments:\n${assignments.map(item => `- ${item.role} via ${item.agent}: ${item.task}`).join("\n")}\nUse the returned specialist results as evidence, not as authority; preserve conflicts and verify decisive findings before implementation.`;
	}
	const item = assignments[0];
	return `[Orchestration specialist delegation]\nReason: ${decision.reason}\nDelegate exactly one targeted read-only specialist through the existing task tool. Shared context:\n${context}\nAssignment: ${item?.role ?? "SPECIALIST"} via ${item?.agent ?? "scout"}: ${item?.task ?? "Analyze the specific question and return compact evidence."}\nDo not delegate duplicate work; use the result to inform the next primary-agent decision.`;
}
function compactAggregation(aggregation: SpecialistAggregation): string | undefined {
	if (aggregation.consensus.length === 0 && aggregation.conflicts.length === 0) return undefined;
	const consensus = aggregation.consensus.slice(0, 4).map(item => `- ${item.role}: ${item.summary} [confidence ${item.confidence.toFixed(2)}]`).join("\n");
	const conflicts = aggregation.conflicts.slice(0, 3).map(item => `- ${item.topic}: ${item.findings.map(finding => `${finding.role}=${finding.summary}`).join(" | ")}`).join("\n");
	return `[Specialist evidence]\n${consensus ? `CONSENSUS\n${consensus}\n` : ""}${conflicts ? `CONFLICTS\n${conflicts}\n` : ""}${aggregation.recommendedNextAction ? `NEXT\n${aggregation.recommendedNextAction}` : ""}`.trim();
}
function ingestSpecialistResults(runtime: SpecialistRuntimeState, details: unknown): void {
	if (!details || typeof details !== "object") return;
	const rawResults = (details as { results?: unknown }).results;
	if (!Array.isArray(rawResults) || rawResults.length === 0) return;
	const findings: SpecialistFinding[] = [];
	for (const raw of rawResults) {
		if (!raw || typeof raw !== "object") continue;
		const result = raw as { index?: number; id?: string; agent?: string; output?: string; stderr?: string; tokens?: number; durationMs?: number; aborted?: boolean; error?: string; structuredOutput?: { data?: unknown } };
		const role = runtime.activeRoles[result.index ?? 0];
		if (!role) continue;
		const output = typeof result.output === "string" ? result.output : "";
		const data = result.structuredOutput?.data;
		let summary = output.trim() || (typeof result.stderr === "string" ? result.stderr.trim() : "") || (typeof result.error === "string" ? result.error : "no specialist output");
		if (data && typeof data === "object" && !Array.isArray(data) && typeof (data as { explanation?: unknown }).explanation === "string") summary = String((data as { explanation: string }).explanation);
		summary = summary.replace(/\s+/g, " ").slice(0, 600);
		const confidenceValue = data && typeof data === "object" && !Array.isArray(data) && typeof (data as { confidence?: unknown }).confidence === "number" ? Number((data as { confidence: number }).confidence) : result.error || result.aborted ? 0.2 : 0.65;
		const evidence = output.split(/\r?\n/).filter(line => /(?:\.tsx?|\.jsx?|\.py|\.rs|\.go|\.java|:|line\s+\d+)/i.test(line)).slice(0, 4);
		findings.push({ role, summary, evidence, confidence: Math.max(0, Math.min(1, confidenceValue)) });
		runtime.results.push({ role, agent: result.agent ?? roleToAgent(role), tokens: result.tokens, latencyMs: result.durationMs, cancelled: result.aborted === true, useful: !result.error && result.aborted !== true });
	}
	if (findings.length === 0) return;
	runtime.findings = findings;
	runtime.lastAggregation = aggregateSpecialistFindings(findings);
	const strongest = findings.reduce((best, finding) => finding.confidence > best.confidence ? finding : best, findings[0]!);
	runtime.earlyAccepted = strongest.confidence >= 0.9 && strongest.evidence.length > 0;
}
function patch(): void {
	const target = Agent.prototype as Agent & { [key: symbol]: unknown };
	if (target[kPatched]) return;
	target[kPatched] = true;
	const original = Agent.prototype.prompt as (...args: unknown[]) => Promise<unknown>;
	(target as any).prompt = async function specialistAwarePrompt(this: Agent, ...args: unknown[]) {
		if (!enabled()) return original.apply(this, args);
		const state = (this.state as SpecialistAgentState).orchestration as OrchestrationState | undefined;
		if (!state) return original.apply(this, args);
		const runtime: SpecialistRuntimeState = { invocationsSuggested: 0, delegationsAvoided: 0, activeRoles: [], findings: [], earlyAccepted: false, results: [] };
		const removeHook = this.addBeforeModelCall(async context => {
			const live = (this.state as SpecialistAgentState).orchestration as OrchestrationState | undefined;
			if (!live) return;
			const aggregate = compactAggregation(runtime.lastAggregation ?? { consensus: [], conflicts: [], unresolvedQuestions: [] });
			if (aggregate && !context.messages.some(message => extractText((message as { content?: unknown }).content).startsWith("[Specialist evidence]"))) context.messages = [{ role: "user", content: aggregate, timestamp: Date.now() } as AgentMessage, ...context.messages];
			if (runtime.earlyAccepted) {
				runtime.lastDecision = { action: "SKIP_DELEGATION", roles: [], reason: "decisive evidence already returned; skip optional specialist work", expectedBenefit: "none", estimatedTokenCost: 0, estimatedLatencyMs: 0, contextRequired: [], readOnly: true };
				runtime.delegationsAvoided += 1;
				(this.state as SpecialistAgentState).specialistOrchestration = runtime;
				return;
			}
			const decision = decideDelegation({ ...delegationInput(live), alreadyDelegatedRoles: runtime.activeRoles });
			runtime.lastDecision = decision;
			const fingerprint = strategyFingerprintForDelegation(decision);
			if (runtime.lastFingerprint === fingerprint) return;
			runtime.lastFingerprint = fingerprint;
			runtime.activeRoles = decision.roles;
			if (decision.action === "SKIP_DELEGATION") runtime.delegationsAvoided += 1;
			else {
				runtime.invocationsSuggested += decision.roles.length;
				context.messages = [{ role: "user", content: buildDirective(live, decision), timestamp: Date.now() } as AgentMessage, ...context.messages];
			}
			(this.state as SpecialistAgentState).specialistOrchestration = runtime;
		});
		const unsubscribe = this.subscribe(event => {
			if (event.type === "turn_end") {
				const results = event.toolResults as unknown[];
				for (const item of results) {
					const details = item && typeof item === "object" ? (item as { details?: unknown }).details : undefined;
					ingestSpecialistResults(runtime, details);
				}
				(this.state as SpecialistAgentState).specialistOrchestration = runtime;
			}
		});
		byAgent.set(this, { removeHook });
		try { return await original.apply(this, args); }
		finally { removeHook(); unsubscribe(); byAgent.delete(this); }
	};
}
patch();
export function getSpecialistOrchestration(agent: Agent): SpecialistRuntimeState | undefined { return (agent.state as SpecialistAgentState).specialistOrchestration; }
