/**
 * Contract: `retry.provider.maxRetries` (`providerMaxAttempts` on the stream
 * options) is the TOTAL provider request allowance for one call — initial
 * request included, shared by every stacked retry layer.
 *
 * Before this contract the transport retried up to its own 6-attempt ceiling
 * and the replay-safe wrapper added a retry on top, so a single agent turn
 * could issue up to 12 requests against a rate-limited endpoint. `retry.baseDelayMs`
 * drives the transport's exponential backoff whenever the provider sends no
 * `Retry-After` hint.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessageEventStream, Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const modelDefaults: Pick<ModelSpec, "id" | "name" | "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens"> = {
	id: "gpt-test",
	name: "GPT test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

const model: Model<"openai-completions"> = buildModel({
	...modelDefaults,
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.test/v1",
});

const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 1_000 }],
};

const RATE_LIMIT_BODY = JSON.stringify({ error: { message: "rate limit exceeded", type: "rate_limit_error" } });

/** A 429 with no `Retry-After` hint: the transport must apply its backoff. */
function rateLimited(): Response {
	return new Response(RATE_LIMIT_BODY, { status: 429, headers: { "content-type": "application/json" } });
}

function completedSse(text: string): Response {
	const frames = [
		{ id: "chatcmpl_1", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
		{
			id: "chatcmpl_1",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
		},
	].map(event => `data: ${JSON.stringify(event)}`);
	frames.push("data: [DONE]");
	return new Response(`${frames.join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function drain(stream: AssistantMessageEventStream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("provider attempt budget", () => {
	it("issues exactly one request when the allowance is one", async () => {
		let requests = 0;
		const fetchImpl: FetchImpl = async () => {
			requests++;
			return rateLimited();
		};

		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: fetchImpl,
			providerMaxAttempts: 1,
		});
		const events = await drain(stream);
		const result = await stream.result();

		expect(requests).toBe(1);
		expect(events.at(-1)?.type).toBe("error");
		expect(result.stopReason).toBe("error");
	});

	it("honors the allowance across the transport and replay layers", async () => {
		let requests = 0;
		const fetchImpl: FetchImpl = async () => {
			requests++;
			return rateLimited();
		};

		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: fetchImpl,
			// 3 attempts → 2 transport retries, never 3 + a replay retry.
			providerMaxAttempts: 3,
			providerBaseDelayMs: 1,
		});
		await drain(stream);

		expect(requests).toBe(3);
	});

	it("applies the configured base delay to 429 backoff with no Retry-After hint", async () => {
		let requests = 0;
		const fetchImpl: FetchImpl = async () => {
			requests++;
			return rateLimited();
		};

		const started = Date.now();
		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: fetchImpl,
			providerMaxAttempts: 3,
			// Two backoff sleeps: 20ms then 40ms.
			providerBaseDelayMs: 20,
		});
		await drain(stream);
		const elapsedMs = Date.now() - started;

		expect(requests).toBe(3);
		expect(elapsedMs).toBeGreaterThanOrEqual(55);
		// Well under the transport's 500ms default base delay, so a regression to
		// the hardcoded schedule would trip this upper bound.
		expect(elapsedMs).toBeLessThan(400);
	});

	it("keeps the provider default allowance when the caller sets none", async () => {
		let requests = 0;
		const fetchImpl: FetchImpl = async () => {
			requests++;
			if (requests < 3) return rateLimited();
			return completedSse("recovered");
		};

		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: fetchImpl,
			providerBaseDelayMs: 1,
		});
		const result = await stream.result();

		expect(requests).toBe(3);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("delivers a successful first attempt without retrying", async () => {
		let requests = 0;
		const fetchImpl: FetchImpl = async () => {
			requests++;
			return completedSse("hello");
		};

		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: fetchImpl,
			providerMaxAttempts: 5,
		});
		const result = await stream.result();

		expect(requests).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});
});
