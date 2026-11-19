import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { COMPLETION_TEXT_MAX_CHARS, journalCompletion } from "@oh-my-pi/pi-coding-agent/session/model-usage-journal";
import type { ModelUsageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const USAGE: Usage = {
	input: 300,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 320,
	cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		usage: USAGE,
		stopReason: "stop",
		timestamp: 1,
		duration: 640,
		ttft: 410,
	};
}

function journaled(manager: SessionManager): ModelUsageEntry[] {
	return manager.getEntries().filter((entry): entry is ModelUsageEntry => entry.type === "model_usage");
}

describe("journalCompletion", () => {
	it("journals a side channel's usage, timing, prompt and reply into session totals", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "ship it", timestamp: 1 });
		const leaf = manager.getLeafId();

		journalCompletion(manager, { purpose: "commit:message", role: "smol" })?.(reply("fix: park tests"), "the diff");

		expect(journaled(manager)).toMatchObject([
			{
				parentId: leaf,
				purpose: "commit:message",
				role: "smol",
				model: "claude-haiku-4-5",
				duration: 640,
				ttft: 410,
				completion: { prompt: "the diff", reply: "fix: park tests" },
			},
		]);
		expect(manager.getUsageStatistics().totalTokens).toBe(USAGE.totalTokens);
	});

	it("leaves out text over the cap instead of truncating it, and everything under usageOnly", () => {
		const manager = SessionManager.inMemory();
		const long = "x".repeat(COMPLETION_TEXT_MAX_CHARS + 1);

		journalCompletion(manager, { purpose: "memory:extract" })?.(reply("three memories"), long);
		journalCompletion(manager, { purpose: "recap" })?.(reply(long));
		journalCompletion(manager, { purpose: "compaction", usageOnly: true })?.(reply("summary"), "prompt");

		expect(journaled(manager).map(entry => entry.completion)).toEqual([{ reply: "three memories" }, {}, undefined]);
	});

	it("keeps the usage of a message that came back without content", () => {
		const manager = SessionManager.inMemory();

		journalCompletion(manager, { purpose: "recap" })?.({ ...reply(""), content: undefined } as never);

		expect(journaled(manager).map(entry => [entry.usage.totalTokens, entry.completion])).toEqual([
			[USAGE.totalTokens, { reply: "" }],
		]);
	});

	it("drops an attempt that settles after the session was replaced", async () => {
		const manager = SessionManager.inMemory();
		const journal = journalCompletion(manager, { purpose: "recap" });

		await manager.newSession();
		journal?.(reply("late"));

		expect(journaled(manager)).toEqual([]);
	});
});
