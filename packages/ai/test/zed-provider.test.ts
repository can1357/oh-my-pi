import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { buildZedProviderRequest, resolveProviderKind } from "../src/providers/zed";
import type { Context, Model } from "../src/types";

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
		const params = tools[0].functionDeclarations[0].parameters as { properties: { limit: Record<string, unknown> } };
		expect(params.properties.limit.exclusiveMinimum).toBeUndefined();
		expect(payload.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "medium" } });
	});
});
