import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { MeterProvider } from "@opentelemetry/api";
import { logger, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import composerPredictionPrompt from "../../prompts/system/composer-prediction-user.md" with { type: "text" };
import type { AgentViewSession } from "../../session/agent-session-handle";
import { isAdvisorCard } from "../../session/queued-messages";
import { cfgComposerPredictionAlternatives, cfgComposerPredictions } from "../settings";
import type { InteractiveModeContext } from "../types";
import {
	type PredictionOutcome,
	recordPredictionRequest,
	recordPredictionResolved,
	recordPredictionShown,
} from "./composer-prediction-telemetry";

/** Reply the prediction prompt asks for when the model has no confident guess. */
const SKIP_REPLY = "NO_PREDICTION";
/** Longer replies are rambling, not a message the user would type; drop them. */
const MAX_PREDICTION_LENGTH = 500;
/** Most alternatives one request asks for and the composer offers. */
export const MAX_PREDICTION_CHOICES = 4;
/**
 * Output cap for the side turn. Providers key prompt caches on reasoning parameters, so the
 * prediction runs at the lowest effort only where that change rides a per-message control (see
 * `minimizeEffort`), keeps the session's reasoning elsewhere, and sends this cap only where it
 * leaves reasoning unchanged. Leaves room for a short reasoning pass on effort models.
 */
const PREDICTION_MAX_TOKENS = 1024;
/** A prediction that has not arrived by then is no longer worth paying for or showing. */
const PREDICTION_DEADLINE_MS = 15_000;
/** Usage-ledger purpose, so session totals and `/stats` include prediction requests. */
const USAGE_PURPOSE = "composer-prediction";
/** One pair of double quotes or backticks around the whole reply. */
const WRAPPING_QUOTES = /^(?:"([^"]*)"|“([^“”]*)”|`([^`]*)`)$/;
/** A list marker some models put before each alternative despite the prompt. */
const LIST_MARKER = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;
/** Everything but letters and digits, so alternatives differing only in case or punctuation fold together. */
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * The message a prediction is keyed on: the last one that is not an advisor card. Silent advisor
 * notes land after the turn without changing what the user would reply to.
 */
function predictionAnchor(session: AgentViewSession): AgentMessage | undefined {
	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (!isAdvisorCard(messages[i])) return messages[i];
	}
	return undefined;
}

/** The conversation point a prediction was made for: a new message or session invalidates it. */
interface PredictionSource {
	/** Identifies the request in {@link ComposerPredictionUpdate}s. */
	id: string;
	session: AgentViewSession;
	lastMessage: AgentMessage | undefined;
	/** Session file and entry the request branched from; its usage is recorded there. */
	sessionId: string;
	leafId: string | null;
	/** `provider/model` serving the request, for metrics. */
	model: string;
}

interface Prediction {
	/** Alternatives, most likely first; one unless `composer.predictionAlternatives` is on. */
	choices: readonly string[];
	source: PredictionSource;
	/** `performance.now()` when the composer first displayed the prediction; unset while never displayed. */
	shownAt: number | undefined;
	/** Time from first display to the first insert; unset while not inserted or inserted before any display. */
	acceptDelayMs: number | undefined;
	/** Rank of the alternative the user inserted last; unset while none was inserted. */
	rank: number | undefined;
}

/** What predictions read and drive: any composer draft skips a request; `requestRender` repaints the composer. */
export type ComposerPredictionContext = Pick<InteractiveModeContext, "settings" | "viewSession" | "focusedAgentId"> & {
	readonly editor: Pick<InteractiveModeContext["editor"], "getText">;
	readonly ui: Pick<InteractiveModeContext["ui"], "requestRender">;
};

/** How a started request settled, or `retired`: its offered prediction left the composer. */
export type ComposerPredictionStatus = PredictionOutcome | "retired";

/**
 * A prediction's lifecycle step. Every started request settles exactly once; an `offered` one,
 * which alone carries `choices`, is later `retired` exactly once (cancelled, superseded, or stale).
 */
export interface ComposerPredictionUpdate {
	id: string;
	status: ComposerPredictionStatus;
	/** Alternatives, most likely first; present only when `status` is `offered`. */
	choices?: readonly string[];
}

export interface ComposerPredictionOptions {
	deadlineMs?: number;
	/** Metrics sink; the global provider when unset. */
	meterProvider?: MeterProvider;
	/** Called on every lifecycle step, for hosts that render the prediction themselves. */
	onUpdate?: (update: ComposerPredictionUpdate) => void;
}

/**
 * Normalize a prediction reply to the single line the composer shows, or
 * `undefined` when the model skipped, rambled, or replied with nothing usable.
 */
export function parseComposerPrediction(reply: string): string | undefined {
	let text = sanitizeText(reply).replace(/\s+/g, " ").trim();
	const quoted = WRAPPING_QUOTES.exec(text);
	if (quoted) text = (quoted[1] ?? quoted[2] ?? quoted[3] ?? "").trim();
	if (!text || text.includes(SKIP_REPLY) || text.length > MAX_PREDICTION_LENGTH) return undefined;
	return text;
}

/**
 * Normalize an alternatives reply (one message per line, most likely first) to at most `max` distinct
 * lines, or `undefined` when the model skipped or nothing usable remains. List markers and wrapping
 * quotes are stripped per line; a leading preamble line ending in a colon, lines that ramble, repeat an
 * earlier one up to case and punctuation, or carry the skip reply are dropped.
 */
export function parseComposerPredictions(reply: string, max: number): string[] | undefined {
	const lines = reply
		.split(/\r?\n/)
		.map(raw => raw.replace(LIST_MARKER, ""))
		.filter(line => line.trim());
	const choices: string[] = [];
	const seen = new Set<string>();
	for (const [i, line] of lines.entries()) {
		if (choices.length === max) break;
		// A skip in place of the most likely message declines the whole prediction.
		if (choices.length === 0 && line.includes(SKIP_REPLY)) return undefined;
		const text = parseComposerPrediction(line);
		if (!text) continue;
		// "Here are some options:" introducing the alternatives below it, despite the prompt.
		if (i === 0 && i < lines.length - 1 && text.endsWith(":")) continue;
		// Lines with no letters or digits (an emoji, "?") fold to nothing; compare those verbatim.
		const key = text.toLowerCase().replace(NON_WORD, " ").trim() || text;
		if (seen.has(key)) continue;
		seen.add(key);
		choices.push(text);
	}
	return choices.length > 0 ? choices : undefined;
}

/** The reply's alternatives, or its single prediction as the only one when alternatives are off. */
function parseReply(reply: string, alternatives: boolean): string[] | undefined {
	if (alternatives) return parseComposerPredictions(reply, MAX_PREDICTION_CHOICES);
	const text = parseComposerPrediction(reply);
	return text === undefined ? undefined : [text];
}

/**
 * Composer predictions: once a turn completes, run an ephemeral side turn on
 * the session's model and context (the same prompt prefix, so it reads the
 * prompt cache) asking for the user's likely next message, or with
 * `composer.predictionAlternatives` up to four of them, then offer them in the
 * empty composer. Tab or Right inserts one; nothing is sent.
 */
export class ComposerPredictionController {
	readonly #ctx: ComposerPredictionContext;
	readonly #deadlineMs: number;
	/** Metrics sink; the global provider when unset. */
	readonly #meterProvider: MeterProvider | undefined;
	readonly #onUpdate: ((update: ComposerPredictionUpdate) => void) | undefined;
	/** The request in flight, if any. */
	#pending: { id: string; abort: AbortController } | undefined;
	#prediction: Prediction | undefined;
	#lastId = 0;

	constructor(ctx: ComposerPredictionContext, options: ComposerPredictionOptions = {}) {
		this.#ctx = ctx;
		this.#deadlineMs = options.deadlineMs ?? PREDICTION_DEADLINE_MS;
		this.#meterProvider = options.meterProvider;
		this.#onUpdate = options.onUpdate;
	}

	/** The prediction's alternatives for the conversation as it stands now, most likely first, if one is ready. */
	get choices(): readonly string[] | undefined {
		const prediction = this.#prediction;
		if (!prediction || !this.#isCurrent(prediction.source)) return undefined;
		return prediction.choices;
	}

	/** Id of the prediction offered for the conversation as it stands now, if one is ready. */
	get offeredId(): string | undefined {
		const prediction = this.#prediction;
		if (!prediction || !this.#isCurrent(prediction.source)) return undefined;
		return prediction.source.id;
	}

	/** Id of the request in flight, else of the offered prediction not yet retired (even if stale). */
	get activeId(): string | undefined {
		return this.#pending?.id ?? this.#prediction?.source.id;
	}

	/**
	 * Predict the next message for the turn that just completed, superseding any earlier prediction.
	 * Returns the request's id, or `undefined` when no request started.
	 */
	request(): string | undefined {
		this.cancel();
		if (!cfgComposerPredictions.get(this.#ctx.settings)) return undefined;
		// A focused subagent's "user" is the parent agent, not the person at the composer.
		if (this.#ctx.focusedAgentId !== undefined) return undefined;
		const session = this.#ctx.viewSession;
		// Any draft, even whitespace, keeps the ghost hidden (it shows only over a prefix of the
		// prediction), and a compaction would rewrite the history the prediction reads: skip the
		// billed request either way.
		const model = session.model;
		if (!model || session.isStreaming || session.isCompacting || this.#ctx.editor.getText()) return undefined;
		const abort = new AbortController();
		const id = String(++this.#lastId);
		this.#pending = { id, abort };
		const source: PredictionSource = {
			id,
			session,
			lastMessage: predictionAnchor(session),
			// The journal id: after `/fresh` or with an SDK provider id, `session.sessionId` is the
			// provider-facing id, which the usage ledger rejects.
			sessionId: session.sessionManager.getSessionId(),
			leafId: session.sessionManager.getLeafId(),
			model: `${model.provider}/${model.id}`,
		};
		void this.#run(source, abort, cfgComposerPredictionAlternatives.get(this.#ctx.settings));
		return id;
	}

	/** The composer painted the current prediction; its first painted frame counts it as shown. */
	shown(): void {
		const prediction = this.#prediction;
		if (!prediction || prediction.shownAt !== undefined || !this.#isCurrent(prediction.source)) return;
		prediction.shownAt = performance.now();
		recordPredictionShown(prediction.source.model, prediction.choices.length, this.#meterProvider);
	}

	/** The user inserted the alternative at `rank` (Tab or Right); the last insert before retirement counts. */
	accepted(rank: number): void {
		const prediction = this.#prediction;
		if (!prediction || !this.#isCurrent(prediction.source)) return;
		// Inserted before any frame painted it: outside the shown population the rate is taken over.
		if (prediction.rank === undefined && prediction.shownAt !== undefined) {
			prediction.acceptDelayMs = performance.now() - prediction.shownAt;
		}
		prediction.rank = rank;
	}

	/** Abort an in-flight prediction and retire the offered one; returns whether there was either. */
	cancel(): boolean {
		const pending = this.#pending;
		pending?.abort.abort();
		this.#pending = undefined;
		const prediction = this.#prediction;
		if (!prediction) return pending !== undefined;
		// Resolved on retirement, so an accepted prediction counts the alternative the user kept.
		const { source, choices, shownAt, rank, acceptDelayMs } = prediction;
		if (rank === undefined) {
			// Only a prediction the user saw can have been ignored.
			if (shownAt !== undefined) {
				recordPredictionResolved(
					{ result: "ignored" },
					source.model,
					choices.length,
					performance.now() - shownAt,
					this.#meterProvider,
				);
			}
		} else if (acceptDelayMs !== undefined) {
			recordPredictionResolved(
				{ result: "accepted", rank },
				source.model,
				choices.length,
				acceptDelayMs,
				this.#meterProvider,
			);
		}
		this.#prediction = undefined;
		this.#ctx.ui.requestRender();
		this.#onUpdate?.({ id: source.id, status: "retired" });
		return true;
	}

	async #run(source: PredictionSource, abort: AbortController, alternatives: boolean): Promise<void> {
		const startedAt = performance.now();
		const deadline = AbortSignal.timeout(this.#deadlineMs);
		let outcome: PredictionOutcome;
		let choices: string[] | undefined;
		try {
			const { replyText } = await source.session.runEphemeralTurn({
				promptText: prompt.render(composerPredictionPrompt, {
					skip: SKIP_REPLY,
					choices: alternatives ? MAX_PREDICTION_CHOICES : undefined,
				}),
				maxTokens: source.session.ephemeralMaxTokensPreservesRequest() ? PREDICTION_MAX_TOKENS : undefined,
				minimizeEffort: true,
				signal: AbortSignal.any([abort.signal, deadline]),
				onUsage: message => this.#recordUsage(source, message),
			});
			choices = parseReply(replyText, alternatives);
			outcome = this.#offer(source, abort, choices);
		} catch (error) {
			outcome = abort.signal.aborted ? "cancelled" : deadline.aborted ? "timeout" : "error";
			if (outcome === "error") logger.debug("Composer prediction failed", { error: String(error) });
		} finally {
			if (this.#pending?.abort === abort) this.#pending = undefined;
		}
		const offered = outcome === "offered" ? choices : undefined;
		recordPredictionRequest(
			outcome,
			source.model,
			performance.now() - startedAt,
			offered?.length,
			this.#meterProvider,
		);
		this.#onUpdate?.(
			offered ? { id: source.id, status: outcome, choices: offered } : { id: source.id, status: outcome },
		);
	}

	/** Offer settled alternatives as the composer prediction when it is still wanted; returns how it settled. */
	#offer(source: PredictionSource, abort: AbortController, choices: string[] | undefined): PredictionOutcome {
		if (this.#pending?.abort !== abort) return "cancelled";
		if (!this.#isCurrent(source)) return "stale";
		if (!choices) return "skipped";
		// Counted as shown by the composer's first frame that paints it (`shown()`), not here.
		this.#prediction = { choices, source, shownAt: undefined, acceptDelayMs: undefined, rank: undefined };
		this.#ctx.ui.requestRender();
		return "offered";
	}

	#recordUsage(source: PredictionSource, message: AssistantMessage): void {
		try {
			source.session.sessionManager.appendModelUsage(
				{
					purpose: USAGE_PURPOSE,
					api: message.api,
					provider: message.provider,
					model: message.model,
					usage: message.usage,
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
				},
				{ sessionId: source.sessionId, parentId: source.leafId },
			);
		} catch (error) {
			logger.debug("Failed to persist composer prediction usage", { error: String(error) });
		}
	}

	#isCurrent(source: PredictionSource): boolean {
		return this.#ctx.viewSession === source.session && predictionAnchor(source.session) === source.lastMessage;
	}
}
