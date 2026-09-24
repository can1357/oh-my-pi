import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { AssistantMessage, Context, Message, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

/**
 * A `drop_block` request that the API answers with an `input_transformations`
 * report has already survived the prefix mismatch: the server dropped the
 * bound thinking blocks itself and will do so again on every replay. Mirroring
 * that drop client-side removed the blocks from every later request, which
 * rewrote the cached prefix from that message forward. The mirror is now
 * reserved for the 400 path, where omitting the blocks is what gets the retry
 * through.
 */

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-fable-5-1",
	name: "Fable 5.1",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});

const boundThinkingContext: Context = {
	messages: [
		{ role: "user", content: "Summarize README", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Read the file, then summarise.",
					thinkingSignature: "sig_bound_to_old_prefix",
				},
				{ type: "redactedThinking", data: "redacted_bound_to_old_prefix" },
				{ type: "text", text: "The README covers the CLI." },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5-1",
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

const DROPPED_AT_FIRST_THINKING = [
	{ type: "thinking_dropped", reason: "prefix_binding_mismatch", path: "messages.1.content.0" },
];

interface WireBlock {
	type: string;
	signature?: string;
	data?: string;
	text?: string;
}
interface WirePayload {
	messages?: Array<{ role: string; content: WireBlock[] | string }>;
	thinking?: { type: string; block_binding?: { prefix_mismatch_behavior: string } };
}

function priorAssistantBlocks(payload: unknown): WireBlock[] {
	const messages = (payload as WirePayload).messages ?? [];
	const assistant = messages.find(msg => msg.role === "assistant");
	return assistant && typeof assistant.content !== "string" ? assistant.content : [];
}

function successRequest(inputTransformations?: unknown) {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_ok",
				...(inputTransformations ? { input_transformations: inputTransformations } : {}),
				usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bonjour." } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
	const response = new Response(null, { status: 200, headers: { "request-id": "req_ok" } });
	return {
		async withResponse() {
			return {
				data: (async function* () {
					for (const event of events) yield event;
				})(),
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

function prefixBindingRejection(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \\"drop_block\\"."},"request_id":"req_test"}',
	);
	Object.assign(error, { status: 400 });
	return error;
}

async function runTurn(providerSessionState: Map<string, ProviderSessionState>): Promise<AssistantMessage> {
	const stream = streamAnthropic(model, boundThinkingContext, {
		apiKey: "sk-test",
		providerSessionState,
		thinkingEnabled: true,
		reasoning: Effort.High,
	});
	for await (const _ of stream) {
		/* drain */
	}
	return stream.result();
}

describe("anthropic-messages prefix-dropped thinking bookkeeping", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps replaying blocks the API dropped under drop_block so the wire prefix stays byte-stable", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const payloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			return successRequest(payloads.length === 1 ? DROPPED_AT_FIRST_THINKING : undefined) as never;
		});

		const first = await runTurn(providerSessionState);
		expect(first.stopReason).toBe("stop");
		expect(first.inputTransformations).toEqual(DROPPED_AT_FIRST_THINKING);
		expect((payloads[0] as WirePayload).thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });

		const second = await runTurn(providerSessionState);
		expect(second.stopReason).toBe("stop");
		expect(payloads).toHaveLength(2);

		const replayed = priorAssistantBlocks(payloads[1]);
		expect(replayed.find(block => block.type === "thinking")?.signature).toBe("sig_bound_to_old_prefix");
		expect(replayed.find(block => block.type === "redacted_thinking")?.data).toBe("redacted_bound_to_old_prefix");
		expect(JSON.stringify((payloads[1] as WirePayload).messages)).toBe(
			JSON.stringify((payloads[0] as WirePayload).messages),
		);
	});

	it("still omits bound thinking for good after a prefix-binding 400", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const payloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			if (payloads.length === 1) {
				return {
					async withResponse() {
						throw prefixBindingRejection();
					},
				} as never;
			}
			return successRequest() as never;
		});

		const first = await runTurn(providerSessionState);
		expect(first.stopReason).toBe("stop");
		expect(first.errorMessage).toBeUndefined();
		expect(payloads).toHaveLength(2);

		const second = await runTurn(providerSessionState);
		expect(second.stopReason).toBe("stop");
		expect(payloads).toHaveLength(3);

		for (const payload of payloads.slice(1)) {
			const blocks = priorAssistantBlocks(payload);
			expect(blocks.find(block => block.type === "thinking")).toBeUndefined();
			expect(blocks.find(block => block.type === "redacted_thinking")).toBeUndefined();
			expect(blocks.find(block => block.type === "text")?.text).toBe("The README covers the CLI.");
		}
	});
});
