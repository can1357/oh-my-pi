/**
 * Anthropic server-side compaction backend (`compact-2026-01-12`).
 *
 * Covers the agent side of the lane: which models take it, the request
 * `compact()` issues (live-turn shape plus the compact edit with the harness
 * instructions), what it persists (the API's summary as both entry text and
 * native replay payload), the eligibility floor that routes small contexts to
 * the local summarizer, native-failure semantics, and how a later compaction
 * reads a native entry back.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	ANTHROPIC_COMPACTION_MIN_CONTEXT_TOKENS,
	buildAnthropicCompactionInstructions,
	describeRetainedTail,
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	getAnthropicCompactionPayload,
	NativeCompactionError,
	prepareCompaction,
	remotePreserveReusable,
	type SessionEntry,
	shouldUseAnthropicNativeCompaction,
	shouldUseProviderNativeCompaction,
	withAnthropicCompactionPreserveData,
} from "@oh-my-pi/pi-agent-core/compaction";
import * as ai from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import * as snapcompact from "@oh-my-pi/snapcompact";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const NATIVE_SUMMARY = "## Goal\nAudit the handlers.\n\n## Next Steps\n1. Continue with chunk 11.";

function makeAnthropicModel(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
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
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

function makeOpenAiModel(): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	});
}

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [{ role: "user", content: "long history", timestamp: 1 }],
		turnPrefixMessages: [],
		recentMessages: [{ role: "user", content: "recent", timestamp: 2 }],
		isSplitTurn: false,
		tokensBefore: 100_000,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
		...overrides,
	};
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

/** Records every completion the lane issues and answers with `respond`. */
function recordingCompleteImpl(respond: (ctx: Context, options: SimpleStreamOptions) => AssistantMessage) {
	const calls: Array<{ ctx: Context; options: SimpleStreamOptions }> = [];
	const completeImpl = async <TApi extends ai.Api>(
		_model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => {
		calls.push({ ctx, options });
		return respond(ctx, options);
	};
	return { calls, completeImpl };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("shouldUseAnthropicNativeCompaction", () => {
	test("covers beta-supported first-party models on the official endpoint and explicit opt-ins only", () => {
		expect(shouldUseAnthropicNativeCompaction(makeAnthropicModel())).toBe(true);
		expect(shouldUseAnthropicNativeCompaction(makeAnthropicModel({ remoteCompaction: { enabled: false } }))).toBe(
			false,
		);
		expect(
			shouldUseAnthropicNativeCompaction(makeAnthropicModel({ compat: { supportsContextManagement: false } })),
		).toBe(false);
		// The beta rejects the budget-thinking generations (Haiku 4.5, Sonnet
		// 4.5, Opus 4.5): only adaptive-thinking models qualify.
		expect(
			shouldUseAnthropicNativeCompaction(
				makeAnthropicModel({ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000 }),
			),
		).toBe(false);
		expect(
			shouldUseAnthropicNativeCompaction(
				makeAnthropicModel({ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 1_000_000 }),
			),
		).toBe(false);
		// A first-party model routed through a proxy is not assumed to accept the beta.
		expect(shouldUseAnthropicNativeCompaction(makeAnthropicModel({ baseUrl: "https://proxy.example" }))).toBe(false);
		const proxy = makeAnthropicModel({ provider: "custom-anthropic-proxy", baseUrl: "https://proxy.example" });
		expect(shouldUseAnthropicNativeCompaction(proxy)).toBe(false);
		expect(
			shouldUseAnthropicNativeCompaction(
				makeAnthropicModel({
					provider: "custom-anthropic-proxy",
					baseUrl: "https://proxy.example",
					remoteCompaction: { enabled: true },
				}),
			),
		).toBe(true);
		expect(shouldUseAnthropicNativeCompaction(makeOpenAiModel())).toBe(false);
	});

	test("resolves the endpoint the way the transport does, so an ANTHROPIC_BASE_URL reroute is excluded", async () => {
		const previous = Bun.env.ANTHROPIC_BASE_URL;
		Bun.env.ANTHROPIC_BASE_URL = "https://gateway.example.com";
		try {
			expect(shouldUseAnthropicNativeCompaction(makeAnthropicModel())).toBe(false);
			expect(shouldUseAnthropicNativeCompaction(makeAnthropicModel({ remoteCompaction: { enabled: true } }))).toBe(
				true,
			);
		} finally {
			if (previous === undefined) delete Bun.env.ANTHROPIC_BASE_URL;
			else Bun.env.ANTHROPIC_BASE_URL = previous;
		}
	});

	test("counts as provider-native compaction behind the remote setting", () => {
		expect(shouldUseProviderNativeCompaction(makeAnthropicModel(), { remoteEnabled: true })).toBe(true);
		expect(shouldUseProviderNativeCompaction(makeAnthropicModel(), { remoteEnabled: false })).toBe(false);
	});
});

describe("compact() Anthropic native lane", () => {
	test("compacts through the live-turn request shape and persists the summary as text and replay payload", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple");
		const model = makeAnthropicModel();
		const { calls, completeImpl } = recordingCompleteImpl(() =>
			assistantMessage(model, {
				providerPayload: {
					type: "anthropicCompaction",
					provider: "anthropic",
					content: NATIVE_SUMMARY,
					encryptedContent: "enc_state_1",
				},
				stopDetails: { type: "compaction" },
				usage: { ...ZERO_USAGE, input: 64, output: 2002, cacheRead: 79_000, totalTokens: 81_066 },
			}),
		);
		const preparation = makePreparation();
		preparation.fileOps.read.add("/repo/src/handlers.ts");
		const tools = [
			{
				name: "read",
				description: "Read a file",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: undefined }),
			},
		];

		const result = await compact(preparation, model, "sk-ant-test", "keep the codeword", undefined, {
			completeImpl,
			remoteSystemPrompt: ["You are the live agent."],
			tools,
			extraContext: ["Branch: main"],
		});

		expect(completeSimple).not.toHaveBeenCalled();
		expect(calls).toHaveLength(1);
		const [{ ctx, options }] = calls;
		// The request is the live turn: same system prompt, tools, and every
		// message that would be summarized plus the retained tail.
		expect(ctx.systemPrompt).toEqual(["You are the live agent."]);
		expect(ctx.tools).toBe(tools);
		expect(ctx.messages.map(message => message.content)).toEqual(["long history", "recent"]);
		expect(options.anthropicCompaction?.triggerInputTokens).toBe(50_000);
		expect(options.anthropicCompaction?.pauseAfterCompaction).toBe(true);
		const instructions = options.anthropicCompaction?.instructions ?? "";
		expect(instructions).toContain("<additional-context>\n- Branch: main\n</additional-context>");
		expect(instructions).toContain("## Goal");
		// The retained tail travels for the prompt cache but is scoped out of the
		// summary, by count rather than by quoting its contents.
		expect(instructions.startsWith("SCOPE: The conversation's final user message stays in context verbatim")).toBe(
			true,
		);
		expect(instructions).not.toContain('"recent"');
		expect(instructions).toContain("Summarize ONLY the history before those messages");
		expect(instructions.endsWith("respond with the summary text only.")).toBe(true);
		expect(instructions).toContain("MUST NOT call any tools");

		// The API's summary is the entry text, with the file lists the local
		// summarizer appends. The replay payload stays verbatim so the block
		// matches the opaque state on the next request.
		expect(result.summary).toContain(NATIVE_SUMMARY);
		expect(result.summary).toContain("<files>\n# /repo/src/\nhandlers.ts (Read)\n</files>");
		expect(result.shortSummary).toBe("Remote compaction");
		expect(result.firstKeptEntryId).toBe("kept-1");
		// The API's opaque state travels with the verbatim summary into the
		// entry and back out as the replay payload.
		expect(result.preserveData).toEqual({
			anthropicCompaction: {
				provider: "anthropic",
				content: NATIVE_SUMMARY,
				encryptedContent: "enc_state_1",
				filesText: "<files>\n# /repo/src/\nhandlers.ts (Read)\n</files>",
				model: "claude-fable-5",
				usedTokens: 79_064,
			},
		});
		expect(getAnthropicCompactionPayload(result.preserveData)).toEqual({
			type: "anthropicCompaction",
			provider: "anthropic",
			content: NATIVE_SUMMARY,
			encryptedContent: "enc_state_1",
			filesText: "<files>\n# /repo/src/\nhandlers.ts (Read)\n</files>",
		});
	});

	test("renders the retained-tail scope singular and plural from structured scope", () => {
		const singular = buildAnthropicCompactionInstructions("BASE", undefined, undefined, {
			count: 1,
			role: "user",
		});
		expect(singular.startsWith("SCOPE: The conversation's final user message stays in context verbatim")).toBe(true);

		const plural = buildAnthropicCompactionInstructions("BASE", undefined, undefined, {
			count: 3,
			role: "assistant",
		});
		expect(
			plural.startsWith(
				"SCOPE: The conversation's final 3 messages, starting with a assistant message, stay in context verbatim",
			),
		).toBe(true);
	});

	test("describeRetainedTail counts the trailing pad for assistant-final tails", () => {
		const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
		const assistant = (text: string | undefined): Message => ({
			role: "assistant",
			content: text === undefined ? [] : [{ type: "text", text }],
			provider: "anthropic",
			model: "claude-fable-5",
			api: "anthropic-messages",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: 2,
		});

		// The wire appends a synthetic trailing user message after an
		// assistant turn, which stays verbatim like the rest of the tail.
		expect(describeRetainedTail([user("old"), assistant("new")])).toEqual({ count: 3, role: "user" });
		expect(describeRetainedTail([assistant("only")])).toEqual({ count: 2, role: "assistant" });
		// No pad without a live final turn — and collapsing still applies.
		expect(describeRetainedTail([assistant(undefined)])).toEqual({ count: 1, role: "assistant" });
		// Server-tool blocks serialize unconditionally, so a server-tool-only
		// turn draws the pad too.
		const serverToolAssistant: Message = {
			role: "assistant",
			content: [
				{ type: "anthropicServerTool", block: { type: "server_tool_use", id: "srv_1", name: "web_search" } },
			],
			provider: "anthropic",
			model: "claude-fable-5",
			api: "anthropic-messages",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: 2,
		};
		expect(describeRetainedTail([user("old"), serverToolAssistant])).toEqual({ count: 3, role: "user" });
		expect(describeRetainedTail([])).toBeUndefined();
		// Consecutive tool results still collapse into one wire message.
		const toolResult = (id: string): Message => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: "bytes" }],
			isError: false,
			timestamp: 1,
		});
		expect(describeRetainedTail([toolResult("a"), toolResult("b"), user("next")])).toEqual({
			count: 2,
			role: "user",
		});
	});

	test("leads a follow-up compaction with the previous native summary as its replay payload", async () => {
		const model = makeAnthropicModel();
		const { calls, completeImpl } = recordingCompleteImpl(() =>
			assistantMessage(model, {
				providerPayload: { type: "anthropicCompaction", provider: "anthropic", content: "second summary" },
			}),
		);
		const preparation = makePreparation({
			previousSummary: "first summary",
			previousPreserveData: {
				anthropicCompaction: {
					provider: "anthropic",
					content: "first summary",
					encryptedContent: "enc_state_0",
					filesText: "<files>\n# /repo/src/\nold.ts (Read)\n</files>",
					model: "claude-fable-5",
				},
				appKey: "kept",
			},
		});

		const result = await compact(preparation, model, "sk-ant-test", undefined, undefined, { completeImpl });

		const [{ ctx }] = calls;
		expect(ctx.messages[0]).toMatchObject({
			role: "user",
			providerPayload: {
				type: "anthropicCompaction",
				provider: "anthropic",
				content: "first summary",
				encryptedContent: "enc_state_0",
				filesText: "<files>\n# /repo/src/\nold.ts (Read)\n</files>",
			},
		});
		expect(ctx.messages.slice(1).map(message => message.content)).toEqual(["long history", "recent"]);
		// The stale slot is replaced, unrelated preserve data survives.
		expect(result.preserveData).toEqual({
			appKey: "kept",
			anthropicCompaction: {
				provider: "anthropic",
				content: result.summary,
				model: "claude-fable-5",
				usedTokens: 0,
			},
		});
	});

	test("derives the rewrite marker from the oldest replayed message, not the previous commit", async () => {
		const model = makeAnthropicModel();
		const { calls, completeImpl } = recordingCompleteImpl(() =>
			assistantMessage(model, {
				providerPayload: { type: "anthropicCompaction", provider: "anthropic", content: "second summary" },
			}),
		);
		// Re-retained and re-summarized turns can both predate the previous
		// compaction's commit: the marker must precede every message this
		// request replays, exactly like the live rebuild.
		const preparation = makePreparation({
			messagesToSummarize: [{ role: "user", content: "long history", timestamp: 2000 }],
			recentMessages: [{ role: "user", content: "recent", timestamp: 3000 }],
			previousSummary: "first summary",
			previousSummaryTimestamp: new Date(90_000).toISOString(),
			previousPreserveData: {
				anthropicCompaction: { provider: "anthropic", content: "first summary" },
			},
		});

		await compact(preparation, model, "sk-ant-test", undefined, undefined, { completeImpl });

		const [{ ctx }] = calls;
		const first = ctx.messages[0] as { historyRewriteAt?: number };
		expect(first.historyRewriteAt).toBe(2_000 - 1);
		// The rewrite marker precedes the retained tail, so prefix-bound thinking
		// in the tail is not treated as pre-rewrite and stripped.
		const retained = ctx.messages[ctx.messages.length - 1] as { timestamp: number };
		expect(first.historyRewriteAt).toBeLessThan(retained.timestamp);
	});

	test("summarizes locally below the trigger floor instead of issuing a request that cannot compact", async () => {
		const model = makeAnthropicModel();
		const { calls, completeImpl } = recordingCompleteImpl(() =>
			assistantMessage(model, { content: [{ type: "text", text: "local summary" }] }),
		);
		const preparation = makePreparation({ tokensBefore: ANTHROPIC_COMPACTION_MIN_CONTEXT_TOKENS - 1 });

		const result = await compact(preparation, model, "sk-ant-test", undefined, undefined, { completeImpl });

		expect(calls.every(call => call.options.anthropicCompaction === undefined)).toBe(true);
		expect(calls[0]?.ctx.messages[0]?.content).toMatchObject([{ type: "text" }]);
		expect(result.summary).toContain("local summary");
		expect(result.preserveData).toBeUndefined();
	});

	test("a response without a compaction block is a native failure, never a silent local summary", async () => {
		const completeSimple = vi.spyOn(ai, "completeSimple");
		const model = makeAnthropicModel();
		const { calls, completeImpl } = recordingCompleteImpl(() =>
			assistantMessage(model, { content: [{ type: "text", text: "the model answered instead" }] }),
		);

		await expect(
			compact(makePreparation(), model, "sk-ant-test", undefined, undefined, { completeImpl }),
		).rejects.toBeInstanceOf(NativeCompactionError);
		expect(calls).toHaveLength(1);
		expect(completeSimple).not.toHaveBeenCalled();
	});

	test("an abort during the native request propagates as the abort, not as a native failure", async () => {
		const model = makeAnthropicModel();
		const controller = new AbortController();
		const { completeImpl } = recordingCompleteImpl(() => {
			controller.abort();
			throw new AIError.AbortError();
		});

		await expect(
			compact(makePreparation(), model, "sk-ant-test", undefined, controller.signal, { completeImpl }),
		).rejects.toBeInstanceOf(AIError.AbortError);
	});

	test("a resolved aborted response is the abort too: completeSimple reports cancellation as a message", async () => {
		const model = makeAnthropicModel();
		const controller = new AbortController();
		const { completeImpl } = recordingCompleteImpl(() => {
			controller.abort();
			return assistantMessage(model, { stopReason: "aborted", errorMessage: "Request was aborted" });
		});

		await expect(
			compact(makePreparation(), model, "sk-ant-test", undefined, controller.signal, { completeImpl }),
		).rejects.toBeInstanceOf(AIError.AbortError);
	});

	test("a resolved error response keeps its HTTP status for downstream classification", async () => {
		const model = makeAnthropicModel();
		const { completeImpl } = recordingCompleteImpl(() =>
			assistantMessage(model, { stopReason: "error", errorMessage: "invalid x-api-key", errorStatus: 401 }),
		);

		const failure = await compact(makePreparation(), model, "sk-ant-test", undefined, undefined, {
			completeImpl,
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(NativeCompactionError);
		const cause = (failure as NativeCompactionError).cause;
		expect(cause).toBeInstanceOf(AIError.ProviderHttpError);
		expect((cause as AIError.ProviderHttpError).status).toBe(401);
		expect(AIError.is(AIError.classify(cause), AIError.Flag.AuthFailed)).toBe(true);
	});

	test("honors the caller's oneshot retry opt-out: one full-context attempt, then the native failure", async () => {
		const model = makeAnthropicModel();
		const { calls, completeImpl } = recordingCompleteImpl(() => {
			throw new AIError.ProviderHttpError("overloaded_error", 529);
		});

		await expect(
			compact(makePreparation(), model, "sk-ant-test", undefined, undefined, { completeImpl, oneshotRetry: false }),
		).rejects.toBeInstanceOf(NativeCompactionError);
		expect(calls).toHaveLength(1);

		// The same transient failure retries under the default policy, so the
		// single attempt above is the opt-out at work, not an unretryable error.
		calls.length = 0;
		await expect(
			compact(makePreparation(), model, "sk-ant-test", undefined, undefined, { completeImpl }),
		).rejects.toBeInstanceOf(NativeCompactionError);
		expect(calls.length).toBeGreaterThan(1);
	});

	test("carries a prior snapcompact archive once, inside the previous summary", async () => {
		const model = makeAnthropicModel();
		const { calls, completeImpl } = recordingCompleteImpl(() =>
			assistantMessage(model, {
				providerPayload: { type: "anthropicCompaction", provider: "anthropic", content: "after archive" },
			}),
		);
		const archiveText = "ARCHIVE-SENTINEL-7f3a";
		const preparation = makePreparation({
			previousSummary: "snapcompact lead-in",
			previousPreserveData: {
				[snapcompact.PRESERVE_KEY]: {
					frames: [],
					totalChars: archiveText.length,
					truncatedChars: 0,
					text: archiveText,
				},
			},
		});

		const result = await compact(preparation, model, "sk-ant-test", undefined, undefined, { completeImpl });

		const wire = JSON.stringify(calls[0]?.ctx.messages);
		expect(wire.split(archiveText).length - 1).toBe(1);
		expect(calls[0]?.ctx.messages.map(message => message.role)).toEqual(["user", "user", "user"]);
		expect(result.preserveData).toEqual({
			anthropicCompaction: {
				provider: "anthropic",
				content: result.summary,
				model: "claude-fable-5",
				usedTokens: 0,
			},
		});
	});
});

describe("native compaction entries read back", () => {
	test("a native summary stays readable by every model and keeps its retained tail", () => {
		const ts = (n: number) => new Date(n).toISOString();
		const preserveData = withAnthropicCompactionPreserveData(undefined, {
			provider: "anthropic",
			content: "native summary text",
		});
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: ts(1),
				message: { role: "user", content: "summarized away", timestamp: 1 },
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: ts(2),
				message: { role: "user", content: "retained tail", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "m2",
				timestamp: ts(3),
				summary: "native summary text",
				firstKeptEntryId: "m2",
				tokensBefore: 100_000,
				preserveData,
			},
			{
				type: "message",
				id: "m3",
				parentId: "c1",
				timestamp: ts(4),
				message: { role: "user", content: "after compaction", timestamp: 4 },
			},
		];
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };

		// Unlike an opaque OpenAI replay blob, the text summary is portable.
		expect(remotePreserveReusable(preserveData, makeOpenAiModel(), settings)).toBe(true);
		expect(remotePreserveReusable(preserveData, makeAnthropicModel(), settings)).toBe(true);

		const next = prepareCompaction(entries, settings, makeOpenAiModel());
		expect(next?.previousSummary).toBe("native summary text");
		expect(next?.previousSummaryTimestamp).toBe(ts(3));
		// The retained tail lives in entries (like a local summary), so the next
		// compaction re-reads it from `firstKeptEntryId` rather than from the payload.
		expect(next?.messagesToSummarize.map(message => ("content" in message ? message.content : undefined))).toEqual([
			"retained tail",
		]);
		expect(next?.recentMessages.map(message => ("content" in message ? message.content : undefined))).toEqual([
			"after compaction",
		]);
	});
});
