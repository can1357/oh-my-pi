import { describe, expect, it, vi } from "bun:test";
import { streamAzureOpenAIResponses } from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, TextContent } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { waitForDelayOrAbort } from "./helpers";

const openAIResponsesModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const openAICompletionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;
const azureOpenAIResponsesModel: Model<"azure-openai-responses"> = buildModel({
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
});
const ollamaChatModel: Model<"ollama-chat"> = buildModel({
	id: "llama-local",
	name: "llama-local",
	api: "ollama-chat",
	provider: "ollama",
	baseUrl: "http://127.0.0.1:11434",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function getRequestSignal(input: string | URL | Request, init: RequestInit | undefined): AbortSignal | undefined {
	if (init?.signal) {
		return init.signal;
	}
	if (input instanceof Request) {
		return input.signal;
	}
	return undefined;
}

function getRequestHeader(input: string | URL | Request, init: RequestInit | undefined, name: string): string | null {
	if (init?.headers) {
		return new Headers(init.headers).get(name);
	}
	if (input instanceof Request) {
		return input.headers.get(name);
	}
	return null;
}
function createHangingSseResponse(signal: AbortSignal | undefined, onCancel?: (reason: unknown) => void): Response {
	let abortListener: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			abortListener = () => {
				if (abortListener) {
					signal?.removeEventListener("abort", abortListener);
				}
				const reason = signal?.reason;
				if (reason instanceof Error) {
					controller.error(reason);
					return;
				}
				controller.error(new Error("request aborted"));
			};
			if (signal?.aborted) {
				queueMicrotask(() => abortListener?.());
				return;
			}
			signal?.addEventListener("abort", abortListener, { once: true });
		},
		cancel(reason) {
			onCancel?.(reason);
			if (abortListener) {
				signal?.removeEventListener("abort", abortListener);
			}
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createHangingFetch(): FetchImpl {
	async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		return createHangingSseResponse(getRequestSignal(input, init));
	}

	return mockFetch as typeof fetch;
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createNoProgressOpenAIResponsesStream(signal: AbortSignal | undefined): Response {
	const encoder = new TextEncoder();
	let interval: NodeJS.Timeout | undefined;
	let abortListener: (() => void) | undefined;
	const encode = (event: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encode({ type: "response.created", response: { id: "resp_stalled" } }));
			controller.enqueue(
				encode({
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_stalled",
						call_id: "call_stalled",
						name: "todo",
						arguments: "",
						status: "in_progress",
					},
				}),
			);
			interval = setInterval(() => {
				controller.enqueue(
					encode({
						type: "response.in_progress",
						response: { id: "resp_stalled", status: "in_progress" },
					}),
				);
			}, 2);
			abortListener = () => {
				if (interval) clearInterval(interval);
				if (abortListener) signal?.removeEventListener("abort", abortListener);
				const reason = signal?.reason;
				controller.error(reason instanceof Error ? reason : new Error("request aborted"));
			};
			if (signal?.aborted) {
				queueMicrotask(() => abortListener?.());
			} else {
				signal?.addEventListener("abort", abortListener, { once: true });
			}
		},
		cancel() {
			if (interval) clearInterval(interval);
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createDelayedFetch(
	delayMs: number,
	responseFactory: () => Response,
	onRequest?: (input: string | URL | Request, init: RequestInit | undefined) => void,
): FetchImpl {
	async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		onRequest?.(input, init);
		await waitForDelayOrAbort(delayMs, getRequestSignal(input, init));
		return responseFactory();
	}

	return mockFetch as typeof fetch;
}

function createOpenAIResponsesSuccessResponse(): Response {
	return createSseResponse([
		{ type: "response.created", response: { id: "resp_delayed" } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_delayed", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Hello delayed" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_delayed",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello delayed" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_delayed",
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 2,
					total_tokens: 7,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	]);
}

function createOpenAICompletionsSuccessResponse(modelId: string): Response {
	return createSseResponse([
		{
			id: "chatcmpl-delayed",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: { content: "Hello delayed" } }],
		},
		{
			id: "chatcmpl-delayed",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 5,
				completion_tokens: 2,
				total_tokens: 7,
				prompt_tokens_details: { cached_tokens: 0 },
			},
		},
		"[DONE]",
	]);
}

function createOllamaChatSuccessResponse(): Response {
	return new Response(
		`${JSON.stringify({ message: { content: "Hello delayed" }, done: false })}\n${JSON.stringify({
			done: true,
			done_reason: "stop",
			prompt_eval_count: 5,
			eval_count: 2,
		})}\n`,
		{ status: 200 },
	);
}

async function expectFirstEventTimeout(
	run: (
		streamFirstEventTimeoutMs: number,
		fetchMock: FetchImpl,
	) => Promise<{ stopReason: string; errorMessage?: string }>,
	expectedMessage: string,
): Promise<void> {
	const fetchMock = createHangingFetch();
	const result = await run(20, fetchMock);

	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBe(expectedMessage);
}

async function expectRequestSetupTimeout(
	run: (
		streamFirstEventTimeoutMs: number,
		fetchMock: FetchImpl,
	) => Promise<{ stopReason: string; errorMessage?: string }>,
	expectedMessage: string,
	responseFactory: () => Response,
): Promise<void> {
	const timeoutHeaders: string[] = [];
	const fetchMock = createDelayedFetch(30, responseFactory, (input, init) => {
		timeoutHeaders.push(getRequestHeader(input, init, "X-Stainless-Timeout") ?? "");
	});

	const result = await run(20, fetchMock);

	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBe(expectedMessage);
	expect(timeoutHeaders).toContain("0");
}

async function expectCallerAbort(
	run: (
		signal: AbortSignal,
		streamFirstEventTimeoutMs: number,
		fetchMock: FetchImpl,
	) => Promise<{ stopReason: string; errorMessage?: string }>,
	unexpectedMessage: string,
): Promise<void> {
	const fetchMock = createHangingFetch();
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 5);

	const result = await run(controller.signal, 50, fetchMock);

	expect(result.stopReason).toBe("aborted");
	expect(result.errorMessage).not.toBe(unexpectedMessage);
	expect((result.errorMessage ?? "").toLowerCase()).toContain("abort");
}

function getFirstTextContent(result: { content: unknown[] }): TextContent | undefined {
	return result.content.find((content): content is TextContent => {
		return typeof content === "object" && content !== null && "type" in content && content.type === "text";
	});
}

async function expectDelayedRequestSetupSucceeds(
	run: (
		streamFirstEventTimeoutMs: number,
		fetchMock: FetchImpl,
	) => Promise<{ stopReason: string; content: unknown[] }>,
	responseFactory: () => Response,
): Promise<void> {
	// The watchdog must cover request setup (connection + first byte). We simulate
	// a realistic ~30ms setup latency, but keep the budget far larger so the
	// scheduler jitter of a loaded CI box (where this stream races dozens of other
	// parallel test processes) can never trip the watchdog on a request that is
	// supposed to succeed. The complementary firing tests pin the budget < latency
	// case with their own short timeouts, so the contrast is preserved.
	const fetchMock = createDelayedFetch(30, responseFactory);
	const result = await run(5_000, fetchMock);

	expect(result.stopReason).toBe("stop");
	expect(getFirstTextContent(result)).toMatchObject({ type: "text", text: "Hello delayed" });
}

describe("OpenAI-family first-event timeouts", () => {
	it("surfaces the OpenAI responses first-event timeout message instead of a generic abort", async () => {
		await expectFirstEventTimeout(
			(streamFirstEventTimeoutMs, fetchMock) =>
				streamOpenAIResponses(openAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			"OpenAI responses stream timed out while waiting for the first event",
		);
	});
	it("times out OpenAI responses before the stream opens and forwards the budget to the SDK request", async () => {
		await expectRequestSetupTimeout(
			(streamFirstEventTimeoutMs, fetchMock) =>
				streamOpenAIResponses(openAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			"OpenAI responses stream timed out while waiting for the first event",
			createOpenAIResponsesSuccessResponse,
		);
	});

	it("lets PI_OPENAI_STREAM_IDLE_TIMEOUT_MS widen OpenAI responses first-event request setup", async () => {
		const previousOpenAIIdleTimeout = Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS;
		const previousGenericFirstEventTimeout = Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
		const timeoutHeaders: string[] = [];
		Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = "1500";
		Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "20";
		const fetchMock = createDelayedFetch(30, createOpenAIResponsesSuccessResponse, (input, init) => {
			timeoutHeaders.push(getRequestHeader(input, init, "X-Stainless-Timeout") ?? "");
		});

		try {
			const result = await streamOpenAIResponses(openAIResponsesModel, baseContext(), {
				apiKey: "test-key",
				fetch: fetchMock,
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(getFirstTextContent(result)).toMatchObject({ type: "text", text: "Hello delayed" });
			expect(timeoutHeaders).toContain("1");
		} finally {
			if (previousOpenAIIdleTimeout === undefined) {
				delete Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS;
			} else {
				Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = previousOpenAIIdleTimeout;
			}
			if (previousGenericFirstEventTimeout === undefined) {
				delete Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
			} else {
				Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = previousGenericFirstEventTimeout;
			}
		}
	});

	it("lets PI_OPENAI_STREAM_IDLE_TIMEOUT_MS widen native Ollama first-event request setup", async () => {
		const previousOpenAIIdleTimeout = Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS;
		const previousGenericFirstEventTimeout = Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
		Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = "1500";
		Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "20";
		const fetchMock = createDelayedFetch(30, createOllamaChatSuccessResponse);

		try {
			const result = await streamSimple(ollamaChatModel, baseContext(), {
				apiKey: "test-key",
				fetch: fetchMock,
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(getFirstTextContent(result)).toMatchObject({ type: "text", text: "Hello delayed" });
		} finally {
			if (previousOpenAIIdleTimeout === undefined) {
				delete Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS;
			} else {
				Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = previousOpenAIIdleTimeout;
			}
			if (previousGenericFirstEventTimeout === undefined) {
				delete Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
			} else {
				Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = previousGenericFirstEventTimeout;
			}
		}
	});

	it("honors PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS even when caller pins streamIdleTimeoutMs", async () => {
		const previousOpenAIFirstEventTimeout = Bun.env.PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS;
		const previousGenericFirstEventTimeout = Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
		const timeoutHeaders: string[] = [];
		Bun.env.PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS = "1500";
		Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "20";
		const fetchMock = createDelayedFetch(30, createOpenAIResponsesSuccessResponse, (input, init) => {
			timeoutHeaders.push(getRequestHeader(input, init, "X-Stainless-Timeout") ?? "");
		});

		try {
			const result = await streamOpenAIResponses(openAIResponsesModel, baseContext(), {
				apiKey: "test-key",
				streamIdleTimeoutMs: 5_000,
				fetch: fetchMock,
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(getFirstTextContent(result)).toMatchObject({ type: "text", text: "Hello delayed" });
			expect(timeoutHeaders).toContain("1");
		} finally {
			if (previousOpenAIFirstEventTimeout === undefined) {
				delete Bun.env.PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS;
			} else {
				Bun.env.PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS = previousOpenAIFirstEventTimeout;
			}
			if (previousGenericFirstEventTimeout === undefined) {
				delete Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
			} else {
				Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = previousGenericFirstEventTimeout;
			}
		}
	});

	it("times out OpenAI responses streams that only emit no-progress status events", async () => {
		const fetchMock: FetchImpl = (input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(createNoProgressOpenAIResponsesStream(getRequestSignal(input, init)));

		const result = await streamOpenAIResponses(openAIResponsesModel, baseContext(), {
			apiKey: "test-key",
			streamFirstEventTimeoutMs: 1_000,
			streamIdleTimeoutMs: 20,
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI responses stream stalled while waiting for the next event");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{
				type: "toolCall",
				id: "call_stalled|fc_stalled",
				name: "todo",
				arguments: {},
			},
		]);
	});

	it("forwards streamSimple per-call timeout options to OpenAI-family providers", async () => {
		const fetchMock = createHangingFetch();
		const controller = new AbortController();
		const abortTimer = setTimeout(() => controller.abort(new Error("fallback abort")), 200);
		abortTimer.unref();

		try {
			const result = await streamSimple(openAIResponsesModel, baseContext(), {
				apiKey: "test-key",
				signal: controller.signal,
				streamFirstEventTimeoutMs: 20,
				streamIdleTimeoutMs: 20,
				fetch: fetchMock,
			}).result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("OpenAI responses stream timed out while waiting for the first event");
		} finally {
			clearTimeout(abortTimer);
		}
	});

	it("surfaces the OpenAI completions first-event timeout message", async () => {
		await expectFirstEventTimeout(
			(streamFirstEventTimeoutMs, fetchMock) =>
				streamOpenAICompletions(openAICompletionsModel, baseContext(), {
					apiKey: "test-key",
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			"OpenAI completions stream timed out while waiting for the first event",
		);
	});
	it("times out OpenAI completions before the stream opens and forwards the budget to the SDK request", async () => {
		await expectRequestSetupTimeout(
			(streamFirstEventTimeoutMs, fetchMock) =>
				streamOpenAICompletions(openAICompletionsModel, baseContext(), {
					apiKey: "test-key",
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			"OpenAI completions stream timed out while waiting for the first event",
			() => createOpenAICompletionsSuccessResponse(openAICompletionsModel.id),
		);
	});

	it("cancels the OpenAI completions response body when the first-event watchdog fires", async () => {
		let cancelled = false;
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				createHangingSseResponse(undefined, () => {
					cancelled = true;
				}),
			);
		const result = await streamOpenAICompletions(openAICompletionsModel, baseContext(), {
			apiKey: "test-key",
			streamFirstEventTimeoutMs: 20,
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI completions stream timed out while waiting for the first event");
		expect(cancelled).toBe(true);
	});
	it("surfaces the Azure OpenAI responses first-event timeout message", async () => {
		await expectFirstEventTimeout(
			(streamFirstEventTimeoutMs, fetchMock) =>
				streamAzureOpenAIResponses(azureOpenAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					azureBaseUrl: azureOpenAIResponsesModel.baseUrl,
					azureApiVersion: "v1",
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			"Azure OpenAI responses stream timed out while waiting for the first event",
		);
	});
	it("times out Azure OpenAI responses before the stream opens and forwards the budget to the SDK request", async () => {
		await expectRequestSetupTimeout(
			(streamFirstEventTimeoutMs, fetchMock) =>
				streamAzureOpenAIResponses(azureOpenAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					azureBaseUrl: azureOpenAIResponsesModel.baseUrl,
					azureApiVersion: "v1",
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			"Azure OpenAI responses stream timed out while waiting for the first event",
			createOpenAIResponsesSuccessResponse,
		);
	});

	it("times out Azure responses streams that only emit no-progress status events", async () => {
		const fetchMock: FetchImpl = (input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(createNoProgressOpenAIResponsesStream(getRequestSignal(input, init)));
		const controller = new AbortController();
		const abortTimer = setTimeout(() => controller.abort(new Error("fallback abort")), 200);
		abortTimer.unref();

		try {
			const result = await streamAzureOpenAIResponses(azureOpenAIResponsesModel, baseContext(), {
				apiKey: "test-key",
				azureBaseUrl: azureOpenAIResponsesModel.baseUrl,
				azureApiVersion: "v1",
				signal: controller.signal,
				streamFirstEventTimeoutMs: 1_000,
				streamIdleTimeoutMs: 20,
				fetch: fetchMock,
			}).result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("Azure OpenAI responses stream stalled while waiting for the next event");
		} finally {
			clearTimeout(abortTimer);
		}
	});

	it("keeps caller aborts as aborted for OpenAI responses", async () => {
		await expectCallerAbort(
			(signal, streamFirstEventTimeoutMs, fetchMock) =>
				streamOpenAIResponses(openAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					signal,
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			"OpenAI responses stream timed out while waiting for the first event",
		);
	});

	it("keeps caller aborts as aborted for OpenAI completions", async () => {
		await expectCallerAbort(
			(signal, streamFirstEventTimeoutMs, fetchMock) =>
				streamOpenAICompletions(openAICompletionsModel, baseContext(), {
					apiKey: "test-key",
					signal,
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			"OpenAI completions stream timed out while waiting for the first event",
		);
	});

	it("keeps caller aborts as aborted for Azure OpenAI responses", async () => {
		await expectCallerAbort(
			(signal, streamFirstEventTimeoutMs, fetchMock) =>
				streamAzureOpenAIResponses(azureOpenAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					azureBaseUrl: azureOpenAIResponsesModel.baseUrl,
					azureApiVersion: "v1",
					signal,
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			"Azure OpenAI responses stream timed out while waiting for the first event",
		);
	});

	it("does not arm the first-event watchdog before OpenAI responses stream setup finishes", async () => {
		await expectDelayedRequestSetupSucceeds(
			(streamFirstEventTimeoutMs, fetchMock) =>
				streamOpenAIResponses(openAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			createOpenAIResponsesSuccessResponse,
		);
	});

	it("does not arm the first-event watchdog before OpenAI completions stream setup finishes", async () => {
		await expectDelayedRequestSetupSucceeds(
			(streamFirstEventTimeoutMs, fetchMock) =>
				streamOpenAICompletions(openAICompletionsModel, baseContext(), {
					apiKey: "test-key",
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			() => createOpenAICompletionsSuccessResponse(openAICompletionsModel.id),
		);
	});

	it("does not arm the first-event watchdog before Azure OpenAI responses setup finishes", async () => {
		await expectDelayedRequestSetupSucceeds(
			(streamFirstEventTimeoutMs, fetchMock) =>
				streamAzureOpenAIResponses(azureOpenAIResponsesModel, baseContext(), {
					apiKey: "test-key",
					azureBaseUrl: azureOpenAIResponsesModel.baseUrl,
					azureApiVersion: "v1",
					streamFirstEventTimeoutMs,
					fetch: fetchMock,
				}).result(),
			createOpenAIResponsesSuccessResponse,
		);
	});

	it("errors when OpenAI responses stream closes without a terminal response event", async () => {
		const incompleteResponse = createSseResponse([
			{ type: "response.created", response: { id: "resp_incomplete" } },
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_incomplete", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hello" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_incomplete",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			},
			// Intentionally no response.completed/incomplete — simulates premature provider disconnect.
		]);
		const fetchMock: FetchImpl = () => Promise.resolve(incompleteResponse);
		const result = await streamOpenAIResponses(openAIResponsesModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI responses stream closed before a terminal response event was received");
		expect(result.content as unknown[]).toEqual([
			{ type: "text", text: "Hello", textSignature: '{"v":1,"id":"msg_incomplete"}' },
		]);
	});

	it("accepts response.done with a completed response as an OpenAI responses terminal event", async () => {
		const completedResponse = createSseResponse([
			{ type: "response.created", response: { id: "resp_done" } },
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_done", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hello done" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_done",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello done" }],
				},
			},
			{
				type: "response.done",
				response: {
					id: "resp_done",
					status: "completed",
					usage: {
						input_tokens: 3,
						output_tokens: 2,
						total_tokens: 5,
					},
				},
			},
		]);
		const fetch: FetchImpl = () => Promise.resolve(completedResponse);
		const result = await streamOpenAIResponses(openAIResponsesModel, baseContext(), {
			apiKey: "test-key",
			fetch,
		}).result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		expect(result.content as unknown[]).toContainEqual({
			type: "text",
			text: "Hello done",
			textSignature: '{"v":1,"id":"msg_done"}',
		});
	});

	it("errors when Azure OpenAI responses stream closes without a terminal response event", async () => {
		const incompleteResponse = createSseResponse([
			{ type: "response.created", response: { id: "resp_incomplete_azure" } },
			{
				type: "response.output_item.added",
				item: {
					type: "message",
					id: "msg_incomplete_azure",
					role: "assistant",
					status: "in_progress",
					content: [],
				},
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hello azure" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_incomplete_azure",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello azure" }],
				},
			},
			// Intentionally no response.completed/incomplete — simulates premature provider disconnect.
		]);
		const fetchMock: FetchImpl = () => Promise.resolve(incompleteResponse);
		const result = await streamAzureOpenAIResponses(azureOpenAIResponsesModel, baseContext(), {
			apiKey: "test-key",
			azureBaseUrl: azureOpenAIResponsesModel.baseUrl,
			azureApiVersion: "v1",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(
			"Azure OpenAI responses stream closed before a terminal response event was received",
		);
		expect(result.content as unknown[]).toEqual([
			{ type: "text", text: "Hello azure", textSignature: '{"v":1,"id":"msg_incomplete_azure"}' },
		]);
	});

	it("handles response.incomplete as a valid terminal event (not premature closure)", async () => {
		const incompleteResponse = createSseResponse([
			{ type: "response.created", response: { id: "resp_length_limited" } },
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_length_limited", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Truncated output" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_length_limited",
					role: "assistant",
					status: "incomplete",
					content: [{ type: "output_text", text: "Truncated output" }],
				},
			},
			{
				type: "response.incomplete",
				response: {
					id: "resp_length_limited",
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
				},
			},
		]);
		const fetchMock: FetchImpl = () => Promise.resolve(incompleteResponse);
		const result = await streamOpenAIResponses(openAIResponsesModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("length");
		expect(result.errorMessage).toBeFalsy();
		expect(result.content as unknown[]).toEqual([
			{ type: "text", text: "Truncated output", textSignature: '{"v":1,"id":"msg_length_limited"}' },
		]);
	});

	it("honors streamIdleTimeoutMs from model.compat for OpenAI responses streams", async () => {
		const customResponsesModel: Model<"openai-responses"> = buildModel({
			id: "fugu-test",
			name: "Fugu Test",
			api: "openai-responses",
			provider: "sakana",
			baseUrl: "https://api.sakana.ai/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
			compat: { streamIdleTimeoutMs: 20 },
		});

		const fetchMock = () => Promise.resolve(createNoProgressOpenAIResponsesStream(undefined));
		const result = await streamOpenAIResponses(customResponsesModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock as any,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI responses stream stalled while waiting for the next event");
	});

	it("honors streamFirstEventTimeoutMs from model.compat for OpenAI responses streams", async () => {
		const customResponsesModel: Model<"openai-responses"> = buildModel({
			id: "slow-first-event",
			name: "Slow First Event",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
			compat: { streamFirstEventTimeoutMs: 20, streamIdleTimeoutMs: 5 },
		});
		const fetchMock = createDelayedFetch(30, createOpenAIResponsesSuccessResponse);

		const result = await streamOpenAIResponses(customResponsesModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI responses stream timed out while waiting for the first event");
	});

	it("keeps a local first-event disable after SSE headers arrive", async () => {
		vi.useFakeTimers();
		const localResponsesModel: Model<"openai-responses"> = buildModel({
			id: "slow-local-prefill",
			name: "Slow Local Prefill",
			api: "openai-responses",
			provider: "llama.cpp",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 16384,
			compat: { streamFirstEventTimeoutMs: 0, streamIdleTimeoutMs: 20 },
		});
		const responseBody = new Uint8Array(await createOpenAIResponsesSuccessResponse().arrayBuffer());
		const bodyRead = Promise.withResolvers<void>();
		const releaseBody = Promise.withResolvers<void>();
		const fetchMock: FetchImpl = () => {
			const body = new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						bodyRead.resolve();
						await releaseBody.promise;
						controller.enqueue(responseBody);
						controller.close();
					},
				},
				{ highWaterMark: 0 },
			);
			return Promise.resolve(
				new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);
		};

		try {
			const resultPromise = streamOpenAIResponses(localResponsesModel, baseContext(), {
				apiKey: "test-key",
				fetch: fetchMock,
			}).result();
			await bodyRead.promise;
			for (let i = 0; i < 10; i++) await Promise.resolve();

			expect(vi.getTimerCount()).toBe(0);
			releaseBody.resolve();
			const result = await resultPromise;
			expect(result.stopReason).toBe("stop");
			expect(getFirstTextContent(result)).toMatchObject({ type: "text", text: "Hello delayed" });
		} finally {
			releaseBody.resolve();
			vi.useRealTimers();
		}
	});
});
