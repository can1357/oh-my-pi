/**
 * Per-task prewalk-suitability classifier for `prewalk.auto`.
 *
 * Asks the native System One judge one choice question about where a request's
 * expensive reasoning belongs: up front (`prewalk`: the active model
 * investigates and plans, the cheap target finishes), throughout (`primary`:
 * stay on the active model), or nowhere (`direct`: nothing worth handing off
 * from). This is not a difficulty classifier (see `auto-thinking/classifier.ts`)
 * and it trusts only the calibrated native probabilities, so a prompted chat or
 * on-device model never stands in for the native judge.
 *
 * Resolves `undefined` when there is nothing to judge: no native backend, or a
 * low-signal request ("ok", "thanks"). Throws on every other failure (no key,
 * malformed answer, abort, timeout); the caller treats both as "do not arm".
 */
import type { AgentMessage, AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { type ChoiceAnswer, judgeQuestions } from "@oh-my-pi/pi-ai";
import { titleTextFromSkillPrompt } from "@oh-my-pi/pi-tui/chat/skill-title-input";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { assistantText } from "@oh-my-pi/pi-tui/overlays/copy-targets";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { hasNativeJudge, type JudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import questionFile from "../prompts/judge/auto-prewalk.json" with { type: "json" };
import { preprocessTinyMessage } from "../tiny/message-preproc";
import { isLowSignalTitleInput } from "../tiny/text";

export type PrewalkRoute = "prewalk" | "primary" | "direct";

/** `P(prewalk)` a task needs before auto-prewalk arms: a wrong hand-off costs more than a missed one. */
export const AUTO_PREWALK_MIN_PROBABILITY = 0.7;

/** A judgment slower than this gives way to the unmodified turn; an optimization never makes the user wait longer. */
export const AUTO_PREWALK_TIMEOUT_MS = 4000;

const ROUTES: readonly PrewalkRoute[] = ["prewalk", "primary", "direct"];

const QUESTIONS = judgeQuestions(questionFile);

/** The turn to classify. */
export interface AutoPrewalkInput {
	/** The expanded prompt the agent is about to act on. */
	request: string;
	/** Transcript before `request`; only its latest request/reply pair reaches the judge, to resolve follow-ups. */
	history: readonly AgentMessage[];
}

export interface AutoPrewalkDecision {
	/** The judge's winning route. */
	route: PrewalkRoute;
	/** Every route's probability; sums to 1. */
	probabilities: Record<PrewalkRoute, number>;
	/** Concentration of the distribution, 0–1. */
	confidence: number;
	/** Whether to arm prewalk: `prewalk` won with `P(prewalk) >= `{@link AUTO_PREWALK_MIN_PROBABILITY}. */
	arm: boolean;
}

export interface ClassifyAutoPrewalkDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId?: string;
	signal?: AbortSignal;
	onUsage?: (usage: JudgmentUsage) => void;
	telemetry?: AgentTelemetryConfig;
}

/** Text of a user-authored request: a typed prompt or a user-invoked skill, never an injected or agent-attributed one. */
function userRequestText(message: AgentMessage): string | undefined {
	if (message.role === "user") {
		return message.synthetic || message.attribution === "agent" ? undefined : textContent(message.content);
	}
	return message.role === "custom" ? titleTextFromSkillPrompt(message) : undefined;
}

/**
 * The newest substantive user request and the agent's newest reply after it.
 * Acknowledgements ("ok", "thanks") are not requests, so the scan looks past them.
 */
function recentContext(history: readonly AgentMessage[]): { request?: string; response?: string } {
	let response: string | undefined;
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index]!;
		response ??= assistantText(message);
		const request = userRequestText(message);
		if (request && !isLowSignalTitleInput(request)) return { request, response };
	}
	return { response };
}

/** `request` leads and is authoritative; the earlier pair is included only when the transcript has one. */
function buildState(input: AutoPrewalkInput): Record<string, string> {
	const state: Record<string, string> = { request: preprocessTinyMessage(input.request) };
	const { request, response } = recentContext(input.history);
	if (request) state.previous_request = preprocessTinyMessage(request);
	if (response) state.previous_response = preprocessTinyMessage(response);
	return state;
}

function toDecision({ choice, probabilities, confidence }: ChoiceAnswer<PrewalkRoute>): AutoPrewalkDecision {
	// The judge's wire shape is only checked for answer type upstream; a malformed answer must never arm.
	const valid = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= 1;
	if (!ROUTES.includes(choice) || !valid(confidence) || !ROUTES.every(route => valid(probabilities?.[route]))) {
		throw new Error("auto-prewalk: the judge returned a malformed route answer");
	}
	const total = ROUTES.reduce((sum, route) => sum + probabilities[route], 0);
	// Tolerates wire rounding; a distribution that does not sum to 1 is not calibrated.
	if (Math.abs(total - 1) > 1e-3 || ROUTES.some(route => probabilities[route] > probabilities[choice])) {
		throw new Error("auto-prewalk: the judge returned an inconsistent route answer");
	}
	return {
		route: choice,
		probabilities,
		confidence,
		arm: choice === "prewalk" && probabilities.prewalk >= AUTO_PREWALK_MIN_PROBABILITY,
	};
}

/**
 * Classify where `input.request`'s reasoning belongs.
 * @returns `undefined` when the request is low-signal or the `judge` role does not resolve first to a native
 * System One backend.
 * @throws when the judge cannot produce a usable answer within {@link AUTO_PREWALK_TIMEOUT_MS}.
 */
export async function classifyAutoPrewalk(
	input: AutoPrewalkInput,
	deps: ClassifyAutoPrewalkDeps,
): Promise<AutoPrewalkDecision | undefined> {
	if (isLowSignalTitleInput(input.request) || !hasNativeJudge(deps.settings, deps.registry)) return undefined;
	const judge = resolveJudge({
		settings: deps.settings,
		registry: deps.registry,
		sessionId: deps.sessionId,
		purpose: "auto-prewalk",
		onUsage: deps.onUsage,
		telemetry: deps.telemetry,
		cache: sharedJudgmentCache(),
	});
	const timeout = AbortSignal.timeout(AUTO_PREWALK_TIMEOUT_MS);
	const options = { signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout };
	// The cached execution chain can lag the fresh gate after credentials or discovery change.
	const { answers } = await judge.withCandidate((candidate, kind) => {
		if (kind !== "native") throw new Error("auto-prewalk: the judge role has no native backend");
		return candidate.judge({ state: buildState(input), questions: QUESTIONS }, options);
	}, options);
	return toDecision(answers.route);
}
