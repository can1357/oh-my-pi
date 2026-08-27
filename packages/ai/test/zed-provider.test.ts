import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { buildZedProviderRequest, resolveProviderKind } from "../src/providers/zed";
import { invalidateZedLlmToken } from "../src/registry/oauth/zed-token-pool";
import { streamSimple } from "../src/stream";
import type { AssistantMessage, Context, FetchImpl, Model } from "../src/types";
import { mockFetch } from "./helpers/fetch-mock";

describe("Zed Provider Payload Construction", () => {
	it("resolves exact provider kinds matching Zed serde conventions", () => {
		expect(resolveProviderKind("gpt-5.6-luna")).toBe("open_ai");
		expect(resolveProviderKind("gpt-5.6-sol")).toBe("open_ai");
		expect(resolveProviderKind("gpt-5.4")).toBe("open_ai");
		expect(resolveProviderKind("claude-sonnet-5")).toBe("anthropic");
		expect(resolveProviderKind("claude-sonnet-4-6")).toBe("anthropic");
		expect(resolveProviderKind("gemini-3.1-pro-preview")).toBe("google");
		expect(resolveProviderKind("grok-2")).toBe("x_ai");
	});

	it("preserves developer messages as developer-role Responses input", () => {
		const model: Model<"zed-agent"> = {
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "zed-agent",
			provider: "zed-agent",
			baseUrl: "https://cloud.zed.dev",
			reasoning: true,
			contextWindow: 400000,
			maxTokens: 128000,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
		};

		const payload = buildZedProviderRequest(
			"open_ai",
			{
				messages: [{ role: "developer", content: "Follow these instructions.", timestamp: 1 }],
			},
			model,
		) as { input: Array<{ type: string; role: string; content: Array<{ type: string; text: string }> }> };

		expect(payload.input).toEqual([
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "Follow these instructions." }],
			},
		]);
	});

	it("keeps mixed Anthropic tool-result text and image content in one tool_result block", () => {
		const model: Model<"zed-agent"> = {
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			api: "zed-agent",
			provider: "zed-agent",
			baseUrl: "https://cloud.zed.dev",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 128000,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
		};

		const payload = buildZedProviderRequest(
			"anthropic",
			{
				messages: [
					{
						role: "toolResult",
						toolCallId: "call_inspect",
						toolName: "inspect_image",
						content: [
							{ type: "text", text: "The image contains a diagram." },
							{ type: "image", data: "AQID", mimeType: "image/png" },
						],
						isError: false,
						timestamp: 1,
					},
				],
			},
			model,
		) as { messages: Array<{ role: string; content: unknown }> };

		expect(payload.messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_inspect",
						content: [
							{ type: "text", text: "The image contains a diagram." },
							{
								type: "image",
								source: {
									type: "base64",
									media_type: "image/png",
									data: "AQID",
								},
							},
						],
						is_error: false,
					},
				],
			},
		]);
	});

	it("keeps Claude 4.5 thinking budget strictly below a low maxTokens limit", () => {
		const model: Model<"zed-agent"> = {
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "zed-agent",
			provider: "zed-agent",
			baseUrl: "https://cloud.zed.dev",
			reasoning: true,
			contextWindow: 200000,
			maxTokens: 128000,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
		};

		const payload = buildZedProviderRequest(
			"anthropic",
			{ messages: [{ role: "user", content: "Keep this concise.", timestamp: 1 }] },
			model,
			{ maxTokens: 1024 },
		) as {
			max_tokens: number;
			thinking?: { budget_tokens?: number };
		};

		expect(payload.thinking?.budget_tokens).toBe(1023);
		expect(payload.thinking?.budget_tokens).toBeGreaterThan(0);
		expect(payload.thinking?.budget_tokens).toBeLessThan(payload.max_tokens);
	});

	it("formats OpenAI Responses API payload for open_ai provider models", () => {
		const mockModel: Model<"zed-agent"> = {
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "zed-agent",
			provider: "zed-agent",
			baseUrl: "https://cloud.zed.dev",
			reasoning: true,
			contextWindow: 400000,
			maxTokens: 128000,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
		};

		const mockContext: Context = {
			systemPrompt: ["You are an assistant."],
			messages: [
				{
					role: "user",
					content: "Hello world",
					timestamp: Date.now(),
				},
			],
		};

		const payload = buildZedProviderRequest("open_ai", mockContext, mockModel, {
			reasoning: Effort.Medium,
		}) as Record<string, unknown>;

		expect(payload.model).toBe("gpt-5.6-luna");
		expect(payload.instructions).toBe("You are an assistant.");
		expect(payload.stream).toBe(true);
		expect(payload.reasoning).toEqual({ effort: "medium", summary: "auto" });

		const input = payload.input as Array<{
			type: string;
			role: string;
			content: Array<{ type: string; text: string }>;
		}>;
		expect(input).toBeArray();
		expect(input.length).toBe(1);
		expect(input[0].type).toBe("message");
		expect(input[0].role).toBe("user");
		expect(input[0].content[0].type).toBe("input_text");
		expect(input[0].content[0].text).toBe("Hello world");
	});

	it("formats Anthropic Messages API payload for anthropic provider models", () => {
		const mockModel: Model<"zed-agent"> = {
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			api: "zed-agent",
			provider: "zed-agent",
			baseUrl: "https://cloud.zed.dev",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 128000,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
		};

		const mockContext: Context = {
			systemPrompt: ["You are an assistant."],
			messages: [
				{
					role: "user",
					content: "Hello world",
					timestamp: Date.now(),
				},
			],
		};

		const payload = buildZedProviderRequest("anthropic", mockContext, mockModel, {
			reasoning: Effort.High,
		}) as Record<string, unknown>;

		expect(payload.model).toBe("claude-sonnet-5");
		expect(payload.system).toBe("You are an assistant.");
		expect(payload.max_tokens).toBe(128000);
		expect(payload.thinking).toEqual({ type: "adaptive" });
		expect(payload.output_config).toEqual({ effort: "high" });

		const messages = payload.messages as Array<{ role: string; content: string }>;
		expect(messages).toBeArray();
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toBe("Hello world");
	});

	it("demotes foreign and unsigned thinking when switching Zed models to Claude", () => {
		const model: Model<"zed-agent"> = {
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			api: "zed-agent",
			provider: "zed-agent",
			baseUrl: "https://cloud.zed.dev",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
		};
		const cases = [
			{
				sourceModel: "gemini-3-flash",
				thinking: "Gemini's foreign reasoning",
				thinkingSignature: "google-signature",
			},
			{
				sourceModel: "gpt-5.6-luna",
				thinking: "OpenAI's unsigned reasoning",
			},
		] as const;

		for (const testCase of cases) {
			const assistant: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: testCase.thinking,
						...("thinkingSignature" in testCase && testCase.thinkingSignature
							? { thinkingSignature: testCase.thinkingSignature }
							: {}),
					},
					{ type: "text", text: "The answer." },
				],
				api: "zed-agent",
				provider: "zed-agent",
				model: testCase.sourceModel,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			};
			const payload = buildZedProviderRequest("anthropic", { messages: [assistant] }, model) as {
				messages: Array<{ role: string; content: unknown }>;
			};

			expect(payload.messages).toEqual([
				{
					role: "assistant",
					content: [
						{ type: "text", text: testCase.thinking },
						{ type: "text", text: "The answer." },
					],
				},
			]);
		}
	});

	it("forwards mixed Anthropic sampling controls only when thinking is inactive", () => {
		const model: Model<"zed-agent"> = {
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			api: "zed-agent",
			provider: "zed-agent",
			baseUrl: "https://cloud.zed.dev",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
		};
		const sampling = {
			temperature: 0.25,
			topP: 0.75,
			stopSequences: ["<END>", "<STOP>", "<DONE>", "<HALT>", "<EXTRA>"],
		};
		const disabledThinking = buildZedProviderRequest(
			"anthropic",
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			model,
			{ ...sampling, disableReasoning: true },
		) as Record<string, unknown>;

		expect(disabledThinking).toMatchObject({
			temperature: 0.25,
			top_p: 0.75,
			stop_sequences: ["<END>", "<STOP>", "<DONE>", "<HALT>"],
		});
		expect(disabledThinking.thinking).toBeUndefined();

		const enabledThinking = buildZedProviderRequest(
			"anthropic",
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			model,
			{ ...sampling, reasoning: Effort.Medium },
		) as Record<string, unknown>;

		expect(enabledThinking.temperature).toBeUndefined();
		expect(enabledThinking.top_p).toBeUndefined();
		expect(enabledThinking.stop_sequences).toEqual(["<END>", "<STOP>", "<DONE>", "<HALT>"]);

		const restrictedDisabledThinking = buildZedProviderRequest(
			"anthropic",
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ ...model, id: "claude-sonnet-5", name: "Claude Sonnet 5" },
			{ ...sampling, disableReasoning: true },
		) as Record<string, unknown>;

		expect(restrictedDisabledThinking.temperature).toBeUndefined();
		expect(restrictedDisabledThinking.top_p).toBeUndefined();
		expect(restrictedDisabledThinking.stop_sequences).toEqual(["<END>", "<STOP>", "<DONE>", "<HALT>"]);
	});

	it("formats Google AI GenerateContentRequest payload for google provider models", () => {
		const mockModel: Model<"zed-agent"> = {
			id: "gemini-3-flash",
			name: "Gemini 3 Flash",
			api: "zed-agent",
			provider: "zed-agent",
			baseUrl: "https://cloud.zed.dev",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 66000,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
		};

		const mockContext: Context = {
			systemPrompt: ["You are a Google assistant."],
			messages: [
				{
					role: "user",
					content: "Hello Gemini",
					timestamp: Date.now(),
				},
			],
			tools: [
				{
					name: "search_tool",
					description: "Search web",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string" },
							limit: { type: "number", exclusiveMinimum: 0 },
						},
					},
				},
			],
		};

		const payload = buildZedProviderRequest("google", mockContext, mockModel, {
			reasoning: Effort.Medium,
		}) as Record<string, unknown>;

		expect(payload.contents).toBeArray();
		const contents = payload.contents as Array<{ role: string; parts: Array<{ text?: string }> }>;
		expect(contents.length).toBe(1);
		expect(contents[0].role).toBe("user");
		expect(contents[0].parts[0].text).toBe("Hello Gemini");
		expect(payload.systemInstruction).toEqual({ parts: [{ text: "You are a Google assistant." }] });
		expect(payload.tools).toBeArray();
		const tools = payload.tools as Array<{
			functionDeclarations: Array<{ name: string; parameters: Record<string, unknown> }>;
		}>;
		const params = tools[0].functionDeclarations[0].parameters as {
			properties: { limit: Record<string, unknown> };
		};
		expect(params.properties.limit.exclusiveMinimum).toBeUndefined();
		expect(payload.generationConfig).toMatchObject({
			maxOutputTokens: 66000,
			thinkingConfig: { thinkingLevel: "MEDIUM" },
		});
	});
	it("replays Gemini assistant tool-call thought signatures in the functionCall payload", () => {
		const thoughtSignature = "gemini-thought-signature";
		const mockModel: Model<"zed-agent"> = {
			id: "gemini-3-flash",
			name: "Gemini 3 Flash",
			api: "zed-agent",
			provider: "zed-agent",
			baseUrl: "https://cloud.zed.dev",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 66_000,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_search",
					name: "search_tool",
					arguments: { query: "weather in Paris" },
					thoughtSignature,
				},
			],
			api: "zed-agent",
			provider: "zed-agent",
			model: mockModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};

		const payload = buildZedProviderRequest("google", { messages: [assistant] }, mockModel) as Record<
			string,
			unknown
		>;
		const contents = payload.contents as Array<{
			role: string;
			parts: Array<Record<string, unknown>>;
		}>;

		expect(contents).toEqual([
			{
				role: "model",
				parts: [
					{
						functionCall: {
							name: "search_tool",
							args: { query: "weather in Paris" },
						},
						thoughtSignature,
					},
				],
			},
		]);
	});

	it("propagates forceReasoningOff to Zed provider options and disables Gemini thinking", async () => {
		const userId = "user_force_reasoning_off";
		const accessToken = "access-token-force-reasoning-off";
		const mockModel: Model<"zed-agent"> = {
			id: "gemini-3-flash",
			name: "Gemini 3 Flash",
			api: "zed-agent",
			provider: "zed-agent",
			baseUrl: "https://cloud.zed.dev",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 66_000,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
		};
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		let completionPayload: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = mockFetch(async (_input, init) => {
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			if (body?.organization_id === null) {
				return new Response(JSON.stringify({ token: "llm-token-force-reasoning-off" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			completionPayload = body;
			return new Response(
				[
					JSON.stringify({ event: { type: "content_block_start", content_block: { type: "text" } } }),
					JSON.stringify({ event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } }),
					JSON.stringify({ event: { type: "content_block_stop" } }),
					JSON.stringify({ status: "stream_ended" }),
				].join("\n"),
				{
					status: 200,
					headers: { "content-type": "application/x-ndjson" },
				},
			);
		});

		try {
			await streamSimple(mockModel, context, {
				apiKey: `${userId} ${accessToken}`,
				reasoning: Effort.High,
				forceReasoningOff: true,
				fetch: fetchMock,
			}).result();
		} finally {
			invalidateZedLlmToken(userId, accessToken);
		}

		if (!completionPayload) throw new Error("Zed completion request was not captured");
		const providerRequest = completionPayload.provider_request as Record<string, unknown>;
		expect(providerRequest.generationConfig).toMatchObject({
			maxOutputTokens: 66_000,
			thinkingConfig: { thinkingBudget: 0 },
		});
	});
});
