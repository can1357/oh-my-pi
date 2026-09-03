import { describe, expect, it } from "bun:test";
import {
	isOpenAICompletionsProgressChunk,
	streamOpenAICompletions,
} from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const openAICompletionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;
const openAIResponsesModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function getRequestSignal(input: string | URL | Request, init: RequestInit | undefined): AbortSignal | undefined {
	if (init?.signal) {
		return init.signal;
	}
	if (input instanceof Request) {
		return input.signal;
	}
	return undefined;
}

function createKeepaliveOnlyCompletionsResponse(modelId: string, signal: AbortSignal | undefined): Response {
	const encoder = new TextEncoder();
	let interval: NodeJS.Timeout | undefined;
	let abortListener: (() => void) | undefined;
	const encode = (event: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				encode({
					id: "chatcmpl-stalled",
					object: "chat.completion.chunk",
					created: 0,
					model: modelId,
					choices: [{ index: 0, delta: { content: "Hello" } }],
				}),
			);
			interval = setInterval(() => {
				controller.enqueue(
					encode({
						id: "chatcmpl-stalled",
						object: "chat.completion.chunk",
						created: 0,
						model: modelId,
						choices: [{ index: 0, delta: { role: "assistant" } }],
					}),
				);
			}, 2);
			abortListener = () => {
				if (interval) clearInterval(interval);
				if (abortListener) signal?.removeEventListener("abort", abortListener);
				const reason = signal?.reason;
				controller.error(reason instanceof Error ? reason : new Error("request aborted"));
			};
			if (signal?.aborted) {
				queueMicrotask(() => abortListener?.());
			} else {
				signal?.addEventListener("abort", abortListener, { once: true });
			}
		},
		cancel() {
			if (interval) clearInterval(interval);
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("resolveOpenAICompat stream idle timeout", () => {
	it("widens GLM 5.1 coding-plan stream watchdogs", () => {
		const model = buildModel({
			...openAICompletionsModel,
			id: "glm-5.1",
			name: "GLM-5.1",
			provider: "zhipu-coding-plan",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
			compat: openAICompletionsModel.compatConfig,
		} as ModelSpec<"openai-completions">);

		expect(model.compat.streamIdleTimeoutMs).toBe(600_000);
	});

	it("also widens custom Z.AI OpenAI-compatible GLM 5.1 endpoints", () => {
		const model = buildModel({
			...openAICompletionsModel,
			id: "glm-5.1",
			name: "GLM-5.1",
			provider: "openai",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
			compat: openAICompletionsModel.compatConfig,
		} as ModelSpec<"openai-completions">);

		expect(model.compat.streamIdleTimeoutMs).toBe(600_000);
	});

	it("widens namespaced custom Z.AI OpenAI-compatible GLM 5.2 endpoints", () => {
		const model = buildModel({
			...openAICompletionsModel,
			id: "zai-org/GLM-5.2",
			name: "GLM-5.2",
			provider: "openai",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
			compat: openAICompletionsModel.compatConfig,
		} as ModelSpec<"openai-completions">);

		expect(model.compat.streamIdleTimeoutMs).toBe(600_000);
	});

	it("widens DeepSeek V4 reasoning streams on the official DeepSeek API", () => {
		const model = buildModel({
			...openAICompletionsModel,
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com",
			reasoning: true,
			compat: openAICompletionsModel.compatConfig,
		} as ModelSpec<"openai-completions">);

		expect(model.compat.streamIdleTimeoutMs).toBe(300_000);
	});

	it("widens DeepSeek reasoning streams routed through an aliased OpenAI-compatible provider id", () => {
		const model = buildModel({
			...openAICompletionsModel,
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			provider: "openai",
			baseUrl: "https://api.deepseek.com/v1",
			reasoning: true,
			compat: openAICompletionsModel.compatConfig,
		} as ModelSpec<"openai-completions">);

		expect(model.compat.streamIdleTimeoutMs).toBe(300_000);
	});

	it("widens Kimi K2.6 reasoning streams across OpenAI-compatible hosts", () => {
		const bundled = getBundledModel<"openai-completions">("firepass", "kimi-k2.6-turbo");
		const canonicalRouter = buildModel({
			...bundled,
			id: "accounts/fireworks/routers/kimi-k2p6-turbo",
			compat: bundled.compatConfig,
		} as ModelSpec<"openai-completions">);

		expect(bundled.compat.streamIdleTimeoutMs).toBe(300_000);
		expect(canonicalRouter.compat.streamIdleTimeoutMs).toBe(300_000);
	});

	it("leaves non-reasoning DeepSeek-hosted models on the global timeout", () => {
		const model = buildModel({
			...openAICompletionsModel,
			id: "deepseek-chat",
			name: "DeepSeek Chat",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com",
			reasoning: false,
			compat: openAICompletionsModel.compatConfig,
		} as ModelSpec<"openai-completions">);

		expect(model.compat.streamIdleTimeoutMs).toBeUndefined();
	});

	it("does not widen DeepSeek V4 reasoning models hosted on third-party OpenAI-compatible proxies", () => {
		const model = buildModel({
			...openAICompletionsModel,
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			provider: "aimlapi",
			baseUrl: "https://api.aimlapi.com/v1",
			reasoning: true,
			compat: openAICompletionsModel.compatConfig,
		} as ModelSpec<"openai-completions">);

		expect(model.compat.streamIdleTimeoutMs).toBeUndefined();
	});

	it("keeps ordinary OpenAI-compatible models on the global timeout", () => {
		expect(openAICompletionsModel.compat.streamIdleTimeoutMs).toBeUndefined();
	});

	it("widens local idle watchdogs and disables first-event deadlines", () => {
		const completions = buildModel({
			...openAICompletionsModel,
			id: "qwen3-local",
			name: "Qwen3 Local",
			provider: "llama.cpp",
			baseUrl: "http://localhost:8080/v1",
			compat: openAICompletionsModel.compatConfig,
		} as ModelSpec<"openai-completions">);
		const responses = buildModel({
			...openAIResponsesModel,
			id: "qwen3-local",
			name: "Qwen3 Local",
			provider: "llama.cpp",
			baseUrl: "http://localhost:8080/v1",
			compat: openAIResponsesModel.compatConfig,
		} as ModelSpec<"openai-responses">);

		expect(completions.compat.streamIdleTimeoutMs).toBe(300_000);
		expect(completions.compat.streamFirstEventTimeoutMs).toBe(0);
		expect(responses.compat.streamIdleTimeoutMs).toBe(300_000);
		expect(responses.compat.streamFirstEventTimeoutMs).toBe(0);
	});

	it("widens custom loopback OpenAI-compatible responses stream watchdogs", () => {
		const model = buildModel({
			...openAIResponsesModel,
			id: "local-model",
			name: "Local Model",
			provider: "custom-local",
			baseUrl: "http://127.0.0.1:8080/v1",
			compat: openAIResponsesModel.compatConfig,
		} as ModelSpec<"openai-responses">);

		expect(model.compat.streamIdleTimeoutMs).toBe(300_000);
		expect(model.compat.streamFirstEventTimeoutMs).toBe(0);
	});

	it("widens Xiaomi MiMo Pro stream watchdog (issue #1770)", () => {
		const model = buildModel({
			...openAICompletionsModel,
			id: "mimo-v2.5-pro",
			name: "MiMo v2.5 Pro",
			provider: "xiaomi",
			baseUrl: "https://api.xiaomimimo.com/v1",
		} as ModelSpec<"openai-completions">);

		expect(model.compat.streamIdleTimeoutMs).toBe(300_000);
	});

	it("widens Alibaba Coding Plan stream watchdog (issue #1770)", () => {
		const model = buildModel({
			...openAICompletionsModel,
			id: "qwen3.7-plus",
			name: "Qwen3.7 Plus",
			provider: "alibaba-coding-plan",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
		} as ModelSpec<"openai-completions">);

		expect(model.compat.streamIdleTimeoutMs).toBe(600_000);
	});
});

/**
 * Contract: `isOpenAICompletionsProgressChunk` decides whether a streamed chunk
 * resets the idle-watchdog deadline in `iterateWithIdleTimeout`. A false
 * positive (counting a no-op chunk as progress) silently disables the
 * watchdog and is the root cause of the z.ai/GLM-via-OpenRouter hang where
 * a subagent stalled for hours with no error surfaced. A false negative is
 * cheap (delays the watchdog by at most the first-event window).
 */
describe("isOpenAICompletionsProgressChunk", () => {
	describe("non-progress chunks (MUST NOT reset the watchdog)", () => {
		it("rejects null/non-object", () => {
			expect(isOpenAICompletionsProgressChunk(null)).toBe(false);
			expect(isOpenAICompletionsProgressChunk(undefined)).toBe(false);
			expect(isOpenAICompletionsProgressChunk("hi")).toBe(false);
			expect(isOpenAICompletionsProgressChunk(42)).toBe(false);
		});

		it("rejects empty {} keepalives", () => {
			expect(isOpenAICompletionsProgressChunk({})).toBe(false);
		});

		it("rejects {choices: []} keepalives", () => {
			expect(isOpenAICompletionsProgressChunk({ choices: [] })).toBe(false);
		});

		it("rejects role-only preambles", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { role: "assistant" } }],
				}),
			).toBe(false);
		});

		it("rejects empty-string content deltas", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { content: "" } }],
				}),
			).toBe(false);
		});

		it("rejects empty-array content deltas", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { content: [] } }],
				}),
			).toBe(false);
		});

		it("rejects empty tool_calls arrays", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { tool_calls: [] } }],
				}),
			).toBe(false);
		});

		it("rejects empty reasoning fields", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { reasoning: "" } }],
				}),
			).toBe(false);
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { reasoning_content: "" } }],
				}),
			).toBe(false);
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { reasoning_text: "" } }],
				}),
			).toBe(false);
		});
	});

	describe("progress chunks (MUST reset the watchdog)", () => {
		it("accepts a top-level usage chunk (terminal token report)", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					usage: { prompt_tokens: 12, completion_tokens: 4 },
				}),
			).toBe(true);
		});

		it("accepts choice-level usage", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ usage: { prompt_tokens: 12 } }],
				}),
			).toBe(true);
		});

		it("accepts finish_reason", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ finish_reason: "stop" }],
				}),
			).toBe(true);
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ finish_reason: "tool_calls" }],
				}),
			).toBe(true);
		});

		it("accepts text content deltas", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { content: "Hello" } }],
				}),
			).toBe(true);
		});

		it("accepts array-shape content parts (Mistral-style)", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { content: [{ type: "text", text: "Hi" }] } }],
				}),
			).toBe(true);
		});

		it("accepts tool call deltas", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [
						{
							delta: {
								tool_calls: [{ id: "call_1", function: { name: "search", arguments: "{}" } }],
							},
						},
					],
				}),
			).toBe(true);
		});

		it("accepts reasoning deltas in all three field names", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { reasoning: "thinking..." } }],
				}),
			).toBe(true);
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { reasoning_content: "thinking..." } }],
				}),
			).toBe(true);
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { reasoning_text: "thinking..." } }],
				}),
			).toBe(true);
		});

		it("accepts refusal deltas", () => {
			expect(
				isOpenAICompletionsProgressChunk({
					choices: [{ delta: { refusal: "I can't help with that." } }],
				}),
			).toBe(true);
		});
	});
});
describe("provider integration", () => {
	it("times out a completions stream whose keepalives never make progress", async () => {
		const fetchMock: FetchImpl = (input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(
				createKeepaliveOnlyCompletionsResponse(openAICompletionsModel.id, getRequestSignal(input, init)),
			);

		const result = await streamOpenAICompletions(openAICompletionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			streamFirstEventTimeoutMs: 1_000,
			streamIdleTimeoutMs: 20,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI completions stream stalled while waiting for the next event");
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	});
});
