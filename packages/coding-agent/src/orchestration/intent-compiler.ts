/**
 * Intent compiler for ephemeral root task contracts.
 *
 * This module is deliberately deterministic and heuristic-only: it never calls a
 * model and it never persists a contract. It extracts a useful best-effort
 * contract, records assumptions, and asks at most one material clarification.
 */

import type { TaskAssumption, TaskContractV1 } from "./task-contract";
import {
	OMPK_DEFAULT_CRITERIA,
	OMPK_DEFAULT_EVIDENCE_REQUIREMENTS,
	OMPK_DEFAULT_FAILURE_MODES,
	OMPK_DEFAULT_NON_SOLUTIONS,
	TASK_CONTRACT_VERSION,
} from "./task-contract";

export type FieldProvenance = "explicit" | "inferred_keyword" | "inferred_context" | "default";

export interface FieldConfidence<T> {
	readonly value: T;
	readonly confidence: number;
	readonly provenance: FieldProvenance;
	readonly note?: string;
}

export type GapImpact = "critical" | "high" | "medium" | "low";
export type GapRisk = "blocking" | "significant" | "minor";
export type HardOverrideKind =
	| "authorization"
	| "destructive"
	| "external"
	| "irreversible_cost"
	| "security"
	| "privacy"
	| "safety";

export interface QuestionSpec {
	readonly field: string;
	readonly questionText: string;
	readonly kind: "single_select" | "multi_select" | "free_text" | "boolean" | "numeric";
	readonly options?: readonly string[];
	readonly recommendedDefault?: string;
}

/** Normalized values used by the canonical material-gap score. */
export interface GapScoreFactors {
	readonly impact: number;
	readonly uncertainty: number;
	readonly branching: number;
	readonly risk: number;
	readonly effort: number;
}

export interface ContractGap {
	/** Stable within a compiler version; used as the deterministic tie-breaker. */
	readonly id: string;
	readonly field: string;
	readonly description: string;
	readonly confidence: number;
	readonly impact: GapImpact;
	readonly risk: GapRisk;
	readonly recommendedDefault?: string;
	readonly questionSpec?: QuestionSpec;
	readonly hardOverride?: HardOverrideKind;
	readonly scoreFactors: GapScoreFactors;
	/** S = 0.25I + 0.20U + 0.20B + 0.25R + 0.10(1-E). */
	readonly priorityScore: number;
}

export interface CompiledIntent {
	readonly contract: TaskContractV1;
	readonly assumptions: readonly AssumptionRecord[];
	readonly gaps: readonly ContractGap[];
	/** Material gaps retained for runtime injection. */
	readonly unresolved: readonly ContractGap[];
	/** Whether the one allowed clarification question should be asked. */
	readonly requiresClarification: boolean;
	/** The sole question to ask before execution, when needed. */
	readonly topClarificationQuestion?: QuestionSpec;
}

export interface AssumptionRecord extends TaskAssumption {
	readonly confidence: number;
	readonly provenance: FieldProvenance;
	readonly impactIfWrong: GapImpact;
	readonly field: string;
}

type ExtractionEntry = { value: string; confidence: number; provenance: FieldProvenance };

type GapInput = Omit<ContractGap, "priorityScore" | "scoreFactors"> & {
	readonly branching: number;
	readonly effort: number;
};

const CLARIFICATION_THRESHOLD = 0.6;

const IMPACT_SCORES = Object.freeze({ critical: 1, high: 0.75, medium: 0.5, low: 0.25 } as const);
const RISK_SCORES = Object.freeze({ blocking: 1, significant: 0.67, minor: 0.33 } as const);

const PERMISSION_DENY_PATTERNS = [
	/don'?t\s+(?:touch|modify|change|delete|remove)\s+([^,.\n]{3,60})/gi,
	/(?:do\s+not|never|avoid)\s+(?:touch|modify|change|delete|remove)\s+([^,.\n]{3,60})/gi,
	/(?:leave|keep|preserve)\s+([^,.\n]{3,60})\s+(?:as.is|unchanged|intact)/gi,
];

const CONSTRAINT_PATTERNS = [
	/(?:must|should|needs?\s+to|has?\s+to)\s+((?:not\s+)?[^,.\n]{5,80})/gi,
	/((?:only|always|never)\s+[^,.\n]{5,80})/gi,
	/(without\s+[^,.\n]{5,60})/gi,
];

const HARD_OVERRIDE_RULES: readonly {
	readonly kind: HardOverrideKind;
	readonly pattern: RegExp;
	readonly description: string;
	readonly questionText: string;
}[] = Object.freeze([
	{
		kind: "authorization",
		pattern: /\b(?:authorization|authorisation|permission|access approval)\b/i,
		description: "The required authorization is not explicit.",
		questionText: "What authorization boundary applies before proceeding?",
	},
	{
		kind: "destructive",
		pattern: /\b(?:delete|destroy|drop|overwrite|truncate|wipe|remove)\b/i,
		description: "The request may perform a destructive operation without a confirmed target and boundary.",
		questionText: "Which destructive targets and rollback boundary are authorized?",
	},
	{
		kind: "external",
		pattern: /\b(?:deploy|publish|release|send|email|upload|post|notify|provision)\b/i,
		description: "The request may perform an external action without a confirmed target or environment.",
		questionText: "Which external target or environment is authorized?",
	},
	{
		kind: "irreversible_cost",
		pattern: /\b(?:purchase|buy|charge|spend|pay|billing|cost)\b/i,
		description: "The request may incur an irreversible cost without a spending boundary.",
		questionText: "What spending limit and approval apply?",
	},
	{
		kind: "security",
		pattern: /\b(?:security|vulnerability|exploit|secret|credential|password|token|authentication|authorization)\b/i,
		description: "The security boundary and approval are not explicit.",
		questionText: "What security boundary and approval govern this work?",
	},
	{
		kind: "privacy",
		pattern: /\b(?:privacy|personal data|pii|sensitive data|customer data)\b/i,
		description: "The data-handling or consent boundary is not explicit.",
		questionText: "What data-handling and consent boundary applies?",
	},
	{
		kind: "safety",
		pattern: /\b(?:safety|hazard|medical|physical harm|dangerous)\b/i,
		description: "The safety boundary and approval are not explicit.",
		questionText: "What safety boundary and approval apply?",
	},
]);

const EXPLICIT_APPROVAL_PATTERN =
	/\b(?:approved|authorized|authorised|permission\s+(?:is\s+)?granted|owner(?:'s)?\s+(?:approval|permission))\b/i;

function extractLines(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 3);
}

function objectiveFromText(text: string): FieldConfidence<string> {
	const lines = extractLines(text);
	if (lines.length === 0) {
		return { value: "Unspecified task", confidence: 0.1, provenance: "default" };
	}

	const firstLine = lines[0] ?? "";
	const isImperative =
		/^(?:implement|build|create|add|fix|refactor|debug|analyze|investigate|design|write|migrate|update|review)\b/i.test(
			firstLine,
		);
	if (isImperative) {
		return { value: lines.slice(0, 2).join(" ").slice(0, 300), confidence: 0.9, provenance: "explicit" };
	}

	const isVague = firstLine.length < 20 || /^(?:help|please help|thing|whatever)$/i.test(firstLine);
	return {
		value: lines.slice(0, 2).join(" ").slice(0, 300),
		confidence: isVague ? 0.2 : 0.7,
		provenance: isVague ? "default" : "inferred_context",
	};
}

function extractDeliverables(text: string): ExtractionEntry[] {
	const results: ExtractionEntry[] = [];
	for (const match of text.matchAll(/^[-*•]\s+(.{5,100})$/gm)) {
		const item = match[1]?.trim();
		if (item) results.push({ value: item, confidence: 0.8, provenance: "explicit" });
	}

	const deliverableSection = text.match(/deliverables?[:\s]+(.+?)(?:\n\n|\n(?=[A-Z])|$)/is);
	if (deliverableSection?.[1]) {
		for (const item of deliverableSection[1]
			.split(/[,\n]/)
			.map(value => value.trim())
			.filter(value => value.length > 4)) {
			results.push({ value: item, confidence: 0.85, provenance: "explicit" });
		}
	}
	return results.slice(0, 8);
}

function extractFromPatterns(
	text: string,
	patterns: readonly RegExp[],
	minLength: number,
	maxLength: number,
): ExtractionEntry[] {
	const results: ExtractionEntry[] = [];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			const value = match[1]?.trim();
			if (value && value.length >= minLength && value.length < maxLength) {
				results.push({ value, confidence: 0.65, provenance: "inferred_keyword" });
			}
		}
	}
	return results.slice(0, 6);
}

function createGap(input: GapInput): ContractGap {
	const scoreFactors = Object.freeze({
		impact: IMPACT_SCORES[input.impact],
		uncertainty: 1 - Math.max(0, Math.min(1, input.confidence)),
		branching: Math.max(0, Math.min(1, input.branching)),
		risk: RISK_SCORES[input.risk],
		effort: Math.max(0, Math.min(1, input.effort)),
	});
	const priorityScore =
		0.25 * scoreFactors.impact +
		0.2 * scoreFactors.uncertainty +
		0.2 * scoreFactors.branching +
		0.25 * scoreFactors.risk +
		0.1 * (1 - scoreFactors.effort);
	return Object.freeze({
		id: input.id,
		field: input.field,
		description: input.description,
		confidence: input.confidence,
		impact: input.impact,
		risk: input.risk,
		recommendedDefault: input.recommendedDefault,
		questionSpec: input.questionSpec,
		hardOverride: input.hardOverride,
		scoreFactors,
		priorityScore,
	});
}

function appendHardOverrideGaps(text: string, gaps: ContractGap[]): void {
	if (EXPLICIT_APPROVAL_PATTERN.test(text)) return;
	for (const rule of HARD_OVERRIDE_RULES) {
		const hasAffirmativeAction = [...text.matchAll(new RegExp(rule.pattern.source, "gi"))].some(match => {
			const index = match.index ?? 0;
			const prefix = text.slice(Math.max(0, index - 40), index);
			return !/(?:do\s+not|don'?t|must\s+not|should\s+not|never|avoid)\s+[^,.\n]{0,80}$/i.test(prefix);
		});
		if (!hasAffirmativeAction) continue;
		gaps.push(
			createGap({
				id: `gap-hard-${rule.kind}`,
				field: rule.kind,
				description: rule.description,
				confidence: 0,
				impact: "critical",
				risk: "blocking",
				hardOverride: rule.kind,
				questionSpec: { field: rule.kind, questionText: rule.questionText, kind: "free_text" },
				branching: 1,
				effort: 0.2,
			}),
		);
	}
}

export interface CompileIntentOptions {
	readonly constraints?: readonly string[];
	readonly nonSolutions?: readonly string[];
	readonly projectContext?: string;
}

export function compileIntent(userText: string, options: CompileIntentOptions = {}): CompiledIntent {
	const text = userText.trim();
	const assumptions: AssumptionRecord[] = [];
	const gaps: ContractGap[] = [];

	const objectiveResult = objectiveFromText(text);
	if (objectiveResult.confidence < 0.7) {
		assumptions.push({
			id: "A-objective",
			statement: `Objective inferred as: "${objectiveResult.value}"`,
			confidence: objectiveResult.confidence,
			provenance: objectiveResult.provenance,
			impactIfWrong: "critical",
			field: "objective",
			verified: false,
		});
	}
	if (objectiveResult.confidence < 0.5) {
		gaps.push(
			createGap({
				id: "gap-objective",
				field: "objective",
				description: "Objective is unclear; execution would be speculative.",
				confidence: objectiveResult.confidence,
				impact: "critical",
				risk: "blocking",
				questionSpec: {
					field: "objective",
					questionText: "What is the primary goal of this task?",
					kind: "free_text",
					recommendedDefault: objectiveResult.value,
				},
				branching: 0.9,
				effort: 0.25,
			}),
		);
	}

	const deliverableEntries = extractDeliverables(text);
	const deliverables = deliverableEntries.map(entry => entry.value);
	for (const entry of deliverableEntries) {
		if (entry.confidence >= 0.7) continue;
		assumptions.push({
			id: `A-del-${deliverables.indexOf(entry.value)}`,
			statement: `Deliverable inferred: "${entry.value}"`,
			confidence: entry.confidence,
			provenance: entry.provenance,
			impactIfWrong: "high",
			field: "deliverables",
			verified: false,
		});
	}
	if (deliverables.length === 0) {
		assumptions.push({
			id: "A-deliverables-default",
			statement: "Deliverables default to the implementation directly required by the stated objective.",
			confidence: 0.7,
			provenance: "default",
			impactIfWrong: "low",
			field: "deliverables",
			verified: false,
		});
		gaps.push(
			createGap({
				id: "gap-deliverables",
				field: "deliverables",
				description: "No concrete deliverables were detected; use the objective as the default scope.",
				confidence: 0.7,
				impact: "low",
				risk: "minor",
				recommendedDefault: "Implementation matching the stated objective",
				branching: 0.2,
				effort: 0.2,
			}),
		);
	}

	const extractedConstraints = extractFromPatterns(text, CONSTRAINT_PATTERNS, 5, 100);
	const allConstraints = [...extractedConstraints.map(entry => entry.value), ...(options.constraints ?? [])];
	const extractedNonSolutions = extractFromPatterns(text, PERMISSION_DENY_PATTERNS, 3, 80);
	const allNonSolutions = [
		...OMPK_DEFAULT_NON_SOLUTIONS,
		...extractedNonSolutions.map(entry => entry.value),
		...(options.nonSolutions ?? []),
	];
	for (const entry of extractedNonSolutions) {
		assumptions.push({
			id: `A-ns-${allNonSolutions.indexOf(entry.value)}`,
			statement: `Non-solution inferred from an explicit preservation constraint: "${entry.value}"`,
			confidence: entry.confidence,
			provenance: entry.provenance,
			impactIfWrong: "medium",
			field: "nonSolutions",
			verified: false,
		});
	}

	assumptions.push({
		id: "A-criteria-default",
		statement: "Success criteria use OMPK defaults because task-specific criteria were not detected.",
		confidence: 0.6,
		provenance: "default",
		impactIfWrong: "high",
		field: "completionCriteria",
		verified: false,
	});
	appendHardOverrideGaps(text, gaps);

	const sortedGaps = [...gaps].sort(
		(left, right) => right.priorityScore - left.priorityScore || left.id.localeCompare(right.id),
	);
	const unresolved = sortedGaps.filter(
		gap => gap.hardOverride !== undefined || gap.priorityScore >= CLARIFICATION_THRESHOLD,
	);
	const questionGap = unresolved.find(
		gap => gap.questionSpec !== undefined && (gap.hardOverride !== undefined || gap.risk === "blocking"),
	);

	const contract: TaskContractV1 = Object.freeze({
		version: TASK_CONTRACT_VERSION,
		objective: objectiveResult.value,
		deliverables: Object.freeze([...deliverables]),
		completionCriteria: OMPK_DEFAULT_CRITERIA,
		nonSolutions: Object.freeze(allNonSolutions),
		knownFailureModes: OMPK_DEFAULT_FAILURE_MODES,
		evidenceRequirements: OMPK_DEFAULT_EVIDENCE_REQUIREMENTS,
		constraints: Object.freeze(allConstraints),
		assumptions: Object.freeze(
			assumptions.map(assumption =>
				Object.freeze({ id: assumption.id, statement: assumption.statement, verified: assumption.verified }),
			),
		),
		verificationPolicy: Object.freeze({ requireTargetedChecks: true, allowNarrativeOnly: false }),
		orchestrationPolicy: Object.freeze({ preferIndependence: true }),
	});

	return Object.freeze({
		contract,
		assumptions: Object.freeze([...assumptions]),
		gaps: Object.freeze(sortedGaps),
		unresolved: Object.freeze(unresolved),
		requiresClarification: questionGap !== undefined,
		topClarificationQuestion: questionGap?.questionSpec,
	});
}

/**
 * Patch the single clarification answer into a new immutable contract. Root
 * runtime consumes at most one answer; it does not compile a second question.
 */
export function patchContractFromAnswer(contract: TaskContractV1, field: string, answer: string): TaskContractV1 {
	const value = answer.trim();
	if (!value) return contract;
	switch (field) {
		case "objective":
			return Object.freeze({ ...contract, objective: value });
		case "deliverables":
			return Object.freeze({
				...contract,
				deliverables: Object.freeze([...contract.deliverables, value]),
			});
		case "constraints":
		case "authorization":
		case "destructive":
		case "external":
		case "irreversible_cost":
		case "security":
		case "privacy":
		case "safety":
			return Object.freeze({
				...contract,
				constraints: Object.freeze([...contract.constraints, value]),
			});
		default:
			return contract;
	}
}
