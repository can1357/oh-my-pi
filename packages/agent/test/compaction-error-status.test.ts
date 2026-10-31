import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoff,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Pins the fix for the "raw 401 surfaced as Compaction failed:" bug.
//
// When a real provider returns HTTP 401/403 from a summarization call,
// `instrumentedCompleteSimple` resolves with `stopReason: "error"` and
// `errorStatus` populated by the provider's catch block (e.g.
// `packages/ai/src/providers/anthropic.ts`). The compaction layer must
// surface that status on the thrown Error so
// `AgentSession.#isCompactionAuthFailure` can route to the authenticated
// fallback model instead of dumping the raw `<status> <body>` string
// into the UI.
//
// `generateHandoff` is the cheapest vehicle (one LLM call). The same
// `createSummarizationError` helper backs every provider-error throw site
// in `packages/agent/src/compaction/compaction.ts`, so verifying one
// site is sufficient to lock that contract.

function makeAssistantStop(content: AssistantMessage["content"]): AssistantMessage {
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

function makeAssistantError(errorStatus: number | undefined, errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		stopReason: "error",
		errorMessage,
		...(errorStatus !== undefined ? { errorStatus } : {}),
	};
}

function makeAssistantLength(content: AssistantMessage["content"]): AssistantMessage {
	return {
		...makeAssistantStop(content),
		stopReason: "length",
		errorStatus: 401,
		errorId: AIError.create(AIError.Flag.AuthFailed),
		errorMessage: "auth_unavailable",
	};
}

function getAnthropicModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

const handoffMessages: AgentMessage[] = [
	{ role: "user", content: "begin", timestamp: 1 },
	makeAssistantStop([{ type: "text", text: "ok" }]),
];

function makeUserMessage(text: string, timestamp = Date.now()): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [
			makeUserMessage("history msg"),
			makeAssistantStop([{ type: "text", text: "history reply" }]),
		],
		turnPrefixMessages: [makeUserMessage("turn prefix msg")],
		recentMessages: [makeUserMessage("recent msg")],
		isSplitTurn: true,
		tokensBefore: 12_345,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
		...overrides,
	};
}

function expectIncompleteSummaryError(error: unknown, prefix: string): void {
	if (!(error instanceof Error)) throw new Error("Expected incomplete summary to reject");
	expect(error.constructor).toBe(Error);
	expect(error.message).toBe(`${prefix}: model output ended incomplete (stopReason: length)`);
	expect("status" in error).toBe(false);
	expect("errorId" in error).toBe(false);
	const classification = AIError.classify(error.message);
	expect(AIError.is(classification, AIError.Flag.Transient)).toBe(false);
	expect(AIError.is(classification, AIError.Flag.ContextOverflow)).toBe(false);
	expect(AIError.is(classification, AIError.Flag.AuthFailed)).toBe(false);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compaction error-status propagation", () => {
	test("generateHandoff throws Error with .status === 401 when provider returns 401", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			makeAssistantError(
				401,
				'401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
			),
		);

		const error = await generateHandoff(handoffMessages, getAnthropicModel(), "stale-key", {
			systemPrompt: ["sp"],
			tools: [],
		}).catch(err => err);

		expect(error).toBeInstanceOf(Error);
		const e = error as Error & { status?: number };
		expect(e.status).toBe(401);
		// Message still carries the upstream body so logs and telemetry
		// retain the raw provider envelope.
		expect(e.message).toContain("Handoff generation failed");
		expect(e.message).toContain("authentication_error");
	});

	test("compact() fan-out throws Error with .status === 403 when provider returns 403", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			makeAssistantError(403, '403 {"error":{"type":"forbidden","message":"Access denied"}}'),
		);

		const error = await compact(makePreparation(), getAnthropicModel(), "stale-key").catch(err => err);

		expect(error).toBeInstanceOf(Error);
		const e = error as Error & { status?: number };
		expect(e.status).toBe(403);
		expect(e.message).toMatch(/Summarization failed|Turn prefix summarization failed/);
	});

	test("missing errorStatus does not attach .status (preserves auth_unavailable regex path)", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			makeAssistantError(undefined, "503 auth_unavailable: no auth available (providers=codex, model=gpt-5.4-mini)"),
		);

		const error = await generateHandoff(handoffMessages, getAnthropicModel(), "stale-key", {
			systemPrompt: ["sp"],
			tools: [],
		}).catch(err => err);

		expect(error).toBeInstanceOf(Error);
		const e = error as Error & { status?: number };
		// Synthetic pi-native gateway errors don't carry HTTP status; the
		// upstream regex on `auth_unavailable` is the load-bearing detector.
		expect(e.status).toBeUndefined();
		expect(e.message).toContain("auth_unavailable");
	});
});

describe("incomplete local summaries", () => {
	test("generateHandoff rejects incomplete output without carrying stale provider error metadata", async () => {
		const response = makeAssistantLength([{ type: "text", text: "## Next Steps\nContinue by" }]);
		const completeSimpleSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(response);
		const error = await generateHandoff(handoffMessages, getAnthropicModel(), "key", {
			systemPrompt: ["sp"],
		}).catch((caught: unknown) => caught);

		expectIncompleteSummaryError(error, "Handoff generation failed");
		expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
	});

	const incompleteContents: Array<[string, AssistantMessage["content"]]> = [
		["partial text", [{ type: "text", text: "The remaining work is to" }]],
		["reasoning only", [{ type: "thinking", thinking: "Preparing the summary" }]],
	];
	for (const [name, content] of incompleteContents) {
		test(`compact rejects a full summary ending on length with ${name} without another call`, async () => {
			const response = makeAssistantLength(content);
			const completeImpl = vi.fn(async () => response);
			const preparation = makePreparation({ isSplitTurn: false, turnPrefixMessages: [] });
			const originalHistory = structuredClone(preparation.messagesToSummarize);
			const error = await compact(preparation, getAnthropicModel(), "key", undefined, undefined, {
				completeImpl,
			}).catch((caught: unknown) => caught);

			expectIncompleteSummaryError(error, "Summarization failed");
			expect(completeImpl).toHaveBeenCalledTimes(1);
			expect(preparation.messagesToSummarize).toEqual(originalHistory);
		});

		test(`compact rejects a split-turn prefix ending on length with ${name}`, async () => {
			const response = makeAssistantLength(content);
			const historyResponse = makeAssistantStop([{ type: "text", text: "Complete history summary." }]);
			const prompts: string[] = [];
			const preparation = makePreparation();
			const originalPrefix = structuredClone(preparation.turnPrefixMessages);
			const prefixPrompt = "MUST summarize prefix for retained suffix:";
			const error = await compact(preparation, getAnthropicModel(), "key", undefined, undefined, {
				completeImpl: async (_model, ctx) => {
					const prompt = JSON.stringify(ctx.messages);
					prompts.push(prompt);
					return prompt.includes(prefixPrompt) ? response : historyResponse;
				},
			}).catch((caught: unknown) => caught);

			expectIncompleteSummaryError(error, "Turn prefix summarization failed");
			expect(prompts).toHaveLength(2);
			expect(prompts.filter(prompt => prompt.includes(prefixPrompt))).toHaveLength(1);
			expect(preparation.turnPrefixMessages).toEqual(originalPrefix);
		});
	}
});
