/**
 * Contract: the tool-step card. It is created by the first tool call of a turn,
 * carries the stop button the router maps to `turn:stop`, republishes at most
 * once every two seconds without losing the newest state, and loses the button
 * when the turn finishes.
 */
import { describe, expect, it } from "bun:test";
import { TURN_STOP_CALLBACK, createTurnCard } from "@oh-my-pi/pi-coding-agent/telegram/turn-card";
import { drain, fakeClock, fakeDelivery, manualSleeper } from "./slice-d-fakes";

function card(options: { chatId?: number } = {}) {
	const deliver = fakeDelivery();
	const clock = fakeClock(0);
	const sleeper = manualSleeper();
	const turn = createTurnCard({
		deliver,
		clock,
		chatId: options.chatId ?? 555,
		threadId: 7,
		sleep: sleeper.sleep,
	});
	const sends = () => deliver.of("send").map(call => call.fields);
	const edits = () => deliver.of("edit").map(call => call.fields);
	return { turn, deliver, clock, sleeper, sends, edits };
}

describe("turn card", () => {
	it("opens on the first tool with the stop button and drops it on finish", async () => {
		const { turn, sends, edits } = card();
		turn.begin();
		await turn.tool({ callId: "c1", toolName: "read", args: { file_path: "bin/x.mjs" } });
		expect(sends()).toHaveLength(1);
		expect(sends()[0].threadId).toBe(7);
		expect(sends()[0].replyMarkup).toEqual({ inlineKeyboard: [[{ text: "⏹ Stop", callbackData: "turn:stop" }]] });
		expect(String(sends()[0].markdown)).toContain("⏳ 📖 `read` `bin/x.mjs`");
		await turn.toolEnd({ callId: "c1", ok: true });
		await turn.finish({ status: "done" });
		const last = edits().at(-1);
		expect(String(last?.markdown).startsWith("**✅ Done**")).toBe(true);
		expect(String(last?.markdown)).toContain("✅ 📖 `read` `bin/x.mjs`");
		expect(last?.replyMarkup).toEqual({ inlineKeyboard: [] });
		expect(last?.threadId).toBe(7);
	});

	it("posts no card for a turn without tools", async () => {
		const { turn, deliver } = card();
		turn.begin();
		await turn.finish({ status: "done" });
		expect(deliver.of("send")).toHaveLength(0);
		expect(deliver.of("edit")).toHaveLength(0);
	});

	it("distinguishes a failed step from a successful one", async () => {
		const { turn, clock, edits } = card();
		turn.begin();
		await turn.tool({ callId: "a", toolName: "bash", args: { command: "echo ok" } });
		await turn.toolEnd({ callId: "a", ok: true });
		clock.advance(2_100);
		await turn.tool({ callId: "b", toolName: "bash", args: { command: "exit 7" } });
		await turn.toolEnd({ callId: "b", ok: false });
		await turn.finish({ status: "done" });
		const markdown = String(edits().at(-1)?.markdown);
		expect(markdown).toContain("- ✅ 💻 `bash` `echo ok`");
		expect(markdown).toContain("- ❌ 💻 `bash` `exit 7`");
	});

	it("signs a stopped turn stopped", async () => {
		const { turn, edits } = card();
		turn.begin();
		await turn.tool({ callId: "a", toolName: "bash", args: { command: "sleep 100" } });
		await turn.finish({ status: "stopped" });
		expect(String(edits().at(-1)?.markdown)).toContain("**⏹ Stopped**");
	});

	it("renders the todo plan as a checklist", async () => {
		const { turn, edits } = card();
		turn.begin();
		await turn.tool({ callId: "t", toolName: "todo", args: {} });
		await turn.setPlan([
			{
				name: "Work",
				tasks: [
					{ content: "First step", status: "completed" },
					{ content: "Second", status: "in_progress" },
				],
			},
		]);
		await turn.finish({ status: "done" });
		const markdown = String(edits().at(-1)?.markdown);
		expect(markdown).toContain("- [x] First step");
		expect(markdown).toContain("- [ ] Second");
	});

	it("renders a notice line with its icon and label", async () => {
		const { turn, edits } = card();
		turn.begin();
		await turn.tool({ callId: "a", toolName: "read", args: { file_path: "a.mjs" } });
		await turn.notice({ icon: "🔁", label: "Retry · attempt 2 of 5" });
		await turn.finish({ status: "done" });
		expect(String(edits().at(-1)?.markdown)).toContain("- 🔁 Retry · attempt 2 of 5");
	});

	it("sums the turn's cost and reports it with the context share on finish", async () => {
		const { turn, edits } = card();
		turn.begin();
		await turn.tool({ callId: "a", toolName: "bash", args: { command: "ls" } });
		turn.usage({ tokens: 10, cost: 0.001 });
		turn.usage({ tokens: 20, cost: 0.0005 });
		await turn.finish({ status: "done", contextPercent: 12 });
		const markdown = String(edits().at(-1)?.markdown);
		expect(markdown).toContain("$0.0015");
		expect(markdown).toContain("context 12.0%");
	});

	it("delivers the state a throttled republish skipped", async () => {
		const { turn, edits, sleeper } = card();
		turn.begin();
		await turn.tool({ callId: "a", toolName: "read", args: { file_path: "a.mjs" } });
		await turn.toolEnd({ callId: "a", ok: true });
		expect(edits()).toHaveLength(0);
		expect(sleeper.held()).toBe(1);
		sleeper.release();
		await drain();
		expect(String(edits().at(-1)?.markdown)).toContain("- ✅ 📖 `read` `a.mjs`");
	});

	it("keeps a step that arrives while a republish is pending", async () => {
		const { turn, edits, sleeper } = card();
		turn.begin();
		await turn.tool({ callId: "a", toolName: "read", args: { file_path: "a.mjs" } });
		await turn.toolEnd({ callId: "a", ok: true });
		await turn.tool({ callId: "b", toolName: "bash", args: { command: "make" } });
		sleeper.release();
		await drain();
		const markdown = String(edits().at(-1)?.markdown);
		expect(markdown).toContain("- ✅ 📖 `read` `a.mjs`");
		expect(markdown).toContain("- ⏳ 💻 `bash` `make`");
	});

	it("cancels a pending republish on finish so the final card is last", async () => {
		const { turn, edits, sleeper } = card();
		turn.begin();
		await turn.tool({ callId: "a", toolName: "read", args: { file_path: "a.mjs" } });
		await turn.toolEnd({ callId: "a", ok: true });
		expect(sleeper.held()).toBe(1);
		await turn.finish({ status: "done" });
		expect(sleeper.held()).toBe(0);
		const last = edits().at(-1);
		expect(String(last?.markdown)).toContain("**✅ Done**");
		expect(last?.replyMarkup).toEqual({ inlineKeyboard: [] });
	});

	it("keeps the stop callback data in one place", () => {
		expect(TURN_STOP_CALLBACK).toBe("turn:stop");
	});
});
