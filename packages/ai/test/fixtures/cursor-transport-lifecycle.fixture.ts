import { expect, test, vi } from "bun:test";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import type * as http2 from "node:http2";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { encodeConnectFrame } from "../../src/providers/cursor/connect-frame";
import * as h2Pool from "../../src/providers/cursor/h2-pool";
import * as serverConfig from "../../src/providers/cursor/server-config";

// Isolated replicas of the three async lifecycle scenarios that used to
// install process-wide uncaughtException/unhandledRejection listeners in the
// parent test runner (pattern: cursor-h2-proxy-env.ts). This child owns the
// listener install/remove for the one scenario named by LIFECYCLE_SCENARIO,
// preserves the original observable assertions, and prints a single
// LIFECYCLE_RESULT=<json> line for the parent to parse and re-assert.

const CONNECT_END_STREAM_FLAG = 0b00000010;
const API_KEY = "transport-lifecycle-key";

interface LifecycleResult {
	uncaught: number;
	unhandledRejections: number;
	elapsedMs?: number;
	eventTypes?: string[];
	stopReason?: string;
	errorMessage?: string;
}

function frame(data: Uint8Array, flags = 0): Buffer {
	const out = Buffer.alloc(5 + data.length);
	out[0] = flags;
	out.writeUInt32BE(data.length, 1);
	out.set(data, 5);
	return out;
}

function varint(value: bigint): Uint8Array {
	const bytes: number[] = [];
	let remaining = value;
	do {
		let byte = Number(remaining & 0x7fn);
		remaining >>= 7n;
		if (remaining !== 0n) byte |= 0x80;
		bytes.push(byte);
	} while (remaining !== 0n);
	return Uint8Array.from(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function pollResponse(seqno: bigint, data: string, eof: boolean): Uint8Array {
	const dataBytes = Buffer.from(data);
	const parts = [varint(8n), varint(seqno), varint(18n), varint(BigInt(dataBytes.length)), dataBytes];
	if (eof) parts.push(varint(24n), varint(1n));
	return concat(parts);
}

const turnEndedPayload = toBinary(
	AgentServerMessageSchema,
	create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		},
	}),
);

function execReadPayload(toolCallId = "call-read", path = "/tmp/read"): Uint8Array {
	return toBinary(
		AgentServerMessageSchema,
		create(AgentServerMessageSchema, {
			message: {
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, {
					id: 1,
					execId: "exec-hang",
					message: {
						case: "readArgs",
						value: create(ReadArgsSchema, { path, toolCallId }),
					},
				}),
			},
		}),
	);
}

function alpnCause(): Error {
	return Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" });
}

function model(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-transport-lifecycle-fixture",
		name: "Cursor transport lifecycle fixture",
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

const context: Context = { messages: [{ role: "user", content: "lifecycle", timestamp: 1 }] };

async function listen(server: http.Server): Promise<string> {
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected lifecycle fixture to bind a tcp port");
	return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server): Promise<void> {
	const closed = Promise.withResolvers<void>();
	server.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}

/** Installs both process-wide collectors; returns their removal. */
function installExceptionCollectors(collected: { uncaught: unknown[]; unhandled: unknown[] }): () => void {
	const onUncaught = (error: unknown): void => {
		collected.uncaught.push(error);
	};
	const onUnhandled = (reason: unknown): void => {
		collected.unhandled.push(reason);
	};
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onUnhandled);
	return () => {
		process.off("uncaughtException", onUncaught);
		process.off("unhandledRejection", onUnhandled);
	};
}

async function runHeartbeatDrain(): Promise<LifecycleResult> {
	const collected = { uncaught: [] as unknown[], unhandled: [] as unknown[] };
	const removeCollectors = installExceptionCollectors(collected);
	const execB64 = Buffer.from(execReadPayload()).toString("base64");
	const turnB64 = Buffer.from(turnEndedPayload).toString("base64");
	// Hold the read-result append past the heartbeat that each successful write arms.
	const heartbeatIntervalMs = 5_000;
	const appendHoldMs = heartbeatIntervalMs + 600;
	let appendRequests = 0;
	const laterAppendPending = Promise.withResolvers<void>();
	const server = http.createServer((req, res) => {
		if (req.url?.includes("RunPoll")) {
			res.writeHead(200, { "content-type": "application/connect+proto" });
			res.write(encodeConnectFrame(pollResponse(0n, execB64, false), false));
			// End the poll only after the read result starts its append request.
			void laterAppendPending.promise.then(() => {
				res.write(encodeConnectFrame(pollResponse(1n, turnB64, false), false));
				res.write(encodeConnectFrame(pollResponse(2n, "", true), false));
				res.write(frame(Buffer.from("{}", "utf8"), CONNECT_END_STREAM_FLAG));
				res.end();
			});
			return;
		}
		if (req.url?.includes("BidiAppend")) {
			appendRequests++;
			if (appendRequests === 1) {
				res.statusCode = 200;
				res.end();
				return;
			}
			// Keep the read-result append pending while the heartbeat would fire.
			laterAppendPending.resolve();
			setTimeout(() => {
				res.statusCode = 200;
				res.end();
			}, appendHoldMs);
			return;
		}
		res.statusCode = 200;
		res.end();
	});
	const baseUrl = await listen(server);
	vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
		ok: false,
		unavailable: { reason: "alpn", cause: alpnCause() },
	});
	vi.spyOn(serverConfig, "fetchCursorBidiAvailability").mockResolvedValue("bidi-disabled");
	try {
		const started = Date.now();
		const stream = streamCursor(model(baseUrl), context, {
			apiKey: API_KEY,
			execHandlers: {
				read: () =>
					Promise.resolve({
						role: "toolResult" as const,
						toolCallId: "call-read",
						toolName: "read",
						content: [{ type: "text" as const, text: "file body" }],
						isError: false,
						timestamp: 1,
					}),
			},
		});
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);
		const elapsedMs = Date.now() - started;
		const result = await stream.result();
		// Original observable assertions, preserved verbatim in the child.
		expect(elapsedMs).toBeLessThan(7000);
		expect(elapsedMs).toBeGreaterThanOrEqual(4500);
		expect(eventTypes).toContain("done");
		expect(eventTypes).not.toContain("error");
		expect(result.stopReason).toBe("stop");
		return {
			uncaught: collected.uncaught.length,
			unhandledRejections: collected.unhandled.length,
			elapsedMs,
			eventTypes,
			stopReason: result.stopReason,
		};
	} finally {
		removeCollectors();
		vi.restoreAllMocks();
		await h2Pool.disposeCursorH2Pool();
		await closeServer(server);
	}
}

async function runSyncWriteFailure(): Promise<LifecycleResult> {
	const collected = { uncaught: [] as unknown[], unhandled: [] as unknown[] };
	const removeCollectors = installExceptionCollectors(collected);
	// Deliberate error-case test double: an EventEmitter faking only the
	// ClientHttp2Stream surface the transport touches, so the double cast
	// below is the documented escape hatch, matching the original in-process
	// mock this scenario was moved from.
	const request = new EventEmitter() as EventEmitter & {
		write: (frame: Buffer) => boolean;
		destroy: () => void;
	};
	request.write = () => {
		throw new Error("forced synchronous write failure");
	};
	request.destroy = () => {
		request.emit("close");
	};
	vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
		ok: true,
		lease: {
			request: request as unknown as http2.ClientHttp2Stream,
			release() {
				request.destroy();
			},
		},
	});
	const server = http.createServer((_req, res) => {
		res.statusCode = 200;
		res.end();
	});
	const baseUrl = await listen(server);
	try {
		const stream = streamCursor(model(baseUrl), context, { apiKey: API_KEY });
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);
		const result = await stream.result();
		expect(eventTypes.at(-1)).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("forced synchronous write failure");
		return {
			uncaught: collected.uncaught.length,
			unhandledRejections: collected.unhandled.length,
			eventTypes,
			stopReason: result.stopReason,
			errorMessage: result.errorMessage,
		};
	} finally {
		removeCollectors();
		vi.restoreAllMocks();
		await h2Pool.disposeCursorH2Pool();
		await closeServer(server);
	}
}

async function runTrailersRejection(): Promise<LifecycleResult> {
	const collected = { uncaught: [] as unknown[], unhandled: [] as unknown[] };
	const removeCollectors = installExceptionCollectors(collected);
	// Same deliberate EventEmitter double as runSyncWriteFailure.
	const request = new EventEmitter() as EventEmitter & {
		write: (frame: Buffer) => boolean;
		destroy: () => void;
	};
	let failed = false;
	request.write = () => {
		if (!failed) {
			failed = true;
			queueMicrotask(() => {
				request.emit("response", { ":status": "200" });
				request.emit("error", new Error("mid-stream network error"));
			});
		}
		return true;
	};
	request.destroy = () => {
		request.emit("close");
	};
	vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
		ok: true,
		lease: {
			request: request as unknown as http2.ClientHttp2Stream,
			release() {
				request.destroy();
			},
		},
	});
	const server = http.createServer((_req, res) => {
		res.statusCode = 200;
		res.end();
	});
	const baseUrl = await listen(server);
	try {
		const stream = streamCursor(model(baseUrl), context, { apiKey: API_KEY });
		for await (const _event of stream) {
			/* drain */
		}
		await Promise.resolve();
		await Promise.resolve();
		// Original observable assertion, preserved in the child.
		expect(collected.unhandled).toHaveLength(0);
		return {
			uncaught: collected.uncaught.length,
			unhandledRejections: collected.unhandled.length,
		};
	} finally {
		removeCollectors();
		vi.restoreAllMocks();
		await h2Pool.disposeCursorH2Pool();
		await closeServer(server);
	}
}

test("runs one isolated cursor transport lifecycle scenario", async () => {
	const scenario = Bun.env.LIFECYCLE_SCENARIO;
	const runners: Record<string, () => Promise<LifecycleResult>> = {
		"heartbeat-drain": runHeartbeatDrain,
		"sync-write-failure": runSyncWriteFailure,
		"trailers-rejection": runTrailersRejection,
	};
	const run = runners[scenario ?? ""];
	if (!run) throw new Error(`unknown LIFECYCLE_SCENARIO: ${scenario ?? "(unset)"}`);
	const result = await run();
	process.stdout.write(`LIFECYCLE_RESULT=${JSON.stringify(result)}\n`);
}, 30_000);
