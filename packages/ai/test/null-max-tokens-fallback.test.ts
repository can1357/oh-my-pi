import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const ctx: Context = {
	systemPrompt: ["hi"],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

function completionsSse(): Response {
	const events: unknown[] = [
		{
			id: "c",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { content: "ok" } }],
		},
		{
			id: "c",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		"[DONE]",
	];
	const payload = `${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function responsesSse(): Response {
	const event = {
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("null maxTokens fallback wire tests", () => {
	it("verifies anthropic messages wire format max_tokens fallback is finite when maxTokens is null", async () => {
		const spec: ModelSpec<"anthropic-messages"> = {
			id: "claude-custom",
			name: "Claude Custom",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: null, // unknown limit
		};
		const model = buildModel(spec);

		let capturedPayload: Record<string, unknown> | null = null;
		const mockFetch: FetchImpl = async (_url, init) => {
			capturedPayload = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response("{}", { status: 400 }); // we just want to capture
		};

		// streamAnthropic triggers fetch. We ignore errors.
		try {
			await streamAnthropic(model, ctx, { apiKey: "test-key", fetch: mockFetch }).result();
		} catch {
			// expected 400
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload!.max_tokens).toBe(64000); // fallback for unknown model ceilings
	});

	it("verifies openai completions clamps to OPENAI_MAX_OUTPUT_TOKENS when maxTokens is null", async () => {
		const spec: ModelSpec<"openai-completions"> = {
			id: "gpt-custom",
			name: "GPT Custom",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: null, // unknown limit
		};
		const model = buildModel(spec);

		let capturedPayload: Record<string, unknown> | null = null;
		const mockFetch: FetchImpl = async (_url, init) => {
			capturedPayload = JSON.parse(init?.body as string) as Record<string, unknown>;
			return completionsSse();
		};

		await streamOpenAICompletions(model, ctx, {
			apiKey: "test-key",
			maxTokens: 100000, // requested max tokens
			fetch: mockFetch,
		}).result();

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload!.max_completion_tokens).toBe(64000); // clamps to OPENAI_MAX_OUTPUT_TOKENS
	});

	it("sends a finite max-token fallback for Kimi models that require max tokens when maxTokens is null", async () => {
		const spec: ModelSpec<"openai-completions"> = {
			id: "moonshotai/kimi-k2",
			name: "Kimi K2",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: null, // unknown limit
		};
		const model = buildModel(spec);

		let capturedPayload: Record<string, unknown> | null = null;
		const mockFetch: FetchImpl = async (_url, init) => {
			capturedPayload = JSON.parse(init?.body as string) as Record<string, unknown>;
			return completionsSse();
		};

		await streamOpenAICompletions(model, ctx, {
			apiKey: "test-key",
			fetch: mockFetch,
		}).result();

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload!.max_completion_tokens).toBe(64000);
	});

	it("verifies openai responses clamps to OPENAI_MAX_OUTPUT_TOKENS when maxTokens is null", async () => {
		const spec: ModelSpec<"openai-responses"> = {
			id: "gpt-responses-custom",
			name: "GPT Responses Custom",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: null, // unknown limit
		};
		const model = buildModel(spec);

		let capturedPayload: Record<string, unknown> | null = null;
		const mockFetch: FetchImpl = async (_url, init) => {
			capturedPayload = JSON.parse(init?.body as string) as Record<string, unknown>;
			return responsesSse();
		};

		await streamOpenAIResponses(model, ctx, {
			apiKey: "test-key",
			maxTokens: 100000, // requested max tokens
			fetch: mockFetch,
		}).result();

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload!.max_output_tokens).toBe(64000); // clamps to OPENAI_MAX_OUTPUT_TOKENS
	});
});
