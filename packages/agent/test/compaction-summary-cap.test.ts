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

function promptTextOf(call: unknown[]): string {
	const context = call[1] as { messages: { content: { type: string; text: string }[] }[] };
	return context.messages[0]?.content[0]?.text ?? "";
}

describe("compaction summary output budget", () => {
	test("caps the summary budget for large reserves", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("summary"));
		// A 1M-token window yields a 150k reserve, which used to authorize a ~120k-token summary.
		await generateSummary(messages, getModel(), 150_000, "test-key");
		expect(spy.mock.calls[0]?.[2]?.maxTokens).toBe(MAX_SUMMARY_TOKENS);
		expect(MAX_SUMMARY_TOKENS).toBe(2048);
	});

	test("requests a deterministic continuity capsule with explicit provenance", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("capsule"));
		await generateSummary(messages, getModel(), 150_000, "test-key");

		const request = promptTextOf(spy.mock.calls[0] ?? []);
		const headings = [
			"## Outcome",
			"## Owner constraints",
			"## Settled decisions",
			"## Verified evidence",
			"## Current authorities and identifiers",
			"## Open blocker",
			"## Current conversation",
			"## One next action",
			"## Exact archive pointers",
		];
		let previousIndex = -1;
		for (const heading of headings) {
			const headingIndex = request.indexOf(heading);
			expect(headingIndex).toBeGreaterThan(previousIndex);
			previousIndex = headingIndex;
		}
		expect(request).toContain("Observed tool result (not re-verified)");
		expect(request).toContain("quoted or pasted material");
		expect(request).toContain("An Ask selection, custom input, or note carries owner intent");
		expect(request).toContain("An Ask cancellation means only that its question remains unanswered");
		expect(request).toContain("A tool call proves only that an action was attempted");
		expect(request).toContain("last-observed coordinates");
		expect(request).toContain("Exactly one concrete action");
		expect(request).toContain("under 500 words");
		expect(request).toContain("Move completed-lane chronology");
	});

	test("rewrites carried summaries instead of preserving stale state", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("capsule"));
		await generateSummary(messages, getModel(), 150_000, "test-key", undefined, undefined, "old capsule");

		const request = promptTextOf(spy.mock.calls[0] ?? []);
		expect(request).toContain("never append to it mechanically");
		expect(request).toContain("Remove completed-lane chronology, superseded hypotheses, completed next actions");
		expect(request).toContain("<previous-summary>\nold capsule\n</previous-summary>");
		expect(request).toContain("An Ask selection, custom input, or note carries owner intent");
		expect(request).toContain("An Ask cancellation means only that its question remains unanswered");
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
		expect(String(requestBody?.prompt)).toContain("## Exact archive pointers");
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
		expect(budgets).toEqual([512, MAX_SUMMARY_TOKENS / 2, MAX_SUMMARY_TOKENS]);
		const requests = spy.mock.calls.map(call => promptTextOf(call));
		expect(
			requests.some(
				request =>
					request.includes("## Owner request") &&
					request.includes("## Verified prefix evidence") &&
					request.includes("## Unverified prefix state") &&
					request.includes("under 250 words") &&
					request.includes("An Ask selection, custom input, or note carries owner intent") &&
					request.includes("an Ask cancellation means only that its question remains unanswered"),
			),
		).toBeTrue();
	});

	test("caps default-sized reserves at the continuity capsule ceiling", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("summary"));
		await generateSummary(messages, getModel(), 10_000, "test-key");
		expect(spy.mock.calls[0]?.[2]?.maxTokens).toBe(MAX_SUMMARY_TOKENS);
	});
});
