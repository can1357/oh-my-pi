/**
 * The Anthropic thinking signature is an opaque blob to us except for one
 * cleartext header field naming the model that produced the block. These pin
 * the parsing boundary against real wire bytes: a substitution detector that
 * misreads the header would either miss a swapped model or accuse an honest
 * one.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import {
	servedModelFromAnthropicSignature,
	servedModelFromOpenRouterReasoning,
} from "@oh-my-pi/pi-ai/providers/anthropic-signature";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Captured from OpenRouter → "Claude Platform on AWS" for anthropic/claude-opus-5 (2026-09-15).
const OPUS_5_SIGNATURE =
	"CAISnAIKrgEIERgCKkBun5aw4pp8OwMcmPih8WPkWUcibrzQ8Jg5AooTtYTxb4OGtHksxfgAiCJWYNO0xqC4zVwgAFZ0nU0+5/QoKQStMg1jbGF1ZGUtb3B1cy01OAFCCHRoaW5raW5nWiQ0YzBmMDQ2Zi0yNWZkLTQ1ZmItYmZiMy1hMDhhOGUyNDljYTd6HnVwcm9mXzAxMUNlUVRqY1ZkV2lES1F4d0Zlc3BldqgBndWi1QYSDDfLtFY9SutE7G2OLhoMvcDeJZgBIoqoYb4IIjBvpyKZu6JlaYZEy4cKXscU+OxzGZkpQapVraxYNEwKypi+Dbvz9FD2bO0yHjFhi5kqGwmcLJKipAse80nNfJfANbVYCqh6yW6HgnkXAxgB";
// Captured from api.anthropic.com for claude-fable-5-1: the v4 outer format
// whose header carries no model id.
const FABLE_5_1_V4_SIGNATURE = "CAQStgYKEAgRGAI4AUIIdGhpbmtpbmcSDCgdRY6PL4pRWmAaPxoMkEErP6SIhmUZXydSIjDBUTSM41Hv";
// OpenAI Responses `encrypted_content` (Fernet), never an Anthropic header.
const OPENAI_FERNET = "gAAAAABqqKjDeKWwGqlnw3QcNkzoMW4FNSSRdQoIAE2cBvpWtJW1CeF8SOHqZawrG5ebwSua9tWKUhWydIlL";

describe("servedModelFromAnthropicSignature", () => {
	it("recovers the serving model id from a current-format signature", () => {
		expect(servedModelFromAnthropicSignature(OPUS_5_SIGNATURE)).toBe("claude-opus-5");
	});

	it("yields nothing for a v4 signature whose header omits the model", () => {
		expect(servedModelFromAnthropicSignature(FABLE_5_1_V4_SIGNATURE)).toBeUndefined();
	});

	it("yields nothing for foreign or malformed blobs instead of a bogus id", () => {
		expect(servedModelFromAnthropicSignature(OPENAI_FERNET)).toBeUndefined();
		expect(servedModelFromAnthropicSignature("not base64 at all!!")).toBeUndefined();
		expect(servedModelFromAnthropicSignature("")).toBeUndefined();
	});

	it("reads only OpenRouter items that forward an Anthropic signature", () => {
		expect(
			servedModelFromOpenRouterReasoning({
				type: "reasoning.text",
				format: "anthropic-claude-v1",
				signature: OPUS_5_SIGNATURE,
			}),
		).toBe("claude-opus-5");
		expect(
			servedModelFromOpenRouterReasoning({
				type: "reasoning.text",
				format: "google-gemini-v1",
				signature: OPUS_5_SIGNATURE,
			}),
		).toBeUndefined();
		expect(servedModelFromOpenRouterReasoning({ type: "reasoning.encrypted", data: OPENAI_FERNET })).toBeUndefined();
	});
});

const sonnetModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-5",
	name: "Claude Sonnet 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
});

const context: Context = {
	messages: [{ role: "user", content: "17*23?", timestamp: Date.now() }],
};

function createMockRequest(events: Record<string, unknown>[]) {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
	const stream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: response.headers.get("request-id") };
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic stream served-model recovery", () => {
	it("stamps upstreamModel from the signed thinking block while model stays the requested id", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				createMockRequest([
					{
						type: "message_start",
						message: { id: "msg_x", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 0 } },
					},
					{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "391" } },
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "signature_delta", signature: OPUS_5_SIGNATURE },
					},
					{ type: "content_block_stop", index: 0 },
					{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "391" } },
					{ type: "content_block_stop", index: 1 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
					{ type: "message_stop" },
				]) as never,
		);

		const s = streamAnthropic(sonnetModel, context, { apiKey: "sk-ant-test" });
		for await (const _ of s) {
			// drain
		}
		const message = await s.result();

		expect(message.model).toBe("claude-sonnet-5");
		expect(message.upstreamModel).toBe("claude-opus-5");
	});
});
