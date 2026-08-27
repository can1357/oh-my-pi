import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { renderDemotedThinking } from "../src/dialect/demotion";
import { NON_VISION_IMAGE_PLACEHOLDER } from "../src/providers/vision-guard";
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
	it("preserves ordered text and image content in GPT Responses tool outputs", () => {
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
				messages: [
					{
						role: "toolResult",
						toolCallId: "call_screenshot",
						toolName: "capture",
						content: [
							{ type: "text", text: "Screenshot captured." },
							{ type: "image", data: "AQID", mimeType: "image/png" },
						],
						isError: false,
						timestamp: 1,
					},
				],
			},
			model,
		) as { input: Array<Record<string, unknown>> };

		expect(payload.input).toEqual([
			{
				type: "function_call_output",
				call_id: "call_screenshot",
				output: [
					{ type: "input_text", text: "Screenshot captured." },
					{
						type: "input_image",
						detail: "auto",
						image_url: "data:image/png;base64,AQID",
					},
				],
			},
		]);
	});

	it("replaces images with the standard placeholder for text-only Zed xAI models", () => {
		const model: Model<"zed-agent"> = {
			id: "grok-4.20",
			name: "Grok 4.20",
			api: "zed-agent",
			provider: "zed-agent",
			baseUrl: "https://cloud.zed.dev",
			reasoning: false,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
		};

		const payload = buildZedProviderRequest(
			"x_ai",
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Describe the screenshot." },
							{ type: "image", data: "AQID", mimeType: "image/png" },
						],
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
					{ type: "text", text: "Describe the screenshot." },
					{ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER },
				],
			},
		]);
	});

	it("forwards temperature and topP to Zed xAI chat requests", () => {
		const model: Model<"zed-agent"> = {
			id: "grok-2",
			name: "Grok 2",
			api: "zed-agent",
			provider: "zed-agent",
			baseUrl: "https://cloud.zed.dev",
			reasoning: false,
			contextWindow: 131_072,
			maxTokens: 8_192,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
		};

		const payload = buildZedProviderRequest(
			"x_ai",
			{ messages: [{ role: "user", content: "Hello Grok", timestamp: 1 }] },
			model,
			{ temperature: 0.2, topP: 0.8 },
		) as Record<string, unknown>;

		expect(payload).toMatchObject({ temperature: 0.2, top_p: 0.8 });
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

	it("maps Claude 4.5 reasoning effort to budget and clamps it below maxTokens", () => {
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
		const expectedBudgets = [
			[Effort.Minimal, 1024],
			[Effort.Low, 4096],
			[Effort.Medium, 8192],
			[Effort.High, 16384],
		] as const;

		for (const [effort, expectedBudget] of expectedBudgets) {
			const payload = buildZedProviderRequest(
				"anthropic",
				{ messages: [{ role: "user", content: "Keep this concise.", timestamp: 1 }] },
				model,
				{ reasoning: effort },
			) as {
				max_tokens: number;
				thinking?: { budget_tokens?: number };
			};

			expect(payload.thinking?.budget_tokens).toBe(expectedBudget);
			expect(payload.thinking?.budget_tokens).toBeLessThan(payload.max_tokens);
		}

		const clampedPayload = buildZedProviderRequest(
			"anthropic",
			{ messages: [{ role: "user", content: "Keep this concise.", timestamp: 1 }] },
			model,
			{ reasoning: Effort.High, maxTokens: 1024 },
		) as {
			max_tokens: number;
			thinking?: { budget_tokens?: number };
		};

		expect(clampedPayload.max_tokens).toBe(1024);
		expect(clampedPayload.thinking?.budget_tokens).toBe(1023);
		expect(clampedPayload.thinking?.budget_tokens).toBeGreaterThan(0);
		expect(clampedPayload.thinking?.budget_tokens).toBeLessThan(clampedPayload.max_tokens);
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

	it("demotes cross-model OpenAI reasoning instead of replaying it as a Responses item", () => {
		const model: Model<"zed-agent"> = {
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "zed-agent",
			provider: "zed-agent",
			baseUrl: "https://cloud.zed.dev",
			reasoning: true,
			contextWindow: 400_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: undefined,
		};
		const thinkingText = "Reasoning from the previous GPT model.";
		const foreignReasoningItem = {
			type: "reasoning",
			id: "rs_foreign_gpt_reasoning",
			status: "completed",
			summary: [{ type: "summary_text", text: thinkingText }],
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: thinkingText,
					thinkingSignature: JSON.stringify(foreignReasoningItem),
				},
				{ type: "text", text: "The answer." },
			],
			api: "zed-agent",
			provider: "zed-agent",
			model: "gpt-5.6-sol",
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

		const payload = buildZedProviderRequest("open_ai", { messages: [assistant] }, model) as {
			input: Array<{ type: string; role?: string; content?: Array<Record<string, unknown>> }>;
		};

		expect(payload.input).toEqual([
			{
				type: "message",
				role: "assistant",
				content: [
					{ type: "output_text", text: renderDemotedThinking(model.id, thinkingText) },
					{ type: "output_text", text: "The answer." },
				],
			},
		]);
		expect(payload.input.some(item => item.type === "reasoning")).toBe(false);
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

	it("formats Google AI GenerateContentRequest payload and forwards all Gemini sampling controls", () => {
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
			temperature: 0,
			topP: 0.75,
			topK: 32,
			minP: 0.05,
			presencePenalty: -0.25,
			repetitionPenalty: 1.1,
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
			temperature: 0,
			topP: 0.75,
			topK: 32,
			minP: 0.05,
			presencePenalty: -0.25,
			repetitionPenalty: 1.1,
			thinkingConfig: { thinkingLevel: "MEDIUM" },
		});
	});

	it("replays only valid same-model Gemini thought signatures", () => {
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
		const cases = [
			{
				sourceModel: mockModel.id,
				thinking: "same-model reasoning",
				thinkingSignature: "QUJDRA==",
				toolSignature: "RUZHSA==",
				retained: true,
			},
			{
				sourceModel: "gemini-3.1-pro-preview",
				thinking: "foreign-model reasoning",
				thinkingSignature: "QUJDRA==",
				toolSignature: "RUZHSA==",
				retained: false,
			},
			{
				sourceModel: mockModel.id,
				thinking: "invalid-signature reasoning",
				thinkingSignature: "not base64!",
				toolSignature: "also not base64!",
				retained: false,
			},
		] as const;

		for (const testCase of cases) {
			const assistant: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: testCase.thinking,
						thinkingSignature: testCase.thinkingSignature,
					},
					{
						type: "toolCall",
						id: "call_search",
						name: "search_tool",
						arguments: { query: "weather in Paris" },
						thoughtSignature: testCase.toolSignature,
					},
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
				stopReason: "toolUse",
				timestamp: 2,
			};

			const payload = buildZedProviderRequest("google", { messages: [assistant] }, mockModel) as {
				contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
			};
			const parts = payload.contents[0]?.parts;
			if (!parts) throw new Error(`Gemini parts were not emitted for ${testCase.sourceModel}`);

			if (testCase.retained) {
				expect(parts).toEqual([
					{
						thought: true,
						text: testCase.thinking,
						thoughtSignature: testCase.thinkingSignature,
					},
					{
						functionCall: {
							name: "search_tool",
							args: { query: "weather in Paris" },
						},
						thoughtSignature: testCase.toolSignature,
					},
				]);
				continue;
			}

			expect(parts).toHaveLength(2);
			expect(String(parts[0]?.text)).toContain(testCase.thinking);
			expect(parts[0]?.thought).toBeUndefined();
			expect(parts[0]?.thoughtSignature).toBeUndefined();
			expect(parts[1]).toEqual({
				functionCall: {
					name: "search_tool",
					args: { query: "weather in Paris" },
				},
			});
		}
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
