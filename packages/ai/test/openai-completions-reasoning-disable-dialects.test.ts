import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ModelSpec, OpenAICompat, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Each Chat Completions reasoning dialect carries "thinking is on" on a
// different wire field. The `disableReasoningOnForcedToolChoice` /
// `disableReasoningOnToolChoice` conflict policies must turn thinking OFF on the
// *matching* field, not just delete `reasoning_effort` — otherwise a Qwen /
// Qwen-template / OpenRouter request keeps thinking enabled and re-trips the
// very 400 the policy exists to dodge. Both conflict branches funnel through the
// same `disableChatCompletionsReasoningForDialect` helper, so the forced-tool
// path below exercises that helper for every dialect.

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function createMockFetch(): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

const readTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
};

function forcedToolContext(): Context {
	return {
		messages: [{ role: "user", content: "Summarize the README", timestamp: Date.now() }],
		tools: [readTool],
	};
}

function reasoningDialectModel(
	thinkingFormat: NonNullable<OpenAICompat["thinkingFormat"]>,
	compatOverrides: Partial<OpenAICompat> = {},
): Model<"openai-completions"> {
	return buildModel({
		id: "test-reasoning-model",
		name: "Test Reasoning Model",
		api: "openai-completions",
		provider: "custom-openai-compatible",
		baseUrl: "https://example.test/v1",
		reasoning: true,
		compat: {
			thinkingFormat,
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
			supportsToolChoice: true,
			supportsForcedToolChoice: true,
			disableReasoningOnForcedToolChoice: true,
			...compatOverrides,
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	} satisfies ModelSpec<"openai-completions">);
}

async function captureForcedToolPayload(model: Model<"openai-completions">): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, forcedToolContext(), {
		apiKey: "test-key",
		fetch: createMockFetch(),
		signal: createAbortedSignal(),
		reasoning: "high",
		toolChoice: { type: "tool", name: "read" },
		onPayload: payload => resolve(payload),
	});
	const payload = await promise;
	if (typeof payload !== "object" || payload === null) throw new Error("Expected captured request payload");
	return payload as Record<string, unknown>;
}

describe("Chat Completions reasoning-disable conflict policy (per dialect)", () => {
	it("disables Go LongCat reasoning without selecting a nonexistent effort", async () => {
		const model = getBundledModel<"openai-completions">("opencode-go", "longcat-2.5-preview-free");
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "Summarize the README", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				fetch: createMockFetch(),
				signal: createAbortedSignal(),
				disableReasoning: true,
				onPayload: payload => resolve(payload),
			},
		);

		const payload = await promise;
		expect(payload).toEqual(expect.objectContaining({ reasoning: { enabled: false } }));
		expect(payload).not.toHaveProperty("reasoning_effort");
	});

	it("disables Z.AI thinking and drops reasoning_effort on forced tool choice", async () => {
		const payload = await captureForcedToolPayload(reasoningDialectModel("zai"));
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.reasoning_effort).toBeUndefined();
	});

	it("sets Qwen enable_thinking=false on forced tool choice", async () => {
		const payload = await captureForcedToolPayload(reasoningDialectModel("qwen"));
		expect(payload.enable_thinking).toBe(false);
		expect(payload.reasoning_effort).toBeUndefined();
	});

	it("sets Qwen chat-template enable_thinking=false on forced tool choice", async () => {
		const payload = await captureForcedToolPayload(reasoningDialectModel("qwen-chat-template"));
		expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(payload.reasoning_effort).toBeUndefined();
	});

	it("sets OpenRouter reasoning={enabled:false} (never just deleted) on forced tool choice", async () => {
		const payload = await captureForcedToolPayload(reasoningDialectModel("openrouter"));
		// OpenRouter defaults reasoning models back to thinking when `reasoning` is
		// absent, so suppression must explicitly disable rather than delete it.
		expect(payload.reasoning).toEqual({ enabled: false });
		expect(payload.reasoning_effort).toBeUndefined();
	});

	it("drops stale reasoning_effort for OpenAI-style effort endpoints on forced tool choice", async () => {
		const payload = await captureForcedToolPayload(reasoningDialectModel("openai"));
		expect(payload.reasoning_effort).toBeUndefined();
		expect(payload.reasoning).toBeUndefined();
	});

	it("omits reasoning fields when a non-reasoning model disables reasoning for a forced tool", async () => {
		const model = { ...reasoningDialectModel("openai"), reasoning: false, thinking: undefined };
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(model, forcedToolContext(), {
			apiKey: "test-key",
			fetch: createMockFetch(),
			signal: createAbortedSignal(),
			disableReasoning: true,
			toolChoice: { type: "tool", name: "read" },
			onPayload: payload => resolve(payload),
		});

		const payload = await promise;
		expect(payload).not.toHaveProperty("reasoning_effort");
		expect(payload).not.toHaveProperty("reasoning");
	});

	it("returns a terminal error when reasoning policy resolution fails", async () => {
		const model: Model<"openai-completions"> = {
			...reasoningDialectModel("openai"),
			thinking: { mode: "effort", efforts: [] },
		};
		const stream = streamOpenAICompletions(model, forcedToolContext(), {
			apiKey: "test-key",
			fetch: createMockFetch(),
			disableReasoning: true,
			toolChoice: { type: "tool", name: "read" },
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("has no supported reasoning efforts");
	});

	it("applies the same per-dialect disable on the non-forced disableReasoningOnToolChoice path", async () => {
		// Non-forced branch shares the dialect-aware helper: an OpenRouter
		// reasoning model with disableReasoningOnToolChoice must emit
		// reasoning={enabled:false} rather than leaving the effort object in place.
		// A semantic "none" selector exercises the path; a bare "auto" no longer
		// does — it is dropped as redundant so reasoning survives (#1207).
		const model = reasoningDialectModel("openrouter", {
			disableReasoningOnForcedToolChoice: false,
			disableReasoningOnToolChoice: true,
		});
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(model, forcedToolContext(), {
			apiKey: "test-key",
			fetch: createMockFetch(),
			signal: createAbortedSignal(),
			reasoning: "high",
			toolChoice: "none",
			onPayload: payload => resolve(payload),
		});
		const payload = (await promise) as Record<string, unknown>;
		expect(payload.tool_choice).toBe("none");
		expect(payload.reasoning).toEqual({ enabled: false });
	});
});

// Kimi reasoning models reject `tool_choice 'specified' is incompatible with
// thinking enabled`, and Anthropic rejects reasoning beside a forced tool choice.
// Like Anthropic's `disableThinkingIfToolChoiceForced`, the forced turn drops
// reasoning instead of dropping `tool_choice`.
describe("forced tool_choice reasoning suppression by model family", () => {
	function catalogModel(spec: Partial<ModelSpec<"openai-completions">>): Model<"openai-completions"> {
		const base = getBundledModel("openai", "gpt-4o-mini");
		return buildModel({
			...base,
			api: "openai-completions",
			...spec,
			compat: base.compatConfig,
		} as ModelSpec<"openai-completions">);
	}

	function kimiOpencodeGoModel(): Model<"openai-completions"> {
		return catalogModel({
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/v1",
			id: "kimi-k2.6",
			name: "Kimi K2.6",
			reasoning: true,
		});
	}

	async function captureToolChoicePayload(
		model: Model<"openai-completions">,
		options: Parameters<typeof streamOpenAICompletions>[2],
	): Promise<Record<string, unknown>> {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(model, forcedToolContext(), {
			...options,
			apiKey: "test-key",
			fetch: createMockFetch(),
			signal: createAbortedSignal(),
			onPayload: payload => resolve(payload),
		});
		return (await promise) as Record<string, unknown>;
	}

	it("strips reasoning_effort when toolChoice is forced on direct Kimi (Moonshot-style id)", async () => {
		const body = await captureToolChoicePayload(kimiOpencodeGoModel(), { reasoning: "high", toolChoice: "any" });

		// Forced choice still forwarded so the model must pick a tool…
		expect(body.tool_choice).toBe("required");
		// …but reasoning is suppressed to satisfy Kimi's "thinking incompatible with forced tool_choice" rule.
		expect(body.reasoning_effort).toBeUndefined();
	});

	it("preserves reasoning_effort when toolChoice is auto", async () => {
		const body = await captureToolChoicePayload(kimiOpencodeGoModel(), { reasoning: "high", toolChoice: "auto" });

		expect(body.tool_choice).toBe("auto");
		expect(body.reasoning_effort).toBe("high");
	});

	it("strips OpenRouter-shaped reasoning object on forced toolChoice for Kimi via OpenRouter", async () => {
		const model = catalogModel({
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			id: "moonshotai/kimi-k2",
			name: "Kimi K2 (OpenRouter)",
			reasoning: true,
		});
		const body = await captureForcedToolPayload(model);

		expect(body.tool_choice).toMatchObject({ type: "function", function: { name: "read" } });
		expect(body.reasoning).toBeUndefined();
		expect(body.reasoning_effort).toBeUndefined();
	});

	it("sends explicit thinking disabled for Moonshot Kimi K2.6 when a named tool is forced", async () => {
		const model = catalogModel({
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			id: "kimi-k2.6",
			name: "Kimi K2.6",
			reasoning: false,
		});
		const body = await captureToolChoicePayload(model, { toolChoice: { type: "tool", name: "read" } });

		expect(body.tool_choice).toMatchObject({ type: "function", function: { name: "read" } });
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.reasoning).toBeUndefined();
		expect(body.reasoning_effort).toBeUndefined();
	});

	it("strips reasoning_effort for Anthropic Claude models served via openai-completions (e.g. LiteLLM/OpenRouter proxies)", async () => {
		// LiteLLM / Vertex proxies often expose Claude through chat-completions; the
		// Anthropic reasoning + forced tool_choice constraint follows the model
		// when it's reached through the OpenAI shape.
		const model = catalogModel({
			provider: "litellm",
			baseUrl: "http://localhost:4000/v1",
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6 (LiteLLM)",
			reasoning: true,
		});
		const body = await captureToolChoicePayload(model, { reasoning: "high", toolChoice: "any" });

		expect(body.tool_choice).toBe("required");
		expect(body.reasoning_effort).toBeUndefined();
	});

	it("does not strip reasoning on non-Kimi models even with forced tool_choice", async () => {
		// OpenAI itself accepts forced tool_choice with reasoning.
		const model = catalogModel({ id: "gpt-5-mini", reasoning: true });
		const body = await captureToolChoicePayload(model, { reasoning: "high", toolChoice: "any" });

		expect(body.tool_choice).toBe("required");
		expect(body.reasoning_effort).toBe("high");
	});
});
