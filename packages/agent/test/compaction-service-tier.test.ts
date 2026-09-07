import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateBranchSummary,
	generateHandoff,
	type CompactionPreparation,
} from "@oh-my-pi/pi-agent-core/compaction";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { AssistantMessage, Effort, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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

function getAnthropicModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

function makeUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function makePreparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [makeUserMessage("history")],
		turnPrefixMessages: [makeUserMessage("turn prefix")],
		recentMessages: [makeUserMessage("recent")],
		isSplitTurn: true,
		tokensBefore: 12_345,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
	};
}

const messages: AgentMessage[] = [makeUserMessage("continue the work")];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compaction service-tier resolution", () => {
	test("compact resolves each local candidate call from its concrete effort", async () => {
		const model = getAnthropicModel();
		const provider = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "summary" }]));
		const resolverCalls: Array<{
			model: Model;
			reasoning: Effort | undefined;
			disableReasoning: boolean | undefined;
		}> = [];

		await compact(makePreparation(), model, "test-key", undefined, undefined, {
			thinkingLevel: ThinkingLevel.Low,
			serviceTierResolver: (candidate, reasoning, disableReasoning) => {
				resolverCalls.push({ model: candidate, reasoning, disableReasoning });
				return reasoning === ai.Effort.Low ? "flex" : "priority";
			},
		});

		expect(provider).toHaveBeenCalledTimes(3);
		expect(resolverCalls).toHaveLength(3);
		for (const call of resolverCalls) {
			expect(call.model).toBe(model);
			expect(call.reasoning).toBe(ai.Effort.Low);
			expect(call.disableReasoning).toBe(false);
		}
		for (const [, , options] of provider.mock.calls) {
			expect(options?.reasoning).toBe(ai.Effort.Low);
			expect(options?.serviceTier).toBe("flex");
		}
	});

	test("branch summaries resolve the candidate model tier", async () => {
		const model = getAnthropicModel();
		const provider = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "branch summary" }]));
		const resolver = vi.fn((_candidate: Model, reasoning: Effort | undefined, disableReasoning?: boolean) => {
			expect(reasoning).toBeUndefined();
			expect(disableReasoning).toBeUndefined();
			return "flex" as const;
		});

		await generateBranchSummary(
			[
				{
					type: "message",
					id: "branch-message",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: makeUserMessage("branch history"),
				},
			],
			{
				model,
				apiKey: "test-key",
				signal: new AbortController().signal,
				serviceTierResolver: resolver,
			},
		);

		expect(resolver).toHaveBeenCalledWith(model, undefined, undefined);
		expect(provider.mock.calls[0]?.[2]?.serviceTier).toBe("flex");
	});

	test("handoff sends disabled reasoning to the resolver instead of reusing a session tier", async () => {
		const model = getAnthropicModel();
		const provider = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		const resolver = vi.fn((_candidate: Model, reasoning: Effort | undefined, disableReasoning?: boolean) => {
			expect(reasoning).toBeUndefined();
			expect(disableReasoning).toBe(true);
			return undefined;
		});

		await generateHandoff(messages, model, "test-key", {
			systemPrompt: ["system"],
			thinkingLevel: ThinkingLevel.Off,
			serviceTierResolver: resolver,
		});

		expect(resolver).toHaveBeenCalledWith(model, undefined, true);
		expect(provider).toHaveBeenCalledTimes(1);
		expect(provider.mock.calls[0]?.[2]?.reasoning).toBeUndefined();
		expect(provider.mock.calls[0]?.[2]?.serviceTier).toBeUndefined();
	});
});
