import { describe, expect, test, vi } from "bun:test";
import { loginVolcengineAgentPlan } from "@oh-my-pi/pi-ai/registry/volcengine-agent-plan";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, FetchImpl, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { VOLCENGINE_AGENT_PLAN_STATIC_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { VOLCENGINE_AGENT_PLAN_BASE_URL } from "@oh-my-pi/pi-catalog/wire/volcengine-agent-plan";

const context: Context = {
	messages: [{ role: "user", content: "Reply with OK", timestamp: 1 }],
};

function sseResponse(api: "responses" | "chat"): Response {
	const events =
		api === "responses"
			? [
					{ type: "response.created", response: { id: "resp_test" } },
					{
						type: "response.completed",
						response: {
							id: "resp_test",
							status: "completed",
							output: [],
							usage: {
								input_tokens: 1,
								output_tokens: 1,
								total_tokens: 2,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				]
			: [
					{
						id: "chat_test",
						object: "chat.completion.chunk",
						created: 1,
						model: "kimi-k2.7-code",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
					"[DONE]",
				];
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, { headers: { "Content-Type": "text/event-stream" } });
}

function responseModel(id: string): Model<"openai-responses"> {
	const spec = VOLCENGINE_AGENT_PLAN_STATIC_MODELS.find(
		(model): model is Extract<typeof model, { api: "openai-responses" }> =>
			model.id === id && model.api === "openai-responses",
	);
	if (!spec) throw new Error(`Missing Agent Plan Responses model fixture: ${id}`);
	return buildModel(spec);
}

function chatModel(id: string): Model<"openai-completions"> {
	const spec = VOLCENGINE_AGENT_PLAN_STATIC_MODELS.find(
		(model): model is Extract<typeof model, { api: "openai-completions" }> =>
			model.id === id && model.api === "openai-completions",
	);
	if (!spec) throw new Error(`Missing Agent Plan Chat model fixture: ${id}`);
	return buildModel(spec);
}

describe("Volcengine Ark Agent Plan", () => {
	test("validates the dedicated key without starting inference", async () => {
		const fetchMock: FetchImpl = Object.assign(
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				expect(url).toBe(`${VOLCENGINE_AGENT_PLAN_BASE_URL}/responses`);
				expect(init?.method).toBe("POST");
				expect(init?.body).toBe("{}");
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer agent-plan-key");
				return new Response(
					JSON.stringify({ error: { code: "MissingParameter", message: "missing model", type: "Bad Request" } }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}),
			{ preconnect: fetch.preconnect },
		);

		const key = await loginVolcengineAgentPlan({
			onPrompt: async () => "  agent-plan-key  ",
			fetch: fetchMock,
		});

		expect(key).toBe("agent-plan-key");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("rejects invalid credentials instead of accepting arbitrary 400 responses", async () => {
		const fetchMock: FetchImpl = Object.assign(
			async () =>
				new Response(JSON.stringify({ error: { code: "InvalidParameter" } }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				}),
			{ preconnect: fetch.preconnect },
		);
		await expect(loginVolcengineAgentPlan({ onPrompt: async () => "bad-key", fetch: fetchMock })).rejects.toThrow(
			"InvalidParameter",
		);
	});

	test("surfaces 401 authentication failures", async () => {
		const fetchMock: FetchImpl = Object.assign(
			async () =>
				new Response(JSON.stringify({ error: { code: "AuthenticationError" } }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
			{ preconnect: fetch.preconnect },
		);
		await expect(loginVolcengineAgentPlan({ onPrompt: async () => "bad-key", fetch: fetchMock })).rejects.toThrow(
			"401",
		);
	});
	test("rewrites MiniMax M2.7 Responses controls on the outgoing payload", async () => {
		const model = responseModel("minimax-m2.7");
		let url = "";
		let payload: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				url = input instanceof Request ? input.url : String(input);
				payload = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
				return sseResponse("responses");
			},
			{ preconnect: fetch.preconnect },
		);
		await streamSimple(model, context, {
			apiKey: "test-key",
			reasoning: Effort.High,
			include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
			fetch: fetchMock,
		}).result();

		expect(url).toBe(`${VOLCENGINE_AGENT_PLAN_BASE_URL}/responses`);
		expect(payload?.reasoning).toBeUndefined();
		expect(payload?.include).toEqual(["message.output_text.logprobs"]);
		expect(payload?.thinking).toEqual({ type: "enabled" });
	});

	test("uses Chat Completions with preserved reasoning for Kimi K2.7 Code", async () => {
		const model = chatModel("kimi-k2.7-code");
		let url = "";
		let payload: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				url = input instanceof Request ? input.url : String(input);
				payload = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
				return sseResponse("chat");
			},
			{ preconnect: fetch.preconnect },
		);
		await streamSimple(model, context, {
			apiKey: "test-key",
			reasoning: Effort.High,
			fetch: fetchMock,
		}).result();

		expect(url).toBe(`${VOLCENGINE_AGENT_PLAN_BASE_URL}/chat/completions`);
		expect(payload?.model).toBe("kimi-k2.7-code");
		expect(payload?.reasoning_effort).toBe("high");
		expect(payload?.max_completion_tokens).toBe(32_000);
	});

	test("replays Kimi reasoning and tool result on the second Chat turn", async () => {
		const model = chatModel("kimi-k2.7-code");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "I must call lookup_weather.", thinkingSignature: "reasoning_content" },
				{ type: "toolCall", id: "call_weather", name: "lookup_weather", arguments: { city: "Paris" } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_weather",
			toolName: "lookup_weather",
			content: [{ type: "text", text: "Sunny, 24C" }],
			isError: false,
			timestamp: 3,
		};
		let payload: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				payload = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
				return sseResponse("chat");
			},
			{ preconnect: fetch.preconnect },
		);
		await streamSimple(
			model,
			{ messages: [context.messages[0]!, assistant, result] },
			{
				apiKey: "test-key",
				reasoning: Effort.High,
				fetch: fetchMock,
			},
		).result();

		const messages = payload?.messages as Array<Record<string, unknown>>;
		const replay = messages.find(message => message.role === "assistant");
		expect(replay?.reasoning_content).toBe("I must call lookup_weather.");
		expect(replay?.tool_calls).toEqual([
			expect.objectContaining({
				id: "call_weather",
				function: { name: "lookup_weather", arguments: '{"city":"Paris"}' },
			}),
		]);
		expect(messages.find(message => message.role === "tool")).toMatchObject({
			tool_call_id: "call_weather",
			content: "Sunny, 24C",
		});
	});

	test("replays Responses function call and output on the second turn", async () => {
		const model = responseModel("doubao-seed-2.1-turbo");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call_weather|fc_weather", name: "lookup_weather", arguments: { city: "Paris" } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_weather|fc_weather",
			toolName: "lookup_weather",
			content: [{ type: "text", text: "Sunny, 24C" }],
			isError: false,
			timestamp: 3,
		};
		let payload: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				payload = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
				return sseResponse("responses");
			},
			{ preconnect: fetch.preconnect },
		);
		await streamSimple(
			model,
			{ messages: [context.messages[0]!, assistant, result] },
			{
				apiKey: "test-key",
				fetch: fetchMock,
			},
		).result();

		const input = payload?.input as Array<Record<string, unknown>>;
		expect(input).toContainEqual({
			type: "function_call",
			call_id: "call_weather",
			name: "lookup_weather",
			arguments: '{"city":"Paris"}',
		});
		expect(input).toContainEqual({ type: "function_call_output", call_id: "call_weather", output: "Sunny, 24C" });
	});
});
