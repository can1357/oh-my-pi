import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	OpenAICompat,
	StreamOptions,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const context: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "ping", timestamp: 0 }],
};

function createSseResponse(
	usage: Record<string, unknown> = {
		input_tokens: 1,
		output_tokens: 1,
		total_tokens: 2,
		input_tokens_details: { cached_tokens: 0 },
	},
): Response {
	return new Response(
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", content: [] },
		})}\n\n` +
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}\n\n` +
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n` +
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
			})}\n\n` +
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage,
				},
			})}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}
function createChatDoneResponse(): Response {
	return new Response(
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n` +
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
			`data: [DONE]\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function buildOpenRouterModel(
	overrides: Partial<ModelSpec<"openrouter">> = {},
	compat?: OpenAICompat,
): Model<"openrouter"> {
	return buildModel({
		id: "anthropic/claude-haiku-latest",
		name: "Claude Haiku via OpenRouter",
		api: "openrouter",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 131_072,
		compat,
		...overrides,
	} as ModelSpec<"openrouter">);
}

function buildOpenRouterResponsesModel(
	overrides: Partial<ModelSpec<"openai-responses">> = {},
): Model<"openai-responses"> {
	return buildModel({
		id: "anthropic/claude-haiku-latest",
		name: "Claude Haiku via OpenRouter Responses",
		api: "openai-responses",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 131_072,
		...overrides,
	} as ModelSpec<"openai-responses">);
}
async function capturePseudoChatRequest(
	model: Model<"openrouter">,
	options: Omit<StreamOptions, "apiKey"> & {
		reasoning?: Effort;
		disableReasoning?: boolean;
		openrouterVariant?: string;
	} = {},
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		return createChatDoneResponse();
	});

	const stream = streamOpenAICompletions(model as unknown as Model<"openai-completions">, context, {
		apiKey: "test-key",
		...options,
		fetch: fetchMock,
	});
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	expect(fetchMock).toHaveBeenCalledTimes(1);
	if (!body) throw new Error("Expected captured OpenRouter chat request");
	return body;
}

async function capturePseudoResponsesRequest(
	model: Model<"openrouter">,
	options: Omit<StreamOptions, "apiKey"> & {
		reasoning?: Effort;
		disableReasoning?: boolean;
		openrouterVariant?: string;
	} = {},
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		return createSseResponse();
	});

	const stream = streamOpenAIResponses(model as unknown as Model<"openai-responses">, context, {
		apiKey: "test-key",
		...options,
		fetch: fetchMock,
	});
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	expect(fetchMock).toHaveBeenCalledTimes(1);
	if (!body) throw new Error("Expected captured OpenRouter Responses request");
	return body;
}

async function captureRequest<TApi extends "openrouter" | "openai-responses">(
	model: Model<TApi>,
	options: Omit<StreamOptions, "apiKey"> & {
		reasoning?: Effort;
		disableReasoning?: boolean;
		openrouterVariant?: string;
	} = {},
): Promise<{ body: Record<string, unknown>; headers: Headers }> {
	let body: Record<string, unknown> | undefined;
	let headers: Headers | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		headers = new Headers(init?.headers);
		return createSseResponse();
	});

	const stream = streamSimple(model, context, { apiKey: "test-key", ...options, fetch: fetchMock });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	expect(fetchMock).toHaveBeenCalledTimes(1);
	if (!body || !headers) throw new Error("Expected captured OpenRouter Responses request");
	return { body, headers };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OpenRouter pseudo API dual-surface request parity", () => {
	it("builds equivalent Anthropic reasoning payloads for chat and Responses", async () => {
		const routing = { only: ["anthropic"], order: ["anthropic", "openai"] };
		const model = buildOpenRouterModel(
			{ id: "anthropic/claude-fable-5", name: "Claude Fable 5", reasoning: true },
			{ openRouterRouting: routing },
		);

		const chatBody = await capturePseudoChatRequest(model, {
			openrouterVariant: "nitro",
			reasoning: Effort.High,
			sessionId: "workflow-123",
		});
		const responsesBody = await capturePseudoResponsesRequest(model, {
			openrouterVariant: "nitro",
			reasoning: Effort.High,
			sessionId: "workflow-123",
		});

		expect(chatBody).toEqual({
			model: "anthropic/claude-fable-5:nitro",
			messages: [
				{ role: "system", content: "Stay concise." },
				{
					role: "user",
					content: [{ type: "text", text: "ping", cache_control: { type: "ephemeral" } }],
				},
			],
			stream: true,
			stream_options: { include_usage: true },
			store: false,
			reasoning: { effort: "high" },
			provider: routing,
		});
		expect(responsesBody).toEqual({
			model: "anthropic/claude-fable-5:nitro",
			instructions: "Stay concise.",
			stream: true,
			input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
			store: false,
			reasoning: { effort: "high", summary: "auto" },
			prompt_cache_key: "workflow-123",
			session_id: "workflow-123",
			provider: routing,
			include: ["reasoning.encrypted_content"],
			cache_control: { type: "ephemeral" },
		});
		expect(chatBody).not.toHaveProperty("max_tokens");
		expect(chatBody).not.toHaveProperty("max_completion_tokens");
		expect(responsesBody).not.toHaveProperty("max_output_tokens");
	});

	it("builds equivalent non-Anthropic reasoning payloads for chat and Responses", async () => {
		const routing = { order: ["deepseek", "openai"] };
		const model = buildOpenRouterModel(
			{ id: "deepseek/deepseek-r1", name: "DeepSeek R1", reasoning: true },
			{ openRouterRouting: routing },
		);

		const chatBody = await capturePseudoChatRequest(model, {
			openrouterVariant: "nitro",
			reasoning: Effort.High,
			sessionId: "workflow-456",
		});
		const responsesBody = await capturePseudoResponsesRequest(model, {
			openrouterVariant: "nitro",
			reasoning: Effort.High,
			sessionId: "workflow-456",
		});

		expect(chatBody).toEqual({
			model: "deepseek/deepseek-r1:nitro",
			messages: [
				{ role: "system", content: "Stay concise." },
				{ role: "user", content: "ping" },
			],
			stream: true,
			stream_options: { include_usage: true },
			store: false,
			reasoning: { effort: "high" },
			provider: routing,
		});
		expect(responsesBody).toEqual({
			model: "deepseek/deepseek-r1:nitro",
			instructions: "Stay concise.",
			stream: true,
			input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
			store: false,
			reasoning: { effort: "high", summary: "auto" },
			prompt_cache_key: "workflow-456",
			session_id: "workflow-456",
			provider: routing,
			include: ["reasoning.encrypted_content"],
		});
		expect(chatBody).not.toHaveProperty("max_tokens");
		expect(chatBody).not.toHaveProperty("max_completion_tokens");
		expect(responsesBody).not.toHaveProperty("max_output_tokens");
	});

	it("keeps stop and frequency penalty on Chat Completions but drops them for Responses", async () => {
		const model = buildOpenRouterModel();
		const options = {
			stopSequences: ["</stop>"],
			frequencyPenalty: 0.75,
		};

		const chatBody = await capturePseudoChatRequest(model, options);
		const responsesBody = await capturePseudoResponsesRequest(model, options);

		expect(chatBody.stop).toBe("</stop>");
		expect(chatBody.frequency_penalty).toBe(0.75);
		expect(responsesBody).not.toHaveProperty("stop");
		expect(responsesBody).not.toHaveProperty("frequency_penalty");
	});
});

describe("OpenRouter Responses request shape", () => {
	it("uses OpenRouter's reported account charge instead of the catalog estimate", async () => {
		const providerCost = 0.73;
		const fetchMock: FetchImpl = vi.fn(async () =>
			createSseResponse({
				input_tokens: 1_000_000,
				output_tokens: 100_000,
				total_tokens: 1_100_000,
				input_tokens_details: { cached_tokens: 0 },
				cost: providerCost,
			}),
		);
		const stream = streamOpenAIResponses(
			buildOpenRouterResponsesModel({
				cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
			}),
			context,
			{ apiKey: "test-key", fetch: fetchMock },
		);
		let message: AssistantMessage | undefined;
		for await (const event of stream) {
			if (event.type === "done") {
				message = event.message;
				break;
			}
			if (event.type === "error") throw event.error;
		}
		if (!message) throw new Error("Expected completed OpenRouter response");

		expect(message.usage.cost.total).toBe(providerCost);
		const componentTotal =
			message.usage.cost.input +
			message.usage.cost.output +
			message.usage.cost.cacheRead +
			message.usage.cost.cacheWrite;
		expect(componentTotal).toBeCloseTo(providerCost);
	});

	it("appends openrouterVariant only when the resolved model id has no variant after the final slash", async () => {
		const suffixed = await captureRequest(buildOpenRouterResponsesModel(), { openrouterVariant: "nitro" });
		expect(suffixed.body.model).toBe("anthropic/claude-haiku-latest:nitro");

		const explicit = await captureRequest(
			buildOpenRouterResponsesModel({ id: "anthropic/claude-haiku-latest:online" }),
			{ openrouterVariant: "nitro" },
		);
		expect(explicit.body.model).toBe("anthropic/claude-haiku-latest:online");
	});

	it("resolves pseudo OpenRouter API compat and preserves provider routing in the Responses body", async () => {
		const routing = { only: ["anthropic"], order: ["anthropic", "openai"] };
		const pseudoModel = buildOpenRouterModel({}, { openRouterRouting: routing });
		expect(pseudoModel.compat.openRouterRouting).toEqual(routing);

		const { body } = await captureRequest(buildOpenRouterResponsesModel({ compat: { openRouterRouting: routing } }));
		expect(body.provider).toEqual(routing);
	});

	it("explicitly disables OpenRouter Responses reasoning with enabled=false", async () => {
		const { body } = await captureRequest(
			buildOpenRouterResponsesModel({ id: "deepseek/deepseek-r1", name: "DeepSeek R1", reasoning: true }),
			{ disableReasoning: true },
		);
		expect(body.reasoning).toEqual({ enabled: false });
	});

	it("omits default max_output_tokens for OpenRouter but sends explicit caller caps", async () => {
		const defaultRequest = await captureRequest(buildOpenRouterResponsesModel());
		expect(defaultRequest.body).not.toHaveProperty("max_output_tokens");

		const explicitRequest = await captureRequest(buildOpenRouterResponsesModel(), { maxTokens: 2048 });
		expect(explicitRequest.body.max_output_tokens).toBe(2048);
	});

	it("keeps default max_output_tokens for OpenRouter models that require it", async () => {
		const request = await captureRequest(
			buildOpenRouterResponsesModel({ id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" }),
		);
		expect(request.body.max_output_tokens).toBe(64_000);
	});

	it("lets caller headers override OpenRouter attribution and cache defaults", async () => {
		const { headers } = await captureRequest(buildOpenRouterResponsesModel(), {
			headers: {
				"HTTP-Referer": "https://caller.example/",
				"X-OpenRouter-Title": "Caller App",
				"X-OpenRouter-Cache": "false",
				"X-OpenRouter-Cache-TTL": "7",
			},
		});

		expect(headers.get("HTTP-Referer")).toBe("https://caller.example/");
		expect(headers.get("X-OpenRouter-Title")).toBe("Caller App");
		expect(headers.get("X-OpenRouter-Cache")).toBe("false");
		expect(headers.get("X-OpenRouter-Cache-TTL")).toBe("7");
	});

	it("omits native reasoning history for OpenRouter Anthropic turns", async () => {
		const nativeItem = {
			type: "reasoning",
			id: "rs_1",
			encrypted_content: "encrypted-reasoning",
			summary: [],
			format: "google-gemini-v1",
		};
		const firstResponse = new Response(
			`${[
				`data: ${JSON.stringify({ type: "response.output_item.done", item: nativeItem })}`,
				`data: ${JSON.stringify({
					type: "response.completed",
					response: {
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 2,
							total_tokens: 3,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}`,
			].join("\n\n")}\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = vi
			.fn()
			.mockImplementationOnce(async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {});
				return firstResponse;
			})
			.mockImplementationOnce(async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {});
				return createSseResponse();
			}) as FetchImpl;
		const model = buildOpenRouterModel({ id: "anthropic/claude-sonnet-4", reasoning: true });
		const responseModel = model as unknown as Model<"openai-responses">;

		let firstMessage: AssistantMessage | undefined;
		const firstStream = streamOpenAIResponses(responseModel, context, { apiKey: "test-key", fetch: fetchMock });
		for await (const event of firstStream) {
			if (event.type === "done") {
				firstMessage = event.message;
				break;
			}
			if (event.type === "error") throw event.error;
		}

		expect(firstMessage?.api).toBe("openrouter");
		expect(firstMessage?.providerPayload).toMatchObject({
			type: "openaiResponsesHistory",
			provider: "openrouter",
			items: [nativeItem],
		});

		const followup: Context = {
			messages: [firstMessage!, { role: "user", content: "continue", timestamp: 1 }],
		};
		const secondStream = streamOpenAIResponses(responseModel, followup, { apiKey: "test-key", fetch: fetchMock });
		for await (const event of secondStream) {
			if (event.type === "done") break;
			if (event.type === "error") throw event.error;
		}

		expect(bodies[1]?.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "continue" }] }]);
	});
});

async function captureDirectResponsesRequest(
	model: Model<"openai-responses">,
	options: Omit<StreamOptions, "apiKey"> & { reasoning?: Effort } = {},
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		return createSseResponse();
	});

	const stream = streamOpenAIResponses(model, context, { apiKey: "test-key", ...options, fetch: fetchMock });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	expect(fetchMock).toHaveBeenCalledTimes(1);
	if (!body) throw new Error("Expected captured direct Responses request");
	return body;
}

describe("Responses direct-provider max-token defaults", () => {
	// `streamOpenAIResponses` is public; callers may bypass `streamSimple` (which
	// pre-fills `options.maxTokens` from the model cap). After centralizing the
	// output-token policy in `resolveOpenAIOutputTokenParam`, the provider itself
	// supplies the `alwaysSendMaxTokens` default — so a direct call now emits
	// `max_output_tokens` for Kimi-style models even with no caller cap. This is
	// an intentional consistency change vs. the prior inline logic, which only
	// emitted the field because `streamSimple` had injected it.
	it("emits max_output_tokens for an alwaysSendMaxTokens model on a direct call with no caller cap", async () => {
		const body = await captureDirectResponsesRequest(
			buildOpenRouterResponsesModel({ id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" }),
		);
		expect(body.max_output_tokens).toBe(64_000);
	});

	it("still omits max_output_tokens for a routing-only OpenRouter model on a direct call", async () => {
		const body = await captureDirectResponsesRequest(buildOpenRouterResponsesModel());
		expect(body).not.toHaveProperty("max_output_tokens");
	});
});
