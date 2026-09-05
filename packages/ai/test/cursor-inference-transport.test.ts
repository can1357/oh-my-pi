import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ClientHttp2Session, Http2Server, ServerHttp2Session, ServerHttp2Stream } from "node:http2";
import { connect, createServer } from "node:http2";
import * as net from "node:net";
import {
	InferenceRequestedModelSchema,
	InferenceStreamRequestSchema,
	InferenceStreamResponseSchema,
	InferenceTextStreamPartSchema,
	RunInferenceClientMessageSchema,
	RunInferenceErrorDetailSchema,
	RunInferenceInvocationEndSchema,
	RunInferenceInvocationErrorSchema,
	RunInferenceInvocationResponseSchema,
	RunInferenceRunReadySchema,
	RunInferenceRunRequestSchema,
	RunInferenceServerMessageSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { CONNECT_FLAG_END_STREAM, ConnectFrameDecoder, encodeConnectFrame } from "../src/providers/cursor/connect";
import {
	CursorInferenceRun,
	CursorInferenceRuntime,
	type CursorInferenceRuntimeOptions,
} from "../src/providers/cursor/transport";
import type { RunInferenceClientMessage, RunInferenceServerMessage } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";

const IDENTITY = {
	machineId: "1".repeat(64),
	macMachineId: "2".repeat(64),
	machineIdSource: "host",
} as const;
const REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_KEY = "b".repeat(64);

let server: Http2Server | undefined;
const sessions = new Set<ServerHttp2Session>();

afterEach(() => {
	for (const session of sessions) session.destroy();
	sessions.clear();
	server?.close();
	server = undefined;
});

function serverMessage(message: Partial<RunInferenceServerMessage>): RunInferenceServerMessage {
	return create(RunInferenceServerMessageSchema, message);
}

function clientRun() {
	return create(RunInferenceClientMessageSchema, {
		message: {
			case: "runRequest",
			value: create(RunInferenceRunRequestSchema, {
				conversationId: "omp-session",
				requestedModel: create(InferenceRequestedModelSchema, { modelId: "composer-2.5" }),
				agentMode: "agent",
			}),
		},
	});
}

function textResponse(invocationId: string, text: string) {
	return serverMessage({
		message: {
			case: "invocationResponse",
			value: create(RunInferenceInvocationResponseSchema, {
				invocationId,
				response: create(InferenceStreamResponseSchema, {
					response: { case: "textPart", value: create(InferenceTextStreamPartSchema, { text }) },
				}),
			}),
		},
	});
}

function invocationEnd(invocationId: string) {
	return serverMessage({
		message: {
			case: "invocationEnd",
			value: create(RunInferenceInvocationEndSchema, { invocationId }),
		},
	});
}

function send(stream: ServerHttp2Stream, message: RunInferenceServerMessage): void {
	stream.write(encodeConnectFrame(toBinary(RunInferenceServerMessageSchema, message)));
}

async function loopback(onMessage: (message: RunInferenceClientMessage, stream: ServerHttp2Stream) => void) {
	let capturedHeaders: Record<string, string> | undefined;
	server = createServer();
	server.on("session", session => sessions.add(session));
	server.on("stream", (stream: ServerHttp2Stream, headers) => {
		capturedHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)]));
		stream.respond({ ":status": 200, "content-type": "application/connect+proto", "x-test": "ok" });
		const decoder = new ConnectFrameDecoder();
		stream.on("data", (chunk: Uint8Array) => {
			for (const frame of decoder.push(chunk)) {
				onMessage(fromBinary(RunInferenceClientMessageSchema, frame.body), stream);
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("loopback has no port");
	return { origin: `http://127.0.0.1:${address.port}`, headers: () => capturedHeaders };
}

function runtime(target: { readonly origin: string }, overrides: Partial<CursorInferenceRuntimeOptions> = {}) {
	return new CursorInferenceRuntime({
		backendUrl: "https://api2.cursor.sh",
		token: "HEADER.PAYLOAD.SIGNATURE",
		ghostMode: false,
		identity: IDENTITY,
		connect: () => connect(target.origin),
		createRequestId: () => REQUEST_ID,
		createClientKey: () => CLIENT_KEY,
		now: () => 1_788_307_200_000,
		timezone: () => "America/Sao_Paulo",
		...overrides,
	});
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return await promise.then(
		() => undefined,
		error => error,
	);
}

describe("Cursor managed-inference transport", () => {
	test("multiplexes correlated invocations over one routed HTTP/2 run", async () => {
		const invokes: string[] = [];
		const target = await loopback((message, stream) => {
			if (message.message.case === "runRequest") {
				send(
					stream,
					serverMessage({
						message: {
							case: "runReady",
							value: create(RunInferenceRunReadySchema, {
								resolvedModel: create(InferenceRequestedModelSchema, { modelId: "composer-2.5" }),
							}),
						},
					}),
				);
			}
			if (message.message.case === "invokeModel") {
				invokes.push(message.message.value.invocationId);
				if (invokes.length === 2) {
					for (const id of invokes.toReversed()) {
						send(stream, textResponse(id, id));
						send(stream, invocationEnd(id));
					}
				}
			}
			if (message.message.case === "finishRun") {
				stream.end(encodeConnectFrame(new TextEncoder().encode("{}"), CONNECT_FLAG_END_STREAM));
			}
		});
		const managed = runtime(target);
		const request = create(InferenceStreamRequestSchema);
		const seen: string[] = [];
		const metadata: number[] = [];
		const invoke = (id: string) =>
			managed.invoke("omp-session", "route", clientRun(), id, request, {
				onResponse: response => {
					metadata.push(response.status);
				},
				onMessage: message => {
					if (message.message.case === "invocationResponse") seen.push(message.message.value.invocationId);
				},
			});
		const first = invoke("first");
		const second = invoke("second");
		expect((await second).invocationId).toBe("second");
		expect((await first).invocationId).toBe("first");
		expect(seen).toEqual(["second", "first"]);
		expect(metadata).toEqual([200, 200]);
		expect(target.headers()?.[":path"]).toBe("/aiserver.v1.InferenceService/RunInference");
		await managed.shutdown();
	});

	test("finishes the old outer run before changing model routing", async () => {
		let opened = 0;
		const order: string[] = [];
		const target = await loopback((message, stream) => {
			if (message.message.case === "runRequest") {
				opened++;
				order.push(`run-${opened}`);
				send(
					stream,
					serverMessage({
						message: {
							case: "runReady",
							value: create(RunInferenceRunReadySchema, {
								resolvedModel: create(InferenceRequestedModelSchema, { modelId: `model-${opened}` }),
							}),
						},
					}),
				);
			}
			if (message.message.case === "invokeModel") send(stream, invocationEnd(message.message.value.invocationId));
			if (message.message.case === "finishRun") {
				order.push(`finish-${opened}`);
				stream.end(encodeConnectFrame(new TextEncoder().encode("{}"), CONNECT_FLAG_END_STREAM));
			}
		});
		const managed = runtime(target);
		const request = create(InferenceStreamRequestSchema);
		const options = { onMessage: () => undefined };
		await managed.invoke("omp-session", "route-a", clientRun(), "first", request, options);
		await managed.invoke("omp-session", "route-b", clientRun(), "second", request, options);
		expect(order.slice(0, 3)).toEqual(["run-1", "finish-1", "run-2"]);
		await managed.shutdown();
	});

	test("bounds the complete finish sequence, aborts the stale run, and opens its replacement", async () => {
		let opened = 0;
		const target = await loopback((message, stream) => {
			if (message.message.case === "runRequest") {
				opened++;
				send(
					stream,
					serverMessage({
						message: {
							case: "runReady",
							value: create(RunInferenceRunReadySchema, {
								resolvedModel: create(InferenceRequestedModelSchema, { modelId: `model-${opened}` }),
							}),
						},
					}),
				);
			}
			if (message.message.case === "invokeModel") send(stream, invocationEnd(message.message.value.invocationId));
			if (message.message.case === "finishRun" && opened > 1) {
				stream.end(encodeConnectFrame(new TextEncoder().encode("{}"), CONNECT_FLAG_END_STREAM));
			}
		});
		const managed = runtime(target, { shutdownTimeoutMs: 10 });
		const request = create(InferenceStreamRequestSchema);
		const options = { onMessage: () => undefined };
		await managed.invoke("omp-session", "route-a", clientRun(), "first", request, options);
		expect(await managed.invoke("omp-session", "route-b", clientRun(), "second", request, options)).toHaveProperty(
			"invocationId",
			"second",
		);
		expect(opened).toBe(2);
		await managed.shutdown();
	});

	test("aborts a new outer run before runReady", async () => {
		const sawRun = Promise.withResolvers<void>();
		const target = await loopback(message => {
			if (message.message.case === "runRequest") sawRun.resolve();
		});
		const managed = runtime(target, { responseTimeoutMs: 10_000 });
		const controller = new AbortController();
		const pending = managed.invoke(
			"omp-session",
			"route",
			clientRun(),
			"cancelled",
			create(InferenceStreamRequestSchema),
			{ signal: controller.signal, onMessage: () => undefined },
		);
		await sawRun.promise;
		controller.abort();
		const error = await rejection(pending);
		expect(error).toHaveProperty("name", "AbortError");
		await managed.shutdown();
	});

	test("aborts while waiting for another invocation's per-session run lock", async () => {
		const firstRunStarted = Promise.withResolvers<void>();
		const target = await loopback(message => {
			if (message.message.case === "runRequest") firstRunStarted.resolve();
		});
		const managed = runtime(target, { responseTimeoutMs: 10_000 });
		const firstController = new AbortController();
		const first = managed.invoke("omp-session", "route", clientRun(), "first", create(InferenceStreamRequestSchema), {
			signal: firstController.signal,
			onMessage: () => undefined,
		});
		await firstRunStarted.promise;

		const secondController = new AbortController();
		const second = managed.invoke(
			"omp-session",
			"route",
			clientRun(),
			"second",
			create(InferenceStreamRequestSchema),
			{ signal: secondController.signal, onMessage: () => undefined },
		);
		secondController.abort();
		const outcome = await Promise.race([rejection(second), Bun.sleep(100).then(() => "still pending")]);
		expect(outcome).toHaveProperty("name", "AbortError");

		firstController.abort();
		expect(await rejection(first)).toHaveProperty("name", "AbortError");
		await managed.shutdown();
	});

	test("bounds the initial run write with the readiness timeout", async () => {
		const target = await loopback(() => undefined);
		const originalSend = CursorInferenceRun.prototype.send;
		const blockedRunWrite = Promise.withResolvers<void>();
		const runWriteStarted = Promise.withResolvers<void>();
		const sendSpy = spyOn(CursorInferenceRun.prototype, "send").mockImplementation(function (
			this: CursorInferenceRun,
			message: RunInferenceClientMessage,
		) {
			if (message.message.case !== "runRequest") return originalSend.call(this, message);
			runWriteStarted.resolve();
			return blockedRunWrite.promise;
		});
		const managed = runtime(target, { responseTimeoutMs: 20 });
		try {
			const pending = managed.invoke(
				"omp-session",
				"route",
				clientRun(),
				"blocked-start",
				create(InferenceStreamRequestSchema),
				{ onMessage: () => undefined },
			);
			await runWriteStarted.promise;
			expect(await rejection(pending)).toHaveProperty("message", "Cursor runReady timed out");
		} finally {
			blockedRunWrite.resolve();
			sendSpy.mockRestore();
			await managed.shutdown();
		}
	});

	test("bounds and destroys a stalled initial HTTP/2 connection", async () => {
		const stalledServer = net.createServer(() => undefined);
		const listening = Promise.withResolvers<void>();
		stalledServer.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = stalledServer.address();
		if (address === null || typeof address === "string") throw new Error("stalled server has no port");
		const stalledOrigin = `https://127.0.0.1:${address.port}`;
		let stalledSession: ClientHttp2Session | undefined;
		const managed = runtime(
			{ origin: stalledOrigin },
			{
				responseTimeoutMs: 20,
				connect: () => {
					stalledSession = connect(stalledOrigin, { rejectUnauthorized: false });
					return stalledSession;
				},
			},
		);
		try {
			const pending = managed.invoke(
				"omp-session",
				"route",
				clientRun(),
				"stalled-connect",
				create(InferenceStreamRequestSchema),
				{ onMessage: () => undefined },
			);
			expect(await rejection(pending)).toHaveProperty("message", "Cursor HTTP/2 connection timed out");
			expect(stalledSession?.destroyed).toBe(true);
		} finally {
			await managed.shutdown();
			stalledServer.close();
		}
	});

	test("settles an aborted invocation before its invoke and cancellation writes drain", async () => {
		const target = await loopback((message, stream) => {
			if (message.message.case === "runRequest") {
				send(
					stream,
					serverMessage({
						message: {
							case: "runReady",
							value: create(RunInferenceRunReadySchema, {
								resolvedModel: create(InferenceRequestedModelSchema, { modelId: "composer-2.5" }),
							}),
						},
					}),
				);
			}
			if (message.message.case === "finishRun") {
				stream.end(encodeConnectFrame(new TextEncoder().encode("{}"), CONNECT_FLAG_END_STREAM));
			}
		});
		const originalSend = CursorInferenceRun.prototype.send;
		const blockedInvocation = Promise.withResolvers<void>();
		const blockedCancellation = Promise.withResolvers<void>();
		const invocationWriteStarted = Promise.withResolvers<void>();
		const sendSpy = spyOn(CursorInferenceRun.prototype, "send").mockImplementation(function (
			this: CursorInferenceRun,
			message: RunInferenceClientMessage,
		) {
			if (message.message.case === "invokeModel") {
				invocationWriteStarted.resolve();
				return blockedInvocation.promise;
			}
			return message.message.case === "cancelInvocation"
				? blockedCancellation.promise
				: originalSend.call(this, message);
		});
		const managed = runtime(target);
		try {
			const controller = new AbortController();
			const pending = managed.invoke(
				"omp-session",
				"route",
				clientRun(),
				"cancelled",
				create(InferenceStreamRequestSchema),
				{ signal: controller.signal, onMessage: () => undefined },
			);
			await invocationWriteStarted.promise;
			controller.abort();
			const outcome = await Promise.race([rejection(pending), Bun.sleep(100).then(() => "still pending")]);
			expect(outcome).toHaveProperty("name", "AbortError");
		} finally {
			blockedInvocation.resolve();
			blockedCancellation.resolve();
			sendSpy.mockRestore();
			await managed.shutdown();
		}
	});

	test("cancels one ready invocation without cancelling its sibling", async () => {
		let activeStream: ServerHttp2Stream | undefined;
		let invocations = 0;
		const invocationsReady = Promise.withResolvers<void>();
		const cancelObserved = Promise.withResolvers<void>();
		const target = await loopback((message, stream) => {
			activeStream = stream;
			if (message.message.case === "runRequest") {
				send(
					stream,
					serverMessage({
						message: {
							case: "runReady",
							value: create(RunInferenceRunReadySchema, {
								resolvedModel: create(InferenceRequestedModelSchema, { modelId: "composer-2.5" }),
							}),
						},
					}),
				);
			}
			if (message.message.case === "invokeModel" && ++invocations === 2) invocationsReady.resolve();
			if (message.message.case === "cancelInvocation") {
				cancelObserved.resolve();
				send(stream, invocationEnd(message.message.value.invocationId));
			}
			if (message.message.case === "finishRun") {
				stream.end(encodeConnectFrame(new TextEncoder().encode("{}"), CONNECT_FLAG_END_STREAM));
			}
		});
		const managed = runtime(target);
		const request = create(InferenceStreamRequestSchema);
		const controller = new AbortController();
		const cancelled = managed.invoke("omp-session", "route", clientRun(), "cancelled", request, {
			signal: controller.signal,
			onMessage: () => undefined,
		});
		const sibling = managed.invoke("omp-session", "route", clientRun(), "sibling", request, {
			onMessage: () => undefined,
		});
		await invocationsReady.promise;
		controller.abort();
		expect(await rejection(cancelled)).toHaveProperty("name", "AbortError");
		await cancelObserved.promise;
		if (activeStream === undefined) throw new Error("loopback stream missing");
		send(activeStream, textResponse("sibling", "ok"));
		send(activeStream, invocationEnd("sibling"));
		expect(await sibling).toHaveProperty("invocationId", "sibling");
		await managed.shutdown();
	});

	test("retries after a transient HTTP/2 connection rejection", async () => {
		const target = await loopback((message, stream) => {
			if (message.message.case === "runRequest") {
				send(
					stream,
					serverMessage({
						message: {
							case: "runReady",
							value: create(RunInferenceRunReadySchema, {
								resolvedModel: create(InferenceRequestedModelSchema, { modelId: "composer-2.5" }),
							}),
						},
					}),
				);
			}
			if (message.message.case === "invokeModel") send(stream, invocationEnd(message.message.value.invocationId));
			if (message.message.case === "finishRun") {
				stream.end(encodeConnectFrame(new TextEncoder().encode("{}"), CONNECT_FLAG_END_STREAM));
			}
		});
		let attempts = 0;
		const managed = runtime(target, {
			connect: async () => {
				attempts++;
				if (attempts === 1) throw new Error("temporary connect failure");
				return connect(target.origin);
			},
		});
		const request = create(InferenceStreamRequestSchema);
		expect(
			await rejection(
				managed.invoke("omp-session", "route", clientRun(), "first", request, { onMessage: () => undefined }),
			),
		).toHaveProperty("message", "temporary connect failure");
		expect(
			await managed.invoke("omp-session", "route", clientRun(), "second", request, { onMessage: () => undefined }),
		).toHaveProperty("invocationId", "second");
		expect(attempts).toBe(2);
		await managed.shutdown();
	});

	test("destroys a session that connects after runtime shutdown", async () => {
		const target = await loopback(() => undefined);
		const connectStarted = Promise.withResolvers<void>();
		const lateSession = Promise.withResolvers<ClientHttp2Session>();
		const managed = runtime(target, {
			connect: async () => {
				connectStarted.resolve();
				return await lateSession.promise;
			},
		});
		const pending = managed.invoke(
			"omp-session",
			"route",
			clientRun(),
			"late",
			create(InferenceStreamRequestSchema),
			{ onMessage: () => undefined },
		);
		await connectStarted.promise;
		await managed.shutdown();
		const session = connect(target.origin);
		lateSession.resolve(session);
		expect(await rejection(pending)).toHaveProperty("message", "Cursor managed-inference runtime is shut down");
		expect(session.destroyed).toBe(true);
	});

	test("surfaces an HTTP failure before runReady without unhandled rejection", async () => {
		server = createServer();
		server.on("session", session => sessions.add(session));
		server.on("stream", (stream: ServerHttp2Stream) => {
			stream.respond({ ":status": 500, "content-type": "application/connect+proto" });
			stream.end();
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("loopback has no port");
		const managed = runtime({ origin: `http://127.0.0.1:${address.port}` });
		const error = await rejection(
			managed.invoke("omp-session", "route", clientRun(), "failed", create(InferenceStreamRequestSchema), {
				onMessage: () => undefined,
			}),
		);
		expect(error).toHaveProperty("message", "Cursor RunInference returned HTTP 500");
		await managed.shutdown();
	});

	test("preserves structured details from Connect error trailers", async () => {
		const target = await loopback((message, stream) => {
			if (message.message.case === "runRequest") {
				send(
					stream,
					serverMessage({
						message: {
							case: "runReady",
							value: create(RunInferenceRunReadySchema, {
								resolvedModel: create(InferenceRequestedModelSchema, { modelId: "composer-2.5" }),
							}),
						},
					}),
				);
			}
			if (message.message.case === "invokeModel") {
				const trailer = new TextEncoder().encode(
					JSON.stringify({
						error: {
							code: "resource_exhausted",
							message: "Error",
							details: [{ type: "cursor.quota", debug: { reason: "plan_limit" } }],
						},
					}),
				);
				stream.end(encodeConnectFrame(trailer, CONNECT_FLAG_END_STREAM));
			}
		});
		const managed = runtime(target);
		const error = await rejection(
			managed.invoke("omp-session", "route", clientRun(), "failed", create(InferenceStreamRequestSchema), {
				onMessage: () => undefined,
			}),
		);
		expect(error).toHaveProperty("message", expect.stringContaining('cursor.quota: {"reason":"plan_limit"}'));
		expect(error).toHaveProperty("status", 429);
		await managed.shutdown();
	});

	test("maps Connect authentication trailers to a rotatable HTTP status", async () => {
		const target = await loopback((message, stream) => {
			if (message.message.case === "runRequest") {
				send(
					stream,
					serverMessage({
						message: {
							case: "runReady",
							value: create(RunInferenceRunReadySchema, {
								resolvedModel: create(InferenceRequestedModelSchema, { modelId: "composer-2.5" }),
							}),
						},
					}),
				);
			}
			if (message.message.case === "invokeModel") {
				const trailer = new TextEncoder().encode(
					JSON.stringify({ error: { code: "unauthenticated", message: "Login required" } }),
				);
				stream.end(encodeConnectFrame(trailer, CONNECT_FLAG_END_STREAM));
			}
		});
		const managed = runtime(target);
		const error = await rejection(
			managed.invoke("omp-session", "route", clientRun(), "failed", create(InferenceStreamRequestSchema), {
				onMessage: () => undefined,
			}),
		);
		expect(error).toHaveProperty("status", 401);
		expect(error).toHaveProperty("message", expect.stringContaining("unauthenticated"));
		await managed.shutdown();
	});

	test("preserves structured details from invocation errors", async () => {
		const target = await loopback((message, stream) => {
			if (message.message.case === "runRequest") {
				send(
					stream,
					serverMessage({
						message: {
							case: "runReady",
							value: create(RunInferenceRunReadySchema, {
								resolvedModel: create(InferenceRequestedModelSchema, { modelId: "composer-2.5" }),
							}),
						},
					}),
				);
			}
			if (message.message.case === "invokeModel") {
				send(
					stream,
					serverMessage({
						message: {
							case: "invocationEnd",
							value: create(RunInferenceInvocationEndSchema, {
								invocationId: message.message.value.invocationId,
								error: create(RunInferenceInvocationErrorSchema, {
									code: 8,
									message: "Error",
									details: [
										create(RunInferenceErrorDetailSchema, {
											type: "cursor.quota",
											value: new TextEncoder().encode('{"reason":"plan_limit"}'),
										}),
									],
								}),
							}),
						},
					}),
				);
			}
			if (message.message.case === "finishRun") {
				stream.end(encodeConnectFrame(new TextEncoder().encode("{}"), CONNECT_FLAG_END_STREAM));
			}
		});
		const managed = runtime(target);
		const error = await rejection(
			managed.invoke("omp-session", "route", clientRun(), "failed", create(InferenceStreamRequestSchema), {
				onMessage: () => undefined,
			}),
		);
		expect(error).toHaveProperty("message", expect.stringContaining('cursor.quota: {"reason":"plan_limit"}'));
		await managed.shutdown();
	});

	test("fails every pending invocation on an unknown correlation id", async () => {
		const target = await loopback((message, stream) => {
			if (message.message.case !== "runRequest") return;
			send(
				stream,
				serverMessage({
					message: {
						case: "runReady",
						value: create(RunInferenceRunReadySchema, {
							resolvedModel: create(InferenceRequestedModelSchema, { modelId: "composer-2.5" }),
						}),
					},
				}),
			);
			send(stream, textResponse("unknown", "bad"));
		});
		const managed = runtime(target);
		const failure = await managed
			.invoke("omp-session", "route", clientRun(), "expected", create(InferenceStreamRequestSchema), {
				onMessage: () => undefined,
			})
			.then(
				() => undefined,
				error => error,
			);
		expect(failure).toHaveProperty("message", "Cursor response has unknown invocation 'unknown'");
		await managed.shutdown();
	});
});
