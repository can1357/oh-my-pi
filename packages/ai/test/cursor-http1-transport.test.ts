import { expect, it } from "bun:test";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	BidiAppendRequestSchema,
	BidiRequestIdSchema,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const CONNECT_END_STREAM_FLAG = 0x02;

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function readConnectMessage(frame: Uint8Array): Uint8Array {
	if (frame.length < 5) throw new Error("truncated Connect frame");
	const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, false);
	if (frame.length !== length + 5) throw new Error("invalid Connect frame length");
	return frame.subarray(5);
}

function textDeltaFrame(text: string): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function turnEndedFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function connectEndErrorFrame(code: string): Buffer {
	return frameConnectMessage(Buffer.from(JSON.stringify({ error: { code } }), "utf8"), CONNECT_END_STREAM_FLAG);
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-http1-fixture",
		name: "Cursor HTTP1 fixture",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const context: Context = { messages: [{ role: "user", content: "transport", timestamp: 1 }] };

/**
 * Serves RunSSE and hands its response controller to `onRunRequest` once the
 * client's first BidiAppend (the run request) arrives.
 */
function startRunSseServer(onRunRequest: (controller: ReadableStreamDefaultController<Uint8Array>) => void) {
	const streamReady = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	let runRequestSeen = false;
	return Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			await request.arrayBuffer();
			if (url.pathname === "/agent.v1.AgentService/RunSSE") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							streamReady.resolve(controller);
						},
					}),
					{ headers: { "content-type": "application/connect+proto" } },
				);
			}
			if (url.pathname === "/aiserver.v1.BidiService/BidiAppend") {
				if (!runRequestSeen) {
					runRequestSeen = true;
					onRunRequest(await streamReady.promise);
				}
				return new Response(null, { headers: { "content-type": "application/proto" } });
			}
			return new Response(null, { status: 404 });
		},
	});
}

/** A turn that never settles fails the test at this bound instead of hanging the suite. */
const SETTLE_TIMEOUT_MS = 2_000;

/** Drains the stream, recording every terminal event it emits. */
async function drain(response: AssistantMessageEventStream, onEvent?: (type: string) => void) {
	const terminalEvents: string[] = [];
	for await (const event of response) {
		onEvent?.(event.type);
		if (event.type === "done" || event.type === "error") terminalEvents.push(event.type);
	}
	return { result: await response.result(), terminalEvents };
}

it("streams through RunSSE and sends AgentClientMessage frames through BidiAppend", async () => {
	const streamReady = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	const runRequestIds: string[] = [];
	const appendRequestIds: string[] = [];
	const appendSeqnos: bigint[] = [];
	const appendedCases: string[] = [];
	const streamingHeaders: string[] = [];

	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			streamingHeaders.push(request.headers.get("x-cursor-streaming") ?? "");
			const body = new Uint8Array(await request.arrayBuffer());
			if (url.pathname === "/agent.v1.AgentService/RunSSE") {
				const requestId = fromBinary(BidiRequestIdSchema, readConnectMessage(body));
				runRequestIds.push(requestId.requestId);
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							streamReady.resolve(controller);
						},
					}),
					{ headers: { "content-type": "application/connect+proto" } },
				);
			}
			if (url.pathname === "/aiserver.v1.BidiService/BidiAppend") {
				// BidiAppend is a unary RPC: the live service answers 415 to a
				// streaming-framed `application/connect+proto` body and accepts only
				// an unframed `application/proto` message.
				if (request.headers.get("content-type") !== "application/proto") {
					return new Response(null, { status: 415 });
				}
				const append = fromBinary(BidiAppendRequestSchema, body);
				appendRequestIds.push(append.requestId?.requestId ?? "");
				appendSeqnos.push(append.appendSeqno);
				appendedCases.push(fromBinary(AgentClientMessageSchema, append.dataBinary).message.case ?? "");
				const controller = await streamReady.promise;
				controller.enqueue(textDeltaFrame("http1 ok"));
				controller.enqueue(turnEndedFrame());
				controller.close();
				return new Response(null, { headers: { "content-type": "application/proto" } });
			}
			return new Response(null, { status: 404 });
		},
	});

	try {
		const response = streamCursor(makeModel(server.url.toString()), context, {
			apiKey: "test-token",
			transport: "http1",
		});
		const { result, terminalEvents } = await drain(response);

		expect(terminalEvents).toEqual(["done"]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "http1 ok" })]);
		expect(runRequestIds).toHaveLength(1);
		expect(appendRequestIds).toEqual(runRequestIds);
		expect(appendSeqnos).toEqual([0n]);
		expect(appendedCases).toEqual(["runRequest"]);
		expect(streamingHeaders).toEqual(["true", "true"]);
	} finally {
		server.stop(true);
	}
});

it(
	"settles a turn with the error an end-stream frame carries",
	async () => {
		const server = startRunSseServer(controller => {
			controller.enqueue(textDeltaFrame("partial"));
			controller.enqueue(connectEndErrorFrame("resource_exhausted"));
			controller.close();
		});

		try {
			const response = streamCursor(makeModel(server.url.toString()), context, {
				apiKey: "test-token",
				transport: "http1",
			});
			const { result, terminalEvents } = await drain(response);

			expect(terminalEvents).toEqual(["error"]);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("resource_exhausted");
		} finally {
			server.stop(true);
		}
	},
	SETTLE_TIMEOUT_MS,
);

it(
	"settles a caller abort on a live RunSSE stream as aborted",
	async () => {
		const server = startRunSseServer(controller => {
			// `turnEnded` arrives but the transport never ends, so the turn is still
			// waiting on a clean end when the caller aborts. Closing the transport
			// must not turn that abort into a successful completion.
			controller.enqueue(Buffer.concat([textDeltaFrame("partial"), turnEndedFrame()]));
		});
		const abort = new AbortController();

		try {
			const response = streamCursor(makeModel(server.url.toString()), context, {
				apiKey: "test-token",
				transport: "http1",
				signal: abort.signal,
			});
			const { result, terminalEvents } = await drain(response, type => {
				if (type === "text_delta") abort.abort();
			});

			expect(terminalEvents).toEqual(["error"]);
			expect(result.stopReason).toBe("aborted");
		} finally {
			server.stop(true);
		}
	},
	SETTLE_TIMEOUT_MS,
);

interface Refusal {
	/** Which RPC of the first run refuses it. */
	rpc: "RunSSE" | "BidiAppend";
	status: number;
	body: Record<string, unknown>;
}

/**
 * Serves Cursor's HTTP/1 transport where the first run is refused, with a
 * 750 ms `retry-after-ms`, by its RunSSE or by its run request's BidiAppend;
 * every later run streams "after wait" and ends the turn. Runs are matched to
 * their appends by request id, whichever arrives first; a run RunSSE refused
 * has no stream.
 */
function startRefusingServer(refusal: Refusal) {
	const counts = { runs: 0, appends: 0 };
	const runs = new Map<string, PromiseWithResolvers<ReadableStreamDefaultController<Uint8Array> | undefined>>();
	const runFor = (requestId: string) => {
		let run = runs.get(requestId);
		if (!run) {
			run = Promise.withResolvers();
			runs.set(requestId, run);
		}
		return run;
	};
	const refuse = () =>
		new Response(JSON.stringify(refusal.body), {
			status: refusal.status,
			headers: { "content-type": "application/json", "retry-after-ms": "750" },
		});
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body = new Uint8Array(await request.arrayBuffer());
			if (url.pathname === "/agent.v1.AgentService/RunSSE") {
				counts.runs++;
				const run = runFor(fromBinary(BidiRequestIdSchema, readConnectMessage(body)).requestId);
				if (refusal.rpc === "RunSSE" && counts.runs === 1) {
					run.resolve(undefined);
					return refuse();
				}
				return new Response(new ReadableStream<Uint8Array>({ start: controller => run.resolve(controller) }), {
					headers: { "content-type": "application/connect+proto" },
				});
			}
			if (url.pathname === "/aiserver.v1.BidiService/BidiAppend") {
				counts.appends++;
				if (refusal.rpc === "BidiAppend" && counts.appends === 1) return refuse();
				const append = fromBinary(BidiAppendRequestSchema, body);
				if (fromBinary(AgentClientMessageSchema, append.dataBinary).message.case === "runRequest") {
					const controller = await runFor(append.requestId?.requestId ?? "").promise;
					controller?.enqueue(Buffer.concat([textDeltaFrame("after wait"), turnEndedFrame()]));
					controller?.close();
				}
				return new Response(null, { headers: { "content-type": "application/proto" } });
			}
			return new Response(null, { status: 404 });
		},
	});
	return { server, counts };
}

async function runRefused(refusal: Refusal, maxRetryDelayMs: number) {
	const { server, counts } = startRefusingServer(refusal);
	const delays: number[] = [];
	try {
		const response = streamCursor(makeModel(server.url.toString()), context, {
			apiKey: "test-token",
			transport: "http1",
			maxRetryDelayMs,
			providerRetryWait: async delayMs => {
				delays.push(delayMs);
			},
		});
		const { result, terminalEvents } = await drain(response);
		return { result, terminalEvents, delays, runs: counts.runs };
	} finally {
		server.stop(true);
	}
}

it(
	"surfaces a RunSSE 429 whose header wait exceeds the cap after one run, with its status and wait",
	async () => {
		const { result, terminalEvents, delays, runs } = await runRefused(
			{ rpc: "RunSSE", status: 429, body: { message: "Too many requests" } },
			10,
		);

		expect(runs).toBe(1);
		expect(delays).toEqual([]);
		expect(terminalEvents).toEqual(["error"]);
		expect(result.errorStatus).toBe(429);
		expect(result.errorRetryAfterMs).toBe(750);
	},
	SETTLE_TIMEOUT_MS,
);

it(
	"retries a RunSSE 429 after its header wait when it fits the cap",
	async () => {
		const { result, delays, runs } = await runRefused(
			{ rpc: "RunSSE", status: 429, body: { message: "Too many requests" } },
			1_000,
		);

		expect(runs).toBe(2);
		expect(delays).toEqual([750]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "after wait" })]);
	},
	SETTLE_TIMEOUT_MS,
);

it(
	"keeps a BidiAppend 429's status and wait when its Connect error has no details",
	async () => {
		const { result, terminalEvents, delays, runs } = await runRefused(
			{ rpc: "BidiAppend", status: 429, body: { code: "resource_exhausted", message: "busy" } },
			10,
		);

		expect(runs).toBe(1);
		expect(delays).toEqual([]);
		expect(terminalEvents).toEqual(["error"]);
		expect(result.errorStatus).toBe(429);
		expect(result.errorRetryAfterMs).toBe(750);
		expect(result.errorMessage).toContain("resource_exhausted");
	},
	SETTLE_TIMEOUT_MS,
);

it(
	"surfaces a BidiAppend 503 whose wait exceeds the cap after one run, with its status",
	async () => {
		const { result, delays, runs } = await runRefused(
			{ rpc: "BidiAppend", status: 503, body: { code: "unavailable", message: "busy" } },
			10,
		);

		expect(runs).toBe(1);
		expect(delays).toEqual([]);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(503);
		expect(result.errorRetryAfterMs).toBe(750);
	},
	SETTLE_TIMEOUT_MS,
);

it(
	"retries a BidiAppend 503 whose Connect error has no details after its wait",
	async () => {
		const { result, delays, runs } = await runRefused(
			{ rpc: "BidiAppend", status: 503, body: { code: "unavailable", message: "busy" } },
			1_000,
		);

		expect(runs).toBe(2);
		expect(delays).toEqual([750]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "after wait" })]);
	},
	SETTLE_TIMEOUT_MS,
);
