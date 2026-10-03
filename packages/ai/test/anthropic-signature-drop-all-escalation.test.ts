import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	ProviderSessionState,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Regression for the failover-proxy death loop: a gateway that routes a
 * conversation across upstreams (or silently falls back mid-conversation)
 * mints thinking signatures the restored upstream rejects on replay. Every
 * replayed block is *signed*, so the #4297 unsigned-demotion retry resends an
 * identical body and the session 400s forever. The transport must escalate to
 * dropping replayed thinking entirely — prior-turn reasoning is optional
 * context — succeed on the next attempt, and pin the (baseUrl, modelId) so
 * subsequent turns skip the doomed round-trips.
 */

const model: Model<"anthropic-messages"> = buildModel({
	id: "work2/claude-fable-5-1",
	name: "Fable 5.1 (W2)",
	api: "anthropic-messages",
	provider: "work2",
	baseUrl: "https://dev.work2.im",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const foreignSignedContext: Context = {
	messages: [
		{ role: "user", content: "Summarize README", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Read the file, then summarise.",
					thinkingSignature: "sig_minted_by_upstream_a",
				},
				{ type: "redactedThinking", data: "oppo_by_upstream_a" },
				{ type: "text", text: "The README covers the CLI." },
			],
			api: "anthropic-messages",
			provider: "work2",
			model: "work2/claude-fable-5-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		} satisfies AssistantMessage,
		{ role: "user", content: "Translate to French.", timestamp: 0 },
	] satisfies Message[],
};

function createSignatureRejection(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block"},"request_id":"req_test"}',
	);
	Object.assign(error, { status: 400 });
	return error;
}

interface AnthropicWireBlock {
	type: string;
	thinking?: string;
	text?: string;
	signature?: string;
}
interface AnthropicWireMessage {
	role: string;
	content: AnthropicWireBlock[] | string;
}
interface CapturedRequestPayload {
	messages?: AnthropicWireMessage[];
}
function extractPriorAssistantBlocks(params: unknown): AnthropicWireBlock[] {
	if (!params || typeof params !== "object" || !("messages" in params)) return [];
	const { messages } = params as CapturedRequestPayload;
	if (!Array.isArray(messages)) return [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		if (typeof msg.content === "string") continue;
		return msg.content;
	}
	return [];
}

const successEvents = [
	{
		type: "message_start",
		message: {
			id: "msg_ok",
			usage: {
				input_tokens: 12,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bonjour." } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: {
			input_tokens: 12,
			output_tokens: 4,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
	},
	{ type: "message_stop" },
] as const;

function successRequest() {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_ok" } });
	return {
		async withResponse() {
			return {
				data: (async function* () {
					for (const event of successEvents) {
						yield event;
					}
				})(),
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

function readThinkingReplayDisabled(map: Map<string, ProviderSessionState>): boolean | undefined {
	for (const [key, value] of map) {
		if (!key.startsWith("anthropic-messages")) continue;
		if (typeof value !== "object" || value === null) continue;
		if (!("thinkingReplayDisabled" in value)) continue;
		const flag = value.thinkingReplayDisabled;
		return typeof flag === "boolean" ? flag : undefined;
	}
	return undefined;
}

describe("anthropic-messages foreign-signed thinking escalation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops replayed thinking after the unsigned-demotion retry fails and succeeds", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const capturedPayloads: unknown[] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			capturedPayloads.push(params);
			if (extractPriorAssistantBlocks(params).some(block => block.type === "thinking")) {
				return {
					async withResponse() {
						throw createSignatureRejection();
					},
				} as never;
			}
			return successRequest() as never;
		});

		const stream = streamAnthropic(model, foreignSignedContext, {
			apiKey: "sk-test",
			providerSessionState,
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(3);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();

		// The first two attempts replay the foreign-signed block unchanged —
		// the unsigned-demotion retry has nothing to demote.
		for (const payload of capturedPayloads.slice(0, 2)) {
			const thinking = extractPriorAssistantBlocks(payload).find(block => block.type === "thinking");
			expect(thinking?.signature).toBe("sig_minted_by_upstream_a");
		}

		// The escalation attempt replays no thinking at all, but keeps the
		// visible assistant text so the conversation stays coherent.
		const escalatedBlocks = extractPriorAssistantBlocks(capturedPayloads[2]);
		expect(escalatedBlocks.find(block => block.type === "thinking")).toBeUndefined();
		expect(escalatedBlocks.find(block => block.type === "redacted_thinking")).toBeUndefined();
		expect(escalatedBlocks.find(block => block.type === "text")?.text).toBe("The README covers the CLI.");

		expect(readThinkingReplayDisabled(providerSessionState)).toBe(true);
		expect(result.disabledFeatures).toContain("thinking-replay");
	});

	it("surfaces the failure after the escalation instead of retrying forever", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return {
				async withResponse() {
					throw createSignatureRejection();
				},
			} as never;
		});

		const stream = streamAnthropic(model, foreignSignedContext, {
			apiKey: "sk-test",
			providerSessionState,
		});
		for await (const _ of stream) {
			/* drain */
		}
		const result = await stream.result();

		expect(attempt).toBe(3);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid `signature` in `thinking` block");
	});

	it("pre-drops replayed thinking on subsequent turns once the session is pinned", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const capturedPayloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			capturedPayloads.push(params);
			return successRequest() as never;
		});

		// Seed the session state as though a prior turn had already escalated.
		// This mirrors the shape produced by the runtime retry so subsequent
		// turns never repeat the two doomed 400 round-trips.
		providerSessionState.set(`anthropic-messages:${model.baseUrl}\u0000${model.id}`, {
			close: () => {},
			strictToolsDisabled: false,
			fastModeDisabled: false,
			replayUnsignedThinkingDisabled: false,
			thinkingReplayDisabled: true,
		} as ProviderSessionState);

		const stream = streamAnthropic(model, foreignSignedContext, {
			apiKey: "sk-test",
			providerSessionState,
		});
		for await (const _ of stream) {
			/* drain */
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(capturedPayloads.length).toBe(1);
		const blocks = extractPriorAssistantBlocks(capturedPayloads[0]);
		expect(blocks.find(block => block.type === "thinking")).toBeUndefined();
		expect(blocks.find(block => block.type === "redacted_thinking")).toBeUndefined();
		expect(blocks.find(block => block.type === "text")?.text).toBe("The README covers the CLI.");
		expect(result.disabledFeatures).toContain("thinking-replay");
	});
});
