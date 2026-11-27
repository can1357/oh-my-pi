import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { renderDemotedThinking } from "@oh-my-pi/pi-ai/dialect";
import {
	applyOpenRouterRoutingVariant,
	convertMessages,
	type OpenAICompletionsOptions,
	parseChunkUsage,
	streamOpenAICompletions,
} from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	OpenAICompat,
	Tool,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { parseReasoningDetailsSignature } from "@oh-my-pi/pi-ai/utils/reasoning-source";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ResolvedOpenAICompat } from "@oh-my-pi/pi-catalog/types";
import { serializeAlibabaTokenPlanCredential } from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";
import { minimaxTokenPlanOpenAIModel } from "./helpers";

const gpt4oMiniSpec: ModelSpec<"openai-completions"> = (() => {
	const {
		compat: _resolved,
		compatConfig,
		...rest
	} = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
	return { ...rest, compat: compatConfig };
})();

const copilotGeminiSpec: ModelSpec<"openai-completions"> = {
	...gpt4oMiniSpec,
	id: "gemini-4-neon",
	name: "Gemini 4 Neon",
	api: "openai-completions",
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: true,
	compat: undefined,
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function toObject(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function getNestedObject(value: unknown, key: string): Record<string, unknown> | null {
	const obj = toObject(value);
	if (!obj) return null;
	return toObject(obj[key]);
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}

	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: "hello",
				timestamp: Date.now(),
			},
		],
	};
}

function zaiGlm52Model(): Model<"openai-completions"> {
	return buildModel({
		id: "glm-5.2",
		name: "GLM-5.2",
		api: "openai-completions",
		provider: "zhipu-coding-plan",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		reasoning: true,
		compat: {
			thinkingFormat: "zai",
			reasoningContentField: "reasoning_content",
			supportsDeveloperRole: false,
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	} satisfies ModelSpec<"openai-completions">);
}

const alibabaQwen38Flash = getBundledModel<"openai-completions">("alibaba-token-plan", "qwen3.8-flash");
const alibabaTokenPlanApiKey = serializeAlibabaTokenPlanCredential("sk-sp-test", "session_id=test");
const mistralSmallLatest = getBundledModel<"openai-completions">("mistral", "mistral-small-latest");

function kimiZaiModel(): Model<"openai-completions"> {
	return buildModel({
		...gpt4oMiniSpec,
		api: "openai-completions",
		provider: "moonshot",
		baseUrl: "https://api.moonshot.ai/v1",
		id: "kimi-k2.6",
		reasoning: true,
	} as ModelSpec<"openai-completions">);
}

async function captureOpenAICompletionsPayload(
	model: Model<"openai-completions">,
	context: Context = baseContext(),
	options?: OpenAICompletionsOptions,
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const fetchMock = createMockFetch(["[DONE]"]);
	streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		fetch: fetchMock,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload),
		...options,
	});
	return promise;
}

function getPayloadMessages(payload: unknown): Record<string, unknown>[] {
	const payloadObject = toObject(payload);
	const messages = payloadObject?.messages;
	if (!Array.isArray(messages)) throw new Error("payload messages missing");
	return messages.map(message => {
		const messageObject = toObject(message);
		if (!messageObject) throw new Error("payload message is not an object");
		return messageObject;
	});
}

function getLastPayloadContent(payload: unknown): unknown {
	const lastMessage = getPayloadMessages(payload).at(-1);
	if (!lastMessage) throw new Error("payload has no messages");
	return lastMessage.content;
}

function getLastTextPart(content: unknown): Record<string, unknown> | undefined {
	if (!Array.isArray(content)) return undefined;
	for (let index = content.length - 1; index >= 0; index--) {
		const part = toObject(content[index]);
		if (part?.type === "text") return part;
	}
	return undefined;
}

describe("openai-completions compatibility", () => {
	it("omits sampling params for OpenAI reasoning models", async () => {
		const model = buildModel({
			...gpt4oMiniSpec,
			id: "gpt-5.6-luna",
			provider: "github-copilot",
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		expect(model.compat.supportsSamplingParams).toBe(false);

		const payload = await captureOpenAICompletionsPayload(model, undefined, { temperature: 0 });
		expect(toObject(payload)?.temperature).toBeUndefined();
	});

	it("serializes assistant text content as a plain string", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const compat = {
			supportsStore: true,
			supportsDeveloperRole: true,
			supportsMultipleSystemMessages: true,
			supportsReasoningEffort: true,
			reasoningEffortMap: {},
			supportsUsageInStreaming: true,
			supportsToolChoice: true,
			supportsForcedToolChoice: true,
			supportsNamedToolChoice: true,
			disableReasoningOnForcedToolChoice: false,
			disableReasoningOnToolChoice: false,
			maxTokensField: "max_completion_tokens",
			requiresToolResultName: false,
			requiresAssistantAfterToolResult: false,
			foldUserAfterToolResult: false,
			requiresThinkingAsText: false,
			requiresMistralToolIds: false,
			thinkingFormat: "openai",
			reasoningDisableMode: "lowest-effort",
			omitReasoningEffort: false,
			includeEncryptedReasoning: true,
			filterReasoningHistory: false,
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: false,
			requiresReasoningContentForAllAssistantTurns: false,
			allowsSyntheticReasoningContentForToolCalls: true,
			replayReasoningContent: false,
			qwenPreserveThinking: false,
			qwenTemplateReasoningEffort: false,
			requiresAssistantContentForToolCalls: false,
			openRouterRouting: {},
			vercelGatewayRouting: {},
			extraBody: {},
			supportsStrictMode: true,
			toolStrictMode: "none",
			supportsReasoningParams: true,
			reasoningOpaqueReplay: false,
			supportsSamplingParams: true,
			supportsPenaltyAndStopParams: true,
			alwaysSendMaxTokens: false,
			isOpenRouterHost: false,
			isVercelGatewayHost: false,
			wireModelIdMode: "raw",
			stripDeepseekSpecialTokens: false,
			neutralizeDeepseekSpecialTokens: false,
			reasoningDeltasMayBeCumulative: false,
			emptyLengthFinishIsContextError: false,
			usesOpenAIToolCallIdLimit: false,
			dropThinkingWhenReasoningEffort: false,
			nativeKimiK3Reasoning: false,
			zaiReasoningEffortDialect: false,
			clampOutputToModelMax: false,
			stripImageInput: false,
			rejectRootObjectUnion: false,
			retryWithoutStrictOnGrammarError: false,
			supportsPromptCacheKey: false,
			splitToolCalls: false,
		} satisfies ResolvedOpenAICompat;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "hello" },
				{ type: "text", text: " world" },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const messages = convertMessages(model, { messages: [assistantMessage] }, compat);
		const assistant = messages.find(message => message.role === "assistant");
		if (assistant?.role !== "assistant") {
			throw new Error("assistant message missing");
		}
		// Ordinary adjacent text blocks (bridge stitching, imported transcripts,
		// streaming chunk splits) preserve their original byte sequence on
		// flatten. The demoted-thinking separator is inserted by the flatten
		// itself, gated on the kDemotedThinking marker, so unmarked blocks like
		// these are never touched.
		expect(assistant.content).toBe("hello world");
	});

	it("prepends thinking text to string assistant content when requiresThinkingAsText is set", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "chain of thought" },
				{ type: "text", text: "final answer" },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const messages = convertMessages(
			model,
			{ messages: [assistantMessage] },
			{
				...model.compat,
				requiresThinkingAsText: true,
			},
		);
		const assistant = messages.find(message => message.role === "assistant");
		if (assistant?.role !== "assistant") throw new Error("assistant message missing");
		// Regression: thinking+text replay used to call `.unshift` on the string
		// content set above (TypeError). Both blocks must survive as one string.
		expect(assistant.content).toBe(`${renderDemotedThinking(model.id, "chain of thought")} final answer`);
	});

	it("emits thinking-only assistant content as a plain string when requiresThinkingAsText is set", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "only thoughts" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const messages = convertMessages(
			model,
			{ messages: [assistantMessage] },
			{
				...model.compat,
				requiresThinkingAsText: true,
			},
		);
		const assistant = messages.find(message => message.role === "assistant");
		if (assistant?.role !== "assistant") throw new Error("assistant message missing");
		expect(assistant.content).toBe(renderDemotedThinking(model.id, "only thoughts"));
	});

	it("preserves multiple system prompts as leading system messages for chat completions", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			model.compat,
		);

		expect(messages.slice(0, 3)).toEqual([
			{ role: "system", content: "stable instructions" },
			{ role: "system", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("uses developer messages for reasoning chat models only when the target supports them", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			reasoning: true,
		} as ModelSpec<"openai-completions">);

		const supportedMessages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			model.compat,
		);

		expect(supportedMessages.slice(0, 3)).toEqual([
			{ role: "developer", content: "stable instructions" },
			{ role: "developer", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);

		const unsupportedMessages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...model.compat, supportsDeveloperRole: false },
		);

		expect(unsupportedMessages.slice(0, 3)).toEqual([
			{ role: "system", content: "stable instructions" },
			{ role: "system", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("defaults supportsDeveloperRole to off for non-OpenAI/Azure hosts", () => {
		// Regression: Moonshot's Kimi chat template rejects the `developer` role
		// with `400 Invalid request: tokenization failed` because `developer` is
		// an OpenAI extension and most other hosts don't carry it through their
		// tokenizer. The default for non-OpenAI/Azure hosts MUST be `system`,
		// so reasoning models on those hosts cannot accidentally emit `developer`.
		const cases: Array<{ provider: string; baseUrl: string; expected: boolean }> = [
			{ provider: "openai", baseUrl: "https://api.openai.com/v1", expected: true },
			{ provider: "azure", baseUrl: "https://example.openai.azure.com/openai", expected: true },
			{ provider: "moonshot", baseUrl: "https://api.moonshot.ai/v1", expected: false },
			{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", expected: false },
			{ provider: "groq", baseUrl: "https://api.groq.com/openai/v1", expected: false },
			{ provider: "github-copilot", baseUrl: "https://api.githubcopilot.com", expected: false },
		];
		for (const { provider, baseUrl, expected } of cases) {
			const model: Model<"openai-completions"> = buildModel({
				...gpt4oMiniSpec,
				api: "openai-completions",
				provider: provider as Model["provider"],
				baseUrl,
				reasoning: true,
			} as ModelSpec<"openai-completions">);
			expect(model.compat.supportsDeveloperRole).toBe(expected);
		}
	});

	it("emits system role for reasoning models on Moonshot (kimi tokenization rejects developer)", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			id: "kimi-k2.5",
			reasoning: true,
		} as ModelSpec<"openai-completions">);

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["you are a helpful assistant"],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			model.compat,
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "system", content: "you are a helpful assistant" },
			{ role: "user", content: "hi" },
		]);
	});

	it("coalesces ordered system prompts when the host disables multi-system support", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...model.compat, supportsMultipleSystemMessages: false },
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "system", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("coalesces system prompts on a developer-role reasoning model when multi-system is disabled", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			reasoning: true,
		} as ModelSpec<"openai-completions">);

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...model.compat, supportsMultipleSystemMessages: false },
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "developer", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("emits separate system prompts for an unknown OpenAI-compatible host when explicitly enabled", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "custom" as Model["provider"],
			baseUrl: "https://example.invalid/v1",
		} as ModelSpec<"openai-completions">);

		const detected = model.compat;
		expect(detected.supportsMultipleSystemMessages).toBe(false);

		const overridden = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...detected, supportsMultipleSystemMessages: true },
		);

		expect(overridden.slice(0, 3)).toEqual([
			{ role: "system", content: "stable instructions" },
			{ role: "system", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("auto-detects MiniMax OpenAI hosts as single-system to satisfy error 2013", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "minimax-code" as Model["provider"],
			baseUrl: "https://api.minimax.io/v1",
		} as ModelSpec<"openai-completions">);

		const detected = model.compat;
		expect(detected.supportsMultipleSystemMessages).toBe(false);

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			detected,
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "system", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("coalesces system blocks for the bundled Fireworks Qwen model (Qwen template rejects multiple)", () => {
		// Repro of the live `fireworks/qwen3.7-plus` 500: the Qwen 3.5+ chat
		// template `internal_server_error`s when more than one leading system
		// block is present, and Fireworks was previously on the multi-system
		// allowlist. The bundled entry must auto-detect single-system.
		const model = getBundledModel<"openai-completions">("fireworks", "qwen3.7-plus");

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			model.compat,
		);

		expect(messages.filter(m => m.role === "system")).toHaveLength(1);
		expect(messages.slice(0, 2)).toEqual([
			{ role: "system", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("reads usage from choice usage fallback", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: "Hello" },
						usage: {
							prompt_tokens: 12,
							completion_tokens: 3,
							prompt_tokens_details: { cached_tokens: 2 },
						},
					},
				],
			},
			{
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(3);
		expect(result.usage.cacheRead).toBe(2);
		expect(result.usage.totalTokens).toBe(15);
	});

	it("freezes DeepSeek response pricing across a UTC tariff transition", async () => {
		const model = getBundledModel("deepseek", "deepseek-v4-flash") as Model<"openai-completions">;
		const peakStart = Date.parse("2026-09-10T03:59:59Z");
		const offPeakStart = Date.parse("2026-09-10T04:00:00Z");
		let now = peakStart;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const releaseFinalUsage = Promise.withResolvers<void>();
		const encoder = new TextEncoder();
		const firstChunk = {
			id: "chatcmpl-tariff",
			choices: [{ index: 0, delta: { content: "Hello" } }],
			usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000 },
		};
		const finalChunk = {
			id: "chatcmpl-tariff",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1_000_000, completion_tokens: 200_000 },
		};
		let requests = 0;
		const fetchMock: FetchImpl = async () => {
			if (requests++ > 0) return createSseResponse([firstChunk, finalChunk, "[DONE]"]);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));
					},
					async pull(controller) {
						await releaseFinalUsage.promise;
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		try {
			const stream = streamOpenAICompletions(model, baseContext(), { apiKey: "test-key", fetch: fetchMock });
			let initialCost: number | undefined;
			for await (const event of stream) {
				if (event.type === "text_delta") {
					initialCost = event.partial.usage.cost.total;
					now = offPeakStart;
					releaseFinalUsage.resolve();
				}
			}
			const first = await stream.result();
			expect(initialCost).toBeCloseTo(0.42, 12);
			expect(first.timestamp).toBe(peakStart);
			expect(first.usage.cost.total).toBeCloseTo(0.54, 12);
			const second = await streamOpenAICompletions(model, baseContext(), {
				apiKey: "test-key",
				fetch: fetchMock,
			}).result();
			expect(second.timestamp).toBe(offPeakStart);
			expect(second.usage.cost.total).toBeCloseTo(0.27, 12);
			expect(first.usage.cost.total).toBeCloseTo(0.54, 12);
		} finally {
			releaseFinalUsage.resolve();
			clock.mockRestore();
		}
	});

	it("preserves opaque tool-call IDs when replaying a custom Chat Completions turn", async () => {
		const model: Model<"openai-completions"> = buildModel({
			id: "gateway-model",
			name: "Gateway Model",
			api: "openai-completions",
			provider: "custom-gateway",
			baseUrl: "https://gateway.example/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		} satisfies ModelSpec<"openai-completions">);
		const toolCallId = "call_abc||gateway_state||opaque";
		const assistant = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: createMockFetch([
				{
					id: "chatcmpl-opaque-tool-id",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										id: toolCallId,
										type: "function",
										function: { name: "read", arguments: '{"path":"README.md"}' },
									},
								],
							},
						},
					],
				},
				{
					id: "chatcmpl-opaque-tool-id",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				},
				"[DONE]",
			]),
		}).result();
		const streamedToolCall = assistant.content.find(content => content.type === "toolCall");
		expect(streamedToolCall?.id).toBe(toolCallId);

		const payload = await captureOpenAICompletionsPayload(model, {
			messages: [
				{ role: "user", content: "Read README", timestamp: 1 },
				assistant,
				{
					role: "toolResult",
					toolCallId,
					toolName: "read",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: 2,
				},
			],
		});
		const replayMessages = getPayloadMessages(payload);
		const assistantPayload = replayMessages.find(message => message.role === "assistant");
		const toolCalls = assistantPayload?.tool_calls;
		if (!Array.isArray(toolCalls)) throw new Error("assistant tool_calls missing");
		expect(toObject(toolCalls[0])?.id).toBe(toolCallId);
		expect(replayMessages.find(message => message.role === "tool")?.tool_call_id).toBe(toolCallId);
	});

	it("keeps unindexed batched tool-call arguments isolated", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-batched-tools",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ function: { name: "bash", arguments: '{"command":"echo hello"}' } },
								{ function: { name: "bash", arguments: '{"command":"echo goodbye"}' } },
							],
						},
					},
				],
			},
			{
				id: "chatcmpl-batched-tools",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		const calls = result.content.filter(content => content.type === "toolCall");
		expect(calls.map(call => call.arguments)).toEqual([{ command: "echo hello" }, { command: "echo goodbye" }]);
	});

	it("routes unindexed batched tool-call continuation chunks back by array offset", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-batched-continuation",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ function: { name: "bash", arguments: '{"command":"echo hello"' } },
								{ function: { name: "bash", arguments: '{"command":"echo goodbye"' } },
							],
						},
					},
				],
			},
			{
				id: "chatcmpl-batched-continuation",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ function: { arguments: "}" } }, { function: { arguments: "}" } }],
						},
					},
				],
			},
			{
				id: "chatcmpl-batched-continuation",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		const calls = result.content.filter(content => content.type === "toolCall");
		expect(calls.map(call => call.arguments)).toEqual([{ command: "echo hello" }, { command: "echo goodbye" }]);
	});

	it("falls through zero cached-token candidates to later non-zero usage fields", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const cases: Array<{
			name: string;
			usage: object;
			expectedCacheRead: number;
		}> = [
			{
				name: "root zero falls through to nested prompt token details",
				usage: {
					prompt_tokens: 50_000,
					completion_tokens: 3,
					cached_tokens: 0,
					prompt_tokens_details: { cached_tokens: 49_216 },
				},
				expectedCacheRead: 49_216,
			},
			{
				name: "missing root uses prompt cache hit tokens",
				usage: {
					prompt_tokens: 100,
					completion_tokens: 3,
					prompt_cache_hit_tokens: 41,
				},
				expectedCacheRead: 41,
			},
			{
				name: "standard nested prompt token details",
				usage: {
					prompt_tokens: 100,
					completion_tokens: 3,
					prompt_tokens_details: { cached_tokens: 37 },
				},
				expectedCacheRead: 37,
			},
			{
				name: "all candidates missing or zero",
				usage: {
					prompt_tokens: 100,
					completion_tokens: 3,
					cached_tokens: 0,
					prompt_cache_hit_tokens: 0,
					prompt_tokens_details: { cached_tokens: 0 },
				},
				expectedCacheRead: 0,
			},
			{
				name: "multiple non-zero fields preserve priority order",
				usage: {
					prompt_tokens: 100,
					completion_tokens: 3,
					cached_tokens: 11,
					prompt_cache_hit_tokens: 13,
					prompt_tokens_details: { cached_tokens: 17 },
				},
				expectedCacheRead: 11,
			},
		];

		for (const testCase of cases) {
			const usage = parseChunkUsage(testCase.usage, model, undefined);
			expect(usage.cacheRead).toBe(testCase.expectedCacheRead);
			expect(usage.input).toBe(
				(testCase.usage as { prompt_tokens: number }).prompt_tokens - testCase.expectedCacheRead,
			);
		}
	});

	it("sends Alibaba Qwen 3.8 Flash reasoning effort on the wire", async () => {
		expect(getSupportedEfforts(alibabaQwen38Flash)).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
		const selectedEffort = clampThinkingLevelForModel(alibabaQwen38Flash, Effort.Minimal);
		expect(selectedEffort).toBe(Effort.Minimal);
		const payload = toObject(
			await captureOpenAICompletionsPayload(alibabaQwen38Flash, undefined, {
				apiKey: alibabaTokenPlanApiKey,
				reasoning: selectedEffort,
			}),
		);

		expect(payload?.enable_thinking).toBe(true);
		expect(payload?.reasoning_effort).toBe("minimal");
		expect(payload?.thinking_budget).toBeUndefined();
	});

	it("replays Alibaba Qwen 3.8 Flash reasoning history", async () => {
		const model = alibabaQwen38Flash;
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Keep this decision for the next turn.",
					thinkingSignature: "reasoning_content",
				},
				{ type: "text", text: "I chose the indexed path." },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const payload = await captureOpenAICompletionsPayload(
			model,
			{
				messages: [
					{ role: "user", content: "Choose an implementation.", timestamp: Date.now() },
					priorAssistant,
					{ role: "user", content: "Continue.", timestamp: Date.now() },
				],
			},
			{ apiKey: alibabaTokenPlanApiKey },
		);
		const assistant = getPayloadMessages(payload).find(message => message.role === "assistant");

		expect(assistant?.reasoning_content).toBe("Keep this decision for the next turn.");
		expect(assistant?.content).toBe("I chose the indexed path.");
	});

	it("sends reasoning_effort:max for the real Z.AI max tier and enables tool streaming", async () => {
		const model = zaiGlm52Model();
		const readTool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(
			model,
			{ ...baseContext(), tools: [readTool] },
			{
				apiKey: "test-key",
				reasoning: "max",
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
				maxTokens: 65_536,
			},
		);
		const payload = await promise;
		const thinking = getNestedObject(payload, "thinking");

		const payloadObject = toObject(payload);

		expect(thinking?.type).toBe("enabled");
		expect(payloadObject?.reasoning_effort).toBe("max");
		expect(payloadObject?.tool_stream).toBe(true);
		expect(payloadObject?.max_tokens).toBe(65_536);
	});

	it("keeps Z.AI tool streaming disabled for native Kimi reasoning models", async () => {
		const model = kimiZaiModel();
		expect(model.compat.thinkingFormat).toBe("zai");
		expect(model.compat.supportsReasoningEffort).toBe(true);
		const readTool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{ ...baseContext(), tools: [readTool] },
			{
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning: "high",
				toolChoice: { type: "tool", name: "read" },
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);
		const payload = await promise;
		const payloadObject = toObject(payload);

		expect(payloadObject?.tool_stream).toBeUndefined();
	});

	it("bakes the honest [high, max] Z.AI GLM-5.2 ladder with no effortMap", () => {
		const model = zaiGlm52Model();
		expect(model.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
		expect(model.thinking?.effortMap).toBeUndefined();
	});

	it("treats finish_reason end as stop", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-end",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "done" } }],
			},
			{
				id: "chatcmpl-end",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "end" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "done" });
	});
	it("surfaces empty Ollama length completions as context-window errors", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "ollama" as Model["provider"],
			id: "local-12b",
			baseUrl: "http://ollama.invalid/v1",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-empty-length",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "length" }],
				usage: {
					prompt_tokens: 8191,
					completion_tokens: 1,
					total_tokens: 8192,
				},
			},
			"[DONE]",
		]);

		const stream = streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		});
		const resultPromise = stream.result();
		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
		}
		const result = await resultPromise;

		expect(result.stopReason).toBe("error");
		expect(eventTypes).toContain("error");
		expect(result.errorMessage).toBe(
			"Model returned no content: prompt filled the context window; raise Ollama num_ctx or shorten the prompt.",
		);
		expect(result.content).toEqual([]);
		expect(result.usage.input).toBe(8191);
		expect(result.usage.output).toBe(1);
	});
	it("preserves empty non-Ollama length completions for recovery", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "custom" as Model["provider"],
			baseUrl: "https://gateway.example/v1",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-empty-length",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "length" }],
			},
			"[DONE]",
		]);

		const stream = streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		});
		const resultPromise = stream.result();
		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
		}
		const result = await resultPromise;

		expect(result.stopReason).toBe("length");
		expect(eventTypes).toContain("done");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([]);
	});

	it("injects compat.extraBody into OpenAI payload", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			compat: {
				extraBody: {
					gateway: "m1-01",
					controller: "mlx",
				},
			},
		} as ModelSpec<"openai-completions">);

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			signal: createAbortedSignal(),
			onPayload: payload => resolve(payload),
		});

		const payload = await promise;
		expect(payload).toEqual(
			expect.objectContaining({
				gateway: "m1-01",
				controller: "mlx",
			}),
		);
	});

	it("preserves the streamed reasoning field name when replay requires reasoning content", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-reasoning-text",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { reasoning_text: "inspect tool output" },
					},
				],
			},
			{
				id: "chatcmpl-reasoning-text",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		expect(result.content).toContainEqual({
			type: "thinking",
			thinking: "inspect tool output",
			thinkingSignature: "reasoning_text",
			summary: false,
		});

		const compat = { ...model.compat, requiresReasoningContentForToolCalls: true };
		const messages = convertMessages(model, { messages: [result] }, compat);
		const assistant = messages.find(message => message.role === "assistant");
		const assistantObject = toObject(assistant);
		expect(assistantObject?.reasoning_text).toBe("inspect tool output");
		expect(assistantObject?.reasoning_content).toBeUndefined();
	});

	it.each([
		{ name: "interleaved reasoning", first: "Check ", second: "the file.", replayText: "Check the file." },
		{ name: "opaque-only reasoning", first: undefined, second: undefined, replayText: undefined },
	])("persists and replays Copilot $name only to the issuing model", async ({ first, second, replayText }) => {
		const model = buildModel(copilotGeminiSpec);
		const deltas = [
			{ reasoning_text: first },
			{ reasoning_opaque: "earlier-state" },
			{
				tool_calls: [{ index: 0, id: "call_first", type: "function", function: { name: "read", arguments: "{}" } }],
			},
			{ reasoning_text: second },
			{ reasoning_opaque: "latest-state" },
			{
				tool_calls: [
					{ index: 1, id: "call_second", type: "function", function: { name: "read", arguments: "{}" } },
				],
			},
			{ reasoning_opaque: "" },
		];
		const fetchMock = createMockFetch([
			...deltas.map(delta => ({ choices: [{ index: 0, delta }] })),
			{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			"[DONE]",
		]);
		const context = baseContext();
		const result = await streamOpenAICompletions(model, context, { apiKey: "test-key", fetch: fetchMock }).result();
		expect(result.stopReason).toBe("toolUse");
		const stored = result.content.find(block => block.type === "thinking")?.thinkingSignature;
		expect(JSON.parse(stored ?? "null")).toMatchObject({ reasoningOpaque: "latest-state" });
		const history: Context = {
			messages: [
				...context.messages,
				result,
				...["call_first", "call_second"].map((toolCallId): ToolResultMessage => ({
					role: "toolResult",
					toolCallId,
					toolName: "read",
					content: [{ type: "text", text: "File contents" }],
					isError: false,
					timestamp: Date.now(),
				})),
			],
		};
		const replay = async (target: Model<"openai-completions">) =>
			getPayloadMessages(await captureOpenAICompletionsPayload(target, history)).find(
				message => message.role === "assistant",
			);
		const expectedReplay: Record<string, unknown> = {
			role: "assistant",
			content: "",
			tool_calls: [
				{ id: "call_first", type: "function", function: { name: "read", arguments: "{}" } },
				{ id: "call_second", type: "function", function: { name: "read", arguments: "{}" } },
			],
			reasoning_opaque: "latest-state",
		};
		if (replayText !== undefined) expectedReplay.reasoning_text = replayText;
		expect(await replay(model)).toEqual(expectedReplay);
		for (const target of [
			buildModel({ ...copilotGeminiSpec, id: "gemini-4-hydrogen" }),
			buildModel({ ...copilotGeminiSpec, provider: "openai", baseUrl: "https://api.openai.com/v1" }),
		]) {
			const foreign = await replay(target);
			expect(foreign?.tool_calls).toHaveLength(2);
			expect(foreign?.reasoning_opaque).toBeUndefined();
			expect(foreign?.reasoning_text).toBeUndefined();
		}
	});

	it.each([{ base: true }, { base: false }])("uses thinking compat for opaque replay ($base)", async ({ base }) => {
		const model = buildModel({
			...copilotGeminiSpec,
			compat: { reasoningOpaqueReplay: base, whenThinking: { reasoningOpaqueReplay: !base } },
		});
		const fetchMock = (opaque: string) =>
			createMockFetch([
				{
					choices: [
						{ index: 0, delta: { content: "Answer", reasoning_text: "Summary", reasoning_opaque: opaque } },
					],
				},
				{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				"[DONE]",
			]);
		const context = baseContext();
		const prior = await streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			reasoning: base ? undefined : "medium",
			fetch: fetchMock("prior-state"),
		}).result();
		let assistant: Record<string, unknown> | undefined;
		const next = await streamOpenAICompletions(
			model,
			{ messages: [...context.messages, prior] },
			{
				apiKey: "test-key",
				reasoning: "medium",
				fetch: fetchMock("next-state"),
				onPayload: payload => {
					assistant = getPayloadMessages(payload).find(message => message.role === "assistant");
				},
			},
		).result();
		expect(assistant?.content).toBe("Answer");
		expect(assistant?.reasoning_opaque).toBe(base ? undefined : "prior-state");
		const signature = next.content.find(block => block.type === "thinking")?.thinkingSignature;
		if (base) {
			expect(signature).toBe("reasoning_text");
		} else {
			expect(JSON.parse(signature ?? "null")).toEqual({ reasoningOpaque: "next-state", field: "reasoning_text" });
		}
	});

	it("preserves reasoning_text summary when an opaque-replay delta also mirrors reasoning_content", async () => {
		const model = buildModel(copilotGeminiSpec);
		const fetchMock = createMockFetch([
			{
				choices: [
					{
						index: 0,
						delta: {
							reasoning_content: "Mirrored summary",
							reasoning_text: "Mirrored summary",
							reasoning_opaque: "mirrored-state",
							content: "Answer",
						},
					},
				],
			},
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			"[DONE]",
		]);
		const context = baseContext();
		const result = await streamOpenAICompletions(model, context, { apiKey: "test-key", fetch: fetchMock }).result();
		const thinking = result.content.find(block => block.type === "thinking");
		expect(thinking?.thinking).toBe("Mirrored summary");
		expect(JSON.parse(thinking?.thinkingSignature ?? "null")).toEqual({
			field: "reasoning_text",
			reasoningOpaque: "mirrored-state",
		});

		const assistant = getPayloadMessages(
			await captureOpenAICompletionsPayload(model, { messages: [...context.messages, result] }),
		).find(message => message.role === "assistant");
		expect(assistant).toEqual({
			role: "assistant",
			content: "Answer",
			reasoning_opaque: "mirrored-state",
			reasoning_text: "Mirrored summary",
		});
	});

	it("drops opaque replay state from errored turns on both capture and replay", async () => {
		const model = buildModel(copilotGeminiSpec);
		const fetchMock = createMockFetch([
			{
				choices: [
					{
						index: 0,
						delta: {
							reasoning_text: "Partial summary",
							reasoning_opaque: "error-state",
						},
					},
				],
			},
			{
				choices: [{ index: 0, delta: { content: "Partial answer" }, finish_reason: "error" }],
			},
			"[DONE]",
		]);
		const context = baseContext();
		const errored = await streamOpenAICompletions(model, context, { apiKey: "test-key", fetch: fetchMock }).result();
		expect(errored.stopReason).toBe("error");
		const thinking = errored.content.find(block => block.type === "thinking");
		expect(thinking?.thinkingSignature).toBe("reasoning_text");

		// Even if an earlier thinking block already carries an opaque envelope on a persisted error turn,
		// replay must not send it back to Copilot.
		const persistedError: AssistantMessage = {
			...errored,
			content: [
				{
					type: "thinking",
					thinking: "Partial summary",
					thinkingSignature: JSON.stringify({ field: "reasoning_text", reasoningOpaque: "error-state" }),
				},
				{ type: "text", text: "Partial answer" },
			],
		};
		const replayed = getPayloadMessages(
			await captureOpenAICompletionsPayload(model, { messages: [...context.messages, persistedError] }),
		).find(message => message.role === "assistant");
		expect(replayed?.reasoning_opaque).toBeUndefined();
		expect(replayed?.reasoning_text).toBeUndefined();
	});

	it.each([
		{ label: "opaque", provider: "github-copilot", envelope: { reasoningOpaque: "stale-state" } },
		{
			label: "details",
			provider: "openrouter",
			envelope: { reasoningDetails: [{ type: "reasoning.encrypted", data: "stale-state" }] },
		},
	])("drops turn-scoped reasoning $label with a malformed call", async ({ provider, envelope }) => {
		const model = buildModel({
			...copilotGeminiSpec,
			provider,
			baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : copilotGeminiSpec.baseUrl,
		});
		const assistant: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			content: [
				{
					type: "thinking",
					thinking: "Check the file.",
					thinkingSignature: JSON.stringify({ ...envelope, field: "reasoning_text" }),
				},
				{ type: "toolCall", id: "call_bad", name: "", arguments: {} },
				{ type: "toolCall", id: "call_good", name: "read", arguments: {} },
			],
		};
		const history: Context = {
			messages: [
				...baseContext().messages,
				assistant,
				...["call_bad", "call_good"].map((toolCallId): ToolResultMessage => ({
					role: "toolResult",
					toolCallId,
					toolName: toolCallId === "call_good" ? "read" : "",
					content: [{ type: "text", text: toolCallId }],
					isError: toolCallId === "call_bad",
					timestamp: Date.now(),
				})),
			],
		};
		const messages = getPayloadMessages(await captureOpenAICompletionsPayload(model, history));
		const replay = messages.find(message => message.role === "assistant");
		expect(replay?.tool_calls).toEqual([
			{ type: "function", id: "call_good", function: { name: "read", arguments: "{}" } },
		]);
		expect(messages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual([
			"call_good",
		]);
		expect(replay?.reasoning_opaque).toBeUndefined();
		expect(replay?.reasoning_details).toBeUndefined();
		if (provider === "github-copilot") expect(replay?.reasoning_text).toBeUndefined();
	});

	it.each([
		{ name: "no text", text: undefined },
		{ name: "a newline", text: "\n" },
	])("does not turn a Copilot empty stop with $name into a replayable turn", async ({ text }) => {
		const model = buildModel(copilotGeminiSpec);
		const fetchMock = createMockFetch([
			{ choices: [{ index: 0, delta: { content: text, reasoning_opaque: "opaque-state" } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			"[DONE]",
		]);
		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			acceptEmptyResponse: true,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual(text === undefined ? [] : [{ type: "text", text }]);
	});

	it("maps MiMo unsupported reasoning efforts to opencode-go accepted wire values", async () => {
		const model: Model<"openai-completions"> = buildModel({
			id: "mimo-v2.5-pro",
			name: "MiMo V2.5 Pro",
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		});

		const minimalPayload = toObject(
			await captureOpenAICompletionsPayload(model, baseContext(), { reasoning: "minimal" }),
		);
		const xhighPayload = toObject(
			await captureOpenAICompletionsPayload(model, baseContext(), { reasoning: "xhigh" }),
		);

		expect(minimalPayload ? Reflect.get(minimalPayload, "reasoning_effort") : undefined).toBe("low");
		expect(xhighPayload ? Reflect.get(xhighPayload, "reasoning_effort") : undefined).toBe("high");
		const collapsedModel: Model<"openai-completions"> = buildModel({
			id: "mimo-v2.5-pro",
			name: "MiMo V2.5 Pro",
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			requestModelId: "mimo-v2.5-pro",
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
				effortRouting: {
					off: "mimo-v2.5-pro",
					[Effort.Low]: "mimo-v2.5-pro-thinking",
					[Effort.Medium]: "mimo-v2.5-pro-thinking",
					[Effort.High]: "mimo-v2.5-pro-thinking",
				},
			},
			compat: { reasoningEffortMap: { minimal: "low", xhigh: "high" } },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		});
		const collapsedMinimalPayload = toObject(
			await captureOpenAICompletionsPayload(collapsedModel, baseContext(), { reasoning: "minimal" }),
		);
		const collapsedXhighPayload = toObject(
			await captureOpenAICompletionsPayload(collapsedModel, baseContext(), { reasoning: "xhigh" }),
		);
		expect(collapsedMinimalPayload ? Reflect.get(collapsedMinimalPayload, "model") : undefined).toBe(
			"mimo-v2.5-pro-thinking",
		);
		expect(collapsedMinimalPayload ? Reflect.get(collapsedMinimalPayload, "reasoning_effort") : undefined).toBe(
			"low",
		);
		expect(collapsedXhighPayload ? Reflect.get(collapsedXhighPayload, "model") : undefined).toBe(
			"mimo-v2.5-pro-thinking",
		);
		expect(collapsedXhighPayload ? Reflect.get(collapsedXhighPayload, "reasoning_effort") : undefined).toBe("high");
	});

	it("uses the configured xhigh effort for custom OpenAI-compatible models", async () => {
		const model: Model<"openai-completions"> = buildModel({
			id: "gpt-5.1",
			name: "GPT-5.1 proxy",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		let payload: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
				return createSseResponse([
					{
						id: "chatcmpl-custom-xhigh",
						object: "chat.completion.chunk",
						created: 0,
						model: model.id,
						choices: [{ index: 0, delta: { content: "ok" } }],
					},
					{
						id: "chatcmpl-custom-xhigh",
						object: "chat.completion.chunk",
						created: 0,
						model: model.id,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					},
					"[DONE]",
				]);
			},
			{ preconnect: fetch.preconnect },
		);

		expect(getSupportedEfforts(model)).toContain(Effort.XHigh);
		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			reasoning: "xhigh",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(payload?.reasoning_effort).toBe("xhigh");
	});
});

// Some OpenAI-compatible hosts (GLM, Qwen reasoning variants behind custom
// providers) stream the DeepSeek-format dual-key pattern
// `{"delta":{"content":null,"reasoning_content":"..."}}`, where `content` is
// explicitly JSON null. The reasoning delta must still become a thinking block,
// and the null content must not be coerced into an empty text block.
describe("streamed reasoning_content beside null content", () => {
	function customReasoningModel(id = "glm-5.2"): Model<"openai-completions"> {
		return buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "yunwu",
			baseUrl: "https://yunwu.ai/v1",
			id,
			reasoning: true,
		} as ModelSpec<"openai-completions">);
	}

	function deltaChunk(model: Model<"openai-completions">, delta: Record<string, unknown>): unknown {
		return {
			id: "x",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [{ index: 0, delta }],
		};
	}

	it("emits a thinking block for reasoning_content deltas paired with content:null", async () => {
		const model = customReasoningModel();
		const fetchMock = createMockFetch([
			deltaChunk(model, { content: null, reasoning_content: "分析" }),
			deltaChunk(model, { content: null, reasoning_content: "步骤" }),
			deltaChunk(model, { content: "2", reasoning_content: null }),
			{
				id: "x",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "分析步骤", thinkingSignature: "reasoning_content", summary: false },
			{ type: "text", text: "2" },
		]);
	});

	it("does not coerce a content:null delta into a text block when only reasoning_content is present", async () => {
		const model = customReasoningModel();
		const fetchMock = createMockFetch([
			deltaChunk(model, { content: null, reasoning_content: "only thinking" }),
			deltaChunk(model, { content: "answer", reasoning_content: null }),
			{
				id: "x",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();

		const textBlocks = result.content.filter(b => b.type === "text");
		expect(textBlocks).toEqual([{ type: "text", text: "answer" }]);
	});
});

describe("MiniMax Token Plan request payload", () => {
	it.each([
		["minimax-code", "MiniMax-M2.5"],
		["minimax-code-cn", "MiniMax-M2.5"],
	] as const)("omits unsupported thinking fields for %s/%s", async (provider, modelId) => {
		const model = minimaxTokenPlanOpenAIModel(provider, modelId);
		const body = toObject(
			await captureOpenAICompletionsPayload(
				model,
				{
					systemPrompt: ["stable instructions", "cacheable policy"],
					messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
				},
				{ reasoning: "high" },
			),
		);

		expect(body?.model).toBe(modelId);
		expect(body?.messages).toEqual([
			{ role: "system", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
		expect(body?.thinking).toBeUndefined();
		expect(body?.reasoning).toBeUndefined();
		expect(body?.reasoning_effort).toBeUndefined();
	});
});

describe("kimi model detection via detectCompat", () => {
	function kimiOpenCodeModel(id: string): Model<"openai-completions"> {
		return buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			id,
			reasoning: true,
		} as ModelSpec<"openai-completions">);
	}

	function kimiMoonshotModel(id: string): Model<"openai-completions"> {
		return buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			id,
			reasoning: true,
		} as ModelSpec<"openai-completions">);
	}
	// The z.ai binary `thinking: { type }` field is Kimi's *native* surface
	// (Moonshot / Kimi-code, matched by isMoonshotKimi). Kimi reached through an
	// OpenAI-compatible proxy talks to the proxy's API shape, not Moonshot's
	// backend directly, and those proxies expect the OpenAI-standard
	// `reasoning_effort`. The generic Kimi model-id match MUST NOT default
	// proxies to "zai": doing so regressed #827 (opencode-go strips
	// reasoning_effort under forced tool_choice) and the Fire Pass xhigh capture
	// (#1199), and would mis-shape 14+ gateways (Fireworks, OpenCode, Kilo,
	// NVIDIA, Together, Vercel, …). Hosts that genuinely speak zai pin
	// `compat.thinkingFormat` per catalog entry (e.g. kimi-code, wafer-serverless).
	it("reserves zai for native Kimi hosts and defaults proxies to OpenAI reasoning_effort", () => {
		// Native Moonshot surface → z.ai binary thinking.
		const moonshotK25 = kimiMoonshotModel("kimi-k2.5").compat;
		expect(moonshotK25.thinkingFormat).toBe("zai");
		expect(moonshotK25.thinkingKeep).toBeUndefined();
		const moonshotK26 = kimiMoonshotModel("kimi-k2.6").compat;
		expect(moonshotK26.thinkingFormat).toBe("zai");
		expect(moonshotK26.thinkingKeep).toBe("all");

		// OpenAI-compatible proxies → reasoning_effort ("openai").
		const opencodeK26 = kimiOpenCodeModel("kimi-k2.6").compat;
		expect(opencodeK26.thinkingFormat).toBe("openai");
		expect(opencodeK26.thinkingKeep).toBeUndefined();
		const kiloKimi: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "kilo",
			baseUrl: "https://api.kilo.ai/api/gateway",
			id: "moonshotai/kimi-k2.6",
			reasoning: true,
		} as ModelSpec<"openai-completions">);
		expect(kiloKimi.compat.thinkingFormat).toBe("openai");

		// OpenRouter normalizes reasoning via its own object and keeps precedence
		// over the generic Kimi id match.
		const openRouterKimi: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			id: "moonshotai/kimi-k2.6",
			reasoning: true,
		} as ModelSpec<"openai-completions">);
		expect(openRouterKimi.compat.thinkingFormat).toBe("openrouter");
	});

	it("sends OpenRouter Anthropic adaptive reasoning efforts 1:1 on the wire", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			id: "anthropic/claude-fable-5",
			reasoning: true,
		} as ModelSpec<"openai-completions">);

		const highPayload = await captureOpenAICompletionsPayload(model, baseContext(), { reasoning: "high" });
		const xhighPayload = await captureOpenAICompletionsPayload(model, baseContext(), { reasoning: "xhigh" });
		const maxPayload = await captureOpenAICompletionsPayload(model, baseContext(), { reasoning: "max" });

		expect(getNestedObject(highPayload, "reasoning")).toEqual({ effort: "high" });
		expect(getNestedObject(xhighPayload, "reasoning")).toEqual({ effort: "xhigh" });
		expect(getNestedObject(maxPayload, "reasoning")).toEqual({ effort: "max" });
	});

	// Regression for #1071: OpenCode-Go/Zen handle reasoning content server-side
	// and reject client-supplied `reasoning_content` ("Extra inputs are not
	// permitted"). Kimi on opencode-* MUST NOT have reasoning_content injected,
	// even though it's still recognized as a Kimi model for other quirks.
	it("does not require reasoning_content for tool calls on kimi-k2.5 (opencode-go)", () => {
		const compat = kimiOpenCodeModel("kimi-k2.5").compat;
		expect(compat.requiresReasoningContentForToolCalls).toBe(false);
		// Kimi-specific quirks still apply even on opencode hosts.
		expect(compat.requiresAssistantContentForToolCalls).toBe(true);
	});

	it("does not inject reasoning_content placeholder for kimi on opencode-go", () => {
		const model = kimiOpenCodeModel("kimi-k2.5");
		const compat = model.compat;
		const toolCallMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Let me research this." },
				{
					type: "toolCall",
					id: "call_abc123",
					name: "web_search",
					arguments: { query: "beads gastownhall" },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		};
		const messages = convertMessages(model, { messages: [toolCallMessage] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(toObject(assistant)?.reasoning_content).toBeUndefined();
	});

	it("does not replay streamed reasoning fields for kimi on opencode-go", () => {
		const model = kimiOpenCodeModel("kimi-k2.6");
		const compat = model.compat;
		const toolCallMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "." },
				{
					type: "thinking",
					thinking: "The user wants to install...",
					thinkingSignature: "reasoning",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "bash",
					arguments: { command: "echo ok" },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		};

		expect(compat.requiresReasoningContentForToolCalls).toBe(false);
		const messages = convertMessages(model, { messages: [toolCallMessage] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		const assistantObject = toObject(assistant);
		if (!assistantObject) {
			throw new Error("assistant message missing");
		}
		expect(assistantObject.reasoning).toBeUndefined();
		expect(assistantObject.reasoning_content).toBeUndefined();
		expect(assistantObject.reasoning_text).toBeUndefined();
	});

	// #1484: OpenCode Zen's Kimi gateway now 400s with `thinking is enabled but
	// reasoning_content is missing in assistant tool call message at index N`
	// when a follow-up request has thinking on but the prior assistant tool-call
	// turn lacks `reasoning_content`. `buildParams` must reactivate the
	// `requiresReasoningContentForToolCalls` flag whenever the request itself is
	// in thinking mode, even though static compat detection leaves it off.
	it("emits reasoning_content on kimi opencode-go tool-call replays when thinking is enabled", async () => {
		const model = kimiOpenCodeModel("kimi-k2.6");
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Need to read the file before answering.",
					// OpenCode Kimi streams reasoning under the `reasoning` field
					// name; the override must coerce it into `reasoning_content`
					// when replaying tool-call history.
					thinkingSignature: "reasoning",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{
				messages: [
					{ role: "user", content: "Summarize the README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_abc123",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning: "high",
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as { messages: Array<Record<string, unknown>> };
		const assistant = payload.messages.find(m => m.role === "assistant");
		expect(assistant?.reasoning_content).toBe("Need to read the file before answering.");
		// The streamed `reasoning` key must NOT land in the wire body alongside
		// `reasoning_content`; opencode's strict schema rejects unknown fields.
		expect(assistant?.reasoning).toBeUndefined();
	});

	it("demotes cross-api reasoning while keeping thinking-enabled tool-call schema on kimi opencode-go", async () => {
		const model = kimiOpenCodeModel("kimi-k2.6");
		expect(model.compat.requiresReasoningContentForToolCalls).toBe(false);
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Need to preserve cross-api reasoning.",
					thinkingSignature: "sig_from_anthropic",
				},
				{
					type: "toolCall",
					id: "toolu_cross_api",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			api: "anthropic-messages",
			provider: "zai",
			model: "claude-compatible",
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
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{
				messages: [
					{ role: "user", content: "Summarize the README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "toolu_cross_api",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning: "high",
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as { messages: Array<Record<string, unknown>> };
		const assistant = payload.messages.find(m => m.role === "assistant");
		expect(assistant?.content).toBe(renderDemotedThinking(model.id, "Need to preserve cross-api reasoning."));
		expect(assistant?.reasoning_content).toBe("");
		expect(assistant?.reasoning).toBeUndefined();
		expect(assistant?.reasoning_text).toBeUndefined();
	});

	// #1071 regression guard alongside the #1484 fix: with thinking disabled the
	// override stays off so the gateway's `Extra inputs are not permitted` error
	// can never reappear on tool-call replays.
	it("omits reasoning_content on kimi opencode-go tool-call replays when thinking is disabled", async () => {
		const model = kimiOpenCodeModel("kimi-k2.6");
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Let me check." },
				{
					type: "toolCall",
					id: "call_abc123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{
				messages: [
					{ role: "user", content: "Summarize the README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_abc123",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as { messages: Array<Record<string, unknown>> };
		const assistant = payload.messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant?.reasoning_content).toBeUndefined();
		expect(assistant?.reasoning).toBeUndefined();
		expect(assistant?.reasoning_text).toBeUndefined();
	});

	// #1485 review: `disableReasoningOnForcedToolChoice` strips thinking from
	// the wire body for Kimi when `toolChoice` is forced, so the per-request
	// reasoning_content override must back off on the same path or the
	// thinking-disabled payload reintroduces the #1071 `Extra inputs are not
	// permitted` failure.
	it("omits reasoning_content on kimi opencode-go forced-tool turns even when reasoning is requested", async () => {
		const model = kimiOpenCodeModel("kimi-k2.6");
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Plan first, then call the tool.",
					thinkingSignature: "reasoning_content",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		};

		const readTool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{
				messages: [
					{ role: "user", content: "Summarize the README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_abc123",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
				tools: [readTool],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning: "high",
				// Forced tool choice triggers `disableReasoningOnForcedToolChoice`
				// for Kimi, suppressing reasoning_effort on the wire body.
				toolChoice: { type: "tool", name: "read" },
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as {
			messages: Array<Record<string, unknown>>;
			reasoning_effort?: unknown;
		};
		const assistant = payload.messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant?.reasoning_content).toBeUndefined();
		expect(assistant?.reasoning).toBeUndefined();
		expect(assistant?.reasoning_text).toBeUndefined();
		// The forced-tool guard must still strip the request-level thinking
		// signal so neither end of the wire mentions reasoning.
		expect(payload.reasoning_effort).toBeUndefined();
	});

	it("downgrades unsupported forced tool_choice without suppressing thinking", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			id: "kimi-k2.7-code",
			reasoning: true,
			compat: { supportsForcedToolChoice: false },
		} as ModelSpec<"openai-completions">);
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Plan first, then call the tool.",
					thinkingSignature: "reasoning_content",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		};
		const readTool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{
				messages: [
					{ role: "user", content: "Summarize the README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_abc123",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
				tools: [readTool],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning: "high",
				toolChoice: { type: "tool", name: "read" },
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as {
			messages: Array<Record<string, unknown>>;
			reasoning_effort?: unknown;
			tool_choice?: unknown;
		};
		const assistant = payload.messages.find(m => m.role === "assistant");
		expect(assistant?.reasoning_content).toBe("Plan first, then call the tool.");
		expect(payload.reasoning_effort).toBe("high");
		expect(payload.tool_choice).toBe("auto");
	});

	// #7315: DeepSeek reasoning models via OpenCode Zen/Go 400 with "Thinking
	// mode does not support this tool_choice" when a specific function is forced.
	// Dropping reasoning_effort does not turn off the gateway's default thinking
	// mode, so the compat descriptor itself must mark forced tool choice
	// unsupported (no per-model override) and buildParams must downgrade the
	// selector while keeping the tool advertised. The downgraded "auto" is then
	// dropped as redundant so reasoning survives (#1207) — omission and "auto"
	// are wire-equivalent for tool selection.
	it("scopes the DeepSeek forced tool_choice downgrade to OpenCode gateways", async () => {
		const todoTool: Tool = {
			name: "todo",
			description: "Manage the todo list",
			parameters: { type: "object", properties: {}, required: [] },
		};
		async function captureToolChoice(model: Model<"openai-completions">): Promise<Record<string, unknown>> {
			const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
			streamOpenAICompletions(
				model,
				{
					messages: [{ role: "user", content: "do it", timestamp: Date.now() }],
					tools: [todoTool],
				},
				{
					apiKey: "test-key",
					fetch: createMockFetch(["[DONE]"]),
					reasoning: "high",
					toolChoice: { type: "tool", name: "todo" },
					signal: createAbortedSignal(),
					onPayload: payload => {
						const object = toObject(payload);
						if (!object) throw new Error("Expected object payload");
						resolve(object);
					},
				},
			);
			return promise;
		}

		const deepseekSpec = {
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			provider: "opencode-zen",
			baseUrl: "https://opencode.ai/zen/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		} satisfies ModelSpec<"openai-completions">;

		const openCode = buildModel(deepseekSpec);
		expect(openCode.compat.supportsForcedToolChoice).toBe(false);
		const openCodePayload = await captureToolChoice(openCode);
		expect(openCodePayload.tool_choice).toBeUndefined();
		expect(
			Array.isArray(openCodePayload.tools) &&
				openCodePayload.tools.some(tool => getNestedObject(tool, "function")?.name === "todo"),
		).toBe(true);

		// A custom provider id pointed at the OpenCode gateway URL is still
		// classified as OpenCode by baseUrl, so the downgrade must apply there too.
		const customOpenCode = buildModel({
			...deepseekSpec,
			provider: "my-opencode",
		} satisfies ModelSpec<"openai-completions">);
		expect(customOpenCode.compat.supportsForcedToolChoice).toBe(false);
		const customPayload = await captureToolChoice(customOpenCode);
		expect(customPayload.tool_choice).toBeUndefined();

		const nvidia = buildModel({
			...deepseekSpec,
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			id: "deepseek-ai/deepseek-v4-flash",
		} satisfies ModelSpec<"openai-completions">);
		expect(nvidia.compat.supportsForcedToolChoice).toBe(true);
		const nvidiaPayload = await captureToolChoice(nvidia);
		expect(nvidiaPayload.tool_choice).toEqual({
			type: "function",
			function: { name: "todo" },
		});
	});

	// #1484 follow-up: DeepSeek V4 on opencode-go exhibits the same gateway
	// invariant as Kimi (same Zen gateway). DeepSeek emits reasoning under the
	// `reasoning` signature, so the pre-fix code wrote both `reasoning` and
	// `reasoning_content` to the wire body. The line-1488 fix in convertMessages
	// now coerces the replay onto `reasoningContentField` whenever
	// `allowsSyntheticReasoningContentForToolCalls=false`, so DeepSeek V4
	// payloads carry only `reasoning_content`.
	it("emits only reasoning_content on deepseek-v4-flash opencode-go tool-call replays", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			id: "deepseek-v4-flash",
			reasoning: true,
		} as ModelSpec<"openai-completions">);
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Need to read the file before answering.",
					thinkingSignature: "reasoning",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{
				messages: [
					{ role: "user", content: "Summarize the README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_abc123",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning: "high",
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as { messages: Array<Record<string, unknown>> };
		const assistant = payload.messages.find(m => m.role === "assistant");
		expect(assistant?.reasoning_content).toBe("Need to read the file before answering.");
		// DeepSeek's allowsSynthetic=false must keep the stale `reasoning` key
		// off the wire body so opencode's schema validation does not flag it.
		expect(assistant?.reasoning).toBeUndefined();
	});

	// #1484 follow-up: the Zen gateway invariant applies to every opencode-go
	// model (GLM, Qwen, MiMo, MiniMax, Kimi, DeepSeek). Verify a non-Kimi
	// non-DeepSeek opencode model also replays reasoning_content when thinking
	// is enabled, and stays silent when thinking is disabled.
	it.each([
		{ id: "glm-5.1", reasoning: "high" as const, expectReplay: true },
		{ id: "glm-5.1", reasoning: undefined, expectReplay: false },
		{ id: "qwen3.7-max", reasoning: "high" as const, expectReplay: true },
		{ id: "mimo-v2-pro", reasoning: "high" as const, expectReplay: true },
	])("opencode-go/%s reasoning=%s → replay=%s", async ({ id, reasoning, expectReplay }) => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			id,
			reasoning: true,
		} as ModelSpec<"openai-completions">);
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Plan before acting.",
					thinkingSignature: "reasoning",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{
				messages: [
					{ role: "user", content: "Summarize the README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_abc123",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning,
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as { messages: Array<Record<string, unknown>> };
		const assistant = payload.messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		if (expectReplay) {
			expect(assistant?.reasoning_content).toBe("Plan before acting.");
			// The stale streamed `reasoning` key must never land in the wire body.
			expect(assistant?.reasoning).toBeUndefined();
		} else {
			expect(assistant?.reasoning_content).toBeUndefined();
			expect(assistant?.reasoning).toBeUndefined();
			expect(assistant?.reasoning_text).toBeUndefined();
		}
	});

	it("injects reasoning_content placeholder when kimi-on-moonshot has tool calls without reasoning field", () => {
		const model = kimiMoonshotModel("kimi-k2.5");
		const compat = model.compat;
		const toolCallMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Let me research this." },
				{
					type: "toolCall",
					id: "call_abc123",
					name: "web_search",
					arguments: { query: "beads gastownhall" },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		};
		const messages = convertMessages(model, { messages: [toolCallMessage] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		const reasoningContent = toObject(assistant)?.reasoning_content;
		expect(reasoningContent).toBeDefined();
		expect(typeof reasoningContent).toBe("string");
		expect((reasoningContent as string).length).toBeGreaterThan(0);
	});

	it("injects reasoning_content placeholder for direct Moonshot Kimi after thinking-disabled forced tool calls", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			id: "kimi-k2.6",
			reasoning: false,
		} as ModelSpec<"openai-completions">);
		const compat = model.compat;
		const toolCallMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_abc123",
					name: "resolve",
					arguments: { action: "apply", reason: "approved" },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		};

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		const messages = convertMessages(model, { messages: [toolCallMessage] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(toObject(assistant)?.reasoning_content).toBe(".");
	});

	it("does not inject reasoning_content when model is not kimi", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			id: "some-other-model",
		} as ModelSpec<"openai-completions">);
		const compat = model.compat;
		expect(compat.requiresReasoningContentForToolCalls).toBe(false);
		expect(compat.requiresAssistantContentForToolCalls).toBe(false);
	});

	// `requiresAssistantContentForToolCalls` keys directly off isKimiModel and
	// is provider-agnostic, so it's the cleanest signal that the id-pattern
	// match recognizes every Kimi variant.
	it.each(["kimi-k2.5", "kimi-k1.5", "kimi-k2-5"])("matches kimi model id: %s", id => {
		const compat = kimiMoonshotModel(id).compat;
		expect(compat.requiresAssistantContentForToolCalls).toBe(true);
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});

	it("still matches moonshotai/kimi via openrouter", () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			id: "moonshotai/kimi-k2-5",
			reasoning: true,
		} as ModelSpec<"openai-completions">);
		const compat = model.compat;
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});

	// Moonshot's K2.6 `thinking.keep: "all"` makes the server preserve
	// `reasoning_content` from historical assistant turns across multi-step tool
	// calls; without it the backend silently drops every prior turn's reasoning
	// even though it rides on the wire. The field is K2.6-only (K2.5 and earlier
	// reject unknown fields) and Moonshot-host-only: every gateway translates
	// thinking into its own native shape and would reject the extra key.
	describe("Moonshot K2.6 preserved thinking (thinking.keep)", () => {
		it("preserves the Moonshot-native gate against gateway IDs that match the kimi-k2.6 prefix", async () => {
			// The gate is provider+baseUrl driven, not id-only: a non-Moonshot host
			// with `kimi-k2.6` in the id never gets the Moonshot-only `keep`.
			const customModel: Model<"openai-completions"> = buildModel({
				...gpt4oMiniSpec,
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://example.com/v1",
				id: "kimi-k2.6",
				reasoning: true,
			} as ModelSpec<"openai-completions">);
			const payload = await captureOpenAICompletionsPayload(customModel, baseContext(), { reasoning: "high" });
			expect(toObject(payload)?.thinking).toBeUndefined();
		});

		it("does NOT send thinking.keep on kimi-k2.5 (field is K2.6-only in Moonshot's schema)", async () => {
			const payload = await captureOpenAICompletionsPayload(kimiMoonshotModel("kimi-k2.5"), baseContext(), {
				reasoning: "high",
			});
			const thinking = getNestedObject(payload, "thinking");
			expect(thinking).not.toBeNull();
			expect(thinking?.type).toBe("enabled");
			expect(thinking?.keep).toBeUndefined();
		});

		it("does NOT send thinking.keep on OpenRouter-hosted Kimi K2.6 (proxy uses its own thinking shape)", async () => {
			// OpenRouter uses `reasoning: { effort }` rather than Moonshot's
			// `thinking: { type, keep }`.
			const openRouterModel: Model<"openai-completions"> = buildModel({
				...gpt4oMiniSpec,
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				id: "moonshotai/kimi-k2.6",
				reasoning: true,
			} as ModelSpec<"openai-completions">);
			const payload = await captureOpenAICompletionsPayload(openRouterModel, baseContext(), { reasoning: "high" });
			expect(toObject(payload)?.thinking).toBeUndefined();
		});

		it("does NOT send thinking.keep on a forced-tool turn (compat disables thinking entirely for Kimi)", async () => {
			// `disableReasoningOnForcedToolChoice` flips thinking to `disabled` for
			// Kimi whenever a named tool is forced (Moonshot rejects
			// `tool_choice 'specified'` with thinking enabled); `keep` MUST NOT
			// resurrect on this path.
			const payload = await captureOpenAICompletionsPayload(
				kimiMoonshotModel("kimi-k2.6"),
				{
					messages: [{ role: "user", content: "Use the read tool", timestamp: Date.now() }],
					tools: [
						{
							name: "read",
							description: "read a file",
							parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
						},
					],
				},
				{ reasoning: "high", toolChoice: { type: "tool", name: "read" } },
			);
			expect(toObject(payload)?.thinking).toEqual({ type: "disabled" });
		});

		it("survives kimi-k2.6 ids that include a routing suffix (Fireworks-style)", async () => {
			// Fireworks publishes Kimi K2.6 under `accounts/fireworks/routers/` and
			// never speaks the Moonshot wire, so it takes the reasoning_effort path.
			const fireworksModel: Model<"openai-completions"> = buildModel({
				...gpt4oMiniSpec,
				api: "openai-completions",
				provider: "fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				id: "accounts/fireworks/routers/kimi-k2.6",
				reasoning: true,
			} as ModelSpec<"openai-completions">);
			const payload = await captureOpenAICompletionsPayload(fireworksModel, baseContext(), { reasoning: "high" });
			expect(toObject(payload)?.thinking).toBeUndefined();
		});

		it("preserves the streamed assistant flow alongside thinking.keep='all'", async () => {
			// The rest of the body is unchanged when keep is set: `stream` stays true
			// and the prior assistant reasoning_content still rides on the wire, so
			// the server's `keep: "all"` has data to preserve.
			const priorAssistant: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Need to read the file first.", thinkingSignature: "reasoning_content" },
					{ type: "toolCall", id: "call_abc", name: "read", arguments: { path: "README.md" } },
				],
				api: "openai-completions",
				provider: "moonshot",
				model: "kimi-k2.6",
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
			};
			const payload = await captureOpenAICompletionsPayload(
				kimiMoonshotModel("kimi-k2.6"),
				{
					messages: [
						{ role: "user", content: "Summarize README", timestamp: Date.now() },
						priorAssistant,
						{
							role: "toolResult",
							toolCallId: "call_abc",
							toolName: "read",
							content: [{ type: "text", text: "# Hello\n" }],
							isError: false,
							timestamp: Date.now(),
						},
					],
				},
				{ reasoning: "high" },
			);
			expect(toObject(payload)?.thinking).toEqual({ type: "enabled", keep: "all" });
			expect(toObject(payload)?.stream).toBe(true);
			const assistant = getPayloadMessages(payload).find(message => message.role === "assistant");
			expect(assistant).toBeDefined();
			expect(assistant?.reasoning_content).toBe("Need to read the file first.");
		});
	});
});

describe("NVIDIA NIM DeepSeek special-token stripping", () => {
	function nvidiaDeepseekModel(): Model<"openai-completions"> {
		return buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			id: "deepseek-ai/deepseek-v4-flash",
			reasoning: true,
		} as ModelSpec<"openai-completions">);
	}

	it("strips leaked <\uff5cDSML\uff5c...\uff5c> markers from visible content", async () => {
		const model = nvidiaDeepseekModel();
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-nim-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: "Sure thing.<\uff5cDSML\uff5ctool_calls\uff5c>I'll help." },
					},
				],
			},
			{
				id: "chatcmpl-nim-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("Sure thing.I'll help.");
		expect(text).not.toContain("DSML");
		expect(text).not.toContain("\uff5c");
	});

	it("holds back partial token split across chunks", async () => {
		const model = nvidiaDeepseekModel();
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "Hello <\uff5ctool_calls" } }],
			},
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "_begin\uff5c>world" } }],
			},
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("Hello world");
	});

	it("flushes a dangling partial open delimiter at end of stream", async () => {
		const model = nvidiaDeepseekModel();
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-nim-3",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "trailing <\uff5c" } }],
			},
			{
				id: "chatcmpl-nim-3",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		// At end-of-stream we have no way to know whether the partial is a real token,
		// so we emit it verbatim rather than swallow legitimate text forever.
		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("trailing <\uff5c");
	});

	it("leaves visible content alone for non-deepseek nvidia models", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			id: "meta/llama-3.3-70b-instruct",
		} as ModelSpec<"openai-completions">);
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-nim-4",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "keep <\uff5cas-is\uff5c> please" } }],
			},
			{
				id: "chatcmpl-nim-4",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("keep <\uff5cas-is\uff5c> please");
	});
});

describe("DeepSeek chat-template token stripping", () => {
	const model: Model<"openai-completions"> = {
		...getBundledModel("deepseek", "deepseek-v4-flash"),
	};

	it("strips leaked deepseek chat-template markers from visible text for deepseek providers", async () => {
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-deepseek-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "去改前端交互描述：" } }],
			},
			{
				id: "chatcmpl-deepseek-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "<｜Assistant｜>\n\n" } }],
			},
			{
				id: "chatcmpl-deepseek-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "让我找到对应位置并修改。" } }],
			},
			{
				id: "chatcmpl-deepseek-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => (block as { text: string }).text)
			.join("");

		expect(text).toBe("去改前端交互描述：让我找到对应位置并修改。");
		expect(text).not.toContain("<｜Assistant｜>");
	});

	it("holds partial deepseek markers across chunks before stripping them", async () => {
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-deepseek-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "去改前端交互描述：<｜Ass" } }],
			},
			{
				id: "chatcmpl-deepseek-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "istant｜>\n\n让我找到对应位置并修改。" } }],
			},
			{
				id: "chatcmpl-deepseek-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => (block as { text: string }).text)
			.join("");

		expect(text).toBe("去改前端交互描述：让我找到对应位置并修改。");
		expect(text).not.toContain("<｜Assistant｜>");
	});
});

describe("applyOpenRouterRoutingVariant", () => {
	it("returns the id untouched when variant is missing", () => {
		expect(applyOpenRouterRoutingVariant("anthropic/claude-haiku-latest", undefined)).toBe(
			"anthropic/claude-haiku-latest",
		);
		expect(applyOpenRouterRoutingVariant("anthropic/claude-haiku-latest", "")).toBe("anthropic/claude-haiku-latest");
	});

	it("appends the variant suffix when the id has no colon after the last slash", () => {
		expect(applyOpenRouterRoutingVariant("anthropic/claude-haiku-latest", "nitro")).toBe(
			"anthropic/claude-haiku-latest:nitro",
		);
		expect(applyOpenRouterRoutingVariant("openai/gpt-4o-mini", "floor")).toBe("openai/gpt-4o-mini:floor");
	});

	it("preserves an explicit variant already present in the id", () => {
		// User-typed override
		expect(applyOpenRouterRoutingVariant("anthropic/claude-haiku-latest:nitro", "exacto")).toBe(
			"anthropic/claude-haiku-latest:nitro",
		);
		// Catalog entry with a baked-in variant
		expect(applyOpenRouterRoutingVariant("deepseek/deepseek-v3.1-terminus:exacto", "nitro")).toBe(
			"deepseek/deepseek-v3.1-terminus:exacto",
		);
	});

	it("appends the variant when the id has no slash separator", () => {
		expect(applyOpenRouterRoutingVariant("opaque-id", "nitro")).toBe("opaque-id:nitro");
	});
});

describe("anthropic cache control for OpenAI-compatible chat completions", () => {
	function claudeProxyModel(compat?: OpenAICompat): Model<"openai-completions"> {
		return buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "litellm",
			baseUrl: "https://litellm.example/v1",
			id: "claude-opus-4-8",
			compat,
		} as ModelSpec<"openai-completions">);
	}

	function cacheContext(): Context {
		return { messages: [{ role: "user", content: "cache me", timestamp: 0 }] };
	}

	it("injects Anthropic cache_control when compat requests Anthropic cache markers", async () => {
		const payload = await captureOpenAICompletionsPayload(
			claudeProxyModel({ cacheControlFormat: "anthropic" }),
			cacheContext(),
		);
		const content = getLastPayloadContent(payload);
		const textPart = getLastTextPart(content);

		expect(textPart?.text).toBe("cache me");
		expect(textPart?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("preserves OpenRouter Anthropic cache_control detection", async () => {
		const model = getBundledModel("openrouter", "anthropic/claude-sonnet-4.6") as Model<"openai-completions">;
		const payload = await captureOpenAICompletionsPayload(model, cacheContext());
		const content = getLastPayloadContent(payload);
		const textPart = getLastTextPart(content);

		expect(textPart?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("anchors Anthropic cache_control on the trailing tool result during a tool loop", async () => {
		const model = getBundledModel("openrouter", "anthropic/claude-sonnet-4.6") as Model<"openai-completions">;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_read",
					name: "read",
					arguments: { path: "screenshot.png" },
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_read",
			toolName: "read",
			content: [{ type: "text", text: "Read image file [image/webp]" }],
			isError: false,
			timestamp: 2,
		};
		const payload = await captureOpenAICompletionsPayload(model, {
			messages: [{ role: "user", content: "cache me", timestamp: 0 }, assistantMessage, toolResultMessage],
		});
		const messages = getPayloadMessages(payload);
		const [user, assistant, tool] = messages;

		// Empty tool-call replay content must stay a string: an empty text part
		// with cache_control is rejected by Anthropic/OpenRouter.
		expect(assistant?.content).toBe("");
		expect(getLastTextPart(user?.content)?.cache_control).toBeUndefined();
		expect(tool?.role).toBe("tool");
		expect(tool?.content).toEqual([
			{ type: "text", text: "Read image file [image/webp]", cache_control: { type: "ephemeral" } },
		]);
	});

	it("does not infer Anthropic cache_control for custom Claude ids without compat", async () => {
		const payload = await captureOpenAICompletionsPayload(claudeProxyModel(), cacheContext());

		expect(getLastPayloadContent(payload)).toBe("cache me");
	});
});
describe("openrouterVariant request integration", () => {
	it("appends the configured variant suffix to params.model for OpenRouter requests", async () => {
		const model = getBundledModel("openrouter", "anthropic/claude-sonnet-4.6") as Model<"openai-completions">;
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			signal: createAbortedSignal(),
			openrouterVariant: "nitro",
			onPayload: payload => resolve(payload),
		});
		const payload = await promise;
		expect((payload as { model?: string }).model).toBe(`${model.id}:nitro`);
	});

	it("does not override an explicit variant in the model id", async () => {
		const base = getBundledModel("openrouter", "anthropic/claude-sonnet-4.6") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = buildModel({
			...base,
			id: `${base.id}:online`,
			compat: base.compatConfig,
		} as ModelSpec<"openai-completions">);
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			signal: createAbortedSignal(),
			openrouterVariant: "nitro",
			onPayload: payload => resolve(payload),
		});
		const payload = await promise;
		expect((payload as { model?: string }).model).toBe(model.id);
	});

	it("leaves params.model unchanged for non-OpenRouter providers", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
		} as ModelSpec<"openai-completions">);
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			signal: createAbortedSignal(),
			openrouterVariant: "nitro",
			onPayload: payload => resolve(payload),
		});
		const payload = await promise;
		expect((payload as { model?: string }).model).toBe(model.id);
	});
});

describe("Moonshot Flavored JSON Schema tool normalization", () => {
	const mfjsProbeTools: Tool[] = [
		{
			name: "github",
			description: "gh",
			parameters: {
				type: "object",
				properties: {
					op: {
						anyOf: [
							{ const: "pr_checkout", description: "github operation" },
							{ const: "pr_create", description: "github operation" },
						],
						description: "github operation",
					},
				},
				required: ["op"],
				additionalProperties: false,
			},
		},
		{
			name: "find",
			description: "find",
			parameters: {
				type: "object",
				properties: {
					paths: { type: "array", description: "globs", minItems: 1, items: { type: "string" } },
				},
				required: ["paths"],
				additionalProperties: false,
			},
		},
		{
			name: "task",
			description: "spawn task",
			parameters: {
				type: "object",
				properties: {
					tasks: {
						type: "array",
						items: {
							type: "object",
							properties: { outputSchema: true },
						},
					},
				},
			},
		},
	];

	function toolParameters(payload: unknown, toolName: string): Record<string, unknown> {
		const tools = toObject(payload)?.tools;
		if (!Array.isArray(tools)) throw new Error("payload tools missing");
		for (const entry of tools) {
			const fn = getNestedObject(entry, "function");
			if (fn?.name === toolName) {
				const params = toObject(fn.parameters);
				if (!params) throw new Error(`tool ${toolName} has no parameters`);
				return params;
			}
		}
		throw new Error(`tool ${toolName} not in payload`);
	}

	function probeProperty(payload: unknown, toolName: string, prop: string): Record<string, unknown> {
		const properties = toObject(toolParameters(payload, toolName).properties);
		const node = toObject(properties?.[prop]);
		if (!node) throw new Error(`property ${prop} missing on ${toolName}`);
		return node;
	}

	function moonshotKimiModel(): Model<"openai-completions"> {
		return buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			id: "kimi-k2.5",
		} as ModelSpec<"openai-completions">);
	}

	function genericNonStrictModel(): Model<"openai-completions"> {
		return buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://api.example.com/v1",
			id: "local-model",
		} as ModelSpec<"openai-completions">);
	}

	it("rewrites tool schemas to MFJS on native Moonshot hosts", async () => {
		const model = moonshotKimiModel();
		expect(model.compat.toolSchemaFlavor).toBe("moonshot-mfjs");
		const payload = await captureOpenAICompletionsPayload(model, { ...baseContext(), tools: mfjsProbeTools });
		const op = probeProperty(payload, "github", "op");
		expect(op).toEqual({ type: "string", enum: ["pr_checkout", "pr_create"], description: "github operation" });
		const paths = probeProperty(payload, "find", "paths");
		expect(paths.minItems).toBeUndefined();
		expect(paths.type).toBe("array");
		const taskProperties = toObject(
			toObject(toObject(probeProperty(payload, "task", "tasks").items)?.properties)?.outputSchema,
		);
		expect(taskProperties).toEqual({});
	});

	it("leaves raw JSON Schema untouched on non-Moonshot hosts (flag-gated)", async () => {
		const model = genericNonStrictModel();
		expect(model.compat.toolSchemaFlavor).toBeUndefined();
		const payload = await captureOpenAICompletionsPayload(model, { ...baseContext(), tools: mfjsProbeTools });
		// The const-union → enum collapse is a universal wire optimization, not MFJS,
		// so `op` collapses identically here; MFJS gating is proven by `paths.minItems` below.
		const op = probeProperty(payload, "github", "op");
		expect(op).toEqual({ type: "string", enum: ["pr_checkout", "pr_create"], description: "github operation" });
		const paths = probeProperty(payload, "find", "paths");
		expect(paths.minItems).toBe(1);
		const taskItems = toObject(probeProperty(payload, "task", "tasks").items);
		const taskProperties = toObject(taskItems?.properties);
		expect(taskProperties?.outputSchema).toBe(true);
	});
});

describe("GitHub Copilot Gemini tool schemas (issue #20198)", () => {
	// MCP tools (e.g. Grafana's update_dashboard) declare JSON Schema type
	// arrays; Copilot's Gemini backend answers them with a blank 400.
	const mcpTool: Tool = {
		name: "mcp__grafana_update_dashboard",
		description: "update a dashboard",
		parameters: {
			type: "object",
			properties: {
				value: { type: ["string", "number", "integer", "boolean", "object", "array", "null"] },
				folder: { type: ["string", "null"] },
			},
		},
	};

	function copilotModel(id: string): Model<"openai-completions"> {
		return buildModel({
			...gpt4oMiniSpec,
			provider: "github-copilot",
			baseUrl: "https://api.enterprise.githubcopilot.com",
			id,
			name: id,
		});
	}

	async function wireProperties(model: Model<"openai-completions">): Promise<Record<string, unknown>> {
		const payload = await captureOpenAICompletionsPayload(model, { ...baseContext(), tools: [mcpTool] });
		const tools = toObject(payload)?.tools;
		if (!Array.isArray(tools)) throw new Error("payload tools missing");
		const properties = getNestedObject(getNestedObject(tools[0], "function")?.parameters, "properties");
		if (!properties) throw new Error("tool parameters missing");
		return properties;
	}

	it("scalarizes type arrays for Gemini models", async () => {
		const properties = await wireProperties(copilotModel("gemini-4-hydrogen"));
		expect(JSON.stringify(properties)).not.toContain('"type":[');
		expect(properties.folder).toEqual({ type: "string", nullable: true });
		const value = toObject(properties.value);
		expect(value?.nullable).toBe(true);
		expect(value?.anyOf).toContainEqual({ type: "integer" });
	});

	it("keeps standard JSON Schema for non-Gemini Copilot models", async () => {
		const properties = await wireProperties(copilotModel("gpt-5.5"));
		expect(properties.folder).toEqual({ type: ["string", "null"] });
	});
});

describe("grammar tool-schema normalization (issue #5914)", () => {
	const primitiveUnion = {
		anyOf: [
			{ type: "string" },
			{ type: "number" },
			{ type: "boolean" },
			{ type: "object" },
			{ type: "array" },
			{ type: "null" },
		],
	};

	// An open field (`z.unknown()` / ArkType `"unknown"` / raw `{}`) becomes a
	// bare boolean `true` after `toolWireSchema`'s empty-schema normalization
	// (issue #1179). The `task` tool ships exactly this via `outputSchema`.
	const openFieldTool: Tool = {
		name: "task",
		description: "spawn subagents",
		parameters: {
			type: "object",
			properties: {
				task: { type: "string" },
				outputSchema: {},
				nested: {
					type: "object",
					properties: { value: { type: "string" } },
					additionalProperties: false,
				},
			},
			required: ["task"],
			additionalProperties: false,
		},
	};

	function toolParameters(payload: unknown, toolName: string): Record<string, unknown> {
		const tools = toObject(payload)?.tools;
		if (!Array.isArray(tools)) throw new Error("payload tools missing");
		for (const entry of tools) {
			const fn = getNestedObject(entry, "function");
			if (fn?.name === toolName) {
				const params = toObject(fn.parameters);
				if (!params) throw new Error(`tool ${toolName} has no parameters`);
				return params;
			}
		}
		throw new Error(`tool ${toolName} not in payload`);
	}

	function localLlamaModel(): Model<"openai-completions"> {
		return buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "llama.cpp",
			baseUrl: "http://127.0.0.1:8080/v1",
			id: "qwen3-coder",
		} as ModelSpec<"openai-completions">);
	}

	function remoteModel(): Model<"openai-completions"> {
		return buildModel({
			...gpt4oMiniSpec,
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://api.example.com/v1",
			id: "remote-model",
		} as ModelSpec<"openai-completions">);
	}

	it("widens bare boolean subschemas and keeps additionalProperties:false", async () => {
		const model = localLlamaModel();
		const payload = await captureOpenAICompletionsPayload(model, { ...baseContext(), tools: [openFieldTool] });
		const params = toolParameters(payload, "task");
		const properties = toObject(params.properties);
		if (!properties) throw new Error("task tool has no properties");

		// The offending bare `true` (from the `{}` open field) becomes a
		// value-accepting primitive union the GBNF converter can compile.
		expect(properties.outputSchema).toEqual(primitiveUnion);
		// No bare boolean subschema remains anywhere in the wire schema.
		expect(JSON.stringify(params)).not.toContain('"outputSchema":true');
		// The closed-object contract survives: dropping `additionalProperties:
		// false` would silently reopen the object to arbitrary keys.
		expect(params.additionalProperties).toBe(false);
		const nested = toObject(properties.nested);
		expect(nested?.additionalProperties).toBe(false);
	});

	it("widens booleans nested inside object-valued additionalProperties", async () => {
		const model = localLlamaModel();
		const mapTool: Tool = {
			name: "map_tool",
			description: "tool with a schema-valued additionalProperties",
			parameters: {
				type: "object",
				properties: {
					env: {
						type: "object",
						additionalProperties: { type: "object", properties: { metadata: {} } },
					},
				},
				additionalProperties: false,
			},
		};
		const payload = await captureOpenAICompletionsPayload(model, { ...baseContext(), tools: [mapTool] });
		const params = toolParameters(payload, "map_tool");
		const env = getNestedObject(toObject(params.properties), "env");
		const ap = toObject(env?.additionalProperties);
		// The schema-valued form is traversed: the nested open field is widened
		// so the GBNF converter never reaches a bare boolean subschema.
		expect(getNestedObject(toObject(ap?.properties), "metadata")).toEqual(primitiveUnion);
		// The boolean form on the outer object still survives untouched.
		expect(params.additionalProperties).toBe(false);
	});

	it("leaves the wire schema untouched on non-grammar hosts", async () => {
		const model = remoteModel();
		expect(model.compat.toolSchemaFlavor).toBeUndefined();
		const payload = await captureOpenAICompletionsPayload(model, { ...baseContext(), tools: [openFieldTool] });
		const properties = toObject(toolParameters(payload, "task").properties);
		// Off the grammar path the open field keeps the normalized bare boolean.
		expect(properties?.outputSchema).toBe(true);
	});
});

describe("mistral prompt_cache_key regression (#15079)", () => {
	it("sends the session-stable prompt_cache_key on Mistral chat-completions requests", async () => {
		expect(mistralSmallLatest.compat.supportsPromptCacheKey).toBe(true);
		const payload = await captureOpenAICompletionsPayload(mistralSmallLatest, undefined, {
			sessionId: "regression-session-15079",
		});
		const payloadObject = toObject(payload);
		// Catalog rule + baked row must both survive regeneration for this to hold.
		expect(payloadObject?.prompt_cache_key).toBe("regression-session-15079");
	});

	it("omits prompt_cache_key when cache retention is disabled", async () => {
		const payload = await captureOpenAICompletionsPayload(mistralSmallLatest, undefined, {
			sessionId: "regression-session-15079",
			cacheRetention: "none",
		});
		const payloadObject = toObject(payload);
		expect(payloadObject === null || !("prompt_cache_key" in payloadObject)).toBe(true);
	});
});

describe("Mistral reasoning_effort ladders (#19265)", () => {
	// docs.mistral.ai/inference/conversations/reasoning: GLM 5.3 and Flash take
	// low/high/max; Large 4 takes low/medium/high and rejects minimal/xhigh/max.
	it("offers each model only the efforts Mistral documents and sends them on the wire", async () => {
		const ladders = [
			["zai-glm-5-3", [Effort.Low, Effort.High, Effort.Max]],
			["zai-glm-5-3-flash", [Effort.Low, Effort.High, Effort.Max]],
			["mistral-large-4", [Effort.Low, Effort.Medium, Effort.High]],
			["mistral-large-4-0", [Effort.Low, Effort.Medium, Effort.High]],
		] as const;
		for (const [id, efforts] of ladders) {
			const model = getBundledModel<"openai-completions">("mistral", id);
			expect(getSupportedEfforts(model)).toEqual([...efforts]);
			const send = async (requested: Effort) =>
				toObject(
					await captureOpenAICompletionsPayload(model, undefined, {
						reasoning: clampThinkingLevelForModel(model, requested),
					}),
				)?.reasoning_effort;
			// A documented effort goes out as itself, `max` included.
			for (const effort of efforts) expect(await send(effort)).toBe(effort);
			// An undocumented one is clamped to a documented value, never sent as-is.
			for (const requested of [Effort.Minimal, Effort.Medium, Effort.XHigh, Effort.Max]) {
				if ((efforts as readonly Effort[]).includes(requested)) continue;
				expect(efforts as readonly unknown[]).toContain(await send(requested));
			}
		}
	});
});

// Mistral Medium 3.5 streams `delta.content` as an array of typed content parts
// (`[{ type: "text", text: "Hello" }]`) instead of a plain string; appending it
// verbatim would coerce the array to the literal `[object Object]`.
describe("Mistral typed content parts in streamed deltas", () => {
	const model: Model<"openai-completions"> = {
		...getBundledModel("mistral", "mistral-medium-2604"),
	};

	it("normalizes array-of-parts delta.content into the assembled text without [object Object]", async () => {
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-mistral-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: [{ type: "text", text: "Hello" }] },
					},
				],
			},
			{
				id: "chatcmpl-mistral-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: [{ type: "text", text: ", world" }] },
					},
				],
			},
			{
				id: "chatcmpl-mistral-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");

		expect(text).not.toContain("[object Object]");
		expect(text).toBe("Hello, world");
	});

	it("handles mixed string and array-of-parts content shapes within one stream", async () => {
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-mistral-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "plain " } }],
			},
			{
				id: "chatcmpl-mistral-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							content: [
								{ type: "text", text: "and " },
								{ type: "text", text: "typed" },
							],
						},
					},
				],
			},
			{
				id: "chatcmpl-mistral-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");

		expect(text).not.toContain("[object Object]");
		expect(text).toBe("plain and typed");
	});
});

describe("Groq Qwen reasoning_effort on the wire", () => {
	it("sends each Qwen only an effort value Groq accepts", async () => {
		// Qwen 3.6 takes `default` (thinking) or `none`; Qwen 3.8 takes low/medium/high.
		const qwen36 = getBundledModel<"openai-completions">("groq", "qwen/qwen3.6-27b");
		const on36 = toObject(await captureOpenAICompletionsPayload(qwen36, undefined, { reasoning: "high" }));
		expect(on36?.reasoning_effort).toBe("default");
		expect(on36?.enable_thinking).toBeUndefined();

		const qwen38 = getBundledModel<"openai-completions">("groq", "qwen/qwen3.8-27b");
		const on38 = toObject(await captureOpenAICompletionsPayload(qwen38, undefined, { reasoning: "low" }));
		expect(on38?.reasoning_effort).toBe("low");
	});
});

describe("Kimi K3 reasoning_effort contract on OpenAI-compatible routes", () => {
	const kimiK3Litellm = buildModel({
		id: "kimi-k3",
		name: "Kimi K3",
		api: "openai-completions",
		provider: "litellm",
		baseUrl: "http://127.0.0.1:4000/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 32_768,
	});

	it("derives K3's mandatory low/high/max ladder for a LiteLLM route", () => {
		expect(getSupportedEfforts(kimiK3Litellm)).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(kimiK3Litellm.thinking).toMatchObject({
			mode: "effort",
			defaultLevel: Effort.Max,
			requiresEffort: true,
		});
		expect(kimiK3Litellm.compat.reasoningEffortMap).toEqual({
			minimal: "low",
			medium: "high",
			xhigh: "max",
			max: "max",
		});
	});

	it("folds every generic requested tier into K3's accepted wire values", async () => {
		const cases: readonly (readonly [Effort, string])[] = [
			[Effort.Minimal, "low"],
			[Effort.Low, "low"],
			[Effort.Medium, "high"],
			[Effort.High, "high"],
			[Effort.XHigh, "max"],
			[Effort.Max, "max"],
		];
		const payloads = await Promise.all(
			cases.map(([requested]) =>
				captureOpenAICompletionsPayload(kimiK3Litellm, undefined, { reasoning: requested }),
			),
		);
		for (let index = 0; index < cases.length; index++) {
			expect(payloads[index]).toMatchObject({ reasoning_effort: cases[index]?.[1] });
		}
	});
});

describe("custom API OpenAI-completions compatibility", () => {
	const CUSTOM_OPENAI_API = "custom-openai-wrapper";

	function customModel(api: string, compat?: ModelSpec<Api>["compat"]): Model<Api> {
		return buildModel({
			id: "hy4-preview",
			name: "HY4 Preview",
			provider: "custom-wrapper-provider",
			baseUrl: "https://example.com/v1",
			api,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131_072,
			maxTokens: 8_192,
			compat,
		} as ModelSpec<Api>);
	}

	function createFetch(
		capture?: (body: Record<string, unknown>) => void,
		delta?: Record<string, unknown>,
		finishReason = "stop",
	): FetchImpl {
		async function mockFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
			if (typeof init?.body === "string") capture?.(JSON.parse(init.body) as Record<string, unknown>);
			const payload = [
				`data: ${JSON.stringify({
					id: "chatcmpl-custom",
					object: "chat.completion.chunk",
					created: 0,
					model: "hy4-preview",
					choices: [{ index: 0, delta: { role: "assistant", content: "ok", ...delta } }],
				})}`,
				`data: ${JSON.stringify({
					id: "chatcmpl-custom",
					object: "chat.completion.chunk",
					created: 0,
					model: "hy4-preview",
					choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
				})}`,
				"data: [DONE]",
			].join("\n\n");
			return new Response(`${payload}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		return Object.assign(mockFetch, { preconnect: fetch.preconnect });
	}

	function registerOpenAIWrapper(): void {
		registerCustomApi(CUSTOM_OPENAI_API, (custom, messages, options) =>
			streamOpenAICompletions(
				custom as Model<"openai-completions">,
				messages,
				(options ?? {}) as OpenAICompletionsOptions,
			),
		);
	}

	afterEach(() => {
		clearCustomApis();
	});

	it("streams through an OpenAI-completions wrapper with declared overrides", async () => {
		const model = customModel(CUSTOM_OPENAI_API, {
			maxTokensField: "max_tokens",
			supportsSamplingParams: false,
		});
		registerOpenAIWrapper();

		let request: Record<string, unknown> | undefined;
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				fetch: createFetch(body => {
					request = body;
				}),
				temperature: 0.7,
				maxTokens: 321,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(request?.max_tokens).toBe(321);
		expect(request?.max_completion_tokens).toBeUndefined();
		expect(request?.temperature).toBeUndefined();
	});

	it("captures and replays opaque reasoning through an opted-in wrapper", async () => {
		const model = customModel(CUSTOM_OPENAI_API, { reasoningOpaqueReplay: true });
		registerOpenAIWrapper();
		const initial: Context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
		const reasoning = { reasoning_opaque: "opaque-state", reasoning_text: "Check the input." };
		const first = await streamSimple(model, initial, {
			apiKey: "test-key",
			fetch: createFetch(undefined, reasoning),
		}).result();

		expect(first.stopReason).toBe("stop");
		expect(first.api).toBe(CUSTOM_OPENAI_API);
		const thinking = first.content.find(block => block.type === "thinking");
		expect(parseReasoningDetailsSignature(thinking?.thinkingSignature)).toMatchObject({
			field: "reasoning_text",
			reasoningOpaque: reasoning.reasoning_opaque,
		});

		let request: Record<string, unknown> | undefined;
		const next = await streamSimple(
			model,
			{ messages: [...initial.messages, first, { role: "user", content: "continue", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				fetch: createFetch(body => {
					request = body;
				}),
			},
		).result();

		expect(next.stopReason).toBe("stop");
		expect(request?.messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "assistant", ...reasoning })]),
		);
	});

	it("does not replay opaque reasoning when a wrapper truncates a tool call ID", async () => {
		const model = customModel(CUSTOM_OPENAI_API, {
			reasoningOpaqueReplay: true,
			usesOpenAIToolCallIdLimit: true,
		});
		registerOpenAIWrapper();
		const initial: Context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
		const id = `call_${"a".repeat(48)}`;
		const first = await streamSimple(model, initial, {
			apiKey: "test-key",
			fetch: createFetch(
				undefined,
				{
					reasoning_opaque: "opaque-state",
					reasoning_text: "Read the file.",
					tool_calls: [{ index: 0, id, type: "function", function: { name: "read", arguments: "{}" } }],
				},
				"tool_calls",
			),
		}).result();
		expect(first.stopReason).toBe("toolUse");
		expect(first.content).toContainEqual(expect.objectContaining({ type: "toolCall", id }));
		const thinking = first.content.find(block => block.type === "thinking");
		expect(parseReasoningDetailsSignature(thinking?.thinkingSignature)?.reasoningOpaque).toBe("opaque-state");

		let request: Record<string, unknown> | undefined;
		const next = await streamSimple(
			model,
			{
				messages: [
					...initial.messages,
					first,
					{
						role: "toolResult",
						toolCallId: id,
						toolName: "read",
						content: [{ type: "text", text: "file contents" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: createFetch(body => {
					request = body;
				}),
			},
		).result();

		expect(next.stopReason).toBe("stop");
		const messages = request?.messages as Array<Record<string, unknown>> | undefined;
		const replayed = messages?.find(message => message.role === "assistant");
		expect(replayed).toMatchObject({ tool_calls: [{ id: id.slice(0, 40) }] });
		expect(replayed).not.toHaveProperty("reasoning_opaque");
	});

	it("keeps compatibility undefined for a registered unrelated custom API", () => {
		const api = "custom-anthropic-shaped";
		registerCustomApi(api, () => {
			throw new Error("unrelated custom streamer must not run");
		});
		const model = customModel(api);
		expect(model.compat).toBeUndefined();
	});
});

describe("DeepSeek special tokens in outgoing text", () => {
	// DeepSeek V4.1's encoder rejects this placeholder anywhere in message text, so a
	// tool result quoting the chat template would fail every later request.
	const IMAGE_MARKER = "<｜deepseek_image｜>";
	const NEUTRALIZED_MARKER = "<\u200b｜deepseek_image｜>";
	const DSML_CALL = "<｜DSML｜tool_calls>";

	function quotingContext(model: Model<"openai-completions">): Context {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `plan ${IMAGE_MARKER}`, thinkingSignature: "reasoning_content" },
				{ type: "toolCall", id: "call_1", name: "write", arguments: { content: IMAGE_MARKER } },
			],
			api: "openai-completions",
			provider: model.provider,
			model: model.id,
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
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "write",
			content: [{ type: "text", text: `{{ "${IMAGE_MARKER}" }} ${DSML_CALL} <|im_start|>` }],
			isError: false,
			timestamp: Date.now(),
		};
		return {
			messages: [{ role: "user", content: `quote ${IMAGE_MARKER}`, timestamp: Date.now() }, assistant, result],
		};
	}

	it.each([
		// reasoning replays as top-level `reasoning_content`
		["deepseek", "deepseek-v4.1-flash", "https://api.deepseek.com"],
		// reasoning replays as nested Mistral `thinking` content parts
		["mistral", "deepseek-v4-1-flash-1017", "https://api.mistral.ai/v1"],
	])("breaks DeepSeek tokens in every replayed text field on %s", (provider, id, baseUrl) => {
		const model = buildModel({
			id,
			name: id,
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		} satisfies ModelSpec<"openai-completions">);
		const wire = JSON.stringify(convertMessages(model, quotingContext(model), model.compat));
		expect(wire).not.toContain(IMAGE_MARKER);
		expect(wire).not.toContain("｜DSML｜");
		expect(wire).toContain(`plan ${NEUTRALIZED_MARKER}`);
		expect(wire).toContain(`quote ${NEUTRALIZED_MARKER}`);
		// ASCII-pipe spellings are left alone: they are common in ordinary text.
		expect(wire).toContain("<|im_start|>");
	});

	it("leaves the marker intact for non-DeepSeek models", () => {
		const model = buildModel(gpt4oMiniSpec);
		const wire = JSON.stringify(convertMessages(model, quotingContext(model), model.compat));
		expect(wire).toContain(`quote ${IMAGE_MARKER}`);
		expect(wire).not.toContain("\u200b");
	});
});
