/**
 * Guardian decision engine — what the memory layer *would* do, and why.
 *
 * `observe-mode.ts` already knows how to hold an intervention back and how to
 * move its own threshold in response to feedback. What it cannot do is decide
 * whether a turn deserves an intervention at all: `evaluateTurn` takes a score
 * it is handed. This module is what produces that score, and the reasoning
 * string that makes it auditable.
 *
 * ## The score
 *
 * Seven positive signals, weighted to sum to exactly 1, minus three penalties:
 *
 * ```text
 *   0.22 taskRelevance + 0.18 decisionImpact + 0.16 agentUncertainty
 * + 0.14 errorSimilarity + 0.12 userConstraintMatch + 0.10 graphImpact
 * + 0.08 memoryNovelty
 * - latencyCost - contextBloatPenalty - staleMemoryPenalty
 * ```
 *
 * Every term is 0..1 and the result is clamped to 0..1, so a run of penalties
 * cannot drive the score negative and make the ladder below behave oddly.
 *
 * ## Two axes, deliberately separate
 *
 * A decision has an **intended** action (what the score says) and an
 * **effective** action (what the session is allowed to see). They are computed
 * independently and both are returned, for the same reason
 * {@link GuardianObserveModeEngine} returns both: the decision trace has to
 * stay honest even when the intervention is suppressed. A guardian that only
 * recorded what it was permitted to do could never produce the evidence needed
 * to grant it more permission.
 *
 * - `intendedAction` comes from {@link GuardianDecisionEngine.decideAction},
 *   which is a pure function of the score and the configured thresholds.
 * - `action` (effective) is `intendedAction` after {@link GuardianMode} is
 *   applied.
 *
 * ## The escalation ladder
 *
 * Ascending, and aligned with the thresholds already in `observe-mode.ts` so
 * the two files cannot disagree about what "worth injecting" means:
 *
 * | score      | intended action     |
 * |------------|---------------------|
 * | >= 0.75    | `WARN_AGENT`        |
 * | >= 0.55    | `INJECT_CONTEXT`    |
 * | >= 0.30    | `RETRIEVE_SILENTLY` |
 * | otherwise  | `CAPTURE_ONLY`      |
 *
 * `CHECKPOINT_NOW` and `QUEUE_MAINTENANCE` are deliberately **not** on this
 * ladder. They are housekeeping, not escalation — a compaction always wants a
 * checkpoint regardless of how interesting the turn was, and an idle period is
 * the right time for maintenance no matter what the score says. Putting them
 * at the top of a relevance ladder would mean the most relevant turns get
 * garbage-collected instead of answered.
 *
 * ## Cost
 *
 * Scoring is pure arithmetic over already-extracted entities and
 * already-retrieved records: no I/O, no allocation beyond a handful of sets in
 * {@link jaccardSimilarity}. It runs on the agent's hot path, so it must stay
 * that way. Anything needing I/O belongs behind `RETRIEVE_SILENTLY`, not
 * inside the scorer.
 */

import type { CandidateStatus, CandidateVerification } from "../tiered-retrieval-types";
import type { ExtractedEntities, QueryIntent, SessionEvent, SessionEventBus } from "./event-bus";

/**
 * What the guardian can do about a turn.
 *
 * The first four are the escalation ladder, ordered by how visible they are to
 * the user. The last two are housekeeping and are chosen by which event fired,
 * not by the score.
 */
export type GuardianAction =
	| "IGNORE"
	| "CAPTURE_ONLY"
	| "RETRIEVE_SILENTLY"
	| "INJECT_CONTEXT"
	| "WARN_AGENT"
	| "CHECKPOINT_NOW"
	| "QUEUE_MAINTENANCE";

/**
 * How much of its intent the guardian is permitted to act on.
 *
 * - `off` — the engine subscribes to nothing. Zero hot-path cost.
 * - `observe` — scores and records everything, suppresses everything a user
 *   could notice. This is the mode that earns the right to the others.
 * - `suggest` — may inject context, may not warn. Warnings are downgraded
 *   rather than dropped, so the evidence for warning survives.
 * - `active` — acts on its intent.
 * - `strict` — acts on its intent; reserved for future policy that refuses to
 *   fail open. Behaves as `active` today and is mapped to `enforce` by
 *   {@link GuardianDecisionEngine.getDecisionEngineMode}.
 */
export type GuardianMode = "off" | "observe" | "suggest" | "active" | "strict";

/**
 * The individual signals behind a score.
 *
 * Recorded on the decision so a reviewer can see *which* signal carried it,
 * rather than only the total.
 */
export interface InterventionScore {
	/** Overlap between what the user just said and the session objective. */
	taskRelevance: number;
	/** How consequential the operation about to happen is. */
	decisionImpact: number;
	/** How much of what we believe is unverified or contradicted. */
	agentUncertainty: number;
	/** Similarity between a live error and one we have evidence about. */
	errorSimilarity: number;
	/** Whether a recorded user constraint bears on this operation. */
	userConstraintMatch: number;
	/** Whether the symbols in play appear in graph assertions we hold. */
	graphImpact: number;
	/** Share of candidates that have never been surfaced before. */
	memoryNovelty: number;
	/** Penalty: retrieval latency already spent. */
	latencyCost: number;
	/** Penalty: how full the context window already is. */
	contextBloatPenalty: number;
	/** Penalty: share of candidates that are old and unconfirmed. */
	staleMemoryPenalty: number;
}

/**
 * Positive-signal weights. Summing to exactly 1 is load-bearing: it is what
 * makes a score comparable against the thresholds in `observe-mode.ts`, which
 * are expressed on a 0..1 scale. Changing a weight without rebalancing the
 * others silently rescales every threshold in the fabric.
 */
export const SCORE_WEIGHTS = {
	taskRelevance: 0.22,
	decisionImpact: 0.18,
	agentUncertainty: 0.16,
	errorSimilarity: 0.14,
	userConstraintMatch: 0.12,
	graphImpact: 0.1,
	memoryNovelty: 0.08,
} as const satisfies Record<string, number>;

export interface GuardianTriggerConfig {
	sessionStart: boolean;
	userPrompt: boolean;
	beforeModel: boolean;
	planCommit: boolean;
	toolCall: boolean;
	toolResult: boolean;
	compaction: boolean;
	resume: boolean;
	idle: boolean;
	sessionStop: boolean;
}

export interface GuardianConfig {
	enabled: boolean;
	mode: GuardianMode;
	/** Score at or above which the guardian wants to retrieve, quietly. */
	retrieveSilentlyThreshold: number;
	/** Score at or above which the guardian wants to inject context. */
	injectContextThreshold: number;
	/** Score at or above which the guardian wants to warn the agent. */
	warnAgentThreshold: number;
	/** Interventions retained in memory. Oldest are dropped past this. */
	maxRetainedInterventions: number;
	triggers: GuardianTriggerConfig;
}

/**
 * Thresholds mirror `observe-mode.ts` exactly (`minWarnScore` 0.75,
 * `minInjectScore` 0.55, `MIN_SILENT_RETRIEVAL_SCORE` 0.3). The two files
 * describe the same ladder from two directions and must not drift.
 */
export const DEFAULT_GUARDIAN_CONFIG: GuardianConfig = {
	enabled: true,
	mode: "observe",
	retrieveSilentlyThreshold: 0.3,
	injectContextThreshold: 0.55,
	warnAgentThreshold: 0.75,
	maxRetainedInterventions: 200,
	triggers: {
		sessionStart: true,
		userPrompt: true,
		beforeModel: true,
		planCommit: true,
		toolCall: true,
		toolResult: true,
		compaction: true,
		resume: true,
		idle: true,
		sessionStop: true,
	},
};

/**
 * A persisted memory record, as the scorer needs to see it.
 *
 * This is deliberately a narrow view rather than the full record type: the
 * scorer reads seven fields and should not be coupled to the rest. The
 * `status` and `verification` unions are imported from
 * `../tiered-retrieval-types` rather than redeclared, so a new verification
 * level cannot appear in retrieval without the compiler pointing at every
 * scorer branch that now has a case it does not handle.
 */
export interface GuardianMemoryRecord {
	memoryId: string;
	/** Record kind, e.g. `"evidence"`, `"graph-assertion"`, `"decision"`. */
	type: string;
	content: string;
	status: CandidateStatus;
	verification: CandidateVerification;
	createdAt: string;
	/** Times this record has been surfaced. 0 means never seen. */
	retrievalCount?: number;
	/** Kind-specific payload; only `evidenceType` is read here. */
	structured?: { evidenceType?: string } & Record<string, unknown>;
}

/** The slice of session working state the scorer reads. */
export interface GuardianWorkingState {
	objective?: string;
	constraints?: string[];
}

export interface GuardianContext {
	entities: ExtractedEntities;
	intent: QueryIntent;
	/** `null` when the session has not established an objective yet. */
	workingState: GuardianWorkingState | null;
	recentMemories: GuardianMemoryRecord[];
	retrievedRecords: GuardianMemoryRecord[];
	estimatedLatencyMs: number;
	currentContextTokens?: number;
}

export interface GuardianDecision {
	/** What the session is allowed to see, after mode is applied. */
	action: GuardianAction;
	/** What the score alone asked for, before mode was applied. */
	intendedAction: GuardianAction;
	/** True when `action` was held back from `intendedAction`. */
	suppressed: boolean;
	score: number;
	components: InterventionScore;
	reasoning: string;
	trigger: SessionEvent["type"];
	entities: ExtractedEntities;
	intent: QueryIntent;
}

export interface GuardianIntervention {
	id: string;
	timestamp: string;
	trigger: SessionEvent["type"];
	decision: GuardianDecision;
	/** Populated by the participant that performs retrieval, not by the engine. */
	injectedRecordIds: string[];
	tokenCount: number;
	latencyMs: number;
	usefulness?: "USED" | "PARTIALLY_USED" | "IGNORED" | "CONTRADICTED" | "OUTDATED" | "HARMFUL" | "UNKNOWN";
}

/**
 * Per-event scoring defaults.
 *
 * The original engine had ten near-identical handlers differing only in these
 * three values; expressing them as data makes the differences reviewable and
 * makes it impossible for one handler to drift from the others. Keyed by
 * `SessionEvent["type"]`, so adding an event to the bus without deciding how
 * the guardian reacts is a compile error.
 */
interface TriggerSpec {
	configKey: keyof GuardianTriggerConfig;
	intent: QueryIntent;
	/** Budget attributed to this trigger; feeds the latency penalty. */
	estimatedLatencyMs: number;
	/**
	 * Housekeeping action that replaces the score ladder for this event.
	 * Present only where the action is a consequence of the event itself.
	 */
	forcedAction?: GuardianAction;
}

const TRIGGERS: Record<SessionEvent["type"], TriggerSpec> = {
	"session-start": { configKey: "sessionStart", intent: "unknown", estimatedLatencyMs: 50 },
	"user-prompt": { configKey: "userPrompt", intent: "unknown", estimatedLatencyMs: 50 },
	"before-model": { configKey: "beforeModel", intent: "unknown", estimatedLatencyMs: 100 },
	"plan-commit": { configKey: "planCommit", intent: "architecture", estimatedLatencyMs: 200 },
	"tool-call": { configKey: "toolCall", intent: "implementation", estimatedLatencyMs: 100 },
	"tool-result": { configKey: "toolResult", intent: "debugging", estimatedLatencyMs: 150 },
	compaction: {
		configKey: "compaction",
		intent: "procedure",
		estimatedLatencyMs: 300,
		forcedAction: "CHECKPOINT_NOW",
	},
	resume: { configKey: "resume", intent: "procedure", estimatedLatencyMs: 200 },
	idle: { configKey: "idle", intent: "procedure", estimatedLatencyMs: 500, forcedAction: "QUEUE_MAINTENANCE" },
	"session-stop": {
		configKey: "sessionStop",
		intent: "procedure",
		estimatedLatencyMs: 500,
		forcedAction: "CHECKPOINT_NOW",
	},
};

/** Latency penalty saturates here; beyond this, slower is not more damning. */
const LATENCY_PENALTY_CEILING = 0.3;
const LATENCY_PENALTY_SCALE_MS = 2000;
/** Context-bloat penalty saturates here. */
const BLOAT_PENALTY_CEILING = 0.2;
const BLOAT_PENALTY_SCALE_TOKENS = 20000;
/** Stale-memory penalty saturates here. */
const STALE_PENALTY_CEILING = 0.3;
/** A record older than this, still unconfirmed, counts as stale. */
const STALE_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Words shorter than this are dropped before similarity is computed. */
const MIN_SIMILARITY_WORD_LENGTH = 3;
/** Signals below this are omitted from the reasoning string. */
const REASONING_SIGNAL_FLOOR = 0.1;
const REASONING_TOP_N = 3;

/** Tool names matching any of these are treated as consequential. */
const DESTRUCTIVE_TOOL_PATTERN = /write|edit|patch|delete|remove|move|rename|bash|shell|exec|apply/i;

/** Empty entity set, for events that carry no prompt of their own. */
const NO_ENTITIES: ExtractedEntities = { files: [], symbols: [], errors: [], taskNames: [], commands: [] };

const EMPTY_COMPONENTS: InterventionScore = {
	taskRelevance: 0,
	decisionImpact: 0,
	agentUncertainty: 0,
	errorSimilarity: 0,
	userConstraintMatch: 0,
	graphImpact: 0,
	memoryNovelty: 0,
	latencyCost: 0,
	contextBloatPenalty: 0,
	staleMemoryPenalty: 0,
};

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/**
 * Word-set Jaccard similarity.
 *
 * Chosen over edit distance because the inputs are error messages, where the
 * signal is which identifiers and words co-occur rather than their order or
 * exact spelling. Short words are dropped so that "the", "not" and "was" do
 * not make every pair of English sentences look alike.
 */
function jaccardSimilarity(a: string, b: string): number {
	const wordsA = new Set(
		a
			.toLowerCase()
			.split(/\W+/)
			.filter(w => w.length >= MIN_SIMILARITY_WORD_LENGTH),
	);
	const wordsB = new Set(
		b
			.toLowerCase()
			.split(/\W+/)
			.filter(w => w.length >= MIN_SIMILARITY_WORD_LENGTH),
	);
	if (wordsA.size === 0 || wordsB.size === 0) return 0;

	let intersection = 0;
	for (const word of wordsA) {
		if (wordsB.has(word)) intersection++;
	}
	const union = wordsA.size + wordsB.size - intersection;
	return union > 0 ? intersection / union : 0;
}

/** True for records that describe something that was actually observed to happen. */
function isOutcomeEvidence(record: GuardianMemoryRecord): boolean {
	if (record.type !== "evidence") return false;
	const kind = record.structured?.evidenceType;
	return kind === "test-result" || kind === "build-result";
}

/** Notified for every decision the engine records. See {@link GuardianDecisionEngine.onDecision}. */
export type GuardianDecisionListener = (intervention: GuardianIntervention, event: SessionEvent) => void;

/**
 * Scores session events and records what it would have done about them.
 *
 * The engine never performs retrieval or injection itself. It decides, records
 * the decision, and leaves acting on it to a session participant — which is
 * what keeps it cheap enough to run on every event and testable without a
 * session.
 */
export class GuardianDecisionEngine {
	#config: GuardianConfig;
	readonly #eventBus: SessionEventBus;
	readonly #interventions: GuardianIntervention[] = [];
	readonly #unsubscribes: Array<() => void> = [];
	readonly #decisionListeners = new Set<GuardianDecisionListener>();
	#lastIntervention: GuardianIntervention | null = null;
	#interventionCounter = 0;

	constructor(config: Partial<GuardianConfig>, eventBus: SessionEventBus) {
		this.#config = {
			...DEFAULT_GUARDIAN_CONFIG,
			...config,
			triggers: { ...DEFAULT_GUARDIAN_CONFIG.triggers, ...config.triggers },
		};
		this.#eventBus = eventBus;
		this.#registerHooks();
	}

	#registerHooks(): void {
		if (!this.#config.enabled || this.#config.mode === "off") return;

		for (const [type, spec] of Object.entries(TRIGGERS) as Array<[SessionEvent["type"], TriggerSpec]>) {
			if (!this.#config.triggers[spec.configKey]) continue;
			this.#unsubscribes.push(this.#eventBus.on(type, event => this.#handle(event, spec)));
		}
	}

	/**
	 * Unsubscribe from every event.
	 *
	 * The engine holds a reference to itself in each listener closure, so an
	 * engine that is dropped without being disposed keeps receiving events for
	 * the life of the bus. Sessions are long-lived; this matters.
	 */
	dispose(): void {
		for (const unsubscribe of this.#unsubscribes) unsubscribe();
		this.#unsubscribes.length = 0;
		this.#decisionListeners.clear();
	}

	/**
	 * Observe every decision as it is recorded.
	 *
	 * This is the seam an acting participant hangs off. The engine deliberately
	 * does not retrieve or inject; a listener that wants to act reads the
	 * intervention and does the work on its own clock, so a slow participant
	 * can never stall the event that produced the decision.
	 *
	 * A listener that throws is reported and skipped, never rethrown into the
	 * emitting event — a broken participant must not take the session with it.
	 *
	 * @returns an unsubscribe handle
	 */
	onDecision(listener: GuardianDecisionListener): () => void {
		this.#decisionListeners.add(listener);
		return () => {
			this.#decisionListeners.delete(listener);
		};
	}

	/**
	 * Combine weighted signals into a single 0..1 score.
	 *
	 * Missing components are treated as 0 rather than as an error: a caller
	 * that cannot compute `graphImpact` because no graph lane is installed
	 * should get a lower score, not an exception.
	 */
	computeScore(components: Partial<InterventionScore>): number {
		const merged = { ...EMPTY_COMPONENTS, ...components };

		let positive = 0;
		for (const [key, weight] of Object.entries(SCORE_WEIGHTS)) {
			positive += weight * clamp01(merged[key as keyof typeof SCORE_WEIGHTS]);
		}

		const penalties =
			clamp01(merged.latencyCost) + clamp01(merged.contextBloatPenalty) + clamp01(merged.staleMemoryPenalty);

		return clamp01(positive - penalties);
	}

	/**
	 * Map a score onto the escalation ladder.
	 *
	 * Pure: no mode, no config mutation, no side effects. Mode is applied
	 * separately by {@link applyMode} so that the intended action survives
	 * suppression.
	 */
	decideAction(score: number): GuardianAction {
		if (score >= this.#config.warnAgentThreshold) return "WARN_AGENT";
		if (score >= this.#config.injectContextThreshold) return "INJECT_CONTEXT";
		if (score >= this.#config.retrieveSilentlyThreshold) return "RETRIEVE_SILENTLY";
		return "CAPTURE_ONLY";
	}

	/**
	 * Reduce an intended action to what the current mode permits.
	 *
	 * `observe` suppresses exactly the actions a user could notice, matching
	 * `GuardianObserveModeEngine`; `suggest` downgrades a warning to an
	 * injection rather than dropping it, so the softer action still carries the
	 * information that prompted the warning.
	 */
	applyMode(intended: GuardianAction): GuardianAction {
		switch (this.#config.mode) {
			case "off":
				return "IGNORE";
			case "observe":
				return intended === "INJECT_CONTEXT" || intended === "WARN_AGENT" ? "IGNORE" : intended;
			case "suggest":
				return intended === "WARN_AGENT" ? "INJECT_CONTEXT" : intended;
			default:
				return intended;
		}
	}

	/**
	 * Score one event and decide what to do about it.
	 *
	 * Public because it is the unit under test: a decision is reproducible from
	 * an event plus a context, with no bus and no session involved.
	 */
	decide(event: SessionEvent, context: GuardianContext, forcedAction?: GuardianAction): GuardianDecision {
		const { entities, intent, workingState, recentMemories, retrievedRecords } = context;

		const components: InterventionScore = {
			taskRelevance: this.#computeTaskRelevance(entities, workingState),
			decisionImpact: this.#computeDecisionImpact(event, intent, entities),
			agentUncertainty: this.#computeAgentUncertainty(recentMemories),
			errorSimilarity: this.#computeErrorSimilarity(entities, retrievedRecords),
			userConstraintMatch: this.#computeUserConstraintMatch(event, workingState),
			graphImpact: this.#computeGraphImpact(entities, retrievedRecords),
			memoryNovelty: this.#computeMemoryNovelty(retrievedRecords),
			latencyCost: Math.min(LATENCY_PENALTY_CEILING, context.estimatedLatencyMs / LATENCY_PENALTY_SCALE_MS),
			contextBloatPenalty: Math.min(
				BLOAT_PENALTY_CEILING,
				(context.currentContextTokens ?? 0) / BLOAT_PENALTY_SCALE_TOKENS,
			),
			staleMemoryPenalty: this.#computeStalePenalty(retrievedRecords),
		};

		const score = this.computeScore(components);

		// A forced action is housekeeping and outranks the ladder, but it is
		// still subject to mode: an engine in `off` acts on nothing at all.
		const intendedAction = forcedAction ?? this.decideAction(score);
		const action = this.applyMode(intendedAction);

		return {
			action,
			intendedAction,
			suppressed: action !== intendedAction,
			score,
			components,
			reasoning: this.#generateReasoning(score, intendedAction, components, forcedAction !== undefined),
			trigger: event.type,
			entities,
			intent,
		};
	}

	#handle(event: SessionEvent, spec: TriggerSpec): Promise<void> {
		// A tool result that did not fail carries no signal the guardian acts
		// on, and tool results are the highest-frequency event on the bus.
		if (event.type === "tool-result" && !event.isError) return Promise.resolve();

		const entities =
			event.type === "user-prompt"
				? event.entities
				: event.type === "tool-result"
					? { ...NO_ENTITIES, errors: [describeToolFailure(event.toolName)] }
					: NO_ENTITIES;

		const intent = event.type === "user-prompt" ? event.intent : spec.intent;

		// `session-start` is the one event that carries the objective inline, so
		// it is the one place the engine can score against real working state
		// rather than a placeholder. Every other event gets its working state
		// from the participant that owns the session, once one is wired up.
		const workingState: GuardianWorkingState | null =
			event.type === "session-start" && event.objective ? { objective: event.objective } : null;

		const decision = this.decide(
			event,
			{
				entities,
				intent,
				workingState,
				recentMemories: [],
				retrievedRecords: [],
				estimatedLatencyMs: spec.estimatedLatencyMs,
			},
			spec.forcedAction,
		);

		// `CAPTURE_ONLY` and `IGNORE` are recorded too. The decision trace is
		// the product in observe mode, and a trace with the quiet turns removed
		// would misrepresent how often the guardian wanted to act.
		this.#record(event, decision);
		return Promise.resolve();
	}

	#computeTaskRelevance(entities: ExtractedEntities, workingState: GuardianWorkingState | null): number {
		const objective = workingState?.objective?.toLowerCase();
		if (!objective) return 0;

		let score = 0;
		if (entities.taskNames.some(t => objective.includes(t.toLowerCase()))) score += 0.5;
		if (entities.files.some(f => matchesBasename(objective, f))) score += 0.3;
		if (entities.symbols.some(s => objective.includes(s.toLowerCase()))) score += 0.2;
		return clamp01(score);
	}

	/**
	 * How consequential the operation about to happen is.
	 *
	 * Distinct from {@link #computeErrorSimilarity} on purpose: impact is about
	 * the *operation*, similarity is about the *evidence*. The original engine
	 * computed both with the same code, which meant 32% of the weight was one
	 * signal counted twice.
	 */
	#computeDecisionImpact(event: SessionEvent, intent: QueryIntent, entities: ExtractedEntities): number {
		let score = 0.2;

		if (event.type === "plan-commit" || event.type === "compaction") score += 0.3;
		else if (event.type === "tool-call" && DESTRUCTIVE_TOOL_PATTERN.test(event.toolName)) score += 0.3;

		if (intent === "architecture") score += 0.2;
		else if (intent === "debugging") score += 0.1;

		// Breadth: an edit touching many files is more consequential than one
		// touching a single file, and saturates so a noisy prompt cannot
		// dominate the term.
		score += Math.min(0.2, entities.files.length * 0.04);

		return clamp01(score);
	}

	/**
	 * How much of what we currently believe is unverified or disputed.
	 *
	 * Note that `contradicted` is a {@link CandidateStatus}, not a
	 * {@link CandidateVerification}; testing it against `verification` — as the
	 * original did — makes the term unconditionally zero, because the two
	 * unions share no members.
	 */
	#computeAgentUncertainty(recentMemories: GuardianMemoryRecord[]): number {
		// No memory at all is genuinely uncertain, not certainly fine.
		if (recentMemories.length === 0) return 0.5;

		let provisional = 0;
		let contradicted = 0;
		for (const record of recentMemories) {
			if (record.verification === "model-proposed") provisional++;
			if (record.status === "contradicted") contradicted++;
		}

		const provisionalRatio = provisional / recentMemories.length;
		return clamp01(0.3 + provisionalRatio * 0.4 + contradicted * 0.1);
	}

	#computeErrorSimilarity(entities: ExtractedEntities, retrievedRecords: GuardianMemoryRecord[]): number {
		if (entities.errors.length === 0) return 0;
		// We have an error but nothing to compare it against; that is a weak
		// reason to go looking, not a reason to conclude anything.
		if (retrievedRecords.length === 0) return 0.3;

		let best = 0;
		for (const record of retrievedRecords) {
			if (!isOutcomeEvidence(record)) continue;
			for (const error of entities.errors) {
				best = Math.max(best, jaccardSimilarity(error, record.content));
				if (best === 1) return 1;
			}
		}
		return best;
	}

	#computeUserConstraintMatch(event: SessionEvent, workingState: GuardianWorkingState | null): number {
		if (!workingState?.constraints?.length) return 0;
		// A constraint matters most immediately before something is done.
		return event.type === "tool-call" || event.type === "before-model" ? 0.4 : 0.2;
	}

	#computeGraphImpact(entities: ExtractedEntities, retrievedRecords: GuardianMemoryRecord[]): number {
		if (entities.symbols.length === 0) return 0;

		const graphRecords = retrievedRecords.filter(r => r.type === "graph-assertion");
		if (graphRecords.length === 0) return 0;

		const haystack = graphRecords.map(r => r.content.toLowerCase());
		let hits = 0;
		for (const symbol of entities.symbols) {
			const needle = symbol.toLowerCase();
			if (haystack.some(content => content.includes(needle))) hits++;
		}
		return clamp01(hits * 0.2);
	}

	#computeMemoryNovelty(retrievedRecords: GuardianMemoryRecord[]): number {
		if (retrievedRecords.length === 0) return 0;
		const unseen = retrievedRecords.filter(r => (r.retrievalCount ?? 0) === 0).length;
		return unseen / retrievedRecords.length;
	}

	#computeStalePenalty(retrievedRecords: GuardianMemoryRecord[]): number {
		if (retrievedRecords.length === 0) return 0;

		const now = Date.now();
		let stale = 0;
		for (const record of retrievedRecords) {
			if (record.verification === "user-confirmed") continue;
			const createdAt = Date.parse(record.createdAt);
			// An unparseable timestamp is not evidence of staleness.
			if (Number.isNaN(createdAt)) continue;
			if (now - createdAt > STALE_AGE_MS) stale++;
		}
		return (stale / retrievedRecords.length) * STALE_PENALTY_CEILING;
	}

	#generateReasoning(score: number, action: GuardianAction, components: InterventionScore, forced: boolean): string {
		const top = (Object.keys(SCORE_WEIGHTS) as Array<keyof typeof SCORE_WEIGHTS>)
			.map(key => [key, components[key]] as const)
			.filter(([, value]) => value > REASONING_SIGNAL_FLOOR)
			.sort(([, a], [, b]) => b - a)
			.slice(0, REASONING_TOP_N)
			.map(([key, value]) => `${key}=${value.toFixed(2)}`)
			.join(", ");

		const factors = top.length > 0 ? `Top factors: ${top}` : "No signal above floor";
		const how = forced ? `${action} (event-determined)` : action;
		return `Score ${score.toFixed(3)} -> ${how}. ${factors}`;
	}

	#record(event: SessionEvent, decision: GuardianDecision): void {
		this.#interventionCounter++;
		const intervention: GuardianIntervention = {
			id: `int_${this.#interventionCounter}_${Date.now().toString(36)}`,
			timestamp: new Date().toISOString(),
			trigger: event.type,
			decision,
			injectedRecordIds: [],
			tokenCount: 0,
			latencyMs: 0,
		};

		this.#interventions.push(intervention);
		// Bounded on purpose: a long session emits an event per tool call, and
		// an unbounded trace is a leak that only shows up in the sessions that
		// matter most.
		const overflow = this.#interventions.length - this.#config.maxRetainedInterventions;
		if (overflow > 0) this.#interventions.splice(0, overflow);

		this.#lastIntervention = intervention;

		for (const listener of this.#decisionListeners) {
			try {
				listener(intervention, event);
			} catch (error) {
				console.error("[guardian] decision listener failed", error);
			}
		}
	}

	getLastIntervention(): GuardianIntervention | null {
		return this.#lastIntervention;
	}

	getInterventions(limit = 20): GuardianIntervention[] {
		return this.#interventions.slice(-limit);
	}

	getConfig(): GuardianConfig {
		return { ...this.#config, triggers: { ...this.#config.triggers } };
	}

	/**
	 * Update configuration in place.
	 *
	 * Thresholds and mode take effect immediately. Changing `triggers` does
	 * *not* re-subscribe: subscriptions are established once at construction,
	 * so a trigger disabled here stops being acted on only if the caller also
	 * disposes and rebuilds. Flipping mode to `off` is the supported way to
	 * silence a live engine.
	 */
	updateConfig(updates: Partial<GuardianConfig>): void {
		this.#config = {
			...this.#config,
			...updates,
			triggers: { ...this.#config.triggers, ...updates.triggers },
		};
	}

	recordUsefulness(interventionId: string, usefulness: GuardianIntervention["usefulness"]): void {
		const intervention = this.#interventions.find(i => i.id === interventionId);
		if (intervention) intervention.usefulness = usefulness;
	}

	/**
	 * The two-state mode the transparency snapshot consumes.
	 *
	 * The engine's own five-state mode is richer than the wire format, so
	 * `active` and `strict` both collapse to `enforce` and everything else
	 * reads as `observe`.
	 */
	getDecisionEngineMode(): "observe" | "enforce" {
		return this.#config.mode === "active" || this.#config.mode === "strict" ? "enforce" : "observe";
	}

	#countByIntendedAction(actions: ReadonlySet<GuardianAction>): number {
		let count = 0;
		for (const intervention of this.#interventions) {
			// Counted on intent, not effect: in observe mode every suppressed
			// action reads as IGNORE, and a panel showing "0 warnings" for a
			// guardian that wanted to warn forty times is worse than no panel.
			if (actions.has(intervention.decision.intendedAction)) count++;
		}
		return count;
	}

	infoAdvisoryCount(): number {
		return this.#countByIntendedAction(new Set(["IGNORE", "CAPTURE_ONLY", "RETRIEVE_SILENTLY", "INJECT_CONTEXT"]));
	}

	warningAdvisoryCount(): number {
		return this.#countByIntendedAction(new Set(["WARN_AGENT"]));
	}

	blockAdvisoryCount(): number {
		return this.#countByIntendedAction(new Set(["CHECKPOINT_NOW", "QUEUE_MAINTENANCE"]));
	}

	activeRuleCount(): number {
		let count = 0;
		for (const enabled of Object.values(this.#config.triggers)) {
			if (enabled) count++;
		}
		return count;
	}

	decisionCount(): number {
		return this.#interventions.length;
	}
}

/** True when `objective` mentions the final path segment of `file`. */
function matchesBasename(objective: string, file: string): boolean {
	const basename = file.split("/").pop()?.toLowerCase();
	return basename !== undefined && basename.length > 0 && objective.includes(basename);
}

/**
 * A stand-in error string for a failed tool call.
 *
 * The result content is deliberately not read here: it can be arbitrarily
 * large, it is not always text, and the scorer runs on the hot path. The tool
 * name alone is enough for the guardian to decide whether it is worth going
 * and looking properly.
 */
function describeToolFailure(toolName: string): string {
	return `Failed to run tool ${toolName}`;
}
