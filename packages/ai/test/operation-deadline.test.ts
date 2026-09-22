/**
 * Contracts for the aggregate provider-operation budget: it spans every nested
 * retry of one logical request, is spent before a retry sleeps rather than
 * after, and never outranks the caller's own abort.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AnthropicMessagesClientLike } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { withReplaySafeStreamRetry } from "@oh-my-pi/pi-ai/utils/empty-completion-retry";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	type OperationDeadlineOptions,
	operationDeadlineExceeded,
	withOperationDeadline,
} from "@oh-my-pi/pi-ai/utils/operation-deadline";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};

type MockAnthropicEvent = Record<string, unknown>;

function successEvents(text: string): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_deadline",
				usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
}

function createSuccessRequest(text: string): unknown {
	const events = successEvents(text);
	return {
		async withResponse() {
			return {
				data: (async function* () {
					for (const event of events) yield event;
				})(),
				response: new Response(null, { status: 200 }),
				request_id: "req_deadline",
			};
		},
	};
}

function createRejectedRequest(error: unknown): unknown {
	return {
		withResponse() {
			return Promise.reject(error);
		},
	};
}

/** A 529 carrying a 30s `retry-after` — a wait no exhausted budget can afford. */
function overloadedError(): AIError.AnthropicApiError {
	return new AIError.AnthropicApiError(
		529,
		'529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
		new Headers({ "retry-after": "30" }),
	);
}

const CTX = {} as Context;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function emptyAttempt(): AssistantMessageEventStream {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		timestamp: 1,
		stopReason: "stop",
		usage: usage(),
	};
	const stream = new AssistantMessageEventStream();
	for (const event of [
		{ type: "start", partial: message },
		{ type: "done", reason: "stop", message },
	] as unknown as AssistantMessageEvent[]) {
		stream.push(event);
	}
	return stream;
}

describe("withOperationDeadline", () => {
	it("stamps an absolute deadline once and leaves a disabled budget alone", () => {
		const budget: OperationDeadlineOptions = { operationTimeoutMs: 60_000 };
		const stamped = withOperationDeadline(budget);
		expect(stamped.operationDeadlineAt).toBeGreaterThan(Date.now());

		// Re-entrant dispatch must not restart the clock.
		expect(withOperationDeadline(stamped).operationDeadlineAt).toBe(stamped.operationDeadlineAt);
		// Explicit zero and omission are both "no budget".
		const disabled: OperationDeadlineOptions = { operationTimeoutMs: 0 };
		const unset: OperationDeadlineOptions = {};
		expect(withOperationDeadline(disabled).operationDeadlineAt).toBeUndefined();
		expect(withOperationDeadline(unset).operationDeadlineAt).toBeUndefined();
	});

	it("refuses only the retries whose sleep would land past the deadline", () => {
		const options = { operationTimeoutMs: 60_000, operationDeadlineAt: Date.now() + 10_000 };
		expect(operationDeadlineExceeded(options, 1_000)).toBeUndefined();

		const error = operationDeadlineExceeded(options, 30_000);
		expect(error?.name).toBe("ProviderOperationDeadlineError");
		expect(error?.budgetMs).toBe(60_000);
		expect(error?.declinedDelayMs).toBe(30_000);
		// Elapsed is measured from the stamp, not from the refused wait.
		expect(error?.elapsedMs).toBeGreaterThanOrEqual(49_000);
		expect(AIError.retriable(AIError.classify(error))).toBe(true);
		expect(AIError.is(AIError.classify(error), AIError.Flag.Timeout)).toBe(true);
		expect(operationDeadlineExceeded({ operationTimeoutMs: 60_000 }, 30_000)).toBeUndefined();
	});
});

describe("provider operation deadline", () => {
	it("takes a retry that still fits the budget, at its full server-directed delay", async () => {
		let attempt = 0;
		const create = (() => {
			attempt += 1;
			return attempt === 1 ? createRejectedRequest(overloadedError()) : createSuccessRequest("recovered");
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } } as AnthropicMessagesClientLike,
			providerRetryWait,
			// 600s of budget comfortably covers the 30s `retry-after`.
			operationTimeoutMs: 600_000,
			operationDeadlineAt: Date.now() + 600_000,
		}).result();

		expect(attempt).toBe(2);
		// The budget must not shorten or skip a retry it can afford.
		expect(providerRetryWait).toHaveBeenCalledWith(30_000, undefined);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("fails fast instead of sleeping a retry past the deadline", async () => {
		let attempt = 0;
		const create = (() => {
			attempt += 1;
			return createRejectedRequest(overloadedError());
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } } as AnthropicMessagesClientLike,
			providerRetryWait,
			// 30s of server-directed backoff cannot fit in 100ms of remaining budget.
			operationTimeoutMs: 900_000,
			operationDeadlineAt: Date.now() + 100,
		}).result();

		expect(attempt).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		// Exact accounting: 900s budget with 100ms left means ~900s already spent,
		// and the refused wait is the server's 30s hint, not the local backoff.
		expect(result.errorMessage).toBe(
			"Provider operation budget exhausted after 900s of a 900s budget; declined a 30000ms retry wait.",
		);
		expect(AIError.isProviderOperationDeadlineText(result.errorMessage)).toBe(true);
		expect(AIError.retriable(result.errorId)).toBe(true);
	});

	it("lets a caller abort win over an exhausted budget", async () => {
		const controller = new AbortController();
		let attempt = 0;
		const create = (() => {
			attempt += 1;
			controller.abort();
			return createRejectedRequest(overloadedError());
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } } as AnthropicMessagesClientLike,
			signal: controller.signal,
			providerRetryWait,
			operationTimeoutMs: 900_000,
			operationDeadlineAt: Date.now() - 1,
		}).result();

		expect(attempt).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("aborted");
		expect(AIError.isProviderOperationDeadlineText(result.errorMessage)).toBe(false);
	});

	it("refuses a replay-safe empty-completion retry once the budget is spent", async () => {
		let attempts = 0;
		const providerRetryWait = vi.fn(async () => {});
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{
				providerRetryWait,
				operationTimeoutMs: 30_000,
				operationDeadlineAt: Date.now() - 1,
			},
			() => {
				attempts++;
				return emptyAttempt();
			},
			{ retryEmptyCompletion: true },
		);

		await expect(stream.result()).rejects.toThrow("Provider operation budget exhausted");
		expect(attempts).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
	});

	it("keeps an aborted empty-completion retry aborted rather than deadline-exceeded", async () => {
		const controller = new AbortController();
		controller.abort();
		let attempts = 0;
		const providerRetryWait = vi.fn(async () => {});
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{
				signal: controller.signal,
				providerRetryWait,
				operationTimeoutMs: 30_000,
				operationDeadlineAt: Date.now() - 1,
			},
			() => {
				attempts++;
				return emptyAttempt();
			},
			{ retryEmptyCompletion: true },
		);

		const result = await stream.result();
		expect(attempts).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("stop");
	});
});

describe("operation deadline across provider families", () => {
	afterEach(() => {
		clearCustomApis();
	});

	it("refuses the Codex transient-stream retry once the budget is spent", async () => {
		const codexModel: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		});
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const errorSse = `data: ${JSON.stringify({ type: "error", code: "model_error", message: "An error occurred while processing your request. You can retry your request." })}\n\n`;
		let requests = 0;
		const fetchMock = vi.fn(async () => {
			requests += 1;
			return new Response(errorSse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		const result = await streamOpenAICodexResponses(codexModel, context, {
			apiKey: `aaa.${payload}.bbb`,
			fetch: fetchMock as unknown as FetchImpl,
			operationTimeoutMs: 900_000,
			operationDeadlineAt: Date.now() - 1,
		}).result();

		// Without the budget this transient `model_error` is retried (see
		// openai-codex-stream.test.ts); the spent budget must refuse it outright.
		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(AIError.isProviderOperationDeadlineText(result.errorMessage)).toBe(true);
	});

	it("refuses the Google empty-stream retry once the budget is spent", async () => {
		const googleModel: Model<"google-generative-ai"> = buildModel({
			id: "gemini-3-pro",
			name: "Gemini 3 Pro",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		});
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return new Response(
				`data: ${JSON.stringify({
					candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 },
				})}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		};

		const result = await streamGoogle(googleModel, context, {
			apiKey: "k",
			fetch: fetchMock,
			operationTimeoutMs: 900_000,
			operationDeadlineAt: Date.now() - 1,
		}).result();

		// Unbudgeted this retries twice more before reporting "empty response".
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(AIError.isProviderOperationDeadlineText(result.errorMessage)).toBe(true);
	});

	it("stamps the deadline on a streamSimple branch that never reaches the dispatcher", async () => {
		const api = "test-operation-deadline-api";
		const customModel = {
			api,
			provider: "test",
			id: "test-model",
			name: "Test model",
			baseUrl: "test://",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000,
			maxTokens: 100,
		} as unknown as Model<Api>;
		let seen: SimpleStreamOptions | undefined;
		registerCustomApi(api, (_model, _context, options) => {
			seen = options;
			const inner = new AssistantMessageEventStream();
			inner.end({
				role: "assistant",
				content: [],
				api,
				provider: "test",
				model: "test-model",
				timestamp: 1,
				stopReason: "stop",
				usage: usage(),
			});
			return inner;
		});

		const before = Date.now();
		await streamSimple(customModel, context, { apiKey: "k", operationTimeoutMs: 60_000 }).result();

		// The custom-API branch returns before `streamDispatch`, so the stamp has
		// to come from the `streamSimple` entry or it never happens at all.
		expect(seen?.operationTimeoutMs).toBe(60_000);
		expect(seen?.operationDeadlineAt).toBeGreaterThanOrEqual(before + 60_000);
	});
});
