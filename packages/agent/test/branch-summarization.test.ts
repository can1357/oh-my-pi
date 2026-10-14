import { describe, expect, test } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	prepareBranchEntries,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const MODEL: Model = buildModel({
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
});

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("branch summarization", () => {
	test("includes informative tool results and drops useless ones", async () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "Inspect the branch-only state.", timestamp: 0 },
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: new Date(1).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "config.txt" } }],
					api: "mock",
					provider: "mock",
					model: "mock-model",
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "tool-1",
				parentId: "assistant-1",
				timestamp: new Date(2).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call-read",
					toolName: "read",
					content: [{ type: "text", text: "BRANCH_ONLY_FACT_4076=enabled" }],
					isError: false,
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "assistant-2",
				parentId: "tool-1",
				timestamp: new Date(3).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-search", name: "search", arguments: { pattern: "absent" } }],
					api: "mock",
					provider: "mock",
					model: "mock-model",
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: 3,
				},
			},
			{
				type: "message",
				id: "tool-2",
				parentId: "assistant-2",
				timestamp: new Date(4).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call-search",
					toolName: "search",
					content: [{ type: "text", text: "NO_MATCH_SENTINEL_4076" }],
					isError: false,
					useless: true,
					timestamp: 4,
				},
			},
		];
		let capturedPrompt = "";
		const completeImpl: GenerateBranchSummaryOptions["completeImpl"] = async (_model, ctx) => {
			const message = ctx.messages[0];
			if (message?.role !== "user") {
				throw new Error("branch summary request did not contain a user prompt");
			}
			if (typeof message.content === "string") {
				capturedPrompt = message.content;
			} else {
				for (const block of message.content) {
					if (block.type === "text") capturedPrompt += block.text;
				}
			}
			const response: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "branch summary text" }],
				api: "mock",
				provider: "mock",
				model: "mock-model",
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: 5,
			};
			return response;
		};

		await generateBranchSummary(entries, {
			model: MODEL,
			apiKey: "test-api-key",
			signal: new AbortController().signal,
			completeImpl,
		});

		expect(capturedPrompt).toContain("BRANCH_ONLY_FACT_4076=enabled");
		expect(capturedPrompt).not.toContain("NO_MATCH_SENTINEL_4076");
	});

	test("a Claude summarizer reads a compaction summary without its archived reasoning", async () => {
		const summary = [
			"- `¶user:`, `¶think:`, `¶ai:`, `¶call:`: user, assistant reasoning, assistant reply, tool call.",
			"HISTORY",
			"¶user: fix the build",
			"¶think: PRIVATE-REASONING plan",
			"",
			"PRIVATE-REASONING continued",
			"¶ai: BUILD_FIXED_4076",
		].join("\n");
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "compaction-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				summary,
				firstKeptEntryId: "user-1",
				tokensBefore: 1000,
			},
			{
				type: "message",
				id: "user-1",
				parentId: "compaction-1",
				timestamp: new Date(1).toISOString(),
				message: { role: "user", content: "Next step.", timestamp: 1 },
			},
		];
		const prompts: string[] = [];
		const completeImpl: GenerateBranchSummaryOptions["completeImpl"] = async (model, ctx) => {
			prompts.push(JSON.stringify(ctx.messages));
			return {
				role: "assistant",
				content: [{ type: "text", text: "branch summary text" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: 5,
			};
		};

		for (const id of ["claude-opus-5-5", "gpt-5.4"]) {
			await generateBranchSummary(entries, {
				model: { ...MODEL, id },
				apiKey: "test-api-key",
				signal: new AbortController().signal,
				completeImpl,
			});
		}

		const [claude, gpt] = prompts;
		expect(claude).toContain("BUILD_FIXED_4076");
		expect(claude).not.toContain("¶think:");
		expect(claude).not.toContain("PRIVATE-REASONING");
		expect(gpt).toContain("PRIVATE-REASONING");
	});

	test("useless tool results do not consume the token budget", () => {
		const uselessBlob = "USELESS_".repeat(4000);
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "OLDER_USEFUL_FACT_4076", timestamp: 0 },
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: new Date(1).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-search", name: "search", arguments: { pattern: "absent" } }],
					api: "mock",
					provider: "mock",
					model: "mock-model",
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "tool-1",
				parentId: "assistant-1",
				timestamp: new Date(2).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call-search",
					toolName: "search",
					content: [{ type: "text", text: uselessBlob }],
					isError: false,
					useless: true,
					timestamp: 2,
				},
			},
		];

		// Budget tight enough that the useless blob alone would blow it out.
		const { messages } = prepareBranchEntries(entries, new Tokenizer(), 100);

		const userMessages = messages.filter((m): m is Extract<typeof m, { role: "user" }> => m.role === "user");
		expect(userMessages).toHaveLength(1);
		expect(userMessages[0].content).toBe("OLDER_USEFUL_FACT_4076");
		expect(messages.some(m => m.role === "toolResult")).toBe(false);
	});

	test("large informative tool results are budgeted after summary truncation", () => {
		const informativeBlob = `IMPORTANT_LARGE_TOOL_FACT_4112\n${"x".repeat(20_000)}`;
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "assistant-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "big.txt" } }],
					api: "mock",
					provider: "mock",
					model: "mock-model",
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: 0,
				},
			},
			{
				type: "message",
				id: "tool-1",
				parentId: "assistant-1",
				timestamp: new Date(1).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call-read",
					toolName: "read",
					content: [{ type: "text", text: informativeBlob }],
					isError: false,
					timestamp: 1,
				},
			},
		];

		const { messages } = prepareBranchEntries(entries, new Tokenizer(), 700);

		expect(messages.some(m => m.role === "toolResult")).toBe(true);
	});

	// Contract: the summarizer receives the branch as plain text, so a Codex
	// turn's native reasoning, charged at its reported tokens when the same model
	// replays it, never takes up the selection budget.
	test("replayed reasoning does not consume the text-only summary budget", async () => {
		const codex = getBundledModel("openai-codex", "gpt-6.1-sol");
		const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "e".repeat(16_000) };
		const conclusion = "BRANCH_CONCLUSION_5000: keep the retry loop.";
		const answerItem = {
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: conclusion, annotations: [] }],
		};
		// Signed, and payload-only as `/shake thinking` leaves it.
		const variants: Array<[string, AssistantMessage["content"]]> = [
			[
				"signed",
				[
					{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoningItem) },
					{ type: "text", text: conclusion },
				],
			],
			["payload only", [{ type: "text", text: conclusion }]],
		];
		for (const [name, content] of variants) {
			const entries: SessionEntry[] = [
				{
					type: "message",
					id: "assistant-1",
					parentId: null,
					timestamp: new Date(1).toISOString(),
					message: {
						role: "assistant",
						content,
						api: codex.api,
						provider: codex.provider,
						model: codex.id,
						providerPayload: {
							type: "openaiResponsesHistory",
							provider: codex.provider,
							dt: true,
							items: [reasoningItem, answerItem],
						},
						usage: { ...ZERO_USAGE, output: 6_000, totalTokens: 6_000, reasoningTokens: 5_000 },
						stopReason: "stop",
						timestamp: 1,
					},
				},
			];
			let prompt = "";
			const result = await generateBranchSummary(entries, {
				// 1,000 tokens for the branch: room for the conclusion, not for the reasoning.
				model: { ...codex, contextWindow: 2_000 },
				reserveTokens: 1_000,
				apiKey: "test-api-key",
				signal: new AbortController().signal,
				completeImpl: async (_model, ctx) => {
					prompt = JSON.stringify(ctx.messages);
					return {
						role: "assistant",
						content: [{ type: "text", text: "branch summary text" }],
						api: codex.api,
						provider: codex.provider,
						model: codex.id,
						usage: ZERO_USAGE,
						stopReason: "stop",
						timestamp: 2,
					};
				},
			});
			// The failure mode is "No content to summarize" without a summarizer call.
			expect({ name, summarized: result.summary?.includes("branch summary text") }).toEqual({
				name,
				summarized: true,
			});
			expect(prompt).toContain("BRANCH_CONCLUSION_5000");
		}
	});

	test("returns an aborted result when cancelled during transient retry backoff", async () => {
		const reason = new Error("user cancelled branch summary");
		let aborted = false;
		const signal = {
			get aborted() {
				return aborted;
			},
			get reason() {
				return aborted ? reason : undefined;
			},
			addEventListener(type: string, listener: ((event: Event) => void) | { handleEvent(event: Event): void }) {
				if (type !== "abort") return;
				aborted = true;
				const event = new Event("abort");
				if (typeof listener === "function") listener(event);
				else listener.handleEvent(event);
			},
			removeEventListener() {},
		} as unknown as AbortSignal;
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "Summarize this branch.", timestamp: 0 },
			},
		];
		let calls = 0;

		const result = await generateBranchSummary(entries, {
			model: MODEL,
			apiKey: "test-api-key",
			signal,
			completeImpl: async () => {
				calls += 1;
				return {
					role: "assistant",
					content: [],
					api: "mock",
					provider: "mock",
					model: "mock-model",
					usage: ZERO_USAGE,
					stopReason: "error",
					errorStatus: 529,
					errorMessage: "overloaded_error: Overloaded",
					timestamp: 1,
				};
			},
		});

		expect(calls).toBe(1);
		expect(result).toEqual({ aborted: true });
	});
});
