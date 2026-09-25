import { afterEach, describe, expect, it, vi } from "bun:test";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as zlib from "node:zlib";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";

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
