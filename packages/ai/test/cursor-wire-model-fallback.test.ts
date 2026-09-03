import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	type AgentRunRequest,
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	HeartbeatUpdateSchema,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

const CONNECT_END_STREAM_FLAG = 0b00000010;

type Response = (
	| { kind: "error"; code: string; message: string; partialText?: string; heartbeat?: boolean }
	| { kind: "success"; text: string }
	| { kind: "exec-success" }
) & { delayMs?: number };

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let responses: Response[] = [];
let requests: AgentRunRequest[] = [];

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function textDeltaFrame(text: string): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "textDelta",
					value: create(TextDeltaUpdateSchema, { text }),
				},
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
				message: {
					case: "turnEnded",
					value: create(TurnEndedUpdateSchema, {}),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function heartbeatFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "heartbeat",
					value: create(HeartbeatUpdateSchema, {}),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function execReadRequestFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 1,
				execId: "exec-fallback",
				message: {
					case: "readArgs",
					value: create(ReadArgsSchema, { path: "/tmp/fallback", toolCallId: "call-fallback" }),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function connectErrorFrame(code: string, message: string): Buffer {
	const payload = Buffer.from(JSON.stringify({ error: { code, message } }), "utf8");
	return frameConnectMessage(payload, CONNECT_END_STREAM_FLAG);
}

function decodeRunRequest(frame: Buffer): AgentRunRequest {
	const length = frame.readUInt32BE(1);
	const clientMessage = fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + length));
	if (clientMessage.message.case !== "runRequest") {
		throw new Error(`expected runRequest, received ${clientMessage.message.case ?? "empty message"}`);
	}
	return clientMessage.message.value;
}

function isAgentRunRequest(payload: unknown): payload is AgentRunRequest {
	return payload !== null && typeof payload === "object" && "$typeName" in payload;
}

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		let pending: Buffer = Buffer.alloc(0);
		const onData = async (chunk: Buffer): Promise<void> => {
			pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
			if (pending.length < 5) return;
			const length = pending.readUInt32BE(1);
			if (pending.length < 5 + length) return;
			stream.off("data", onData);

			requests.push(decodeRunRequest(pending));
			const response = responses[requests.length - 1];
			if (!response) {
				stream.respond({ ":status": 500 });
				stream.end();
				return;
			}

			// This HTTP/2 integration fixture verifies reported performance.now()
			// latency; fake timers would also stall the transport events under test.
			if (response.delayMs) await Bun.sleep(response.delayMs);
			stream.respond({
				":status": 200,
				"content-type": "application/connect+proto",
			});
			if (response.kind === "success") {
				stream.end(Buffer.concat([textDeltaFrame(response.text), turnEndedFrame()]));
				return;
			}
			if (response.kind === "exec-success") {
				stream.end(Buffer.concat([execReadRequestFrame(), turnEndedFrame()]));
				return;
			}
			const frames = response.heartbeat ? [heartbeatFrame()] : [];
			if (response.partialText) frames.push(textDeltaFrame(response.partialText));
			frames.push(connectErrorFrame(response.code, response.message));
			stream.end(Buffer.concat(frames));
		};
		stream.on("data", onData);
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected Cursor fallback fixture to bind a TCP port");
	}
	return `http://127.0.0.1:${address.port}`;
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "gpt-5.6-sol",
		requestModelId: "gpt-5.6-sol-none",
		name: "GPT-5.6 Sol",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	} satisfies ModelSpec<"cursor-agent">);
}

const context: Context = {
	messages: [{ role: "user", content: "Reply only: OK", timestamp: 1 }],
};

async function runStream(baseUrl: string): Promise<{ events: string[]; result: AssistantMessage }> {
	const stream = streamCursor(makeModel(baseUrl), context, {
		apiKey: "test-token",
		sessionId: crypto.randomUUID(),
		wireModelId: "gpt-5.6-sol-medium",
	});
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	return { events, result: await stream.result() };
}

async function stopServer(): Promise<void> {
	for (const session of sessions) session.destroy();
	sessions.clear();
	if (!server) return;
	const closing = server;
	server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => {
		if (error) closed.reject(error);
		else closed.resolve();
	});
	await closed.promise;
}

afterEach(async () => {
	responses = [];
	requests = [];
	await stopServer();
});

describe("Cursor discovered effort wire fallback", () => {
	it("retries not_found once with the exact discovered sibling id", async () => {
		responses = [
			{ kind: "error", code: "not_found", message: "Error" },
			{ kind: "success", text: "OK" },
		];
		const baseUrl = await startServer();
		const { events, result } = await runStream(baseUrl);

		expect(events.filter(event => event === "start")).toHaveLength(1);
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		expect(requests[0].requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(requests[0].requestedModel?.parameters).toEqual([
			expect.objectContaining({ id: "reasoning", value: "medium" }),
		]);
		expect(requests[1].requestedModel?.modelId).toBe("gpt-5.6-sol-medium");
		expect(requests[1].requestedModel?.parameters).toEqual([]);
		expect(requests[1].modelDetails?.modelId).toBe("gpt-5.6-sol-medium");
	});

	it("still retries when a heartbeat precedes the not_found", async () => {
		responses = [
			{ kind: "error", code: "not_found", message: "Error", heartbeat: true },
			{ kind: "success", text: "OK" },
		];
		const baseUrl = await startServer();
		const { result } = await runStream(baseUrl);

		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		expect(requests[1].requestedModel?.modelId).toBe("gpt-5.6-sol-medium");
	});

	it("does not start the fallback after the request is canceled", async () => {
		responses = [
			{ kind: "error", code: "not_found", message: "Error" },
			{ kind: "success", text: "must not be requested" },
		];
		const baseUrl = await startServer();
		const controller = new AbortController();
		// Model cancellation at the exact retry boundary without a timer race:
		// once the fixture receives attempt one, the signal is already aborted
		// when the not_found catch decides whether to launch attempt two.
		Object.defineProperty(controller.signal, "aborted", {
			configurable: true,
			get: () => requests.length > 0,
		});
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			sessionId: crypto.randomUUID(),
			wireModelId: "gpt-5.6-sol-medium",
			signal: controller.signal,
		});
		for await (const _event of stream) {
			// drain to completion
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("aborted");
		expect(requests).toHaveLength(1);
	});

	it("reports latency across both wire attempts", async () => {
		responses = [
			{ kind: "error", code: "not_found", message: "Error", delayMs: 40 },
			{ kind: "success", text: "OK", delayMs: 20 },
		];
		const baseUrl = await startServer();
		const { result } = await runStream(baseUrl);

		expect(result.stopReason).toBe("stop");
		expect(result.duration).toBeGreaterThanOrEqual(50);
		expect(result.ttft).toBeGreaterThanOrEqual(50);
		expect(requests).toHaveLength(2);
	});

	it.each([
		["permission_denied", "authentication"],
		["resource_exhausted", "quota"],
		["unavailable", "network"],
	])("does not retry %s %s errors", async code => {
		responses = [{ kind: "error", code, message: "Error" }];
		const baseUrl = await startServer();
		const { result } = await runStream(baseUrl);

		expect(result.stopReason).toBe("error");
		expect(requests).toHaveLength(1);
	});

	it("does not retry when onPayload replaced the normalized effort model", async () => {
		responses = [{ kind: "error", code: "not_found", message: "hook model unavailable" }];
		const baseUrl = await startServer();
		let hookCalls = 0;
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			sessionId: crypto.randomUUID(),
			wireModelId: "gpt-5.6-sol-medium",
			onPayload: payload => {
				hookCalls++;
				if (!isAgentRunRequest(payload)) throw new Error("expected Cursor AgentRunRequest payload");
				return {
					...payload,
					requestedModel: payload.requestedModel
						? { ...payload.requestedModel, modelId: "hook-selected-model" }
						: undefined,
					modelDetails: payload.modelDetails
						? { ...payload.modelDetails, modelId: "hook-selected-model" }
						: undefined,
				};
			},
		});
		for await (const _event of stream) {
			// drain to completion
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(hookCalls).toBe(1);
		expect(requests).toHaveLength(1);
		expect(requests[0].requestedModel?.modelId).toBe("hook-selected-model");
		expect(requests[0].modelDetails?.modelId).toBe("hook-selected-model");
	});

	it("attempts the discovered sibling at most once", async () => {
		responses = [
			{ kind: "error", code: "not_found", message: "normalized unavailable" },
			{ kind: "error", code: "not_found", message: "sibling unavailable" },
		];
		const baseUrl = await startServer();
		const { result } = await runStream(baseUrl);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("sibling unavailable");
		expect(requests).toHaveLength(2);
	});

	it("does not retry after the server emits partial output", async () => {
		responses = [{ kind: "error", code: "not_found", message: "late failure", partialText: "partial" }];
		const baseUrl = await startServer();
		const { result } = await runStream(baseUrl);

		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "partial" })]);
		expect(requests).toHaveLength(1);
	});

	it("keeps the fallback turn's exec bridge busy state on the watched outer stream", async () => {
		responses = [{ kind: "error", code: "not_found", message: "Error" }, { kind: "exec-success" }];
		const baseUrl = await startServer();
		const execStarted = Promise.withResolvers<void>();
		const releaseExec = Promise.withResolvers<void>();
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			sessionId: crypto.randomUUID(),
			wireModelId: "gpt-5.6-sol-medium",
			execHandlers: {
				async read() {
					execStarted.resolve();
					await releaseExec.promise;
					return {
						role: "toolResult",
						toolCallId: "call-fallback",
						toolName: "read",
						content: [{ type: "text", text: "file body" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
		});
		const drain = (async () => {
			for await (const _event of stream) {
				// drain to completion
			}
			return stream.result();
		})();

		await execStarted.promise;
		// The watchdog reads the outer stream; the exec bridge marked the inner
		// fallback stream busy. Without forwarding, this would read false and the
		// idle watchdog would abort a healthy tool run.
		expect(stream.hasPendingLocalWork).toBe(true);
		releaseExec.resolve();

		const result = await drain;
		expect(result.stopReason).toBe("stop");
		expect(stream.hasPendingLocalWork).toBe(false);
		expect(requests).toHaveLength(2);
	});
});
