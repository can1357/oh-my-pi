import { describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	DEFAULT_COMPACTION_SETTINGS,
	findReadableCompactionIndex,
	generateSummary,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function getModel(contextWindow: number): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return { ...model, contextWindow };
}

/** ~4 chars per cl100k token, so each turn is roughly `tokens` tokens of input. */
function turn(index: number, tokens: number): AgentMessage[] {
	return [
		{ role: "user", content: `turn ${index} ${"work ".repeat(tokens / 2)}`, timestamp: index },
		createAssistantMessage(`did ${index}`),
	];
}

function promptTextOf(call: unknown[]): string {
	const context = call[1] as { messages: { content: { type: string; text: string }[] }[] };
	return context.messages[0].content[0].text;
}

describe("summarization input budget", () => {
	test("summarizes a fitting conversation in one call", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("summary"));
		try {
			const summary = await generateSummary(turn(1, 200), getModel(200_000), 16_384, "test-key");
			expect(spy.mock.calls.length).toBe(1);
			expect(summary).toBe("summary");
		} finally {
			spy.mockRestore();
		}
	});

	test("folds a conversation larger than the summarizer window across calls", async () => {
		let call = 0;
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockImplementation(async () => createAssistantMessage(`summary ${++call}`));
		try {
			// 40k-token window leaves ~4k of conversation budget after the summary
			// reserve, so ~48k tokens of conversation cannot be one prompt.
			const messages = Array.from({ length: 12 }, (_, i) => turn(i, 4_000)).flat();
			const summary = await generateSummary(messages, getModel(40_000), 16_384, "test-key");

			expect(spy.mock.calls.length).toBeGreaterThan(1);
			expect(summary).toBe(`summary ${spy.mock.calls.length}`);

			// Every window is inside the budget, and every window after the first
			// carries the summary of the ones before it.
			const prompts = spy.mock.calls.map(promptTextOf);
			for (const prompt of prompts) {
				expect(prompt.length).toBeLessThan(40_000 * 4);
			}
			expect(prompts[0]).not.toContain("<previous-summary>");
			expect(prompts[1]).toContain("<previous-summary>\nsummary 1\n</previous-summary>");

			// The fold covers the whole span: first and last turns both reach a call.
			expect(prompts[0]).toContain("turn 0");
			expect(prompts[prompts.length - 1]).toContain("turn 11");
		} finally {
			spy.mockRestore();
		}
	});

	test("shrinks windows when the provider rejects a prompt the catalog said would fit", async () => {
		// claude-sonnet-4-5 advertises a 1M window but is beta-gated to 200k on
		// OAuth credentials (`anthropic.ts` never advertises the 1M beta), so the
		// only authority on the real cap is the rejection itself.
		const providerCapChars = 160_000;
		const rejected: number[] = [];
		let call = 0;
		const spy = vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			const prompt = promptTextOf([_model, context]);
			if (prompt.length > providerCapChars) {
				rejected.push(prompt.length);
				throw new Error(`400 prompt is too long: ${prompt.length} tokens > ${providerCapChars} maximum`);
			}
			return createAssistantMessage(`summary ${++call}`);
		});
		try {
			const messages = Array.from({ length: 60 }, (_, i) => turn(i, 4_000)).flat();
			const summary = await generateSummary(messages, getModel(400_000), 16_384, "test-key");

			// The first plan trusted the catalog and was rejected; the fold halved
			// the window instead of failing the compaction.
			expect(rejected.length).toBeGreaterThan(0);
			expect(rejected.length).toBeLessThan(4);
			expect(summary).toBe(`summary ${call}`);
			const accepted = spy.mock.calls.map(promptTextOf).filter(p => p.length <= providerCapChars);
			expect(accepted[0]).toContain("turn 0");
			expect(accepted[accepted.length - 1]).toContain("turn 59");
		} finally {
			spy.mockRestore();
		}
	});

	test("keeps the window floor inside a small model's context", async () => {
		// The absolute 16,384-token floor plus the carried summary and output
		// reserves exceeds a 40k window outright, and overflow recovery would then
		// bail at the very floor that caused the rejection. The floor scales with
		// the window instead, so a small-context model still folds successfully.
		const providerCapChars = 26_000; // what a 40k window can host next to the reserves
		const spy = vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			const prompt = promptTextOf([_model, context]);
			if (prompt.length > providerCapChars) {
				throw new Error(`400 prompt is too long: ${prompt.length} tokens > ${providerCapChars} maximum`);
			}
			return createAssistantMessage("summary");
		});
		try {
			const messages = Array.from({ length: 12 }, (_, i) => turn(i, 4_000)).flat();
			const summary = await generateSummary(messages, getModel(40_000), 16_384, "test-key");
			expect(summary).toBe("summary");
			for (const prompt of spy.mock.calls.map(promptTextOf)) {
				expect(prompt.length).toBeLessThanOrEqual(providerCapChars);
			}
		} finally {
			spy.mockRestore();
		}
	});

	test("propagates a non-overflow failure instead of shrinking", async () => {
		let calls = 0;
		const spy = vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			calls++;
			throw new Error("provider exploded");
		});
		try {
			const messages = Array.from({ length: 12 }, (_, i) => turn(i, 4_000)).flat();
			await expect(generateSummary(messages, getModel(40_000), 16_384, "test-key")).rejects.toThrow(
				"provider exploded",
			);
			expect(calls).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	test("carries a caller-supplied previous summary into the first window", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("merged"));
		try {
			await generateSummary(turn(1, 200), getModel(200_000), 16_384, "test-key", undefined, undefined, "earlier");
			expect(promptTextOf(spy.mock.calls[0])).toContain("<previous-summary>\nearlier\n</previous-summary>");
		} finally {
			spy.mockRestore();
		}
	});
});

function compactionEntry(id: string, preserveData?: Record<string, unknown>): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		summary: "summary",
		firstKeptEntryId: `${id}-kept`,
		tokensBefore: 1,
		preserveData,
	} satisfies SessionEntry;
}

describe("readable compaction boundary", () => {
	const local = compactionEntry("local");
	const remote = compactionEntry("remote", {
		openaiRemoteCompaction: { provider: "openai-codex", replacementHistory: [] },
	});
	const entries = [local, remote];

	test("skips a provider-native compaction another provider cannot replay", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
		expect(findReadableCompactionIndex(entries, DEFAULT_COMPACTION_SETTINGS, model)).toBe(0);
	});

	test("keeps a provider-native compaction the same provider can replay", () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected built-in openai-codex/gpt-5.6-sol to exist");
		expect(findReadableCompactionIndex(entries, DEFAULT_COMPACTION_SETTINGS, model)).toBe(1);
	});

	test("without an active model the newest entry is the boundary", () => {
		expect(findReadableCompactionIndex(entries, DEFAULT_COMPACTION_SETTINGS)).toBe(1);
	});
});
