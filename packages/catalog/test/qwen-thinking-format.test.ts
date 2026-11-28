import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "@oh-my-pi/pi-utils";

// Alibaba DashScope speaks top-level `enable_thinking`. Strict-schema hosts
// (`additionalProperties: false`) reject it with a 400, so the `qwen` id
// pattern must not pick the DashScope format regardless of host.

function sseDoneResponse(): Response {
	return new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function veniceQwenSpec(overrides: Partial<ModelSpec<"openai-completions">> = {}): ModelSpec<"openai-completions"> {
	return {
		api: "openai-completions",
		id: "qwen3-6-35b-a3b",
		name: "Qwen3 6-35B A3B",
		provider: "venice",
		baseUrl: "https://api.venice.ai/api/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 64_000,
		contextWindow: 131_072,
		reasoning: true,
		...overrides,
	};
}

interface VeniceReasoningOptions {
	reasoning?: "high";
	disableReasoning?: boolean;
}

async function captureVeniceQwenBody(options: VeniceReasoningOptions) {
	const bundled = getBundledModel<"openai-completions">("venice", "qwen3-6-35b-a3b");
	const model = {
		...bundled,
		compat: {
			...bundled.compat,
			extraBody: { venice_parameters: { include_venice_system_prompt: false } },
		},
	};
	const captured: { body: string | null } = { body: null };
	const fetchMock: FetchImpl = async (_input, init) => {
		captured.body = typeof init?.body === "string" ? init.body : null;
		return sseDoneResponse();
	};
	const context: Context = {
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	};
	const stream = streamOpenAICompletions(model, context, {
		apiKey: "vn-test",
		...options,
		fetch: fetchMock,
	});
	for await (const _ of stream) {
		// drain
	}
	const body: unknown = JSON.parse(captured.body ?? "{}");
	if (!isRecord(body)) throw new Error("Captured Venice request body was not an object");
	return { body, model };
}

describe("DashScope Qwen thinking format", () => {
	it("keeps Alibaba DashScope qwen models on the top-level enable_thinking format", () => {
		const dashscope: ModelSpec<"openai-completions"> = {
			api: "openai-completions",
			id: "qwen3-coder-plus",
			name: "Qwen3 Coder Plus",
			provider: "alibaba-coding-plan",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8192,
			contextWindow: 131072,
			reasoning: true,
		};
		expect(resolveModelPolicy(dashscope).compat.thinkingFormat).toBe("qwen");
	});
});

// NVIDIA NIM's qwen models accept the vLLM convention
// `chat_template_kwargs: { enable_thinking: bool }`.
describe("NVIDIA NIM Qwen thinking format", () => {
	it("resolves NVIDIA-hosted qwen models to the chat_template_kwargs thinking format", () => {
		const spec: ModelSpec<"openai-completions"> = {
			api: "openai-completions",
			id: "qwen/qwen3.5-397b-a17b",
			name: "Qwen3.5-397B-A17B",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8192,
			contextWindow: 262144,
			reasoning: true,
		};
		const compat = resolveModelPolicy(spec).compat;
		expect(compat.thinkingFormat).toBe("qwen-chat-template");
	});

	it("emits chat_template_kwargs.enable_thinking — never top-level enable_thinking — on the wire", async () => {
		const model = getBundledModel<"openai-completions">("nvidia", "qwen/qwen3.5-397b-a17b");
		expect(model.provider).toBe("nvidia");
		expect(model.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
		expect(model.reasoning).toBe(true);
		expect(model.compatConfig?.thinkingFormat).toBeUndefined();

		const captured: { body: string | null } = { body: null };
		const fetchMock: FetchImpl = async (_input, init) => {
			captured.body = typeof init?.body === "string" ? init.body : null;
			return sseDoneResponse();
		};

		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};
		const stream = streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey: "nvapi-test",
			reasoning: "high",
			fetch: fetchMock,
		});
		for await (const _ of stream) {
			// drain
		}

		expect(captured.body).not.toBeNull();
		const parsed = JSON.parse(captured.body ?? "{}") as Record<string, unknown>;
		// NVIDIA NIM 400s on top-level `enable_thinking`. The vLLM-compatible
		// `chat_template_kwargs.enable_thinking` is what the official
		// `qwen/qwen3.5-122b-a10b` docs example uses.
		expect(parsed.enable_thinking).toBeUndefined();
		expect(parsed.chat_template_kwargs).toEqual({ enable_thinking: true });
	});
});

describe("Fireworks Qwen thinking format", () => {
	it("resolves Fireworks-hosted qwen models to the openai thinking format (reasoning_effort)", () => {
		// Fireworks hosts Qwen3 with controllable thinking via OpenAI-style
		// `reasoning_effort`, and its strict request schema rejects the top-level
		// `enable_thinking` boolean.
		const compat = resolveModelPolicy({
			api: "openai-completions",
			id: "qwen3.7-plus",
			name: "Qwen3.7 Plus",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 65_536,
			contextWindow: 262_144,
			reasoning: true,
		}).compat;
		expect(compat.thinkingFormat).toBe("openai");
		expect(compat.reasoningDisableMode).toBe("lowest-effort");
	});
});

// Venice drives reasoning via `reasoning_effort` and
// `venice_parameters.disable_thinking`; its schema does not define `enable_thinking`.
describe("Venice Qwen thinking format", () => {
	it("resolves Venice-hosted qwen models to the reasoning_effort thinking format", () => {
		const compat = resolveModelPolicy(veniceQwenSpec()).compat;
		expect(compat.thinkingFormat).toBe("openai");
	});

	it("detects Venice by baseUrl even when the provider id is a custom loopback", () => {
		const compat = resolveModelPolicy(veniceQwenSpec({ provider: "custom" })).compat;
		expect(compat.thinkingFormat).toBe("openai");
	});

	it("emits reasoning_effort — never top-level enable_thinking — on the wire", async () => {
		const { body, model } = await captureVeniceQwenBody({ reasoning: "high" });
		expect(model.provider).toBe("venice");
		expect(model.baseUrl).toBe("https://api.venice.ai/api/v1");
		expect(model.compat.thinkingFormat).toBe("openai");
		expect(model.compat.reasoningDisableMode).toBe("venice-disable-thinking");
		expect(model.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
		expect(body.enable_thinking).toBeUndefined();
		expect(body.chat_template_kwargs).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
		expect(body.venice_parameters).toEqual({ include_venice_system_prompt: false });
	});

	it("emits Venice's explicit disable flag when reasoning is off", async () => {
		const { body } = await captureVeniceQwenBody({ disableReasoning: true });
		expect(body.reasoning_effort).toBeUndefined();
		expect(body.enable_thinking).toBeUndefined();
		expect(body.chat_template_kwargs).toBeUndefined();
		expect(body.venice_parameters).toEqual({
			include_venice_system_prompt: false,
			disable_thinking: true,
		});
	});
});
