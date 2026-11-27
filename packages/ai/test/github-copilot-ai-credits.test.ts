import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { parseCopilotUsageFrame } from "@oh-my-pi/pi-ai/providers/github-copilot-billing";
import type { ResponseStreamEvent } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { processResponsesStream, resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { COPILOT_API_HEADERS, rememberCopilotTokenBilling } from "@oh-my-pi/pi-catalog/wire/github-copilot";

afterEach(() => {
	vi.restoreAllMocks();
});

// Frame shape captured from api.business.githubcopilot.com (issue #20667).
const COPILOT_USAGE = {
	token_details: [
		{
			batch_size: 1_000_000,
			cost_per_batch: 200_000_000_000,
			model: "claude-sonnet-5.5",
			token_count: 2,
			token_type: "input",
		},
		{
			batch_size: 1_000_000,
			cost_per_batch: 10_000_000_000,
			model: "claude-sonnet-5.5",
			token_count: 27_694,
			token_type: "cache_read",
		},
		{
			batch_size: 1_000_000,
			cost_per_batch: 250_000_000_000,
			model: "claude-sonnet-5.5",
			token_count: 225,
			token_type: "cache_write",
		},
		{
			batch_size: 1_000_000,
			cost_per_batch: 1_000_000_000_000,
			model: "claude-sonnet-5.5",
			token_count: 103,
			token_type: "output",
		},
	],
	total_nano_aiu: 436_590_000,
};

function makeOutput(provider: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		provider,
		model: "gpt-test",
		api: "openai-responses",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function makeResponsesModel(provider: string): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "GPT Test",
		id: "gpt-test",
		provider,
		baseUrl: "https://api.githubcopilot.com",
		contextWindow: 8192,
		maxTokens: 2048,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function makeCopilotCompletionsModel(provider: string = "github-copilot"): Model<"openai-completions"> {
	return buildModel({
		api: "openai-completions",
		name: "GPT Test",
		id: "gpt-test",
		provider,
		baseUrl: "https://api.githubcopilot.com",
		...(provider === "github-copilot" ? { headers: { ...COPILOT_API_HEADERS } } : {}),
		contextWindow: 8192,
		maxTokens: 2048,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

async function* eventsOf(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const event of events) yield event as ResponseStreamEvent;
}

async function runResponses(provider: string, terminal: Record<string, unknown>): Promise<AssistantMessage> {
	const output = makeOutput(provider);
	await processResponsesStream(
		eventsOf([
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
				},
				...terminal,
			},
		]),
		output,
		new AssistantMessageEventStream(),
		makeResponsesModel(provider),
	);
	return output;
}

describe("parseCopilotUsageFrame", () => {
	it("returns the server total and a per-type split that sums to it", () => {
		const aiu = parseCopilotUsageFrame(COPILOT_USAGE);
		expect(aiu?.nano).toBe(436_590_000);
		const split = aiu?.nanoByType;
		expect(split).toEqual({ input: 400_000, cacheRead: 276_940_000, cacheWrite: 56_250_000, output: 103_000_000 });
		expect((split?.input ?? 0) + (split?.cacheRead ?? 0) + (split?.cacheWrite ?? 0) + (split?.output ?? 0)).toBe(
			436_590_000,
		);
	});

	it("treats a frame without a valid total as unknown, never zero", () => {
		expect(parseCopilotUsageFrame(undefined)).toBeUndefined();
		expect(parseCopilotUsageFrame({ token_details: [] })).toBeUndefined();
		expect(parseCopilotUsageFrame({ total_nano_aiu: "436590000" })).toBeUndefined();
		expect(parseCopilotUsageFrame({ total_nano_aiu: -1 })).toBeUndefined();
	});

	it("keeps the total and skips malformed token rows", () => {
		const aiu = parseCopilotUsageFrame({
			total_nano_aiu: 5,
			token_details: [
				{ token_type: "output", token_count: 1, cost_per_batch: 5, batch_size: 0 },
				{ token_type: "audio" },
			],
		});
		expect(aiu).toEqual({ nano: 5 });
	});
});

describe("Responses: copilot_usage on response.completed", () => {
	it("records the billing frame for github-copilot", async () => {
		const output = await runResponses("github-copilot", { copilot_usage: COPILOT_USAGE });
		expect(output.usage.aiu?.nano).toBe(436_590_000);
		// Token accounting from `response.usage` is untouched by the frame.
		expect(output.usage.input).toBe(4);
		expect(output.usage.output).toBe(2);
	});

	it("leaves aiu absent when the server sent no frame", async () => {
		const output = await runResponses("github-copilot", {});
		expect(output.usage.aiu).toBeUndefined();
	});

	it("ignores the field on other providers", async () => {
		const output = await runResponses("openai", { copilot_usage: COPILOT_USAGE });
		expect(output.usage.aiu).toBeUndefined();
	});

	it("marks a finished reply without a frame as missing one, and a framed reply not", async () => {
		const completed = (terminal: Record<string, unknown>) =>
			streamOpenAIResponses(makeResponsesModel("github-copilot"), context, {
				apiKey: "ghu_test",
				fetch: vi.fn(async () =>
					sse([
						{
							type: "response.completed",
							response: {
								id: "resp_1",
								status: "completed",
								output: [],
								usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
							},
							...terminal,
						},
					]),
				) as unknown as typeof fetch,
			}).result();

		const frameless = await completed({});
		expect(frameless.usage.aiu).toBeUndefined();
		expect(frameless.usage.aiuMissing).toBe(true);
		const framed = await completed({ copilot_usage: COPILOT_USAGE });
		expect(framed.usage.aiu?.nano).toBe(436_590_000);
		expect(framed.usage.aiuMissing).toBeUndefined();
	});

	it("marks a reply that streamed text and then dropped before its terminal event", async () => {
		// Responses reports tokens only on the terminal event, so the dropped reply carries none.
		const result = await streamOpenAIResponses(makeResponsesModel("github-copilot"), context, {
			apiKey: "ghu_test",
			fetch: vi.fn(async () =>
				sse([
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
					},
					{
						type: "response.content_part.added",
						item_id: "msg_1",
						output_index: 0,
						content_index: 0,
						part: { type: "output_text", text: "", annotations: [] },
					},
					{
						type: "response.output_text.delta",
						item_id: "msg_1",
						output_index: 0,
						content_index: 0,
						delta: "partial answer",
					},
				]),
			) as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.usage.totalTokens).toBe(0);
		expect(result.content.length).toBeGreaterThan(0);
		expect(result.usage.aiuMissing).toBe(true);
	});
});

function sse(events: Array<Record<string, unknown>>): Response {
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function makeCopilotClaudeModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-5.5",
		name: "Claude Sonnet 5.5",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		headers: { ...COPILOT_API_HEADERS },
		reasoning: false,
		input: ["text"],
		cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	});
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

function messagesStream(messageDelta: Record<string, unknown>): Response {
	return sse([
		{
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5.5",
				content: [],
				stop_reason: null,
				usage: {
					input_tokens: 2,
					output_tokens: 1,
					cache_read_input_tokens: 27_694,
					cache_creation_input_tokens: 225,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		messageDelta,
		{ type: "message_stop" },
	]);
}

describe("Messages: copilot_usage on message_delta", () => {
	it("records the billing frame without disturbing token usage", async () => {
		const fetchMock = vi.fn(async () =>
			messagesStream({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 103 },
				copilot_usage: COPILOT_USAGE,
			}),
		);
		const result = await streamAnthropic(makeCopilotClaudeModel(), context, {
			apiKey: "ghu_test",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.usage.aiu?.nano).toBe(436_590_000);
		expect(result.usage.output).toBe(103);
		expect(result.usage.cacheRead).toBe(27_694);
	});

	it("leaves aiu absent when the reply carries no billing frame", async () => {
		const fetchMock = vi.fn(async () =>
			messagesStream({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
		);
		const result = await streamAnthropic(makeCopilotClaudeModel(), context, {
			apiKey: "ghu_test",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.usage.aiu).toBeUndefined();
		// Recorded as a missed frame, unlike a transcript from before the frame was read.
		expect(result.usage.aiuMissing).toBe(true);
	});

	it("does not mark a request that failed before any token", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { message: "bad request" } }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const result = await streamAnthropic(makeCopilotClaudeModel(), context, {
			apiKey: "ghu_test",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.usage.totalTokens).toBe(0);
		expect(result.usage.aiuMissing).toBeUndefined();
	});
});

describe("premium-request estimate follows the account's billing mode", () => {
	const delta = { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } };
	async function reply(tokenBasedBilling: boolean | undefined, messageDelta: Record<string, unknown>) {
		const apiKey = JSON.stringify({
			token: "ghu_test",
			...(tokenBasedBilling === undefined ? {} : { tokenBasedBilling }),
		});
		const fetchMock = vi.fn(async () => messagesStream(messageDelta));
		return streamAnthropic(makeCopilotClaudeModel(), context, {
			apiKey,
			fetch: fetchMock as unknown as typeof fetch,
		}).result();
	}

	it("drops the estimate on a token-billed account even when the reply's frame is missing", async () => {
		const result = await reply(true, delta);
		expect(result.usage.premiumRequests).toBeUndefined();
		expect(result.usage.aiu).toBeUndefined();
		expect(result.usage.aiuMissing).toBe(true);
	});

	it("keeps the estimate on a request-billed account even when the reply carries a frame", async () => {
		const result = await reply(false, { ...delta, copilot_usage: COPILOT_USAGE });
		expect(result.usage.premiumRequests).toBe(1);
		expect(result.usage.aiu?.nano).toBe(436_590_000);
	});

	it("keeps the estimate while the billing mode is unknown", async () => {
		const result = await reply(undefined, { ...delta, copilot_usage: COPILOT_USAGE });
		expect(result.usage.premiumRequests).toBe(1);
	});

	it("applies the same rule to Responses and Chat Completions requests", () => {
		for (const model of [makeResponsesModel("github-copilot"), makeCopilotCompletionsModel()]) {
			const estimate = (tokenBasedBilling: boolean) =>
				resolveOpenAIRequestSetup(model, {
					apiKey: JSON.stringify({ token: "ghu_test", tokenBasedBilling }),
					messages: context.messages,
				}).copilotPremiumRequests;
			expect(estimate(true)).toBeUndefined();
			expect(estimate(false)).toBe(1);
		}
	});

	it("drops the estimate for a bare token whose account was learned as token-billed", () => {
		const estimate = () =>
			resolveOpenAIRequestSetup(makeCopilotCompletionsModel(), {
				apiKey: "ghu_bare_env_token",
				messages: context.messages,
			}).copilotPremiumRequests;
		expect(estimate()).toBe(1);
		rememberCopilotTokenBilling("ghu_bare_env_token", true);
		expect(estimate()).toBeUndefined();
	});
});

function chatCompletionsSse(chunks: Array<Record<string, unknown>>): Response {
	const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function runCopilotCompletions(
	chunks: Array<Record<string, unknown>>,
	provider: string = "github-copilot",
): Promise<AssistantMessage> {
	const fetchMock = vi.fn(async () => chatCompletionsSse(chunks));
	return streamOpenAICompletions(makeCopilotCompletionsModel(provider), context, {
		apiKey: "ghu_test",
		fetch: fetchMock as unknown as typeof fetch,
	}).result();
}

describe("Chat Completions on Copilot (endpoint never captured, not marked reports-aiu)", () => {
	const id = "chatcmpl_1";
	const tokenUsage = {
		prompt_tokens: 4,
		completion_tokens: 2,
		total_tokens: 6,
		prompt_tokens_details: { cached_tokens: 1 },
	};

	it("finishes on the token-usage chunk and records no credits, so no frame is awaited or reported", async () => {
		const output = await runCopilotCompletions([
			{ id, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
			{ id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: tokenUsage },
			{ id, choices: [], copilot_usage: COPILOT_USAGE },
		]);

		expect(output.stopReason).toBe("stop");
		expect(output.usage.input).toBe(3);
		expect(output.usage.output).toBe(2);
		expect(output.usage.aiu).toBeUndefined();
	});
});
