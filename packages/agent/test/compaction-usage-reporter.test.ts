/**
 * The shared journal for billed compaction-side provider requests.
 *
 * A provider bills a request as soon as it completes, even when the response
 * turns out to be unusable. Every such attempt must reach the session ledger,
 * and one that produced nothing usable must be recorded as a *failed* request
 * rather than a successful one.
 */
import { describe, expect, test } from "bun:test";
import {
	anthropicCompactionRejection,
	compact,
	COMPACTION_USAGE_PURPOSES,
	compactionUsageObserver,
	type CompactionRequestUsage,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoffFromContext,
	handoffRejection,
	reportRemoteCompactionUsage,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-fable-5",
		name: "Claude Fable 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

function assistantMessage(model: Model, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		provider: model.provider,
		model: model.id,
		api: model.api,
		usage: ZERO_USAGE,
		stopReason: "stop",
		...overrides,
	};
}

/** Answers every completion the lane issues with `respond`. */
function recordingCompleteImpl(respond: () => AssistantMessage) {
	const calls: Array<{ model: Model; ctx: Context; options: SimpleStreamOptions }> = [];
	const completeImpl = async <TApi extends Api>(model: Model<TApi>, ctx: Context, options: SimpleStreamOptions) => {
		calls.push({ model, ctx, options });
		return respond();
	};
	return { calls, completeImpl };
}

describe("compaction usage reporter", () => {
	test("records a billed attempt that produced nothing usable as a failed request", () => {
		const observed: CompactionRequestUsage[] = [];
		const observe = compactionUsageObserver(
			{ onUsage: usage => observed.push(usage) },
			COMPACTION_USAGE_PURPOSES.summary,
			() => "provider wrote no summary",
		);
		const model = makeModel();
		observe?.(
			assistantMessage(model, {
				usage: { ...ZERO_USAGE, input: 10, output: 5, totalTokens: 15 },
			}),
		);

		expect(observed).toHaveLength(1);
		expect(observed[0].stopReason).toBe("error");
		expect(observed[0].errorMessage).toBe("provider wrote no summary");
		expect(observed[0].purpose).toBe(COMPACTION_USAGE_PURPOSES.summary);
	});

	test("keeps a provider error as the failure", () => {
		const observed: CompactionRequestUsage[] = [];
		const observe = compactionUsageObserver(
			{ onUsage: usage => observed.push(usage) },
			COMPACTION_USAGE_PURPOSES.summary,
			() => "provider wrote no summary",
		);
		const model = makeModel();
		observe?.(
			assistantMessage(model, {
				stopReason: "error",
				errorMessage: "upstream 500",
			}),
		);

		expect(observed[0].stopReason).toBe("error");
		expect(observed[0].errorMessage).toBe("upstream 500");
	});

	test("keeps a cancellation out of the failure bucket", () => {
		const observed: CompactionRequestUsage[] = [];
		const observe = compactionUsageObserver(
			{ onUsage: usage => observed.push(usage) },
			COMPACTION_USAGE_PURPOSES.summary,
			() => "provider wrote no summary",
		);
		const model = makeModel();
		observe?.(assistantMessage(model, { stopReason: "aborted" }));

		expect(observed[0].stopReason).toBe("aborted");
		expect(observed[0].errorMessage).toBeUndefined();
	});

	test("reports no observer when the host does not track usage", () => {
		expect(compactionUsageObserver(undefined, COMPACTION_USAGE_PURPOSES.summary)).toBeUndefined();
		expect(compactionUsageObserver({}, COMPACTION_USAGE_PURPOSES.summary)).toBeUndefined();
	});

	test("records a remote attempt that produced nothing usable as a failed request", () => {
		const observed: CompactionRequestUsage[] = [];
		reportRemoteCompactionUsage(
			{ onUsage: usage => observed.push(usage) },
			makeModel(),
			{
				inputTokens: 100,
				outputTokens: 7,
				accounting: { input: 60, output: 7, cacheRead: 40, cacheWrite: 0, totalTokens: 107 },
			},
			COMPACTION_USAGE_PURPOSES.remote,
			"provider wrote no payload",
		);

		expect(observed).toHaveLength(1);
		expect(observed[0].stopReason).toBe("error");
		expect(observed[0].errorMessage).toBe("provider wrote no payload");
		expect(observed[0].usage).toMatchObject({ input: 60, output: 7, cacheRead: 40, totalTokens: 107 });
	});
});

describe("anthropicCompactionRejection", () => {
	test("accepts a signed compaction block", () => {
		const model = makeModel();
		expect(
			anthropicCompactionRejection(
				assistantMessage(model, {
					stopDetails: { type: "compaction" },
					providerPayload: {
						type: "anthropicCompaction",
						provider: model.provider,
						content: "summary",
						signature: "sig",
					},
				}),
			),
		).toBeUndefined();
	});

	test("rejects a compaction block without a signature", () => {
		const model = makeModel();
		expect(
			anthropicCompactionRejection(
				assistantMessage(model, {
					stopDetails: { type: "compaction" },
					providerPayload: {
						type: "anthropicCompaction",
						provider: model.provider,
						content: "summary",
					},
				}),
			),
		).toBe("Anthropic compaction returned no signed summary");
	});

	test("rejects a response without a compaction block", () => {
		const model = makeModel();
		expect(anthropicCompactionRejection(assistantMessage(model, { stopDetails: { type: "end_turn" } }))).toBe(
			"Anthropic compaction response carried no compaction block (stop reason: end_turn)",
		);
	});

	test("leaves a provider error and a cancellation alone", () => {
		const model = makeModel();
		expect(anthropicCompactionRejection(assistantMessage(model, { stopReason: "error" }))).toBeUndefined();
		expect(anthropicCompactionRejection(assistantMessage(model, { stopReason: "aborted" }))).toBeUndefined();
	});
});

describe("handoffRejection", () => {
	test("rejects a response without a document", () => {
		const model = makeModel();
		expect(handoffRejection(assistantMessage(model, { content: [] }))).toBe("Handoff generation produced no content");
		expect(handoffRejection(assistantMessage(model, { content: [{ type: "text", text: "   \n\t" }] }))).toBe(
			"Handoff generation produced no content",
		);
	});

	test("accepts a response with a document", () => {
		const model = makeModel();
		expect(
			handoffRejection(assistantMessage(model, { content: [{ type: "text", text: "handoff" }] })),
		).toBeUndefined();
	});
});

describe("compaction lanes", () => {
	test("records a rejected Anthropic compaction attempt as a failed request", async () => {
		const model = makeModel();
		const observed: CompactionRequestUsage[] = [];
		const { completeImpl } = recordingCompleteImpl(() =>
			// The provider answers without the compaction block the lane needs.
			assistantMessage(model, { stopDetails: { type: "end_turn" } }),
		);

		await expect(
			compact(
				{
					firstKeptEntryId: "kept-1",
					messagesToSummarize: [{ role: "user", content: "long history", timestamp: 1 }],
					turnPrefixMessages: [],
					recentMessages: [{ role: "user", content: "recent", timestamp: 2 }],
					isSplitTurn: false,
					tokensBefore: 100_000,
					fileOps: createFileOps(),
					settings: { ...DEFAULT_COMPACTION_SETTINGS },
				},
				model,
				"sk-ant-test",
				undefined,
				undefined,
				{ completeImpl, onUsage: usage => observed.push(usage) },
			),
		).rejects.toThrow("Anthropic compaction response carried no compaction block");

		const native = observed.find(usage => usage.purpose === COMPACTION_USAGE_PURPOSES.summary);
		expect(native).toBeDefined();
		expect(native?.stopReason).toBe("error");
		expect(native?.errorMessage).toContain("Anthropic compaction response carried no compaction block");
	});

	test("records a rejected handoff attempt as a failed request", async () => {
		const model = makeModel();
		const observed: CompactionRequestUsage[] = [];
		const { completeImpl } = recordingCompleteImpl(() =>
			// The provider answers without the document the host needs.
			assistantMessage(model, { content: [{ type: "text", text: "  " }] }),
		);
		const context: Context = {
			systemPrompt: ["system"],
			messages: [{ role: "user", content: "history", timestamp: 1 }],
			tools: [],
		};

		await generateHandoffFromContext(context, model, {
			streamOptions: { apiKey: "sk-ant-test" },
			completeImpl,
			onUsage: usage => observed.push(usage),
		});

		expect(observed).toHaveLength(1);
		expect(observed[0].purpose).toBe(COMPACTION_USAGE_PURPOSES.handoff);
		expect(observed[0].stopReason).toBe("error");
		expect(observed[0].errorMessage).toBe("Handoff generation produced no content");
	});
});
