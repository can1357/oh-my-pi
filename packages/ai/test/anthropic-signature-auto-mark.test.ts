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
 * Regression for #4297 — the anthropic-messages transport auto-heals the very
 * first `400 Invalid signature in thinking block` from an unmarked custom
 * signing proxy: demote every unsigned thinking block in the request, retry
 * once, and pin the (baseUrl, modelId) as signing in the session state so
 * subsequent turns skip the demotion round-trip.
 */

const model: Model<"anthropic-messages"> = buildModel({
	id: "cf-anthropic/claude-opus-4-8",
	name: "Claude Opus 4.8 via cloudflared",
	api: "anthropic-messages",
	provider: "cf-anthropic",
	baseUrl: "https://opencode.cloudflare.dev/anthropic",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const prefixModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-fable-5-1",
	name: "Claude Fable 5.1",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});

const priorTurnContext: Context = {
	messages: [
		{ role: "user", content: "Summarize README", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Read the file, then summarise.", thinkingSignature: "" },
				{ type: "text", text: "The README covers the CLI." },
			],
			api: "anthropic-messages",
			provider: "cf-anthropic",
			model: "cf-anthropic/claude-opus-4-8",
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

const prefixBoundContext: Context = {
	messages: [
		{ role: "user", content: "Inspect the repository.", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "sig_bound" },
				{ type: "text", text: "I inspected it." },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: prefixModel.id,
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
		{ role: "user", content: "Continue.", timestamp: 0 },
	] satisfies Message[],
};

function createSignatureRejection(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block"},"request_id":"req_test"}',
	);
	Object.assign(error, { status: 400 });
	return error;
}

/**
 * Bedrock-backed anthropic-messages proxies reject the same `signature: ""`
 * replay in schema validation instead of the signature check, so the wording is
 * a missing required field rather than an invalid signature.
 */
function createBedrockSignatureRejection(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"ValidationException","message":"The model returned the following errors: messages.1.content.0.thinking.signature: Field required"}}',
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

function createPrefixBindingRejection(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."},"request_id":"req_test"}',
	);
	Object.assign(error, { status: 400 });
	return error;
}

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

function readReplayUnsignedThinkingDisabled(map: Map<string, ProviderSessionState>): boolean | undefined {
	for (const [key, value] of map) {
		if (!key.startsWith("anthropic-messages")) continue;
		if (typeof value !== "object" || value === null) continue;
		if (!("replayUnsignedThinkingDisabled" in value)) continue;
		const flag = value.replayUnsignedThinkingDisabled;
		return typeof flag === "boolean" ? flag : undefined;
	}
	return undefined;
}

describe("#4297 anthropic-messages runtime signing auto-mark", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("demotes unsigned thinking, retries, and pins the session on the first signing 400", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const capturedPayloads: unknown[] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			capturedPayloads.push(params);
			if (attempt === 1) {
				return {
					async withResponse() {
						throw createSignatureRejection();
					},
				} as never;
			}
			return successRequest() as never;
		});

		const stream = streamAnthropic(model, priorTurnContext, {
			apiKey: "sk-ant-test",
			providerSessionState,
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();

		const firstAttemptBlocks = extractPriorAssistantBlocks(capturedPayloads[0]);
		const firstThinking = firstAttemptBlocks.find(block => block.type === "thinking");
		expect(firstThinking?.signature).toBe("");
		expect(firstThinking?.thinking).toBe("Read the file, then summarise.");

		const retryBlocks = extractPriorAssistantBlocks(capturedPayloads[1]);
		expect(retryBlocks.find(block => block.type === "thinking")).toBeUndefined();
		const demotedText = retryBlocks.find(block => block.type === "text");
		expect(demotedText?.text).toContain("Read the file, then summarise.");

		expect(readReplayUnsignedThinkingDisabled(providerSessionState)).toBe(true);
		expect(result.disabledFeatures).toContain("unsigned-thinking-replay");
	});

	it("also heals the Bedrock missing-signature wording", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const capturedPayloads: unknown[] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			capturedPayloads.push(params);
			if (attempt === 1) {
				return {
					async withResponse() {
						throw createBedrockSignatureRejection();
					},
				} as never;
			}
			return successRequest() as never;
		});

		const stream = streamAnthropic(model, priorTurnContext, {
			apiKey: "sk-ant-test",
			providerSessionState,
		});
		for await (const _ of stream) {
			/* drain */
		}
		const result = await stream.result();

		expect(attempt).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();

		const retryBlocks = extractPriorAssistantBlocks(capturedPayloads[1]);
		expect(retryBlocks.find(block => block.type === "thinking")).toBeUndefined();
		expect(retryBlocks.find(block => block.type === "text")?.text).toContain("Read the file, then summarise.");
		expect(readReplayUnsignedThinkingDisabled(providerSessionState)).toBe(true);
	});

	it("pre-demotes unsigned thinking on subsequent turns once the session is pinned", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const capturedPayloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			capturedPayloads.push(params);
			return successRequest() as never;
		});

		// Seed the session state as though a prior turn had already auto-marked
		// the endpoint. This mirrors the shape produced by the runtime retry so
		// subsequent turns never repeat the 400 round-trip.
		providerSessionState.set(`anthropic-messages:${model.baseUrl}\u0000${model.id}`, {
			close: () => {},
			strictToolsDisabled: false,
			fastModeDisabled: false,
			replayUnsignedThinkingDisabled: true,
		} as ProviderSessionState);

		const stream = streamAnthropic(model, priorTurnContext, {
			apiKey: "sk-ant-test",
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
		expect(blocks.find(block => block.type === "text")?.text).toContain("Read the file, then summarise.");
		expect(result.disabledFeatures).toContain("unsigned-thinking-replay");
	});

	it("remembers prefix-binding drops so later turns avoid another failed request", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const capturedPayloads: unknown[] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			capturedPayloads.push(params);
			if (attempt === 1) {
				return {
					async withResponse() {
						throw createPrefixBindingRejection();
					},
				} as never;
			}
			return successRequest() as never;
		});

		const run = async () => {
			const stream = streamAnthropic(prefixModel, prefixBoundContext, {
				apiKey: "sk-ant-test",
				providerSessionState,
			});
			for await (const _ of stream) {
				/* drain */
			}
			return stream.result();
		};

		expect((await run()).stopReason).toBe("stop");
		expect(attempt).toBe(2);
		expect(extractPriorAssistantBlocks(capturedPayloads[0]).some(block => block.type === "thinking")).toBe(true);
		expect(extractPriorAssistantBlocks(capturedPayloads[1]).some(block => block.type === "thinking")).toBe(false);

		expect((await run()).stopReason).toBe("stop");
		expect(attempt).toBe(3);
		expect(extractPriorAssistantBlocks(capturedPayloads[2]).some(block => block.type === "thinking")).toBe(false);
	});

	it("surfaces prefix-binding errors when the caller requests fail-loud behavior", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return {
				async withResponse() {
					throw createPrefixBindingRejection();
				},
			} as never;
		});

		const stream = streamAnthropic(prefixModel, prefixBoundContext, {
			apiKey: "sk-ant-test",
			providerSessionState,
			anthropicPrefixMismatchBehavior: "error",
		});
		for await (const _ of stream) {
			/* drain */
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("bound to a different conversation");
	});

	it("does not auto-mark on unrelated Anthropic invalid_request_error 400s", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return {
				async withResponse() {
					const error = new Error(
						'400 {"type":"error","error":{"type":"invalid_request_error","message":"Some other validation failure"},"request_id":"req_test"}',
					);
					Object.assign(error, { status: 400 });
					throw error;
				},
			} as never;
		});

		const stream = streamAnthropic(model, priorTurnContext, {
			apiKey: "sk-ant-test",
			providerSessionState,
		});
		for await (const _ of stream) {
			/* drain */
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Some other validation failure");
		expect(readReplayUnsignedThinkingDisabled(providerSessionState)).toBe(false);
	});
});
