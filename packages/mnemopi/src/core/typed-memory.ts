export const MemoryType = {
	FACT: "fact",
	PREFERENCE: "preference",
	DECISION: "decision",
	COMMITMENT: "commitment",
	GOAL: "goal",
	EVENT: "event",
	INSTRUCTION: "instruction",
	RELATIONSHIP: "relationship",
	CONTEXT: "context",
	LEARNING: "learning",
	OBSERVATION: "observation",
	ERROR: "error",
	ARTIFACT: "artifact",
	UNKNOWN: "unknown",
} as const;

export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];
export type TypePriority =
	| "stable"
	| "moderate"
	| "high"
	| "time_critical"
	| "decaying"
	| "accumulating"
	| "evolving"
	| "persistent"
	| "reference";

export interface TypeMatch {
	memory_type: MemoryType;
	memoryType: MemoryType;
	confidence: number;
	matched_pattern: string;
	matchedPattern: string;
	priority: TypePriority;
}

export type TypePattern = readonly [
	pattern: string,
	memoryType: MemoryType,
	baseConfidence: number,
	priority: TypePriority,
];
type CompiledTypePattern = readonly [
	pattern: RegExp,
	matchedPattern: string,
	memoryType: MemoryType,
	baseConfidence: number,
	priority: TypePriority,
];
const MEMORY_TYPE_ORDER: readonly MemoryType[] = [
	MemoryType.FACT,
	MemoryType.PREFERENCE,
	MemoryType.DECISION,
	MemoryType.COMMITMENT,
	MemoryType.GOAL,
	MemoryType.EVENT,
	MemoryType.INSTRUCTION,
	MemoryType.RELATIONSHIP,
	MemoryType.CONTEXT,
	MemoryType.LEARNING,
	MemoryType.OBSERVATION,
	MemoryType.ERROR,
	MemoryType.ARTIFACT,
	MemoryType.UNKNOWN,
];

function typePattern(
	pattern: string,
	memoryType: MemoryType,
	baseConfidence: number,
	priority: TypePriority,
): TypePattern {
	return [pattern, memoryType, baseConfidence, priority];
}

export const TYPE_PATTERNS: readonly TypePattern[] = [
	// FACT: Objective, verifiable information
	typePattern(String.raw`\b(is|are|was|were)\s+(a|an|the)\s+\w+`, MemoryType.FACT, 0.6, "stable"),
	typePattern(String.raw`\b(has|have|had)\s+\d+`, MemoryType.FACT, 0.7, "stable"),
	typePattern(String.raw`\b(contains|consists?|comprises?)\b`, MemoryType.FACT, 0.8, "stable"),
	typePattern(String.raw`\b(version|v)\s*\d+\.?\d*`, MemoryType.FACT, 0.9, "stable"),
	typePattern(String.raw`\b(API|endpoint|URL|database|DB)\s+(is|at|points?\s+to)`, MemoryType.FACT, 0.8, "stable"),
	typePattern(String.raw`\b(created|modified|updated)\s+(on|at)\s+\d{4}`, MemoryType.FACT, 0.8, "stable"),

	// PREFERENCE: User/system preferences
	typePattern(String.raw`\b(prefer|likes?|enjoys?|loves?|hates?|dislikes?)\b`, MemoryType.PREFERENCE, 0.8, "moderate"),
	typePattern(String.raw`\b(want|wants|wanted)\s+(to|the|a|an)\b`, MemoryType.PREFERENCE, 0.6, "moderate"),
	typePattern(String.raw`\b(rather|instead|alternative)\b`, MemoryType.PREFERENCE, 0.5, "moderate"),
	typePattern(String.raw`\b(dark\s+mode|light\s+mode|theme|color\s+scheme)\b`, MemoryType.PREFERENCE, 0.9, "moderate"),
	typePattern(String.raw`\b(usually|typically|normally|generally)\b`, MemoryType.PREFERENCE, 0.6, "moderate"),

	// DECISION: Choices affecting future
	typePattern(String.raw`\b(decided|chose|selected|picked|opted)\b`, MemoryType.DECISION, 0.9, "high"),
	typePattern(String.raw`\b(going\s+with|settled\s+on|locked\s+in)\b`, MemoryType.DECISION, 0.8, "high"),
	typePattern(String.raw`\b(choose|select|pick)\s+(between|from|among)\b`, MemoryType.DECISION, 0.7, "high"),
	typePattern(String.raw`\b(final\s+decision|final\s+call|final\s+choice)\b`, MemoryType.DECISION, 0.9, "high"),
	typePattern(String.raw`\b(will\s+use|using|adopt|adopting)\s+(the|a|an)?\s*\w+`, MemoryType.DECISION, 0.7, "high"),

	// COMMITMENT: Promises, obligations, deadlines
	typePattern(
		String.raw`\b(will|shall|must|need\s+to)\s+\w+\s+(by|before|until)\b`,
		MemoryType.COMMITMENT,
		0.8,
		"time_critical",
	),
	typePattern(String.raw`\b(deadline|due\s+date|due|milestone)\b`, MemoryType.COMMITMENT, 0.9, "time_critical"),
	typePattern(String.raw`\b(promise|committed|pledged|obligated)\b`, MemoryType.COMMITMENT, 0.9, "time_critical"),
	typePattern(
		String.raw`\b(deliver|ship|release|deploy)\s+(by|before|on)\b`,
		MemoryType.COMMITMENT,
		0.8,
		"time_critical",
	),
	typePattern(
		String.raw`\b(EOD|COB|end\s+of\s+day|close\s+of\s+business)\b`,
		MemoryType.COMMITMENT,
		0.7,
		"time_critical",
	),
	typePattern(
		String.raw`\b(tomorrow|next\s+week|Monday|Friday)\s+(by|at)\b`,
		MemoryType.COMMITMENT,
		0.6,
		"time_critical",
	),

	// GOAL: Objectives to achieve
	typePattern(String.raw`\b(goal|objective|target|aim|purpose)\b`, MemoryType.GOAL, 0.9, "high"),
	typePattern(String.raw`\b(achieve|reach|hit|attain|accomplish)\s+\d+`, MemoryType.GOAL, 0.8, "high"),
	typePattern(String.raw`\b(KPI|metric|OKR|success\s+criteria)\b`, MemoryType.GOAL, 0.9, "high"),
	typePattern(String.raw`\b(roadmap|plan|strategy)\s+(for|to)\b`, MemoryType.GOAL, 0.7, "high"),
	typePattern(
		String.raw`\b(reach|get\s+to|grow\s+to)\s+\d+[KkMm]?\s+(users|customers|revenue)\b`,
		MemoryType.GOAL,
		0.8,
		"high",
	),

	// EVENT: Historical occurrences
	typePattern(
		String.raw`\b(meeting|call|discussion|conversation)\s+(with|about)\b`,
		MemoryType.EVENT,
		0.7,
		"decaying",
	),
	typePattern(String.raw`\b(happened|occurred|took\s+place|went\s+down)\b`, MemoryType.EVENT, 0.8, "decaying"),
	typePattern(String.raw`\b(yesterday|last\s+week|last\s+month|earlier\s+today)\b`, MemoryType.EVENT, 0.6, "decaying"),
	typePattern(String.raw`\b(scheduled|planned|booked|set\s+up)\s+(for|at)\b`, MemoryType.EVENT, 0.7, "decaying"),
	typePattern(String.raw`\b(incident|outage|bug|issue)\s+#?\d+`, MemoryType.EVENT, 0.8, "decaying"),
	typePattern(String.raw`\b( launched|released|shipped|deployed)\s+(on|at)\b`, MemoryType.EVENT, 0.8, "decaying"),

	// INSTRUCTION: Rules, guidelines
	typePattern(String.raw`\b(always|never|must|should|shall|do\s+not|don't)\b`, MemoryType.INSTRUCTION, 0.7, "stable"),
	typePattern(String.raw`\b(rule|policy|guideline|procedure|protocol)\b`, MemoryType.INSTRUCTION, 0.9, "stable"),
	typePattern(String.raw`\b(how\s+to|steps?\s+to|guide\s+to|tutorial)\b`, MemoryType.INSTRUCTION, 0.8, "stable"),
	typePattern(String.raw`\b(remember\s+to|make\s+sure|ensure|verify)\b`, MemoryType.INSTRUCTION, 0.6, "stable"),
	typePattern(String.raw`\b(first|then|next|finally)\s*,?\s*\w+`, MemoryType.INSTRUCTION, 0.5, "stable"),
	typePattern(String.raw`\b(if\s+.+\s+then\s+.+)`, MemoryType.INSTRUCTION, 0.7, "stable"),

	// RELATIONSHIP: Entity connections
	typePattern(String.raw`\b(manages?|reports?\s+to|supervises?|leads?)\b`, MemoryType.RELATIONSHIP, 0.9, "stable"),
	typePattern(String.raw`\b(owns?|belongs?\s+to|part\s+of|member\s+of)\b`, MemoryType.RELATIONSHIP, 0.8, "stable"),
	typePattern(
		String.raw`\b(works?\s+with|collaborates?\s+with|partners?\s+with)\b`,
		MemoryType.RELATIONSHIP,
		0.8,
		"stable",
	),
	typePattern(String.raw`\b(depends?\s+on|requires?|needs?)\b`, MemoryType.RELATIONSHIP, 0.7, "stable"),
	typePattern(String.raw`\b(related\s+to|connected\s+to|associated\s+with)\b`, MemoryType.RELATIONSHIP, 0.6, "stable"),
	typePattern(
		String.raw`\b(is\s+a|is\s+an)\s+(type\s+of|kind\s+of|form\s+of)\b`,
		MemoryType.RELATIONSHIP,
		0.7,
		"stable",
	),

	// CONTEXT: Situational information
	typePattern(String.raw`\b(currently|right\s+now|at\s+the\s+moment|presently)\b`, MemoryType.CONTEXT, 0.7, "high"),
	typePattern(String.raw`\b(working\s+on|focusing\s+on|dealing\s+with)\b`, MemoryType.CONTEXT, 0.8, "high"),
	typePattern(String.raw`\b(status|state|phase|stage)\s+(is|of)\b`, MemoryType.CONTEXT, 0.7, "high"),
	typePattern(String.raw`\b(in\s+progress|ongoing|active|pending|blocked)\b`, MemoryType.CONTEXT, 0.8, "high"),
	typePattern(String.raw`\b(environment|setup|configuration|settings?)\b`, MemoryType.CONTEXT, 0.6, "high"),
	typePattern(String.raw`\b(today|this\s+week|this\s+sprint|this\s+quarter)\b`, MemoryType.CONTEXT, 0.5, "high"),

	// LEARNING: Lessons from experience
	typePattern(String.raw`\b(learned|realized|discovered|found\s+out)\b`, MemoryType.LEARNING, 0.8, "accumulating"),
	typePattern(String.raw`\b(lesson|takeaway|insight|finding)\b`, MemoryType.LEARNING, 0.9, "accumulating"),
	typePattern(String.raw`\b(turns?\s+out|surprisingly|interestingly)\b`, MemoryType.LEARNING, 0.7, "accumulating"),
	typePattern(String.raw`\b(should\s+have|could\s+have|would\s+have)\b`, MemoryType.LEARNING, 0.6, "accumulating"),
	typePattern(
		String.raw`\b(best\s+practice|lessons?\s+learned|post[-\s]?mortem)\b`,
		MemoryType.LEARNING,
		0.9,
		"accumulating",
	),

	// OBSERVATION: Patterns noticed
	typePattern(String.raw`\b(noticed|observed|saw|seems?)\b`, MemoryType.OBSERVATION, 0.7, "evolving"),
	typePattern(String.raw`\b(pattern|trend|correlation|tends?\s+to)\b`, MemoryType.OBSERVATION, 0.9, "evolving"),
	typePattern(
		String.raw`\b(often|frequently|sometimes|rarely|usually)\s+\w+`,
		MemoryType.OBSERVATION,
		0.6,
		"evolving",
	),
	typePattern(String.raw`\b(appears?|looks?\s+like|seems?\s+like)\b`, MemoryType.OBSERVATION, 0.6, "evolving"),
	typePattern(
		String.raw`\b(increasing|decreasing|growing|shrinking|stable)\b`,
		MemoryType.OBSERVATION,
		0.7,
		"evolving",
	),
	typePattern(String.raw`\b(every\s+time|whenever|each\s+time)\b`, MemoryType.OBSERVATION, 0.8, "evolving"),

	// ERROR: Mistakes to avoid
	typePattern(String.raw`\b(error|bug|issue|problem|failure|crash)\b`, MemoryType.ERROR, 0.7, "persistent"),
	typePattern(String.raw`\b(broke|broken|failed|failing|doesn't\s+work)\b`, MemoryType.ERROR, 0.8, "persistent"),
	typePattern(
		String.raw`\b(do\s+not|never|avoid|watch\s+out|be\s+careful)\s+\w+\s+(error|bug|issue)\b`,
		MemoryType.ERROR,
		0.9,
		"persistent",
	),
	typePattern(String.raw`\b(deprecated|obsolete|legacy|outdated)\b`, MemoryType.ERROR, 0.8, "persistent"),
	typePattern(String.raw`\b(exception|timeout|crash|hang|freeze)\b`, MemoryType.ERROR, 0.8, "persistent"),
	typePattern(String.raw`\b(workaround|hotfix|patch|kludge)\b`, MemoryType.ERROR, 0.7, "persistent"),

	// ARTIFACT: Document/code references
	typePattern(String.raw`\b(document|doc|spreadsheet|sheet|slide)\b`, MemoryType.ARTIFACT, 0.6, "reference"),
	typePattern(String.raw`\b(file|folder|directory|path)\s+(name|called|at)\b`, MemoryType.ARTIFACT, 0.7, "reference"),
	typePattern(String.raw`\b(PR|pull\s+request|issue|ticket|ticket)\s+#?\d+`, MemoryType.ARTIFACT, 0.9, "reference"),
	typePattern(String.raw`\b(commit|branch|tag|release)\s+[a-f0-9]{7,40}\b`, MemoryType.ARTIFACT, 0.9, "reference"),
	typePattern(String.raw`\b(repo|repository|project|codebase)\s+(at|on|in)\b`, MemoryType.ARTIFACT, 0.7, "reference"),
	typePattern(String.raw`\b(link|URL|href|reference)\s+(to|for)\b`, MemoryType.ARTIFACT, 0.6, "reference"),
	typePattern(String.raw`\b(README|CHANGELOG|LICENSE|CONTRIBUTING)\b`, MemoryType.ARTIFACT, 0.9, "reference"),
];

const COMPILED_TYPE_PATTERNS: readonly CompiledTypePattern[] = TYPE_PATTERNS.map(
	([pattern, memoryType, baseConfidence, priority]): CompiledTypePattern => [
		new RegExp(pattern, "i"),
		pattern,
		memoryType,
		baseConfidence,
		priority,
	],
);

export const CONFIDENCE_BOOSTERS: Readonly<Record<MemoryType, readonly string[]>> = {
	[MemoryType.FACT]: ["verified", "confirmed", "official", "documented", "according to", "data shows"],
	[MemoryType.PREFERENCE]: ["always", "never", "absolutely", "definitely", "strongly"],
	[MemoryType.DECISION]: ["final", "official", "approved", "agreed", "consensus"],
	[MemoryType.COMMITMENT]: ["promise", "guarantee", "committed", "deadline", "SLA"],
	[MemoryType.GOAL]: ["target", "objective", "KPI", "OKR", "success metric"],
	[MemoryType.EVENT]: ["specifically", "exactly", "precisely", "at", "on"],
	[MemoryType.INSTRUCTION]: ["mandatory", "required", "critical", "important"],
	[MemoryType.RELATIONSHIP]: ["directly", "reports to", "managed by", "owned by"],
	[MemoryType.CONTEXT]: ["currently", "right now", "active", "in progress"],
	[MemoryType.LEARNING]: ["key lesson", "important finding", "critical insight"],
	[MemoryType.OBSERVATION]: ["consistently", "repeatedly", "over time", "pattern"],
	[MemoryType.ERROR]: ["critical", "severe", "blocking", "P0", "P1"],
	[MemoryType.ARTIFACT]: ["official", "canonical", "source of truth", "reference"],
	[MemoryType.UNKNOWN]: [],
};

function makeTypeMatch(
	memoryType: MemoryType,
	confidence: number,
	matchedPattern: string,
	priority: TypePriority,
): TypeMatch {
	return {
		memory_type: memoryType,
		memoryType,
		confidence,
		matched_pattern: matchedPattern,
		matchedPattern,
		priority,
	};
}

export function classifyMemory(content: string): TypeMatch {
	if (content.trim().length === 0) {
		return makeTypeMatch(MemoryType.UNKNOWN, 0.0, "", "stable");
	}

	const contentLower = content.toLowerCase();
	let bestMatch: TypeMatch | null = null;
	let bestScore = 0.0;

	for (const [pattern, matchedPattern, memoryType, baseConfidence, priority] of COMPILED_TYPE_PATTERNS) {
		const match = pattern.exec(contentLower);
		if (match === null) {
			continue;
		}

		let confidence = baseConfidence;
		const matchText = match[0] ?? "";
		if (matchText.length > 20) {
			confidence += 0.1;
		} else if (matchText.length > 10) {
			confidence += 0.05;
		}

		for (const booster of CONFIDENCE_BOOSTERS[memoryType]) {
			if (contentLower.includes(booster.toLowerCase())) {
				confidence += 0.05;
			}
		}

		confidence = Math.min(confidence, 1.0);
		const score = confidence * (1.0 + 0.1 * MEMORY_TYPE_ORDER.indexOf(memoryType));
		if (score > bestScore) {
			bestScore = score;
			bestMatch = makeTypeMatch(memoryType, confidence, matchedPattern, priority);
		}
	}

	if (bestMatch === null) {
		return content.trim().split(/\s+/).length < 5
			? makeTypeMatch(MemoryType.FACT, 0.3, "default_short", "stable")
			: makeTypeMatch(MemoryType.CONTEXT, 0.3, "default_long", "high");
	}

	return bestMatch;
}

export function classifyBatch(contents: readonly string[]): TypeMatch[] {
	return contents.map(content => classifyMemory(content));
}

export function getTypePriority(memoryType: MemoryType | string): number {
	switch (memoryType) {
		case MemoryType.INSTRUCTION:
			return 10;
		case MemoryType.COMMITMENT:
			return 9;
		case MemoryType.ERROR:
			return 8;
		case MemoryType.GOAL:
			return 7;
		case MemoryType.DECISION:
			return 6;
		case MemoryType.PREFERENCE:
			return 5;
		case MemoryType.FACT:
		case MemoryType.RELATIONSHIP:
			return 4;
		case MemoryType.LEARNING:
		case MemoryType.OBSERVATION:
			return 3;
		case MemoryType.EVENT:
		case MemoryType.CONTEXT:
			return 2;
		case MemoryType.ARTIFACT:
			return 1;
		default:
			return 0;
	}
}

const CONSOLIDATABLE_MEMORY_TYPES: ReadonlySet<string> = new Set<string>([
	MemoryType.FACT,
	MemoryType.PREFERENCE,
	MemoryType.DECISION,
	MemoryType.GOAL,
	MemoryType.LEARNING,
	MemoryType.OBSERVATION,
	MemoryType.RELATIONSHIP,
	MemoryType.INSTRUCTION,
]);

export function shouldConsolidate(memoryType: MemoryType | string): boolean {
	return CONSOLIDATABLE_MEMORY_TYPES.has(memoryType);
}

export function getDecayRate(memoryType: MemoryType | string): number {
	switch (memoryType) {
		case MemoryType.CONTEXT:
			return 0.9;
		case MemoryType.EVENT:
			return 0.7;
		case MemoryType.OBSERVATION:
		case MemoryType.UNKNOWN:
			return 0.5;
		case MemoryType.GOAL:
			return 0.4;
		case MemoryType.LEARNING:
		case MemoryType.DECISION:
			return 0.3;
		case MemoryType.PREFERENCE:
			return 0.2;
		case MemoryType.FACT:
		case MemoryType.RELATIONSHIP:
		case MemoryType.ARTIFACT:
			return 0.1;
		case MemoryType.INSTRUCTION:
		case MemoryType.ERROR:
			return 0.05;
		case MemoryType.COMMITMENT:
			return 0.5;
		default:
			return 0.3;
	}
}
