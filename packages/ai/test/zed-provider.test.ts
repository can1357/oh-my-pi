import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { renderDemotedThinking } from "../src/dialect/demotion";
import { streamZed } from "../src/providers/register-builtins";
import { NON_VISION_IMAGE_PLACEHOLDER } from "../src/providers/vision-guard";
import { buildZedProviderRequest, resolveProviderKind } from "../src/providers/zed";
import { invalidateZedLlmToken } from "../src/registry/oauth/zed-token-pool";
import { streamSimple } from "../src/stream";
import type { AssistantMessage, Context, FetchImpl, Model, ModelSpec } from "../src/types";
import { mockFetch } from "./helpers/fetch-mock";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function makeModel(spec: Partial<ModelSpec<"zed-agent">> & { id: string }): Model<"zed-agent"> {
	const { name, id, ...rest } = spec;
	return buildModel({
		id,
		name: name ?? id,
		api: "zed-agent",
		provider: "zed-agent",
		baseUrl: "https://cloud.zed.dev",
		reasoning: false,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 4096,
		cost: zeroCost,
		...rest,
	});
}

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

	it("resolves provider kind from structured model compat and identity", () => {
		const anthropicModel = makeModel({
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
		});
		expect(resolveProviderKind(anthropicModel)).toBe("anthropic");

		const openAiModel = makeModel({
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
		});
		expect(resolveProviderKind(openAiModel)).toBe("open_ai");

		const googleModel = makeModel({
			id: "gemini-3.1-pro-preview",
			name: "Gemini 3.1 Pro Preview",
		});
		expect(resolveProviderKind(googleModel)).toBe("google");

		const xAiModel = makeModel({
			id: "grok-2",
			name: "Grok 2",
		});
		expect(resolveProviderKind(xAiModel)).toBe("x_ai");

		const aliasedOpenAiModel = makeModel({
			id: "my-custom-model",
			name: "Internal GPT Alias",
			compat: { provider: "open_ai" },
		});
		expect(resolveProviderKind(aliasedOpenAiModel)).toBe("open_ai");

		const aliasedGoogleModel = makeModel({
			id: "my-other-custom-model",
			name: "Internal Gemini Alias",
			compat: { provider: "google" },
		});
		expect(resolveProviderKind(aliasedGoogleModel)).toBe("google");
		const taxonomyIdentityModel = {
			...makeModel({ id: "vendor-model", name: "Vendor Model" }),
			compat: {},
			identity: { class: "gemini" },
		} as Model<"zed-agent">;
		expect(resolveProviderKind(taxonomyIdentityModel)).toBe("google");
	});

	it("preserves developer messages as developer-role Responses input", () => {
		const model: Model<"zed-agent"> = makeModel({
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			reasoning: true,
			contextWindow: 400000,
			maxTokens: 128000,
			input: ["text", "image"],
		});

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
		const model: Model<"zed-agent"> = makeModel({
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			reasoning: true,
			contextWindow: 400000,
			maxTokens: 128000,
			input: ["text", "image"],
		});

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
	it("preserves OpenAI Responses image detail and native image references", () => {
		const model: Model<"zed-agent"> = makeModel({
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			reasoning: true,
			contextWindow: 400000,
			maxTokens: 128000,
			input: ["text", "image"],
		});
		const imageData = "AQID";
		const imageUrl = "https://blob.example.invalid/screenshot.png";
		const providerFileId = "file_screenshot_123";
		const payload = buildZedProviderRequest(
			"open_ai",
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Inspect this frame." },
							{ type: "image", data: imageData, mimeType: "image/png", detail: "original" },
							{ type: "image", data: imageData, mimeType: "image/png", detail: "high", url: imageUrl },
							{
								type: "image",
								data: imageData,
								mimeType: "image/png",
								detail: "low",
								providerFile: { provider: "openai", id: providerFileId },
							},
						],
						timestamp: 1,
					},
				],
			},
			model,
		) as { input: Array<Record<string, unknown>> };

		expect(payload.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "Inspect this frame." },
					{
						type: "input_image",
						detail: "original",
						image_url: `data:image/png;base64,${imageData}`,
					},
					{ type: "input_image", detail: "high", image_url: imageUrl },
					{ type: "input_image", detail: "low", file_id: providerFileId },
				],
			},
		]);
	});

	it("replaces images with the standard placeholder for text-only Zed xAI models", () => {
		const model: Model<"zed-agent"> = makeModel({
			id: "grok-4.20",
			name: "Grok 4.20",
			reasoning: false,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text"],
		});

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

	it("moves xAI vision tool-result images into a following user message", () => {
		const context: Context = {
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
		};
		const visionModel: Model<"zed-agent"> = makeModel({
			id: "grok-4.6",
			name: "Grok 4.6",
			reasoning: false,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
		});
		const visionPayload = buildZedProviderRequest("x_ai", context, visionModel) as {
			messages: Array<{ role: string; tool_call_id?: string; content: unknown }>;
		};
		expect(visionPayload.messages).toEqual([
			{
				role: "tool",
				tool_call_id: "call_screenshot",
				content: "Screenshot captured.",
			},
			{
				role: "user",
				content: [
					{ type: "text", text: "Attached image(s) from tool result:" },
					{
						type: "image_url",
						image_url: { url: "data:image/png;base64,AQID" },
					},
				],
			},
		]);

		const textOnlyModel: Model<"zed-agent"> = makeModel({
			id: "grok-4.20",
			name: "Grok 4.20",
			reasoning: false,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text"],
		});
		const textOnlyPayload = buildZedProviderRequest("x_ai", context, textOnlyModel) as {
			messages: Array<{ role: string; tool_call_id?: string; content: unknown }>;
		};
		expect(textOnlyPayload.messages).toEqual([
			{
				role: "tool",
				tool_call_id: "call_screenshot",
				content: `Screenshot captured.\n${NON_VISION_IMAGE_PLACEHOLDER}`,
			},
		]);
	});

	it("forwards temperature and topP to Zed xAI chat requests", () => {
		const model: Model<"zed-agent"> = makeModel({
			id: "grok-2",
			name: "Grok 2",
			reasoning: false,
			contextWindow: 131_072,
			maxTokens: 8_192,
			input: ["text"],
		});

		const payload = buildZedProviderRequest(
			"x_ai",
			{ messages: [{ role: "user", content: "Hello Grok", timestamp: 1 }] },
			model,
			{ temperature: 0.2, topP: 0.8 },
		) as Record<string, unknown>;

		expect(payload).toMatchObject({ temperature: 0.2, top_p: 0.8 });
	});

	it("keeps mixed Anthropic tool-result text and image content in one tool_result block", () => {
		const model: Model<"zed-agent"> = makeModel({
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 128000,
			input: ["text", "image"],
		});

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
	it("hoists images out of Anthropic error tool results", () => {
		const model: Model<"zed-agent"> = makeModel({
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 128000,
			input: ["text", "image"],
		});
		const payload = buildZedProviderRequest(
			"anthropic",
			{
				messages: [
					{
						role: "toolResult",
						toolCallId: "call_failed_screenshot",
						toolName: "capture",
						content: [
							{ type: "text", text: "Screenshot capture failed." },
							{ type: "image", data: "AQID", mimeType: "image/png" },
						],
						isError: true,
						timestamp: 1,
					},
				],
			},
			model,
		) as { messages: Array<{ role: string; content: unknown }> };

		const entries = payload.messages.flatMap(message => {
			if (!Array.isArray(message.content)) return [];
			return message.content.map(block => ({ role: message.role, block: block as Record<string, unknown> }));
		});
		const toolResultIndex = entries.findIndex(entry => entry.block.type === "tool_result");
		const toolResultEntry = entries[toolResultIndex];
		if (!toolResultEntry) throw new Error("Anthropic error tool result was not emitted");

		expect(toolResultEntry.block).toMatchObject({
			type: "tool_result",
			tool_use_id: "call_failed_screenshot",
			is_error: true,
		});
		expect(toolResultEntry.block.content).toEqual([{ type: "text", text: "Screenshot capture failed." }]);

		const imageIndex = entries.findIndex(entry => entry.block.type === "image");
		const imageEntry = entries[imageIndex];
		if (!imageEntry) throw new Error("Anthropic error tool image was not hoisted");
		expect(imageIndex).toBeGreaterThan(toolResultIndex);
		expect(imageEntry.role).toBe("user");
		expect(imageEntry.block).toEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "AQID",
			},
		});
	});

	it("maps Claude 4.5 reasoning effort to budget and clamps it below maxTokens", () => {
		const model: Model<"zed-agent"> = makeModel({
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			reasoning: true,
			contextWindow: 200000,
			maxTokens: 128000,
			input: ["text", "image"],
		});
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
		const mockModel: Model<"zed-agent"> = makeModel({
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			reasoning: true,
			contextWindow: 400000,
			maxTokens: 128000,
			input: ["text", "image"],
		});

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
		const model: Model<"zed-agent"> = makeModel({
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			reasoning: true,
			contextWindow: 400_000,
			maxTokens: 128_000,
			input: ["text", "image"],
		});
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
		const mockModel: Model<"zed-agent"> = makeModel({
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 128000,
			input: ["text", "image"],
		});

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
		expect(payload.output_config).toEqual({ effort: "high", include: ["summary"] });

		const messages = payload.messages as Array<{ role: string; content: string }>;
		expect(messages).toBeArray();
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toBe("Hello world");
	});
	it("disables Anthropic thinking for required and named tool choices", () => {
		const model: Model<"zed-agent"> = makeModel({
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			reasoning: true,
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
				defaultLevel: Effort.Medium,
			},
			contextWindow: 1000000,
			maxTokens: 128000,
			input: ["text", "image"],
		});
		const context: Context = {
			messages: [{ role: "user", content: "Use the search tool.", timestamp: 1 }],
			tools: [
				{
					name: "search",
					description: "Search the web",
					parameters: { type: "object", properties: { query: { type: "string" } } },
				},
			],
		};
		const cases = [
			{ toolChoice: "required" as const, expectedToolChoice: { type: "any" } },
			{
				toolChoice: { type: "function", name: "search" } as const,
				expectedToolChoice: { type: "tool", name: "search" },
			},
		] as const;

		for (const testCase of cases) {
			const payload = buildZedProviderRequest("anthropic", context, model, {
				reasoning: Effort.High,
				toolChoice: testCase.toolChoice,
			}) as Record<string, unknown>;

			expect(payload.tool_choice).toEqual(testCase.expectedToolChoice);
			expect(payload.thinking).toBeUndefined();
			expect(payload.output_config).toBeUndefined();
		}
	});

	it("demotes foreign and unsigned thinking when switching Zed models to Claude", () => {
		const model: Model<"zed-agent"> = makeModel({
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
		});
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
		const model: Model<"zed-agent"> = makeModel({
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
		});
		const sampling = {
			temperature: 0.25,
			topP: 0.75,
			topK: 32,
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
			top_k: 32,
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
		expect(enabledThinking.top_k).toBeUndefined();
		expect(enabledThinking.stop_sequences).toEqual(["<END>", "<STOP>", "<DONE>", "<HALT>"]);

		const restrictedDisabledThinking = buildZedProviderRequest(
			"anthropic",
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			makeModel({
				id: "claude-sonnet-5",
				name: "Claude Sonnet 5",
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				input: ["text", "image"],
			}),
			{ ...sampling, disableReasoning: true },
		) as Record<string, unknown>;

		expect(restrictedDisabledThinking.temperature).toBeUndefined();
		expect(restrictedDisabledThinking.top_p).toBeUndefined();
		expect(restrictedDisabledThinking.top_k).toBeUndefined();
		expect(restrictedDisabledThinking.stop_sequences).toEqual(["<END>", "<STOP>", "<DONE>", "<HALT>"]);
	});
	it("pins adaptive Claude effort to low when reasoning is disabled", () => {
		for (const [id, name] of [
			["claude-sonnet-4-6", "Claude Sonnet 4.6"],
			["claude-sonnet-5", "Claude Sonnet 5"],
		] as const) {
			const model: Model<"zed-agent"> = makeModel({
				id,
				name,
				reasoning: true,
				thinking: {
					mode: "anthropic-adaptive",
					efforts: [Effort.Low, Effort.Medium, Effort.High],
					defaultLevel: Effort.Medium,
				},
				contextWindow: 1000000,
				maxTokens: 128000,
				input: ["text", "image"],
			});
			const payload = buildZedProviderRequest(
				"anthropic",
				{ messages: [{ role: "user", content: "Keep this short.", timestamp: 1 }] },
				model,
				{ reasoning: Effort.High, disableReasoning: true },
			) as Record<string, unknown>;

			expect(payload.thinking).toBeUndefined();
			expect(payload.output_config).toEqual({ effort: "low" });
		}
	});

	it("formats Google AI GenerateContentRequest payload and forwards all Gemini sampling controls", () => {
		const mockModel: Model<"zed-agent"> = makeModel({
			id: "gemini-3-flash",
			name: "Gemini 3 Flash",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 66000,
			input: ["text", "image"],
		});

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

	it("nests Gemini function-response images with the tool result that produced them", () => {
		const model: Model<"zed-agent"> = makeModel({
			id: "gemini-3-flash",
			name: "Gemini 3 Flash",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 66_000,
			input: ["text", "image"],
		});
		const payload = buildZedProviderRequest(
			"google",
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
		) as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };

		expect(payload.contents).toEqual([
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							name: "capture",
							response: { output: "Screenshot captured." },
							parts: [{ inlineData: { mimeType: "image/png", data: "AQID" } }],
						},
					},
				],
			},
		]);
	});

	it("replays only valid same-model Gemini thought signatures", () => {
		const mockModel: Model<"zed-agent"> = makeModel({
			id: "gemini-3-flash",
			name: "Gemini 3 Flash",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 66_000,
			input: ["text", "image"],
		});
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

	it("propagates forceReasoningOff to Zed provider options and reduces Gemini thinking to minimal level", async () => {
		const userId = "user_force_reasoning_off";
		const accessToken = "access-token-force-reasoning-off";
		const mockModel: Model<"zed-agent"> = makeModel({
			id: "gemini-3-flash",
			name: "Gemini 3 Flash",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 66_000,
			input: ["text", "image"],
		});
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
			thinkingConfig: { thinkingLevel: "MINIMAL" },
		});
	});

	it("throws ProviderResponseError on standalone Responses error events", async () => {
		const userId = "user_error_event";
		const accessToken = "access-token-error-event";
		const mockModel: Model<"zed-agent"> = makeModel({
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			reasoning: true,
			contextWindow: 400_000,
			maxTokens: 128_000,
			input: ["text", "image"],
		});
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		const fetchMock: FetchImpl = mockFetch(async (_input, init) => {
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			if (body?.organization_id === null) {
				return new Response(JSON.stringify({ token: "llm-token-error-event" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				[
					JSON.stringify({
						event: {
							type: "error",
							error: { code: "invalid_request_error", message: "Invalid payload provided" },
						},
					}),
				].join("\n"),
				{
					status: 200,
					headers: { "content-type": "application/x-ndjson" },
				},
			);
		});

		try {
			const result = await streamSimple(mockModel, context, {
				apiKey: `${userId} ${accessToken}`,
				fetch: fetchMock,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("Error Code invalid_request_error: Invalid payload provided");
		} finally {
			invalidateZedLlmToken(userId, accessToken);
		}
	});
	it("hoists tool-result images out of functionResponse.parts for models with multimodalFunctionResponse: false", () => {
		const model = makeModel({
			id: "google/gemini-2.5-flash",
			compat: {
				provider: "google",
				multimodalFunctionResponse: false,
			},
			input: ["text", "image"],
		});

		const context: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "getImageDescription",
					isError: false,
					timestamp: Date.now(),
					content: [
						{ type: "text", text: "This is a beautiful sunset" },
						{ type: "image", data: "test-image-data", mimeType: "image/png" },
					],
				},
			],
		};

		const request = buildZedProviderRequest("google", context, model) as {
			contents: Array<{ role: string; parts: unknown[] }>;
		};

		// Should have two user messages - one with functionResponse (without images) and one with hoisted images
		expect(request.contents).toHaveLength(2);

		// First message should contain functionResponse without image parts
		expect(request.contents[0]).toEqual({
			role: "user",
			parts: [
				{
					functionResponse: {
						name: "getImageDescription",
						response: { output: "This is a beautiful sunset" },
					},
				},
			],
		});

		// Second message should contain the hoisted image
		expect(request.contents[1]).toEqual({
			role: "user",
			parts: [
				{ text: "Tool result image:" },
				{
					inlineData: {
						mimeType: "image/png",
						data: "test-image-data",
					},
				},
			],
		});
	});

	it("nests images directly inside functionResponse.parts for models with multimodalFunctionResponse: true", () => {
		const model = makeModel({
			id: "google/gemini-3.0-pro",
			compat: {
				provider: "google",
				multimodalFunctionResponse: true,
			},
			input: ["text", "image"],
		});

		const context: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "getImageDescription",
					isError: false,
					timestamp: Date.now(),
					content: [
						{ type: "text", text: "This is a beautiful sunset" },
						{ type: "image", data: "test-image-data", mimeType: "image/png" },
					],
				},
			],
		};

		const request = buildZedProviderRequest("google", context, model) as {
			contents: Array<{ role: string; parts: unknown[] }>;
		};

		// Should have one user message with nested functionResponse containing images
		expect(request.contents).toHaveLength(1);

		// Message should contain functionResponse with image parts nested inside
		expect(request.contents[0]).toEqual({
			role: "user",
			parts: [
				{
					functionResponse: {
						name: "getImageDescription",
						response: { output: "This is a beautiful sunset" },
						parts: [
							{
								inlineData: {
									mimeType: "image/png",
									data: "test-image-data",
								},
							},
						],
					},
				},
			],
		});
	});
	it("exports streamZed as a lazy stream function without throwing at import time", () => {
		// This test verifies that the streamZed function can be imported without throwing
		// and that it's a function that returns an AssistantMessageEventStream when called
		expect(typeof streamZed).toBe("function");

		// We're not actually going to call the function since that would require
		// a real Zed provider connection, but we can verify it exists and is callable
		expect(streamZed).toBeDefined();
		expect(() => {
			// This should not throw at import time
			const fnType = typeof streamZed;
			expect(fnType).toBe("function");
		}).not.toThrow();
	});
});
