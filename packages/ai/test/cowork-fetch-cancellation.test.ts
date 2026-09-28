import { afterEach, describe, expect, it, vi } from "bun:test";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as zlib from "node:zlib";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import * as AIError from "@oh-my-pi/pi-ai/error";

class StubClientRequest extends http.ClientRequest {
	constructor() {
		super({ path: "/", createConnection: () => new net.Socket() });
	}

	override end(): this {
		return this;
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("coworkFetch response cancellation", () => {
	it("destroys a compressed response source when its web body is cancelled", async () => {
		const socket = new net.Socket();
		const message = new http.IncomingMessage(socket);
		message.statusCode = 200;
		message.statusMessage = "OK";
		message.headers = { "content-encoding": "gzip" };
		message.rawHeaders = ["content-encoding", "gzip"];

		const compressed = zlib.gzipSync("event: message_stop\ndata: {}\n\n");
		message.push(compressed.subarray(0, -8));

		const request = new StubClientRequest();
		vi.spyOn(https, "request").mockImplementation((_options, callback) => {
			if (typeof callback === "function") callback(message);
			return request;
		});

		const response = await coworkFetch("https://api.anthropic.com/v1/messages", {
			headers: { accept: "text/event-stream" },
		});
		if (!response.body) throw new Error("Expected a streaming response body.");
		const reader = response.body.getReader();
		const chunk = await reader.read();
		expect(new TextDecoder().decode(chunk.value)).toContain("event: message_stop");

		const closed = Promise.withResolvers<void>();
		message.once("close", closed.resolve);
		await reader.cancel();
		await closed.promise;

		expect(message.destroyed).toBe(true);
	});
});

// Bun's node:http shim surfaces a body cut off mid-stream as a bare
// `Error("aborted")` (ECONNRESET), which classified as unknown and ended the
// session with no retry. It must reach the reader as a retryable socket close,
// while a caller abort keeps its own error.
describe("coworkFetch premature response close", () => {
	async function streamingResponse(signal?: AbortSignal) {
		const message = new http.IncomingMessage(new net.Socket());
		message.statusCode = 200;
		message.statusMessage = "OK";
		message.headers = { "content-type": "text/event-stream" };
		message.rawHeaders = ["content-type", "text/event-stream"];
		message.push("event: ping\ndata: {}\n\n");
		vi.spyOn(https, "request").mockImplementation((_options, callback) => {
			if (typeof callback === "function") callback(message);
			return new StubClientRequest();
		});
		const response = await coworkFetch("https://api.anthropic.com/v1/messages", {
			headers: { accept: "text/event-stream" },
			signal,
		});
		if (!response.body) throw new Error("Expected a streaming response body.");
		const reader = response.body.getReader();
		await reader.read();
		return { message, reader };
	}

	function cutOff(message: http.IncomingMessage): void {
		message.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
	}

	it("surfaces a mid-body connection drop as a retryable socket close", async () => {
		const { message, reader } = await streamingResponse();
		cutOff(message);
		const error = await reader.read().then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("socket connection was closed unexpectedly");
		const finalized = await AIError.finalize(error, { api: "anthropic-messages", provider: "anthropic" });
		expect(finalized.stopReason).toBe("error");
		expect(AIError.retriable(finalized.id)).toBe(true);
	});

	it("keeps the original error when the caller aborted the request", async () => {
		const controller = new AbortController();
		const { message, reader } = await streamingResponse(controller.signal);
		controller.abort();
		cutOff(message);
		const error = await reader.read().then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect((error as Error).message).toBe("aborted");
	});
});
