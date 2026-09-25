import { afterEach, describe, expect, it, vi } from "bun:test";
import { clearCopilotIntegrationCache } from "@oh-my-pi/pi-ai/providers/github-copilot-headers";
import { applyCopilotUsage } from "@oh-my-pi/pi-ai/providers/github-copilot-usage";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model, Usage } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

afterEach(() => {
	clearCopilotIntegrationCache();
	vi.restoreAllMocks();
});

const testContext: Context = {
	messages: [{ role: "user", content: "Reply with the single word: ok", timestamp: Date.now() }],
};
const apiKey = JSON.stringify({
	token: "ghu_test_copilot_token",
	apiEndpoint: "https://api.individual.githubcopilot.com",
});

const COPILOT_USAGE = { total_nano_aiu: 1_711_400_000 };

function sse(events: Array<{ event?: string; data: unknown }>): Response {
	const body = events
		.map(
			({ event, data }) =>
				`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
		)
		.join("");
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function responsesStream(copilotUsage?: unknown): Response {
	const response = {
		id: "resp_1",
		object: "response",
		status: "completed",
		model: "gpt-5.4-mini",
		output: [
			{
				id: "msg_1",
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "ok", annotations: [] }],
			},
		],
		usage: {
			input_tokens: 13,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 5,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 18,
		},
	};
	const item = response.output[0];
	return sse([
		{
			event: "response.created",
			data: {
				type: "response.created",
				sequence_number: 0,
				response: { ...response, status: "in_progress", output: [] },
			},
		},
		{
			event: "response.output_item.added",
			data: {
				type: "response.output_item.added",
				sequence_number: 1,
				output_index: 0,
				item: { ...item, status: "in_progress", content: [] },
			},
		},
		{
			event: "response.output_text.delta",
			data: {
				type: "response.output_text.delta",
				sequence_number: 2,
				item_id: "msg_1",
				output_index: 0,
				content_index: 0,
				delta: "ok",
			},
		},
		{
			event: "response.output_item.done",
			data: { type: "response.output_item.done", sequence_number: 3, output_index: 0, item },
		},
		{
			event: "response.completed",
			data: {
				type: "response.completed",
				sequence_number: 4,
				response,
				...(copilotUsage === undefined ? {} : { copilot_usage: copilotUsage }),
			},
		},
	]);
}

function completionsStream(copilotUsage?: unknown): Response {
	const base = { id: "chatcmpl-1", created: 1790215872, model: "gpt-4.1-2025-04-14" };
	return sse([
		{ data: { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] } },
		{
			data: {
				...base,
				choices: [{ index: 0, finish_reason: "stop", delta: { content: null } }],
				usage: {
					completion_tokens: 1,
					prompt_tokens: 14,
					prompt_tokens_details: { cached_tokens: 0 },
					total_tokens: 15,
				},
				...(copilotUsage === undefined ? {} : { copilot_usage: copilotUsage }),
			},
		},
		{ data: "[DONE]" },
	]);
}

function anthropicStream(copilotUsage?: unknown): Response {
	return sse([
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: "msg_1",
					model: "claude-haiku-4.5",
					usage: { input_tokens: 12, output_tokens: 0 },
				},
			},
		},
		{
			event: "content_block_start",
			data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 2 },
				...(copilotUsage === undefined ? {} : { copilot_usage: copilotUsage }),
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	]);
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("applyCopilotUsage", () => {
	it("records a reported zero rather than dropping it", () => {
		const usage = emptyUsage();
		applyCopilotUsage({ provider: "github-copilot" }, usage, { ...COPILOT_USAGE, total_nano_aiu: 0 });
		expect(usage.aiu).toBe(0);
		expect(usage.credits).toBeUndefined();
	});

	it("ignores other providers and malformed payloads", () => {
		for (const [provider, payload] of [
			["openai", COPILOT_USAGE],
			["github-copilot", undefined],
			["github-copilot", null],
			["github-copilot", { total_nano_aiu: "1711400000" }],
			["github-copilot", { total_nano_aiu: -1 }],
			["github-copilot", { token_details: [] }],
		] as const) {
			const usage = emptyUsage();
			applyCopilotUsage({ provider }, usage, payload);
			expect(usage.aiu).toBeUndefined();
		}
	});
});

describe("GitHub Copilot server-reported AIU", () => {
	it("captures copilot_usage from the Responses terminal event", async () => {
		const fetchMock = vi.fn(async () => responsesStream(COPILOT_USAGE));
		const model = getBundledModel("github-copilot", "gpt-5.4-mini") as Model<"openai-responses">;
		const result = await streamOpenAIResponses(model, testContext, {
			apiKey,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(13);
		expect(result.usage.output).toBe(5);
		expect(result.usage.aiu).toBeCloseTo(1.7114, 10);
		// AIU is kept apart from the locally derived meters.
		expect(result.usage.premiumRequests).toBeDefined();
		expect(result.usage.cost.total).toBeGreaterThan(0);
	});

	it("captures copilot_usage from the final Chat Completions chunk", async () => {
		const fetchMock = vi.fn(async () => completionsStream(COPILOT_USAGE));
		const model = getBundledModel("github-copilot", "gpt-4.1") as Model<"openai-completions">;
		const result = await streamOpenAICompletions(model, testContext, {
			apiKey,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(14);
		expect(result.usage.aiu).toBeCloseTo(1.7114, 10);
	});

	it("captures copilot_usage from the Anthropic message_delta event", async () => {
		const fetchMock = vi.fn(async () => anthropicStream(COPILOT_USAGE));
		const model = getBundledModel("github-copilot", "claude-haiku-4.5") as Model<"anthropic-messages">;
		const result = await streamAnthropic(model, testContext, {
			apiKey,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(12);
		expect(result.usage.output).toBe(2);
		expect(result.usage.aiu).toBeCloseTo(1.7114, 10);
	});
});
