import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, StopReason } from "@oh-my-pi/pi-ai";
import { logger, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import composerPredictionPrompt from "../../prompts/system/composer-prediction-user.md" with { type: "text" };
import type { AgentSession } from "../../session/agent-session";
import type { SessionEntry } from "../../session/session-entries";
import {
	cfgComposerPredictionsOnResume,
	cfgComposerPredictionTimeoutSeconds,
	cfgComposerPredictions,
} from "../settings";
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
/** Bounds on `composer.predictionTimeoutSeconds`: a prediction needs a few seconds, and past two minutes the user has moved on. */
const MIN_PREDICTION_TIMEOUT_SECONDS = 5;
const MAX_PREDICTION_TIMEOUT_SECONDS = 120;
/** Usage-ledger purpose, so session totals and `/stats` include prediction requests. */
const USAGE_PURPOSE = "composer-prediction";
/** Whether the user can follow up on a turn that ended this way; errors, interrupts, and pending tool calls cannot. */
const FOLLOWS_UP: Record<StopReason, boolean> = {
	stop: true,
	length: true,
	toolUse: false,
	error: false,
	aborted: false,
};
/**
 * Whether a journal entry changes the conversation a prediction reads. Exhaustive, so a new entry
 * type must be classified here; neutral ones (bookkeeping and request settings) keep a hidden
 * prediction reusable on catch-up.
 */
const REWRITES_CONVERSATION: Record<SessionEntry["type"], boolean> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	reset_boundary: true,
	ttsr_injection: true,
	mode_change: true,
	session_init: true,
	model_usage: false,
	label: false,
	title_change: false,
	custom: false,
	credential_pin: false,
	model_change: false,
	thinking_level_change: false,
	service_tier_change: false,
};
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

/** A conversation point whose prediction came back; `text` is `undefined` when the model skipped. */
interface SettledPrediction {
	text: string | undefined;
	source: PredictionSource;
}

type PredictionContext = Pick<
	InteractiveModeContext,
	"settings" | "viewSession" | "focusedAgentId" | "collabGuest" | "editor" | "ui"
>;

/**
 * Deadline for one prediction from `composer.predictionTimeoutSeconds`, clamped so a zero,
 * negative, or runaway value can neither abort every request at once nor keep paying for a reply
 * nobody waits for.
 */
export function composerPredictionDeadlineMs(seconds: number): number {
	const bounded = Number.isFinite(seconds) ? seconds : MIN_PREDICTION_TIMEOUT_SECONDS;
	return Math.max(MIN_PREDICTION_TIMEOUT_SECONDS, Math.min(MAX_PREDICTION_TIMEOUT_SECONDS, bounded)) * 1000;
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
 * Opening a finished conversation ({@link catchUp}) offers the same prediction
 * for it, requesting one only when that conversation point has none yet.
 */
export class ComposerPredictionController {
	readonly #ctx: PredictionContext;
	readonly #deadlineMs: number | undefined;
	#pending: { abort: AbortController; source: PredictionSource } | undefined;
	#settled: SettledPrediction | undefined;
	/** {@link cancel} hides the settled prediction; {@link catchUp} may show it again. */
	#hidden = false;

	/** `deadlineMs` overrides `composer.predictionTimeoutSeconds`. */
	constructor(ctx: PredictionContext, options: { deadlineMs?: number } = {}) {
		this.#ctx = ctx;
		this.#deadlineMs = options.deadlineMs;
	}

	/** The prediction for the conversation as it stands now, if one is ready. */
	get text(): string | undefined {
		const settled = this.#settled;
		if (!settled?.text || this.#hidden || !this.#isCurrent(settled.source)) return undefined;
		return settled.text;
	}

	/** Predict the next message for the turn that just completed, superseding any earlier prediction. */
	request(): void {
		this.cancel();
		if (!cfgComposerPredictions.get(this.#ctx.settings)) return;
		// A focused subagent's "user" is the parent agent, not the person at the composer.
		if (this.#ctx.focusedAgentId !== undefined) return;
		// A read-only collab guest cannot send what it would accept.
		if (this.#ctx.collabGuest?.readOnly) return;
		const session = this.#ctx.viewSession;
		// Any draft, even whitespace, keeps the ghost hidden (it shows only over a prefix of the
		// prediction), and a compaction would rewrite the history the prediction reads: skip the
		// billed request either way.
		if (!session.model || session.isStreaming || session.isCompacting || this.#ctx.editor.getText()) return;
		const source: PredictionSource = {
			session,
			lastMessage: session.messages.at(-1),
			// The journal id: after `/fresh` or with an SDK provider id, `session.sessionId` is the
			// provider-facing id, which the usage ledger rejects.
			sessionId: session.sessionManager.getSessionId(),
			leafId: session.sessionManager.getLeafId(),
		};
		const pending = { abort: new AbortController(), source };
		this.#pending = pending;
		void this.#run(pending);
	}

	/**
	 * Offer a prediction for a conversation the user just opened (startup resume, `/resume`,
	 * returning from a subagent) when its last turn finished. A conversation point that already
	 * has a prediction, or one on the way, is not requested again.
	 */
	catchUp(): void {
		const pending = this.#pending;
		if (pending && !this.#isCurrent(pending.source)) {
			pending.abort.abort();
			this.#pending = undefined;
		}
		const settings = this.#ctx.settings;
		if (!cfgComposerPredictions.get(settings) || !cfgComposerPredictionsOnResume.get(settings)) return;
		const last = this.#ctx.viewSession.messages.at(-1);
		if (last?.role !== "assistant" || !FOLLOWS_UP[last.stopReason]) return;
		if (this.#pending) return;
		const settled = this.#settled;
		if (settled && this.#isCurrent(settled.source)) {
			if (!this.#hidden) return;
			this.#hidden = false;
			if (settled.text) this.#ctx.ui.requestRender();
			return;
		}
		this.request();
	}

	/**
	 * Abort the in-flight prediction for the conversation on screen and hide the shown one. Turn
	 * starts and resets in another conversation (a focused subagent's) leave the main session's
	 * request running: its result is kept for {@link catchUp}.
	 */
	cancel(): void {
		if (this.#pending?.source.session === this.#ctx.viewSession) {
			this.#pending.abort.abort();
			this.#pending = undefined;
		}
		this.hide();
	}

	/** Hide the shown prediction while the view moves to another conversation; nothing is aborted. */
	hide(): void {
		if (this.#hidden) return;
		this.#hidden = true;
		if (this.#settled?.text) this.#ctx.ui.requestRender();
	}

	/** Abort any in-flight prediction, whichever conversation is on screen. */
	dispose(): void {
		this.#pending?.abort.abort();
		this.#pending = undefined;
		this.hide();
	}

	async #run(pending: { abort: AbortController; source: PredictionSource }): Promise<void> {
		const { abort, source } = pending;
		const deadlineMs =
			this.#deadlineMs ?? composerPredictionDeadlineMs(cfgComposerPredictionTimeoutSeconds.get(this.#ctx.settings));
		// The view can be on a subagent, whose events never reach this session's cancel(): a turn or
		// compaction starting in the prediction's own session makes it obsolete, so stop paying for it.
		const unsubscribe = source.session.subscribe(event => {
			if (event.type === "agent_start" || event.type === "auto_compaction_start") abort.abort();
		});
		try {
			const { replyText, assistantMessage } = await source.session.runEphemeralTurn({
				promptText: prompt.render(composerPredictionPrompt, { skip: SKIP_REPLY }),
				maxTokens: source.session.ephemeralMaxTokensPreservesRequest() ? PREDICTION_MAX_TOKENS : undefined,
				minimizeEffort: true,
				signal: AbortSignal.any([abort.signal, AbortSignal.timeout(deadlineMs)]),
			});
			// Paid for even when the reply arrives too late to show.
			this.#recordUsage(source, assistantMessage);
			if (this.#pending !== pending || !this.#isAtPoint(source)) return;
			const text = parseComposerPrediction(replyText);
			this.#settled = { text, source };
			// Finished while a subagent was on screen: kept hidden until catch-up shows it.
			this.#hidden = this.#ctx.viewSession !== source.session;
			if (text && !this.#hidden) this.#ctx.ui.requestRender();
		} catch (error) {
			if (!abort.signal.aborted) logger.debug("Composer prediction failed", { error: String(error) });
		} finally {
			unsubscribe();
			if (this.#pending === pending) this.#pending = undefined;
		}
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
				},
				{ sessionId: source.sessionId, parentId: source.leafId },
			);
		} catch (error) {
			logger.debug("Failed to persist composer prediction usage", { error: String(error) });
		}
	}

	#isCurrent(source: PredictionSource): boolean {
		return this.#ctx.viewSession === source.session && this.#isAtPoint(source);
	}

	/** Whether the prediction's own conversation still ends where it was made, whichever is on screen. */
	#isAtPoint(source: PredictionSource): boolean {
		if (!this.#isUnchanged(source)) return false;
		const last = source.session.messages.at(-1);
		if (last === source.lastMessage) return true;
		// Reloading the open session (`/resume` of itself) rebuilds every message object; the point
		// is still current when the journal leaf is the same and the tail kept its role and timestamp.
		return (
			last !== undefined && last.role === source.lastMessage?.role && last.timestamp === source.lastMessage.timestamp
		);
	}

	/**
	 * Whether the journal still ends where the prediction branched. A compaction, branch summary,
	 * or `/tree` move appends or switches entries, so a hidden prediction for the old history is
	 * not offered again on catch-up even when the tail message survives the rewrite. Entries that
	 * leave the conversation as it was (usage, labels, titles, model switches) are skipped.
	 */
	#isUnchanged(source: PredictionSource): boolean {
		const sessionManager = source.session.sessionManager;
		if (sessionManager.getSessionId() !== source.sessionId) return false;
		let entry = sessionManager.getLeafEntry();
		while (entry && entry.id !== source.leafId && !REWRITES_CONVERSATION[entry.type]) {
			entry = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined;
		}
		return (entry?.id ?? null) === source.leafId;
	}
}
