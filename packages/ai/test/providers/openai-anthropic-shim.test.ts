import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { streamOpenAIAnthropicShim } from "../../src/providers/openai-anthropic-shim";
import type { Context, Model, ModelSpec } from "../../src/types";

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "Reply OK", timestamp: 0 }],
	tools: [],
};

const staleOpenAIClaude: Model<"openai-completions"> = buildModel({
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8 via shim",
	api: "openai-completions",
	provider: "synthetic",
	baseUrl: "https://api.synthetic.new/openai/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 64_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	thinking: {
		mode: "effort",
		efforts: [Effort.Low, Effort.High],
	},
} satisfies ModelSpec<"openai-completions">);

const budgetOpenAIClaude: Model<"openai-completions"> = buildModel({
	id: "claude-3-7-sonnet-20250219",
	name: "Claude 3.7 Sonnet via shim",
	api: "openai-completions",
	provider: "synthetic",
	baseUrl: "https://api.synthetic.new/openai/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 64_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	thinking: {
		mode: "budget",
		efforts: [Effort.Low, Effort.High],
	},
} satisfies ModelSpec<"openai-completions">);

const offCapableOpenAIClaude: Model<"openai-completions"> = buildModel({
	id: "claude-opus-5",
	name: "Claude Opus 5 via shim",
	api: "openai-completions",
	provider: "synthetic",
	reasoning: true,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 64_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	baseUrl: "https://api.anthropic.com",
	thinking: {
		mode: "effort",
		efforts: [Effort.Low, Effort.High],
		supportsDisabledThinking: true,
		disabledThinkingMaxEffort: Effort.High,
	},
} satisfies ModelSpec<"openai-completions">);

describe("OpenAI/Anthropic shim thinking transport", () => {
	it("re-derives Anthropic Claude thinking mode instead of carrying OpenAI effort metadata", async () => {
		let payload: Record<string, unknown> | undefined;
		const stream = streamOpenAIAnthropicShim(
			staleOpenAIClaude,
			context,
			{
				apiKey: "test-key",
				format: "anthropic",
				anthropicThinkingMode: "adaptive",
				onPayload: body => {
					payload = body as Record<string, unknown>;
					throw new Error("stop after payload capture");
				},
			},
			{
				anthropicBaseUrl: "https://api.synthetic.new/anthropic",
				defaultFormat: "anthropic",
			},
		);
		await stream.result();

		expect(payload?.thinking).toMatchObject({ type: "adaptive" });
		expect(payload?.output_config).toBeUndefined();
	});

	it("forwards reasoning effort after re-deriving Anthropic Claude thinking metadata", async () => {
		let payload: Record<string, unknown> | undefined;
		const stream = streamOpenAIAnthropicShim(
			staleOpenAIClaude,
			context,
			{
				apiKey: "test-key",
				format: "anthropic",
				reasoning: Effort.High,
				onPayload: body => {
					payload = body as Record<string, unknown>;
					throw new Error("stop after payload capture");
				},
			},
			{
				anthropicBaseUrl: "https://api.synthetic.new/anthropic",
				defaultFormat: "anthropic",
			},
		);
		await stream.result();

		expect(payload?.thinking).toMatchObject({ type: "adaptive" });
		expect(payload?.output_config).toEqual({ effort: "high" });
	});

	it("maps neutral adaptive mode through the Anthropic transport", async () => {
		let payload: Record<string, unknown> | undefined;
		const stream = streamOpenAIAnthropicShim(
			staleOpenAIClaude,
			context,
			{
				apiKey: "test-key",
				format: "anthropic",
				thinkingMode: "adaptive",
				onPayload: body => {
					payload = body as Record<string, unknown>;
					throw new Error("stop after payload capture");
				},
			},
			{
				anthropicBaseUrl: "https://api.synthetic.new/anthropic",
				defaultFormat: "anthropic",
			},
		);
		await stream.result();

		expect(payload?.thinking).toMatchObject({ type: "adaptive" });
		expect(payload?.output_config).toBeUndefined();
	});

	it("ignores neutral adaptive mode for non-adaptive Anthropic transports", async () => {
		let payload: Record<string, unknown> | undefined;
		const stream = streamOpenAIAnthropicShim(
			budgetOpenAIClaude,
			context,
			{
				apiKey: "test-key",
				format: "anthropic",
				thinkingMode: "adaptive",
				onPayload: body => {
					payload = body as Record<string, unknown>;
					throw new Error("stop after payload capture");
				},
			},
			{
				anthropicBaseUrl: "https://api.synthetic.new/anthropic",
				defaultFormat: "anthropic",
			},
		);
		await stream.result();

		expect(payload?.thinking).toEqual({ type: "disabled" });
		expect(payload?.output_config).toBeUndefined();
	});

	it("maps neutral off mode to the adaptive-only suppression path", async () => {
		let payload: Record<string, unknown> | undefined;
		const stream = streamOpenAIAnthropicShim(
			staleOpenAIClaude,
			context,
			{
				apiKey: "test-key",
				format: "anthropic",
				reasoning: Effort.High,
				thinkingMode: "off",
				onPayload: body => {
					payload = body as Record<string, unknown>;
					throw new Error("stop after payload capture");
				},
			},
			{
				anthropicBaseUrl: "https://api.synthetic.new/anthropic",
				defaultFormat: "anthropic",
			},
		);
		await stream.result();

		expect(payload?.thinking).toBeUndefined();
		expect(payload?.output_config).toEqual({ effort: "low" });
	});

	it("preserves effort when neutral off mode maps to disabled Anthropic thinking", async () => {
		let payload: Record<string, unknown> | undefined;
		const stream = streamOpenAIAnthropicShim(
			offCapableOpenAIClaude,
			context,
			{
				apiKey: "test-key",
				format: "anthropic",
				reasoning: Effort.High,
				thinkingMode: "off",
				onPayload: body => {
					payload = body as Record<string, unknown>;
					throw new Error("stop after payload capture");
				},
			},
			{
				anthropicBaseUrl: "https://api.synthetic.new/anthropic",
				defaultFormat: "anthropic",
				anthropicThinkingMode: "anthropic-adaptive",
			},
		);
		await stream.result();

		expect(payload?.thinking).toEqual({ type: "disabled" });
		expect(payload?.output_config).toEqual({ effort: "high" });
	});

	it("lets disableReasoning suppress a supplied effort after Anthropic re-derivation", async () => {
		let payload: Record<string, unknown> | undefined;
		const stream = streamOpenAIAnthropicShim(
			staleOpenAIClaude,
			context,
			{
				apiKey: "test-key",
				format: "anthropic",
				reasoning: Effort.High,
				disableReasoning: true,
				onPayload: body => {
					payload = body as Record<string, unknown>;
					throw new Error("stop after payload capture");
				},
			},
			{
				anthropicBaseUrl: "https://api.synthetic.new/anthropic",
				defaultFormat: "anthropic",
			},
		);
		await stream.result();

		expect(payload?.thinking).toBeUndefined();
		expect(payload?.output_config).toEqual({ effort: "low" });
	});
});
