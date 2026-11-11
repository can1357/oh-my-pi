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
	GetBlobArgsSchema,
	InteractionUpdateSchema,
	KvServerMessageSchema,
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

it("completes a RunSSE turn after delivering a burst of blob replies in append order", async () => {
	const blobRequests = 4;
	const streamReady = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	const runRequestIds: string[] = [];
	const appendRequestIds: string[] = [];
	const appendSeqnos: bigint[] = [];
	const appendedCases: string[] = [];
	const answeredIds: number[] = [];
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
				// A slow first blob append lets later requests overtake it if the client sends them concurrently.
				if (append.appendSeqno === 1n) await Bun.sleep(25);
				appendRequestIds.push(append.requestId?.requestId ?? "");
				appendSeqnos.push(append.appendSeqno);
				const client = fromBinary(AgentClientMessageSchema, append.dataBinary);
				appendedCases.push(client.message.case ?? "");
				const controller = await streamReady.promise;
				if (client.message.case === "runRequest") {
					for (let id = 1; id <= blobRequests; id++) {
						const request = create(AgentServerMessageSchema, {
							message: {
								case: "kvServerMessage",
								value: create(KvServerMessageSchema, {
									id,
									message: {
										case: "getBlobArgs",
										value: create(GetBlobArgsSchema, { blobId: new Uint8Array([id]) }),
									},
								}),
							},
						});
						controller.enqueue(frameConnectMessage(toBinary(AgentServerMessageSchema, request)));
					}
				} else if (client.message.case === "kvClientMessage") {
					answeredIds.push(client.message.value.id);
					if (answeredIds.length === blobRequests) {
						controller.enqueue(textDeltaFrame("http1 ok"));
						controller.enqueue(turnEndedFrame());
						controller.close();
					}
				}
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
		expect(appendRequestIds).toEqual(Array.from({ length: blobRequests + 1 }, () => runRequestIds[0]));
		expect(appendSeqnos).toEqual([0n, 1n, 2n, 3n, 4n]);
		expect(answeredIds).toEqual([1, 2, 3, 4]);
		expect(appendedCases).toEqual(["runRequest", ...Array.from({ length: blobRequests }, () => "kvClientMessage")]);
		expect(streamingHeaders).toEqual(Array.from({ length: blobRequests + 2 }, () => "true"));
	} finally {
		server.stop(true);
	}
});

function startFlakyAppendServer(
	failure: (attempt: number) => ResponseInit | undefined | Promise<ResponseInit | undefined>,
) {
	const streams = new Map<string, PromiseWithResolvers<ReadableStreamDefaultController<Uint8Array>>>();
	const streamFor = (requestId: string) => {
		let entry = streams.get(requestId);
		if (!entry) {
			entry = Promise.withResolvers();
			streams.set(requestId, entry);
		}
		return entry;
	};
	const attempts: { requestId: string; seqno: bigint }[] = [];
	let runSseOpens = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body = new Uint8Array(await request.arrayBuffer());
			if (url.pathname === "/agent.v1.AgentService/RunSSE") {
				runSseOpens++;
				const { requestId } = fromBinary(BidiRequestIdSchema, readConnectMessage(body));
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							streamFor(requestId).resolve(controller);
						},
					}),
					{ headers: { "content-type": "application/connect+proto" } },
				);
			}
			if (url.pathname === "/aiserver.v1.BidiService/BidiAppend") {
				const append = fromBinary(BidiAppendRequestSchema, body);
				const requestId = append.requestId?.requestId ?? "";
				attempts.push({ requestId, seqno: append.appendSeqno });
				const failed = await failure(attempts.length);
				if (failed !== undefined) return new Response(null, failed);
				const controller = await streamFor(requestId).promise;
				controller.enqueue(textDeltaFrame("retried ok"));
				controller.enqueue(turnEndedFrame());
				controller.close();
				return new Response(null, { headers: { "content-type": "application/proto" } });
			}
			return new Response(null, { status: 404 });
		},
	});
	return {
		server,
		attempts,
		get runSseOpens() {
			return runSseOpens;
		},
		async endRun(requestId: string) {
			(await streamFor(requestId).promise).close();
		},
		async finishRun(requestId: string, eofAfterMs: number) {
			const controller = await streamFor(requestId).promise;
			controller.enqueue(textDeltaFrame("retried ok"));
			controller.enqueue(turnEndedFrame());
			controller.enqueue(frameConnectMessage(Buffer.from("{}"), CONNECT_END_STREAM_FLAG));
			setTimeout(() => controller.close(), eofAfterMs);
		},
	};
}

it(
	"resends a BidiAppend that hits a gateway error on the open stream, with the same request id and seqno",
	async () => {
		const flaky = startFlakyAppendServer(attempt => (attempt === 1 ? { status: 503 } : undefined));
		try {
			const response = streamCursor(makeModel(flaky.server.url.toString()), context, {
				apiKey: "test-token",
				transport: "http1",
				providerRetryWait: async () => {},
			});
			const { result, terminalEvents } = await drain(response);

			expect(terminalEvents).toEqual(["done"]);
			expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "retried ok" })]);
			expect(flaky.attempts).toEqual([flaky.attempts[0], flaky.attempts[0]]);
			expect(flaky.runSseOpens).toBe(1);
		} finally {
			flaky.server.stop(true);
		}
	},
	SETTLE_TIMEOUT_MS,
);

const RUN_OVER_DURING_RETRY = [
	{ during: "EOF during the backoff", resends: 0, runs: 2, endsInBackoff: "eof", endsInResend: false },
	{ during: "an end frame during the backoff", resends: 0, runs: 1, endsInBackoff: "frame", endsInResend: false },
	{
		during: "an end frame while the resend is in flight",
		resends: 1,
		runs: 1,
		endsInBackoff: undefined,
		endsInResend: true,
	},
] as const;

for (const { during, resends, runs, endsInBackoff, endsInResend } of RUN_OVER_DURING_RETRY) {
	it(
		`stops a retrying append without failing the turn on ${during}`,
		async () => {
			const firstRequestId = () => flaky.attempts[0].requestId;
			const flaky = startFlakyAppendServer(async attempt => {
				if (attempt === 1) return { status: 503 };
				if (attempt === 2 && endsInResend) {
					await flaky.finishRun(firstRequestId(), 100);
					await Bun.sleep(30);
				}
				return attempt === 2 && endsInBackoff !== "eof" ? { status: 400 } : undefined;
			});
			let waits = 0;
			try {
				const response = streamCursor(makeModel(flaky.server.url.toString()), context, {
					apiKey: "test-token",
					transport: "http1",
					providerRetryWait: async () => {
						if (waits++ > 0) return;
						if (endsInBackoff === "eof") {
							await flaky.endRun(firstRequestId());
							while (flaky.runSseOpens < 2) await Bun.sleep(5);
						} else if (endsInBackoff === "frame") {
							await flaky.finishRun(firstRequestId(), 100);
							await Bun.sleep(30);
						}
					},
				});
				const { result, terminalEvents } = await drain(response);
				// Let a stale resend reach the server.
				await Bun.sleep(50);

				expect(terminalEvents).toEqual(["done"]);
				expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "retried ok" })]);
				const firstRun = flaky.attempts.filter(append => append.requestId === firstRequestId());
				expect(firstRun).toHaveLength(1 + resends);
				expect(flaky.runSseOpens).toBe(runs);
			} finally {
				flaky.server.stop(true);
			}
		},
		SETTLE_TIMEOUT_MS,
	);
}

for (const { hint, maxRetryDelayMs } of [
	{ hint: "30", maxRetryDelayMs: undefined },
	{ hint: "2", maxRetryDelayMs: 1_000 },
]) {
	it(
		`fails an append over to a new run, without resending, on a Retry-After of ${hint}s (maxRetryDelayMs ${maxRetryDelayMs})`,
		async () => {
			const flaky = startFlakyAppendServer(attempt =>
				attempt === 1 ? { status: 503, headers: { "retry-after": hint } } : undefined,
			);
			try {
				const response = streamCursor(makeModel(flaky.server.url.toString()), context, {
					apiKey: "test-token",
					transport: "http1",
					maxRetryDelayMs,
					providerRetryWait: async () => {},
				});
				const { terminalEvents } = await drain(response);

				expect(terminalEvents).toEqual(["done"]);
				const firstRun = flaky.attempts.filter(append => append.requestId === flaky.attempts[0].requestId);
				expect(firstRun).toHaveLength(1);
				expect(flaky.runSseOpens).toBe(2);
			} finally {
				flaky.server.stop(true);
			}
		},
		SETTLE_TIMEOUT_MS,
	);
}

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
