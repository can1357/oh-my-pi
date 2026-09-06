import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ModelSpec, OpenAICompat, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

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
