/**
 * Issue #2299 — `NVIDIA as provider was selected and models not working correctly.`
 *
 * Reporter: with `NVIDIA_API_KEY` set, selecting any reasoning-capable Qwen
 * model on NVIDIA NIM (e.g. `qwen/qwen3.5-397b-a17b`) and sending a turn
 * returns `400 Validation: Unsupported parameter(s): enable_thinking`.
 *
 * Root cause: NVIDIA NIM's chat-completions schema is
 * `additionalProperties: false`. Its qwen models accept the vLLM convention
 * `chat_template_kwargs: { enable_thinking: bool }`, not the top-level
 * `enable_thinking: bool` that Alibaba DashScope speaks. `buildOpenAICompat`
 * picked `thinkingFormat: "qwen"` from the `qwen/*` id pattern regardless of
 * host, so every NVIDIA-hosted qwen turn 400'd.
 *
 * Fix: register `nvidia` as a known host (`integrate.api.nvidia.com`) and
 * route NVIDIA-hosted qwen models to `thinkingFormat: "qwen-chat-template"`
 * so the wire body carries `chat_template_kwargs.enable_thinking` instead.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function sseDoneResponse(): Response {
	return new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("issue #2299 — NVIDIA NIM qwen thinking format", () => {
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

	it("keeps non-NVIDIA qwen models on the top-level enable_thinking format", () => {
		// Alibaba DashScope (the upstream native API) still wants top-level
		// `enable_thinking` — only NVIDIA NIM diverges.
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
		// Issue #2299: NVIDIA NIM 400s on top-level `enable_thinking`. The
		// vLLM-compatible `chat_template_kwargs.enable_thinking` is what the
		// official `qwen/qwen3.5-122b-a10b` docs example uses.
		expect(parsed.enable_thinking).toBeUndefined();
		expect(parsed.chat_template_kwargs).toEqual({ enable_thinking: true });
	});
});

describe("issue #2299-adj — Fireworks Qwen thinking format", () => {
	it("resolves the bundled Fireworks Qwen model to the openai thinking format (reasoning_effort)", () => {
		// The raw 400 came from `fireworks/qwen3.7-plus`: Fireworks hosts Qwen3
		// with controllable thinking via OpenAI-style `reasoning_effort`, and its
		// strict request schema rejects the top-level `enable_thinking` boolean
		// that Alibaba DashScope speaks. Pin the real bundled id/metadata that
		// produced the failing request, not a synthetic spec.
		const model = getBundledModel<"openai-completions">("fireworks", "qwen3.7-plus");
		expect(model.provider).toBe("fireworks");
		expect(model.baseUrl).toContain("fireworks.ai");
		expect(model.compat.thinkingFormat).toBe("openai");
		expect(model.compat.reasoningDisableMode).toBe("lowest-effort");
	});
});
