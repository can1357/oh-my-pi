/**
 * Contract: the turn conveyor. It reads one session's event stream and renders
 * it into the topic — reactions on the human messages (👀 queued, 👨‍💻 working,
 * 👌 done, 🫡 stopped, 💔 died), the ⚡ icon around a running turn, the streamed
 * answer, the tool card with retry/compaction notices and the todo plan, the
 * context share on settle, and terminal-only ends. Prompts typed in the
 * terminal of an attached session are echoed as quotes.
 */
import { describe, expect, it } from "bun:test";
import { TURN_STOP_CALLBACK } from "@oh-my-pi/pi-coding-agent/telegram/turn-card";
import { createTurnConveyor } from "@oh-my-pi/pi-coding-agent/telegram/turn-conveyor";
import type { TelegramInlineKeyboardMarkup, TelegramSticker } from "@oh-my-pi/pi-coding-agent/telegram/types";
import { drain, fakeApi, fakeClock, fakeDelivery, fakeTurnSource, type FakeDelivery } from "./slice-d-fakes";

const STICKERS: TelegramSticker[] = [
	{ file_id: "f1", emoji: "🙂", custom_emoji_id: "icon-smile" },
	{ file_id: "f2", emoji: "⚡️", custom_emoji_id: "icon-bolt" },
];

function conveyor(options: { chatId?: number; echo?: boolean; percent?: number } = {}) {
	const api = fakeApi();
	const api_ = api;
	api.getForumTopicIconStickers = async () => {
		api_.calls.push({ method: "getForumTopicIconStickers", fields: {} });
		return STICKERS;
	};
	const deliver = fakeDelivery();
	const clock = fakeClock();
	const turn = fakeTurnSource(options.percent);
	const lifecycle: string[] = [];
	const subject = createTurnConveyor({
		source: turn.source,
		api,
		delivery: deliver,
		chatId: options.chatId ?? 555,
		threadId: 7,
		clock,
		echoLocalPrompts: options.echo,
		onTurnStart: () => lifecycle.push("start"),
		onTurnEnd: () => lifecycle.push("end"),
	});
	const reactions = () =>
		api.of("setMessageReaction").map(call => ({
			messageId: call.fields.messageId as number,
			emoji: (call.fields.reaction as { emoji: string }[])[0].emoji,
		}));
	const icons = () => api.of("editForumTopic").map(call => call.fields.iconCustomEmojiId);
	const edits = () => deliver.of("edit").map(call => call.fields);
	const sends = () => deliver.of("send").map(call => call.fields);
	/** Lets the card republish immediately instead of waiting out its throttle. */
	const beat = () => clock.advance(2_100);
	const markdown = () => [...sends(), ...edits()].at(-1)?.markdown;
	return { api, deliver, clock, turn, subject, lifecycle, reactions, icons, edits, sends, beat, markdown };
}

const toolStart = (callId: string, toolName: string, args: object = {}) => ({
	type: "tool_execution_start",
	toolCallId: callId,
	toolName,
	args,
});

/** Card messages that carried the Stop keyboard, and which of them still hold one. */
function stopKeyboards(deliver: FakeDelivery): { cards: number[]; orphans: number[] } {
	const live = new Map<number, boolean>();
	for (const call of deliver.calls) {
		const id = call.ids?.[0] ?? (typeof call.fields.messageId === "number" ? call.fields.messageId : null);
		if (id === null) continue;
		const markup = call.fields.replyMarkup as TelegramInlineKeyboardMarkup | undefined;
		const stop =
			markup !== undefined &&
			markup.inlineKeyboard.some(row => row.some(button => button.callbackData === TURN_STOP_CALLBACK));
		if (stop || live.has(id)) live.set(id, stop);
	}
	const cards = [...live.keys()];
	return { cards, orphans: cards.filter(id => live.get(id) === true) };
}

describe("turn conveyor", () => {
	it("ends a message queued while the turn ran on 👌 with the turn", async () => {
		const { subject, turn, reactions } = conveyor();
		subject.seen(11);
		await turn.emit({ type: "agent_start" });
		// The production order (topic session `say`): register the message the turn
		// answers, then paint the eyes on the running turn's queue.
		subject.seen(12);
		await subject.queued(12);
		await turn.emit({ type: "agent_end", isTerminal: true });
		expect(reactions()).toEqual([
			{ messageId: 11, emoji: "👨‍💻" },
			{ messageId: 12, emoji: "👀" },
			{ messageId: 11, emoji: "👌" },
			{ messageId: 12, emoji: "👌" },
		]);
	});

	it("reuses one card across a non-terminal end and leaves no live Stop keyboard", async () => {
		const { subject, deliver, turn, beat, lifecycle, reactions } = conveyor();
		subject.seen(50);
		await turn.emit({ type: "agent_start" });
		await turn.emit(toolStart("c1", "bash", { command: "ls" }));
		// A non-terminal end is a scheduling pause — queued follow-up, retry or
		// compaction continuation — not the end of the turn.
		await turn.emit({ type: "agent_end", isTerminal: false });
		subject.seen(51);
		await subject.queued(51);
		await turn.emit({ type: "agent_start" });
		beat();
		await turn.emit(toolStart("c2", "read", { file_path: "a.mjs" }));
		await turn.emit({ type: "agent_end", isTerminal: true });
		const keyboards = stopKeyboards(deliver);
		expect(keyboards.orphans).toEqual([]);
		expect(keyboards.cards).toHaveLength(1);
		expect(lifecycle).toEqual(["start", "end"]);
		// The single card carries both steps of the logical turn, and both human
		// messages end on 👌.
		expect(String(deliver.of("edit").at(-1)?.fields.markdown)).toContain("Steps (2)");
		expect(reactions().filter(reaction => reaction.emoji === "👌")).toEqual([
			{ messageId: 50, emoji: "👌" },
			{ messageId: 51, emoji: "👌" },
		]);
		// The next prompt after the settle opens a fresh turn on its own message.
		subject.seen(52);
		await turn.emit({ type: "agent_start" });
		expect(reactions().at(-1)).toEqual({ messageId: 52, emoji: "👨‍💻" });
	});

	it("shows the ⚡ icon for a private chat only, around the running turn", async () => {
		const priv = conveyor();
		priv.subject.seen(31);
		await priv.turn.emit({ type: "agent_start" });
		expect(priv.icons()).toEqual(["icon-bolt"]);
		await priv.turn.emit({ type: "agent_end", isTerminal: true });
		expect(priv.icons()).toEqual(["icon-bolt", ""]);

		const group = conveyor({ chatId: -100_500 });
		group.subject.seen(31);
		await group.turn.emit({ type: "agent_start" });
		await group.turn.emit({ type: "agent_end", isTerminal: true });
		expect(group.api.of("editForumTopic")).toHaveLength(0);
		expect(group.api.of("getForumTopicIconStickers")).toHaveLength(0);
	});

	it("settles a halted turn as stopped: 🫡 once, ⏹ card, no 👌", async () => {
		const { subject, turn, reactions, edits, beat, api, markdown } = conveyor();
		subject.seen(21);
		await turn.emit({ type: "agent_start" });
		beat();
		await turn.emit(toolStart("c1", "bash", { command: "sleep 100" }));
		await subject.halt();
		expect(reactions().at(-1)).toEqual({ messageId: 21, emoji: "🫡" });
		await turn.emit({ type: "agent_end", isTerminal: true });
		expect(String(markdown())).toContain("**⏹ Stopped**");
		expect(edits().at(-1)?.replyMarkup).toEqual({ inlineKeyboard: [] });
		expect(reactions().at(-1)).toEqual({ messageId: 21, emoji: "🫡" });
		expect(api.of("editForumTopic").at(-1)?.fields.iconCustomEmojiId).toBe("");
	});

	it("finishes a disposed turn as stopped with 🫡", async () => {
		const { subject, turn, reactions, edits, beat, markdown } = conveyor();
		subject.seen(22);
		await turn.emit({ type: "agent_start" });
		beat();
		await turn.emit(toolStart("c1", "bash", { command: "sleep 100" }));
		await subject.dispose();
		expect(String(markdown())).toContain("**⏹ Stopped**");
		expect(edits().at(-1)?.replyMarkup).toEqual({ inlineKeyboard: [] });
		expect(reactions().at(-1)).toEqual({ messageId: 22, emoji: "🫡" });
	});

	it("marks a failed turn failed and reacts 💔 on its last message", async () => {
		const { subject, turn, reactions, markdown, beat } = conveyor();
		subject.seen(41);
		await turn.emit({ type: "agent_start" });
		beat();
		await turn.emit(toolStart("c1", "bash", { command: "ls" }));
		await subject.fail("dispatch failed");
		expect(reactions().at(-1)).toEqual({ messageId: 41, emoji: "💔" });
		expect(String(markdown())).toContain("**⚠️ Failed: dispatch failed**");
	});

	it("leaves a non-terminal agent_end running", async () => {
		const { subject, turn, reactions } = conveyor();
		subject.seen(71);
		await turn.emit({ type: "agent_start" });
		await turn.emit({ type: "agent_end", isTerminal: false });
		expect(subject.active()).toBe(true);
		expect(reactions().at(-1)).toEqual({ messageId: 71, emoji: "👨‍💻" });
	});

	it("puts retry and compaction notices on the card", async () => {
		const { subject, turn, markdown, beat } = conveyor();
		subject.seen(51);
		await turn.emit({ type: "agent_start" });
		beat();
		await turn.emit(toolStart("c1", "read", { file_path: "a.mjs" }));
		beat();
		await turn.emit({ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 3000, errorMessage: "502" });
		beat();
		await turn.emit({ type: "auto_compaction_start", reason: "overflow", action: "context-full" });
		await turn.emit({ type: "agent_end", isTerminal: true });
		const text = String(markdown());
		expect(text).toContain("🔁 Retry · attempt 2 of 5 · 502");
		expect(text).toContain("🗜️ Compacting context · overflow");
	});

	it("renders todo phases from a tool result as the card's plan", async () => {
		const { subject, turn, markdown } = conveyor();
		subject.seen(61);
		await turn.emit({ type: "agent_start" });
		await turn.emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "todo",
			result: { details: { phases: [{ name: "Work", tasks: [{ content: "First", status: "completed" }] }] } },
		});
		await turn.emit({ type: "agent_end", isTerminal: true });
		expect(String(markdown())).toContain("- [x] First");
	});

	it("reports the session's context share when the turn settles", async () => {
		const { subject, turn, markdown, beat } = conveyor({ percent: 12.5 });
		subject.seen(81);
		await turn.emit({ type: "agent_start" });
		beat();
		await turn.emit(toolStart("c1", "read", { file_path: "a.mjs" }));
		await turn.emit({ type: "agent_end", isTerminal: true });
		expect(String(markdown())).toContain("context 12.5%");
	});

	it("settles an undispatched prompt without opening a card", async () => {
		const { subject, lifecycle, reactions, deliver, turn } = conveyor();
		subject.seen(91);
		await subject.settleUndispatched();
		expect(reactions()).toEqual([{ messageId: 91, emoji: "👌" }]);
		expect(lifecycle).toEqual(["end"]);
		expect(deliver.of("send")).toHaveLength(0);
		expect(subject.active()).toBe(false);
		await turn.emit({ type: "agent_end", isTerminal: true });
		expect(reactions()).toHaveLength(1);
	});

	it("announces the turn's lifecycle to the host exactly once per turn", async () => {
		const { subject, turn, lifecycle } = conveyor();
		subject.seen(95);
		await turn.emit({ type: "agent_start" });
		expect(lifecycle).toEqual(["start"]);
		await turn.emit({ type: "agent_end", isTerminal: true });
		expect(lifecycle).toEqual(["start", "end"]);
	});

	it("echoes terminal prompts as quotes only for an attached session", async () => {
		const echoed = conveyor({ echo: true });
		await echoed.turn.emit({ type: "message_end", message: { role: "user", content: "hello from the terminal" } });
		expect(String(echoed.sends().at(-1)?.markdown)).toBe("> 👤 **Terminal:** hello from the terminal");

		const quiet = conveyor();
		await quiet.turn.emit({ type: "message_end", message: { role: "user", content: "hello from the terminal" } });
		expect(quiet.sends()).toHaveLength(0);
	});

	it("stops rendering once disposed", async () => {
		const { subject, turn, reactions, api } = conveyor();
		subject.seen(97);
		await turn.emit({ type: "agent_start" });
		const before = reactions().length;
		await subject.dispose();
		const after = reactions().length;
		await subject.dispose();
		await turn.emit({ type: "agent_start" });
		await turn.emit({ type: "agent_end", isTerminal: true });
		expect(reactions()).toHaveLength(after);
		expect(after).toBeGreaterThan(before);
		expect(subject.active()).toBe(false);
		expect(api.of("editForumTopic").at(-1)?.fields.iconCustomEmojiId).toBe("");
	});

	it("streams the answer into the topic", async () => {
		const { subject, turn, deliver, clock } = conveyor();
		subject.seen(99);
		await turn.emit({ type: "agent_start" });
		await turn.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
		clock.advance(2_100);
		await turn.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } });
		await turn.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello world" }],
				usage: { totalTokens: 12, cost: { total: 0.002 } },
			},
		});
		await turn.emit({ type: "agent_end", isTerminal: true });
		await drain();
		const drafts = deliver.of("draft").map(call => call.fields.markdown);
		expect(drafts).toContain("hello world");
		expect(deliver.of("send").map(call => call.fields.markdown)).toContain("hello world");
	});
});
