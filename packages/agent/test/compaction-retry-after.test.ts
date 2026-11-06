/**
 * A compaction step that fails throws an Error rebuilt from the failed
 * AssistantMessage. The session's compaction retry reads the failure's header
 * retry wait from that Error's headers (`getHeadersFromError`), never from its
 * text, so the message's structured `errorRetryAfterMs` must travel onto it —
 * for summarization (`createSummarizationError`) and for Anthropic native
 * compaction alike, with and without an HTTP status.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type AnthropicNativeCompactionRequest,
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoff,
	requestAnthropicNativeCompaction,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "@oh-my-pi/pi-ai/utils/retry-after";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

/** A body that names a shorter wait than the header did. */
const BODY_TEXT = "usage_limit_reached retry-after-ms=200";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
} as ModelSpec<"anthropic-messages">);

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function response(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: 1,
		provider: model.provider,
		model: model.id,
		api: model.api,
		usage,
		stopReason: "error",
		errorMessage: BODY_TEXT,
		...overrides,
	};
}

function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [
			{ role: "user", content: "history msg", timestamp: 1 },
			response({ stopReason: "stop", errorMessage: undefined, content: [{ type: "text", text: "ok" }] }),
		],
		turnPrefixMessages: [],
		recentMessages: [{ role: "user", content: "recent msg", timestamp: 2 }],
		isSplitTurn: false,
		tokensBefore: 12_345,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
	};
}

const handoffMessages: AgentMessage[] = [{ role: "user", content: "begin", timestamp: 1 }];

const nativeRequest: AnthropicNativeCompactionRequest = {
	context: { systemPrompt: ["Audit."], messages: [{ role: "user", content: "Audit.", timestamp: 1 }] },
	instructions: "Summarize.",
	maxTokens: 1024,
};

/** The header wait a consumer reads from a thrown compaction failure. */
function thrownWaitMs(error: unknown): number | undefined {
	return getRetryAfterMsFromHeaders(getHeadersFromError(error));
}

/** Summarize as the session's compaction loop does: it retries the whole attempt itself, so no inner one-shot retry. */
function summarize(): Promise<unknown> {
	return compact(preparation(), model, "key", undefined, undefined, { oneshotRetry: false }).catch(err => err);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compaction failures carry the failed response's header retry wait", () => {
	test("summarization with an HTTP status", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ errorStatus: 429, errorRetryAfterMs: 9000 }));

		const error = await summarize();

		expect(error).toHaveProperty("message", expect.stringContaining("Summarization failed"));
		expect(error).toHaveProperty("status", 429);
		expect(thrownWaitMs(error)).toBe(9000);
	});

	test("summarization without an HTTP status", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ errorRetryAfterMs: 9000 }));

		const error = await summarize();

		expect(error).toHaveProperty("message", expect.stringContaining("Summarization failed"));
		expect(error).not.toHaveProperty("status");
		expect(thrownWaitMs(error)).toBe(9000);
	});

	test("handoff generation", async () => {
		// Past the handoff one-shot's 30 s cap, so it surfaces the failure instead of sleeping it out.
		vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ errorStatus: 429, errorRetryAfterMs: 60_000 }));

		const error = await generateHandoff(handoffMessages, model, "key", { systemPrompt: ["sp"], tools: [] }).catch(
			err => err,
		);

		expect(error).toHaveProperty("message", expect.stringContaining("Handoff generation failed"));
		expect(thrownWaitMs(error)).toBe(60_000);
	});

	test("leaves the wait unset when the failed response named none", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ errorStatus: 429 }));

		const error = await summarize();

		expect(error).toBeInstanceOf(Error);
		expect(thrownWaitMs(error)).toBeUndefined();
	});

	test("Anthropic native compaction, from a real 429's Retry-After through the provider", async () => {
		const fetch = async () =>
			new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: BODY_TEXT } }), {
				status: 429,
				// Past the provider's own retry cap, so it surfaces the failure at once.
				headers: { "content-type": "application/json", "retry-after": "86400" },
			});

		const error = await requestAnthropicNativeCompaction(model, "sk-ant-test", nativeRequest, undefined, {
			fetch,
			telemetry: undefined,
		}).catch(err => err);

		expect(error).toHaveProperty("message", expect.stringContaining("Anthropic compaction failed"));
		expect(error).toHaveProperty("status", 429);
		expect(thrownWaitMs(error)).toBe(86_400_000);
	});

	test("Anthropic native compaction without an HTTP status", async () => {
		const completeImpl = async () => response({ errorRetryAfterMs: 9000 });

		const error = await requestAnthropicNativeCompaction(model, "sk-ant-test", nativeRequest, undefined, {
			completeImpl,
			telemetry: undefined,
		}).catch(err => err);

		expect(error).toHaveProperty("message", expect.stringContaining("Anthropic compaction failed"));
		expect(error).not.toHaveProperty("status");
		expect(thrownWaitMs(error)).toBe(9000);
	});
});
