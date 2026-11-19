import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	type BranchSummaryEntry,
	type CustomMessageEntry,
	DEFAULT_COMPACTION_SETTINGS,
	findCutPoint,
	prepareCompaction,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import { Tokenizer } from "@oh-my-pi/pi-agent-core/tokenizer";
import { createAssistantMessage, createUserMessage } from "./helpers";

const tokenizer = new Tokenizer();

let seq = 0;
function base(type: string) {
	const id = `e${seq++}`;
	return { id, parentId: null, timestamp: new Date().toISOString(), type };
}

function assistantEntry(text: string): SessionMessageEntry {
	return {
		...base("message"),
		type: "message",
		message: createAssistantMessage([{ type: "text", text }]),
	};
}

function customMessageEntry(content: string): CustomMessageEntry {
	return {
		...base("custom_message"),
		type: "custom_message",
		customType: "test",
		content,
		display: true,
	};
}

function branchSummaryEntry(summary: string): BranchSummaryEntry {
	return {
		...base("branch_summary"),
		type: "branch_summary",
		fromId: "branch-root",
		summary,
	};
}

describe("findCutPoint backward scan boundaries", () => {
	test("does not re-admit an oversized custom_message during backward scan", () => {
		const custom = customMessageEntry("x".repeat(100_000));
		const assistant = assistantEntry("small answer");
		const entries = [custom, assistant];

		const cut = findCutPoint(entries, tokenizer, 0, entries.length, 20_000);
		expect(cut.firstKeptEntryIndex).toBe(1);
		expect(cut.isSplitTurn).toBe(true);
		expect(cut.turnStartIndex).toBe(0);

		const preparation = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 20_000 });
		expect(preparation?.firstKeptEntryId).toBe(assistant.id);
		expect(preparation?.recentMessages).toEqual([assistant.message]);
		expect(tokenizer.countMessages(preparation!.recentMessages)).toBeLessThanOrEqual(20_000);
	});

	test("does not re-admit an oversized branch_summary during backward scan", () => {
		const branch = branchSummaryEntry("s".repeat(100_000));
		const assistant = assistantEntry("small answer");
		const entries = [branch, assistant];

		const cut = findCutPoint(entries, tokenizer, 0, entries.length, 20_000);
		expect(cut.firstKeptEntryIndex).toBe(1);
		expect(cut.isSplitTurn).toBe(true);
		expect(cut.turnStartIndex).toBe(0);

		const preparation = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 20_000 });
		expect(preparation?.firstKeptEntryId).toBe(assistant.id);
		expect(preparation?.recentMessages).toEqual([assistant.message]);
		expect(tokenizer.countMessages(preparation!.recentMessages)).toBeLessThanOrEqual(20_000);
	});

	test("retains fitting custom_message without marking a split turn", () => {
		const oldAssistant = assistantEntry("x".repeat(100_000));
		const custom = customMessageEntry("small question");
		const assistant = assistantEntry("small answer");
		const entries = [oldAssistant, custom, assistant];

		const cut = findCutPoint(entries, tokenizer, 0, entries.length, 20_000);
		expect(cut.firstKeptEntryIndex).toBe(1);
		expect(cut.isSplitTurn).toBe(false);
		expect(cut.turnStartIndex).toBe(-1);

		const preparation = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 20_000 });
		expect(preparation?.firstKeptEntryId).toBe(custom.id);
		expect(preparation?.messagesToSummarize).toEqual([oldAssistant.message]);
		expect(preparation?.turnPrefixMessages).toEqual([]);
		expect(preparation?.recentMessages).toHaveLength(2);
	});

	describe("counts the reasoning the latest turn replays when its tool calls were abandoned", () => {
		// The replay keeps the latest assistant turn byte-for-byte, so a turn
		// whose tool calls ended on max_tokens still sends its 30,000 tokens of
		// signed reasoning, and the kept tail must count them.
		const opus = getBundledModel("anthropic", "claude-opus-5-5");
		const fromOpus = (content: AssistantMessage["content"], stop: AssistantMessage["stopReason"]) => ({
			...createAssistantMessage(content, stop),
			api: opus.api,
			provider: opus.provider,
			model: opus.id,
		});
		const message = (content: SessionMessageEntry["message"]): SessionMessageEntry => ({
			...base("message"),
			type: "message",
			message: content,
		});
		const abandoned = (): SessionMessageEntry => {
			const latest = fromOpus(
				[
					{ type: "thinking", thinking: "Plan the read.", thinkingSignature: "s".repeat(4000) },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
				],
				"length",
			);
			latest.usage = { ...latest.usage, output: 30_000, totalTokens: 30_000 };
			return message(latest);
		};
		const history = () => [
			message(createUserMessage("x".repeat(40_000))),
			assistantEntry("first answer"),
			message(createUserMessage("next question")),
		];

		test("as the newest entry", () => {
			const entries = [...history(), abandoned()];
			const cut = findCutPoint(entries, new Tokenizer(opus), 0, entries.length, 20_000);
			expect(cut.firstKeptEntryIndex).toBe(3);
		});

		test("behind a newer turn the replay drops for its malformed tool call", () => {
			// The replay drops the malformed call and with it the whole turn, so
			// the abandoned turn before it is the request's latest.
			const malformed = fromOpus([{ type: "toolCall", id: "call-2", name: "", arguments: {} }], "toolUse");
			const entries = [...history(), abandoned(), message(malformed)];
			const cut = findCutPoint(entries, new Tokenizer(opus), 0, entries.length, 20_000);
			expect(cut.firstKeptEntryIndex).toBe(4);
		});
	});
});
