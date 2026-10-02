/**
 * One topic's turn conveyor: the bridge's single reader of a session's event
 * stream.
 *
 * It subscribes to the session on creation and folds events into reactions on
 * the human messages (👀 queued, 👨‍💻 working, 👌 done, 🫡 stopped, 💔 died), the
 * ⚡ topic icon, the streamed answer and the tool-step card. Only a terminal
 * `agent_end` settles the turn; a non-terminal one is a scheduling pause, and
 * the `agent_start` that follows resumes the same card. Events arrive
 * synchronously while rendering awaits Telegram, so every event is serialized
 * onto one chain; the public control methods (`seen`, `queued`, `halt`, `fail`)
 * only mutate the small state the renderer reads.
 *
 * Callers register every message a turn answers with `seen()` — including the
 * ones they then paint with `queued()` — so the message ends on the turn's
 * final reaction.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { normalizeEvent, type TurnStep } from "./events";
import { createTurnWriter, type TurnWriter } from "./stream";
import { createTurnIcon, type TurnIcon } from "./turn-icon";
import { errorText, speakerQuote } from "./text";
import type { Clock, TurnConveyor, TurnConveyorDeps } from "./types";

const REACTIONS = { queued: "👀", working: "👨‍💻", done: "👌", stopped: "🫡", died: "💔" } as const;

/** Card line describing a retry or compaction step, or null when it needs none. */
function noticeOf(step: TurnStep): { icon: string; label: string } | null {
	if (step.kind === "retry") {
		const attempt =
			step.attempt === null
				? ""
				: `attempt ${step.attempt}${step.maxAttempts === null ? "" : ` of ${step.maxAttempts}`}`;
		return { icon: "🔁", label: ["Retry", attempt, step.message].filter(part => part !== "").join(" · ") };
	}
	if (step.kind === "retryEnd") return step.ok ? null : { icon: "🔁", label: "Retry failed" };
	if (step.kind === "compaction") {
		return { icon: "🗜️", label: step.reason === "" ? "Compacting context" : `Compacting context · ${step.reason}` };
	}
	if (step.kind === "compactionEnd") {
		const how = step.aborted ? "aborted" : step.ok ? "done" : "failed";
		return { icon: "🗜️", label: `Compacting context · ${how}` };
	}
	return null;
}

export function createTurnConveyor(deps: TurnConveyorDeps): TurnConveyor {
	const { api, delivery, chatId, threadId } = deps;
	const clock: Clock = deps.clock ?? { now: Date.now };
	const echoLocalPrompts = deps.echoLocalPrompts === true;
	const icon: TurnIcon = createTurnIcon({ api, chatId });
	let writer: TurnWriter | null = null;
	let turnIds: number[] = [];
	let lastMessageId: number | null = null;
	let halted = false;
	let disposed = false;
	let chain: Promise<void> = Promise.resolve();

	const serial = (run: () => Promise<void>): Promise<void> => {
		const next = chain.then(run, run).catch(error => {
			logger.warn("telegram: conveyor render failed", { threadId, error: errorText(error) });
		});
		chain = next;
		return next;
	};

	async function react(messageId: number | null, emoji: string): Promise<void> {
		if (messageId === null) return;
		try {
			await api.setMessageReaction({ chatId, messageId, reaction: [{ type: "emoji", emoji }] });
		} catch (error) {
			logger.debug("telegram: reaction failed", { threadId, messageId, emoji, error: errorText(error) });
		}
	}

	async function reactAll(ids: readonly number[], emoji: string): Promise<void> {
		await Promise.all(ids.map(id => react(id, emoji)));
	}

	/**
	 * Opens the turn's card — or resumes the one already on screen. A
	 * non-terminal `agent_end` followed by another `agent_start` is a scheduling
	 * pause (queued follow-up or steer drain, retry, compaction continuation), not
	 * a new turn, so the writer is reused: one card per logical turn, and no card
	 * is left behind holding a live ⏹ Stop button.
	 */
	async function begin(): Promise<void> {
		if (disposed) return;
		halted = false;
		if (writer === null) {
			deps.onTurnStart?.();
			const next = createTurnWriter({ api, delivery, chatId, threadId, clock });
			writer = next;
			await next.start();
		}
		if (turnIds.length === 0 && lastMessageId !== null) turnIds.push(lastMessageId);
		await reactAll(turnIds, REACTIONS.working);
		await icon.set(threadId, true);
	}

	async function settle(): Promise<void> {
		if (disposed) return;
		const current = writer;
		const ids = turnIds;
		const stopped = halted;
		writer = null;
		turnIds = [];
		halted = false;
		const contextPercent = deps.source.getContextUsage()?.percent ?? null;
		await icon.set(threadId, false);
		if (current !== null) await current.finish({ status: stopped ? "stopped" : "done", contextPercent });
		if (!stopped) await reactAll(ids, REACTIONS.done);
		deps.onTurnEnd?.();
	}

	async function quote(text: string): Promise<void> {
		const body = text.trim();
		if (body === "") return;
		try {
			await delivery.send({ chatId, threadId, markdown: speakerQuote("Terminal", body) });
		} catch (error) {
			logger.warn("telegram: prompt echo failed", { threadId, error: errorText(error) });
		}
	}

	async function apply(step: TurnStep): Promise<void> {
		if (step.kind === "start") return begin();
		if (step.kind === "end") {
			if (step.terminal) await settle();
			return;
		}
		if (step.kind === "userPrompt") {
			if (echoLocalPrompts) await quote(step.text);
			return;
		}
		const current = writer;
		if (current === null) return;
		if (step.kind === "thinking") return current.think(step.text);
		if (step.kind === "text") return current.say(step.text);
		if (step.kind === "final") {
			current.usage(step.usage);
			if (step.text !== "") await current.end(step.text);
			return;
		}
		if (step.kind === "tool") return current.tool(step);
		if (step.kind === "toolEnd") {
			if (step.plan !== null) await current.plan(step.plan);
			await current.toolEnd({ callId: step.callId, ok: step.ok });
			return;
		}
		const line = noticeOf(step);
		if (line !== null) await current.notice(line);
	}

	const unsubscribe = deps.source.subscribe(event => {
		void serial(() => apply(normalizeEvent(event)));
	});

	return {
		seen(messageId) {
			lastMessageId = messageId;
			if (!turnIds.includes(messageId)) turnIds.push(messageId);
		},
		async queued(messageId) {
			await react(messageId, REACTIONS.queued);
		},
		async halt() {
			halted = true;
			const ids = turnIds.length > 0 ? turnIds : lastMessageId === null ? [] : [lastMessageId];
			await reactAll(ids, REACTIONS.stopped);
		},
		async fail(reason) {
			if (disposed) return;
			const current = writer;
			const ids = turnIds;
			writer = null;
			turnIds = [];
			halted = false;
			await icon.set(threadId, false);
			if (current !== null) await current.finish({ status: "failed", error: reason });
			await react(ids.at(-1) ?? lastMessageId, REACTIONS.died);
			deps.onTurnEnd?.();
		},
		async settleUndispatched() {
			await serial(settle);
		},
		active: () => writer !== null,
		async dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			const current = writer;
			const ids = turnIds;
			writer = null;
			turnIds = [];
			halted = false;
			await icon.set(threadId, false);
			if (current !== null) await current.finish({ status: "stopped" });
			await reactAll(ids, REACTIONS.stopped);
		},
	};
}
