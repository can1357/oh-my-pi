import { expect, test } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { crc32 } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import { type KiroRequest, normalizeKiroFrame, streamKiro } from "@oh-my-pi/pi-ai/providers/kiro/index";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { encodeKiroCredential } from "@oh-my-pi/pi-catalog/wire/kiro-credential";

const EU_ENDPOINT = "https://runtime.eu-central-1.kiro.dev/";
const API_KEY = "ksk_kiro-token";
const CONTEXT: Context = { messages: [{ role: "user", content: "Say hello", timestamp: 0 }] };
const encoder = new TextEncoder();
const CAPACITY = "INSUFFICIENT_MODEL_CAPACITY";

const createModel = (baseUrl = "https://runtime.us-east-1.kiro.dev/"): Model<"kiro-api"> =>
	buildModel({
		id: "m",
		name: "m",
		api: "kiro-api",
		provider: "kiro",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 2_048,
	});

/** Encodes one AWS event-stream frame with string headers and a JSON payload. */
function encodeFrame(headerValues: Record<string, string>, payload: unknown): Uint8Array {
	const payloadBytes = encoder.encode(JSON.stringify(payload));
	const headers = Object.entries(headerValues).flatMap(([name, value]) => {
		const [n, v] = [encoder.encode(name), encoder.encode(value)];
		return [n.length, ...n, 7, v.length >> 8, v.length & 0xff, ...v];
	});
	const total = 12 + headers.length + payloadBytes.length + 4;
	const frame = new Uint8Array(total);
	const view = new DataView(frame.buffer);
	view.setUint32(0, total, false);
	view.setUint32(4, headers.length, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(headers, 12);
	frame.set(payloadBytes, 12 + headers.length);
	view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)), false);
	return frame;
}

const ev = (type: string, payload: unknown) => encodeFrame({ ":message-type": "event", ":event-type": type }, payload);
const CAPACITY_FRAME = encodeFrame(
	{ ":message-type": "exception", ":exception-type": "ThrottlingError" },
	{ message: "busy", reason: CAPACITY },
);
const METERING = ev("meteringEvent", { unit: "credit", unitPlural: "credits", usage: 0.02 });
const VISIBLE = ev("assistantResponseEvent", { content: "partial answer" });

/** A 200 event-stream response, split mid-frame to exercise chunk reassembly. */
function framesResponse(frames: readonly Uint8Array[]): Response {
	const bytes = new Uint8Array(frames.flatMap(frame => [...frame]));
	const chunks = [bytes.subarray(0, 7), bytes.subarray(7)];
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		}),
	);
}

const eventsResponse = (events: readonly [string, unknown][]) => framesResponse(events.map(([t, p]) => ev(t, p)));
const recovered = () => eventsResponse([["assistantResponseEvent", { content: "recovered" }]]);

/** Runs one Kiro turn against `respond`, counting attempts and recording retry waits. */
async function run(
	respond: (attempt: number, init?: RequestInit) => Response | Promise<Response>,
	options: Partial<Parameters<typeof streamKiro>[2]> = {},
) {
	let attempts = 0;
	const waits: number[] = [];
	const result = await streamKiro(createModel(), CONTEXT, {
		apiKey: API_KEY,
		fetch: async (_input, init) => respond(++attempts, init),
		providerRetryWait: async delay => void waits.push(delay),
		...options,
	}).result();
	return { attempts, waits, result };
}

test("normalizes event aliases, ignores unknown events, and rejects malformed or error frames", async () => {
	const cases: Array<[string, unknown, unknown]> = [
		["initial-response", { requestId: "r" }, { type: "metadata", requestId: "r" }],
		["reasoningContentEvent", { text: "t", signature: "s" }, { type: "reasoning", text: "t", signature: "s" }],
		["toolUseEvent", { toolUseId: "t1", name: "n", input: "{}" }, { type: "tool", toolUseId: "t1", name: "n" }],
		["contextUsageEvent", { contextUsagePercentage: 42 }, { type: "contextUsage", percentage: 42 }],
		["metricsEvent", { input_tokens: 8, cachedTokens: 2 }, { usage: { inputTokens: 8, cacheReadTokens: 2 } }],
		["futureKiroEvent", { ignored: true }, { type: "ignored" }],
	];
	const norm = (type: string, payload: unknown) =>
		normalizeKiroFrame({
			headers: { ":message-type": "event", ":event-type": type },
			payload: encoder.encode(JSON.stringify(payload)),
		});
	for (const [type, payload, expected] of cases) expect(norm(type, payload)).toMatchObject(expected as object);
	expect(() => norm("assistantResponseEvent", { content: 42 })).toThrow(/MALFORMED_ASSISTANT_EVENT/);

	// A header-only error frame is built from its :error-code/:error-message headers.
	for (const [code, retriable] of Object.entries({ ThrottlingException: true, SomeFutureError: false })) {
		const headers = { ":message-type": "error", ":error-code": code, ":error-message": "msg" };
		const thrown = await Promise.resolve()
			.then(() => normalizeKiroFrame({ headers, payload: new Uint8Array(0) }))
			.catch((error: Error) => error);
		expect((thrown as Error).message).toBe(`${code}: msg`);
		expect(AIError.retriable(AIError.classify(thrown))).toBe(retriable);
	}
});

test("emits ordered reasoning, text, interleaved tool-call, usage, and terminal events; zero usage when absent", async () => {
	const stream = streamKiro(createModel(), CONTEXT, {
		apiKey: API_KEY,
		fetch: async () =>
			eventsResponse([
				["reasoningContentEvent", { text: "thinking", signature: "sig-1" }],
				["assistantResponseEvent", { content: "before tool" }],
				["toolUseEvent", { toolUseId: "a", name: "first", input: '{"x":' }],
				["toolUseEvent", { toolUseId: "b", name: "second", input: { value: 1 } }],
				["toolUseEvent", { toolUseId: "a", input: "1}", stop: true }],
				["toolUseEvent", { toolUseId: "b", input: { value: 2 }, stop: true }],
				["contextUsageEvent", { contextUsagePercentage: 10 }],
				["contextUsageEvent", { contextUsagePercentage: 37.5 }],
				[
					"metadataEvent",
					{ stopReason: "TOOL_USE", tokenUsage: { uncachedInputTokens: 11, cacheReadInputTokens: 13 } },
				],
				["usageEvent", { outputTokens: 7 }],
			]),
	});
	const emitted: string[] = [];
	for await (const event of stream) emitted.push(event.type);
	const result = await stream.result();

	expect(emitted.join(" ")).toBe(
		"start thinking_start thinking_delta thinking_end text_start text_delta text_end toolcall_start " +
			"toolcall_delta toolcall_start toolcall_delta toolcall_end toolcall_end done",
	);
	expect(result.stopReason).toBe("toolUse");
	expect(result.content).toEqual([
		{ type: "thinking", thinking: "thinking", thinkingSignature: "sig-1" },
		{ type: "text", text: "before tool" },
		{ type: "toolCall", id: "a", name: "first", arguments: { x: 1 } },
		{ type: "toolCall", id: "b", name: "second", arguments: { value: 2 } },
	]);
	// 37.5% of the 32,000-token window: the last context event wins.
	expect(result.usage).toMatchObject({ input: 11, cacheRead: 13, output: 7, contextTokens: 12_000 });

	const { usage } = (await run(recovered)).result;
	expect(usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, totalTokens: 0 });
	expect(usage.contextTokens).toBeUndefined();
});

test("retries one pre-output HTTP capacity throttle with the identical frozen body and CLI headers", async () => {
	let hooks = 0;
	const headers: Record<string, string>[] = [];
	const bodies: string[] = [];
	const { waits, result } = await run(
		(attempt, init) => {
			headers.push(Object.fromEntries(new Headers(init?.headers)));
			bodies.push(String(init?.body));
			if (attempt > 1) return recovered();
			return Response.json({ __type: "ThrottlingError", message: "busy", reason: CAPACITY }, { status: 429 });
		},
		// A stateful hook: rerunning it per attempt would change the body.
		{ onPayload: payload => ({ ...(payload as KiroRequest), hookRun: ++hooks }) },
	);

	expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
	expect(waits).toEqual([500]);
	expect(bodies[1]).toBe(bodies[0]);
	expect(JSON.parse(bodies[0]).hookRun).toBe(1);
	const cliHeaders = (attempt: number) =>
		expect.objectContaining({
			"x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
			"x-amzn-codewhisperer-optout": "true",
			"x-amzn-kiro-attempt": `${attempt};max=2`,
			authorization: `Bearer ${API_KEY}`,
			"amz-sdk-request": `attempt=${attempt}; max=2`,
		});
	expect(headers).toEqual([cliHeaders(1), cliHeaders(2)]);
	expect(headers[1]["amz-sdk-invocation-id"]).not.toBe(headers[0]["amz-sdk-invocation-id"]);
});

const json = (status: number, __type: string, message: string) => () => Response.json({ __type, message }, { status });
test.each<[string, Uint8Array[] | (() => Response), number]>([
	["capacity named only in message text", json(429, "ThrottlingError", CAPACITY), 1],
	["in-stream capacity before output", [CAPACITY_FRAME], 2],
	["in-stream capacity after billing", [METERING, CAPACITY_FRAME], 1],
	["transient tool-format rejection", json(400, "ValidationException", "Invalid tool use format."), 2],
	["other validation rejection", json(400, "ValidationException", "Missing required field."), 1],
	["clean stream ending without output", [ev("initial-response", { requestId: "x" })], 1],
	["frame cut off before output", [ev("initial-response", { requestId: "x" }).subarray(0, 20)], 2],
	["frame cut off after output", [VISIBLE, VISIBLE.subarray(0, 20)], 1],
	["corrupt frame before output", [CAPACITY_FRAME.map((byte, i) => (i === 8 ? byte ^ 1 : byte))], 1],
])("replay policy: %s", async (_name, first, expectedAttempts) => {
	const { attempts, result } = await run(attempt =>
		attempt > 1 ? recovered() : Array.isArray(first) ? framesResponse(first) : first(),
	);
	expect(attempts).toBe(expectedAttempts);
	if (expectedAttempts === 2) {
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(result.responseId).toBeUndefined();
	} else {
		expect(result.stopReason).toBe("error");
	}
});

test("releases the stalled HTTP connection on first-event and idle timeouts, distinct from caller abort", async () => {
	// A real socket: only aborting the fetch closes it, because the frame
	// decoder holds the body's reader lock while its read is pending.
	let head = ev("initial-response", { requestId: "stalled" });
	const cancelled: Array<PromiseWithResolvers<void>> = [];
	const server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		fetch() {
			const closed = Promise.withResolvers<void>();
			cancelled.push(closed);
			const body = new ReadableStream<Uint8Array>({
				start: controller => controller.enqueue(head),
				cancel: () => closed.resolve(),
			});
			return new Response(body);
		},
	});
	try {
		const cases = Object.entries({ "first visible output": head, "next event": VISIBLE });
		const fetch: FetchImpl = (_input, init) => globalThis.fetch(server.url, init);
		for (const [index, [message, frame]] of cases.entries()) {
			head = frame;
			const { result } = await run(recovered, { fetch, streamFirstEventTimeoutMs: 250, streamIdleTimeoutMs: 250 });
			expect(result.errorMessage).toContain(message);
			expect(AIError.is(result.errorId, AIError.Flag.Timeout)).toBe(true);
			// Resolves only once the server sees the connection closed.
			await cancelled[index]?.promise;
		}
		const aborted = await run(recovered, { fetch, signal: AbortSignal.abort() });
		expect(aborted.result.stopReason).toBe("aborted");
	} finally {
		server.stop(true);
	}
});

test("stops reading an error body that never ends", async () => {
	const blocked = Promise.withResolvers<void>();
	const body = new ReadableStream<Uint8Array>({
		start: controller => controller.enqueue(encoder.encode('{"message":"upstream busy"}')),
		pull: () => blocked.promise,
		cancel: () => blocked.resolve(),
	});
	const errorBody = await run(() => new Response(body, { status: 503 }), { streamFirstEventTimeoutMs: 30 });
	expect(errorBody.result.errorMessage).toMatch(/timed out|timeout/i);
});

test("drops a cut-off tool call on CONTENT_FILTERED refusal (not replayed) and MAX_TOKENS truncation", async () => {
	const refusal = { category: "CYBER", explanation: "Cannot continue." };
	const turn = (metadata: unknown) => () =>
		eventsResponse([
			["assistantResponseEvent", { content: "Let me" }],
			["toolUseEvent", { toolUseId: "t", name: "write", input: '{"path":"a.txt","content":"partial' }],
			["metadataEvent", metadata],
		]);
	const filtered = await run(turn({ stopReason: "CONTENT_FILTERED", stopDetails: { refusal } }));
	expect(filtered.attempts).toBe(1);
	expect(filtered.result.content).toEqual([{ type: "text", text: "Let me" }]);
	expect(filtered.result.stopDetails).toEqual({ type: "refusal", ...refusal });
	expect(AIError.is(filtered.result.errorId, AIError.Flag.ContentBlocked)).toBe(true);
	expect(AIError.retriable(filtered.result.errorId)).toBe(false);

	const truncatedTurn = await run(turn({ stopReason: "MAX_TOKENS" }));
	expect(truncatedTurn.result.stopReason).toBe("length");
	expect(truncatedTurn.result.content).toEqual([{ type: "text", text: "Let me" }]);
});

test("maps context overflow responses", async () => {
	for (const respond of [
		json(400, "ValidationException", "input exceeds the context window"),
		() => new Response(null, { status: 413 }),
	]) {
		const { result } = await run(respond);
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(true);
	}
});

test("reuses the session ID as conversation ID and routes to the active credential's endpoint", async () => {
	const sent: string[] = [];
	const fetch: FetchImpl = async (input, init) => {
		sent.push(`${input} ${(JSON.parse(String(init?.body)) as KiroRequest).conversationState.conversationId}`);
		return recovered();
	};
	const apiKey = encodeKiroCredential({ kind: "api_key", token: "ksk_api-key", apiEndpoint: EU_ENDPOINT });
	for (const sessionId of ["session-a", "session-a", "session-b"]) await run(recovered, { apiKey, fetch, sessionId });
	expect(sent).toEqual([`${EU_ENDPOINT} session-a`, `${EU_ENDPOINT} session-a`, `${EU_ENDPOINT} session-b`]);

	const invalid = await streamKiro(createModel("https://api.example.com/"), CONTEXT, { apiKey: API_KEY, fetch });
	expect((await invalid.result()).errorMessage).toContain("Invalid Kiro runtime endpoint");
	expect(sent).toHaveLength(3);
});
