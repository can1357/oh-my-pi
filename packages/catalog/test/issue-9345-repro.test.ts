/**
 * Issue #9345 — `Can't use qwen3-6-35b-a3b on Venice because OMP sends some
 * incorrect params.`
 *
 * Reporter: with `venice/qwen3-6-35b-a3b` configured as the `smol` model role,
 * spawning a `scout` subagent fails with `400 Invalid request parameters` from
 * Venice. The captured request body carried the top-level `enable_thinking:
 * true` boolean.
 *
 * Root cause: Venice's `chat/completions` schema is `additionalProperties:
 * false` and does not define `enable_thinking`. Venice drives reasoning via the
 * OpenAI-style `reasoning_effort` field (and `venice_parameters.disable_thinking`).
 * `buildOpenAICompat` picked `thinkingFormat: "qwen"` from the `qwen` id pattern
 * regardless of host, so every Venice-hosted qwen turn 400'd — the same defect
 * class as the earlier Fireworks and NVIDIA NIM host overrides.
 *
 * Fix: register `venice` as a known host (`api.venice.ai`) and route
 * Venice-hosted qwen models to `thinkingFormat: "openai"` so the wire body
 * carries `reasoning_effort` instead of `enable_thinking`.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "@oh-my-pi/pi-utils";

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

function sseDoneResponse(): Response {
	return new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
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

describe("issue #9345 — Venice qwen thinking format", () => {
	it("resolves Venice-hosted qwen models to the reasoning_effort thinking format", () => {
		const compat = buildOpenAICompat(veniceQwenSpec());
		expect(compat.thinkingFormat).toBe("openai");
	});

	it("detects Venice by baseUrl even when the provider id is a custom loopback", () => {
		const compat = buildOpenAICompat(veniceQwenSpec({ provider: "custom" }));
		expect(compat.thinkingFormat).toBe("openai");
	});

	it("keeps Alibaba DashScope qwen models on the top-level enable_thinking format", () => {
		// Only Venice (and the other strict-schema hosts) diverges; the native
		// DashScope upstream still speaks top-level `enable_thinking`.
		const dashscope = veniceQwenSpec({
			id: "qwen3-coder-plus",
			name: "Qwen3 Coder Plus",
			provider: "alibaba-coding-plan",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		});
		expect(buildOpenAICompat(dashscope).thinkingFormat).toBe("qwen");
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
