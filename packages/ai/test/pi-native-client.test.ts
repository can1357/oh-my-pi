import { afterEach, describe, expect, it, type Mock, mock, spyOn } from "bun:test";
import { streamPiNative } from "@oh-my-pi/pi-ai/providers/pi-native-client";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	ProviderResponseMetadata,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function sseBytes(events: AssistantMessageEvent[]): Uint8Array {
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	for (const event of events) {
		parts.push(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
	}
	parts.push(encoder.encode("data: [DONE]\n\n"));
	const total = parts.reduce((n, p) => n + p.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}
function sseEventBytes(event: AssistantMessageEvent): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function fakeBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function stalledBody(bytes: Uint8Array[] = []): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of bytes) controller.enqueue(chunk);
		},
	});
}

function delayedBody(chunks: Array<{ atMs: number; bytes: Uint8Array }>): ReadableStream<Uint8Array> {
	let closed = false;
	const timers: Timer[] = [];
	const clearTimers = () => {
		closed = true;
		for (const timer of timers) clearTimeout(timer);
		timers.length = 0;
	};
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const enqueue = (bytes: Uint8Array) => {
				if (!closed) controller.enqueue(bytes);
			};
			for (const chunk of chunks) {
				if (chunk.atMs <= 0) {
					enqueue(chunk.bytes);
				} else {
					timers.push(setTimeout(() => enqueue(chunk.bytes), chunk.atMs));
				}
			}
			timers.push(
				setTimeout(
					() => {
						if (!closed) {
							clearTimers();
							controller.close();
						}
					},
					Math.max(...chunks.map(chunk => chunk.atMs)) + 1,
				),
			);
		},
		cancel() {
			clearTimers();
		},
	});
}

function fakeResponse(events: AssistantMessageEvent[], init: ResponseInit = {}): Response {
	return new Response(fakeBody(sseBytes(events)), {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
		...init,
	});
}

function baseAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function fakeModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://llm-gateway.internal:4000",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
		transport: "pi-native",
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}
function fakeBedrockModel(overrides: Partial<Model<"bedrock-converse-stream">> = {}): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "amazon.nova-lite-v1:0",
		name: "Amazon Nova Lite",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "http://llm-gateway.internal:4000",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.8, output: 2.4, cacheRead: 0.08, cacheWrite: 0.1 },
		contextWindow: 300_000,
		maxTokens: 5_000,
		transport: "pi-native",
		...overrides,
	} as ModelSpec<"bedrock-converse-stream">);
}

const baseContext: Context = {
	systemPrompt: ["you are helpful"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const out: AssistantMessageEvent[] = [];
	for await (const event of stream) out.push(event);
	return out;
}

afterEach(() => {
	mock.restore();
});

describe("streamPiNative request shape", () => {
	it("POSTs `{modelId, context, options, stream:true}` to `<baseUrl>/v1/pi/stream`", async () => {
		const final = baseAssistant();
		const captured: { url?: string; init?: RequestInit } = {};
		const fetchImpl: FetchImpl = (async (input, init) => {
			captured.url = typeof input === "string" ? input : input.toString();
			captured.init = init;
			return fakeResponse([{ type: "done", reason: "stop", message: final }]);
		}) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "gw-bearer",
			fetch: fetchImpl,
			temperature: 0.7,
		});
		await stream.result();

		expect(captured.url).toBe("http://llm-gateway.internal:4000/v1/pi/stream");
		expect(captured.init?.method).toBe("POST");
		const headers = captured.init?.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers.Accept).toBe("text/event-stream");
		expect(headers.Authorization).toBe("Bearer gw-bearer");

		const body = JSON.parse(captured.init?.body as string);
		// Provider-qualified to avoid cross-provider id collisions; the gateway
		// registry keys on `${provider}/${id}` first (see auth-gateway-cli runServe).
		expect(body.modelId).toBe("anthropic/claude-sonnet-4-5");
		expect(body.context).toEqual(baseContext);
		expect(body.stream).toBe(true);
		expect(body.options.temperature).toBe(0.7);
	});
	it("forwards Bedrock guardrails from the model through streamSimple", async () => {
		const captured: { init?: RequestInit } = {};
		const fetchImpl: FetchImpl = (async (_input, init) => {
			captured.init = init;
			return fakeResponse([{ type: "done", reason: "stop", message: baseAssistant() }]);
		}) as FetchImpl;

		await streamSimple(
			fakeBedrockModel({
				guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/example",
				guardrailVersion: "7",
				guardrailTrace: "enabled_full",
			}),
			baseContext,
			{ apiKey: "gw-bearer", fetch: fetchImpl },
		).result();

		const body = JSON.parse(captured.init?.body as string);
		expect(body.options).toMatchObject({
			guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/example",
			guardrailVersion: "7",
			guardrailTrace: "enabled_full",
		});
	});

	it("strips non-wire fields (signal, apiKey, fetch, callbacks) from `options`", async () => {
		// `apiKey` must ride in the Authorization header, never the body — sending
		// it twice would let a logged request leak the gateway bearer. The other
		// fields are non-serializable function/runtime handles.
		const captured: { init?: RequestInit } = {};
		let responseMetadata: ProviderResponseMetadata | undefined;
		const fetchImpl: FetchImpl = (async (_input, init) => {
			captured.init = init;
			return fakeResponse([{ type: "done", reason: "stop", message: baseAssistant() }], {
				headers: {
					"Content-Type": "text/event-stream",
					"X-Request-Id": "gateway-request-id",
					"CF-AIG-Cache-Status": "HIT",
				},
			});
		}) as FetchImpl;

		const controller = new AbortController();
		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "gw-bearer",
			fetch: fetchImpl,
			signal: controller.signal,
			onPayload: () => {
				throw new Error("the gateway payload is unavailable to the client");
			},
			onResponse: response => {
				responseMetadata = response;
			},
			onSseEvent: () => undefined,
			providerSessionState: new Map(),
			maxTokens: 1024,
		});
		await stream.result();

		const body = JSON.parse(captured.init?.body as string);
		expect("apiKey" in body.options).toBe(false);
		expect("signal" in body.options).toBe(false);
		expect("fetch" in body.options).toBe(false);
		expect("onPayload" in body.options).toBe(false);
		expect("onResponse" in body.options).toBe(false);
		expect("onSseEvent" in body.options).toBe(false);
		expect("providerSessionState" in body.options).toBe(false);
		// And the legitimate options survive
		expect(body.options.maxTokens).toBe(1024);
		expect(responseMetadata).toMatchObject({
			status: 200,
			requestId: "gateway-request-id",
			headers: {
				"x-request-id": "gateway-request-id",
				"cf-aig-cache-status": "HIT",
			},
		});
	});

	it("normalizes trailing slashes on `baseUrl` so the endpoint never double-slashes", async () => {
		const captured: { url?: string } = {};
		const fetchImpl: FetchImpl = (async (input, _init) => {
			captured.url = typeof input === "string" ? input : input.toString();
			return fakeResponse([{ type: "done", reason: "stop", message: baseAssistant() }]);
		}) as FetchImpl;

		await streamPiNative(fakeModel({ baseUrl: "http://llm-gateway.internal:4000///" }), baseContext, {
			apiKey: "k",
			fetch: fetchImpl,
		}).result();
		expect(captured.url).toBe("http://llm-gateway.internal:4000/v1/pi/stream");
	});

	it("forwards `model.headers` and lets a caller-supplied Authorization win", async () => {
		const captured: { init?: RequestInit } = {};
		const fetchImpl: FetchImpl = (async (_input, init) => {
			captured.init = init;
			return fakeResponse([{ type: "done", reason: "stop", message: baseAssistant() }]);
		}) as FetchImpl;

		await streamPiNative(
			fakeModel({ headers: { "x-omp-slot": "robomp-1", Authorization: "Bearer model-wins" } }),
			baseContext,
			{ apiKey: "options-loses", fetch: fetchImpl },
		).result();

		const headers = captured.init?.headers as Record<string, string>;
		expect(headers["x-omp-slot"]).toBe("robomp-1");
		expect(headers.Authorization).toBe("Bearer model-wins");
	});

	it("throws synchronously when `baseUrl` is missing", async () => {
		const broken = fakeModel({ baseUrl: "" as unknown as string });
		// The promise the iterator awaits surfaces the error via `.result()`.
		const stream = streamPiNative(broken, baseContext, { apiKey: "k" });
		await expect(stream.result()).rejects.toThrow(/baseUrl/);
	});
});

describe("streamPiNative event flow", () => {
	it("pushes parsed events verbatim and resolves `.result()` on terminal `done`", async () => {
		const final = baseAssistant({
			content: [{ type: "text", text: "hi" }],
			usage: {
				input: 4,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 6,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const partial = baseAssistant({ content: [{ type: "text", text: "hi" }] });
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: baseAssistant() },
			{ type: "text_delta", contentIndex: 0, delta: "hi", partial },
			{ type: "done", reason: "stop", message: final },
		];
		const fetchImpl: FetchImpl = (async () => fakeResponse(events)) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, { apiKey: "k", fetch: fetchImpl });
		const seen = await collectEvents(stream);
		const result = await stream.result();

		expect(seen).toEqual(events);
		expect(result).toEqual(final);
	});

	it("classifies non-2xx responses into Errors with status + type tags", async () => {
		const fetchImpl: FetchImpl = (async () =>
			new Response(JSON.stringify({ error: { type: "authentication_error", message: "no credential" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			})) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, { apiKey: "k", fetch: fetchImpl });
		await expect(stream.result()).rejects.toThrow(/no credential/);
	});

	it("falls back to plain text on a non-JSON error body", async () => {
		const fetchImpl: FetchImpl = (async () => new Response("bad gateway", { status: 502 })) as FetchImpl;
		const stream = streamPiNative(fakeModel(), baseContext, { apiKey: "k", fetch: fetchImpl });
		await expect(stream.result()).rejects.toThrow(/502/);
	});

	it("rejects when the gateway sends headers but no first event before the timeout", async () => {
		const fetchImpl: FetchImpl = (async () =>
			new Response(stalledBody(), { status: 200, headers: { "Content-Type": "text/event-stream" } })) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "k",
			fetch: fetchImpl,
			streamFirstEventTimeoutMs: 20,
			streamIdleTimeoutMs: 20,
		});

		await expect(stream.result()).rejects.toThrow(/first event/);
	});

	it("uses PI_STREAM_FIRST_EVENT_TIMEOUT_MS for silent pi-native streams", async () => {
		const previous = Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
		Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "20";
		try {
			const fetchImpl: FetchImpl = (async () =>
				new Response(stalledBody(), {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				})) as FetchImpl;

			const stream = streamPiNative(fakeModel(), baseContext, { apiKey: "k", fetch: fetchImpl });

			await expect(stream.result()).rejects.toThrow(/first event/);
		} finally {
			if (previous === undefined) {
				delete Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
			} else {
				Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = previous;
			}
		}
	});

	it("rejects when a pi-native stream stalls after semantic progress", async () => {
		const partial = baseAssistant({ content: [{ type: "text", text: "hi" }] });
		const chunks = [
			sseEventBytes({ type: "start", partial: baseAssistant() }),
			sseEventBytes({ type: "text_delta", contentIndex: 0, delta: "hi", partial }),
		];
		const fetchImpl: FetchImpl = (async () =>
			new Response(stalledBody(chunks), {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			})) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "k",
			fetch: fetchImpl,
			streamFirstEventTimeoutMs: 1_000,
			streamIdleTimeoutMs: 20,
		});

		await expect(stream.result()).rejects.toThrow(/next event/);
	});

	it("does not time out a healthy pi-native stream that keeps making semantic progress", async () => {
		const final = baseAssistant({ content: [{ type: "text", text: "hello world" }] });
		const chunks = [
			{ atMs: 0, bytes: sseEventBytes({ type: "start", partial: baseAssistant() }) },
			{ atMs: 15, bytes: sseEventBytes({ type: "text_delta", contentIndex: 0, delta: "hello", partial: final }) },
			{ atMs: 35, bytes: sseEventBytes({ type: "text_delta", contentIndex: 0, delta: " world", partial: final }) },
			{ atMs: 55, bytes: sseEventBytes({ type: "done", reason: "stop", message: final }) },
		];
		const fetchImpl: FetchImpl = (async () =>
			new Response(delayedBody(chunks), {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			})) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "k",
			fetch: fetchImpl,
			streamFirstEventTimeoutMs: 1000,
			streamIdleTimeoutMs: 1000,
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
	});

	it("synthesizes a terminal `done` when the SSE stream closes silently", async () => {
		// Models the gateway dropping mid-stream — without this synthetic terminator,
		// `.result()` would hang forever.
		const halfEvents: AssistantMessageEvent[] = [{ type: "start", partial: baseAssistant() }];
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const e of halfEvents) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
				controller.close();
			},
		});
		const fetchImpl: FetchImpl = (async () =>
			new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, { apiKey: "k", fetch: fetchImpl });
		const seen = await collectEvents(stream);
		expect(seen.length).toBeGreaterThanOrEqual(2);
		expect(seen[seen.length - 1].type).toBe("done");

		const result = await stream.result();
		expect(result.role).toBe("assistant");
		expect(result.stopReason).toBe("stop");
	});

	it("fails fast when the caller's signal is already aborted before fetch fires", async () => {
		const fetchImpl = spyOn({ fetch: globalThis.fetch }, "fetch") as unknown as FetchImpl;
		const controller = new AbortController();
		controller.abort(new Error("pre-aborted"));

		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "k",
			fetch: fetchImpl,
			signal: controller.signal,
		});

		await expect(stream.result()).rejects.toThrow(/pre-aborted/);
		// fetch was never called — short-circuit happened in the abort guard
		expect((fetchImpl as unknown as Mock<typeof globalThis.fetch>).mock.calls.length).toBe(0);
	});

	it("forwards caller aborts to the underlying fetch signal", async () => {
		const captured: { signal?: AbortSignal } = {};
		const fetchImpl: FetchImpl = (async (_input, init) => {
			captured.signal = init?.signal ?? undefined;
			return new Response(stalledBody(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
		}) as FetchImpl;
		const controller = new AbortController();
		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "k",
			fetch: fetchImpl,
			signal: controller.signal,
		});

		await Bun.sleep(0);
		expect(captured.signal?.aborted).toBe(false);
		controller.abort(new Error("caller aborted"));

		const result = await stream.result();
		expect(captured.signal?.aborted).toBe(true);
		expect(result.stopReason).toBe("aborted");
	});
});
