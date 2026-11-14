import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Captured v4 format; its header deliberately has no serving-model field.
const SIGNATURE = "CAQStgYKEAgRGAI4AUIIdGhpbmtpbmcSDCgdRY6PL4pRWmAaPxoMkEErP6SIhmUZXydSIjDBUTSM41Hv";
const model = buildModel({
	id: "signature-model",
	name: "Signature model",
	provider: "signature-provider",
	api: "anthropic-messages",
	baseUrl: "http://localhost/anthropic",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

function thinkingResponse(startSignature: string, signatureDeltas: readonly string[]): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "signed-start",
				type: "message",
				role: "assistant",
				model: model.id,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "thinking", thinking: "", signature: startSignature },
		},
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Preserve signed bytes." } },
		...signatureDeltas.map(signature => ({
			type: "content_block_delta",
			index: 0,
			delta: { type: "signature_delta", signature },
		})),
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Complete." } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Anthropic thinking signatures", () => {
	it.each([
		// First-party shape: an empty block-start signature, then fragmented deltas.
		{
			name: "native deltas after an empty block start",
			startSignature: "",
			deltas: [SIGNATURE.slice(0, 30), SIGNATURE.slice(30)],
		},
		{ name: "a block-start signature with no deltas", startSignature: SIGNATURE, deltas: [] },
		{ name: "native deltas over a block-start signature", startSignature: "discarded", deltas: [SIGNATURE] },
	])("keeps the signature from $name", async ({ startSignature, deltas }) => {
		const context: Context = { messages: [{ role: "user", content: "Think and reply.", timestamp: 0 }] };
		const message = await streamAnthropic(model, context, {
			apiKey: "local-test-key",
			thinkingEnabled: true,
			fetch: async () => thinkingResponse(startSignature, deltas),
		}).result();
		expect(message.content[0]).toMatchObject({ type: "thinking", thinkingSignature: SIGNATURE });
	});
});
