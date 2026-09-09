import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateSummary,
	MAX_SUMMARY_TOKENS,
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

function getModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

const messages: AgentMessage[] = [
	{ role: "user", content: "start work", timestamp: 1 },
	createAssistantMessage("started"),
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compaction summary output budget", () => {
	test("caps the summary budget for large reserves", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("summary"));
		// A 1M-token window yields a 150k reserve, which used to authorize a ~120k-token summary.
		await generateSummary(messages, getModel(), 150_000, "test-key");
		expect(spy.mock.calls[0]?.[2]?.maxTokens).toBe(MAX_SUMMARY_TOKENS);
	});

	test("forwards the cap to remote compaction", async () => {
		let requestBody: Record<string, unknown> | undefined;
		await generateSummary(messages, getModel(), 150_000, "test-key", undefined, undefined, undefined, {
			remoteEndpoint: "https://compaction.example.test/summarize",
			fetch: async (_input, init) => {
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(JSON.stringify({ summary: "summary" }));
			},
		});

		expect(requestBody?.maxTokens).toBe(MAX_SUMMARY_TOKENS);
	});

	test("caps both summaries when compaction splits a turn", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("summary"));
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: messages,
			turnPrefixMessages: [{ role: "user", content: "continue", timestamp: 2 }],
			recentMessages: [{ role: "user", content: "recent", timestamp: 3 }],
			isSplitTurn: true,
			tokensBefore: 900_000,
			fileOps: createFileOps(),
			settings: {
				...DEFAULT_COMPACTION_SETTINGS,
				reserveTokens: 150_000,
				remoteEnabled: false,
			},
		};

		await compact(preparation, getModel(), "test-key");

		const budgets = spy.mock.calls.map(call => call[2]?.maxTokens).sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(budgets).toEqual([512, MAX_SUMMARY_TOKENS, MAX_SUMMARY_TOKENS]);
	});

	test("leaves a reserve smaller than the cap proportional", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("summary"));
		await generateSummary(messages, getModel(), 10_000, "test-key");
		expect(spy.mock.calls[0]?.[2]?.maxTokens).toBe(8_000);
	});
});
