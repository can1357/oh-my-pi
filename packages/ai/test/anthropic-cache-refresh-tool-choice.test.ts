import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AnthropicMessagesClientLike } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * #12597 — a zero-output Anthropic cache-refresh request inherits the caller's
 * pinned `tool_choice`. Anthropic rejects `tool_choice: tool|any` paired with
 * `max_tokens: 0` (400 invalid_request_error), so a forced-yield turn whose
 * cache-refresh replay carried `tool_choice: {type:"tool", name:"_yield"}`
 * died on a 400 instead of yielding.
 *
 * The refresh request generates zero output by definition, so a pinned
 * tool_choice is meaningless on it — and tool_choice is not part of the
 * prompt-cache key (system/tools/messages are), so dropping it cannot miss
 * the cache the refresh is meant to warm.
 */

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const context: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "partial findings so far…", timestamp: Date.now() }],
};

interface CapturedParams {
	max_tokens?: number;
	stream?: boolean;
	tool_choice?: { type: string; name?: string };
}

function textSuccessEvents(): Record<string, unknown>[] {
	return [
		{
			type: "message_start",
			message: { id: "msg_text", usage: { input_tokens: 12, output_tokens: 0 } },
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 12, output_tokens: 1 } },
		{ type: "message_stop" },
	];
}

function captureClient(): { client: AnthropicMessagesClientLike; captured: () => CapturedParams | undefined } {
	let capturedParams: CapturedParams | undefined;
	const client = {
		messages: {
			create(params: unknown) {
				capturedParams = params as CapturedParams;
				// The provider picks the request shape by the methods exposed:
				// asResponse → raw-SSE path, withResponse → SDK stream path. Expose
				// only the one matching the call: the zero-output refresh is
				// non-streaming (max_tokens 0 / stream false), the rest stream.
				const isRefresh = capturedParams.max_tokens === 0 || capturedParams.stream === false;
				if (isRefresh) {
					return {
						async asResponse() {
							return new Response(
								JSON.stringify({ id: "msg_refresh", usage: { input_tokens: 10, output_tokens: 0 } }),
								{ headers: { "content-type": "application/json" } },
							);
						},
					};
				}
				return {
					async withResponse() {
						const events = textSuccessEvents();
						return {
							data: {
								async *[Symbol.asyncIterator]() {
									for (const event of events) yield event;
								},
							},
							response: new Response(null, { status: 200, headers: { "request-id": "req_mock" } }),
							request_id: "req_mock",
						};
					},
				};
			},
		},
	} as unknown as AnthropicMessagesClientLike;
	return { client, captured: () => capturedParams };
}

describe("Anthropic zero-output cache refresh", () => {
	it("strips a pinned tool_choice from the refresh request (#12597)", async () => {
		const { client, captured } = captureClient();
		const stream = streamAnthropic(model, context, {
			client,
			anthropicCacheRefreshRequest: true,
			toolChoice: { type: "tool", name: "_yield" },
		});
		for await (const event of stream) void event;

		const params = captured();
		expect(params?.max_tokens).toBe(0);
		expect(params?.tool_choice).toBeUndefined();
	});

	it("keeps tool_choice on the normal (non-refresh) path", async () => {
		// Control: without the refresh flag the pinned choice must still reach
		// the wire — the strip is scoped to zero-output refreshes only.
		const { client, captured } = captureClient();
		const stream = streamAnthropic(model, context, {
			client,
			toolChoice: { type: "tool", name: "_yield" },
		});
		for await (const event of stream) void event;

		expect(captured()?.tool_choice).toEqual({ type: "tool", name: "_yield" });
	});
});
