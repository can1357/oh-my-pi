import { describe, expect, it } from "bun:test";
import * as AIError from "@pk-nerdsaver-ai/pi-ai/error";
import { AnthropicMessagesClient } from "@pk-nerdsaver-ai/pi-ai/providers/anthropic-client";
import type { MessageCreateParamsStreaming } from "@pk-nerdsaver-ai/pi-ai/providers/anthropic-wire";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";

const params: MessageCreateParamsStreaming = {
	model: "claude-sonnet-4-5",
	messages: [{ role: "user", content: "hi" }],
	max_tokens: 64,
	stream: true,
};

type FetchCall = { url: string; init: RequestInit };

function createFetchMock(responses: Array<Response | Error>): { calls: FetchCall[]; fetch: FetchImpl } {
	const calls: FetchCall[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		const next = responses[Math.min(calls.length - 1, responses.length - 1)];
		if (next instanceof Error) throw next;
		return next.clone();
	}) as typeof fetch;
	return { calls, fetch: fetchImpl };
}

const anthropicErrorBody = JSON.stringify({
	type: "error",
	error: { type: "invalid_request_error", message: "The compiled grammar is too large." },
});

describe("AnthropicMessagesClient error mapping", () => {
	it("maps non-2xx responses to AnthropicApiError with status and body in message", async () => {
		const { calls, fetch } = createFetchMock([
			new Response(anthropicErrorBody, { status: 400, headers: { "request-id": "req_err" } }),
		]);
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", baseURL: "https://api.anthropic.com", fetch });

		const error = await client.messages
			.create(params)
			.asResponse()
			.then(
				() => undefined,
				err => err,
			);

		expect(error).toBeInstanceOf(AIError.AnthropicApiError);
		const apiError = error as AIError.AnthropicApiError;
		// Downstream classification reads `.status` (extractHttpStatusFromError) and
		// regex-matches the message body (isAnthropicStrictGrammarTooLargeError).
		expect(apiError.status).toBe(400);
		expect(apiError.message).toStartWith("400 ");
		expect(apiError.message).toContain("invalid_request_error");
		expect(apiError.message).toContain("compiled grammar is too large");
		expect(apiError.requestId).toBe("req_err");
		// 400 is not retryable: exactly one attempt.
		expect(calls.length).toBe(1);
	});

	it("does not invent a body when the error response is empty", async () => {
		const { fetch } = createFetchMock([new Response(null, { status: 500 })]);
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 0, fetch });

		const error = await client.messages
			.create(params)
			.asResponse()
			.catch(err => err);

		expect(error).toBeInstanceOf(AIError.AnthropicApiError);
		expect((error as AIError.AnthropicApiError).message).toBe("500 status code (no body)");
	});

	it("does not let fetchOptions override core request fields", async () => {
		const { calls, fetch } = createFetchMock([new Response(null, { status: 200 })]);
		const preAborted = AbortSignal.abort();
		const client = new AnthropicMessagesClient({
			apiKey: "sk-test",
			maxRetries: 0,
			fetch,
			fetchOptions: { method: "GET", signal: preAborted },
		});

		const response = await client.messages.create(params).asResponse();

		// fetchOptions exists for transport extras (tls); a caller-supplied signal
		// or method must not disconnect the timeout controller or break the POST.
		expect(response.status).toBe(200);
		expect(calls[0]?.init.method).toBe("POST");
		expect(calls[0]?.init.signal?.aborted).toBe(false);
	});
});

describe("AnthropicMessagesClient retries", () => {
	it("retries 429 honoring retry-after-ms and succeeds", async () => {
		const { calls, fetch } = createFetchMock([
			new Response("overloaded", { status: 429, headers: { "retry-after-ms": "1" } }),
			new Response("{}", { status: 200 }),
		]);
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 2, fetch });

		const response = await client.messages.create(params).asResponse();

		expect(response.status).toBe(200);
		expect(calls.length).toBe(2);
	});

	it("obeys x-should-retry: false over a retryable status", async () => {
		const { calls, fetch } = createFetchMock([
			new Response("stop", { status: 503, headers: { "x-should-retry": "false" } }),
		]);
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 3, fetch });

		const error = await client.messages
			.create(params)
			.asResponse()
			.catch(err => err);

		expect(error).toBeInstanceOf(AIError.AnthropicApiError);
		expect((error as AIError.AnthropicApiError).status).toBe(503);
		expect(calls.length).toBe(1);
	});

	it("surfaces the final error after exhausting the retry budget", async () => {
		const { calls, fetch } = createFetchMock([
			new Response("err", { status: 500, headers: { "retry-after-ms": "1" } }),
		]);
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 2, fetch });

		const error = await client.messages
			.create(params)
			.asResponse()
			.catch(err => err);

		expect(error).toBeInstanceOf(AIError.AnthropicApiError);
		expect(calls.length).toBe(3); // initial attempt + 2 retries
	});
});

describe("AnthropicMessagesClient timeout and abort", () => {
	it("throws AnthropicConnectionTimeoutError when no response arrives in time", async () => {
		const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")), { once: true });
			return promise;
		}) as typeof fetch;
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", fetch: hangingFetch });

		const error = await client.messages
			.create(params, { timeout: 5, maxRetries: 0 })
			.asResponse()
			.catch(err => err);

		expect(error).toBeInstanceOf(AIError.AnthropicConnectionTimeoutError);
		// isRetryableError() keys off "timed out"/"timeout" phrasing.
		expect((error as Error).message).toMatch(/timed out/i);
	});

	it("maps caller aborts to 'Request was aborted.' without retrying", async () => {
		const controller = new AbortController();
		const { calls, fetch } = createFetchMock([new Error("network down")]);
		const abortingFetch = ((input: string | URL | Request, init?: RequestInit) => {
			controller.abort();
			return fetch(input, init);
		}) as typeof fetch;
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 5, fetch: abortingFetch });

		const error = await client.messages
			.create(params, { signal: controller.signal })
			.asResponse()
			.catch(err => err);

		expect((error as Error).message).toBe("Request was aborted.");
		expect(calls.length).toBe(1);
	});
});

describe("AnthropicMessagesClient request assembly", () => {
	it("sends auth, body, and beta URL according to client options", async () => {
		const { calls, fetch } = createFetchMock([new Response("{}", { status: 200 })]);
		const client = new AnthropicMessagesClient({
			authToken: "oauth-token",
			baseURL: "https://api.anthropic.com",
			defaultHeaders: { "Anthropic-Version": "2023-06-01" },
			fetch,
		});

		await client.beta.messages.create(params).asResponse();

		expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages?beta=true");
		expect(calls[0].init.method).toBe("POST");
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer oauth-token");
		expect(headers["Anthropic-Version"]).toBe("2023-06-01");
		expect(JSON.parse(String(calls[0].init.body))).toEqual(params);
	});

	it("never overrides auth headers already present in defaultHeaders", async () => {
		const { calls, fetch } = createFetchMock([new Response("{}", { status: 200 })]);
		const client = new AnthropicMessagesClient({
			apiKey: "sk-wrong",
			authToken: "wrong-token",
			defaultHeaders: { "X-Api-Key": "sk-right", authorization: "Bearer right-token" },
			fetch,
		});

		await client.messages.create(params).asResponse();

		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers["X-Api-Key"]).toBe("sk-right");
		expect(headers.authorization).toBe("Bearer right-token");
		expect(headers.Authorization).toBeUndefined();
		expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
	});
});
