/**
 * Per-turn stuck detection: after each tool-call turn, one judge choice ask
 * over a code-built cut of the session ({@link buildSessionCut}) classifies
 * what the latest turns do against what the session already established:
 * advancing, re-investigating, retrying, off plan, finished, or unclear.
 *
 * A turn is a strike when P(re_investigating) + P(retrying) reaches
 * `model.stuckTurnGuard.threshold`; `model.stuckTurnGuard.strikes` strikes in a
 * row inject one nudge to act on what the session found, and the count starts
 * over, so the model has that many turns to act before the next one. Any other
 * verdict, including `unclear`, breaks the streak. A judge that is
 * unavailable, slow, or wrong-shaped has no effect beyond breaking the streak.
 *
 * Ported from nace-ai/intern's `supervise.py` (Apache-2.0): replayed over 82
 * stored sessions, 16 of its 19 nudges fell on turns a blind judge called stuck.
 */
import type { AgentMessage, AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import { type ChoiceAnswer, type Judge, judgeQuestions } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import questionFile from "../prompts/judge/stuck-turn.json" with { type: "json" };
import stuckTurnNudgeTemplate from "../prompts/system/stuck-turn-nudge.md" with { type: "text" };
import { buildSessionCut } from "./session-cut";
import {
	cfgModelStuckTurnGuardEnabled,
	cfgModelStuckTurnGuardStrikes,
	cfgModelStuckTurnGuardThreshold,
} from "./settings";
import { injectTurnEndCorrective, type TurnEndCorrectiveSink } from "./stream-guards";

export const STUCK_TURN_NUDGE_TYPE = "stuck-turn-nudge";

/**
 * Token budget of the session cut: three quarters of the 32k state intern's
 * System 1 accepts, leaving room for the question's own text.
 */
export const STUCK_TURN_CUT_TOKENS = 24_576;

/**
 * Longest the turn end waits for a verdict. A native judge answers in about a
 * second at the full cut (intern measured 0.6 s at the median, 0.85 s at full
 * size); a slower verdict is dropped rather than holding up the run.
 */
export const STUCK_TURN_TIMEOUT_MS = 5000;

const QUESTIONS = judgeQuestions(questionFile);

export type StuckTurnMode = keyof typeof questionFile.mode.criteria;

/** Modes whose summed probability makes a turn a strike. */
const STUCK_MODES: readonly StuckTurnMode[] = ["re_investigating", "retrying"];

/** Capabilities the stuck-turn guard borrows from its session. */
export interface StuckTurnGuardHost extends TurnEndCorrectiveSink {
	settings: Settings;
	/** The judge for one verdict; the session resolves its live `judge` role chain. */
	judge(): Judge;
	/** Changes on each prompt start; strikes never carry over from an earlier prompt. */
	promptGeneration(): number;
	/** Whether plan mode (read-only until approval) is on; the guard does not run then. */
	planModeEnabled(): boolean;
}

/** A verdict being asked for one completed turn; settle it with {@link StuckTurnGuard.settle}. */
export interface PendingStuckVerdict {
	readonly answer: Promise<ChoiceAnswer<StuckTurnMode> | undefined>;
}

/** Journal details of an injected nudge, for auditing what earned it. */
export interface StuckTurnNudgeDetails {
	strikes: number;
	threshold: number;
	choice: StuckTurnMode;
	stuckProbability: number;
}

/** P(re_investigating) + P(retrying); judges one-hot a bare choice upstream, so it counts as certain. */
export function stuckProbability(answer: ChoiceAnswer<StuckTurnMode>): number {
	let total = 0;
	for (const mode of STUCK_MODES) total += answer.probabilities[mode] ?? 0;
	return total;
}

/** Whether every probability names a mode and lies in 0..1; judges past the discriminant are not trusted. */
function fitsModes(answer: ChoiceAnswer<StuckTurnMode>): boolean {
	const probabilities: unknown = answer.probabilities;
	if (typeof probabilities !== "object" || probabilities === null) return false;
	return Object.entries(probabilities).every(
		([mode, value]) => mode in questionFile.mode.criteria && typeof value === "number" && value >= 0 && value <= 1,
	);
}

/** Counts consecutive stuck turns of a run and nudges the model once a streak reaches the strike count. */
export class StuckTurnGuard {
	readonly #host: StuckTurnGuardHost;
	readonly #timeoutMs: number;
	#strikes = 0;
	#generation: number | undefined;

	constructor(host: StuckTurnGuardHost, timeoutMs = STUCK_TURN_TIMEOUT_MS) {
		this.#host = host;
		this.#timeoutMs = timeoutMs;
	}

	/**
	 * Starts the verdict for a completed tool-call turn, so the ask runs while
	 * the rest of the turn-end work does. `undefined` when the guard is off, plan
	 * mode is on, or the turn ends the run (no next request would carry a nudge).
	 */
	ask(
		messages: readonly AgentMessage[],
		context: AgentTurnEndContext | undefined,
		signal: AbortSignal | undefined,
	): PendingStuckVerdict | undefined {
		// Plan mode is read-only until approval: a nudge to act would contradict it.
		if (cfgModelStuckTurnGuardEnabled.get(this.#host.settings) !== true || this.#host.planModeEnabled()) {
			this.#strikes = 0;
			return undefined;
		}
		const generation = this.#host.promptGeneration();
		if (generation !== this.#generation) {
			this.#generation = generation;
			this.#strikes = 0;
		}
		if (context?.message.role !== "assistant" || !context.willContinue || signal?.aborted) return undefined;
		return { answer: this.#judge(messages, signal) };
	}

	/**
	 * Counts the verdict toward the streak and injects the nudge into `messages`
	 * when the streak reaches the strike count. `corrected` (another guard
	 * already corrected this turn) resets the streak instead of counting it.
	 */
	async settle(
		messages: AgentMessage[],
		pending: PendingStuckVerdict,
		options: { signal?: AbortSignal; corrected?: boolean } = {},
	): Promise<void> {
		const answer = await pending.answer;
		if (options.signal?.aborted) return;
		if (!answer) {
			this.#strikes = 0;
			return;
		}
		const settings = this.#host.settings;
		const threshold = cfgModelStuckTurnGuardThreshold.get(settings);
		const strikesNeeded = cfgModelStuckTurnGuardStrikes.get(settings);
		const probability = stuckProbability(answer);
		const stuck = probability >= threshold;
		// A turn another guard corrected starts the streak over, so its corrective
		// gets a full streak of turns before this one can stack a second.
		this.#strikes = stuck && !options.corrected ? this.#strikes + 1 : 0;
		const due = this.#strikes >= strikesNeeded;
		logger.debug("stuck-turn guard verdict", {
			choice: answer.choice,
			stuckProbability: probability,
			threshold,
			stuck,
			corrected: options.corrected === true,
			strikes: this.#strikes,
			nudge: due,
		});
		if (!due) return;
		const strikes = this.#strikes;
		this.#strikes = 0;
		logger.warn("stuck turns detected; nudging the model to act on its findings", {
			strikes,
			stuckProbability: probability,
		});
		const details: StuckTurnNudgeDetails = {
			strikes,
			threshold,
			choice: answer.choice,
			stuckProbability: probability,
		};
		injectTurnEndCorrective(
			this.#host,
			messages,
			STUCK_TURN_NUDGE_TYPE,
			prompt.render(stuckTurnNudgeTemplate, { turns: strikes }),
			details,
		);
	}

	async #judge(
		messages: readonly AgentMessage[],
		signal: AbortSignal | undefined,
	): Promise<ChoiceAnswer<StuckTurnMode> | undefined> {
		try {
			const state = buildSessionCut(messages, STUCK_TURN_CUT_TOKENS);
			const timeout = AbortSignal.timeout(this.#timeoutMs);
			const { answers } = await this.#host
				.judge()
				.judge(
					{ state, questions: { mode: QUESTIONS.mode } },
					{ signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
				);
			const answer = answers.mode;
			if (answer?.type !== "choice" || !(answer.choice in questionFile.mode.criteria) || !fitsModes(answer)) {
				throw new Error("the judge returned a malformed mode answer");
			}
			return answer;
		} catch (error) {
			logger.debug("stuck-turn guard: verdict failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}
}
