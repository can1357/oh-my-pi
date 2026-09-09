import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import type { MessageCreateParamsStreaming } from "../../src/providers/anthropic-wire";
import { type KimiApiFormat, type KimiOptions, streamKimi } from "../../src/providers/kimi";
import { streamOpenAIAnthropicShim } from "../../src/providers/openai-anthropic-shim";
import {
	applyChatCompletionsCompatPolicy,
	type OpenAICompletionsParams,
	resolveOpenAICompatPolicy,
} from "../../src/providers/openai-shared";
import * as kimiOauth from "../../src/registry/oauth/kimi";
import { streamSimple } from "../../src/stream";
import type { Context, Model } from "../../src/types";

const BASE_CHAT_COMPLETIONS_PARAMS: OpenAICompletionsParams = { messages: [], model: "unused", stream: true };
const KIMI_HEADERS = Object.freeze({
	"User-Agent": "KimiCLI/test",
	"X-Msh-Platform": "kimi_cli",
	"X-Msh-Version": "test",
	"X-Msh-Device-Name": "test",
	"X-Msh-Device-Model": "test",
	"X-Msh-Os-Version": "test",
	"X-Msh-Device-Id": "test",
});
const TITLE_CONTEXT: Context = {
	systemPrompt: ["Generate a title."],
	messages: [{ role: "user", content: "Explain the login failure", timestamp: 0 }],
	tools: [
		{
			name: "set_title",
			description: "Set title",
			parameters: {
				type: "object",
				properties: { title: { type: "string" } },
				required: ["title"],
				additionalProperties: false,
			},
		},
	],
};

const K3_MODEL = buildModel({
	id: "kimi-k3",
	name: "K3",
	api: "openai-completions",
	provider: "kimi-code",
	baseUrl: "https://api.kimi.com/coding/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 32_000,
	thinking: {
		mode: "effort",
		efforts: [Effort.Low, Effort.High, Effort.Max],
		defaultLevel: Effort.Max,
		requiresEffort: true,
	},
	compat: {
		thinkingFormat: "kimi",
		kimiApiFormat: "openai",
		reasoningContentField: "reasoning_content",
		supportsDeveloperRole: false,
	},
} satisfies ModelSpec<"openai-completions">);

async function captureKimiPayload(
	model: Model<"openai-completions">,
	reasoning: Effort,
	format?: KimiApiFormat,
): Promise<unknown> {
	let payload: unknown;
	const stream = streamKimi(
		model,
		{
			systemPrompt: [],
			messages: [{ role: "user", content: "Reply OK", timestamp: 0 }],
			tools: [],
		},
		{
			...(format ? { format } : {}),
			apiKey: "test-key",
			reasoning,
			onPayload: body => {
				payload = body;
				throw new Error("stop after payload capture");
			},
		},
	);
	await stream.result();
	if (payload === undefined) throw new Error("Kimi request payload was not captured");
	return payload;
}

async function captureKimiCachePayload(
	format: KimiApiFormat,
	options: Omit<KimiOptions, "apiKey" | "format" | "onPayload">,
): Promise<Record<string, unknown>> {
	let payload: unknown;
	const stream = streamKimi(
		K3_MODEL,
		{
			systemPrompt: [],
			messages: [{ role: "user", content: "Reply OK", timestamp: 0 }],
			tools: [],
		},
		{
			...options,
			apiKey: "test-key",
			format,
			onPayload: body => {
				payload = body;
				throw new Error("stop after payload capture");
			},
		},
	);
	await stream.result();
	if (payload === undefined || typeof payload !== "object" || payload === null) {
		throw new Error("Kimi cache-affinity payload was not captured");
	}
	return payload as Record<string, unknown>;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OpenAI/Anthropic compatibility shim cache affinity", () => {
	it("forwards an explicit cache key through its OpenAI-compatible transport", async () => {
		const cacheKey = "shared-shim-cache-key";
		const cacheModel = buildModel({
			id: "shim-cache-model",
			name: "Shim Cache Model",
			api: "openai-completions",
			provider: "synthetic",
			baseUrl: "https://shim-cache.example/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
			compat: { promptCacheSessionHeader: "x-grok-conv-id" },
		} satisfies ModelSpec<"openai-completions">);
		let requestHeaders: Headers | undefined;
		const stream = streamOpenAIAnthropicShim(
			cacheModel,
			TITLE_CONTEXT,
			{
				apiKey: "test-key",
				format: "openai",
				cacheRetention: "none",
				promptCacheKey: cacheKey,
				fetch: async (_input, init) => {
					requestHeaders = new Headers(init?.headers);
					return new Response(JSON.stringify({ error: { message: "stop after header capture" } }), {
						status: 400,
						headers: { "content-type": "application/json" },
					});
				},
			},
			{
				anthropicBaseUrl: "https://shim-cache.example",
				defaultFormat: "openai",
			},
		);

		await stream.result();

		expect(requestHeaders?.get("x-grok-conv-id")).toBe(cacheKey);
	});
});

describe("Kimi Code prompt cache affinity", () => {
	it("sends the explicit cache key on both supported transports", async () => {
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(KIMI_HEADERS);

		const openaiPayload = await captureKimiCachePayload("openai", {
			promptCacheKey: "stable-cache-key",
			sessionId: "side-channel-session",
		});
		const anthropicPayload = await captureKimiCachePayload("anthropic", {
			promptCacheKey: "stable-cache-key",
			sessionId: "side-channel-session",
		});

		expect(openaiPayload.prompt_cache_key).toBe("stable-cache-key");
		expect(anthropicPayload.metadata).toEqual({ user_id: "stable-cache-key" });
	});

	it("falls back to the provider session on both supported transports", async () => {
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(KIMI_HEADERS);

		const openaiPayload = await captureKimiCachePayload("openai", { sessionId: "stable-session" });
		const anthropicPayload = await captureKimiCachePayload("anthropic", { sessionId: "stable-session" });

		expect(openaiPayload.prompt_cache_key).toBe("stable-session");
		expect(anthropicPayload.metadata).toEqual({ user_id: "stable-session" });
	});

	it("preserves an explicit Anthropic metadata user id", async () => {
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(KIMI_HEADERS);

		const payload = await captureKimiCachePayload("anthropic", {
			metadata: { user_id: "caller-user-id" },
			promptCacheKey: "automatic-cache-key",
		});

		expect(payload.metadata).toEqual({ user_id: "caller-user-id" });
	});

	it("falls back from an invalid Anthropic metadata user id", async () => {
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(KIMI_HEADERS);

		const payload = await captureKimiCachePayload("anthropic", {
			metadata: { user_id: 0 },
			promptCacheKey: "automatic-cache-key",
		});

		expect(payload.metadata).toEqual({ user_id: "automatic-cache-key" });
	});

	it("omits automatic affinity when prompt caching is disabled", async () => {
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(KIMI_HEADERS);
		const options = {
			cacheRetention: "none",
			promptCacheKey: "disabled-cache-key",
			sessionId: "disabled-session",
		} as const;

		const openaiPayload = await captureKimiCachePayload("openai", options);
		const anthropicPayload = await captureKimiCachePayload("anthropic", options);

		expect(openaiPayload).not.toHaveProperty("prompt_cache_key");
		expect(anthropicPayload).not.toHaveProperty("metadata");
	});
});

describe("Kimi K3 thinking transport", () => {
	it("sends every live named effort through Kimi's native thinking object by default", async () => {
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(KIMI_HEADERS);

		for (const effort of [Effort.Low, Effort.High, Effort.Max]) {
			const payload = await captureKimiPayload(K3_MODEL, effort);
			expect(payload).toMatchObject({ thinking: { type: "enabled", effort } });
			expect(payload).not.toHaveProperty("reasoning_effort");
		}
	});

	it("uses adaptive named effort rather than a token budget for an explicit Anthropic override", async () => {
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(KIMI_HEADERS);

		const payload = await captureKimiPayload(K3_MODEL, Effort.Max, "anthropic");

		expect(payload).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: Effort.Max },
		});
		expect(payload).not.toHaveProperty("thinking.budget_tokens");
	});

	it("keeps the legacy K2 default on the Anthropic transport", async () => {
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(KIMI_HEADERS);
		const model = getBundledModel<"openai-completions">("kimi-code", "kimi-for-coding");

		const payload = await captureKimiPayload(model, Effort.High);

		expect(payload).toMatchObject({ thinking: { type: "enabled" } });
		expect(payload).toHaveProperty("thinking.budget_tokens");
	});

	it("clamps disabled thinking to the lowest effort for a mandatory-thinking K3", async () => {
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(KIMI_HEADERS);

		let payload: unknown;
		const stream = streamSimple(
			K3_MODEL,
			{
				systemPrompt: [],
				messages: [{ role: "user", content: "Reply OK", timestamp: 0 }],
				tools: [],
			},
			{
				apiKey: "test-key",
				disableReasoning: true,
				onPayload: body => {
					payload = body;
					throw new Error("stop after payload capture");
				},
			},
		);
		await stream.result();

		expect(payload).toMatchObject({ thinking: { type: "enabled", effort: Effort.Low } });
		expect(payload).not.toMatchObject({ thinking: { type: "disabled" } });
	});

	it("downgrades named tool choice to required for K3 thinking", async () => {
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(KIMI_HEADERS);
		expect(K3_MODEL.compat.nativeKimiK3Reasoning).toBe(true);
		let payload: unknown;
		const capturePayload = async (
			model: Model<"openai-completions">,
			toolChoice: "required" | { type: "tool"; name: string },
			tools = TITLE_CONTEXT.tools,
		) => {
			const stream = streamKimi(
				model,
				{ ...TITLE_CONTEXT, tools },
				{
					apiKey: "test-key",
					format: "openai",
					reasoning: Effort.Max,
					toolChoice,
					onPayload: body => {
						payload = body;
						throw new Error("stop after payload capture");
					},
				},
			);
			await stream.result();
		};

		await capturePayload(K3_MODEL, { type: "tool", name: "set_title" });
		expect(payload).toMatchObject({
			thinking: { type: "enabled" },
			tool_choice: "required",
			tools: [{ type: "function", function: { name: "set_title" } }],
		});

		await capturePayload(K3_MODEL, "required");
		expect(payload).toMatchObject({
			thinking: { type: "enabled" },
			tool_choice: "required",
			tools: [{ type: "function", function: { name: "set_title" } }],
		});

		await capturePayload(K3_MODEL, { type: "tool", name: "missing_tool" }, []);
		expect((payload as { tool_choice?: unknown }).tool_choice).toBeUndefined();
	});
});

describe("Kimi K2.7 Code thinking policy", () => {
	it("expresses disabled thinking explicitly for title-generator-style Kimi Code requests", () => {
		const model = getBundledModel<"openai-completions">("kimi-code", "kimi-for-coding");
		const policy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			disableReasoning: true,
			toolChoice: { type: "tool", name: "set_title" },
		});
		const params = { ...BASE_CHAT_COMPLETIONS_PARAMS };

		applyChatCompletionsCompatPolicy(params, policy);

		// Kimi's native hosts speak the z.ai binary thinking field: a disabled
		// request carries `{ type: "disabled" }` rather than omitting the block.
		expect((params as Record<string, unknown>).thinking).toEqual({ type: "disabled" });
		// Thinking yields to a forced tool choice (#5758 review): the choice is
		// honored and reasoning is turned off, instead of downgrading the choice.
		expect(model.compat.supportsForcedToolChoice).toBe(true);
		expect(model.compat.disableReasoningOnForcedToolChoice).toBe(true);
	});

	it("preserves the forced tool choice on Kimi Code's Anthropic endpoint", async () => {
		const model = getBundledModel<"openai-completions">("kimi-code", "kimi-for-coding");
		let payload: MessageCreateParamsStreaming | undefined;
		const stream = streamOpenAIAnthropicShim(
			model,
			TITLE_CONTEXT,
			{
				apiKey: "test-key",
				maxTokens: 1024,
				disableReasoning: true,
				toolChoice: { type: "tool", name: "set_title" },
				onPayload: body => {
					payload = body as MessageCreateParamsStreaming;
					throw new Error("stop after payload capture");
				},
			},
			{
				anthropicBaseUrl: "https://api.kimi.com/coding",
				defaultFormat: "anthropic",
			},
		);

		await stream.result();

		// The resolved Kimi Code policy honors the caller's named choice while
		// explicitly disabling thinking for this title-generation request.
		expect(payload?.tool_choice).toEqual({ type: "tool", name: "set_title" });
		expect(payload?.thinking).toBeUndefined();
	});

	it("preserves forced tool choice for the reviewed Kimi Code aliases", async () => {
		// The catalog bakes each alias's reviewed identity and wire policy.
		for (const id of ["k3", "kimi-for-coding", "kimi-for-coding-highspeed"]) {
			const model = getBundledModel<"openai-completions">("kimi-code", id);
			let payload: MessageCreateParamsStreaming | undefined;
			const stream = streamOpenAIAnthropicShim(
				model,
				TITLE_CONTEXT,
				{
					apiKey: "test-key",
					maxTokens: 1024,
					toolChoice: { type: "tool", name: "set_title" },
					onPayload: body => {
						payload = body as MessageCreateParamsStreaming;
						throw new Error("stop after payload capture");
					},
				},
				{
					anthropicBaseUrl: "https://api.kimi.com/coding",
					defaultFormat: "anthropic",
				},
			);

			await stream.result();

			expect(payload?.tool_choice).toEqual({ type: "tool", name: "set_title" });
		}
	});

	it("uses the configured Kimi base URL for Anthropic requests", async () => {
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(KIMI_HEADERS);
		const bundledModel = getBundledModel<"openai-completions">("kimi-code", "kimi-for-coding");
		const model = { ...bundledModel, baseUrl: "https://gateway.example.com/v1" };
		let requestedUrl: string | undefined;
		const stream = streamKimi(
			model,
			{
				systemPrompt: [],
				messages: [{ role: "user", content: "Reply OK", timestamp: 0 }],
				tools: [],
			},
			{
				format: "anthropic",
				apiKey: "gateway-key",
				fetch: async input => {
					requestedUrl = String(input);
					return new Response(
						JSON.stringify({
							type: "error",
							error: { type: "authentication_error", message: "stop after URL capture" },
						}),
						{ status: 401, headers: { "content-type": "application/json" } },
					);
				},
			},
		);

		await stream.result();

		expect(requestedUrl).toBe("https://gateway.example.com/v1/messages");
	});

	it("omits disabled thinking for native Moonshot Kimi K2.7 Code variants", () => {
		for (const modelId of ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"]) {
			const model = getBundledModel<"openai-completions">("moonshot", modelId);
			const policy = resolveOpenAICompatPolicy(model, {
				endpoint: "chat-completions",
				disableReasoning: true,
			});
			const params = { ...BASE_CHAT_COMPLETIONS_PARAMS };
			applyChatCompletionsCompatPolicy(params, policy);

			expect("thinking" in params).toBe(false);
			expect(model.compat.supportsForcedToolChoice).toBe(false);
		}
	});

	it("keeps the openai disable shape for non-native Kimi K2.7 Code aliases", () => {
		for (const { provider, id } of [
			{ provider: "fireworks", id: "kimi-k2.7-code" },
			{ provider: "openrouter", id: "moonshotai/kimi-k2.7-code" },
		] as const) {
			const model = getBundledModel<"openai-completions">(provider, id);
			expect(model.compat.supportsForcedToolChoice).toBe(true);
			expect(model.compat.reasoningDisableMode).not.toBe("omit");
		}
	});

	it("keeps explicit disabled thinking for Kimi K2.6", () => {
		const model = getBundledModel<"openai-completions">("moonshot", "kimi-k2.6");
		const policy = resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			disableReasoning: true,
		});
		const params = { ...BASE_CHAT_COMPLETIONS_PARAMS };

		applyChatCompletionsCompatPolicy(params, policy);

		expect(params.thinking).toEqual({ type: "disabled" });
	});
});
