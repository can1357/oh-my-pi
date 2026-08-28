import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { OPENCODE_HEADERS } from "@oh-my-pi/pi-catalog/wire/github-copilot";

afterEach(() => {
	vi.restoreAllMocks();
});

function makeCopilotClaudeModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		headers: { ...OPENCODE_HEADERS },
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	});
}

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

/**
 * Copilot's transient response when a request lands on a fleet replica that
 * does not yet support a model advertised by `/models`.
 */
const FLEET_SKEW_BODY = {
	error: {
		message: "The requested model is not supported by this fleet replica.",
		code: "model_not_supported",
		param: "model",
		type: "invalid_request_error",
	},
};

const SSE_EVENTS = [
	{
		type: "message_start",
		message: {
			id: "msg_fleet",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4.6",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 7, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "second try" } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 3 },
	},
	{ type: "message_stop" },
];

function sseResponse(): Response {
	const body = `${SSE_EVENTS.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n")}\n`;
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("GitHub Copilot Anthropic fleet skew", () => {
	it("retries the model-availability 400 and completes on the next replica", async () => {
		let attempts = 0;
		const fetchMock = vi.fn(async () => {
			attempts += 1;
			if (attempts === 1) {
				return new Response(JSON.stringify(FLEET_SKEW_BODY), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
			return sseResponse();
		});

		const result = await streamAnthropic(makeCopilotClaudeModel(), testContext, {
			apiKey: "ghu_test_copilot_token",
			fetch: fetchMock as unknown as typeof fetch,
			providerRetryWait: async () => {},
		}).result();

		expect(attempts).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toMatchObject([{ type: "text", text: "second try" }]);
		// Billing is per user prompt, not per wire attempt: a turn that burned an
		// extra gateway-rejected attempt must still report one premium request.
		expect(result.usage.premiumRequests).toBe(1);
	});

	it("surfaces fleet-skew guidance once every retry lands on a stale replica", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify(FLEET_SKEW_BODY), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const result = await streamAnthropic(makeCopilotClaudeModel(), testContext, {
			apiKey: "ghu_test_copilot_token",
			fetch: fetchMock as unknown as typeof fetch,
			providerRetryWait: async () => {},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("only part of its fleet");
		// Every attempt is a fresh wire request, not a replayed promise.
		expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
	});
});
