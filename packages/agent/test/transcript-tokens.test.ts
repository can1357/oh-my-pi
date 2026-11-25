import { describe, expect, test } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	estimateTranscriptTokens,
	findTranscriptUsageAnchor,
	isTranscriptUsageAnchor,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";

const tokenizer = new Tokenizer();

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 1_000,
		output: 200,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1_200,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

// Contract: transcript sizing charges the provider's own report for the prefix
// it already measured and tokenizes only the tail appended after it. Getting
// this wrong either re-tokenizes the whole history every turn (the cost this
// exists to avoid) or double-counts the anchored prefix into a false
// compaction trigger.
describe("findTranscriptUsageAnchor", () => {
	test("anchors on the newest settled assistant with usable usage", () => {
		const older = assistant("older");
		const newer = assistant("newer");
		const anchor = findTranscriptUsageAnchor([user("a"), older, user("b"), newer, user("c")]);
		expect(anchor?.message).toBe(newer);
		expect(anchor?.index).toBe(3);
		expect(anchor?.tokens).toBeGreaterThan(0);
	});

	test("skips aborted and errored turns and falls back to an older usable one", () => {
		const good = assistant("good");
		const messages = [
			good,
			assistant("aborted", { stopReason: "aborted" }),
			assistant("errored", { stopReason: "error" }),
		];
		expect(findTranscriptUsageAnchor(messages)?.message).toBe(good);
	});

	test("rejects usage carrying no usable context numbers", () => {
		const empty = assistant("empty", {
			usage: usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
		});
		expect(isTranscriptUsageAnchor(empty)).toBe(false);
		expect(findTranscriptUsageAnchor([empty])).toBeUndefined();
	});

	test("fromIndex hides stale pre-compaction usage from the scan", () => {
		const stale = assistant("summarized away");
		const messages = [stale, user("kept")];
		expect(findTranscriptUsageAnchor(messages)?.message).toBe(stale);
		expect(findTranscriptUsageAnchor(messages, 1)).toBeUndefined();
	});

	test("non-assistant roles never anchor", () => {
		expect(isTranscriptUsageAnchor(user("hi"))).toBe(false);
	});
});

describe("estimateTranscriptTokens", () => {
	test("charges provider usage for the prefix and tokenizes only the tail", () => {
		const anchorMessage = assistant("anchored turn");
		const tail = user("x".repeat(4_000));
		const anchored = estimateTranscriptTokens([user("ancient"), anchorMessage, tail], tokenizer);

		// Provider report for the prefix, plus a local count of the tail only —
		// the pre-anchor "ancient" message is already inside the report.
		const anchorTokens = findTranscriptUsageAnchor([anchorMessage])?.tokens ?? 0;
		expect(anchored).toBeGreaterThan(anchorTokens);
		expect(anchored).toBe(anchorTokens + tokenizer.countMessages([tail]));
	});

	test("the local floor ignores provider usage so it cannot be deflated", () => {
		const messages = [user("a".repeat(400)), assistant("reply"), user("b".repeat(400))];
		const anchored = estimateTranscriptTokens(messages, tokenizer);
		const local = tokenizer.countMessages(messages);
		// The anchored arm inherits the provider's 1.2k-token report; the local
		// floor counts only message bytes, so the two must not coincide.
		expect(anchored).not.toBe(local);
		expect(local).toBeLessThan(anchored);
	});

	test("unanchored transcripts fall back to counting every message from countFromIndex", () => {
		const messages = [user("a".repeat(400)), user("b".repeat(400))];
		const all = estimateTranscriptTokens(messages, tokenizer);
		const skipFirst = estimateTranscriptTokens(messages, tokenizer, { countFromIndex: 1 });
		expect(all).toBeGreaterThan(skipFirst);
		expect(skipFirst).toBeGreaterThan(0);
	});

	test("a hidden anchor still counts the whole transcript locally", () => {
		// anchorFromIndex gates only the anchor scan; content accounting stays
		// governed by countFromIndex so a stale-usage guard cannot silently drop
		// real messages from the estimate.
		const messages = [assistant("stale usage"), user("y".repeat(400))];
		const hidden = estimateTranscriptTokens(messages, tokenizer, { anchorFromIndex: messages.length });
		expect(hidden).toBe(tokenizer.countMessages(messages));
	});

	// Issue #20510: Cursor's `contextTokens` is its checkpoint total, which
	// already holds the results of tools it ran server-side mid-turn; the host
	// appends those results after the assistant message.
	describe("Cursor server-resolved results after the anchor", () => {
		const start = 1_795_543_707_339;
		const calls = ["srv-1", "srv-2", "client-1"].map(id => ({
			type: "toolCall" as const,
			id,
			name: "bash",
			arguments: {},
		}));
		const result = (toolCallId: string, timestamp: number): AgentMessage => ({
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(13_558) }],
			isError: false,
			timestamp,
		});
		const turn = (api: AssistantMessage["api"]): AgentMessage[] => [
			user("go"),
			assistant("done", {
				api,
				provider: "cursor",
				timestamp: start,
				duration: 400_000,
				content: [...calls, { type: "text", text: "done" }],
				usage: usage({ contextTokens: 183_384 }),
			}),
			result("srv-1", start + 1_000),
			result("srv-2", start + 2_000),
			// Run by the client after the stream ended, so not in the report.
			result("client-1", start + 400_500),
			user("follow-up"),
		];

		test("are not re-counted on top of the provider report", () => {
			const messages = turn("cursor-agent");
			expect(estimateTranscriptTokens(messages, tokenizer)).toBe(
				183_384 + tokenizer.countMessages(messages.slice(4)),
			);
		});

		test("other providers still count every result after the anchor", () => {
			const messages = turn("anthropic-messages");
			const anchorTokens = findTranscriptUsageAnchor(messages)?.tokens ?? 0;
			expect(estimateTranscriptTokens(messages, tokenizer)).toBe(
				anchorTokens + tokenizer.countMessages(messages.slice(2)),
			);
		});
	});
});
