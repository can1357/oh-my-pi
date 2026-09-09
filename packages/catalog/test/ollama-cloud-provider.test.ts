import { afterEach, describe, expect, test, vi } from "bun:test";
import { completeSimple, getEnvApiKey, stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { ollamaCloudModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/ollama";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const originalApiKey = Bun.env.OLLAMA_CLOUD_API_KEY;

const cloudModel: Model<"ollama-chat"> = buildModel({
	id: "gpt-oss:120b",
	name: "GPT OSS 120B",
	api: "ollama-chat",
	provider: "ollama-cloud",
	baseUrl: "https://ollama.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 8_192,
});

const readFileTool = {
	name: "read_file",
	description: "Read a file from disk",
	parameters: {
		type: "object",
		required: ["path"],
		properties: {
			path: { type: "string" },
		},
	} as never,
} satisfies Tool;

function createNdjsonResponse(lines: unknown[]): Response {
	const body = `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(body));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "application/x-ndjson" },
	});
}

afterEach(() => {
	if (originalApiKey === undefined) {
		delete Bun.env.OLLAMA_CLOUD_API_KEY;
	} else {
		Bun.env.OLLAMA_CLOUD_API_KEY = originalApiKey;
	}
	vi.restoreAllMocks();
});

describe("ollama-cloud provider support", () => {
	test("resolves OLLAMA_CLOUD_API_KEY from environment", () => {
		Bun.env.OLLAMA_CLOUD_API_KEY = "ollama-cloud-test-key";
		expect(getEnvApiKey("ollama-cloud")).toBe("ollama-cloud-test-key");
	});

	test("discovers ollama-cloud models from native cloud endpoints", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			expect(headers.get("Authorization")).toBe("Bearer cloud-test-key");
			if (url === "https://ollama.com/api/tags") {
				return new Response(
					JSON.stringify({
						models: [{ name: "gpt-oss:120b" }, { model: "qwen3:32b", name: "Qwen 3 32B" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://ollama.com/api/show") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
				if (body.model === "gpt-oss:120b") {
					return new Response(
						JSON.stringify({
							capabilities: ["completion", "thinking", "vision"],
							model_info: { "gpt-oss.context_length": 262144 },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(JSON.stringify({ capabilities: ["completion", "vision"] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const gpt = models?.find(model => model.id === "gpt-oss:120b");
		const qwen = models?.find(model => model.id === "qwen3:32b");

		expect(options.providerId).toBe("ollama-cloud");
		expect(gpt?.provider).toBe("ollama-cloud");
		expect(gpt?.api).toBe("ollama-chat");
		expect(gpt?.baseUrl).toBe("https://ollama.com");
		expect(gpt?.reasoning).toBe(true);
		expect(gpt?.contextWindow).toBe(262144);
		expect(gpt?.input).toEqual(["text", "image"]);
		expect(qwen?.name).toBe("Qwen 3 32B");
		expect(qwen?.input).toEqual(["text", "image"]);
		expect(fetchMock).toHaveBeenCalledWith("https://ollama.com/api/tags", expect.objectContaining({ method: "GET" }));
	});

	test("discovers GLM-5.2 with Ollama Cloud high/max reasoning efforts", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input, _init) => {
			const url = String(input);
			if (url === "https://ollama.com/api/tags") {
				return new Response(JSON.stringify({ models: [{ name: "glm-5.2" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://ollama.com/api/show") {
				return new Response(
					JSON.stringify({
						capabilities: ["completion", "thinking"],
						model_info: { "glm.context_length": 1000000 },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const model = models?.find(candidate => candidate.id === "glm-5.2");
		const built = model ? buildModel(model) : undefined;

		expect(model?.reasoning).toBe(true);
		expect(built?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.High, Effort.Max],
		});
	});

	test("tolerates individual /api/show failures during model discovery", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			if (url === "https://ollama.com/api/tags") {
				return new Response(
					JSON.stringify({
						models: [{ name: "model-a" }, { name: "model-b" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://ollama.com/api/show") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
				if (body.model === "model-b") {
					throw new Error("network error");
				}
				return new Response(JSON.stringify({ capabilities: ["completion"] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		const ids = models?.map(m => m.id).sort();
		expect(ids).toEqual(["model-a", "model-b"]);
		const modelB = models?.find(m => m.id === "model-b");
		expect(modelB?.input).toEqual(["text"]);
	});

	test("falls back to bundled metadata when /api/show metadata is unavailable", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input, _init) => {
			const url = String(input);
			if (url === "https://ollama.com/api/tags") {
				return new Response(
					JSON.stringify({
						models: [{ name: "gpt-oss:120b" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://ollama.com/api/show") {
				return new Response(null, { status: 500 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const model = models?.find(candidate => candidate.id === "gpt-oss:120b");

		expect(model).toBeDefined();
		expect(model?.id).toBe("gpt-oss:120b");
		expect(model?.api).toBe("ollama-chat");
		expect(model?.provider).toBe("ollama-cloud");
		expect(model?.reasoning).toBe(true);
		expect(model?.contextWindow).toBeGreaterThan(0);
		expect(model?.maxTokens).toBeGreaterThan(0);
	});

	test("streams native chat responses with thinking, text, and usage mapping", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			expect(String(input)).toBe("https://ollama.com/api/chat");
			const headers = new Headers(init?.headers);
			expect(headers.get("Authorization")).toBe("Bearer cloud-test-key");
			return createNdjsonResponse([
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", thinking: "Need to think." },
					done: false,
				},
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", content: "Hello" },
					done: false,
				},
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", content: " world" },
					done: false,
				},
				{
					model: "gpt-oss:120b",
					done: true,
					done_reason: "stop",
					prompt_eval_count: 11,
					eval_count: 4,
				},
			]);
		});

		const response = stream(
			cloudModel,
			{
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			{ apiKey: "cloud-test-key", fetch: fetchMock },
		);

		const eventTypes: string[] = [];
		for await (const event of response) {
			eventTypes.push(event.type);
		}
		const result = await response.result();

		expect(eventTypes).toContain("thinking_start");
		expect(eventTypes).toContain("thinking_delta");
		expect(eventTypes).toContain("text_start");
		expect(eventTypes).toContain("text_delta");
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(11);
		expect(result.usage.output).toBe(4);
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "Need to think." },
			{ type: "text", text: "Hello world" },
		]);
	});

	test("surfaces empty length completions as context-window errors", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			createNdjsonResponse([
				{ model: "gpt-oss:120b", done: true, done_reason: "length", prompt_eval_count: 1000, eval_count: 0 },
			]),
		);

		const result = await stream(
			cloudModel,
			{
				messages: [{ role: "user", content: "Large task prompt", timestamp: Date.now() }],
			},
			{ apiKey: "cloud-test-key", fetch: fetchMock },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("prompt filled the context window");
	});

	test("sends native max for GLM-5.2 max reasoning on Ollama Cloud", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return createNdjsonResponse([
				{ model: "glm-5.2", message: { role: "assistant", content: "ok" }, done: false },
				{ model: "glm-5.2", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
			]);
		});
		const model: Model<"ollama-chat"> = buildModel({
			id: "glm-5.2",
			name: "GLM-5.2",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 131_072,
		});

		await stream(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{
				apiKey: "cloud-test-key",
				fetch: fetchMock,
				reasoning: Effort.Max,
			},
		).result();

		expect(requestBody?.think).toBe("max");
	});

	test("supports ollama-cloud through streamSimple option mapping", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			createNdjsonResponse([
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", content: "Mapped through streamSimple" },
					done: false,
				},
				{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 2, eval_count: 4 },
			]),
		);

		const response = await streamSimple(
			cloudModel,
			{ messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }] },
			{ apiKey: "cloud-test-key", toolChoice: "auto", fetch: fetchMock },
		).result();

		expect(response.stopReason).toBe("stop");
		expect(response.content).toEqual([{ type: "text", text: "Mapped through streamSimple" }]);
		expect(response.usage.input).toBe(2);
		expect(response.usage.output).toBe(4);
	});

	test("supports ollama-cloud through completeSimple top-level contract", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			createNdjsonResponse([
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", content: "Completed through completeSimple" },
					done: false,
				},
				{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 5 },
			]),
		);

		const response = await completeSimple(
			cloudModel,
			{ messages: [{ role: "user", content: "Finish this", timestamp: Date.now() }] },
			{ apiKey: "cloud-test-key", fetch: fetchMock },
		);

		expect(response.stopReason).toBe("stop");
		expect(response.content).toEqual([{ type: "text", text: "Completed through completeSimple" }]);
		expect(response.usage.input).toBe(3);
		expect(response.usage.output).toBe(5);
	});
	test("streams tool calls and maps native tool stop reasons", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			createNdjsonResponse([
				{
					model: "gpt-oss:120b",
					message: {
						role: "assistant",
						tool_calls: [
							{
								type: "function",
								function: {
									index: 0,
									name: "read_file",
									arguments: { path: "README.md" },
								},
							},
						],
					},
					done: false,
				},
				{
					model: "gpt-oss:120b",
					done: true,
					done_reason: "tool_calls",
					prompt_eval_count: 5,
					eval_count: 2,
				},
			]),
		);

		const response = stream(
			cloudModel,
			{
				messages: [{ role: "user", content: "Read README", timestamp: Date.now() }],
				tools: [readFileTool],
			},
			{ apiKey: "cloud-test-key", fetch: fetchMock },
		);
		const eventTypes: string[] = [];
		for await (const event of response) {
			eventTypes.push(event.type);
		}
		const result = await response.result();
		const toolCall = result.content.find(block => block.type === "toolCall");

		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_end");
		expect(result.stopReason).toBe("toolUse");
		expect(toolCall && toolCall.type === "toolCall" ? toolCall.name : undefined).toBe("read_file");
		expect(
			toolCall && toolCall.type === "toolCall" ? (toolCall.arguments as { path?: string }).path : undefined,
		).toBe("README.md");
	});

	test("converts replay history, tools, and images into native ollama chat payloads", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return createNdjsonResponse([
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", content: "done" },
					done: false,
				},
				{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 1 },
			]);
		});

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Inspect this image" },
						{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
					],
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tool-1", name: "read_file", arguments: { path: "README.md" } }],
					api: "ollama-chat",
					provider: "ollama-cloud",
					model: "gpt-oss:120b",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "read_file",
					content: [{ type: "text", text: "README contents" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
			tools: [readFileTool],
		};

		await stream(cloudModel, context, { apiKey: "cloud-test-key", fetch: fetchMock }).result();

		const messages = requestBody?.messages as Array<Record<string, unknown>> | undefined;
		expect(requestBody?.model).toBe("gpt-oss:120b");
		expect(requestBody?.stream).toBe(true);
		expect(Array.isArray(requestBody?.tools)).toBe(true);
		expect(messages?.[0]).toMatchObject({
			role: "user",
			content: "Inspect this image",
			images: ["aW1hZ2U="],
		});
		expect(messages?.[1]).toMatchObject({
			role: "assistant",
			tool_calls: [
				{
					type: "function",
					function: { name: "read_file", arguments: { path: "README.md" } },
				},
			],
		});
		expect(messages?.[2]).toMatchObject({
			role: "tool",
			tool_name: "read_file",
			content: "README contents",
		});
	});

	test("strips `thinking` from assistant history messages on ollama-cloud", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return createNdjsonResponse([
				{ model: "gpt-oss:120b", message: { role: "assistant", content: "ok" }, done: false },
				{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
			]);
		});

		const context: Context = {
			messages: [
				{ role: "user", content: "kick off", timestamp: Date.now() },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "internal reasoning" },
						{ type: "toolCall", id: "tool-1", name: "read_file", arguments: { path: "README.md" } },
					],
					api: "ollama-chat",
					provider: "ollama-cloud",
					model: "gpt-oss:120b",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "read_file",
					content: [{ type: "text", text: "README contents" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
			tools: [readFileTool],
		};

		await stream(cloudModel, context, { apiKey: "cloud-test-key", fetch: fetchMock }).result();

		const messages = requestBody?.messages as Array<Record<string, unknown>> | undefined;
		const assistant = messages?.find(message => message.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant).not.toHaveProperty("thinking");
		expect(assistant?.tool_calls).toEqual([
			{
				type: "function",
				function: { name: "read_file", arguments: { path: "README.md" } },
			},
		]);
	});

	test("emits one Ollama system message per ordered system prompt entry", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return createNdjsonResponse([
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", content: "done" },
					done: false,
				},
				{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 1 },
			]);
		});

		await stream(
			cloudModel,
			{
				systemPrompt: ["Stable instruction.", "Extra policy."],
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			},
			{ apiKey: "cloud-test-key", fetch: fetchMock },
		).result();

		const messages = requestBody?.messages as Array<Record<string, unknown>> | undefined;
		expect(messages).toHaveLength(3);
		expect(messages?.[0]).toEqual({ role: "system", content: "Stable instruction." });
		expect(messages?.[1]).toEqual({ role: "system", content: "Extra policy." });
		expect(messages?.map(message => message.role)).toEqual(["system", "system", "user"]);
	});

	describe("mapToolChoice", () => {
		test("omits tool_choice when undefined or auto", async () => {
			let requestBody: Record<string, unknown> | undefined;
			const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
				requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return createNdjsonResponse([
					{ model: "gpt-oss:120b", message: { role: "assistant", content: "ok" }, done: false },
					{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
				]);
			});

			await stream(
				cloudModel,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [readFileTool] },
				{ apiKey: "cloud-test-key", toolChoice: "auto", fetch: fetchMock },
			).result();
			expect(requestBody?.tool_choice).toBeUndefined();
		});

		test("passes tool_choice: none when ToolChoice is none", async () => {
			let requestBody: Record<string, unknown> | undefined;
			const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
				requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return createNdjsonResponse([
					{ model: "gpt-oss:120b", message: { role: "assistant", content: "ok" }, done: false },
					{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
				]);
			});

			await stream(
				cloudModel,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [readFileTool] },
				{ apiKey: "cloud-test-key", toolChoice: "none", fetch: fetchMock },
			).result();
			expect(requestBody?.tool_choice).toBe("none");
		});

		test("passes tool_choice: required when ToolChoice is required or any", async () => {
			let requestBody: Record<string, unknown> | undefined;
			const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
				requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return createNdjsonResponse([
					{ model: "gpt-oss:120b", message: { role: "assistant", content: "ok" }, done: false },
					{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
				]);
			});

			await stream(
				cloudModel,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [readFileTool] },
				{ apiKey: "cloud-test-key", toolChoice: "required", fetch: fetchMock },
			).result();
			expect(requestBody?.tool_choice).toBe("required");
		});
	});
});
