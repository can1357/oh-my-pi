/**
 * Contract: the streamed answer. While no text has arrived the draft carries a
 * bounded thinking tail with a stop button; once text arrives it replaces the
 * thinking; drafts refresh at most every two seconds; a refused draft (or a
 * group chat, where drafts do not exist) falls back to a sent message that is
 * edited in place; and the final assistant text replaces the streamed message.
 */
import { describe, expect, it } from "bun:test";
import { renderAssistantText } from "@oh-my-pi/pi-coding-agent/telegram/markdown";
import { createTurnWriter } from "@oh-my-pi/pi-coding-agent/telegram/stream";
import { bench } from "./deliver-fixtures";
import { fakeApi, fakeClock, fakeDelivery, type FakeDelivery } from "./slice-d-fakes";

function writer(options: { chatId?: number; drafts?: boolean; failDraft?: boolean } = {}) {
	const deliver = fakeDelivery({ drafts: options.drafts, failDraft: options.failDraft });
	const api = fakeApi();
	const clock = fakeClock();
	const turn = createTurnWriter({
		api,
		delivery: deliver,
		clock,
		chatId: options.chatId ?? 555,
		threadId: 7,
	});
	const drafts = () => deliver.of("draft").map(call => call.fields);
	const sends = () => deliver.of("send").map(call => call.fields);
	const edits = () => deliver.of("edit").map(call => call.fields);
	return { turn, deliver, api, clock, drafts, sends, edits };
}

const sentIds = (deliver: FakeDelivery) => deliver.of("send").map(call => call.ids?.[0]);

describe("turn writer", () => {
	it("streams a bounded thinking tail with a stop button while no text arrived", async () => {
		const { turn, drafts, clock } = writer();
		await turn.start();
		await turn.think("x".repeat(900));
		expect(drafts()).toHaveLength(1);
		expect(String(drafts()[0].thinking)).toHaveLength(800);
		expect(String(drafts()[0].thinking)).toBe("x".repeat(800));
		expect(drafts()[0].markdown).toBe("");
		expect(drafts()[0].canStop).toBe(true);
		clock.advance(2_000);
		await turn.think("-tail");
		expect(String(drafts()[1].thinking).endsWith("-tail")).toBe(true);
	});

	it("replaces the thinking tail with text and refreshes at most every two seconds", async () => {
		const { turn, drafts, clock } = writer();
		await turn.start();
		await turn.think("thinking");
		clock.advance(2_000);
		await turn.say("hello");
		expect(drafts().at(-1)?.markdown).toBe("hello");
		expect(drafts().at(-1)?.thinking).toBeNull();
		clock.advance(500);
		await turn.say(", world");
		expect(drafts().at(-1)?.markdown).toBe("hello");
		clock.advance(2_000);
		await turn.say("!");
		expect(drafts().at(-1)?.markdown).toBe("hello, world!");
	});

	it("sends an unpushed final answer as the agent's markdown", async () => {
		const { turn, sends, edits } = writer();
		await turn.start();
		await turn.say("partial");
		await turn.end("## Answer\n\n- item");
		expect(sends().map(fields => fields.markdown)).toEqual(["## Answer\n\n- item"]);
		expect(edits()).toHaveLength(0);
	});

	it("falls back to send+edit when drafts are unavailable", async () => {
		const { turn, deliver, drafts, sends, edits, clock } = writer({ chatId: -100_500 });
		await turn.start();
		await turn.say("a");
		expect(drafts()).toHaveLength(0);
		expect(sends().map(fields => fields.markdown)).toEqual(["a"]);
		clock.advance(2_100);
		await turn.say("b");
		expect(edits().map(fields => fields.markdown)).toEqual(["ab"]);
		expect(edits()[0].threadId).toBe(7);
		expect(deliver.of("send")).toHaveLength(1);
	});

	it("edits the streamed message in place when the final answer arrives", async () => {
		const { turn, deliver, edits, clock } = writer({ chatId: -100_500 });
		await turn.start();
		await turn.say("a");
		clock.advance(2_100);
		await turn.end("## Answer");
		const last = edits().at(-1);
		expect(last?.markdown).toBe("## Answer");
		expect(last?.threadId).toBe(7);
		expect(last?.messageId).toBe(sentIds(deliver)[0]);
	});

	it("keeps a long streamed answer's continuations in place instead of re-posting the tail", async () => {
		const b = bench({ withoutRich: true });
		const clock = fakeClock();
		const turn = createTurnWriter({ api: b.api, delivery: b.delivery, clock, chatId: -100_500, threadId: 7 });
		await turn.start();
		for (let tick = 0; tick < 4; tick += 1) {
			await turn.say("z".repeat(3_000));
			clock.advance(2_100);
		}
		await turn.end("");
		const chunks = renderAssistantText("z".repeat(12_000)).length;
		const posted = b.of("sendMessage");
		expect(chunks).toBeGreaterThan(1);
		// Every rendered chunk was posted exactly once; later ticks and the final answer edited those messages.
		expect(posted.length).toBe(chunks);
		expect(
			b
				.of("editMessageText")
				.slice(-chunks)
				.map(call => call.fields.messageId),
		).toEqual(posted.map(call => call.messageId));
		expect(
			b
				.of("editMessageText")
				.slice(-chunks)
				.map(call => String(call.fields.text))
				.join(""),
		).toBe("z".repeat(12_000));
	});

	it("falls back to send+edit when the draft itself fails", async () => {
		const { turn, deliver, drafts, sends, edits, clock } = writer({ failDraft: true });
		await turn.start();
		await turn.say("a");
		expect(drafts()).toHaveLength(1);
		expect(sends().map(fields => fields.markdown)).toEqual(["a"]);
		clock.advance(2_100);
		await turn.say("b");
		expect(edits().map(fields => fields.markdown)).toEqual(["ab"]);
		expect(deliver.of("draft")).toHaveLength(1);
	});

	it("throttles the typing action", async () => {
		const { turn, api, clock } = writer();
		await turn.start();
		await turn.say("a");
		expect(api.of("sendChatAction")).toHaveLength(1);
		expect(api.of("sendChatAction")[0].fields).toEqual({ chatId: 555, threadId: 7, action: "typing" });
		clock.advance(4_000);
		await turn.say("b");
		expect(api.of("sendChatAction")).toHaveLength(2);
	});

	it("keeps plans, steps and turn usage on the card, not in the answer", async () => {
		const { turn, deliver } = writer();
		await turn.start();
		await turn.tool({ callId: "t", toolName: "todo", args: {} });
		await turn.plan([{ name: "Work", tasks: [{ content: "First", status: "completed" }] }]);
		await turn.toolEnd({ callId: "t", ok: true });
		turn.usage({ tokens: 5, cost: 0.002 });
		await turn.finish({ status: "done", contextPercent: 4 });
		const card = [...deliver.of("send"), ...deliver.of("edit")].at(-1);
		expect(String(card?.fields.markdown)).toContain("- [x] First");
		expect(String(card?.fields.markdown)).toContain("context 4.0%");
	});
});
