import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { logger, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import composerPredictionPrompt from "../../prompts/system/composer-prediction-user.md" with { type: "text" };
import type { AgentSession } from "../../session/agent-session";
import { cfgComposerPredictions } from "../settings";
import type { InteractiveModeContext } from "../types";

/** Reply the prediction prompt asks for when the model has no confident guess. */
const SKIP_REPLY = "NO_PREDICTION";
/** Longer replies are rambling, not a message the user would type; drop them. */
const MAX_PREDICTION_LENGTH = 500;
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
/** Custom entry for a prediction reply: its text, or none when the model skipped or the parser rejected it. */
export const COMPOSER_PREDICTION_ENTRY_TYPE = "composer_prediction";
/** Custom entry, child of the prediction entry, for what the next submitted message did with it. */
export const COMPOSER_PREDICTION_OUTCOME_ENTRY_TYPE = "composer_prediction_outcome";

/** Data of a {@link COMPOSER_PREDICTION_ENTRY_TYPE} entry; its parent is the request's usage entry. */
export interface ComposerPredictionEntryData {
	/** Identifies the prediction prompt template, so results can be compared across prompt changes. */
	promptVersion: string;
	/** The ghost text offered; absent when the reply was a skip. */
	text?: string;
}

/**
 * What the next submitted message did with a ready prediction: `accepted` sent it as inserted by
 * Tab or Right, `edited` changed it after that insertion, `ignored` never inserted the shown ghost,
 * and `unseen` never painted it (the draft did not match).
 */
export type ComposerPredictionOutcome = "accepted" | "edited" | "ignored" | "unseen";

/** Data of a {@link COMPOSER_PREDICTION_OUTCOME_ENTRY_TYPE} entry. */
export interface ComposerPredictionOutcomeEntryData {
	outcome: ComposerPredictionOutcome;
}

/** Short digest of the prompt template; it changes whenever the template does. */
const PROMPT_VERSION = new Bun.CryptoHasher("sha256").update(composerPredictionPrompt).digest("hex").slice(0, 12);
/** One pair of double quotes or backticks around the whole reply. */
const WRAPPING_QUOTES = /^(?:"([^"]*)"|“([^“”]*)”|`([^`]*)`)$/;

/** The conversation point a prediction was made for: a new message or session invalidates it. */
interface PredictionSource {
	session: AgentSession;
	lastMessage: AgentMessage | undefined;
	/** Session file and entry the request branched from; its usage is recorded there. */
	sessionId: string;
	leafId: string | null;
}

type PredictionContext = Pick<InteractiveModeContext, "settings" | "viewSession" | "focusedAgentId" | "editor" | "ui">;

interface ReadyPrediction {
	text: string;
	source: PredictionSource;
	/** Journal entry recording it; outcomes are written beneath it. */
	entryId: string | undefined;
	shown: boolean;
	accepted: boolean;
	/** A run started: no longer offered, but still settled by the message that started it. */
	hidden: boolean;
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
 * Composer predictions: once a turn completes, run an ephemeral side turn on
 * the session's model and context (the same prompt prefix, so it reads the
 * prompt cache) asking for the user's likely next message, then offer it as
 * ghost text in the empty composer. Tab or Right inserts it; nothing is sent.
 */
export class ComposerPredictionController {
	readonly #ctx: PredictionContext;
	readonly #deadlineMs: number;
	#abort: AbortController | undefined;
	#prediction: ReadyPrediction | undefined;

	constructor(ctx: PredictionContext, options: { deadlineMs?: number } = {}) {
		this.#ctx = ctx;
		this.#deadlineMs = options.deadlineMs ?? PREDICTION_DEADLINE_MS;
	}

	/** The prediction for the conversation as it stands now, if one is ready. */
	get text(): string | undefined {
		const prediction = this.#prediction;
		if (!prediction || prediction.hidden || !this.#isCurrent(prediction.source)) return undefined;
		return prediction.text;
	}

	/** Predict the next message for the turn that just completed, superseding any earlier prediction. */
	request(): void {
		this.cancel();
		if (!cfgComposerPredictions.get(this.#ctx.settings)) return;
		// A focused subagent's "user" is the parent agent, not the person at the composer.
		if (this.#ctx.focusedAgentId !== undefined) return;
		const session = this.#ctx.viewSession;
		// Any draft, even whitespace, keeps the ghost hidden (it shows only over a prefix of the
		// prediction), and a compaction would rewrite the history the prediction reads: skip the
		// billed request either way.
		if (!session.model || session.isStreaming || session.isCompacting || this.#ctx.editor.getText()) return;
		const abort = new AbortController();
		this.#abort = abort;
		const source: PredictionSource = {
			session,
			lastMessage: session.messages.at(-1),
			// The journal id: after `/fresh` or with an SDK provider id, `session.sessionId` is the
			// provider-facing id, which the usage ledger rejects.
			sessionId: session.sessionManager.getSessionId(),
			leafId: session.sessionManager.getLeafId(),
		};
		void this.#run(source, abort);
	}

	/** Abort an in-flight prediction and clear the shown one. */
	cancel(): void {
		this.#abort?.abort();
		this.#abort = undefined;
		if (!this.#prediction) return;
		this.#prediction = undefined;
		this.#ctx.ui.requestRender();
	}

	/**
	 * A run is starting: abort an in-flight prediction and hide the shown one. Unlike {@link cancel},
	 * keep it for {@link settle}, because the run's input message arrives after the run starts.
	 */
	hide(): void {
		this.#abort?.abort();
		this.#abort = undefined;
		const prediction = this.#prediction;
		if (!prediction || prediction.hidden) return;
		prediction.hidden = true;
		this.#ctx.ui.requestRender();
	}

	/** The composer painted `text` as ghost text. */
	noteShown(text: string): void {
		const prediction = this.#readyFor(text);
		if (prediction) prediction.shown = true;
	}

	/** Tab or Right inserted `text` into the composer. */
	noteAccepted(text: string): void {
		const prediction = this.#readyFor(text);
		if (!prediction) return;
		prediction.shown = true;
		prediction.accepted = true;
	}

	/**
	 * Record what `message`, a user message just sent, did with the prediction offered for the
	 * conversation point it follows. Messages after any other point leave the prediction alone.
	 */
	settle(message: AgentMessage): void {
		const prediction = this.#prediction;
		if (!prediction || message.role !== "user" || message.synthetic || message.attribution === "agent") return;
		const { source } = prediction;
		if (this.#ctx.viewSession !== source.session) return;
		// The session may or may not hold the message yet when its start event arrives.
		const messages = source.session.messages;
		const index = messages.lastIndexOf(message);
		const previous = index >= 0 ? messages[index - 1] : messages.at(-1);
		if (previous !== source.lastMessage) return;
		this.#prediction = undefined;
		if (prediction.entryId === undefined) return;
		const sent = textContent(message.content).trim();
		const outcome: ComposerPredictionOutcome = prediction.accepted
			? sent === prediction.text
				? "accepted"
				: "edited"
			: prediction.shown
				? "ignored"
				: "unseen";
		this.#appendEntry(
			source,
			COMPOSER_PREDICTION_OUTCOME_ENTRY_TYPE,
			{ outcome } satisfies ComposerPredictionOutcomeEntryData,
			prediction.entryId,
		);
	}

	async #run(source: PredictionSource, abort: AbortController): Promise<void> {
		try {
			const { replyText, assistantMessage } = await source.session.runEphemeralTurn({
				promptText: prompt.render(composerPredictionPrompt, { skip: SKIP_REPLY }),
				maxTokens: source.session.ephemeralMaxTokensPreservesRequest() ? PREDICTION_MAX_TOKENS : undefined,
				minimizeEffort: true,
				signal: AbortSignal.any([abort.signal, AbortSignal.timeout(this.#deadlineMs)]),
			});
			// Paid for even when the reply arrives too late to show.
			const usageId = this.#recordUsage(source, assistantMessage);
			// A reply the composer can no longer offer was neither shown nor skipped: record only its usage.
			if (this.#abort !== abort || !this.#isCurrent(source)) return;
			const text = parseComposerPrediction(replyText);
			const data: ComposerPredictionEntryData = text
				? { promptVersion: PROMPT_VERSION, text }
				: { promptVersion: PROMPT_VERSION };
			const entryId = usageId && this.#appendEntry(source, COMPOSER_PREDICTION_ENTRY_TYPE, data, usageId);
			if (!text) return;
			this.#prediction = { text, source, entryId, shown: false, accepted: false, hidden: false };
			this.#ctx.ui.requestRender();
		} catch (error) {
			if (!abort.signal.aborted) logger.debug("Composer prediction failed", { error: String(error) });
		} finally {
			if (this.#abort === abort) this.#abort = undefined;
		}
	}

	#recordUsage(source: PredictionSource, message: AssistantMessage): string | undefined {
		try {
			return source.session.sessionManager.appendModelUsage(
				{
					purpose: USAGE_PURPOSE,
					api: message.api,
					provider: message.provider,
					model: message.model,
					usage: message.usage,
					stopReason: message.stopReason,
				},
				{ sessionId: source.sessionId, parentId: source.leafId },
			);
		} catch (error) {
			logger.debug("Failed to persist composer prediction usage", { error: String(error) });
			return undefined;
		}
	}

	#appendEntry(source: PredictionSource, customType: string, data: unknown, parentId: string): string | undefined {
		try {
			return source.session.sessionManager.appendCustomEntryOnBranch(customType, data, {
				sessionId: source.sessionId,
				parentId,
			});
		} catch (error) {
			logger.debug("Failed to persist composer prediction entry", { customType, error: String(error) });
			return undefined;
		}
	}

	/** The current prediction, when `text` is what it offers. */
	#readyFor(text: string): ReadyPrediction | undefined {
		const prediction = this.#prediction;
		return prediction && !prediction.hidden && prediction.text === text && this.#isCurrent(prediction.source)
			? prediction
			: undefined;
	}

	#isCurrent(source: PredictionSource): boolean {
		return this.#ctx.viewSession === source.session && source.session.messages.at(-1) === source.lastMessage;
	}
}
