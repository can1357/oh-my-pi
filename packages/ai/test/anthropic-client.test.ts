import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AnthropicMessagesClient } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { MessageCreateParamsStreaming } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

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
const anthropicOverloadedErrorBody = JSON.stringify({
	type: "error",
	error: { type: "overloaded_error", message: "Overloaded" },
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

	it("disables the cap when maxRetryDelayMs is negative", async () => {
		const { calls, fetch } = createFetchMock([
			new Response("overloaded", { status: 429, headers: { "retry-after-ms": "1" } }),
			new Response("{}", { status: 200 }),
		]);
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 5, fetch });

		const response = await client.messages.create(params, { maxRetryDelayMs: -1 }).asResponse();

		expect(response.status).toBe(200);
		expect(calls.length).toBe(2);
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

describe("AnthropicMessagesClient retry-after cap", () => {
	it("uses the documented 60-second default cap when callers omit one", async () => {
		const { calls, fetch } = createFetchMock([
			new Response(anthropicOverloadedErrorBody, { status: 429, headers: { "retry-after": "120" } }),
		]);
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 5, fetch });

		const error = await client.messages
			.create(params)
			.asResponse()
			.catch(err => err as AIError.AnthropicApiError);

		expect(error).toBeInstanceOf(AIError.AnthropicApiError);
		expect(error.status).toBe(429);
		expect(calls.length).toBe(1);
	});

	it("declines a retry and preserves original status/body/headers when retry-after exceeds maxRetryDelayMs", async () => {
		const errorHeaders = { "retry-after": "120", "request-id": "req_cap" };
		const { calls, fetch } = createFetchMock([
			new Response(anthropicOverloadedErrorBody, { status: 429, headers: errorHeaders }),
		]);
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 5, fetch });

		const error = await client.messages
			.create(params, { maxRetryDelayMs: 60_000 })
			.asResponse()
			.catch(err => err as AIError.AnthropicApiError);
		if (!(error instanceof AIError.AnthropicApiError)) throw new Error("Expected AnthropicApiError");

		expect(error).toBeInstanceOf(AIError.AnthropicApiError);
		expect(error.status).toBe(429);
		expect(error.message).toContain("overloaded");
		expect(error.headers.get("request-id")).toBe("req_cap");
		expect(calls.length).toBe(1);
	});

	it("cancels and releases an open error-body reader when the caller aborts", async () => {
		const controller = new AbortController();
		const encoder = new TextEncoder();
		let readBlocked = false;
		let bodyCancelled = false;
		let response: Response | undefined;
		const openBody = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(encoder.encode("overloaded"));
			},
			pull() {
				readBlocked = true;
				return Promise.withResolvers<void>().promise;
			},
			cancel() {
				bodyCancelled = true;
			},
		});
		const fetch: FetchImpl = async () => {
			response = new Response(openBody, {
				status: 429,
				headers: { "retry-after": "120", "request-id": "req_abort" },
			});
			return response;
		};
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 5, fetch });

		const pending = client.messages
			.create(params, { signal: controller.signal, maxRetryDelayMs: 60_000 })
			.asResponse();
		for (let i = 0; i < 1000 && !readBlocked; i++) await Promise.resolve();
		if (!readBlocked) throw new Error("Anthropic error-body read did not block");

		controller.abort();
		const error = await pending.catch(err => err as Error);
		if (!(error instanceof Error)) throw new Error("Expected request abort error");
		for (let i = 0; i < 1000 && !bodyCancelled; i++) await Promise.resolve();
		if (!bodyCancelled) throw new Error("Anthropic error-body reader was not cancelled");

		expect(error).toBeInstanceOf(AIError.AbortError);
		expect(error.message).toBe("Request was aborted.");
		expect(response?.body?.locked).toBe(false);
	});

	it("bounds a never-ending error body without a caller signal", async () => {
		const encoder = new TextEncoder();
		let readBlocked = false;
		let bodyCancelled = false;
		let response: Response | undefined;
		const openBody = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(encoder.encode("overloaded"));
			},
			pull() {
				readBlocked = true;
				return new Promise<void>(() => {});
			},
			cancel() {
				bodyCancelled = true;
			},
		});
		const fetch: FetchImpl = async () => {
			response = new Response(openBody, {
				status: 529,
				headers: { "retry-after": "120", "request-id": "req_body_timeout" },
			});
			return response;
		};
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 5, fetch });

		AIError.__anthropicApiErrorForTesting.setBodyReadTimeoutMs(5);
		try {
			const error = await client.messages
				.create(params, { maxRetryDelayMs: 60_000 })
				.asResponse()
				.catch(err => err as AIError.AnthropicApiError);
			if (!(error instanceof AIError.AnthropicApiError)) throw new Error("Expected AnthropicApiError");

			expect(readBlocked).toBe(true);
			expect(error.status).toBe(529);
			expect(error.message).toBe("529 overloaded");
			expect(error.headers.get("request-id")).toBe("req_body_timeout");
			expect(bodyCancelled).toBe(true);
			expect(response?.body?.locked).toBe(false);
		} finally {
			AIError.__anthropicApiErrorForTesting.setBodyReadTimeoutMs(undefined);
		}
	});

	it("preserves bounded partial error details when the body stream errors", async () => {
		const encoder = new TextEncoder();
		let response: Response | undefined;
		const partialBody = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(encoder.encode("partial detail"));
			},
			pull(streamController) {
				streamController.error(new Error("socket closed"));
			},
		});
		const client = new AnthropicMessagesClient({
			apiKey: "sk-test",
			maxRetries: 0,
			fetch: async () => {
				response = new Response(partialBody, { status: 502, headers: { "request-id": "req_partial" } });
				return response;
			},
		});

		const error = await client.messages
			.create(params)
			.asResponse()
			.catch(err => err as AIError.AnthropicApiError);
		if (!(error instanceof AIError.AnthropicApiError)) throw new Error("Expected AnthropicApiError");

		expect(error.status).toBe(502);
		expect(error.message).toBe("502 partial detail");
		expect(error.headers.get("request-id")).toBe("req_partial");
		expect(response?.body?.locked).toBe(false);
	});

	it("flushes an incomplete UTF-8 prefix at clean error-body EOF", async () => {
		let response: Response | undefined;
		const incompleteBody = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(new Uint8Array([0xe2, 0x82]));
				streamController.close();
			},
		});
		const client = new AnthropicMessagesClient({
			apiKey: "sk-test",
			maxRetries: 0,
			fetch: async () => {
				response = new Response(incompleteBody, { status: 500 });
				return response;
			},
		});

		const error = await client.messages
			.create(params)
			.asResponse()
			.catch(err => err as AIError.AnthropicApiError);
		if (!(error instanceof AIError.AnthropicApiError)) throw new Error("Expected AnthropicApiError");

		expect(error.message).toBe("500 \uFFFD");
		expect(response?.body?.locked).toBe(false);
	});

	it("keeps complete error text without flushing an incomplete UTF-8 prefix after a read rejection", async () => {
		const completeText = new TextEncoder().encode("complete text");
		const completeTextWithIncompletePrefix = new Uint8Array(completeText.byteLength + 2);
		completeTextWithIncompletePrefix.set(completeText);
		completeTextWithIncompletePrefix.set([0xe2, 0x82], completeText.byteLength);
		let response: Response | undefined;
		let pullErrored = false;
		const rejectedBody = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(completeTextWithIncompletePrefix);
			},
			pull(streamController) {
				pullErrored = true;
				streamController.error(new Error("socket closed"));
			},
		});
		const client = new AnthropicMessagesClient({
			apiKey: "sk-test",
			maxRetries: 0,
			fetch: async () => {
				response = new Response(rejectedBody, { status: 502 });
				return response;
			},
		});

		const error = await client.messages
			.create(params)
			.asResponse()
			.catch(err => err as AIError.AnthropicApiError);
		if (!(error instanceof AIError.AnthropicApiError)) throw new Error("Expected AnthropicApiError");

		expect(error.message).toBe("502 complete text");
		expect(error.message).not.toContain("\uFFFD");
		expect(response?.body?.locked).toBe(false);
		expect(pullErrored).toBe(true);
	});

	it("does not flush an incomplete UTF-8 prefix when the error body times out", async () => {
		const readBlocked = Promise.withResolvers<void>();
		let didBlockRead = false;
		let bodyCancelled = false;
		const incompleteBody = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(new Uint8Array([0xe2, 0x82]));
			},
			pull() {
				didBlockRead = true;
				return readBlocked.promise;
			},
			cancel() {
				bodyCancelled = true;
			},
		});
		const client = new AnthropicMessagesClient({
			apiKey: "sk-test",
			maxRetries: 0,
			fetch: async () => new Response(incompleteBody, { status: 500 }),
		});

		AIError.__anthropicApiErrorForTesting.setBodyReadTimeoutMs(5);
		try {
			const error = await client.messages
				.create(params)
				.asResponse()
				.catch(err => err as AIError.AnthropicApiError);
			if (!(error instanceof AIError.AnthropicApiError)) throw new Error("Expected AnthropicApiError");

			expect(error.message).toBe("500 status code (no body)");
			expect(error.message).not.toContain("\uFFFD");
			expect(didBlockRead).toBe(true);
			expect(bodyCancelled).toBe(true);
		} finally {
			AIError.__anthropicApiErrorForTesting.setBodyReadTimeoutMs(undefined);
		}
	});

	it("bounds, marks, and cancels a continuously ready oversized error body", async () => {
		const chunk = new TextEncoder().encode("x".repeat(1024));
		let bodyCancelled = false;
		let response: Response | undefined;
		const oversizedBody = new ReadableStream<Uint8Array>({
			pull(streamController) {
				streamController.enqueue(chunk);
			},
			cancel() {
				bodyCancelled = true;
			},
		});
		const fetch: FetchImpl = async () => {
			response = new Response(oversizedBody, { status: 400 });
			return response;
		};
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 0, fetch });

		const startedAt = performance.now();
		const error = await client.messages
			.create(params)
			.asResponse()
			.catch(err => err as AIError.AnthropicApiError);
		if (!(error instanceof AIError.AnthropicApiError)) throw new Error("Expected AnthropicApiError");
		for (let i = 0; i < 1000 && !bodyCancelled; i++) await Promise.resolve();
		if (!bodyCancelled) throw new Error("Anthropic error-body reader was not cancelled");

		expect(performance.now() - startedAt).toBeLessThan(1_000);
		expect(error.message).toBe(`400 ${"x".repeat(64 * 1024)}\n[Response body truncated after 64 KiB]`);
		expect(response?.body?.locked).toBe(false);
	});

	it("preserves an exact 64 KiB error body without marking or cancelling it", async () => {
		const body = new Uint8Array(64 * 1024).fill(120);
		let bodyCancelled = false;
		const exactBody = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(body);
				streamController.close();
			},
			cancel() {
				bodyCancelled = true;
			},
		});
		const client = new AnthropicMessagesClient({
			apiKey: "sk-test",
			maxRetries: 0,
			fetch: async () => new Response(exactBody, { status: 400 }),
		});

		const error = await client.messages
			.create(params)
			.asResponse()
			.catch(err => err as AIError.AnthropicApiError);
		if (!(error instanceof AIError.AnthropicApiError)) throw new Error("Expected AnthropicApiError");

		expect(error.message).toBe(`400 ${"x".repeat(64 * 1024)}`);
		expect(bodyCancelled).toBe(false);
	});

	it("marks and cancels only after observing the 64 KiB-plus-one error-body byte", async () => {
		const firstChunk = new Uint8Array(64 * 1024).fill(120);
		const overflowByte = new Uint8Array([120]);
		let bodyCancelled = false;
		const overflowingBody = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(firstChunk);
				streamController.enqueue(overflowByte);
			},
			cancel() {
				bodyCancelled = true;
			},
		});
		const client = new AnthropicMessagesClient({
			apiKey: "sk-test",
			maxRetries: 0,
			fetch: async () => new Response(overflowingBody, { status: 400 }),
		});

		const error = await client.messages
			.create(params)
			.asResponse()
			.catch(err => err as AIError.AnthropicApiError);
		if (!(error instanceof AIError.AnthropicApiError)) throw new Error("Expected AnthropicApiError");

		expect(error.message).toBe(`400 ${"x".repeat(64 * 1024)}\n[Response body truncated after 64 KiB]`);
		expect(bodyCancelled).toBe(true);
	});

	it("does not append a replacement character for UTF-8 split by the truncation boundary", async () => {
		const body = new Uint8Array(64 * 1024 + 2).fill(120);
		body.set([0xe2, 0x82, 0xac], 64 * 1024 - 1);
		const client = new AnthropicMessagesClient({
			apiKey: "sk-test",
			maxRetries: 0,
			fetch: async () => new Response(body, { status: 400 }),
		});

		const error = await client.messages
			.create(params)
			.asResponse()
			.catch(err => err as AIError.AnthropicApiError);
		if (!(error instanceof AIError.AnthropicApiError)) throw new Error("Expected AnthropicApiError");

		expect(error.message).toBe(`400 ${"x".repeat(64 * 1024 - 1)}\n[Response body truncated after 64 KiB]`);
		expect(error.message).not.toContain("\uFFFD");
	});

	it("bounds continuously-ready empty error-body chunks without accumulating read reactions", async () => {
		let pulls = 0;
		let bodyCancelled = false;
		const emptyBody = new ReadableStream<Uint8Array>({
			pull(streamController) {
				pulls += 1;
				streamController.enqueue(new Uint8Array());
			},
			cancel() {
				bodyCancelled = true;
			},
		});
		const client = new AnthropicMessagesClient({
			apiKey: "sk-test",
			maxRetries: 0,
			fetch: async () => new Response(emptyBody, { status: 500 }),
		});

		AIError.__anthropicApiErrorForTesting.setBodyReadTimeoutMs(5);
		try {
			const startedAt = performance.now();
			const error = await client.messages
				.create(params)
				.asResponse()
				.catch(err => err as AIError.AnthropicApiError);
			if (!(error instanceof AIError.AnthropicApiError)) throw new Error("Expected AnthropicApiError");

			expect(performance.now() - startedAt).toBeLessThan(1_000);
			expect(pulls).toBeGreaterThan(0);
			expect(pulls).toBeLessThan(100_000);
			expect(bodyCancelled).toBe(true);
			expect(error.message).toBe("500 status code (no body)");
		} finally {
			AIError.__anthropicApiErrorForTesting.setBodyReadTimeoutMs(undefined);
		}
	});

	it("checks the deadline before an always-ready error body can starve timer callbacks", async () => {
		let bodyCancelled = false;
		let response: Response | undefined;
		const alwaysReadyBody = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(new Uint8Array([120]));
			},
			pull(streamController) {
				streamController.enqueue(new Uint8Array([120]));
			},
			cancel() {
				bodyCancelled = true;
			},
		});
		const fetch: FetchImpl = async () => {
			response = new Response(alwaysReadyBody, { status: 500 });
			return response;
		};
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 0, fetch });

		AIError.__anthropicApiErrorForTesting.setBodyReadTimeoutMs(0);
		try {
			const startedAt = performance.now();
			const error = await client.messages
				.create(params)
				.asResponse()
				.catch(err => err as AIError.AnthropicApiError);
			if (!(error instanceof AIError.AnthropicApiError)) throw new Error("Expected AnthropicApiError");
			for (let i = 0; i < 1000 && !bodyCancelled; i++) await Promise.resolve();
			if (!bodyCancelled) throw new Error("Anthropic error-body reader was not cancelled");

			expect(performance.now() - startedAt).toBeLessThan(1_000);
			expect(error.message).toBe("500 status code (no body)");
			expect(response?.body?.locked).toBe(false);
		} finally {
			AIError.__anthropicApiErrorForTesting.setBodyReadTimeoutMs(undefined);
		}
	});
});
