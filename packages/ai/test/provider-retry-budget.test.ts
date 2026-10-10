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
import { streamSimple } from "@oh-my-pi/pi-ai";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type {
	AssistantMessageEventStream,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	TJsonSchema,
	Tool,
} from "@oh-my-pi/pi-ai/types";
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

const anthropicModel: Model<"anthropic-messages"> = buildModel({
	...modelDefaults,
	id: "claude-test",
	name: "Claude test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.test/v1",
});

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

	it("honors the allowance when the call arrives through streamSimple", async () => {
		let requests = 0;
		const fetchImpl: FetchImpl = async () => {
			requests++;
			return rateLimited();
		};

		// `streamSimple` maps `SimpleStreamOptions` onto api-specific options, so a
		// field missing from that mapping silently disarms the whole allowance.
		const stream = await streamSimple(model, context, {
			apiKey: "test-key",
			fetch: fetchImpl,
			providerMaxAttempts: 1,
			providerBaseDelayMs: 0,
		});
		const result = await stream.result();

		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("retries a hinted 429 when retry.maxDelayMs disables the delay cap", async () => {
		let requests = 0;
		const fetchImpl: FetchImpl = async () => {
			requests++;
			if (requests < 3) {
				return new Response(RATE_LIMIT_BODY, {
					status: 429,
					headers: { "content-type": "application/json", "retry-after-ms": "5" },
				});
			}
			return completedSse("recovered");
		};

		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: fetchImpl,
			providerMaxAttempts: 3,
			// `0` disables the ceiling (settings.md): a hinted wait must still be
			// honored instead of the retry being declined outright.
			maxRetryDelayMs: 0,
		});
		const result = await stream.result();

		expect(requests).toBe(3);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("does not send a second request when a strict-tools fallback re-enters with the allowance spent", async () => {
		let requests = 0;
		const fetchImpl: FetchImpl = async () => {
			requests++;
			// A rejection `shouldRetryWithoutStrictTools` accepts: the completions
			// transport answers it by re-entering the stream without strict tools.
			return new Response(
				JSON.stringify({
					error: {
						message: "Invalid 'tools[0].function.strict': unsupported value",
						type: "invalid_request_error",
					},
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		};
		const tools: Tool[] = [
			{
				name: "get_weather",
				description: "Get the weather",
				strict: true,
				parameters: {
					type: "object",
					properties: { city: { type: "string" } },
					required: ["city"],
				} as TJsonSchema,
			},
		];

		const stream = streamOpenAICompletions(
			model,
			{ ...context, tools },
			{
				apiKey: "test-key",
				fetch: fetchImpl,
				providerMaxAttempts: 1,
			},
		);
		const result = await stream.result();

		// The strict-tools re-entry must not issue a second wire request.
		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		// The failure that consumed the allowance surfaces, not a budget error.
		expect(result.errorMessage ?? "").toMatch(/strict/);
		expect(result.errorMessage ?? "").not.toMatch(/attempt budget/i);
	});

	it("issues no further Anthropic request when fast-mode recovery re-enters with the allowance spent", async () => {
		let requests = 0;
		const fetchImpl: FetchImpl = async () => {
			requests++;
			// `isFastModeUnsupported`: the Anthropic loop answers it by dropping
			// fast mode and starting another wire attempt.
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "invalid_request_error", message: "The 'speed' parameter is not supported" },
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		};

		const stream = streamAnthropic(anthropicModel, context, {
			apiKey: "test-key",
			fetch: fetchImpl,
			serviceTier: "priority",
			providerMaxAttempts: 1,
			providerRetryWait: async () => {},
		});
		const result = await stream.result();

		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/speed/i);
		// The failure that consumed the allowance surfaces, not a budget error.
		expect(result.errorMessage ?? "").not.toMatch(/attempt budget/i);
	});

	it("issues no further Anthropic request once the shared allowance is spent", async () => {
		let requests = 0;
		const fetchImpl: FetchImpl = async () => {
			requests++;
			return new Response(JSON.stringify({ type: "error", error: { message: "boom" } }), {
				status: 500,
				headers: { "content-type": "application/json" },
			});
		};

		const stream = streamAnthropic(anthropicModel, context, {
			apiKey: "test-key",
			fetch: fetchImpl,
			providerMaxAttempts: 1,
			// The retry loop would sleep before the second attempt; there is none.
			providerRetryWait: async () => {},
		});
		const result = await stream.result();

		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		// The failure that consumed the allowance surfaces, not a budget error.
		expect(result.errorMessage ?? "").not.toMatch(/attempt budget/i);
	});

	it("bounds a hanging Anthropic request with retry.provider.timeoutMs", async () => {
		let requests = 0;
		let dispatched: () => void = () => {};
		const fetchStarted = new Promise<void>(resolve => {
			dispatched = resolve;
		});
		// Hangs until the client aborts: the pre-response watchdog is the only
		// thing that can end this request, and it must do so on its own.
		const hangingFetch: FetchImpl = (_url, init) => {
			requests++;
			dispatched();
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				});
			});
		};

		const stream = streamAnthropic(anthropicModel, context, {
			apiKey: "test-key",
			fetch: hangingFetch,
			providerMaxAttempts: 1,
			providerTimeoutMs: 40,
		});
		await fetchStarted;
		const result = await stream.result();

		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/timed out/i);
	});

	it("keeps the tighter first-event watchdog when it is smaller than the explicit timeout", async () => {
		let requests = 0;
		let dispatched: () => void = () => {};
		const fetchStarted = new Promise<void>(resolve => {
			dispatched = resolve;
		});
		const hangingFetch: FetchImpl = (_url, init) => {
			requests++;
			dispatched();
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				});
			});
		};

		// A cap never extends the session's own watchdog: 40ms wins over 30s.
		const stream = streamAnthropic(anthropicModel, context, {
			apiKey: "test-key",
			fetch: hangingFetch,
			providerMaxAttempts: 1,
			streamFirstEventTimeoutMs: 40,
			providerTimeoutMs: 30_000,
		});
		await fetchStarted;
		const result = await stream.result();

		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/timed out/i);
	});
});
