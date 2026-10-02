/**
 * The streamed answer of one turn.
 *
 * In a private chat the answer streams through Telegram's rich drafts (with a
 * thinking tail while the model only thinks) at most every two seconds; a
 * refused draft — or a group chat, where drafts do not exist — falls back to a
 * sent message that later deltas edit. The final assistant text replaces the
 * streamed message instead of posting a second one.
 *
 * An answer longer than one message streams in full: `delivery.edit` posts the
 * overflow once and edits those continuation messages in place on every later
 * tick, so a tick costs one edit per rendered chunk and never re-posts the tail.
 * Clipping here and continuing only at `end()` was rejected — the chunk limits
 * differ per rung (32768 in a rich message, 4096 in HTML) and the ladder picks
 * the rung at runtime, so a clip would have to guess the mode, truncate answers
 * that fit one rich message, and still could not guarantee a single chunk.
 *
 * Tool steps, the todo plan and retry/compaction notices live on the turn card
 * (`turn-card.ts`), not in the answer text.
 */
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { logger } from "@oh-my-pi/pi-utils";
import { errorText } from "./text";
import { createTurnCard, type CardFinish, type TurnCard, type TurnToolCall, type TurnToolEnd } from "./turn-card";
import type { Clock, TelegramApi, TelegramDelivery } from "./types";

const STREAM_EDIT_PAUSE_MS = 2_000;
const TYPING_PAUSE_MS = 4_000;
const THINKING_TAIL = 800;

export interface TurnWriter {
	start(): Promise<void>;
	think(chunk: string): Promise<void>;
	say(chunk: string): Promise<void>;
	tool(step: TurnToolCall): Promise<void>;
	toolEnd(step: TurnToolEnd): Promise<void>;
	plan(phases: readonly TodoPhase[] | null): Promise<void>;
	notice(line: { icon: string | null; label: string }): Promise<void>;
	usage(step: { tokens: number | null; cost: number | null } | null): void;
	end(finalText: string): Promise<void>;
	finish(options?: CardFinish): Promise<void>;
	isActive(): boolean;
}

export interface TurnWriterOptions {
	api: TelegramApi;
	delivery: TelegramDelivery;
	chatId: number;
	threadId: number;
	clock: Clock;
}

export function createTurnWriter(options: TurnWriterOptions): TurnWriter {
	const { api, delivery, chatId, threadId, clock } = options;
	const card: TurnCard = createTurnCard({ deliver: delivery, chatId, threadId, clock });
	let active = false;
	let messageOpen = false;
	let text = "";
	let thinking = "";
	let streamId: number | null = null;
	let draftId = 0;
	// Drafts exist in private chats only, and stop for good once Telegram refuses one.
	let drafts = chatId > 0;
	let lastTextAt: number | null = null;
	let lastTypingAt: number | null = null;

	/** Runs one Telegram call; false/absent results and refusals are logged, never thrown. */
	async function claim<T>(event: string, run: () => Promise<T>): Promise<T | null> {
		try {
			return await run();
		} catch (error) {
			logger.warn(`telegram: ${event}`, { threadId, error: errorText(error) });
			return null;
		}
	}

	async function typing(): Promise<void> {
		if (lastTypingAt !== null && clock.now() - lastTypingAt < TYPING_PAUSE_MS) return;
		lastTypingAt = clock.now();
		await claim("stream.typing", () => api.sendChatAction({ chatId, threadId, action: "typing" }));
	}

	async function pushDraft(markdown: string, thinkingText: string | null): Promise<boolean> {
		if (!drafts) return false;
		const sent = await claim("stream.draft", () =>
			delivery.draft({ chatId, threadId, draftId, markdown, thinking: thinkingText, canStop: true }),
		);
		if (sent === true) return true;
		drafts = false;
		logger.debug("telegram: streaming drafts disabled", { threadId });
		return false;
	}

	const due = (): boolean => lastTextAt === null || clock.now() - lastTextAt >= STREAM_EDIT_PAUSE_MS;

	async function pushText(): Promise<void> {
		if (await pushDraft(text, null)) return;
		if (streamId === null) {
			const ids = await claim("stream.send", () => delivery.send({ chatId, threadId, markdown: text }));
			streamId = ids?.[0] ?? null;
			if (streamId === null) logger.debug("telegram: streamed answer not placed", { threadId });
			return;
		}
		const id = streamId;
		await claim("stream.edit", () => delivery.edit({ chatId, threadId, messageId: id, markdown: text }));
	}

	return {
		async start() {
			active = true;
			messageOpen = true;
			text = "";
			thinking = "";
			streamId = null;
			draftId += 1;
			lastTextAt = null;
			card.begin();
			await typing();
		},
		async think(chunk) {
			if (!active || chunk === "") return;
			thinking += chunk;
			// Once the answer started, the thinking tail is no longer interesting.
			if (text !== "") return;
			await typing();
			if (!due()) return;
			lastTextAt = clock.now();
			await pushDraft("", thinking.length <= THINKING_TAIL ? thinking : thinking.slice(-THINKING_TAIL));
		},
		async say(chunk) {
			if (!active || chunk === "") return;
			if (!messageOpen) {
				messageOpen = true;
				text = "";
				streamId = null;
				draftId += 1;
				lastTextAt = null;
			}
			text += chunk;
			await typing();
			if (!due()) return;
			lastTextAt = clock.now();
			await pushText();
		},
		async tool(step) {
			if (active) await card.tool(step);
		},
		async toolEnd(step) {
			if (active) await card.toolEnd(step);
		},
		async plan(phases) {
			if (active) await card.setPlan(phases);
		},
		async notice(line) {
			if (active) await card.notice(line);
		},
		usage(step) {
			if (active) card.usage(step);
		},
		async end(finalText) {
			if (!active || !messageOpen) return;
			messageOpen = false;
			const markdown = finalText !== "" ? finalText : text;
			text = "";
			if (streamId === null) {
				await claim("stream.final", () => delivery.send({ chatId, threadId, markdown }));
				return;
			}
			const id = streamId;
			streamId = null;
			lastTextAt = null;
			// `delivery.edit` continues an over-long answer as further messages.
			await claim("stream.final.edit", () => delivery.edit({ chatId, threadId, messageId: id, markdown }));
		},
		async finish(finishOptions) {
			if (!active) return;
			active = false;
			await card.finish(finishOptions);
		},
		isActive: () => active,
	};
}
