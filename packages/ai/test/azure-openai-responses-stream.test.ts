import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type AzureOpenAIResponsesOptions,
	streamAzureOpenAIResponses,
} from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import type { Context, FetchImpl, Model, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const azureModel: Model<"azure-openai-responses"> = buildModel({
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
});

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function createSseResponse(events: unknown[]): Response {
	const sse = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(sse));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createAssistantMessage(text: string, textSignature?: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text, ...(textSignature ? { textSignature } : {}) }],
		api: "azure-openai-responses" as const,
		provider: "azure" as const,
		model: "gpt-5-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

async function captureAzurePayload(
	context: Context,
	model: Model<"azure-openai-responses"> = azureModel,
	options: Partial<AzureOpenAIResponsesOptions> = {},
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamAzureOpenAIResponses(model, context, {
		apiKey: "test-key",
		azureBaseUrl: model.baseUrl,
		azureApiVersion: "v1",
		...options,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("azure openai responses streaming", () => {
	it("serializes each system prompt as an Azure Responses system input item for non-reasoning models", async () => {
		const payload = await captureAzurePayload({
			systemPrompt: ["First instruction", "", "Second instruction"],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		expect(payload.input).toEqual([
			{ role: "system", content: "First instruction" },
			{ role: "system", content: "Second instruction" },
			{ role: "user", content: [{ type: "input_text", text: "Say hello" }] },
		]);
	});

	it("sends an async onPayload replacement body", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			return createSseResponse([
				{
					type: "response.completed",
					response: {
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]);
		});

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				fetch: fetchMock as unknown as typeof fetch,
				azureBaseUrl: azureModel.baseUrl,
				azureApiVersion: "v1",
				onPayload: async payload => ({
					...(payload as Record<string, unknown>),
					input: [{ role: "user", content: [{ type: "input_text", text: "replacement" }] }],
				}),
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedBody?.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "replacement" }] }]);
	});

	it("uses developer role for Azure Responses reasoning model system prompts", async () => {
		const reasoningModel: Model<"azure-openai-responses"> = buildModel({
			...azureModel,
			reasoning: true,
			compat: azureModel.compatConfig,
		} as ModelSpec<"azure-openai-responses">);
		const payload = await captureAzurePayload(
			{
				systemPrompt: ["Reasoning instruction", "Second instruction"],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			reasoningModel,
		);

		expect(payload.input).toEqual([
			{ role: "developer", content: "Reasoning instruction" },
			{ role: "developer", content: "Second instruction" },
			{ role: "user", content: [{ type: "input_text", text: "Say hello" }] },
		]);
	});

	it("omits reasoning summaries when model compatibility disables them", async () => {
		const model: Model<"azure-openai-responses"> = buildModel({
			...azureModel,
			reasoning: true,
			compat: { ...azureModel.compatConfig, supportsReasoningSummary: false },
		} as ModelSpec<"azure-openai-responses">);

		const payload = await captureAzurePayload(
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			model,
			{ reasoning: "high", reasoningSummary: "detailed" },
		);

		expect(payload.reasoning).toEqual({ effort: "high" });
	});

	it("keeps Azure Responses prompt_cache_key separate from Anthropic cache controls", async () => {
		const payload = await captureAzurePayload(
			{
				systemPrompt: ["Cache-stable instruction"],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			azureModel,
			{ sessionId: "azure-session" },
		);

		expect(payload.prompt_cache_key).toBe("azure-session");
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(payload.cache_control).toBeUndefined();
	});

	it("rewrites oneOf tool schemas to anyOf for Azure Responses", async () => {
		const tool: Tool = {
			name: "choose",
			description: "choose a branch",
			parameters: {
				type: "object",
				properties: {
					item: {
						oneOf: [
							{
								type: "object",
								properties: { kind: { const: "a" }, value: { type: "string" } },
								required: ["kind", "value"],
								additionalProperties: false,
							},
							{
								type: "object",
								properties: { kind: { const: "b" }, count: { type: "integer" } },
								required: ["kind", "count"],
								additionalProperties: false,
							},
						],
					},
				},
				required: ["item"],
			},
		};

		const payload = await captureAzurePayload({
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			tools: [tool],
		});

		const tools = payload.tools as Array<{ parameters: { properties: { item: Record<string, unknown> } } }>;
		expect(tools[0].parameters.properties.item.oneOf).toBeUndefined();
		expect(Array.isArray(tools[0].parameters.properties.item.anyOf)).toBe(true);
	});

	it("serializes computer and its forced choice as a function on unsupported models", async () => {
		const computer: Tool = {
			name: "computer",
			description: "Control the desktop",
			parameters: { type: "object", properties: {} },
			native: { type: "computer" },
		};
		const read: Tool = {
			name: "read_file",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		};
		const payload = await captureAzurePayload(
			{
				messages: [{ role: "user", content: "Inspect", timestamp: Date.now() }],
				tools: [computer, read],
			},
			azureModel,
			{ toolChoice: { type: "computer" } },
		);
		expect(payload.tools).toEqual([
			expect.objectContaining({ type: "function", name: "computer" }),
			expect.objectContaining({ type: "function", name: "read_file" }),
		]);
		expect(JSON.stringify(payload.tools)).not.toContain('{"type":"computer"}');
		expect(payload.tool_choice).toEqual({ type: "function", name: "computer" });
	});

	it("serializes native GA computer and forced choice for a supported GPT-5.4 Azure model", async () => {
		const supportedModel: Model<"azure-openai-responses"> = buildModel({
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: azureModel.baseUrl,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		});
		const computer: Tool = {
			name: "computer",
			description: "Control the desktop",
			parameters: { type: "object", properties: {} },
			native: { type: "computer" },
		};
		const nativeItem = {
			type: "message" as const,
			role: "user" as const,
			content: [
				{ type: "input_text" as const, text: "Inspect" },
				{ type: "input_image" as const, file_id: "file_azure_screen_雪", detail: "auto" as const },
				{ type: "input_file" as const, file_id: "file_azure_context_电脑" },
			],
		};
		const payload = await captureAzurePayload(
			{
				messages: [
					{
						role: "user",
						content: "Inspect",
						providerPayload: { type: "openaiResponsesHistory", items: [nativeItem], dt: true },
						timestamp: Date.now(),
					},
				],
				tools: [computer],
			},
			supportedModel,
			{
				toolChoice: { type: "function", name: "computer" },
				include: ["computer_call_output.output.image_url", "reasoning.encrypted_content"],
			},
		);
		expect(supportedModel.supportsComputerUse).toBe(true);
		expect(payload.tools).toEqual([{ type: "computer" }]);
		expect(payload.tool_choice).toEqual({ type: "computer" });
		expect(payload.input).toEqual([nativeItem]);
		expect(payload.include).toEqual(["computer_call_output.output.image_url", "reasoning.encrypted_content"]);
		expect(JSON.stringify(payload)).not.toContain("display_width");
		expect(JSON.stringify(payload)).not.toContain("display_height");

		const gatewayPayload = await captureAzurePayload(
			{
				messages: [{ role: "user", content: "Inspect", timestamp: Date.now() }],
				tools: [computer],
			},
			supportedModel,
			{
				azureBaseUrl: "https://gateway.example/openai/v1",
				toolChoice: { type: "function", name: "computer" },
			},
		);
		expect(gatewayPayload.tools).toMatchObject([
			{
				type: "function",
				name: "computer",
				description: "Control the desktop",
				parameters: { type: "object", properties: {} },
				strict: false,
			},
		]);
		expect(gatewayPayload.tool_choice).toEqual({ type: "function", name: "computer" });
	});

	it("surfaces nested response.failed provider errors", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.failed",
					response: {
						error: { code: "server_error", message: "backend exploded" },
					},
				},
			]),
		);

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1", fetch: fetchMock },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("server_error: backend exploded");
	});

	it("surfaces response.failed incomplete reasons", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.failed",
					response: {
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
		);

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1", fetch: fetchMock },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("incomplete: max_output_tokens");
	});

	it("surfaces response.completed failed status_details errors", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.completed",
					response: {
						status: "failed",
						status_details: {
							error: { code: "server_error", message: "backend exploded late" },
						},
					},
				},
			]),
		);

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1", fetch: fetchMock },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("server_error: backend exploded late");
	});
	it("preserves assistant message phase when rebuilding fallback replay history", async () => {
		const payload = await captureAzurePayload({
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				createAssistantMessage(
					"Commentary answer",
					JSON.stringify({ v: 1, id: "msg_commentary", phase: "final_answer" }),
				),
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first user" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Commentary answer", annotations: [] }],
				status: "completed",
				id: "msg_commentary",
				phase: "final_answer",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});

	it("keeps legacy plain-string text signatures when rebuilding fallback replay history", async () => {
		const payload = await captureAzurePayload({
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				createAssistantMessage("Legacy answer", "msg_legacy"),
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first user" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Legacy answer", annotations: [] }],
				status: "completed",
				id: "msg_legacy",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});
});
