import { describe, expect, it } from "bun:test";
import { buildAnthropicClientOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, TJsonSchema, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

const CUSTOM_MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-haiku-4.5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "internal-anthropic",
	baseUrl: "https://llm.example.com/v1/messages",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const TOOLS: Tool[] = [
	{
		name: "ping",
		description: "ping",
		parameters: {
			type: "object",
			properties: { msg: { type: "string" } },
			required: ["msg"],
		} as TJsonSchema,
	},
];

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
	tools: TOOLS,
};

function aborted(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

describe("issue #5572 — custom Anthropic endpoints reject eager_input_streaming", () => {
	it("omits eager_input_streaming from custom endpoint tool definitions", async () => {
		const model = buildModel(CUSTOM_MODEL_SPEC);
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamAnthropic(model, CONTEXT, {
			apiKey: "sk-ant-test",
			signal: aborted(),
			onPayload: payload => resolve(payload),
		});

		const payload = (await promise) as { tools?: Array<Record<string, unknown>> };
		expect(payload.tools).toHaveLength(1);
		expect(payload.tools?.[0]).not.toHaveProperty("eager_input_streaming");
	});

	it("omits the legacy fine-grained streaming beta from custom endpoint requests", () => {
		const model = buildModel(CUSTOM_MODEL_SPEC);
		const options = buildAnthropicClientOptions({
			model,
			apiKey: "sk-ant-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			hasTools: true,
		});

		expect(options.defaultHeaders["anthropic-beta"] ?? "").not.toContain("fine-grained-tool-streaming-2025-05-14");
	});

	it("omits eager_input_streaming when a baseUrl-only override reroutes a canonical model", async () => {
		// Mirrors `pi.registerProvider("anthropic", { baseUrl })`: the registry
		// mutates `baseUrl` without rebuilding compat, so the resolved
		// `supportsEagerToolInputStreaming` stays canonical-true. The authored
		// spec never opted in, so the custom endpoint must not receive the flag.
		const model = buildModel({
			...CUSTOM_MODEL_SPEC,
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
		});
		expect(model.compat.supportsEagerToolInputStreaming).toBe(true);
		model.baseUrl = "https://proxy.example.com";

		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamAnthropic(model, CONTEXT, {
			apiKey: "sk-ant-test",
			signal: aborted(),
			onPayload: payload => resolve(payload),
		});

		const payload = (await promise) as { tools?: Array<Record<string, unknown>> };
		expect(payload.tools).toHaveLength(1);
		expect(payload.tools?.[0]).not.toHaveProperty("eager_input_streaming");
	});

	it("omits eager_input_streaming after a baseUrl override even when the spec baked a resolved official compat", async () => {
		// Some bundled models (e.g. `claude-3-7-sonnet-20250219`) ship a
		// fully-resolved compat block in models.json, so `compatConfig` carries
		// `supportsEagerToolInputStreaming: true`. Gating on `compatConfig` alone
		// would leak the field; the fix keys on the resolved `officialEndpoint`
		// provenance instead.
		const model = buildModel({
			...CUSTOM_MODEL_SPEC,
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			compat: { supportsEagerToolInputStreaming: true },
		});
		expect(model.compat.officialEndpoint).toBe(true);
		expect(model.compatConfig?.supportsEagerToolInputStreaming).toBe(true);
		model.baseUrl = "https://proxy.example.com";

		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamAnthropic(model, CONTEXT, {
			apiKey: "sk-ant-test",
			signal: aborted(),
			onPayload: payload => resolve(payload),
		});

		const payload = (await promise) as { tools?: Array<Record<string, unknown>> };
		expect(payload.tools?.[0]).not.toHaveProperty("eager_input_streaming");
	});

	it("honors explicit compat opt-in on a custom endpoint", async () => {
		const model = buildModel({
			...CUSTOM_MODEL_SPEC,
			compat: { supportsEagerToolInputStreaming: true },
		});

		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamAnthropic(model, CONTEXT, {
			apiKey: "sk-ant-test",
			signal: aborted(),
			onPayload: payload => resolve(payload),
		});

		const payload = (await promise) as { tools?: Array<Record<string, unknown>> };
		expect(payload.tools?.[0]).toHaveProperty("eager_input_streaming", true);
	});

	it("keeps eager tool input streaming on the official Anthropic endpoint", () => {
		const model = buildModel({
			...CUSTOM_MODEL_SPEC,
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
		});

		expect(model.compat.supportsEagerToolInputStreaming).toBe(true);
	});
});
