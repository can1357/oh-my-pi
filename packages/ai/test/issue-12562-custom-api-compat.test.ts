import { afterEach, describe, expect, it } from "bun:test";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { parseReasoningDetailsSignature } from "@oh-my-pi/pi-ai/utils/reasoning-source";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const CUSTOM_OPENAI_API = "issue-12562-openai-wrapper";

function customModel(api: string, compat?: ModelSpec<Api>["compat"]): Model<Api> {
	return buildModel({
		id: "hy4-preview",
		name: "HY4 Preview",
		provider: "issue-12562-provider",
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

function context(): Context {
	return {
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	};
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
				id: "chatcmpl-12562",
				object: "chat.completion.chunk",
				created: 0,
				model: "hy4-preview",
				choices: [{ index: 0, delta: { role: "assistant", content: "ok", ...delta } }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl-12562",
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

describe("custom API OpenAI-completions compatibility (#12562)", () => {
	it("streams through an OpenAI-completions wrapper with declared overrides", async () => {
		const model = customModel(CUSTOM_OPENAI_API, {
			maxTokensField: "max_tokens",
			supportsSamplingParams: false,
		});
		registerOpenAIWrapper();

		let request: Record<string, unknown> | undefined;
		const result = await streamSimple(model, context(), {
			apiKey: "test-key",
			fetch: createFetch(body => {
				request = body;
			}),
			temperature: 0.7,
			maxTokens: 321,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(request?.max_tokens).toBe(321);
		expect(request?.max_completion_tokens).toBeUndefined();
		expect(request?.temperature).toBeUndefined();
	});

	it("captures and replays opaque reasoning through an opted-in wrapper", async () => {
		const model = customModel(CUSTOM_OPENAI_API, { reasoningOpaqueReplay: true });
		registerOpenAIWrapper();
		const initial = context();
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
		const initial = context();
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
		const api = "issue-12562-anthropic-shaped";
		registerCustomApi(api, () => {
			throw new Error("unrelated custom streamer must not run");
		});
		const model = customModel(api);
		expect(model.compat).toBeUndefined();
	});
});
