/**
 * Guardian observe mode and the feedback loop that tunes it.
 *
 * A proactive memory layer that injects context into a live turn is a layer
 * that can make the agent *worse*. Observe mode is how that risk is paid down
 * before it is taken: the engine scores every turn and records the action it
 * *would* have taken, while the session runs exactly as if the guardian were
 * not installed. The decision trace is real; the intervention is not.
 *
 * That separation is the whole point of `evaluateTurn` returning both an
 * `intendedAction` and an `effectiveAction`. The intended action is what the
 * scoring says; the effective action is what the session actually sees. In
 * observe mode the two diverge for exactly the interventions a user would
 * notice — `INJECT_CONTEXT` and `WARN_AGENT` — and agree everywhere else,
 * because silent retrieval and ignoring are unobservable either way.
 *
 * Once signals carry usefulness feedback, `tuneThresholds` closes the loop and
 * moves the injection threshold. It is deliberately timid:
 *
 *   - It refuses to move on fewer than five rated signals, because a threshold
 *     tuned on two data points is noise with extra steps.
 *   - It raises the bar on a false-positive rate above 30%, and lowers it only
 *     when *every* rated signal came back useful.
 *   - It clamps to [0.4, 0.85] and steps by 0.05, so no feedback run can drive
 *     the guardian into either always-inject or never-inject.
 */

export interface GuardianInterventionSignal {
	id: string;
	timestamp: string;
	action: "INJECT_CONTEXT" | "WARN_AGENT" | "IGNORE" | "RETRIEVE_SILENTLY";
	observedOnly: boolean;
	score: number;
	/** 0..1 feedback rating; undefined until feedback arrives. */
	usefulnessScore?: number;
	relevanceReason: string;
}

export interface InjectionThresholdConfig {
	observeMode: boolean;
	minInjectScore: number;
	minWarnScore: number;
	bloatPenaltyWeight: number;
}

/** Minimum rated signals before a tuning pass is allowed to move anything. */
const MIN_RATED_SIGNALS_TO_TUNE = 5;
/** False-positive rate above which the injection threshold is raised. */
const FALSE_POSITIVE_RATE_LIMIT = 0.3;
const THRESHOLD_STEP = 0.05;
const THRESHOLD_CEILING = 0.85;
const THRESHOLD_FLOOR = 0.4;
/** Score below which a turn is not worth even a silent retrieval. */
const MIN_SILENT_RETRIEVAL_SCORE = 0.3;

export class GuardianObserveModeEngine {
	readonly #config: InjectionThresholdConfig;
	readonly #signals: GuardianInterventionSignal[] = [];

	constructor(config: Partial<InjectionThresholdConfig> = {}) {
		this.#config = {
			observeMode: true,
			minInjectScore: 0.55,
			minWarnScore: 0.75,
			bloatPenaltyWeight: 0.1,
			...config,
		};
	}

	setObserveMode(enabled: boolean): void {
		this.#config.observeMode = enabled;
	}

	isObserveMode(): boolean {
		return this.#config.observeMode;
	}

	/**
	 * Score a turn and decide what to do about it.
	 *
	 * Returns the intended action alongside the effective one so a caller can
	 * log what the guardian *wanted* while honouring what observe mode allows.
	 */
	evaluateTurn(
		score: number,
		reason: string,
	): {
		effectiveAction: GuardianInterventionSignal["action"];
		intendedAction: GuardianInterventionSignal["action"];
		observedOnly: boolean;
	} {
		let intendedAction: GuardianInterventionSignal["action"] = "IGNORE";

		if (score >= this.#config.minWarnScore) {
			intendedAction = "WARN_AGENT";
		} else if (score >= this.#config.minInjectScore) {
			intendedAction = "INJECT_CONTEXT";
		} else if (score >= MIN_SILENT_RETRIEVAL_SCORE) {
			intendedAction = "RETRIEVE_SILENTLY";
		}

		// Observe mode suppresses only the actions a user would notice. Silent
		// retrieval and ignoring are unobservable, so they pass through.
		const observedOnly = this.#config.observeMode;
		const suppressed = intendedAction === "INJECT_CONTEXT" || intendedAction === "WARN_AGENT";
		const effectiveAction = observedOnly && suppressed ? "IGNORE" : intendedAction;

		this.#signals.push({
			id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			timestamp: new Date().toISOString(),
			action: intendedAction,
			observedOnly,
			score,
			relevanceReason: reason,
		});

		return { effectiveAction, intendedAction, observedOnly };
	}

	/** Attach a usefulness rating to a previously emitted signal. */
	recordFeedback(signalId: string, useful: boolean): void {
		const signal = this.#signals.find(s => s.id === signalId);
		if (signal) {
			signal.usefulnessScore = useful ? 1 : 0;
		}
	}

	/**
	 * Move the injection threshold in response to accumulated feedback.
	 *
	 * No-ops below `MIN_RATED_SIGNALS_TO_TUNE`, and never leaves
	 * [`THRESHOLD_FLOOR`, `THRESHOLD_CEILING`], so repeated tuning cannot drive
	 * the guardian to always-inject or never-inject.
	 */
	tuneThresholds(): { oldThreshold: number; newThreshold: number } {
		const oldThreshold = this.#config.minInjectScore;
		const rated = this.#signals.filter(s => s.usefulnessScore !== undefined);
		if (rated.length < MIN_RATED_SIGNALS_TO_TUNE) {
			return { oldThreshold, newThreshold: oldThreshold };
		}

		const falsePositives = rated.filter(s => s.action === "INJECT_CONTEXT" && s.usefulnessScore === 0);

		if (falsePositives.length / rated.length > FALSE_POSITIVE_RATE_LIMIT) {
			this.#config.minInjectScore = Math.min(THRESHOLD_CEILING, oldThreshold + THRESHOLD_STEP);
		} else if (rated.every(s => s.usefulnessScore === 1)) {
			this.#config.minInjectScore = Math.max(THRESHOLD_FLOOR, oldThreshold - THRESHOLD_STEP);
		}

		return { oldThreshold, newThreshold: this.#config.minInjectScore };
	}

	/** Snapshot of every signal recorded so far. The caller cannot mutate ours. */
	getSignals(): GuardianInterventionSignal[] {
		return [...this.#signals];
	}
}
