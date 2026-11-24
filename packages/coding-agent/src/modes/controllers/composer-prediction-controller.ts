import { type AgentMessage, isExcludedFromContext } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { signal } from "@oh-my-pi/pi-tui";
import type { MeterProvider } from "@opentelemetry/api";
import { logger, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import composerPredictionPrompt from "../../prompts/system/composer-prediction-user.md" with { type: "text" };
import type { AgentViewSession } from "../../session/agent-session-handle";
import { completionRecord } from "../../session/model-usage-journal";
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
 * The message a prediction is keyed on: the last one that reaches the model and is not an advisor
 * card. Silent advisor notes and rows kept out of context (an extension's stats line sent with
 * `excludeFromContext`) land after the turn without changing what the user would reply to.
 */
function predictionAnchor(session: AgentViewSession): AgentMessage | undefined {
	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAdvisorCard(message) || isExcludedFromContext(message)) continue;
		return message;
	}
	return undefined;
}

/** The conversation point a prediction was made for: a new message or session invalidates it. */
interface PredictionSource {
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

type PredictionContext = Pick<InteractiveModeContext, "settings" | "viewSession" | "focusedAgentId" | "composer">;

export interface AutomaticPromptLimits {
	minutes: number;
	tokens: number;
	dollars: number;
	turns: number;
}

export interface AutomaticPromptStatus {
	turns: number;
	limits: AutomaticPromptLimits;
	elapsedMs: number;
	tokens: number;
	dollars: number;
}

interface AutomaticPromptRun {
	startedAt: number;
	startedTokens: number;
	startedDollars: number;
	limits: AutomaticPromptLimits;
	session: AgentViewSession;
	seen: Set<string>;
	turns: number;
}

function promptKey(text: string): string {
	return text.toLowerCase().replace(NON_WORD, " ").trim();
}

function userMessageText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join(" ");
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
	readonly #ctx: PredictionContext;
	readonly #deadlineMs: number;
	/** Metrics sink; the global provider when unset. */
	readonly #meterProvider: MeterProvider | undefined;
	#abort: AbortController | undefined;
	#automaticRun: AutomaticPromptRun | undefined;
	readonly #onAutomaticStop: ((reason: string) => void) | undefined;
	/** Reactive: the composer's ghost reads {@link choices}, so offering or retiring repaints it. */
	readonly #prediction = signal<Prediction | undefined>(undefined);

	constructor(
		ctx: PredictionContext,
		options: {
			deadlineMs?: number;
			meterProvider?: MeterProvider;
			onAutomaticStop?: (reason: string) => void;
		} = {},
	) {
		this.#ctx = ctx;
		this.#deadlineMs = options.deadlineMs ?? PREDICTION_DEADLINE_MS;
		this.#meterProvider = options.meterProvider;
		this.#onAutomaticStop = options.onAutomaticStop;
	}

	/** Start submitting predicted follow-ups, bounded by all four caller-selected limits. */
	startAutomatic(limits: AutomaticPromptLimits): void {
		if (this.#ctx.focusedAgentId !== undefined) throw new Error("Auto-prompt is available only in the main session");
		const session = this.#ctx.viewSession;
		const stats = session.getSessionStats();
		const seen = new Set(
			session.messages
				.map(userMessageText)
				.filter((text): text is string => text !== undefined)
				.map(promptKey)
				.filter(Boolean),
		);
		this.#automaticRun = {
			startedAt: Date.now(),
			startedTokens: stats.tokens.total,
			startedDollars: stats.cost,
			limits,
			session,
			seen,
			turns: 0,
		};
		this.request();
	}

	/** Current auto-prompt counters, if a bounded run is active. */
	getAutomaticStatus(): AutomaticPromptStatus | undefined {
		const run = this.#automaticRun;
		if (!run) return undefined;
		const stats = run.session.getSessionStats();
		return {
			turns: run.turns,
			limits: run.limits,
			elapsedMs: Date.now() - run.startedAt,
			tokens: Math.max(0, stats.tokens.total - run.startedTokens),
			dollars: Math.max(0, stats.cost - run.startedDollars),
		};
	}

	/** Stop automatic follow-ups without interrupting a turn already in progress. */
	stopAutomatic(): boolean {
		if (!this.#automaticRun) return false;
		this.#automaticRun = undefined;
		this.cancel();
		return true;
	}

	/** The prediction's alternatives for the conversation as it stands now, most likely first, if one is ready. */
	get choices(): readonly string[] | undefined {
		const prediction = this.#prediction();
		if (!prediction || !this.#isCurrent(prediction.source)) return undefined;
		return prediction.choices;
	}

	/** Predict the next message for the turn that just completed, superseding any earlier prediction. */
	request(): void {
		this.cancel();
		if (this.#automaticRun && this.#automaticRun.session !== this.#ctx.viewSession) {
			this.#stopAutomatic("the active session changed");
			return;
		}
		if (!cfgComposerPredictions.get(this.#ctx.settings) && !this.#automaticRun) return;
		// A focused subagent's "user" is the parent agent, not the person at the composer.
		if (this.#ctx.focusedAgentId !== undefined) return;
		const session = this.#ctx.viewSession;
		// Any draft, even whitespace, keeps the ghost hidden (it shows only over a prefix of the
		// prediction), and a compaction would rewrite the history the prediction reads: skip the
		// billed request either way.
		const model = session.model;
		if (this.#automaticRun) {
			const limitReason = this.#automaticLimitReason();
			if (limitReason) {
				this.#stopAutomatic(limitReason);
				return;
			}
		}
		if (this.#automaticRun && this.#ctx.composer.text()) {
			this.#stopAutomatic("a composer draft was entered");
			return;
		}
		if (!model) {
			if (this.#automaticRun) this.#stopAutomatic("the session has no model selected");
			return;
		}
		if (session.isStreaming || session.isCompacting) {
			if (this.#automaticRun) this.#stopAutomatic("the session is busy");
			return;
		}
		const abort = new AbortController();
		this.#abort = abort;
		const source: PredictionSource = {
			session,
			lastMessage: predictionAnchor(session),
			// The journal id: after `/fresh` or with an SDK provider id, `session.sessionId` is the
			// provider-facing id, which the usage ledger rejects.
			sessionId: session.sessionManager.getSessionId(),
			leafId: session.sessionManager.getLeafId(),
			model: `${model.provider}/${model.id}`,
		};
		void this.#run(source, abort, this.#automaticRun ? true : cfgComposerPredictionAlternatives.get(this.#ctx.settings));
	}

	/** The composer painted the current prediction; its first painted frame counts it as shown. */
	shown(): void {
		const prediction = this.#prediction.peek();
		if (!prediction || prediction.shownAt !== undefined || !this.#isCurrent(prediction.source)) return;
		prediction.shownAt = performance.now();
		recordPredictionShown(prediction.source.model, prediction.choices.length, this.#meterProvider);
	}

	/** The user inserted the alternative at `rank` (Tab or Right); the last insert before retirement counts. */
	accepted(rank: number): void {
		const prediction = this.#prediction.peek();
		if (!prediction || !this.#isCurrent(prediction.source)) return;
		// Inserted before any frame painted it: outside the shown population the rate is taken over.
		if (prediction.rank === undefined && prediction.shownAt !== undefined) {
			prediction.acceptDelayMs = performance.now() - prediction.shownAt;
		}
		prediction.rank = rank;
	}

	/** Abort an in-flight prediction and retire the shown one. */
	cancel(): void {
		this.#abort?.abort();
		this.#abort = undefined;
		const prediction = this.#prediction.peek();
		if (!prediction) return;
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
		this.#prediction.set(undefined);
	}

	async #run(source: PredictionSource, abort: AbortController, alternatives: boolean): Promise<void> {
		const startedAt = performance.now();
		const deadline = AbortSignal.timeout(this.#deadlineMs);
		let outcome: PredictionOutcome;
		let offered: number | undefined;
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
			const choices = parseReply(replyText, alternatives);
			if (this.#automaticRun) {
				outcome = await this.#submitAutomatic(source, abort, choices);
			} else {
				outcome = this.#offer(source, abort, choices);
			}
			if (outcome === "offered" || outcome === "submitted") offered = choices?.length;
		} catch (error) {
			outcome = abort.signal.aborted ? "cancelled" : deadline.aborted ? "timeout" : "error";
			if (outcome === "error") logger.debug("Composer prediction failed", { error: String(error) });
			if (this.#automaticRun && (outcome === "error" || outcome === "timeout")) {
				this.#stopAutomatic(outcome === "timeout" ? "the prediction request timed out" : "the prediction request failed");
			}
		} finally {
			if (this.#abort === abort) this.#abort = undefined;
		}
		recordPredictionRequest(outcome, source.model, performance.now() - startedAt, offered, this.#meterProvider);
	}

	async #submitAutomatic(
		source: PredictionSource,
		abort: AbortController,
		choices: string[] | undefined,
	): Promise<PredictionOutcome> {
		const run = this.#automaticRun;
		if (!run || run.session !== source.session || this.#abort !== abort) return "cancelled";
		if (!this.#isCurrent(source)) {
			this.#stopAutomatic("the conversation changed while a prediction was running");
			return "stale";
		}
		if (!choices?.length) {
			this.#stopAutomatic("DeepSeek had no useful next prompt (NO_PREDICTION or no usable reply).");
			return "skipped";
		}
		if (this.#ctx.composer.text()) {
			this.#stopAutomatic("a composer draft was entered");
			return "stale";
		}
		const limitReason = this.#automaticLimitReason();
		if (limitReason) {
			this.#stopAutomatic(limitReason);
			return "skipped";
		}
		const choice = choices.find(text => !run.seen.has(promptKey(text)));
		if (!choice) {
			this.#stopAutomatic("all suggested follow-ups repeated an earlier prompt");
			return "skipped";
		}
		if (source.session.isStreaming || source.session.isCompacting) {
			this.#stopAutomatic("the session became busy before the next prompt could be sent");
			return "cancelled";
		}
		run.seen.add(promptKey(choice));
		run.turns++;
		try {
			void source.session.prompt(choice).then(
				submitted => {
					if (!submitted) this.#stopAutomatic("the session did not accept the next prompt");
				},
				error => {
					logger.debug("Automatic prompt submission failed", { error: String(error) });
					this.#stopAutomatic("the next prompt could not be submitted");
				},
			);
			return "submitted";
		} catch (error) {
			logger.debug("Automatic prompt submission failed", { error: String(error) });
			this.#stopAutomatic("the next prompt could not be submitted");
			return "error";
		}
	}

	#stopAutomatic(reason: string): void {
		if (!this.#automaticRun) return;
		this.#automaticRun = undefined;
		this.cancel();
		this.#onAutomaticStop?.(reason);
	}

	#automaticLimitReason(): string | undefined {
		const run = this.#automaticRun;
		if (!run) return undefined;
		const status = this.getAutomaticStatus()!;
		if (status.elapsedMs >= run.limits.minutes * 60_000) return "time limit reached";
		if (status.tokens >= run.limits.tokens) return "token limit reached";
		if (status.dollars >= run.limits.dollars) return "spend limit reached";
		if (run.turns >= run.limits.turns) return "turn limit reached";
		return undefined;
	}

	/** Offer settled alternatives as the composer prediction when it is still wanted; returns how it settled. */
	#offer(source: PredictionSource, abort: AbortController, choices: string[] | undefined): PredictionOutcome {
		if (this.#abort !== abort) return "cancelled";
		if (!this.#isCurrent(source)) return "stale";
		if (!choices) return "skipped";
		// Counted as shown by the composer's first frame that paints it (`shown()`), not here.
		this.#prediction.set({ choices, source, shownAt: undefined, acceptDelayMs: undefined, rank: undefined });
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
					duration: message.duration,
					ttft: message.ttft,
					// The prompt is a static template, so only the reply is kept.
					completion: completionRecord(undefined, message),
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
