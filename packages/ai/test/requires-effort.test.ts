import { describe, expect, it } from "bun:test";
import { Effort, type FetchImpl } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec, ThinkingConfig } from "@oh-my-pi/pi-catalog/types";

interface CapturedBody {
	model?: string;
	reasoning?: { enabled?: boolean; effort?: string };
	reasoning_effort?: string;
	chat_template_kwargs?: {
		enable_thinking?: boolean;
		preserve_thinking?: boolean;
		reasoning_effort?: string;
	};
}

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function openRouterModel(thinking: ThinkingConfig): Model<"openai-completions"> {
	return buildModel({
		// Neutral id: the wire contract under test is metadata-driven, not
		// identity-driven (identity baking is covered in catalog tests).
		id: "test/router-model",
		name: "Mandatory Reasoner",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		thinking,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	} satisfies ModelSpec<"openai-completions">);
}

function localQwenModel(): Model<"openai-completions"> {
	return buildModel({
		id: "qwen3.8-27b",
		name: "Local Qwen 3.8",
		api: "openai-completions",
		provider: "local-qwen",
		baseUrl: "http://127.0.0.1:18085/v1",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.XHigh],
			requiresEffort: false,
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 32_768,
		compat: {
			thinkingFormat: "qwen-chat-template",
			qwenTemplateReasoningEffort: true,
			supportsReasoningEffort: true,
			reasoningContentField: "reasoning_content",
		},
	} satisfies ModelSpec<"openai-completions">);
}

async function captureBody(
	model: Model<"openai-completions">,
	options: { reasoning?: Effort; disableReasoning?: boolean; forceReasoningOff?: boolean },
): Promise<CapturedBody> {
	let requestBody: string | undefined;
	const fetchMock: FetchImpl = (_input, init) => {
		requestBody = typeof init?.body === "string" ? init.body : undefined;
		return Promise.resolve(new Response('{"error":{"message":"bad request"}}', { status: 400 }));
	};
	const stream = streamSimple(model, context, { apiKey: "test-key", fetch: fetchMock, ...options });
	await stream.result();
	if (!requestBody) throw new Error("request body was not captured");
	return JSON.parse(requestBody) as CapturedBody;
}

const MANDATORY_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	requiresEffort: true,
};

describe("thinking.requiresEffort clamping", () => {
	it("clamps omitted reasoning to the lowest supported effort", async () => {
		const body = await captureBody(openRouterModel(MANDATORY_THINKING), {});
		expect(body.reasoning).toEqual({ effort: "minimal" });
	});

	it("clamps disableReasoning instead of sending an explicit disable", async () => {
		const body = await captureBody(openRouterModel(MANDATORY_THINKING), { disableReasoning: true });
		// The pre-fix payload was `reasoning: { enabled: false }` — the exact
		// shape OpenRouter rejects with "Reasoning is mandatory".
		expect(body.reasoning).toEqual({ effort: "minimal" });
	});

	it("clamps forceReasoningOff when the endpoint cannot disable reasoning", async () => {
		const body = await captureBody(openRouterModel(MANDATORY_THINKING), {
			reasoning: Effort.High,
			forceReasoningOff: true,
		});
		expect(body.reasoning).toEqual({ effort: "minimal" });
	});

	it("keeps explicit efforts untouched", async () => {
		const body = await captureBody(openRouterModel(MANDATORY_THINKING), { reasoning: Effort.High });
		expect(body.reasoning).toEqual({ effort: "high" });
	});

	it("preserves the status quo for models without the flag", async () => {
		const plain = openRouterModel({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		});
		const off = await captureBody(plain, {});
		expect(off.reasoning).toBeUndefined();
		const disabled = await captureBody(plain, { disableReasoning: true });
		expect(disabled.reasoning).toEqual({ enabled: false });
	});

	it("allows strict off for local Qwen3.8 chat templates", async () => {
		const model = localQwenModel();
		expect(model.thinking?.requiresEffort).toBe(false);

		const body = await captureBody(model, { disableReasoning: true });
		expect(body.reasoning_effort).toBeUndefined();
		expect(body.chat_template_kwargs).toEqual({
			preserve_thinking: true,
			enable_thinking: false,
		});
	});

	it("routes flag-free pairs off to the bare SKU and efforts to the thinking SKU", async () => {
		// Pair derivation strips member-grammar flags: the collapsed pair CAN
		// disable because off routes to the bare backing id.
		const routed = openRouterModel({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortRouting: {
				off: "test/router-model",
				[Effort.Minimal]: "test/router-model-thinking",
				[Effort.High]: "test/router-model-thinking",
			},
		});
		const off = await captureBody(routed, {});
		expect(off.model).toBe("test/router-model");
		expect(off.reasoning).toBeUndefined();
		const high = await captureBody(routed, { reasoning: Effort.High });
		expect(high.model).toBe("test/router-model-thinking");
		expect(high.reasoning).toEqual({ effort: "high" });
	});

	it("clamps flagged pairs whose logical id is itself mandatory", async () => {
		// Identity backfill re-flags pairs like nanogpt's gemini-3.5 twins: the
		// bare SKU cannot disable thinking either, so off floors to minimal and
		// rides the thinking route.
		const routed = openRouterModel({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			requiresEffort: true,
			effortRouting: {
				off: "test/router-model",
				[Effort.Minimal]: "test/router-model-thinking",
				[Effort.High]: "test/router-model-thinking",
			},
		});
		const off = await captureBody(routed, {});
		expect(off.model).toBe("test/router-model-thinking");
		expect(off.reasoning).toEqual({ effort: "minimal" });
	});
});
